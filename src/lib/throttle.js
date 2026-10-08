'use strict'
/**
 * A THROTTLE for live value writes — never a debounce (CLAUDE.md: "A live
 * edit writes through a THROTTLE, never a debounce, with one request in
 * flight"). Pure; the clock is injectable for tests.
 *
 *  - The first value goes out at once: a dial that starts turning moves the
 *    show on the first detent, not when the hand stops.
 *  - At most ONE write is in flight. Values pushed meanwhile replace each
 *    other; only the LATEST is sent when the write in flight is answered (and
 *    at least `intervalMs` after the previous one started).
 *  - Only absolute values go through it, so dropping the intermediate ones
 *    loses nothing — the last value always reaches the engine.
 */
class LatestThrottle {
	/**
	 * @param {(value:any) => Promise<any>|any} send  performs one write; its result goes to onResult
	 * @param {{ intervalMs?: number, onResult?: Function, now?: () => number, setTimer?: Function, clearTimer?: Function }} [o]
	 */
	constructor(send, { intervalMs = 40, onResult = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
		this.send = send
		this.intervalMs = intervalMs
		this.onResult = onResult
		this.now = now
		this.setTimer = setTimer
		this.clearTimer = clearTimer
		this.pending = undefined
		this.hasPending = false
		this.inflight = false
		this.lastStart = -Infinity
		this.timer = null
		this.waiters = []
	}

	/** Queue the latest value; replaces any value not yet sent. */
	push(value) {
		this.pending = value
		this.hasPending = true
		this._kick()
	}

	/** True while a write is in flight or a value waits. */
	get busy() {
		return this.inflight || this.hasPending
	}

	/** Resolves once nothing is in flight and nothing waits (tests, shutdown). */
	idle() {
		if (!this.busy) return Promise.resolve()
		return new Promise((r) => this.waiters.push(r))
	}

	/** Forget a value that has not been sent yet. */
	cancel() {
		this.hasPending = false
		this.pending = undefined
		if (this.timer) this.clearTimer(this.timer)
		this.timer = null
		this._settle()
	}

	_kick() {
		if (this.inflight || this.timer || !this.hasPending) return
		const wait = this.lastStart + this.intervalMs - this.now()
		if (wait > 0) {
			this.timer = this.setTimer(() => {
				this.timer = null
				this._kick()
			}, wait)
			return
		}
		const value = this.pending
		this.pending = undefined
		this.hasPending = false
		this.inflight = true
		this.lastStart = this.now()
		Promise.resolve()
			.then(() => this.send(value))
			.then(
				(r) => r,
				(e) => ({ ok: false, error: e && e.message ? e.message : String(e) }),
			)
			.then((r) => {
				this.inflight = false
				try {
					this.onResult(r, value)
				} finally {
					this._kick()
					this._settle()
				}
			})
	}

	_settle() {
		if (this.busy) return
		for (const w of this.waiters.splice(0)) w()
	}
}

module.exports = { LatestThrottle }
