'use strict'
// The event detail view (design "The event detail view"): the event read fresh (events.get) as clean
// HTML for the reviewer's HTML mode (and the plugin's own reader page), its key fields as the details
// column (`aside`, a `dl.facts`), and the same as plain text (`ccc calendar show`, Discuss, the
// reviewer's text mode). Fixed markup, every text escaped; the description (Google keeps HTML there)
// goes through the sanitizer (bronos.gmail's), so only the reviewer's allow-list and http(s) / mailto
// links come out, and no remote image is ever loaded.

const { esc } = require('./entities')
const { sanitizeHtml, htmlToText, textToHtml, safeHref } = require('./sanitize')
const T = require('./time')
const { cut, oneLine, emailAddress } = require('./util')

const MAX_DESCRIPTION = 400000
const MAX_GUESTS = 300
const ANSWER_TEXT = { accepted: 'Accepted', tentative: 'Maybe', declined: 'Declined', needsAction: 'Not answered', organizer: 'You organize it', none: 'You are not a guest' }
const ANSWER_TONE = { accepted: 'success', tentative: 'warning', declined: 'danger', needsAction: 'info', organizer: 'neutral', none: 'neutral' }
const TYPE_TEXT = { default: 'Event', fromGmail: 'From Gmail', outOfOffice: 'Out of office', focusTime: 'Focus time', workingLocation: 'Working location', birthday: 'Birthday' }
const MARK = { accepted: '✓', declined: '✗', tentative: '?', needsAction: '·' }

/** When, in words: `Tue 3 Nov, 10:00–10:30 (Europe/Berlin)`, an all-day span `Tue 3 Nov – Thu 5 Nov`. */
function whenText(ev, tz, thisYear) {
  if (ev.allDay) {
    const last = T.addDays(ev.endDate, -1)
    return last === ev.startDate ? `${T.longDay(ev.startDate, thisYear)}, all day` : `${T.longDay(ev.startDate, thisYear)} – ${T.longDay(last, thisYear)}, all day`
  }
  return `${T.longDay(T.dayKey(ev.start, tz), thisYear)}, ${T.range(ev.start, ev.end, tz)} (${tz})`
}

/** The same event in its own zone when that differs from the display zone, else ''. */
function ownZoneText(ev, tz) {
  if (ev.allDay || !ev.zone || ev.zone === tz) return ''
  // Only worth saying when the wall clock differs (two names of one offset read the same).
  if (T.range(ev.start, ev.end, ev.zone) === T.range(ev.start, ev.end, tz)) return ''
  return `${T.range(ev.start, ev.end, ev.zone)} in ${ev.zone}`
}

/** Whether a description is HTML (Calendar's editor, an Outlook invitation) rather than plain text. */
function isHtml(s) {
  return /<(a|b|i|u|br|p|div|span|strong|em|ul|ol|li|table|h[1-6])\b[^>]*>/i.test(s) || /&(nbsp|amp|lt|gt|quot);/.test(s)
}

/** The description as safe HTML ('' when there is none). */
function descriptionHtml(raw) {
  const d = typeof raw.description === 'string' ? raw.description.slice(0, MAX_DESCRIPTION) : ''
  if (!d.trim()) return ''
  return isHtml(d) ? sanitizeHtml(d, { headingShift: 2 }).html : textToHtml(d)
}

/** The description as plain text. */
function descriptionText(raw) {
  const d = typeof raw.description === 'string' ? raw.description.slice(0, MAX_DESCRIPTION) : ''
  if (!d.trim()) return ''
  return isHtml(d) ? htmlToText(d) : d.replace(/\r\n?/g, '\n').trim()
}

/** The guests grouped by answer, rooms apart: `{ groups: [[status, [guest]]], rooms, hidden }`. */
function guestGroups(raw) {
  const atts = (Array.isArray(raw.attendees) ? raw.attendees : []).filter(Boolean).slice(0, MAX_GUESTS)
  const g = { accepted: [], tentative: [], needsAction: [], declined: [] }
  const rooms = []
  for (const a of atts) {
    const person = {
      name: cut(oneLine(a.displayName || ''), 120),
      email: emailAddress(a.email) || '',
      optional: a.optional === true,
      organizer: a.organizer === true,
      self: a.self === true,
    }
    if (a.resource) {
      rooms.push(person)
      continue
    }
    const r = g[a.responseStatus] ? a.responseStatus : 'needsAction'
    g[r].push(person)
  }
  return { groups: Object.entries(g).filter(([, list]) => list.length), rooms, hidden: raw.guestsCanSeeOtherGuests === false, omitted: raw.attendeesOmitted === true }
}

const GROUP_TITLE = { accepted: 'Going', tentative: 'Maybe', needsAction: 'Not answered', declined: 'Not going' }

function personHtml(p) {
  const who = p.name || p.email || 'a guest'
  const extra = [p.self ? 'you' : '', p.organizer ? 'organizer' : '', p.optional ? 'optional' : ''].filter(Boolean)
  return `<span class="person">${esc(who)}</span>${p.name && p.email ? ` <span class="muted">${esc(p.email)}</span>` : ''}${extra.length ? ` <span class="muted">(${esc(extra.join(', '))})</span>` : ''}`
}

function personText(p) {
  const extra = [p.self ? 'you' : '', p.organizer ? 'organizer' : '', p.optional ? 'optional' : ''].filter(Boolean)
  return `${p.name || p.email || 'a guest'}${p.name && p.email ? ` <${p.email}>` : ''}${extra.length ? ` (${extra.join(', ')})` : ''}`
}

/** The attachments as `{ title, url }` (http(s) links only; Drive files are links, never downloaded). */
function attachmentsOf(raw) {
  return (Array.isArray(raw.attachments) ? raw.attachments : [])
    .filter(Boolean)
    .slice(0, 25)
    .map((a) => ({ title: cut(oneLine(a.title || 'attachment'), 200), url: safeHref(String(a.fileUrl || '')) }))
    .filter((a) => a.url && /^https:\/\//.test(a.url))
}

/**
 * The detail view: `{ html, aside, text }`.
 * @param {object} o
 * @param {object} o.raw the event from events.get
 * @param {object} o.ev model.compactEvent of it
 * @param {string} o.tz the display zone
 * @param {{ title: string, time: string }[]} [o.conflicts]
 * @param {string} [o.calendarUrl] the event in Google Calendar (with authuser)
 * @param {string} [o.jiraFacts] `<dt>/<dd>` rows of the event's Jira issue for the aside
 * @param {string[]} [o.jiraLines] the same as text lines
 * @param {number} [o.now]
 */
function eventDocument(o) {
  const { raw, ev, tz } = o
  const year = new Date(o.now || Date.now()).getUTCFullYear()
  const when = whenText(ev, tz, year)
  const own = ownZoneText(ev, tz)
  const g = guestGroups(raw)
  const files = attachmentsOf(raw)
  const conflicts = o.conflicts || []
  const answer = ANSWER_TEXT[ev.response] || ev.response
  const tone = ANSWER_TONE[ev.response] || 'neutral'
  const desc = descriptionHtml(raw)
  const h = []
  h.push(`<h1>${esc(ev.title)}</h1>`)
  h.push(`<p class="meta">${esc(when)}${ev.recurring ? ' · repeats' : ''}${ev.calendarName ? ` · ${esc(ev.calendarName)}` : ''}</p>`)
  if (own) h.push(`<p class="muted">${esc(own)}</p>`)
  if (ev.type === 'outOfOffice') h.push('<div class="jira-panel jira-panel-note"><p>Out of office.</p></div>')
  if (conflicts.length) h.push(`<div class="jira-panel jira-panel-warning">${conflicts.map((c) => `<p>Overlaps ${esc(c.title)} ${esc(c.time)}</p>`).join('')}</div>`)
  h.push(`<p>Your answer: <span class="lozenge lozenge-${tone}">${esc(answer)}</span>${ev.organizer && !ev.organizer.self && (ev.organizer.name || ev.organizer.email) ? ` · organized by <span class="person">${esc(ev.organizer.name || ev.organizer.email)}</span>` : ''}</p>`)
  if (ev.location) h.push(`<h2>Where</h2><p>${esc(ev.location)}</p>`)
  if (ev.join || (ev.phone && ev.phone.label)) {
    const parts = []
    if (ev.join) parts.push(`<a href="${esc(ev.join)}">${esc(ev.join.replace(/^https:\/\//, ''))}</a>`)
    if (ev.phone && ev.phone.label) parts.push(`Dial-in ${esc(ev.phone.label)}${ev.phone.pin ? `, PIN ${esc(ev.phone.pin)}` : ''}`)
    h.push(`<h2>Join</h2><p>${parts.join('<br>')}</p>`)
  }
  if (desc) h.push(`<h2>Description</h2>${desc}`)
  if (g.groups.length || g.rooms.length) {
    h.push(`<h2>Guests (${ev.guests.total})</h2>`)
    if (g.hidden && !ev.organizer.self) h.push('<p class="muted"><em>The organizer hides the guest list: only some guests are shown.</em></p>')
    for (const [status, list] of g.groups) h.push(`<h3>${esc(GROUP_TITLE[status])} (${list.length})</h3><ul>${list.map((p) => `<li>${personHtml(p)}</li>`).join('')}</ul>`)
    if (g.rooms.length) h.push(`<h3>Rooms</h3><ul>${g.rooms.map((p) => `<li>${esc(p.name || p.email)}</li>`).join('')}</ul>`)
  }
  if (files.length) h.push(`<h2>Attachments</h2><ul class="attachment-list">${files.map((f) => `<li><a href="${esc(f.url)}">${esc(f.title)}</a></li>`).join('')}</ul>`)

  const row = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : '')
  const counts = ev.guests.total ? `${ev.guests.total}: ${ev.guests.accepted} yes, ${ev.guests.tentative} maybe, ${ev.guests.needsAction} no answer${ev.guests.declined ? `, ${ev.guests.declined} no` : ''}` : ''
  const aside = [
    '<dl class="facts">',
    row('Calendar', esc(ev.calendarName)),
    row('When', esc(when)),
    row('Your answer', `<span class="lozenge lozenge-${tone}">${esc(answer)}</span>`),
    row('Organizer', ev.organizer && (ev.organizer.name || ev.organizer.email) ? `<span class="person">${esc(ev.organizer.self ? 'you' : ev.organizer.name || ev.organizer.email)}</span>` : ''),
    row('Guests', esc(counts)),
    row('Shows as', esc(ev.busy ? 'Busy' : 'Free')),
    row('Visibility', raw.visibility && raw.visibility !== 'default' ? esc(String(raw.visibility).slice(0, 20)) : ''),
    row('Type', ev.type !== 'default' ? esc(TYPE_TEXT[ev.type] || ev.type) : ''),
    row('Conference', esc(ev.conference)),
    o.jiraFacts || '',
    '</dl>',
  ].join('')

  // The readable text: what Claude reads (Discuss, `ccc calendar show`, the reviewer's text mode).
  const t = []
  t.push(ev.title, `When: ${when}${ev.recurring ? ' (repeats)' : ''}`)
  if (own) t.push(`(${own})`)
  t.push(`Calendar: ${ev.calendarName}`, `Your answer: ${answer}`)
  if (ev.organizer && !ev.organizer.self && (ev.organizer.name || ev.organizer.email)) t.push(`Organizer: ${personText({ name: ev.organizer.name, email: ev.organizer.email })}`)
  if (ev.location) t.push(`Where: ${ev.location}`)
  if (ev.join) t.push(`Join: ${ev.join}`)
  if (ev.phone && ev.phone.label) t.push(`Dial-in: ${ev.phone.label}${ev.phone.pin ? `, PIN ${ev.phone.pin}` : ''}`)
  if (!ev.busy) t.push('Shows as free')
  for (const c of conflicts) t.push(`Overlaps: ${c.title} ${c.time}`)
  for (const l of o.jiraLines || []) t.push(l)
  const dt = descriptionText(raw)
  if (dt) t.push('', 'Description:', dt)
  if (g.groups.length || g.rooms.length) {
    t.push('', `Guests (${ev.guests.total}):`)
    for (const [status, list] of g.groups) for (const p of list) t.push(`  ${MARK[status]} ${personText(p)}`)
    for (const r of g.rooms) t.push(`  room: ${r.name || r.email}`)
  }
  for (const f of files) t.push(`Attachment: ${f.title} ${f.url}`)
  return { html: h.join('\n'), aside, text: t.join('\n') }
}

/** What Discuss and New session send: a line that says what it is about, then the readable text. */
function discussPrompt(ev, text, tz, now) {
  const when = ev.allDay ? T.longDay(ev.startDate, new Date(now || Date.now()).getUTCFullYear()) : `${T.longDay(T.dayKey(ev.start, tz), new Date(now || Date.now()).getUTCFullYear())} ${T.hm(ev.start, tz)}`
  return `About the meeting "${cut(oneLine(ev.title), 200)}" on ${when} (from my Google Calendar):\n\n${cut(text, 60000)}`
}

module.exports = { eventDocument, discussPrompt, whenText, ownZoneText, descriptionHtml, descriptionText, guestGroups, attachmentsOf, isHtml, ANSWER_TEXT, MARK }
