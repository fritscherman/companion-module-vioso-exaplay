'use strict'
const { COLORS } = require('./feedbacks')
const { varKey, allCompositions } = require('./lib/status')
const { orderedCues } = require('./lib/cues')

function button(category, name, text, down, feedbacks = [], style = {}, extra = {}) {
	return {
		type: 'button',
		category,
		name,
		style: { text, size: 'auto', color: COLORS.white, bgcolor: COLORS.black, ...style },
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

	/* ------------------------------------------------------------ Show --- */
	const S = 'Show'
	presets.blank = button(S, 'Blank toggle', 'BLANK', [act('blank', { mode: 'toggle', fade: '' })], [
		fb('blank', {}, { bgcolor: COLORS.red, color: COLORS.white }),
	])
	presets.show_mode = button(S, 'Show mode toggle', 'SHOW\\nMODE', [act('show_mode', { mode: 'toggle' })], [
		fb('show_mode', {}, { bgcolor: COLORS.blue, color: COLORS.white }),
	])
	presets.stop_all = button(S, 'Stop all', 'STOP\\nALL', [act('stop_all')], [], { bgcolor: COLORS.red })
	presets.play_all = button(S, 'Play all', 'PLAY\\nALL', [act('play_all')], [], { bgcolor: COLORS.green })
	presets.audio_mute = button(S, 'Audio mute toggle', 'AUDIO\\nMUTE', [act('audio_mute', { mode: 'toggle' })], [
		fb('audio_mute', {}, { bgcolor: COLORS.red, color: COLORS.white }),
	])
	presets.identify = button(S, 'Identify toggle', 'IDENTIFY', [act('identify', { mode: 'toggle' })], [
		fb('identify', {}, { bgcolor: COLORS.amber, color: COLORS.black }),
	])
	presets.outlines = button(S, 'Outlines toggle', 'OUTLINES', [act('outlines', { mode: 'toggle' })], [
		fb('outlines', {}, { bgcolor: COLORS.amber, color: COLORS.black }),
	])
	presets.correction_bypass = button(S, 'Correction bypass (raw wall) toggle', 'RAW\\nWALL', [act('correction_bypass', { mode: 'toggle' })], [
		fb('correction_bypass', {}, { bgcolor: COLORS.amber, color: COLORS.black }),
	])
	presets.projectors_on = button(S, 'Projectors: all on', 'PROJ\\nON', [act('pjlink_all', { power: 'on' })])
	presets.projectors_off = button(S, 'Projectors: all off', 'PROJ\\nOFF', [act('pjlink_all', { power: 'off' })])
	presets.page_prev = button(S, 'Spaces: previous page', '◀ PAGE\\n' + v('show_page'), [act('show_page', { page: 'prev' })], [], { size: '14' })
	presets.page_next = button(S, 'Spaces: next page', 'PAGE ▶\\n' + v('show_page'), [act('show_page', { page: 'next' })], [], { size: '14' })
	presets.connection = button(S, 'Connection / project (flashes red when lost)', `${v('connection')}\\n${v('project_name')}`, [], [
		fb('connected', { link: 'both' }, { bgcolor: COLORS.green, color: COLORS.white }),
		fb('loading', {}, { bgcolor: COLORS.amber, color: COLORS.black }),
		fb('connection_lost', { blink: true }, { bgcolor: COLORS.red, color: COLORS.white }),
	], { size: '7' })
	presets.refresh_lists = button(S, 'Refresh cue lists and command buttons', `REFRESH\\n${v('lists_state')}`, [act('refresh_lists')], [], { size: '7' })
	presets.resync = button(S, 'Re-sync (reconnect, re-read)', 'RE-SYNC', [act('resync')], [
		fb('connection_lost', { blink: true }, { bgcolor: COLORS.red, color: COLORS.white }),
	])
	presets.last_error = button(S, 'Last error (press to clear)', `${v('last_error')}`, [act('clear_error')], [], { size: '7' })

	/* ------------------------------------------- per composition folders --- */
	for (const c of allCompositions(self.status, cat)) {
		const k = `comp_${varKey(c.id)}`
		const name = literal(c.name || c.id)
		const T = `Transport: ${c.name || c.id}`
		const o = { comp: c.id, compText: '' }
		const st = (state, style) => fb('comp_state', { ...o, state }, style)
		const unknown = fb('comp_unknown', o, { bgcolor: COLORS.grey, color: COLORS.white })

		presets[`${k}_play`] = button(T, 'Play', `▶\\n${name}`, [act('comp_play', o)], [st('playing', { bgcolor: COLORS.green, color: COLORS.white })])
		presets[`${k}_pause`] = button(T, 'Pause', `❚❚\\n${name}`, [act('comp_pause', o)], [st('paused', { bgcolor: COLORS.amber, color: COLORS.black })])
		presets[`${k}_stop`] = button(T, 'Stop', `■\\n${name}`, [act('comp_stop', o)], [st('stopped', { bgcolor: COLORS.red, color: COLORS.white })])
		presets[`${k}_toggle`] = button(T, 'Play/pause toggle', `${name}\\n${v(`${k}_time`)}`, [act('comp_toggle', o)], [
			st('playing', { bgcolor: COLORS.green, color: COLORS.white }),
			st('paused', { bgcolor: COLORS.amber, color: COLORS.black }),
			unknown,
		], { size: '14' })
		presets[`${k}_prev`] = button(T, 'Previous', `⏮\\n${name}`, [act('comp_previous', o)])
		presets[`${k}_next`] = button(T, 'Next', `⏭\\n${name}`, [act('comp_next', o)])
		const countdown = c.type === 'playlist' ? v(`${k}_item_remaining`) : v(`${k}_next_cue_in`)
		presets[`${k}_cue`] = button(T, 'Current cue and countdown', `${v(`${k}_cue_name`)}\\n${countdown}`, [], [
			st('playing', { bgcolor: COLORS.green, color: COLORS.white }),
			unknown,
		], { size: '14' })
		presets[`${k}_remaining`] = button(T, 'Remaining time (colour by time left)', `${name}\\n-${v(`${k}_remaining_mmss`)}\\n${v(`${k}_progress_bar`)}`, [], [
			fb('comp_progress', { ...o, warn: 30, critical: 10 }),
			fb('comp_remaining_below', { ...o, seconds: 10, playingOnly: true }, { bgcolor: COLORS.red, color: COLORS.white }),
		], { size: '14' })
		presets[`${k}_next_cue_info`] = button(T, 'Next cue and countdown', `NEXT\\n${v(`${k}_next_cue_name`)}\\n${v(`${k}_next_cue_in`)}`, [], [], { size: '14' })
		presets[`${k}_seek_back`] = button(T, 'Seek −10 s', `⏪ 10s\\n${name}`, [act('comp_seek_relative', { ...o, delta: -10 })])
		presets[`${k}_seek_fwd`] = button(T, 'Seek +10 s', `10s ⏩\\n${name}`, [act('comp_seek_relative', { ...o, delta: 10 })])
		presets[`${k}_restart`] = button(T, 'Back to the start', `⏮ 0:00\\n${name}`, [act('comp_seek', { ...o, time: '0' })])

		/* ---- cues ---- */
		const entry = (cat.comps || []).find((e) => e.id === c.id)
		const cues = orderedCues(entry)
		if (cues && cues.length) {
			const C = `Cues: ${c.name || c.id}`
			presets[`${k}_cue_next_info`] = button(C, 'Next cue', `NEXT\\n${v(`${k}_next_cue_name`)}\\n${v(`${k}_next_cue_in`)}`, [], [], { size: '14' })
			for (const q of cues) {
				const co = { ...o, cue: String(q.index) }
				presets[`${k}_cue_${varKey(q.index)}`] = button(
					C,
					`GO ${q.index} ${q.name}`,
					`${q.index}\\n${literal(q.name || '(unnamed)')}`,
					[act('cue_go', co)],
					[
						fb('cue_next', co, { bgcolor: COLORS.darkAmber, color: COLORS.white }),
						fb('cue_current', co, { bgcolor: COLORS.green, color: COLORS.white }),
					],
					{ size: '14' },
				)
			}
		}

		/* ---- dials ---- */
		const D = `Dials: ${c.name || c.id}`
		presets[`${k}_dial_volume`] = dial(D, 'Volume dial (±2 per detent)', `VOL\\n${name}\\n${v(`${k}_volume`)}`, {
			left: [act('comp_volume_nudge', { ...o, delta: -2 })],
			right: [act('comp_volume_nudge', { ...o, delta: 2 })],
		}, [], { size: '14' })
		presets[`${k}_dial_opacity`] = dial(D, 'Opacity dial (±2 per detent)', `OPACITY\\n${name}\\n${v(`${k}_opacity`)}`, {
			left: [act('comp_opacity_nudge', { ...o, delta: -2 })],
			right: [act('comp_opacity_nudge', { ...o, delta: 2 })],
		}, [], { size: '14' })
		presets[`${k}_dial_seek`] = dial(D, 'Seek dial (±1 s per detent, press = play/pause)', `SEEK\\n${name}\\n${v(`${k}_time`)}`, {
			left: [act('comp_seek_relative', { ...o, delta: -1 })],
			right: [act('comp_seek_relative', { ...o, delta: 1 })],
			press: [act('comp_toggle', o)],
		}, [
			st('playing', { bgcolor: COLORS.green, color: COLORS.white }),
			st('paused', { bgcolor: COLORS.amber, color: COLORS.black }),
		], { size: '14' })
		presets[`${k}_dial_cue`] = dial(D, 'Cue picker dial (turn to pick, press = GO)', `CUE ${v(`${k}_selected_cue_index`)}\\n${v(`${k}_selected_cue_name`)}\\nnow ${v(`${k}_cue_name`)}`, {
			left: [act('cue_select_step', { ...o, step: -1 })],
			right: [act('cue_select_step', { ...o, step: 1 })],
			press: [act('cue_select_go', o)],
		}, [fb('cue_selected', o, { bgcolor: COLORS.purple, color: COLORS.white })], { size: '14' })
	}

	presets.dial_master_volume = dial('Dials: engine', 'Master volume dial (±2 per detent)', `MASTER\\n${v('master_volume')}`, {
		left: [act('master_volume_nudge', { delta: -2 })],
		right: [act('master_volume_nudge', { delta: 2 })],
	}, [fb('audio_mute', {}, { bgcolor: COLORS.red, color: COLORS.white })], { size: '14' })

	/* ------------------------------------------------- command buttons --- */
	for (const b of cat.buttons || []) {
		presets[`button_${varKey(b.id)}`] = button(
			'Command buttons',
			b.label,
			literal(b.label),
			[act('fire_button', { button: b.id, id: '' })],
			[
				fb('button_running', { button: b.id }, { bgcolor: COLORS.amber, color: COLORS.black }),
				fb('button_failed', { button: b.id }, { bgcolor: COLORS.red, color: COLORS.white }),
			],
			{ size: '14', bgcolor: COLORS.blue },
		)
	}
	return presets
}

module.exports = { getPresetDefinitions }
