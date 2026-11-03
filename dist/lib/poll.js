'use strict'
// One poll (design "Fetching"): the calendar list when it is an hour old (or asked for), then each
// selected calendar's window of events, two calendars at a time, merged into one agenda with the
// conflicts. The state it fills is what agenda.json keeps, so a window that opens shows the last
// agenda at once. A calendar that fails keeps its last events (marked stale in the notes); the poll
// fails as a whole only when the primary calendar does, or every one does.

const T = require('./time')
const { compactCalendar, compactEvent, mergeEvents, findConflicts } = require('./model')
const { mapLimit, emailAddress, cut } = require('./util')
const { htmlToText } = require('./sanitize')
const { keysIn } = require('./jira')

const LIST_MAX_AGE_MS = 3600000
const MAX_EVENTS_PER_CALENDAR = 1000 // 4 pages of 250
const STATE_VERSION = 1

/** An empty poll state for a client (its hash, so another client's agenda is never shown). */
function emptyState(client) {
  return { v: STATE_VERSION, client: client || '', account: '', calendars: [], calendarZone: null, listAt: 0, byCal: {}, lastPoll: 0, zone: null, day: null }
}

/** The stored state when it is this client's and well formed, else an empty one. */
function loadState(raw, client) {
  if (!raw || typeof raw !== 'object' || raw.v !== STATE_VERSION || raw.client !== client) return emptyState(client)
  const s = emptyState(client)
  s.account = typeof raw.account === 'string' ? raw.account.slice(0, 254) : ''
  s.calendars = Array.isArray(raw.calendars) ? raw.calendars.map(compactCalendarKept).filter(Boolean) : []
  s.calendarZone = T.validZone(raw.calendarZone)
  s.listAt = Number(raw.listAt) || 0
  s.lastPoll = Number(raw.lastPoll) || 0
  s.zone = T.validZone(raw.zone)
  s.day = T.validDay(raw.day)
  if (raw.byCal && typeof raw.byCal === 'object') {
    for (const [cal, list] of Object.entries(raw.byCal)) {
      if (Array.isArray(list)) s.byCal[cal] = list.filter((e) => e && typeof e.key === 'string' && typeof e.id === 'string' && Number.isFinite(e.start) && Number.isFinite(e.end)).slice(0, MAX_EVENTS_PER_CALENDAR)
    }
  }
  return s
}

// A stored calendar entry is already compact; checked again as it comes from a file.
function compactCalendarKept(c) {
  if (!c || typeof c !== 'object') return null
  const k = compactCalendar({ id: c.id, summary: c.name, backgroundColor: c.color, primary: c.primary, timeZone: c.tz, accessRole: c.access, hidden: c.hidden })
  return k
}

/** The display zone (setting `timeZone`, design "Time zones"). */
function displayZone(cfg, state) {
  if (cfg.timeZone === 'computer') return T.computerZone()
  return T.validZone(state && state.calendarZone) || T.computerZone()
}

/** The primary calendar of the list, or null. */
function primaryOf(state) {
  return (state.calendars || []).find((c) => c.primary) || null
}

/**
 * The calendars to read: the primary one, then the setting's, then the picker's, each once. Ids not
 * in the calendar list are `missing` (a notice names them; they are not read).
 */
function selection(state, cfg, picked) {
  const primary = primaryOf(state)
  const known = new Map((state.calendars || []).map((c) => [c.id, c]))
  const out = primary ? [primary] : []
  const missing = []
  const fromSettings = new Set()
  for (const [id, src] of [...cfg.calendars.map((id) => [id, 'settings']), ...(picked || []).map((id) => [id, 'picked'])]) {
    if (primary && id === primary.id) continue
    if (src === 'settings') fromSettings.add(id)
    const c = known.get(id)
    if (!c) {
      if (src === 'settings' && !missing.includes(id)) missing.push(id)
      continue
    }
    if (!out.includes(c)) out.push(c)
  }
  return { calendars: out, missing, fromSettings }
}

/** The window of a poll: `{ todayKey, timeMin, timeMax, inviteMax }` (instants as RFC 3339). */
function windowOf(now, tz, cfg) {
  const todayKey = T.dayKey(now, tz)
  return {
    todayKey,
    timeMin: T.rfc3339(T.startOfDay(todayKey, tz)),
    timeMax: T.rfc3339(T.startOfDay(T.addDays(todayKey, cfg.upcomingDays + 1), tz)),
    inviteMax: T.rfc3339(T.startOfDay(T.addDays(todayKey, Math.max(cfg.upcomingDays, cfg.inviteDays) + 1), tz)),
  }
}

/**
 * Poll once. Fills `state` and resolves `{ stats }` (`errors` per calendar, `missing` ids, `skipped`
 * malformed events, `more` calendars cut at 1000 events). Rejects with the primary calendar's error
 * (or the first one, when every calendar failed), so the host can back off or show the sign-in.
 *
 * @param {object} o
 * @param {object} o.client client.createClient
 * @param {object} o.cfg settings cfg
 * @param {object} o.state poll state (emptyState / loadState)
 * @param {string[]} [o.picked] the picker's calendar ids
 * @param {number} o.now
 * @param {boolean} [o.listAgain] read the calendar list even when it is recent
 * @param {{ site: string } | null} [o.jira] the Jira site, for the issue keys of an event
 * @param {AbortSignal} [o.signal]
 */
async function poll(o) {
  const { client, cfg, state, now, signal } = o
  const stats = { calendars: 0, events: 0, errors: [], missing: [], skipped: 0, more: [] }
  if (o.listAgain || !state.calendars.length || now - state.listAt > LIST_MAX_AGE_MS || !primaryOf(state)) {
    const list = (await client.calendarList(signal)).map(compactCalendar).filter(Boolean)
    if (!list.some((c) => c.primary)) throw Object.assign(new Error('Google sent a calendar list without your primary calendar: try again later'), { kind: 'http' })
    state.calendars = list
    state.listAt = now
    const p = primaryOf(state)
    state.account = emailAddress(p.id) || p.id
    state.calendarZone = p.tz
  }
  const tz = displayZone(cfg, state)
  const w = windowOf(now, tz, cfg)
  const sel = selection(state, cfg, o.picked)
  stats.missing = sel.missing
  const me = emailAddress(state.account) || ''
  const site = o.jira && o.jira.site
  const jiraKeys = o.jira
    ? (raw) => {
        const desc = typeof raw.description === 'string' ? (/[<&]/.test(raw.description) ? htmlToText(cut(raw.description, 200000)) : raw.description) : ''
        return keysIn([raw.summary, raw.location, desc], site)
      }
    : null
  const results = await mapLimit(sel.calendars, 2, async (cal) => {
    const r = await client.events(cal.id, { timeMin: w.timeMin, timeMax: cal.primary ? w.inviteMax : w.timeMax, timeZone: tz }, signal)
    const list = []
    for (const raw of r.items) {
      let ev = null
      try {
        ev = compactEvent(raw, { cal, me, tz, jiraKeys })
      } catch {
        ev = null
      }
      if (ev) list.push(ev)
      else if (!raw || raw.status !== 'cancelled') stats.skipped++
    }
    if (r.more) stats.more.push(cal.name)
    return list.slice(0, MAX_EVENTS_PER_CALENDAR)
  })
  const fails = []
  results.forEach((r, i) => {
    const cal = sel.calendars[i]
    if (r.ok) {
      state.byCal[cal.id] = r.value
      stats.calendars++
    } else {
      fails.push({ cal, error: r.error })
      stats.errors.push({ calendar: cal.name, id: cal.id, message: r.error && r.error.message ? r.error.message : String(r.error) })
    }
  })
  const primaryFail = fails.find((f) => f.cal.primary)
  if (primaryFail || (fails.length && fails.length === sel.calendars.length)) throw (primaryFail || fails[0]).error
  // Calendars no longer selected leave the agenda.
  for (const id of Object.keys(state.byCal)) if (!sel.calendars.some((c) => c.id === id)) delete state.byCal[id]
  state.lastPoll = now
  state.zone = tz
  state.day = w.todayKey
  stats.events = Object.values(state.byCal).reduce((n, l) => n + l.length, 0)
  return { stats }
}

/** The merged agenda of a state and its conflicts. */
function agendaOf(state) {
  const events = mergeEvents(Object.values(state.byCal || {}))
  return { events, conflicts: findConflicts(events) }
}

module.exports = { poll, emptyState, loadState, displayZone, primaryOf, selection, windowOf, agendaOf, LIST_MAX_AGE_MS, STATE_VERSION }
