'use strict'
// The `calendar` service (v1) the Inbox plugin calls (inbox design "The calendar contract"): the pure
// parts. The host (dist/host.js) wires them to its agenda, its RSVP and its event page.
//
// - Reads (`day`, `upcoming`) answer from the last poll's agenda and never make a Google call: a
//   service call is a plain call inside the plugin host with no rate limit from the app, so a caller
//   that asks every few seconds must cost nothing. Writes (`respond`) go through the plugin's own
//   RSVP path and its gate (rsvp.js: 4 at once, 60 a minute).
// - Arguments come from another plugin, so each is checked here: the date is a real YYYY-MM-DD, count
//   and days are clamped (a caller can only ask for less), the id has the shape of a Google event id
//   (the lookup is by that id in the agenda, never a request), the answer is one of the three exact
//   words (not the CLI's yes / no / maybe: this is a contract, not a prompt).
// - Results are plain data (the registry copies them with structuredClone): `meetUrl` is https only,
//   times are ms, nothing carries the token, the guest list, notes or the Google link.
// - Which events: the ones the panel shows. Declined ones are left out unless the plugin's
//   `showDeclined` is on (the person's choice, as in the panel); a working-location chip and a
//   birthday (per `showBirthdays`) are not things to attend, so working location is always left out.
// - Errors are thrown as `calendar: <why>`.

const T = require('./time')
const { eventId } = require('./util')

const COUNT = { def: 5, min: 1, max: 20 }
const DAYS = { def: 7, min: 1, max: 30 }
const EVENTS_MAX = 100 // a day's events in one answer (a calendar full of all-day chips stays small)
const ANSWERS = new Set(['accepted', 'tentative', 'declined'])

function clampInt(v, def, lo, hi) {
  if (v === undefined || v === null) return def
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, n))
}

function options(o) {
  if (o === undefined || o === null) return {}
  if (typeof o !== 'object' || Array.isArray(o)) throw new Error('calendar: the options are an object')
  return o
}

/** `day()`'s options: `{ date }` as YYYY-MM-DD (or none: today). */
function dayOptions(o) {
  const x = options(o)
  if (x.date === undefined || x.date === null) return { date: null }
  const d = typeof x.date === 'string' && x.date.length === 10 ? T.validDay(x.date) : null
  if (!d) throw new Error('calendar: date is YYYY-MM-DD')
  return { date: d }
}

/** `upcoming()`'s options: `{ count, days }`, clamped to 1..20 and 1..30. */
function upcomingOptions(o) {
  const x = options(o)
  return { count: clampInt(x.count, COUNT.def, COUNT.min, COUNT.max), days: clampInt(x.days, DAYS.def, DAYS.min, DAYS.max) }
}

/** The event id of a service argument, or throws: a string of Google's id alphabet, bounded. */
function checkId(value) {
  const id = eventId(value)
  if (!id) throw new Error('calendar: not an event id')
  return id
}

/** The answer of a service argument, or throws: exactly accepted, tentative or declined. */
function checkAnswer(value) {
  if (typeof value !== 'string' || !ANSWERS.has(value)) throw new Error("calendar: the answer is 'accepted', 'tentative' or 'declined'")
  return value
}

/** The https address of a Meet link, or undefined: anything else is dropped (Join opens it in a browser). */
function meetUrlOf(join) {
  if (typeof join !== 'string' || join.length > 2000) return undefined
  try {
    const u = new URL(join)
    return u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}

/** Google's answer of the person as the contract's: an organizer has accepted, a non-guest has none. */
function responseOf(ev) {
  if (ev.response === 'organizer') return 'accepted'
  if (ev.response === 'accepted' || ev.response === 'tentative' || ev.response === 'declined' || ev.response === 'needsAction') return ev.response
  return null
}

/** An agenda event as the contract's `CalEvent`. */
function calEvent(ev) {
  const out = { id: ev.id, title: ev.title, start: ev.start, end: ev.end, allDay: Boolean(ev.allDay), response: responseOf(ev) }
  const meetUrl = meetUrlOf(ev.join)
  if (meetUrl) out.meetUrl = meetUrl
  return out
}

/** Whether the contract lists this event at all. */
function listed(ev, cfg) {
  if (ev.type === 'workingLocation') return false
  if (ev.response === 'declined' && !cfg.showDeclined) return false
  if (ev.type === 'birthday' && !cfg.showBirthdays) return false
  return true
}

const byStart = (a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1)

/** Whether an event is on the day `key`: a timed one overlaps it, an all-day one covers the date. */
function onDay(ev, key, tz) {
  if (ev.allDay) return ev.startDate <= key && key < ev.endDate
  const from = T.startOfDay(key, tz)
  const to = T.startOfDay(T.addDays(key, 1), tz)
  // A zero-length event (no end) sits at its start.
  return ev.start < to && (ev.end > from || ev.start >= from)
}

/**
 * `day()`: the events of a date, how many tomorrow holds and the first of them.
 * @param {object} o
 * @param {object[]} o.events the agenda's events (poll.agendaOf, with the pending answers applied)
 * @param {{ date: string | null }} o.opts dayOptions
 * @param {number} o.now
 * @param {string} o.tz the display zone
 * @param {object} o.cfg the plugin's settings
 * @param {'ok' | 'signedOut' | 'error'} o.state
 * @param {string} [o.message] why the state is not ok
 */
function day({ events, opts, now, tz, cfg, state, message }) {
  const today = T.dayKey(now, tz)
  const date = opts.date || today
  const tomorrow = T.addDays(date, 1)
  const out = { date, events: [], tomorrow: { count: 0 }, state }
  if (message) out.message = message
  if (state !== 'ok') return out
  // What the cache holds: today through the Upcoming window (poll.windowOf). Another date is not
  // "no events": the caller must not read an empty list as a free day.
  const last = T.addDays(today, cfg.upcomingDays)
  if (date < today || date > last) {
    out.message = `${date} is outside what the calendar has read (${today} to ${last})`
    return out
  }
  const list = events.filter((e) => listed(e, cfg)).sort(byStart)
  out.events = list.filter((e) => onDay(e, date, tz)).slice(0, EVENTS_MAX).map(calEvent)
  const next = tomorrow <= last ? list.filter((e) => onDay(e, tomorrow, tz)) : []
  out.tomorrow = { count: next.length }
  if (next.length) out.tomorrow.first = calEvent(next[0])
  return out
}

/** `upcoming()`: events not over yet that start within `days` from now, soonest first, at most `count`. */
function upcoming({ events, opts, now, tz, cfg }) {
  const until = now + opts.days * T.DAY_MS
  const today = T.dayKey(now, tz)
  return events
    .filter((e) => listed(e, cfg) && e.start < until && (e.allDay ? e.endDate > today : e.end > now))
    .sort(byStart)
    .slice(0, opts.count)
    .map(calEvent)
}

module.exports = { dayOptions, upcomingOptions, checkId, checkAnswer, meetUrlOf, responseOf, calEvent, listed, day, upcoming, COUNT, DAYS, EVENTS_MAX }
