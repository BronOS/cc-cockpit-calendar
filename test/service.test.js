'use strict'
// The `calendar` service (lib/service.js and the host's provide): the shapes of day and upcoming,
// the caps, the declined rule, the https-only Meet link, bad arguments refused, `changed` after a
// poll and an RSVP, respond and open reaching the plugin's own paths, and an app without useAll.
const test = require('node:test')
const assert = require('node:assert/strict')
const svc = require('../dist/lib/service')
const T = require('../dist/lib/time')
const { fakeReviewer, TZ, NOW, ME } = require('./fakes')
const { boot, signedIn, settle } = require('./helpers')

const calendar = (b) => b.ctx.provided.calendar
const titles = (list) => list.map((e) => e.title)

test('day: today by default, in order, with the CalEvent shape; tomorrow counts and names the first', async () => {
  const b = await signedIn()
  const d = await calendar(b).day()
  assert.equal(d.date, '2026-11-03')
  assert.equal(d.state, 'ok')
  assert.equal(d.message, undefined)
  assert.deepEqual(titles(d.events), ['Early sync', 'Standup', 'Design review ACME-12', 'Vendor call', 'Focus time'])
  const standup = d.events.find((e) => e.title === 'Standup')
  assert.deepEqual(standup, { id: 'standup_20261103T083000Z', title: 'Standup', start: Date.parse('2026-11-03T09:30:00+01:00'), end: Date.parse('2026-11-03T09:45:00+01:00'), allDay: false, response: 'accepted', meetUrl: 'https://meet.google.com/abc-defg-hij' })
  assert.equal(d.events.find((e) => e.title === 'Vendor call').response, 'accepted', 'an organizer has accepted')
  assert.equal(d.events.find((e) => e.title === 'Vendor call').meetUrl, undefined)
  assert.deepEqual(Object.keys(standup).sort(), ['allDay', 'end', 'id', 'meetUrl', 'response', 'start', 'title'])
  assert.equal(d.tomorrow.count, 2)
  assert.equal(d.tomorrow.first.title, 'Customer demo')
  assert.ok(!titles(d.events).includes('Home'), 'the working location is not an event')
})

test('day: a date, an all-day event on every day it covers, needsAction, and a date outside the cache', async () => {
  const b = await signedIn()
  const calls = b.google.calls.length
  const wed = await calendar(b).day({ date: '2026-11-04' })
  assert.deepEqual(titles(wed.events), ['Customer demo', 'Budget planning'])
  assert.equal(wed.events[1].response, 'needsAction')
  assert.equal(wed.tomorrow.count, 1)
  const conf = await calendar(b).day({ date: '2026-11-11' })
  assert.deepEqual(titles(conf.events), ['Acme conference'], 'the middle day of a three-day all-day event')
  assert.equal(conf.events[0].allDay, true)
  assert.equal(conf.events[0].start, T.startOfDay('2026-11-10', TZ))
  for (const date of ['2026-11-02', '2027-01-01']) {
    const out = await calendar(b).day({ date })
    assert.deepEqual(out.events, [])
    assert.deepEqual(out.tomorrow, { count: 0 })
    assert.equal(out.date, date)
    assert.equal(out.state, 'ok')
    assert.match(out.message, /outside what the calendar has read/)
  }
  assert.equal(b.google.calls.length, calls, 'no Google call for a read')
})

test('day: bad options are refused', async () => {
  const b = await signedIn()
  for (const bad of [{ date: '2026-13-01' }, { date: 'today' }, { date: 20261103 }, { date: '2026-11-3' }, 'x', [1]]) {
    await assert.rejects(async () => calendar(b).day(bad), /^Error: calendar: /, JSON.stringify(bad))
  }
  assert.equal((await calendar(b).day(null)).date, '2026-11-03')
})

test('the declined rule: left out unless the plugin shows declined events', async () => {
  const off = await signedIn()
  assert.ok(!titles((await calendar(off).day()).events).includes('Offsite lunch'))
  assert.ok(!titles(await calendar(off).upcoming({ count: 20, days: 1 })).includes('Offsite lunch'))
  const on = await signedIn({ project: { showDeclined: true } })
  const lunch = (await calendar(on).day()).events.find((e) => e.title === 'Offsite lunch')
  assert.equal(lunch.response, 'declined')
  assert.ok(titles(await calendar(on).upcoming({ count: 20, days: 1 })).includes('Offsite lunch'))
})

test('upcoming: not over yet, soonest first, count clamped to 1..20 and days to 1..30', async () => {
  const b = await signedIn()
  const week = await calendar(b).upcoming({ count: 20, days: 7 })
  // At 09:00 Berlin: the early sync is over; the rest is in order, the all-day holiday on Fri included.
  assert.ok(!titles(week).includes('Early sync'))
  assert.deepEqual(titles(week).slice(0, 4), ['Standup', 'Design review ACME-12', 'Vendor call', 'Focus time'])
  assert.ok(titles(week).includes('Company holiday'))
  assert.ok(titles(week).includes('Planning'), 'Mon 9 13:00 is within 7 days of Tue 3 08:00Z')
  assert.ok(!titles(await calendar(b).upcoming({ count: 20, days: 3 })).includes('Planning'))
  assert.equal((await calendar(b).upcoming({ count: 2, days: 7 })).length, 2)
  assert.equal((await calendar(b).upcoming({ count: 0, days: 7 })).length, 1, 'count below 1 is 1')
  assert.equal((await calendar(b).upcoming({ count: 1000, days: 30 })).length <= 20, true)
  assert.equal((await calendar(b).upcoming({ count: 20, days: 0 })).length > 0, true, 'days below 1 is 1')
  assert.ok(titles(await calendar(b).upcoming({ count: 20, days: 1000 })).includes('Weekly 1:1'), 'days above 30 is 30')
  assert.equal((await calendar(b).upcoming()).length, 5, 'defaults')
  await assert.rejects(async () => calendar(b).upcoming('lots'), /calendar: the options are an object/)
})

test('svc.upcomingOptions and the clamps on their own', () => {
  assert.deepEqual(svc.upcomingOptions({ count: 99, days: 99 }), { count: 20, days: 30 })
  assert.deepEqual(svc.upcomingOptions({ count: -4, days: -1 }), { count: 1, days: 1 })
  assert.deepEqual(svc.upcomingOptions({ count: 'x', days: NaN }), { count: 5, days: 7 })
  assert.deepEqual(svc.upcomingOptions({ count: 2.9 }), { count: 2, days: 7 })
})

test('meetUrl: https only, anything else is dropped', () => {
  const ev = (join) => svc.calEvent({ id: 'a', title: 'T', start: 1, end: 2, allDay: false, response: 'accepted', join })
  assert.equal(ev('https://meet.example.com/abc-defg-hij').meetUrl, 'https://meet.example.com/abc-defg-hij')
  for (const bad of ['http://meet.example.com/x', 'javascript:alert(1)', 'tel:+1-555-0100', 'meet.example.com/x', '', null, undefined, 42, 'https://' + 'a'.repeat(3000)]) {
    assert.ok(!('meetUrl' in ev(bad)), String(bad).slice(0, 30))
  }
})

test('responseOf: organizer accepted, no entry none, Google\'s own words kept', () => {
  assert.equal(svc.responseOf({ response: 'organizer' }), 'accepted')
  assert.equal(svc.responseOf({ response: 'none' }), null)
  for (const r of ['accepted', 'tentative', 'declined', 'needsAction']) assert.equal(svc.responseOf({ response: r }), r)
})

test('respond: a bad answer or id is refused before any call; a good one is the plugin\'s RSVP', async () => {
  const b = await signedIn()
  const writes = b.google.writes.length
  for (const bad of ['yes', 'no', 'maybe', 'needsAction', 'Accepted', '', null, undefined, 1, {}, ['accepted']]) {
    await assert.rejects(calendar(b).respond('budget1', bad), /calendar: the answer is/, String(bad))
  }
  for (const bad of ['', 'a/b', '../x', 'x'.repeat(2000), null, 5, {}, 'ev with space']) {
    await assert.rejects(calendar(b).respond(bad, 'accepted'), /^Error: calendar: not an event id/, String(bad).slice(0, 20))
    await assert.rejects(calendar(b).open(bad), /^Error: calendar: not an event id/)
  }
  await assert.rejects(calendar(b).respond('nosuchevent', 'accepted'), /not in the last poll/)
  await assert.rejects(calendar(b).respond('vendor1', 'accepted'), /You organize/, 'the plugin\'s own rules apply')
  assert.equal(b.google.writes.length, writes)
  const r = await calendar(b).respond('budget1', 'tentative')
  assert.equal(r, undefined)
  await settle(b)
  assert.equal(b.google.writes.length, writes + 1)
  assert.equal(b.google.writes.at(-1).id, 'budget1')
  assert.deepEqual(b.google.writes.at(-1).body.attendees, [{ email: ME, responseStatus: 'tentative' }])
  const budget = (await calendar(b).day({ date: '2026-11-04' })).events.find((e) => e.title === 'Budget planning')
  assert.equal(budget.response, 'tentative')
})

test('respond: Google refuses it, the caller gets the reason', async () => {
  const b = await signedIn({ google: { fail: { patch: 500 } } })
  await assert.rejects(calendar(b).respond('budget1', 'accepted'), /^Error: calendar: Could not answer/)
  const budget = (await calendar(b).day({ date: '2026-11-04' })).events.find((e) => e.title === 'Budget planning')
  assert.equal(budget.response, 'needsAction', 'put back')
})

test('open: the event page the panel opens (the reviewer), by id', async () => {
  const reviewer = fakeReviewer()
  const b = await signedIn({ reviewer })
  await calendar(b).open('budget1')
  assert.equal(reviewer.calls.length, 1)
  assert.equal(reviewer.calls[0].title, 'Budget planning')
  await assert.rejects(calendar(b).open('nosuchevent'), /not in the last poll/)
})

test('changed: after a poll (ok or failed) and after an RSVP, with an empty payload', async () => {
  const b = await signedIn()
  const seen = () => b.ctx.emitted.filter((e) => e.name === 'calendar' && e.event === 'changed')
  assert.ok(seen().length >= 1, 'the first poll')
  assert.deepEqual(seen()[0].data, {})
  let n = seen().length
  await b.h.pollNow('test', true)
  assert.equal(seen().length, n + 1)
  n = seen().length
  await calendar(b).respond('budget1', 'accepted')
  assert.ok(seen().length >= n + 1, 'the answer')
  await settle(b)
  n = seen().length
  b.google.world.events[ME] = null // the next read fails
  await b.h.pollNow('test', true)
  assert.equal(seen().length, n + 1, 'a failed poll changes what the service says too')
})

test('states: signed out and not yet read are said, never an empty free day', async () => {
  const b = boot()
  await b.h.ready
  const d = await calendar(b).day()
  assert.equal(d.state, 'signedOut')
  assert.deepEqual(d.events, [])
  assert.ok(d.message)
  assert.deepEqual(await calendar(b).upcoming({ count: 3, days: 3 }), [])
  await assert.rejects(calendar(b).respond('budget1', 'accepted'), /calendar:/)
  const old = boot({ old: true })
  await old.h.ready
  const o = await calendar(old).day()
  assert.equal(o.state, 'error')
  assert.match(o.message, /needs cc-cockpit 0\.9\.4/)
})

test('an older app (services without useAll or emit): the plugin activates and still provides', async () => {
  const b = boot()
  delete b.ctx.services.emit
  assert.equal(b.ctx.services.useAll, undefined)
  assert.equal(typeof b.ctx.provided.calendar.day, 'function')
  const fresh = require('./fakes').fakeCtx({})
  delete fresh.services.emit
  const host = require('../dist/host')
  const h = host._start(fresh, { setTimeout: () => 0, clearTimeout: () => {}, now: () => NOW })
  await h.ready
  assert.deepEqual(Object.keys(fresh.provided.calendar).sort(), ['day', 'open', 'respond', 'upcoming'])
  await h.pollNow('x', true) // nothing to emit through: no throw
  const noProvide = require('./fakes').fakeCtx({})
  delete noProvide.services.provide
  const h2 = host._start(noProvide, { setTimeout: () => 0, clearTimeout: () => {}, now: () => NOW })
  await h2.ready
  await h.stop()
  await h2.stop()
})

test('the manifest provides calendar 1 beside what it uses', () => {
  const m = require('../plugin.json')
  assert.deepEqual(m.services.provides, { calendar: 1 })
  assert.equal(m.version, '0.3.0')
})
