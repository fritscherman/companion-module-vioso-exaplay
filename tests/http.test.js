'use strict'
/** HTTP requests against a local mock engine: command button and stop all. */
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { request } = require('../src/lib/http')
const cmd = require('../src/lib/commands')

test('POST /control/fire names the button; POST /stop has no body', async () => {
	const seen = []
	const srv = http.createServer((req, res) => {
		let body = ''
		req.on('data', (d) => (body += d))
		req.on('end', () => {
			seen.push({ method: req.method, url: req.url, body, type: req.headers['content-type'] })
			if (req.url === '/control/fire') {
				const { id } = JSON.parse(body)
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(id === 'btn1' ? '{"ok":true,"lines":3}' : '{"ok":false,"reason":"no such button"}')
			} else if (req.url === '/stop') {
				res.writeHead(200)
				res.end()
			} else if (req.url === '/slow') {
				setTimeout(() => res.end(), 500)
			}
		})
	})
	srv.listen(0, '127.0.0.1')
	await once(srv, 'listening')
	const port = srv.address().port
	try {
		const b = cmd.httpFireButton('btn1')
		const r = await request({ host: '127.0.0.1', port, ...b })
		assert.deepEqual(cmd.parseFireResponse(r.status, r.body), { ok: true, lines: 3 })
		assert.deepEqual(seen[0], { method: 'POST', url: '/control/fire', body: '{"id":"btn1"}', type: 'application/json' })

		const r2 = await request({ host: '127.0.0.1', port, ...cmd.httpFireButton('other') })
		assert.deepEqual(cmd.parseFireResponse(r2.status, r2.body), { ok: false, error: 'no such button' })

		const s = await request({ host: '127.0.0.1', port, ...cmd.httpStopAll() })
		assert.deepEqual(cmd.parseStopAllResponse(s.status), { ok: true })
		assert.equal(seen[2].body, '')

		const t = await request({ host: '127.0.0.1', port, method: 'POST', path: '/slow', timeoutMs: 100 })
		assert.match(t.error, /not resent/)
	} finally {
		srv.closeAllConnections?.()
		await new Promise((r) => srv.close(r))
	}
})

test('nothing listening reports an error, never throws', async () => {
	const srv = http.createServer().listen(0, '127.0.0.1')
	await once(srv, 'listening')
	const port = srv.address().port
	await new Promise((r) => srv.close(r))
	const r = await request({ host: '127.0.0.1', port, ...cmd.httpStopAll() })
	assert.ok(r.error)
})

test('pjlink-all, master volume read/write and Inputs groups against a mock engine', async () => {
	const seen = []
	let masterVolume = 80
	const srv = http.createServer((req, res) => {
		let body = ''
		req.on('data', (d) => (body += d))
		req.on('end', () => {
			seen.push({ method: req.method, url: req.url, body })
			const json = (status, o) => {
				res.writeHead(status, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify(o))
			}
			if (req.url === '/cmd') {
				const b = JSON.parse(body)
				if (b.req !== 'pjlink-all') return json(200, {})
				return b.parameter === '1' ? json(200, { response: 'OK', message: 'OK,2/2' }) : json(500, { response: 'ERROR', message: 'ERR,no_devices' })
			}
			if (req.method === 'GET' && req.url === '/data?type=exaObj&path=global&values') return json(200, { values: { 'audio-volume': masterVolume, 'show-mode': true }, revs: {} })
			if (req.method === 'POST' && req.url === '/data') {
				const b = JSON.parse(body)
				if (b.type !== 'exaObj' || b.path !== 'global') return json(404, {})
				masterVolume = b.values['audio-volume']
				res.writeHead(200)
				return res.end()
			}
			if (req.url === '/tracking') {
				const b = JSON.parse(body)
				return json(200, b.command === 'group:scene2=on' ? { ok: true } : { ok: false, error: 'unknown group' })
			}
			res.writeHead(404)
			res.end()
		})
	})
	srv.listen(0, '127.0.0.1')
	await once(srv, 'listening')
	const port = srv.address().port
	const go = (b) => request({ host: '127.0.0.1', port, ...b })
	try {
		let r = await go(cmd.httpPjlinkAll(true))
		assert.deepEqual(cmd.parsePjlinkAllResponse(r.status, r.body), { ok: true, okCount: 2, total: 2, message: '2/2 projectors' })
		r = await go(cmd.httpPjlinkAll(false))
		assert.match(cmd.parsePjlinkAllResponse(r.status, r.body).error, /No PJLink projector/)

		r = await go(cmd.httpReadGlobalValues())
		const d = cmd.parseDataValues(r.status, r.body)
		assert.equal(cmd.readMasterVolume(d.values), 80)
		r = await go(cmd.httpSetMasterVolume(55))
		assert.deepEqual(cmd.parseDataWriteResponse(r.status), { ok: true })
		assert.equal(masterVolume, 55)

		r = await go(cmd.httpInputsGroups('group:scene2=on'))
		assert.deepEqual(cmd.parseOkErrorResponse(r.status, r.body), { ok: true })
		r = await go(cmd.httpInputsGroups('group:nope=on'))
		assert.deepEqual(cmd.parseOkErrorResponse(r.status, r.body), { ok: false, error: 'unknown group' })

		r = await go(cmd.httpCustom('GET', '/data?type=exaObj&path=global&values', ''))
		assert.equal(r.status, 200)
		assert.equal(seen[seen.length - 1].body, '', 'a GET carries no body')
	} finally {
		srv.closeAllConnections?.()
		await new Promise((r) => srv.close(r))
	}
})
