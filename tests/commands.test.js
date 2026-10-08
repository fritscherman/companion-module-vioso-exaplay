'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const c = require('../src/lib/commands')

test('transport builds dotted lines from tcp-api.md', () => {
	assert.equal(c.transport('comp1', 'play').line, 'comp1.play')
	assert.equal(c.transport('comp1', 'pause').line, 'comp1.pause')
	assert.equal(c.transport(' comp1 ', 'stop').line, 'comp1.stop')
	assert.equal(c.transport('comp_lobby', 'next').line, 'comp_lobby.next')
	assert.equal(c.transport('comp_lobby', 'previous').line, 'comp_lobby.prev')
	assert.equal(c.transport('Main Show', 'play').line, 'Main Show.play')
	assert.equal(c.transport('comp1', 'next').relative, true)
	assert.equal(c.transport('comp1', 'play').relative, false)
	assert.equal(c.transport('comp1', 'rewind').ok, false)
})

test('a composition reference that would break the line is refused', () => {
	for (const bad of ['', '   ', 'a.b', 'Act 1, Scene 2', 'x>y', 'comp1\r\ncomp2.play', 'c\0', undefined, null, 3]) {
		const r = c.transport(bad, 'play')
		assert.equal(r.ok, false, JSON.stringify(bad))
		assert.ok(r.error)
	}
})

test('toggle needs a KNOWN state: unknown is never evidence', () => {
	assert.equal(c.toggleTransport('comp1', 'playing').line, 'comp1.pause')
	assert.equal(c.toggleTransport('comp1', 'paused').line, 'comp1.play')
	assert.equal(c.toggleTransport('comp1', 'stopped').line, 'comp1.play')
	assert.equal(c.toggleTransport('comp1', undefined).ok, false)
	assert.equal(c.toggleTransport('comp1', 'weird').ok, false)
})

test('cue go by index or name', () => {
	assert.equal(c.cueGo('comp_main', 3).line, 'comp_main.cue.go=3')
	assert.equal(c.cueGo('comp_main', '3').line, 'comp_main.cue.go=3')
	assert.equal(c.cueGo('comp_main', 'Blackout').line, 'comp_main.cue.go=Blackout')
	// commas are fine in a dotted argument
	assert.equal(c.cueGo('comp_main', 'Act 1, Scene 2').line, 'comp_main.cue.go=Act 1, Scene 2')
	assert.equal(c.cueGo('comp_main', '').ok, false)
	assert.equal(c.cueGo('comp_main', undefined).ok, false)
	assert.equal(c.cueGo('comp_main', 'a\nb').ok, false)
	assert.equal(c.cueGo('comp_main', 'go > there').ok, false)
	assert.equal(c.cueGo('a.b', '1').ok, false)
})

test('show mode over TCP', () => {
	assert.equal(c.showMode('on').line, 'system.showmode=on')
	assert.equal(c.showMode('off').line, 'system.showmode=off')
	assert.equal(c.showMode('toggle').line, 'system.showmode=toggle')
	assert.equal(c.showMode('maybe').ok, false)
})

test('raw lines: one per action, trimmed', () => {
	assert.equal(c.raw(' comp1.set:vol=80 ').line, 'comp1.set:vol=80')
	assert.equal(c.raw('').ok, false)
	assert.equal(c.raw('a\r\nb').ok, false)
	assert.equal(c.raw(undefined).ok, false)
})

test('list commands are recognised so END is awaited', () => {
	assert.equal(c.expectsList('get:complist'), true)
	assert.equal(c.expectsList('GET:COMPLIST'), true)
	assert.equal(c.expectsList('get:cuelist,comp1'), true)
	assert.equal(c.expectsList('comp1.get:cuelist'), true)
	assert.equal(c.expectsList('comp1.get:cuename'), false)
	assert.equal(c.expectsList('comp1.play'), false)
	assert.equal(c.expectsList('hello'), false)
})

test('OSC switches: address and typed args', () => {
	assert.deepEqual(c.oscSwitch('exaplay', 'blank', 'on'), {
		ok: true,
		address: '/exaplay/global/videomute',
		args: [{ type: 's', value: 'on' }],
	})
	assert.deepEqual(c.oscSwitch('exaplay', 'blank', 'toggle', '3').args, [
		{ type: 's', value: 'toggle' },
		{ type: 'f', value: 3 },
	])
	assert.deepEqual(c.oscSwitch('exaplay', 'blank', 'off', 0).args[1], { type: 'f', value: 0 })
	assert.equal(c.oscSwitch('exaplay', 'blank', 'on', '').args.length, 1)
	assert.equal(c.oscSwitch('exaplay', 'blank', 'on', '61').ok, false)
	assert.equal(c.oscSwitch('exaplay', 'blank', 'on', '-1').ok, false)
	assert.equal(c.oscSwitch('exaplay', 'blank', 'on', 'abc').ok, false)
	assert.equal(c.oscSwitch('exaplay', 'audiomute', 'toggle').address, '/exaplay/global/audiomute')
	assert.equal(c.oscSwitch('exaplay', 'identify', 'on').address, '/exaplay/global/identify')
	assert.equal(c.oscSwitch('exaplay', 'outlines', 'off').address, '/exaplay/global/showguides')
	// fade only for blank
	assert.equal(c.oscSwitch('exaplay', 'identify', 'on', '3').args.length, 1)
	assert.equal(c.oscSwitch('exaplay', 'identify', 'sideways').ok, false)
	assert.equal(c.oscSwitch('exaplay', 'nope', 'on').ok, false)
	// prefix handling
	assert.equal(c.oscSwitch('', 'blank', 'on').address, '/global/videomute')
	assert.equal(c.oscSwitch('/show/', 'blank', 'on').address, '/show/global/videomute')
	assert.equal(c.oscSwitch('a/b', 'blank', 'on').ok, false)
	assert.equal(c.oscPlayAll('exaplay').address, '/exaplay/global/start')
	assert.deepEqual(c.oscPlayAll('exaplay').args, [])
})

test('command button: the request NAMES the button, never carries a script', () => {
	const r = c.httpFireButton(' control_script_1727800000000 ')
	assert.equal(r.path, '/control/fire')
	assert.equal(r.method, 'POST')
	assert.deepEqual(JSON.parse(r.body), { id: 'control_script_1727800000000' })
	assert.deepEqual(Object.keys(JSON.parse(r.body)), ['id'])
	assert.equal(c.httpFireButton('').ok, false)
	assert.equal(c.httpFireButton('a\nb').ok, false)
	assert.equal(c.httpFireButton(undefined).ok, false)
})

test('command button and stop-all answers', () => {
	assert.deepEqual(c.parseFireResponse(200, '{"ok":true,"lines":3}'), { ok: true, lines: 3 })
	assert.deepEqual(c.parseFireResponse(200, '{"ok":false,"reason":"still running"}'), { ok: false, error: 'still running' })
	assert.equal(c.parseFireResponse(400, '').ok, false)
	assert.match(c.parseFireResponse(503, '{"error":"loading"}').error, /loading/)
	assert.equal(c.parseFireResponse(200, 'not json').ok, false)
	assert.equal(c.parseFireResponse(500, '').error, 'HTTP 500')
	assert.deepEqual(c.parseStopAllResponse(200), { ok: true })
	assert.match(c.parseStopAllResponse(400).error, /project/)
	assert.match(c.parseStopAllResponse(503).error, /loading/)
	assert.deepEqual(c.httpStopAll(), { ok: true, method: 'POST', path: '/stop', body: null })
})

/* ------------------------------------------------------------------ 1.1 --- */

test('volume / opacity: set:vol / set:alpha 0–100 (clamped), reads the STORED value', () => {
	assert.equal(c.setLevel('comp1', 'volume', 80).line, 'comp1.set:vol=80')
	assert.equal(c.setLevel('comp1', 'volume', '37.5').line, 'comp1.set:vol=37.5')
	assert.equal(c.setLevel('comp1', 'volume', 140).line, 'comp1.set:vol=100')
	assert.equal(c.setLevel('comp1', 'opacity', -3).line, 'comp1.set:alpha=0')
	assert.equal(c.setLevel('comp1', 'opacity', 33.33333).line, 'comp1.set:alpha=33.333')
	assert.equal(c.setLevel('comp1', 'opacity', 'loud').ok, false)
	assert.equal(c.setLevel('comp1', 'opacity', '1e3').ok, false, 'no exponent forms')
	assert.equal(c.setLevel('a.b', 'volume', 1).ok, false)
	assert.equal(c.setLevel('comp1', 'gain', 1).ok, false)
	assert.equal(c.getLevel('comp1', 'volume').line, 'comp1.get:audio.volume')
	assert.equal(c.getLevel('comp1', 'opacity').line, 'comp1.get:alpha')
	assert.equal(c.parseNumberReply('37.5'), 37.5)
	assert.equal(c.parseNumberReply('80'), 80)
	assert.equal(c.parseNumberReply('abc'), undefined)
	assert.equal(c.parseNumberReply(undefined), undefined)
})

test('seek: set:time=, seconds or [h:]mm:ss', () => {
	assert.equal(c.parseTimeText('75'), 75)
	assert.equal(c.parseTimeText('1:15.5'), 75.5)
	assert.equal(c.parseTimeText('1:02:03'), 3723)
	assert.equal(c.parseTimeText('1:75'), undefined)
	assert.equal(c.parseTimeText('soon'), undefined)
	assert.equal(c.parseTimeText('-4'), undefined)
	assert.equal(c.parseTimeText(''), undefined)
	assert.equal(c.seekTime('comp1', '1:15.5').line, 'comp1.set:time=75.5')
	assert.equal(c.seekTime('comp1', 12.25).line, 'comp1.set:time=12.25')
	assert.equal(c.seekTime('comp1', -3).line, 'comp1.set:time=0')
	assert.equal(c.seekTime('comp1', 'x').ok, false)
	assert.equal(c.wireNumber(0.1 + 0.2), '0.3')
	assert.equal(c.wireNumber(5), '5')
})

test('loop: set:loop=on|off; get:loop reads 0/1', () => {
	assert.equal(c.setLoop('comp1', true).line, 'comp1.set:loop=on')
	assert.equal(c.setLoop('comp1', false).line, 'comp1.set:loop=off')
	assert.equal(c.setLoop('comp1', 'yes').ok, false)
	assert.equal(c.getLoop('comp1').line, 'comp1.get:loop')
	assert.equal(c.parseLoopReply('1'), true)
	assert.equal(c.parseLoopReply('0'), false)
	assert.equal(c.parseLoopReply('maybe'), undefined)
})

test('catalog reads: complist, get:type, get:cuelist (a list)', () => {
	assert.equal(c.compList().line, 'get:complist')
	assert.equal(c.compType('comp1').line, 'comp1.get:type')
	assert.equal(c.cueList('comp1').line, 'comp1.get:cuelist')
	assert.equal(c.expectsList(c.cueList('comp1').line), true)
	assert.equal(c.expectsList(c.compList().line), true)
	assert.equal(c.cueList('a.b').ok, false)
})

test('system verbs: Spaces page and a CONFIRMED restart', () => {
	assert.equal(c.showPage('next').line, 'system.showpage=next')
	assert.equal(c.showPage(' Intro ').line, 'system.showpage=Intro')
	assert.equal(c.showPage(3).line, 'system.showpage=3')
	assert.equal(c.showPage('').ok, false)
	assert.equal(c.showPage('a>b').ok, false)
	assert.equal(c.restartEngine('project', true).line, 'system.restart')
	assert.equal(c.restartEngine('clean', true).line, 'system.restart=clean')
	assert.equal(c.restartEngine('project', false).ok, false)
	assert.equal(c.restartEngine('project', 'true').ok, false, 'only a real tick confirms')
	assert.equal(c.restartEngine('reboot', true).ok, false, 'never the machine')
})

test('Inputs: track,<channel>,… in the documented forms', () => {
	assert.equal(c.track('wand', 'xy', '0.25', '0.75').line, 'track,wand,0.25,0.75')
	assert.equal(c.track('wand', 'xy', 0.25, '').line, 'track,wand,0.25')
	assert.equal(c.track(' radar3 ', 'x', '0.4').line, 'track,radar3,x,0.4')
	assert.equal(c.track('radar3', 'y', 1).line, 'track,radar3,y,1')
	assert.equal(c.track('btn', 'click').line, 'track,btn,click')
	assert.equal(c.track('btn', 'click', '0').line, 'track,btn,click,0')
	assert.equal(c.track('a,b', 'x', 1).ok, false)
	assert.equal(c.track('', 'x', 1).ok, false)
	assert.equal(c.track('a\nb', 'x', 1).ok, false)
	assert.equal(c.track('a', 'x', 'high').ok, false)
	assert.equal(c.track('a', 'z', 1).ok, false)
})

test('OSC: blank fade, Timeline frame, correction bypass, a free message to the engine', () => {
	assert.deepEqual(c.oscBlankFade('exaplay', '2.5'), { ok: true, address: '/exaplay/global/blankfade', args: [{ type: 'f', value: 2.5 }] })
	assert.equal(c.oscBlankFade('exaplay', '61').ok, false)
	assert.equal(c.oscBlankFade('exaplay', '').ok, false)
	assert.deepEqual(c.oscFrame('exaplay', 'comp1', '750'), { ok: true, address: '/exaplay/comp1/frame', args: [{ type: 'i', value: 750 }] })
	assert.equal(c.oscFrame('exaplay', 'Main Show', 1).address, '/exaplay/Main_Show/frame')
	assert.equal(c.oscFrame('', 'comp1', 1).address, '/comp1/frame')
	assert.equal(c.oscFrame('exaplay', 'comp1', '1.5').ok, false)
	assert.equal(c.oscFrame('exaplay', 'a/b', 1).ok, false)
	assert.equal(c.oscSwitch('exaplay', 'correctionbypass', 'toggle').address, '/exaplay/global/correctionbypass')
	assert.deepEqual(c.oscCustom('/exaplay/comp1/cue', 'i:5, f:0.75, s:main, 3, word').args, [
		{ type: 'i', value: 5 },
		{ type: 'f', value: 0.75 },
		{ type: 's', value: 'main' },
		{ type: 'f', value: 3 },
		{ type: 's', value: 'word' },
	])
	assert.deepEqual(c.oscCustom('/exaplay/global/start', '').args, [])
	assert.equal(c.oscCustom('exaplay/x', '').ok, false)
	assert.equal(c.oscCustom('/a b', '').ok, false)
	assert.equal(c.oscCustom('/a', 'i:1.5').ok, false)
})

test('HTTP: pjlink-all, project / global reads, master volume, Inputs groups, a free request', () => {
	assert.deepEqual(JSON.parse(c.httpPjlinkAll(true).body), { req: 'pjlink-all', parameter: '1' })
	assert.deepEqual(JSON.parse(c.httpPjlinkAll(false).body), { req: 'pjlink-all', parameter: '0' })
	assert.equal(c.httpPjlinkAll(false).path, '/cmd')
	assert.deepEqual(c.parsePjlinkAllResponse(200, '{"response":"OK","message":"OK,3/3"}'), { ok: true, okCount: 3, total: 3, message: '3/3 projectors' })
	assert.match(c.parsePjlinkAllResponse(200, '{"response":"OK","message":"OK,1/3"}').error, /only 1 of 3/)
	assert.match(c.parsePjlinkAllResponse(500, '{"response":"ERROR","message":"ERR,no_devices"}').error, /No PJLink projector/)
	assert.match(c.parsePjlinkAllResponse(503, '').error, /loading/)
	assert.equal(c.parsePjlinkAllResponse(400, '{"response":"ERROR","message":"No project loaded"}').error, 'No project loaded')

	assert.equal(c.httpReadProjectValues().path, '/data?type=exaObj&path=project&values')
	assert.equal(c.httpReadProjectValues().method, 'GET')
	assert.equal(c.httpReadGlobalValues().path, '/data?type=exaObj&path=global&values')
	assert.deepEqual(c.parseDataValues(200, '{"values":{"a":1},"revs":{}}'), { ok: true, values: { a: 1 } })
	assert.match(c.parseDataValues(200, '{"loading":true}').error, /loading/)
	assert.match(c.parseDataValues(404, '').error, /not found/)
	assert.equal(c.parseDataValues(200, 'null').ok, false)
	assert.equal(c.readMasterVolume({ 'audio-volume': 80 }), 80)
	assert.equal(c.readMasterVolume({}), undefined)

	const mv = c.httpSetMasterVolume('120')
	assert.equal(mv.path, '/data')
	assert.deepEqual(JSON.parse(mv.body), { type: 'exaObj', path: 'global', values: { 'audio-volume': 100 } })
	assert.equal(c.httpSetMasterVolume('x').ok, false)
	assert.deepEqual(c.parseDataWriteResponse(200), { ok: true })
	assert.match(c.parseDataWriteResponse(401).error, /rejected/)

	assert.deepEqual(JSON.parse(c.httpInputsGroups('group:scene2=on').body), { command: 'group:scene2=on' })
	assert.equal(c.httpInputsGroups('solo=scene2').ok, true)
	assert.equal(c.httpInputsGroups('all=off').ok, true)
	assert.equal(c.httpInputsGroups('BATCH>format c:').ok, false)
	assert.equal(c.httpInputsGroups('').ok, false)
	assert.deepEqual(c.parseOkErrorResponse(200, '{"ok":false,"error":"no such group"}'), { ok: false, error: 'no such group' })

	assert.deepEqual(c.httpCustom('post', '/cue/trigger', '{"name":"x"}'), { ok: true, method: 'POST', path: '/cue/trigger', body: '{"name":"x"}' })
	assert.equal(c.httpCustom('GET', '/data?type=exaObj&path=global&values', '').body, null)
	assert.equal(c.httpCustom('DELETE', '/x', '').ok, false)
	assert.equal(c.httpCustom('GET', '//evil.example/x', '').ok, false, 'never another host')
	assert.equal(c.httpCustom('GET', 'http://evil.example/x', '').ok, false)
	assert.equal(c.httpCustom('GET', '/a/../b', '').ok, false)
	assert.equal(c.httpCustom('POST', '/x', 'not json').ok, false)
	assert.equal(c.httpCustom('GET', '/x', '{}').ok, false)
})

test('the rig-wide switches as TCP lines (Exaplay 3.4)', () => {
	assert.deepEqual(c.tcpSwitch('blank', 'on'), { ok: true, line: 'system.blank=on', relative: false })
	assert.equal(c.tcpSwitch('blank', 'toggle', '3').line, 'system.blank=toggle,3')
	assert.equal(c.tcpSwitch('blank', 'off', 0).line, 'system.blank=off,0')
	assert.equal(c.tcpSwitch('blank', 'on', '').line, 'system.blank=on')
	assert.equal(c.tcpSwitch('blank', 'on', '61').ok, false)
	assert.equal(c.tcpSwitch('blank', 'on', 'abc').ok, false)
	assert.equal(c.tcpSwitch('audiomute', 'toggle').line, 'system.audiomute=toggle')
	assert.equal(c.tcpSwitch('identify', 'off').line, 'system.identify=off')
	assert.equal(c.tcpSwitch('identify', 'on', '3').line, 'system.identify=on', 'a fade belongs to the blank only')
	assert.equal(c.tcpSwitch('identify', 'sideways').ok, false)
	assert.equal(c.tcpSwitch('outlines', 'on').ok, false, 'Outlines have no TCP verb')
	assert.equal(c.tcpSwitchable('outlines'), false)
	assert.equal(c.tcpSwitchable('blank'), true)
	assert.equal(c.tcpBlankFade('2.5').line, 'system.blankfade=2.5')
	assert.equal(c.tcpBlankFade('70').ok, false)
	assert.equal(c.tcpPlayAll().line, 'system.playall')
	assert.equal(c.tcpStopAll().line, 'system.stopall')
})
