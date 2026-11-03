'use strict'
// Jira issues an event names (design "Jira"): with the bronos.jira plugin enabled in the project, its
// `jira` service (v1) says where the site is, what an issue's status is now (the row chips), and
// gives the issue as a reviewer document (beside the event in the detail view, the reviewer's
// `companion`). Without it nothing here runs and the panel is exactly the same otherwise. From
// bronos.gmail's jira.js: the key finder, the lookup cache, the document check and the companion;
// the mail rules (hints, Jira's senders) are left out.

const { cut, oneLine } = require('./util')

const KEY = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9})(?![A-Za-z0-9_-])/g
const MAX_KEYS = 3 // per event (design)

const TTL_MS = 10 * 60000 // a lookup answer is used this long (unless the event changed since)
const ERROR_MS = 60000 // a failed lookup (Jira down, busy) is tried again after a minute
const MAX_CACHED = 300
const MAX_STARTED = 10 // lookups started per poll (bronos.jira allows 30 a minute)
const SITE_TTL_MS = 5 * 60000
const ASIDE_MAX = 90000 // below the reviewer's 100,000 characters of a companion's facts

/**
 * The issue keys an event names, in order, at most 3: bare keys (`PROJ-123`, not inside a word) in
 * the title, the location and the description, and `<site>/browse/KEY` links (a link's key is the
 * same key, so a description with only links counts too).
 */
function keysIn(texts, site) {
  const out = []
  const add = (k) => {
    if (k && !out.includes(k) && out.length < MAX_KEYS) out.push(k)
  }
  for (const t of texts) {
    const s = String(t || '')
    if (!s) continue
    for (const m of s.matchAll(KEY)) add(m[1])
    if (site) {
      const base = `${site}/browse/`
      let at = s.indexOf(base)
      while (at >= 0 && out.length < MAX_KEYS) {
        const m = /^([A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9})(?![A-Za-z0-9_])/.exec(s.slice(at + base.length, at + base.length + 64))
        if (m) add(m[1])
        at = s.indexOf(base, at + base.length)
      }
    }
  }
  return out
}

/** The service's site() answer as this plugin uses it: `{ site }`, or null (no Jira, not set up). */
function jiraContext(s) {
  if (!s || typeof s !== 'object' || !s.ready || typeof s.site !== 'string' || !/^https:\/\/[^/\s]+$/.test(s.site)) return null
  return { site: s.site }
}

/**
 * The lookups of issue status for the row chips: per key `{ at, value }` (the answer and when it came)
 * and `failedAt` after a failure. Asked again past the TTL, after the event changed, or a
 * minute after a failure; started at most MAX_STARTED a poll and waited for at most `budgetMs`. A
 * lookup that finishes after the wait calls `onLate` (once a batch). An answer past its TTL is still
 * used while the new one is on its way (a slow Jira must not make a chip flicker), but never one older than `newestAt` (the event's last change).
 *
 * @param {object} o
 * @param {(key: string, opts: object) => Promise<object>} o.issue the service's issue()
 * @param {() => number} [o.now]
 * @param {() => void} [o.onLate]
 */
function createLookups(o) {
  const now = o.now || Date.now
  const m = new Map()
  const pending = new Map()
  let lateQueued = false

  /** Whether a key needs no new lookup now. */
  function fresh(e, newestAt) {
    if (!e) return false
    if (e.failedAt && now() - e.failedAt < ERROR_MS) return true
    return Boolean(e.value) && now() - e.at < TTL_MS && e.at >= (newestAt || 0)
  }

  /** The answer for a key: the value, null (the lookup failed), undefined (none yet). */
  function peek(key, newestAt) {
    const e = m.get(key)
    if (!e) return undefined
    if (e.value && e.at >= (newestAt || 0)) return e.value
    return e.failedAt ? null : undefined
  }

  // A failure keeps an earlier answer only while it is still the newest news (peek's rule).
  function failed(key) {
    const e = m.get(key)
    m.delete(key)
    m.set(key, { ...(e && e.value ? { at: e.at, value: e.value } : { at: 0 }), failedAt: now() })
  }

  function start(key, newestAt) {
    if (pending.has(key)) return pending.get(key)
    // As fresh as the event: Jira's own poll answers when it is newer, else it reads.
    const maxAgeMs = Math.max(15000, Math.min(TTL_MS, now() - (newestAt || 0)))
    const p = Promise.resolve()
      .then(() => o.issue(key, { maxAgeMs }))
      .then(
        (v) => {
          if (v && typeof v === 'object' && typeof v.key === 'string') m.set(key, { at: now(), value: { key: v.key, done: v.done === true, mine: v.mine === true, status: cut(oneLine(v.status), 100) } })
          else failed(key)
        },
        () => failed(key),
      )
      .finally(() => {
        pending.delete(key)
        while (m.size > MAX_CACHED) m.delete(m.keys().next().value)
      })
    pending.set(key, p)
    return p
  }

  /**
   * Start the lookups `wants` needs ([{ key, newestAt }]) and wait for them at most `budgetMs`.
   * Resolves `{ started, late }` (how many were still running after the wait).
   */
  async function ensure(wants, budgetMs) {
    const todo = []
    const seen = new Set()
    for (const w of wants) {
      if (!w.key || seen.has(w.key)) continue
      seen.add(w.key)
      if (!fresh(m.get(w.key), w.newestAt)) todo.push(w)
    }
    const run = todo.slice(0, MAX_STARTED).map((w) => start(w.key, w.newestAt))
    if (!run.length) return { started: 0, late: 0 }
    let timer
    const all = Promise.all(run)
    const done = await Promise.race([all.then(() => true), new Promise((r) => (timer = setTimeout(() => r(false), budgetMs)))])
    clearTimeout(timer)
    if (done) return { started: run.length, late: 0 }
    const late = pending.size
    if (!lateQueued && o.onLate) {
      lateQueued = true
      all.then(() => {
        lateQueued = false
        o.onLate()
      })
    }
    return { started: run.length, late }
  }

  return { peek, ensure, clear: () => m.clear(), get size() {
    return m.size
  } }
}

/** The service's site(), asked at most every 5 minutes (and at once again after a failure). */
function createSiteCache(o) {
  const now = o.now || Date.now
  let got = null
  return {
    async get(timeoutMs) {
      if (got && now() - got.at < SITE_TTL_MS) return got.value
      let timer
      try {
        const s = await Promise.race([o.site(), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('the Jira plugin did not answer in time')), timeoutMs)))])
        got = { at: now(), value: jiraContext(s) }
        return got.value
      } catch {
        got = null
        return null
      } finally {
        clearTimeout(timer)
      }
    },
    clear() {
      got = null
    },
  }
}

const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const ASSET_ID = /^[A-Za-z0-9]{1,64}$/

/**
 * The service's document() answer, checked (it comes from another plugin): html a string within
 * `maxHtmlBytes`, assets pictures as data: URLs with plain ids, the title
 * one line of at most 200 chars (else `Jira issue KEY`), the details column (`aside`) only when it is
 * a string within ASIDE_MAX (else null). Returns `{ html, assets, title, aside }` or `{ error }`.
 */
function checkDocument(d, maxHtmlBytes, takenIds) {
  if (!d || typeof d !== 'object' || typeof d.html !== 'string') return { error: 'the Jira plugin sent no document' }
  if (Buffer.byteLength(d.html, 'utf8') > maxHtmlBytes) return { error: 'the issue is too long to show beside the event' }
  if (d.html.includes('\0')) return { error: 'the Jira plugin sent a document with a NUL byte' }
  const assets = []
  for (const a of Array.isArray(d.assets) ? d.assets : []) {
    if (!a || typeof a.id !== 'string' || !ASSET_ID.test(a.id) || takenIds.has(a.id)) continue
    if (typeof a.dataUrl !== 'string' || a.dataUrl.length > 1000000 || !IMAGE_URL.test(a.dataUrl)) continue
    const mime = a.dataUrl.slice(5, a.dataUrl.indexOf(';'))
    assets.push({ id: a.id, name: typeof a.name === 'string' ? cut(a.name, 200) : a.id, mime, dataUrl: a.dataUrl })
  }
  const title = typeof d.title === 'string' ? cut(oneLine(d.title), 200) : ''
  const key = typeof d.key === 'string' && /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]{0,9}$/.test(d.key) ? d.key : null
  const aside = typeof d.aside === 'string' && d.aside && d.aside.length <= ASIDE_MAX && !d.aside.includes('\0') ? d.aside : null
  return { html: d.html, assets, title: title || (key ? `Jira issue ${key}` : 'Jira issue'), aside }
}

/**
 * The issue as the reviewer's `companion` (cc-cockpit 0.9.3+): beside the event.
 * `checked` is checkDocument's answer, `assets` its pictures (the event has none of its own), `url` the issue's browse URL; its facts are the document's own
 * details column, else the facts made from issue() (`fallbackFacts`), else none. Its
 * header bar reads `Jira · KEY` with an "Open in Jira ↗" button.
 */
function jiraCompanion({ key, checked, assets, url, fallbackFacts }) {
  // The column's header bar: "Jira · KEY" and an "Open in Jira ↗" button.
  const c = { title: checked.title, html: checked.html, label: `Jira · ${key}`, urlLabel: 'Jira' }
  const facts = checked.aside || fallbackFacts || ''
  if (facts) c.facts = facts
  if (typeof url === 'string' && /^https:\/\//.test(url)) c.url = url
  if (assets.length) c.assets = assets
  return c
}

/**
 * The issue's facts for the details column, from issue() (when there is no companion, or as the
 * companion's facts when the document brought none). `esc` escapes text for HTML.
 */
function issueFacts(key, issue, url, esc) {
  const link = url ? `<a href="${esc(url)}">${esc(key)}</a>` : esc(key)
  if (!issue) return `<dt>Jira issue</dt><dd>${link}</dd>`
  const status = issue.status ? ` <span class="lozenge lozenge-${issue.done ? 'success' : issue.category === 'indeterminate' ? 'info' : 'neutral'}">${esc(cut(issue.status, 100))}</span>` : ''
  return `<dt>Jira issue</dt><dd>${link}${status}${issue.summary ? ` ${esc(cut(oneLine(issue.summary), 200))}` : ''}</dd>`
}

/** One line for the text views (`ccc calendar show`, the reviewer's text mode). */
function jiraLine(key, issue, url) {
  if (!issue) return `Jira issue ${key}${url ? `: ${url}` : ''}`
  return `Jira issue ${key}: ${oneLine(issue.summary || '')} (${[issue.status, issue.priority, issue.assignee ? `assigned to ${issue.assignee}${issue.mine ? ' (you)' : ''}` : 'unassigned'].filter(Boolean).join(', ')})${url ? ` ${url}` : ''}`
}

/** A chip's text: `PROJ-123 · In Progress`, the key alone while the status is not known. */
function chip(key, issue) {
  return issue && issue.status ? `${key} · ${cut(oneLine(issue.status), 40)}` : key
}

module.exports = { keysIn, jiraContext, createLookups, createSiteCache, checkDocument, jiraCompanion, issueFacts, jiraLine, chip, KEY, MAX_KEYS, TTL_MS, ERROR_MS, MAX_STARTED }
