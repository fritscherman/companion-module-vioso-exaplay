'use strict'
const { varKey, allCompositions } = require('./lib/status')
const { orderedCues } = require('./lib/cues')
const { EXA, face, mix, rgb } = require('./lib/icons')

/**
 * The Exaplay look (lib/icons.js): a key is the page tone with an outlined
 * square and a glyph; a state lights the outline and glyph in its colour on a
 * dark tint of it, and a state that is a WARNING to the room (Blank, Audio
 * mute) fills solid, like Produce & Play's active BLANKED / MUTED.
 */
const TONE = { ok: EXA.ok, warn: EXA.warn, error: EXA.error, accent: EXA.accent, purple: EXA.purple, muted: EXA.muted }

/** Idle face of a key: glyph (or '' for frame only) and caption underneath. */
function look(glyph, { centered = false, glyphColor = EXA.text, frame = EXA.lineStrong, ...style } = {}) {
	return {
		size: glyph && !centered ? '14' : 'auto',
		color: rgb(EXA.text),
		bgcolor: rgb(EXA.page),
		png64: face(glyph, { color: glyphColor, frame, center: centered }),
		pngalignment: 'center:center',
		alignment: glyph && !centered ? 'center:bottom' : 'center:center',
		...style,
	}
}

/** A lit state: outline and glyph in the tone, on a dark tint of it. */
function lit(glyph, tone) {
	return { bgcolor: rgb(mix(EXA.page, tone, 0.3)), color: rgb(EXA.text), png64: face(glyph, { color: tone, frame: tone }) }
}

/** A solid state (Blank on, Audio mute on): filled, white glyph, no outline. */
function solid(glyph, fill) {
	return { bgcolor: rgb(fill), color: rgb(EXA.text), png64: face(glyph, { color: EXA.text, frame: null }) }
}

function button(category, name, text, down, feedbacks = [], style = {}, extra = {}) {
	return {
		type: 'button',
		category,
		name,
		style: { text, ...look(''), ...style },
		steps: [{ down, up: [], ...(extra.steps || {}) }],
		feedbacks,
		...(extra.options ? { options: extra.options } : {}),
	}
}

/** A Stream Deck+ dial: rotate left/right, press. */
function dial(category, name, text, { left, right, press = [] }, feedbacks = [], style = {}) {
	return button(category, name, text, press, feedbacks, style, {
		options: { rotaryActions: true },
		steps: { rotate_left: left, rotate_right: right },
	})
}

const act = (actionId, options = {}) => ({ actionId, options })
const fb = (feedbackId, options, style) => ({ feedbackId, options, style })

/** Text from the engine on a key face: `$(` would be read as a variable. */
const literal = (s) => String(s ?? '').replace(/\$\(/g, '$ (')

/**
 * Presets, in folders:
 *   Show                       engine-wide keys
 *   Transport: <composition>   play, pause, stop, toggle, prev, next, cue, remaining, seek
 *   Cues: <composition>        one GO key per cue, lit while it is current / next
 *   Command buttons            one key per command button of the project
 *   Dials: <composition>       Stream Deck+ dials: volume, opacity, seek, cue picker
 *   Dials: engine              master volume
 * Per-composition, per-cue and per-button folders appear once the status
 * feed or the cue-list read has reported them.
 *
 * @param {import('./main').ExaplayInstance} self
 */
function getPresetDefinitions(self) {
	const L = self.label
	const v = (id) => `$(${L}:${id})`
	const presets = {}
	const cat = self.catalog.state
	const lost = fb('connection_lost', { blink: true }, solid('link', EXA.errorFill))

	/* ------------------------------------------------------------ Show --- */
	const S = 'Show'
	/** A rig-wide switch: glyph, caption, lit while the engine says it is on. */
	const toggle = (id, name, glyph, caption, onStyle, action = act(id, { mode: 'toggle' })) =>
		button(S, name, caption, [action], [fb(id, {}, onStyle)], look(glyph))
	presets.blank = toggle('blank', 'Blank toggle', 'blank', 'BLANK', solid('blank', EXA.errorFill), act('blank', { mode: 'toggle', fade: '' }))
	presets.show_mode = toggle('show_mode', 'Show mode toggle', 'showmode', 'SHOW MODE', lit('showmode', TONE.accent))
	presets.audio_mute = toggle('audio_mute', 'Audio mute toggle', 'mute', 'AUDIO MUTE', solid('mute', EXA.errorFill))
	presets.identify = toggle('identify', 'Identify toggle', 'identify', 'IDENTIFY', lit('identify', TONE.warn))
	presets.outlines = toggle('outlines', 'Outlines toggle', 'outlines', 'OUTLINES', lit('outlines', TONE.warn))
	presets.correction_bypass = toggle('correction_bypass', 'Correction bypass (raw wall) toggle', 'rawwall', 'RAW WALL', lit('rawwall', TONE.warn))
	presets.stop_all = button(S, 'Stop all', 'STOP ALL', [act('stop_all')], [], look('stopAll', { glyphColor: EXA.error, frame: EXA.error }))
	presets.play_all = button(S, 'Play all', 'PLAY ALL', [act('play_all')], [], look('playAll', { glyphColor: EXA.ok, frame: EXA.ok }))
	presets.projectors_on = button(S, 'Projectors: all on', 'PROJ ON', [act('pjlink_all', { power: 'on' })], [], look('projector', { glyphColor: EXA.ok }))
	presets.projectors_off = button(S, 'Projectors: all off', 'PROJ OFF', [act('pjlink_all', { power: 'off' })], [], look('projector', { glyphColor: EXA.muted }))
	presets.page_prev = button(S, 'Spaces: previous page', v('show_page'), [act('show_page', { page: 'prev' })], [], look('pagePrev'))
	presets.page_next = button(S, 'Spaces: next page', v('show_page'), [act('show_page', { page: 'next' })], [], look('pageNext'))
	presets.connection = button(S, 'Connection / project (flashes red when lost)', `${v('connection')}\\n${v('project_name')}`, [], [
		fb('connected', { link: 'both' }, lit('link', TONE.ok)),
		fb('loading', {}, lit('link', TONE.warn)),
		lost,
	], look('link', { size: '7' }))
	presets.refresh_lists = button(S, 'Refresh cue lists and command buttons', `REFRESH\\n${v('lists_state')}`, [act('refresh_lists')], [], look('refresh', { size: '7' }))
	presets.resync = button(S, 'Re-sync (reconnect, re-read)', 'RE-SYNC', [act('resync')], [lost], look('refresh'))
	presets.last_error = button(S, 'Last error (press to clear)', `${v('last_error')}`, [act('clear_error')], [], look('warning', { size: '7', glyphColor: EXA.warn }))

	/* ------------------------------------------- per composition folders --- */
	for (const c of allCompositions(self.status, cat)) {
		const k = `comp_${varKey(c.id)}`
		const name = literal(c.name || c.id)
		const T = `Transport: ${c.name || c.id}`
		const o = { comp: c.id, compText: '' }
		const st = (state, style) => fb('comp_state', { ...o, state }, style)
		const unknown = (glyph) => fb('comp_unknown', o, { color: rgb(EXA.muted), png64: face(glyph, { color: EXA.muted, frame: EXA.line }) })
		const key = (id, label, glyph, caption, down, feedbacks = [], style = {}) => {
			presets[`${k}_${id}`] = button(T, label, caption, down, feedbacks, look(glyph, style))
		}

		key('play', 'Play', 'play', name, [act('comp_play', o)], [st('playing', lit('play', TONE.ok)), unknown('play')])
		key('pause', 'Pause', 'pause', name, [act('comp_pause', o)], [st('paused', lit('pause', TONE.warn)), unknown('pause')])
		key('stop', 'Stop', 'stop', name, [act('comp_stop', o)], [st('stopped', lit('stop', TONE.error)), unknown('stop')])
		key('toggle', 'Play/pause toggle', 'toggle', `${name}\\n${v(`${k}_time`)}`, [act('comp_toggle', o)], [
			st('playing', lit('toggle', TONE.ok)),
			st('paused', lit('toggle', TONE.warn)),
			unknown('toggle'),
		], { size: '7' })
		key('prev', 'Previous', 'prev', name, [act('comp_previous', o)])
		key('next', 'Next', 'next', name, [act('comp_next', o)])
		const countdown = c.type === 'playlist' ? v(`${k}_item_remaining`) : v(`${k}_next_cue_in`)
		key('cue', 'Current cue and countdown', 'go', `${v(`${k}_cue_name`)}\\n${countdown}`, [], [
			st('playing', lit('go', TONE.ok)),
			unknown('go'),
		], { size: '7' })
		key('remaining', 'Remaining time (colour by time left)', 'clock', `-${v(`${k}_remaining_mmss`)}\\n${v(`${k}_progress_bar`)}`, [], [
			fb('comp_progress', { ...o, warn: 30, critical: 10 }),
			fb('comp_remaining_below', { ...o, seconds: 10, playingOnly: true }, solid('clock', EXA.errorFill)),
		], { size: '7' })
		key('next_cue_info', 'Next cue and countdown', 'next', `NEXT ${v(`${k}_next_cue_name`)}\\n${v(`${k}_next_cue_in`)}`, [], [], { size: '7' })
		key('seek_back', 'Seek −10 s', 'rewind', `-10s ${name}`, [act('comp_seek_relative', { ...o, delta: -10 })])
		key('seek_fwd', 'Seek +10 s', 'forward', `+10s ${name}`, [act('comp_seek_relative', { ...o, delta: 10 })])
		key('restart', 'Back to the start', 'restart', `0:00 ${name}`, [act('comp_seek', { ...o, time: '0' })])

		/* ---- cues ---- */
		const entry = (cat.comps || []).find((e) => e.id === c.id)
		const cues = orderedCues(entry)
		if (cues && cues.length) {
			const C = `Cues: ${c.name || c.id}`
			presets[`${k}_cue_next_info`] = button(C, 'Next cue', `NEXT ${v(`${k}_next_cue_name`)}\\n${v(`${k}_next_cue_in`)}`, [], [], look('next', { size: '7' }))
			for (const q of cues) {
				const co = { ...o, cue: String(q.index) }
				presets[`${k}_cue_${varKey(q.index)}`] = button(
					C,
					`GO ${q.index} ${q.name}`,
					`${q.index}\\n${literal(q.name || '(unnamed)')}`,
					[act('cue_go', co)],
					[
						fb('cue_next', co, { bgcolor: rgb(mix(EXA.page, EXA.warn, 0.15)), png64: face('', { frame: EXA.warn }) }),
						fb('cue_current', co, lit('', TONE.ok)),
					],
					look('', { size: '14' }),
				)
			}
		}

		/* ---- dials ---- */
		const D = `Dials: ${c.name || c.id}`
		const dialLook = (glyph) => look(glyph, { size: '7' })
		presets[`${k}_dial_volume`] = dial(D, 'Volume dial (±2 per detent)', `VOL ${v(`${k}_volume`)}\\n${name}`, {
			left: [act('comp_volume_nudge', { ...o, delta: -2 })],
			right: [act('comp_volume_nudge', { ...o, delta: 2 })],
		}, [], dialLook('speaker'))
		presets[`${k}_dial_opacity`] = dial(D, 'Opacity dial (±2 per detent)', `OPACITY ${v(`${k}_opacity`)}\\n${name}`, {
			left: [act('comp_opacity_nudge', { ...o, delta: -2 })],
			right: [act('comp_opacity_nudge', { ...o, delta: 2 })],
		}, [], dialLook('knob'))
		presets[`${k}_dial_seek`] = dial(D, 'Seek dial (±1 s per detent, press = play/pause)', `${v(`${k}_time`)}\\n${name}`, {
			left: [act('comp_seek_relative', { ...o, delta: -1 })],
			right: [act('comp_seek_relative', { ...o, delta: 1 })],
			press: [act('comp_toggle', o)],
		}, [
			st('playing', lit('toggle', TONE.ok)),
			st('paused', lit('toggle', TONE.warn)),
		], dialLook('toggle'))
		presets[`${k}_dial_cue`] = dial(D, 'Cue picker dial (turn to pick, press = GO)', `CUE ${v(`${k}_selected_cue_index`)} ${v(`${k}_selected_cue_name`)}\\nnow ${v(`${k}_cue_name`)}`, {
			left: [act('cue_select_step', { ...o, step: -1 })],
			right: [act('cue_select_step', { ...o, step: 1 })],
			press: [act('cue_select_go', o)],
		}, [fb('cue_selected', o, lit('go', TONE.purple))], dialLook('go'))
	}

	presets.dial_master_volume = dial('Dials: engine', 'Master volume dial (±2 per detent)', `MASTER ${v('master_volume')}`, {
		left: [act('master_volume_nudge', { delta: -2 })],
		right: [act('master_volume_nudge', { delta: 2 })],
	}, [fb('audio_mute', {}, solid('mute', EXA.errorFill))], look('speaker', { size: '7' }))

	/* ------------------------------------------------- command buttons --- */
	// The Control tab draws a command button in the accent: so does its key.
	for (const b of cat.buttons || []) {
		presets[`button_${varKey(b.id)}`] = button(
			'Command buttons',
			b.label,
			literal(b.label),
			[act('fire_button', { button: b.id, id: '' })],
			[
				fb('button_running', { button: b.id }, lit('bolt', TONE.warn)),
				fb('button_failed', { button: b.id }, solid('warning', EXA.errorFill)),
			],
			look('bolt', { glyphColor: EXA.accent, frame: EXA.accent }),
		)
	}
	return presets
}

module.exports = { getPresetDefinitions, look, lit, solid, TONE }
