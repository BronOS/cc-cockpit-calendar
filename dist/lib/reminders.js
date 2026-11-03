'use strict'
// Meeting reminders (design "Reminders", decision 2): which reminders are due on a tick, the key that
// lets exactly one project window show each one, the text, and the call to ctx.notify with its
// feature detection. Pure but for `notify` (it takes ctx).
//
// - Due: for each timed meeting of the person's that they have not declined (layout.isMeeting: no
//   focus time, out of office, working location or birthday), each offset of the `reminders`
//   setting is due from `start - minutes` until the meeting has run 5 minutes. Of the offsets due at
//   once (the window opened late, the computer slept) only the latest (the fewest minutes) is shown;
//   the earlier ones count as done with it. The text always says the real time left.
// - One per event and offset across windows: the key is `remind:<UTC date of the start>:<sha256 of
//   address | iCalUID | start | minutes, 16>`; the host increments it in ctx.appStorage (main applies
//   increments one at a time) and shows the reminder only when the answer is 1. The date in the key
//   lets the host delete old keys without knowing when they were written. A moved meeting has another
//   start, so another key: it reminds again for the new time.

const T = require('./time')
const { isMeeting } = require('./layout')
const { sha, cut } = require('./util')

const LATE_MS = 5 * 60000 // a reminder still shows until the meeting has run this long
const KEY_RE = /^remind:(\d{4}-\d{2}-\d{2}):[a-f0-9]{16}$/
const TITLE = 'Google Calendar'
const OLD_APP_SUFFIX = ' · Join from the Calendar panel'

/** The appStorage key of one reminder. */
function reminderKey(account, ev, minutes) {
  return `remind:${new Date(ev.start).toISOString().slice(0, 10)}:${sha(`${account}|${ev.iCalUID}|${ev.start}|${minutes}`, 16)}`
}

/**
 * The reminders due now: `[{ ev, minutes, key, also }]` (`also`: the keys of earlier offsets of the
 * same event that count as done with this one). `fired` holds the keys this window already handled.
 *
 * @param {object} o
 * @param {object[]} o.events the merged agenda
 * @param {number[]} o.offsets minutes before the start (settings `reminders`)
 * @param {number} o.now
 * @param {string} o.account the person's address (part of the key: two accounts never share one)
 * @param {Set<string>} o.fired
 */
function dueReminders(o) {
  const out = []
  if (!o.offsets || !o.offsets.length) return out
  for (const ev of o.events) {
    if (!isMeeting(ev) || ev.status === 'cancelled') continue
    if (o.now >= ev.start + LATE_MS) continue
    const due = o.offsets.filter((m) => o.now >= ev.start - m * 60000).sort((a, b) => a - b)
    if (!due.length) continue
    const keys = due.map((m) => reminderKey(o.account, ev, m))
    if (o.fired.has(keys[0])) {
      // The latest one was shown: an earlier one that was never handled (it came due at the same
      // tick) is not shown any more.
      for (const k of keys.slice(1)) o.fired.add(k)
      continue
    }
    out.push({ ev, minutes: due[0], key: keys[0], also: keys.slice(1).filter((k) => !o.fired.has(k)) })
  }
  return out
}

/** `In 10 min: Weekly sync (Google Meet), 10:00–10:30`; `Now: …`; `Started 3 min ago: …`. */
function reminderText(ev, now, tz) {
  const left = ev.start - now
  const head = left > 30000 ? `In ${T.span(left)}` : left >= -30000 ? 'Now' : `Started ${T.span(-left)} ago`
  return cut(`${head}: ${ev.title}${ev.join ? ' (Google Meet)' : ''}, ${T.range(ev.start, ev.end, tz)}`, 480)
}

/** The keys of reminders of days before `todayUtc - 1` (yesterday's stay: a meeting past midnight). */
function staleKeys(keys, todayUtc) {
  const cutoff = T.addDays(todayUtc, -1)
  return keys.filter((k) => {
    const m = KEY_RE.exec(k)
    return m && m[1] < cutoff
  })
}

/**
 * Whether a rejection of `ctx.notify(text, options)` is about the options (an app that checks its
 * arguments strictly and does not know one), so the call is worth one more try with the text alone;
 * not a refusal for the rate (10 a minute) or anything else.
 */
function optionsRefused(err) {
  const m = err && err.message ? err.message : String(err || '')
  if (/per minute|a minute|rate|too many|at most \d+/i.test(m)) return false
  return /option|title|sound|action|argument|unknown (key|field|property)/i.test(m) || (err && err.name === 'TypeError' && !/needs some text/.test(m))
}

/**
 * The `sound` of a reminder's ctx.notify (design "Reminders"): false with `reminderSound` off, else
 * the picked `reminderSoundChoice` id, or true (the app's sound) for "" (App default). An app that
 * does not offer the id rings its own sound instead; 0.9.4 ignores the option altogether.
 */
function reminderSoundOf(cfg) {
  if (!cfg.reminderSound) return false
  return cfg.reminderSoundChoice || true
}

/**
 * Show a reminder (design "Reminders", "The notification"). Always `ctx.notify(text, { title,
 * sound, action? })`, `sound` true, false or a sound id (reminderSoundOf): cc-cockpit 0.9.5 shows the title and the Join action and resolves `{ clicked }`;
 * 0.9.4 and older take the text only and ignore the second argument (their host's notify is
 * `(text) => …`), resolving `undefined`. A rejection that names the options is tried again with the
 * text alone. Resolves `{ clicked: boolean | null, clickable: boolean | null }`: `clickable` true when
 * the app answered the 0.9.5 way, false when it answered the old way, null when unknown (retried
 * plain). Rejects with the app's refusal otherwise (the rate cap).
 */
async function notify(ctx, text, { join = false, sound = true } = {}) {
  const opts = { title: TITLE, sound: typeof sound === 'string' ? sound : Boolean(sound), ...(join ? { action: { label: 'Join' } } : {}) }
  let r
  try {
    r = await ctx.notify(text, opts)
  } catch (e) {
    if (!optionsRefused(e)) throw e
    await ctx.notify(text)
    return { clicked: null, clickable: null }
  }
  if (r && typeof r === 'object' && typeof r.clicked === 'boolean') return { clicked: r.clicked, clickable: true }
  return { clicked: null, clickable: false }
}

module.exports = { dueReminders, reminderKey, reminderText, staleKeys, optionsRefused, notify, reminderSoundOf, LATE_MS, TITLE, OLD_APP_SUFFIX, KEY_RE }
