'use strict'
/**
 * Cue lists and command buttons — pure parsers and lookups.
 *
 * Wire formats (engine: project/exaplay-project-Composition.cpp, the dotted
 * `comp1.get:cuelist` / `comp1.get:type`; docs/references/tcp-api.md):
 *
 *   get:type      `timeline` | `cuelist` (= Playlist) | `composition`
 *   get:cuelist   Timeline:  `<variable index>,<name>,<offset s, 4 decimals>` … END
 *                 Playlist:  `<1-based index>,<name>,<source file>` … END
 *
 * Reply fields are NOT escaped. A Timeline row is unambiguous (the offset is
 * a number, so the name is everything between the first and the LAST comma).
 * A Playlist row is not when a name or a path holds a comma: the file is
 * taken from the first comma whose remainder looks like an absolute path
 * (`C:\…`, `\\server\…`, `/…`), else from the last comma — and such a row is
 * marked `ambiguous`. The cue is addressed by INDEX, so a mis-split name only
 * changes a label, never which cue fires.
 *
 * Command buttons (engine-comm/comm-control-script-rules.h): the project value
 * `control_panel_items[] { id, type:"script", label | customLabel, code }`,
 * stored as an array or (older projects) as a JSON string of one. Only `id`
 * and the label are kept — the script stays in the project; a press NAMES the
 * button (`POST /control/fire {"id"}`).
 */

const TYPES = { timeline: 'timeline', cuelist: 'playlist', playlist: 'playlist', composition: 'other' }

/** `get:type` reply → 'timeline' | 'playlist' | 'other', or undefined. */
function parseTypeReply(value) {
	const t = typeof value === 'string' ? value.trim().toLowerCase() : ''
	return TYPES[t]
}

const PATHLIKE = /^([A-Za-z]:[\\/]|\\\\|\/)/

/**
 * Rows of a `get:cuelist` reply (END already removed) → cues in ENGINE order.
 * A row that does not parse is skipped (and counted), never guessed.
 */
function parseCueListRows(type, rows) {
	const cues = []
	let skipped = 0
	for (const row of rows || []) {
		const r = String(row)
		const first = r.indexOf(',')
		if (first <= 0) {
			skipped++
			continue
		}
		const idxText = r.slice(0, first).trim()
		if (!/^-?\d+$/.test(idxText)) {
			skipped++
			continue
		}
		const index = Number(idxText)
		const rest = r.slice(first + 1)
		if (type === 'timeline') {
			const last = rest.lastIndexOf(',')
			const offText = last >= 0 ? rest.slice(last + 1).trim() : ''
			if (last < 0 || !/^-?(\d+\.?\d*|\.\d+)$/.test(offText)) {
				skipped++
				continue
			}
			cues.push({ index, name: rest.slice(0, last), offset: Number(offText) })
		} else if (type === 'playlist') {
			const commas = []
			for (let i = rest.indexOf(','); i >= 0; i = rest.indexOf(',', i + 1)) commas.push(i)
			if (commas.length === 0) {
				// no file field at all — the name is the rest
				cues.push({ index, name: rest, file: undefined })
				continue
			}
			let at = commas.find((i) => PATHLIKE.test(rest.slice(i + 1)))
			if (at === undefined) at = commas[commas.length - 1]
			cues.push({ index, name: rest.slice(0, at), file: rest.slice(at + 1), ambiguous: commas.length > 1 || undefined })
		} else {
			skipped++
		}
	}
	return { cues, skipped }
}

/**
 * Cues in the order an operator steps through them: a Playlist in list
 * order; a Timeline by time offset (engine order is project order, which a
 * drag in the editor does not keep chronological). Stable for equal offsets.
 */
function orderedCues(entry) {
	if (!entry || !Array.isArray(entry.cues)) return undefined
	if (entry.type !== 'timeline') return entry.cues.slice()
	return entry.cues
		.map((c, i) => [c, i])
		.sort((a, b) => a[0].offset - b[0].offset || a[1] - b[1])
		.map(([c]) => c)
}

/** Find a cue by index (numeric text) or name (case-insensitive), like the engine's resolveCueRef. */
function findCue(entry, ref) {
	if (!entry || !Array.isArray(entry.cues)) return undefined
	const r = typeof ref === 'number' ? String(ref) : typeof ref === 'string' ? ref.trim() : ''
	if (!r) return undefined
	if (/^\d+$/.test(r)) return entry.cues.find((c) => c.index === Number(r))
	const low = r.toLowerCase()
	return entry.cues.find((c) => c.name.toLowerCase() === low)
}

/**
 * The cue that comes NEXT, from the live status of the composition and its
 * cue list. Returns a cue, null ("there is none") or undefined (unknown).
 *
 *  - Timeline: the engine's own rule (Timeline::on_extraFillInfo) — the cue
 *    with the smallest offset strictly after the playhead. The status time is
 *    rounded to 0.1 s, so within a tenth of a cue this can lag by one frame
 *    of status.
 *  - Playlist: the item after the playing one (`cue.index` + 1); with nothing
 *    playing, `next` starts the FIRST item (tcp-api.md › CueList Commands).
 */
function nextCue(comp, entry) {
	if (!comp || !entry || !Array.isArray(entry.cues)) return undefined
	if (entry.type === 'timeline') {
		if (typeof comp.time !== 'number') return undefined
		let best = null
		for (const c of entry.cues) if (c.offset > comp.time && (best === null || c.offset < best.offset)) best = c
		return best
	}
	if (entry.type === 'playlist') {
		if (comp.cue === undefined) return undefined
		if (comp.cue === null) return comp.state === 'stopped' ? entry.cues[0] || null : undefined
		if (typeof comp.cue.index !== 'number') return undefined
		return entry.cues.find((c) => c.index === comp.cue.index + 1) || null
	}
	return undefined
}

/**
 * Is `ref` the CURRENT cue of the composition (status `cue.index`)? true /
 * false on a known state; undefined while unknown (the feedback then stays
 * unlit — unknown is never evidence).
 */
function isCurrentCue(comp, entry, ref) {
	if (!comp || comp.cue === undefined) return undefined
	if (comp.cue === null) return false
	const r = typeof ref === 'number' ? String(ref) : typeof ref === 'string' ? ref.trim() : ''
	if (!r) return undefined
	if (/^\d+$/.test(r)) return typeof comp.cue.index === 'number' ? comp.cue.index === Number(r) : undefined
	// by name: through the list when it is known (index match), else the status name
	const cue = findCue(entry, r)
	if (cue && typeof comp.cue.index === 'number') return comp.cue.index === cue.index
	if (typeof comp.cue.name === 'string') return comp.cue.name.toLowerCase() === r.toLowerCase()
	return undefined
}

/** Is `ref` the NEXT cue? Same tri-state as isCurrentCue. */
function isNextCue(comp, entry, ref) {
	const n = nextCue(comp, entry)
	if (n === undefined) return undefined
	if (n === null) return false
	const r = typeof ref === 'number' ? String(ref) : typeof ref === 'string' ? ref.trim() : ''
	if (!r) return undefined
	if (/^\d+$/.test(r)) return n.index === Number(r)
	return n.name.toLowerCase() === r.toLowerCase()
}

/** The value of `control_panel_items`: an array, or a JSON string of one. */
function controlItemsArray(v) {
	if (Array.isArray(v)) return v
	if (typeof v === 'string') {
		try {
			const p = JSON.parse(v)
			if (Array.isArray(p)) return p
		} catch {
			/* not a list */
		}
	}
	return undefined
}

/**
 * The project's command buttons from GET /data project values: `[{id, label}]`.
 * Returns [] when the project has no `control_panel_items` (absent = none —
 * the project was read, it simply has no controls), undefined when the value
 * is there but unreadable. The script (`code`) is never copied.
 */
function parseCommandButtons(values) {
	if (!values || typeof values !== 'object') return undefined
	if (!('control_panel_items' in values) || values.control_panel_items === null) return []
	const items = controlItemsArray(values.control_panel_items)
	if (!items) return undefined
	const out = []
	const seen = new Set()
	for (const it of items) {
		if (!it || typeof it !== 'object' || it.type !== 'script') continue
		if (typeof it.id !== 'string' || !it.id || seen.has(it.id)) continue
		// The engine's isValidId: printable ASCII, ≤ 128 — anything else it refuses at /control/fire.
		if (it.id.length > 128 || /[^\x20-\x7e]/.test(it.id)) continue
		seen.add(it.id)
		const label =
			typeof it.customLabel === 'string' && it.customLabel.trim()
				? it.customLabel.trim()
				: typeof it.label === 'string' && it.label.trim()
					? it.label.trim()
					: it.id
		out.push({ id: it.id, label })
	}
	return out
}

module.exports = {
	parseTypeReply,
	parseCueListRows,
	orderedCues,
	findCue,
	nextCue,
	isCurrentCue,
	isNextCue,
	parseCommandButtons,
}
