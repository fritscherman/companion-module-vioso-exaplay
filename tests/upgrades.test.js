'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { upgradeScripts, v1ToV2, legacyCompId, upgradeConfig } = require('../src/upgrades')
const { getActionDefinitions } = require('../src/actions')
const { getFeedbackDefinitions, legacyFeedbackDefinitions } = require('../src/feedbacks')
const { variableDefinitions, variableValues, staleVariableValues, emptyState } = require('../src/lib/status')

// A saved 1.x connection as Companion hands it to the script.
const v1Config = { prot: 'tcp', host: '10.0.0.5', port: '8101', pollingInterval: '1', saveresponse: true }
const action = (actionId, options) => ({ id: `a-${actionId}-${Math.random()}`, controlId: 'bank:1', actionId, options })
const feedback = (feedbackId, options) => ({ id: `f-${feedbackId}`, controlId: 'bank:1', feedbackId, options })

test('one upgrade script; never fewer (Companion counts them)', () => {
	assert.equal(upgradeScripts.length, 1)
})

test('the 1.x composition rule: "1" → "comp1", a comp prefix in any case stays', () => {
	assert.equal(legacyCompId('1'), 'comp1')
	assert.equal(legacyCompId(' 12 '), 'comp12')
	assert.equal(legacyCompId('comp3'), 'comp3')
	assert.equal(legacyCompId('Comp3'), 'Comp3')
	assert.equal(legacyCompId(''), 'comp')
	assert.equal(legacyCompId(undefined), 'comp')
})

test('1.x config → 2.x: port becomes tcpPort, the polling fields go, 1.x compatibility on', () => {
	assert.deepEqual(upgradeConfig(v1Config), { host: '10.0.0.5', tcpPort: 8101, legacy1x: true })
	assert.equal(upgradeConfig({ host: 'x', port: 'abc' }).tcpPort, 8100, 'an unreadable port falls back to the default')
	assert.equal(upgradeConfig({ host: 'x', tcpPort: 8100, statusEnabled: true }), null, 'a 2.x config is left alone')
	assert.equal(upgradeConfig(null), null)
})

test('1.x actions map to the 2.x ids, with options the 2.x definitions know', () => {
	const actions = [
		action('transportmode', { command: 'play', composition_id: '1' }),
		action('transportmode', { command: 'pause', composition_id: 'comp2' }),
		action('transportmode', { command: 'stop', composition_id: '3' }),
		action('set_cue', { composition_id: '1', cue_number: '4' }),
		action('volume', { composition_id: '1', volume_value: 75 }),
		action('volume_adjust', { composition_id: '1', adjustment: '-' }),
		action('volume_adjust', { composition_id: '1', adjustment: '+' }),
		action('jump_to_time', { composition_id: '1', time_in_seconds: '12.5' }),
		action('comp_play', { comp: 'comp1', compText: '' }), // already 2.x: untouched
	]
	const r = v1ToV2({}, { config: null, actions, feedbacks: [] })
	assert.equal(r.updatedConfig, null)
	assert.equal(r.updatedActions.length, 8, 'only the 1.x actions are reported as changed')
	const [play, pause, stop, cue, vol, down, up, seek] = r.updatedActions
	assert.deepEqual([play.actionId, play.options], ['comp_play', { comp: '', compText: 'comp1' }])
	assert.deepEqual([pause.actionId, pause.options.compText], ['comp_pause', 'comp2'])
	assert.equal(stop.actionId, 'comp_stop')
	assert.deepEqual([cue.actionId, cue.options], ['cue_go', { comp: '', compText: 'comp1', cue: '4' }])
	assert.deepEqual([vol.actionId, vol.options.value], ['comp_volume_set', '75'])
	assert.deepEqual([down.actionId, down.options.delta, up.options.delta], ['comp_volume_nudge', -10, 10])
	assert.deepEqual([seek.actionId, seek.options.time], ['comp_seek', '12.5'])

	const defs = getActionDefinitions(fakeSelf())
	for (const a of r.updatedActions) {
		assert.ok(defs[a.actionId], `${a.actionId} exists`)
		const known = new Set(defs[a.actionId].options.map((o) => o.id))
		for (const k of Object.keys(a.options)) assert.ok(known.has(k), `${a.actionId} has option ${k}`)
	}
})

test('an unknown transport word is left for Companion to report, not guessed', () => {
	const r = v1ToV2({}, { config: null, actions: [action('transportmode', { command: 'rewind', composition_id: '1' })], feedbacks: [] })
	assert.equal(r.updatedActions.length, 0)
})

test('1.x feedbacks: the two boolean ones map, the display ones keep their ids', () => {
	const fbs = [
		feedback('transportModeFeedback', { composition_id: '1', mode: 'stop' }),
		feedback('transportModeFeedback', { composition_id: '1', mode: 'paused' }),
		feedback('cueActiveFeedback', { composition_id: 'comp2', cue_number: '3' }),
		feedback('cueIndexDisplayFeedback', { composition_id: '1', bgcolor: 0, color: 0xffffff }),
	]
	const r = v1ToV2({}, { config: null, actions: [], feedbacks: fbs })
	assert.equal(r.updatedFeedbacks.length, 3)
	assert.deepEqual([r.updatedFeedbacks[0].feedbackId, r.updatedFeedbacks[0].options], ['comp_state', { comp: '', compText: 'comp1', state: 'stopped' }])
	assert.equal(r.updatedFeedbacks[1].options.state, 'paused')
	assert.deepEqual([r.updatedFeedbacks[2].feedbackId, r.updatedFeedbacks[2].options], ['cue_current', { comp: '', compText: 'comp2', cue: '3' }])
	assert.equal(fbs[3].feedbackId, 'cueIndexDisplayFeedback', 'kept as is')

	const defs = getFeedbackDefinitions(fakeSelf())
	for (const f of r.updatedFeedbacks) assert.ok(defs[f.feedbackId], `${f.feedbackId} exists`)
	const legacy = legacyFeedbackDefinitions(fakeSelf())
	for (const id of ['cueIndexDisplayFeedback', 'volumeDisplayFeedback', 'frameIndexDisplayFeedback', 'currentTimeFeedback', 'combinedInfoFeedback'])
		assert.ok(legacy[id], `legacy ${id} is defined`)
})

const statusWith = (compositions) => ({ ...emptyState(), known: true, compositions })
const comp1 = { id: 'comp1', name: 'Main', type: 'timeline', state: 'stopped', time: 2.5, duration: 60, cue: { index: 3, name: 'Intro' } }

test('legacy variables: defined and filled only while 1.x compatibility is on', () => {
	const st = statusWith([comp1])
	assert.ok(!variableDefinitions(st, undefined).some((d) => d.variableId === 'playback_status_comp1'))
	const ids = variableDefinitions(st, undefined, { legacy: true }).map((d) => d.variableId)
	for (const n of ['playback_status', 'current_time', 'frame_index', 'cue_index', 'clip_index', 'composition_duration', 'current_volume'])
		assert.ok(ids.includes(`${n}_comp1`), n)

	assert.equal(variableValues(st, {}).playback_status_comp1, undefined)
	const v = variableValues(st, { legacy: true, levels: { comp1: { volume: 80 } } })
	assert.equal(v.playback_status_comp1, 'stop', '1.x spelled stopped "stop"')
	assert.equal(v.current_time_comp1, '2.5')
	assert.equal(v.frame_index_comp1, '150')
	assert.equal(v.cue_index_comp1, '3')
	assert.equal(v.clip_index_comp1, '-', 'a Timeline has no clip index')
	assert.equal(v.composition_duration_comp1, '60')
	assert.equal(v.current_volume_comp1, '80')
})

test('legacy variables: unknown is "?", never the 1.x placeholder 0', () => {
	const v = variableValues(statusWith([{ id: 'comp1' }]), { legacy: true })
	for (const n of ['playback_status', 'current_time', 'frame_index', 'cue_index', 'composition_duration', 'current_volume']) assert.equal(v[`${n}_comp1`], '?', n)
	const pl = variableValues(statusWith([{ id: 'comp2', type: 'playlist', cue: { index: 2 } }]), { legacy: true })
	assert.equal(pl.clip_index_comp2, '2', 'on a Playlist the clip index is the item')
	const stale = staleVariableValues(statusWith([comp1]), statusWith([]))
	assert.equal(stale.playback_status_comp1, '?', 'a composition that left the project reads unknown')
})

test('legacy display feedbacks write the legacy variable into the key text', async () => {
	const self = fakeSelf(statusWith([comp1]))
	const fb = legacyFeedbackDefinitions(self)
	const o = (extra) => ({ options: { composition_id: '1', bgcolor: 1, color: 2, ...extra } })
	assert.deepEqual(fb.cueIndexDisplayFeedback.callback(o()), { bgcolor: 1, color: 2, text: 'Cue/Clip Index comp1\n$(exa:cue_index_comp1)' })
	assert.deepEqual(fb.volumeDisplayFeedback.callback(o()), {}, 'volume never read: leaves the key alone')
	assert.deepEqual(fb.currentTimeFeedback.callback(o({ time: 10 })), {}, 'before the threshold')
	assert.match(fb.currentTimeFeedback.callback(o({ time: 1 })).text, /current_time_comp1/)
	assert.match(fb.combinedInfoFeedback.callback(o()).text, /Transport: \$\(exa:playback_status_comp1\)/)
	assert.deepEqual(fb.frameIndexDisplayFeedback.callback({ options: { composition_id: '9', bgcolor: 1, color: 2 } }), {}, 'a composition the feed does not report')
})

function fakeSelf(status = emptyState()) {
	return {
		label: 'exa',
		status,
		levels: {},
		config: { legacy1x: true },
		catalog: { state: { comps: [], buttons: [], known: false }, entry: () => undefined },
		compositionChoices: () => [],
		resolveCompId: (r) => r,
	}
}
