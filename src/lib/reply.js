'use strict'
/**
 * TCP reply parsing — pure.
 *
 * The engine answers each line with exactly one line (`OK`, `ERR,<reason>` or
 * a value) or, for list commands, rows ending in `END`. Lines end in CRLF; a
 * bare CR or LF is accepted too, and empty lines are skipped.
 */

/** Splits a byte/character stream into lines; keeps the unfinished tail. */
class LineSplitter {
	constructor() {
		this.buf = ''
	}

	/** @returns {string[]} the complete, non-empty lines in this chunk */
	push(chunk) {
		this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
		const out = []
		let m
		const re = /\r\n|\r|\n/g
		let last = 0
		while ((m = re.exec(this.buf)) !== null) {
			// A CR at the very end may be the first half of a CRLF still in flight.
			if (m[0] === '\r' && m.index === this.buf.length - 1) break
			const line = this.buf.slice(last, m.index)
			if (line.length) out.push(line)
			last = m.index + m[0].length
		}
		this.buf = this.buf.slice(last)
		return out
	}

	reset() {
		this.buf = ''
	}
}

/**
 * Classify one single-line reply.
 * Only the documented `ERR,<reason>` form is an error: a value that merely
 * starts with "ERR" (a composition called ERRATA) is data.
 */
function parseReply(line) {
	const l = String(line)
	if (l === 'OK') return { kind: 'ok', text: l }
	if (l.startsWith('OK,')) return { kind: 'ok', text: l, value: l.slice(3) }
	if (l.startsWith('ERR,')) return { kind: 'error', text: l, reason: l.slice(4) }
	return { kind: 'value', text: l, value: l }
}

/**
 * `get:complist` rows: `<varname>,<display name>` — the name is everything
 * after the FIRST comma (reply fields are not escaped).
 */
function parseCompList(rows) {
	const out = []
	for (const r of rows) {
		const i = r.indexOf(',')
		if (i <= 0) continue
		out.push({ id: r.slice(0, i), name: r.slice(i + 1) })
	}
	return out
}

module.exports = { LineSplitter, parseReply, parseCompList }
