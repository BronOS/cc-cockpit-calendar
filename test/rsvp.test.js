'use strict'
// Answering an invitation, the plugin's only write (lib/rsvp.js, client.rsvp, the host's answerEvent):
// the target (the series by default, one occurrence on request), the exact patch Google gets, the
// optimistic row and its rollback, the scope 403 in its two meanings, the bound on calls.
const test = require('node:test')
const assert = require('node:assert/strict')
const { planRsvp, answerOf, createGate, GateStopped } = require('../dist/lib/rsvp')
const { createClient } = require('../dist/lib/client')
const { RSVP_SCOPE_REFUSED_TEXT } = require('../dist/lib/oauth-client')
const { fakeGoogle, tokens, ME, ALL_SCOPES } = require('./fakes')
const { signedIn, settle, rowOf } = require('./helpers')

const invite = (o = {}) => ({ key: 'k', id: 'budget1', calendarId: ME, primary: true, response: 'needsAction', selfEmail: ME, recurring: null, ...o })

test('answerOf: yes / no / maybe and Google\'s own words; anything else is no answer', () => {
  assert.equal(answerOf('yes'), 'accepted')
  assert.equal(answerOf('No'), 'declined')
  assert.equal(answerOf('maybe'), 'tentative')
  assert.equal(answerOf('tentative'), 'tentative')
  for (const bad of ['needsAction', 'sure', '', null, 'constructor', '__proto__']) assert.equal(answerOf(bad), null, String(bad))
})

test('planRsvp: a recurring invitation answers the series unless one; only my primary copy, never as organizer', () => {
  assert.deepEqual(planRsvp(invite()), { cal: ME, id: 'budget1', series: false, email: ME, target: `one:${ME}:budget1` })
  const occ = invite({ id: 'weekly11_20261105T090000Z', recurring: 'weekly11' })
  assert.deepEqual(planRsvp(occ), { cal: ME, id: 'weekly11', series: true, email: ME, target: `series:${ME}:weekly11` })
  assert.deepEqual(planRsvp(occ, { one: true }), { cal: ME, id: 'weekly11_20261105T090000Z', series: false, email: ME, target: `one:${ME}:weekly11_20261105T090000Z` })
  assert.match(planRsvp(null).error, /not in the last poll/)
  assert.match(planRsvp(invite({ primary: false })).error, /primary calendar/)
  assert.match(planRsvp(invite({ response: 'organizer' })).error, /You organize/)
  assert.match(planRsvp(invite({ response: 'none', selfEmail: '' })).error, /not among its guests/)
  // An answered invitation may be answered again (change of mind).
  assert.equal(planRsvp(invite({ response: 'accepted' })).id, 'budget1')
})

test('client.rsvp: PATCH with exactly my attendee entry, attendeesOmitted, sendUpdates=all', async () => {
  const reg = tokens()
  reg.valid.add('tok')
  const google = fakeGoogle({ tokens: reg })
  const client = createClient({ getToken: async () => 'tok', invalidate: () => {}, fetch: google.fetch })
  await client.rsvp(ME, 'weekly11', 'accepted', ME)
  const call = google.calls[0]
  assert.equal(call.method, 'PATCH')
  assert.equal(call.path, '/calendar/v3/calendars/me%40example.com/events/weekly11')
  assert.equal(call.params.sendUpdates, 'all')
  assert.deepEqual(call.body, { attendeesOmitted: true, attendees: [{ email: ME, responseStatus: 'accepted' }] })
  assert.ok(google.world.events[ME].filter((e) => e.recurringEventId === 'weekly11').every((e) => e.attendees.find((a) => a.self).responseStatus === 'accepted'))
  await assert.rejects(client.rsvp(ME, 'budget1', 'needsAction', ME), (e) => e.kind === 'unsafe')
  await assert.rejects(client.rsvp(ME, 'budget1', 'accepted', 'not-an-address'), (e) => e.kind === 'unsafe')
  await assert.rejects(client.rsvp(ME, 'a/b', 'accepted', ME), (e) => e.kind === 'unsafe')
  assert.equal(google.calls.length, 1)
})

test('the gate: at most 4 at once, 60 a minute, nothing after stop', async () => {
  let clock = 0
  const slept = []
  const gate = createGate({ now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms } })
  let running = 0
  let most = 0
  const job = async () => {
    running++
    most = Math.max(most, running)
    await new Promise((r) => setTimeout(r, 1))
    running--
  }
  await Promise.all(Array.from({ length: 10 }, () => gate.run(job)))
  assert.equal(most, 4)
  await Promise.all(Array.from({ length: 55 }, () => gate.run(async () => {})))
  assert.ok(slept.length >= 1, 'the 61st start waited for the minute')
  gate.stop()
  await assert.rejects(gate.run(job), GateStopped)
})

test('the host: a single invitation accepted; the row leaves Invitations at once, the badge drops, Google is told', async () => {
  const b = await signedIn()
  const before = b.ctx.lastState()
  const row = rowOf(before, 'Budget planning', 'invitations')
  assert.equal(b.ctx.badges.at(-1), 2)
  await b.ctx.sendPanel({ type: 'rsvp', key: row.key, answer: 'accepted' })
  await settle(b)
  const w = b.google.writes[0]
  assert.deepEqual(w, { cal: ME, id: 'budget1', body: { attendeesOmitted: true, attendees: [{ email: ME, responseStatus: 'accepted' }] }, sendUpdates: 'all' })
  const st = b.ctx.lastState()
  assert.ok(!st.view.invitations.some((r) => r.title === 'Budget planning'))
  assert.equal(rowOf(st, 'Budget planning', 'tomorrow').response, 'accepted')
  assert.equal(b.ctx.badges.at(-1), 1)
  assert.match(st.notice.text, /^Accepted "Budget planning"\. The organizer is told\.$/)
})

test('the host: a recurring invitation answers the series by default, one occurrence with one: true', async () => {
  const b = await signedIn()
  const series = rowOf(b.ctx.lastState(), 'Weekly 1:1', 'invitations')
  await b.ctx.sendPanel({ type: 'rsvp', key: series.key, answer: 'tentative', one: true })
  await settle(b)
  assert.equal(b.google.writes[0].id, 'weekly11_20261105T090000Z')
  assert.match(b.ctx.lastState().notice.text, /Maybe "Weekly 1:1" \(this occurrence\)/)
  // The other occurrence is still waiting: the series row is back, now for the 12th.
  const again = rowOf(b.ctx.lastState(), 'Weekly 1:1', 'invitations')
  assert.match(again.when, /next Thu 12/)
  await b.ctx.sendPanel({ type: 'rsvp', key: again.key, answer: 'declined' })
  await settle(b)
  assert.equal(b.google.writes[1].id, 'weekly11', 'the series')
  assert.deepEqual(b.google.writes[1].body.attendees, [{ email: ME, responseStatus: 'declined' }])
  assert.match(b.ctx.lastState().notice.text, /Declined "Weekly 1:1" \(the whole series\)/)
  assert.equal(b.ctx.lastState().view.invitations.length, 1)
})

test('the host: Google refuses the answer (500): the row is back as it was, with the reason', async () => {
  const b = await signedIn({ google: { fail: { patch: 500 } } })
  const row = rowOf(b.ctx.lastState(), 'Budget planning', 'invitations')
  const seen = []
  const post = b.ctx.panels.post
  b.ctx.panels.post = (p, m) => {
    seen.push(m)
    post(p, m)
  }
  await b.ctx.sendPanel({ type: 'rsvp', key: row.key, answer: 'tentative' })
  // While the call ran, the row was already answered (optimistic)...
  assert.ok(seen.some((m) => m.view && !m.view.invitations.some((r) => r.title === 'Budget planning') && (rowOf(m, 'Budget planning', 'tomorrow') || {}).pending === true))
  // ...and then put back.
  const st = b.ctx.lastState()
  assert.ok(st.view.invitations.some((r) => r.title === 'Budget planning'))
  assert.equal(rowOf(st, 'Budget planning', 'tomorrow').response, 'needsAction')
  assert.equal(b.ctx.badges.at(-1), 2)
  assert.equal(st.notice.kind, 'error')
  assert.match(st.notice.text, /^Could not answer "Budget planning": Google Calendar had a problem \(500\).*It is shown as before\.$/)
  assert.deepEqual(b.h.S.pending, {})
})

test('the host: a 403 for the scope while the grant holds the RSVP scope names the fix (calendar.events)', async () => {
  const b = await signedIn({ google: { fail: { patch: 403 } } })
  const r = await b.h.answerEvent(b.h.eventOfId('budget1'), 'accepted')
  assert.ok(r.error.includes(RSVP_SCOPE_REFUSED_TEXT.replace(/\.$/, '')))
  assert.match(r.error, /set RSVP_SCOPE to https:\/\/www\.googleapis\.com\/auth\/calendar\.events/)
})

test('the host: a 403 for the scope with no grant known says both causes', async () => {
  const b = await signedIn({ google: { fail: { patch: 403 } }, oauthOpts: { scope: null } })
  const r = await b.h.answerEvent(b.h.eventOfId('budget1'), 'accepted')
  assert.match(r.error, /If you unticked a box at sign-in, Sign in again\. If not: Google refused the answer/)
})

test('the host: a sign-in without the RSVP scope offers no buttons and refuses before any call; the agenda works', async () => {
  const b = await signedIn({ oauthOpts: { scope: ALL_SCOPES.slice(0, 2) } })
  const st = b.ctx.lastState()
  assert.equal(st.rsvpOn, false)
  assert.match(st.rsvpText, /calendar\.events\.owned/)
  assert.ok(st.view.today.rows.length > 3)
  assert.match(st.notice.text, /calendar\.events\.owned .* was not granted: invitations cannot be answered from here/)
  const r = await b.h.answerEvent(b.h.eventOfId('budget1'), 'accepted')
  assert.match(r.error, /Sign in again to answer invitations/)
  assert.equal(b.google.writes.length, 0)
  const cli = await b.ctx.runCli(['rsvp', 'budget1', 'yes'])
  assert.equal(cli.code, 1)
  assert.match(cli.stderr, /Sign in again to answer invitations/)
})

test('the host: refused before any call: an event I organize, another calendar\'s, a second answer while one is on its way', async () => {
  const b = await signedIn({ project: { calendars: ['acme-team@group.calendar.google.com'] } })
  assert.match((await b.h.answerEvent(b.h.eventOfId('vendor1'), 'accepted')).error, /You organize/)
  assert.match((await b.h.answerEvent(b.h.eventOfId('retro1'), 'accepted')).error, /primary calendar/)
  assert.match((await b.h.answerEvent(b.h.eventOfId('budget1'), 'sure')).error, /yes, no or maybe/)
  const first = b.h.answerEvent(b.h.eventOfId('budget1'), 'accepted')
  const second = await b.h.answerEvent(b.h.eventOfId('budget1'), 'declined')
  assert.match(second.message, /still on its way/)
  await first
  assert.equal(b.google.writes.length, 1)
})

test('the host: after a good answer the next poll reads Google\'s own state and the guess goes', async () => {
  const b = await signedIn()
  await b.h.answerEvent(b.h.eventOfId('budget1'), 'accepted')
  await settle(b)
  assert.deepEqual(b.h.S.pending, {}, 'the poll after the answer started after it: the record went')
  assert.equal(rowOf(b.ctx.lastState(), 'Budget planning', 'tomorrow').response, 'accepted', 'now from Google')
  assert.equal(rowOf(b.ctx.lastState(), 'Budget planning', 'tomorrow').pending, false)
})
