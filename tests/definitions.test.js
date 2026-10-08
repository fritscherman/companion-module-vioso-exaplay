'use strict'
/**
 * The Companion-facing definitions, built with a stand-in instance: the
 * manifest passes the base package's own validator, every preset points at
 * an action / feedback that exists with options those define, and main.js
 * parses. This is NOT a run inside Companion.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { validateManifest } = require('@companion-module/base')
const { getActionDefinitions } = require('../src/actions')
const { getFeedbackDefinitions, COLORS } = require('../src/feedbacks')
const { getPresetDefinitions } = require('../src/presets')
const { getVariableDefinitions, getVariableValues, connectionWord, listsWord } = require('../src/variables')
const { getConfigFields, withDefaults } = require('../src/config')
const { parseMessage, emptyState, compositionChoices, resolveCompId } = require('../src/lib/status')
const { Catalog, emptyCatalog } = require('../src/lib/catalog')

const ROOT = path.join(__dirname, '..')

/** The catalog a refresh of the sample project produces. */
function sampleCatalog() {
	return {
		...emptyCatalog(),
		known: true,
		comps: [
			{
				id: 'comp1',
				name: 'Main Show',
				type: 'timeline',
				cues: [
					{ index: 1, name: 'Intro', offset: 0 },
					{ index: 2, name: 'Scene A', offset: 30 },
					{ index: 3, name: 'Blackout', offset: 90 },
				],
				volume: 80,
				opacity: 100,
			},
			{ id: 'comp2', name: 'Lobby', type: 'playlist', cues: [{ index: 1, name: 'Opening' }, { index: 2, name: 'Act 1' }] },
		],
		buttons: [{ id: 'control_script_1', label: 'Doors open' }],
	}
}

function fakeSelf(status, catalogState = emptyCatalog()) {
	const catalog = new Catalog({ sendTcp: async () => ({ ok: false, error: 'test' }), http: async () => ({ error: 'test' }) })
	catalog.state = catalogState
	const self = {
		label: 'exaplay',
		config: withDefaults({ host: '10.0.0.5' }),
		status,
		catalog,
		tcpState: 'connected',
		statusState: 'connected',
		levels: {},
		selected: {},
		buttonResults: {},
		blinkOn: true,
		masterVolume: undefined,
		compositionChoices: () => compositionChoices(self.status, self.catalog.state),
		resolveCompId: (ref) => resolveCompId(self.status, self.catalog.state, ref),
	}
	return self
}

const STATUS = parseMessage(
	JSON.stringify({
		type: 'status',
		v: 1,
		compositions: [
			{ id: 'comp1', name: 'Main Show', type: 'timeline', state: 'playing', time: 31, duration: 100, cue: { index: 2, name: 'Scene A' } },
			{ id: 'comp2', name: 'Lobby', type: 'playlist', state: 'stopped', time: 0, cue: null },
		],
	}),
).state

test('manifest passes @companion-module/base validation and points at main.js', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'companion/manifest.json'), 'utf8'))
	validateManifest(manifest)
	assert.equal(path.resolve(ROOT, 'companion', manifest.runtime.entrypoint), path.join(ROOT, 'src/main.js'))
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
	assert.equal(manifest.version, pkg.version)
	const compat = JSON.parse(fs.readFileSync(path.join(ROOT, 'compatibility.json'), 'utf8'))
	assert.equal(compat.version, pkg.version)
	assert.match(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), new RegExp(`## ${pkg.version.replace(/\./g, '\\.')} `))
	assert.ok(fs.statSync(path.join(ROOT, 'companion/HELP.md')).size > 0)
})

test('main.js and every source file parse', () => {
	execFileSync(process.execPath, ['--check', path.join(ROOT, 'src/main.js')])
	for (const f of fs.readdirSync(path.join(ROOT, 'src/lib'))) execFileSync(process.execPath, ['--check', path.join(ROOT, 'src/lib', f)])
})

for (const [label, status, catalog] of [
	['with a status list and cue lists', STATUS, sampleCatalog()],
	['with a status list, lists unknown', STATUS, emptyCatalog()],
	['catalog only (status feed off)', emptyState(), sampleCatalog()],
	['without status or lists', emptyState(), emptyCatalog()],
]) {
	test(`presets reference real actions, feedbacks and options (${label})`, () => {
		const self = fakeSelf(status, catalog)
		const actions = getActionDefinitions(self)
		const feedbacks = getFeedbackDefinitions(self)
		const presets = getPresetDefinitions(self)
		const checkAction = (id, a) => {
			const def = actions[a.actionId]
			assert.ok(def, `${id}: action ${a.actionId}`)
			const known = new Set(def.options.map((o) => o.id))
			for (const k of Object.keys(a.options)) assert.ok(known.has(k), `${id}: ${a.actionId}.${k}`)
		}
		for (const [id, p] of Object.entries(presets)) {
			assert.equal(p.type, 'button', id)
			assert.ok(p.category && p.name, id)
			for (const step of p.steps) {
				for (const a of [...step.down, ...step.up]) checkAction(id, a)
				if (step.rotate_left || step.rotate_right) {
					assert.equal(p.options && p.options.rotaryActions, true, `${id}: rotary steps need rotaryActions`)
					for (const a of [...(step.rotate_left || []), ...(step.rotate_right || [])]) checkAction(id, a)
				}
			}
			for (const f of p.feedbacks) {
				const def = feedbacks[f.feedbackId]
				assert.ok(def, `${id}: feedback ${f.feedbackId}`)
				const known = new Set(def.options.map((o) => o.id))
				for (const k of Object.keys(f.options)) assert.ok(known.has(k), `${id}: ${f.feedbackId}.${k}`)
				if (def.type === 'advanced') assert.equal(f.style, undefined, `${id}: an advanced feedback takes no style`)
			}
		}
		// every action / feedback definition is well-formed
		for (const [id, a] of Object.entries(actions)) {
			assert.equal(typeof a.name, 'string', id)
			assert.equal(typeof a.callback, 'function', id)
			assert.ok(Array.isArray(a.options), id)
			for (const o of a.options) assert.ok(o.id && o.type && o.label !== undefined, `${id}.${o.id}`)
		}
		for (const [id, f] of Object.entries(feedbacks)) {
			assert.ok(f.type === 'boolean' || f.type === 'advanced', id)
			if (f.type === 'boolean') assert.ok(f.defaultStyle, id)
		}
		const names = Object.keys(presets)
		for (const g of ['blank', 'show_mode', 'stop_all', 'correction_bypass', 'projectors_on', 'resync', 'refresh_lists', 'dial_master_volume'])
			assert.ok(names.includes(g), g)
		const comps = status.compositions && status.compositions.length ? status.compositions : catalog.comps || []
		if (comps.length) {
			for (const p of ['comp_comp1_play', 'comp_comp2_next', 'comp_comp1_remaining', 'comp_comp1_dial_volume', 'comp_comp1_dial_cue'])
				assert.ok(names.includes(p), p)
		}
		if (catalog.comps) {
			assert.ok(names.includes('comp_comp1_cue_3'), 'one preset per cue')
			assert.equal(presets.comp_comp1_cue_3.category, 'Cues: Main Show')
			assert.deepEqual(presets.comp_comp1_cue_3.steps[0].down, [{ actionId: 'cue_go', options: { comp: 'comp1', compText: '', cue: '3' } }])
			assert.ok(names.includes('comp_comp2_cue_2'))
			assert.ok(names.includes('button_control_script_1'))
			assert.equal(presets.button_control_script_1.category, 'Command buttons')
			assert.deepEqual(presets.button_control_script_1.steps[0].down[0].options, { button: 'control_script_1', id: '' })
		} else {
			assert.ok(!names.some((n) => /_cue_\d+$/.test(n)), 'no cue presets while the lists are unknown')
			assert.ok(!names.some((n) => n.startsWith('button_')))
		}
		const categories = new Set(Object.values(presets).map((p) => p.category))
		for (const c of categories) assert.match(c, /^(Show|Transport: |Cues: |Command buttons|Dials: )/, c)

		const defs = getVariableDefinitions(self)
		const ids = defs.map((d) => d.variableId)
		assert.equal(new Set(ids).size, ids.length, 'variable ids are unique')
		for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/)
		const vals = getVariableValues(self)
		for (const id of ids) if (!['last_reply', 'last_error', 'button_last'].includes(id)) assert.ok(id in vals, `value for ${id}`)
		assert.equal(vals.connection, 'ok')
		// every $(exaplay:…) a preset shows is a defined variable
		const re = /\$\(exaplay:([A-Za-z0-9_-]+)\)/g
		for (const [id, p] of Object.entries(presets)) for (const m of p.style.text.matchAll(re)) assert.ok(ids.includes(m[1]), `${id} shows undefined $(exaplay:${m[1]})`)
	})
}

test('dropdowns: cue picks and command buttons come from the catalog', () => {
	const self = fakeSelf(STATUS, sampleCatalog())
	const a = getActionDefinitions(self)
	const pick = a.cue_go_pick.options[0]
	assert.deepEqual(pick.choices.map((c) => c.id), ['comp1|1', 'comp1|2', 'comp1|3', 'comp2|1', 'comp2|2'])
	assert.match(pick.choices[2].label, /Main Show › 3 +Blackout/)
	assert.deepEqual(a.fire_button.options[0].choices, [{ id: 'control_script_1', label: 'Doors open (control_script_1)' }])
	assert.equal(a.fire_button.options[0].allowCustom, true)
})

test('feedbacks: true only on a known value', async () => {
	const self = fakeSelf(emptyState())
	const fbs = getFeedbackDefinitions(self)
	const ctx = { parseVariablesInString: async (s) => s }
	const o = (x) => ({ options: { comp: 'comp1', compText: '', ...x } })
	assert.equal(fbs.blank.callback({ options: {} }, ctx), false)
	assert.equal(fbs.status_unknown.callback({ options: {} }, ctx), true)
	assert.equal(await fbs.comp_state.callback(o({ state: 'playing' }), ctx), false)
	assert.equal(await fbs.comp_unknown.callback(o({}), ctx), true)
	assert.equal(await fbs.cue_current.callback(o({ cue: '2' }), ctx), false)
	assert.equal(await fbs.cue_next.callback(o({ cue: '3' }), ctx), false)
	assert.equal(await fbs.comp_remaining_below.callback(o({ seconds: 1000, playingOnly: false }), ctx), false)
	assert.deepEqual(await fbs.comp_progress.callback(o({ warn: 30, critical: 10 }), ctx), {})
	self.status = STATUS
	assert.equal(await fbs.comp_state.callback(o({ state: 'playing' }), ctx), true)
	assert.equal(await fbs.comp_state.callback({ options: { comp: 'x', compText: 'Lobby', state: 'stopped' } }, ctx), true)
	assert.equal(await fbs.comp_unknown.callback(o({}), ctx), false)
	// current cue from /status alone (index), next cue needs the list
	assert.equal(await fbs.cue_current.callback(o({ cue: '2' }), ctx), true)
	assert.equal(await fbs.cue_current.callback(o({ cue: 'scene a' }), ctx), true)
	assert.equal(await fbs.cue_current.callback(o({ cue: '3' }), ctx), false)
	assert.equal(await fbs.cue_next.callback(o({ cue: '3' }), ctx), false, 'lists unknown: unlit')
	self.catalog.state = sampleCatalog()
	assert.equal(await fbs.cue_next.callback(o({ cue: '3' }), ctx), true)
	assert.equal(await fbs.cue_next.callback(o({ cue: 'Blackout' }), ctx), true)
	assert.equal(await fbs.cue_next.callback(o({ cue: '2' }), ctx), false)
	// playlist stopped with nothing playing: next = the first item
	assert.equal(await fbs.cue_next.callback({ options: { comp: 'comp2', compText: '', cue: '1' } }, ctx), true)
	// remaining: 100 − 31 = 69 s
	assert.equal(await fbs.comp_remaining_below.callback(o({ seconds: 70, playingOnly: true }), ctx), true)
	assert.equal(await fbs.comp_remaining_below.callback(o({ seconds: 60, playingOnly: true }), ctx), false)
	assert.deepEqual(await fbs.comp_progress.callback(o({ warn: 30, critical: 10 }), ctx), { bgcolor: COLORS.darkGreen, color: COLORS.white })
	assert.equal((await fbs.comp_progress.callback(o({ warn: 80, critical: 10 }), ctx)).bgcolor, COLORS.amber)
	assert.equal((await fbs.comp_progress.callback(o({ warn: 80, critical: 70 }), ctx)).bgcolor, COLORS.red)
	// the picked cue lights while it waits for GO
	assert.equal(await fbs.cue_selected.callback(o({}), ctx), false)
	self.selected.comp1 = 3
	assert.equal(await fbs.cue_selected.callback(o({}), ctx), true)
	self.selected.comp1 = 2
	assert.equal(await fbs.cue_selected.callback(o({}), ctx), false, 'picked = current: nothing waits')
	// command button result
	assert.equal(fbs.button_failed.callback({ options: { button: 'b' } }), false)
	self.buttonResults.b = { ok: false, error: 'already running' }
	assert.equal(fbs.button_failed.callback({ options: { button: 'b' } }), true)
	// a running sequence lights its key; unknown (not reported) never does
	const statusBefore = self.status
	self.status = { ...statusBefore, buttonsRunning: undefined }
	assert.equal(fbs.button_running.callback({ options: { button: 'b' } }), false)
	self.status = { ...statusBefore, buttonsRunning: ['b'] }
	assert.equal(fbs.button_running.callback({ options: { button: 'b' } }), true)
	assert.equal(fbs.button_running.callback({ options: { button: 'c' } }), false)
	self.status = statusBefore
	// links
	self.tcpState = 'connecting'
	assert.equal(fbs.connected.callback({ options: { link: 'both' } }), false)
	assert.equal(fbs.connected.callback({ options: { link: 'status' } }), true)
	assert.equal(fbs.connection_lost.callback({ options: { blink: false } }), true)
	self.blinkOn = false
	assert.equal(fbs.connection_lost.callback({ options: { blink: true } }), false, 'off phase of the flash')
	self.tcpState = 'connected'
	assert.equal(fbs.connection_lost.callback({ options: { blink: false } }), false)
})

test('actions route through the right sender', async () => {
	const calls = []
	const self = fakeSelf(STATUS, sampleCatalog())
	self.runTcp = async (b) => calls.push(['tcp', b.ok ? b.line : `!${b.error}`])
	self.runOsc = (b) => calls.push(['osc', b.ok ? `${b.address} ${b.args.map((a) => a.value).join(' ')}`.trim() : `!${b.error}`])
	self.runHttp = async (b) => calls.push(['http', b.ok ? `${b.method} ${b.path} ${b.body || ''}`.trim() : `!${b.error}`])
	self.runStopAll = async () => calls.push(['http', '/stop'])
	self.runFireButton = async (id) => calls.push(['http', `/control/fire ${id}`])
	self.runPjlinkAll = async (on) => calls.push(['http', `pjlink-all ${on}`])
	self.reportError = (what, e) => calls.push(['error', `${what}: ${e}`])
	self.refreshLists = async () => calls.push(['refresh'])
	self.resync = () => calls.push(['resync'])
	self.setVariableValues = (v) => calls.push(['vars', v])
	const dialCalls = (kind) => ({ set: (v) => calls.push([kind, 'set', v]), nudge: (d) => calls.push([kind, 'nudge', d]), setRange: () => {} })
	self.levelDial = (id, which) => dialCalls(`${which}:${id}`)
	self.masterDial = () => dialCalls('master')
	self.seekDial = (id) => dialCalls(`seek:${id}`)
	self.seekMax = () => 100
	self.inputDial = (ch, axis, r) => dialCalls(`input:${ch}:${axis}:${r.min}..${r.max}@${r.start}`)
	self.stepSelectedCue = (id, step) => calls.push(['select', id, step])
	self.goSelectedCue = async (id) => calls.push(['go-selected', id])
	const a = getActionDefinitions(self)
	const ctx = { parseVariablesInString: async (s) => s.replace('$(internal:x)', '7') }
	const run = (id, options) => a[id].callback({ options }, ctx)
	await run('comp_play', { comp: 'comp1', compText: '' })
	await run('comp_toggle', { comp: 'comp1', compText: '' })
	await run('comp_toggle', { comp: 'comp2', compText: '' })
	await run('comp_toggle', { comp: 'gone', compText: '' })
	await run('comp_previous', { comp: 'comp2', compText: 'comp_lobby' })
	await run('cue_go', { comp: 'comp1', compText: '', cue: '$(internal:x)' })
	await run('cue_go_pick', { pick: 'comp2|2' })
	await run('cue_go_pick', { pick: '' })
	await run('show_mode', { mode: 'on' })
	await run('blank', { mode: 'on', fade: '2.5' })
	await run('audio_mute', { mode: 'toggle' })
	await run('outlines', { mode: 'off' })
	await run('correction_bypass', { mode: 'on' })
	await run('blank_fade', { seconds: '3' })
	await run('play_all', {})
	await run('stop_all', {})
	await run('fire_button', { button: 'control_script_1', id: '' })
	await run('fire_button', { button: 'control_script_1', id: 'typed_id' })
	await run('fire_button', { id: 'legacy_id' }) // a 1.0 action: text id only
	await run('raw_tcp', { line: 'comp1.set:vol=80' })
	await run('show_page', { page: 'next' })
	await run('pjlink_all', { power: 'off' })
	await run('restart_engine', { mode: 'clean', confirm: false })
	await run('restart_engine', { mode: 'clean', confirm: true })
	await run('comp_seek', { comp: 'comp1', compText: '', time: '1:05.5' })
	await run('comp_seek', { comp: 'comp1', compText: '', time: 'soon' })
	await run('comp_seek_relative', { comp: 'comp1', compText: '', delta: -5 })
	await run('comp_seek_frame', { comp: 'comp1', compText: '', frame: '750' })
	await run('comp_loop', { comp: 'comp1', compText: '', mode: 'on' })
	await run('comp_volume_set', { comp: 'comp1', compText: '', value: '$(internal:x)' })
	await run('comp_volume_nudge', { comp: 'x', compText: 'Main Show', delta: -2 })
	await run('comp_opacity_set', { comp: 'comp1', compText: '', value: 'loud' })
	await run('comp_opacity_nudge', { comp: 'comp1', compText: '', delta: 2 })
	await run('master_volume_set', { value: '50' })
	await run('master_volume_nudge', { delta: 1 })
	await run('cue_select_step', { comp: 'comp1', compText: '', step: 1 })
	await run('cue_select_go', { comp: 'comp1', compText: '' })
	await run('inputs_send', { channel: 'wand', form: 'xy', a: '0.25', b: '0.75' })
	await run('inputs_send', { channel: 'wand', form: 'click', a: '', b: '' })
	await run('inputs_nudge', { channel: 'fader', axis: 'x', delta: 0.1, min: 0, max: 1, start: 0.5 })
	await run('inputs_groups', { command: 'group:scene2=on' })
	await run('osc_send', { address: '/exaplay/comp1/cue', args: 's:Blackout' })
	await run('http_send', { method: 'POST', path: '/cue/trigger', body: '{"name":"Blackout"}' })
	await run('refresh_lists', {})
	await run('resync', {})
	await run('clear_error', {})
	assert.deepEqual(calls, [
		['tcp', 'comp1.play'],
		['tcp', 'comp1.pause'],
		['tcp', 'comp2.play'],
		['tcp', '!Composition state unknown (no status feed) — toggle not sent'],
		['tcp', 'comp_lobby.prev'],
		['tcp', 'comp1.cue.go=7'],
		['tcp', 'comp2.cue.go=2'],
		['error', 'Cue: go: no cue picked (expected <composition>|<index>)'],
		['tcp', 'system.showmode=on'],
		['tcp', 'system.blank=on,2.5'],
		['tcp', 'system.audiomute=toggle'],
		['osc', '/exaplay/global/showguides off'],
		['osc', '/exaplay/global/correctionbypass on'],
		['tcp', 'system.blankfade=3'],
		['tcp', 'system.playall'],
		['http', '/stop'],
		['http', '/control/fire control_script_1'],
		['http', '/control/fire typed_id'],
		['http', '/control/fire legacy_id'],
		['tcp', 'comp1.set:vol=80'],
		['tcp', 'system.showpage=next'],
		['http', 'pjlink-all false'],
		['tcp', '!Restart not sent: tick "Yes, restart the engine" in the action first'],
		['tcp', 'system.restart=clean'],
		['seek:comp1', 'set', 65.5],
		['error', 'Jump to time: Time must be seconds or [h:]mm:ss (got "soon")'],
		['seek:comp1', 'nudge', -5],
		['osc', '/exaplay/comp1/frame 750'],
		['tcp', 'comp1.set:loop=on'],
		['volume:comp1', 'set', 7],
		['volume:comp1', 'nudge', -2],
		['error', 'Set opacity: "loud" is not a number'],
		['opacity:comp1', 'nudge', 2],
		['master', 'set', 50],
		['master', 'nudge', 1],
		['select', 'comp1', 1],
		['go-selected', 'comp1'],
		['tcp', 'track,wand,0.25,0.75'],
		['tcp', 'track,wand,click'],
		['input:fader:x:0..1@0.5', 'nudge', 0.1],
		['http', 'POST /tracking {"command":"group:scene2=on"}'],
		['osc', '/exaplay/comp1/cue Blackout'],
		['http', 'POST /cue/trigger {"name":"Blackout"}'],
		['refresh'],
		['resync'],
		['vars', { last_error: '' }],
	])
})

test('loop toggle reads first and sends nothing on an unknown state', async () => {
	const calls = []
	const self = fakeSelf(STATUS)
	let loopReply = '1'
	self.runTcp = async (b) => {
		calls.push(b.ok ? b.line : `!${b.error}`)
		return b.line && b.line.endsWith('get:loop') ? { ok: true, value: loopReply } : { ok: true }
	}
	self.reportError = (what, e) => calls.push(`error ${e}`)
	const a = getActionDefinitions(self)
	await a.comp_loop.callback({ options: { comp: 'comp1', compText: '', mode: 'toggle' } }, { parseVariablesInString: async (s) => s })
	loopReply = 'maybe'
	await a.comp_loop.callback({ options: { comp: 'comp1', compText: '', mode: 'toggle' } }, { parseVariablesInString: async (s) => s })
	assert.deepEqual(calls, ['comp1.get:loop', 'comp1.set:loop=off', 'comp1.get:loop', 'error current loop state unknown ("maybe") — toggle not sent'])
})

test('learn fills the value from the engine', async () => {
	const self = fakeSelf(STATUS, sampleCatalog())
	self.levelDial = () => ({ read: async () => ({ ok: true, value: 37.5 }) })
	self.masterDial = () => ({ read: async () => ({ ok: false, error: 'HTTP 404' }) })
	const errors = []
	self.reportError = (w, e) => errors.push(e)
	const a = getActionDefinitions(self)
	const ctx = { parseVariablesInString: async (s) => s }
	assert.deepEqual(await a.comp_volume_set.learn({ options: { comp: 'comp1', compText: '', value: '100' } }, ctx), {
		comp: 'comp1',
		compText: '',
		value: '37.5',
	})
	assert.equal(await a.master_volume_set.learn({ options: { value: '100' } }, ctx), undefined)
	assert.deepEqual(errors, ['HTTP 404'])
})

test('config defaults, the link word and the lists word', () => {
	const ids = getConfigFields().map((f) => f.id)
	for (const id of ['host', 'tcpPort', 'httpPort', 'oscPort', 'oscPrefix', 'statusEnabled', 'statusRate']) assert.ok(ids.includes(id), id)
	const c = withDefaults({ host: ' 10.0.0.5 ' })
	assert.equal(c.host, '10.0.0.5')
	assert.equal(c.tcpPort, 8100)
	assert.equal(c.httpPort, 8123)
	assert.equal(c.statusRate, 5)
	assert.equal(connectionWord('connected', 'connected', true), 'ok')
	assert.equal(connectionWord('connected', 'disconnected', true), 'partial')
	assert.equal(connectionWord('connected', 'disconnected', false), 'ok')
	assert.equal(connectionWord('disconnected', 'connected', true), 'partial')
	assert.equal(connectionWord('connecting', 'disconnected', true), 'disconnected')
	assert.equal(listsWord(emptyCatalog(), false), '?')
	assert.equal(listsWord(sampleCatalog(), true), 'refreshing')
	assert.equal(listsWord(sampleCatalog(), false), 'ok')
	assert.equal(listsWord({ ...sampleCatalog(), buttonsError: 'HTTP 404' }, false), 'error: HTTP 404')
})

test('switch transport OSC: an older engine gets the OSC verbs', async () => {
	const calls = []
	const self = fakeSelf(STATUS, sampleCatalog())
	self.config = { ...self.config, switchTransport: 'osc' }
	self.runTcp = async (b) => calls.push(['tcp', b.ok ? b.line : `!${b.error}`])
	self.runOsc = (b) => calls.push(['osc', b.ok ? `${b.address} ${b.args.map((a) => a.value).join(' ')}`.trim() : `!${b.error}`])
	const a = getActionDefinitions(self)
	const ctx = { parseVariablesInString: async (s) => s }
	await a.blank.callback({ options: { mode: 'on', fade: '' } }, ctx)
	await a.identify.callback({ options: { mode: 'toggle' } }, ctx)
	await a.blank_fade.callback({ options: { seconds: '2' } }, ctx)
	await a.play_all.callback({ options: {} }, ctx)
	assert.deepEqual(calls, [
		['osc', '/exaplay/global/videomute on'],
		['osc', '/exaplay/global/identify toggle'],
		['osc', '/exaplay/global/blankfade 2'],
		['osc', '/exaplay/global/start'],
	])
})
