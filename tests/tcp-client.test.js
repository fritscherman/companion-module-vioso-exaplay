'use strict'
/**
 * The TCP client against a local mock engine (a plain net.Server that speaks
 * the documented reply shapes). Nothing here talks to a real Exaplay.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { once } = require('node:events')
const { TcpClient } = require('../src/lib/tcp-client')

/** A scripted engine: handler(line, socket) writes the reply (or nothing). */
async function mockEngine(handler) {
	const received = []
	const sockets = new Set()
	const server = net.createServer((sock) => {
		sockets.add(sock)
		sock.on('close', () => sockets.delete(sock))
		let buf = ''
		// Like the engine: one line at a time, in order — a slow command delays every later reply.
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
		dropClients: () => sockets.forEach((s) => s.destroy()),
		close: () =>
			new Promise((r) => {
				sockets.forEach((s) => s.destroy())
				server.close(() => r())
			}),
	}
}

function engineReplies(line, sock) {
	const w = (s) => sock.write(s + '\r\n')
	if (line === 'hello') return w('hallo')
	if (line === 'get:complist') return w('comp_main,Main Show\r\ncomp_lobby,Lobby, Loop\r\nEND')
	if (line === 'comp_x.get:cuelist') return w('ERR,command_failed')
	if (line === 'comp_main.get:status') return w('1,42.1230,2527,2,0')
	if (line === 'comp_main.cue.go=NoSuchCue') return w('ERR,command_failed')
	if (line.startsWith('drop:')) return // like a loading engine
	if (line.startsWith('late:')) return new Promise((r) => setTimeout(() => (w('OK'), r()), 150))
	if (line === 'split') {
		sock.write('O')
		return new Promise((r) => setTimeout(() => (sock.write('K\r\n'), r()), 20))
	}
	w('OK')
}

async function connected(client) {
	if (client.state === 'connected') return
	await new Promise((resolve) => {
		const on = (s) => {
			if (s === 'connected') {
				client.off('state', on)
				resolve()
			}
		}
		client.on('state', on)
	})
}

test('commands, values, errors and lists over one connection, CRLF framed', async () => {
	const eng = await mockEngine(engineReplies)
	const c = new TcpClient({ host: '127.0.0.1', port: eng.port, replyTimeoutMs: 500 })
	c.start()
	await connected(c)
	try {
		assert.deepEqual(await c.send('comp_main.play'), { ok: true, reply: 'OK', value: undefined })
		assert.equal((await c.send('comp_main.get:status')).value, '1,42.1230,2527,2,0')
		const err = await c.send('comp_main.cue.go=NoSuchCue')
		assert.equal(err.ok, false)
		assert.equal(err.reply, 'ERR,command_failed')
		assert.deepEqual((await c.send('get:complist')).rows, ['comp_main,Main Show', 'comp_lobby,Lobby, Loop'])
		assert.equal((await c.send('comp_x.get:cuelist')).ok, false)
		assert.equal((await c.send('split')).reply, 'OK')
		// several at once: answered in order, one in flight
		const all = await Promise.all(['comp_main.play', 'comp_main.get:status', 'comp_main.stop'].map((l) => c.send(l)))
		assert.deepEqual(all.map((r) => r.reply), ['OK', '1,42.1230,2527,2,0', 'OK'])
		assert.deepEqual(eng.received.slice(-3), ['comp_main.play', 'comp_main.get:status', 'comp_main.stop'])
	} finally {
		c.stop()
		await eng.close()
	}
})

test('a dropped command fails, is NOT resent, and the link re-syncs with hello before the next one', async () => {
	const eng = await mockEngine(engineReplies)
	const c = new TcpClient({ host: '127.0.0.1', port: eng.port, replyTimeoutMs: 100 })
	c.start()
	await connected(c)
	try {
		const r = await c.send('drop:comp_lobby.next')
		assert.equal(r.ok, false)
		assert.match(r.error, /not resent/)
		// a late reply to a timed-out command must not be read as the next answer
		const late = await c.send('late:comp_main.play')
		assert.equal(late.ok, false)
		const next = await c.send('comp_main.get:status')
		assert.equal(next.value, '1,42.1230,2527,2,0')
		assert.equal(eng.received.filter((l) => l === 'drop:comp_lobby.next').length, 1)
		assert.ok(eng.received.includes('hello'), 'resync probe sent')
	} finally {
		c.stop()
		await eng.close()
	}
})

test('a command while disconnected fails at once; the client reconnects with backoff', async () => {
	const eng = await mockEngine(engineReplies)
	const states = []
	const c = new TcpClient({ host: '127.0.0.1', port: eng.port, replyTimeoutMs: 300, backoff: { initialMs: 50, maxMs: 200 } })
	c.on('state', (s) => states.push(s))
	c.start()
	await connected(c)
	try {
		eng.dropClients()
		await new Promise((r) => {
			const on = (s) => s === 'disconnected' && (c.off('state', on), r())
			c.on('state', on)
		})
		const r = await c.send('comp_main.play')
		assert.equal(r.ok, false)
		assert.match(r.error, /not connected/)
		await connected(c)
		assert.equal((await c.send('comp_main.play')).ok, true)
		assert.deepEqual(states.slice(0, 4), ['connecting', 'connected', 'disconnected', 'connecting'])
	} finally {
		c.stop()
		await eng.close()
	}
})

test('an idle link is probed with hello; an unanswered probe reconnects', async () => {
	let mute = false
	const eng = await mockEngine((line, sock) => {
		if (mute) return
		engineReplies(line, sock)
	})
	const c = new TcpClient({ host: '127.0.0.1', port: eng.port, replyTimeoutMs: 100, keepAliveMs: 80, backoff: { initialMs: 30 } })
	const states = []
	c.on('state', (s) => states.push(s))
	c.start()
	await connected(c)
	try {
		await new Promise((r) => setTimeout(r, 200))
		assert.ok(eng.received.includes('hello'))
		assert.equal(c.state, 'connected')
		mute = true
		await new Promise((r) => setTimeout(r, 400))
		assert.ok(states.includes('disconnected'), states.join())
	} finally {
		c.stop()
		await eng.close()
	}
})

test('nothing listening: connecting/disconnected, never connected', async () => {
	const srv = net.createServer().listen(0, '127.0.0.1')
	await once(srv, 'listening')
	const port = srv.address().port
	await new Promise((r) => srv.close(r))
	const c = new TcpClient({ host: '127.0.0.1', port, backoff: { initialMs: 20, maxMs: 40 } })
	const states = []
	c.on('state', (s) => states.push(s))
	c.start()
	await new Promise((r) => setTimeout(r, 150))
	c.stop()
	assert.ok(!states.includes('connected'))
	assert.ok(states.filter((s) => s === 'connecting').length >= 2, states.join())
})
