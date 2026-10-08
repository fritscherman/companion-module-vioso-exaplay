'use strict'
const { findComposition, remainingOf, progressOf, buttonRunning } = require('./lib/status')
const { isCurrentCue, isNextCue } = require('./lib/cues')
const { buttonChoices } = require('./lib/catalog')
const { compositionOptions, resolveComposition, parsedText } = require('./options')
const { EXA, mix, rgb } = require('./lib/icons')
const { legacyCompId } = require('./upgrades')

/**
 * Default feedback colours, from the Exaplay palette (lib/icons.js EXA):
 * a state is a dark tint of its status colour on the page tone, a warning
 * to the room (red) the solid fill the UI uses for BLANKED / MUTED.
 */
const COLORS = {
	white: rgb(EXA.text),
	black: rgb(EXA.page),
	green: rgb(mix(EXA.page, EXA.ok, 0.45)),
	darkGreen: rgb(mix(EXA.page, EXA.ok, 0.2)),
	amber: rgb(EXA.warn),
	darkAmber: rgb(mix(EXA.page, EXA.warn, 0.25)),
	red: rgb(EXA.errorFill),
	blue: rgb(mix(EXA.page, EXA.accent, 0.45)),
	purple: rgb(mix(EXA.page, EXA.purple, 0.4)),
	grey: rgb(EXA.raised),
}

/**
 * Boolean feedbacks are TRUE only on a known value. Unknown (no status feed,
 * an absent key, a cue list not read) is false — the button stays unlit; it
 * never lights up as if the engine had confirmed something. `status_unknown`
 * and `comp_unknown` let a button show that state explicitly.
 *
 * @param {import('./main').ExaplayInstance} self
 */
function getFeedbackDefinitions(self) {
	const choices = self.compositionChoices()
	const btnChoices = buttonChoices(self.catalog.state)
	const flag = (name, key, bgcolor) => ({
		type: 'boolean',
		name,
		defaultStyle: { bgcolor, color: COLORS.white },
		options: [],
		callback: () => self.status[key] === true,
	})
	const compOf = async (fb, context) => {
		const ref = await resolveComposition(fb.options, context)
		const comp = findComposition(self.status, ref)
		return { ref, comp, entry: self.catalog.entry(comp ? comp.id : self.resolveCompId(ref)) }
	}
	const cueOption = {
		type: 'textinput',
		id: 'cue',
		label: 'Cue index (Timeline: cue index, Playlist: 1-based item) or name',
		default: '1',
		useVariables: true,
	}

	return {
		comp_state: {
			type: 'boolean',
			name: 'Composition: state is …',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [
				...compositionOptions(choices),
				{
					type: 'dropdown',
					id: 'state',
					label: 'State',
					choices: [
						{ id: 'playing', label: 'Playing' },
						{ id: 'paused', label: 'Paused' },
						{ id: 'stopped', label: 'Stopped' },
					],
					default: 'playing',
				},
			],
			callback: async (fb, context) => {
				const { comp } = await compOf(fb, context)
				return !!comp && comp.state === fb.options.state
			},
		},
		comp_unknown: {
			type: 'boolean',
			name: 'Composition: state is unknown (no status, or not in the project)',
			defaultStyle: { bgcolor: COLORS.grey, color: COLORS.white },
			options: compositionOptions(choices),
			callback: async (fb, context) => {
				const { comp } = await compOf(fb, context)
				return !comp || comp.state === undefined
			},
		},
		cue_current: {
			type: 'boolean',
			name: 'Cue: is the current cue / playing item',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [...compositionOptions(choices), cueOption],
			callback: async (fb, context) => {
				const { comp, entry } = await compOf(fb, context)
				return isCurrentCue(comp, entry, await parsedText(fb.options, 'cue', context)) === true
			},
		},
		cue_next: {
			type: 'boolean',
			name: 'Cue: is the next cue / item',
			defaultStyle: { bgcolor: COLORS.darkAmber, color: COLORS.white },
			options: [...compositionOptions(choices), cueOption],
			callback: async (fb, context) => {
				const { comp, entry } = await compOf(fb, context)
				return isNextCue(comp, entry, await parsedText(fb.options, 'cue', context)) === true
			},
		},
		cue_selected: {
			type: 'boolean',
			name: 'Cue dial: a cue is picked (not yet fired)',
			defaultStyle: { bgcolor: COLORS.purple, color: COLORS.white },
			options: compositionOptions(choices),
			callback: async (fb, context) => {
				const ref = await resolveComposition(fb.options, context)
				const id = self.resolveCompId(ref)
				const sel = self.selected[id]
				if (sel === undefined) return false
				const comp = findComposition(self.status, id)
				// lit while the pick differs from what is current — it is waiting for GO
				return !(comp && comp.cue && comp.cue.index === sel)
			},
		},
		comp_remaining_below: {
			type: 'boolean',
			name: 'Composition: time running out (remaining below N seconds)',
			description: 'Timeline: to its end (needs an engine that reports its length); Playlist: to the end of the playing item. Unknown stays unlit.',
			defaultStyle: { bgcolor: COLORS.red, color: COLORS.white },
			options: [
				...compositionOptions(choices),
				{ type: 'number', id: 'seconds', label: 'Below (seconds)', default: 10, min: 0, max: 86400 },
				{ type: 'checkbox', id: 'playingOnly', label: 'Only while playing', default: true },
			],
			callback: async (fb, context) => {
				const { comp } = await compOf(fb, context)
				if (!comp) return false
				if (fb.options.playingOnly && comp.state !== 'playing') return false
				const rem = remainingOf(comp)
				return typeof rem === 'number' && rem < Number(fb.options.seconds)
			},
		},
		comp_progress: {
			type: 'advanced',
			name: 'Composition: progress colour (green → amber → red as the end nears)',
			description: 'Colours by remaining time; leaves the key alone while the remaining time is unknown.',
			options: [
				...compositionOptions(choices),
				{ type: 'number', id: 'warn', label: 'Amber below (seconds)', default: 30, min: 0, max: 86400 },
				{ type: 'number', id: 'critical', label: 'Red below (seconds)', default: 10, min: 0, max: 86400 },
			],
			callback: async (fb, context) => {
				const { comp } = await compOf(fb, context)
				const rem = remainingOf(comp)
				if (typeof rem !== 'number' || progressOf(comp) === undefined) return {}
				if (rem < Number(fb.options.critical)) return { bgcolor: COLORS.red, color: COLORS.white }
				if (rem < Number(fb.options.warn)) return { bgcolor: COLORS.amber, color: COLORS.black }
				return { bgcolor: COLORS.darkGreen, color: COLORS.white }
			},
		},
		show_mode: flag('Show mode is on', 'showMode', COLORS.blue),
		blank: flag('Blank is on', 'blank', COLORS.red),
		audio_mute: flag('Audio mute is on', 'audioMute', COLORS.red),
		identify: flag('Identify is on', 'identify', COLORS.amber),
		outlines: flag('Outlines are on', 'outlines', COLORS.amber),
		correction_bypass: flag('Correction bypass (raw wall) is on', 'correctionBypass', COLORS.amber),
		loading: flag('A project is loading', 'loading', COLORS.amber),
		connected: {
			type: 'boolean',
			name: 'Connected',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [
				{
					type: 'dropdown',
					id: 'link',
					label: 'Link',
					choices: [
						{ id: 'both', label: 'Commands and status' },
						{ id: 'tcp', label: 'TCP commands' },
						{ id: 'status', label: 'Status feed' },
					],
					default: 'both',
				},
			],
			callback: (fb) => {
				const tcp = self.tcpState === 'connected'
				const st = self.statusState === 'connected'
				if (fb.options.link === 'tcp') return tcp
				if (fb.options.link === 'status') return st
				return tcp && st
			},
		},
		connection_lost: {
			type: 'boolean',
			name: 'Connection to the engine lost (optionally flashing)',
			description: 'The TCP command link is down — the module knows this for certain (its own socket).',
			defaultStyle: { bgcolor: COLORS.red, color: COLORS.white },
			options: [{ type: 'checkbox', id: 'blink', label: 'Flash', default: true }],
			callback: (fb) => {
				if (!self.config.host || self.tcpState === 'connected') return false
				return fb.options.blink ? self.blinkOn : true
			},
		},
		status_unknown: {
			type: 'boolean',
			name: 'Status is unknown (status feed not connected)',
			defaultStyle: { bgcolor: COLORS.grey, color: COLORS.white },
			options: [],
			callback: () => !self.status.known,
		},
		button_running: {
			type: 'boolean',
			name: 'Command button: its commands are running',
			description: 'Lit from the engine\'s status while the button\'s sequence runs (its WAITs included), whoever pressed it. Unlit while unknown.',
			defaultStyle: { bgcolor: COLORS.amber, color: COLORS.black },
			options: [
				{
					type: 'dropdown',
					id: 'button',
					label: 'Command button',
					choices: btnChoices,
					default: btnChoices.length ? btnChoices[0].id : '',
					allowCustom: true,
				},
			],
			callback: (fb) => buttonRunning(self.status, fb.options.button) === true,
		},
		button_failed: {
			type: 'boolean',
			name: 'Command button: its last press failed',
			description: 'The reason is in $(…:button_last) and $(…:last_error).',
			defaultStyle: { bgcolor: COLORS.red, color: COLORS.white },
			options: [
				{
					type: 'dropdown',
					id: 'button',
					label: 'Command button',
					choices: btnChoices,
					default: btnChoices.length ? btnChoices[0].id : '',
					allowCustom: true,
				},
			],
			callback: (fb) => {
				const r = self.buttonResults[String(fb.options.button ?? '').trim()]
				return !!r && r.ok === false
			},
		},
	}
}

/**
 * The display feedbacks of the 1.x module (before 2.0.0), kept under their
 * old ids so a button made with them still draws after the update (see
 * upgrades.js). They set the key's text to the legacy variables
 * ($(…:cue_index_comp1) & co, on while "Legacy variables" is), exactly as
 * they did. New buttons use the presets and the comp_* variables instead.
 */
function legacyFeedbackDefinitions(self) {
	const L = () => self.label
	const compField = { type: 'textinput', label: 'Composition ID (e.g. "1" or "comp1")', id: 'composition_id', default: 'comp1' }
	const colours = (bg) => [
		{ type: 'colorpicker', label: 'Background colour', id: 'bgcolor', default: bg },
		{ type: 'colorpicker', label: 'Text colour', id: 'color', default: rgb(EXA.text) },
	]
	const style = (fb, text) => ({ bgcolor: fb.options.bgcolor, color: fb.options.color, text })
	const compOf = (fb) => {
		const id = legacyCompId(fb.options.composition_id)
		return { id, comp: findComposition(self.status, id) }
	}
	const display = (name, what, varName, known) => ({
		type: 'advanced',
		name: `(1.x) ${name}`,
		description: 'From the module before 2.0.0 — kept so existing buttons keep working.',
		options: [compField, ...colours(rgb(EXA.card))],
		callback: (fb) => {
			const { id, comp } = compOf(fb)
			if (!known(comp, id)) return {}
			return style(fb, `${what} ${id}\n$(${L()}:${varName}_${id})`)
		},
	})
	return {
		cueIndexDisplayFeedback: display('Cue/Clip index display', 'Cue/Clip Index', 'cue_index', (c) => !!c && c.cue !== undefined),
		volumeDisplayFeedback: display('Volume display', 'Volume', 'current_volume', (_c, id) => !!self.levels[id] && typeof self.levels[id].volume === 'number'),
		frameIndexDisplayFeedback: display('Frame index display', 'Frame Index', 'frame_index', (c) => !!c && typeof c.time === 'number'),
		currentTimeFeedback: {
			type: 'advanced',
			name: '(1.x) Current time from … seconds on',
			description: 'From the module before 2.0.0 — kept so existing buttons keep working.',
			options: [compField, { type: 'number', label: 'Time in seconds', id: 'time', default: 0, min: 0, max: 86400, step: 0.1 }, ...colours(rgb(EXA.card))],
			callback: (fb) => {
				const { id, comp } = compOf(fb)
				const t = Number(fb.options.time)
				if (!comp || typeof comp.time !== 'number' || !(comp.time >= (Number.isFinite(t) ? t : 0))) return {}
				return style(fb, `Time ${id}\n$(${L()}:current_time_${id})`)
			},
		},
		combinedInfoFeedback: {
			type: 'advanced',
			name: '(1.x) Combined info',
			description: 'From the module before 2.0.0 — kept so existing buttons keep working.',
			options: [compField, ...colours(rgb(EXA.card))],
			callback: (fb) => {
				const { id } = compOf(fb)
				const v = (n) => `$(${L()}:${n}_${id})`
				return style(
					fb,
					`Transport: ${v('playback_status')}\nVolume: ${v('current_volume')}\nClip Index: ${v('clip_index')}\n` +
						`Cue Index: ${v('cue_index')}\nTime: ${v('current_time')}\nFrame: ${v('frame_index')}\nDuration: ${v('composition_duration')}`,
				)
			},
		},
	}
}

module.exports = { getFeedbackDefinitions, legacyFeedbackDefinitions, COLORS }
