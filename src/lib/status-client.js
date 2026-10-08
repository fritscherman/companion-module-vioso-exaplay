'use strict'
/**
 * The engine's push status feed: `ws://<host>:<http-port>/status` (v1).
 * No Companion dependency.
 *
 *  - On open, asks for the configured rate with `{"rate":N}` (1..20 Hz).
 *  - Every text frame is parsed by ./status.parseMessage and emitted.
 *  - The engine sends a heartbeat after 5 s without change; 15 s of SILENCE
 *    means the link is dead even if TCP has not noticed — terminate and
 *    reconnect with backoff.
 *  - When the socket goes, the module must treat every value as UNKNOWN
 *    (event 'lost'), never keep showing the last snapshot as if it were live.
 */
const { EventEmitter } = require('node:events')
const { parseMessage } = require('./status')
const { backoffDelay } = require('./backoff')

function clampRate(r) {
	const n = Math.round(Number(r))
	if (!Number.isFinite(n)) return 5
	return Math.min(20, Math.max(1, n))
}

class StatusClient extends EventEmitter {
	constructor({ url, rate = 5, silenceMs = 15000, connectTimeoutMs = 5000, backoff = {}, WebSocketImpl } = {}) {
		super()
		this.url = url
		this.rate = clampRate(rate)
		this.silenceMs = silenceMs
		this.connectTimeoutMs = connectTimeoutMs
		this.backoff = backoff
		this.WS = WebSocketImpl || require('ws')
		this.state = 'disconnected'
		this.ws = null
		this.running = false
		this.attempt = 0
		this.reconnectTimer = null
		this.silenceTimer = null
		this.lastFailure = ''
	}

	start() {
		if (this.running) return
		this.running = true
		this._connect()
	}

	stop() {
		this.running = false
		clearTimeout(this.reconnectTimer)
		this._drop()
		this._setState('disconnected')
	}

	setRate(rate) {
		this.rate = clampRate(rate)
		if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ rate: this.rate }))
	}

	_setState(s) {
		if (this.state === s) return
		const was = this.state
		this.state = s
		this.emit('state', s)
		if (was === 'connected' && s !== 'connected') this.emit('lost')
	}

	_log(level, msg) {
		this.emit('log', level, msg)
	}

	_armSilence() {
		clearTimeout(this.silenceTimer)
		this.silenceTimer = setTimeout(() => {
			this._log('warn', `status feed silent for ${this.silenceMs / 1000} s — reconnecting`)
			const ws = this.ws
			if (ws) ws.terminate ? ws.terminate() : ws.close()
		}, this.silenceMs)
	}

	_drop() {
		clearTimeout(this.silenceTimer)
		const ws = this.ws
		this.ws = null
		if (ws) {
			ws.removeAllListeners?.()
			ws.on?.('error', () => {}) // a late error on a dropped socket must not crash the process
			try {
				ws.terminate ? ws.terminate() : ws.close()
			} catch {
				/* already closed */
			}
		}
	}

	_connect() {
		if (!this.running) return
		this._setState('connecting')
		let ws
		try {
			ws = new this.WS(this.url, { handshakeTimeout: this.connectTimeoutMs })
		} catch (e) {
			this._fail(`cannot open ${this.url}: ${e.message}`)
			return
		}
		this.ws = ws
		ws.on('open', () => {
			if (this.ws !== ws) return
			this.attempt = 0
			this.lastFailure = ''
			this._log('info', `status feed connected (${this.url})`)
			ws.send(JSON.stringify({ rate: this.rate }))
			this._setState('connected')
			this._armSilence()
		})
		ws.on('message', (data, isBinary) => {
			if (this.ws !== ws) return
			this._armSilence()
			if (isBinary) return
			const parsed = parseMessage(data.toString())
			if (parsed.kind === 'ignored') this._log('debug', `status frame ignored: ${parsed.reason}`)
			else this.emit('message', parsed)
		})
		ws.on('unexpected-response', (_req, res) => {
			if (this.ws !== ws) return
			// e.g. 404 from an engine that predates /status
			this._fail(`status feed refused: HTTP ${res.statusCode} (engine without /status?)`)
		})
		ws.on('error', (err) => {
			if (this.ws !== ws) return
			this._fail(`status feed error: ${err.message}`)
		})
		ws.on('close', () => {
			if (this.ws !== ws) return
			this._fail('status feed closed')
		})
	}

	_fail(reason) {
		this._drop()
		// Log a failure once, not on every backoff round.
		if (reason !== this.lastFailure) this._log('warn', reason)
		this.lastFailure = reason
		this._setState('disconnected')
		if (!this.running) return
		clearTimeout(this.reconnectTimer)
		const delay = backoffDelay(this.attempt++, this.backoff)
		this.reconnectTimer = setTimeout(() => this._connect(), delay)
	}
}

module.exports = { StatusClient, clampRate }
