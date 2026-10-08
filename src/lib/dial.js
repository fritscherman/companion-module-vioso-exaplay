'use strict'
/**
 * One value an operator sets or NUDGES (a Stream Deck+ dial, a +/- key):
 * composition volume / opacity, the master volume, a seek, an Inputs channel.
 * Pure; reads and writes are injected, the clock too.
 *
 * Rules:
 *  - Writes go through ONE LatestThrottle: absolute values only, one in
 *    flight, the latest wins (./throttle.js).
 *  - A nudge needs a KNOWN base. Unknown is never evidence: with no known
 *    value the dial READS the engine first and applies the turns made while
 *    it waited; if the read fails, those turns are dropped and reported —
 *    never applied to a guessed 0.
 *  - The base is the module's own value while the operator is working the
 *    dial (`staleMs` since the value was last read or sent): it is what was
 *    last SENT, and a readback in that window would lag the hand. After the
 *    pause the next nudge reads again, so a change made in Exaplay's UI
 *    meanwhile is picked up rather than overwritten from an old base.
 *  - A failed write makes the value unknown again (the engine may or may not
 *    have it), so the next nudge re-reads.
 */
const { LatestThrottle } = require('./throttle')

class ValueDial {
	/**
	 * @param {object} o
	 * @param {() => Promise<{ok:boolean, value?:number, error?:string}>} o.read
	 * @param {(v:number) => Promise<{ok:boolean, error?:string}>} o.write
	 * @param {number} [o.min] @param {number} [o.max]
	 * @param {number} [o.staleMs]  how long the module's own value stays the base without a re-read
	 * @param {number} [o.intervalMs] throttle spacing
	 * @param {(v:number|undefined) => void} [o.onChange]
	 * @param {(msg:string) => void} [o.onError]
	 */
	constructor({
		read,
		write,
		min = 0,
		max = 100,
		staleMs = 2000,
		intervalMs = 40,
		onChange = () => {},
		onError = () => {},
		now = Date.now,
		setTimer,
		clearTimer,
	} = {}) {
		this.read = read
		this.min = min
		this.max = max
		this.staleMs = staleMs
		this.onChange = onChange
		this.onError = onError
		this.now = now
		this.value = undefined
		/** when `value` was last read from, or sent to, the engine */
		this.baseAt = -Infinity
		this.pendingDelta = 0
		this.reading = null
		this.generation = 0
		this.throttle = new LatestThrottle(write, {
			intervalMs,
			now,
			setTimer,
			clearTimer,
			onResult: (r, v) => {
				if (r && r.ok) return
				// The engine may or may not hold v — the next nudge must re-read.
				this._setValue(undefined)
				this.onError(`could not set ${fmt(v)}: ${(r && r.error) || 'no answer'}`)
			},
		})
	}

	setRange(min, max) {
		if (Number.isFinite(min)) this.min = min
		if (Number.isFinite(max)) this.max = max
	}

	clamp(v) {
		return Math.min(this.max, Math.max(this.min, v))
	}

	/** The module's value may serve as the base for a nudge without a re-read. */
	get fresh() {
		return this.value !== undefined && this.now() - this.baseAt < this.staleMs
	}

	_setValue(v) {
		if (v === this.value) return
		this.value = v
		this.onChange(v)
	}

	_send(v) {
		const c = this.clamp(v)
		this.baseAt = this.now()
		this._setValue(c)
		this.throttle.push(c)
		return c
	}

	/** An absolute value (a key that sets 80 %, a learned value). */
	set(v) {
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			this.onError(`not a number: ${v}`)
			return
		}
		this.generation++ // an absolute set wins over turns still waiting for a read
		this.pendingDelta = 0
		this._send(v)
	}

	/** A relative step (a dial detent, a +/- key). */
	nudge(delta) {
		if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) return
		if (!this.reading && this.fresh) {
			this._send(this.value + delta)
			return
		}
		this.pendingDelta += delta
		this._readThenApply()
	}

	/** A value read elsewhere (a refresh). Ignored while the operator works the dial or a write waits. */
	observe(v) {
		if (typeof v !== 'number' || !Number.isFinite(v)) return
		if (this.throttle.busy || this.reading || this.fresh) return
		this.baseAt = this.now()
		this._setValue(v)
	}

	/** Forget the value (project changed, link lost): the next nudge reads. */
	invalidate() {
		this.baseAt = -Infinity
		this._setValue(undefined)
	}

	_readThenApply() {
		if (this.reading) return this.reading
		const gen = this.generation
		this.reading = (async () => {
			let r
			try {
				r = await this.read()
			} catch (e) {
				r = { ok: false, error: e && e.message ? e.message : String(e) }
			}
			this.reading = null
			const delta = this.pendingDelta
			this.pendingDelta = 0
			if (gen !== this.generation) return // an absolute set came in meanwhile
			if (!r || !r.ok || typeof r.value !== 'number' || !Number.isFinite(r.value)) {
				this._setValue(undefined)
				this.onError(`current value unknown (${(r && r.error) || 'no answer'}) — turn not applied`)
				return
			}
			if (delta !== 0) this._send(r.value + delta)
			else {
				this.baseAt = this.now()
				this._setValue(r.value)
			}
		})()
		return this.reading
	}

	/** Resolves when no read and no write is outstanding. */
	async idle() {
		while (this.reading || this.throttle.busy) {
			if (this.reading) await this.reading
			await this.throttle.idle()
		}
	}
}

function fmt(v) {
	return typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v)
}

module.exports = { ValueDial }
