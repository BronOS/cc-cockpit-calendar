'use strict'
// The panel's layout from the merged agenda (design "Panel"): the Now / Next card, the Invitations
// lane (a recurring invitation as one row), Today and Tomorrow (each timed row placed on its day's
// hour timeline: `from` / `to` in wall minutes, and the day's `clock`), and the Upcoming short list;
// plus the badge (invitations waiting) and what the title bar says. Pure: the agenda, the
// clock, the zone, the settings and the RSVPs on their way in, the view out. The host builds it after
// every poll and on its 15 s tick (the clock moves meetings from Next to Now to past).

const T = require('./time')
const { sha } = require('./util')

const CHIP_TYPES = new Set(['workingLocation', 'birthday'])
const NOT_MEETINGS = new Set(['workingLocation', 'birthday', 'focusTime', 'outOfOffice'])
const STARTED_GRACE_MS = 5 * 60000

/**
 * The agenda as the person should see it with RSVPs on their way: an event answered (or the series
 * it belongs to) takes the new answer. `pending` is target -> { answer, cal, id, series, state }
 * (rsvp.js): a series target matches every instance of it on that calendar.
 */
function withPending(events, pending) {
  const list = Object.values(pending || {})
  if (!list.length) return events
  return events.map((ev) => {
    const p = list.find((x) => x.cal === ev.calendarId && (x.series ? ev.recurring === x.id || ev.id === x.id : ev.id === x.id))
    if (!p) return ev
    return { ...ev, response: p.answer, invitation: false, rsvpPending: p.state === 'pending' }
  })
}

/** Whether a row of this event is shown at all (the show* settings). */
function shown(ev, cfg) {
  if (ev.response === 'declined' && !cfg.showDeclined) return false
  if (ev.type === 'birthday' && !cfg.showBirthdays) return false
  if (ev.type === 'workingLocation' && !cfg.showWorkingLocation) return false
  return true
}

/** A meeting for Now / Next, the title bar and reminders: timed, mine, not declined, a real meeting. */
function isMeeting(ev) {
  return ev.mine && !ev.allDay && ev.response !== 'declined' && !NOT_MEETINGS.has(ev.type)
}

/** Whether the person can join it now: a Meet link, from `early` ms before the start until the end. */
function joinable(ev, now, earlyMs) {
  return Boolean(ev.join) && now >= ev.start - earlyMs && now < Math.max(ev.end, ev.start + STARTED_GRACE_MS)
}

/**
 * A row as the panel and the CLI get it: plain data with the time already in words (the page knows
 * no zone). `conflicts` is model.findConflicts' map.
 */
function rowOf(ev, ctx) {
  const { tz, conflicts, lookups, now, earlyMs } = ctx
  const overlaps = (conflicts.get(ev.key) || []).map((c) => ({ title: c.title, time: T.range(c.start, c.end, tz) }))
  const dayKey = ev.allDay ? ev.startDate : T.dayKey(ev.start, tz)
  return {
    key: ev.key,
    id: ev.id,
    calendarId: ev.calendarId,
    primaryCal: ev.primary,
    calendar: ev.calendarName,
    color: ev.color,
    title: ev.title,
    allDay: ev.allDay,
    start: ev.start,
    end: ev.end,
    day: dayKey,
    time: ev.allDay ? allDayText(ev) : T.range(ev.start, ev.end, tz),
    type: ev.type,
    busy: ev.busy,
    response: ev.response,
    mine: ev.mine,
    join: Boolean(ev.join),
    joinable: Boolean(ev.join) && joinable(ev, now, earlyMs),
    link: Boolean(ev.link),
    location: ev.location,
    organizer: ev.organizer.name || ev.organizer.email,
    recurring: Boolean(ev.recurring),
    invitation: ev.invitation,
    pending: Boolean(ev.rsvpPending),
    running: !ev.allDay && ev.start <= now && now < ev.end,
    // Over: ended, or (no end given) started.
    past: !ev.allDay && (ev.end > ev.start ? ev.end <= now : ev.start < now),
    conflicts: overlaps,
    jira: (ev.jira || []).map((k) => (lookups ? lookups(k) : k)),
  }
}

/** "all day", or "day 2 of 5" for a span (relative to `day`, else to its own start). */
function allDayText(ev, day) {
  const n = T.daysBetween(ev.startDate, ev.endDate)
  if (n <= 1) return 'all day'
  const at = day ? T.daysBetween(ev.startDate, day) + 1 : 1
  return day ? `day ${at} of ${n}` : `all day, ${n} days`
}

/** One day: its all-day chips and its timed rows. */
function dayOf(events, key, ctx) {
  const start = T.startOfDay(key, ctx.tz)
  const end = T.startOfDay(T.addDays(key, 1), ctx.tz)
  const chips = []
  const rows = []
  for (const ev of events) {
    if (ev.allDay) {
      if (ev.startDate <= key && key < ev.endDate) chips.push({ ...rowOf(ev, ctx), time: allDayText(ev, key), chip: true })
      continue
    }
    const startsToday = ev.start >= start && ev.start < end
    const continues = ev.start < start && ev.end > start
    if (!startsToday && !continues) continue
    if (CHIP_TYPES.has(ev.type)) {
      chips.push({ ...rowOf(ev, ctx), chip: true })
      continue
    }
    rows.push({ ...rowOf(ev, ctx), ...placeOf(ev, start, end, ctx.tz), ...(continues ? { continued: true } : {}) })
  }
  return { day: key, chips, rows, clock: T.clockAnchors(key, ctx.tz) }
}

/**
 * Where a timed row sits on its day's hour timeline: `from` / `to` in wall minutes of the display
 * zone (the page knows no zone). One that began the day before starts at 0; one that runs past
 * midnight ends at 1440 (24:00), as the old cockpit's timeline; no end given: as long as nothing.
 */
function placeOf(ev, dayStart, dayEnd, tz) {
  const from = ev.start <= dayStart ? 0 : T.minuteOfDay(ev.start, tz)
  const to = !(ev.end > ev.start) ? from : ev.end >= dayEnd ? 1440 : T.minuteOfDay(ev.end, tz)
  // A DST fall-back hour can read an end before its start on the wall: never a negative block.
  return { from, to: Math.max(from, to) }
}

/**
 * The Invitations lane: invitations waiting for the person's answer that have not ended, the
 * occurrences of one recurring invitation as one row ("repeats · next Tue 10:00 · 4 in reach").
 */
function invitationsOf(events, ctx) {
  const out = []
  const series = new Map()
  for (const ev of events) {
    if (!ev.invitation || ev.response !== 'needsAction' || ev.end <= ctx.now) continue
    if (ev.recurring) {
      const k = `${ev.calendarId}\n${ev.recurring}`
      if (!series.has(k)) {
        const row = { ...rowOf(ev, ctx), key: `series:${sha(k, 16)}`, series: { id: ev.recurring, next: ev.key, count: 0 } }
        series.set(k, row)
        out.push(row)
      }
      series.get(k).series.count++
      continue
    }
    out.push(rowOf(ev, ctx))
  }
  for (const r of out) {
    const when = r.allDay ? `${T.shortDay(r.day)} · ${r.time}` : `${T.shortDay(r.day)} ${r.time}`
    r.when = r.series ? `repeats · next ${when}${r.series.count > 1 ? ` · ${r.series.count} in reach` : ''}` : when
  }
  return out
}

/**
 * The view.
 * @param {object} o
 * @param {object[]} o.events the merged agenda (model.mergeEvents)
 * @param {Map} o.conflicts model.findConflicts of it
 * @param {number} o.now
 * @param {string} o.tz the display zone
 * @param {object} o.cfg settings.readSettings().cfg
 * @param {object} [o.pending] RSVPs on their way (rsvp.js)
 * @param {(key: string) => string} [o.chip] a Jira key's chip text
 */
function buildView(o) {
  const { cfg, tz, now } = o
  const events = withPending(o.events || [], o.pending).filter((ev) => shown(ev, cfg))
  const ctx = { tz, now, conflicts: o.conflicts || new Map(), lookups: o.chip, earlyMs: cfg.joinEarlyMinutes * 60000 }
  const todayKey = T.dayKey(now, tz)
  const tomorrowKey = T.addDays(todayKey, 1)
  const today = dayOf(events, todayKey, ctx)
  const tomorrow = dayOf(events, tomorrowKey, ctx)
  // How many of today's meetings are over; a running one is not.
  today.past = today.rows.filter((r) => r.past && !r.running).length

  // Now / Next: meetings only (mine, not declined, not focus time, OOO, working location, birthday).
  const meetings = events.filter(isMeeting)
  const running = meetings.filter((ev) => ev.start <= now && now < ev.end).map((ev) => rowOf(ev, ctx))
  const nextEv = meetings.find((ev) => ev.start > now)
  const next = nextEv ? { ...rowOf(nextEv, ctx), dayLabel: nextEv && T.dayKey(nextEv.start, tz) === todayKey ? 'today' : T.dayKey(nextEv.start, tz) === tomorrowKey ? 'tomorrow' : T.shortDay(T.dayKey(nextEv.start, tz)) } : null
  const ooo = events.find((ev) => ev.mine && ev.type === 'outOfOffice' && ev.start <= now && now < ev.end && ev.response !== 'declined')
  const invitations = invitationsOf(events, ctx)

  // Upcoming: the next events after tomorrow within upcomingDays, compact (no chips of working
  // location or birthdays: those are day decorations, not things to attend).
  const fromMs = T.startOfDay(T.addDays(todayKey, 2), tz)
  const toKey = T.addDays(todayKey, cfg.upcomingDays + 1)
  const toMs = T.startOfDay(toKey, tz)
  const later = events.filter((ev) => !CHIP_TYPES.has(ev.type) && (ev.allDay ? ev.startDate >= T.addDays(todayKey, 2) && ev.startDate < toKey : ev.start >= fromMs && ev.start < toMs))
  const upcoming = {
    rows: later.slice(0, cfg.upcomingCount).map((ev) => {
      const r = rowOf(ev, ctx)
      return { ...r, line: `${T.shortDay(r.day)} · ${ev.allDay ? r.time : T.hm(ev.start, tz)} · ${r.title}` }
    }),
    more: Math.max(0, later.length - cfg.upcomingCount),
    days: cfg.upcomingDays,
  }

  // The title bar's next meeting (design "Panel"): the running one, else the next one today.
  const headNow = running[0] || null
  const headNext = nextEv && T.dayKey(nextEv.start, tz) === todayKey ? next : null
  const joinRow = [...running, ...(next ? [next] : [])].find((r) => r.joinable) || null
  const conflictCount = new Set([...ctx.conflicts.keys()].filter((k) => events.some((e) => e.key === k && e.end > now))).size
  return {
    tz,
    today,
    tomorrow,
    upcoming,
    now: running,
    next,
    ooo: ooo ? { title: ooo.title, until: ooo.end, untilText: T.dayKey(ooo.end, tz) === todayKey ? T.hm(ooo.end, tz) : `${T.shortDay(T.dayKey(ooo.end - 1, tz))} ${T.hm(ooo.end, tz)}` } : null,
    invitations,
    badge: invitations.length,
    head: { now: headNow, next: headNext, join: joinRow, tomorrowFirst: !headNow && !headNext && next ? next : null },
    counts: { today: today.rows.length + today.chips.length, tomorrow: tomorrow.rows.length + tomorrow.chips.length, upcoming: later.length, invitations: invitations.length, conflicts: conflictCount },
  }
}

module.exports = { buildView, withPending, shown, isMeeting, joinable, rowOf, dayOf, placeOf, invitationsOf, allDayText, STARTED_GRACE_MS }
