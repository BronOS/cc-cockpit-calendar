'use strict'
// The agenda slot: the page's pure render functions (panels it needs are timeline.js and
// rowlogic.js; slots/agenda.js), and the host's end of the slot against the fake ctx.slots
// (state after hello, Join and its https-only rule, the RSVP answer, frames that close, an app with
// no ctx.slots). Example data only.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const A = require('../slots/agenda')
const { signedIn, settle } = require('./helpers')
const { ME } = require('./fakes')

const ROOT = path.join(__dirname, '..')
const DAY0 = Date.parse('2026-11-02T23:00:00Z') // 00:00 Tue 3 Nov in Berlin
const MIN = 60000
const row = (key, from, to, o = {}) => ({ key, title: o.title || key, from, to, start: DAY0 + from * MIN, end: DAY0 + to * MIN, time: `${from}-${to}`, busy: true, response: 'accepted', mine: true, type: 'default', conflicts: [], ...o })
const today = (rows) => ({ day: '2026-11-03', label: 'Tue 3 Nov', rows, clock: [{ at: DAY0, min: 0 }] })
const at = (min) => DAY0 + min * MIN

test('timeline: blocks as percentages of the span, overlaps in lanes, the now line, states', () => {
  assert.equal(A.agendaTimeline(today([]), at(540)), null)
  const t = A.agendaTimeline(today([row('a', 600, 660), row('b', 630, 690, { response: 'needsAction' }), row('c', 720, 780, { response: 'declined' })]), at(615))
  assert.equal(t.lo, 480)
  assert.equal(t.hi, 1140)
  assert.equal(t.lanes, 2)
  assert.equal(t.height, 2 * 18 + 2)
  const [a, b, c] = t.blocks
  assert.deepEqual([a.key, a.lane, b.key, b.lane, c.lane], ['a', 0, 'b', 1, 0])
  assert.equal(a.left, ((600 - 480) / 660) * 100)
  assert.equal(a.width, (60 / 660) * 100)
  assert.ok(a.cls.includes('cur'))
  assert.ok(b.cls.includes('unans') && !b.cls.includes('cur'))
  assert.ok(c.cls.includes('decl'))
  assert.equal(t.nowPct, ((615 - 480) / 660) * 100)
  assert.deepEqual(t.scale, ['08:00', '19:00'])
  // Outside the span: no line; a late event widens the span.
  assert.equal(A.agendaTimeline(today([row('a', 600, 660)]), at(60)).nowPct, null)
  assert.equal(A.agendaTimeline(today([row('late', 1200, 1260)]), at(60)).hi, 1260)
  // A very short event still gets a visible width.
  assert.ok(A.agendaTimeline(today([row('s', 600, 601)]), at(0)).blocks[0].width >= 1.5)
})

test('next event: running now first, else the next one with its countdown and Join', () => {
  const m = { now: [], next: { key: 'n', title: 'Standup', start: at(570), time: '09:30', dayLabel: 'today', join: true }, invitations: [] }
  assert.deepEqual(A.agendaNext(m, at(540)), { label: 'Next', key: 'n', title: 'Standup', count: '09:30 · in 30 min', join: true })
  assert.equal(A.agendaNext({ ...m, next: { ...m.next, join: false, dayLabel: 'tomorrow' } }, at(540)).count, 'tomorrow 09:30 · in 30 min')
  const run = { now: [{ key: 'r', title: 'Review', start: at(540), end: at(600), join: false }], next: m.next }
  assert.deepEqual(A.agendaNext(run, at(555)), { label: 'Now', key: 'r', title: 'Review', count: 'ends in 45 min', join: false })
  assert.equal(A.agendaNext({ now: [], next: null }, at(0)), null)
  assert.equal(A.agendaDelay(m, at(570 - 0.5)), 1000)
  assert.equal(A.agendaDelay(m, at(500)), 15000)
})

test('invitations: Accept and Decline, none without the RSVP scope, at most 3', () => {
  const inv = (n) => Array.from({ length: n }, (_, i) => ({ key: `i${i}`, title: `Invite ${i}`, when: 'Wed 14:00', organizer: 'Bob Example', series: i === 0 }))
  const on = A.agendaInvitations({ invitations: inv(5), rsvpOn: true })
  assert.equal(on.length, 3)
  assert.deepEqual(on[0].buttons.map((b) => b.answer), ['accepted', 'declined'])
  assert.equal(on[0].when, 'Wed 14:00')
  assert.deepEqual(A.agendaInvitations({ invitations: inv(1), rsvpOn: false })[0].buttons, [])
  assert.deepEqual(A.agendaInvitations({}), [])
})

test('empty state: the host\'s reason when not ok, "No events today" when ok and bare, else nothing', () => {
  assert.equal(A.agendaEmpty(null), 'Loading…')
  assert.equal(A.agendaEmpty({ ok: false, text: 'Not signed in.' }), 'Not signed in.')
  assert.match(A.agendaEmpty({ ok: false }), /not available/)
  assert.equal(A.agendaEmpty({ ok: true, today: today([]), now: [], next: null, invitations: [] }), 'No events today.')
  assert.equal(A.agendaEmpty({ ok: true, today: today([row('a', 600, 660)]), now: [], next: null, invitations: [] }), null)
  assert.equal(A.agendaEmpty({ ok: true, today: today([]), now: [], next: null, invitations: [{ key: 'i' }] }), null)
})

test('the page: no inline script, no markup building, no URL; the manifest slot entry is the page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'slots/agenda.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(attrs, /src=/)
    assert.equal(body.trim(), '')
  }
  assert.ok(!/\son[a-z]+=/i.test(html) && !/<form/i.test(html))
  const js = fs.readFileSync(path.join(ROOT, 'slots/agenda.js'), 'utf8')
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(js))
  assert.ok(!/https?:\/\//.test(js.replace(/^\s*\/\/.*$/gm, '')), 'the page holds no URL: it posts keys')
})

// ---- the host's end ----

test('a slot frame gets the agenda after hello: today, next, invitations, no id or URL', async () => {
  const b = await signedIn()
  const slot = b.ctx.openSlot('agenda', { anything: 1 })
  await slot.send({ type: 'hello' })
  const m = slot.last()
  assert.equal(m.ok, true)
  assert.ok(m.today.rows.some((r) => r.title === 'Standup'))
  assert.ok(m.today.rows.every((r) => !r.allDay), 'timed rows only')
  assert.ok(Array.isArray(m.today.clock) && m.today.clock.length > 0)
  assert.ok(m.invitations.some((r) => r.title === 'Budget planning'))
  assert.equal(m.rsvpOn, true)
  assert.ok(m.next)
  const said = JSON.stringify(slot.posts)
  assert.ok(!said.includes('meet.google.com') && !said.includes('"calendarId"'), 'no URL and no id reaches the page')
  // A poll that changes nothing posts nothing new; a closed frame gets nothing.
  const n = slot.posts.length
  await b.h.pollNow('test')
  await settle(b)
  assert.equal(slot.posts.length, n)
  slot.close()
  await b.h.pollNow('test')
  assert.equal(slot.posts.length, n)
})

test('signed out: the slot says why instead of an agenda', async () => {
  const { boot } = require('./helpers')
  const b = boot()
  await b.h.ready
  const slot = b.ctx.openSlot('agenda')
  await slot.send({ type: 'hello' })
  assert.deepEqual([slot.last().ok, /Not signed in|client/i.test(slot.last().text)], [false, true])
})

test('Join opens the Meet link from the last poll; the page names only a key', async () => {
  const b = await signedIn()
  const slot = b.ctx.openSlot('agenda')
  await slot.send({ type: 'hello' })
  const standup = slot.last().today.rows.find((r) => r.title === 'Standup')
  await slot.send({ type: 'join', key: standup.key })
  assert.deepEqual(b.ctx.external, ['https://meet.google.com/abc-defg-hij'])
  // A URL in place of a key, an unknown key, an event with no Meet link: nothing opens.
  await slot.send({ type: 'join', key: 'https://evil.example' })
  await slot.send({ type: 'join', key: 'ev:nope' })
  const vendor = slot.last().today.rows.find((r) => r.title === 'Vendor call')
  await slot.send({ type: 'join', key: vendor.key })
  assert.equal(b.ctx.external.length, 1)
  assert.match(slot.posts.at(-1).text, /no Google Meet link/)
})

test('Join refuses a link that is not https', async () => {
  const b = await signedIn()
  const slot = b.ctx.openSlot('agenda')
  await slot.send({ type: 'hello' })
  const standup = slot.last().today.rows.find((r) => r.title === 'Standup')
  const ev = b.h.eventOfKey(standup.key)
  ev.join = 'http://meet.example.com/abc'
  await slot.send({ type: 'join', key: standup.key })
  assert.deepEqual(b.ctx.external, [])
  assert.deepEqual([slot.posts.at(-1).type, slot.posts.at(-1).kind, slot.posts.at(-1).text], ['notice', 'error', 'Only https meeting links open from here.'])
})

test('RSVP from the slot: the answer goes to Google as the panel\'s does; a bad answer is ignored', async () => {
  const b = await signedIn()
  const slot = b.ctx.openSlot('agenda')
  await slot.send({ type: 'hello' })
  const inv = slot.last().invitations.find((r) => r.title === 'Budget planning')
  await slot.send({ type: 'rsvp', key: inv.key, answer: 'sure' })
  assert.equal(b.google.calls.filter((c) => c.method === 'PATCH').length, 0)
  await slot.send({ type: 'rsvp', key: inv.key, answer: 'accepted' })
  const patch = b.google.calls.find((c) => c.method === 'PATCH')
  assert.ok(patch.path.endsWith('/events/budget1'))
  assert.deepEqual(patch.body.attendees, [{ email: ME, responseStatus: 'accepted' }])
  await settle(b)
  assert.ok(!slot.last().invitations.some((r) => r.title === 'Budget planning' && !r.pending && r.response === 'needsAction'))
})

test('an app without ctx.slots: the plugin activates and works as before', async () => {
  const b = await signedIn({ noSlots: true })
  assert.equal(b.ctx.slots, undefined)
  assert.equal(b.ctx.slotFrames.length, 0)
  assert.ok(b.ctx.lastState().view)
})
