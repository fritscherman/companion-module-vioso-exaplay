'use strict'
/** Reconnect delay: 1 s, 2 s, 4 s … capped (default 30 s). Pure. */
function backoffDelay(attempt, { initialMs = 1000, maxMs = 30000 } = {}) {
	const n = Math.max(0, Math.floor(attempt))
	return Math.min(maxMs, initialMs * 2 ** Math.min(n, 20))
}

module.exports = { backoffDelay }
