'use strict'
// What an event is to the panel (lib/model.js): the person's own answer on the primary calendar and
// on another one, the Meet-only join link, the checked Calendar link, all-day and timed times, the
// event types, the merge of copies across calendars and the conflicts.
const test = require('node:test')
const assert = require('node:assert/strict')
const M = require('../dist/lib/model')
const T = require('../dist/lib/time')
const { eventKey } = require('../dist/lib/util')
const { ev, allDay, self, guest, ME, ANN, BOB, TEAM, TZ } = require('./fakes')

const PRIMARY = { id: ME, name: ME, color: '#4285f4', primary: true }
const TEAMCAL = { id: TEAM, name: 'Acme Team', color: '#0b8043', primary: false }
const make = (raw, cal = PRIMARY, o = {}) => M.compactEvent(raw, { cal, me: ME, tz: TZ, ...o })
const DAY = '2026-11-03'

test('compactCalendar: the id checked, the name, a colour that is #rrggbb, the zone', () => {
  assert.deepEqual(M.compactCalendar({ id: TEAM, summary: 'Acme Team', summaryOverride: 'Team', backgroundColor: '#0b8043', timeZone: TZ, accessRole: 'reader' }), { id: TEAM, name: 'Team', color: '#0b8043', primary: false, tz: TZ, access: 'reader', hidden: false })
  assert.equal(M.compactCalendar({ id: TEAM, backgroundColor: 'red; background:url(x)' }).color, '#9e9e9e')
  assert.equal(M.compactCalendar({ id: TEAM, timeZone: 'Mars/Base' }).tz, null)
  assert.equal(M.compactCalendar({ id: 'a/b' }), null)
  assert.equal(M.compactCalendar({ id: TEAM, summary: 'a\nb' }).name, 'a b')
})

test('the answer on the primary calendar: self entry, organizer, own event without guests', () => {
  assert.equal(make(ev('a', DAY, '10:00', '11:00', { title: 'x', organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('tentative')] })).response, 'tentative')
  const inv = make(ev('b', DAY, '10:00', '11:00', { title: 'x', organizer: { email: ANN, displayName: 'Ann Example' }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('needsAction')] }))
  assert.equal(inv.response, 'needsAction')
  assert.equal(inv.invitation, true)
  assert.equal(inv.selfEmail, ME)
  assert.equal(inv.organizer.name, 'Ann Example')
  const mine = make(ev('c', DAY, '10:00', '11:00', { title: 'x', attendees: [self('accepted'), guest(ANN, 'needsAction')] }))
  assert.equal(mine.response, 'organizer')
  assert.equal(mine.invitation, false)
  assert.equal(make(ev('d', DAY, '10:00', '11:00', { title: 'x' })).response, 'organizer', 'no guests on the primary: my own')
  assert.equal(make(ev('e', DAY, '10:00', '11:00', { title: 'x', organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true }), { email: ME, self: true }] })).response, 'needsAction', 'no responseStatus: not answered')
})

test('the answer on another calendar: the attendee with my address (self there is that calendar), else none', () => {
  // On Ann's calendar, `self` marks Ann's entry; my answer is the entry with my address.
  const raw = ev('f', DAY, '10:00', '11:00', { title: 'x', organizer: { email: ANN, self: true }, attendees: [{ ...guest(ANN, 'accepted', { organizer: true }), self: true }, guest(ME.toUpperCase(), 'declined')] })
  const e = make(raw, TEAMCAL)
  assert.equal(e.response, 'declined')
  assert.equal(e.mine, true)
  assert.equal(e.invitation, false, 'only the primary copy is answered from here')
  const other = make(ev('g', DAY, '10:00', '11:00', { title: 'x', organizer: { email: BOB }, attendees: [guest(BOB, 'accepted', { organizer: true })] }), TEAMCAL)
  assert.equal(other.response, 'none')
  assert.equal(other.mine, false)
  assert.equal(make(ev('h', DAY, '10:00', '11:00', { title: 'x', organizer: { email: ME } }), TEAMCAL).response, 'organizer')
})

test('the join link: Google Meet only (hangoutLink, else the video entry point); Zoom, Teams, http and odd URLs never', () => {
  const base = ev('j', DAY, '10:00', '11:00', { title: 'x' })
  assert.equal(M.joinLink({ ...base, hangoutLink: 'https://meet.google.com/abc-defg-hij' }), 'https://meet.google.com/abc-defg-hij')
  assert.equal(M.joinLink({ ...base, conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1' }, { entryPointType: 'video', uri: 'https://meet.google.com/xyz-abcd-efg' }] } }), 'https://meet.google.com/xyz-abcd-efg')
  for (const bad of ['https://example.zoom.us/j/1', 'https://teams.microsoft.com/l/meetup-join/1', 'http://meet.google.com/abc', 'https://user:pw@meet.google.com/abc', 'https://meet.google.com.evil.example/abc', 'javascript:alert(1)', `https://meet.google.com/${'a'.repeat(2100)}`]) {
    assert.equal(M.joinLink({ ...base, hangoutLink: bad }), null, bad)
    assert.equal(M.joinLink({ ...base, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: bad }] } }), null, bad)
  }
  assert.equal(M.joinLink({ ...base, location: 'https://example.zoom.us/j/1', description: 'https://meet.google.com/abc-defg-hij' }), null, 'a link in the text is not picked up')
  assert.deepEqual(M.phoneOf({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+1-555-0100', label: '+1 555-0100', pin: '123' }] } }), { label: '+1 555-0100', pin: '123' })
  const e = make(ev('k', DAY, '10:00', '11:00', { title: 'x', meet: 'https://meet.google.com/abc-defg-hij' }))
  assert.equal(e.join, 'https://meet.google.com/abc-defg-hij')
  assert.equal(e.conference, 'Google Meet')
})

test('the Calendar link: only Google Calendar\'s own htmlLink', () => {
  assert.equal(M.calendarLink({ htmlLink: 'https://www.google.com/calendar/event?eid=abc' }), 'https://www.google.com/calendar/event?eid=abc')
  assert.equal(M.calendarLink({ htmlLink: 'https://calendar.google.com/calendar/event?eid=abc' }), 'https://calendar.google.com/calendar/event?eid=abc')
  for (const bad of ['https://evil.example/calendar', 'http://www.google.com/calendar', 'https://www.google.com.evil.example/', '']) assert.equal(M.calendarLink({ htmlLink: bad }), null, bad)
})

test('times: timed events as instants, all-day ones as days (end exclusive), a missing or odd end', () => {
  const t = make(ev('t', DAY, '09:30', '09:45', { title: 'x' }))
  assert.equal(t.allDay, false)
  assert.equal(t.start, Date.parse('2026-11-03T08:30:00Z'))
  assert.equal(t.end, Date.parse('2026-11-03T08:45:00Z'))
  assert.equal(t.zone, TZ)
  const a = make(allDay('a', '2026-11-10', '2026-11-13', { title: 'Conference' }))
  assert.equal(a.allDay, true)
  assert.equal(a.startDate, '2026-11-10')
  assert.equal(a.endDate, '2026-11-13')
  assert.equal(a.start, T.startOfDay('2026-11-10', TZ))
  assert.equal(a.busy, false)
  // An all-day event's days do not move with the zone; only its sort instants do.
  const ny = M.compactEvent(allDay('a', '2026-11-10', '2026-11-13', { title: 'Conference' }), { cal: PRIMARY, me: ME, tz: 'America/New_York' })
  assert.equal(ny.startDate, '2026-11-10')
  assert.equal(ny.start, Date.parse('2026-11-10T05:00:00Z'))
  assert.equal(make(allDay('b', '2026-11-10', '2026-11-10', { title: 'x' })).endDate, '2026-11-11', 'an end not after the start: one day')
  const back = make({ ...ev('c', DAY, '10:00', '11:00', { title: 'x' }), end: { dateTime: '2026-11-03T08:00:00+01:00' } })
  assert.equal(back.end, back.start, 'an end before the start: none')
  assert.equal(make({ ...ev('d', DAY, '10:00', '11:00', { title: 'x' }), endTimeUnspecified: true }).end, Date.parse('2026-11-03T09:00:00Z'))
  for (const bad of [{ ...ev('e', DAY, '10:00', '11:00'), start: {} }, { ...ev('f', DAY, '10:00', '11:00'), start: { dateTime: 'soon' } }, { ...ev('g', DAY, '10:00', '11:00'), id: 'a/b' }, { ...allDay('h', '2026-02-30', '2026-03-01') }, null, 'x']) assert.equal(make(bad), null)
  assert.equal(make(ev('i', DAY, '10:00', '11:00', { title: 'x', status: 'cancelled' })), null, 'cancelled: gone')
})

test('types, titles and other fields: working location, out of office, focus time, recurring, text cut', () => {
  assert.equal(make(allDay('w', DAY, '2026-11-04', { title: '', type: 'workingLocation', extra: { workingLocationProperties: { type: 'homeOffice', homeOffice: {} } } })).title, 'Home')
  assert.equal(make(allDay('w2', DAY, '2026-11-04', { title: '', type: 'workingLocation', extra: { workingLocationProperties: { type: 'officeLocation', officeLocation: { label: 'Building 2' } } } })).title, 'Office: Building 2')
  assert.equal(make(allDay('w3', DAY, '2026-11-04', { title: '', type: 'workingLocation', extra: { workingLocationProperties: { type: 'customLocation', customLocation: { label: 'Lisbon' } } } })).working, 'Lisbon')
  assert.equal(make(ev('o', DAY, '09:00', '18:00', { title: '', type: 'outOfOffice' })).title, 'Out of office')
  assert.equal(make(ev('n', DAY, '09:00', '10:00', { title: '' })).title, '(busy)')
  assert.equal(make(ev('u', DAY, '09:00', '10:00', { title: 'x', type: 'somethingNew' })).type, 'default')
  const r = make(ev('standup_20261103T083000Z', DAY, '09:30', '09:45', { title: 'Standup', recurring: 'standup' }))
  assert.equal(r.recurring, 'standup')
  assert.equal(r.originalStart, '2026-11-03T09:30:00+01:00')
  assert.equal(r.key, eventKey(ME, 'standup_20261103T083000Z'))
  const long = make(ev('l', DAY, '09:00', '10:00', { title: 'a\n'.repeat(400), location: 'b'.repeat(400) }))
  assert.equal(long.title.length, 300)
  assert.ok(!long.title.includes('\n'))
  assert.equal(long.location.length, 300)
  assert.equal(make(ev('f', DAY, '09:00', '10:00', { title: 'x', transparency: 'transparent' })).busy, false)
  assert.deepEqual(make(ev('g', DAY, '09:00', '10:00', { title: 'x', attendees: [self('accepted'), guest(ANN, 'declined'), guest(BOB, 'tentative'), { email: 'room@resource.calendar.google.com', resource: true }] })).guests, { total: 3, accepted: 1, tentative: 1, declined: 1, needsAction: 0, rooms: 1 })
  assert.deepEqual(make(ev('j', DAY, '09:00', '10:00', { title: 'ACME-1' }), PRIMARY, { jiraKeys: (raw) => [raw.summary] }).jira, ['ACME-1'])
})

test('merge: one event on two calendars shows once (the primary copy); sorted all-day first, then by start', () => {
  const review = ev('review1', DAY, '11:00', '12:00', { title: 'Review', iCalUID: 'review@google.com', organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('accepted')] })
  const onTeam = make({ ...review, attendees: review.attendees.map((a) => ({ ...a, self: undefined })) }, TEAMCAL)
  const onMine = make(review)
  const early = make(ev('e', DAY, '08:00', '08:30', { title: 'Early' }))
  const day = make(allDay('d', DAY, '2026-11-04', { title: 'Holiday' }))
  const merged = M.mergeEvents([[onTeam], [onMine, early, day]])
  assert.deepEqual(merged.map((e) => e.title), ['Holiday', 'Early', 'Review'])
  assert.equal(merged[2].calendarId, ME)
  // Two occurrences of one series are two events (originalStart differs).
  const a = make(ev('w_1', '2026-11-05', '10:00', '10:30', { title: 'W', recurring: 'w', iCalUID: 'w@google.com' }))
  const b = make(ev('w_2', '2026-11-12', '10:00', '10:30', { title: 'W', recurring: 'w', iCalUID: 'w@google.com' }))
  assert.equal(M.mergeEvents([[a, b]]).length, 2)
  // Not a guest on the primary's copy? The copy where I am a guest wins over one where I am not.
  const team1 = make(ev('t', DAY, '10:00', '11:00', { title: 'T', iCalUID: 't@google.com', organizer: { email: BOB }, attendees: [guest(BOB, 'accepted', { organizer: true })] }), TEAMCAL)
  const team2 = make(ev('t', DAY, '10:00', '11:00', { title: 'T', iCalUID: 't@google.com', organizer: { email: BOB }, attendees: [guest(BOB, 'accepted', { organizer: true }), guest(ME, 'accepted')] }), { ...TEAMCAL, id: ANN })
  assert.equal(M.mergeEvents([[team1], [team2]])[0].calendarId, ANN)
})

test('conflicts: my busy timed meetings that overlap; declined, free, focus time, other people\'s and back-to-back ones do not', () => {
  const m = (id, from, to, o = {}) => make(ev(id, DAY, from, to, { title: id, ...o }), o.cal || PRIMARY)
  const list = [
    m('a', '10:00', '11:00'),
    m('b', '10:30', '11:30'),
    m('c', '11:30', '12:00'), // touches b's end: no conflict
    m('d', '10:15', '10:45', { organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('declined')] }),
    m('e', '10:15', '10:45', { transparency: 'transparent' }),
    m('f', '10:00', '12:00', { type: 'focusTime' }),
    m('g', '10:00', '12:00', { cal: TEAMCAL, organizer: { email: BOB }, attendees: [guest(BOB, 'accepted', { organizer: true })] }),
    m('o1', '13:00', '15:00', { type: 'outOfOffice' }),
    m('o2', '14:00', '16:00', { type: 'outOfOffice' }),
    m('h', '14:30', '15:00'),
  ]
  const c = M.findConflicts(M.mergeEvents([list]))
  const names = (k) => (c.get(list.find((x) => x.id === k).key) || []).map((x) => x.title).sort()
  assert.deepEqual(names('a'), ['b'])
  assert.deepEqual(names('b'), ['a'])
  assert.deepEqual(names('c'), [])
  assert.deepEqual(names('d'), [])
  assert.deepEqual(names('e'), [])
  assert.deepEqual(names('f'), [])
  assert.deepEqual(names('g'), [])
  assert.deepEqual(names('o1'), ['h'], 'two out-of-office spans do not conflict with each other')
  assert.deepEqual(names('h'), ['o1', 'o2'])
})
