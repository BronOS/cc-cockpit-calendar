'use strict'
// One poll against the fake Google Calendar (lib/poll.js through lib/client.js): the calendar list
// (hourly), each selected calendar's window in the display zone, several calendars merged, a
// calendar that fails, all-day and recurring events, the computer's zone vs the calendar's, paging,
// and the stored state.
const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../dist/lib/poll')
const { createClient } = require('../dist/lib/client')
const { readSettings } = require('../dist/lib/settings')
const { buildView } = require('../dist/lib/layout')
const T = require('../dist/lib/time')
const { fakeGoogle, tokens, ev, NOW, ME, ANN, TEAM, HOLIDAYS, TZ } = require('./fakes')

function setup(opts = {}) {
  const reg = tokens()
  reg.valid.add('tok')
  const google = fakeGoogle({ tokens: reg, ...opts })
  const client = createClient({ getToken: async () => 'tok', invalidate: () => {}, fetch: google.fetch })
  return { google, client, state: P.emptyState('c1') }
}
const cfg = (p = {}) => readSettings(p).cfg
const titles = (state) => P.agendaOf(state).events.map((e) => e.title)

test('the first poll: the calendar list, then the primary calendar\'s window in its own zone (Berlin)', async () => {
  const { google, client, state } = setup()
  const r = await P.poll({ client, cfg: cfg(), state, now: NOW })
  assert.equal(state.account, ME)
  assert.equal(state.calendarZone, TZ)
  assert.equal(state.zone, TZ)
  assert.equal(state.day, '2026-11-03')
  assert.equal(state.lastPoll, NOW)
  assert.deepEqual(state.calendars.map((c) => c.id), [ME, TEAM, ANN, HOLIDAYS])
  assert.deepEqual(google.calls.map((c) => c.path), ['/calendar/v3/users/me/calendarList', '/calendar/v3/calendars/me%40example.com/events'])
  const p = google.calls[1].params
  // From Berlin's midnight today to the end of max(upcomingDays, inviteDays) days later (primary).
  assert.equal(p.timeMin, '2026-11-02T23:00:00Z')
  assert.equal(p.timeMax, '2026-12-03T23:00:00Z')
  assert.equal(p.timeZone, TZ)
  assert.equal(p.singleEvents, 'true')
  assert.equal(p.orderBy, 'startTime')
  assert.equal(p.maxAttendees, '100')
  assert.match(p.fields, /^items\(id,status,summary/)
  assert.ok(google.calls.every((c) => c.method === 'GET' && c.auth === 'Bearer tok' && c.redirect === 'manual'))
  assert.deepEqual(Object.keys(state.byCal), [ME])
  assert.equal(r.stats.calendars, 1)
  assert.equal(r.stats.skipped, 0, 'a cancelled event is not a skipped one')
  assert.ok(!titles(state).includes('Cancelled thing'))
  assert.ok(titles(state).includes('Weekly 1:1'))
})

test('the list is read again after an hour, or when asked; not on every poll', async () => {
  const { google, client, state } = setup()
  await P.poll({ client, cfg: cfg(), state, now: NOW })
  await P.poll({ client, cfg: cfg(), state, now: NOW + 3 * 60000 })
  assert.equal(google.calls.filter((c) => c.path.endsWith('calendarList')).length, 1)
  await P.poll({ client, cfg: cfg(), state, now: NOW + 6 * 60000, listAgain: true })
  assert.equal(google.calls.filter((c) => c.path.endsWith('calendarList')).length, 2)
  await P.poll({ client, cfg: cfg(), state, now: NOW + 70 * 60000 })
  assert.equal(google.calls.filter((c) => c.path.endsWith('calendarList')).length, 3)
})

test('several calendars: the setting\'s and the picker\'s read with the shorter window, merged with their colours, a copy shown once', async () => {
  const { google, client, state } = setup()
  await P.poll({ client, cfg: cfg({ calendars: [TEAM, 'ghost@example.com'] }), state, now: NOW, picked: [HOLIDAYS] })
  const evCalls = google.calls.filter((c) => c.path.endsWith('/events'))
  assert.deepEqual(evCalls.map((c) => decodeURIComponent(c.path.split('/')[4])), [ME, TEAM, HOLIDAYS])
  assert.match(evCalls[2].path, /en\.example%23holiday%40group\.v\.calendar\.google\.com/, 'the # is escaped in the path')
  assert.equal(evCalls[1].params.timeMax, '2026-11-17T23:00:00Z', 'upcomingDays + 1 for a calendar other than the primary')
  const sel = P.selection(state, cfg({ calendars: [TEAM, 'ghost@example.com'] }), [HOLIDAYS])
  assert.deepEqual(sel.missing, ['ghost@example.com'])
  assert.ok(sel.fromSettings.has(TEAM))
  const { events, conflicts } = P.agendaOf(state)
  const reviews = events.filter((e) => e.title === 'Design review ACME-12')
  assert.equal(reviews.length, 1, 'the review is on both calendars: once')
  assert.equal(reviews[0].calendarId, ME)
  const retro = events.find((e) => e.title === 'Team retro')
  assert.equal(retro.color, '#0b8043')
  assert.equal(retro.mine, false)
  assert.equal(conflicts.has(retro.key), false, 'not mine: no conflict with my focus time or anything')
  assert.ok(events.find((e) => e.title === 'Example Day'))
  // A calendar no longer selected leaves the agenda.
  await P.poll({ client, cfg: cfg(), state, now: NOW + 60000 })
  assert.deepEqual(Object.keys(state.byCal), [ME])
})

test('a calendar that fails keeps its last events and is named; the primary failing fails the poll', async () => {
  const fail = {}
  const { client, state } = setup({ fail })
  await P.poll({ client, cfg: cfg({ calendars: [TEAM] }), state, now: NOW })
  fail[`events:${TEAM}`] = 500
  const r = await P.poll({ client, cfg: cfg({ calendars: [TEAM] }), state, now: NOW + 60000 })
  assert.equal(r.stats.errors.length, 1)
  assert.equal(r.stats.errors[0].calendar, 'Acme Team')
  assert.match(r.stats.errors[0].message, /Google Calendar had a problem \(500\)/)
  assert.ok(titles(state).includes('Team retro'), 'its last events stay')
  assert.equal(state.lastPoll, NOW + 60000)
  fail[`events:${ME}`] = 403
  await assert.rejects(P.poll({ client, cfg: cfg({ calendars: [TEAM] }), state, now: NOW + 120000 }), (e) => e.kind === 'scope')
  assert.equal(state.lastPoll, NOW + 60000, 'a failed poll does not move lastPoll')
})

test('a list without the primary calendar is refused; a calendar list error fails the poll', async () => {
  const { google, client, state } = setup()
  google.world.calendars = google.world.calendars.filter((c) => !c.primary)
  await assert.rejects(P.poll({ client, cfg: cfg(), state, now: NOW }), /without your primary calendar/)
  const b = setup({ fail: { list: 'disabled' } })
  await assert.rejects(P.poll({ client: b.client, cfg: cfg(), state: b.state, now: NOW }), (e) => e.kind === 'disabled' && /Calendar API is not enabled/.test(e.message))
})

test('the computer\'s zone: the window and the times follow it; all-day events keep their days', async () => {
  const { google, client, state } = setup()
  const c = cfg({ timeZone: 'computer' })
  const zone = P.displayZone(c, state)
  assert.equal(zone, T.computerZone())
  await P.poll({ client, cfg: c, state, now: NOW })
  assert.equal(google.calls[1].params.timeZone, zone)
  assert.equal(google.calls[1].params.timeMin, T.rfc3339(T.startOfDay(T.dayKey(NOW, zone), zone)))
  // The view in New York: the review (11:00 Berlin) is at 05:00; the holiday is still Fri 6.
  const { events, conflicts } = P.agendaOf(state)
  const v = buildView({ events, conflicts, now: NOW, tz: 'America/New_York', cfg: c })
  const review = v.today.rows.find((r) => r.title === 'Design review ACME-12')
  assert.equal(review.time, '05:00–06:00')
  const holiday = v.upcoming.rows.find((r) => r.title === 'Company holiday')
  assert.equal(holiday.day, '2026-11-06')
  assert.equal(holiday.line, 'Fri 6 · all day · Company holiday')
  // 03:00 in New York: today there is still Tue 3.
  assert.equal(v.today.day, '2026-11-03')
})

test('recurring events: every occurrence its own event, carrying the series id and its original start', async () => {
  const { client, state } = setup()
  await P.poll({ client, cfg: cfg(), state, now: NOW })
  const weekly = P.agendaOf(state).events.filter((e) => e.recurring === 'weekly11')
  assert.deepEqual(weekly.map((e) => e.id), ['weekly11_20261105T090000Z', 'weekly11_20261112T090000Z'])
  assert.ok(weekly.every((e) => e.invitation && e.response === 'needsAction'))
  assert.notEqual(weekly[0].key, weekly[1].key)
})

test('paging: every page up to 1000 events; more than that is said', async () => {
  const { google, client, state } = setup()
  const many = []
  for (let i = 0; i < 1100; i++) many.push(ev(`bulk${i}`, '2026-11-04', '10:00', '10:05', { title: `Bulk ${i}` }))
  google.world.events[ME] = many
  const r = await P.poll({ client, cfg: cfg(), state, now: NOW })
  assert.equal(google.calls.filter((c) => c.path.endsWith('/events')).length, 4)
  assert.equal(state.byCal[ME].length, 1000)
  assert.deepEqual(r.stats.more, [ME])
})

test('a malformed event is skipped and counted; the rest of the calendar is read', async () => {
  const { google, client, state } = setup()
  google.world.events[ME].push({ id: 'bad/id', start: { dateTime: '2026-11-03T10:00:00+01:00' }, end: { dateTime: '2026-11-03T11:00:00+01:00' } }, { id: 'nostart', status: 'confirmed' })
  const r = await P.poll({ client, cfg: cfg(), state, now: NOW })
  assert.equal(r.stats.skipped, 2)
  assert.ok(state.byCal[ME].length > 10)
})

test('the Jira keys of an event (with a site): in the title, the location and the description', async () => {
  const { client, state } = setup()
  await P.poll({ client, cfg: cfg(), state, now: NOW, jira: { site: 'https://acme.atlassian.example' } })
  const review = P.agendaOf(state).events.find((e) => e.id === 'review1')
  assert.deepEqual(review.jira, ['ACME-12'])
  const s2 = P.emptyState('c1')
  await P.poll({ client, cfg: cfg(), state: s2, now: NOW })
  assert.deepEqual(P.agendaOf(s2).events.find((e) => e.id === 'review1').jira, [], 'no Jira plugin: no keys')
})

test('loadState: only this client\'s state, checked as it comes from a file', () => {
  assert.deepEqual(P.loadState(null, 'c1'), P.emptyState('c1'))
  assert.deepEqual(P.loadState({ v: 1, client: 'other', account: ME }, 'c1'), P.emptyState('c1'))
  assert.deepEqual(P.loadState({ v: 9, client: 'c1' }, 'c1'), P.emptyState('c1'))
  const s = P.loadState({ v: 1, client: 'c1', account: ME, calendarZone: 'Mars/Base', zone: TZ, day: '2026-13-01', lastPoll: NOW, calendars: [{ id: ME, name: ME, color: '#4285f4', primary: true, tz: TZ }, { id: 'a/b' }], byCal: { [ME]: [{ key: 'k', id: 'x', start: 1, end: 2 }, { key: 'k2', id: 'y', start: 'soon', end: 2 }, null] } }, 'c1')
  assert.equal(s.account, ME)
  assert.equal(s.calendarZone, null)
  assert.equal(s.zone, TZ)
  assert.equal(s.day, null)
  assert.deepEqual(s.calendars.map((c) => c.id), [ME])
  assert.equal(s.calendars[0].primary, true)
  assert.deepEqual(s.byCal[ME].map((e) => e.id), ['x'])
})

test('a 401 on a call: the client takes a fresh token once and retries', async () => {
  const reg = tokens()
  reg.valid.add('fresh')
  const google = fakeGoogle({ tokens: reg })
  let n = 0
  let invalidated = 0
  const client = createClient({ getToken: async () => (n++ === 0 ? 'dead' : 'fresh'), invalidate: () => invalidated++, fetch: google.fetch })
  const list = await client.calendarList()
  assert.equal(list.length, 4)
  assert.equal(invalidated, 1)
  assert.deepEqual(google.calls.map((c) => c.auth), ['Bearer dead', 'Bearer fresh'])
  const client2 = createClient({ getToken: async () => 'dead', invalidate: () => {}, fetch: google.fetch })
  await assert.rejects(client2.calendarList(), (e) => e.kind === 'auth')
})
