'use strict'
/**
 * Upgrade scripts: what Companion runs ONCE on a saved connection whose
 * buttons were made with an older version of this module.
 *
 * v1 → v2: the module that was on Companion's list before 2.0.0
 * (bitfocus/companion-module-vioso-exaplay 1.x, TCP polling of
 * `get:status`) had its own config, action and feedback ids. 2.0.0 is a
 * rewrite under the same module id, so without this script every button an
 * operator built with 1.x would show "action not found" after the update.
 *
 * What it maps (anything else is left untouched):
 *
 *   config   port → tcpPort; prot / pollingInterval / saveresponse dropped;
 *            legacy1x switched ON so $(…:playback_status_comp1) & co
 *            keep resolving on existing buttons
 *   actions  transportmode {command}   → comp_play / comp_pause / comp_stop
 *            set_cue                    → cue_go
 *            volume                     → comp_volume_set
 *            volume_adjust {+|-}        → comp_volume_nudge (±10, as before)
 *            jump_to_time               → comp_seek
 *   feedback transportModeFeedback      → comp_state (stop → stopped)
 *            cueActiveFeedback          → cue_current
 *            the five display feedbacks keep their ids (see feedbacks.js,
 *            "legacy") — they had no equivalent with the same look.
 *
 * The old composition field accepted "1" for "comp1"; `legacyCompId` keeps
 * that meaning, and the result goes into the text field (compText), which
 * wins over the dropdown — so the button addresses exactly what it did.
 */

/** v1's rule: "1" → "comp1"; anything already starting with "comp" (any case) unchanged. */
function legacyCompId(value) {
	const s = String(value ?? '').trim()
	if (!s) return 'comp'
	return /^comp/i.test(s) ? s : `comp${s}`
}

const compFields = (o) => ({ comp: '', compText: legacyCompId(o.composition_id) })

const TRANSPORT = { play: 'comp_play', pause: 'comp_pause', stop: 'comp_stop' }

/** One v1 action → its v2 id and options, or null when it is not a v1 action. */
function upgradeAction(actionId, o = {}) {
	switch (actionId) {
		case 'transportmode': {
			const id = TRANSPORT[String(o.command ?? '').trim()]
			return id ? { actionId: id, options: compFields(o) } : null
		}
		case 'set_cue':
			return { actionId: 'cue_go', options: { ...compFields(o), cue: String(o.cue_number ?? '1').trim() || '1' } }
		case 'volume': {
			const v = o.volume_value === undefined || o.volume_value === null || o.volume_value === '' ? 50 : o.volume_value
			return { actionId: 'comp_volume_set', options: { ...compFields(o), value: String(v) } }
		}
		case 'volume_adjust':
			return { actionId: 'comp_volume_nudge', options: { ...compFields(o), delta: o.adjustment === '-' ? -10 : 10 } }
		case 'jump_to_time':
			return { actionId: 'comp_seek', options: { ...compFields(o), time: String(o.time_in_seconds ?? '0').trim() || '0' } }
		default:
			return null
	}
}

/** One v1 feedback → its v2 id and options, or null when it keeps its id. */
function upgradeFeedback(feedbackId, o = {}) {
	switch (feedbackId) {
		case 'transportModeFeedback':
			return { feedbackId: 'comp_state', options: { ...compFields(o), state: o.mode === 'stop' ? 'stopped' : o.mode === 'paused' ? 'paused' : 'playing' } }
		case 'cueActiveFeedback':
			return { feedbackId: 'cue_current', options: { ...compFields(o), cue: String(o.cue_number ?? '1').trim() || '1' } }
		default:
			return null
	}
}

/** v1's config → v2's; null when the config is not a v1 one. */
function upgradeConfig(config) {
	if (!config || typeof config !== 'object') return null
	const isV1 = 'port' in config || 'pollingInterval' in config || 'saveresponse' in config || 'prot' in config
	if (!isV1) return null
	const out = { ...config }
	if (out.tcpPort === undefined) {
		const p = Number(String(config.port ?? '').trim())
		out.tcpPort = Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 8100
	}
	delete out.port
	delete out.prot
	delete out.pollingInterval
	delete out.saveresponse
	if (out.legacy1x === undefined) out.legacy1x = true
	return out
}

/** @type {import('@companion-module/base').CompanionStaticUpgradeScript<any>} */
function v1ToV2(_context, props) {
	const result = { updatedConfig: upgradeConfig(props.config), updatedActions: [], updatedFeedbacks: [] }
	for (const action of props.actions) {
		const up = upgradeAction(action.actionId, action.options || {})
		if (!up) continue
		action.actionId = up.actionId
		action.options = up.options
		result.updatedActions.push(action)
	}
	for (const feedback of props.feedbacks) {
		const up = upgradeFeedback(feedback.feedbackId, feedback.options || {})
		if (!up) continue
		feedback.feedbackId = up.feedbackId
		feedback.options = up.options
		result.updatedFeedbacks.push(feedback)
	}
	return result
}

const upgradeScripts = [v1ToV2]

module.exports = { upgradeScripts, v1ToV2, legacyCompId, upgradeAction, upgradeFeedback, upgradeConfig }
