'use strict'
/**
 * ONE persistent TCP connection to the engine's command port (default 8100).
 * No Companion dependency — the module wires its events to Companion.
 *
 * Rules this client keeps (docs/references/tcp-api.md):
 *  - One command per line, CRLF. Replies carry no request id, so exactly one
 *    command is in flight at a time and replies are matched by order.
 *  - A list command (`get:complist`, `get:cuelist`) reads rows until `END`.
 *  - While a project loads the engine DROPS commands without a reply. A
 *    command that gets no reply within the timeout is reported as failed and
 *    is NEVER resent: "no reply" does not prove the engine did not act, and a
 *    repeated next/prev/toggle would move twice. Because a late reply could
 *    then be read as the answer to the NEXT command, the client re-syncs
 *    first: it sends `hello` and discards everything up to `hallo`.
 *  - A command sent while the link is down fails at once — it is not queued
 *    for later, because a GO that fires half a minute late is worse than one
 *    that visibly failed.
 *  - Idle links are probed with `hello` (keepalive); a probe that is not
 *    answered drops the connection and reconnects with backoff.
 *  - Background reads (`send(line, {background:true})`: cue lists, levels)
 *    are served only when no operator command waits.
 */
const { EventEmitter } = require('node:events')
const net = require('node:net')
const { LineSplitter, parseReply } = require('./reply')
const { expectsList } = require('./commands')
const { backoffDelay } = require('./backoff')

class TcpClient extends EventEmitter {
	constructor({
		host,
		port = 8100,
		replyTimeoutMs = 3000,
		connectTimeoutMs = 5000,
		keepAliveMs = 15000,
		backoff = {},
		netImpl = net,
	} = {}) {
		super()
		this.host = host
		this.port = port
		this.replyTimeoutMs = replyTimeoutMs
		this.connectTimeoutMs = connectTimeoutMs
		this.keepAliveMs = keepAliveMs
		this.backoff = backoff
		this.net = netImpl

		this.state = 'disconnected'
		this.socket = null
		this.splitter = new LineSplitter()
		this.queue = []
		this.bgQueue = []
		this.inflight = null
		this.needSync = false
		this.attempt = 0
		this.running = false
		this.reconnectTimer = null
		this.keepAliveTimer = null
		this.connectTimer = null
	}

	start() {
		if (this.running) return
		this.running = true
		this._connect()
	}

	stop() {
		this.running = false
		clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
		this._teardown('stopped')
		this._setState('disconnected')
	}

	/**
	 * Send one line. Resolves (never rejects) with
	 *   { ok: true, reply, value? }          single-line success / value
	 *   { ok: true, rows }                   list reply (rows before END)
	 *   { ok: false, error, reply? }         ERR,<reason>, timeout, or link down
	 */
	send(line, { background = false } = {}) {
		return new Promise((resolve) => {
			if (this.state !== 'connected') {
				resolve({ ok: false, error: 'not connected to the engine' })
				return
			}
			const entry = { line, list: expectsList(line), resolve, timer: null }
			// Background reads (cue lists, levels) wait behind every operator
			// command: a refresh of a large project must never delay a GO.
			if (background) this.bgQueue.push(entry)
			else this.queue.push(entry)
			this._pump()
		})
	}

	/** Commands waiting (operator + background), not counting the one in flight. */
	get waiting() {
		return this.queue.length + this.bgQueue.length
	}

	/* ------------------------------------------------------------------ */

	_setState(s) {
		if (this.state === s) return
		this.state = s
		this.emit('state', s)
	}

	_log(level, msg) {
		this.emit('log', level, msg)
	}

	_connect() {
		if (!this.running) return
		this._setState('connecting')
		this.splitter.reset()
		this.needSync = false
		const sock = this.net.connect({ host: this.host, port: this.port })
		this.socket = sock
		sock.setNoDelay?.(true)
		this.connectTimer = setTimeout(() => {
			this._log('warn', `TCP connect to ${this.host}:${this.port} timed out`)
			sock.destroy()
		}, this.connectTimeoutMs)

		sock.on('connect', () => {
			clearTimeout(this.connectTimer)
			if (this.socket !== sock) return
			this.attempt = 0
			sock.setKeepAlive?.(true, 5000)
			this._log('info', `TCP connected to ${this.host}:${this.port}`)
			this._setState('connected')
			this._armKeepAlive()
			this._pump()
		})
		sock.on('data', (chunk) => {
			if (this.socket !== sock) return
			this._armKeepAlive()
			for (const l of this.splitter.push(chunk)) this._onLine(l)
		})
		sock.on('error', (err) => {
			if (this.socket !== sock) return
			this._log('debug', `TCP error: ${err.message}`)
		})
		sock.on('close', () => {
			clearTimeout(this.connectTimer)
			if (this.socket !== sock) return
			this._teardown('connection closed')
			this._setState('disconnected')
			this._scheduleReconnect()
		})
	}

	_scheduleReconnect() {
		if (!this.running) return
		clearTimeout(this.reconnectTimer)
		const delay = backoffDelay(this.attempt++, this.backoff)
		this._log('debug', `TCP reconnect in ${delay} ms`)
		this.reconnectTimer = setTimeout(() => this._connect(), delay)
	}

	/** Fail everything outstanding and forget the socket. */
	_teardown(reason) {
		clearTimeout(this.keepAliveTimer)
		clearTimeout(this.connectTimer)
		const sock = this.socket
		this.socket = null
		if (sock) sock.destroy()
		if (this.inflight) {
			clearTimeout(this.inflight.timer)
			if (this.inflight.resolve) this.inflight.resolve({ ok: false, error: `link lost before a reply (${reason}) — not resent` })
			this.inflight = null
		}
		for (const e of [...this.queue.splice(0), ...this.bgQueue.splice(0)]) e.resolve({ ok: false, error: `link lost (${reason})` })
	}

	_armKeepAlive() {
		clearTimeout(this.keepAliveTimer)
		if (!this.keepAliveMs) return
		this.keepAliveTimer = setTimeout(() => {
			if (this.state !== 'connected') return
			if (!this.inflight && this.waiting === 0) {
				this.needSync = true // a hello probe
				this._pump()
			} else this._armKeepAlive()
		}, this.keepAliveMs)
	}

	_write(line) {
		this._armKeepAlive()
		this.socket.write(line + '\r\n')
	}

	_pump() {
		if (this.inflight || this.state !== 'connected' || !this.socket) return
		if (this.needSync) {
			const sync = { sync: true, timer: null }
			this.inflight = sync
			sync.timer = setTimeout(() => {
				if (this.inflight !== sync) return
				this._log('warn', 'engine did not answer "hello" — reconnecting')
				this._teardown('no answer to hello')
				this._setState('disconnected')
				this._scheduleReconnect()
			}, this.replyTimeoutMs)
			this._write('hello')
			return
		}
		const entry = this.queue.shift() || this.bgQueue.shift()
		if (!entry) return
		entry.rows = []
		this.inflight = entry
		entry.timer = setTimeout(() => {
			if (this.inflight !== entry) return
			this.inflight = null
			this.needSync = true
			entry.resolve({
				ok: false,
				error: `no reply to "${entry.line}" within ${this.replyTimeoutMs} ms (project loading?) — not resent`,
			})
			this._pump()
		}, this.replyTimeoutMs)
		this._write(entry.line)
	}

	_onLine(line) {
		const cur = this.inflight
		if (!cur) {
			this._log('debug', `unsolicited TCP line ignored: ${line}`)
			return
		}
		if (cur.sync) {
			if (line === 'hallo') {
				clearTimeout(cur.timer)
				this.inflight = null
				this.needSync = false
				this._pump()
			}
			// anything else is a late reply to a command that already timed out
			return
		}
		if (cur.list) {
			if (line === 'END') return this._finish(cur, { ok: true, rows: cur.rows })
			if (cur.rows.length === 0 && line.startsWith('ERR,'))
				return this._finish(cur, { ok: false, error: line, reply: line })
			cur.rows.push(line)
			return
		}
		const r = parseReply(line)
		if (r.kind === 'error') this._finish(cur, { ok: false, error: line, reply: line })
		else this._finish(cur, { ok: true, reply: line, value: r.value })
	}

	_finish(entry, result) {
		clearTimeout(entry.timer)
		this.inflight = null
		entry.resolve(result)
		this._pump()
	}
}

module.exports = { TcpClient }
