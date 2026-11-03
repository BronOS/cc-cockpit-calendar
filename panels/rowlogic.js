'use strict'
// The row decisions of the Google Calendar panel, kept free of the DOM so node:test can check them
// (test/panel.test.js requires this file; the page loads it as a classic script before main.js, where
// these functions become globals). As bronos.chat's rowlogic.js.
//
// A row is one focusable element: a click on it or Enter / Space while it has the focus opens the
// event; the arrow keys move between rows. Its other actions are small buttons shown while the row is
// hovered or has the focus inside it (Tab reaches them; they are in the DOM all the time, only faded
// out). An invitation's Accept / Maybe / Decline are always shown (they are what the lane is for).

/**
 * What a key press on a row does: 'open', 'next', 'prev', 'first', 'last', or null (let it be).
 * Only presses on the row itself count: Enter on one of its buttons is that button's click.
 */
function rowKeyAction(key, onRow, mods) {
  if (!onRow) return null
  if (mods && (mods.alt || mods.ctrl || mods.meta)) return null
  switch (key) {
    case 'Enter':
    case ' ':
      return 'open'
    case 'ArrowDown':
      return 'next'
    case 'ArrowUp':
      return 'prev'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    default:
      return null
  }
}

/** Whether a click opens the event: anywhere on the row except its buttons, and not while selecting text. */
function rowClickOpens(inControl, selecting) {
  return !inControl && !selecting
}

/** The index the focus moves to for a move action over `count` rows from `at`; null to stay. */
function moveIndex(action, at, count) {
  if (!count) return null
  if (action === 'first') return 0
  if (action === 'last') return count - 1
  if (action === 'next') return at < count - 1 ? at + 1 : null
  if (action === 'prev') return at > 0 ? at - 1 : null
  return null
}

/**
 * The hover buttons of a row, in order: `{ action, label, title }` (`action` is the message type the
 * page posts with the row's key). Join only with a Meet link (`joinable`: inside the join window, the
 * primary style); ↗ only with the event's Google Calendar link.
 */
function rowButtons(r) {
  const out = []
  if (r.join) out.push({ action: 'join', label: 'Join', title: `Join ${r.title} (Google Meet)`, primary: Boolean(r.joinable) })
  if (r.link) out.push({ action: 'calendar', label: '↗', title: 'Open in Google Calendar' })
  out.push({ action: 'discuss', label: 'Discuss', title: 'Send this event to the Claude tab you are looking at' })
  out.push({ action: 'newSession', label: 'New', title: 'Open a new Claude tab about this event' })
  return out
}

/**
 * Accept / Maybe / Decline of an invitation row: `{ answer, label, title, disabled? }`. A recurring
 * invitation answers the series unless `one` (the row's "this one only" toggle). Without the RSVP
 * scope there are none (the lane says how to get it); while an answer is on its way they are
 * disabled.
 */
function rsvpButtons(r, { rsvpOn, one }) {
  if (!rsvpOn) return []
  const scope = r.series ? (one ? ' this occurrence only' : ' the whole series') : ''
  const all = [
    { answer: 'accepted', label: 'Accept', title: `Accept${scope}: the organizer is told` },
    { answer: 'tentative', label: 'Maybe', title: `Maybe${scope}: the organizer is told` },
    { answer: 'declined', label: 'Decline', title: `Decline${scope}: the organizer is told` },
  ]
  return all.map((b) => ({ ...b, ...(r.series && one ? { label: `${b.label} this one` } : {}), ...(r.pending ? { disabled: true } : {}) }))
}

const MARKS = { accepted: '✓', tentative: '?', needsAction: '·', declined: '✗' }
const MARK_TITLES = { accepted: 'You accepted', tentative: 'You said maybe', needsAction: 'You have not answered', declined: 'You declined' }

/** The response mark of a row ('' when the person organizes it or is not a guest). */
function responseMark(response) {
  return MARKS[response] || ''
}
function responseTitle(response) {
  return MARK_TITLES[response] || ''
}

/** "45 s", "12 min", "2 h 5 min", "3 d" (time.span's twin: the page has no require). */
function spanText(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.ceil(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
  return `${Math.round(h / 24)} d`
}

/** The Next line's countdown: "in 12 min", "now" within half a minute, "started 2 min ago". */
function countdownText(start, now) {
  const left = start - now
  if (left > 30000) return `in ${spanText(left)}`
  if (left >= -30000) return 'now'
  return `started ${spanText(-left)} ago`
}

/** How far a running meeting is, 0..1. */
function progress(start, end, now) {
  if (!(end > start)) return 1
  return Math.min(1, Math.max(0, (now - start) / (end - start)))
}

/**
 * How soon the page redraws its countdowns (design "Fetching", Between polls): every second while
 * one is under a minute away, else every 15 s.
 */
function redrawDelay(times, now) {
  return times.some((t) => Math.abs(t - now) < 60000) ? 1000 : 15000
}

if (typeof module !== 'undefined' && module.exports) module.exports = { rowKeyAction, rowClickOpens, moveIndex, rowButtons, rsvpButtons, responseMark, responseTitle, spanText, countdownText, progress, redrawDelay }
