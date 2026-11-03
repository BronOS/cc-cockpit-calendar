'use strict'
// The panel's title bar (`ctx.panels.header`, design "Panel"): the running or next meeting with its
// countdown and the account address as the header's text, Join (enabled from `joinEarlyMinutes`
// before a meeting with a Meet link until its end) and Refresh (spins while a poll runs). Pure, so
// node:test checks it; the host sends it on every state change and on its 15 s tick (the countdown
// moves), and only when it changed. (From bronos.chat's header.js, with the meeting and Join.)

const T = require('./time')

const META_MAX = 120 // the app refuses a longer header text
const JOIN_ICON = 'icons/join.svg'

function cutMeta(s) {
  return s.length > META_MAX ? s.slice(0, META_MAX - 1) + '…' : s
}

/**
 * The header for a state: `{ meta, actions }`.
 * @param {object} s
 * @param {boolean} s.ready signed in and nothing blocks polling
 * @param {boolean} s.polling
 * @param {object|null} s.view layout.buildView's view (null before a poll)
 * @param {string} s.account
 * @param {number} s.lastPoll
 * @param {boolean} [s.stale] the agenda is older than a poll interval or two (the last poll failed)
 * @param {string} s.tz
 */
function headerSpec(s, now) {
  const refresh = { id: 'refresh', icon: 'refresh', title: 'Poll Google Calendar now', busy: Boolean(s.ready && s.polling), disabled: !s.ready }
  if (!s.ready || !s.view) return { meta: s.ready && s.polling ? 'polling…' : '', actions: [refresh] }
  const h = s.view.head
  let what
  if (h.now) what = `now: ${h.now.title} · ends in ${T.span(h.now.end - now)}`
  else if (h.next) what = `next: ${h.next.title} in ${T.span(h.next.start - now)}`
  else if (h.tomorrowFirst) what = 'no more meetings today'
  else what = 'no meetings'
  const tail = `${s.stale && s.lastPoll ? ` · as of ${T.hm(s.lastPoll, s.tz)}` : ''}${s.account ? ` · ${s.account}` : ''}`
  // The meeting's title is what gets cut, never the address.
  const meta = what.length + tail.length > META_MAX ? cutMeta(`${what.slice(0, Math.max(10, META_MAX - tail.length - 1))}…${tail}`) : what + tail
  const j = h.join
  const join = { id: 'join', icon: JOIN_ICON, title: j ? `Join ${j.title}` : 'No meeting to join now', disabled: !j }
  return { meta, actions: [join, refresh] }
}

module.exports = { headerSpec, META_MAX, JOIN_ICON }
