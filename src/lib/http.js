'use strict'
/** Minimal JSON-over-HTTP request to the engine (port 8123). No Companion dependency. */
const http = require('node:http')

/**
 * Resolves (never rejects) with { status, body } or { error }.
 * A timeout aborts the request; the caller reports it, it does not retry —
 * a command button that ran but whose answer was lost must not run twice.
 */
function request({ host, port, method = 'POST', path, body = null, timeoutMs = 3000 }) {
	return new Promise((resolve) => {
		const headers = {}
		if (body !== null) {
			headers['Content-Type'] = 'application/json'
			headers['Content-Length'] = Buffer.byteLength(body)
		} else headers['Content-Length'] = 0
		let done = false
		const finish = (r) => {
			if (done) return
			done = true
			resolve(r)
		}
		const req = http.request({ host, port, method, path, headers, timeout: timeoutMs }, (res) => {
			const chunks = []
			res.on('data', (c) => chunks.push(c))
			res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
			res.on('error', (e) => finish({ error: e.message }))
		})
		req.on('timeout', () => {
			req.destroy(new Error(`no answer within ${timeoutMs} ms — not resent`))
		})
		req.on('error', (e) => finish({ error: e.message }))
		if (body !== null) req.write(body)
		req.end()
	})
}

module.exports = { request }
