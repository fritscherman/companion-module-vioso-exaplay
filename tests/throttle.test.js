'use strict'
/**
 * The live-value throttle: first value at once, one write in flight, the
 * LATEST value wins, never a debounce (a dial that keeps turning still moves
 * the show).
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { LatestThrottle } = require('../src/lib/throttle')

/** A write the test answers by hand. */
function manualSend() {
	const sent = []
	const pending = []
	const send = (v) =>
		new Promise((resolve) => {
			sent.push(v)
			pending.push(resolve)
		})
	const answer = async (r = { ok: true }) => {
		pending.shift()(r)
		await new Promise((r2) => setImmediate(r2))
	}
	return { sent, send, answer, get inflight() { return pending.length } }
}

const tick = () => new Promise((r) => setImmediate(r))

test('the first value goes out at once; later ones coalesce to the latest while one is in flight', async () => {
	const m = manualSend()
	const t = new LatestThrottle(m.send, { intervalMs: 0 })
	t.push(10)
	await tick()
	assert.deepEqual(m.sent, [10], 'no waiting for the hand to stop (not a debounce)')
	t.push(11)
	t.push(12)
	t.push(13)
	await tick()
	assert.deepEqual(m.sent, [10], 'one in flight')
	assert.equal(m.inflight, 1)
	await m.answer()
	assert.deepEqual(m.sent, [10, 13], 'only the latest follows')
	await m.answer()
	await t.idle()
	assert.deepEqual(m.sent, [10, 13])
	assert.equal(t.busy, false)
})

test('a steady stream keeps sending (throttle, not debounce) and spaces writes by the interval', async () => {
	let now = 0
	const timers = []
	const sent = []
	const t = new LatestThrottle(async (v) => sent.push(v) && { ok: true }, {
		intervalMs: 40,
		now: () => now,
		setTimer: (fn, ms) => {
			const h = { fn, at: now + ms }
			timers.push(h)
			return h
		},
		clearTimer: (h) => timers.splice(timers.indexOf(h), 1),
	})
	const advance = async (ms) => {
		now += ms
		const due = timers.filter((x) => x.at <= now)
		for (const h of due) timers.splice(timers.indexOf(h), 1)
		for (const h of due) h.fn()
		await tick()
		await tick()
	}
	for (let i = 1; i <= 10; i++) {
		t.push(i)
		await advance(10)
	}
	await advance(100)
	// every ~40 ms one write: 1 at once, then the latest value each interval, and the final value last
	assert.equal(sent[0], 1)
	assert.equal(sent[sent.length - 1], 10)
	assert.ok(sent.length >= 3 && sent.length <= 5, `sent ${sent.join(',')}`)
	for (let i = 1; i < sent.length; i++) assert.ok(sent[i] > sent[i - 1], 'never an older value after a newer one')
})

test('a failed or throwing write is reported and does not stop later values', async () => {
	const results = []
	let n = 0
	const t = new LatestThrottle(
		async (v) => {
			n++
			if (v === 1) throw new Error('socket gone')
			if (v === 2) return { ok: false, error: 'ERR,command_failed' }
			return { ok: true }
		},
		{ intervalMs: 0, onResult: (r, v) => results.push([v, r.ok, r.error]) },
	)
	t.push(1)
	await t.idle()
	t.push(2)
	await t.idle()
	t.push(3)
	await t.idle()
	assert.equal(n, 3)
	assert.deepEqual(results, [
		[1, false, 'socket gone'],
		[2, false, 'ERR,command_failed'],
		[3, true, undefined],
	])
})

test('cancel drops a value not yet sent', async () => {
	const m = manualSend()
	const t = new LatestThrottle(m.send, { intervalMs: 0 })
	t.push(1)
	await tick()
	t.push(2)
	t.cancel()
	await m.answer()
	await t.idle()
	assert.deepEqual(m.sent, [1])
})
