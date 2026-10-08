'use strict'
/**
 * The catalog (cue lists + command buttons) against a local mock engine: a
 * net.Server speaking the engine's reply shapes (Composition.cpp get:type /
 * get:cuelist, the TCP list framing) and an http.Server answering GET /data.
 * Nothing here talks to a real Exaplay.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const http = require('node:http')
const { once } = require('node:events')
const { TcpClient } = require('../src/lib/tcp-client')
const { request } = require('../src/lib/http')
const { Catalog, catalogSignature, cueChoices, parseCuePick, buttonChoices } = require('../src/lib/catalog')

async function mockTcp(handler) {
	const received = []
	const sockets = new Set()
	const server = net.createServer((sock) => {
		sockets.add(sock)
		sock.on('close', () => sockets.delete(sock))
		let buf = ''
		let chain = Promise.resolve()
		sock.on('data', (d) => {
			buf += d.toString()
			let i
			while ((i = buf.indexOf('\r\n')) >= 0) {
				const line = buf.slice(0, i)
				buf = buf.slice(i + 2)
				received.push(line)
				chain = chain.then(() => handler(line, sock))
			}
		})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	return {
		port: server.address().port,
		received,
		close: () =>
			new Promise((r) => {
				sockets.forEach((s) => s.destroy())
				server.close(() => r())
			}),
	}
}

async function mockHttp(handler) {
	const seen = []
	const srv = http.createServer((req, res) => {
		let body = ''
		req.on('data', (d) => (body += d))
		req.on('end', () => {
			seen.push({ method: req.method, url: req.url, body })
			handler(req, res, body)
		})
	})
	srv.listen(0, '127.0.0.1')
	await once(srv, 'listening')
	return {
		port: srv.address().port,
		seen,
		close: () =>
			new Promise((r) => {
				srv.closeAllConnections?.()
				srv.close(() => r())
			}),
	}
}

/** The sample project: a Timeline, a Playlist, a plain composition. */
let lobbyRows = ['1,Opening,/media/opening.mp4', '2,Act 1, Scene 2,C:\\media\\act1.mov']
function engine(line, sock) {
	const w = (s) => sock.write(s + '\r\n')
	if (line === 'hello') return w('hallo')
	if (line === 'get:complist') return w('comp_main,Main Show\r\ncomp_lobby,Lobby, Loop\r\ncomp_plain,Plain\r\nEND')
	if (line === 'comp_main.get:type') return w('timeline')
	if (line === 'comp_lobby.get:type') return w('cuelist')
	if (line === 'comp_plain.get:type') return w('composition')
	if (line === 'comp_main.get:cuelist') return w('2,Scene A,30.0000\r\n1,Intro,0.0000\r\n3,Blackout,90.0000\r\nEND')
	if (line === 'comp_lobby.get:cuelist') return w([...lobbyRows, 'END'].join('\r\n'))
	if (line === 'comp_main.get:audio.volume') return w('80')
	if (line === 'comp_main.get:alpha') return w('37.5')
	if (line === 'comp_lobby.get:audio.volume') return w('ERR,command_failed')
	if (line.endsWith('.get:alpha') || line.endsWith('.get:audio.volume')) return w('100')
	if (line.startsWith('slow:')) return new Promise((r) => setTimeout(() => (w('OK'), r()), 60))
	w('OK')
}

const PROJECT_VALUES = {
	values: {
		name: 'Show',
		control_panel_items: [
			{ id: 'control_script_1', type: 'script', label: 'Command button', customLabel: 'Doors open', code: 'comp_main.play' },
			{ id: 'fader_1', type: 'value', label: 'Alpha' },
		],
	},
	revs: {},
}

async function connected(c) {
	if (c.state === 'connected') return
	await new Promise((resolve) => c.on('state', (s) => s === 'connected' && resolve()))
}

async function setup(httpHandler) {
	const tcpEng = await mockTcp(engine)
	const httpEng = await mockHttp(
		httpHandler ||
			((req, res) => {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify(PROJECT_VALUES))
			}),
	)
	const tcp = new TcpClient({ host: '127.0.0.1', port: tcpEng.port, replyTimeoutMs: 500 })
	tcp.start()
	await connected(tcp)
	const cat = new Catalog({
		sendTcp: (line, o) => tcp.send(line, o),
		http: (b) => request({ host: '127.0.0.1', port: httpEng.port, method: b.method, path: b.path, body: b.body }),
	})
	return {
		tcpEng,
		httpEng,
		tcp,
		cat,
		close: async () => {
			tcp.stop()
			await tcpEng.close()
			await httpEng.close()
		},
	}
}

test('a refresh reads the composition list, each type and cue list, the levels and the buttons', async () => {
	const t = await setup()
	try {
		const changes = []
		t.cat.on('change', (s) => changes.push(s))
		await t.cat.refresh('test')
		const st = t.cat.state
		assert.equal(st.known, true)
		assert.deepEqual(
			st.comps.map((c) => [c.id, c.name, c.type]),
			[
				['comp_main', 'Main Show', 'timeline'],
				['comp_lobby', 'Lobby, Loop', 'playlist'],
				['comp_plain', 'Plain', 'other'],
			],
		)
		assert.deepEqual(st.comps[0].cues.map((c) => [c.index, c.name, c.offset]), [
			[2, 'Scene A', 30],
			[1, 'Intro', 0],
			[3, 'Blackout', 90],
		])
		assert.equal(st.comps[1].cues[1].name, 'Act 1, Scene 2')
		assert.deepEqual(st.comps[2].cues, [], 'a plain composition has no cues — no get:cuelist is sent for it')
		assert.ok(!t.tcpEng.received.includes('comp_plain.get:cuelist'))
		assert.equal(st.comps[0].volume, 80)
		assert.equal(st.comps[0].opacity, 37.5)
		assert.equal(st.comps[1].volume, undefined, 'an ERR reply is unknown, not 0')
		assert.deepEqual(st.buttons, [{ id: 'control_script_1', label: 'Doors open' }])
		assert.equal(changes.length, 1)
		// read only: GET /data on the project, nothing else over HTTP
		assert.deepEqual(t.httpEng.seen, [{ method: 'GET', url: '/data?type=exaObj&path=project&values', body: '' }])
		// dropdowns
		assert.deepEqual(cueChoices(st).map((c) => c.id).slice(0, 4), ['comp_main|2', 'comp_main|1', 'comp_main|3', 'comp_lobby|1'])
		assert.deepEqual(parseCuePick('comp_main|3'), { comp: 'comp_main', cue: '3' })
		assert.equal(parseCuePick('nothing'), undefined)
		assert.deepEqual(buttonChoices(st), [{ id: 'control_script_1', label: 'Doors open (control_script_1)' }])
	} finally {
		await t.close()
	}
})

test('refreshes are coalesced: calls during a run give exactly one more run', async () => {
	const t = await setup()
	try {
		let runs = 0
		t.cat.on('change', () => runs++)
		const a = t.cat.refresh('a')
		t.cat.refresh('b')
		t.cat.refresh('c')
		assert.equal(t.cat.refreshing, true)
		await a
		assert.equal(runs, 2)
		assert.equal(t.tcpEng.received.filter((l) => l === 'get:complist').length, 2)
	} finally {
		await t.close()
	}
})

test('the signature changes with the cue names, not with anything else', async () => {
	const t = await setup()
	try {
		await t.cat.refresh()
		const sig = catalogSignature(t.cat.state)
		await t.cat.refresh()
		assert.equal(catalogSignature(t.cat.state), sig)
		lobbyRows = ['1,Opening,/media/opening.mp4', '2,Act 2,/media/act2.mov']
		await t.cat.refresh()
		assert.notEqual(catalogSignature(t.cat.state), sig)
	} finally {
		lobbyRows = ['1,Opening,/media/opening.mp4', '2,Act 1, Scene 2,C:\\media\\act1.mov']
		await t.close()
	}
})

test('unknown is never evidence: a failed read leaves that part UNKNOWN with its reason', async () => {
	const t = await setup((req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' })
		res.end('{"loading":true}')
	})
	try {
		await t.cat.refresh()
		assert.equal(t.cat.state.buttons, undefined)
		assert.match(t.cat.state.buttonsError, /loading/)
		assert.ok(Array.isArray(t.cat.state.comps))
	} finally {
		await t.close()
	}
	// TCP down: the composition list is unknown, not empty
	const cat = new Catalog({ sendTcp: async () => ({ ok: false, error: 'not connected to the engine' }), http: async () => ({ error: 'ECONNREFUSED' }) })
	await cat.refresh()
	assert.equal(cat.state.comps, undefined)
	assert.match(cat.state.compsError, /not connected/)
	assert.equal(cat.state.buttons, undefined)
	assert.equal(cat.state.known, true)
	cat.clear()
	assert.equal(cat.state.known, false)
})

test('a clear() during a run discards that run (the project changed under it)', async () => {
	const t = await setup()
	try {
		const p = t.cat.refresh()
		t.cat.clear()
		await p
		assert.equal(t.cat.state.known, false, 'the stale result was not published')
	} finally {
		await t.close()
	}
})

test('background reads never delay an operator command', async () => {
	const t = await setup()
	try {
		// queue a long background refresh, then an operator GO
		const bg = []
		for (let i = 0; i < 5; i++) bg.push(t.tcp.send(`slow:bg${i}`, { background: true }))
		await new Promise((r) => setTimeout(r, 10))
		const go = t.tcp.send('comp_main.cue.go=3')
		await go
		await Promise.all(bg)
		const order = t.tcpEng.received.filter((l) => l.startsWith('slow:') || l.startsWith('comp_main.cue'))
		// bg0 was already in flight; the GO goes next, before bg1…bg4
		assert.deepEqual(order, ['slow:bg0', 'comp_main.cue.go=3', 'slow:bg1', 'slow:bg2', 'slow:bg3', 'slow:bg4'])
	} finally {
		await t.close()
	}
})
