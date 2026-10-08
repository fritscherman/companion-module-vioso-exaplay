'use strict'
/**
 * A nudged value (Stream Deck+ dial): the base must be KNOWN, turns made
 * while it is read are kept, a failed read applies nothing, a failed write
 * makes the value unknown again.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { ValueDial } = require('../src/lib/dial')

function rig({ readValue = 50, readOk = true, writeOk = true, staleMs = 2000, min = 0, max = 100 } = {}) {
	let now = 1000
	const log = { reads: 0, writes: [], errors: [], changes: [] }
	let releaseRead = null
	let holdReads = false
	const d = new ValueDial({
		min,
		max,
		staleMs,
		intervalMs: 0,
		now: () => now,
		read: async () => {
			log.reads++
			if (holdReads) await new Promise((r) => (releaseRead = r))
			return readOk ? { ok: true, value: readValue } : { ok: false, error: 'no reply' }
		},
		write: async (v) => {
			log.writes.push(v)
			return writeOk ? { ok: true } : { ok: false, error: 'ERR,command_failed' }
		},
		onError: (m) => log.errors.push(m),
		onChange: (v) => log.changes.push(v),
	})
	return {
		d,
		log,
		advance: (ms) => (now += ms),
		hold: () => (holdReads = true),
		release: () => {
			holdReads = false
			releaseRead && releaseRead()
		},
		set readOk(v) {
			readOk = v
		},
		set writeOk(v) {
			writeOk = v
		},
		set readValue(v) {
			readValue = v
		},
	}
}

test('a nudge with no known value reads first; turns made meanwhile are added', async () => {
	const r = rig({ readValue: 50 })
	r.hold()
	r.d.nudge(2)
	r.d.nudge(2)
	r.d.nudge(1)
	assert.equal(r.log.reads, 1, 'one read for the whole burst')
	assert.deepEqual(r.log.writes, [])
	r.release()
	await r.d.idle()
	assert.deepEqual(r.log.writes, [55])
	assert.equal(r.d.value, 55)
})

test('while the dial turns, the module\'s own value is the base (no read per detent)', async () => {
	const r = rig({ readValue: 50 })
	r.d.nudge(1)
	await r.d.idle()
	for (let i = 0; i < 5; i++) {
		r.advance(100)
		r.d.nudge(1)
		await r.d.idle()
	}
	assert.equal(r.log.reads, 1)
	assert.deepEqual(r.log.writes, [51, 52, 53, 54, 55, 56])
})

test('after a pause the next nudge re-reads (a change made in Exaplay is not overwritten)', async () => {
	const r = rig({ readValue: 50 })
	r.d.nudge(5)
	await r.d.idle()
	r.advance(5000)
	r.readValue = 20 // the operator moved it in the editor meanwhile
	r.d.nudge(5)
	await r.d.idle()
	assert.equal(r.log.reads, 2)
	assert.deepEqual(r.log.writes, [55, 25])
})

test('unknown is never evidence: a failed read applies no turn at all', async () => {
	const r = rig({ readOk: false })
	r.d.nudge(10)
	await r.d.idle()
	assert.deepEqual(r.log.writes, [])
	assert.equal(r.d.value, undefined)
	assert.match(r.log.errors[0], /unknown.*not applied/)
})

test('a failed write makes the value unknown, so the next nudge reads again', async () => {
	const r = rig({ readValue: 50 })
	r.d.nudge(1)
	await r.d.idle()
	r.writeOk = false
	r.d.nudge(1)
	await r.d.idle()
	assert.equal(r.d.value, undefined)
	assert.match(r.log.errors[0], /could not set 52/)
	r.writeOk = true
	r.readValue = 51
	r.d.nudge(1)
	await r.d.idle()
	assert.equal(r.log.reads, 2)
	assert.deepEqual(r.log.writes, [51, 52, 52])
})

test('clamped to the range; an absolute set needs no read and wins over a pending read', async () => {
	const r = rig({ readValue: 99 })
	r.d.nudge(5)
	await r.d.idle()
	assert.deepEqual(r.log.writes, [100])
	r.d.set(-20)
	await r.d.idle()
	assert.deepEqual(r.log.writes, [100, 0])

	const s = rig({ readValue: 50 })
	s.hold()
	s.d.nudge(3)
	s.d.set(80)
	s.release()
	await s.d.idle()
	assert.deepEqual(s.log.writes, [80], 'the turn based on the old read is dropped')
	assert.equal(s.d.value, 80)
	s.d.set('loud')
	assert.match(s.log.errors[0], /not a number/)
})

test('observe() seeds the value only while nobody works the dial', async () => {
	const r = rig({ readValue: 50 })
	r.d.observe(70)
	assert.equal(r.d.value, 70)
	r.d.nudge(1)
	await r.d.idle()
	assert.deepEqual(r.log.writes, [71], 'a fresh observed value is a valid base')
	r.d.observe(10)
	assert.equal(r.d.value, 71, 'ignored while the operator is turning')
	r.advance(5000)
	r.d.observe(10)
	assert.equal(r.d.value, 10)
	r.d.invalidate()
	assert.equal(r.d.value, undefined)
})
