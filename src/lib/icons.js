'use strict'
/**
 * Key faces in the Exaplay look: the outlined-square transport buttons of
 * Produce & Play (assets/ui-tokens.css, "Transport"), drawn as 72×72 PNGs.
 *
 * Nothing here is an image asset: every glyph is a handful of primitives
 * (polygons, strokes, rings) rasterised with 4×4 supersampling and encoded
 * with Node's own zlib — no dependency, no licence, and the same picture on
 * every Companion. A face is built once per (glyph, tone) and cached.
 *
 * A face is transparent except for its frame and glyph, so the key's
 * bgcolor shows through: the idle key is the Exaplay page tone, a feedback
 * swaps BOTH the bgcolor (a dark tint of the state's colour) and the face
 * (frame and glyph in that colour) — the way an active Produce & Play
 * button lights its outline, not only its fill.
 */
const zlib = require('zlib')

/** The Exaplay palette (exaplay_frontend/src/assets/ui-tokens.css). */
const EXA = {
	page: '#171e26',
	card: '#1c2530',
	raised: '#212d3a',
	line: '#2b3d4f',
	lineStrong: '#3f5d7a',
	text: '#f0f6fc',
	muted: '#a8bccf',
	accent: '#5db4ff',
	ok: '#4cce7a',
	warn: '#f5b041',
	error: '#f76965',
	errorFill: '#c8332f',
	purple: '#b48cff',
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
/** a → b by t (0..1), as '#rrggbb'. */
function mix(a, b, t) {
	const A = hex(a)
	const B = hex(b)
	return '#' + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, '0')).join('')
}
/** '#rrggbb' → Companion's 0xRRGGBB number. */
const rgb = (h) => {
	const [r, g, b] = hex(h)
	return (r << 16) | (g << 8) | b
}

/* ------------------------------------------------------------- PNG --- */

const CRC = (() => {
	const t = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[n] = c >>> 0
	}
	return t
})()
function crc32(buf) {
	let c = 0xffffffff
	for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length)
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(td))
	return Buffer.concat([len, td, crc])
}
/** RGBA pixels → PNG bytes. */
function encodePng(w, h, rgba) {
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(w, 0)
	ihdr.writeUInt32BE(h, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA
	const raw = Buffer.alloc((w * 4 + 1) * h)
	for (let y = 0; y < h; y++) {
		raw[y * (w * 4 + 1)] = 0 // filter: none
		rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	])
}

/* ------------------------------------------------------- primitives --- */
// Glyph coordinates are in a 24×24 box (like an icon font), placed in the
// upper part of the key so the caption fits underneath.

function inPolygon(x, y, pts) {
	let inside = false
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i]
		const [xj, yj] = pts[j]
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
	}
	return inside
}
function segDist(x, y, [ax, ay], [bx, by]) {
	const dx = bx - ax
	const dy = by - ay
	const l2 = dx * dx + dy * dy
	const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
	return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}
const poly = (...pts) => (x, y) => inPolygon(x, y, pts)
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1
const line = (a, b, w = 2) => (x, y) => segDist(x, y, a, b) <= w / 2
/** A polyline (open), stroked. */
const path = (w, ...pts) => (x, y) => pts.some((p, i) => i > 0 && segDist(x, y, pts[i - 1], p) <= w / 2)
const disc = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) <= r
const ring = (cx, cy, r, w = 2) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) <= w / 2
/** A ring with a gap: only the part whose angle (0 = right, clockwise) is in [from, to] degrees. */
const arc = (cx, cy, r, from, to, w = 2) => (x, y) => {
	if (Math.abs(Math.hypot(x - cx, y - cy) - r) > w / 2) return false
	let a = (Math.atan2(y - cy, x - cx) * 180) / Math.PI
	if (a < 0) a += 360
	return from <= to ? a >= from && a <= to : a >= from || a <= to
}
const strokeRect = (x0, y0, x1, y1, w = 2) => path(w, [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0])
const not = (f) => (x, y) => !f(x, y)
const and = (...fs) => (x, y) => fs.every((f) => f(x, y))

const GLYPHS = {
	play: [poly([7, 4], [20, 12], [7, 20])],
	pause: [rect(6, 4, 10, 20), rect(14, 4, 18, 20)],
	stop: [rect(5, 5, 19, 19)],
	toggle: [poly([2, 5], [11, 12], [2, 19]), rect(14, 5, 17, 19), rect(19.5, 5, 22.5, 19)],
	prev: [rect(4, 5, 7, 19), poly([20, 5], [8, 12], [20, 19])],
	next: [rect(17, 5, 20, 19), poly([4, 5], [16, 12], [4, 19])],
	rewind: [poly([12, 5], [2, 12], [12, 19]), poly([22, 5], [12, 12], [22, 19])],
	forward: [poly([2, 5], [12, 12], [2, 19]), poly([12, 5], [22, 12], [12, 19])],
	restart: [rect(3, 5, 6, 19), poly([14, 5], [7, 12], [14, 19]), poly([22, 5], [15, 12], [22, 19])],
	// a screen with a slash: the wall goes dark
	blank: [strokeRect(2, 4, 22, 17), line([8, 21], [16, 21]), line([12, 17], [12, 21]), line([4, 2], [20, 19], 2.2)],
	// a speaker with a cross
	mute: [poly([3, 9], [7, 9], [12, 4], [12, 20], [7, 15], [3, 15]), line([15, 9], [21, 15]), line([21, 9], [15, 15])],
	speaker: [poly([3, 9], [7, 9], [12, 4], [12, 20], [7, 15], [3, 15]), arc(12, 12, 5, 300, 60), arc(12, 12, 9, 305, 55)],
	// "on air": a dot in a ring
	showmode: [disc(12, 12, 4.5), ring(12, 12, 9, 2)],
	identify: [ring(12, 12, 7, 2), line([12, 1], [12, 7]), line([12, 17], [12, 23]), line([1, 12], [7, 12]), line([17, 12], [23, 12])],
	outlines: [path(2, [3, 8], [3, 3], [8, 3]), path(2, [16, 3], [21, 3], [21, 8]), path(2, [21, 16], [21, 21], [16, 21]), path(2, [8, 21], [3, 21], [3, 16]), strokeRect(8, 8, 16, 16, 1.6)],
	// a wall in a 2×2 grid: the raw, uncorrected canvas
	rawwall: [strokeRect(2, 4, 22, 20), line([12, 4], [12, 20]), line([2, 12], [22, 12])],
	projector: [strokeRect(2, 8, 22, 18), ring(15, 13, 3, 1.8), line([5, 18], [5, 21]), line([19, 18], [19, 21]), line([5, 11], [9, 11], 1.6)],
	pagePrev: [path(2.6, [15, 4], [7, 12], [15, 20])],
	pageNext: [path(2.6, [9, 4], [17, 12], [9, 20])],
	// a lightning bolt: a command button runs a script
	bolt: [poly([14, 2], [5, 13], [11, 13], [9, 22], [19, 10], [13, 10])],
	go: [poly([5, 3], [5, 21], [7.5, 21], [7.5, 13], [19, 13], [15, 8.5], [19, 4], [7.5, 4], [7.5, 3])],
	// circular arrow
	refresh: [arc(12, 12, 8, 40, 330, 2.4), poly([20.5, 1.5], [21, 9.5], [13.5, 7])],
	link: [disc(12, 12, 3), arc(12, 12, 7, 200, 340, 2), arc(12, 12, 7, 20, 160, 2)],
	warning: [and(poly([12, 2], [23, 21], [1, 21]), not(rect(11, 8, 13, 15)), not(disc(12, 18, 1.3)))],
	clock: [ring(12, 12, 9, 2), path(2, [12, 6], [12, 12], [16, 14])],
	knob: [ring(12, 12, 9, 2), line([12, 12], [12, 4], 2.4)],
	playAll: [poly([3, 4], [13, 12], [3, 20]), poly([12, 4], [22, 12], [12, 20])],
	stopAll: [rect(2, 6, 11, 15), rect(13, 9, 22, 18)],
}

const SIZE = 72
const GLYPH_PX = 30 // the 24-unit box drawn 30 px wide
const GLYPH_TOP = 8
const SS = 4 // supersampling per axis

const cache = new Map()

/**
 * A key face: base64 PNG, 72×72, transparent outside the frame and glyph.
 * @param {string} glyph   a key of GLYPHS (unknown: frame only)
 * @param {object} [o]
 * @param {string} [o.color]  glyph colour '#rrggbb' (default: Exaplay text)
 * @param {string} [o.frame]  frame colour, or null for none (default: the strong line)
 * @param {boolean} [o.center] glyph in the middle of the key (no caption)
 */
function face(glyph, o = {}) {
	const color = o.color || EXA.text
	const frame = o.frame === undefined ? EXA.lineStrong : o.frame
	const key = `${glyph}|${color}|${frame}|${o.center ? 1 : 0}`
	if (cache.has(key)) return cache.get(key)
	const parts = GLYPHS[glyph] || []
	const gc = hex(color)
	const fc = frame ? hex(frame) : null
	const scale = GLYPH_PX / 24
	const ox = (SIZE - GLYPH_PX) / 2
	const oy = o.center ? (SIZE - GLYPH_PX) / 2 : GLYPH_TOP
	// the frame: a rounded square, 2 px, inset 3 px, radius 9 (an Arco button at key scale)
	const inset = 3
	const radius = 9
	const fw = 2
	const inFrame = (x, y) => {
		const cx = Math.min(Math.max(x, inset + radius), SIZE - inset - radius)
		const cy = Math.min(Math.max(y, inset + radius), SIZE - inset - radius)
		return Math.abs(Math.hypot(x - cx, y - cy) - radius) <= fw / 2
	}
	const px = Buffer.alloc(SIZE * SIZE * 4)
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			let g = 0
			let f = 0
			for (let sy = 0; sy < SS; sy++) {
				for (let sx = 0; sx < SS; sx++) {
					const X = x + (sx + 0.5) / SS
					const Y = y + (sy + 0.5) / SS
					const u = (X - ox) / scale
					const v = (Y - oy) / scale
					if (u >= -1 && u <= 25 && v >= -1 && v <= 25 && parts.some((p) => p(u, v))) g++
					else if (fc && inFrame(X, Y)) f++
				}
			}
			const n = SS * SS
			const ga = g / n
			const fa = f / n
			const a = ga + fa
			const i = (y * SIZE + x) * 4
			if (a <= 0) continue
			const c = fc && fa > 0 ? gc.map((v, k) => (v * ga + fc[k] * fa) / a) : gc
			px[i] = Math.round(c[0])
			px[i + 1] = Math.round(c[1])
			px[i + 2] = Math.round(c[2])
			px[i + 3] = Math.round(Math.min(1, a) * 255)
		}
	}
	const b64 = encodePng(SIZE, SIZE, px).toString('base64')
	cache.set(key, b64)
	return b64
}

module.exports = { EXA, GLYPHS, face, mix, rgb, encodePng, crc32 }
