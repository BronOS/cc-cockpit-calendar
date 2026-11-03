'use strict'
// The host end to end with a fake ctx, a fake Google sign-in and a fake Google Calendar: setup,
// sign-in and the grant, polling (the jittered interval, backoff, a new day), the stored agenda, the
// settings and the picker, the title bar and the badge, Join and Open in Calendar, the detail view
// and its fallbacks (with the Jira issue beside it), Discuss, and the rule that no token or secret
// ever reaches a panel message, a log line, a notification or the CLI output.
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const T = require('../dist/lib/time')
const { fakeStorage, fakeSecrets, fakeReviewer, fakeJira, tmpDir, NOW, ME, TEAM, HOLIDAYS, CLIENT_SECRET, ALL_SCOPES } = require('./fakes')
const { boot, signedIn, settle, until, rowOf, everythingSaid, CLIENT_FILE } = require('./helpers')

const tab = (tabId, status, extra = {}) => ({ tabId, status, cwd: `/p/${tabId}`, notes: [], files: [], ...extra })
const MIN = 60000

test('not configured: the setup guide, no request to Google, status says what to do', async () => {
  const { ctx, h, google, oauth } = boot()
  await h.ready
  await ctx.sendPanel({ type: 'hello' })
  const st = ctx.lastState()
  assert.equal(st.tooOld, null)
  assert.equal(st.auth.signedIn, false)
  assert.equal(st.auth.client, null)
  assert.equal(st.view, null)
  assert.ok(st.steps.some((s) => s.links.some((l) => l.id === 'calendarApi')))
  await h.pollNow('test')
  await h.tick()
  assert.equal(google.calls.length, 0)
  assert.equal(oauth.authorizes.length, 0)
  const r = await ctx.runCli(['status'])
  assert.match(r.stdout, /client +\(none\)/)
  assert.match(r.stdout, /ccc calendar client <file\.json>/)
  assert.equal(ctx.schedules[0].seconds, 15)
  assert.equal(ctx.cliName, 'calendar')
  assert.deepEqual(ctx.headers.at(-1).actions.map((a) => a.id), ['refresh'])
  // A setup link opens a fixed URL; an id the host does not know opens nothing.
  await ctx.sendPanel({ type: 'link', id: 'calendarApi' })
  await ctx.sendPanel({ type: 'link', id: 'https://evil.example' })
  assert.deepEqual(ctx.external, ['https://console.cloud.google.com/apis/library/calendar-json.googleapis.com'])
})

test('an app before 0.9.4: the panel and the CLI say to update; nothing is scheduled or polled', async () => {
  const { ctx, h, google } = boot({ old: true })
  await h.ready
  await ctx.sendPanel({ type: 'hello' })
  assert.match(ctx.lastState().tooOld, /needs cc-cockpit 0\.9\.4 or later \(this app has no ctx\.oauth, ctx\.secrets, ctx\.panels\.header, ctx\.openExternal, ctx\.appStorage\)/)
  assert.equal(ctx.schedules.length, 0)
  assert.match((await ctx.runCli(['status'])).stdout, /needs cc-cockpit 0\.9\.4/)
  assert.equal((await ctx.runCli(['today'])).code, 1)
  assert.equal(google.calls.length, 0)
  assert.deepEqual(host._apiGaps({ oauth: { authorize() {}, refresh() {} }, secrets: { get() {} }, panels: { header() {} }, openExternal() {}, appStorage: { increment() {} } }), [])
})

test('paste and sign in: the first poll, the agenda, the badge, the title bar; Start over while the browser is open', async () => {
  const b = boot()
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: '{"web":{}}' })
  assert.match(b.ctx.lastState().clientError, /Web application/)
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  assert.equal(b.ctx.lastState().clientError, null)
  assert.match(b.ctx.lastState().notice.text, /Client saved \(123456789012…\)\. Next: Sign in with Google\./)
  let open
  b.oauth.gate = new Promise((r) => (open = r))
  await b.ctx.sendPanel({ type: 'signIn' })
  assert.equal(b.ctx.lastState().auth.signingIn, true)
  await b.ctx.sendPanel({ type: 'signIn' })
  assert.equal(b.oauth.authorizes.length, 2, 'Start over: a second authorize')
  open()
  await until(() => b.h.S.state && b.h.S.state.lastPoll)
  await settle(b)
  const st = b.ctx.lastState()
  assert.equal(st.auth.signedIn, true)
  assert.equal(st.account, ME)
  assert.equal(st.notice.text, `Signed in as ${ME}.`)
  assert.equal(st.view.invitations.length, 2)
  assert.equal(b.ctx.badges.at(-1), 2)
  assert.equal(b.ctx.headers.at(-1).meta, `next: Standup in 30 min · ${ME}`)
  assert.deepEqual(b.ctx.headers.at(-1).actions.map((a) => [a.id, Boolean(a.disabled)]), [['join', true], ['refresh', false]])
  // The panel gets keys, never event ids or URLs.
  const json = JSON.stringify(st.view)
  assert.ok(!/"id":|calendarId|https:\/\/|meet\.google|budget1/.test(json))
  const said = everythingSaid(b.ctx)
  assert.ok(!said.includes(CLIENT_SECRET) && !said.includes('ya29.') && !said.includes('1//refresh'))
})

test('the grant: a sign-in without the events scope is blocked (said how to fix), nothing polled', async () => {
  const b = await signedIn({ oauthOpts: { scope: [ALL_SCOPES[0], ALL_SCOPES[2]] } })
  const st = b.ctx.lastState()
  assert.match(st.blocked, /lacks calendar\.events\.readonly .*no event can be read: nothing is polled\. Sign in again and leave every box ticked/)
  assert.equal(st.view, null)
  assert.equal(b.google.calls.length, 0)
  assert.equal(st.notice.kind, 'error')
  assert.match((await b.ctx.runCli(['status'])).stdout, /scopes +missing calendar\.events\.readonly/)
})

test('the grant not known and Google answers 403 for the scope: blocked, and the record says so', async () => {
  const b = await signedIn({ oauthOpts: { scope: null }, google: { fail: { list: 403 } } })
  assert.match(b.h.S.blocked, /lacks calendar\.calendarlist\.readonly/)
  assert.deepEqual(b.h.auth.status().grant, { missing: ['calendars'] })
})

test('the Calendar API not enabled: one error that says where to enable it', async () => {
  const b = await signedIn({ google: { fail: { list: 'disabled' } } })
  const st = b.ctx.lastState()
  assert.match(st.error, /Calendar API is not enabled in your Google Cloud project/)
  assert.equal(st.auth.signedIn, true)
})

test('polling: every pollMinutes ±25% (jittered), only from the tick; a busy Google doubles the interval, then it recovers', async () => {
  const fail = {}
  const b = await signedIn({ google: { fail } })
  const evCalls = () => b.google.calls.filter((c) => c.path.endsWith('/events')).length
  const n0 = evCalls()
  // random() = 0.5: exactly 3 min.
  assert.equal(b.h.S.nextPollAt, b.clock.t + 3 * MIN)
  b.tick(2 * MIN)
  await b.h.tick()
  await settle(b)
  assert.equal(evCalls(), n0)
  b.tick(MIN)
  await b.h.tick()
  await settle(b)
  assert.equal(evCalls(), n0 + 1)
  fail[`events:${ME}`] = 429
  b.tick(3 * MIN)
  await b.h.tick()
  await settle(b)
  assert.equal(b.h.S.backoffMinutes, 6)
  assert.match(b.ctx.lastState().error, /rate limiting.*\(every 6 min for now\)/)
  assert.equal(b.ctx.lastState().stale, true)
  assert.match(b.ctx.headers.at(-1).meta, / · as of 09:0\d · /)
  assert.equal(b.h.S.nextPollAt, b.clock.t + 6 * MIN)
  delete fail[`events:${ME}`]
  b.tick(6 * MIN)
  await b.h.tick()
  await settle(b)
  assert.equal(b.h.S.backoffMinutes, 0)
  assert.equal(b.ctx.lastState().error, null)
})

test('the jitter: the next poll falls within ±25% of the interval', async () => {
  for (const [r, minutes] of [[0, 2.25], [1, 3.75]]) {
    const b = boot()
    b.h.S.settings.cfg.pollMinutes = 3
    await b.h.ready
    const t0 = b.clock.t
    // planNextPoll runs after every poll (also one that does nothing because nobody is signed in).
    const h = host._start(b.ctx, { fetch: b.google.fetch, now: () => t0, random: () => r, setTimeout: () => 0, clearTimeout: () => {} })
    await h.ready
    await h.pollNow('test')
    assert.equal(h.S.nextPollAt, t0 + minutes * MIN)
    h.stop()
  }
})

test('a new day: the tick after midnight polls at once and Today moves on', async () => {
  const b = await signedIn()
  const n = b.google.calls.length
  b.clock.t = Date.parse('2026-11-03T23:00:30Z') // 00:00:30 Berlin, Wed 4 Nov
  b.h.S.nextPollAt = b.clock.t + 10 * MIN
  await b.h.tick()
  await settle(b)
  assert.ok(b.google.calls.length > n)
  assert.equal(b.h.S.state.day, '2026-11-04')
  assert.equal(b.ctx.lastState().view.today.day, '2026-11-04')
  assert.ok(b.ctx.lastState().view.today.rows.some((r) => r.title === 'Customer demo'))
})

test('the last agenda is shown at once after a restart (before any poll), only for the same client', async () => {
  const dataDir = tmpDir()
  const storage = fakeStorage()
  const secrets = fakeSecrets()
  const a = await signedIn({ dataDir, storage, secrets })
  await a.h.stop()
  const b = boot({ dataDir, storage, secrets })
  await b.h.ready
  await b.ctx.sendPanel({ type: 'hello' })
  const st = b.ctx.lastState()
  assert.equal(st.account, ME)
  assert.equal(st.view.next.title, 'Standup')
  assert.equal(b.google.calls.length, 0)
  assert.equal(b.ctx.badges.at(-1), 2)
})

test('settings: a calendar added is read on the next poll at once; another client id signs out and forgets the agenda', async () => {
  const b = await signedIn()
  await b.ctx.changeSettings({ calendars: [TEAM] })
  await settle(b)
  assert.ok(b.google.calls.some((c) => c.path.includes('acme-team%40group.calendar.google.com')))
  assert.ok(rowOf(b.ctx.lastState(), 'Team retro', 'today'))
  const team = b.ctx.lastState().calendars.find((c) => c.id === TEAM)
  assert.deepEqual([team.on, team.from], [true, 'settings'])
  await b.ctx.changeSettings({ calendars: [TEAM, 'ghost@example.com'] })
  await settle(b)
  assert.deepEqual(b.ctx.lastState().missingCalendars, ['ghost@example.com'])
  // The pasted client wins over the settings fields, so remove it first: then the settings client is in use.
  await b.ctx.changeSettings({ clientId: '555555555555-settingsclient.apps.googleusercontent.com', clientSecret: 'GOCSPX-settings-secret' })
  await b.ctx.sendPanel({ type: 'removeClient' })
  await settle(b)
  const st = b.ctx.lastState()
  assert.equal(st.auth.signedIn, false)
  assert.equal(st.auth.client.source, 'settings')
  assert.equal(st.view, null)
  assert.equal(b.h.S.state.lastPoll, 0)
})

test('the picker: a calendar of the list switched on for this project (kept in storage), read with its colour; primary and settings ones are not switchable', async () => {
  const b = await signedIn({ project: { calendars: [TEAM] } })
  await b.ctx.sendPanel({ type: 'pick', id: HOLIDAYS })
  await settle(b)
  assert.deepEqual(await b.ctx.storage.get('picked'), [HOLIDAYS])
  const st = b.ctx.lastState()
  const h = st.calendars.find((c) => c.id === HOLIDAYS)
  assert.deepEqual([h.on, h.from], [true, 'picked'])
  const chip = st.view.upcoming.rows.find((r) => r.title === 'Example Day')
  assert.equal(chip.color, '#795548')
  assert.equal(chip.calendar, 'Holidays')
  await b.ctx.sendPanel({ type: 'pick', id: ME })
  await b.ctx.sendPanel({ type: 'pick', id: TEAM })
  await b.ctx.sendPanel({ type: 'pick', id: 'not-in-the-list@example.com' })
  assert.deepEqual(await b.ctx.storage.get('picked'), [HOLIDAYS])
  await b.ctx.sendPanel({ type: 'pick', id: HOLIDAYS })
  await settle(b)
  assert.deepEqual(await b.ctx.storage.get('picked'), [])
  assert.ok(!b.ctx.lastState().view.upcoming.rows.some((r) => r.title === 'Example Day'))
  await b.ctx.sendPanel({ type: 'toggleCalendars' })
  assert.equal(b.ctx.lastState().ui.calendarsOpen, true)
  assert.deepEqual(await b.ctx.storage.get('ui'), { calendarsOpen: true })
})

test('Join: the Meet link of the last poll, from a row and from the title bar (only inside the join window)', async () => {
  const b = await signedIn()
  const standup = rowOf(b.ctx.lastState(), 'Standup', 'today')
  await b.ctx.sendPanel({ type: 'join', key: standup.key })
  assert.deepEqual(b.ctx.external, ['https://meet.google.com/abc-defg-hij'])
  await b.ctx.clickAction('join')
  assert.equal(b.ctx.external.length, 1, 'not in the join window yet: the title bar has nothing to join')
  b.clock.t = Date.parse('2026-11-03T08:25:00Z')
  await b.h.tick()
  await settle(b)
  assert.equal(b.ctx.headers.at(-1).actions[0].disabled, false)
  assert.equal(b.ctx.headers.at(-1).actions[0].title, 'Join Standup')
  await b.ctx.clickAction('join')
  assert.equal(b.ctx.external.at(-1), 'https://meet.google.com/abc-defg-hij')
  const vendor = rowOf(b.ctx.lastState(), 'Vendor call', 'today')
  await b.ctx.sendPanel({ type: 'join', key: vendor.key })
  assert.match(b.ctx.lastState().notice.text, /"Vendor call" has no Google Meet link/)
  b.ctx.externalError = 'at most 3 a 10 s'
  await b.ctx.sendPanel({ type: 'join', key: standup.key })
  assert.match(b.ctx.lastState().notice.text, /Could not open the browser \(at most 3 a 10 s\)\. The address: https:\/\/meet\.google\.com\/abc-defg-hij/)
})

test('Open in Calendar: the event\'s own link with the account as authuser; a key not in the agenda opens nothing', async () => {
  const b = await signedIn()
  const review = rowOf(b.ctx.lastState(), 'Design review ACME-12', 'today')
  await b.ctx.sendPanel({ type: 'calendar', key: review.key })
  assert.deepEqual(b.ctx.external, ['https://www.google.com/calendar/event?eid=review1&authuser=me%40example.com'])
  await b.ctx.sendPanel({ type: 'calendar', key: '0123456789abcdef' })
  await b.ctx.sendPanel({ type: 'join', key: 'https://evil.example' })
  await b.ctx.sendPanel({ type: 'open', key: { toString: () => 'x' } })
  assert.equal(b.ctx.external.length, 1)
})

test('open: the reviewer\'s annotate with the clean html and the facts, read fresh; the event\'s key and Calendar link', async () => {
  const reviewer = fakeReviewer()
  const b = await signedIn({ reviewer, sessions: [tab('t1', 'waiting', { active: true })] })
  const review = rowOf(b.ctx.lastState(), 'Design review ACME-12', 'today')
  await b.ctx.sendPanel({ type: 'open', key: review.key })
  const a = reviewer.calls[0]
  assert.equal(a.title, 'Design review ACME-12')
  assert.match(a.key, /^calendar:[a-f0-9]{24}$/)
  assert.equal(a.url, 'https://www.google.com/calendar/event?eid=review1&authuser=me%40example.com')
  assert.equal(a.urlLabel, 'Calendar')
  assert.equal(a.label, 'Event')
  assert.equal(a.tabId, 't1')
  assert.match(a.html, /^<h1>Design review ACME-12<\/h1>/)
  assert.match(a.html, /Overlaps Vendor call 11:30–12:15/)
  assert.match(a.aside, /^<dl class="facts">/)
  assert.equal(a.companion, undefined, 'no Jira plugin: nothing beside it')
  assert.ok(b.google.calls.some((c) => c.path.endsWith('/events/review1')))
})

test('open with the Jira plugin: chips with the status on the rows, the issue beside the event (reviewer companion), its facts', async () => {
  const reviewer = fakeReviewer({ companion: true })
  const jira = fakeJira()
  const b = await signedIn({ reviewer, jira })
  await until(() => {
    const r = rowOf(b.ctx.lastState(), 'Design review ACME-12', 'today')
    return r && r.jira[0] === 'ACME-12 · In Progress'
  })
  const review = rowOf(b.ctx.lastState(), 'Design review ACME-12', 'today')
  await b.ctx.sendPanel({ type: 'open', key: review.key })
  const a = reviewer.calls[0]
  assert.equal(a.companion.label, 'Jira · ACME-12')
  assert.equal(a.companion.url, 'https://acme.atlassian.example/browse/ACME-12')
  assert.match(a.companion.html, /New checkout page/)
  assert.match(a.aside, /<dt>Jira issue<\/dt><dd><a href="https:\/\/acme\.atlassian\.example\/browse\/ACME-12">ACME-12<\/a> <span class="lozenge lozenge-info">In Progress<\/span> New checkout page<\/dd>/)
  assert.match((await b.ctx.runCli(['status'])).stdout, /jira +on \(bronos\.jira\)/)
  // A reviewer without the companion: the event alone, with the issue in its facts.
  const plain = fakeReviewer()
  const c = await signedIn({ reviewer: plain, jira: fakeJira() })
  await c.ctx.sendPanel({ type: 'open', key: rowOf(c.ctx.lastState(), 'Design review ACME-12', 'today').key })
  assert.equal(plain.calls[0].companion, undefined)
  assert.match(plain.calls[0].aside, /Jira issue/)
})

test('open falls back: a reviewer that takes text only, then no reviewer at all (the plugin\'s own reader page)', async () => {
  const reviewer = fakeReviewer({ refuseHtml: true })
  const b = await signedIn({ reviewer })
  const key = rowOf(b.ctx.lastState(), 'Design review ACME-12', 'today').key
  await b.ctx.sendPanel({ type: 'open', key })
  assert.equal(reviewer.calls.length, 2)
  assert.match(reviewer.calls[1].text, /^Design review ACME-12\nWhen: /)
  assert.match((await b.ctx.runCli(['status'])).stdout, /text only \(its html mode was refused/)
  await b.ctx.sendPanel({ type: 'open', key })
  assert.equal(reviewer.calls.length, 3, 'text at once this time')
  const c = await signedIn({ overlayAnswer: { kind: 'value', value: { action: 'newSession' } } })
  await c.ctx.sendPanel({ type: 'open', key: rowOf(c.ctx.lastState(), 'Design review ACME-12', 'today').key })
  const o = c.ctx.overlays[0]
  assert.equal(o.spec.file, 'panels/event.html')
  assert.deepEqual(o.posts[0], { type: 'doc', title: 'Design review ACME-12', parts: 1 })
  assert.match(o.posts[1].part, /<h2>Details<\/h2><dl class="facts">/)
  // The page may open only a link the host put into the document.
  o.send({ open: 'https://evil.example/' })
  o.send({ open: 'https://meet.google.com/rev-iewx-yzq' })
  o.send({ open: 'https://docs.example.com/plan' })
  await settle(c)
  assert.deepEqual(c.ctx.external, ['https://meet.google.com/rev-iewx-yzq', 'https://docs.example.com/plan'])
  // Its New session button: a new Claude tab about the event.
  await until(() => c.ctx.opened.length === 1)
  assert.match(c.ctx.opened[0].prompt, /^About the meeting "Design review ACME-12" on Tue 3 Nov 11:00 \(from my Google Calendar\):\n\nDesign review ACME-12\nWhen:/)
})

test('Discuss: to the active tab; several tabs: the person picks; none: says so', async () => {
  const b = await signedIn({ sessions: [tab('t1', 'waiting'), tab('t2', 'busy')] })
  const key = rowOf(b.ctx.lastState(), 'Budget planning', 'invitations').key
  await b.ctx.sendPanel({ type: 'discuss', key })
  const choose = b.ctx.lastState().choose
  assert.equal(choose.label, '"Budget planning"')
  assert.deepEqual(choose.tabs.map((t) => t.tabId), ['t1', 't2'])
  await b.ctx.sendPanel({ type: 'discuss', key, tabId: 't2' })
  assert.equal(b.ctx.sent[0].tabId, 't2')
  assert.match(b.ctx.sent[0].text, /^About the meeting "Budget planning" on Wed 4 Nov 14:00/)
  assert.match(b.ctx.lastState().notice.text, /Sent "Budget planning" to "t2"/)
  assert.equal(b.ctx.lastState().choose, null)
  b.ctx.sessionList = []
  await b.ctx.sendPanel({ type: 'discuss', key })
  assert.match(b.ctx.lastState().notice.text, /No Claude tab is open/)
})

test('time zones: the computer\'s zone by setting; the note says when the two differ', async () => {
  const b = await signedIn({ project: { timeZone: 'computer' } })
  const st = b.ctx.lastState()
  const zone = T.computerZone()
  assert.equal(st.view.tz, zone)
  if (zone !== 'Europe/Berlin') assert.match(st.zoneNote, new RegExp(`Times in ${zone.replace('/', '\\/')} \\(this computer's zone\\); your Google Calendar is set to Europe\\/Berlin\\.`))
  const c = await signedIn()
  if (zone !== 'Europe/Berlin') assert.match(c.ctx.lastState().zoneNote, /Times in Europe\/Berlin \(your Google Calendar's time zone\); this computer is in /)
  else assert.equal(c.ctx.lastState().zoneNote, '')
})

test('invalid_grant: the panel shows the sign-in again with the reason; Sign out deletes the sign-in', async () => {
  const b = await signedIn()
  b.oauth.invalidGrant = true
  b.h.auth.invalidate()
  await b.h.pollNow('test', true)
  await settle(b)
  const st = b.ctx.lastState()
  assert.equal(st.auth.signedIn, false)
  assert.match(st.auth.signedOutReason, /7 days/)
  assert.equal(st.error, null)
  const c = await signedIn()
  await c.ctx.sendPanel({ type: 'signOut' })
  assert.equal(c.ctx.lastState().auth.signedIn, false)
  assert.equal(c.ctx.lastState().view, null)
  assert.equal(c.ctx.badges.at(-1), null)
  assert.deepEqual((await c.ctx.secrets.keys()).filter((k) => k.startsWith('refresh:')), [])
})

test('stop: no message after deactivate; the agenda is flushed', async () => {
  const b = await signedIn()
  await b.h.stop()
  const n = b.ctx.posts.length
  await b.h.tick()
  await b.ctx.sendPanel({ type: 'hello' })
  assert.equal(b.ctx.posts.length, n)
})
