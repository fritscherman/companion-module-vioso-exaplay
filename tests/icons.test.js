'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const { face, GLYPHS, crc32, mix, rgb, EXA } = require('../src/lib/icons')
const { getPresetDefinitions } = require('../src/presets')
const { emptyState } = require('../src/lib/status')

/** Decode our own PNG: chunks with valid CRCs, IHDR 72×72 RGBA, pixel rows. */
function decode(b64) {
	const buf = Buffer.from(b64, 'base64')
	assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
	let off = 8
	const chunks = {}
	while (off < buf.length) {
		const len = buf.readUInt32BE(off)
		const type = buf.toString('ascii', off + 4, off + 8)
		const data = buf.subarray(off + 8, off + 8 + len)
		assert.equal(buf.readUInt32BE(off + 8 + len), crc32(buf.subarray(off + 4, off + 8 + len)), `${type} CRC`)
		chunks[type] = Buffer.concat([chunks[type] || Buffer.alloc(0), data])
		off += 12 + len
	}
	const w = chunks.IHDR.readUInt32BE(0)
	const h = chunks.IHDR.readUInt32BE(4)
	assert.deepEqual([w, h, chunks.IHDR[8], chunks.IHDR[9]], [72, 72, 8, 6])
	assert.ok('IEND' in chunks)
	const raw = zlib.inflateSync(chunks.IDAT)
	assert.equal(raw.length, (w * 4 + 1) * h)
	return { w, h, raw }
}
const alphaAt = ({ w, raw }, x, y) => raw[y * (w * 4 + 1) + 1 + x * 4 + 3]

test('crc32 matches the PNG reference value', () => {
	assert.equal(crc32(Buffer.from('IEND', 'ascii')), 0xae426082)
})

test('every glyph is a valid 72×72 PNG with something drawn', () => {
	for (const g of Object.keys(GLYPHS)) {
		const img = decode(face(g, { frame: null }))
		let drawn = 0
		for (let y = 0; y < 72; y++) for (let x = 0; x < 72; x++) if (alphaAt(img, x, y) > 0) drawn++
		assert.ok(drawn > 40, `${g} draws pixels (${drawn})`)
	}
})

test('the face is transparent outside frame and glyph, so the key colour shows', () => {
	const img = decode(face('play'))
	assert.equal(alphaAt(img, 0, 0), 0, 'corner outside the frame')
	assert.equal(alphaAt(img, 10, 60), 0, 'inside the frame, away from the glyph')
	assert.ok(alphaAt(img, 36, 3) > 100, 'the frame line')
	assert.ok(alphaAt(img, 32, 23) > 200, 'the play triangle')
	assert.equal(alphaAt(decode(face('play', { frame: null })), 36, 3), 0, 'no frame when asked')
})

test('faces are cached and differ by colour', () => {
	assert.equal(face('stop', { color: EXA.error }), face('stop', { color: EXA.error }))
	assert.notEqual(face('stop', { color: EXA.error }), face('stop'))
})

test('palette helpers', () => {
	assert.equal(mix('#000000', '#ffffff', 0.5), '#808080')
	assert.equal(rgb('#5db4ff'), 0x5db4ff)
})

test('every preset key and every feedback style that sets a face carries a valid PNG', () => {
	const self = {
		label: 'exa',
		status: { ...emptyState(), known: true, compositions: [{ id: 'comp1', name: 'Main', type: 'timeline' }] },
		catalog: { state: { known: true, comps: [{ id: 'comp1', name: 'Main', type: 'timeline', cues: [{ index: 1, name: 'A' }] }], buttons: [{ id: 'b1', label: 'Go' }] } },
	}
	const seen = new Set()
	for (const [id, p] of Object.entries(getPresetDefinitions(self))) {
		assert.ok(p.style.png64, `${id} has a face`)
		seen.add(p.style.png64)
		for (const f of p.feedbacks) if (f.style && f.style.png64) seen.add(f.style.png64)
	}
	for (const b64 of seen) decode(b64)
	assert.ok(seen.size > 20)
})
