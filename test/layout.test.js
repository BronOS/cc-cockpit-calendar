'use strict'
// The panel's layout (lib/layout.js) over the example week, as the clock moves: Now / Next with the
// join window, Today with the past folded, Tomorrow, the Invitations lane (a series as one row), the
// Upcoming list and its settings, all-day spans, declined events, the badge, and answers on their way.
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildView, withPending, dayOf, placeOf, allDayText } = require('../dist/lib/layout')
const T = require('../dist/lib/time')
const { compactEvent, mergeEvents, findConflicts } = require('../dist/lib/model')
const { readSettings } = require('../dist/lib/settings')
const { world, ev, NOW, ME, TZ } = require('./fakes')

const PRIMARY = { id: ME, name: ME, color: '#4285f4', primary: true }
const at = (hm, day = '2026-11-03') => Date.parse(`${day}T${hm}:00+01:00`)

function agenda(extra = []) {
  const w = world()
  const list = [...w.events[ME], ...extra].map((raw) => compactEvent(raw, { cal: PRIMARY, me: ME, tz: TZ })).filter(Boolean)
  const events = mergeEvents([list])
  return { events, conflicts: findConflicts(events) }
}
function view(now, settings = {}, o = {}) {
  const a = o.agenda || agenda(o.extra)
  return buildView({ events: a.events, conflicts: a.conflicts, now, tz: o.tz || TZ, cfg: readSettings(settings).cfg, pending: o.pending })
}
const titles = (rows) => rows.map((r) => r.title)

test('09:00: Next is the standup in 30 min (not joinable yet), Today folds the early sync, declined lunch hidden', () => {
  const v = view(NOW)
  assert.deepEqual(v.now, [])
  assert.equal(v.next.title, 'Standup')
  assert.equal(v.next.dayLabel, 'today')
  assert.equal(v.next.time, '09:30–09:45')
  assert.equal(v.next.join, true)
  assert.equal(v.next.joinable, false)
  assert.equal(v.head.join, null)
  assert.equal(v.head.next.title, 'Standup')
  assert.equal(v.today.day, '2026-11-03')
  assert.deepEqual(titles(v.today.chips), ['Home'])
  assert.deepEqual(titles(v.today.rows), ['Early sync', 'Standup', 'Design review ACME-12', 'Vendor call', 'Focus time'])
  assert.equal(v.today.past, 1)
  assert.equal(v.today.rows[0].past, true)
  assert.ok(!titles(v.today.rows).includes('Offsite lunch'))
  assert.deepEqual(titles(v.tomorrow.rows), ['Customer demo', 'Budget planning'])
  const review = v.today.rows.find((r) => r.title === 'Design review ACME-12')
  assert.deepEqual(review.conflicts, [{ title: 'Vendor call', time: '11:30–12:15' }])
  assert.equal(v.counts.conflicts, 2)
})

test('the join window: joinEarlyMinutes before the start until the end; Now while it runs', () => {
  const early = view(at('09:21'))
  assert.equal(early.next.joinable, true)
  assert.equal(early.head.join.title, 'Standup')
  assert.equal(view(at('09:19')).next.joinable, false)
  assert.equal(view(at('09:19'), { joinEarlyMinutes: 15 }).next.joinable, true)
  const running = view(at('09:35'))
  assert.deepEqual(titles(running.now), ['Standup'])
  assert.equal(running.now[0].running, true)
  assert.equal(running.now[0].joinable, true)
  assert.equal(running.head.now.title, 'Standup')
  assert.equal(running.head.join.title, 'Standup')
  assert.equal(running.next.title, 'Design review ACME-12')
  assert.equal(running.today.past, 1, 'a running meeting never folds')
  const after = view(at('09:46'))
  assert.deepEqual(after.now, [])
  assert.equal(after.today.past, 2)
  // Two meetings at once (the overlap): both are Now.
  assert.deepEqual(titles(view(at('11:40')).now), ['Design review ACME-12', 'Vendor call'])
})

test('focus time, working location and a declined meeting are never Now / Next; after the last one: tomorrow\'s', () => {
  const v = view(at('13:45'))
  assert.equal(v.next.title, 'Customer demo')
  assert.equal(v.next.dayLabel, 'tomorrow')
  assert.equal(v.head.next, null)
  assert.equal(v.head.tomorrowFirst.title, 'Customer demo')
  assert.deepEqual(view(at('14:30')).now, [], 'focus time is running but is not a meeting')
  assert.equal(view(at('15:00', '2026-11-04')).next.dayLabel, 'tomorrow')
  const far = view(at('11:00', '2026-11-05'))
  assert.equal(far.next.title, 'Planning')
  assert.equal(far.next.dayLabel, 'Mon 9')
})

test('showDeclined: the declined lunch is back (marked declined), still never Next or a conflict', () => {
  const v = view(at('12:20'), { showDeclined: true })
  const lunch = v.today.rows.find((r) => r.title === 'Offsite lunch')
  assert.equal(lunch.response, 'declined')
  assert.notEqual(v.next && v.next.title, 'Offsite lunch')
  assert.deepEqual(lunch.conflicts, [])
})

test('the show* settings: working location and birthdays off', () => {
  const birthday = { ...ev('bd1', '2026-11-03', '00:00', '00:00', { title: 'Ann Example\'s birthday', type: 'birthday' }), start: { date: '2026-11-03' }, end: { date: '2026-11-04' } }
  const v = view(NOW, {}, { extra: [birthday] })
  assert.deepEqual(titles(v.today.chips).sort(), ['Ann Example\'s birthday', 'Home'])
  assert.deepEqual(titles(view(NOW, { showWorkingLocation: false, showBirthdays: false }, { extra: [birthday] }).today.chips), [])
})

test('Invitations: open invitations not yet over, a recurring one as one row; the badge counts them', () => {
  const v = view(NOW)
  assert.deepEqual(v.invitations.map((r) => [r.title, r.when]), [
    ['Budget planning', 'Wed 4 14:00–15:00'],
    ['Weekly 1:1', 'repeats · next Thu 5 10:00–10:30 · 2 in reach'],
  ])
  const series = v.invitations[1]
  assert.match(series.key, /^series:[a-f0-9]{16}$/)
  assert.equal(series.series.id, 'weekly11')
  assert.equal(series.series.count, 2)
  assert.equal(series.series.next, v.upcoming.rows.find((r) => r.title === 'Weekly 1:1').key)
  assert.equal(v.badge, 2)
  assert.equal(v.counts.invitations, 2)
  // After the first occurrence and the budget meeting: one occurrence left, the next one.
  const later = view(at('11:00', '2026-11-05'))
  assert.deepEqual(later.invitations.map((r) => r.when), ['repeats · next Thu 12 10:00–10:30'])
  assert.equal(later.badge, 1)
  assert.equal(view(at('11:00', '2026-11-12')).badge, 0)
})

test('an answer on its way: the row takes the answer at once and leaves Invitations; a series answer covers every occurrence', () => {
  const pending = { 'series:me@example.com:weekly11': { answer: 'accepted', cal: ME, id: 'weekly11', series: true, state: 'pending' } }
  const v = view(NOW, {}, { pending })
  assert.deepEqual(titles(v.invitations), ['Budget planning'])
  assert.equal(v.badge, 1)
  const weekly = v.upcoming.rows.filter((r) => r.title === 'Weekly 1:1')
  assert.equal(weekly.length, 2)
  assert.ok(weekly.every((r) => r.response === 'accepted' && r.pending))
  // One occurrence only: the other stays an invitation.
  const one = view(NOW, {}, { pending: { 'one:me@example.com:weekly11_20261105T090000Z': { answer: 'declined', cal: ME, id: 'weekly11_20261105T090000Z', series: false, state: 'done' } } })
  assert.deepEqual(one.invitations.map((r) => r.when), ['Wed 4 14:00–15:00', 'repeats · next Thu 12 10:00–10:30'])
  assert.ok(!one.upcoming.rows.some((r) => r.key === v.upcoming.rows.find((x) => x.day === '2026-11-05').key), 'declined and showDeclined off: the occurrence is hidden')
  // withPending only matches its own calendar.
  const a = agenda()
  const other = withPending(a.events, { x: { answer: 'accepted', cal: 'other@example.com', id: 'weekly11', series: true, state: 'pending' } })
  assert.equal(other.filter((e) => e.invitation).length, 3)
})

test('Upcoming: after tomorrow, within upcomingDays, at most upcomingCount, one compact line each', () => {
  const v = view(NOW)
  assert.deepEqual(v.upcoming.rows.map((r) => r.line), ['Thu 5 · 10:00 · Weekly 1:1', 'Fri 6 · all day · Company holiday', 'Mon 9 · 13:00 · Planning', 'Tue 10 · all day, 3 days · Acme conference', 'Thu 12 · 10:00 · Weekly 1:1'])
  assert.equal(v.upcoming.more, 0)
  assert.equal(v.upcoming.days, 14)
  assert.ok(!v.upcoming.rows.some((r) => r.day === '2026-11-03' || r.day === '2026-11-04'), 'today and tomorrow have their own sections')
  const two = view(NOW, { upcomingCount: 2 })
  assert.deepEqual(two.upcoming.rows.map((r) => r.title), ['Weekly 1:1', 'Company holiday'])
  assert.equal(two.upcoming.more, 3)
  assert.equal(two.counts.upcoming, 5)
  const short = view(NOW, { upcomingDays: 3 })
  assert.deepEqual(short.upcoming.rows.map((r) => r.day), ['2026-11-05', '2026-11-06'])
  assert.equal(short.upcoming.days, 3)
})

test('all-day spans: a chip on each of its days ("day 2 of 3"); an event across midnight continues into the next day', () => {
  const a = agenda([ev('late1', '2026-11-04', '23:00', '23:30', { title: 'Late deploy', extra: { end: { dateTime: '2026-11-05T01:00:00+01:00' } } })])
  const ctx = { tz: TZ, now: NOW, conflicts: a.conflicts, earlyMs: 600000 }
  assert.deepEqual(dayOf(a.events, '2026-11-11', ctx).chips.map((c) => [c.title, c.time]), [['Acme conference', 'day 2 of 3']])
  assert.deepEqual(dayOf(a.events, '2026-11-13', ctx).chips, [], 'the end date is exclusive')
  const thu = dayOf(a.events, '2026-11-05', ctx)
  const late = thu.rows.find((r) => r.title === 'Late deploy')
  assert.equal(late.continued, true)
  assert.equal(late.time, '23:00–Thu 5 01:00')
  assert.equal(allDayText({ startDate: '2026-11-06', endDate: '2026-11-07' }), 'all day')
})

test('out of office: the card says until when; a zone change moves the days (New York)', () => {
  const ooo = ev('ooo1', '2026-11-03', '08:00', '18:00', { title: 'Out of office', type: 'outOfOffice' })
  const v = view(NOW, {}, { extra: [ooo] })
  assert.deepEqual(v.ooo, { title: 'Out of office', until: at('18:00'), untilText: '18:00' })
  assert.equal(v.next.title, 'Standup', 'out of office is not a meeting')
  const ny = view(NOW, {}, { tz: 'America/New_York' })
  assert.equal(ny.today.day, '2026-11-03')
  assert.equal(ny.today.rows.find((r) => r.title === 'Standup').time, '03:30–03:45')
  assert.equal(ny.next.time, '03:30–03:45')
  // At 00:30 Berlin it is Wednesday there, still Tuesday evening in New York.
  assert.equal(view(at('00:30', '2026-11-04')).today.day, '2026-11-04')
  assert.equal(view(at('00:30', '2026-11-04'), {}, { tz: 'America/New_York' }).today.day, '2026-11-03')
})

test('the timeline places: wall minutes of the display zone, an event across midnight ends at 24:00 and goes on from 0', () => {
  const a = agenda([ev('late1', '2026-11-04', '23:00', '23:30', { title: 'Late deploy', extra: { end: { dateTime: '2026-11-05T01:00:00+01:00' } } })])
  const ctx = { tz: TZ, now: NOW, conflicts: a.conflicts, earlyMs: 600000 }
  const today = view(NOW).today
  assert.deepEqual(today.rows.map((r) => [r.title, r.from, r.to]), [['Early sync', 420, 450], ['Standup', 570, 585], ['Design review ACME-12', 660, 720], ['Vendor call', 690, 735], ['Focus time', 840, 960]])
  assert.ok(today.chips.every((c) => c.from === undefined), 'chips are not on the timeline')
  assert.deepEqual(today.clock, [{ at: T.startOfDay('2026-11-03', TZ), min: 0 }])
  const late = (key) => dayOf(a.events, key, ctx).rows.find((r) => r.title === 'Late deploy')
  assert.deepEqual([late('2026-11-04').from, late('2026-11-04').to], [1380, 1440])
  assert.deepEqual([late('2026-11-05').from, late('2026-11-05').to], [0, 60])
  // The same day in New York: the minutes follow the zone.
  const ny = view(NOW, {}, { tz: 'America/New_York' }).today.rows.find((r) => r.title === 'Standup')
  assert.deepEqual([ny.from, ny.to], [210, 225])
  // No end given: as long as nothing (the page draws it at the least height).
  assert.deepEqual(placeOf({ start: at('10:00'), end: at('10:00') }, T.startOfDay('2026-11-03', TZ), T.startOfDay('2026-11-04', TZ), TZ), { from: 600, to: 600 })
})

test('the day clock: one anchor on a plain day, a second at a DST change, to the minute', () => {
  assert.deepEqual(T.clockAnchors('2026-11-03', TZ), [{ at: Date.parse('2026-11-02T23:00:00Z'), min: 0 }])
  // Berlin, 25 Oct 2026: 03:00 CEST becomes 02:00 CET at 01:00 UTC.
  assert.deepEqual(T.clockAnchors('2026-10-25', TZ), [{ at: Date.parse('2026-10-24T22:00:00Z'), min: 0 }, { at: Date.parse('2026-10-25T01:00:00Z'), min: 120 }])
  // 29 Mar 2026: 02:00 CET becomes 03:00 CEST.
  assert.deepEqual(T.clockAnchors('2026-03-29', TZ), [{ at: Date.parse('2026-03-28T23:00:00Z'), min: 0 }, { at: Date.parse('2026-03-29T01:00:00Z'), min: 180 }])
  assert.equal(T.minuteOfDay(Date.parse('2026-10-25T09:00:00Z'), TZ), 600)
})
