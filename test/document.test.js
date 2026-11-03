'use strict'
// The event detail view (lib/document.js) and the Jira pieces it uses (lib/jira.js): the clean HTML,
// the facts column, the readable text, the description sanitized, guests grouped, the zone note, the
// Discuss prompt; issue keys found in an event, the chip, the facts and the companion check.
const test = require('node:test')
const assert = require('node:assert/strict')
const D = require('../dist/lib/document')
const J = require('../dist/lib/jira')
const { esc } = require('../dist/lib/entities')
const { compactEvent, phoneOf } = require('../dist/lib/model')
const { world, ev, self, guest, NOW, ME, ANN, TZ } = require('./fakes')

const PRIMARY = { id: ME, name: ME, color: '#4285f4', primary: true }
const review = () => world().events[ME].find((e) => e.id === 'review1')
function docOf(raw, o = {}) {
  const e = compactEvent(raw, { cal: PRIMARY, me: ME, tz: o.tz || TZ })
  e.phone = phoneOf(raw)
  return D.eventDocument({ raw, ev: e, tz: o.tz || TZ, conflicts: o.conflicts, calendarUrl: 'https://www.google.com/calendar/event?eid=review1&authuser=me%40example.com', jiraFacts: o.jiraFacts, jiraLines: o.jiraLines, now: NOW })
}

test('the html: the title, when, your answer, where, Join with dial-in, the description cleaned, guests grouped, rooms', () => {
  const d = docOf(review(), { conflicts: [{ title: 'Vendor call', time: '11:30–12:15' }] })
  assert.match(d.html, /^<h1>Design review ACME-12<\/h1>\n<p class="meta">Tue 3 Nov, 11:00–12:00 \(Europe\/Berlin\) · me@example\.com<\/p>/)
  assert.match(d.html, /<div class="jira-panel jira-panel-warning"><p>Overlaps Vendor call 11:30–12:15<\/p><\/div>/)
  assert.match(d.html, /Your answer: <span class="lozenge lozenge-success">Accepted<\/span> · organized by <span class="person">Ann Example<\/span>/)
  assert.match(d.html, /<h2>Where<\/h2><p>Room 1<\/p>/)
  assert.match(d.html, /<h2>Join<\/h2><p><a href="https:\/\/meet\.google\.com\/rev-iewx-yzq">meet\.google\.com\/rev-iewx-yzq<\/a><br>Dial-in \+1 555-0100, PIN 123456<\/p>/)
  assert.match(d.html, /<h2>Description<\/h2><p>Agenda: <strong>ACME-12<\/strong> and the <a href="https:\/\/docs\.example\.com\/plan">plan<\/a><\/p>/)
  assert.ok(!/<script|alert\(1\)/.test(d.html), 'the description\'s script is gone')
  assert.match(d.html, /<h2>Guests \(3\)<\/h2>/)
  assert.match(d.html, /<h3>Going \(2\)<\/h3><ul><li><span class="person">Ann Example<\/span> <span class="muted">ann@example\.com<\/span> <span class="muted">\(organizer\)<\/span><\/li><li><span class="person">me@example\.com<\/span> <span class="muted">\(you\)<\/span><\/li><\/ul>/)
  assert.match(d.html, /<h3>Maybe \(1\)<\/h3>/)
  assert.match(d.html, /<h3>Rooms<\/h3><ul><li>room-1@resource\.calendar\.google\.com<\/li><\/ul>/)
  assert.match(d.aside, /^<dl class="facts"><dt>Calendar<\/dt><dd>me@example\.com<\/dd><dt>When<\/dt>/)
  assert.match(d.aside, /<dt>Guests<\/dt><dd>3: 2 yes, 1 maybe, 0 no answer<\/dd>/)
  assert.match(d.aside, /<dt>Conference<\/dt><dd>Google Meet<\/dd>/)
})

test('hostile text is escaped everywhere: a title, a location, a guest name, an attachment', () => {
  const raw = ev('x', '2026-11-03', '10:00', '11:00', {
    title: '<img src=x onerror=alert(1)>',
    location: '"><script>alert(2)</script>',
    organizer: { email: ANN, displayName: '<b>Ann</b>' },
    attendees: [guest(ANN, 'accepted', { organizer: true, displayName: '<i>Ann</i>' }), self('needsAction')],
    description: 'plain text with <notatag> & a link https://example.com/a?b=1&c=2',
    extra: { attachments: [{ title: '<x>', fileUrl: 'javascript:alert(3)' }, { title: 'Plan', fileUrl: 'https://drive.google.com/file/d/1' }] },
  })
  const d = docOf(raw)
  assert.ok(!/<img|<script|<b>|<i>|<x>|<notatag>|javascript:/.test(d.html + d.aside))
  assert.match(d.html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(d.html, /<h2>Attachments<\/h2><ul class="attachment-list"><li><a href="https:\/\/drive\.google\.com\/file\/d\/1">Plan<\/a><\/li><\/ul>/)
})

test('the text: what Claude reads; the event in its own zone when the display zone differs; all-day spans', () => {
  const d = docOf(review(), { tz: 'America/New_York', jiraLines: ['Jira issue ACME-12: New checkout page (In Progress)'] })
  assert.match(d.text, /^Design review ACME-12\nWhen: Tue 3 Nov, 05:00–06:00 \(America\/New_York\)\n\(11:00–12:00 in Europe\/Berlin\)\n/)
  assert.match(d.text, /\nJira issue ACME-12: New checkout page \(In Progress\)\n/)
  assert.match(d.text, /\nGuests \(3\):\n {2}✓ Ann Example <ann@example\.com> \(organizer\)\n {2}✓ me@example\.com \(you\)\n {2}\? Bob Example <bob@example\.com>\n {2}room: room-1@resource\.calendar\.google\.com$/)
  const conf = world().events[ME].find((e) => e.id === 'conf1')
  const c = docOf(conf)
  assert.match(c.text, /^Acme conference\nWhen: Tue 10 Nov – Thu 12 Nov, all day\n/)
  assert.match(c.text, /Shows as free/)
  assert.equal(D.ownZoneText({ allDay: false, zone: 'Europe/Paris', start: NOW, end: NOW + 3600000 }, TZ), '', 'another name of the same clock: nothing said')
})

test('the Discuss prompt says what it is about, then the text', () => {
  const raw = review()
  const e = compactEvent(raw, { cal: PRIMARY, me: ME, tz: TZ })
  const p = D.discussPrompt(e, 'TEXT', TZ, NOW)
  assert.equal(p, 'About the meeting "Design review ACME-12" on Tue 3 Nov 11:00 (from my Google Calendar):\n\nTEXT')
})

test('Jira: keys in the title, location and description (at most 3, once each), site links, not inside words', () => {
  const site = 'https://acme.atlassian.example'
  assert.deepEqual(J.keysIn(['Review ACME-12', 'Room ACME-12', `see ${site}/browse/OPS-7 and xACME-1 or acme-3 and ACME-12x`], site), ['ACME-12', 'OPS-7'])
  assert.deepEqual(J.keysIn(['A-1 B-2 C-3 D-4'], site), ['A-1', 'B-2', 'C-3'])
  assert.deepEqual(J.keysIn([null, undefined, ''], site), [])
  assert.equal(J.chip('ACME-12', { status: 'In Progress' }), 'ACME-12 · In Progress')
  assert.equal(J.chip('ACME-12', null), 'ACME-12')
  assert.match(J.issueFacts('ACME-12', { status: 'Done', done: true, summary: 'Checkout' }, `${site}/browse/ACME-12`, esc), /lozenge-success">Done<\/span> Checkout/)
  assert.equal(J.jiraContext({ ready: true, site: 'http://insecure.example' }), null)
  assert.equal(J.jiraContext({ ready: false, site }), null)
  assert.deepEqual(J.jiraContext({ ready: true, site }), { site })
  assert.match(J.checkDocument({ html: 'x'.repeat(100) }, 10, new Set()).error, /too long/)
  const ok = J.checkDocument({ key: 'ACME-12', html: '<p>x</p>', assets: [{ id: 'a1', dataUrl: 'data:image/png;base64,AAAA' }, { id: 'bad id', dataUrl: 'data:image/png;base64,AAAA' }, { id: 'a2', dataUrl: 'https://x.example/p.png' }] }, 1000, new Set())
  assert.deepEqual(ok.assets.map((a) => a.id), ['a1'])
  assert.equal(ok.title, 'Jira issue ACME-12')
})

test('Jira lookups: cached, a failure retried after a minute, a late answer calls back once', async () => {
  let clock = NOW
  let calls = 0
  let late = 0
  const l = J.createLookups({ issue: async (key) => (calls++, key === 'BAD-1' ? Promise.reject(new Error('down')) : { key, status: 'Open' }), now: () => clock, onLate: () => late++ })
  await l.ensure([{ key: 'ACME-12' }, { key: 'BAD-1' }], 500)
  assert.deepEqual(l.peek('ACME-12'), { key: 'ACME-12', done: false, mine: false, status: 'Open' })
  assert.equal(l.peek('BAD-1'), null)
  await l.ensure([{ key: 'ACME-12' }, { key: 'BAD-1' }], 500)
  assert.equal(calls, 2, 'both cached')
  clock += 61000
  await l.ensure([{ key: 'BAD-1' }], 500)
  assert.equal(calls, 3)
  let release
  const slow = J.createLookups({ issue: () => new Promise((r) => (release = () => r({ key: 'S-1', status: 'Open' }))), now: () => clock, onLate: () => late++ })
  const r = await slow.ensure([{ key: 'S-1' }], 5)
  assert.equal(r.late, 1)
  release()
  await new Promise((res) => setTimeout(res, 5))
  assert.equal(late, 1)
  assert.equal(slow.peek('S-1').status, 'Open')
})
