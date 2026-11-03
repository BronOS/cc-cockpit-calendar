'use strict'
// Small helpers shared by the other modules: text cuts, a bounded parallel map, stable hashes, and
// the checks on the Calendar ids that go into a URL path. No I/O here, so every suite can use them
// as they are. (From bronos.chat's util.js; the id checks are Calendar's.)

const crypto = require('node:crypto')

/** `text` cut to at most `max` characters, with an ellipsis that says it was cut. */
function cut(text, max) {
  const s = String(text == null ? '' : text)
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** One line: line breaks and runs of white space become one space (rows, notices, a title). */
function oneLine(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/**
 * Run `fn` over `items` with at most `limit` running at once (a poll reads its calendars two at a
 * time). Resolves to `[{ ok: true, value } | { ok: false, error }]` in the items' order: one failing
 * calendar never fails the poll.
 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        out[i] = { ok: true, value: await fn(items[i], i) }
      } catch (error) {
        out[i] = { ok: false, error }
      }
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker())
  await Promise.all(workers)
  return out
}

/** A short stable hash of a JSON value. */
function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

/** The first `n` hex digits of sha256(text): a key part that names a value without holding it. */
function sha(text, n = 12) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, n)
}

/** "3 min ago", "2 h ago": `ccc calendar status`. */
function ago(ms, now = Date.now()) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

// Calendar ids (design "Auth": ids checked by pattern, then encodeURIComponent). Google's are an
// address (`ann@example.com`), `<random>@group.calendar.google.com`, or a public one such as
// `en.usa#holiday@group.v.calendar.google.com`; `primary` is Google's alias. Nothing that could add a
// path segment, a query or a quote passes, and `..` never (encodeURIComponent leaves dots alone).
const CALENDAR_RE = /^[A-Za-z0-9._@#+-]{1,254}$/
// Event ids: base32hex letters and digits for Google's own, letters, digits, `_` and `-` for imported
// ones; an instance of a recurring event adds `_YYYYMMDD` or `_YYYYMMDDTHHMMSSZ` (the old connector's
// rule: Google's ids run to 1024 characters).
const EVENT_RE = /^[A-Za-z0-9_-]{1,1100}$/

/** A calendar id that may go into a path, or null. */
function calendarId(v) {
  return typeof v === 'string' && CALENDAR_RE.test(v) && !v.includes('..') ? v : null
}

/** An event id that may go into a path, or null. */
function eventId(v) {
  return typeof v === 'string' && EVENT_RE.test(v) ? v : null
}

/** The row key the panel posts for an event (`sha256(calendarId \n eventId)` 16): never an id or a URL. */
function eventKey(cal, id) {
  return sha(`${cal}\n${id}`, 16)
}

/** Whether a value looks like a row key. */
function isKey(v) {
  return typeof v === 'string' && /^[a-z]{0,8}:?[a-f0-9]{16}$/.test(v)
}

/** An email address as the plugin keeps it (lower case), or null when it does not look like one. */
function emailAddress(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase()
  if (s.length > 254 || !/^[^\s@"'(){}<>,;:\\/[\]]+@[^\s@"'(){}<>,;:\\/[\]]+\.[^\s@"'(){}<>,;:\\/[\]]+$/.test(s)) return null
  return s
}

/** The values in order, each once, empty ones left out. */
function unique(xs) {
  return [...new Set(xs.filter((x) => x))]
}

module.exports = { cut, oneLine, mapLimit, hashOf, sha, ago, calendarId, eventId, eventKey, isKey, emailAddress, unique, CALENDAR_RE, EVENT_RE }
