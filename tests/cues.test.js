'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const q = require('../src/lib/cues')

test('get:type reply', () => {
	assert.equal(q.parseTypeReply('timeline'), 'timeline')
	assert.equal(q.parseTypeReply('cuelist'), 'playlist')
	assert.equal(q.parseTypeReply('composition'), 'other')
	assert.equal(q.parseTypeReply('Timeline '), 'timeline')
	assert.equal(q.parseTypeReply('ERR,command_failed'), undefined)
	assert.equal(q.parseTypeReply(undefined), undefined)
})

test('Timeline cue rows: the name is everything between the first and the LAST comma', () => {
	// the engine's own format: "{},{},{:.4f}" (Composition.cpp get:cuelist)
	const r = q.parseCueListRows('timeline', ['1,Intro,0.0000', '2,Act 1, Scene 2,30.5000', '7,,90.0000', 'junk', 'x,Name,1.0', '3,NoOffset'])
	assert.deepEqual(r.cues, [
		{ index: 1, name: 'Intro', offset: 0 },
		{ index: 2, name: 'Act 1, Scene 2', offset: 30.5 },
		{ index: 7, name: '', offset: 90 },
	])
	assert.equal(r.skipped, 3)
})

test('Playlist rows: the file starts at the first comma followed by an absolute path', () => {
	const r = q.parseCueListRows('playlist', [
		'1,Opening,/media/opening.mp4',
		'2,Act 1, Scene 2,C:\\Shows\\act1.mov',
		'3,Loop,\\\\nas\\media\\a,b.mov',
		'4,Gen, red,ndi://x',
		'5,NoFile,',
		'6,OnlyName',
	])
	assert.deepEqual(r.cues[0], { index: 1, name: 'Opening', file: '/media/opening.mp4', ambiguous: undefined })
	assert.equal(r.cues[1].name, 'Act 1, Scene 2')
	assert.equal(r.cues[1].file, 'C:\\Shows\\act1.mov')
	assert.equal(r.cues[1].ambiguous, true)
	assert.equal(r.cues[2].name, 'Loop')
	assert.equal(r.cues[2].file, '\\\\nas\\media\\a,b.mov')
	// nothing looks like a path: the last comma, flagged
	assert.equal(r.cues[3].name, 'Gen, red')
	assert.equal(r.cues[3].ambiguous, true)
	assert.equal(r.cues[4].name, 'NoFile')
	assert.equal(r.cues[4].file, '')
	assert.deepEqual(r.cues[5], { index: 6, name: 'OnlyName', file: undefined })
	assert.equal(r.skipped, 0)
	assert.equal(q.parseCueListRows('other', ['1,a,b']).skipped, 1)
})

const TL = {
	type: 'timeline',
	cues: [
		{ index: 5, name: 'Late', offset: 90 },
		{ index: 1, name: 'Intro', offset: 0 },
		{ index: 2, name: 'Scene A', offset: 30 },
	],
}
const PL = { type: 'playlist', cues: [{ index: 1, name: 'Opening' }, { index: 2, name: 'Act 1' }, { index: 3, name: 'Closing' }] }

test('ordered cues: a Timeline by time, a Playlist as listed', () => {
	assert.deepEqual(q.orderedCues(TL).map((c) => c.index), [1, 2, 5])
	assert.deepEqual(q.orderedCues(PL).map((c) => c.index), [1, 2, 3])
	assert.equal(q.orderedCues(undefined), undefined)
	assert.equal(q.orderedCues({ type: 'timeline' }), undefined)
})

test('find a cue by index or by name (case-insensitive)', () => {
	assert.equal(q.findCue(TL, '5').name, 'Late')
	assert.equal(q.findCue(TL, 5).name, 'Late')
	assert.equal(q.findCue(TL, 'scene a').index, 2)
	assert.equal(q.findCue(TL, '9'), undefined)
	assert.equal(q.findCue(undefined, '1'), undefined)
})

test('next cue: Timeline = smallest offset after the playhead (the engine rule)', () => {
	assert.equal(q.nextCue({ time: 10 }, TL).index, 2)
	assert.equal(q.nextCue({ time: 30 }, TL).index, 5, 'a cue exactly at the playhead is passed')
	assert.equal(q.nextCue({ time: 95 }, TL), null)
	assert.equal(q.nextCue({ time: undefined }, TL), undefined)
	assert.equal(q.nextCue({ time: 1 }, undefined), undefined)
})

test('next cue: Playlist = the item after the playing one; stopped = the first', () => {
	assert.equal(q.nextCue({ cue: { index: 1, name: 'Opening' } }, PL).index, 2)
	assert.equal(q.nextCue({ cue: { index: 3 } }, PL), null)
	assert.equal(q.nextCue({ cue: null, state: 'stopped' }, PL).index, 1)
	assert.equal(q.nextCue({ cue: null, state: undefined }, PL), undefined)
	assert.equal(q.nextCue({ cue: undefined }, PL), undefined)
	assert.equal(q.nextCue({ cue: null, state: 'stopped' }, { type: 'playlist', cues: [] }), null)
})

test('current / next are tri-state: unknown is never "false"-with-confidence', () => {
	const comp = { time: 31, cue: { index: 2, name: 'Scene A' } }
	assert.equal(q.isCurrentCue(comp, TL, '2'), true)
	assert.equal(q.isCurrentCue(comp, TL, 'Scene A'), true)
	assert.equal(q.isCurrentCue(comp, undefined, 'scene a'), true, 'by the status name without a list')
	assert.equal(q.isCurrentCue(comp, TL, '1'), false)
	assert.equal(q.isCurrentCue({ cue: null }, TL, '1'), false)
	assert.equal(q.isCurrentCue({ cue: undefined }, TL, '1'), undefined)
	assert.equal(q.isCurrentCue(undefined, TL, '1'), undefined)
	assert.equal(q.isCurrentCue(comp, TL, ''), undefined)
	assert.equal(q.isNextCue(comp, TL, '5'), true)
	assert.equal(q.isNextCue(comp, TL, 'late'), true)
	assert.equal(q.isNextCue(comp, TL, '2'), false)
	assert.equal(q.isNextCue({ time: 99, cue: { index: 5 } }, TL, '5'), false)
	assert.equal(q.isNextCue(comp, undefined, '5'), undefined)
})

test('command buttons: id and label only, the script never leaves the project', () => {
	const items = [
		{ id: 'control_script_1', type: 'script', label: 'Command button', customLabel: 'Doors open', code: 'comp1.play\nTCP>10.0.0.9:1,x' },
		{ id: 'control_script_2', type: 'script', label: 'Blackout' },
		{ id: 'ctl_fader', type: 'value', label: 'Alpha' },
		{ id: 'control_script_1', type: 'script', label: 'duplicate' },
		{ id: 'bad\u00e9id', type: 'script', label: 'non-ASCII id (the engine refuses it)' },
		{ type: 'script', label: 'no id' },
		null,
		'junk',
	]
	const out = q.parseCommandButtons({ control_panel_items: items })
	assert.deepEqual(out, [
		{ id: 'control_script_1', label: 'Doors open' },
		{ id: 'control_script_2', label: 'Blackout' },
	])
	for (const b of out) assert.deepEqual(Object.keys(b), ['id', 'label'])
	// older projects store the list as a JSON string
	assert.deepEqual(q.parseCommandButtons({ control_panel_items: JSON.stringify(items.slice(1, 2)) }), [{ id: 'control_script_2', label: 'Blackout' }])
	// absent = the project has none (it WAS read)
	assert.deepEqual(q.parseCommandButtons({ name: 'x' }), [])
	assert.deepEqual(q.parseCommandButtons({ control_panel_items: null }), [])
	// present but unreadable = unknown
	assert.equal(q.parseCommandButtons({ control_panel_items: '{not json' }), undefined)
	assert.equal(q.parseCommandButtons({ control_panel_items: 7 }), undefined)
	assert.equal(q.parseCommandButtons(undefined), undefined)
	// a label falls back to the id
	assert.deepEqual(q.parseCommandButtons({ control_panel_items: [{ id: 'b', type: 'script', label: '  ' }] }), [{ id: 'b', label: 'b' }])
})
