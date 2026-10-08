'use strict'
/**
 * Command builders — pure, no Companion and no socket.
 *
 * Every builder returns either { ok: true, ... } or { ok: false, error }.
 * Nothing here throws on operator input: a Companion button whose text field
 * holds something unsendable must log why, not crash the module.
 *
 * Which transport carries what (docs/references/tcp-api.md, osc-api.md,
 * rest-api.md):
 *   TCP 8100  — composition transport, cues, next/prev, seek, volume/opacity,
 *               loop, cue lists, Show Mode, Spaces page, engine restart,
 *               Inputs samples (`track,…`), raw lines.
 *   OSC 8000  — the engine-wide switches the TCP API has no verb for:
 *               start all, blank (videomute [+ fade]), blank fade, audio mute,
 *               Identify, Outlines (showguides), correction bypass; a Timeline
 *               frame jump; a free message to the engine.
 *   HTTP 8123 — POST /stop (stop all, with a status code),
 *               POST /control/fire {"id"} (a command button: the request NAMES
 *               the button, it never carries a script), POST /cmd pjlink-all,
 *               GET /data (project values: the command-button list, read
 *               only; global: master volume), POST /data path=global
 *               (master volume), POST /tracking {"command"} (Inputs groups).
 */

/** CR, LF and NUL would split one request into two commands on a CRLF wire. */
const LINE_BREAKERS = /[\r\n\0]/

/** On/off/toggle words the engine accepts for every switch. */
const SWITCH_MODES = ['on', 'off', 'toggle']

function fail(error) {
	return { ok: false, error }
}

/**
 * A composition reference for the FIRST component of a dotted line: the
 * composition's ID (`comp1`) or its name. A name with a `.` cannot be used
 * there (the dot separates path components), a `,` would end the first field
 * and turn the line into a classic command, and a `>` anywhere makes the
 * engine answer ERR,unknown_command.
 */
function checkCompRef(ref) {
	if (typeof ref !== 'string') return fail('No composition given')
	const r = ref.trim()
	if (!r) return fail('No composition given')
	if (LINE_BREAKERS.test(r)) return fail('Composition contains a line break')
	if (r.includes('.')) return fail(`"${r}" contains a "." — use the composition ID (comp1) instead of its name`)
	if (r.includes(',')) return fail(`"${r}" contains a "," — use the composition ID (comp1) instead of its name`)
	if (r.includes('>')) return fail(`"${r}" contains a ">" — the engine refuses such lines`)
	return { ok: true, ref: r }
}

/** A dotted-line argument (a cue name): no line breaks and no `>`. */
function checkArgument(arg, what) {
	if (LINE_BREAKERS.test(arg)) return fail(`${what} contains a line break`)
	if (arg.includes('>')) return fail(`${what} contains a ">" — the engine refuses such lines`)
	return { ok: true }
}

const TRANSPORT_VERBS = {
	play: 'play',
	pause: 'pause',
	stop: 'stop',
	next: 'next',
	previous: 'prev',
	prev: 'prev',
}

/**
 * `comp1.play` / `.pause` / `.stop` / `.next` / `.prev`.
 * next/previous are RELATIVE: never resend one whose reply was lost.
 */
function transport(compRef, verb) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	const v = TRANSPORT_VERBS[verb]
	if (!v) return fail(`Unknown transport verb "${verb}"`)
	return { ok: true, line: `${c.ref}.${v}`, relative: v === 'next' || v === 'prev' }
}

/**
 * Play/pause toggle needs the composition's CURRENT state, which only the
 * status feed knows. Unknown is never evidence: with no state the toggle does
 * nothing rather than guess.
 */
function toggleTransport(compRef, state) {
	if (state === 'playing') return transport(compRef, 'pause')
	if (state === 'paused' || state === 'stopped') return transport(compRef, 'play')
	return fail('Composition state unknown (no status feed) — toggle not sent')
}

/**
 * `comp1.cue.go=<index|name>`. Timeline: the cue's variable index; Playlist:
 * the 1-based item. A purely numeric argument is ALWAYS taken as the index by
 * the engine, so a cue NAMED "3" cannot be reached by name.
 */
function cueGo(compRef, cue) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	const raw = cue === undefined || cue === null ? '' : String(cue)
	const arg = raw.trim()
	if (!arg) return fail('No cue given')
	const a = checkArgument(arg, 'Cue')
	if (!a.ok) return a
	return { ok: true, line: `${c.ref}.cue.go=${arg}`, relative: false }
}

/** `system.showmode=on|off|toggle` — TCP has it, so it goes over TCP. */
function showMode(mode) {
	if (!SWITCH_MODES.includes(mode)) return fail(`Show mode must be on, off or toggle (got "${mode}")`)
	return { ok: true, line: `system.showmode=${mode}`, relative: mode === 'toggle' }
}

/**
 * The rig-wide switches as TCP lines (Exaplay 3.4: tcp-api.md › System):
 * `system.blank=on|off|toggle[,<fade s>]`, `system.audiomute=…`,
 * `system.identify=…`. Outlines and the raw wall have no TCP verb — those
 * stay on OSC (oscSwitch).
 */
const TCP_SWITCHES = { blank: 'blank', audiomute: 'audiomute', identify: 'identify' }

function tcpSwitchable(which) {
	return Object.prototype.hasOwnProperty.call(TCP_SWITCHES, which)
}

function tcpSwitch(which, mode, fadeSeconds) {
	const verb = TCP_SWITCHES[which]
	if (!verb) return fail(`"${which}" has no TCP command — it is sent over OSC`)
	if (!SWITCH_MODES.includes(mode)) return fail(`Mode must be on, off or toggle (got "${mode}")`)
	let line = `system.${verb}=${mode}`
	if (which === 'blank' && fadeSeconds !== undefined && fadeSeconds !== null && String(fadeSeconds).trim() !== '') {
		const f = Number(fadeSeconds)
		if (!Number.isFinite(f) || f < 0 || f > 60) return fail(`Fade must be 0–60 seconds (got "${fadeSeconds}")`)
		line += `,${f}`
	}
	return { ok: true, line, relative: mode === 'toggle' }
}

/** `system.blankfade=<s>` — the blank fade time without blanking (0–60 s). */
function tcpBlankFade(seconds) {
	const f = toNumber(typeof seconds === 'number' ? seconds : String(seconds ?? ''))
	if (f === undefined || f < 0 || f > 60) return fail(`Blank fade must be 0–60 seconds (got "${seconds}")`)
	return { ok: true, line: `system.blankfade=${f}` }
}

/** `system.playall` / `system.stopall` — every composition. */
function tcpPlayAll() {
	return { ok: true, line: 'system.playall' }
}

function tcpStopAll() {
	return { ok: true, line: 'system.stopall' }
}

/** A raw line from the operator. Only the framing is checked. */
function raw(line) {
	if (typeof line !== 'string') return fail('Empty command')
	const l = line.trim()
	if (!l) return fail('Empty command')
	if (LINE_BREAKERS.test(l)) return fail('Command contains a line break — send one command per action')
	return { ok: true, line: l, relative: true }
}

/**
 * Does this line answer with a LIST ending in `END`? The client needs to know,
 * because replies carry no request id: `get:complist` and every
 * `get:cuelist` (classic `get:cuelist,comp1` and dotted `comp1.get:cuelist`).
 */
function expectsList(line) {
	const l = String(line).trim()
	if (/^get:complist$/i.test(l)) return true
	if (/^get:cuelist,/i.test(l)) return true
	if (/\.get:cuelist$/i.test(l)) return true
	return false
}

/* ---------------------------------------------------------------- OSC --- */

/** `/<prefix>/global/<verb>`; an empty prefix is allowed by the engine. */
function oscAddress(prefix, verb) {
	const p = String(prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
	if (p.includes('/')) return null
	return p ? `/${p}/global/${verb}` : `/global/${verb}`
}

const OSC_SWITCHES = {
	blank: 'videomute',
	audiomute: 'audiomute',
	identify: 'identify',
	outlines: 'showguides',
	// Raw wall: every output without its calibration (osc-api.md › Global).
	correctionbypass: 'correctionbypass',
}

/**
 * The engine-wide switches, as an OSC message { address, args }.
 * Blank takes an optional fade (0–60 s) that ALSO becomes the rig's blank
 * fade time for later blanks; empty/absent fade = keep the engine's own.
 */
function oscSwitch(prefix, which, mode, fadeSeconds) {
	const verb = OSC_SWITCHES[which]
	if (!verb) return fail(`Unknown switch "${which}"`)
	if (!SWITCH_MODES.includes(mode)) return fail(`Mode must be on, off or toggle (got "${mode}")`)
	const address = oscAddress(prefix, verb)
	if (!address) return fail('OSC prefix must not contain "/"')
	const args = [{ type: 's', value: mode }]
	if (which === 'blank' && fadeSeconds !== undefined && fadeSeconds !== null && String(fadeSeconds).trim() !== '') {
		const f = Number(fadeSeconds)
		if (!Number.isFinite(f) || f < 0 || f > 60) return fail(`Fade must be 0–60 seconds (got "${fadeSeconds}")`)
		args.push({ type: 'f', value: f })
	}
	return { ok: true, address, args }
}

/** `/<prefix>/global/start` — start ALL compositions (no TCP or HTTP verb). */
function oscPlayAll(prefix) {
	const address = oscAddress(prefix, 'start')
	if (!address) return fail('OSC prefix must not contain "/"')
	return { ok: true, address, args: [] }
}

/* --------------------------------------------------------------- HTTP --- */

/** POST /stop — stop all compositions. No body. */
function httpStopAll() {
	return { ok: true, method: 'POST', path: '/stop', body: null }
}

/**
 * POST /control/fire {"id"} — press a command button. The body NAMES the
 * button; the engine runs the project's stored script for that id. Never a
 * script in the request.
 */
function httpFireButton(id) {
	const i = typeof id === 'string' ? id.trim() : ''
	if (!i) return fail('No command button id given')
	if (/[\0-\x1f]/.test(i)) return fail('Command button id contains control characters')
	return { ok: true, method: 'POST', path: '/control/fire', body: JSON.stringify({ id: i }) }
}

/**
 * Read a /control/fire answer: 200 {"ok":true,"lines":N} started;
 * {"ok":false,"reason"} did not; 400 bad id; 503 loading.
 */
function parseFireResponse(status, bodyText) {
	let body = null
	try {
		body = bodyText ? JSON.parse(bodyText) : null
	} catch {
		body = null
	}
	if (status === 200 && body && body.ok === true) return { ok: true, lines: typeof body.lines === 'number' ? body.lines : undefined }
	if (status === 503) return { ok: false, error: 'Engine is loading a project' }
	if (status === 400) return { ok: false, error: 'Engine refused the id (missing or malformed)' }
	if (body && body.ok === false) return { ok: false, error: String(body.reason || 'refused') }
	return { ok: false, error: `HTTP ${status}` }
}

function parseStopAllResponse(status) {
	if (status === 200) return { ok: true }
	if (status === 400) return { ok: false, error: 'No project loaded' }
	if (status === 503) return { ok: false, error: 'Engine is loading a project' }
	return { ok: false, error: `HTTP ${status}` }
}

/* ------------------------------------------------ TCP: values & seek --- */

/** A number on the wire: finite, no exponent, at most 3 decimals, no trailing zeros. */
function wireNumber(n) {
	const s = (Math.round(n * 1000) / 1000).toFixed(3)
	return s.replace(/\.?0+$/, '') || '0'
}

/** Parse an operator number (variables already substituted). */
function toNumber(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
	if (typeof v !== 'string') return undefined
	const t = v.trim()
	if (!t || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined
	return Number(t)
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Composition volume / opacity, 0–100 (tcp-api.md › Setter verbs:
 * `comp1.set:vol=80`, `comp1.set:alpha=50`; the engine clamps too, the module
 * clamps first so its own idea of the value matches the engine's).
 */
const LEVELS = {
	volume: { set: 'set:vol', get: 'get:audio.volume' },
	opacity: { set: 'set:alpha', get: 'get:alpha' },
}

function setLevel(compRef, which, value) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	const L = LEVELS[which]
	if (!L) return fail(`Unknown level "${which}"`)
	const n = toNumber(value)
	if (n === undefined) return fail(`${which} must be a number 0–100 (got "${value}")`)
	const v = clamp(n, 0, 100)
	return { ok: true, line: `${c.ref}.${L.set}=${wireNumber(v)}`, value: v, relative: false }
}

/**
 * Read the STORED volume / opacity: the generic getter answers the number as
 * stored (`37.5`), where the classic `get:vol` truncates to an integer.
 */
function getLevel(compRef, which) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	const L = LEVELS[which]
	if (!L) return fail(`Unknown level "${which}"`)
	return { ok: true, line: `${c.ref}.${L.get}`, relative: false }
}

/** A numeric reply → number, or undefined (an `ERR,…` never reaches here). */
function parseNumberReply(value) {
	const n = toNumber(typeof value === 'string' ? value : String(value ?? ''))
	return n
}

/**
 * Seconds from operator text: `75`, `75.5`, `1:15`, `1:15.5`, `1:02:03`.
 * undefined when it is none of these.
 */
function parseTimeText(text) {
	if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? text : undefined
	if (typeof text !== 'string') return undefined
	const t = text.trim()
	if (!t) return undefined
	const parts = t.split(':')
	if (parts.length > 3) return undefined
	let total = 0
	for (let i = 0; i < parts.length; i++) {
		const last = i === parts.length - 1
		const p = parts[i].trim()
		if (last ? !/^(\d+\.?\d*|\.\d+)$/.test(p) : !/^\d+$/.test(p)) return undefined
		const n = Number(p)
		if (i > 0 && n >= 60) return undefined
		total = total * 60 + n
	}
	return total
}

/**
 * `comp1.set:time=SECONDS` — Timeline: the timeline position; Playlist: the
 * time WITHIN the current item (what /status reports as item.time).
 */
function seekTime(compRef, seconds) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	const s = typeof seconds === 'number' ? seconds : parseTimeText(seconds)
	if (s === undefined || !Number.isFinite(s)) return fail(`Time must be seconds or [h:]mm:ss (got "${seconds}")`)
	return { ok: true, line: `${c.ref}.set:time=${wireNumber(Math.max(0, s))}`, value: Math.max(0, s), relative: false }
}

/** `comp1.set:loop=on|off`; a toggle needs the current value (`get:loop`, 0/1). */
function setLoop(compRef, on) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	if (typeof on !== 'boolean') return fail('Loop must be on or off')
	return { ok: true, line: `${c.ref}.set:loop=${on ? 'on' : 'off'}`, relative: false }
}

function getLoop(compRef) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	return { ok: true, line: `${c.ref}.get:loop`, relative: false }
}

/** `get:loop` answers `0`/`1` (generic getter: a bool reads `1`/`0`). Anything else is unknown. */
function parseLoopReply(value) {
	if (value === '1' || value === 'true') return true
	if (value === '0' || value === 'false') return false
	return undefined
}

/* ----------------------------------------- TCP: cue lists / catalog --- */

/** `get:complist` (classic, list reply). */
function compList() {
	return { ok: true, line: 'get:complist', relative: false }
}

/** `comp1.get:type` → `timeline` | `cuelist` | `composition`. */
function compType(compRef) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	return { ok: true, line: `${c.ref}.get:type`, relative: false }
}

/** `comp1.get:cuelist` — rows then END (only on a Timeline or a Playlist). */
function cueList(compRef) {
	const c = checkCompRef(compRef)
	if (!c.ok) return c
	return { ok: true, line: `${c.ref}.get:cuelist`, relative: false }
}

/* ------------------------------------------------- TCP: system verbs --- */

/**
 * VIOSO Spaces: `system.showpage=next|prev|first|last|<n>|<page id>`
 * (engine: project/exaplay-project-System.cpp; the same resolver as the OSC
 * `global/page` verb and `POST /show/page`). The id is case-sensitive and
 * passed verbatim; the keywords are folded by the engine.
 */
function showPage(ref) {
	const r = typeof ref === 'string' ? ref.trim() : typeof ref === 'number' ? String(ref) : ''
	if (!r) return fail('No page given (next, prev, first, last, a number or a page id)')
	const a = checkArgument(r, 'Page')
	if (!a.ok) return a
	return { ok: true, line: `system.showpage=${r}`, relative: /^(next|prev)$/i.test(r) }
}

/**
 * `system.restart` (reload the current project) / `system.restart=clean`
 * (no project). Behind an explicit confirm: a stray press would drop the show.
 */
function restartEngine(mode, confirmed) {
	if (confirmed !== true) return fail('Restart not sent: tick "Yes, restart the engine" in the action first')
	if (mode === 'project') return { ok: true, line: 'system.restart', relative: true }
	if (mode === 'clean') return { ok: true, line: 'system.restart=clean', relative: true }
	return fail(`Restart mode must be project or clean (got "${mode}")`)
}

/* ------------------------------------------------ TCP: Inputs (track) --- */

/** An Inputs channel name for a classic `track,…` line: no comma, no line break. */
function checkChannel(ch) {
	const c = typeof ch === 'string' ? ch.trim() : ''
	if (!c) return fail('No Inputs channel given')
	if (LINE_BREAKERS.test(c)) return fail('Channel contains a line break')
	if (c.includes(',')) return fail(`Channel "${c}" contains a "," — the engine splits the line there`)
	return { ok: true, channel: c }
}

/**
 * Inputs channel samples (tcp-api.md › Inputs):
 *   track,<ch>,<x>[,<y>]   track,<ch>,x,<v>   track,<ch>,y,<v>   track,<ch>,click[,<v>]
 */
function track(channel, form, a, b) {
	const ch = checkChannel(channel)
	if (!ch.ok) return ch
	const num = (v, what) => {
		const n = toNumber(typeof v === 'number' ? v : String(v ?? ''))
		return n === undefined ? fail(`${what} must be a number (got "${v}")`) : { ok: true, n }
	}
	if (form === 'xy') {
		const x = num(a, 'X')
		if (!x.ok) return x
		const ys = b === undefined || b === null ? '' : String(b).trim()
		if (ys === '') return { ok: true, line: `track,${ch.channel},${wireNumber(x.n)}`, relative: false }
		const y = num(ys, 'Y')
		if (!y.ok) return y
		return { ok: true, line: `track,${ch.channel},${wireNumber(x.n)},${wireNumber(y.n)}`, relative: false }
	}
	if (form === 'x' || form === 'y') {
		const v = num(a, form.toUpperCase())
		if (!v.ok) return v
		return { ok: true, line: `track,${ch.channel},${form},${wireNumber(v.n)}`, relative: false }
	}
	if (form === 'click') {
		const s = a === undefined || a === null ? '' : String(a).trim()
		if (s === '') return { ok: true, line: `track,${ch.channel},click`, relative: true }
		const v = num(s, 'Click value')
		if (!v.ok) return v
		return { ok: true, line: `track,${ch.channel},click,${wireNumber(v.n)}`, relative: true }
	}
	return fail(`Unknown Inputs form "${form}"`)
}

/* ------------------------------------------------------ OSC: more ---- */

/** `/<prefix>/global/blankfade <seconds 0–60>` — set the blank fade without blanking. */
function oscBlankFade(prefix, seconds) {
	const f = toNumber(typeof seconds === 'number' ? seconds : String(seconds ?? ''))
	if (f === undefined || f < 0 || f > 60) return fail(`Blank fade must be 0–60 seconds (got "${seconds}")`)
	const address = oscAddress(prefix, 'blankfade')
	if (!address) return fail('OSC prefix must not contain "/"')
	return { ok: true, address, args: [{ type: 'f', value: f }] }
}

/** Characters an OSC address segment must not hold (OSC 1.0 reserves them). */
const OSC_RESERVED = /[\s#*,/?[\]{}\0-\x1f]/

/**
 * `/<prefix>/<timeline>/frame <i>` — Timeline only: jump to that frame,
 * counted at the Timecode frame rate (osc-api.md). The composition goes in
 * the ADDRESS, so a name is written with `_` for a space.
 */
function oscFrame(prefix, compRef, frame) {
	const r = typeof compRef === 'string' ? compRef.trim().replace(/ /g, '_') : ''
	if (!r) return fail('No composition given')
	if (OSC_RESERVED.test(r)) return fail(`"${compRef}" cannot be an OSC address segment — use the composition ID`)
	const n = toNumber(typeof frame === 'number' ? frame : String(frame ?? ''))
	if (n === undefined || n < 0 || !Number.isInteger(n)) return fail(`Frame must be a whole number ≥ 0 (got "${frame}")`)
	const p = String(prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
	if (p.includes('/')) return fail('OSC prefix must not contain "/"')
	const address = p ? `/${p}/${r}/frame` : `/${r}/frame`
	return { ok: true, address, args: [{ type: 'i', value: n }] }
}

/**
 * A free OSC message — to THE ENGINE only (the module never takes a host
 * here). Arguments use the cue-script syntax: `i:<int>`, `f:<float>`,
 * `s:<text>`, comma-separated; a bare number is a float, other bare text a
 * string.
 */
function oscCustom(address, argsText) {
	const a = typeof address === 'string' ? address.trim() : ''
	if (!a.startsWith('/')) return fail('OSC address must start with "/"')
	if (/[\s#,?*[\]{}\0-\x1f]/.test(a)) return fail('OSC address contains a space or a reserved character')
	const args = []
	const text = typeof argsText === 'string' ? argsText.trim() : ''
	if (text) {
		for (const raw of text.split(',')) {
			const t = raw.trim()
			if (!t) continue
			const m = /^([ifs]):(.*)$/s.exec(t)
			if (m) {
				if (m[1] === 's') args.push({ type: 's', value: m[2] })
				else {
					const n = toNumber(m[2])
					if (n === undefined || (m[1] === 'i' && !Number.isInteger(n))) return fail(`"${t}" is not a valid ${m[1] === 'i' ? 'integer' : 'float'}`)
					args.push({ type: m[1], value: n })
				}
			} else {
				const n = toNumber(t)
				args.push(n === undefined ? { type: 's', value: t } : { type: 'f', value: n })
			}
		}
	}
	return { ok: true, address: a, args }
}

/* ------------------------------------------------------ HTTP: more ---- */

/** Read a JSON body; null when absent or malformed. */
function jsonBody(text) {
	try {
		return text ? JSON.parse(text) : null
	} catch {
		return null
	}
}

/**
 * `POST /cmd {"req":"pjlink-all","parameter":"1"|"0"}` — every PJLink
 * projector configured in the project (rest-api.md › Projector control). Over
 * HTTP rather than `system.pjlink-all=` on TCP: the engine powers the
 * projectors one after the other (1.5 s connect timeout each), and on the one
 * TCP connection that would hold every GO behind it.
 */
function httpPjlinkAll(on) {
	if (typeof on !== 'boolean') return fail('Power must be on or off')
	return { ok: true, method: 'POST', path: '/cmd', body: JSON.stringify({ req: 'pjlink-all', parameter: on ? '1' : '0' }) }
}

/** 200 {"response":"OK","message":"OK,3/3"} · 500 {"response":"ERROR","message":"ERR,no_devices"} · 400 no project · 503 loading. */
function parsePjlinkAllResponse(status, bodyText) {
	const body = jsonBody(bodyText)
	const msg = body && typeof body.message === 'string' ? body.message : ''
	if (status === 200 && body && body.response === 'OK') {
		const m = /^OK,(\d+)\/(\d+)$/.exec(msg)
		if (m) {
			const okN = Number(m[1])
			const total = Number(m[2])
			if (okN < total) return { ok: false, error: `only ${okN} of ${total} projectors answered`, okCount: okN, total }
			return { ok: true, okCount: okN, total, message: `${okN}/${total} projectors` }
		}
		return { ok: true, message: msg || 'OK' }
	}
	if (status === 503) return { ok: false, error: 'Engine is loading a project' }
	if (msg === 'ERR,no_devices') return { ok: false, error: 'No PJLink projector is configured (Control → TCP Devices)' }
	if (msg) return { ok: false, error: msg }
	return { ok: false, error: `HTTP ${status}` }
}

/**
 * `GET /data?type=exaObj&path=project&values` — the PROJECT's values, where
 * `control_panel_items` lives. Read only: the module never writes it.
 */
function httpReadProjectValues() {
	return { ok: true, method: 'GET', path: '/data?type=exaObj&path=project&values', body: null }
}

/** `GET /data?type=exaObj&path=global&values` — engine runtime state (`audio-volume`, …). */
function httpReadGlobalValues() {
	return { ok: true, method: 'GET', path: '/data?type=exaObj&path=global&values', body: null }
}

/**
 * The `values` of a GET /data answer, or why there are none. A loading engine
 * answers 200 {"loading":true}; a missing object 404.
 */
function parseDataValues(status, bodyText) {
	if (status === 404) return { ok: false, error: 'not found (no project loaded?)' }
	if (status === 503) return { ok: false, error: 'Engine is loading a project' }
	if (status !== 200) return { ok: false, error: `HTTP ${status}` }
	const body = jsonBody(bodyText)
	if (body && body.loading === true) return { ok: false, error: 'Engine is loading a project' }
	if (!body || typeof body.values !== 'object' || body.values === null || Array.isArray(body.values))
		return { ok: false, error: 'answer without values' }
	return { ok: true, values: body.values }
}

/**
 * The engine master volume, 0–100: `POST /data {"type":"exaObj","path":"global",
 * "values":{"audio-volume":v}}` (rest-api.md › /data; the same write the
 * custom-UI `master` fader makes). This machine's own — it never fans out.
 */
function httpSetMasterVolume(value) {
	const n = toNumber(typeof value === 'number' ? value : String(value ?? ''))
	if (n === undefined) return fail(`Master volume must be a number 0–100 (got "${value}")`)
	const v = clamp(n, 0, 100)
	return {
		ok: true,
		method: 'POST',
		path: '/data',
		body: JSON.stringify({ type: 'exaObj', path: 'global', values: { 'audio-volume': v } }),
		value: v,
	}
}

/** POST /data: 200 (empty body) · 401 value rejected · 404 · 503 loading. */
function parseDataWriteResponse(status) {
	if (status === 200) return { ok: true }
	if (status === 401) return { ok: false, error: 'Engine rejected the value' }
	if (status === 404) return { ok: false, error: 'Object not found' }
	if (status === 503) return { ok: false, error: 'Engine is loading a project' }
	return { ok: false, error: `HTTP ${status}` }
}

/** `audio-volume` from GET /data path=global → number or undefined. */
function readMasterVolume(values) {
	const v = values && values['audio-volume']
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Switch Inputs groups: `POST /tracking {"command":"group:scene2=on"}` — the
 * text of a cue's `TRACKING>` line without the prefix (rest-api.md, inputs.md):
 * `group:<name>=on|off|toggle`, `solo=<name>`, `all=on|off`.
 */
function httpInputsGroups(command) {
	const c = typeof command === 'string' ? command.trim() : ''
	if (!c) return fail('No Inputs group command given')
	if (/[\0-\x1f]/.test(c)) return fail('Command contains control characters')
	if (!/^(group:[^=]+=(on|off|toggle)|solo=.+|all=(on|off))$/i.test(c))
		return fail('Expected group:<name>=on|off|toggle, solo=<name> or all=on|off')
	return { ok: true, method: 'POST', path: '/tracking', body: JSON.stringify({ command: c }) }
}

/** {"ok":true} / {"ok":false,"error"}. */
function parseOkErrorResponse(status, bodyText) {
	const body = jsonBody(bodyText)
	if (status === 503) return { ok: false, error: 'Engine is loading a project' }
	if (status === 200 && body && body.ok === true) return { ok: true }
	if (body && body.ok === false) return { ok: false, error: String(body.error || body.reason || 'refused') }
	if (status === 200) return { ok: true }
	return { ok: false, error: `HTTP ${status}` }
}

/**
 * A free HTTP request to THE ENGINE only (path on the configured host/port;
 * the module never takes a host here). GET or POST, a path starting with `/`,
 * a JSON body or none.
 */
function httpCustom(method, path, body) {
	const m = String(method || '').toUpperCase()
	if (m !== 'GET' && m !== 'POST') return fail('Method must be GET or POST')
	const p = typeof path === 'string' ? path.trim() : ''
	if (!p.startsWith('/') || p.startsWith('//')) return fail('Path must start with a single "/" (the engine is the only host)')
	if (/[\s\0-\x1f]/.test(p)) return fail('Path contains a space or a control character')
	if (p.split(/[/?]/).includes('..')) return fail('Path contains a ".." segment')
	const b = typeof body === 'string' ? body.trim() : ''
	if (m === 'GET' && b) return fail('A GET sends no body')
	if (b) {
		try {
			JSON.parse(b)
		} catch {
			return fail('Body must be JSON (or empty)')
		}
	}
	return { ok: true, method: m, path: p, body: b || null }
}

module.exports = {
	SWITCH_MODES,
	checkCompRef,
	transport,
	toggleTransport,
	cueGo,
	showMode,
	raw,
	expectsList,
	oscAddress,
	oscSwitch,
	tcpSwitch,
	tcpSwitchable,
	tcpBlankFade,
	tcpPlayAll,
	tcpStopAll,
	oscPlayAll,
	httpStopAll,
	httpFireButton,
	parseFireResponse,
	parseStopAllResponse,
	// 1.1
	wireNumber,
	toNumber,
	setLevel,
	getLevel,
	parseNumberReply,
	parseTimeText,
	seekTime,
	setLoop,
	getLoop,
	parseLoopReply,
	compList,
	compType,
	cueList,
	showPage,
	restartEngine,
	checkChannel,
	track,
	oscBlankFade,
	oscFrame,
	oscCustom,
	httpPjlinkAll,
	parsePjlinkAllResponse,
	httpReadProjectValues,
	httpReadGlobalValues,
	parseDataValues,
	httpSetMasterVolume,
	parseDataWriteResponse,
	readMasterVolume,
	httpInputsGroups,
	parseOkErrorResponse,
	httpCustom,
}
