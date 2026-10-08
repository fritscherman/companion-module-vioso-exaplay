'use strict'
const { Regex } = require('@companion-module/base')

const DEFAULTS = {
	host: '',
	tcpPort: 8100,
	httpPort: 8123,
	oscPort: 8000,
	oscPrefix: 'exaplay',
	statusEnabled: true,
	statusRate: 5,
	switchTransport: 'tcp',
	legacy1x: false,
}

function getConfigFields() {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Exaplay 3',
			value:
				'Commands go over one TCP connection (port 8100). Status comes from the engine\'s /status WebSocket on the HTTP port (8123), ' +
				'which also carries command buttons and Stop all. Blank, Audio mute, Identify, the blank fade and Play all use TCP on Exaplay 3.4 and later; ' +
				'choose OSC below for an older engine. Outlines and the raw wall always go as OSC (UDP 8000).',
		},
		{ type: 'textinput', id: 'host', label: 'Engine address (the master in a multi-client rig)', width: 6, default: DEFAULTS.host, regex: Regex.HOSTNAME },
		{ type: 'number', id: 'tcpPort', label: 'TCP port', width: 3, default: DEFAULTS.tcpPort, min: 1, max: 65535 },
		{ type: 'number', id: 'httpPort', label: 'HTTP port', width: 3, default: DEFAULTS.httpPort, min: 1, max: 65535 },
		{ type: 'number', id: 'oscPort', label: 'OSC port (UDP)', width: 3, default: DEFAULTS.oscPort, min: 1, max: 65535 },
		{
			type: 'textinput',
			id: 'oscPrefix',
			label: 'OSC prefix (Settings → Communication → OSC Prefix)',
			width: 3,
			default: DEFAULTS.oscPrefix,
			regex: '/^[^/]*$/',
		},
		{ type: 'checkbox', id: 'statusEnabled', label: 'Use the status feed', width: 3, default: DEFAULTS.statusEnabled },
		{ type: 'number', id: 'statusRate', label: 'Status rate (messages/s, 1–20)', width: 3, default: DEFAULTS.statusRate, min: 1, max: 20 },
		{
			type: 'dropdown',
			id: 'switchTransport',
			label: 'Blank, Audio mute, Identify, Play all over',
			width: 6,
			default: DEFAULTS.switchTransport,
			choices: [
				{ id: 'tcp', label: 'TCP — with an answer (Exaplay 3.4 and later)' },
				{ id: 'osc', label: 'OSC — no answer (older Exaplay)' },
			],
		},
		{
			type: 'checkbox',
			id: 'legacy1x',
			label: 'Buttons from module 1.x: keep its variables ($(…:playback_status_comp1) & co) and display feedbacks',
			width: 12,
			default: DEFAULTS.legacy1x,
			tooltip: 'Switched on by the update from 1.x. Leave it off for a new setup — the presets and $(…:comp_<id>_…) variables replace them.',
		},
	]
}

/** Fill defaults for fields an older saved config does not have. */
function withDefaults(config) {
	const c = { ...DEFAULTS, ...(config || {}) }
	c.host = String(c.host || '').trim()
	return c
}

module.exports = { DEFAULTS, getConfigFields, withDefaults }
