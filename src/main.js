'use strict'
/**
 * Bitfocus Companion module for VIOSO Exaplay 3 (Companion 3.x, module API
 * @companion-module/base 1.x).
 *
 * Transports (see ../README.md):
 *   TCP 8100       one persistent connection: transport, cues, seek, levels,
 *                  loop, Show mode, Spaces page, restart, Inputs samples,
 *                  cue-list reads (background queue), raw lines
 *   ws 8123/status push status → variables and feedbacks
 *   HTTP 8123      POST /control/fire (command button by id), POST /stop,
 *                  POST /cmd pjlink-all, GET /data (command-button list, read
 *                  only; master volume), POST /data path=global (master
 *                  volume), POST /tracking {"command"} (Inputs groups)
 *   OSC 8000       blank, blank fade, audio mute, Identify, Outlines,
 *                  correction bypass, play all, Timeline frame (no TCP verb)
 *
 * Every piece of state lives on the instance: two connections to two engines
 * share nothing (Companion namespaces variables and feedbacks per connection).
 */
const { InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base')
const { getConfigFields, withDefaults } = require('./config')
const { getActionDefinitions } = require('./actions')
const { getFeedbackDefinitions } = require('./feedbacks')
const { getPresetDefinitions } = require('./presets')
const { getVariableDefinitions, getVariableValues, listsWord } = require('./variables')
const { TcpClient } = require('./lib/tcp-client')
const { StatusClient } = require('./lib/status-client')
const { request } = require('./lib/http')
const cmd = require('./lib/commands')
const { Catalog, catalogSignature } = require('./lib/catalog')
const { ValueDial } = require('./lib/dial')
const { orderedCues, findCue } = require('./lib/cues')
const {
	emptyState,
	compositionChoices,
	staleVariableValues,
	findComposition,
	allCompositions,
	resolveCompId,
	varKey,
} = require('./lib/status')

/** Long enough for every configured projector to answer, one after the other. */
const PJLINK_ALL_TIMEOUT_MS = 30000
const BLINK_MS = 500

class ExaplayInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		this.config = withDefaults({})
		this.status = emptyState()
		this.tcpState = 'disconnected'
		this.statusState = 'disconnected'
		this.tcp = null
		this.statusClient = null
		this.signature = null
		this.catalog = new Catalog({
			sendTcp: (line, opts) => (this.tcp ? this.tcp.send(line, opts) : Promise.resolve({ ok: false, error: 'not configured' })),
			http: (built) => this.httpRaw(built),
		})
		this.catalog.on('change', () => this.onCatalogChange())
		this.catalog.on('log', (lvl, msg) => this.log(lvl, msg))
		this.prevCatalog = this.catalog.state
		/** compId → { volume, opacity } as last read or set by this module */
		this.levels = {}
		this.masterVolume = undefined
		/** compId → cue index picked with the cue dial */
		this.selected = {}
		/** command button id → { ok, error } of its last press */
		this.buttonResults = {}
		this.dials = new Map()
		this.blinkOn = true
		this.blinkTimer = null
		this.lastStatusSig = ''
		this.statusSeen = false
	}

	async init(config) {
		this.config = withDefaults(config)
		this.defineAll()
		this.connect()
	}

	async configUpdated(config) {
		this.disconnect()
		this.config = withDefaults(config)
		this.status = emptyState()
		this.resetEngineKnowledge()
		this.statusSeen = false
		this.defineAll()
		this.connect()
	}

	async destroy() {
		this.disconnect()
		this.stopBlink()
	}

	getConfigFields() {
		return getConfigFields()
	}

	/* --------------------------------------------------------- wiring --- */

	connect() {
		const c = this.config
		if (!c.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'Set the engine address')
			return
		}
		this.tcp = new TcpClient({ host: c.host, port: Number(c.tcpPort) || 8100 })
		this.tcp.on('state', (s) => {
			const was = this.tcpState
			this.tcpState = s
			if (s === 'connected' && was !== 'connected') this.refreshLists('TCP connected')
			if (s !== 'connected' && was === 'connected') this.invalidateDials()
			this.onLinkChange()
		})
		this.tcp.on('log', (lvl, msg) => this.log(lvl, msg))
		this.tcp.start()

		if (c.statusEnabled) {
			this.statusClient = new StatusClient({
				url: `ws://${c.host}:${Number(c.httpPort) || 8123}/status`,
				rate: c.statusRate,
			})
			this.statusClient.on('state', (s) => {
				const was = this.statusState
				this.statusState = s
				// The feed came BACK: the project may have changed while it was
				// gone, and a lost feed hides a load. Re-read the lists once.
				if (s === 'connected' && was !== 'connected' && this.statusSeen) this.refreshLists('status feed back')
				if (s === 'connected') this.statusSeen = true
				this.onLinkChange()
			})
			this.statusClient.on('lost', () => this.applyStatus(emptyState()))
			this.statusClient.on('message', (m) => {
				if (m.kind === 'status') this.applyStatus(m.state)
			})
			this.statusClient.on('log', (lvl, msg) => this.log(lvl, msg))
			this.statusClient.start()
		}
		this.onLinkChange()
	}

	disconnect() {
		if (this.tcp) {
			this.tcp.removeAllListeners()
			this.tcp.stop()
			this.tcp = null
		}
		if (this.statusClient) {
			this.statusClient.removeAllListeners()
			this.statusClient.stop()
			this.statusClient = null
		}
		this.tcpState = 'disconnected'
		this.statusState = 'disconnected'
		this.stopBlink()
	}

	/** Everything this module knows about the engine's project becomes unknown. */
	resetEngineKnowledge() {
		this.catalog.clear()
		this.levels = {}
		this.masterVolume = undefined
		this.selected = {}
		this.buttonResults = {}
		for (const d of this.dials.values()) d.throttle.cancel()
		this.dials.clear()
		this.lastStatusSig = ''
	}

	invalidateDials() {
		for (const d of this.dials.values()) d.invalidate()
	}

	/** Re-sync: drop both links, forget what was read, connect again (lists refresh on connect). */
	resync() {
		this.log('info', 'Re-sync: reconnecting and re-reading cue lists and command buttons')
		this.disconnect()
		this.status = emptyState()
		this.resetEngineKnowledge()
		this.statusSeen = false // both links restart; the TCP connect re-reads the lists
		this.setVariableValues({ last_error: '' })
		this.connect()
		this.updateAll()
	}

	onLinkChange() {
		const tcp = this.tcpState
		const st = this.statusState
		if (!this.config.host) return
		if (tcp === 'connected' && (st === 'connected' || !this.config.statusEnabled)) this.updateStatus(InstanceStatus.Ok)
		else if (tcp === 'connected') this.updateStatus(InstanceStatus.UnknownWarning, 'Commands OK; status feed not connected')
		else if (tcp === 'connecting' || st === 'connecting') this.updateStatus(InstanceStatus.Connecting)
		else this.updateStatus(InstanceStatus.ConnectionFailure, 'Engine not reachable')
		if (tcp === 'connected') this.stopBlink()
		else this.startBlink()
		this.setVariableValues(getVariableValues(this))
		this.checkFeedbacks('connected', 'status_unknown', 'connection_lost')
	}

	/** The "connection lost" key flashes — a clock that runs only while the link is down. */
	startBlink() {
		if (this.blinkTimer) return
		this.blinkTimer = setInterval(() => {
			this.blinkOn = !this.blinkOn
			this.checkFeedbacks('connection_lost')
		}, BLINK_MS)
	}

	stopBlink() {
		if (this.blinkTimer) clearInterval(this.blinkTimer)
		this.blinkTimer = null
		this.blinkOn = true
	}

	/** A new status snapshot (or an empty one when the feed was lost). */
	applyStatus(next) {
		const prev = this.status
		this.status = next
		this.maybeRefreshForStatus(prev, next)
		this.redefineIfChanged()
		this.setVariableValues({ ...staleVariableValues(prev, next, this.catalog.state, this.catalog.state), ...getVariableValues(this) })
		this.checkFeedbacks()
	}

	/**
	 * When the project behind the lists has changed, re-read them: a load
	 * finished, the project name changed, or the feed's composition list no
	 * longer matches the catalog's. Never while a project loads (the engine
	 * drops TCP commands then).
	 */
	maybeRefreshForStatus(prev, next) {
		if (!next.known || next.loading === true) return
		const loadDone = prev.loading === true && next.loading === false
		const renamed = prev.projectName !== undefined && next.projectName !== undefined && prev.projectName !== next.projectName
		if (loadDone || renamed) {
			this.resetEngineKnowledge()
			this.refreshLists(loadDone ? 'project loaded' : 'project changed')
			return
		}
		if (!Array.isArray(next.compositions) || !this.catalog.state.known || this.catalog.refreshing) return
		const statusSig = JSON.stringify(next.compositions.map((c) => [c.id, c.name, c.type]))
		if (statusSig === this.lastStatusSig) return
		const cat = this.catalog.state.comps || []
		const catSig = JSON.stringify(cat.map((c) => [c.id, c.name, c.type]))
		if (statusSig !== catSig) {
			// once per distinct status list — a lasting difference must not refresh at the status rate
			this.lastStatusSig = statusSig
			this.refreshLists('compositions changed')
		}
	}

	refreshLists(reason) {
		if (this.status.loading === true) return Promise.resolve()
		const p = this.catalog.refresh(reason)
		this.setVariableValues({ lists_state: 'refreshing' })
		return p
			.catch((e) => this.reportError('Refresh', e.message))
			.then(() => this.setVariableValues({ lists_state: listsWord(this.catalog.state, this.catalog.refreshing) }))
	}

	onCatalogChange() {
		const prev = this.prevCatalog
		const cat = this.catalog.state
		this.prevCatalog = cat
		// levels read during the refresh seed the dials (unless an operator is working one)
		for (const c of cat.comps || []) {
			for (const which of ['volume', 'opacity']) {
				if (typeof c[which] !== 'number') continue
				const d = this.dials.get(`${which}:${c.id}`)
				if (d) d.observe(c[which])
				else this.setLevel(c.id, which, c[which])
			}
		}
		if (cat.known && (cat.compsError || cat.buttonsError))
			this.reportError('Reading cue lists / command buttons', [cat.compsError, cat.buttonsError].filter(Boolean).join('; '))
		this.redefineIfChanged()
		this.setVariableValues({ ...staleVariableValues(this.status, this.status, prev, cat), ...getVariableValues(this) })
		this.checkFeedbacks()
	}

	/** Dropdowns, variables and presets follow the composition list, the cue lists and the buttons. */
	redefineIfChanged() {
		const sig = this.definitionSignature()
		if (sig === this.signature) return
		this.signature = sig
		this.setActionDefinitions(getActionDefinitions(this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
		this.setVariableDefinitions(getVariableDefinitions(this))
		this.setPresetDefinitions(getPresetDefinitions(this))
	}

	definitionSignature() {
		return JSON.stringify([allCompositions(this.status, this.catalog.state).map((c) => [c.id, c.name, c.type]), catalogSignature(this.catalog.state)])
	}

	defineAll() {
		this.signature = null
		this.redefineIfChanged()
		this.setVariableValues({ ...getVariableValues(this), last_reply: '', last_error: '' })
	}

	updateAll() {
		this.redefineIfChanged()
		this.setVariableValues(getVariableValues(this))
		this.checkFeedbacks()
	}

	compositionChoices() {
		return compositionChoices(this.status, this.catalog.state)
	}

	/** A composition reference (ID or name) → its ID when either list knows it, else the reference as given. */
	resolveCompId(ref) {
		return resolveCompId(this.status, this.catalog.state, ref)
	}

	/* -------------------------------------------------------- senders --- */

	reportError(what, error) {
		this.log('warn', `${what}: ${error}`)
		this.setVariableValues({ last_error: `${what}: ${error}` })
	}

	/** Send a built TCP command; never resends (see lib/tcp-client.js). Resolves to the client's result. */
	async runTcp(built, what, { quiet = false } = {}) {
		if (!built.ok) {
			this.reportError(what, built.error)
			return { ok: false, error: built.error }
		}
		if (!this.tcp) {
			this.reportError(what, 'not configured')
			return { ok: false, error: 'not configured' }
		}
		const r = await this.tcp.send(built.line)
		if (r.ok) {
			const reply = r.rows ? r.rows.join(' | ') : r.reply
			if (!quiet) this.setVariableValues({ last_reply: reply })
			this.log('debug', `${built.line} → ${reply}`)
		} else {
			if (r.reply && !quiet) this.setVariableValues({ last_reply: r.reply })
			this.reportError(`${what} (${built.line})`, r.error)
		}
		return r
	}

	/** OSC is fire-and-forget: the engine sends no reply, so nothing can confirm it but the status feed. */
	runOsc(built, what) {
		if (!built.ok) return this.reportError(what, built.error)
		if (!this.config.host) return this.reportError(what, 'not configured')
		this.oscSend(this.config.host, Number(this.config.oscPort) || 8000, built.address, built.args)
		this.log('debug', `OSC ${built.address} ${built.args.map((a) => a.value).join(' ')}`)
	}

	/** One HTTP request to the engine; resolves { status, body } or { error }. Never resent. */
	httpRaw(built, timeoutMs) {
		if (!this.config.host) return Promise.resolve({ error: 'not configured' })
		return request({
			host: this.config.host,
			port: Number(this.config.httpPort) || 8123,
			method: built.method,
			path: built.path,
			body: built.body,
			...(timeoutMs ? { timeoutMs } : {}),
		})
	}

	async runHttp(built, what, parse, { timeoutMs } = {}) {
		if (!built.ok) {
			this.reportError(what, built.error)
			return { ok: false, error: built.error }
		}
		if (!this.config.host) {
			this.reportError(what, 'not configured')
			return { ok: false, error: 'not configured' }
		}
		const res = await this.httpRaw(built, timeoutMs)
		if (res.error) {
			this.reportError(what, res.error)
			return { ok: false, error: res.error }
		}
		const r = parse(res.status, res.body)
		if (!r.ok) {
			this.reportError(what, r.error)
			return r
		}
		this.setVariableValues({ last_reply: `${what}: ${r.message || 'OK'}` })
		return r
	}

	async runFireButton(id) {
		const i = typeof id === 'string' ? id.trim() : ''
		const btn = (this.catalog.state.buttons || []).find((b) => b.id === i)
		const label = btn ? btn.label : i
		const r = await this.runHttp(cmd.httpFireButton(i), `Command button "${label}"`, cmd.parseFireResponse)
		if (i) {
			this.buttonResults[i] = { ok: r.ok, error: r.ok ? undefined : r.error }
			this.setVariableValues({ button_last: r.ok ? `${label}: OK` : `${label}: ${r.error}` })
			this.checkFeedbacks('button_failed')
		}
		return r
	}

	runStopAll() {
		return this.runHttp(cmd.httpStopAll(), 'Stop all', (status) => cmd.parseStopAllResponse(status))
	}

	runPjlinkAll(on) {
		return this.runHttp(cmd.httpPjlinkAll(on), `Projectors ${on ? 'on' : 'off'}`, cmd.parsePjlinkAllResponse, {
			timeoutMs: PJLINK_ALL_TIMEOUT_MS,
		})
	}

	/* ---------------------------------------------------- levels / dials --- */

	setLevel(compId, which, v) {
		const cur = this.levels[compId] || (this.levels[compId] = {})
		if (cur[which] === v) return
		cur[which] = v
		this.setVariableValues({ [`comp_${varKey(compId)}_${which}`]: typeof v === 'number' ? String(Math.round(v * 10) / 10) : '?' })
	}

	dial(key, make) {
		let d = this.dials.get(key)
		if (!d) {
			d = make()
			this.dials.set(key, d)
		}
		return d
	}

	/** Composition volume / opacity dial: TCP get (stored value) / set (0–100). */
	levelDial(compId, which) {
		return this.dial(`${which}:${compId}`, () => {
			const what = `${which === 'volume' ? 'Volume' : 'Opacity'} ${compId}`
			return new ValueDial({
				min: 0,
				max: 100,
				read: async () => {
					const b = cmd.getLevel(compId, which)
					if (!b.ok) return b
					if (!this.tcp) return { ok: false, error: 'not configured' }
					const r = await this.tcp.send(b.line)
					if (!r.ok) return { ok: false, error: r.error }
					const v = cmd.parseNumberReply(r.value)
					return v === undefined ? { ok: false, error: `unexpected reply "${r.value}"` } : { ok: true, value: v }
				},
				write: (v) => this.runTcp(cmd.setLevel(compId, which, v), what, { quiet: true }),
				onChange: (v) => this.setLevel(compId, which, v),
				onError: (m) => this.reportError(what, m),
			})
		})
	}

	/** Engine master volume dial: HTTP GET /data path=global / POST /data path=global. */
	masterDial() {
		return this.dial('master', () => {
			return new ValueDial({
				min: 0,
				max: 100,
				read: async () => {
					const res = await this.httpRaw(cmd.httpReadGlobalValues())
					if (res.error) return { ok: false, error: res.error }
					const d = cmd.parseDataValues(res.status, res.body)
					if (!d.ok) return d
					const v = cmd.readMasterVolume(d.values)
					return v === undefined ? { ok: false, error: 'the engine did not report audio-volume' } : { ok: true, value: v }
				},
				write: async (v) => {
					const res = await this.httpRaw(cmd.httpSetMasterVolume(v))
					if (res.error) return { ok: false, error: res.error }
					return cmd.parseDataWriteResponse(res.status)
				},
				onChange: (v) => {
					this.masterVolume = v
					this.setVariableValues({ master_volume: typeof v === 'number' ? String(Math.round(v * 10) / 10) : '?' })
				},
				onError: (m) => this.reportError('Master volume', m),
			})
		})
	}

	/**
	 * Seek dial: the base is the status feed's time (Timeline: time; Playlist:
	 * the playing item's time — what set:time addresses). The module's own
	 * value serves as the base for 1 s while the dial turns.
	 */
	seekDial(compId) {
		return this.dial(`seek:${compId}`, () => {
			const what = `Seek ${compId}`
			return new ValueDial({
				min: 0,
				max: Infinity,
				staleMs: 1000,
				read: async () => {
					const c = findComposition(this.status, compId)
					if (!c) return { ok: false, error: 'composition not in the status feed' }
					const t = c.type === 'playlist' ? (c.item && typeof c.item === 'object' ? c.item.time : undefined) : c.time
					if (typeof t !== 'number') return { ok: false, error: 'current time unknown' }
					return { ok: true, value: t }
				},
				write: (v) => this.runTcp(cmd.seekTime(compId, v), what, { quiet: true }),
				onError: (m) => this.reportError(what, m),
			})
		})
	}

	/** The seek range for a composition: up to its known length, else open. */
	seekMax(compId) {
		const c = findComposition(this.status, compId)
		if (!c) return Infinity
		if (c.type === 'timeline' && typeof c.duration === 'number' && c.duration > 0) return c.duration
		if (c.type === 'playlist' && c.item && typeof c.item.duration === 'number' && c.item.duration > 0) return c.item.duration
		return Infinity
	}

	/**
	 * Inputs channel dial: the module's OWN value (Exaplay has no read-back of
	 * a single channel over TCP), starting at the action's start value.
	 */
	inputDial(channel, axis, { min, max, start }) {
		const d = this.dial(`input:${channel}:${axis}`, () => {
			const what = `Inputs ${channel}`
			return new ValueDial({
				min,
				max,
				staleMs: Infinity,
				read: async () => ({ ok: true, value: start }),
				write: (v) => this.runTcp(cmd.track(channel, axis, v), what, { quiet: true }),
				onError: (m) => this.reportError(what, m),
			})
		})
		d.setRange(min, max)
		return d
	}

	/* -------------------------------------------------------- cue dial --- */

	/** Step the picked cue of a composition by `step` (no engine traffic). */
	stepSelectedCue(compId, step) {
		const entry = this.catalog.entry(compId)
		const cues = orderedCues(entry)
		if (!cues || cues.length === 0) {
			this.reportError(`Cue dial ${compId}`, cues ? 'no cues' : 'cue list unknown — refresh the lists')
			return
		}
		let pos
		const sel = this.selected[compId]
		if (sel !== undefined) pos = cues.findIndex((c) => c.index === sel)
		if (pos === undefined || pos < 0) {
			const comp = findComposition(this.status, compId)
			const cur = comp && comp.cue && typeof comp.cue.index === 'number' ? cues.findIndex((c) => c.index === comp.cue.index) : -1
			pos = cur >= 0 ? cur : step > 0 ? -1 : cues.length
		}
		const nextPos = Math.min(cues.length - 1, Math.max(0, pos + step))
		this.selected[compId] = cues[nextPos].index
		this.setVariableValues(getVariableValues(this))
		this.checkFeedbacks('cue_selected')
	}

	/** GO the picked cue — an absolute cue.go, so a lost reply never moves twice. */
	async goSelectedCue(compId) {
		const sel = this.selected[compId]
		if (sel === undefined) {
			this.reportError(`Cue dial ${compId}`, 'no cue picked — turn the dial first')
			return
		}
		const entry = this.catalog.entry(compId)
		if (entry && !findCue(entry, String(sel))) {
			this.reportError(`Cue dial ${compId}`, `cue ${sel} is no longer in the list`)
			return
		}
		await this.runTcp(cmd.cueGo(compId, String(sel)), 'Cue: go picked')
	}
}

runEntrypoint(ExaplayInstance, [])

module.exports = { ExaplayInstance }
