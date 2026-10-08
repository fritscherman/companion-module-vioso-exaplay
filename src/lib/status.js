'use strict'
/**
 * The `/status` WebSocket (protocol v1) → module state — pure.
 *
 * Contract (engine: engine-comm/comm-status-view.h):
 *  - `{"type":"status","v":1, ...}` is a FULL snapshot, sent on connect and
 *    whenever something in it changed. A snapshot REPLACES the previous one:
 *    a key it leaves out is UNKNOWN from then on, never "false" and never the
 *    previous value.
 *  - `{"type":"alive","v":1}` is a heartbeat (nothing changed for 5 s).
 *  - While a project loads: `loading:true`, `compositions:[]`, other keys
 *    may be absent.
 *  - Unknown keys are ignored (forward compatible).
 *
 * Every field below is `undefined` while unknown. Booleans are taken only
 * when they ARE booleans; numbers only when finite.
 */

const { formatTime, formatSeconds, formatBool, itemRemaining, formatClock, formatPercent, progressBar, UNKNOWN, NONE } = require('./format')
const { nextCue, findCue } = require('./cues')

const STATES = ['playing', 'paused', 'stopped']
const TYPES = ['timeline', 'playlist', 'other']

function emptyState() {
	return {
		/** true once a status snapshot has been read on the current socket */
		known: false,
		loading: undefined,
		projectName: undefined,
		projectUnsaved: undefined,
		showMode: undefined,
		blank: undefined,
		blankFade: undefined,
		audioMute: undefined,
		identify: undefined,
		outlines: undefined,
		correctionBypass: undefined,
		showPage: undefined,
		/** @type {string[]|undefined} ids of the command buttons running now; undefined = not reported */
		buttonsRunning: undefined,
		/** @type {Array<object>|undefined} in engine order; undefined = unknown */
		compositions: undefined,
	}
}

const bool = (v) => (typeof v === 'boolean' ? v : undefined)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v) => (typeof v === 'string' ? v : undefined)
/** number, null (= "there is none"), or undefined (unknown / wrong type) */
const numOrNull = (v) => (v === null ? null : num(v))

function readCue(c) {
	if (c === null) return null
	if (!c || typeof c !== 'object') return undefined
	return { index: num(c.index), name: str(c.name) }
}

function readItem(it) {
	if (it === null) return null
	if (!it || typeof it !== 'object') return undefined
	return { time: num(it.time), duration: num(it.duration) }
}

function readComposition(c) {
	if (!c || typeof c !== 'object') return null
	const id = str(c.id)
	if (!id) return null
	return {
		id,
		uid: num(c.uid),
		name: str(c.name),
		type: TYPES.includes(c.type) ? c.type : undefined,
		state: STATES.includes(c.state) ? c.state : undefined,
		time: num(c.time),
		// Timeline length in seconds (engine 2026-10). Absent on a Playlist and
		// on older engines: unknown, so remaining time / progress read "?".
		duration: num(c.duration),
		cue: 'cue' in c ? readCue(c.cue) : undefined,
		nextCueIn: 'next-cue-in' in c ? numOrNull(c['next-cue-in']) : undefined,
		item: 'item' in c ? readItem(c.item) : undefined,
	}
}

/**
 * Parse one text frame. Returns { kind: 'status', state } for a snapshot,
 * { kind: 'alive' } for a heartbeat, { kind: 'ignored' } for anything else
 * (malformed JSON, an unknown type, a future major version).
 */
function parseMessage(text) {
	let msg
	try {
		msg = JSON.parse(typeof text === 'string' ? text : String(text))
	} catch {
		return { kind: 'ignored', reason: 'not JSON' }
	}
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { kind: 'ignored', reason: 'not an object' }
	// v1 is the contract; a v2 would be a breaking change by definition.
	if (msg.v !== 1) return { kind: 'ignored', reason: `unsupported version ${JSON.stringify(msg.v)}` }
	if (msg.type === 'alive') return { kind: 'alive' }
	if (msg.type !== 'status') return { kind: 'ignored', reason: `unknown type ${JSON.stringify(msg.type)}` }

	const s = emptyState()
	s.known = true
	s.loading = bool(msg.loading)
	if (msg.project && typeof msg.project === 'object') {
		s.projectName = str(msg.project.name)
		s.projectUnsaved = bool(msg.project.unsaved)
	}
	s.showMode = bool(msg['show-mode'])
	s.blank = bool(msg.blank)
	s.blankFade = num(msg['blank-fade'])
	s.audioMute = bool(msg['audio-mute'])
	s.identify = bool(msg.identify)
	s.outlines = bool(msg.outlines)
	s.correctionBypass = bool(msg['correction-bypass'])
	s.showPage = str(msg['show-page'])
	if (Array.isArray(msg['buttons-running'])) {
		s.buttonsRunning = msg['buttons-running'].filter((x) => typeof x === 'string')
	}
	if (Array.isArray(msg.compositions)) {
		s.compositions = msg.compositions.map(readComposition).filter(Boolean)
	}
	return { kind: 'status', state: s }
}

/**
 * Is a command button's sequence running? true / false, or undefined when
 * the engine does not report it (no feed, or an engine older than
 * `buttons-running`) — unknown is never "not running".
 */
function buttonRunning(state, id) {
	if (!state || !Array.isArray(state.buttonsRunning)) return undefined
	return state.buttonsRunning.includes(String(id ?? '').trim())
}

/** Find a composition by id (exact) or, failing that, by name (case-insensitive). */
function findComposition(state, ref) {
	if (!state || !Array.isArray(state.compositions) || typeof ref !== 'string') return undefined
	const r = ref.trim()
	if (!r) return undefined
	const byId = state.compositions.find((c) => c.id === r)
	if (byId) return byId
	const norm = (x) => x.toLowerCase().replace(/_/g, ' ')
	return state.compositions.find((c) => c.name !== undefined && norm(c.name) === norm(r))
}

/** Companion variable ids allow letters, digits, `_` and `-`. */
function varKey(id) {
	return String(id).replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The composition list's identity — redefine variables/presets only when it changes. */
function compositionSignature(state) {
	if (!state || !Array.isArray(state.compositions)) return ''
	return JSON.stringify(state.compositions.map((c) => [c.id, c.name, c.type]))
}

/**
 * Remaining time of a composition, in seconds: Timeline `duration − time`
 * (needs the `duration` key), Playlist the playing item's remaining time.
 * undefined = unknown, null = there is none (a Playlist with nothing playing).
 */
function remainingOf(c) {
	if (!c) return undefined
	if (c.type === 'timeline') {
		if (typeof c.duration !== 'number' || typeof c.time !== 'number') return undefined
		return Math.max(0, c.duration - c.time)
	}
	if (c.type === 'playlist') return itemRemaining(c.item)
	return undefined
}

/** Progress 0..1: Timeline time/duration, Playlist item.time/item.duration; undefined when unknown. */
function progressOf(c) {
	if (!c) return undefined
	let t
	let d
	if (c.type === 'timeline') {
		t = c.time
		d = c.duration
	} else if (c.type === 'playlist' && c.item && typeof c.item === 'object') {
		t = c.item.time
		d = c.item.duration
	} else return undefined
	if (typeof t !== 'number' || typeof d !== 'number' || !(d > 0)) return undefined
	return Math.min(1, Math.max(0, t / d))
}

/**
 * Every composition known from either source, in status order, then those
 * only the catalog (TCP get:complist) knows — with the feed off the catalog
 * is the only list there is.
 */
function allCompositions(state, catalog) {
	const out = []
	const seen = new Set()
	for (const c of (state && state.compositions) || []) {
		seen.add(c.id)
		out.push({ id: c.id, name: c.name, type: c.type })
	}
	for (const c of (catalog && catalog.comps) || []) {
		if (seen.has(c.id)) continue
		seen.add(c.id)
		out.push({ id: c.id, name: c.name, type: c.type })
	}
	return out
}

/**
 * A composition reference (ID or name) → its ID when the feed or the catalog
 * knows it, else the reference as given (the engine resolves it itself).
 */
function resolveCompId(state, catalog, ref) {
	const r = typeof ref === 'string' ? ref.trim() : String(ref ?? '').trim()
	const c = findComposition(state, r)
	if (c) return c.id
	const cat = (catalog && catalog.comps) || []
	const byId = cat.find((x) => x.id === r)
	if (byId) return byId.id
	const norm = (x) => x.toLowerCase().replace(/_/g, ' ')
	const byName = cat.find((x) => typeof x.name === 'string' && norm(x.name) === norm(r))
	return byName ? byName.id : r
}

/** Per-composition variable suffixes (`comp_<id>_<suffix>`) and their labels. */
const COMP_VARS = [
	['name', 'name'],
	['state', 'state (playing / paused / stopped)'],
	['playing', 'playing (on / off / ?)'],
	['time', 'time (M:SS.t)'],
	['time_s', 'time, s'],
	['time_hms', 'time (H:MM:SS)'],
	['time_mmss', 'time (MM:SS)'],
	['duration', 'Timeline length (M:SS.t)'],
	['remaining', 'remaining: Timeline to its end, Playlist to the end of the item (M:SS.t)'],
	['remaining_s', 'remaining, whole seconds (rounded up)'],
	['remaining_hms', 'remaining (H:MM:SS, rounded up)'],
	['remaining_mmss', 'remaining (MM:SS, rounded up)'],
	['progress', 'progress, %'],
	['progress_bar', 'progress as a text bar'],
	['cue_name', 'current cue / item name'],
	['cue_index', 'current cue / item index'],
	['next_cue_name', 'next cue / item name'],
	['next_cue_index', 'next cue / item index'],
	['next_cue_in', 'time to next cue / end of item (M:SS.t)'],
	['item_remaining', 'playlist item remaining (M:SS.t)'],
	['cue_count', 'number of cues / items'],
	['selected_cue_name', 'cue picked with the cue dial'],
	['selected_cue_index', 'index of the cue picked with the cue dial'],
	['volume', 'volume, % (as last read or set by this module)'],
	['opacity', 'opacity, % (as last read or set by this module)'],
]

/**
 * Variable definitions for the current list. Fixed ones always; per
 * composition ones for every composition the feed or the catalog reported.
 */
/**
 * The 1.x module's per-composition variables (before 2.0.0), kept for the
 * buttons made with it while "Buttons from module 1.x" is on: same names
 * (`playback_status_comp1`, with the composition id as it was typed with its
 * "comp" prefix), same words (playing / paused / stop), values in seconds.
 * Unknown is "?", never the 1.x placeholder "0" — the feed did not say.
 */
const LEGACY_VARS = [
	['playback_status', 'Playback Status'],
	['current_time', 'Current Time'],
	['frame_index', 'Frame Index'],
	['cue_index', 'Cue Index'],
	['clip_index', 'Clip Index'],
	['composition_duration', 'Composition Duration'],
	['current_volume', 'Current Volume'],
]
const LEGACY_FPS = 60 // 1.x reported frames at the engine's 60 Hz cue clock

function legacyValues(c, meta, level) {
	const known = !!c
	const time = known && typeof c.time === 'number' ? c.time : undefined
	const cueIdx = known && c.cue !== undefined ? (c.cue === null ? NONE : c.cue.index === undefined ? UNKNOWN : String(c.cue.index)) : UNKNOWN
	const type = (c && c.type) || meta.type
	return {
		playback_status: !known || c.state === undefined ? UNKNOWN : c.state === 'stopped' ? 'stop' : c.state,
		current_time: time === undefined ? UNKNOWN : String(Math.round(time * 1000) / 1000),
		frame_index: time === undefined ? UNKNOWN : String(Math.floor(time * LEGACY_FPS + 1e-6)),
		cue_index: cueIdx,
		clip_index: type === 'playlist' ? cueIdx : NONE,
		composition_duration: known && typeof c.duration === 'number' ? String(Math.round(c.duration * 1000) / 1000) : UNKNOWN,
		current_volume: fmtNum(level && level.volume),
	}
}

function variableDefinitions(state, catalog, opts = {}) {
	const defs = [
		{ variableId: 'connection', name: 'Connection: TCP commands and status feed (ok / partial / disconnected)' },
		{ variableId: 'tcp_state', name: 'TCP command link (connected / connecting / disconnected)' },
		{ variableId: 'status_state', name: 'Status feed (connected / connecting / disconnected)' },
		{ variableId: 'loading', name: 'Project loading (on / off / ?)' },
		{ variableId: 'project_name', name: 'Project name' },
		{ variableId: 'project_unsaved', name: 'Project has unsaved changes (on / off / ?)' },
		{ variableId: 'show_mode', name: 'Show mode (on / off / ?)' },
		{ variableId: 'blank', name: 'Blank (on / off / ?)' },
		{ variableId: 'blank_fade', name: 'Blank fade time, s' },
		{ variableId: 'audio_mute', name: 'Audio mute (on / off / ?)' },
		{ variableId: 'identify', name: 'Identify (on / off / ?)' },
		{ variableId: 'outlines', name: 'Outlines (on / off / ?)' },
		{ variableId: 'correction_bypass', name: 'Correction bypass / raw wall (on / off / ?)' },
		{ variableId: 'show_page', name: 'VIOSO Spaces page on screen' },
		{ variableId: 'composition_count', name: 'Number of compositions' },
		{ variableId: 'master_volume', name: 'Engine master volume, % (as last read or set by this module)' },
		{ variableId: 'lists_state', name: 'Cue lists and command buttons (ok / refreshing / ? / error text)' },
		{ variableId: 'button_count', name: 'Number of command buttons in the project' },
		{ variableId: 'button_last', name: 'Last command button press and its result' },
		{ variableId: 'buttons_running', name: 'Command buttons running now (ids, comma-separated; - none; ? unknown)' },
		{ variableId: 'last_reply', name: 'Last reply' },
		{ variableId: 'last_error', name: 'Last error' },
	]
	for (const c of allCompositions(state, catalog)) {
		const k = `comp_${varKey(c.id)}`
		const label = c.name ? `${c.name} (${c.id})` : c.id
		for (const [suffix, what] of COMP_VARS) defs.push({ variableId: `${k}_${suffix}`, name: `${label}: ${what}` })
		if (opts.legacy) for (const [name, what] of LEGACY_VARS) defs.push({ variableId: `${name}_${varKey(c.id)}`, name: `(1.x) ${what} ${c.id}` })
	}
	return defs
}

const fmtNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 10) / 10) : UNKNOWN)

/**
 * Variable values for a state. Values that are unknown read UNKNOWN ("?");
 * values the engine reported as "none" read NONE ("-").
 *
 * ctx: { catalog, levels: {[compId]: {volume, opacity}}, selected: {[compId]: index} }
 */
function variableValues(state, ctx = {}) {
	const s = state || emptyState()
	const catalog = ctx.catalog
	const levels = ctx.levels || {}
	const selected = ctx.selected || {}
	const v = {
		loading: formatBool(s.loading),
		project_name: s.projectName === undefined ? UNKNOWN : s.projectName,
		project_unsaved: formatBool(s.projectUnsaved),
		show_mode: formatBool(s.showMode),
		blank: formatBool(s.blank),
		blank_fade: formatSeconds(s.blankFade),
		audio_mute: formatBool(s.audioMute),
		identify: formatBool(s.identify),
		outlines: formatBool(s.outlines),
		correction_bypass: formatBool(s.correctionBypass),
		show_page: s.showPage === undefined ? UNKNOWN : s.showPage,
		composition_count: Array.isArray(s.compositions)
			? String(s.compositions.length)
			: catalog && Array.isArray(catalog.comps)
				? String(catalog.comps.length)
				: UNKNOWN,
		button_count: catalog && Array.isArray(catalog.buttons) ? String(catalog.buttons.length) : UNKNOWN,
		buttons_running: !Array.isArray(s.buttonsRunning) ? UNKNOWN : s.buttonsRunning.length ? s.buttonsRunning.join(', ') : NONE,
	}
	const statusById = new Map(((s.compositions || [])).map((c) => [c.id, c]))
	for (const meta of allCompositions(s, catalog)) {
		const c = statusById.get(meta.id) // undefined: the feed does not report it → status values unknown
		const entry = catalog && Array.isArray(catalog.comps) ? catalog.comps.find((e) => e.id === meta.id) : undefined
		const k = `comp_${varKey(meta.id)}`
		const cueKnown = c && c.cue !== undefined
		const name = c && c.name !== undefined ? c.name : entry && entry.name !== undefined ? entry.name : undefined
		v[`${k}_name`] = name === undefined ? UNKNOWN : name
		v[`${k}_state`] = !c || c.state === undefined ? UNKNOWN : c.state
		v[`${k}_playing`] = !c || c.state === undefined ? UNKNOWN : formatBool(c.state === 'playing')
		v[`${k}_time`] = formatTime(c ? c.time : undefined)
		v[`${k}_time_s`] = formatSeconds(c ? c.time : undefined)
		v[`${k}_time_hms`] = formatClock(c ? c.time : undefined, 'hms')
		v[`${k}_time_mmss`] = formatClock(c ? c.time : undefined, 'mmss')
		v[`${k}_duration`] = formatTime(c && c.type === 'timeline' ? c.duration : undefined)
		const rem = remainingOf(c)
		v[`${k}_remaining`] = formatTime(rem)
		v[`${k}_remaining_s`] = formatClock(rem, 's', { up: true })
		v[`${k}_remaining_hms`] = formatClock(rem, 'hms', { up: true })
		v[`${k}_remaining_mmss`] = formatClock(rem, 'mmss', { up: true })
		const prog = progressOf(c)
		v[`${k}_progress`] = formatPercent(prog)
		v[`${k}_progress_bar`] = progressBar(prog)
		v[`${k}_cue_name`] = !cueKnown ? UNKNOWN : c.cue === null ? NONE : c.cue.name === undefined ? UNKNOWN : c.cue.name
		v[`${k}_cue_index`] = !cueKnown ? UNKNOWN : c.cue === null ? NONE : c.cue.index === undefined ? UNKNOWN : String(c.cue.index)
		const nc = nextCue(c, entry)
		v[`${k}_next_cue_name`] = nc === undefined ? UNKNOWN : nc === null ? NONE : nc.name
		v[`${k}_next_cue_index`] = nc === undefined ? UNKNOWN : nc === null ? NONE : String(nc.index)
		v[`${k}_next_cue_in`] = formatTime(c ? c.nextCueIn : undefined)
		v[`${k}_item_remaining`] = formatTime(itemRemaining(c ? c.item : undefined))
		v[`${k}_cue_count`] = entry && Array.isArray(entry.cues) ? String(entry.cues.length) : UNKNOWN
		const selIdx = selected[meta.id]
		const sel = selIdx === undefined ? undefined : findCue(entry, String(selIdx))
		v[`${k}_selected_cue_index`] = selIdx === undefined ? NONE : String(selIdx)
		v[`${k}_selected_cue_name`] = selIdx === undefined ? NONE : sel ? sel.name : UNKNOWN
		const lv = levels[meta.id] || {}
		v[`${k}_volume`] = fmtNum(lv.volume)
		v[`${k}_opacity`] = fmtNum(lv.opacity)
		if (ctx.legacy) for (const [name, value] of Object.entries(legacyValues(c, meta, lv))) v[`${name}_${varKey(meta.id)}`] = value
	}
	return v
}

/**
 * Values for compositions that LEFT the list: blank them to UNKNOWN so a
 * button bound to a removed composition does not keep showing its last time.
 */
function staleVariableValues(prevState, nextState, prevCatalog, nextCatalog) {
	const out = {}
	const keep = new Set(allCompositions(nextState, nextCatalog).map((c) => varKey(c.id)))
	for (const c of allCompositions(prevState, prevCatalog)) {
		const key = varKey(c.id)
		if (keep.has(key)) continue
		for (const [suffix] of COMP_VARS) out[`comp_${key}_${suffix}`] = UNKNOWN
		for (const [name] of LEGACY_VARS) out[`${name}_${key}`] = UNKNOWN
	}
	return out
}

/** Dropdown choices for the composition option. */
function compositionChoices(state, catalog) {
	return allCompositions(state, catalog).map((c) => ({
		id: c.id,
		label: c.name && c.name !== c.id ? `${c.name} (${c.id})` : c.id,
	}))
}

module.exports = {
	buttonRunning,
	STATES,
	emptyState,
	parseMessage,
	findComposition,
	varKey,
	compositionSignature,
	variableDefinitions,
	variableValues,
	staleVariableValues,
	compositionChoices,
	allCompositions,
	resolveCompId,
	remainingOf,
	progressOf,
	COMP_VARS,
	LEGACY_VARS,
}
