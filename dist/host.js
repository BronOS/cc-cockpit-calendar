'use strict'
// bronos.calendar: your Google Calendar in a cc-cockpit panel (Now / Next, Invitations, Today,
// Tomorrow, Upcoming), meeting reminders, Join, the event as a clean page to discuss with Claude, and
// Accept / Maybe / Decline. Plain JavaScript with no build step; the pure logic is in ./lib
// (node:test suites in test/). Design: docs/design.md. The app API: `ccc guide api` (this file uses
// only what it documents, plus the notify options of cc-cockpit 0.9.5, feature-detected). Built the
// way bronos.chat and bronos.gmail are built (their hosts are the model).
//
// Life of a project window: activate reads the settings, the sign-in state and the last agenda, then
// polls every `pollMinutes` (±25%) while the window is open (a closed project has no host, so it
// does nothing). A poll reads the calendar list when it is an hour old, then each selected calendar's
// window (lib/poll.js). Between polls a 15 s tick moves the clock: Now / Next, the countdown in the
// title bar, due reminders (lib/reminders.js), a new day. Nothing is polled until an OAuth client is
// set and the person signed in with Google.
//
// Writes: only the person's own answer to an invitation (lib/rsvp.js through lib/client.js's one
// write method, events.patch with attendeesOmitted and sendUpdates=all). No event is ever created,
// moved, edited or deleted.

const { readSettings } = require('./lib/settings')
const { createAuth, AuthError } = require('./lib/auth')
const { shortClientId, SCOPE_TEXT, RSVP_SCOPE_REFUSED_TEXT } = require('./lib/oauth-client')
const { createClient } = require('./lib/client')
const { isBusy } = require('./lib/http')
const { poll, loadState, emptyState, displayZone, selection, agendaOf } = require('./lib/poll')
const { compactEvent, phoneOf, safeUrl, CALENDAR_HOSTS } = require('./lib/model')
const { buildView, withPending } = require('./lib/layout')
const { planRsvp, createGate, answerOf, SAID } = require('./lib/rsvp')
const { dueReminders, reminderText, staleKeys, notify, reminderSoundOf, OLD_APP_SUFFIX } = require('./lib/reminders')
const { eventDocument, discussPrompt } = require('./lib/document')
const J = require('./lib/jira')
const svc = require('./lib/service')
const { esc } = require('./lib/entities')
const { pickTab, isMissingAnnotate } = require('./lib/actions')
const { headerSpec } = require('./lib/header')
const { STEPS, linkUrl } = require('./lib/setup')
const { runCli } = require('./lib/cli')
const { jsonFile } = require('./lib/store')
const { sha, oneLine, cut, isKey, emailAddress, unique } = require('./lib/util')
const { htmlToText } = require('./lib/sanitize')
const { decode } = require('./lib/entities')
const T = require('./lib/time')

const PANEL = 'main'
const CLI_WAIT_MS = 25000 // `ccc` gives a handler 30 s
const BACKOFF_MAX_MINUTES = 30
const TICK_SECONDS = 15
const JITTER = 0.25 // Google asks to vary recurring intervals by ±25% (design "Fetching")
// The reader page gets the html in parts: a page message is at most 1,040,384 chars of JSON.
const PAGE_HTML_PART = 400000
// How long an open waits for the reviewer's features() and the Jira plugin (host-local calls; a
// provider still activating makes them wait).
const FEATURES_WAIT_MS = 2000
const JIRA_SITE_WAIT_MS = 2000
const JIRA_LOOKUP_WAIT_MS = 3000
const JIRA_VIEW_WAIT_MS = 15000
const JIRA_COMPANION_DOC = { maxHtmlBytes: 2000000, maxImages: 7, maxImageChars: 3.5 * 1024 * 1024, waitMs: 8000 }
const ROWS_MAX = 200 // a day's rows sent to the panel: the message stays far below the 1 MiB post limit

let instance = null

/** What this app lacks of what the plugin needs (cc-cockpit 0.9.4); empty on a new enough app. */
function apiGaps(ctx) {
  const gaps = []
  if (!ctx.oauth || typeof ctx.oauth.authorize !== 'function' || typeof ctx.oauth.refresh !== 'function') gaps.push('ctx.oauth')
  if (!ctx.secrets || typeof ctx.secrets.get !== 'function') gaps.push('ctx.secrets')
  if (!ctx.panels || typeof ctx.panels.header !== 'function') gaps.push('ctx.panels.header')
  if (typeof ctx.openExternal !== 'function') gaps.push('ctx.openExternal')
  if (!ctx.appStorage || typeof ctx.appStorage.increment !== 'function') gaps.push('ctx.appStorage')
  return gaps
}

/**
 * The host, with its I/O injectable for the suites (`fetch`, timers, the clock, the jitter). The app
 * calls `activate(ctx)`, which uses the real ones.
 */
function start(ctx, io = {}) {
  const fetchFn = io.fetch || globalThis.fetch
  const now = io.now || Date.now
  const random = io.random || Math.random
  const reviewer = ctx.services.use('reviewer')
  const jira = ctx.services.use('jira')
  const agendaFile = jsonFile(ctx.dataDir, 'agenda.json')
  const abort = new AbortController()
  const gaps = apiGaps(ctx)
  const tooOld = gaps.length ? `The Google Calendar plugin needs cc-cockpit 0.9.4 or later (this app has no ${gaps.join(', ')}). Update cc-cockpit, then reopen this project.` : null

  const S = {
    settings: readSettings(ctx.settings.project),
    state: null, // poll.loadState: the account, the calendars, each calendar's events
    agenda: { events: [], conflicts: new Map() }, // poll.agendaOf of the state
    view: null, // layout.buildView of the agenda (null before a poll)
    gen: 0, // bumped when the client or account changes: a poll of the old one is thrown away
    polling: null, // the running poll's promise: one at a time
    pollAgain: false, // an answer finished during a poll: poll once more when it ends
    listAgain: false, // read the calendar list on the next poll (a settings or picker change)
    nextPollAt: 0,
    error: null, // the last poll's failure, shown as a notice
    notes: [], // the last poll's minor troubles
    calendarErrors: [],
    missingCalendars: [],
    backoffMinutes: 0, // set while Google is busy (429 / 5xx): the poll interval, doubled each time
    blocked: null, // why nothing is polled although signed in (a scope not granted)
    pending: {}, // RSVP target -> { answer, cal, id, series, state, doneAt }: the optimistic view
    picked: [], // calendar ids switched on in the panel's picker (ctx.storage `picked`)
    ui: { calendarsOpen: false },
    notice: null, // { text, kind: 'info'|'error' } after an action, until dismissed or replaced
    clientError: null,
    choose: null, // { key, label, tabs } when Discuss needs the person to pick a tab
    annotateMissing: false,
    htmlRejected: null,
    fired: new Set(), // reminder keys this window handled
    clickable: null, // whether the app's notifications can be clicked (0.9.5): null until one was shown
    cleanedDay: null, // the UTC day old reminder keys were last cleaned
    appStorageWarned: false,
    stopped: false,
  }
  const cfg = () => S.settings.cfg

  /**
   * Tell the services' listeners (Inbox) that the agenda or an answer changed: after each poll and
   * each RSVP. Not every app has emit (the plugin runs on 0.9.4), and a listener's trouble is not ours.
   */
  function changed() {
    try {
      if (typeof ctx.services.emit === 'function') ctx.services.emit('calendar', 'changed', {})
    } catch (e) {
      ctx.log.warn(`calendar changed event: ${e && e.message ? e.message : e}`)
    }
  }

  const auth = tooOld ? null : createAuth({ oauth: ctx.oauth, secrets: ctx.secrets, storage: ctx.storage, log: ctx.log, now })
  const cal = createClient({ getToken: () => auth.token(), invalidate: () => auth.invalidate(), fetch: fetchFn })
  const gate = createGate({ now })
  const signedIn = () => Boolean(auth) && auth.status().signedIn
  const ready_ = () => signedIn() && !S.blocked
  const clientHash = () => {
    const c = auth && auth.client()
    return c ? sha(c.clientId, 12) : ''
  }
  const account = () => (S.state && S.state.account) || ''
  const zone = () => displayZone(cfg(), S.state)

  // ---- Jira (lib/jira.js; optional: without the jira service nothing here runs) ----

  const jiraSite = J.createSiteCache({ site: () => jira.site(), now })
  const lookups = J.createLookups({
    issue: (key, o) => jira.issue(key, o),
    now,
    onLate: () => {
      if (S.stopped) return
      rebuild()
      postState()
    },
  })

  let lastPosted = '' // the last state message posted (the tick posts only a changed one)

  // ---- stored state ----

  const ready = (async () => {
    const ui = await ctx.storage.get('ui').catch(() => undefined)
    if (ui && typeof ui === 'object') S.ui = { calendarsOpen: ui.calendarsOpen === true }
    const picked = await ctx.storage.get('picked').catch(() => undefined)
    if (Array.isArray(picked)) S.picked = picked.filter((x) => typeof x === 'string').slice(0, 20)
    const c = await ctx.storage.get('notifyClicks').catch(() => undefined)
    if (typeof c === 'boolean') S.clickable = c
    if (!auth) return
    await auth.load(cfg())
    S.state = loadState(await agendaFile.read(null), clientHash())
    const g = auth.status().grant
    if (g) S.blocked = blockedBy(g.missing)
    rebuild()
  })().catch((e) => ctx.log.error('loading the stored state failed:', e && e.stack ? e.stack : e))

  function saveState() {
    if (!S.state) return Promise.resolve()
    return agendaFile.write(S.state).catch((e) => ctx.log.warn('writing the agenda failed:', e.message))
  }

  /** Forget everything of the previous client or account: the agenda, answers on their way, a running poll's result. */
  function resetAccount() {
    S.gen++
    S.state = emptyState(clientHash())
    S.pending = {}
    S.error = null
    S.notes = []
    S.calendarErrors = []
    S.missingCalendars = []
    S.backoffMinutes = 0
    S.blocked = null
    S.fired = new Set()
    lookups.clear()
    rebuild()
    void agendaFile.write(S.state).catch(() => {})
  }

  /**
   * Why a signed-in account cannot be polled (design "Auth"): a sign-in without the calendar list or
   * the events scope. Null when it can. Without the RSVP scope the agenda works.
   */
  function blockedBy(missing) {
    const need = (missing || []).filter((k) => k !== 'rsvp')
    if (need.length) return `The Google sign-in lacks ${need.map((k) => SCOPE_TEXT[k].label).join(' and ')}: ${need.map((k) => SCOPE_TEXT[k].loses).join('; ')}. Sign in again and leave every box ticked on Google's consent page.`
    return null
  }

  // ---- the view ----

  function rebuild() {
    if (S.state && ready_() && S.state.lastPoll) {
      S.agenda = agendaOf(S.state)
      S.view = buildView({ events: S.agenda.events, conflicts: S.agenda.conflicts, now: now(), tz: zone(), cfg: cfg(), pending: S.pending, chip: (k) => J.chip(k, lookups.peek(k, 0)) })
    } else {
      S.agenda = { events: [], conflicts: new Map() }
      S.view = null
    }
    try {
      ctx.badge(PANEL, S.view && S.view.badge ? S.view.badge : null)
    } catch (e) {
      ctx.log.warn('badge:', e.message)
    }
  }

  function annotateOn() {
    return !S.annotateMissing && ctx.services.available('reviewer')
  }
  function jiraOn() {
    return ctx.services.available('jira')
  }

  /** The status lookups of the keys the agenda names (chips), waited for briefly. */
  async function lookUpChips() {
    if (!jiraOn() || !S.view) return
    const keys = unique(S.agenda.events.filter((e) => e.end > now()).flatMap((e) => e.jira || []))
    if (!keys.length) return
    const r = await lookups.ensure(keys.map((key) => ({ key, newestAt: 0 })), io.jiraLookupWaitMs === undefined ? JIRA_LOOKUP_WAIT_MS : io.jiraLookupWaitMs)
    if (r.started) {
      rebuild()
      postState()
    }
  }

  // ---- polling ----

  /** Poll now unless a poll is running (then that one's promise). Never rejects. */
  function pollNow(reason, force = false) {
    if (S.polling) return S.polling
    if (!auth || S.stopped) return Promise.resolve()
    S.polling = (async () => {
      try {
        await ready
        if (!signedIn()) return
        const gen = S.gen
        if (S.blocked) {
          rebuild()
          return
        }
        const startedAt = now()
        const j = jiraOn() ? await jiraSite.get(JIRA_SITE_WAIT_MS) : null
        const listAgain = S.listAgain
        S.listAgain = false
        const r = await poll({ client: cal, cfg: cfg(), state: S.state, picked: S.picked, now: startedAt, listAgain, jira: j, signal: abort.signal })
        if (gen !== S.gen) return // signed out or another client meanwhile: not this account's agenda
        // Answers done before this poll began are now Google's own state: the guesses go.
        for (const [k, p] of Object.entries(S.pending)) if (p.state === 'done' && p.doneAt <= startedAt) delete S.pending[k]
        S.calendarErrors = r.stats.errors
        S.missingCalendars = r.stats.missing
        S.notes = []
        if (r.stats.skipped) S.notes.push(`${r.stats.skipped} event${r.stats.skipped === 1 ? '' : 's'} Google sent could not be read and are not shown.`)
        for (const name of r.stats.more) S.notes.push(`${name} has more than 1000 events in the window: the latest are not shown.`)
        S.error = null
        rebuild()
        for (const e of r.stats.errors) ctx.log.warn(`reading ${e.id} failed: ${e.message}`)
        await saveState()
        ctx.log.info(`poll (${reason}${force ? ', forced' : ''}): ${r.stats.calendars} calendar(s), ${r.stats.events} events`)
        if (S.backoffMinutes) S.backoffMinutes = 0
        postState()
        changed()
        void lookUpChips().catch((e) => ctx.log.warn(`jira lookups: ${e && e.message ? e.message : e}`))
      } catch (e) {
        await failed(reason, e)
        changed()
      } finally {
        S.polling = null
        planNextPoll()
        postState()
        if (S.pollAgain && !S.stopped) {
          S.pollAgain = false
          void pollNow('after an answer', true)
        }
      }
    })()
    postState()
    return S.polling
  }

  async function failed(reason, e) {
    if (e instanceof AuthError && (e.kind === 'invalidGrant' || e.kind === 'signedOut')) {
      // The panel shows the sign-in again, with the reason; not an error notice on top of it.
      S.error = null
      rebuild()
      ctx.log.warn(`poll (${reason}): signed out (${e.kind})`)
      return
    }
    if (e && e.kind === 'scope') {
      // A grant without a scope the agenda needs, seen only by a call (Google sent no scope list).
      await auth.scopeMissing(S.state && S.state.calendars.length ? 'events' : 'calendars')
      S.blocked = blockedBy(auth.status().grant && auth.status().grant.missing)
      S.error = null
      rebuild()
      ctx.log.warn(`poll (${reason}): ${S.blocked}`)
      return
    }
    if (isBusy(e)) {
      S.backoffMinutes = Math.min(BACKOFF_MAX_MINUTES, (S.backoffMinutes || cfg().pollMinutes) * 2)
      S.error = `${e.message} (every ${S.backoffMinutes} min for now).`
    } else {
      S.error = e && e.message ? e.message : String(e)
    }
    rebuild()
    ctx.log.error(`poll (${reason}) failed: ${S.error}`)
  }

  /** When the next scheduled poll runs: the interval (or the backoff) ±25%. */
  function planNextPoll() {
    const minutes = S.backoffMinutes || cfg().pollMinutes
    S.nextPollAt = now() + Math.round(minutes * 60000 * (1 - JITTER + 2 * JITTER * random()))
  }

  // ---- the tick (every 15 s): the clock moves, reminders, the day rolls, the next poll ----

  async function tick() {
    if (S.stopped || !auth) return
    await ready
    if (ready_() && S.state && S.state.lastPoll) {
      const t = now()
      if (S.state.day && T.dayKey(t, zone()) !== S.state.day && !S.polling) void pollNow('new day', true)
      else if (t >= S.nextPollAt && !S.polling) void pollNow('schedule')
      rebuild()
      await runReminders()
      await cleanReminderKeys()
      postState(true)
    } else if (ready_() && !S.polling && now() >= S.nextPollAt) {
      void pollNow('schedule')
    }
    setHeader()
  }
  const stopTick = tooOld ? null : ctx.schedule(TICK_SECONDS, () => tick().catch((e) => ctx.log.warn(`tick: ${e && e.message ? e.message : e}`)))
  // Not inside activate: a poll may end in a Jira call, and a service call during activate can close
  // a cycle (`ccc guide api`, Cycles).
  const firstPoll = tooOld ? null : (io.setTimeout || setTimeout)(() => void pollNow('start'), io.firstPollMs === undefined ? 1500 : io.firstPollMs)

  // ---- reminders (lib/reminders.js) ----

  async function runReminders() {
    const offsets = cfg().reminders
    if (!offsets.length || !account()) return
    // With answers on their way: a meeting just declined gets no reminder.
    const events = withPending(S.agenda.events, S.pending)
    const due = dueReminders({ events, offsets, now: now(), account: account(), fired: S.fired })
    for (const d of due) {
      S.fired.add(d.key)
      for (const k of d.also) S.fired.add(k)
      let first = true
      try {
        // One window wins (main applies increments one at a time): the others stay quiet.
        first = (await ctx.appStorage.increment(d.key)) === 1
      } catch (e) {
        if (!S.appStorageWarned) ctx.log.warn(`reminders: the app-wide store refused (${e.message}); this window reminds on its own`)
        S.appStorageWarned = true
      }
      if (!first) {
        ctx.log.info(`reminder ${d.minutes} min for ${d.ev.key}: shown by another window`)
        continue
      }
      const join = d.ev.join
      let text = reminderText(d.ev, now(), zone())
      if (join && S.clickable !== true) text = cut(text, 480 - OLD_APP_SUFFIX.length) + OLD_APP_SUFFIX
      ctx.log.info(`reminder ${d.minutes} min for ${d.ev.key}`)
      void notify(ctx, text, { join: Boolean(join), sound: reminderSoundOf(cfg()) }).then(
        (r) => {
          if (S.stopped) return
          if (r.clickable !== null && r.clickable !== S.clickable) {
            S.clickable = r.clickable
            ctx.storage.set('notifyClicks', r.clickable).catch(() => {})
          }
          // The person clicked the notification (or its Join): open the meeting, as the Join button does.
          if (r.clicked && join) void openUrl(join)
        },
        (e) => ctx.log.warn(`reminder for ${d.ev.key}: ${e && e.message ? e.message : e}`),
      )
    }
  }

  /** Once a day: the reminder keys of days before yesterday leave the app-wide store. */
  async function cleanReminderKeys() {
    const today = new Date(now()).toISOString().slice(0, 10)
    if (S.cleanedDay === today) return
    S.cleanedDay = today
    try {
      const old = staleKeys(await ctx.appStorage.keys(), today)
      for (const k of old) await ctx.appStorage.delete(k)
      if (old.length) ctx.log.info(`deleted ${old.length} old reminder key(s)`)
    } catch (e) {
      ctx.log.warn(`cleaning old reminder keys failed: ${e.message}`)
    }
  }

  // ---- settings ----

  ctx.onSettingsChange(async () => {
    const before = cfg()
    S.settings = readSettings(ctx.settings.project)
    if (!auth) return postState()
    try {
      await ready
      // A different client id signs out (design): its refresh token is deleted in auth.js.
      if (await auth.settingsChanged(cfg())) resetAccount()
    } catch (e) {
      ctx.log.warn(`applying the settings failed: ${e.message}`)
    }
    if (JSON.stringify(before.calendars) !== JSON.stringify(cfg().calendars)) S.listAgain = true
    rebuild()
    postState()
    if (signedIn()) void pollNow('settings', true)
  })

  // ---- sign-in ----

  /** The browser sign-in, started from the panel or `ccc calendar login`; it settles in the background. */
  function startSignIn(from) {
    if (!auth) return { error: tooOld }
    if (!auth.client()) return { error: 'No OAuth client yet: paste the client file in the Google Calendar panel, or ccc calendar client <file.json>.' }
    // Already open: start over (the panel's "Start over", a second `ccc calendar login`). The stuck
    // case is Google's error page ("Access blocked"), which never comes back to the app.
    const restarted = auth.status().signingIn
    void (async () => {
      try {
        const r = await auth.signIn()
        // A new sign-in may be another Google account: nothing of the last one carries over.
        resetAccount()
        S.blocked = blockedBy(auth.status().grant && auth.status().grant.missing)
        setNotice(r.sessionOnly ? `Signed in, but only until the app closes: ${r.sessionOnly}. Fix the keychain (ccc guide settings-secrets) and sign in again to stay signed in.` : 'Signed in with Google. Reading your calendar…', r.sessionOnly ? 'error' : 'info')
        ctx.log.info(`signed in (${from})`)
        // A poll of the old account may be running (its result is thrown away): then this one's
        // promise is that poll, and the new account gets its own right after.
        const stale = Boolean(S.polling)
        await pollNow('signin', true)
        if (stale && !S.blocked) await pollNow('signin', true)
        if (S.blocked) setNotice(S.blocked, 'error')
        else if (account() && !r.sessionOnly) setNotice(`Signed in as ${account()}.${auth.granted('rsvp') ? '' : ` ${SCOPE_TEXT.rsvp.label} was not granted: ${SCOPE_TEXT.rsvp.loses}.`}`)
      } catch (e) {
        // Replaced by a newer sign-in: that one reports, this one says nothing.
        if (e && e.kind === 'superseded') return
        setNotice(e && e.message ? e.message : String(e), 'error')
      }
    })()
    postState()
    return { message: `${restarted ? 'Started over: the open sign-in is cancelled. ' : ''}Your browser opens the Google sign-in: finish it there (it gives up after 5 minutes). ccc calendar status shows the result.` }
  }

  async function signOut() {
    if (!auth) return { message: tooOld }
    await ready
    await auth.signOut()
    resetAccount()
    postState()
    return { message: 'Signed out: the stored Google sign-in of this project is deleted.' }
  }

  async function pasteClient(text) {
    if (!auth) return { ok: false, error: tooOld }
    await ready
    const r = await auth.pasteClient(text)
    if (!r.ok) {
      S.clientError = r.error
      postState()
      return r
    }
    S.clientError = null
    if (r.changed) resetAccount()
    const saved = `Client saved (${shortClientId(r.clientId)})`
    if (!r.changed) {
      setNotice(`${saved}; it is the client already in use.`)
      return { ok: true, message: `${saved}; it is the client already in use.` }
    }
    setNotice(`${saved}. Next: Sign in with Google.`)
    return { ok: true, message: `${saved}. Next: ccc calendar login.` }
  }

  async function removeClient() {
    await ready
    const r = await auth.removeClient()
    if (!r.ok) return setNotice(r.error, 'error')
    if (r.changed) resetAccount()
    setNotice(auth.client() ? 'The pasted client is removed; the client from the settings is used.' : 'The pasted client is removed.')
  }

  // ---- events of the last poll ----

  /** The event behind a row key (a series row: its next occurrence), or null. */
  function eventOfKey(key) {
    if (!isKey(key)) return null
    if (key.startsWith('series:')) {
      const row = S.view && S.view.invitations.find((r) => r.key === key)
      return row ? eventOfKey(row.series.next) : null
    }
    return S.agenda.events.find((e) => e.key === key) || null
  }

  /** The event of an id (the CLI): on `cal` when given, else the primary calendar's copy first. */
  function eventOfId(id, calId) {
    const all = S.agenda.events.filter((e) => e.id === id && (!calId || e.calendarId === calId || (calId === 'primary' && e.primary)))
    // A copy hidden by the merge (the same event on two calendars) is in the state's lists.
    if (!all.length && S.state) {
      for (const list of Object.values(S.state.byCal)) for (const e of list) if (e.id === id && (!calId || e.calendarId === calId)) all.push(e)
    }
    return all.find((e) => e.primary) || all[0] || null
  }

  function labelOf(ev) {
    return ev ? `"${cut(oneLine(ev.title), 60)}"` : 'the event'
  }

  /** The event in Google Calendar, with `authuser` so it opens in the right account (Gmail's lesson). */
  function calendarUrl(ev) {
    if (!ev || !ev.link) return null
    try {
      const u = new URL(ev.link)
      if (account()) u.searchParams.set('authuser', account())
      return safeUrl(u.href, CALENDAR_HOSTS)
    } catch {
      return null
    }
  }

  // ---- RSVP (the only write) ----

  /**
   * Answer an invitation (design "RSVP"): the row changes at once, events.patch runs through the
   * gate, a failure puts the row back and says why. Resolves `{ message }` or `{ error }`; never
   * rejects. `one`: only this occurrence of a recurring invitation (else the series).
   */
  async function answerEvent(ev, answer, { one = false } = {}) {
    await ready
    if (!ready_()) return { error: auth ? auth.status().signedOutReason || S.blocked || 'Not signed in to Google.' : tooOld }
    if (!answerOf(answer)) return { error: 'An answer is yes, no or maybe.' }
    const plan = planRsvp(ev, { one })
    if (plan.error) return { error: plan.error }
    if (!auth.granted('rsvp')) return { error: `Sign in again to answer invitations: this Google sign-in was not granted ${SCOPE_TEXT.rsvp.label}.` }
    if (S.pending[plan.target] && S.pending[plan.target].state === 'pending') return { message: `${labelOf(ev)}: an answer is still on its way.` }
    const what = `${labelOf(ev)}${plan.series ? ' (the whole series)' : ev.recurring ? ' (this occurrence)' : ''}`
    S.pending[plan.target] = { answer, cal: plan.cal, id: plan.id, series: plan.series, state: 'pending' }
    rebuild()
    postState()
    try {
      await gate.run(() => cal.rsvp(plan.cal, plan.id, answer, plan.email, abort.signal))
      S.pending[plan.target] = { ...S.pending[plan.target], state: 'done', doneAt: now() }
      rebuild()
      postState()
      ctx.log.info(`answered ${plan.series ? 'series' : 'event'} ${ev.key}: ${answer}`)
      changed()
      if (S.polling) S.pollAgain = true
      else void pollNow('answer', true)
      const message = `${SAID[answer]} ${what}. The organizer is told.`
      setNotice(message)
      return { message }
    } catch (e) {
      delete S.pending[plan.target]
      rebuild()
      changed()
      let why = e && e.message ? e.message : String(e)
      if (e && e.kind === 'scope') {
        const g = auth.status().grant
        // The grant holds the RSVP scope and Google still refuses it: Google does not take that scope
        // for this write (design "Auth"). Not known: either case may be it.
        if (g && Array.isArray(g.missing)) why = RSVP_SCOPE_REFUSED_TEXT
        else why = `Google refused it for the scope (403). If you unticked a box at sign-in, Sign in again. If not: ${RSVP_SCOPE_REFUSED_TEXT}`
      }
      const text = `Could not answer ${what}: ${why.replace(/\.$/, '')}. It is shown as before.`
      ctx.log.warn(`answering ${ev.key} failed: ${e && e.message ? e.message : e}`)
      setNotice(text, 'error')
      return { error: text }
    }
  }

  // ---- the detail view ----

  /** A promise that rejects after `ms` (service calls have no timeout of their own). */
  function within(p, ms, what = 'the Jira plugin') {
    let timer
    return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} did not answer in time`)), ms)))]).finally(() => clearTimeout(timer))
  }

  async function reviewerHasCompanion() {
    try {
      const f = await within(reviewer.features(), FEATURES_WAIT_MS, 'the reviewer')
      return Array.isArray(f) && f.includes('companion')
    } catch {
      return false
    }
  }

  /** The event read fresh, as `{ ev, raw, doc, url, jira }` for the view, `show` and Discuss. */
  async function loadEvent(ev0, signal, { companion = false } = {}) {
    await ready
    if (!ready_()) throw new Error(auth ? auth.status().signedOutReason || S.blocked || 'Not signed in to Google.' : tooOld)
    const raw = await cal.event(ev0.calendarId, ev0.id, signal || abort.signal)
    const calInfo = (S.state.calendars || []).find((c) => c.id === ev0.calendarId) || { id: ev0.calendarId, name: ev0.calendarName, color: ev0.color, primary: ev0.primary }
    const tz = zone()
    const j = jiraOn() ? await jiraSite.get(JIRA_SITE_WAIT_MS) : null
    const jiraKeys = j ? (r) => J.keysIn([r.summary, r.location, typeof r.description === 'string' ? (/[<&]/.test(r.description) ? htmlToText(cut(r.description, 200000)) : r.description) : ''], j.site) : null
    const ev = compactEvent(raw, { cal: calInfo, me: emailAddress(account()) || '', tz, jiraKeys }) || ev0
    ev.phone = phoneOf(raw || {})
    const conflicts = (S.agenda.conflicts.get(ev0.key) || []).map((c) => ({ title: c.title, time: T.range(c.start, c.end, tz) }))
    // The first Jira issue the event names: its status in the facts, its page beside the event.
    let jiraFacts = ''
    const jiraLines = []
    let companionDoc = null
    if (j && ev.jira && ev.jira.length) {
      const key = ev.jira[0]
      const wait = io.jiraViewWaitMs === undefined ? JIRA_VIEW_WAIT_MS : io.jiraViewWaitMs
      const [i, d] = await Promise.allSettled([within(jira.issue(key, { maxAgeMs: 60000 }), wait), companion ? within(jira.document(key, JIRA_COMPANION_DOC), wait) : Promise.resolve(null)])
      const issue = i.status === 'fulfilled' && i.value && typeof i.value === 'object' ? i.value : null
      const doc = d.status === 'fulfilled' ? d.value : null
      const url = [doc && doc.url, issue && issue.url].find((u) => typeof u === 'string' && u.startsWith(`${j.site}/`)) || `${j.site}/browse/${key}`
      jiraFacts = J.issueFacts(key, issue, url, esc)
      for (const k of ev.jira) jiraLines.push(k === key ? J.jiraLine(key, issue, url) : `Jira issue ${k}: ${j.site}/browse/${k}`)
      if (d.status === 'rejected') ctx.log.warn(`jira: the issue ${key} beside the event: ${(d.reason && d.reason.message) || d.reason}`)
      const checked = doc ? J.checkDocument(doc, JIRA_COMPANION_DOC.maxHtmlBytes, new Set()) : null
      if (checked && !checked.error) companionDoc = J.jiraCompanion({ key, checked, assets: checked.assets, url, fallbackFacts: `<dl class="facts">${jiraFacts}</dl>` })
    }
    const doc = eventDocument({ raw, ev, tz, conflicts, calendarUrl: calendarUrl(ev), jiraFacts, jiraLines, now: now() })
    return { ev, raw, doc, url: calendarUrl(ev), companion: companionDoc }
  }

  /**
   * Open: the event as clean HTML in the reviewer (the Jira issue beside it when the reviewer can),
   * else as text in the reviewer, else in our own page (as bronos.gmail):
   *   annotate({ html, aside, companion }) -> refused -> annotate({ html, aside }) -> refused (not
   *   "no method") -> annotate({ text }) -> "no method annotate" or no reviewer -> panels/event.html.
   */
  async function openEvent(key) {
    const ev0 = eventOfKey(key)
    if (!ev0) return setNotice('That event is no longer in the agenda: refresh, then try again.', 'error')
    const beside = annotateOn() && !S.htmlRejected && jiraOn() && (ev0.jira || []).length ? await reviewerHasCompanion() : false
    const t = await loadEvent(ev0, null, { companion: beside })
    if (annotateOn()) {
      const pick = pickTab(await ctx.sessions.list().catch(() => []))
      const base = { title: cut(oneLine(t.ev.title), 200), key: `calendar:${sha(`${t.ev.calendarId}\n${t.ev.id}`, 24)}`, ...(t.url ? { url: t.url } : {}), ...(pick.tabId ? { tabId: pick.tabId } : {}) }
      const html = { ...base, label: 'Event', urlLabel: 'Calendar', start: 'top', html: t.doc.html, aside: t.doc.aside }
      let htmlError = null
      if (!S.htmlRejected && t.companion) {
        try {
          await reviewer.annotate({ ...html, companion: t.companion })
          return
        } catch (e) {
          if (isMissingAnnotate(e)) noAnnotate()
          else ctx.log.info(`reviewer refused the issue beside ${key} (${e && e.message ? e.message : e}); trying the event alone`)
        }
      }
      if (!S.htmlRejected && !S.annotateMissing) {
        try {
          await reviewer.annotate(html)
          return
        } catch (e) {
          if (isMissingAnnotate(e)) noAnnotate()
          else {
            htmlError = e && e.message ? e.message : String(e)
            ctx.log.info(`reviewer refused the html of ${key} (${htmlError}); trying text`)
          }
        }
      }
      if (!S.annotateMissing) {
        try {
          await reviewer.annotate({ ...base, text: cut(t.doc.text, 400000) })
          if (htmlError) {
            S.htmlRejected = htmlError
            ctx.log.info('reviewer.annotate takes text only: using text for this run')
            postState()
          }
          return
        } catch (e) {
          if (!isMissingAnnotate(e)) return setNotice(`The reviewer could not open the event: ${e.message}${htmlError && htmlError !== e.message ? ` (html: ${htmlError})` : ''}`, 'error')
          noAnnotate()
        }
      }
    }
    await plainReader(key, t)
  }

  function noAnnotate() {
    S.annotateMissing = true
    ctx.log.info("reviewer has no annotate (or none is enabled): using the plugin's reader page")
    postState()
  }

  /**
   * Without the reviewer's annotate: our own read-only page with Discuss and New session. It gets the
   * same HTML in parts. A link click comes back as `{ open }` and opens only a link this host put into
   * the document.
   */
  async function plainReader(key, t) {
    let handle
    try {
      handle = ctx.overlay.start({ kind: 'html', file: 'panels/event.html', title: cut(oneLine(t.ev.title), 100) || 'Google Calendar', size: 'large' })
    } catch (e) {
      return setNotice(`Cannot open the reader: ${e.message}`, 'error')
    }
    const html = `${t.doc.html}\n<h2>Details</h2>${t.doc.aside}`
    const parts = []
    for (let i = 0; i < html.length; i += PAGE_HTML_PART) parts.push(html.slice(i, i + PAGE_HTML_PART))
    try {
      handle.post({ type: 'doc', title: t.ev.title, parts: parts.length })
      parts.forEach((part, i) => handle.post({ type: 'html', i, part }))
    } catch (e) {
      ctx.log.warn(`posting to the reader: ${e.message}`)
    }
    // The links the page may ask to open: the ones this host put into the document (http(s) only).
    const links = new Set([...html.matchAll(/<a href="([^"]*)"/g)].map((x) => decode(x[1])).filter((u) => /^https?:\/\//i.test(u)))
    handle.onMessage((m) => {
      if (m && typeof m.open === 'string' && links.has(m.open)) void openUrl(m.open)
    })
    const res = await handle.result.catch((e) => {
      setNotice(`The reader failed: ${e.message}`, 'error')
      return null
    })
    const action = res && res.kind === 'value' && res.value && typeof res.value === 'object' ? res.value.action : null
    if (action === 'discuss') await discuss(key)
    else if (action === 'newSession') await newSession(key)
  }

  async function eventPrompt(key) {
    const ev0 = eventOfKey(key)
    if (!ev0) throw new Error('That event is no longer in the agenda: refresh, then try again.')
    const t = await loadEvent(ev0)
    return discussPrompt(t.ev, t.doc.text, zone(), now())
  }

  async function discuss(key, tabId) {
    const pick = pickTab(await ctx.sessions.list(), tabId)
    if (pick.error) return setNotice(pick.error, 'error')
    if (pick.choose) {
      S.choose = { key, label: labelOf(eventOfKey(key)), tabs: pick.choose }
      return postState()
    }
    S.choose = null
    const prompt = await eventPrompt(key)
    const r = await ctx.sessions.send(pick.tabId, prompt)
    setNotice(r && r.delivered ? `Sent ${labelOf(eventOfKey(key))} to "${pick.label}".` : `Queued for "${pick.label}": it gets ${labelOf(eventOfKey(key))} when Claude is waiting for input.`)
  }

  async function newSession(key) {
    const prompt = await eventPrompt(key)
    await ctx.sessions.open({ prompt })
    setNotice(`Opened a new Claude tab about ${labelOf(eventOfKey(key))}.`)
  }

  /** Join: the event's Meet link from the last poll (never a URL from the page). */
  async function join(ev) {
    if (!ev) return setNotice('That event is no longer in the agenda: refresh, then try again.', 'error')
    if (!ev.join) return setNotice(`${labelOf(ev)} has no Google Meet link${ev.location ? `; where: ${ev.location}` : ''}.`)
    await openUrl(ev.join)
  }

  /**
   * An http(s) address in the person's browser (Join, Open in Calendar, a setup link, a link in the
   * reader page), with ctx.openExternal. When the app refuses (its limit is 3 a 10 s), the address is
   * shown so it can be copied.
   */
  async function openUrl(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return setNotice(`Only web links open from here; the address: ${cut(String(url), 300)}`)
    try {
      await ctx.openExternal(url)
    } catch (e) {
      setNotice(`Could not open the browser (${e && e.message ? e.message : e}). The address: ${url}`, 'error')
    }
  }

  function setNotice(text, kind = 'info') {
    S.notice = { text: cut(oneLine(text), 900), kind }
    postState()
  }

  // ---- panel ----

  /** The calendars for the picker: each of the list, whether it is shown and why. */
  function calendarsForPanel() {
    if (!S.state) return []
    const sel = selection(S.state, cfg(), S.picked)
    const on = new Set(sel.calendars.map((c) => c.id))
    return S.state.calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, primary: c.primary, on: on.has(c.id), from: c.primary ? 'primary' : sel.fromSettings.has(c.id) ? 'settings' : on.has(c.id) ? 'picked' : '' }))
  }

  function zoneNote() {
    if (!S.state || !S.state.lastPoll) return ''
    const tz = zone()
    const computer = T.computerZone()
    const calZone = S.state.calendarZone
    if (cfg().timeZone === 'computer') return calZone && calZone !== tz ? `Times in ${tz} (this computer's zone); your Google Calendar is set to ${calZone}.` : ''
    return computer !== tz ? `Times in ${tz} (your Google Calendar's time zone); this computer is in ${computer}.` : ''
  }

  function stale() {
    if (!S.state || !S.state.lastPoll) return false
    return Boolean(S.error) || now() - S.state.lastPoll > (S.backoffMinutes || cfg().pollMinutes) * 60000 * 2.5
  }

  function rowJson(r) {
    // The page gets keys, never ids or URLs (design "Panel").
    const { id, calendarId, ...rest } = r
    const out = { ...rest, title: cut(r.title, 300), location: cut(r.location || '', 300) }
    // A series row: its count and its next occurrence's key; the recurring event's id stays here.
    if (r.series) out.series = { next: r.series.next, count: r.series.count }
    return out
  }

  function dayJson(d) {
    return { day: d.day, label: T.longDay(d.day), chips: d.chips.slice(0, 50).map(rowJson), rows: d.rows.slice(0, ROWS_MAX).map(rowJson), past: d.past || 0, clock: d.clock || [] }
  }

  function stateMessage() {
    const a = auth ? auth.status() : null
    const st = S.settings
    const v = S.view
    return {
      type: 'state',
      tooOld,
      // The setup guide while there is no sign-in; the page draws the steps and asks for the links.
      auth: a
        ? {
            client: a.client ? { source: a.client.source, id: a.client.id } : null,
            pasted: a.pasted,
            pastedBroken: a.pastedBroken,
            settingsMissing: a.settingsMissing,
            signedIn: a.signedIn,
            sessionOnly: a.sessionOnly,
            signingIn: a.signingIn,
            signedOutReason: a.signedOutReason,
          }
        : null,
      blocked: S.blocked,
      steps: STEPS,
      clientError: S.clientError,
      problems: st.problems,
      account: account(),
      lastPoll: (S.state && S.state.lastPoll) || 0,
      lastPollText: S.state && S.state.lastPoll ? T.hm(S.state.lastPoll, zone()) : '',
      stale: stale(),
      polling: Boolean(S.polling),
      error: S.error,
      notes: S.notes,
      calendarErrors: S.calendarErrors.slice(0, 5),
      missingCalendars: S.missingCalendars,
      rsvpOn: Boolean(auth) && auth.granted('rsvp'),
      rsvpText: `Sign in again to answer invitations: this sign-in was not granted ${SCOPE_TEXT.rsvp.label}.`,
      annotate: annotateOn(),
      notice: S.notice,
      choose: S.choose,
      ui: S.ui,
      zoneNote: zoneNote(),
      calendars: calendarsForPanel(),
      view: v
        ? {
            tz: v.tz,
            now: v.now.map(rowJson),
            next: v.next ? rowJson(v.next) : null,
            ooo: v.ooo,
            invitations: v.invitations.slice(0, 100).map(rowJson),
            today: dayJson(v.today),
            tomorrow: dayJson(v.tomorrow),
            upcoming: { rows: v.upcoming.rows.map(rowJson), more: v.upcoming.more, days: v.upcoming.days },
          }
        : null,
    }
  }

  /** Post the state. `ifChanged`: only when it differs from the last one posted (the tick). */
  function postState(ifChanged = false) {
    if (S.stopped) return
    try {
      const m = stateMessage()
      const json = JSON.stringify(m)
      if (!(ifChanged && json === lastPosted)) {
        lastPosted = json
        ctx.panels.post(PANEL, m)
      }
    } catch (e) {
      ctx.log.warn('panel post:', e.message)
    }
    postAgenda()
    setHeader()
  }

  // ---- the title bar ----

  let lastHeader = ''
  function setHeader() {
    if (tooOld || S.stopped) return
    const spec = headerSpec({ ready: ready_(), polling: Boolean(S.polling), view: S.view, account: account(), lastPoll: (S.state && S.state.lastPoll) || 0, stale: stale(), tz: zone() }, now())
    // Every state message and every tick call this: unchanged headers are not resent.
    const json = JSON.stringify(spec)
    if (json === lastHeader) return
    lastHeader = json
    try {
      ctx.panels.header(PANEL, spec)
    } catch (e) {
      ctx.log.warn('panel header:', e.message)
    }
  }
  if (!tooOld) {
    ctx.panels.onAction(PANEL, (id) => {
      if (id === 'refresh') void pollNow('header', true)
      else if (id === 'join') {
        const r = S.view && S.view.head.join
        if (r) void join(eventOfKey(r.key))
      }
    })
  }

  ctx.panels.onMessage(PANEL, async (m) => {
    if (!m || typeof m !== 'object') return
    try {
      switch (m.type) {
        case 'hello':
          await ready
          return postState()
        case 'refresh':
          return void pollNow('panel', true)
        case 'toggleCalendars': {
          S.ui.calendarsOpen = !S.ui.calendarsOpen
          ctx.storage.set('ui', S.ui).catch(() => {})
          return postState()
        }
        case 'pick': {
          // A calendar of the list, switched on or off in the picker (not the primary one, not one of the settings).
          const c = S.state && typeof m.id === 'string' ? S.state.calendars.find((x) => x.id === m.id) : null
          if (!c || c.primary || cfg().calendars.includes(c.id)) return
          S.picked = S.picked.includes(c.id) ? S.picked.filter((x) => x !== c.id) : [...S.picked, c.id].slice(0, 20)
          await ctx.storage.set('picked', S.picked).catch((e) => ctx.log.warn(`saving the picked calendars failed: ${e.message}`))
          postState()
          return void pollNow('picker', true)
        }
        case 'dismiss':
          S.notice = null
          S.choose = null
          S.clientError = null
          return postState()
        case 'link': {
          // A setup link: the page names it, the URL is ours (setup.js).
          const url = linkUrl(m.id)
          if (url) await openUrl(url)
          return
        }
        case 'client':
          if (typeof m.text === 'string') await pasteClient(m.text)
          return
        case 'removeClient':
          return await removeClient()
        case 'signIn': {
          const r = startSignIn('panel')
          if (r.error) setNotice(r.error, 'error')
          return
        }
        case 'signOut':
          await signOut()
          return setNotice('Signed out: the stored Google sign-in of this project is deleted.')
      }
      // The page is ours, but a key still picks an event: checked against the last poll's agenda.
      const key = isKey(m.key) ? m.key : null
      if (!key) return
      switch (m.type) {
        case 'open':
          return await openEvent(key)
        case 'join':
          return await join(eventOfKey(key))
        case 'calendar': {
          const url = calendarUrl(eventOfKey(key))
          return url ? await openUrl(url) : setNotice('This event has no Google Calendar link.')
        }
        case 'discuss':
          return await discuss(key, typeof m.tabId === 'string' ? m.tabId : undefined)
        case 'newSession':
          return await newSession(key)
        case 'rsvp': {
          const answer = answerOf(m.answer)
          if (!answer) return
          const r = await answerEvent(eventOfKey(key), answer, { one: m.one === true })
          // A failed call already put up its notice; a refusal before any call says it here.
          if (r.error && (!S.notice || S.notice.text !== cut(oneLine(r.error), 900))) setNotice(r.error, 'error')
          else if (r.message && !S.notice) setNotice(r.message)
          return
        }
      }
    } catch (e) {
      ctx.log.warn(`panel ${m.type}: ${e && e.message ? e.message : e}`)
      setNotice(e && e.message ? e.message : String(e), 'error')
    }
  })

  // ---- the agenda slot (contributes.slots; the Inbox draws it above or below its list) ----
  // The slot's page is ours but sits in another plugin's panel, so it gets the same thing as the
  // panel's page: row keys only, never an id or a URL, and it posts back `{ type, key }`. Join is
  // stricter than the panel's: the Meet link opens only when it is https (a slot is a small
  // surface; the panel's openUrl also takes http).

  const slotFrames = new Set()
  let lastAgenda = ''

  /** What the slot's page draws: today's timed rows with the day clock, now, next, invitations. */
  function agendaMessage() {
    const sv = serviceState()
    const v = S.view
    if (sv.state !== 'ok' || !v) {
      const text = sv.state === 'signedOut' ? 'Not signed in to Google Calendar: open the Google Calendar panel to sign in.' : sv.message || 'The calendar has not been read yet.'
      return { type: 'agenda', ok: false, text }
    }
    const day = dayJson(v.today)
    return {
      type: 'agenda',
      ok: true,
      today: { day: day.day, label: day.label, rows: day.rows.filter((r) => !r.allDay), clock: day.clock },
      now: v.now.map(rowJson),
      next: v.next ? rowJson(v.next) : null,
      invitations: v.invitations.slice(0, 5).map(rowJson),
      rsvpOn: Boolean(auth) && auth.granted('rsvp'),
      rsvpText: `Sign in again to answer invitations: this sign-in was not granted ${SCOPE_TEXT.rsvp.label}.`,
      stale: stale(),
    }
  }

  /** Send the slot state to every open frame; `force` also when it did not change (a new frame). */
  function postAgenda(force = false) {
    if (S.stopped || !slotFrames.size) return
    try {
      const m = agendaMessage()
      const json = JSON.stringify(m)
      if (!force && json === lastAgenda) return
      lastAgenda = json
      for (const f of slotFrames) f.post(m)
    } catch (e) {
      ctx.log.warn('slot post:', e.message)
    }
  }

  /** Join from the slot: the event's Meet link from the last poll, https only. */
  async function slotJoin(ev) {
    if (!ev || !ev.join) return slotNotice('That event has no Google Meet link (or is no longer in the agenda).', 'error')
    if (!/^https:\/\//i.test(ev.join)) return slotNotice('Only https meeting links open from here.', 'error')
    try {
      await ctx.openExternal(ev.join)
    } catch (e) {
      slotNotice(`Could not open the browser (${e && e.message ? e.message : e}).`, 'error')
    }
  }

  function slotNotice(text, kind = 'info') {
    for (const f of slotFrames) {
      try {
        f.post({ type: 'notice', text: cut(oneLine(text), 300), kind })
      } catch (e) {
        ctx.log.warn('slot notice:', e.message)
      }
    }
  }

  async function onSlotMessage(m) {
    if (!m || typeof m !== 'object') return
    try {
      if (m.type === 'hello') {
        await ready
        return postAgenda(true)
      }
      const key = isKey(m.key) ? m.key : null
      if (!key) return
      if (m.type === 'join') return await slotJoin(eventOfKey(key))
      if (m.type === 'open') return await openEvent(key)
      if (m.type === 'rsvp') {
        const answer = answerOf(m.answer)
        if (!answer) return
        const r = await answerEvent(eventOfKey(key), answer, { one: m.one === true })
        if (r.error) slotNotice(r.error, 'error')
      }
    } catch (e) {
      ctx.log.warn(`slot ${m.type}: ${e && e.message ? e.message : e}`)
      slotNotice(e && e.message ? e.message : String(e), 'error')
    }
  }

  // An older app has no ctx.slots: the plugin works without the slot.
  if (!tooOld && ctx.slots && typeof ctx.slots.onOpen === 'function') {
    ctx.slots.onOpen('agenda', (slot) => {
      slotFrames.add(slot)
      slot.onClose(() => slotFrames.delete(slot))
      slot.onMessage(onSlotMessage)
      // The page says hello when it loads; a frame that opened after a poll gets the state at once too.
      void ready.then(() => {
        if (slotFrames.has(slot)) {
          try {
            slot.post(agendaMessage())
          } catch (e) {
            ctx.log.warn('slot post:', e.message)
          }
        }
      })
    })
  }

  // ---- CLI ----

  function status() {
    const a = auth ? auth.status() : {}
    const tz = zone()
    return {
      tooOld,
      client: a.client || null,
      pasted: a.pasted,
      pastedBroken: a.pastedBroken,
      settingsMissing: a.settingsMissing || [],
      signedIn: Boolean(a.signedIn),
      ready: ready_(),
      blocked: S.blocked,
      sessionOnly: a.sessionOnly,
      signingIn: a.signingIn,
      signedOutReason: a.signedOutReason,
      problems: S.settings.problems,
      account: account(),
      missing: a.grant ? a.grant.missing : null,
      zone: S.state && S.state.lastPoll ? tz : null,
      zoneSource: cfg().timeZone === 'computer' ? "this computer's zone (setting timeZone)" : "your Google Calendar's time zone",
      otherZone: T.computerZone() !== tz ? T.computerZone() : null,
      calendars: calendarsForPanel(),
      missingCalendars: S.missingCalendars,
      lastPoll: (S.state && S.state.lastPoll) || 0,
      stale: stale(),
      polling: Boolean(S.polling),
      pollMinutes: cfg().pollMinutes,
      backoffMinutes: S.backoffMinutes,
      counts: S.view ? S.view.counts : null,
      reminders: cfg().reminders,
      reminderSound: cfg().reminderSound,
      reminderSoundChoice: cfg().reminderSoundChoice,
      clickable: S.clickable,
      jira: jiraOn() ? 'on (bronos.jira): issue keys in events get chips, and the issue shows beside the event' : 'off: enable the Jira plugin (bronos.jira) in this project for issue chips and the issue beside the event',
      annotate: annotateOn()
        ? S.htmlRejected
          ? `reviewer.annotate, text only (its html mode was refused: ${S.htmlRejected})`
          : 'reviewer.annotate (the event as a clean page, notes on it)'
        : "the plugin's reader page (no reviewer with annotate in this project)",
      error: S.error,
      notes: S.notes,
      calendarErrors: S.calendarErrors,
    }
  }

  /** The view for the CLI: the panel's, with the join links of Now and Next (the CLI prints them). */
  function cliView() {
    const v = S.view
    const withUrl = (r) => {
      const ev = eventOfKey(r.key)
      return { ...r, joinUrl: ev && ev.join ? ev.join : null }
    }
    return { ...v, now: v.now.map(withUrl), next: v.next ? withUrl(v.next) : null }
  }

  ctx.cli.register('calendar', async (argv, call) => {
    await ready
    return runCli(
      argv,
      {
        status,
        now,
        async refresh() {
          const p = pollNow('cli', true)
          let timer
          const late = new Promise((r) => {
            timer = setTimeout(() => r('late'), io.cliWaitMs || CLI_WAIT_MS)
          })
          const got = await Promise.race([p.then(() => 'done'), late])
          clearTimeout(timer)
          if (got === 'late') return { pending: true }
          return S.error ? { error: S.error } : {}
        },
        view: cliView,
        async show(id, calId, signal) {
          const ev = eventOfId(id, calId)
          if (!ev) throw new Error(`${id} is not among the last poll's events${calId ? ` on ${calId}` : ''}: ccc calendar today shows the ids (refresh first?).`)
          return (await loadEvent(ev, signal)).doc.text
        },
        async rsvp(id, calId, answer, one) {
          const ev = eventOfId(id, calId)
          if (!ev) return { error: `${id} is not among the last poll's events${calId ? ` on ${calId}` : ''}: ccc calendar upcoming shows the invitations.` }
          let timer
          const late = new Promise((r) => {
            timer = setTimeout(() => r({ error: 'Google has not answered yet; ccc calendar upcoming shows whether it went through.' }), io.cliWaitMs || CLI_WAIT_MS)
          })
          const r = await Promise.race([answerEvent(ev, answer, { one }), late])
          clearTimeout(timer)
          return r
        },
        login: async () => startSignIn('cli'),
        logout: () => signOut(),
        client: (text) => pasteClient(text),
      },
      call,
    )
  })

  // ---- the `calendar` service (lib/service.js; Inbox reads it) ----
  // Everything answers from the last poll's agenda, with the answers still on their way applied.

  function serviceState() {
    if (!auth) return { state: 'error', message: tooOld }
    if (!signedIn()) return { state: 'signedOut', message: 'Not signed in to Google Calendar.' }
    // A failed poll keeps the agenda of the last good one: that is served (a Google hiccup must not
    // blank the caller's day). Only before any poll has worked is there nothing to serve.
    if (!S.state || !S.state.lastPoll || S.blocked) return { state: 'error', message: S.blocked || S.error || 'The calendar has not been read yet.' }
    return { state: 'ok' }
  }
  const serviceEvents = () => withPending(S.agenda.events, S.pending)

  /** The agenda event of a service id: the primary copy first, or a refusal naming the cause. */
  function serviceEvent(id) {
    const ev = eventOfId(svc.checkId(id))
    if (!ev) throw new Error('calendar: that event is not in the last poll (it may be over or removed)')
    return ev
  }

  if (typeof ctx.services.provide === 'function') {
    ctx.services.provide('calendar', {
      day: (o) => {
        const opts = svc.dayOptions(o)
        return svc.day({ events: serviceEvents(), opts, now: now(), tz: zone(), cfg: cfg(), ...serviceState() })
      },
      upcoming: (o) => {
        const opts = svc.upcomingOptions(o)
        if (serviceState().state !== 'ok') return []
        return svc.upcoming({ events: serviceEvents(), opts, now: now(), tz: zone(), cfg: cfg() })
      },
      async respond(id, answer) {
        const ev = serviceEvent(id)
        const a = svc.checkAnswer(answer)
        const r = await answerEvent(ev, a)
        if (r.error) throw new Error(`calendar: ${r.error}`)
      },
      async open(id) {
        const ev = serviceEvent(id)
        await openEvent(ev.key)
        // openEvent says a failure in a notice and returns; a refusal here tells the caller.
        if (S.notice && S.notice.kind === 'error') throw new Error(`calendar: ${S.notice.text}`)
      },
    })
  }

  return {
    S,
    auth,
    ready,
    pollNow,
    tick,
    answerEvent,
    eventOfKey,
    eventOfId,
    stop() {
      S.stopped = true
      abort.abort()
      gate.stop()
      if (firstPoll) (io.clearTimeout || clearTimeout)(firstPoll)
      if (stopTick) stopTick()
      return agendaFile.flush().catch(() => {})
    },
  }
}

exports.activate = (ctx) => {
  instance = start(ctx)
  const gaps = apiGaps(ctx)
  ctx.log.info(gaps.length ? `activated on an app that is too old (no ${gaps.join(', ')})` : 'activated')
}

exports.deactivate = () => {
  const i = instance
  instance = null
  return i ? i.stop() : undefined
}

// For the suites: the host with fakes in place of fetch and timers.
exports._start = start
exports._apiGaps = apiGaps
