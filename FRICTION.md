# Friction log

Each entry is one place where the cc-cockpit guide (`ccc guide`, every topic, `ccc guide types`, and
`ccc help`) was not enough, was ambiguous, or an API was missing, found while building
`bronos.calendar` 0.1.0 against cc-cockpit 0.9.4 on 2026-11-03. Format: what I needed, what the guide
says, what I did instead. Status: **Open** unless marked.

Known gaps already reported in bronos.gmail's, bronos.chat's and bronos.jira's FRICTION.md, only
referenced here: no project id for per-project secrets (a random `projectKey` in `ctx.storage`);
`invalid_grant` only in the rejection's text; panels cannot submit a `<form>`; a consumer cannot tell
"the provider has no such method" from "the method failed" except by the rejection's text
(`isMissingAnnotate`); no `ccc plugin validate <dir>` for an unlinked folder; no manifest field that
names the hosts a plugin talks to.

## Plugin API

- **`settings`: a host cannot write its own project settings.** Open.
  Needed: the panel's Calendars picker should add a calendar to the `calendars` setting, so the
  choice shows in Settings and in `ccc plugin config`. Guide: `ctx.settings` is read-only;
  `onSettingsChange` only reports. Did: the picker keeps its own list in `ctx.storage` (`picked`);
  the calendars shown are the primary one, the setting's and the picked ones, and the picker marks a
  setting's calendar "in the settings" (not switchable there). Two places for one choice. Would
  help: `ctx.settings.setProject(patch)` (validated against the schema like a save from Settings,
  firing `onSettingsChange`).

- **`notify`: no title, sound, action or click result (0.9.4).** Open (0.9.5 adds them, per the
  plan).
  Needed: a meeting reminder with the plugin's name as the title, a Join button, and to open the Meet
  link when the person clicks it. Guide (0.9.4): `ctx.notify(text)`, at most 10 a minute, resolves
  nothing. Did: always call `ctx.notify(text, { title, sound, action: { label: 'Join' } })` and read
  the answer's shape: `{ clicked: boolean }` means the 0.9.5 app (clickable; a click opens the link
  with `ctx.openExternal`), `undefined` an older one (the 0.9.4 host's notify is `(text) => ...`, so
  the options are ignored). A rejection that names the options is retried with the text alone. The
  answer is kept in `ctx.storage` (`notifyClicks`); until it is known true, a reminder with a Meet
  link ends "· Join from the Calendar panel". Would help: a feature list on ctx (`ctx.features`,
  like the reviewer's `features()`) so a plugin asks instead of probing with a real notification,
  and the guide saying how long `notify` waits for a click.

- **`appStorage`: no expiry on a key.** Open.
  Needed: one counter per reminder (`increment` is the atomic "first window wins" the guide
  recommends), which nobody needs after the meeting. Guide: keys live until deleted; `keys()` is
  capped at 1 MiB of JSON. Did: the key carries its UTC date (`remind:YYYY-MM-DD:<hash>`) and the
  first tick of a day deletes the keys of days before yesterday. Would help: `set(key, value, {
  ttlMs })` / `increment(key, by, { ttlMs })`, or a guide note on the pattern.

- **`appStorage`: no "set if absent".** Noted (not a gap: `increment` covers it).
  The guide's "increment is the safe counter across windows" was enough to see that `=== 1` is a
  claim; a line saying so ("use `increment(key) === 1` to let exactly one window act") would save the
  next plugin the thought.

- **`types`: `OAuthTokens.scope` (0.9.4) is an array; the token endpoint sends a string.** Noted.
  The guide says array; the plugin reads both (`missingScopes`), and treats an absent `scope` as "not
  known: all granted until a 403 says otherwise".

- **`panels.header`: no badge or text colour for "starting soon".** Open (minor).
  Needed: the title bar's meta to stand out in the last minutes before a meeting. Guide: `meta` is
  plain text, at most 120 characters. Did: the Join action turns enabled (and its title names the
  meeting); the panel's own card gets an accent border. Would help: a `tone` on the header (`info`,
  `warning`) the app styles.

- **`schedule`: the 15 s floor and no "at a time".** Noted.
  Needed: a reminder at a minute, the countdown in the header, a poll every 3 min ± 25% (Google asks
  to vary intervals). Guide: `ctx.schedule(seconds, fn)` repeats, 15 s at the least. Did: one 15 s
  tick does everything (the next poll time is kept and jittered by the host itself; reminders are
  due from their minute on, so a tick at most 15 s late is fine). Would help: a guide line that a
  plugin's own `setTimeout` is allowed in the host for one-off waits (the first poll uses one) and
  is not counted against anything.

## Testing

- **No host test kit.** Open (as in the other plugins).
  This repo has its own fake ctx (`test/fakes.js`), now with a shared fake `ctx.appStorage` for two
  "windows" and three `notify` behaviours (0.9.4, 0.9.5, strict). The panel page is checked against
  a stand-in DOM in `test/panel.test.js`. A kit from cc-cockpit with the app's real limits (message
  sizes, rates, the header's 120 characters, the openExternal cap) would keep the fakes honest.

## Google, not cc-cockpit (for the README and the design)

- No Google page says that `calendar.events.owned` covers answering an invitation (an attendee's
  own `responseStatus` on their primary calendar's copy). The scope is one constant
  (`dist/lib/oauth-client.js` `RSVP_SCOPE`); a 403 for the scope while the grant holds it shows what
  to change (README "If Google refuses the RSVP scope").
- On a calendar other than the primary one, `self` on an attendee marks that calendar, not the
  person: the person's own answer is the attendee with their address.
