'use strict'
// The Google Calendar client: the Calendar API v3 calls the plugin makes (design "Fetching", "RSVP").
// One write only: `rsvp`, the person's own answer to an invitation (events.patch with rsvpBody). No
// method here creates, moves, edits or deletes an event, and none could: http.js refuses any other
// write.
//
// The access token comes from `getToken` (auth.js) on every request. A 401 means it died early
// (revoked, the clock): the client drops it (`invalidate`), takes a fresh one and retries once.

const { CalendarError, googleRequest, rsvpBody } = require('./http')
const { calendarId, eventId } = require('./util')

const LIST_PAGES = 3
const EVENT_PAGES = 4
const PAGE = 250
const MAX_JSON = 8 * 1024 * 1024

// What the panel and the detail view use of an event (the `fields` mask keeps the answer small: a
// week of a busy calendar with descriptions is a few hundred KB instead of megabytes).
const EVENT_FIELDS =
  'id,status,summary,description,location,htmlLink,hangoutLink,iCalUID,recurringEventId,originalStartTime,start,end,endTimeUnspecified,' +
  'eventType,transparency,visibility,guestsCanSeeOtherGuests,attendeesOmitted,' +
  'organizer(email,displayName,self),attendees(email,displayName,self,organizer,resource,optional,responseStatus),' +
  'conferenceData(entryPoints(entryPointType,uri,label,pin),conferenceSolution(name,key/type)),' +
  'workingLocationProperties(type,homeOffice,officeLocation(label,buildingId),customLocation(label)),outOfOfficeProperties(declineMessage),' +
  'attachments(fileUrl,title,mimeType)'
const LIST_FIELDS = `items(${EVENT_FIELDS}),nextPageToken,timeZone`
const CAL_FIELDS = 'items(id,summary,summaryOverride,primary,selected,hidden,accessRole,backgroundColor,foregroundColor,timeZone),nextPageToken'

/** A calendar id as it goes into a path (checked, then escaped). */
function calPath(cal) {
  const c = calendarId(cal)
  if (!c) throw new CalendarError('not a calendar id', { kind: 'unsafe' })
  return encodeURIComponent(c)
}

function evPath(id) {
  const e = eventId(id)
  if (!e) throw new CalendarError('not an event id', { kind: 'unsafe' })
  return e
}

/**
 * @param {object} o
 * @param {() => Promise<string>} o.getToken
 * @param {() => void} o.invalidate
 * @param {typeof fetch} o.fetch
 */
function createClient(o) {
  async function call(path, extra = {}) {
    let token = await o.getToken()
    try {
      return await googleRequest(path, { token, fetch: o.fetch, ...extra })
    } catch (e) {
      if (!(e instanceof CalendarError) || e.kind !== 'auth') throw e
      o.invalidate()
      token = await o.getToken()
      return googleRequest(path, { token, fetch: o.fetch, ...extra })
    }
  }

  /** The person's calendar list (all pages, at most 3 of 250): the raw entries with an id that checks out. */
  async function calendarList(signal) {
    const out = []
    const seen = new Set()
    let pageToken = null
    for (let page = 0; page < LIST_PAGES; page++) {
      const params = { maxResults: String(PAGE), fields: CAL_FIELDS }
      if (pageToken) params.pageToken = pageToken
      const body = (await call('/calendar/v3/users/me/calendarList', { params, signal, maxBytes: MAX_JSON })) || {}
      const got = Array.isArray(body.items) ? body.items : []
      for (const c of got) {
        if (!c || !calendarId(c.id) || seen.has(c.id)) continue
        seen.add(c.id)
        out.push(c)
      }
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null
      if (!pageToken || !got.length) break
    }
    return out
  }

  /**
   * The events of a calendar in a window, recurring ones expanded (design "Fetching"): all pages, at
   * most 4 of 250, ordered by start. `{ items, timeZone, more }` (`more`: Google had another page).
   */
  async function events(cal, { timeMin, timeMax, timeZone }, signal) {
    const items = []
    let pageToken = null
    let zone = null
    let more = false
    for (let page = 0; page < EVENT_PAGES; page++) {
      const params = { timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(PAGE), maxAttendees: '100', fields: LIST_FIELDS }
      if (timeZone) params.timeZone = timeZone
      if (pageToken) params.pageToken = pageToken
      const body = (await call(`/calendar/v3/calendars/${calPath(cal)}/events`, { params, signal, maxBytes: MAX_JSON })) || {}
      if (typeof body.timeZone === 'string') zone = body.timeZone
      const got = Array.isArray(body.items) ? body.items : []
      items.push(...got)
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null
      if (!pageToken || !got.length) break
      if (page === EVENT_PAGES - 1) more = true
    }
    return { items, timeZone: zone, more }
  }

  /** One event, fresh (the detail view, `show`): every guest (no maxAttendees). */
  async function event(cal, id, signal) {
    return call(`/calendar/v3/calendars/${calPath(cal)}/events/${evPath(id)}`, { params: { fields: EVENT_FIELDS }, signal, maxBytes: MAX_JSON })
  }

  /**
   * The plugin's one write (design "RSVP"): the person's own answer, `sendUpdates=all` (decision 3:
   * the organizer is told, as Google's own UI does). `id` is the instance (one occurrence) or the
   * recurring event (the series). Resolves Google's answer, the event.
   */
  async function rsvp(cal, id, answer, email, signal) {
    const json = rsvpBody(answer, email)
    if (!json) throw new CalendarError('an answer is accepted, tentative or declined, with your address', { kind: 'unsafe' })
    return call(`/calendar/v3/calendars/${calPath(cal)}/events/${evPath(id)}`, { method: 'PATCH', params: { sendUpdates: 'all', fields: EVENT_FIELDS }, json, signal, timeoutMs: 20000 })
  }

  return { calendarList, events, event, rsvp }
}

module.exports = { createClient, EVENT_FIELDS, LIST_FIELDS, CAL_FIELDS }
