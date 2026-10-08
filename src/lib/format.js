'use strict'
/**
 * Formatting for Companion variables — pure.
 *
 * Unknown is never evidence: a value the engine did not send (absent key, no
 * status feed) is shown as UNKNOWN, never as 0 or "off". A value the engine
 * sent as null ("there is none", e.g. no next cue) is shown as NONE.
 */

const UNKNOWN = '?'
const NONE = '-'

/**
 * Seconds → `M:SS.t`, or `H:MM:SS.t` from one hour. Negative clamps to 0
 * (a remaining time can undershoot by a rounding step).
 * undefined → UNKNOWN, null → NONE.
 */
function formatTime(seconds, { tenths = true } = {}) {
	if (seconds === undefined) return UNKNOWN
	if (seconds === null) return NONE
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return UNKNOWN
	const s = Math.max(0, seconds)
	// Work in whole tenths so 59.96 rounds to 1:00.0, not 0:60.0.
	const totalTenths = Math.round(s * 10)
	let whole = Math.floor(totalTenths / 10)
	const t = totalTenths % 10
	if (!tenths) whole = Math.round(s)
	const h = Math.floor(whole / 3600)
	const m = Math.floor((whole % 3600) / 60)
	const sec = whole % 60
	const ss = String(sec).padStart(2, '0')
	const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
	return tenths ? `${base}.${t}` : base
}

/** Seconds with one decimal, for a variable meant for arithmetic. */
function formatSeconds(seconds) {
	if (seconds === undefined) return UNKNOWN
	if (seconds === null) return NONE
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return UNKNOWN
	return (Math.round(seconds * 10) / 10).toFixed(1)
}

function formatBool(b) {
	if (b === true) return 'on'
	if (b === false) return 'off'
	return UNKNOWN
}

/** Playlist item remaining = duration − time, from the item object. */
function itemRemaining(item) {
	if (item === undefined) return undefined
	if (item === null) return null
	if (typeof item !== 'object') return undefined
	const { time, duration } = item
	if (typeof time !== 'number' || typeof duration !== 'number') return undefined
	return Math.max(0, duration - time)
}

/**
 * Whole-second clock forms for a key face:
 *   'hms'  → `H:MM:SS` (always with hours: `0:04:05`)
 *   'mmss' → `MM:SS` (minutes keep counting past 59: `75:05`)
 *   's'    → whole seconds (`245`)
 * A remaining time rounds UP (`ceil`), so "0:01" is still showing while the
 * last second runs and 0 means it is over; an elapsed time rounds down.
 */
function formatClock(seconds, style = 'hms', { up = false } = {}) {
	if (seconds === undefined) return UNKNOWN
	if (seconds === null) return NONE
	if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return UNKNOWN
	const s = Math.max(0, seconds)
	// guard the 0.1 s rounding of the status feed: 4.0000001 must not read 5
	const whole = up ? Math.ceil(s - 1e-6) : Math.floor(s + 1e-6)
	if (style === 's') return String(whole)
	const h = Math.floor(whole / 3600)
	const m = Math.floor((whole % 3600) / 60)
	const sec = String(whole % 60).padStart(2, '0')
	if (style === 'mmss') return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${sec}`
	return `${h}:${String(m).padStart(2, '0')}:${sec}`
}

/** 0..1 → integer percent text; unknown → UNKNOWN. */
function formatPercent(fraction) {
	if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return UNKNOWN
	return String(Math.round(Math.min(1, Math.max(0, fraction)) * 100))
}

/** 0..1 → a text bar of `width` cells (`▰▰▰▱▱▱`); unknown → UNKNOWN. */
function progressBar(fraction, width = 10) {
	if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return UNKNOWN
	const f = Math.min(1, Math.max(0, fraction))
	const full = Math.round(f * width)
	return '▰'.repeat(full) + '▱'.repeat(width - full)
}

module.exports = { UNKNOWN, NONE, formatTime, formatSeconds, formatBool, itemRemaining, formatClock, formatPercent, progressBar }
