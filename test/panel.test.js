'use strict'
// The panel: its row decisions (panels/rowlogic.js, free of the DOM), the page sources' rules (no
// inline script, untrusted text only through textContent, keys never URLs), and main.js run against
// a tiny stand-in DOM with the host's real state messages (setup, the agenda with the day strip and
// the Today timeline, a series invitation's "this one only", the calendars picker), so a render that
// throws or a button that posts the wrong message shows up here. The timeline's own logic is in
// test/timeline.test.js.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const L = require('../panels/rowlogic')
const { boot, signedIn } = require('./helpers')
const { NOW } = require('./fakes')

const ROOT = path.join(__dirname, '..')

test('keys on a row: Enter and Space open, arrows move, modifiers and buttons are left alone', () => {
  assert.equal(L.rowKeyAction('Enter', true), 'open')
  assert.equal(L.rowKeyAction(' ', true), 'open')
  assert.equal(L.rowKeyAction('ArrowDown', true), 'next')
  assert.equal(L.rowKeyAction('ArrowUp', true), 'prev')
  assert.equal(L.rowKeyAction('Home', true), 'first')
  assert.equal(L.rowKeyAction('End', true), 'last')
  assert.equal(L.rowKeyAction('Enter', false), null, 'Enter on a button is its click')
  assert.equal(L.rowKeyAction('Enter', true, { meta: true }), null)
  assert.equal(L.rowKeyAction('x', true), null)
  assert.equal(L.rowClickOpens(false, false), true)
  assert.equal(L.rowClickOpens(true, false), false)
  assert.equal(L.rowClickOpens(false, true), false)
  assert.equal(L.moveIndex('next', 2, 3), null)
  assert.equal(L.moveIndex('next', 1, 3), 2)
  assert.equal(L.moveIndex('prev', 0, 3), null)
  assert.equal(L.moveIndex('last', 0, 3), 2)
  assert.equal(L.moveIndex('first', 2, 0), null)
})

test('row buttons: Join only with Meet (primary when joinable), ↗ only with a Calendar link, Discuss and New always', () => {
  assert.deepEqual(L.rowButtons({ title: 'x', join: true, joinable: true, link: true }).map((b) => [b.action, Boolean(b.primary)]), [['join', true], ['calendar', false], ['discuss', false], ['newSession', false]])
  assert.deepEqual(L.rowButtons({ title: 'x', join: true, joinable: false, link: false }).map((b) => [b.action, Boolean(b.primary)]), [['join', false], ['discuss', false], ['newSession', false]])
  assert.deepEqual(L.rowButtons({ title: 'x' }).map((b) => b.action), ['discuss', 'newSession'])
})

test('RSVP buttons: none without the scope, the series or this one in the title, disabled while on their way', () => {
  assert.deepEqual(L.rsvpButtons({}, { rsvpOn: false }), [])
  const plain = L.rsvpButtons({}, { rsvpOn: true })
  assert.deepEqual(plain.map((b) => [b.answer, b.label]), [['accepted', 'Accept'], ['tentative', 'Maybe'], ['declined', 'Decline']])
  assert.match(plain[0].title, /^Accept: the organizer is told$/)
  const series = L.rsvpButtons({ series: { id: 'w' } }, { rsvpOn: true, one: false })
  assert.match(series[2].title, /Decline the whole series/)
  const one = L.rsvpButtons({ series: { id: 'w' } }, { rsvpOn: true, one: true })
  assert.deepEqual(one.map((b) => b.label), ['Accept this one', 'Maybe this one', 'Decline this one'])
  assert.match(one[0].title, /this occurrence only/)
  assert.ok(L.rsvpButtons({ pending: true }, { rsvpOn: true }).every((b) => b.disabled))
})

test('marks, countdowns and the redraw pace', () => {
  assert.equal(L.responseMark('accepted'), '✓')
  assert.equal(L.responseMark('organizer'), '')
  assert.equal(L.responseTitle('needsAction'), 'You have not answered')
  assert.equal(L.countdownText(NOW + 12 * 60000, NOW), 'in 12 min')
  assert.equal(L.countdownText(NOW + 20000, NOW), 'now')
  assert.equal(L.countdownText(NOW - 3 * 60000, NOW), 'started 3 min ago')
  assert.equal(L.spanText(125 * 60000), '2 h 5 min')
  assert.equal(L.progress(NOW, NOW + 60000, NOW + 30000), 0.5)
  assert.equal(L.progress(NOW, NOW, NOW), 1)
  assert.equal(L.progress(NOW, NOW + 60000, NOW + 120000), 1)
  assert.equal(L.redrawDelay([NOW + 30000], NOW), 1000)
  assert.equal(L.redrawDelay([NOW + 5 * 60000], NOW), 15000)
  assert.equal(L.redrawDelay([], NOW), 15000)
})

test('the pages: no inline script, untrusted text never as markup', () => {
  for (const f of ['panels/main.html', 'panels/event.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(attrs, /src=/, `${f}: an inline script`)
      assert.equal(body.trim(), '')
    }
    assert.ok(!/\son[a-z]+=/i.test(html), `${f}: an inline handler`)
    assert.ok(!/<form/i.test(html), `${f}: a form (panels have no allow-forms)`)
  }
  const main = fs.readFileSync(path.join(ROOT, 'panels/main.js'), 'utf8')
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(main), 'main.js builds with textContent only')
  assert.ok(!/https?:\/\//.test(main.replace(/^\s*\/\/.*$/gm, '')), 'the page holds no URL: it posts keys and link ids')
  const reader = fs.readFileSync(path.join(ROOT, 'panels/event.js'), 'utf8')
  assert.match(reader, /function clean\(root\)/, 'the reader cleans the host html again')
})

// ---- main.js against a stand-in DOM ----

/** Just enough DOM for main.js: elements with text, attributes, children, listeners and a style. */
function fakeDom() {
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase()
      this.children = []
      this.parent = null
      this.attrs = {}
      this.listeners = {}
      this.dataset = {}
      this.className = ''
      this._text = ''
      this.disabled = false
      this.value = ''
      const props = {}
      this.style = { setProperty: (k, v) => (props[k] = v), props }
      this.classList = { add: (c) => (this.className = `${this.className} ${c}`.trim()) }
      this.hidden = false
    }
    set textContent(v) {
      this._text = String(v)
      this.children = []
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('')
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v)
    }
    getAttribute(k) {
      return this.attrs[k]
    }
    append(...xs) {
      for (const x of xs) {
        const n = typeof x === 'string' ? Object.assign(new El('#text'), { _text: x }) : x
        n.parent = this
        this.children.push(n)
      }
    }
    replaceChildren() {
      this.children = []
      this._text = ''
    }
    addEventListener(t, fn) {
      ;(this.listeners[t] = this.listeners[t] || []).push(fn)
    }
    click() {
      const ev = { target: this, stopPropagation: () => (ev.stopped = true), preventDefault() {} }
      for (let n = this; n && !ev.stopped; n = n.parent) for (const fn of n.listeners.click || []) fn(ev)
    }
    closest(sel) {
      for (let n = this; n; n = n.parent) if (matches(n, sel)) return n
      return null
    }
    all() {
      return [this, ...this.children.flatMap((c) => c.all())]
    }
    querySelectorAll(sel) {
      return this.all().slice(1).filter((n) => matches(n, sel))
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null
    }
    focus() {
      doc.activeElement = this
    }
  }
  function matches(n, sel) {
    if (sel.includes(', ')) return sel.split(', ').some((x) => matches(n, x))
    if (sel === '.ev') return n.tagName === 'DIV' && n.className.split(' ').includes('ev')
    if (sel === 'button') return n.tagName === 'BUTTON'
    if (sel === 'li.row') return n.tagName === 'LI' && n.className.split(' ').includes('row')
    let m = /^button\[data-action="([^"]+)"\]$/.exec(sel)
    if (m) return n.tagName === 'BUTTON' && n.dataset.action === m[1]
    if (sel === '.bar > span') return n.tagName === 'SPAN' && n.parent && n.parent.className === 'bar'
    m = /^\[data-(start|end)\]\.count$/.exec(sel)
    if (m) return n.className === 'count' && n.attrs[`data-${m[1]}`] !== undefined
    return false
  }
  const ids = {}
  for (const id of ['notices', 'setup', 'agenda', 'footer']) ids[id] = new El('div')
  const doc = {
    body: new El('body'),
    activeElement: null,
    createElement: (t) => new El(t),
    getElementById: (id) => ids[id],
    querySelectorAll: (sel) => Object.values(ids).flatMap((e) => e.querySelectorAll(sel)),
  }
  doc.activeElement = doc.body
  return { doc, ids }
}

function loadPanel() {
  const { doc, ids } = fakeDom()
  const posted = []
  let onMessage = null
  const timers = []
  const clock = { now: NOW }
  const ctx = {
    document: doc,
    window: { getSelection: () => null },
    ccPanel: { post: (m) => posted.push(structuredClone(m)), onMessage: (fn) => (onMessage = fn) },
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
    // The page's clock is the suite's (the host's state is of 09:00 Berlin on Tue 3 Nov).
    Date: class extends Date {
      static now() {
        return clock.now
      }
    },
    console,
  }
  vm.createContext(ctx)
  // In the page's order (main.html): rowlogic.js, timeline.js, main.js.
  for (const f of ['rowlogic.js', 'timeline.js', 'main.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'panels', f), 'utf8'), ctx, { filename: f })
  const buttons = (root, label) => root.all().filter((n) => n.tagName === 'BUTTON' && n.textContent === label)
  return { ids, posted, send: (m) => onMessage(structuredClone(m)), timers, buttons, clock }
}

test('main.js: says hello, draws the setup guide before a sign-in, and its buttons post link ids and the paste', async () => {
  const p = loadPanel()
  assert.deepEqual(p.posted, [{ type: 'hello' }])
  const b = boot()
  await b.h.ready
  await b.ctx.sendPanel({ type: 'hello' })
  p.send(b.ctx.lastState())
  const text = p.ids.setup.textContent
  assert.match(text, /Set up Google Calendar: your own Google OAuth client/)
  assert.match(text, /Enable the Google Calendar API/)
  p.buttons(p.ids.setup, 'Calendar API ↗')[0].click()
  assert.deepEqual(p.posted.at(-1), { type: 'link', id: 'calendarApi' })
  p.buttons(p.ids.setup, 'Save client')[0].click()
  assert.deepEqual(p.posted.at(-1), { type: 'client', text: '' })
  assert.equal(p.ids.agenda.children.length, 0)
})

test('main.js: the agenda over the example week: the strip, Next, Invitations, the Today timeline, Tomorrow, Upcoming, the picker', async () => {
  const b = await signedIn()
  const p = loadPanel()
  p.send(b.ctx.lastState())
  const agenda = p.ids.agenda.textContent
  assert.match(agenda, /NextStandup09:30–09:45in 30 min/)
  assert.match(agenda, /Invitations2/)
  assert.match(agenda, /Budget planning/)
  assert.match(agenda, /repeats · next Thu 5 10:00–10:30 · 2 in reach/)
  assert.match(agenda, /TodayTue 3 Nov/)
  // The day strip: the scale from the early sync's hour, the Next line (meetings only: not focus time).
  assert.match(agenda, /^07:0012:0016:0019:00Next: Standup in 30 min · 3 left today/)
  // Tomorrow's look ahead in the Today header, then the timeline: hours, blocks, past faded.
  assert.match(agenda, /TodayTue 3 NovTomorrow: 2 events, first 10:00 Customer demoHome07:0008:00/)
  const blocks = p.ids.agenda.querySelectorAll('.ev')
  assert.deepEqual(blocks.map((n) => n.textContent), ['07:00Early syncdone', '09:30Standupin 30 minJoin', '11:00Design review ACME-12Joinin 2 h · ⚠ overlaps', '11:30Vendor callin 2 h 30 min · ⚠ overlaps', '14:00Focus timein 5 h'])
  assert.deepEqual(blocks.map((n) => n.className), ['ev past', 'ev', 'ev tall', 'ev', 'ev focus tall'])
  // The clash side by side: two lanes; one hour is 46 px from 07:00.
  const [review, vendor] = [blocks[2], blocks[3]]
  assert.equal(review.style.left, 'calc(4px + (100% - 6px) * 0 / 2)')
  assert.equal(vendor.style.left, 'calc(4px + (100% - 6px) * 1 / 2)')
  assert.equal(review.style.top, '185.0px')
  assert.equal(blocks[0].style.height, '20.0px', 'a short block is 20 px tall')
  // The now line at 09:00 (two hours after 07:00) and the strip's marker (2 of 12 hours).
  const line = p.ids.agenda.all().find((n) => n.className === 'nowline')
  assert.equal(line.style.top, '92.0px')
  assert.equal(line.hidden, false)
  const mark = p.ids.agenda.all().find((n) => n.className === 'now')
  assert.equal(mark.style.left, '16.67%')
  // A block opens on a click and on Enter; its Join posts the key and does not open it too.
  blocks[1].click()
  assert.deepEqual(p.posted.at(-1), { type: 'open', key: blocks[1].dataset.key })
  const n = p.posted.length
  blocks[1].querySelector('button[data-action="join"]').click()
  assert.deepEqual(p.posted.slice(n), [{ type: 'join', key: blocks[1].dataset.key }])
  for (const fn of blocks[3].listeners.keydown) fn({ key: 'Enter', target: blocks[3], preventDefault() {} })
  assert.deepEqual(p.posted.at(-1), { type: 'open', key: blocks[3].dataset.key })
  assert.match(agenda, /TomorrowWed 4 Nov/)
  assert.match(agenda, /Upcomingnext 14 days/)
  assert.match(agenda, /Thu 5 · 10:00/)
  // Calendar colours as a custom property, never markup.
  const rows = p.ids.agenda.querySelectorAll('li.row')
  assert.ok(rows.length > 8)
  assert.ok(rows.every((r) => /^#[0-9a-f]{6}$/i.test(r.style.props['--cal'])))
  assert.ok(rows.every((r) => /^(series:)?[a-f0-9]{16}$/.test(r.dataset.key)))
  assert.ok(blocks.every((r) => r.style.props['--cal'] === '#4285f4' && /^[a-f0-9]{16}$/.test(r.dataset.key)))
  // A row click opens it; its ↗ posts the key, not a URL.
  const demo = rows.find((r) => r.textContent.includes('Customer demo'))
  demo.click()
  assert.deepEqual(p.posted.at(-1), { type: 'open', key: demo.dataset.key })
  demo.querySelector('button[data-action="calendar"]').click()
  assert.deepEqual(p.posted.at(-1), { type: 'calendar', key: demo.dataset.key })
  // The countdown is redrawn on the page's own clock.
  assert.ok(p.timers.length >= 1)
  // The footer: the zone note (when the computer differs), the picker fold, the account.
  const foot = p.ids.footer.textContent
  assert.match(foot, /Calendars \(1 of 4 shown\)/)
  assert.match(foot, /Signed in as me@example\.com/)
  p.ids.footer.all().find((n) => n.tagName === 'BUTTON' && /Calendars/.test(n.textContent)).click()
  assert.deepEqual(p.posted.at(-1), { type: 'toggleCalendars' })
})

test('main.js: a series invitation\'s "this one only" switches its buttons; an answer posts the key, the answer and one', async () => {
  const b = await signedIn()
  const p = loadPanel()
  p.send(b.ctx.lastState())
  const series = () => p.ids.agenda.querySelectorAll('li.row').find((r) => r.dataset.key.startsWith('series:'))
  const key = series().dataset.key
  p.buttons(series(), 'Decline')[0].click()
  assert.deepEqual(p.posted.at(-1), { type: 'rsvp', key, answer: 'declined', one: false })
  p.buttons(series(), 'this one only')[0].click()
  p.buttons(series(), 'Accept this one')[0].click()
  assert.deepEqual(p.posted.at(-1), { type: 'rsvp', key, answer: 'accepted', one: true })
  assert.equal(p.buttons(series(), 'whole series').length, 1)
  // A single invitation has no such toggle.
  const single = p.ids.agenda.querySelectorAll('li.row').find((r) => r.textContent.includes('Budget planning') && r.querySelector('button[data-action="rsvp-accepted"]'))
  assert.equal(p.buttons(single, 'this one only').length, 0)
})

test('main.js: the picker lists the calendars and posts a pick by id; no RSVP scope: the lane says how to get it', async () => {
  const b = await signedIn({ oauthOpts: { scope: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'] } })
  await b.ctx.sendPanel({ type: 'toggleCalendars' })
  const p = loadPanel()
  p.send(b.ctx.lastState())
  const foot = p.ids.footer.textContent
  assert.match(foot, /Acme Team/)
  assert.match(foot, /primary/)
  p.buttons(p.ids.footer, 'show')[0].click()
  assert.deepEqual(p.posted.at(-1), { type: 'pick', id: 'acme-team@group.calendar.google.com' })
  assert.match(p.ids.agenda.textContent, /Sign in again to answer invitations/)
  assert.equal(p.ids.agenda.all().filter((n) => n.tagName === 'BUTTON' && n.textContent === 'Accept').length, 0)
})

test('main.js: between state messages the now line, the marker and the blocks move on the page clock, nothing rebuilt', async () => {
  const b = await signedIn()
  const p = loadPanel()
  p.send(b.ctx.lastState())
  const before = p.ids.agenda.querySelectorAll('.ev')
  p.clock.now = NOW + 35 * 60000 // 09:35: the standup runs
  p.timers.at(-1).fn()
  const blocks = p.ids.agenda.querySelectorAll('.ev')
  assert.ok(blocks.every((n, i) => n === before[i]), 'the same elements')
  assert.equal(blocks[1].className, 'ev cur')
  assert.equal(blocks[1].textContent, '09:30Standupnow · 10 min leftJoin')
  assert.equal(p.ids.agenda.all().find((n) => n.className === 'nowline').style.top, '118.8px')
  assert.match(p.ids.agenda.textContent, /Next: Design review ACME-12 in 1 h 25 min · 2 left today/)
  p.clock.now = NOW + 50 * 60000 // 09:50: over, Join gone
  p.timers.at(-1).fn()
  assert.equal(blocks[1].className, 'ev past')
  assert.equal(blocks[1].querySelector('button[data-action="join"]').hidden, true)
  p.clock.now = NOW + 11 * 3600000 // 20:00: after the timeline's 19:00, the line and the marker hide
  p.timers.at(-1).fn()
  assert.equal(p.ids.agenda.all().find((n) => n.className === 'nowline').hidden, true)
  assert.equal(p.ids.agenda.all().find((n) => n.className === 'now').hidden, true)
  assert.match(p.ids.agenda.textContent, /No more meetings today\./)
})

test('main.js: an empty day says so and draws no timeline; the strip is still there, all free', async () => {
  const b = await signedIn()
  const p = loadPanel()
  const m = structuredClone(b.ctx.lastState())
  m.view.today.rows = []
  m.view.today.chips = []
  m.view.tomorrow.rows = []
  m.view.tomorrow.chips = []
  p.send(m)
  const agenda = p.ids.agenda.textContent
  assert.match(agenda, /^08:0012:0016:0019:00No more meetings today\./)
  assert.match(agenda, /TodayTue 3 NovTomorrow: nothingNo events today\./)
  assert.equal(p.ids.agenda.querySelectorAll('.ev').length, 0)
  const cells = p.ids.agenda.all().filter((n) => n.tagName === 'I')
  assert.equal(cells.length, 22)
  assert.ok(cells.every((c) => c.className === ''))
})
