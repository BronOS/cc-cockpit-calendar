'use strict'
// The Google Calendar panel: the setup guide while not signed in, else the agenda as the host sends
// it (`{ type: 'state', ... }`): Now / Next with the day strip, Invitations, Today as an hour
// timeline (timeline.js), Tomorrow, Upcoming, and the calendars picker in the footer. Actions are posted back as `{ type, key }`: the page holds row
// keys only, never an event id or a URL, and the host finds both itself. The page keeps no data of
// its own (an opaque origin has no storage) except which recurring invitation shows its "this one
// only" buttons and the text in the paste box. Every text from Google goes in through textContent,
// never as markup: a title or a location is whatever the organizer typed. (bronos.chat's main.js,
// with Calendar's layout.)
//
// The countdowns, the strip's now marker and the timeline's now line run on the page's own clock
// between state messages: every second while one is under a minute away, else every 15 s
// (rowlogic.redrawDelay). They change texts, classes and positions only, never rebuild the page.

let state = null
let oneOpen = new Set() // series keys whose buttons answer only the next occurrence
let savePending = false // the paste box is cleared once the host took the client
let timer = null
// What the live update moves between state messages (rebuilt by every render): the strip's marker and
// Next line, the now line, and each timeline block with its row.
let live = { blocks: [] }
// Everything the arrow keys move between: the list rows and the timeline's blocks.
const ROWS = 'li.row, .ev'

const $ = (id) => document.getElementById(id)

function el(tag, props, ...children) {
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

function button(label, onclick, title, cls) {
  return el('button', { type: 'button', title, class: cls, onclick: (ev) => { ev.stopPropagation(); onclick() } }, label)
}

const post = (type, extra) => ccPanel.post({ type, ...extra })

/** A calendar's colour on an element (the host checked it is #rrggbb). */
function colour(n, c) {
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) n.style.setProperty('--cal', c)
  return n
}

function notice(text, kind, extra) {
  const box = el('div', { class: `notice ${kind || ''}` })
  const body = el('div', { class: 'text' })
  body.textContent = text
  if (extra) body.append(extra)
  box.append(body)
  return box
}

// The paste box lives across redraws (every state message rebuilds the page): a redraw must not
// throw away what the person pasted, nor the focus.
const pasteBox = el('textarea', { id: 'paste', spellcheck: 'false', 'aria-label': 'Paste the client file', placeholder: '{"installed":{"client_id":"…apps.googleusercontent.com","client_secret":"…", …}}' })

function renderNotices() {
  const box = $('notices')
  box.replaceChildren()
  if (state.tooOld) {
    box.append(notice(state.tooOld))
    return
  }
  if (state.choose) {
    const tabs = el('div', { class: 'tabs' })
    for (const t of state.choose.tabs) tabs.append(button(t.label, () => post('discuss', { key: state.choose.key, tabId: t.tabId }), `status: ${t.status}`))
    tabs.append(button('Cancel', () => post('dismiss')))
    box.append(notice(`Discuss ${state.choose.label} in which Claude tab?`, 'info', tabs))
  }
  if (state.notice) {
    const n = notice(state.notice.text, state.notice.kind === 'error' ? '' : 'info')
    n.append(button('✕', () => post('dismiss'), 'Dismiss'))
    box.append(n)
  }
  if (!state.auth || !state.auth.signedIn) return
  if (state.blocked) {
    const again = el('div', { class: 'tabs' })
    again.append(button('Sign in again', () => post('signIn'), 'Opens the Google sign-in in your browser'))
    again.append(button('Sign out', () => post('signOut'), 'Deletes the stored Google sign-in of this project'))
    box.append(notice(state.blocked, '', again))
    return
  }
  if (state.error) box.append(notice(state.lastPoll ? `${state.error} The agenda is as of ${state.lastPollText}.` : state.error))
  for (const e of state.calendarErrors || []) box.append(notice(`${e.calendar}: ${e.message} (its last events are shown)`, 'info'))
  for (const id of state.missingCalendars || []) box.append(notice(`${id} (calendars setting) is not in your calendar list: subscribe to it in Google Calendar, or fix the setting.`, 'info'))
  for (const n of state.notes || []) box.append(notice(n, 'info'))
  for (const p of state.problems || []) box.append(notice(p, 'info'))
}

/** The setup guide: what is missing, the steps with their console links, the paste box, Sign in. */
function renderSetup() {
  const box = $('setup')
  const hadFocus = document.activeElement === pasteBox
  box.replaceChildren()
  if (state.tooOld || !state.auth || state.auth.signedIn) return
  const a = state.auth
  const s = el('div', { class: 'setup' })
  if (a.signedOutReason) s.append(notice(a.signedOutReason))
  if (a.client) {
    const c = el('div', { class: 'client' })
    c.append(el('div', { text: `OAuth client: ${a.client.id} (${a.client.source === 'pasted' ? 'pasted client file' : 'from the settings'})` }))
    const row = el('div', { class: 'row' })
    if (a.signingIn) {
      row.append(el('span', { class: 'waiting', text: 'Waiting for the browser…' }))
      row.append(button('Start over', () => post('signIn'), 'Cancels the open sign-in and opens a new one in your browser', 'link'))
    } else {
      row.append(button(a.signedOutReason ? 'Sign in again' : 'Sign in with Google', () => post('signIn'), 'Opens the Google sign-in in your browser', 'primary'))
    }
    if (a.pasted) row.append(button('Remove pasted client', () => post('removeClient'), 'Forget the pasted client file (the settings fields are used again)', 'link'))
    c.append(row)
    if (a.signingIn) {
      c.append(el('div', { class: 'muted', text: 'Finish the sign-in in your browser. Google asks to let the app see your calendar list and events, and change events on calendars you own: the plugin only ever writes your own answer to an invitation.' }))
      // The usual dead ends: a Testing app this account is not a test user of; the unverified screen.
      const hint = el('div', { class: 'muted hint', text: 'Google says "Access blocked" or "has not completed the Google verification process"? On the Audience page set the user type to Internal (Workspace), or Publish app (personal account), or add this account as a test user, then Start over. "Google hasn\'t verified this app": Advanced > Go to <your app name>. ' })
      hint.append(button('Audience ↗', () => post('link', { id: 'audience' }), 'Opens the Google Cloud console in your browser', 'link'))
      c.append(hint)
    }
    s.append(c)
  }
  for (const m of a.settingsMissing || []) s.append(el('p', { class: 'error', text: `${m} is not set: Settings > This project > Google Calendar (or paste the client file below).` }))
  if (a.pastedBroken) s.append(el('p', { class: 'error', text: a.pastedBroken }))
  for (const p of state.problems || []) s.append(el('p', { class: 'error', text: p }))
  s.append(el('h2', { text: a.client ? 'Set up (done once)' : 'Set up Google Calendar: your own Google OAuth client' }))
  const ol = el('ol')
  for (const step of state.steps || []) {
    const li = el('li', { text: step.text })
    if (step.links && step.links.length) {
      const links = el('span', { class: 'links' })
      for (const l of step.links) links.append(button(`${l.label} ↗`, () => post('link', { id: l.id }), 'Opens the Google Cloud console in your browser', 'link'))
      li.append(links)
    }
    ol.append(li)
  }
  s.append(ol)
  s.append(el('div', { class: 'muted', text: 'Paste the client file (the JSON Google downloads for a Desktop app client):' }))
  s.append(pasteBox)
  const row = el('div', { class: 'row' })
  row.append(button('Save client', () => {
    savePending = true
    post('client', { text: pasteBox.value.slice(0, 65536) })
  }, 'Kept in this project\'s plugin storage; the sign-in itself goes to the OS keychain', a.client ? '' : 'primary'))
  row.append(button('More help (README)', () => post('link', { id: 'readme' }), 'The README: the same steps in more words, privacy notes', 'link'))
  s.append(row)
  if (state.clientError) s.append(el('p', { class: 'error', text: state.clientError }))
  box.append(s)
  if (hadFocus) pasteBox.focus({ preventScroll: true })
}

// ---- the agenda ----

function rowActions(r) {
  const a = el('div', { class: 'actions' })
  for (const b of rowButtons(r)) {
    const n = button(b.label, () => post(b.action, { key: r.key }), b.title, b.primary ? 'primary' : '')
    n.dataset.action = b.action
    n.setAttribute('aria-label', `${b.title}: ${r.title}`)
    a.append(n)
  }
  return a
}

function rowEls() {
  return [...document.querySelectorAll(ROWS)]
}

function onRowKey(ev, r, li) {
  const act = rowKeyAction(ev.key, ev.target === li, { alt: ev.altKey, ctrl: ev.ctrlKey, meta: ev.metaKey })
  if (!act) return
  ev.preventDefault()
  if (act === 'open') return post('open', { key: r.key })
  const rows = rowEls()
  const to = moveIndex(act, rows.indexOf(li), rows.length)
  if (to !== null) rows[to].focus()
}

/** The marks after a title: Meet, the answer, a conflict, Jira chips. */
function marks(line, r) {
  if (r.join) line.append(el('span', { class: 'cam', text: '▶', title: 'Has a Google Meet link' }))
  const m = responseMark(r.response)
  line.append(el('span', { class: 'mark', text: m, title: responseTitle(r.response) }))
  if (r.conflicts && r.conflicts.length) line.append(el('span', { class: 'warn', text: '⚠', title: r.conflicts.map((c) => `Overlaps ${c.title} ${c.time}`).join('\n') }))
  for (const j of r.jira || []) line.append(el('span', { class: 'pill', text: j, title: 'Jira issue named in the event' }))
}

function eventRow(r, { compact = false, invitation = false } = {}) {
  const cls = ['row']
  if (compact) cls.push('compact')
  if (r.running) cls.push('running')
  if (r.past && !r.running) cls.push('past')
  if (r.response === 'declined') cls.push('declined')
  if (r.type === 'focusTime') cls.push('muted-row')
  if (r.pending) cls.push('pending')
  const li = colour(el('li', {
    class: cls.join(' '),
    tabindex: '0',
    'aria-label': `${r.time} ${r.title}${r.calendar ? `, ${r.calendar}` : ''}. Enter opens it.`,
    title: `${r.title}\n${r.time}${r.location ? ` · ${r.location}` : ''}\n${r.calendar}${r.organizer ? ` · organized by ${r.organizer}` : ''}\nClick to open${state.annotate ? ' (notes, Discuss, New session)' : ''}`,
  }), r.color)
  li.dataset.key = r.key
  li.addEventListener('click', (ev) => {
    const inControl = Boolean(ev.target.closest && ev.target.closest('button'))
    const sel = window.getSelection && window.getSelection()
    if (rowClickOpens(inControl, Boolean(sel && !sel.isCollapsed && li.contains(sel.anchorNode)))) post('open', { key: r.key })
  })
  li.addEventListener('keydown', (ev) => onRowKey(ev, r, li))
  const line = el('div', { class: 'line' })
  const time = compact ? r.line.split(' · ').slice(0, 2).join(' · ') : invitation ? r.when : r.time
  line.append(el('span', { class: 'time', text: time, title: invitation ? r.when : r.time }), el('span', { class: 'title', text: r.title }))
  if (r.type === 'outOfOffice') line.append(el('span', { class: 'pill', text: 'out of office' }))
  marks(line, r)
  li.append(line)
  if (invitation) {
    const sub = [r.organizer ? `from ${r.organizer}` : '', r.calendar].filter(Boolean).join(' · ')
    if (sub) li.append(el('div', { class: 'sub', text: sub }))
    if (r.conflicts && r.conflicts.length) li.append(el('div', { class: 'sub warn', text: `⚠ overlaps ${r.conflicts.map((c) => `${c.title} ${c.time}`).join(', ')}` }))
    li.append(rsvpRow(r))
  } else if (!compact && r.location) {
    li.append(el('div', { class: 'sub', text: r.location }))
  }
  li.append(rowActions(r))
  return li
}

/** Accept / Maybe / Decline (and, on a recurring invitation, the "this one only" toggle). */
function rsvpRow(r) {
  const box = el('div', { class: 'rsvp' })
  if (!state.rsvpOn) {
    box.append(el('span', { class: 'note', text: state.rsvpText }))
    box.append(button('Sign in again', () => post('signIn'), 'Opens the Google sign-in in your browser', 'link'))
    return box
  }
  const one = oneOpen.has(r.key)
  for (const b of rsvpButtons(r, { rsvpOn: state.rsvpOn, one })) {
    const n = button(b.label, () => post('rsvp', { key: r.key, answer: b.answer, one }), b.title, b.answer === 'accepted' ? 'primary' : '')
    n.dataset.action = `rsvp-${b.answer}`
    if (b.disabled) n.disabled = true
    box.append(n)
  }
  if (r.series) {
    const t = button(one ? 'whole series' : 'this one only', () => {
      if (one) oneOpen.delete(r.key)
      else oneOpen.add(r.key)
      render()
    }, one ? 'Answer the whole series again' : 'Answer only the next occurrence', 'link')
    t.dataset.action = 'one'
    box.append(t)
  }
  if (r.pending) box.append(el('span', { class: 'note', text: 'sending…' }))
  return box
}

/**
 * The day strip (the old cockpit's now bar): today in 30-min cells (busy, not answered, free), the
 * now marker, a small hour scale, and "Next: <title> in 40 min · 4 left today".
 */
function dayStrip(v) {
  const timed = timedOf(v.today)
  const { lo, hi } = dayRange(timed)
  const box = el('div', { class: 'daystrip' })
  const wrap = el('div', { class: 'stripbox' })
  const strip = el('div', { class: 'strip', role: 'img', 'aria-label': `Today ${hourText(lo)} to ${hourText(hi)} in half hours: blue busy, striped not answered, grey free` })
  const words = { busy: 'busy', unanswered: 'not answered', free: 'free' }
  stripCells(timed, lo, hi).forEach((c, i) => {
    const a = lo + i * TL_STEP
    strip.append(el('i', { class: c === 'busy' ? 'b' : c === 'unanswered' ? 'u' : '', title: `${hourText(a)}–${hourText(Math.min(hi, a + TL_STEP))} ${words[c]}` }))
  })
  const mark = el('div', { class: 'now', title: 'Now' })
  wrap.append(strip, mark)
  const scale = el('div', { class: 'scale', 'aria-hidden': 'true' })
  stripScale(lo, hi).forEach((t, i, all) => {
    const n = el('span', { class: i === 0 ? 'first' : i === all.length - 1 ? 'last' : '', text: t.text })
    if (i > 0 && i < all.length - 1) n.style.left = `${t.pct}%`
    scale.append(n)
  })
  const next = el('div', { class: 'stripnext' })
  box.append(wrap, scale, next)
  live.strip = { mark, next, lo, hi, timed, clock: v.today.clock }
  return box
}

/** The strip's Next line at `now`: the title in bold (textContent), then the countdown and the count. */
function drawStripNext(now) {
  const s = live.strip
  if (!s) return
  const n = stripNext(s.timed, now)
  s.next.replaceChildren()
  if (!n.row) {
    s.next.textContent = 'No more meetings today.'
    return
  }
  s.next.append('Next: ', el('b', { text: n.row.title }), ` ${stripNextText(n, now)}`)
}

function nowNextCard(v) {
  const now = Date.now()
  const card = el('div', { class: 'card' })
  card.append(dayStrip(v))
  let any = false
  if (v.ooo) {
    card.append(el('div', { class: 'what ooo', text: `Out of office until ${v.ooo.untilText}` }))
    any = true
  }
  for (const r of v.now) {
    const w = colour(el('div', { class: 'what' }), r.color)
    w.append(el('span', { class: 'label', text: 'Now' }), el('span', { class: 'title', text: r.title, title: r.title }), el('span', { class: 'count', 'data-end': String(r.end), text: `ends in ${spanText(r.end - now)}` }))
    if (r.join) w.append(button('Join', () => post('join', { key: r.key }), `Join ${r.title} (Google Meet)`, 'primary'))
    w.addEventListener('click', () => post('open', { key: r.key }))
    card.append(w)
    const bar = el('div', { class: 'bar' })
    const fill = el('span')
    fill.dataset.start = String(r.start)
    fill.dataset.endAt = String(r.end)
    fill.style.width = `${Math.round(progress(r.start, r.end, now) * 100)}%`
    bar.append(fill)
    card.append(bar)
    any = true
  }
  const n = v.next
  if (n) {
    const w = el('div', { class: 'what' })
    w.append(el('span', { class: 'label', text: 'Next' }), el('span', { class: 'title', text: n.title, title: `${n.title}\n${n.calendar}` }))
    w.append(el('span', { class: 'when', text: `${n.dayLabel === 'today' ? '' : `${n.dayLabel} `}${n.time}` }))
    w.append(el('span', { class: 'count', 'data-start': String(n.start), text: countdownText(n.start, now) }))
    const m = responseMark(n.response)
    if (m) w.append(el('span', { class: 'mark', text: m, title: responseTitle(n.response) }))
    if (n.conflicts && n.conflicts.length) w.append(el('span', { class: 'warn', text: '⚠', title: n.conflicts.map((c) => `Overlaps ${c.title} ${c.time}`).join('\n') }))
    if (n.join) {
      const b = button('Join', () => post('join', { key: n.key }), n.joinable ? `Join ${n.title} (Google Meet)` : `Join opens ${n.title} (Google Meet); it is not time yet`, n.joinable ? 'primary' : '')
      w.append(b)
    }
    w.addEventListener('click', () => post('open', { key: n.key }))
    if (n.joinable && !v.now.length) card.classList.add('soon')
    card.append(w)
    any = true
  }
  if (!any) card.append(el('div', { class: 'muted', text: 'No meetings in the next days.' }))
  return card
}

/** A day's all-day chips (working location, out of office, birthdays, holidays). */
function chipsOf(d) {
  const chips = el('div', { class: 'chips' })
  for (const c of d.chips) {
    const n = colour(el('span', { class: 'chip', tabindex: '0', text: `${c.title}${c.time && c.time !== 'all day' ? ` (${c.time})` : ''}`, title: `${c.title}\n${c.time}\n${c.calendar}` }), c.color)
    n.addEventListener('click', () => post('open', { key: c.key }))
    n.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') post('open', { key: c.key })
    })
    chips.append(n)
  }
  return chips
}

function daySection(title, d) {
  const s = el('section')
  const head = el('div', { class: 'head' })
  head.append(el('span', { text: title }), el('span', { class: 'count', text: d.label }), el('span', { class: 'grow' }))
  s.append(head)
  if (d.chips.length) s.append(chipsOf(d))
  const ul = el('ul', { class: 'rows' })
  for (const r of d.rows) ul.append(eventRow(r))
  s.append(ul)
  if (!d.rows.length && !d.chips.length) s.append(el('p', { class: 'empty', text: 'Nothing.' }))
  return s
}

/**
 * One block of the timeline: a focusable element (click or Enter opens the event, as a row), its
 * start and title (ellipsized), the note ("now · 12 min left", "? not answered", "⚠ overlaps"; on a
 * second line when the block is tall enough) and Join on a Meet event.
 */
function timelineBlock(b) {
  const r = b.row
  const look = laneLook(b.lanes)
  const st = blockState(r, Date.now())
  const tall = b.height >= 36
  const extra = [tall && 'tall', look.dense && 'dense'].filter(Boolean)
  const n = colour(el('div', {
    class: [...st.cls, ...extra].join(' '),
    tabindex: '0',
    'aria-label': `${r.time} ${r.title}, ${st.note}. Enter opens it.`,
    title: `${r.title}\n${r.time}${r.location ? ` · ${r.location}` : ''}\n${r.calendar}${r.organizer ? ` · organized by ${r.organizer}` : ''}\nClick to open`,
  }), r.color)
  n.dataset.key = r.key
  n.style.top = `${b.top.toFixed(1)}px`
  n.style.height = `${b.height.toFixed(1)}px`
  n.style.left = `calc(4px + (100% - 6px) * ${b.lane} / ${b.lanes})`
  n.style.width = `calc((100% - 6px) / ${b.lanes} - 2px)`
  n.addEventListener('click', (ev) => {
    const inControl = Boolean(ev.target.closest && ev.target.closest('button'))
    const sel = window.getSelection && window.getSelection()
    if (rowClickOpens(inControl, Boolean(sel && !sel.isCollapsed && n.contains(sel.anchorNode)))) post('open', { key: r.key })
  })
  n.addEventListener('keydown', (ev) => onRowKey(ev, r, n))
  const l1 = el('div', { class: 'l1' })
  l1.append(el('span', { class: 't', text: r.continued ? '…' : hourText(r.from) }), el('span', { class: 'title', text: r.title }))
  const note = el('span', { class: st.hot ? 's hot' : 's', text: st.note })
  if (!tall) l1.append(note)
  let join = null
  if (r.join) {
    join = button(look.narrow ? '▶' : 'Join', () => post('join', { key: r.key }), `Join ${r.title} (Google Meet)`, r.joinable ? 'join primary' : 'join')
    join.dataset.action = 'join'
    join.setAttribute('aria-label', `Join ${r.title} (Google Meet)`)
    join.hidden = !st.join
    l1.append(join)
  }
  n.append(l1)
  if (tall) n.append(note)
  live.blocks.push({ el: n, note, join, row: r, extra })
  return n
}

/**
 * Today as the old cockpit's hour timeline: the header with tomorrow's look ahead, the all-day
 * chips, then the hours down the side with the events as blocks sized by their length, overlaps side
 * by side, and the red now line.
 */
function todaySection(v) {
  const d = v.today
  const s = el('section', { class: 'today' })
  const head = el('div', { class: 'head' })
  const tom = tomorrowText(v.tomorrow)
  head.append(el('span', { text: 'Today' }), el('span', { class: 'count', text: d.label }), el('span', { class: 'grow' }), el('span', { class: 'tom', text: tom, title: tom }))
  s.append(head)
  if (d.chips.length) s.append(chipsOf(d))
  const timed = timedOf(d)
  if (!timed.length) {
    if (!d.chips.length) s.append(el('p', { class: 'empty', text: 'No events today.' }))
    return s
  }
  const { lo, hi } = dayRange(timed)
  const tl = el('div', { class: 'tl' })
  tl.style.height = `${((hi - lo) / 60) * TL_PX}px`
  for (let m = lo; m < hi; m += 60) tl.append(el('div', { class: 'hr' }, el('span', { text: hourText(m) })))
  const end = el('div', { class: 'hr end' }, el('span', { text: hourText(hi) }))
  tl.append(end)
  for (const b of placeBlocks(timed, lo)) tl.append(timelineBlock(b))
  const line = el('div', { class: 'nowline', 'aria-hidden': 'true' })
  tl.append(line)
  live.line = { el: line, lo, hi, clock: d.clock }
  s.append(tl)
  return s
}

/** The live part between state messages: the now marker and line, the blocks' state, the Next line. */
function updateLive(now) {
  const st = live.strip
  if (st) {
    const pct = nowPct(nowMinute(st.clock, now), st.lo, st.hi)
    st.mark.hidden = pct === null
    if (pct !== null) st.mark.style.left = `${pct.toFixed(2)}%`
    drawStripNext(now)
  }
  const ln = live.line
  if (ln) {
    const top = nowTop(nowMinute(ln.clock, now), ln.lo, ln.hi)
    ln.el.hidden = top === null
    if (top !== null) ln.el.style.top = `${top.toFixed(1)}px`
  }
  for (const b of live.blocks) {
    const s = blockState(b.row, now)
    b.el.className = [...s.cls, ...b.extra].join(' ')
    b.note.textContent = s.note
    b.note.className = s.hot ? 's hot' : 's'
    if (b.join) b.join.hidden = !s.join
  }
}

function renderAgenda() {
  const box = $('agenda')
  box.replaceChildren()
  live = { blocks: [] }
  if (state.tooOld || !state.auth || !state.auth.signedIn || state.blocked) return
  const v = state.view
  if (!v) {
    box.append(el('p', { class: 'empty', text: state.polling ? 'Reading your calendar…' : 'No poll yet.' }))
    return
  }
  box.append(nowNextCard(v))
  if (v.invitations.length) {
    const s = el('section')
    const head = el('div', { class: 'head' })
    head.append(el('span', { text: 'Invitations' }), el('span', { class: 'count', text: String(v.invitations.length) }))
    s.append(head)
    const ul = el('ul', { class: 'rows' })
    for (const r of v.invitations) ul.append(eventRow(r, { invitation: true }))
    s.append(ul)
    box.append(s)
  }
  box.append(todaySection(v))
  box.append(daySection('Tomorrow', v.tomorrow))
  const s = el('section')
  const head = el('div', { class: 'head' })
  head.append(el('span', { text: 'Upcoming' }), el('span', { class: 'count', text: `next ${v.upcoming.days} days` }))
  s.append(head)
  const ul = el('ul', { class: 'rows' })
  for (const r of v.upcoming.rows) ul.append(eventRow(r, { compact: true }))
  s.append(ul)
  if (!v.upcoming.rows.length) s.append(el('p', { class: 'empty', text: 'Nothing after tomorrow.' }))
  if (v.upcoming.more) s.append(el('p', { class: 'empty', text: `${v.upcoming.more} more in the next ${v.upcoming.days} days (ccc calendar upcoming).` }))
  box.append(s)
}

function renderFooter() {
  const f = $('footer')
  f.replaceChildren()
  if (state.tooOld || !state.auth || !state.auth.signedIn) return
  if (state.zoneNote) f.append(el('div', { text: state.zoneNote }))
  if (state.calendars && state.calendars.length) {
    const d = el('div')
    d.append(button(`${state.ui.calendarsOpen ? '▾' : '▸'} Calendars (${state.calendars.filter((c) => c.on).length} of ${state.calendars.length} shown)`, () => post('toggleCalendars'), 'Choose which of your calendars the panel shows', 'link'))
    if (state.ui.calendarsOpen) {
      const ul = el('ul', { class: 'cals' })
      for (const c of state.calendars) {
        const li = colour(el('li'), c.color)
        li.append(el('span', { class: 'swatch' }), el('span', { class: 'name', text: c.name, title: c.id }))
        if (c.from === 'primary') li.append(el('span', { class: 'muted', text: 'primary' }))
        else if (c.from === 'settings') li.append(el('span', { class: 'muted', text: 'in the settings', title: 'Shown by the calendars setting: change it there' }))
        else {
          const b = button(c.on ? 'shown' : 'show', () => post('pick', { id: c.id }), c.on ? 'Hide this calendar' : 'Show this calendar', c.on ? 'on' : '')
          b.setAttribute('aria-pressed', String(c.on))
          li.append(b)
        }
        ul.append(li)
      }
      d.append(ul)
    }
    f.append(d)
  }
  const last = el('div', { text: `Changes nothing in Google Calendar but your answers to invitations. ${state.account ? `Signed in as ${state.account}` : 'Signed in'}${state.auth.sessionOnly ? ' (until the app closes)' : ''}${state.lastPoll ? ` · as of ${state.lastPollText}` : ''}. ` })
  last.append(button('Sign out', () => post('signOut'), 'Deletes the stored Google sign-in of this project', 'link'))
  f.append(last)
}

/** Where the keyboard focus is, as `{ key, action }`, so a redraw can put it back. */
function focusSpot() {
  const a = document.activeElement
  if (!a || a === document.body) return null
  const row = a.closest && a.closest(ROWS)
  if (!row) return null
  return { key: row.dataset.key, action: a === row ? null : a.dataset.action || null }
}

function restoreFocus(spot) {
  if (!spot) return
  const row = rowEls().find((x) => x.dataset.key === spot.key)
  if (!row) return
  const target = spot.action ? row.querySelector(`button[data-action="${spot.action}"]`) : null
  ;(target || row).focus({ preventScroll: true })
}

function render() {
  if (!state) return
  const spot = focusSpot()
  renderNotices()
  renderSetup()
  renderAgenda()
  renderFooter()
  restoreFocus(spot)
  updateLive(Date.now())
  schedule()
}

/** The countdowns between state messages: only the texts and bars change, nothing is rebuilt. */
function updateCountdowns() {
  const now = Date.now()
  for (const n of document.querySelectorAll('[data-start].count')) n.textContent = countdownText(Number(n.dataset.start), now)
  for (const n of document.querySelectorAll('[data-end].count')) n.textContent = `ends in ${spanText(Number(n.dataset.end) - now)}`
  for (const n of document.querySelectorAll('.bar > span')) n.style.width = `${Math.round(progress(Number(n.dataset.start), Number(n.dataset.endAt), now) * 100)}%`
  updateLive(now)
  schedule()
}

function schedule() {
  if (timer) clearTimeout(timer)
  const v = state && state.view
  if (!v) return
  const times = [...v.now.map((r) => r.end), ...(v.next ? [v.next.start] : [])]
  timer = setTimeout(updateCountdowns, redrawDelay(times, Date.now()))
}

ccPanel.onMessage((m) => {
  if (!m || m.type !== 'state') return
  state = m
  if (savePending && !state.clientError) {
    savePending = false
    pasteBox.value = ''
  } else if (state.clientError) savePending = false
  // A series answered or gone: its "this one only" toggle goes with it.
  const keys = new Set(((state.view && state.view.invitations) || []).map((r) => r.key))
  oneOpen = new Set([...oneOpen].filter((k) => keys.has(k)))
  render()
})
post('hello')
