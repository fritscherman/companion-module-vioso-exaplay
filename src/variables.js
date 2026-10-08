'use strict'
const { variableDefinitions, variableValues } = require('./lib/status')

/** Overall link word for $(exaplay:connection). */
function connectionWord(tcpState, statusState, statusEnabled) {
	const tcp = tcpState === 'connected'
	const st = statusState === 'connected'
	if (tcp && (st || !statusEnabled)) return 'ok'
	if (tcp || st) return 'partial'
	return 'disconnected'
}

/** $(exaplay:lists_state): ok / refreshing / ? (never read) / the error. */
function listsWord(catalog, refreshing) {
	if (refreshing) return 'refreshing'
	if (!catalog || !catalog.known) return '?'
	const errs = [catalog.compsError, catalog.buttonsError].filter(Boolean)
	return errs.length ? `error: ${errs.join('; ')}` : 'ok'
}

function getVariableDefinitions(self) {
	return variableDefinitions(self.status, self.catalog ? self.catalog.state : undefined, { legacy: !!self.config.legacy1x })
}

/**
 * All values derived from the status state, the catalog, the module's own
 * levels and the link states. `last_reply`, `last_error` and `button_last`
 * are set by the senders, never here.
 */
function getVariableValues(self) {
	const catalog = self.catalog ? self.catalog.state : undefined
	return {
		...variableValues(self.status, { catalog, levels: self.levels, selected: self.selected, legacy: !!self.config.legacy1x }),
		connection: connectionWord(self.tcpState, self.statusState, self.config.statusEnabled),
		tcp_state: self.tcpState,
		status_state: self.config.statusEnabled ? self.statusState : 'off',
		lists_state: listsWord(catalog, self.catalog ? self.catalog.refreshing : false),
		master_volume: typeof self.masterVolume === 'number' ? String(Math.round(self.masterVolume * 10) / 10) : '?',
	}
}

module.exports = { getVariableDefinitions, getVariableValues, connectionWord, listsWord }
