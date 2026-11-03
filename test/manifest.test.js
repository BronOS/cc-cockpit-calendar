'use strict'
// The manifest's settings rules (the app's validate.ts refuses the plugin otherwise) and source
// checks the design asks for: no npm dependency, no exec, the one write (an answer to an invitation),
// the token's hosts, the RSVP scope named in one place, example data only.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'))
const walkFiles = (dirs, ext) => {
  const out = []
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) walk(p)
      else if (ext.some((e) => n.name.endsWith(e))) out.push(p)
    }
  }
  for (const d of dirs) walk(path.join(ROOT, d))
  return out
}
const sources = () => walkFiles(['dist', 'panels'], ['.js'])
const noComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the manifest: id, api, entry points and files exist, the services it uses, the CLI', () => {
  assert.equal(manifest.id, 'bronos.calendar')
  assert.equal(manifest.version, '0.2.0')
  assert.equal(manifest.api, 1)
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.author, 'Oleg Bronzov')
  assert.ok(fs.existsSync(path.join(ROOT, manifest.main)))
  for (const p of manifest.contributes.panels) {
    assert.ok(fs.existsSync(path.join(ROOT, p.entry)))
    assert.ok(fs.existsSync(path.join(ROOT, p.icon)))
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'icons/join.svg')), 'the title bar\'s Join icon')
  assert.ok(fs.existsSync(path.join(ROOT, 'panels/event.html')))
  assert.deepEqual(manifest.services.uses, { reviewer: 1, jira: 1 })
  assert.deepEqual(manifest.services.provides, { calendar: 1 })
  assert.equal(manifest.contributes.cli[0].name, 'calendar')
  assert.equal(manifest.contributes.cli[0].stdin, undefined, 'no subcommand reads stdin')
  for (const sub of ['status', 'refresh', 'today', 'next', 'upcoming', 'show', 'rsvp', 'login', 'logout', 'client', 'help']) assert.match(manifest.contributes.cli[0].usage, new RegExp(`\\b${sub}\\b`))
  assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE')))
  assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /MIT License[\s\S]*Oleg Bronzov/)
})

test('the settings schema: no regex anywhere; the secret and sound fields top-level, only allowed keywords', () => {
  const schema = manifest.contributes.settings.project
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      assert.ok(!['pattern', 'patternProperties', '$ref', '$anchor', '$id', '$dynamicRef', '$defs', 'definitions'].includes(k), `${at}.${k}`)
      if (k === 'format') assert.ok(['project.properties.clientSecret', 'project.properties.reminderSoundChoice'].includes(at), `format only on the secret and the sound (${at})`)
      walk(v, `${at}.${k}`)
    }
  }
  walk(schema, 'project')
  const secret = schema.properties.clientSecret
  assert.equal(secret.type, 'string')
  assert.equal(secret.format, 'secret')
  assert.ok(!('default' in secret))
  assert.deepEqual(Object.keys(secret).filter((k) => !['type', 'format', 'title', 'description', '$comment'].includes(k)), [])
})

test('the schema and settings.js agree: every property is read, every default the same, every bound', () => {
  const { readSettings, MAX_CALENDARS, MAX_REMINDERS } = require('../dist/lib/settings')
  const props = manifest.contributes.settings.project.properties
  const { cfg } = readSettings({})
  assert.deepEqual(Object.keys(props).sort(), Object.keys(cfg).sort())
  for (const k of Object.keys(props)) {
    if (k === 'clientSecret') continue
    assert.deepEqual(props[k].default, cfg[k], k)
    if (props[k].type === 'integer') {
      assert.equal(readSettings({ [k]: props[k].maximum + 1 }).cfg[k], props[k].maximum, `${k} max`)
      assert.equal(readSettings({ [k]: props[k].minimum - 1 }).cfg[k], props[k].minimum, `${k} min`)
    }
  }
  assert.equal(props.calendars.maxItems, MAX_CALENDARS)
  assert.equal(props.reminders.maxItems, MAX_REMINDERS)
  assert.equal(props.reminders.items.minimum, 0)
  assert.equal(props.reminders.items.maximum, 120)
  assert.deepEqual(props.timeZone.oneOf.map((o) => o.const), ['calendar', 'computer'])
  for (const k of ['reminderSound', 'showDeclined', 'showBirthdays', 'showWorkingLocation']) assert.equal(props[k].type, 'boolean', k)
  // The app's sound picker (cc-cockpit 0.9.5 "format": "sound"): a plain string, App default, and
  // nothing but the keywords the app allows on it (validate.ts soundFieldProblems).
  assert.deepEqual(
    { type: props.reminderSoundChoice.type, format: props.reminderSoundChoice.format, default: props.reminderSoundChoice.default },
    { type: 'string', format: 'sound', default: '' }
  )
  for (const k of Object.keys(props.reminderSoundChoice)) assert.ok(['type', 'format', 'title', 'description', 'default', '$comment'].includes(k), k)
})

test('no npm dependency: every require is node: or relative', () => {
  for (const f of sources()) {
    const src = fs.readFileSync(f, 'utf8')
    for (const [, mod] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.ok(mod.startsWith('node:') || mod.startsWith('./') || mod.startsWith('../'), `${path.relative(ROOT, f)} requires ${mod}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.scripts, { test: 'node --test test/' })
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
})

test('the one write: PATCH only in client.js (the RSVP); no POST, PUT or DELETE; no exec', () => {
  for (const f of sources()) {
    const src = noComments(fs.readFileSync(f, 'utf8'))
    const rel = path.relative(ROOT, f)
    assert.ok(!/ctx\.exec\b|child_process/.test(src), `${rel}: exec`)
    assert.ok(!/method:\s*['"](PUT|DELETE|POST)/i.test(src), `${rel}: PUT, DELETE or POST`)
    const patches = [...src.matchAll(/method:\s*['"]PATCH['"]/g)].length
    // http.js holds the route table (checked below through ROUTES); client.js makes the call.
    if (rel === path.join('dist', 'lib', 'http.js')) continue
    if (rel === path.join('dist', 'lib', 'client.js')) {
      assert.equal(patches, 1)
      assert.match(src, /method: 'PATCH', params: \{ sendUpdates: 'all', fields: EVENT_FIELDS \}, json, signal/)
    } else assert.equal(patches, 0, `${rel}: a PATCH`)
    assert.ok(!/calendars\/[^'"`\s]*\/(acl|watch|quickAdd|import|move|instances|clear)\b|users\/me\/settings|freeBusy|\/channels\/stop/.test(src), `${rel}: another Calendar API method`)
  }
  const { ROUTES } = require('../dist/lib/http')
  assert.deepEqual(ROUTES.map((r) => r.method), ['GET', 'GET', 'PATCH'])
  assert.equal(ROUTES[2].path.test('/calendar/v3/calendars/me%40example.com/events/e1'), true)
  assert.equal(ROUTES[2].path.test('/calendar/v3/calendars/me%40example.com/events'), false, 'no insert')
  assert.equal(ROUTES[2].path.test('/calendar/v3/users/me/calendarList/me%40example.com'), false)
})

test('the RSVP scope is named once (oauth-client.js); the rest reads the constant', () => {
  for (const f of sources()) {
    const rel = path.relative(ROOT, f)
    const src = noComments(fs.readFileSync(f, 'utf8'))
    const hits = [...src.matchAll(/calendar\.events\.owned/g)].length
    if (rel === path.join('dist', 'lib', 'oauth-client.js')) assert.equal(hits, 1, 'the constant (the label and the texts derive from it)')
    else if (rel === path.join('dist', 'lib', 'setup.js')) assert.equal(hits, 1, 'the setup step names the scope to add')
    else assert.equal(hits, 0, rel)
  }
})

test('the only network hosts in the code are Google\'s (and the README link)', () => {
  const allowed = new Set(['www.googleapis.com', 'oauth2.googleapis.com', 'accounts.google.com', 'console.cloud.google.com', 'myaccount.google.com', 'github.com', 'meet.google.com', 'www.google.com', 'calendar.google.com'])
  for (const f of [...sources(), ...walkFiles(['panels'], ['.html'])]) {
    const src = noComments(fs.readFileSync(f, 'utf8'))
    for (const [, host] of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) assert.ok(allowed.has(host.toLowerCase()), `${path.relative(ROOT, f)}: ${host}`)
  }
})

test('example data only: test data and docs use Acme, example.com and the Example people', () => {
  const files = walkFiles(['test', 'docs'], ['.js', '.json', '.md']).concat(['README.md', 'FRICTION.md'].map((p) => path.join(ROOT, p)).filter((p) => fs.existsSync(p)))
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    for (const [, d] of src.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
      const domain = d.toLowerCase()
      const ok = /(^|\.)example\.(com|org)$|\.example$/.test(domain) || /(^|\.)google\.com$/.test(domain) || domain === 'x.org'
      assert.ok(ok, `${path.relative(ROOT, f)}: an address at ${domain}`)
    }
  }
})
