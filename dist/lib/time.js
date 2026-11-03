'use strict'
// Days and times in a time zone (design "Fetching", Time zones). No dependency: Node's Intl has the
// whole zone database. The display zone is an IANA name (the primary calendar's `timeZone`, or this
// computer's, setting `timeZone`); every day boundary and every time a person reads is computed in
// it, so a meeting at 09:00 Berlin time is "09:00" and on the right day whatever zone the process
// runs in (the suites run with TZ set to another zone to prove it).
//
// A day is a key `YYYY-MM-DD`. An all-day event's dates are such keys already (floating dates:
// compared as dates, never turned into instants, so an all-day event never slides into the day
// before for a person west of UTC). A day's start is the instant whose wall time in the zone is
// 00:00 on that date, found from the zone's offset at that instant (two rounds settle a DST change
// on that day; a zone that skips midnight itself starts the day at the first instant that exists).

const DAY_MS = 86400000
const formatters = new Map()

/** The zone's formatter (cached: building one costs far more than using it). */
function fmt(tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    formatters.set(tz, f)
  }
  return f
}

/** `tz` when it is a zone Intl knows, else null. */
function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null
  try {
    fmt(tz)
    return tz
  } catch {
    return null
  }
}

/** This computer's zone (the process's), `UTC` when Intl does not say. */
function computerZone() {
  try {
    return validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The wall clock of an instant in a zone: `{ y, m, d, hh, mm, ss, wd }` (m 1-12, wd 'Mon'). */
function parts(ms, tz) {
  const o = {}
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), hh: Number(o.hour) % 24, mm: Number(o.minute), ss: Number(o.second), wd: o.weekday }
}

/** The zone's offset from UTC at an instant, in ms (Berlin in winter: +3600000). */
function offsetMs(ms, tz) {
  const p = parts(ms, tz)
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss)
  return wall - Math.floor(ms / 1000) * 1000
}

const pad = (n) => String(n).padStart(2, '0')

/** The day of an instant in a zone, `YYYY-MM-DD`. */
function dayKey(ms, tz) {
  const p = parts(ms, tz)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` when it is a real date, else null. */
function validDay(key) {
  const m = KEY_RE.exec(String(key || ''))
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(t).toISOString().slice(0, 10) === key ? key : null
}

/** A day key `n` days after `key` (n may be negative). */
function addDays(key, n) {
  const m = KEY_RE.exec(key)
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)
  return new Date(t).toISOString().slice(0, 10)
}

/** Whole days from day `a` to day `b` (b - a). */
function daysBetween(a, b) {
  const ta = Date.UTC(...KEY_RE.exec(a).slice(1, 4).map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))))
  const tb = Date.UTC(...KEY_RE.exec(b).slice(1, 4).map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))))
  return Math.round((tb - ta) / DAY_MS)
}

/** The instant a day starts in a zone (00:00 wall time; see the top of this file). */
function startOfDay(key, tz) {
  const m = KEY_RE.exec(key)
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const first = wall - offsetMs(wall, tz)
  const second = wall - offsetMs(first, tz)
  // The earliest candidate that is on that day (both are when the offset did not change).
  const ok = [first, second].filter((t) => dayKey(t, tz) === key).sort((a, b) => a - b)
  if (ok.length) {
    // A zone whose day starts in a gap (00:00 does not exist): step back to the first instant of the day.
    let t = ok[0]
    while (dayKey(t - 60000, tz) === key) t -= 60000
    return t
  }
  return second
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The weekday of a day key: 'Mon'. */
function weekday(key) {
  const m = KEY_RE.exec(key)
  return WD[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]
}

/** `Thu 6`: the Upcoming list's day. */
function shortDay(key) {
  return `${weekday(key)} ${Number(key.slice(8, 10))}`
}

/** `Thu 6 Nov` (and the year when it is not `thisYear`). */
function longDay(key, thisYear) {
  const y = key.slice(0, 4)
  return `${weekday(key)} ${Number(key.slice(8, 10))} ${MONTHS[Number(key.slice(5, 7)) - 1]}${thisYear && y !== String(thisYear) ? ` ${y}` : ''}`
}

/** `10:00`: an instant's wall time in a zone, 24 h. */
function hm(ms, tz) {
  const p = parts(ms, tz)
  return `${pad(p.hh)}:${pad(p.mm)}`
}

/** An instant's wall time in a zone as minutes from midnight (10:30 -> 630): the panel's timeline. */
function minuteOfDay(ms, tz) {
  const p = parts(ms, tz)
  return p.hh * 60 + p.mm
}

/**
 * The clock of a day for the panel, which knows no zone: `[{ at, min }]`, an instant and its wall
 * minute, from which the page counts on (min + (now - at) / 60000). One anchor at the day's start,
 * and one more at a DST change inside the day (found to the minute), so the now line stays on the
 * wall clock on the two days a year an hour is skipped or repeated.
 */
function clockAnchors(key, tz) {
  const start = startOfDay(key, tz)
  const end = startOfDay(addDays(key, 1), tz)
  const out = [{ at: start, min: minuteOfDay(start, tz) }]
  const late = offsetMs(end - 1, tz)
  if (offsetMs(start, tz) === late) return out
  // The first minute with the late offset: the offset changes once a day at most.
  // Minute i of the day is start + i min; minute 0 has the early offset, the last one the late.
  let lo = 0
  let hi = Math.floor((end - 1 - start) / 60000)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (offsetMs(start + mid * 60000, tz) === late) hi = mid
    else lo = mid
  }
  const at = start + hi * 60000
  out.push({ at, min: minuteOfDay(at, tz) })
  return out
}

/** `10:00–10:30`; an end on a later day reads `10:00–Thu 6 09:00`. */
function range(start, end, tz) {
  if (!end || end <= start) return hm(start, tz)
  const sameDay = dayKey(start, tz) === dayKey(end - 1, tz)
  return `${hm(start, tz)}–${sameDay ? hm(end, tz) : `${shortDay(dayKey(end, tz))} ${hm(end, tz)}`}`
}

/** "45 s", "12 min", "2 h 5 min", "3 d": a countdown or an age. */
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.ceil(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
  return `${Math.round(h / 24)} d`
}

/** An RFC 3339 instant (Google reads `Z` as the offset it is). */
function rfc3339(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** An RFC 3339 time from Google (`2026-11-03T10:00:00+01:00`) as ms, or null. */
function parseTime(s) {
  if (typeof s !== 'string' || s.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

module.exports = { DAY_MS, validZone, computerZone, parts, offsetMs, dayKey, validDay, addDays, daysBetween, startOfDay, weekday, shortDay, longDay, hm, minuteOfDay, clockAnchors, range, span, rfc3339, parseTime }
