'use strict'
// Settings validation (project scope; design "Settings"). The manifest schema cannot say everything
// (no regexes in schemas: the app refuses them, ReDoS in main), so the host checks here what the
// form cannot: a client id that is a Google one, calendar ids that may go into a URL path. A bad
// optional value (one calendar id) is a problem shown in the panel and `ccc calendar status` and
// skipped; it never stops the plugin. (From bronos.chat's settings.js.)

const { checkClientId } = require('./oauth-client')
const { calendarId } = require('./util')

const MAX_CALENDARS = 20
const MAX_REMINDERS = 5
const DEFAULT_REMINDERS = [10, 2]

/**
 * @param {Record<string, unknown>} p ctx.settings.project
 * @returns {{ cfg: object, problems: string[] }}
 */
function readSettings(p) {
  const s = p || {}
  const problems = []
  const rawId = typeof s.clientId === 'string' ? s.clientId.trim() : ''
  let clientId = ''
  if (rawId) {
    const c = checkClientId(rawId)
    if (c.ok) clientId = rawId
    else problems.push(`clientId: ${c.error}`)
  }
  // A secret field is absent when unset (never '' or null; `ccc guide settings-secrets`).
  const clientSecret = typeof s.clientSecret === 'string' && s.clientSecret ? s.clientSecret : ''

  // Extra calendars beside the primary one (always shown). `primary` is Google's alias for it.
  const calendars = []
  for (const c of Array.isArray(s.calendars) ? s.calendars : []) {
    if (typeof c !== 'string' || !c.trim()) continue
    const id = c.trim()
    if (id === 'primary') continue
    if (!calendarId(id)) problems.push(`calendars: "${id.slice(0, 60)}" is not a calendar id (an address, or …@group.calendar.google.com), skipped`)
    else if (!calendars.includes(id) && calendars.length < MAX_CALENDARS) calendars.push(id)
  }

  const int = (v, d, lo, hi) => {
    const n = Math.floor(Number(v))
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
  }
  // Minutes before the start, each once, latest first (2 before 10 is the order they fire in reverse).
  let reminders = DEFAULT_REMINDERS
  if (Array.isArray(s.reminders)) {
    reminders = [...new Set(s.reminders.map((m) => Math.floor(Number(m))).filter((m) => Number.isFinite(m) && m >= 0 && m <= 120))].sort((a, b) => b - a).slice(0, MAX_REMINDERS)
    if (s.reminders.length && !reminders.length) problems.push('reminders: no value between 0 and 120 minutes: reminders are off')
  }
  const cfg = {
    clientId,
    clientSecret,
    calendars,
    upcomingCount: int(s.upcomingCount, 10, 1, 50),
    upcomingDays: int(s.upcomingDays, 14, 2, 60),
    inviteDays: int(s.inviteDays, 30, 1, 90),
    pollMinutes: int(s.pollMinutes, 3, 1, 30),
    reminders,
    reminderSound: s.reminderSound !== false,
    reminderSoundChoice: soundChoice(s.reminderSoundChoice),
    joinEarlyMinutes: int(s.joinEarlyMinutes, 10, 0, 30),
    showDeclined: s.showDeclined === true,
    showBirthdays: s.showBirthdays !== false,
    showWorkingLocation: s.showWorkingLocation !== false,
    timeZone: s.timeZone === 'computer' ? 'computer' : 'calendar',
  }
  return { cfg, problems }
}

/**
 * `reminderSoundChoice` (a `"format": "sound"` field): the sound id the person picked, passed to
 * ctx.notify as it is; the app checks it there (an id it does not offer rings its own sound), so
 * only the shape is checked here. "" (App default) for anything that is not a string within the
 * app's 1024-character cap: a hand-edited value must not make the call reject.
 */
function soundChoice(v) {
  return typeof v === 'string' && v.length <= 1024 ? v : ''
}

module.exports = { readSettings, MAX_CALENDARS, MAX_REMINDERS, DEFAULT_REMINDERS }
