'use strict'
// Answering an invitation (design "RSVP", the plugin's only write): which event the answer goes to
// (the series or one occurrence), the bound on the calls, and the optimistic record the panel shows
// while the call runs. No I/O here; the host passes the Calendar call (client.rsvp: events.patch
// with http.rsvpBody and sendUpdates=all, nothing else).
//
// - The target: an occurrence of a recurring invitation answers the whole series by default (the
//   patch goes to `recurringEventId`: what a new weekly invite asks; decision 5), the occurrence alone
//   with `one`. Only an event on the primary calendar (the copy the person owns) with an attendee
//   entry of the person's that is not the organizer: anything else is refused before a call.
// - The bound: at most 4 calls at once and 60 started in any 60 s (bronos.gmail's write gate). After
//   `stop` (the host deactivates) nothing more starts.
// - The optimistic record: target -> { answer, cal, id, series, state: 'pending' | 'done', doneAt }.
//   layout.withPending shows the answer at once (the row leaves Invitations); a failure deletes the
//   record (the row is back) and the host says why; a record that succeeded stays until a poll that
//   started after it has read Google again.

const WRITE_CONCURRENCY = 4
const WRITE_PER_MINUTE = 60
const MAX_QUEUED = 100
const WINDOW_MS = 60000

const WORDS = { yes: 'accepted', accept: 'accepted', accepted: 'accepted', no: 'declined', decline: 'declined', declined: 'declined', maybe: 'tentative', tentative: 'tentative' }
const SAID = { accepted: 'Accepted', tentative: 'Maybe', declined: 'Declined' }

/** An answer word (`yes`, `no`, `maybe`, or Google's own) as Google's responseStatus, or null. */
function answerOf(word) {
  const w = String(word || '').toLowerCase()
  return Object.prototype.hasOwnProperty.call(WORDS, w) ? WORDS[w] : null
}

/**
 * Where an answer to an event goes: `{ cal, id, series, email, target }` or `{ error }`. `target` is
 * the record's key (one per series or occurrence, so two answers to one series wait for each other).
 */
function planRsvp(ev, { one = false } = {}) {
  if (!ev) return { error: 'That event is not in the last poll: refresh, then try again.' }
  if (!ev.primary) return { error: 'Only invitations on your primary calendar can be answered from here (that copy is yours).' }
  if (ev.response === 'organizer') return { error: 'You organize this event: there is nothing to answer.' }
  if (!ev.selfEmail || ev.response === 'none') return { error: 'Not an invitation: you are not among its guests.' }
  const series = Boolean(ev.recurring) && !one
  const id = series ? ev.recurring : ev.id
  return { cal: ev.calendarId, id, series, email: ev.selfEmail, target: `${series ? 'series' : 'one'}:${ev.calendarId}:${id}` }
}

class GateStopped extends Error {
  constructor() {
    super('the plugin is stopping: nothing was answered')
    this.name = 'GateStopped'
    this.kind = 'stopped'
  }
}

/**
 * A queue that runs `fn`s with at most `concurrency` at once and `perMinute` started in any minute
 * (bronos.gmail's readstate.createGate).
 *
 * @param {object} [o]
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep] waits (tests pass a fake clock's)
 */
function createGate(o = {}) {
  const now = o.now || Date.now
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const concurrency = o.concurrency || WRITE_CONCURRENCY
  const perMinute = o.perMinute || WRITE_PER_MINUTE
  const maxQueued = o.maxQueued || MAX_QUEUED
  const queue = []
  const starts = [] // start times inside the last minute
  let running = 0
  let pumping = false
  let stopped = false

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length && running < concurrency && !stopped) {
        while (starts.length && now() - starts[0] >= WINDOW_MS) starts.shift()
        if (starts.length >= perMinute) {
          await sleep(Math.max(1, WINDOW_MS - (now() - starts[0])))
          continue
        }
        const job = queue.shift()
        starts.push(now())
        running++
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject)
          .finally(() => {
            running--
            void pump()
          })
      }
    } finally {
      pumping = false
    }
    if (stopped) for (const job of queue.splice(0)) job.reject(new GateStopped())
  }

  /** Run `fn` when the bound allows; rejects when stopped or too much is waiting. */
  function run(fn) {
    if (stopped) return Promise.reject(new GateStopped())
    if (queue.length >= maxQueued) return Promise.reject(new Error('too many answers waiting: try again in a minute'))
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      void pump()
    })
  }

  function stop() {
    stopped = true
    for (const job of queue.splice(0)) job.reject(new GateStopped())
  }

  return { run, stop, stats: () => ({ running, queued: queue.length, inWindow: starts.length }) }
}

module.exports = { answerOf, planRsvp, createGate, GateStopped, SAID, WRITE_CONCURRENCY, WRITE_PER_MINUTE }
