'use strict'
// Token-to-host safety: the one place the Google access token leaves the plugin (the sign-in and the
// token refresh are ctx.oauth's, in the app; never from here). Also the one write (rsvpBody below).
//
// The rule (design "Auth": tokens go only to https://www.googleapis.com/calendar/v3/ and the OAuth
// endpoints): every request is built here from the fixed origin and a path from the route table, so
// no address from a response (a link in a description, a `nextPageToken`, an attachment's URL) can
// point the token elsewhere. Redirects are not followed at all (`redirect: 'manual'`): the API
// answers directly, so a 3xx means something is off (a proxy, a captive portal) and is an error,
// never a hop with the token. The token never goes into a URL.
//
// Methods: GET for reads; PATCH for exactly one path shape, an event of a calendar, and only with
// the body rsvpBody builds (the person's own answer). Anything else is refused before a request is
// made. (From bronos.chat's http.js, made to serve the Calendar API.)

const TIMEOUT_MS = 20000

const ORIGIN = 'https://www.googleapis.com'

// A calendar id as it sits in a path: the checked id (util.calendarId) through encodeURIComponent,
// so only letters, digits, `.`, `_`, `-` and the escapes of `@`, `#` and `+` appear.
const CAL_SEG = '(?:[A-Za-z0-9._-]|%(?:40|23|2B)){1,800}'
const EVENT_SEG = '[A-Za-z0-9_-]{1,1100}'
const ROUTES = [
  { method: 'GET', path: new RegExp(`^/calendar/v3/users/me/calendarList(/${CAL_SEG})?$`) },
  { method: 'GET', path: new RegExp(`^/calendar/v3/calendars/${CAL_SEG}/events(/${EVENT_SEG})?$`) },
  { method: 'PATCH', path: new RegExp(`^/calendar/v3/calendars/${CAL_SEG}/events/${EVENT_SEG}$`) },
]

/** Why a request failed, as a kind the host and the panel can act on. */
class CalendarError extends Error {
  /**
   * @param {string} message what the person reads
   * @param {{ kind: string, status?: number, retryAfter?: number, reason?: string }} info
   *   kind: auth (401), forbidden (403), scope (403 insufficient scopes), disabled (the API is not
   *   enabled), admin (an organisation's policy), notfound (404), gone (410), rate (429, or 403
   *   usageLimits), server (5xx), http (another status), network, timeout, unsafe (a request that
   *   would leave the rule), json, toolarge
   */
  constructor(message, info) {
    super(message)
    this.name = 'CalendarError'
    this.kind = info.kind
    if (info.status !== undefined) this.status = info.status
    if (info.retryAfter !== undefined) this.retryAfter = info.retryAfter
    if (info.reason) this.reason = info.reason
  }
}

/** Whether an error is worth backing off for (design: 429, usageLimits and 5xx double the poll interval). */
function isBusy(err) {
  return Boolean(err) && (err.kind === 'rate' || err.kind === 'server')
}

// ---- the one write ----

const ANSWERS = new Set(['accepted', 'tentative', 'declined'])

/**
 * The body of the plugin's only write (design "RSVP"): exactly `{ attendeesOmitted: true, attendees:
 * [{ email, responseStatus }] }`, from an answer and the person's own attendee address, never from a
 * caller's object, so no call path can change a title, a time, the guests or anything else.
 * `attendeesOmitted` tells Google the list holds only the participant (Events resource: "When
 * updating an event, this can be used to only update the participant's response"). Null for an
 * answer that is not accepted / tentative / declined or an address that does not look like one.
 */
function rsvpBody(answer, email) {
  if (!ANSWERS.has(answer)) return null
  const e = typeof email === 'string' ? email.trim() : ''
  if (!e || e.length > 254 || !/^[^\s@"'<>,;:\\/[\]]+@[^\s@"'<>,;:\\/[\]]+$/.test(e)) return null
  return { attendeesOmitted: true, attendees: [{ email: e, responseStatus: answer }] }
}

/**
 * A request with the bearer token to one of the allowed routes.
 *
 * @param {string} path
 * @param {object} o
 * @param {string} o.token the access token
 * @param {'GET'|'PATCH'} [o.method]
 * @param {URLSearchParams|Record<string,string>|Array<[string,string]>} [o.params]
 * @param {object} [o.json] the PATCH body (rsvpBody's, checked again here)
 * @param {typeof fetch} o.fetch injected (tests pass a fake; nothing here reaches the network itself)
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.timeoutMs]
 * @param {number} [o.maxBytes] the body's cap (default 8 MiB)
 */
async function googleRequest(path, o) {
  const method = o.method || 'GET'
  if (typeof path !== 'string' || path.includes('..') || path.includes('//') || /[?#\s\\]/.test(path) || !ROUTES.some((r) => r.method === method && r.path.test(path))) {
    throw new CalendarError('not an allowed Google Calendar request: the token is not sent', { kind: 'unsafe' })
  }
  if (method === 'PATCH') {
    // The one write takes only the shape rsvpBody makes: checked here too, so no other caller can
    // slip another field through this function.
    const b = o.json
    const a = b && Array.isArray(b.attendees) && b.attendees.length === 1 ? b.attendees[0] : null
    const same = a && rsvpBody(a.responseStatus, a.email)
    if (!same || JSON.stringify(same) !== JSON.stringify(b)) throw new CalendarError('only the answer to an invitation may be written: the token is not sent', { kind: 'unsafe' })
  } else if (o.json !== undefined) {
    throw new CalendarError('a read has no body: the token is not sent', { kind: 'unsafe' })
  }
  const qs = o.params ? new URLSearchParams(o.params).toString() : ''
  const url = ORIGIN + path + (qs ? `?${qs}` : '')
  // The URL parser must agree that this is still the origin and the path (a checked path cannot
  // change either, but the check costs nothing and keeps the rule in one visible place).
  const parsed = new URL(url)
  if (parsed.origin !== ORIGIN || parsed.pathname !== path) throw new CalendarError('not an allowed Google Calendar address: the token is not sent', { kind: 'unsafe' })
  const ms = o.timeoutMs || TIMEOUT_MS
  const timeout = AbortSignal.timeout(ms)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  const headers = { Authorization: `Bearer ${o.token}`, Accept: 'application/json' }
  let body
  if (o.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(o.json)
  }
  let res
  try {
    res = await o.fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal })
  } catch (e) {
    if (timeout.aborted) throw new CalendarError(`Google Calendar did not answer within ${Math.round(ms / 1000)} s`, { kind: 'timeout' })
    if (o.signal && o.signal.aborted) throw new CalendarError('cancelled', { kind: 'network' })
    throw new CalendarError(`cannot reach www.googleapis.com: ${e && e.message ? e.message : e}`, { kind: 'network' })
  }
  let buf
  try {
    buf = await readLimited(res, o.maxBytes || 8 * 1024 * 1024)
  } catch (e) {
    if (e instanceof CalendarError) throw e
    if (timeout.aborted) throw new CalendarError(`Google Calendar did not answer within ${Math.round(ms / 1000)} s`, { kind: 'timeout' })
    throw new CalendarError(`reading Google Calendar's answer failed: ${e && e.message ? e.message : e}`, { kind: 'network' })
  }
  if (res.status >= 200 && res.status < 300) {
    const text = buf.toString('utf8')
    if (!text.trim()) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new CalendarError('Google Calendar answered with something that is not JSON', { kind: 'json', status: res.status })
    }
  }
  throw statusError(res, buf.toString('utf8'), method)
}

const DISABLED_TEXT = 'The Google Calendar API is not enabled in your Google Cloud project: enable it (APIs & Services > Library > Google Calendar API, or the link in the setup guide), then refresh'
const ADMIN_TEXT = 'Your organisation does not allow this app to use Google Calendar (a Workspace admin policy): ask your admin, or use another account'

/**
 * A CalendarError for a status that is not 2xx, as one readable line (design "Auth": never the raw
 * body), with Google's own reason when it gave one.
 */
function statusError(res, text, method) {
  const status = res.status
  if (status >= 300 && status < 400) return new CalendarError(`Google Calendar answered with a redirect (${status}): not followed, the token stays here. A proxy in the way?`, { kind: 'http', status })
  const g = googleError(text)
  const all = `${g.reason} ${g.message}`
  const detail = g.message ? ` (${g.message})` : ''
  if (status === 401) return new CalendarError(`Google refused the access token (401)${detail}`, { kind: 'auth', status })
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|usageLimits|RATE_LIMIT_EXCEEDED/.test(g.reason))) {
    const ra = Number(res.headers.get('retry-after'))
    return new CalendarError('Google Calendar is rate limiting the plugin; it polls less often until it answers again', { kind: 'rate', status, ...(Number.isFinite(ra) ? { retryAfter: ra } : {}) })
  }
  if ((status === 403 || status === 400) && /accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(all)) {
    return new CalendarError(DISABLED_TEXT, { kind: 'disabled', status, reason: g.reason })
  }
  if (status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(all)) {
    // The host words it: on the RSVP call it may mean Google does not take RSVP_SCOPE for the write.
    return new CalendarError(`Google did not grant the plugin this permission${method === 'PATCH' ? ' (answering an invitation)' : ''}: sign in again and leave every box ticked on the consent page`, { kind: 'scope', status, reason: g.reason })
  }
  if (status === 403 && /domainPolicy|admin|administrator|organization|organisation|not authorized to access this resource/i.test(all)) {
    return new CalendarError(`${ADMIN_TEXT}${detail}`, { kind: 'admin', status, reason: g.reason })
  }
  if (status === 403) return new CalendarError(`Google Calendar refused the request (403)${detail}`, { kind: 'forbidden', status, reason: g.reason })
  if (status === 404) return new CalendarError(`not found in Google Calendar (404)${detail}`, { kind: 'notfound', status })
  if (status === 410) return new CalendarError(`gone from Google Calendar (410)${detail}`, { kind: 'gone', status })
  if (status >= 500) return new CalendarError(`Google Calendar had a problem (${status}); it polls less often until it answers again`, { kind: 'server', status })
  return new CalendarError(`Google Calendar answered ${status}${detail}`, { kind: 'http', status })
}

/** Google's error body (`{ error: { code, message, errors: [{ reason }], status, details } }`) as short plain text. */
function googleError(text) {
  try {
    const body = JSON.parse(text)
    const e = body && body.error
    if (!e || typeof e !== 'object') return { message: '', reason: '' }
    const reasons = [...(Array.isArray(e.errors) ? e.errors.map((x) => x && x.reason) : []), e.status, ...(Array.isArray(e.details) ? e.details.map((x) => x && x.reason) : [])].filter((x) => typeof x === 'string')
    return { message: typeof e.message === 'string' ? e.message.replace(/\s+/g, ' ').slice(0, 200) : '', reason: reasons.join(' ') }
  } catch {
    // Not JSON (an HTML error page from a proxy): no detail rather than markup in a notice.
    return { message: '', reason: '' }
  }
}

/**
 * A response body as a Buffer, refused past `max` bytes (a declared Content-Length over it is
 * refused before reading; a body that keeps coming is cut off at the limit and cancelled).
 */
async function readLimited(res, max) {
  const tooLarge = () => new CalendarError(`the answer is over ${max} bytes`, { kind: 'toolarge', status: res.status })
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    if (res.body) await res.body.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > max) throw tooLarge()
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  }
  return Buffer.concat(chunks, total)
}

module.exports = { ORIGIN, ROUTES, CalendarError, googleRequest, rsvpBody, readLimited, isBusy, googleError, DISABLED_TEXT, ADMIN_TEXT }
