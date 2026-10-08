'use strict'
/** The status client against a local mock /status WebSocket (the `ws` package). */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { WebSocketServer } = require('ws')
const { StatusClient, clampRate } = require('../src/lib/status-client')

async function mockStatusServer(onConnection) {
	const server = http.createServer((req, res) => {
		res.writeHead(404)
		res.end()
	})
	const wss = new WebSocketServer({ noServer: true })
	server.on('upgrade', (req, sock, head) => {
		if (req.url !== '/status') {
			sock.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
			sock.destroy()
			return
		}
		wss.handleUpgrade(req, sock, head, (ws) => onConnection(ws))
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	return {
		port: server.address().port,
		wss,
		close: () =>
			new Promise((r) => {
				for (const c of wss.clients) c.terminate()
				wss.close()
				server.close(() => r())
			}),
	}
}

const SNAPSHOT = {
	type: 'status',
	v: 1,
	loading: false,
	project: { name: 'Show.vpp', unsaved: false },
	'show-mode': true,
	compositions: [{ id: 'comp1', name: 'Main Show', type: 'timeline', state: 'playing', time: 1 }],
}

const waitFor = (emitter, ev, pred = () => true, ms = 2000) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms)
		const on = (...a) => {
			if (!pred(...a)) return
			clearTimeout(t)
			emitter.off(ev, on)
			resolve(a)
		}
		emitter.on(ev, on)
	})

test('rate request on connect, snapshot and heartbeat parsed', async () => {
	const fromClient = []
	const srv = await mockStatusServer((ws) => {
		ws.on('message', (m) => fromClient.push(m.toString()))
		ws.send(JSON.stringify(SNAPSHOT))
		ws.send('{"type":"alive","v":1}')
		ws.send('garbage')
	})
	const c = new StatusClient({ url: `ws://127.0.0.1:${srv.port}/status`, rate: 7 })
	const got = []
	c.on('message', (m) => got.push(m))
	c.start()
	try {
		await waitFor(c, 'message', (m) => m.kind === 'alive')
		assert.equal(got[0].kind, 'status')
		assert.equal(got[0].state.showMode, true)
		assert.equal(got[0].state.compositions[0].state, 'playing')
		assert.equal(got.length, 2, 'garbage frame ignored')
		await new Promise((r) => setTimeout(r, 50))
		assert.deepEqual(JSON.parse(fromClient[0]), { rate: 7 })
		c.setRate(50)
		await new Promise((r) => setTimeout(r, 50))
		assert.deepEqual(JSON.parse(fromClient[1]), { rate: 20 })
	} finally {
		c.stop()
		await srv.close()
	}
})

test('silence past the limit drops the socket, reports lost, and reconnects', async () => {
	let connections = 0
	const srv = await mockStatusServer((ws) => {
		connections++
		ws.send(JSON.stringify(SNAPSHOT)) // then say nothing
	})
	const c = new StatusClient({ url: `ws://127.0.0.1:${srv.port}/status`, silenceMs: 150, backoff: { initialMs: 20 } })
	let lost = 0
	c.on('lost', () => lost++)
	c.start()
	try {
		await waitFor(c, 'state', (s) => s === 'connected')
		await waitFor(c, 'state', (s) => s === 'disconnected')
		assert.equal(lost, 1)
		await waitFor(c, 'state', (s) => s === 'connected')
		assert.ok(connections >= 2)
	} finally {
		c.stop()
		await srv.close()
	}
})

test('an engine without /status (HTTP 404) never reads as connected, and keeps retrying', async () => {
	const srv = await mockStatusServer(() => {})
	const c = new StatusClient({ url: `ws://127.0.0.1:${srv.port}/nope`, backoff: { initialMs: 20, maxMs: 40 } })
	const states = []
	const logs = []
	c.on('state', (s) => states.push(s))
	c.on('log', (lvl, m) => logs.push(m))
	c.start()
	await new Promise((r) => setTimeout(r, 250))
	c.stop()
	await srv.close()
	assert.ok(!states.includes('connected'))
	assert.ok(states.filter((s) => s === 'connecting').length >= 2)
	assert.equal(logs.filter((m) => /404/.test(m)).length, 1, 'the same failure is logged once')
})

test('rate is clamped to 1..20', () => {
	assert.equal(clampRate(0), 1)
	assert.equal(clampRate(5), 5)
	assert.equal(clampRate(99), 20)
	assert.equal(clampRate('x'), 5)
})
