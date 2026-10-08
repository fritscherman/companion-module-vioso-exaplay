'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const s = require('../src/lib/status')

// The example frame from the /status v1 contract.
const FULL = {
	type: 'status',
	v: 1,
	loading: false,
	project: { name: 'Show.vpp', unsaved: false },
	'show-mode': false,
	blank: true,
	'blank-fade': 1.0,
	'audio-mute': false,
	identify: false,
	outlines: true,
	'correction-bypass': false,
	'show-page': '',
	compositions: [
		{
			id: 'comp1',
			uid: 123,
			name: 'Main Show',
			type: 'timeline',
			state: 'playing',
			time: 12.3,
			cue: { index: 3, name: 'Blackout' },
			'next-cue-in': 4.2,
			item: null,
		},
		{
			id: 'comp2',
			uid: 124,
			name: 'Lobby',
			type: 'playlist',
			state: 'paused',
			time: 1.5,
			cue: { index: 2, name: 'Act 1' },
			'next-cue-in': 28.5,
			item: { time: 1.5, duration: 30.0 },
		},
	],
}

test('a full v1 snapshot is read', () => {
	const r = s.parseMessage(JSON.stringify(FULL))
	assert.equal(r.kind, 'status')
	const st = r.state
	assert.equal(st.known, true)
	assert.equal(st.projectName, 'Show.vpp')
	assert.equal(st.projectUnsaved, false)
	assert.equal(st.showMode, false)
	assert.equal(st.blank, true)
	assert.equal(st.blankFade, 1)
	assert.equal(st.outlines, true)
	assert.equal(st.compositions.length, 2)
	assert.deepEqual(st.compositions[0], {
		id: 'comp1',
		uid: 123,
		name: 'Main Show',
		type: 'timeline',
		state: 'playing',
		time: 12.3,
		duration: undefined, // an engine that does not send it: unknown
		cue: { index: 3, name: 'Blackout' },
		nextCueIn: 4.2,
		item: null,
	})
})

test('heartbeat, unknown types, versions and garbage', () => {
	assert.deepEqual(s.parseMessage('{"type":"alive","v":1}'), { kind: 'alive' })
	assert.equal(s.parseMessage('{"type":"alive","v":2}').kind, 'ignored')
	assert.equal(s.parseMessage('{"type":"status"}').kind, 'ignored')
	assert.equal(s.parseMessage('{"type":"future","v":1}').kind, 'ignored')
	assert.equal(s.parseMessage('nope').kind, 'ignored')
	assert.equal(s.parseMessage('[1]').kind, 'ignored')
	assert.equal(s.parseMessage('null').kind, 'ignored')
})

test('unknown keys are ignored; absent keys are UNKNOWN, never false', () => {
	const r = s.parseMessage(JSON.stringify({ type: 'status', v: 1, loading: true, compositions: [], 'new-thing': 7 }))
	const st = r.state
	assert.equal(st.loading, true)
	assert.deepEqual(st.compositions, [])
	for (const k of ['showMode', 'blank', 'audioMute', 'identify', 'outlines', 'projectName', 'blankFade'])
		assert.equal(st[k], undefined, k)
	const v = s.variableValues(st)
	assert.equal(v.blank, '?')
	assert.equal(v.show_mode, '?')
	assert.equal(v.project_name, '?')
	assert.equal(v.composition_count, '0')
	assert.equal(v.loading, 'on')
})

test('a snapshot REPLACES the previous one (a dropped key does not keep its old value)', () => {
	const a = s.parseMessage(JSON.stringify(FULL)).state
	const { blank, ...rest } = FULL
	const b = s.parseMessage(JSON.stringify(rest)).state
	assert.equal(a.blank, true)
	assert.equal(b.blank, undefined)
})

test('wrongly typed values are unknown', () => {
	const st = s.parseMessage(
		JSON.stringify({
			type: 'status',
			v: 1,
			blank: 'yes',
			'show-mode': 1,
			compositions: [{ id: 'c', state: 'flying', time: '3', cue: 'x', 'next-cue-in': 'soon' }, { name: 'no id' }, 7],
		}),
	).state
	assert.equal(st.blank, undefined)
	assert.equal(st.showMode, undefined)
	assert.equal(st.compositions.length, 1)
	const c = st.compositions[0]
	assert.equal(c.state, undefined)
	assert.equal(c.time, undefined)
	assert.equal(c.cue, undefined)
	assert.equal(c.nextCueIn, undefined)
	assert.equal(c.item, undefined) // absent key
})

test('variables per composition', () => {
	const st = s.parseMessage(JSON.stringify(FULL)).state
	const v = s.variableValues(st)
	assert.equal(v.comp_comp1_state, 'playing')
	assert.equal(v.comp_comp1_time, '0:12.3')
	assert.equal(v.comp_comp1_time_s, '12.3')
	assert.equal(v.comp_comp1_cue_name, 'Blackout')
	assert.equal(v.comp_comp1_cue_index, '3')
	assert.equal(v.comp_comp1_next_cue_in, '0:04.2')
	assert.equal(v.comp_comp1_item_remaining, '-') // timeline: item null
	assert.equal(v.comp_comp2_item_remaining, '0:28.5')
	assert.equal(v.comp_comp2_state, 'paused')
	assert.equal(v.blank, 'on')
	assert.equal(v.blank_fade, '1.0')
	assert.equal(v.composition_count, '2')

	const none = s.parseMessage(
		JSON.stringify({ type: 'status', v: 1, compositions: [{ id: 'c3', state: 'stopped', time: 0, cue: null, 'next-cue-in': null }] }),
	).state
	const v2 = s.variableValues(none)
	assert.equal(v2.comp_c3_cue_name, '-')
	assert.equal(v2.comp_c3_cue_index, '-')
	assert.equal(v2.comp_c3_next_cue_in, '-')
	assert.equal(v2.comp_c3_item_remaining, '?') // item absent: unknown
	assert.equal(v2.comp_c3_name, '?')
})

test('every defined variable has a value and a valid id', () => {
	const st = s.parseMessage(JSON.stringify(FULL)).state
	const defs = s.variableDefinitions(st)
	const vals = s.variableValues(st)
	const ids = defs.map((d) => d.variableId)
	assert.equal(new Set(ids).size, ids.length)
	for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/)
	const linkOnly = new Set(['connection', 'tcp_state', 'status_state', 'last_reply', 'last_error', 'lists_state', 'master_volume', 'button_last'])
	for (const id of ids) if (!linkOnly.has(id)) assert.ok(id in vals, id)
})

test('removed compositions are blanked, not frozen on their last time', () => {
	const a = s.parseMessage(JSON.stringify(FULL)).state
	const b = s.parseMessage(JSON.stringify({ ...FULL, compositions: [FULL.compositions[1]] })).state
	const stale = s.staleVariableValues(a, b)
	assert.equal(stale.comp_comp1_time, '?')
	assert.equal(stale.comp_comp1_state, '?')
	assert.equal(stale.comp_comp2_time, undefined)
	assert.deepEqual(s.staleVariableValues(a, s.emptyState()).comp_comp2_state, '?')
})

test('lookup, keys, signature and choices', () => {
	const st = s.parseMessage(JSON.stringify(FULL)).state
	assert.equal(s.findComposition(st, 'comp2').name, 'Lobby')
	assert.equal(s.findComposition(st, 'main_show').id, 'comp1')
	assert.equal(s.findComposition(st, 'nope'), undefined)
	assert.equal(s.findComposition(s.emptyState(), 'comp1'), undefined)
	assert.equal(s.varKey('comp 1.x'), 'comp_1_x')
	const sig = s.compositionSignature(st)
	const st2 = s.parseMessage(JSON.stringify({ ...FULL, compositions: FULL.compositions.map((c) => ({ ...c, time: 99 })) })).state
	assert.equal(s.compositionSignature(st2), sig, 'time ticks do not redefine anything')
	assert.notEqual(s.compositionSignature(s.emptyState()), sig)
	assert.deepEqual(s.compositionChoices(st), [
		{ id: 'comp1', label: 'Main Show (comp1)' },
		{ id: 'comp2', label: 'Lobby (comp2)' },
	])
})

/* ------------------------------------------------------------------ 1.1 --- */

const withDuration = (extra = {}) =>
	s.parseMessage(
		JSON.stringify({
			type: 'status',
			v: 1,
			compositions: [
				{ id: 'comp1', name: 'Main Show', type: 'timeline', state: 'playing', time: 30, duration: 120, cue: { index: 2, name: 'Scene A' }, 'next-cue-in': 60, item: null, ...extra },
				{ id: 'comp2', name: 'Lobby', type: 'playlist', state: 'playing', time: 61, cue: { index: 1, name: 'Opening' }, 'next-cue-in': 28.5, item: { time: 1.5, duration: 30 } },
			],
		}),
	).state

const CATALOG = {
	known: true,
	comps: [
		{ id: 'comp1', name: 'Main Show', type: 'timeline', cues: [{ index: 1, name: 'Intro', offset: 0 }, { index: 2, name: 'Scene A', offset: 20 }, { index: 3, name: 'Blackout', offset: 90 }] },
		{ id: 'comp2', name: 'Lobby', type: 'playlist', cues: [{ index: 1, name: 'Opening' }, { index: 2, name: 'Act 1' }] },
		{ id: 'comp9', name: 'Spare', type: 'other', cues: [] },
	],
	buttons: [{ id: 'b1', label: 'Doors' }],
}

test('duration (Timeline) → remaining, progress, clock forms', () => {
	const st = withDuration()
	assert.equal(st.compositions[0].duration, 120)
	assert.equal(st.compositions[1].duration, undefined, 'a Playlist carries no duration')
	assert.equal(s.remainingOf(st.compositions[0]), 90)
	assert.equal(s.remainingOf(st.compositions[1]), 28.5)
	assert.equal(s.progressOf(st.compositions[0]), 0.25)
	assert.equal(s.progressOf(st.compositions[1]), 0.05)
	const v = s.variableValues(st, { catalog: CATALOG })
	assert.equal(v.comp_comp1_duration, '2:00.0')
	assert.equal(v.comp_comp1_remaining, '1:30.0')
	assert.equal(v.comp_comp1_remaining_s, '90')
	assert.equal(v.comp_comp1_remaining_hms, '0:01:30')
	assert.equal(v.comp_comp1_remaining_mmss, '01:30')
	assert.equal(v.comp_comp1_time_hms, '0:00:30')
	assert.equal(v.comp_comp1_progress, '25')
	assert.equal(v.comp_comp1_progress_bar, '▰▰▰▱▱▱▱▱▱▱')
	assert.equal(v.comp_comp1_playing, 'on')
	assert.equal(v.comp_comp2_remaining, '0:28.5')
	assert.equal(v.comp_comp2_progress, '5')
})

test('remaining time is UNKNOWN without duration — never 0, never "ended"', () => {
	const st = withDuration({ duration: undefined })
	const v = s.variableValues(st)
	assert.equal(v.comp_comp1_duration, '?')
	assert.equal(v.comp_comp1_remaining, '?')
	assert.equal(v.comp_comp1_remaining_s, '?')
	assert.equal(v.comp_comp1_progress, '?')
	assert.equal(v.comp_comp1_progress_bar, '?')
	assert.equal(s.remainingOf(st.compositions[0]), undefined)
	// zero length: progress unknown rather than a division by zero
	assert.equal(s.progressOf(withDuration({ duration: 0 }).compositions[0]), undefined)
	// a Playlist with nothing playing: there is NO remaining time
	const none = s.parseMessage(JSON.stringify({ type: 'status', v: 1, compositions: [{ id: 'c', type: 'playlist', state: 'stopped', cue: null, item: null }] })).state
	assert.equal(s.variableValues(none).comp_c_remaining, '-')
})

test('next cue name/index from the cue list; cue count; unknown without a list', () => {
	const st = withDuration()
	const v = s.variableValues(st, { catalog: CATALOG })
	assert.equal(v.comp_comp1_next_cue_name, 'Blackout')
	assert.equal(v.comp_comp1_next_cue_index, '3')
	assert.equal(v.comp_comp2_next_cue_name, 'Act 1')
	assert.equal(v.comp_comp1_cue_count, '3')
	const u = s.variableValues(st)
	assert.equal(u.comp_comp1_next_cue_name, '?')
	assert.equal(u.comp_comp1_cue_count, '?')
	assert.equal(u.button_count, '?')
	assert.equal(v.button_count, '1')
})

test('compositions only the catalog knows get variables too (status feed off)', () => {
	const v = s.variableValues(s.emptyState(), { catalog: CATALOG, levels: { comp9: { volume: 37.5 } }, selected: { comp1: 3 } })
	assert.equal(v.comp_comp9_name, 'Spare')
	assert.equal(v.comp_comp9_state, '?')
	assert.equal(v.comp_comp9_volume, '37.5')
	assert.equal(v.comp_comp9_opacity, '?')
	assert.equal(v.comp_comp1_selected_cue_index, '3')
	assert.equal(v.comp_comp1_selected_cue_name, 'Blackout')
	assert.equal(v.comp_comp2_selected_cue_name, '-')
	assert.equal(v.composition_count, '3')
	const defs = s.variableDefinitions(s.emptyState(), CATALOG).map((d) => d.variableId)
	assert.ok(defs.includes('comp_comp9_remaining_mmss'))
	assert.deepEqual(s.compositionChoices(s.emptyState(), CATALOG).map((c) => c.id), ['comp1', 'comp2', 'comp9'])
	// status first, then catalog-only compositions; no duplicates
	assert.deepEqual(s.allCompositions(withDuration(), CATALOG).map((c) => c.id), ['comp1', 'comp2', 'comp9'])
	assert.equal(s.resolveCompId(s.emptyState(), CATALOG, 'spare'), 'comp9')
	assert.equal(s.resolveCompId(withDuration(), CATALOG, 'main_show'), 'comp1')
	assert.equal(s.resolveCompId(s.emptyState(), CATALOG, 'other'), 'other')
	// leaving the catalog blanks them
	const stale = s.staleVariableValues(s.emptyState(), s.emptyState(), CATALOG, { comps: CATALOG.comps.slice(0, 2) })
	assert.equal(stale.comp_comp9_volume, '?')
	assert.equal(stale.comp_comp1_name, undefined)
})

test('buttons-running: a running command button is reported, unknown stays unknown', () => {
	const on = s.parseMessage(JSON.stringify({ ...FULL, 'buttons-running': ['btn-intro', 7, 'btn-outro'] }))
	assert.deepEqual(on.state.buttonsRunning, ['btn-intro', 'btn-outro'])
	assert.equal(s.buttonRunning(on.state, 'btn-intro'), true)
	assert.equal(s.buttonRunning(on.state, ' btn-outro '), true)
	assert.equal(s.buttonRunning(on.state, 'btn-other'), false)
	assert.equal(s.variableValues(on.state).buttons_running, 'btn-intro, btn-outro')

	const none = s.parseMessage(JSON.stringify({ ...FULL, 'buttons-running': [] }))
	assert.equal(s.buttonRunning(none.state, 'btn-intro'), false)
	assert.equal(s.variableValues(none.state).buttons_running, '-')

	// An engine that does not report it (FULL has no key): unknown, never "not running".
	const old = s.parseMessage(JSON.stringify(FULL))
	assert.equal(s.buttonRunning(old.state, 'btn-intro'), undefined)
	assert.equal(s.variableValues(old.state).buttons_running, '?')
	const bad = s.parseMessage(JSON.stringify({ ...FULL, 'buttons-running': 'btn-intro' }))
	assert.equal(s.buttonRunning(bad.state, 'btn-intro'), undefined)
})
