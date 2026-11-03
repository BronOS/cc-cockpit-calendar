'use strict'
// The small pure pieces: time zones (day starts across DST, wall times, spans), the ids that go into a
// URL, the scopes and the client file, the settings, the setup links, the title bar, and the token's
// one road out (http.js: the routes, the one write's body, Google's errors).
const test = require('node:test')
const assert = require('node:assert/strict')
const T = require('../dist/lib/time')
const { cut, oneLine, mapLimit, calendarId, eventId, eventKey, isKey, emailAddress, unique, ago } = require('../dist/lib/util')
const { oauthSpec, parseClientFile, checkClientId, SCOPE_LIST, SCOPE_TEXT, RSVP_SCOPE_REFUSED_TEXT, shortClientId } = require('../dist/lib/oauth-client')
const { readSettings } = require('../dist/lib/settings')
const { STEPS, LINKS, linkUrl } = require('../dist/lib/setup')
const { headerSpec, META_MAX } = require('../dist/lib/header')
const { googleRequest, rsvpBody, CalendarError, ROUTES, isBusy, DISABLED_TEXT, ADMIN_TEXT } = require('../dist/lib/http')
const { fixture, json, NOW, CLIENT_ID, CLIENT_SECRET, ME, TEAM, HOLIDAYS } = require('./fakes')

test('time: a day starts at local midnight in its zone, across DST changes and midnight gaps', () => {
  assert.equal(T.startOfDay('2026-11-03', 'Europe/Berlin'), Date.parse('2026-11-02T23:00:00Z'))
  assert.equal(T.startOfDay('2026-07-01', 'Europe/Berlin'), Date.parse('2026-06-30T22:00:00Z'))
  // The DST days themselves: 29 Mar 2026 starts at +01:00, 25 Oct 2026 at +02:00.
  assert.equal(T.startOfDay('2026-03-29', 'Europe/Berlin'), Date.parse('2026-03-28T23:00:00Z'))
  assert.equal(T.startOfDay('2026-03-30', 'Europe/Berlin'), Date.parse('2026-03-29T22:00:00Z'))
  assert.equal(T.startOfDay('2026-10-25', 'Europe/Berlin'), Date.parse('2026-10-24T22:00:00Z'))
  assert.equal(T.startOfDay('2026-10-26', 'Europe/Berlin'), Date.parse('2026-10-25T23:00:00Z'))
  assert.equal(T.startOfDay('2026-11-03', 'America/New_York'), Date.parse('2026-11-03T05:00:00Z'))
  assert.equal(T.startOfDay('2026-11-03', 'Asia/Kolkata'), Date.parse('2026-11-02T18:30:00Z'))
  assert.equal(T.startOfDay('2026-11-03', 'UTC'), Date.parse('2026-11-03T00:00:00Z'))
  // Havana springs forward at midnight (00:00 does not exist on 8 Mar 2026): the day starts at 01:00.
  const havana = T.startOfDay('2026-03-08', 'America/Havana')
  assert.equal(T.dayKey(havana, 'America/Havana'), '2026-03-08')
  assert.equal(T.dayKey(havana - 60000, 'America/Havana'), '2026-03-07')
  assert.equal(T.hm(havana, 'America/Havana'), '01:00')
})

test('time: day keys, wall times, ranges and spans in a zone; bad zones and times refused', () => {
  assert.equal(T.dayKey(NOW, 'Europe/Berlin'), '2026-11-03')
  assert.equal(T.dayKey(Date.parse('2026-11-03T23:30:00Z'), 'Europe/Berlin'), '2026-11-04')
  assert.equal(T.dayKey(Date.parse('2026-11-03T03:00:00Z'), 'America/Los_Angeles'), '2026-11-02')
  assert.equal(T.hm(NOW, 'Europe/Berlin'), '09:00')
  assert.equal(T.hm(NOW, 'America/New_York'), '03:00')
  assert.equal(T.range(NOW, NOW + 1800000, 'Europe/Berlin'), '09:00–09:30')
  assert.equal(T.range(NOW, NOW, 'Europe/Berlin'), '09:00')
  assert.equal(T.range(Date.parse('2026-11-03T22:00:00Z'), Date.parse('2026-11-04T08:00:00Z'), 'Europe/Berlin'), '23:00–Wed 4 09:00')
  assert.equal(T.range(Date.parse('2026-11-03T22:00:00Z'), Date.parse('2026-11-03T23:00:00Z'), 'Europe/Berlin'), '23:00–00:00', 'an end at midnight is the same day')
  assert.equal(T.shortDay('2026-11-06'), 'Fri 6')
  assert.equal(T.longDay('2026-11-06'), 'Fri 6 Nov')
  assert.equal(T.longDay('2027-01-04', 2026), 'Mon 4 Jan 2027')
  assert.equal(T.addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(T.addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(T.daysBetween('2026-11-10', '2026-11-13'), 3)
  assert.equal(T.span(45000), '45 s')
  assert.equal(T.span(12 * 60000), '12 min')
  assert.equal(T.span(11 * 60000 + 1000), '12 min', 'rounded up: "in 12 min" while 11:01 is left')
  assert.equal(T.span(125 * 60000), '2 h 5 min')
  assert.equal(T.span(72 * 3600000), '3 d')
  assert.equal(T.rfc3339(NOW), '2026-11-03T08:00:00Z')
  assert.equal(T.parseTime('2026-11-03T09:30:00+01:00'), Date.parse('2026-11-03T08:30:00Z'))
  for (const bad of ['2026-11-03', 'tomorrow', '2026-11-03T09:30', null, 5]) assert.equal(T.parseTime(bad), null, String(bad))
  assert.equal(T.validZone('Europe/Berlin'), 'Europe/Berlin')
  for (const bad of ['Mars/Olympus', '', '../x', null, 'a'.repeat(80)]) assert.equal(T.validZone(bad), null, String(bad))
  for (const bad of ['2026-02-30', '2026-13-01', '26-11-03', null]) assert.equal(T.validDay(bad), null, String(bad))
  assert.ok(T.validZone(T.computerZone()))
})

test('ids: calendar and event ids checked before they go into a URL; row keys', () => {
  for (const ok of [ME, TEAM, HOLIDAYS, 'primary', 'c_0123abc@group.calendar.google.com']) assert.equal(calendarId(ok), ok)
  for (const bad of ['', 'a/b', 'a b', '../x', 'a..b', 'x?y', '%2e', 'a'.repeat(255), null, 7]) assert.equal(calendarId(bad), null, String(bad))
  for (const ok of ['review1', 'standup_20261103T083000Z', 'abc-DEF_09']) assert.equal(eventId(ok), ok)
  for (const bad of ['', 'a/b', 'a.b', 'x?y', 'a'.repeat(1101), null]) assert.equal(eventId(bad), null, String(bad))
  const k = eventKey(ME, 'review1')
  assert.match(k, /^[a-f0-9]{16}$/)
  assert.notEqual(k, eventKey(TEAM, 'review1'), 'the same id on two calendars: two keys')
  assert.equal(isKey(k), true)
  assert.equal(isKey(`series:${k}`), true)
  for (const bad of ['', 'review1', `${k}0`, 'series:xyz', null, { k }]) assert.equal(isKey(bad), false, String(bad))
  assert.equal(emailAddress(' Me@Example.com '), 'me@example.com')
  assert.equal(emailAddress('not an address'), null)
  assert.deepEqual(unique(['a', 'b', 'a']), ['a', 'b'])
})

test('util: cut, oneLine, ago, mapLimit keeps order, limits and catches per item', async () => {
  assert.equal(cut('abcdef', 4), 'abc…')
  assert.equal(cut('abc', 4), 'abc')
  assert.equal(oneLine(' a\n\tb  c '), 'a b c')
  assert.equal(ago(NOW - 90000, NOW), '2 min ago')
  assert.equal(ago(0, NOW), 'never')
  let running = 0
  let most = 0
  const r = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
    running++
    most = Math.max(most, running)
    await new Promise((res) => setTimeout(res, 2))
    running--
    if (x === 3) throw new Error('three')
    return x * 10
  })
  assert.equal(most, 2)
  assert.deepEqual(r.map((x) => (x.ok ? x.value : x.error.message)), [10, 20, 'three', 40, 50])
})

test('scopes: the three asked for, worded as the consent page does; the refused-RSVP text says what to change', () => {
  assert.deepEqual(SCOPE_LIST, ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.events.owned'])
  assert.match(SCOPE_TEXT.rsvp.label, /calendar\.events\.owned/)
  assert.match(SCOPE_TEXT.rsvp.loses, /the agenda works/)
  assert.match(RSVP_SCOPE_REFUSED_TEXT, /dist\/lib\/oauth-client\.js/)
  assert.match(RSVP_SCOPE_REFUSED_TEXT, /RSVP_SCOPE to https:\/\/www\.googleapis\.com\/auth\/calendar\.events,/)
  assert.match(RSVP_SCOPE_REFUSED_TEXT, /Data access/)
  assert.match(RSVP_SCOPE_REFUSED_TEXT, /If Google refuses the RSVP scope/)
})

test('the client file: a Desktop client is taken, a Web one refused, the spec carries our scopes and fixed URLs', () => {
  const p = parseClientFile(JSON.stringify(fixture('client_secret.json')))
  assert.deepEqual(p, { ok: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.match(parseClientFile(JSON.stringify(fixture('client-web.json'))).error, /Web application/)
  assert.match(parseClientFile('').error, /empty/)
  assert.match(parseClientFile('{').error, /not JSON/)
  assert.match(parseClientFile(JSON.stringify({ type: 'service_account' })).error, /service account/)
  const doctored = fixture('client_secret.json')
  doctored.installed.token_uri = 'https://evil.example/token'
  assert.match(parseClientFile(JSON.stringify(doctored)).error, /token_uri/)
  const bad = fixture('client_secret.json')
  bad.installed.client_secret = 'has spaces in it'
  const r = parseClientFile(JSON.stringify(bad))
  assert.ok(!r.ok)
  assert.ok(!r.error.includes('has spaces'), 'the error never quotes the secret')
  assert.equal(checkClientId('x.apps.googleusercontent.com').ok, true)
  assert.equal(checkClientId('x.example.com').ok, false)
  const spec = oauthSpec({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  assert.equal(spec.authUrl, 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent')
  assert.equal(spec.tokenUrl, 'https://oauth2.googleapis.com/token')
  assert.deepEqual(spec.scopes, SCOPE_LIST)
  assert.equal(shortClientId(CLIENT_ID), '123456789012…')
})

test('settings: defaults, clamps, calendars checked, reminders deduped and ordered', () => {
  const { cfg, problems } = readSettings({})
  assert.deepEqual(problems, [])
  assert.deepEqual(cfg, { clientId: '', clientSecret: '', calendars: [], upcomingCount: 10, upcomingDays: 14, inviteDays: 30, pollMinutes: 3, reminders: [10, 2], reminderSound: true, reminderSoundChoice: '', joinEarlyMinutes: 10, showDeclined: false, showBirthdays: true, showWorkingLocation: true, timeZone: 'calendar' })
  const r = readSettings({ calendars: [TEAM, ' primary ', 'a/b', TEAM, ' ann@example.com '], reminders: [2, 10, 10, -1, 500, 0, 30, 60, 90], upcomingCount: 999, pollMinutes: 0, timeZone: 'mars', clientId: 'nope' })
  assert.deepEqual(r.cfg.calendars, [TEAM, 'ann@example.com'])
  assert.deepEqual(r.cfg.reminders, [90, 60, 30, 10, 2], 'latest first, each once, at most 5')
  assert.equal(r.cfg.upcomingCount, 50)
  assert.equal(r.cfg.pollMinutes, 1)
  assert.equal(r.cfg.timeZone, 'calendar')
  assert.equal(r.cfg.clientId, '')
  assert.ok(r.problems.some((p) => /clientId/.test(p)))
  assert.ok(r.problems.some((p) => /"a\/b" is not a calendar id/.test(p)))
  assert.deepEqual(readSettings({ reminders: [] }).cfg.reminders, [], 'an empty list: no reminders')
  assert.match(readSettings({ reminders: [-5] }).problems[0], /reminders are off/)
  assert.equal(readSettings({ timeZone: 'computer' }).cfg.timeZone, 'computer')
  assert.equal(readSettings({ showDeclined: true }).cfg.showDeclined, true)
  assert.equal(readSettings({ reminderSound: false }).cfg.reminderSound, false)
  // The picked sound id as it is (the app checks it in ctx.notify); a damaged value is App default.
  assert.equal(readSettings({ reminderSoundChoice: 'builtin:bell' }).cfg.reminderSoundChoice, 'builtin:bell')
  for (const bad of [5, null, true, 'x'.repeat(1025)]) assert.equal(readSettings({ reminderSoundChoice: bad }).cfg.reminderSoundChoice, '')
})

test('setup: every step link is a fixed https URL; an unknown id is no URL', () => {
  assert.equal(STEPS.length, 6)
  for (const s of STEPS) for (const l of s.links) assert.match(linkUrl(l.id), /^https:\/\/(console\.cloud\.google\.com|github\.com|myaccount\.google\.com)\//)
  assert.equal(LINKS.calendarApi, 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com')
  assert.match(STEPS[3].text, /calendar\.calendarlist\.readonly.*calendar\.events\.readonly.*calendar\.events\.owned/)
  for (const bad of ['https://evil.example', 'toString', '__proto__', null, 7]) assert.equal(linkUrl(bad), null, String(bad))
})

test('header: the meeting now or next with its countdown, Join only when there is one to join', () => {
  const row = (o) => ({ title: 'Standup', start: NOW + 30 * 60000, end: NOW + 45 * 60000, ...o })
  const base = { ready: true, polling: false, account: ME, lastPoll: NOW, tz: 'Europe/Berlin' }
  const notReady = headerSpec({ ...base, ready: false, view: null }, NOW)
  assert.deepEqual(notReady.actions.map((a) => a.id), ['refresh'])
  assert.equal(notReady.actions[0].disabled, true)
  const next = headerSpec({ ...base, view: { head: { now: null, next: row(), join: null } } }, NOW)
  assert.equal(next.meta, `next: Standup in 30 min · ${ME}`)
  assert.deepEqual(next.actions.map((a) => [a.id, a.disabled]), [['join', true], ['refresh', false]])
  const now = headerSpec({ ...base, view: { head: { now: row({ start: NOW - 60000, end: NOW + 14 * 60000 }), next: null, join: row() } } }, NOW)
  assert.equal(now.meta, `now: Standup · ends in 14 min · ${ME}`)
  assert.equal(now.actions[0].disabled, false)
  assert.equal(now.actions[0].icon, 'icons/join.svg')
  assert.equal(headerSpec({ ...base, view: { head: { now: null, next: null, join: null, tomorrowFirst: row() } } }, NOW).meta, `no more meetings today · ${ME}`)
  assert.equal(headerSpec({ ...base, stale: true, view: { head: { now: null, next: null, join: null } } }, NOW).meta, `no meetings · as of 09:00 · ${ME}`)
  const long = headerSpec({ ...base, view: { head: { now: null, next: row({ title: 'x'.repeat(300) }), join: null } } }, NOW)
  assert.ok(long.meta.length <= META_MAX)
  assert.ok(long.meta.endsWith(` · ${ME}`), 'the title is cut, never the address')
  assert.equal(headerSpec({ ...base, polling: true, view: null }, NOW).actions[0].busy, true)
})

test('http: only the allowed routes get the token; no redirect is followed; the path cannot be bent', async () => {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url, init })
    return json({ items: [] })
  }
  await googleRequest('/calendar/v3/users/me/calendarList', { token: 't', fetch, params: { maxResults: '250' } })
  assert.equal(seen[0].url, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer t')
  assert.equal(seen[0].init.redirect, 'manual')
  await googleRequest(`/calendar/v3/calendars/${encodeURIComponent(HOLIDAYS)}/events`, { token: 't', fetch })
  assert.match(seen[1].url, /calendars\/en\.example%23holiday%40group\.v\.calendar\.google\.com\/events$/)
  const refused = [
    ['/calendar/v3/calendars/me%40example.com/events/../../users/me/settings', {}],
    ['/calendar/v3/calendars/me%40example.com/acl', {}],
    ['/calendar/v3/users/me/settings', {}],
    ['/calendar/v3/calendars/me%40example.com/events/x?y', {}],
    ['/calendar/v3/calendars/me%2Fexample/events', {}],
    ['/calendar/v3/calendars/me%40example.com/events', { method: 'POST', json: {} }],
    ['/calendar/v3/calendars/me%40example.com/events/e1', { method: 'DELETE' }],
    ['/calendar/v3/calendars/me%40example.com/events/e1', { method: 'PUT', json: rsvpBody('accepted', ME) }],
    ['/calendar/v3/calendars/me%40example.com/events', { method: 'PATCH', json: rsvpBody('accepted', ME) }],
    ['/calendar/v3/calendars/me%40example.com/events/e1', { method: 'PATCH', json: { summary: 'renamed' } }],
    ['/calendar/v3/calendars/me%40example.com/events/e1', { method: 'PATCH', json: { ...rsvpBody('accepted', ME), summary: 'renamed' } }],
    ['/calendar/v3/calendars/me%40example.com/events/e1', { method: 'PATCH', json: { attendeesOmitted: true, attendees: [{ email: ME, responseStatus: 'accepted', comment: 'x' }] } }],
    ['/calendar/v3/calendars/me%40example.com/events/e1', { method: 'PATCH', json: { attendeesOmitted: false, attendees: [{ email: ME, responseStatus: 'accepted' }] } }],
    ['/calendar/v3/calendars/me%40example.com/events/e1', { method: 'PATCH', json: { attendeesOmitted: true, attendees: [{ email: ME, responseStatus: 'accepted' }, { email: 'ann@example.com', responseStatus: 'declined' }] } }],
    ['/calendar/v3/calendars/me%40example.com/events', { json: {} }],
  ]
  for (const [p, o] of refused) await assert.rejects(googleRequest(p, { token: 't', fetch, ...o }), (e) => e instanceof CalendarError && e.kind === 'unsafe', `${o.method || 'GET'} ${p}`)
  assert.equal(seen.length, 2, 'no refused request reached fetch')
  await googleRequest('/calendar/v3/calendars/me%40example.com/events/e1', { token: 't', fetch, method: 'PATCH', json: rsvpBody('declined', ME), params: { sendUpdates: 'all' } })
  assert.equal(seen[2].init.method, 'PATCH')
  assert.deepEqual(JSON.parse(seen[2].init.body), { attendeesOmitted: true, attendees: [{ email: ME, responseStatus: 'declined' }] })
  assert.equal(seen[2].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(ROUTES.map((r) => r.method), ['GET', 'GET', 'PATCH'])
})

test('rsvpBody: exactly the person\'s own answer, nothing a caller could add', () => {
  assert.deepEqual(rsvpBody('accepted', ' me@example.com '), { attendeesOmitted: true, attendees: [{ email: 'me@example.com', responseStatus: 'accepted' }] })
  assert.deepEqual(rsvpBody('tentative', ME).attendees[0].responseStatus, 'tentative')
  for (const [a, e] of [['needsAction', ME], ['yes', ME], ['accepted', ''], ['accepted', 'not an address'], ['accepted', 'a@b@c'], ['accepted', `${'a'.repeat(250)}@x.org`], ['accepted', null]]) assert.equal(rsvpBody(a, e), null, `${a} ${e}`)
})

test('http: Google errors become kinds the host acts on, as one readable line', async () => {
  const answer = (status, body, headers) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers || {}) } })
  const kind = async (status, body, o = {}) => {
    try {
      await googleRequest('/calendar/v3/users/me/calendarList', { token: 't', fetch: answer(status, body, o.headers) })
    } catch (e) {
      return e
    }
    return null
  }
  assert.equal((await kind(401, { error: { code: 401, message: 'Invalid Credentials' } })).kind, 'auth')
  const rate = await kind(429, { error: { code: 429, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, { headers: { 'retry-after': '30' } })
  assert.equal(rate.kind, 'rate')
  assert.equal(rate.retryAfter, 30)
  assert.ok(isBusy(rate))
  assert.equal((await kind(403, { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } })).kind, 'rate')
  const disabled = await kind(403, { error: { code: 403, message: 'Google Calendar API has not been used in project 1 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }] } })
  assert.equal(disabled.kind, 'disabled')
  assert.equal(disabled.message, DISABLED_TEXT)
  assert.equal((await kind(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } })).kind, 'scope')
  const admin = await kind(403, { error: { code: 403, message: 'Not authorized to access this resource/api', errors: [{ reason: 'forbidden' }] } })
  assert.equal(admin.kind, 'admin')
  assert.ok(admin.message.startsWith(ADMIN_TEXT))
  assert.equal((await kind(403, { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } })).kind, 'forbidden')
  assert.equal((await kind(404, { error: { code: 404, message: 'Not Found' } })).kind, 'notfound')
  assert.equal((await kind(410, { error: { code: 410, message: 'Gone' } })).kind, 'gone')
  const server = await kind(503, '<html><body>down</body></html>')
  assert.equal(server.kind, 'server')
  assert.ok(isBusy(server))
  assert.ok(!server.message.includes('<html>'), 'never the raw body')
  assert.equal((await kind(302, '')).kind, 'http')
  assert.equal((await kind(200, 'not json')).kind, 'json')
  const big = await googleRequest('/calendar/v3/users/me/calendarList', { token: 't', fetch: async () => new Response('x'.repeat(100), { status: 200 }), maxBytes: 10 }).catch((e) => e)
  assert.equal(big.kind, 'toolarge')
  const down = await googleRequest('/calendar/v3/users/me/calendarList', { token: 't', fetch: async () => { throw new Error('ECONNREFUSED') } }).catch((e) => e)
  assert.equal(down.kind, 'network')
  assert.ok(!down.message.includes('Bearer'))
})
