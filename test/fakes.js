'use strict'
// Fakes shared by the suites: the Google Calendar API v3 behind one fake fetch (a small made-up week,
// never the network), Google's OAuth through a fake ctx.oauth (the token answer carries `scope` as
// an array, as cc-cockpit 0.9.4 passes it), and a cc-cockpit ctx written from `ccc guide api`, with
// an app-wide store that two windows can share (ctx.appStorage.increment) and ctx.notify as the
// 0.9.4 app (text only, resolves undefined) or the 0.9.5 one ({ title, sound, action } -> { clicked }).
// Every name, address and id here is example data (Acme, example.com, "Ann Example").
// (bronos.chat's fakes.js, with Calendar's API.)

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const API = 'https://www.googleapis.com'
// Tue 3 Nov 2026, 08:00 UTC = 09:00 in Berlin (CET, UTC+1).
const NOW = Date.parse('2026-11-03T08:00:00Z')
const TZ = 'Europe/Berlin'
const ME = 'me@example.com'
const ANN = 'ann@example.com'
const BOB = 'bob@example.com'
const TEAM = 'acme-team@group.calendar.google.com'
const HOLIDAYS = 'en.example#holiday@group.v.calendar.google.com'
const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-test-secret-0123456789ab'
const SETTINGS_CLIENT = { clientId: '555555555555-settingsclient.apps.googleusercontent.com', clientSecret: 'GOCSPX-settings-secret' }
const G = 'https://www.googleapis.com/auth/'
const ALL_SCOPES = [`${G}calendar.calendarlist.readonly`, `${G}calendar.events.readonly`, `${G}calendar.events.owned`]

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** `2026-11-03T09:30:00+01:00`: a Berlin wall time in November (CET). */
function at(day, hm) {
  return `${day}T${hm}:00+01:00`
}

const self = (status) => ({ email: ME, self: true, responseStatus: status })
const guest = (email, status, extra = {}) => ({ email, displayName: email === ANN ? 'Ann Example' : email === BOB ? 'Bob Example' : undefined, responseStatus: status, ...extra })

/** A timed event on a calendar (Berlin wall times). */
function ev(id, day, from, to, o = {}) {
  return {
    id,
    status: o.status || 'confirmed',
    summary: o.title,
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    iCalUID: o.iCalUID || `${id}@google.com`,
    start: { dateTime: at(day, from), timeZone: TZ },
    end: { dateTime: at(day, to), timeZone: TZ },
    eventType: o.type || 'default',
    ...(o.recurring ? { recurringEventId: o.recurring, originalStartTime: { dateTime: at(day, from), timeZone: TZ } } : {}),
    ...(o.organizer ? { organizer: o.organizer } : { organizer: { email: ME, self: true } }),
    ...(o.attendees ? { attendees: o.attendees } : {}),
    ...(o.meet ? { hangoutLink: o.meet, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: o.meet }, { entryPointType: 'phone', uri: 'tel:+1-555-0100', label: '+1 555-0100', pin: '123456' }], conferenceSolution: { name: 'Google Meet', key: { type: 'hangoutsMeet' } } } } : {}),
    ...(o.location ? { location: o.location } : {}),
    ...(o.description ? { description: o.description } : {}),
    ...(o.transparency ? { transparency: o.transparency } : {}),
    ...(o.extra || {}),
  }
}

/** An all-day event (`to` exclusive). */
function allDay(id, from, to, o = {}) {
  return {
    id,
    status: 'confirmed',
    summary: o.title,
    htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
    iCalUID: `${id}@google.com`,
    start: { date: from },
    end: { date: to },
    eventType: o.type || 'default',
    organizer: { email: ME, self: true },
    transparency: 'transparent',
    ...(o.extra || {}),
  }
}

/**
 * The example week, fresh each call. Primary calendar (me@example.com, Europe/Berlin), Tue 3 Nov:
 *   working location Home (all day); 07:00 Early sync (over); 09:30 Standup (recurring, Meet,
 *   accepted); 11:00 Design review ACME-12 (Ann's, Meet, accepted); 11:30 Vendor call (overlaps the
 *   review); 12:30 Offsite lunch (declined); 14:00 Focus time; a cancelled event.
 * Wed 4: 10:00 Customer demo (accepted); 14:00 Budget planning (Bob's invitation, not answered).
 * Thu 5 and Thu 12: Weekly 1:1 (a recurring invitation of Ann's, not answered). Fri 6: Company
 * holiday (all day). Mon 9: 13:00 Planning. Tue 10 - Thu 12: Acme conference (all day, 3 days).
 * Team calendar (Acme Team): 15:00 Team retro today (not a guest), and a copy of the design review.
 * Ann's calendar and a holiday calendar are in the list but not selected.
 */
function world() {
  const day = '2026-11-03'
  const calendars = [
    { id: ME, summary: ME, primary: true, timeZone: TZ, accessRole: 'owner', backgroundColor: '#4285f4' },
    { id: TEAM, summary: 'Acme Team', timeZone: TZ, accessRole: 'reader', backgroundColor: '#0b8043' },
    { id: ANN, summary: 'Ann Example', timeZone: TZ, accessRole: 'reader', backgroundColor: '#f4511e' },
    { id: HOLIDAYS, summary: 'Holidays', timeZone: TZ, accessRole: 'reader', backgroundColor: '#795548' },
  ]
  const invite = (from, extra = {}) => ({ organizer: { email: from, displayName: from === ANN ? 'Ann Example' : 'Bob Example' }, attendees: [guest(from, 'accepted', { organizer: true }), self('needsAction')], ...extra })
  const review = ev('review1', day, '11:00', '12:00', { title: 'Design review ACME-12', iCalUID: 'review@google.com', organizer: { email: ANN, displayName: 'Ann Example' }, attendees: [guest(ANN, 'accepted', { organizer: true }), self('accepted'), guest(BOB, 'tentative'), { email: 'room-1@resource.calendar.google.com', resource: true, responseStatus: 'accepted' }], meet: 'https://meet.google.com/rev-iewx-yzq', description: '<p>Agenda: <b>ACME-12</b> and the <a href="https://docs.example.com/plan">plan</a></p><script>alert(1)</script>', location: 'Room 1' })
  const events = {
    [ME]: [
      allDay('wl1', day, '2026-11-04', { title: '', type: 'workingLocation', extra: { workingLocationProperties: { type: 'homeOffice', homeOffice: {} } } }),
      ev('early1', day, '07:00', '07:30', { title: 'Early sync', organizer: { email: BOB, displayName: 'Bob Example' }, attendees: [guest(BOB, 'accepted', { organizer: true }), self('accepted')] }),
      ev('standup_20261103T083000Z', day, '09:30', '09:45', { title: 'Standup', recurring: 'standup', iCalUID: 'standup@google.com', meet: 'https://meet.google.com/abc-defg-hij', organizer: { email: BOB, displayName: 'Bob Example' }, attendees: [guest(BOB, 'accepted', { organizer: true }), self('accepted')] }),
      review,
      ev('vendor1', day, '11:30', '12:15', { title: 'Vendor call', attendees: [self('accepted'), guest('vendor@example.org', 'accepted')], organizer: { email: ME, self: true } }),
      ev('lunch1', day, '12:30', '13:30', { title: 'Offsite lunch', organizer: { email: BOB, displayName: 'Bob Example' }, attendees: [guest(BOB, 'accepted', { organizer: true }), self('declined')] }),
      ev('focus1', day, '14:00', '16:00', { title: 'Focus time', type: 'focusTime' }),
      ev('gone1', day, '16:00', '17:00', { title: 'Cancelled thing', status: 'cancelled' }),
      ev('demo1', '2026-11-04', '10:00', '11:00', { title: 'Customer demo', attendees: [self('accepted'), guest(ANN, 'accepted')] }),
      ev('budget1', '2026-11-04', '14:00', '15:00', { title: 'Budget planning', ...invite(BOB) }),
      ev('weekly11_20261105T090000Z', '2026-11-05', '10:00', '10:30', { title: 'Weekly 1:1', recurring: 'weekly11', iCalUID: 'weekly11@google.com', ...invite(ANN) }),
      allDay('holiday1', '2026-11-06', '2026-11-07', { title: 'Company holiday' }),
      ev('plan1', '2026-11-09', '13:00', '14:00', { title: 'Planning' }),
      allDay('conf1', '2026-11-10', '2026-11-13', { title: 'Acme conference' }),
      ev('weekly11_20261112T090000Z', '2026-11-12', '10:00', '10:30', { title: 'Weekly 1:1', recurring: 'weekly11', iCalUID: 'weekly11@google.com', ...invite(ANN) }),
    ],
    [TEAM]: [ev('retro1', day, '15:00', '16:00', { title: 'Team retro', organizer: { email: BOB, displayName: 'Bob Example' }, attendees: [guest(BOB, 'accepted', { organizer: true })] }), { ...structuredClone(review), attendees: review.attendees.map((a) => ({ ...a, self: undefined })) }],
    [ANN]: [ev('ann1', day, '10:00', '11:00', { title: 'Ann: dentist', organizer: { email: ANN, self: true } })],
    [HOLIDAYS]: [allDay('h1', '2026-11-11', '2026-11-12', { title: 'Example Day' })],
  }
  return { calendars, events }
}

/** An event's instants (for the window filter): all-day at Berlin midnight. */
function spanOf(e) {
  // A malformed event (no start) is sent as Google might: in every window.
  if (!e.start || !e.end) return { s: -Infinity, t: Infinity }
  const s = e.start.dateTime ? Date.parse(e.start.dateTime) : Date.parse(`${e.start.date}T00:00:00+01:00`)
  const t = e.end.dateTime ? Date.parse(e.end.dateTime) : Date.parse(`${e.end.date}T00:00:00+01:00`)
  return { s, t }
}

/** A token registry the fake OAuth hands out and the fake Google accepts. */
function tokens() {
  return { valid: new Set(), n: 0 }
}

const ERRORS = {
  401: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } },
  429: { error: { code: 429, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }], status: 'RESOURCE_EXHAUSTED' } },
  403: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }], status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
  disabled: { error: { code: 403, message: 'Google Calendar API has not been used in project 123456789012 before or it is disabled.', errors: [{ reason: 'accessNotConfigured' }], status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } },
  404: { error: { code: 404, message: 'Not Found', errors: [{ reason: 'notFound' }] } },
  500: { error: { code: 500, message: 'Backend Error', errors: [{ reason: 'backendError' }] } },
}

/**
 * A fake Google Calendar. `opts.world` (default world()), `opts.fail`: { [route]: status | 'disabled'
 * | { status, body } } for `list`, `events:<calendar id>`, `event:<event id>`, `patch`. Records every
 * call in `calls` (url, path, params, method, body) and every write in `writes`.
 */
function fakeGoogle(opts = {}) {
  const w = opts.world || world()
  const calls = []
  const writes = []
  const reg = opts.tokens || tokens()
  const failOf = (route) => {
    const f = opts.fail && opts.fail[route]
    if (!f) return null
    if (f === 'disabled') return json(ERRORS.disabled, 403)
    const status = typeof f === 'number' ? f : f.status
    const body = typeof f === 'object' && f.body ? f.body : ERRORS[status] || { error: { code: status, message: 'boom' } }
    return json(body, status)
  }
  async function fetch(url, init = {}) {
    const headers = init.headers || {}
    const u = new URL(url)
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    const params = Object.fromEntries(u.searchParams)
    calls.push({ url, origin: u.origin, path: u.pathname, params, method, auth: headers.Authorization, redirect: init.redirect, body })
    if (opts.delay) await opts.delay(u, init)
    if (u.origin !== API) throw new Error(`fake google: unexpected host ${u.origin}`)
    const token = String(headers.Authorization || '').replace(/^Bearer /, '')
    if (!reg.valid.has(token)) return json(ERRORS[401], 401)
    const p = u.pathname
    if (p === '/calendar/v3/users/me/calendarList' && method === 'GET') {
      const f = failOf('list')
      if (f) return f
      return json({ items: w.calendars })
    }
    let m = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(p)
    if (m && method === 'GET') {
      const cal = decodeURIComponent(m[1])
      const f = failOf(`events:${cal}`)
      if (f) return f
      if (!w.events[cal]) return json(ERRORS[404], 404)
      const min = Date.parse(params.timeMin)
      const max = Date.parse(params.timeMax)
      const hits = w.events[cal].filter((e) => {
        const { s, t } = spanOf(e)
        return s < max && (t > min || (t === s && s >= min))
      }).sort((a, b) => spanOf(a).s - spanOf(b).s)
      const size = Number(params.maxResults) || 250
      const from = Number(params.pageToken || 0)
      const page = hits.slice(from, from + size)
      return json({ timeZone: TZ, items: page, ...(from + size < hits.length ? { nextPageToken: String(from + size) } : {}) })
    }
    m = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p)
    if (m) {
      const cal = decodeURIComponent(m[1])
      const id = m[2]
      const list = w.events[cal] || []
      if (method === 'PATCH') {
        const f = failOf('patch')
        if (f) return f
        writes.push({ cal, id, body, sendUpdates: params.sendUpdates })
        const targets = list.filter((e) => e.id === id || e.recurringEventId === id)
        if (!targets.length) return json(ERRORS[404], 404)
        for (const e of targets) {
          const a = (e.attendees || []).find((x) => x.email === body.attendees[0].email)
          if (a) a.responseStatus = body.attendees[0].responseStatus
        }
        return json(targets[0])
      }
      const f = failOf(`event:${id}`)
      if (f) return f
      const e = list.find((x) => x.id === id)
      return e ? json(e) : json(ERRORS[404], 404)
    }
    return json(ERRORS[404], 404)
  }
  return { fetch, calls, writes, world: w, tokens: reg }
}

/**
 * A fake ctx.oauth. `authorize` and `refresh` record their specs and hand out tokens the fake
 * Google accepts, with `scope` (an array; `opts.scope` overrides it, `null` leaves it out).
 * `invalidGrant: true` makes refresh fail the way the app's ctx.oauth does.
 */
function fakeOAuth(reg, opts = {}) {
  const scopeOf = () => (o.scope === null ? {} : { scope: [...(o.scope || ALL_SCOPES)] })
  const o = {
    authorizes: [],
    refreshes: [],
    scope: opts.scope,
    invalidGrant: Boolean(opts.invalidGrant),
    async authorize(spec) {
      o.authorizes.push(structuredClone(spec))
      if (o.authorizeError) throw new Error(o.authorizeError)
      if (o.gate) await o.gate
      const t = `ya29.access-${++reg.n}`
      reg.valid.add(t)
      return { accessToken: t, refreshToken: opts.noRefreshToken ? null : `1//refresh-${reg.n}`, expiresAt: (opts.now || (() => NOW))() + 3600000, ...scopeOf() }
    },
    async refresh(spec, refreshToken) {
      o.refreshes.push({ spec: structuredClone(spec), refreshToken })
      if (o.invalidGrant) throw new Error('the token endpoint refused the request: HTTP 400 (invalid_grant)')
      if (o.refreshError) throw new Error(o.refreshError)
      const t = `ya29.access-${++reg.n}`
      reg.valid.add(t)
      return { accessToken: t, refreshToken: o.rotate ? `1//rotated-${reg.n}` : null, expiresAt: (opts.now || (() => NOW))() + 3600000, ...scopeOf() }
    },
  }
  if (opts.scope === undefined) delete o.scope
  return o
}

/** A fake ctx.secrets: a Map, with `failSet` to play a locked keyring. */
function fakeSecrets() {
  const m = new Map()
  const s = {
    map: m,
    failSet: null,
    async get(k) {
      return m.has(k) ? m.get(k) : null
    },
    async set(k, v) {
      if (s.failSet) throw new Error(s.failSet)
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(k)) throw new Error(`bad secret key ${k}`)
      if (typeof v !== 'string' || v.length > 65536) throw new Error('bad secret value')
      m.set(k, v)
    },
    async delete(k) {
      m.delete(k)
    },
    async keys() {
      return [...m.keys()].sort()
    },
  }
  return s
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-test-'))
}

/** An in-memory ctx.storage (structured clones both ways, like the app's JSON store). */
function fakeStorage() {
  const store = new Map()
  return {
    map: store,
    async get(k) {
      return store.has(k) ? structuredClone(store.get(k)) : undefined
    },
    async set(k, v) {
      store.set(k, structuredClone(v))
    },
    async delete(k) {
      store.delete(k)
    },
    async keys() {
      return [...store.keys()]
    },
  }
}

/**
 * The app-wide store (ctx.appStorage), shared by the ctxs of two "windows" when passed to both.
 * Main applies calls one at a time, so an increment is atomic: modelled by doing it synchronously.
 */
function fakeAppStorage() {
  const store = new Map()
  const a = {
    map: store,
    increments: [],
    failIncrement: null,
    async get(k) {
      return store.has(k) ? structuredClone(store.get(k)) : undefined
    },
    async set(k, v) {
      store.set(k, structuredClone(v))
    },
    async delete(k) {
      store.delete(k)
    },
    async keys() {
      return [...store.keys()]
    },
    increment(k, by = 1) {
      if (a.failIncrement) return Promise.reject(new Error(a.failIncrement))
      const v = store.has(k) ? store.get(k) : 0
      if (typeof v !== 'number') return Promise.reject(new Error(`${k} is not a number`))
      store.set(k, v + by)
      a.increments.push(k)
      return Promise.resolve(v + by)
    },
  }
  return a
}

/**
 * ctx.notify as one app version plays it, recording every call in `ctx.notes`:
 * - 'old' (0.9.4): `(text) => ...`, ignores more arguments, resolves undefined;
 * - 'new' (0.9.5): `(text, { title, sound, action })`, resolves `{ clicked }` (ctx.notifyClick);
 * - 'strict': an app that rejects options it does not know (then text alone works).
 */
function notifyOf(ctx, mode) {
  if (mode === 'old') {
    return (text) => {
      ctx.notes.push({ text, opts: undefined })
      return Promise.resolve(undefined)
    }
  }
  if (mode === 'strict') {
    return (text, o) => {
      if (o !== undefined) return Promise.reject(new TypeError('notify: unknown option "title"'))
      ctx.notes.push({ text, opts: undefined })
      return Promise.resolve(undefined)
    }
  }
  return (text, o) => {
    ctx.notes.push({ text, opts: o === undefined ? undefined : structuredClone(o) })
    return Promise.resolve({ clicked: Boolean(ctx.notifyClick) })
  }
}

/**
 * A ctx good enough for dist/host.js: in-memory storage and secrets, recorded posts, headers,
 * badges, sessions, overlays, openExternal, notifications; services `reviewer` and `jira` from
 * `opts`. `opts.old`: the members the plugin needs (0.9.4) are left out. `opts.notify`: 'new'
 * (default), 'old' or 'strict'. `opts.appStorage`: share one between two ctxs.
 */
function fakeCtx(opts = {}) {
  const panelListeners = []
  const actionListeners = []
  const settingsListeners = []
  const dataDir = opts.dataDir || tmpDir()
  const services = { reviewer: opts.reviewer || null, jira: opts.jira || null }
  const ctx = {
    api: 1,
    pluginId: 'bronos.calendar',
    projectDir: dataDir,
    dataDir,
    settings: Object.freeze({ project: opts.project || {}, app: {} }),
    posts: [],
    headers: [],
    badges: [],
    logs: [],
    sent: [],
    opened: [],
    external: [],
    overlays: [],
    schedules: [],
    notes: [],
    notifyClick: false,
    sessionList: opts.sessions || [],
    onSettingsChange(fn) {
      settingsListeners.push(fn)
      return () => {}
    },
    async changeSettings(project) {
      ctx.settings = Object.freeze({ project, app: {} })
      for (const fn of settingsListeners) await fn(ctx.settings)
    },
    storage: opts.storage || fakeStorage(),
    appStorage: opts.appStorage || fakeAppStorage(),
    secrets: opts.secrets || fakeSecrets(),
    oauth: opts.oauth,
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    badge: (panel, v) => ctx.badges.push(v),
    schedule(seconds, fn) {
      const s = { seconds, fn, stopped: false }
      ctx.schedules.push(s)
      return () => {
        s.stopped = true
      }
    },
    async exec(argv) {
      throw new Error(`the plugin must not exec (${argv[0]})`)
    },
    async openExternal(url) {
      if (ctx.externalError) throw new Error(ctx.externalError)
      ctx.external.push(url)
    },
    panels: {
      post: (panel, m) => {
        if (JSON.stringify(m).length > 1024 * 1024) throw new Error('panel message over 1 MiB')
        ctx.posts.push(structuredClone(m))
      },
      onMessage: (panel, fn) => {
        panelListeners.push(fn)
        return () => {}
      },
      header: (panel, spec) => {
        if (spec && spec.meta && spec.meta.length > 120) throw new TypeError('meta over 120')
        ctx.headers.push(structuredClone(spec))
      },
      onAction: (panel, fn) => {
        actionListeners.push(fn)
        return () => {}
      },
      show() {},
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(m)
    },
    async clickAction(id) {
      for (const fn of actionListeners) await fn(id)
    },
    overlay: {
      start(spec) {
        const o = { spec, posts: [], listeners: [], answer: opts.overlayAnswer || { kind: 'dismissed' } }
        ctx.overlays.push(o)
        const result = Promise.resolve(o.answer)
        o.send = (m) => o.listeners.forEach((fn) => fn(structuredClone(m)))
        return {
          result,
          post: (m) => {
            if (JSON.stringify(m).length > 1040384) throw new Error('overlay message over 1,040,384 chars of JSON')
            o.posts.push(structuredClone(m))
          },
          onMessage: (fn) => (o.listeners.push(fn), () => {}),
          close() {},
          focus() {},
        }
      },
    },
    sessions: {
      async list() {
        return ctx.sessionList
      },
      async send(tabId, text) {
        ctx.sent.push({ tabId, text })
        return { delivered: true }
      },
      async open(o) {
        ctx.opened.push(o)
        return { tabId: 'new1' }
      },
    },
    cli: {
      register: (name, fn) => {
        ctx.cliName = name
        ctx.cliHandler = fn
        return () => {}
      },
    },
    async runCli(argv, cwd = dataDir) {
      return ctx.cliHandler(argv, { stdin: '', cwd, signal: new AbortController().signal })
    },
    services: {
      use: (name) => {
        const handle = { on: () => () => {} }
        return new Proxy(handle, {
          get(target, prop) {
            if (prop in target) return target[prop]
            if (prop === 'then') return undefined
            return async (...args) => {
              const impl = services[name]
              if (!impl) throw new Error(`no enabled plugin in this project provides service "${name}"`)
              if (typeof impl[prop] !== 'function') throw new Error(`service "${name}" (plugin cockpit.${name}) has no method "${String(prop)}"`)
              return structuredClone(await impl[prop](...structuredClone(args)))
            }
          },
        })
      },
      available: (name) => Boolean(services[name]),
      provide() {},
      emit() {},
      caller: () => undefined,
    },
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  ctx.notify = notifyOf(ctx, opts.notify || 'new')
  if (opts.old) {
    delete ctx.oauth
    delete ctx.secrets
    delete ctx.openExternal
    delete ctx.panels.header
    delete ctx.panels.onAction
    delete ctx.appStorage
  }
  return ctx
}

/** A fake reviewer with annotate; `refuseHtml` plays one whose annotate takes text only; `companion` adds features(). */
function fakeReviewer(opts = {}) {
  const r = {
    calls: [],
    async annotate(a) {
      r.calls.push(a)
      if (opts.refuseHtml && a.html !== undefined) throw new Error('annotate: html is not supported')
      if (opts.refuseCompanion && a.companion !== undefined) throw new Error('annotate: unknown field companion')
      return { opened: true }
    },
  }
  if (opts.companion) r.features = async () => ['companion']
  return r
}

/** A fake Jira service (bronos.jira): one site, a few issues. */
function fakeJira() {
  const site = 'https://acme.atlassian.example'
  const issues = { 'ACME-12': { key: 'ACME-12', summary: 'New checkout page', status: 'In Progress', category: 'indeterminate', done: false, priority: 'High', assignee: 'Ann Example', mine: false, url: `${site}/browse/ACME-12` } }
  const j = {
    calls: [],
    async site() {
      j.calls.push(['site'])
      return { ready: true, site }
    },
    async issue(key) {
      j.calls.push(['issue', key])
      return issues[key] || null
    },
    async document(key) {
      j.calls.push(['document', key])
      return { key, url: `${site}/browse/${key}`, html: `<h1>${key}</h1><p>New checkout page</p>`, assets: [] }
    },
  }
  return j
}

module.exports = { fixture, fakeGoogle, fakeOAuth, fakeSecrets, fakeStorage, fakeAppStorage, fakeCtx, fakeReviewer, fakeJira, tokens, world, ev, allDay, at, self, guest, tmpDir, json, API, NOW, TZ, ME, ANN, BOB, TEAM, HOLIDAYS, CLIENT_ID, CLIENT_SECRET, SETTINGS_CLIENT, ALL_SCOPES, G }
