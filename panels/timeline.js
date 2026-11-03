'use strict'
// The day strip and the Today hour timeline of the Google Calendar panel, ported from the old
// cockpit (its views/today.js and rank.js dayStrip()), kept free of the DOM so node:test can check
// them (test/timeline.test.js requires this file; the page loads it as a classic script after
// rowlogic.js and before main.js, where these functions become globals).
//
// The page knows no time zone: the host places each timed row of a day in wall minutes of the
// display zone (`from` / `to`, 0..1440; layout.placeOf) and sends the day's `clock` (instants with
// their wall minute, layout.dayOf), so the now line is on the same clock as the blocks. Countdowns
// ("now · 12 min left", "in 40 min") use the rows' absolute `start` / `end`, never the minutes.

// rowlogic.js's countdown words: required under node, its globals in the page (loaded before this).
const tlWords = typeof module !== 'undefined' && module.exports ? require('./rowlogic') : { spanText, countdownText }

const TL_PX = 46 // pixels per hour of the timeline (the old cockpit's .hr)
// A block is drawn at least 20 px tall, about this many minutes: lanes() must count a short event
// as this long, or the next one would be drawn over its drawn end.
const TL_MIN_MIN = 30
const TL_MIN_PX = 20
const TL_STEP = 30 // minutes per strip cell
const TL_LO = 8 * 60 // the span is at least 08:00..19:00, wider when an event is outside
const TL_HI = 19 * 60
const TL_DAY = 24 * 60
const TL_NOT_MEETINGS = ['focusTime', 'outOfOffice', 'workingLocation', 'birthday']

/** A day's timed rows that the host placed (chips and all-day rows have no minutes). */
function timedOf(day) {
  return ((day && day.rows) || []).filter((r) => !r.allDay && Number.isFinite(r.from) && Number.isFinite(r.to))
}

/**
 * The span of the strip and the timeline in minutes: from 08:00 or the first event's start (floored
 * to the hour) to 19:00 or the last end (ceiled), never past 24:00 (an event across midnight ends
 * the day there).
 */
function dayRange(timed) {
  const lo = Math.floor(Math.min(TL_LO, ...timed.map((r) => r.from)) / 60) * 60
  const hi = Math.min(TL_DAY, Math.ceil(Math.max(TL_HI, ...timed.map((r) => r.to)) / 60) * 60)
  return { lo: Math.max(0, lo), hi }
}

/**
 * Overlapping events side by side: Map key -> [lane, lanes of its run]. Each run of overlapping
 * events gets as many lanes as it needs; an event takes the first lane free at its start.
 */
function lanes(items) {
  const out = new Map()
  let run = []
  let ends = []
  let runEnd = 0
  const flush = () => {
    for (const [e, lane] of run) out.set(e.key, [lane, ends.length])
    run = []
    ends = []
  }
  for (const e of [...items].sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (run.length && e.from >= runEnd) flush()
    let lane = ends.findIndex((end) => end <= e.from)
    if (lane < 0) lane = ends.length
    ends[lane] = e.to
    runEnd = run.length ? Math.max(runEnd, e.to) : e.to
    run.push([e, lane])
  }
  flush()
  return out
}

/**
 * The blocks of the timeline, in time order: `{ row, top, height, lane, lanes }` in pixels from the
 * top of the hour `lo`. A short event is at least TL_MIN_PX tall, and counts as TL_MIN_MIN long for
 * the lanes so that blocks never overlap where they are drawn.
 */
function placeBlocks(timed, lo) {
  const place = lanes(timed.map((r) => ({ key: r.key, from: r.from, to: Math.max(r.to, r.from + TL_MIN_MIN) })))
  return [...timed]
    .sort((a, b) => a.from - b.from || b.to - a.to)
    .map((row) => {
      const [lane, n] = place.get(row.key) || [0, 1]
      return {
        row,
        top: ((row.from - lo) / 60) * TL_PX + 1,
        height: Math.max(TL_MIN_PX, ((row.to - row.from) / 60) * TL_PX - 3),
        lane,
        lanes: n,
      }
    })
}

/** Whether a row takes time in the strip: not declined, not free (transparent), not zero long. */
function takesTime(r) {
  return r.response !== 'declined' && r.busy !== false && r.to > r.from
}

/**
 * The strip's cells of `step` minutes from `lo` to `hi`: 'busy', 'unanswered' (every event there
 * waits for the person's answer), or 'free' (nothing, or only declined and free events).
 */
function stripCells(timed, lo, hi, step = TL_STEP) {
  const busy = timed.filter(takesTime)
  return Array.from({ length: Math.max(0, Math.ceil((hi - lo) / step)) }, (_, i) => {
    const a = lo + i * step
    const hit = busy.filter((r) => r.from < a + step && r.to > a)
    if (!hit.length) return 'free'
    return hit.every((r) => r.response === 'needsAction') ? 'unanswered' : 'busy'
  })
}

/** `08:00` for minute 480; 1440 is `24:00` (the end of the day, never the next day's 00:00). */
function hourText(min) {
  const m = Math.round(min)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/**
 * The strip's hour scale: its two ends and every 4 hours between them that is at least 2 hours from
 * both (08:00 .. 19:00 gives 08:00 12:00 16:00 19:00), as `{ min, pct, text }`.
 */
function stripScale(lo, hi) {
  if (!(hi > lo)) return []
  const at = (min) => ({ min, pct: ((min - lo) / (hi - lo)) * 100, text: hourText(min) })
  const out = [at(lo)]
  for (let m = Math.ceil(lo / 240) * 240; m < hi; m += 240) if (m - lo >= 120 && hi - m >= 120) out.push(at(m))
  out.push(at(hi))
  return out
}

/**
 * The wall minute of `now` on the day of `clock` (the host's anchors), fractional; null without a
 * clock or before the day began. Past the day's end it keeps counting (> 1440): the line is gone
 * until the host sends the new day.
 */
function nowMinute(clock, now) {
  let best = null
  for (const a of Array.isArray(clock) ? clock : []) {
    if (Number.isFinite(a && a.at) && Number.isFinite(a.min) && a.at <= now && (!best || a.at > best.at)) best = a
  }
  return best ? best.min + (now - best.at) / 60000 : null
}

/** The now line's top in pixels on a timeline from `lo` to `hi`; null when now is outside it. */
function nowTop(m, lo, hi) {
  return m !== null && m >= lo && m < hi ? ((m - lo) / 60) * TL_PX : null
}

/** The strip's now marker as a percentage of its width; null when now is outside it. */
function nowPct(m, lo, hi) {
  return m !== null && m >= lo && m < hi && hi > lo ? ((m - lo) / (hi - lo)) * 100 : null
}

/** Whether a row is over at `now`: ended, or (no end given) started. */
function isOver(r, now) {
  return r.end > r.start ? r.end <= now : r.start < now
}

/**
 * What a block shows at `now`: its classes (past faded, cur green, unans amber, decl struck through,
 * focus muted), the small note after its title ("now · 12 min left · ⚠ overlaps"), whether that note
 * is hot (not answered or a clash, still to come), and whether it has Join (a Meet link, not over,
 * not declined).
 */
function blockState(r, now) {
  const past = isOver(r, now)
  const cur = !past && r.start <= now && now < r.end
  const decl = r.response === 'declined'
  const unans = r.response === 'needsAction' && !past && !decl
  const overlap = Array.isArray(r.conflicts) && r.conflicts.length > 0
  const parts = [
    past ? 'done' : cur ? `now · ${tlWords.spanText(r.end - now)} left` : tlWords.countdownText(r.start, now),
    decl ? 'declined' : unans ? '? not answered' : r.response === 'tentative' ? 'maybe' : '',
    overlap ? '⚠ overlaps' : '',
  ].filter(Boolean)
  const cls = ['ev']
  if (past) cls.push('past')
  if (cur) cls.push('cur')
  if (unans) cls.push('unans')
  if (decl) cls.push('decl')
  if (r.type === 'focusTime') cls.push('focus')
  return { past, cur, cls, note: parts.join(' · '), hot: (unans || overlap) && !past && !decl, join: Boolean(r.join) && !past && !decl }
}

/**
 * The strip's Next line: the next meeting of today to start (not declined, not focus time or out of
 * office) and how many are left today counting it.
 */
function stripNext(timed, now) {
  const left = timed.filter((r) => r.start > now && r.response !== 'declined' && r.mine !== false && !TL_NOT_MEETINGS.includes(r.type)).sort((a, b) => a.start - b.start)
  return { row: left[0] || null, left: left.length }
}

/** "in 40 min · 4 left today" after the Next title (rowlogic's countdown). */
function stripNextText(next, now) {
  return next.row ? `${tlWords.countdownText(next.row.start, now)} · ${next.left} left today` : ''
}

/**
 * The Today header's look ahead, as the old cockpit's: "Tomorrow: 4 events, first 09:30 Standup",
 * "Tomorrow: 1 event, Holiday (all day)", or "Tomorrow: nothing". Declined events are not first.
 */
function tomorrowText(day) {
  const rows = ((day && day.rows) || []).filter((r) => !r.continued)
  const chips = (day && day.chips) || []
  const count = rows.length + chips.length
  if (!count) return 'Tomorrow: nothing'
  const first = rows.find((r) => r.response !== 'declined')
  const head = `Tomorrow: ${count} event${count > 1 ? 's' : ''}`
  if (first) return `${head}, first ${String(first.time || '').slice(0, 5)} ${first.title}`
  return chips.length ? `${head}, ${chips[0].title} (all day)` : head
}

/** How a run of `n` lanes is drawn: from 3 the Join button is just ▶, from 4 the text shrinks. */
function laneLook(n) {
  return { narrow: n >= 3, dense: n > 3 }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TL_PX, TL_MIN_MIN, TL_MIN_PX, TL_STEP, timedOf, dayRange, lanes, placeBlocks, takesTime, stripCells, hourText, stripScale, nowMinute, nowTop, nowPct, isOver, blockState, stripNext, stripNextText, tomorrowText, laneLook }
}
