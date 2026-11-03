'use strict'
// `ccc calendar` (lib/cli.js), on its own with plain deps (usage errors, before a sign-in, the client
// file read from a path) and through the host over the example week (status, today, next, upcoming,
// show, rsvp, refresh, login, logout).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { runCli, statusText, notReady, flags, HELP } = require('../dist/lib/cli')
const { tmpDir, fixture, NOW, ME, TEAM, CLIENT_SECRET } = require('./fakes')
const { boot, signedIn, settle } = require('./helpers')

const base = { client: null, signedIn: false, ready: false, settingsMissing: [], problems: [] }
const deps = (st, extra = {}) => ({ status: () => st, now: () => NOW, view: () => null, refresh: async () => ({}), show: async () => 'text', rsvp: async () => ({ message: 'ok' }), login: async () => ({ message: 'go' }), logout: async () => ({}), client: async () => ({ ok: true, message: 'saved' }), ...extra })

test('help, unknown commands, usage errors exit 2', async () => {
  assert.equal((await runCli([], deps(base))).stdout, HELP)
  assert.equal((await runCli(['help'], deps(base))).stdout, HELP)
  assert.equal((await runCli(['today', '--help'], deps(base))).stdout, HELP)
  const u = await runCli(['frobnicate'], deps(base))
  assert.equal(u.code, 2)
  assert.match(u.stderr, /unknown command "frobnicate"/)
  for (const argv of [['show'], ['rsvp'], ['show', '../etc'], ['rsvp', 'budget1'], ['rsvp', 'budget1', 'sure'], ['rsvp', 'budget1', 'yes', 'extra'], ['show', 'x', '--calendar', 'a/b'], ['show', 'x', '--frob'], ['client']]) {
    assert.equal((await runCli(argv, deps({ ...base, ready: true }))).code, 2, argv.join(' '))
  }
  for (const sub of ['status', 'refresh', 'today', 'next', 'upcoming', 'show', 'rsvp', 'login', 'logout', 'client', 'help']) assert.match(HELP, new RegExp(`ccc calendar ${sub}\\b`))
  assert.match(HELP, /changes nothing in Google Calendar but your own answer to an invitation/)
})

test('flags: --calendar and --one anywhere, checked', () => {
  assert.deepEqual(flags(['x', '--one', '--calendar', TEAM, 'yes']), { args: ['x', 'yes'], calendar: TEAM, one: true, bad: null })
  assert.deepEqual(flags([`--calendar=${TEAM}`, 'x']).calendar, TEAM)
  assert.match(flags(['--calendar']).bad, /not a calendar id/)
})

test('before a sign-in: the first thing missing', async () => {
  assert.match(notReady(base), /No OAuth client yet/)
  assert.match(notReady({ ...base, client: { id: 'x', source: 'pasted' } }), /Not signed in/)
  assert.match(notReady({ ...base, client: { id: 'x' }, signedIn: true, blocked: 'lacks events' }), /lacks events/)
  for (const cmd of ['today', 'next', 'upcoming', 'refresh']) {
    const r = await runCli([cmd], deps(base))
    assert.equal(r.code, 1)
    assert.match(r.stderr, /No OAuth client yet/)
  }
  assert.match((await runCli(['rsvp', 'budget1', 'yes'], deps(base))).stderr, /No OAuth client yet/)
  assert.match(statusText({ ...base, client: { id: '1234…', source: 'settings' }, signedOutReason: 'Google no longer accepts it' }, NOW), /Google no longer accepts it/)
  assert.match(statusText(base, NOW), /client +\(none\)/)
})

test('client <file>: read relative to the caller\'s directory; not a file, too big, missing', async () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify(fixture('client_secret.json')))
  let got = null
  const d = deps(base, { client: async (text) => ((got = text), { ok: true, message: 'Client saved' }) })
  const r = await runCli(['client', 'client.json'], d, { cwd: dir })
  assert.equal(r.code, 0)
  assert.match(got, /installed/)
  assert.match((await runCli(['client', 'nope.json'], d, { cwd: dir })).stderr, /cannot read .*ENOENT/)
  assert.match((await runCli(['client', '.'], d, { cwd: dir })).stderr, /is not a file/)
  fs.writeFileSync(path.join(dir, 'big.json'), 'x'.repeat(70000))
  assert.match((await runCli(['client', 'big.json'], d, { cwd: dir })).stderr, /too big/)
  const refused = await runCli(['client', 'client.json'], deps(base, { client: async () => ({ ok: false, error: 'This is a "Web application" client.' }) }), { cwd: dir })
  assert.equal(refused.code, 1)
})

test('through the host: login with the client file, status, today, next, upcoming over the example week', async () => {
  const b = boot()
  await b.h.ready
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'client.json'), JSON.stringify(fixture('client_secret.json')))
  const c = await b.ctx.runCli(['client', 'client.json'], dir)
  assert.match(c.stdout, /Client saved \(123456789012…\)\. Next: ccc calendar login\./)
  const l = await b.ctx.runCli(['login'])
  assert.match(l.stdout, /Your browser opens the Google sign-in/)
  await settle(b)
  await new Promise((r) => setTimeout(r, 10))
  await settle(b)
  const st = (await b.ctx.runCli(['status'])).stdout
  assert.match(st, /account +me@example\.com/)
  assert.match(st, /scopes +all granted \(answering invitations on\)/)
  assert.match(st, /time zone Europe\/Berlin \(your Google Calendar's time zone\)/)
  assert.match(st, /calendar +\[x\] me@example\.com \(primary\)\n/)
  assert.match(st, /calendar +\[ \] Acme Team acme-team@group\.calendar\.google\.com\n/)
  assert.match(st, /counts +today 6 · tomorrow 2 · upcoming 5 · invitations 2 · conflicts 2/)
  assert.match(st, /reminders 10 min, 2 min before, with the app's sound/)
  assert.ok(!st.includes(CLIENT_SECRET) && !st.includes('ya29') && !st.includes('1//'))
  const today = (await b.ctx.runCli(['today'])).stdout
  assert.match(today, /^Today \(Tue 3 Nov\)\n/)
  assert.match(today, /all day +Home \(working location\) +wl1/)
  assert.match(today, /09:30–09:45 +Standup +\[Meet\] ✓ +standup_20261103T083000Z/)
  assert.match(today, /11:00–12:00 +Design review ACME-12 +\[Meet\] ✓ ⚠ overlaps Vendor call 11:30–12:15 +review1/)
  assert.match(today, /Tomorrow \(Wed 4 Nov\)\n/)
  assert.match(today, /14:00–15:00 +Budget planning +· +budget1/)
  assert.match(today, /2 invitations waiting/)
  assert.ok(!today.includes('Offsite lunch'), 'declined: hidden')
  const next = (await b.ctx.runCli(['next'])).stdout
  assert.match(next, /^Next: Standup, today 09:30–09:45, in 30 min\n {2}join +https:\/\/meet\.google\.com\/abc-defg-hij\n/)
  const up = (await b.ctx.runCli(['upcoming'])).stdout
  assert.match(up, /Thu 5 · 10:00 · Weekly 1:1 +· +weekly11_20261105T090000Z/)
  assert.match(up, /Tue 10 · all day, 3 days · Acme conference +\(free\) +conf1/)
  assert.match(up, /Invitations \(2\)\n {2}Budget planning · Wed 4 14:00–15:00 · from Bob Example +budget1\n {2}Weekly 1:1 · repeats · next Thu 5 10:00–10:30 · 2 in reach · from Ann Example +weekly11_20261105T090000Z/)
})

test('through the host: show reads the event fresh as text; another calendar\'s event needs --calendar', async () => {
  const b = await signedIn({ project: { calendars: [TEAM] } })
  const s = await b.ctx.runCli(['show', 'review1'])
  assert.equal(s.code, 0)
  assert.match(s.stdout, /^Design review ACME-12\nWhen: Tue 3 Nov, 11:00–12:00 \(Europe\/Berlin\)\nCalendar: me@example\.com\nYour answer: Accepted\nOrganizer: Ann Example <ann@example\.com>\nWhere: Room 1\nJoin: https:\/\/meet\.google\.com\/rev-iewx-yzq\nDial-in: \+1 555-0100, PIN 123456\n/)
  assert.match(s.stdout, /Description:\nAgenda: ACME-12 and the plan <https:\/\/docs\.example\.com\/plan>/)
  assert.ok(!s.stdout.includes('alert(1)'))
  assert.match(s.stdout, /Guests \(3\):\n {2}✓ Ann Example <ann@example\.com> \(organizer\)/)
  assert.match(s.stdout, /room: room-1@resource\.calendar\.google\.com/)
  assert.ok(b.google.calls.some((c) => c.path === '/calendar/v3/calendars/me%40example.com/events/review1'))
  const retro = await b.ctx.runCli(['show', 'retro1', '--calendar', TEAM])
  assert.match(retro.stdout, /^Team retro\n/)
  assert.match(retro.stdout, /Calendar: Acme Team\nYour answer: You are not a guest/)
  assert.match((await b.ctx.runCli(['today'])).stdout, /Team retro +\(Acme Team\) +retro1 --calendar acme-team@group\.calendar\.google\.com/)
  const missing = await b.ctx.runCli(['show', 'nosuch'])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /not among the last poll's events/)
})

test('through the host: rsvp answers (the series by default, --one for that occurrence); refresh prints the counts', async () => {
  const b = await signedIn()
  const one = await b.ctx.runCli(['rsvp', 'weekly11_20261105T090000Z', 'maybe', '--one'])
  assert.equal(one.code, 0, one.stderr)
  assert.match(one.stdout, /^Maybe "Weekly 1:1" \(this occurrence\)\. The organizer is told\.\n$/)
  assert.equal(b.google.writes.at(-1).id, 'weekly11_20261105T090000Z')
  await settle(b)
  const all = await b.ctx.runCli(['rsvp', 'weekly11_20261112T090000Z', 'yes'])
  assert.match(all.stdout, /^Accepted "Weekly 1:1" \(the whole series\)/)
  assert.equal(b.google.writes.at(-1).id, 'weekly11')
  assert.match((await b.ctx.runCli(['rsvp', 'vendor1', 'no'])).stderr, /You organize this event/)
  await settle(b)
  const r = await b.ctx.runCli(['refresh'])
  assert.match(r.stdout, /^today 6 · tomorrow 2 · upcoming 5 · invitations 1/)
})

test('through the host: logout signs out; the agenda commands then say so', async () => {
  const b = await signedIn()
  assert.match((await b.ctx.runCli(['logout'])).stdout, /Signed out/)
  const t = await b.ctx.runCli(['today'])
  assert.equal(t.code, 1)
  assert.match(t.stderr, /Not signed in to Google: ccc calendar login/)
  assert.match((await b.ctx.runCli(['status'])).stdout, /sign-in +not signed in/)
})

test('a stale agenda says so under the output; status names the error', async () => {
  const fail = {}
  const b = await signedIn({ google: { fail } })
  b.tick(10 * 60000)
  fail[`events:${ME}`] = 500
  const r = await b.ctx.runCli(['refresh'])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /^refresh failed: Google Calendar had a problem \(500\)/)
  const t = await b.ctx.runCli(['today'])
  assert.equal(t.code, 0)
  assert.match(t.stdout, /Standup/)
  assert.match(t.stdout, /\(as of the last good poll, 10 min ago: Google Calendar had a problem \(500\).*\(every 6 min for now\)\.\)\n$/)
  assert.match((await b.ctx.runCli(['status'])).stdout, /now every 6 min: Google Calendar was busy/)
})
