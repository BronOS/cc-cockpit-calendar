'use strict'
// Meeting reminders (lib/reminders.js and the host's tick): which offsets are due, one notification
// per meeting and offset however many windows are open (ctx.appStorage.increment), declined and
// non-meetings skipped, the text, the old keys cleaned, and ctx.notify's feature detection: the 0.9.5
// options and click, the 0.9.4 text-only call, an app that refuses the options.
const test = require('node:test')
const assert = require('node:assert/strict')
const R = require('../dist/lib/reminders')
const { compactEvent } = require('../dist/lib/model')
const { ev, self, guest, fakeAppStorage, tokens, fakeGoogle, NOW, ME, ANN, TZ } = require('./fakes')
const { signedIn, settle } = require('./helpers')

const PRIMARY = { id: ME, name: ME, color: '#4285f4', primary: true }
const mk = (raw) => compactEvent(raw, { cal: PRIMARY, me: ME, tz: TZ })
const START = Date.parse('2026-11-03T08:30:00Z') // the standup, 09:30 Berlin
const MIN = 60000
const standup = () => mk(ev('standup_20261103T083000Z', '2026-11-03', '09:30', '09:45', { title: 'Standup', recurring: 'standup', iCalUID: 'standup@google.com', meet: 'https://meet.google.com/abc-defg-hij', organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('accepted')] }))
const due = (events, now, fired = new Set(), offsets = [10, 2]) => R.dueReminders({ events, offsets, now, account: ME, fired })

test('due: each offset from its minute on, the smallest due one when several are, never past 5 min into the meeting', () => {
  const e = standup()
  assert.deepEqual(due([e], START - 11 * MIN), [])
  const fired = new Set()
  const ten = due([e], START - 10 * MIN, fired)
  assert.deepEqual(ten.map((d) => d.minutes), [10])
  for (const d of ten) fired.add(d.key)
  assert.deepEqual(due([e], START - 5 * MIN, fired), [], 'shown: not again')
  const two = due([e], START - 2 * MIN, fired)
  assert.deepEqual(two.map((d) => d.minutes), [2])
  assert.deepEqual(two[0].also, [])
  // The window opened late (or the computer slept): only the latest offset shows, the 10 counts as done.
  const late = due([e], START - 1 * MIN)
  assert.deepEqual(late.map((d) => [d.minutes, d.also.length]), [[2, 1]])
  assert.equal(late[0].also[0], R.reminderKey(ME, e, 10))
  assert.deepEqual(due([e], START + 4 * MIN).map((d) => d.minutes), [2], 'up to 5 min into it')
  assert.deepEqual(due([e], START + 5 * MIN), [])
  assert.deepEqual(due([e], START - 10 * MIN, new Set(), []), [], 'no offsets: no reminders')
  assert.deepEqual(due([e], START, new Set(), [0]).map((d) => d.minutes), [0], '0: at the start')
})

test('due: declined, focus time, out of office, all-day, other people\'s events never remind', () => {
  const declined = mk(ev('l', '2026-11-03', '09:30', '10:00', { title: 'Lunch', organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('declined')] }))
  const focus = mk(ev('f', '2026-11-03', '09:30', '10:00', { title: 'Focus', type: 'focusTime' }))
  const ooo = mk(ev('o', '2026-11-03', '09:30', '18:00', { title: 'OOO', type: 'outOfOffice' }))
  const allDay = mk({ id: 'a', summary: 'Holiday', start: { date: '2026-11-03' }, end: { date: '2026-11-04' }, organizer: { email: ME, self: true } })
  const theirs = compactEvent(ev('t', '2026-11-03', '09:30', '10:00', { title: 'Theirs', organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true })] }), { cal: { id: ANN, name: 'Ann', color: '#f4511e', primary: false }, me: ME, tz: TZ })
  const tentative = mk(ev('m', '2026-11-03', '09:30', '10:00', { title: 'Maybe', organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('tentative')] }))
  const unanswered = mk(ev('u', '2026-11-03', '09:30', '10:00', { title: 'Open', organizer: { email: ANN }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('needsAction')] }))
  assert.deepEqual(due([declined, focus, ooo, allDay, theirs, tentative, unanswered], START - 2 * MIN).map((d) => d.ev.title), ['Maybe', 'Open'], 'not declined is enough')
})

test('the key: per account, event, start and offset; a moved meeting gets a new one; old days are cleaned', () => {
  const e = standup()
  const k = R.reminderKey(ME, e, 10)
  assert.match(k, /^remind:2026-11-03:[a-f0-9]{16}$/)
  assert.ok(R.KEY_RE.test(k))
  assert.notEqual(k, R.reminderKey(ME, e, 2))
  assert.notEqual(k, R.reminderKey('other@example.com', e, 10))
  assert.notEqual(k, R.reminderKey(ME, { ...e, start: e.start + 30 * MIN }, 10))
  assert.equal(k, R.reminderKey(ME, { ...e, id: 'another-copy', key: 'x' }, 10), 'two copies of one meeting share it (the iCalUID)')
  assert.deepEqual(R.staleKeys(['remind:2026-11-01:0123456789abcdef', 'remind:2026-11-02:0123456789abcdef', 'remind:2026-11-03:0123456789abcdef', 'other', 'remind:junk'], '2026-11-03'), ['remind:2026-11-01:0123456789abcdef'])
})

test('the text: the real time left, Meet named, the times in the display zone', () => {
  const e = standup()
  assert.equal(R.reminderText(e, START - 10 * MIN, TZ), 'In 10 min: Standup (Google Meet), 09:30–09:45')
  assert.equal(R.reminderText(e, START - 7 * MIN - 20000, TZ), 'In 8 min: Standup (Google Meet), 09:30–09:45')
  assert.equal(R.reminderText(e, START - 10000, TZ), 'Now: Standup (Google Meet), 09:30–09:45')
  assert.equal(R.reminderText(e, START + 3 * MIN, 'America/New_York'), 'Started 3 min ago: Standup (Google Meet), 03:30–03:45')
  assert.ok(R.reminderText({ ...e, title: 'x'.repeat(900) }, START, TZ).length <= 480)
})

test('notify: the 0.9.5 app takes the options and says whether it was clicked', async () => {
  const notes = []
  const ctx = { notify: async (text, o) => (notes.push([text, o]), { clicked: true }) }
  assert.deepEqual(await R.notify(ctx, 'In 10 min: Standup', { join: true, sound: true }), { clicked: true, clickable: true })
  assert.deepEqual(notes[0], ['In 10 min: Standup', { title: 'Google Calendar', sound: true, action: { label: 'Join' } }])
  await R.notify(ctx, 'x', { join: false, sound: false })
  assert.deepEqual(notes[1][1], { title: 'Google Calendar', sound: false }, 'no Join action without a Meet link')
  // A sound id (reminderSoundChoice) goes to the app as it is.
  await R.notify(ctx, 'x', { join: false, sound: 'builtin:bell' })
  assert.deepEqual(notes[2][1], { title: 'Google Calendar', sound: 'builtin:bell' })
  const dismissed = { notify: async () => ({ clicked: false }) }
  assert.deepEqual(await R.notify(dismissed, 'x', { join: true }), { clicked: false, clickable: true })
})

test('notify: the 0.9.4 app ignores the options and resolves nothing: text only, not clickable', async () => {
  const notes = []
  const old = { notify: (text) => (notes.push(text), Promise.resolve(undefined)) }
  assert.deepEqual(await R.notify(old, 'In 10 min: Standup', { join: true }), { clicked: null, clickable: false })
  assert.deepEqual(notes, ['In 10 min: Standup'])
})

test('notify: an app that refuses the options gets the text alone; a refusal for the rate is not retried', async () => {
  const calls = []
  const strict = { notify: (text, o) => (calls.push(o), o ? Promise.reject(new TypeError('notify: unknown option "title"')) : Promise.resolve(undefined)) }
  assert.deepEqual(await R.notify(strict, 'x', { join: true }), { clicked: null, clickable: null })
  assert.equal(calls.length, 2)
  assert.equal(calls[1], undefined)
  const capped = { notify: () => Promise.reject(new Error('at most 10 notifications a minute')) }
  await assert.rejects(R.notify(capped, 'x', {}), /at most 10/)
  assert.equal(R.optionsRefused(new Error('notify needs some text')), false)
  assert.equal(R.optionsRefused(new Error('too many notifications')), false)
  assert.equal(R.optionsRefused(new TypeError('unexpected argument')), true)
})

// ---- the host ----

/** Two signed-in windows on one account sharing the app-wide store (and nothing else). */
async function twoWindows(opts = {}) {
  const appStorage = fakeAppStorage()
  const a = await signedIn({ appStorage, ...opts })
  const b = await signedIn({ appStorage, ...opts })
  return { a, b, appStorage }
}

async function tickAt(w, t) {
  w.clock.t = t
  await w.h.tick()
  await settle(w)
}

test('the host: two windows, one reminder each time: 10 min, then 2 min before the standup', async () => {
  const { a, b, appStorage } = await twoWindows()
  const all = () => [...a.ctx.notes, ...b.ctx.notes]
  // Both windows tick at the same moment: one notification.
  await Promise.all([tickAt(a, START - 10 * MIN), tickAt(b, START - 10 * MIN)])
  assert.equal(all().length, 1)
  assert.equal(all()[0].text, 'In 10 min: Standup (Google Meet), 09:30–09:45 · Join from the Calendar panel', 'not known to be clickable yet: the panel is named')
  assert.deepEqual(all()[0].opts, { title: 'Google Calendar', sound: true, action: { label: 'Join' } })
  const winner = a.ctx.notes.length ? a : b
  const other = winner === a ? b : a
  // The next tick in either window: nothing new.
  await Promise.all([tickAt(a, START - 9 * MIN), tickAt(b, START - 9 * MIN)])
  assert.equal(all().length, 1)
  // 2 min before: the window that ticks first shows it, the other stays quiet.
  await tickAt(winner, START - 2 * MIN)
  await tickAt(other, START - 2 * MIN)
  assert.equal(all().length, 2)
  assert.equal(other.ctx.notes.length, 0)
  assert.equal(winner.ctx.notes[1].text, 'In 2 min: Standup (Google Meet), 09:30–09:45', 'its notifications answered the 0.9.5 way: no panel hint now')
  assert.ok(other.ctx.logs.some(([, m]) => /shown by another window/.test(m)))
  assert.equal([...appStorage.map.keys()].filter((k) => k.startsWith('remind:')).length, 2)
  assert.ok([...appStorage.map.values()].every((v) => v === 2), 'both windows asked; one won each time')
})

test('the host: a click on the notification (or its Join) opens the meeting', async () => {
  const w = await signedIn()
  w.ctx.notifyClick = true
  await tickAt(w, START - 10 * MIN)
  assert.deepEqual(w.ctx.external, ['https://meet.google.com/abc-defg-hij'])
  assert.equal(w.h.S.clickable, true)
  assert.equal(await w.ctx.storage.get('notifyClicks'), true)
  assert.match((await w.ctx.runCli(['status'])).stdout, /notifications clickable \(Join opens the meeting\)/)
})

test('the host on a 0.9.4 app: the reminder is text only, naming the panel; nothing opens', async () => {
  const w = await signedIn({ notify: 'old' })
  await tickAt(w, START - 10 * MIN)
  assert.equal(w.ctx.notes.length, 1)
  assert.match(w.ctx.notes[0].text, / · Join from the Calendar panel$/)
  assert.deepEqual(w.ctx.external, [])
  assert.equal(w.h.S.clickable, false)
  assert.equal(await w.ctx.storage.get('notifyClicks'), false)
  assert.match((await w.ctx.runCli(['status'])).stdout, /notifications text only \(cc-cockpit before 0\.9\.5\)/)
})

test('the host on an app that refuses the options: shown with the text alone', async () => {
  const w = await signedIn({ notify: 'strict' })
  await tickAt(w, START - 10 * MIN)
  assert.equal(w.ctx.notes.length, 1)
  assert.equal(w.ctx.notes[0].opts, undefined)
})

test('the host: no reminder for a meeting just declined (an answer on its way), none with reminders off', async () => {
  const w = await signedIn()
  // The standup is Bob's, I am a guest: decline today's occurrence.
  const r = await w.h.answerEvent(w.h.eventOfId('standup_20261103T083000Z'), 'declined', { one: true })
  assert.ok(r.message, r.error)
  await tickAt(w, START - 10 * MIN)
  assert.equal(w.ctx.notes.length, 0)
  const off = await signedIn({ project: { reminders: [] } })
  await tickAt(off, START - 2 * MIN)
  assert.equal(off.ctx.notes.length, 0)
  assert.match((await off.ctx.runCli(['status'])).stdout, /reminders off/)
})

test('the host: sound off is passed on; several offsets each once', async () => {
  const w = await signedIn({ project: { reminders: [15, 5, 1], reminderSound: false } })
  for (const m of [15, 14, 5, 4, 1, 0]) await tickAt(w, START - m * MIN)
  assert.deepEqual(w.ctx.notes.map((n) => n.text.split(':')[0]), ['In 15 min', 'In 5 min', 'In 1 min'])
  assert.ok(w.ctx.notes.every((n) => n.opts.sound === false))
})

test('reminderSoundOf: off, the picked sound id, or the app\'s sound for App default', () => {
  assert.equal(R.reminderSoundOf({ reminderSound: false, reminderSoundChoice: 'builtin:bell' }), false)
  assert.equal(R.reminderSoundOf({ reminderSound: true, reminderSoundChoice: 'builtin:bell' }), 'builtin:bell')
  assert.equal(R.reminderSoundOf({ reminderSound: true, reminderSoundChoice: '' }), true)
})

test('the host: the picked reminder sound is passed to ctx.notify', async () => {
  const w = await signedIn({ project: { reminders: [10], reminderSoundChoice: 'system:0:freedesktop/stereo/bell.oga' } })
  await tickAt(w, START - 10 * MIN)
  assert.equal(w.ctx.notes.length, 1)
  assert.equal(w.ctx.notes[0].opts.sound, 'system:0:freedesktop/stereo/bell.oga')
  assert.match((await w.ctx.runCli(['status'])).stdout, /before, with sound system:0:freedesktop\/stereo\/bell\.oga;/)
})

test('the host: an app-wide store that refuses: this window reminds on its own, and says so once', async () => {
  const appStorage = fakeAppStorage()
  appStorage.failIncrement = 'store unavailable'
  const w = await signedIn({ appStorage })
  await tickAt(w, START - 10 * MIN)
  await tickAt(w, START - 2 * MIN)
  assert.equal(w.ctx.notes.length, 2)
  assert.equal(w.ctx.logs.filter(([, m]) => /app-wide store refused/.test(m)).length, 1)
})

test('the host: reminder keys of days before yesterday leave the app-wide store, once a day', async () => {
  const appStorage = fakeAppStorage()
  await appStorage.set('remind:2026-10-30:0123456789abcdef', 1)
  await appStorage.set('remind:2026-11-02:0123456789abcdef', 1)
  await appStorage.set('someOtherKey', 5)
  const w = await signedIn({ appStorage })
  await tickAt(w, NOW + MIN)
  assert.deepEqual([...appStorage.map.keys()].sort(), ['remind:2026-11-02:0123456789abcdef', 'someOtherKey'])
})

test('the host: two accounts in two projects never share a reminder', async () => {
  const appStorage = fakeAppStorage()
  const a = await signedIn({ appStorage })
  const reg = tokens()
  const g = fakeGoogle({ tokens: reg })
  g.world.calendars[0] = { ...g.world.calendars[0], id: 'me2@example.com', summary: 'me2@example.com' }
  g.world.events['me2@example.com'] = g.world.events[ME]
  const b = await signedIn({ appStorage, tokens: reg, googleFake: g })
  assert.equal(b.h.S.state.account, 'me2@example.com')
  await tickAt(a, START - 10 * MIN)
  await tickAt(b, START - 10 * MIN)
  assert.equal(a.ctx.notes.length, 1)
  assert.equal(b.ctx.notes.length, 1)
})
