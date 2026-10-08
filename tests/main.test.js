'use strict'
/**
 * src/main.js — the instance WIRING — against local mock servers (TCP 8100,
 * HTTP + /status WebSocket 8123). @companion-module/base's InstanceBase and
 * runEntrypoint are replaced by a recording stand-in, so this is not a run
 * inside Companion; it checks what the module does with its links: when it
 * reads the cue lists, how it reacts to a project load, what a command button
 * or the cue dial sends, and that two instances share nothing.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const http = require('node:http')
const { once } = require('node:events')
const { WebSocketServer } = require('ws')

/* ---- stand-in for @companion-module/base: the real helpers, a recording InstanceBase ---- */
const basePath = require.resolve('@companion-module/base')
const realBase = require('@companion-module/base')
class FakeInstanceBase {
	constructor(internal) {
		this.label = internal.label
		this.vars = {}
		this.defs = {}
		this.statusLog = []
		this.logs = []
		this.osc = []
		this.feedbackChecks = 0
	}
	setActionDefinitions(d) {
		this.defs.actions = d
	}
	setFeedbackDefinitions(d) {
		this.defs.feedbacks = d
	}
	setVariableDefinitions(d) {
		this.defs.variables = d
	}
	setPresetDefinitions(d) {
		this.defs.presets = d
	}
	setVariableValues(v) {
		Object.assign(this.vars, v)
	}
	checkFeedbacks() {
		this.feedbackChecks++
	}
	updateStatus(s, m) {
		this.statusLog.push([s, m])
	}
	log(level, msg) {
		this.logs.push([level, msg])
	}
	oscSend(host, port, address, args) {
		this.osc.push({ host, port, address, args })
	}
}
require.cache[basePath] = {
	id: basePath,
	filename: basePath,
	loaded: true,
	exports: { ...realBase, InstanceBase: FakeInstanceBase, runEntrypoint: () => {} },
}
const { ExaplayInstance } = require('../src/main')

/* ---- mock engine ---- */
async function mockEngine() {
	const eng = {
		received: [],
		httpSeen: [],
		wsClients: new Set(),
		cueRows: ['1,Intro,0.0000', '2,Scene A,30.0000', '3,Blackout,90.0000'],
		fireAnswer: { ok: true, lines: 2 },
	}
	const sockets = new Set()
	const tcp = net.createServer((sock) => {
		sockets.add(sock)
		sock.on('close', () => sockets.delete(sock))
		let buf = ''
		sock.on('data', (d) => {
			buf += d
			let i
			while ((i = buf.indexOf('\r\n')) >= 0) {
				const line = buf.slice(0, i)
				buf = buf.slice(i + 2)
				eng.received.push(line)
				const w = (s) => sock.write(s + '\r\n')
				if (line === 'hello') w('hallo')
				else if (line === 'get:complist') w('comp1,Main Show\r\nEND')
				else if (line === 'comp1.get:type') w('timeline')
				else if (line === 'comp1.get:cuelist') w([...eng.cueRows, 'END'].join('\r\n'))
				else if (line === 'comp1.get:audio.volume') w('80')
				else if (line === 'comp1.get:alpha') w('100')
				else w('OK')
			}
		})
	})
	tcp.listen(0, '127.0.0.1')
	await once(tcp, 'listening')
	const server = http.createServer((req, res) => {
		let body = ''
		req.on('data', (d) => (body += d))
		req.on('end', () => {
			eng.httpSeen.push({ method: req.method, url: req.url, body })
			res.writeHead(200, { 'Content-Type': 'application/json' })
			if (req.url.startsWith('/data?type=exaObj&path=project'))
				res.end(JSON.stringify({ values: { control_panel_items: [{ id: 'control_script_1', type: 'script', label: 'Doors open', code: 'comp1.play' }] } }))
			else if (req.url === '/control/fire') res.end(JSON.stringify(eng.fireAnswer))
			else res.end('{}')
		})
	})
	const wss = new WebSocketServer({ noServer: true })
	server.on('upgrade', (req, sock, head) =>
		wss.handleUpgrade(req, sock, head, (ws) => {
			eng.wsClients.add(ws)
			ws.on('message', () => {})
			ws.on('close', () => eng.wsClients.delete(ws))
		}),
	)
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	eng.tcpPort = tcp.address().port
	eng.httpPort = server.address().port
	eng.push = (msg) => {
		for (const ws of eng.wsClients) ws.send(JSON.stringify({ type: 'status', v: 1, ...msg }))
	}
	eng.close = () =>
		new Promise((r) => {
			for (const s of sockets) s.destroy()
			for (const ws of eng.wsClients) ws.terminate()
			wss.close()
			server.closeAllConnections?.()
			server.close(() => tcp.close(() => r()))
		})
	return eng
}

const waitUntil = async (pred, ms = 3000) => {
	const t0 = Date.now()
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
		await new Promise((r) => setTimeout(r, 10))
	}
}

const PLAYING = (extra = {}) => ({
	loading: false,
	project: { name: 'Show.vpp', unsaved: false },
	compositions: [{ id: 'comp1', name: 'Main Show', type: 'timeline', state: 'playing', time: 31, duration: 120, cue: { index: 2, name: 'Scene A' }, 'next-cue-in': 59, item: null }],
	...extra,
})

async function started(label = 'exaplay') {
	const eng = await mockEngine()
	const inst = new ExaplayInstance({ label })
	await inst.init({ host: '127.0.0.1', tcpPort: eng.tcpPort, httpPort: eng.httpPort, oscPort: 9, statusEnabled: true, statusRate: 5 })
	await waitUntil(() => inst.tcpState === 'connected' && inst.statusState === 'connected' && inst.catalog.state.known && !inst.catalog.refreshing)
	return { eng, inst }
}

test('on connect: cue lists and command buttons are read, presets and dropdowns follow', async () => {
	const { eng, inst } = await started()
	try {
		eng.push(PLAYING())
		await waitUntil(() => inst.vars.comp_comp1_next_cue_name === 'Blackout')
		assert.ok(eng.received.includes('comp1.get:cuelist'))
		assert.ok(inst.defs.presets.comp_comp1_cue_3, 'one preset per cue')
		assert.ok(inst.defs.presets.button_control_script_1, 'one preset per command button')
		assert.equal(inst.vars.comp_comp1_cue_count, '3')
		assert.equal(inst.vars.comp_comp1_volume, '80', 'levels read with the lists seed the dial display')
		assert.equal(inst.vars.comp_comp1_remaining_mmss, '01:29')
		assert.equal(inst.vars.lists_state, 'ok')
		assert.equal(inst.vars.button_count, '1')
		assert.deepEqual(inst.defs.actions.fire_button.options[0].choices.map((c) => c.id), ['control_script_1'])
	} finally {
		await inst.destroy()
		await eng.close()
	}
})

test('a project load (loading → loaded) and a project rename re-read the lists; a time tick does not', async () => {
	const { eng, inst } = await started()
	try {
		const reads = () => eng.received.filter((l) => l === 'get:complist').length
		eng.push(PLAYING())
		await waitUntil(() => inst.status.known)
		const base = reads()
		eng.push(PLAYING({ compositions: [{ ...PLAYING().compositions[0], time: 32 }] }))
		await new Promise((r) => setTimeout(r, 100))
		assert.equal(reads(), base, 'a time tick refreshes nothing')

		inst.selected.comp1 = 3
		eng.push({ loading: true, compositions: [] })
		await waitUntil(() => inst.status.loading === true)
		eng.cueRows = ['1,New Intro,0.0000']
		eng.push(PLAYING())
		await waitUntil(() => reads() === base + 1 && !inst.catalog.refreshing && inst.catalog.state.known)
		assert.equal(inst.selected.comp1, undefined, 'the picked cue of the old project is forgotten')
		await waitUntil(() => inst.vars.comp_comp1_cue_count === '1')
		assert.ok(!inst.defs.presets.comp_comp1_cue_3, 'presets follow the new project')

		eng.push(PLAYING({ project: { name: 'Other.vpp', unsaved: false } }))
		await waitUntil(() => reads() === base + 2)
	} finally {
		await inst.destroy()
		await eng.close()
	}
})

test('command button: pressed by id; a refusal shows its reason and lights button_failed', async () => {
	const { eng, inst } = await started()
	try {
		await inst.runFireButton('control_script_1')
		const fire = eng.httpSeen.filter((r) => r.url === '/control/fire')
		assert.deepEqual(fire.map((r) => JSON.parse(r.body)), [{ id: 'control_script_1' }])
		assert.equal(inst.vars.button_last, 'Doors open: OK')
		eng.fireAnswer = { ok: false, reason: 'already running' }
		await inst.runFireButton('control_script_1')
		assert.equal(inst.vars.button_last, 'Doors open: already running')
		assert.match(inst.vars.last_error, /already running/)
		assert.equal(inst.defs.feedbacks.button_failed.callback({ options: { button: 'control_script_1' } }), true)
	} finally {
		await inst.destroy()
		await eng.close()
	}
})

test('cue dial: turning picks without sending; press GOes the picked cue by index', async () => {
	const { eng, inst } = await started()
	try {
		eng.push(PLAYING())
		await waitUntil(() => inst.status.known)
		const before = eng.received.length
		inst.stepSelectedCue('comp1', 1) // from the current cue 2 → 3
		assert.equal(inst.selected.comp1, 3)
		inst.stepSelectedCue('comp1', 5)
		assert.equal(inst.selected.comp1, 3, 'clamped at the last cue')
		inst.stepSelectedCue('comp1', -2)
		assert.equal(inst.selected.comp1, 1)
		assert.equal(inst.vars.comp_comp1_selected_cue_name, 'Intro')
		assert.equal(eng.received.length, before, 'turning sends nothing to the engine')
		await inst.goSelectedCue('comp1')
		assert.equal(eng.received[eng.received.length - 1], 'comp1.cue.go=1')
	} finally {
		await inst.destroy()
		await eng.close()
	}
})

test('volume dial over TCP; engine-wide switches over OSC; refresh and re-sync', async () => {
	const { eng, inst } = await started()
	try {
		inst.levelDial('comp1', 'volume').nudge(-5)
		await inst.levelDial('comp1', 'volume').idle()
		assert.ok(eng.received.includes('comp1.set:vol=75'), 'the base came from the value read with the lists (80)')
		assert.equal(inst.vars.comp_comp1_volume, '75')
		await inst.defs.actions.correction_bypass.callback({ options: { mode: 'on' } }, { parseVariablesInString: async (s) => s })
		assert.deepEqual(inst.osc[inst.osc.length - 1], { host: '127.0.0.1', port: 9, address: '/exaplay/global/correctionbypass', args: [{ type: 's', value: 'on' }] })
		const n = eng.received.filter((l) => l === 'get:complist').length
		await inst.refreshLists('manual')
		assert.equal(eng.received.filter((l) => l === 'get:complist').length, n + 1)
		inst.resync()
		await waitUntil(() => inst.tcpState === 'connected' && inst.catalog.state.known && !inst.catalog.refreshing)
		assert.equal(eng.received.filter((l) => l === 'get:complist').length, n + 2)
	} finally {
		await inst.destroy()
		await eng.close()
	}
})

test('link lost: the flash runs only while it is lost, values go unknown', async () => {
	const { eng, inst } = await started()
	try {
		assert.equal(inst.blinkTimer, null)
		await eng.close()
		await waitUntil(() => inst.tcpState !== 'connected')
		assert.ok(inst.blinkTimer, 'flashing while lost')
		assert.equal(inst.defs.feedbacks.connection_lost.callback({ options: { blink: false } }), true)
		await waitUntil(() => inst.vars.status_state !== 'connected')
		assert.equal(inst.vars.comp_comp1_state, '?')
	} finally {
		await inst.destroy()
		assert.equal(inst.blinkTimer, null, 'no clock left running after destroy')
	}
})

test('two instances (two engines) share nothing', async () => {
	const a = await started('show_a')
	const b = await started('show_b')
	try {
		a.inst.selected.comp1 = 3
		a.inst.levelDial('comp1', 'volume')
		assert.equal(b.inst.selected.comp1, undefined)
		assert.equal(b.inst.dials.size, 0)
		assert.notEqual(a.inst.catalog, b.inst.catalog)
		assert.match(a.inst.defs.presets.comp_comp1_toggle.style.text, /\$\(show_a:comp_comp1_time\)/)
		assert.match(b.inst.defs.presets.comp_comp1_toggle.style.text, /\$\(show_b:comp_comp1_time\)/)
	} finally {
		await a.inst.destroy()
		await b.inst.destroy()
		await a.eng.close()
		await b.eng.close()
	}
})
