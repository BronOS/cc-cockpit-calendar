'use strict'
// The day strip and the Today hour timeline (panels/timeline.js, free of the DOM): overlaps into
// lanes, the strip's cells (busy, not answered, free; declined and free events ignored), the span
// widening past 08:00..19:00 and stopping at 24:00, the now minute from the host's day clock (inside
// and outside the span, across a DST change), the least block height, the blocks' states, the Next
// line and the Today header's look at tomorrow. Example data only.
const test = require('node:test')
const assert = require('node:assert/strict')
const TL = require('../panels/timeline')

const H = 3600000
const DAY0 = Date.parse('2026-11-02T23:00:00Z') // 00:00 Tue 3 Nov in Berlin
const CLOCK = [{ at: DAY0, min: 0 }]
/** A timed row as the host sends it: wall minutes and the matching instants (a plain day). */
function row(key, from, to, o = {}) {
  return { key, title: o.title || key, from, to, start: DAY0 + from * 60000, end: DAY0 + to * 60000, time: `${TL.hourText(from)}–${TL.hourText(to)}`, busy: true, response: 'accepted', mine: true, type: 'default', conflicts: [], ...o }
}

test('lanes: a run of overlapping events side by side, each in the first lane free; a gap starts a new run', () => {
  const place = TL.lanes([
    { key: 'a', from: 600, to: 660 },
    { key: 'b', from: 630, to: 690 },
    { key: 'c', from: 665, to: 700 }, // a's lane is free again at 11:05
    { key: 'd', from: 720, to: 750 }, // after the run: one lane
  ])
  assert.deepEqual(Object.fromEntries(place), { a: [0, 2], b: [1, 2], c: [0, 2], d: [0, 1] })
  // Three at once: three lanes; a long one holds its lane against later ones.
  const three = TL.lanes([{ key: 'x', from: 540, to: 720 }, { key: 'y', from: 600, to: 630 }, { key: 'z', from: 610, to: 640 }, { key: 'w', from: 635, to: 650 }])
  assert.deepEqual(Object.fromEntries(three), { x: [0, 3], y: [1, 3], z: [2, 3], w: [1, 3] })
  // Back to back is no overlap.
  assert.deepEqual(Object.fromEntries(TL.lanes([{ key: 'p', from: 600, to: 630 }, { key: 'q', from: 630, to: 660 }])), { p: [0, 1], q: [0, 1] })
  // The longer of two equal starts goes first.
  assert.deepEqual(Object.fromEntries(TL.lanes([{ key: 's', from: 600, to: 615 }, { key: 'l', from: 600, to: 700 }])), { l: [0, 2], s: [1, 2] })
})

test('blocks: positions from lo at 46 px an hour, at least 20 px tall, and a short one counts 30 min for the lanes', () => {
  const blocks = TL.placeBlocks([row('b', 615, 660), row('a', 600, 610)], 480)
  assert.deepEqual(blocks.map((b) => [b.row.key, b.top, b.height, b.lane, b.lanes]), [
    ['a', (120 / 60) * 46 + 1, 20, 0, 2], // 10 minutes: 20 px, and 10:15 is inside its drawn 30 min
    ['b', (135 / 60) * 46 + 1, (45 / 60) * 46 - 3, 1, 2],
  ])
  // An event with no length is still a block.
  assert.equal(TL.placeBlocks([row('z', 600, 600)], 480)[0].height, TL.TL_MIN_PX)
  assert.deepEqual(TL.laneLook(2), { narrow: false, dense: false })
  assert.deepEqual(TL.laneLook(3), { narrow: true, dense: false })
  assert.deepEqual(TL.laneLook(4), { narrow: true, dense: true })
})

test('the span: 08:00..19:00 at least, widened to whole hours around the events, never past 24:00', () => {
  assert.deepEqual(TL.dayRange([]), { lo: 480, hi: 1140 })
  assert.deepEqual(TL.dayRange([row('a', 600, 660)]), { lo: 480, hi: 1140 })
  assert.deepEqual(TL.dayRange([row('early', 435, 450), row('late', 1140, 1170)]), { lo: 420, hi: 1200 })
  // Across midnight: the host ends it at 1440, the span stops there; one from the day before starts at 0.
  assert.deepEqual(TL.dayRange([row('deploy', 1380, 1440)]), { lo: 480, hi: 1440 })
  assert.deepEqual(TL.dayRange([row('night', 0, 60)]), { lo: 0, hi: 1140 })
  assert.equal(TL.hourText(1440), '24:00')
  assert.equal(TL.hourText(570), '09:30')
})

test('strip cells: busy, not answered only when every event there waits, declined and free events ignored', () => {
  const timed = [
    row('meet', 540, 600), // 09:00-10:00 busy
    row('ask', 600, 630, { response: 'needsAction' }), // 10:00-10:30 not answered
    row('mixed1', 630, 660, { response: 'needsAction' }),
    row('mixed2', 645, 660), // 10:30 cell: one answered -> busy
    row('no', 660, 720, { response: 'declined' }), // ignored
    row('free', 720, 780, { busy: false }), // transparent: ignored
    row('zero', 780, 780), // no length: ignored
  ]
  assert.deepEqual(TL.stripCells(timed, 480, 840), ['free', 'free', 'busy', 'busy', 'unanswered', 'busy', 'free', 'free', 'free', 'free', 'free', 'free'])
  // A half-hour cell is hit by any minute of it.
  assert.deepEqual(TL.stripCells([row('x', 495, 500)], 480, 540), ['busy', 'free'])
  assert.equal(TL.stripCells([], 480, 1140).length, 22)
  assert.deepEqual(TL.stripScale(480, 1140).map((t) => [t.text, Math.round(t.pct)]), [['08:00', 0], ['12:00', 36], ['16:00', 73], ['19:00', 100]])
  assert.deepEqual(TL.stripScale(420, 1140).map((t) => t.text), ['07:00', '12:00', '16:00', '19:00'], '08:00 is too close to 07:00')
})

test('now: the wall minute from the day clock, inside or outside the span; a DST day keeps the wall clock', () => {
  const m = TL.nowMinute(CLOCK, DAY0 + 9.5 * H)
  assert.equal(m, 570)
  assert.equal(TL.nowTop(m, 480, 1140), (90 / 60) * 46)
  assert.equal(TL.nowPct(m, 480, 1140), (90 / 660) * 100)
  assert.equal(TL.nowTop(TL.nowMinute(CLOCK, DAY0 + 7 * H), 480, 1140), null, 'before the span')
  assert.equal(TL.nowPct(TL.nowMinute(CLOCK, DAY0 + 19 * H), 480, 1140), null, 'the end is outside')
  assert.equal(TL.nowMinute(CLOCK, DAY0 - 1), null, 'before the day')
  assert.equal(TL.nowMinute([], DAY0), null)
  assert.equal(TL.nowMinute(undefined, DAY0), null)
  // Berlin 25 Oct: from 01:00 UTC the wall clock reads 02:00 again (anchor min 120).
  const dst = [{ at: Date.parse('2026-10-24T22:00:00Z'), min: 0 }, { at: Date.parse('2026-10-25T01:00:00Z'), min: 120 }]
  assert.equal(TL.nowMinute(dst, Date.parse('2026-10-25T00:30:00Z')), 150, '02:30 CEST')
  assert.equal(TL.nowMinute(dst, Date.parse('2026-10-25T09:00:00Z')), 600, '10:00 CET')
})

test('block states: past faded, the current one green with the time left, not answered amber, overlaps, Join', () => {
  const now = DAY0 + 11 * H
  const past = TL.blockState(row('a', 540, 600, { join: true }), now)
  assert.deepEqual([past.cls, past.note, past.join], [['ev', 'past'], 'done', false])
  const cur = TL.blockState(row('b', 630, 680, { join: true }), now)
  assert.deepEqual([cur.cls, cur.note, cur.join, cur.hot], [['ev', 'cur'], 'now · 20 min left', true, false])
  const ask = TL.blockState(row('c', 720, 750, { response: 'needsAction', conflicts: [{ title: 'x', time: '12:00–12:30' }] }), now)
  assert.deepEqual([ask.cls, ask.note, ask.hot], [['ev', 'unans'], 'in 1 h · ? not answered · ⚠ overlaps', true])
  const no = TL.blockState(row('d', 720, 750, { response: 'declined', join: true }), now)
  assert.deepEqual([no.cls, no.note, no.join, no.hot], [['ev', 'decl'], 'in 1 h · declined', false, false])
  assert.equal(TL.blockState(row('e', 720, 750, { response: 'tentative' }), now).note, 'in 1 h · maybe')
  assert.deepEqual(TL.blockState(row('f', 840, 960, { type: 'focusTime' }), now).cls, ['ev', 'focus'])
  // An over meeting that waited for an answer is just over.
  assert.deepEqual(TL.blockState(row('g', 540, 600, { response: 'needsAction' }), now).cls, ['ev', 'past'])
})

test('the Next line: meetings only, not declined, how many are left counting it', () => {
  const timed = [row('over', 540, 600), row('focus', 690, 720, { type: 'focusTime' }), row('no', 700, 730, { response: 'declined' }), row('review', 720, 780, { title: 'Design review' }), row('sync', 900, 930)]
  const now = DAY0 + 11 * H + 20 * 60000
  const n = TL.stripNext(timed, now)
  assert.equal(n.row.title, 'Design review')
  assert.equal(n.left, 2)
  assert.equal(TL.stripNextText(n, now), 'in 40 min · 2 left today')
  assert.deepEqual(TL.stripNext(timed, DAY0 + 20 * H), { row: null, left: 0 })
  assert.equal(TL.stripNextText({ row: null, left: 0 }, now), '')
})

test('the Today header looks at tomorrow: the count, the first timed event not declined, else an all-day one', () => {
  assert.equal(TL.tomorrowText({ rows: [row('demo', 600, 660, { title: 'Customer demo', time: '10:00–11:00' })], chips: [{ title: 'Home' }] }), 'Tomorrow: 2 events, first 10:00 Customer demo')
  assert.equal(TL.tomorrowText({ rows: [row('no', 540, 570, { response: 'declined', time: '09:00–09:30' }), row('b', 600, 630, { title: 'Standup', time: '10:00–10:30' })], chips: [] }), 'Tomorrow: 2 events, first 10:00 Standup')
  assert.equal(TL.tomorrowText({ rows: [], chips: [{ title: 'Company holiday' }] }), 'Tomorrow: 1 event, Company holiday (all day)')
  assert.equal(TL.tomorrowText({ rows: [row('night', 0, 60, { continued: true })], chips: [] }), 'Tomorrow: nothing', 'one going on from today is not tomorrow\'s')
  assert.equal(TL.tomorrowText(undefined), 'Tomorrow: nothing')
})
