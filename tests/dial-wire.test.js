'use strict'
/**
 * A volume dial wired to the real TCP client and a mock engine: a fast burst
 * of detents reaches the engine as a few `set:vol=` lines ending on the right
 * value, with ONE `get:audio.volume` first — the shape a Stream Deck+ turn
 * produces on the wire.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { once } = require('node:events')
const { TcpClient } = require('../src/lib/tcp-client')
const { ValueDial } = require('../src/lib/dial')
const cmd = require('../src/lib/commands')

test('a burst of detents: one read, coalesced writes, the final value lands', async () => {
	let vol = 50
	const received = []
	const server = net.createServer((sock) => {
		let buf = ''
		sock.on('data', (d) => {
			buf += d
			let i
			while ((i = buf.indexOf('\r\n')) >= 0) {
				const line = buf.slice(0, i)
				buf = buf.slice(i + 2)
				received.push(line)
				// like the engine, a little slower than the hand
				setTimeout(() => {
					if (line === 'comp1.get:audio.volume') sock.write(`${vol}\r\n`)
					else if (line.startsWith('comp1.set:vol=')) {
						vol = Number(line.slice('comp1.set:vol='.length))
						sock.write('OK\r\n')
					} else if (line === 'hello') sock.write('hallo\r\n')
					else sock.write('ERR,unknown_command\r\n')
				}, 15)
			}
		})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const tcp = new TcpClient({ host: '127.0.0.1', port: server.address().port, replyTimeoutMs: 500 })
	tcp.start()
	await new Promise((r) => tcp.on('state', (s) => s === 'connected' && r()))
	try {
		const dial = new ValueDial({
			intervalMs: 10,
			read: async () => {
				const r = await tcp.send(cmd.getLevel('comp1', 'volume').line)
				return r.ok ? { ok: true, value: cmd.parseNumberReply(r.value) } : { ok: false, error: r.error }
			},
			write: (v) => tcp.send(cmd.setLevel('comp1', 'volume', v).line),
		})
		for (let i = 0; i < 20; i++) {
			dial.nudge(2)
			await new Promise((r) => setTimeout(r, 3))
		}
		await dial.idle()
		assert.equal(vol, 90, '50 + 20 × 2')
		assert.equal(dial.value, 90)
		const reads = received.filter((l) => l.includes('get:'))
		const writes = received.filter((l) => l.includes('set:vol='))
		assert.equal(reads.length, 1)
		assert.ok(writes.length < 20, `coalesced: ${writes.length} writes for 20 detents`)
		assert.equal(writes[writes.length - 1], 'comp1.set:vol=90')
		for (let i = 1; i < writes.length; i++) assert.ok(Number(writes[i].split('=')[1]) > Number(writes[i - 1].split('=')[1]))
	} finally {
		tcp.stop()
		await new Promise((r) => server.close(r))
	}
})
