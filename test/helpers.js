'use strict'
// The host booted with the fakes (dist/host.js's `_start`): a fake ctx, a fake Google sign-in and a
// fake Google Calendar, a clock the test moves, no real timers. Shared by host, rsvp and reminders.
const host = require('../dist/host')
const { fakeGoogle, fakeOAuth, fakeCtx, fakeAppStorage, tokens, fixture, NOW } = require('./fakes')

const CLIENT_FILE = JSON.stringify(fixture('client_secret.json'))

function boot(opts = {}) {
  const reg = opts.tokens || tokens()
  const google = opts.googleFake || fakeGoogle({ tokens: reg, ...(opts.google || {}) })
  const oauth = fakeOAuth(reg, opts.oauthOpts)
  const ctx = fakeCtx({
    project: opts.project || {},
    oauth,
    reviewer: opts.reviewer,
    jira: opts.jira,
    sessions: opts.sessions,
    overlayAnswer: opts.overlayAnswer,
    storage: opts.storage,
    secrets: opts.secrets,
    appStorage: opts.appStorage,
    dataDir: opts.dataDir,
    notify: opts.notify,
    old: opts.old,
    noSlots: opts.noSlots,
  })
  const clock = { t: opts.now || NOW }
  const h = host._start(ctx, { fetch: google.fetch, now: () => clock.t, random: () => 0.5, setTimeout: () => 0, clearTimeout: () => {}, cliWaitMs: 3000, jiraLookupWaitMs: 200, jiraViewWaitMs: 500 })
  return { google, oauth, ctx, h, reg, clock, tick: (ms) => (clock.t += ms) }
}

async function until(fn, ms = 2000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** Let running polls and the promises they start finish. */
async function settle(b) {
  for (let i = 0; i < 6; i++) {
    await b.h.S.polling
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** Boot, paste the client, sign in, wait for the first poll. */
async function signedIn(opts = {}) {
  const b = boot(opts)
  await b.h.ready
  await b.ctx.sendPanel({ type: 'client', text: CLIENT_FILE })
  await b.ctx.sendPanel({ type: 'signIn' })
  await until(() => (b.h.S.state && b.h.S.state.lastPoll) || b.h.S.blocked || b.h.S.error || (b.ctx.lastState() && b.ctx.lastState().notice && b.ctx.lastState().notice.kind === 'error'))
  await settle(b)
  return b
}

/** A row of the last state message by title, in a section: 'today', 'tomorrow', 'upcoming', 'invitations'. */
function rowOf(st, title, where) {
  const v = st.view
  const lists = { today: v.today.rows, tomorrow: v.tomorrow.rows, upcoming: v.upcoming.rows, invitations: v.invitations, chips: [...v.today.chips, ...v.tomorrow.chips] }
  const all = where ? lists[where] : Object.values(lists).flat()
  return all.find((r) => r.title === title)
}

/** Every string the plugin let out: panel posts, headers, logs, overlays, notifications. */
function everythingSaid(ctx) {
  return JSON.stringify([ctx.posts, ctx.headers, ctx.logs, ctx.overlays.map((o) => o.posts), ctx.notes])
}

module.exports = { boot, signedIn, settle, until, rowOf, everythingSaid, fakeAppStorage, CLIENT_FILE }
