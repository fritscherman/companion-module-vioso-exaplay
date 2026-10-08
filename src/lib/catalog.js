'use strict'
/**
 * The project's CATALOG: compositions with their cue lists, and the command
 * buttons — what the dropdowns, the per-cue presets and the cue feedbacks
 * are built from. No Companion dependency; the TCP and HTTP senders are
 * injected.
 *
 * Read with (every one verified against the engine source):
 *   TCP  get:complist                      → `<id>,<name>` … END
 *   TCP  <id>.get:type                     → timeline | cuelist | composition
 *   TCP  <id>.get:cuelist                  → rows … END (Timeline / Playlist only)
 *   TCP  <id>.get:audio.volume, .get:alpha → the stored numbers (for the dials)
 *   HTTP GET /data?type=exaObj&path=project&values → control_panel_items (read only)
 *
 * TCP reads go to the client's BACKGROUND queue, so a refresh of a big
 * project never delays an operator's GO.
 *
 * Unknown is never evidence: a part that could not be read is `undefined`
 * (and its reason kept), never an empty list. `refresh()` calls made while
 * one runs are coalesced into ONE more run after it.
 */
const { EventEmitter } = require('node:events')
const cmd = require('./commands')
const { parseCompList } = require('./reply')
const { parseTypeReply, parseCueListRows, parseCommandButtons } = require('./cues')

function emptyCatalog() {
	return {
		/** a refresh has completed since the last clear */
		known: false,
		/** @type {Array<object>|undefined} */
		comps: undefined,
		compsError: undefined,
		/** @type {Array<{id:string,label:string}>|undefined} */
		buttons: undefined,
		buttonsError: undefined,
		refreshedAt: undefined,
	}
}

class Catalog extends EventEmitter {
	/**
	 * @param {object} o
	 * @param {(line:string, opts?:object) => Promise<object>} o.sendTcp  TcpClient#send
	 * @param {(req:object) => Promise<{status?:number, body?:string, error?:string}>} o.http
	 */
	constructor({ sendTcp, http, now = Date.now } = {}) {
		super()
		this.sendTcp = sendTcp
		this.http = http
		this.now = now
		this.state = emptyCatalog()
		this.running = null
		this.again = false
		this.epoch = 0
	}

	/** Forget everything (project changed / link lost): every list reads unknown. */
	clear() {
		this.epoch++
		this.state = emptyCatalog()
		this.emit('change', this.state)
	}

	/** Refresh now; a call while one runs schedules exactly one more run. */
	refresh(reason = '') {
		if (this.running) {
			this.again = true
			return this.running
		}
		this.running = (async () => {
			try {
				do {
					this.again = false
					await this._run(reason)
				} while (this.again)
			} finally {
				this.running = null
			}
		})()
		return this.running
	}

	get refreshing() {
		return !!this.running
	}

	entry(compId) {
		const comps = this.state.comps
		if (!comps || typeof compId !== 'string') return undefined
		return comps.find((c) => c.id === compId)
	}

	async _bg(line) {
		return this.sendTcp(line, { background: true })
	}

	async _run(reason) {
		const epoch = this.epoch
		this.emit('log', 'debug', `refreshing cue lists and command buttons${reason ? ` (${reason})` : ''}`)
		const next = emptyCatalog()

		const list = await this._bg(cmd.compList().line)
		if (list.ok && Array.isArray(list.rows)) {
			next.comps = []
			for (const c of parseCompList(list.rows)) {
				const entry = { id: c.id, name: c.name, type: undefined, cues: undefined, error: undefined, volume: undefined, opacity: undefined }
				next.comps.push(entry)
				const ref = cmd.checkCompRef(c.id)
				if (!ref.ok) {
					entry.error = ref.error
					continue
				}
				const t = await this._bg(cmd.compType(c.id).line)
				entry.type = t.ok ? parseTypeReply(t.value) : undefined
				if (!t.ok) entry.error = `type: ${t.error}`
				if (entry.type === 'timeline' || entry.type === 'playlist') {
					const cl = await this._bg(cmd.cueList(c.id).line)
					if (cl.ok && Array.isArray(cl.rows)) {
						const p = parseCueListRows(entry.type, cl.rows)
						entry.cues = p.cues
						if (p.skipped) entry.error = `${p.skipped} cue row(s) not understood`
					} else entry.error = `cue list: ${cl.error}`
				} else if (entry.type === 'other') entry.cues = [] // a plain composition has no cues (engine answers ERR there)
				for (const which of ['volume', 'opacity']) {
					const g = await this._bg(cmd.getLevel(c.id, which).line)
					entry[which] = g.ok ? cmd.parseNumberReply(g.value) : undefined
				}
			}
		} else next.compsError = list.error || 'no list'

		const b = await this.http(cmd.httpReadProjectValues())
		if (b.error) next.buttonsError = b.error
		else {
			const d = cmd.parseDataValues(b.status, b.body)
			if (!d.ok) next.buttonsError = d.error
			else {
				next.buttons = parseCommandButtons(d.values)
				if (!next.buttons) next.buttonsError = 'control_panel_items unreadable'
			}
		}

		if (epoch !== this.epoch) return // cleared meanwhile (project changed): a newer run follows
		next.known = true
		next.refreshedAt = this.now()
		this.state = next
		this.emit('change', next)
	}
}

/** Identity of the catalog for redefining dropdowns / presets only when it changed. */
function catalogSignature(cat) {
	if (!cat) return ''
	return JSON.stringify([
		(cat.comps || []).map((c) => [c.id, c.name, c.type, (c.cues || []).map((q) => [q.index, q.name])]),
		cat.comps === undefined,
		(cat.buttons || []).map((x) => [x.id, x.label]),
		cat.buttons === undefined,
	])
}

/** Dropdown choices: every cue of every composition, id `<compId>|<index>`. */
function cueChoices(cat) {
	const out = []
	for (const c of (cat && cat.comps) || [])
		for (const q of c.cues || [])
			out.push({ id: `${c.id}|${q.index}`, label: `${c.name || c.id} › ${q.index}  ${q.name || '(unnamed)'}` })
	return out
}

/** `<compId>|<index>` → { comp, cue } or undefined. */
function parseCuePick(pick) {
	const s = typeof pick === 'string' ? pick.trim() : ''
	const i = s.lastIndexOf('|')
	if (i <= 0 || i === s.length - 1) return undefined
	return { comp: s.slice(0, i), cue: s.slice(i + 1) }
}

function buttonChoices(cat) {
	return ((cat && cat.buttons) || []).map((b) => ({ id: b.id, label: b.label === b.id ? b.id : `${b.label} (${b.id})` }))
}

module.exports = { Catalog, emptyCatalog, catalogSignature, cueChoices, parseCuePick, buttonChoices }
