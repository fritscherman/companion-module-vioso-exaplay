'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { LineSplitter, parseReply, parseCompList } = require('../src/lib/reply')

test('line splitter handles CRLF, CR, LF, split chunks and empty lines', () => {
	const s = new LineSplitter()
	assert.deepEqual(s.push('OK\r\nERR,comm'), ['OK'])
	assert.deepEqual(s.push('and_failed\r'), [])
	assert.deepEqual(s.push('\nhallo\n\r\n'), ['ERR,command_failed', 'hallo'])
	assert.deepEqual(s.push(Buffer.from('a\rb\r\n')), ['a', 'b'])
	assert.deepEqual(s.push('Übergang\r\n'), ['Übergang'])
})

test('only the documented ERR,<reason> form is an error', () => {
	assert.deepEqual(parseReply('OK'), { kind: 'ok', text: 'OK' })
	assert.deepEqual(parseReply('OK,3/3'), { kind: 'ok', text: 'OK,3/3', value: '3/3' })
	assert.deepEqual(parseReply('ERR,cue_not_found'), { kind: 'error', text: 'ERR,cue_not_found', reason: 'cue_not_found' })
	assert.equal(parseReply('ERRATA').kind, 'value')
	assert.equal(parseReply('1,42.1230,2527,2,0').value, '1,42.1230,2527,2,0')
})

test('complist rows: the name is everything after the first comma', () => {
	assert.deepEqual(parseCompList(['comp_main,Main Show', 'comp2,Act 1, Scene 2', 'junk', ',x']), [
		{ id: 'comp_main', name: 'Main Show' },
		{ id: 'comp2', name: 'Act 1, Scene 2' },
	])
})
