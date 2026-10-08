'use strict'
const cmd = require('./lib/commands')
const { findComposition } = require('./lib/status')
const { cueChoices, parseCuePick, buttonChoices } = require('./lib/catalog')
const { compositionOptions, resolveComposition, parsedText, parsedNumber } = require('./options')

const MODE_CHOICES = [
	{ id: 'toggle', label: 'Toggle' },
	{ id: 'on', label: 'On' },
	{ id: 'off', label: 'Off' },
]

const LEVEL_LABEL = { volume: 'volume', opacity: 'opacity' }

/**
 * @param {import('./main').ExaplayInstance} self
 */
function getActionDefinitions(self) {
	const choices = self.compositionChoices()
	const compOpts = () => compositionOptions(choices)
	const cueChoiceList = cueChoices(self.catalog.state)
	const buttonChoiceList = buttonChoices(self.catalog.state)

	const transportAction = (name, verb) => ({
		name,
		options: compOpts(),
		callback: async (action, context) => {
			const ref = await resolveComposition(action.options, context)
			await self.runTcp(cmd.transport(ref, verb), name)
		},
	})

	const switchAction = (name, which, extra = []) => ({
		name,
		options: [{ type: 'dropdown', id: 'mode', label: 'Mode', choices: MODE_CHOICES, default: 'toggle' }, ...extra],
		callback: async (action, context) => {
			let fade
			if (which === 'blank' && typeof action.options.fade === 'string' && action.options.fade.trim() !== '') {
				fade = context ? await context.parseVariablesInString(action.options.fade) : action.options.fade
			}
			if (self.config.switchTransport !== 'osc' && cmd.tcpSwitchable(which))
				await self.runTcp(cmd.tcpSwitch(which, action.options.mode, fade), name)
			else self.runOsc(cmd.oscSwitch(self.config.oscPrefix, which, action.options.mode, fade), name)
		},
	})

	/** Volume / opacity: set (with learn) and nudge, through the composition's dial. */
	const levelSet = (which) => ({
		name: `Composition: set ${LEVEL_LABEL[which]} (0–100)`,
		options: [
			...compOpts(),
			{ type: 'textinput', id: 'value', label: `${which === 'volume' ? 'Volume' : 'Opacity'} 0–100 (variables allowed)`, default: '100', useVariables: true },
		],
		callback: async (action, context) => {
			const ref = await resolveComposition(action.options, context)
			const v = await parsedNumber(action.options, 'value', context)
			const c = cmd.checkCompRef(ref)
			if (!c.ok) return self.reportError(`Set ${which}`, c.error)
			if (v === undefined) return self.reportError(`Set ${which}`, `"${action.options.value}" is not a number`)
			self.levelDial(self.resolveCompId(ref), which).set(v)
		},
		learn: async (action, context) => {
			const ref = await resolveComposition(action.options, context)
			if (!cmd.checkCompRef(ref).ok) return undefined
			const r = await self.levelDial(self.resolveCompId(ref), which).read()
			if (!r.ok) {
				self.reportError(`Learn ${which}`, r.error)
				return undefined
			}
			return { ...action.options, value: String(Math.round(r.value * 10) / 10) }
		},
	})

	const levelNudge = (which) => ({
		name: `Composition: nudge ${LEVEL_LABEL[which]} (dial / +/- key)`,
		options: [
			...compOpts(),
			{ type: 'number', id: 'delta', label: 'Step (negative = down)', default: 2, min: -100, max: 100, step: 0.5 },
		],
		callback: async (action, context) => {
			const ref = await resolveComposition(action.options, context)
			const c = cmd.checkCompRef(ref)
			if (!c.ok) return self.reportError(`Nudge ${which}`, c.error)
			self.levelDial(self.resolveCompId(ref), which).nudge(Number(action.options.delta))
		},
	})

	return {
		/* --------------------------------------------------- transport --- */
		comp_play: transportAction('Composition: play', 'play'),
		comp_pause: transportAction('Composition: pause', 'pause'),
		comp_stop: transportAction('Composition: stop', 'stop'),
		comp_toggle: {
			name: 'Composition: play/pause toggle (needs the status feed)',
			options: compOpts(),
			callback: async (action, context) => {
				const ref = await resolveComposition(action.options, context)
				const comp = findComposition(self.status, ref)
				await self.runTcp(cmd.toggleTransport(ref, comp ? comp.state : undefined), 'Composition: toggle')
			},
		},
		comp_next: transportAction('Composition: next item / next cue', 'next'),
		comp_previous: transportAction('Composition: previous item / previous cue', 'previous'),
		comp_seek: {
			name: 'Composition: jump to a time',
			options: [
				...compOpts(),
				{
					type: 'textinput',
					id: 'time',
					label: 'Time: seconds or [h:]mm:ss[.t] (Playlist: within the current item)',
					default: '0',
					useVariables: true,
				},
			],
			callback: async (action, context) => {
				const ref = await resolveComposition(action.options, context)
				const text = await parsedText(action.options, 'time', context)
				const built = cmd.seekTime(ref, text)
				if (!built.ok) return self.reportError('Jump to time', built.error)
				const id = self.resolveCompId(ref)
				const d = self.seekDial(id)
				d.setRange(0, self.seekMax(id))
				d.set(built.value)
			},
		},
		comp_seek_relative: {
			name: 'Composition: seek ± seconds (dial / key; needs the status feed)',
			options: [...compOpts(), { type: 'number', id: 'delta', label: 'Seconds (negative = back)', default: 5, min: -3600, max: 3600, step: 0.1 }],
			callback: async (action, context) => {
				const ref = await resolveComposition(action.options, context)
				const c = cmd.checkCompRef(ref)
				if (!c.ok) return self.reportError('Seek', c.error)
				const id = self.resolveCompId(ref)
				const d = self.seekDial(id)
				d.setRange(0, self.seekMax(id))
				d.nudge(Number(action.options.delta))
			},
		},
		comp_seek_frame: {
			name: 'Timeline: jump to a frame (OSC; Timecode frame rate)',
			options: [...compOpts(), { type: 'textinput', id: 'frame', label: 'Frame number', default: '0', useVariables: true }],
			callback: async (action, context) => {
				const ref = await resolveComposition(action.options, context)
				const frame = await parsedText(action.options, 'frame', context)
				self.runOsc(cmd.oscFrame(self.config.oscPrefix, self.resolveCompId(ref), frame), 'Jump to frame')
			},
		},
		comp_loop: {
			name: 'Composition: loop',
			options: [...compOpts(), { type: 'dropdown', id: 'mode', label: 'Loop', choices: MODE_CHOICES, default: 'toggle' }],
			callback: async (action, context) => {
				const ref = await resolveComposition(action.options, context)
				let on
				if (action.options.mode === 'on') on = true
				else if (action.options.mode === 'off') on = false
				else {
					const g = cmd.getLoop(ref)
					if (!g.ok) return self.reportError('Loop', g.error)
					const r = await self.runTcp(g, 'Loop (read)', { quiet: true })
					if (!r.ok) return
					const cur = cmd.parseLoopReply(r.value)
					if (cur === undefined) return self.reportError('Loop', `current loop state unknown ("${r.value}") — toggle not sent`)
					on = !cur
				}
				await self.runTcp(cmd.setLoop(ref, on), 'Loop')
			},
		},

		/* --------------------------------------------------------- cues --- */
		cue_go: {
			name: 'Cue: go (by index or name)',
			options: [
				...compOpts(),
				{
					type: 'textinput',
					id: 'cue',
					label: 'Cue index (Timeline: cue index, Playlist: 1-based item) or name',
					default: '1',
					useVariables: true,
				},
			],
			callback: async (action, context) => {
				const ref = await resolveComposition(action.options, context)
				const cue = await context.parseVariablesInString(String(action.options.cue ?? ''))
				await self.runTcp(cmd.cueGo(ref, cue), 'Cue: go')
			},
		},
		cue_go_pick: {
			name: 'Cue: go (pick from the cue lists)',
			options: [
				{
					type: 'dropdown',
					id: 'pick',
					label: 'Cue (lists read from the engine; "Refresh lists" re-reads them)',
					choices: cueChoiceList,
					default: cueChoiceList.length ? cueChoiceList[0].id : '',
					allowCustom: true,
				},
			],
			callback: async (action) => {
				const p = parseCuePick(String(action.options.pick ?? ''))
				if (!p) return self.reportError('Cue: go', 'no cue picked (expected <composition>|<index>)')
				await self.runTcp(cmd.cueGo(p.comp, p.cue), 'Cue: go')
			},
		},
		cue_select_step: {
			name: 'Cue dial: pick the next / previous cue (no GO)',
			options: [...compOpts(), { type: 'number', id: 'step', label: 'Step (+1 next, -1 previous)', default: 1, min: -50, max: 50 }],
			callback: async (action, context) => {
				const ref = await resolveComposition(action.options, context)
				self.stepSelectedCue(self.resolveCompId(ref), Number(action.options.step) || 0)
			},
		},
		cue_select_go: {
			name: 'Cue dial: GO the picked cue',
			options: compOpts(),
			callback: async (action, context) => {
				const ref = await resolveComposition(action.options, context)
				await self.goSelectedCue(self.resolveCompId(ref))
			},
		},
		refresh_lists: {
			name: 'Refresh cue lists and command buttons',
			options: [],
			callback: async () => self.refreshLists('manual'),
		},

		/* ------------------------------------------------------- levels --- */
		comp_volume_set: levelSet('volume'),
		comp_volume_nudge: levelNudge('volume'),
		comp_opacity_set: levelSet('opacity'),
		comp_opacity_nudge: levelNudge('opacity'),
		master_volume_set: {
			name: 'Engine master volume: set (0–100, this machine only)',
			options: [{ type: 'textinput', id: 'value', label: 'Master volume 0–100', default: '100', useVariables: true }],
			callback: async (action, context) => {
				const v = await parsedNumber(action.options, 'value', context)
				if (v === undefined) return self.reportError('Master volume', `"${action.options.value}" is not a number`)
				self.masterDial().set(v)
			},
			learn: async (action) => {
				const r = await self.masterDial().read()
				if (!r.ok) {
					self.reportError('Learn master volume', r.error)
					return undefined
				}
				return { ...action.options, value: String(Math.round(r.value * 10) / 10) }
			},
		},
		master_volume_nudge: {
			name: 'Engine master volume: nudge (dial / +/- key)',
			options: [{ type: 'number', id: 'delta', label: 'Step (negative = down)', default: 2, min: -100, max: 100, step: 0.5 }],
			callback: async (action) => self.masterDial().nudge(Number(action.options.delta)),
		},

		/* ------------------------------------------------- engine-wide --- */
		play_all: {
			name: 'All compositions: play',
			options: [],
			callback: async () =>
				self.config.switchTransport !== 'osc'
					? self.runTcp(cmd.tcpPlayAll(), 'Play all')
					: self.runOsc(cmd.oscPlayAll(self.config.oscPrefix), 'Play all'),
		},
		stop_all: {
			name: 'All compositions: stop',
			options: [],
			callback: async () => self.runStopAll(),
		},
		show_mode: {
			name: 'Show mode',
			options: [{ type: 'dropdown', id: 'mode', label: 'Mode', choices: MODE_CHOICES, default: 'toggle' }],
			callback: async (action) => self.runTcp(cmd.showMode(action.options.mode), 'Show mode'),
		},
		blank: switchAction('Blank (video mute)', 'blank', [
			{
				type: 'textinput',
				id: 'fade',
				label: 'Fade seconds 0–60 (empty = the engine\'s blank fade; a value here BECOMES the blank fade for later blanks)',
				default: '',
				useVariables: true,
			},
		]),
		blank_fade: {
			name: 'Blank fade time: set (without blanking)',
			options: [{ type: 'textinput', id: 'seconds', label: 'Seconds 0–60', default: '1', useVariables: true }],
			callback: async (action, context) => {
				const s = await parsedText(action.options, 'seconds', context)
				if (self.config.switchTransport !== 'osc') await self.runTcp(cmd.tcpBlankFade(s), 'Blank fade')
				else self.runOsc(cmd.oscBlankFade(self.config.oscPrefix, s), 'Blank fade')
			},
		},
		audio_mute: switchAction('Audio mute', 'audiomute'),
		identify: switchAction('Identify (label every output)', 'identify'),
		outlines: switchAction('Outlines (outline every screen)', 'outlines'),
		correction_bypass: switchAction('Correction bypass (raw wall: outputs without calibration)', 'correctionbypass'),
		show_page: {
			name: 'VIOSO Spaces: show a page',
			options: [
				{
					type: 'textinput',
					id: 'page',
					label: 'next, prev, first, last, a page number, or a page ID (case-sensitive)',
					default: 'next',
					useVariables: true,
				},
			],
			callback: async (action, context) => {
				const page = await parsedText(action.options, 'page', context)
				await self.runTcp(cmd.showPage(page), 'Spaces page')
			},
		},
		pjlink_all: {
			name: 'Projectors: power all on / off (PJLink)',
			options: [
				{
					type: 'dropdown',
					id: 'power',
					label: 'Power',
					choices: [
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
					default: 'on',
				},
			],
			callback: async (action) => self.runPjlinkAll(action.options.power === 'on'),
		},
		restart_engine: {
			name: 'Engine: restart (needs confirmation)',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Restart with',
					choices: [
						{ id: 'project', label: 'the current project (reload)' },
						{ id: 'clean', label: 'no project (clean)' },
					],
					default: 'project',
				},
				{
					type: 'checkbox',
					id: 'confirm',
					label: 'Yes, restart the engine (the output goes dark while it restarts)',
					default: false,
				},
			],
			callback: async (action) => self.runTcp(cmd.restartEngine(action.options.mode, action.options.confirm === true), 'Engine restart'),
		},

		/* ------------------------------------------------------- inputs --- */
		inputs_send: {
			name: 'Inputs: send a value to a channel',
			options: [
				{ type: 'textinput', id: 'channel', label: 'Channel (as in Control → Inputs)', default: 'companion', useVariables: true },
				{
					type: 'dropdown',
					id: 'form',
					label: 'What',
					choices: [
						{ id: 'xy', label: 'Position X [Y]' },
						{ id: 'x', label: 'X only' },
						{ id: 'y', label: 'Y only' },
						{ id: 'click', label: 'Click' },
					],
					default: 'x',
				},
				{ type: 'textinput', id: 'a', label: 'Value (X; for a click: optional, default 1)', default: '1', useVariables: true },
				{ type: 'textinput', id: 'b', label: 'Y (Position only; optional)', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const ch = await parsedText(action.options, 'channel', context)
				const a = await parsedText(action.options, 'a', context)
				const b = await parsedText(action.options, 'b', context)
				await self.runTcp(cmd.track(ch, action.options.form, a, b), 'Inputs')
			},
		},
		inputs_nudge: {
			name: 'Inputs: nudge a channel value (dial / +/- key)',
			options: [
				{ type: 'textinput', id: 'channel', label: 'Channel', default: 'companion', useVariables: true },
				{
					type: 'dropdown',
					id: 'axis',
					label: 'Axis',
					choices: [
						{ id: 'x', label: 'X' },
						{ id: 'y', label: 'Y' },
					],
					default: 'x',
				},
				{ type: 'number', id: 'delta', label: 'Step', default: 0.05, min: -1000, max: 1000, step: 0.01 },
				{ type: 'number', id: 'min', label: 'Minimum', default: 0, min: -100000, max: 100000, step: 0.01 },
				{ type: 'number', id: 'max', label: 'Maximum', default: 1, min: -100000, max: 100000, step: 0.01 },
				{ type: 'number', id: 'start', label: 'Start value (the module keeps its own value from here)', default: 0, min: -100000, max: 100000, step: 0.01 },
			],
			callback: async (action, context) => {
				const ch = cmd.checkChannel(await parsedText(action.options, 'channel', context))
				if (!ch.ok) return self.reportError('Inputs', ch.error)
				const min = Number(action.options.min)
				const max = Number(action.options.max)
				if (!(max > min)) return self.reportError('Inputs', 'Maximum must be above Minimum')
				const start = Math.min(max, Math.max(min, Number(action.options.start) || 0))
				self.inputDial(ch.channel, action.options.axis === 'y' ? 'y' : 'x', { min, max, start }).nudge(Number(action.options.delta))
			},
		},
		inputs_groups: {
			name: 'Inputs: switch rule groups',
			options: [
				{
					type: 'textinput',
					id: 'command',
					label: 'group:<name>=on|off|toggle, solo=<name> or all=on|off',
					default: 'all=on',
					useVariables: true,
				},
			],
			callback: async (action, context) => {
				const c = await parsedText(action.options, 'command', context)
				await self.runHttp(cmd.httpInputsGroups(c), 'Inputs groups', cmd.parseOkErrorResponse)
			},
		},

		/* ----------------------------------------------- command buttons --- */
		fire_button: {
			name: 'Command button: press',
			options: [
				{
					type: 'dropdown',
					id: 'button',
					label: 'Command button (read from the project)',
					choices: buttonChoiceList,
					default: buttonChoiceList.length ? buttonChoiceList[0].id : '',
					allowCustom: true,
				},
				{
					type: 'textinput',
					id: 'id',
					label: 'or its ID (overrides the list; Control tab → select the button → Inspector → ID)',
					default: '',
					useVariables: true,
				},
			],
			callback: async (action, context) => {
				const typed = (await parsedText(action.options, 'id', context)).trim()
				const id = typed || String(action.options.button ?? '').trim()
				await self.runFireButton(id)
			},
		},

		/* --------------------------------------------------------- tools --- */
		resync: {
			name: 'Re-sync: reconnect and re-read everything',
			options: [],
			callback: async () => self.resync(),
		},
		clear_error: {
			name: 'Clear $(…:last_error)',
			options: [],
			callback: async () => self.setVariableValues({ last_error: '' }),
		},
		raw_tcp: {
			name: 'Raw TCP command',
			options: [
				{
					type: 'textinput',
					id: 'line',
					label: 'One command line, e.g. comp1.set:vol=80 (the reply goes to $(exaplay:last_reply))',
					default: '',
					useVariables: true,
				},
			],
			callback: async (action, context) => {
				const line = await context.parseVariablesInString(String(action.options.line ?? ''))
				await self.runTcp(cmd.raw(line), 'Raw command')
			},
		},
		osc_send: {
			name: 'Send OSC to the engine',
			options: [
				{ type: 'textinput', id: 'address', label: 'Address, e.g. /exaplay/comp1/cue', default: '/', useVariables: true },
				{ type: 'textinput', id: 'args', label: 'Arguments: i:<int>, f:<float>, s:<text>, comma-separated', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const address = await parsedText(action.options, 'address', context)
				const args = await parsedText(action.options, 'args', context)
				self.runOsc(cmd.oscCustom(address, args), 'OSC')
			},
		},
		http_send: {
			name: 'Send an HTTP request to the engine',
			options: [
				{
					type: 'dropdown',
					id: 'method',
					label: 'Method',
					choices: [
						{ id: 'POST', label: 'POST' },
						{ id: 'GET', label: 'GET' },
					],
					default: 'POST',
				},
				{ type: 'textinput', id: 'path', label: 'Path on the engine, e.g. /cue/trigger', default: '/', useVariables: true },
				{ type: 'textinput', id: 'body', label: 'JSON body (POST; empty = none)', default: '', useVariables: true },
			],
			callback: async (action, context) => {
				const path = await parsedText(action.options, 'path', context)
				const body = await parsedText(action.options, 'body', context)
				await self.runHttp(cmd.httpCustom(action.options.method, path, body), `HTTP ${path}`, (status, text) =>
					status >= 200 && status < 300
						? { ok: true, message: `${status}${text ? ` ${String(text).slice(0, 200)}` : ''}` }
						: { ok: false, error: `HTTP ${status}${text ? ` ${String(text).slice(0, 200)}` : ''}` },
				)
			},
		},
	}
}

module.exports = { getActionDefinitions }
