'use strict'
// The agenda slot's page: today as a compact horizontal timeline with the now line, the meeting now
// or next with a countdown and Join, and the invitations waiting for an answer with Accept /
// Decline. The host sends `{ type: 'agenda', ok, today, now, next, invitations, rsvpOn, ... }` (rows
// carry keys, never ids or URLs) and this page posts `{ type, key }` back: `join` (the host opens
// the Meet link, https only), `open`, `rsvp`. Every text from Google goes in through textContent.
// The decisions are pure functions over that message and a clock, so node:test checks them
// (test/agenda.test.js requires this file; the page loads it after rowlogic.js and timeline.js,
// whose functions are globals there). Names here start with `agenda` so no panel global is shadowed.

const AGT = typeof module !== 'undefined' && module.exports ? require('../panels/timeline') : { timedOf, dayRange, lanes, nowMinute, nowPct, blockState }
const AGR = typeof module !== 'undefined' && module.exports ? require('../panels/rowlogic') : { rsvpButtons, spanText, countdownText, redrawDelay }

const AGENDA_LANE_PX = 18
const AGENDA_MIN_MIN = 30 // a short event is drawn as this long, as the panel's timeline does

/**
 * Today's timeline as percentages of its width: `{ lo, hi, lanes, height, blocks, nowPct, scale }`,
 * or null when there is no timed event. Each block `{ key, title, time, left, width, lane, cls }`.
 */
function agendaTimeline(today, now) {
  const timed = AGT.timedOf(today)
  if (!timed.length) return null
  const { lo, hi } = AGT.dayRange(timed)
  const place = AGT.lanes(timed.map((r) => ({ key: r.key, from: r.from, to: Math.max(r.to, r.from + AGENDA_MIN_MIN) })))
  let n = 1
  const blocks = [...timed]
    .sort((a, b) => a.from - b.from || b.to - a.to)
    .map((r) => {
      const [lane, of] = place.get(r.key) || [0, 1]
      n = Math.max(n, of)
      const st = AGT.blockState(r, now)
      return {
        key: r.key,
        title: r.title,
        time: r.time,
        color: r.color,
        left: ((r.from - lo) / (hi - lo)) * 100,
        width: Math.max(1.5, ((r.to - r.from) / (hi - lo)) * 100),
        lane,
        cls: st.cls.filter((c) => c !== 'ev'),
      }
    })
  const scale = [lo, hi].map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:00`)
  return { lo, hi, lanes: n, height: n * AGENDA_LANE_PX + 2, blocks, nowPct: AGT.nowPct(AGT.nowMinute(today.clock, now), lo, hi), scale }
}

/**
 * The line above the timeline: the meeting running now, else the next one, with its countdown.
 * `{ label, key, title, count, join }` or null.
 */
function agendaNext(m, now) {
  const run = (m.now || [])[0]
  if (run) return { label: 'Now', key: run.key, title: run.title, count: `ends in ${AGR.spanText(run.end - now)}`, join: Boolean(run.join) }
  const n = m.next
  if (!n) return null
  const day = n.dayLabel && n.dayLabel !== 'today' ? `${n.dayLabel} ` : ''
  return { label: 'Next', key: n.key, title: n.title, count: `${day}${n.time} · ${AGR.countdownText(n.start, now)}`, join: Boolean(n.join) }
}

/** The invitations to answer: `{ key, title, when, from, buttons }`, at most 3 in the slot. */
function agendaInvitations(m) {
  return (m.invitations || []).slice(0, 3).map((r) => ({
    key: r.key,
    title: r.title,
    when: r.when || r.time || '',
    from: r.organizer || '',
    series: Boolean(r.series),
    buttons: AGR.rsvpButtons(r, { rsvpOn: m.rsvpOn, one: false }).filter((b) => b.answer !== 'tentative'),
  }))
}

/** What to say instead of the agenda: the host's reason, or "nothing today"; null when there is something. */
function agendaEmpty(m) {
  if (!m) return 'Loading…'
  if (!m.ok) return m.text || 'The calendar is not available.'
  const hasTimed = AGT.timedOf(m.today).length > 0
  if (!hasTimed && !(m.now || []).length && !m.next && !(m.invitations || []).length) return 'No events today.'
  return null
}

/** The next redraw in ms: every second near a countdown's end, else every 15 s. */
function agendaDelay(m, now) {
  const times = [...(m.now || []).map((r) => r.end), ...(m.next ? [m.next.start] : [])]
  return AGR.redrawDelay(times, now)
}

/**
 * The height the slot frame needs: the content element's own box, rounded up. Never
 * `documentElement.scrollHeight`: that is at least the frame's viewport height, so the frame could
 * grow but never shrink (the agenda stayed at the Inbox's initial height with one event or none).
 * The element is the body, whose height is `auto`, so its box is the content plus its padding and
 * does not follow the viewport. The app clamps the value (24-600 px, the slot's range).
 */
function agendaHeight(el) {
  const h = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().height : 0
  return Math.ceil(h || el.offsetHeight || 0)
}

if (typeof module !== 'undefined' && module.exports) module.exports = { agendaTimeline, agendaNext, agendaInvitations, agendaEmpty, agendaDelay, agendaHeight }

// ---- the page (not run under node) ----
if (typeof ccPanel !== 'undefined' && typeof document !== 'undefined') {
  let agendaState = null
  let agendaNotice = null
  let agendaTimer = null

  const agendaEl = (tag, props, ...children) => {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v
      else if (k === 'text') n.textContent = v
      else if (k === 'onclick') n.addEventListener('click', v)
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : String(v))
    }
    for (const c of children) if (c) n.append(c)
    return n
  }
  const agendaPost = (type, extra) => ccPanel.post({ type, ...extra })
  const agendaButton = (label, title, onclick, cls) => agendaEl('button', { type: 'button', class: cls, title, 'aria-label': title, onclick }, label)

  // Report the content's height when it changed. The observer watches the body (its size follows the
  // content, not the frame), and the last value is kept so a resize the app makes in answer cannot
  // start a loop. `ccPanel.slot` appears after load, so it is read on every call.
  let agendaLastHeight = -1
  function agendaReportHeight() {
    if (!ccPanel.slot || typeof ccPanel.slot.setHeight !== 'function') return
    const h = agendaHeight(document.body)
    if (h === agendaLastHeight || h <= 0) return
    agendaLastHeight = h
    ccPanel.slot.setHeight(h)
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(agendaReportHeight).observe(document.body)

  function agendaRender() {
    const root = document.getElementById('root')
    const m = agendaState
    const now = Date.now()
    const out = []
    const empty = agendaEmpty(m)
    if (empty) out.push(agendaEl('p', { class: 'empty', text: empty }))
    else {
      const nx = agendaNext(m, now)
      if (nx) {
        const line = agendaEl('div', { class: 'line' })
        line.append(agendaEl('span', { class: 'label', text: nx.label }), agendaEl('span', { class: 'title', text: nx.title, title: nx.title }), agendaEl('span', { class: 'count', text: nx.count }))
        if (nx.join) line.append(agendaButton('Join', `Join ${nx.title} (Google Meet)`, () => agendaPost('join', { key: nx.key }), 'cc-btn cc-primary'))
        out.push(line)
      }
      const tl = agendaTimeline(m.today, now)
      if (tl) {
        const box = agendaEl('div', { class: 'tl' })
        box.style.height = `${tl.height}px`
        for (const b of tl.blocks) {
          const e = agendaEl('div', { class: ['ev', ...b.cls].join(' '), text: b.title, title: `${b.title}\n${b.time}\nClick to open` })
          if (typeof b.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.color)) e.style.setProperty('--cal', b.color)
          e.style.left = `${b.left.toFixed(2)}%`
          e.style.width = `calc(${b.width.toFixed(2)}% - 1px)`
          e.style.top = `${b.lane * AGENDA_LANE_PX + 1}px`
          e.style.height = `${AGENDA_LANE_PX - 2}px`
          e.addEventListener('click', () => agendaPost('open', { key: b.key }))
          box.append(e)
        }
        if (tl.nowPct !== null) {
          const l = agendaEl('div', { class: 'nowline', 'aria-hidden': 'true' })
          l.style.left = `${tl.nowPct.toFixed(2)}%`
          box.append(l)
        }
        out.push(box, agendaEl('div', { class: 'scale' }, agendaEl('span', { text: tl.scale[0] }), agendaEl('span', { text: tl.scale[1] })))
      }
      const inv = agendaInvitations(m)
      for (const r of inv) {
        const row = agendaEl('div', { class: 'inv' })
        row.append(agendaEl('span', { class: 'what', text: r.title, title: `${r.title}${r.from ? `\nfrom ${r.from}` : ''}` }), agendaEl('span', { class: 'when', text: r.when }))
        for (const b of r.buttons) row.append(agendaButton(b.label, b.title, () => agendaPost('rsvp', { key: r.key, answer: b.answer }), b.answer === 'accepted' ? 'cc-btn cc-primary' : 'cc-btn'))
        if (!m.rsvpOn) row.append(agendaEl('span', { class: 'when', text: m.rsvpText, title: m.rsvpText }))
        out.push(row)
      }
    }
    if (agendaNotice) out.push(agendaEl('p', { class: agendaNotice.kind === 'error' ? 'err' : 'empty', text: agendaNotice.text }))
    root.replaceChildren(...out)
    agendaReportHeight()
    if (agendaTimer) clearTimeout(agendaTimer)
    if (m && m.ok) agendaTimer = setTimeout(agendaRender, agendaDelay(m, now))
  }

  ccPanel.onMessage((m) => {
    if (!m || typeof m !== 'object') return
    if (m.type === 'agenda') {
      agendaState = m
      agendaNotice = null
    } else if (m.type === 'notice' && typeof m.text === 'string') agendaNotice = { text: m.text, kind: m.kind === 'error' ? 'error' : 'info' }
    else return
    agendaRender()
  })
  agendaRender()
  agendaPost('hello')
}
