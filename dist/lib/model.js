'use strict'
// What an event is to the panel (design "Model"): a Google event (events.list with singleEvents, so
// every occurrence of a recurring event is its own item) made into a small, checked record; the
// calendars of the list made into what the panel shows of them; the merge of several calendars (one
// event on two of them shows once); and the conflicts. Pure: no I/O, no clock but the one passed.
//
// Everything from Google is untrusted text here: a title, a location and a description come from
// whoever sent the invitation. They are cut and kept as text; nothing of them becomes markup or a
// URL the host opens, except the join link (Google Meet only, checked) and the event's own Calendar
// link (htmlLink, checked to be Google Calendar's).

const T = require('./time')
const { cut, oneLine, eventId, calendarId, eventKey, emailAddress } = require('./util')

const MAX_TITLE = 300
const MAX_LOCATION = 300
const MAX_URL = 2048 // ctx.openExternal's limit
const RESPONSES = new Set(['accepted', 'tentative', 'declined', 'needsAction'])
const TYPES = new Set(['default', 'birthday', 'focusTime', 'fromGmail', 'outOfOffice', 'workingLocation'])
const COLOR = /^#[0-9a-fA-F]{6}$/

/** A calendar list entry as the plugin keeps it, or null when its id does not check out. */
function compactCalendar(c) {
  if (!c || !calendarId(c.id)) return null
  return {
    id: c.id,
    name: cut(oneLine(c.summaryOverride || c.summary || c.id), 120),
    color: COLOR.test(c.backgroundColor || '') ? c.backgroundColor : '#9e9e9e',
    primary: c.primary === true,
    tz: T.validZone(c.timeZone) || null,
    access: typeof c.accessRole === 'string' ? c.accessRole.slice(0, 20) : '',
    hidden: c.hidden === true,
  }
}

/**
 * A URL a person may be sent to: https, no user:pass, at most 2048 characters, on one of `hosts`
 * (exact host names), normalised by URL. Null otherwise.
 */
function safeUrl(raw, hosts) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || !hosts.includes(u.hostname.toLowerCase())) return null
  return u.href.length <= MAX_URL ? u.href : null
}

const MEET_HOSTS = ['meet.google.com']
const CALENDAR_HOSTS = ['www.google.com', 'calendar.google.com']

/**
 * The join link (design "Model", decision 7: Google Meet only): `hangoutLink`, else the `video`
 * entry point of Meet conference data. A Zoom or Teams link (an add-on's conference data, or pasted
 * into the location or the description) is not picked up.
 */
function joinLink(raw) {
  const direct = safeUrl(raw.hangoutLink, MEET_HOSTS)
  if (direct) return direct
  const cd = raw.conferenceData
  if (!cd || !Array.isArray(cd.entryPoints)) return null
  for (const ep of cd.entryPoints) {
    if (ep && ep.entryPointType === 'video') {
      const u = safeUrl(ep.uri, MEET_HOSTS)
      if (u) return u
    }
  }
  return null
}

/** The dial-in of Meet conference data: `{ label, pin }` (the detail view only), or null. */
function phoneOf(raw) {
  const cd = raw.conferenceData
  if (!cd || !Array.isArray(cd.entryPoints)) return null
  const ep = cd.entryPoints.find((e) => e && e.entryPointType === 'phone' && (e.label || e.uri))
  if (!ep) return null
  return { label: cut(oneLine(ep.label || String(ep.uri || '').replace(/^tel:/, '')), 60), pin: cut(oneLine(ep.pin || ''), 30) }
}

/** The event's page in Google Calendar (checked to be Google's), or null. */
function calendarLink(raw) {
  return safeUrl(raw.htmlLink, CALENDAR_HOSTS)
}

/**
 * The person's own answer (design "Which calendars": only the person's own answer counts). On the
 * primary calendar the `self` entry is the person; on another calendar `self` is that calendar, so
 * the person is the entry with their address. `organizer` when they organize it; `none` when they
 * are not among the guests (an event of a team calendar, a reminder of their own).
 * Returns `{ response, email }` (`email`: their attendee entry's address, what RSVP writes).
 */
function myAnswer(raw, primary, me) {
  const org = raw.organizer || {}
  const atts = Array.isArray(raw.attendees) ? raw.attendees : []
  const mine = (a) => a && (primary ? a.self === true : Boolean(me) && emailAddress(a.email) === me)
  const entry = atts.find(mine) || null
  const orgIsMe = primary ? org.self === true : Boolean(me) && emailAddress(org.email) === me
  if (orgIsMe || (entry && entry.organizer === true)) return { response: 'organizer', email: entry ? String(entry.email || '') : '' }
  if (entry) return { response: RESPONSES.has(entry.responseStatus) ? entry.responseStatus : 'needsAction', email: String(entry.email || '') }
  // An event on the primary calendar with no guest list at all is the person's own.
  if (primary && !atts.length) return { response: 'organizer', email: '' }
  return { response: 'none', email: '' }
}

/** A working location in words: "Home", "Office: Building 2", "Elsewhere: Lisbon". */
function workingLabel(raw) {
  const w = raw.workingLocationProperties || {}
  if (w.type === 'homeOffice' || w.homeOffice) return 'Home'
  if (w.type === 'officeLocation' || w.officeLocation) {
    const l = w.officeLocation && (w.officeLocation.label || w.officeLocation.buildingId)
    return l ? `Office: ${cut(oneLine(l), 60)}` : 'Office'
  }
  const c = w.customLocation && w.customLocation.label
  return c ? cut(oneLine(c), 60) : 'Elsewhere'
}

/** Guests by answer (rooms apart): what the detail view's facts and the CLI say. */
function guestCounts(raw) {
  const out = { total: 0, accepted: 0, tentative: 0, declined: 0, needsAction: 0, rooms: 0 }
  for (const a of Array.isArray(raw.attendees) ? raw.attendees : []) {
    if (!a) continue
    if (a.resource) {
      out.rooms++
      continue
    }
    out.total++
    const r = RESPONSES.has(a.responseStatus) ? a.responseStatus : 'needsAction'
    out[r]++
  }
  return out
}

/**
 * A Google event as the plugin keeps it, or null: cancelled (as the old connector), or malformed
 * (no id that checks out, no start). Times: `start` / `end` are instants (ms) for a timed event;
 * an all-day event has `startDate` / `endDate` (`YYYY-MM-DD`, end exclusive) and its instants are
 * the starts of those days in the display zone (for sorting only).
 *
 * @param {object} raw the event from events.list or events.get
 * @param {{ cal: { id, name, color, primary }, me: string, tz: string, jiraKeys?: (raw) => string[] }} o
 */
function compactEvent(raw, o) {
  if (!raw || typeof raw !== 'object' || raw.status === 'cancelled') return null
  const id = eventId(raw.id)
  if (!id) return null
  const s = raw.start || {}
  const e = raw.end || {}
  let allDay = false
  let start
  let end
  let startDate = null
  let endDate = null
  if (typeof s.date === 'string') {
    startDate = T.validDay(s.date)
    if (!startDate) return null
    endDate = T.validDay(e.date) && e.date > startDate ? e.date : T.addDays(startDate, 1)
    allDay = true
    start = T.startOfDay(startDate, o.tz)
    end = T.startOfDay(endDate, o.tz)
  } else {
    start = T.parseTime(s.dateTime)
    if (start === null) return null
    end = T.parseTime(e.dateTime)
    if (end === null || end < start || raw.endTimeUnspecified === true) end = start
  }
  const type = TYPES.has(raw.eventType) ? raw.eventType : 'default'
  const { response, email } = myAnswer(raw, o.cal.primary, o.me)
  const org = raw.organizer || {}
  const orig = raw.originalStartTime || {}
  const recurring = typeof raw.recurringEventId === 'string' && eventId(raw.recurringEventId) ? raw.recurringEventId : null
  const conference = raw.conferenceData && raw.conferenceData.conferenceSolution && typeof raw.conferenceData.conferenceSolution.name === 'string' ? cut(oneLine(raw.conferenceData.conferenceSolution.name), 60) : ''
  const ev = {
    key: eventKey(o.cal.id, id),
    id,
    calendarId: o.cal.id,
    primary: o.cal.primary,
    calendarName: o.cal.name,
    color: o.cal.color,
    iCalUID: typeof raw.iCalUID === 'string' ? raw.iCalUID.slice(0, 1100) : id,
    recurring,
    originalStart: typeof orig.dateTime === 'string' ? orig.dateTime : typeof orig.date === 'string' ? orig.date : null,
    title: cut(oneLine(raw.summary), MAX_TITLE) || (type === 'workingLocation' ? workingLabel(raw) : type === 'outOfOffice' ? 'Out of office' : '(busy)'),
    allDay,
    start,
    end,
    startDate,
    endDate,
    zone: T.validZone(s.timeZone) || null,
    type,
    busy: raw.transparency !== 'transparent',
    tentative: raw.status === 'tentative',
    response,
    selfEmail: email ? email.slice(0, 254) : '',
    organizer: { email: emailAddress(org.email) || '', name: cut(oneLine(org.displayName || ''), 120), self: response === 'organizer' },
    location: cut(oneLine(raw.location), MAX_LOCATION),
    join: joinLink(raw),
    conference: conference || (joinLink(raw) ? 'Google Meet' : ''),
    link: calendarLink(raw),
    guests: guestCounts(raw),
    working: type === 'workingLocation' ? workingLabel(raw) : '',
    jira: o.jiraKeys ? o.jiraKeys(raw) : [],
  }
  // "Mine" (design "Which calendars"): an event of the primary calendar, or one the person
  // organizes or is a guest of. Now / Next, the title bar, reminders and conflicts use these only.
  ev.mine = ev.primary || response !== 'none'
  // An invitation waiting for an answer: on the primary calendar (RSVP patches that copy), the person
  // a guest and not the organizer.
  ev.invitation = ev.primary && response === 'needsAction' && Boolean(ev.selfEmail)
  return ev
}

/** The key two copies of one event share across calendars: its iCalUID and the occurrence's start. */
function sameEventKey(ev) {
  return `${ev.iCalUID}|${ev.originalStart || ev.startDate || ev.start}`
}

/**
 * Several calendars' events as one list (design "Which calendars"): an event on two selected
 * calendars shows once, the primary's copy first, then one the person is a guest of. Sorted by start
 * (all-day ones of a day before its timed ones), then title.
 */
function mergeEvents(lists) {
  const best = new Map()
  const rank = (ev) => (ev.primary ? 2 : 0) + (ev.response !== 'none' ? 1 : 0)
  for (const list of lists) {
    for (const ev of list || []) {
      const k = sameEventKey(ev)
      const had = best.get(k)
      if (!had || rank(ev) > rank(had)) best.set(k, ev)
    }
  }
  return [...best.values()].sort(byStart)
}

function byStart(a, b) {
  return a.start - b.start || (b.allDay === a.allDay ? 0 : a.allDay ? -1 : 1) || a.end - b.end || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
}

/** Whether an event can be part of a conflict (design "Model", Conflicts). */
function conflicts_(ev) {
  return ev.mine && !ev.allDay && ev.end > ev.start && ev.busy && ev.response !== 'declined' && !['focusTime', 'workingLocation', 'birthday'].includes(ev.type)
}

/**
 * The conflicts of a merged list: key -> [{ key, title, start, end }] of the events it overlaps.
 * Two out-of-office spans do not conflict with each other (only with meetings).
 */
function findConflicts(events) {
  const c = events.filter(conflicts_).sort((a, b) => a.start - b.start)
  const out = new Map()
  const add = (a, b) => {
    if (!out.has(a.key)) out.set(a.key, [])
    out.get(a.key).push({ key: b.key, title: b.title, start: b.start, end: b.end })
  }
  for (let i = 0; i < c.length; i++) {
    for (let j = i + 1; j < c.length && c[j].start < c[i].end; j++) {
      const a = c[i]
      const b = c[j]
      if (a.type === 'outOfOffice' && b.type === 'outOfOffice') continue
      if (a.start < b.end && b.start < a.end) {
        add(a, b)
        add(b, a)
      }
    }
  }
  return out
}

module.exports = { compactCalendar, compactEvent, joinLink, phoneOf, calendarLink, myAnswer, workingLabel, guestCounts, mergeEvents, sameEventKey, findConflicts, safeUrl, byStart, MEET_HOSTS, CALENDAR_HOSTS }
