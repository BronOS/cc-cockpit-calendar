'use strict'
// `ccc calendar ...`: parsing and the printed text. The handler gets plain data from the host
// (`deps`), so the suites drive it without an app. No subcommand reads stdin (the manifest does not
// declare it), so the client file is read from a path. Nothing printed here ever holds a token or the
// client secret. (bronos.chat's cli.js, with Calendar's commands.)

const fs = require('node:fs')
const path = require('node:path')
const { ago, oneLine, cut, eventId, calendarId } = require('./util')
const { MAX_FILE, SCOPE_TEXT } = require('./oauth-client')
const { answerOf, SAID } = require('./rsvp')
const T = require('./time')

const HELP = `ccc calendar: your Google Calendar (bronos.calendar)

  ccc calendar status              client, account, scopes, time zone, calendars, last poll, counts, errors
  ccc calendar refresh             poll Google Calendar now and print the counts
  ccc calendar today               today and tomorrow, one line per event (with its id)
  ccc calendar next                the next meeting: countdown, join link, where, your answer
  ccc calendar upcoming            the events after tomorrow (the Upcoming list), then the invitations
  ccc calendar show <id>           an event as readable text (guests, description, join link)
  ccc calendar rsvp <id> yes|no|maybe [--one]
                                   answer an invitation (the organizer is told); a recurring one
                                   answers the whole series unless --one (this occurrence only)
  ccc calendar login               start the Google sign-in (your browser does the rest)
  ccc calendar logout              sign out: the stored sign-in is deleted
  ccc calendar client <file>       use the OAuth client file you downloaded from Google Cloud (Desktop app)
  ccc calendar help                this text

show and rsvp take --calendar <id> for an event of another calendar than your primary one.
The plugin changes nothing in Google Calendar but your own answer to an invitation (rsvp).
Settings: ccc plugin config bronos.calendar (the client secret only in Settings > This project).
`

const MARK = { accepted: '✓', tentative: '?', declined: '✗', needsAction: '·', organizer: '', none: '' }

/** argv without `--calendar <id>` / `--one`, and those values. */
function flags(rest) {
  const out = { args: [], calendar: null, one: false, bad: null }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--one') out.one = true
    else if (a === '--calendar' || a.startsWith('--calendar=')) {
      const v = a === '--calendar' ? rest[++i] : a.slice('--calendar='.length)
      if (!calendarId(v)) out.bad = `not a calendar id: "${cut(String(v || ''), 80)}"`
      else out.calendar = v
    } else if (a.startsWith('--')) out.bad = `unknown option ${cut(a, 40)}`
    else out.args.push(a)
  }
  return out
}

/**
 * @param {string[]} argv
 * @param {object} deps from the host: status(), refresh(signal), view(), now(), show(id, cal, signal),
 *   rsvp(id, cal, answer, one), login(), logout(), client(text)
 * @param {{ cwd?: string, signal?: AbortSignal }} [call]
 */
async function runCli(argv, deps, call = {}) {
  const [cmd, ...rest] = argv
  const ok = (stdout) => ({ stdout: stdout.endsWith('\n') ? stdout : stdout + '\n', code: 0 })
  const fail = (stderr, code = 1) => ({ stderr: stderr.endsWith('\n') ? stderr : stderr + '\n', code })
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || (rest[0] === '--help' && cmd)) return ok(HELP)
  try {
    switch (cmd) {
      case 'status':
        return ok(statusText(deps.status(), deps.now ? deps.now() : Date.now()))
      case 'refresh': {
        const st = deps.status()
        if (!st.ready) return fail(notReady(st))
        const r = await deps.refresh(call.signal)
        if (r && r.error) return fail(`refresh failed: ${r.error}`)
        if (r && r.pending) return ok('still polling; ccc calendar status shows when it is done')
        return ok(countsLine(deps.status()))
      }
      case 'today':
      case 'next':
      case 'upcoming': {
        const st = deps.status()
        if (!st.ready) return fail(notReady(st))
        if (!st.lastPoll) return fail('no poll yet: run ccc calendar refresh')
        const v = deps.view()
        const now = deps.now ? deps.now() : Date.now()
        const out = cmd === 'today' ? todayText(v) : cmd === 'next' ? nextText(v, now) : upcomingText(v)
        return ok(st.stale ? `${out}\n(as of the last good poll, ${ago(st.lastPoll, now)}: ${st.error || 'the last poll failed'})` : out)
      }
      case 'show':
      case 'rsvp': {
        const f = flags(rest)
        if (f.bad) return fail(f.bad, 2)
        const id = f.args[0]
        if (!id) return fail(cmd === 'show' ? 'usage: ccc calendar show <id> [--calendar <id>]' : 'usage: ccc calendar rsvp <id> yes|no|maybe [--one] [--calendar <id>]', 2)
        if (!eventId(id)) return fail(`not an event id: "${cut(id, 80)}" (ccc calendar today shows them)`, 2)
        const st = deps.status()
        if (!st.ready) return fail(notReady(st))
        if (cmd === 'show') {
          if (f.one || f.args.length > 1) return fail('usage: ccc calendar show <id> [--calendar <id>]', 2)
          return ok(await deps.show(id, f.calendar, call.signal))
        }
        const answer = answerOf(f.args[1])
        if (!answer || f.args.length > 2) return fail('usage: ccc calendar rsvp <id> yes|no|maybe [--one] [--calendar <id>]', 2)
        const r = await deps.rsvp(id, f.calendar, answer, f.one)
        if (r && r.error) return fail(r.error)
        return ok(r && r.message ? r.message : `${SAID[answer]}.`)
      }
      case 'login': {
        const r = await deps.login()
        if (r && r.error) return fail(r.error)
        return ok(r && r.message ? r.message : 'Your browser opens the Google sign-in: finish it there. ccc calendar status shows the result.')
      }
      case 'logout': {
        const r = await deps.logout()
        return ok(r && r.message ? r.message : 'Signed out.')
      }
      case 'client': {
        if (!rest[0]) return fail('usage: ccc calendar client <path to the client JSON file>', 2)
        const file = path.resolve(call.cwd || process.cwd(), rest.join(' '))
        let text
        try {
          const st = await fs.promises.stat(file)
          if (!st.isFile()) return fail(`${file} is not a file`)
          if (st.size > MAX_FILE) return fail(`${file} is too big to be a Google client file`)
          text = await fs.promises.readFile(file, 'utf8')
        } catch (e) {
          return fail(`cannot read ${file}: ${e.code || e.message}`)
        }
        const r = await deps.client(text)
        if (!r.ok) return fail(r.error)
        return ok(r.message)
      }
      default:
        return fail(`unknown command "${cut(cmd, 40)}"\n\n${HELP}`, 2)
    }
  } catch (e) {
    return fail(e && e.message ? e.message : String(e))
  }
}

/** Why there is nothing to show yet: the first thing missing. */
function notReady(st) {
  if (st.tooOld) return st.tooOld
  if (!st.client) return 'No OAuth client yet: ccc calendar client <file.json>, or set clientId and clientSecret (Settings > This project > Google Calendar). ccc calendar status says more.'
  if (!st.signedIn) return st.signedOutReason || 'Not signed in to Google: ccc calendar login (or Sign in with Google in the Google Calendar panel).'
  if (st.blocked) return st.blocked
  return 'Not ready yet: ccc calendar status says more.'
}

function countsLine(st) {
  const c = st.counts
  if (!c) return 'no poll yet'
  return `today ${c.today} · tomorrow ${c.tomorrow} · upcoming ${c.upcoming} · invitations ${c.invitations}${c.conflicts ? ` · conflicts ${c.conflicts}` : ''}`
}

/** `ccc calendar status`. */
function statusText(st, now = Date.now()) {
  const lines = []
  if (st.tooOld) return `${st.tooOld}\n`
  const c = st.client
  lines.push(`client    ${c ? `${c.id} (${c.source === 'pasted' ? 'pasted client file' : 'settings'})` : '(none)'}`)
  if (st.pastedBroken) lines.push(`problem   ${st.pastedBroken}`)
  for (const m of st.settingsMissing || []) lines.push(`problem   ${m} is not set (Settings > This project > Google Calendar)`)
  lines.push(`sign-in   ${st.signedIn ? `signed in${st.sessionOnly ? ' for this session only (the keychain did not take the sign-in)' : ''}` : st.signingIn ? 'waiting for the browser' : 'not signed in'}`)
  if (!st.signedIn) {
    if (st.signedOutReason) lines.push('', st.signedOutReason)
    else if (!c) lines.push('', 'Set up an OAuth client first (the Google Calendar panel shows the steps; README "Set up Google Cloud"), then: ccc calendar client <file.json> and ccc calendar login.')
    else lines.push('', 'Next: ccc calendar login (or Sign in with Google in the Google Calendar panel).')
    for (const p of st.problems || []) lines.push(`problem   ${p}`)
    return lines.join('\n') + '\n'
  }
  lines.push(`account   ${st.account || '(not known yet: the first poll reads it)'}`)
  if (st.missing === null || st.missing === undefined) lines.push('scopes    not reported by Google: taken as all granted')
  else if (!st.missing.length) lines.push('scopes    all granted (answering invitations on)')
  else for (const k of st.missing) lines.push(`scopes    missing ${SCOPE_TEXT[k] ? `${SCOPE_TEXT[k].label}: ${SCOPE_TEXT[k].loses}` : k}`)
  if (st.blocked) lines.push(`blocked   ${st.blocked}`)
  if (st.zone) lines.push(`time zone ${st.zone} (${st.zoneSource})${st.otherZone ? `; this computer is in ${st.otherZone}` : ''}`)
  for (const cal of st.calendars || []) lines.push(`calendar  ${cal.on ? '[x]' : '[ ]'} ${cal.name}${cal.primary ? ' (primary)' : ''}${cal.name === cal.id ? '' : ` ${cal.id}`}${cal.from === 'settings' ? ' (calendars setting)' : cal.from === 'picked' ? ' (picked in the panel)' : ''}`)
  for (const id of st.missingCalendars || []) lines.push(`calendar  ${id}: not in your calendar list (subscribe to it in Google Calendar, or fix the calendars setting)`)
  lines.push(`last poll ${st.lastPoll ? `${new Date(st.lastPoll).toISOString().replace('T', ' ').slice(0, 16)} UTC (${ago(st.lastPoll, now)})` : 'none yet'}${st.polling ? ', polling now' : ''}; every ${st.pollMinutes} min (±25%) while this project is open${st.backoffMinutes ? ` (now every ${st.backoffMinutes} min: Google Calendar was busy)` : ''}`)
  lines.push(`counts    ${countsLine(st)}`)
  lines.push(`reminders ${st.reminders && st.reminders.length ? `${st.reminders.map((m) => `${m} min`).join(', ')} before${st.reminderSound ? (st.reminderSoundChoice ? `, with sound ${st.reminderSoundChoice}` : ", with the app's sound") : ', silent'}; notifications ${st.clickable === true ? 'clickable (Join opens the meeting)' : st.clickable === false ? 'text only (cc-cockpit before 0.9.5)' : 'not shown yet'}` : 'off'}`)
  lines.push(`jira      ${st.jira}`)
  lines.push(`view      ${st.annotate}`)
  for (const p of st.problems || []) lines.push(`problem   ${p}`)
  if (st.error) lines.push(`error     ${st.error}`)
  for (const e of (st.calendarErrors || []).slice(0, 5)) lines.push(`error     ${e.calendar}: ${e.message}`)
  for (const n of (st.notes || []).slice(0, 5)) lines.push(`note      ${n}`)
  return lines.join('\n') + '\n'
}

function marks(r) {
  const m = []
  if (r.join) m.push('[Meet]')
  if (MARK[r.response]) m.push(MARK[r.response])
  if (r.conflicts && r.conflicts.length) m.push(`⚠ overlaps ${r.conflicts.map((c) => `${c.title} ${c.time}`).join(', ')}`)
  if (r.jira && r.jira.length) m.push(r.jira.join(', '))
  if (r.type === 'outOfOffice') m.push('(out of office)')
  if (r.type === 'focusTime') m.push('(focus time)')
  if (!r.busy && r.type === 'default') m.push('(free)')
  return m.join(' ')
}

/** The id as `show` and `rsvp` take it (with --calendar for another calendar than the primary). */
function idOf(r) {
  return `${r.id}${r.primaryCal ? '' : ` --calendar ${r.calendarId}`}`
}

function eventLine(r) {
  return `  ${r.time.padEnd(11)}  ${cut(oneLine(r.title), 60)}${marks(r) ? `  ${marks(r)}` : ''}${r.primaryCal ? '' : `  (${r.calendar})`}  ${idOf(r)}`
}

function dayBlock(title, d) {
  const out = [`${title} (${T.longDay(d.day)})`]
  if (!d.chips.length && !d.rows.length) out.push('  nothing')
  for (const c of d.chips) out.push(`  ${c.time.padEnd(11)}  ${cut(oneLine(c.title), 60)}${c.type === 'workingLocation' ? ' (working location)' : ''}${c.primaryCal ? '' : `  (${c.calendar})`}  ${idOf(c)}`)
  for (const r of d.rows) out.push(eventLine(r))
  return out.join('\n')
}

/** `ccc calendar today`: today and tomorrow (the old connector's reach). */
function todayText(v) {
  const out = [dayBlock('Today', v.today), '', dayBlock('Tomorrow', v.tomorrow)]
  if (v.invitations.length) out.push('', `${v.invitations.length} invitation${v.invitations.length === 1 ? '' : 's'} waiting: ccc calendar upcoming lists them`)
  out.push('', `times in ${v.tz}   ✓ accepted  ? maybe  · not answered  ✗ declined  [Meet] has a Google Meet link`)
  return out.join('\n')
}

/** `ccc calendar next`. */
function nextText(v, now) {
  const out = []
  for (const r of v.now) out.push(`Now: ${r.title}, ${r.time}, ends in ${T.span(r.end - now)}`, ...detailLines(r), '')
  if (v.ooo) out.push(`Out of office until ${v.ooo.untilText}`, '')
  const n = v.next
  if (!n) out.push('No more meetings in the next days.')
  else out.push(`Next: ${n.title}, ${n.dayLabel} ${n.time}, in ${T.span(n.start - now)}`, ...detailLines(n))
  return out.join('\n').trimEnd()
}

function detailLines(r) {
  const out = []
  if (r.joinUrl) out.push(`  join      ${r.joinUrl}`)
  else out.push('  join      no Google Meet link')
  if (r.location) out.push(`  where     ${r.location}`)
  out.push(`  answer    ${{ accepted: 'accepted', tentative: 'maybe', declined: 'declined', needsAction: 'not answered', organizer: 'you organize it', none: 'not a guest' }[r.response] || r.response}`)
  if (r.conflicts && r.conflicts.length) out.push(`  overlaps  ${r.conflicts.map((c) => `${c.title} ${c.time}`).join(', ')}`)
  out.push(`  calendar  ${r.calendar}`, `  id        ${idOf(r)}`)
  return out
}

/** `ccc calendar upcoming`: the Upcoming list, then the invitations. */
function upcomingText(v) {
  const out = [`Upcoming (the next ${v.upcoming.days} days after tomorrow)`]
  if (!v.upcoming.rows.length) out.push('  nothing')
  for (const r of v.upcoming.rows) out.push(`  ${cut(oneLine(r.line), 90)}${marks(r) ? `  ${marks(r)}` : ''}  ${idOf(r)}`)
  if (v.upcoming.more) out.push(`  … ${v.upcoming.more} more`)
  out.push('', `Invitations (${v.invitations.length})`)
  if (!v.invitations.length) out.push('  none waiting')
  for (const r of v.invitations) out.push(`  ${cut(oneLine(r.title), 60)} · ${r.when}${r.organizer ? ` · from ${r.organizer}` : ''}${r.conflicts.length ? ' ⚠' : ''}  ${r.id}`)
  if (v.invitations.length) out.push('', 'Answer one: ccc calendar rsvp <id> yes|no|maybe (a recurring one: the series; --one for that occurrence)')
  return out.join('\n')
}

module.exports = { runCli, statusText, todayText, nextText, upcomingText, notReady, flags, HELP }
