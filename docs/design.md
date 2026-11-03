# Google Calendar (bronos.calendar)

Status: decided 2026-11-03 (the user's answers are in "Decisions" at the end; the sections below
follow them) and built as 0.1.0. External plugin (own repo `BronOS/cc-cockpit-calendar`, for the
marketplace). Built the same way as `~/Projects/cc-cockpit-gmail` and `~/Projects/cc-cockpit-chat`
(their docs/design.md, auth, setup guide, panel, reviewer use, tests and fakes); ported from them
nearly as is: `auth.js`, `oauth-client.js`, `header.js`, `actions.js`, `store.js`, `util.js`,
`entities.js`, `sanitize.js`, `jira.js` (the key finder and the lookups), `setup.js` (its shape).

Prior art (port its decisions, not its user-specific text): the old cockpit's calendar connector
`~/Projects/claude-config/cockpit/connectors/cal.py`. It read the primary calendar's events of today
and tomorrow through the `gws` CLI (`singleEvents`, cancelled events left out, "(busy)" for an event
without a title), offered Accept / Maybe / Decline and Join, showed an event as a page (when, your
answer, organizer, where, join link, calendar link, description as text, attendees with ✓ ✗ ? ·
marks, attachments as links), and wrote only the person's own answer (`attendeesOmitted: true`, one
attendee entry, `sendUpdates: none`; this plugin sends `all`, decision 3). It had no reminders and
no conflicts: both are new here.

Manifest: `services: { uses: { reviewer: 1, jira: 1 } }` (both optional at run time); no `triage`
(decision 8). A panel (default zone right), CLI `ccc calendar`. Needs **cc-cockpit 0.9.4+**:
`ctx.oauth` reporting the granted scopes (`OAuthTokens.scope`, 0.9.4), `ctx.secrets`,
`ctx.appStorage.increment`, `ctx.panels.header`, `ctx.openExternal`, `ctx.notify`, `ctx.badge`,
reviewer `aside` (0.9.1) and `companion` (0.9.3). On an app without them the panel says so instead of
half working. **cc-cockpit 0.9.5** adds a clickable notification (`ctx.notify(text, { title, sound,
action })` resolving `{ clicked }`, section "Reminders"); the plugin detects it and works without it.

## What Google's docs say (researched 2026-11-03)

- **Personal and Workspace accounts both work.** Unlike Chat (Workspace only), the Calendar API v3
  has no account prerequisite: a personal `@gmail.com` account and a Workspace account read the same
  way. Differences: focus time, out of office and working location events exist "only for some
  Google Calendar users" and only on primary calendars ([event types](https://developers.google.com/workspace/calendar/api/guides/event-types));
  in practice Workspace accounts. Personal accounts get `birthday` and `fromGmail` (flights,
  reservations) events, returned by default. A Workspace admin can block third-party apps, or turn
  Calendar off for the user (a 403: say so plainly).
- **Scopes** ([Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)),
  prefix `https://www.googleapis.com/auth/`:
  - `calendar.calendarlist.readonly` "See the list of Google calendars you're subscribed to"
    (calendarList.list/get: names, colours, primary, time zone, access role).
  - `calendar.events.readonly` "View events on all your calendars" (events.list/get on every
    calendar of the list, owned or subscribed).
  - `calendar.events.owned` "See, create, change, and delete events on Google calendars you own":
    the narrowest scope [events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
    accepts (with `calendar`, `calendar.events`, `calendar.app.created`). An invitation's copy lives
    on the person's primary calendar, which they own, so it should cover answering one. **To be
    probed against a real account before 0.1.0** (no Google page says it in words); if Google
    refuses it, the fallback is `calendar.events` ("View and edit events on all your calendars").
  - Not used: `calendar.readonly` (also covers ACLs and settings: broader than needed),
    `calendar.events.owned.readonly` (misses subscribed calendars), `calendar.settings.readonly`
    (the time zone comes from the primary calendar list entry), `calendar.freebusy`.
- **Classification.** No Calendar scope is restricted: Google's [restricted scope list](https://support.google.com/cloud/answer/13464325)
  names Gmail, Drive, Fit, Chat messages, Data Portability, Photos Ambient and Health, not Calendar.
  The Calendar scopes are sensitive (the console's Data access page shows each under "Your
  sensitive scopes"). So unlike Gmail and Chat, a shared verified client would need only the
  sensitive-scope verification, no paid security assessment; the agreed rule still stands (the
  person brings their own client, no shared client: the user does not want to be linked to the
  plugin's users). [When verification is not needed](https://support.google.com/cloud/answer/13464323):
  an Internal app (only the Workspace organisation's users) has no verification, no unverified-app
  screen and no 100-user cap; personal use (fewer than 100 users) is exempt and clicks through the
  unverified-app screen once. A Testing app's refresh token expires after 7 days
  ([OAuth 2.0](https://developers.google.com/identity/protocols/oauth2#expiration)), so a personal
  account's app must be In production.
- **The account address** without `openid`/`email`: the primary calendar's id is the account's
  address (`calendarList.get('primary').id`), with `calendar.calendarlist.readonly`.
- **events.list** ([reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)):
  `timeMin` filters on the end, `timeMax` on the start, both exclusive, RFC 3339 with an offset;
  `singleEvents=true` expands recurring events into instances (`recurringEventId`,
  `originalStartTime`); `orderBy=startTime` only with `singleEvents`; `maxResults` default 250, at
  most 2500; `eventTypes` (repeatable: `default`, `birthday`, `focusTime`, `fromGmail`,
  `outOfOffice`, `workingLocation`; all when absent); `timeZone` sets the zone of the answer;
  `maxAttendees` returns only the participant when an event has more (the `self` entry stays).
  The answer has `timeZone` and `defaultReminders` (the person's popup / email defaults for that
  calendar).
- **Incremental sync** ([sync guide](https://developers.google.com/workspace/calendar/api/guides/sync)):
  `nextSyncToken` on the last page; an incremental request cannot carry `timeMin`, `timeMax`,
  `orderBy`, `q` or `updatedMin`; 410 = full sync again. With `singleEvents` and no `timeMax` an
  endless recurring series expands without end, and the window still has to be cut by hand; so v1
  does not use sync tokens (section "Fetching").
- **Push** ([push notifications](https://developers.google.com/workspace/calendar/api/guides/push))
  needs a public HTTPS endpoint: out, as for Gmail and Chat.
- **Quotas** ([quota](https://developers.google.com/workspace/calendar/api/guides/quota)): 10,000
  requests a minute per project, 600 a minute per user per project, 1,000,000 a day per project
  ("before charges apply"). Over a limit: 403 or 429 `usageLimits`, truncated exponential backoff
  with jitter; Google asks to vary recurring intervals by ±25% and calls "repeatedly poll every
  calendar of interest" an anti-pattern (push is the remedy, which a desktop app cannot have; a few
  calendars every few minutes is far under every limit).
- **Event fields** ([Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)):
  - `htmlLink`: the event in the Calendar web UI. `hangoutLink`: the Meet link.
    `conferenceData.entryPoints[]` with `entryPointType` `video | phone | sip | more`, `uri`,
    `label`, `pin`; `conferenceSolution.name` (Google Meet, or an add-on such as Zoom).
  - `attendees[]`: `self` ("the calendar on which this copy of the event appears"), `organizer`,
    `resource` (rooms), `optional`, `responseStatus` `needsAction | declined | tentative |
    accepted`, `comment`. `attendeesOmitted`: "When updating an event, this can be used to only
    update the participant's response" (the old connector's RSVP). `organizer.self`.
    `guestsCanSeeOtherGuests`.
  - `reminders`: `useDefault`, `overrides[]` (`method` `email | popup`, `minutes` 0..40320, at most 5).
  - `eventType`; `outOfOfficeProperties` / `focusTimeProperties` (`autoDeclineMode`,
    `declineMessage`; focus: `chatStatus`); `workingLocationProperties.type` `homeOffice |
    officeLocation | customLocation` (with a label).
  - `transparency` `opaque` (busy, default) | `transparent` (free); `visibility`; `colorId`;
    `status` `confirmed | tentative | cancelled`; `start` / `end` with `date` (all-day, end
    exclusive) or `dateTime` + `timeZone`; `endTimeUnspecified`; `attachments[]` (`fileUrl`, `title`,
    `mimeType`, at most 25); `locked`; `privateCopy`.
- **Calendar list** ([CalendarList](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList)):
  `id`, `summary`, `summaryOverride` (the person's own name for it), `primary`, `selected`, `hidden`,
  `accessRole`, `backgroundColor` / `foregroundColor` (hex), `timeZone`, `defaultReminders`.
- **The same client as Gmail and Chat**: one Cloud project and Desktop client serve all three;
  enable the Calendar API there and tick its scopes on Data access. Each plugin keeps its own refresh
  token (Google keeps up to 100 per account per client). Revoking the app at
  <https://myaccount.google.com/connections> ends all of them (one app at Google).


## Auth (per project, as Gmail and Chat)

- Google OAuth 2.0 through `ctx.oauth` (code + PKCE, loopback on 127.0.0.1), auth URL
  `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent`, token URL
  `https://oauth2.googleapis.com/token`. Scopes: `calendar.calendarlist.readonly`,
  `calendar.events.readonly`, and the RSVP scope `calendar.events.owned` (decision 1). No `openid` /
  `email` (the address is the primary calendar's id).
- **The RSVP scope is one constant**, `RSVP_SCOPE` in `dist/lib/oauth-client.js`; nothing else names
  it. Should Google refuse `calendar.events.owned` for answering an invitation (to be confirmed with a
  real account: no Google page says it in words), the fallback is `calendar.events` ("View and edit
  events on all your calendars"): change that one line, tick the scope on the Data access page, sign
  in again. The plugin tells the case apart: a 403 for the scope on the RSVP call while the grant
  holds `RSVP_SCOPE` means Google does not accept that scope for the write, and the notice says
  exactly that and what to change (`RSVP_SCOPE_REFUSED_TEXT`); a 403 while the grant lacks it means the
  box was unticked ("Sign in again and leave … ticked").
- The person brings the client (agreed). Settings `clientId`, `clientSecret` (`"format": "secret"`);
  the **Paste the client file** box and `ccc calendar client <file>` check the file as Gmail's
  `oauth-client.js` and keep `client: { clientId, clientSecret }` in this project's `ctx.storage`
  (survives an uninstall: Gmail 0.2.0's decision). The Gmail or Chat file is the same file. No
  reading of another plugin's storage, and no token sharing: Calendar signs in on its own.
- Refresh token in `ctx.secrets` under `refresh:<projectKey>:<sha256(clientId) 12>` (`projectKey`
  random, in `ctx.storage`), access token in memory, refreshed a minute before `expiresAt`, one at a
  time; `invalid_grant` = signed out with the 7-day Testing hint; Sign out deletes the secret;
  another client signs out; the `signedIn` marker gives "the stored sign-in is gone (uninstalled)".
  All as Gmail's `auth.js`.
- **Granted scopes** from `tokens.scope` (cc-cockpit 0.9.4: an array; a string is read too): kept in
  the `signedIn` marker. Without `calendar.events.readonly` or `calendar.calendarlist.readonly`
  nothing is polled and the panel names the missing box with Sign in again; without the RSVP scope
  the agenda works and the Invitations lane says "Sign in again to answer invitations". A response
  with no `scope` is taken as all granted until a 403 says otherwise.
- Errors as one readable line, never the raw body: 403 `accessNotConfigured` ("Google Calendar API
  has not been used in project …") -> enable the API; 403 from a Workspace admin policy ->
  "your organisation does not allow this app"; "Access blocked" (Error 403 access_denied on
  Google's page) -> the hint and **Start over** as Gmail and Chat.
- Tokens go only to `https://www.googleapis.com/calendar/v3/` and the OAuth endpoints (the latter by
  the app's `ctx.oauth`); never logged, never in a panel message or CLI output; redirects not
  followed; every request built in one place from the fixed origin and a route table (`lib/http.js`:
  GET for the calendar list and events, PATCH for one path shape, the event of a calendar). Calendar
  ids are checked by pattern (`[A-Za-z0-9._@#+-]`, no `..`), then `encodeURIComponent`; event ids by
  the old connector's `^[A-Za-z0-9_-]{1,1100}$` (Google's ids run to 1024, an instance adds
  `_YYYYMMDD[THHMMSSZ]`).

## Setup (panel guide while not signed in; the README has the same steps in more words)

1. A Google Cloud project: <https://console.cloud.google.com/projectcreate>, or the Gmail / Chat one.
2. Enable the **Google Calendar API**:
   <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>.
3. Consent screen: Branding <https://console.cloud.google.com/auth/branding>, Audience
   <https://console.cloud.google.com/auth/audience>. Personal account: External, then **Publish
   app** (In production; Testing ends the sign-in every 7 days). Workspace: **Internal**.
4. Data access <https://console.cloud.google.com/auth/scopes>: Add or remove scopes, tick
   `.../auth/calendar.calendarlist.readonly`, `.../auth/calendar.events.readonly` and
   `.../auth/calendar.events.owned`; Update, Save. Google calls them "sensitive" (not restricted);
   the plugin writes with the last one only the person's own answer to an invitation.
5. A Desktop app client <https://console.cloud.google.com/auth/clients/create>, Download JSON; or
   the Gmail / Chat file.
6. Paste the file (Save client) or `ccc calendar client <file>`.
7. **Sign in with Google** (`ccc calendar login`); leave every box ticked. Personal account:
   Advanced > Go to <app name> on the unverified screen (once). "Access blocked" hint and Start over.

Links are ids posted by the page and opened by the host with `ctx.openExternal` from a fixed table
(Gmail's `setup.js`); the README link goes to `#set-up-google-cloud`.

## Which calendars (decision 9)

- The primary calendar always, plus the setting `calendars` (project, a list of calendar ids, default
  empty; `primary` there is the same calendar). Ids come from the calendar list.
- **A picker in the panel**: the footer's "Calendars" fold lists the calendar list (colour, name,
  primary, from the settings) with a toggle per calendar. Settings are read-only to a plugin
  (`ctx.settings`), so the picker keeps its own choice in `ctx.storage` (`picked`) and the selection
  is primary + the setting + the picked ones; a calendar from the setting shows as on and cannot be
  toggled there (FRICTION.md: no settings write API). The README shows
  `ccc plugin config bronos.calendar calendars='["team@group.calendar.google.com"]'` too.
- Each calendar's colour (`backgroundColor`) is the row's stripe; names `summaryOverride ||
  summary`. A calendar id that is not in the list: a notice naming it, the others still show.
- An event on two selected calendars (the same invitation on the person's and a team calendar)
  shows once: keyed by `iCalUID` + `originalStartTime || start`; the primary's copy wins, then one
  where the person is a guest.
- Only the person's own answer counts: on a non-primary calendar `attendees[].self` is that
  calendar, not the person, so the answer there is the attendee entry with the person's address.
  "Mine" (Now / Next, the title bar, reminders, conflicts) = an event of the primary calendar, or one
  the person organizes or is a guest of. Invitations and RSVP are primary-calendar events only (the
  copy RSVP patches).

## Fetching (Calendar API v3)

- **Calendar list** at sign-in and every hour (and on a settings or picker change):
  `calendarList.list` (all pages, at most 3), kept in memory and in `agenda.json`. The account address
  is the primary entry's id.
- **The window**, per selected calendar each poll: `events.list` with `timeMin` = start of today (in
  the display zone), `timeMax` = start of today + `upcomingDays` + 1, `singleEvents=true`,
  `orderBy=startTime`, `maxResults=250` (at most 4 pages), `maxAttendees=100`, `timeZone` = the
  display zone, a `fields` mask for what the panel uses. The primary calendar's call reaches
  `max(upcomingDays, inviteDays)` days instead (one call: the invitations' reach). Cancelled events
  dropped (as the old connector); a malformed event is skipped and counted, never failing the poll.
- **Polling** every `pollMinutes` (default 3, 1..30) with ±25% jitter (Google's advice) while the
  window is open: a timer re-armed after each poll (not `ctx.schedule`, whose interval is fixed).
  Also at once after an RSVP, a sign-in, a settings change and when the day rolls over. 429 / 403
  `usageLimits` / 5xx: interval doubled up to 30 min with a notice, as Gmail. No sync tokens: the
  window must be cut by date anyway, and a sync token cannot carry `timeMax`.
- **Between polls** nothing touches the network: a 15 s `ctx.schedule` tick recomputes now/next,
  due reminders, the badge and the header, and polls when the day changed; the page's own timer
  redraws countdowns every second when under a minute, else every 15 s.
- The last good agenda is kept in the data dir (`agenda.json`, bounded), so opening the window shows
  it at once, marked with its time, until the first poll answers.
- **Time zones** (setting `timeZone`, decision 11): `calendar` (default) uses the primary calendar's
  `timeZone` (the person's Google Calendar setting) for days and times, as Google Calendar on the web
  does; `computer` uses this computer's zone (a traveller). Countdowns are absolute either way. When
  the two differ the footer says which one the panel uses. An event whose `start.timeZone` differs
  shows its own time too in the detail view. All arithmetic is `Intl` (no dependency): a day's start
  is the instant whose wall time in the zone is 00:00 (found from the zone's offset at that time, so
  a DST change on that day is right).
- **All-day** (`date`): a floating date, compared as a date (never through an instant); a chip in its
  day's header row, not a timed row; a multi-day one shows on each day ("day 2 of 5"); end is
  exclusive.

## Model: what an event row knows

`{ key, id, calendarId, title || "(busy)", start, end, allDay, startDate, endDate, type, busy,
status, myResponse (accepted|tentative|declined|needsAction|organizer|none), mine, organizer,
location, join, phone, conference, attendees counts, recurring (recurringEventId), htmlLink, color,
calendar name, jira: [keys], conflicts: [{ key, title, start, end }] }`. `key` is
`sha256(calendarId \n eventId)` cut to 16: the panel posts only keys, never ids or URLs.

- **Join link** (decision 7: Google Meet only): `hangoutLink`, else a `conferenceData.entryPoints`
  `video` `uri` of Google Meet. Always checked: `https://meet.google.com/…`, no credentials, at most
  2048 characters (`ctx.openExternal`'s rule). A Zoom or Teams link in the location or description is
  not picked up. Dial-in: the `phone` entry point `label` + `pin`, in the detail view only.
- **Kinds**: `default` and `fromGmail` are agenda rows; `outOfOffice` a row with an "out of office"
  style (and it makes overlapping meetings a conflict); `focusTime` a row in a muted style;
  `workingLocation` a chip in the day header ("Home", "Office: Building 2"; setting
  `showWorkingLocation`); `birthday` a chip (setting `showBirthdays`). **Declined events hidden**
  (decision 4) unless `showDeclined`, then struck through.
- **Conflicts**: two timed events that are both mine overlap (`a.start < b.end && b.start < a.end`),
  both busy (opaque), neither declined by the person, neither focus time or working location; an
  out-of-office span overlapping a meeting the person has not declined counts. All-day events never
  conflict. Each side gets a ⚠ with "overlaps <other title> 10:00–10:30"; an invitation that would
  clash says so in its lane.

## Panel

Title bar via `ctx.panels.header`: meta `next: Weekly sync in 12 min · ann@example.com` (or
`now: … ends in 18 min`, or `no more meetings today · …`); actions **Join** (the plugin's
`icons/join.svg`, enabled from `joinEarlyMinutes` (default 10) before the next mine meeting with a
join link until its end; title "Join <title>") and ↻. While not signed in: the setup guide, or Sign
in with what is missing, as Gmail and Chat.

From top to bottom (decision: the old cockpit's layout plus Upcoming):

1. **Now / Next** card, with the **day strip** at its top (the old cockpit's now bar, user decision
   2026-11-03): today in 30-minute cells from `lo` = min(08:00, the first event's start) floored to
   the hour to `hi` = max(19:00, the last end) ceiled, at most 24:00; a cell is *busy* (blue) when a
   timed event takes it, *unanswered* (striped amber) when every event there waits for the person's
   answer, else *free* (grey); declined events and free (transparent) ones never count. A red now
   marker, a small hour scale (the ends and every 4 hours between), and "Next: <title> in 40 min · 4
   left today" (meetings only: not declined, not focus time or out of office). Now: the mine meeting(s) running, "ends in 18 min", a thin progress bar, a
   Join button. Next: the next timed mine meeting the person has not declined, "in 12 min" (live
   countdown; "in 2 h 5 min"; tomorrow's first when today is done), its time, calendar colour,
   response mark, Join (from `joinEarlyMinutes` before), ⚠ when it clashes. Out of office now: one
   line saying so.
2. **Invitations** lane (needs a response): `needsAction` primary-calendar events from now to
   `inviteDays`, where the person is a guest and not the organizer. A recurring invitation is one row
   ("repeats · next Tue 10:00", how many in reach). Row: title, when, organizer, ⚠ conflict, and
   **Accept / Maybe / Decline** (a recurring row answers the series; its "this one only" toggle makes
   the buttons answer the next occurrence). Without the RSVP scope: "Sign in again to answer
   invitations". Hidden when empty.
3. **Today** as the old cockpit's **hour timeline** (user decision 2026-11-03, replacing the folded
   rows): the header says what tomorrow starts with ("Tomorrow: 4 events, first 09:30 Standup", "1
   event, Company holiday (all day)", "nothing"); all-day chips (working location, out of office,
   birthdays, holidays) above it; then the hours `lo`..`hi` (as the strip) down the left at 46 px an
   hour, each timed event a block sized by its length (at least 20 px, and counted as 30 minutes for
   the lanes so a short one is never drawn over), overlapping events side by side in lanes (each run
   of overlaps gets as many lanes as it needs; from 3 lanes Join is ▶, from 4 the text shrinks; a
   block under about 110 px wide drops its start time by a container query). A block shows its start,
   the title (ellipsized) and a note: "done" faded, the running one green "now · 12 min left", "in 40
   min", "? not answered" amber, "maybe", "⚠ overlaps" (the conflicts above); Join on a Meet event
   not over (a button that does not open the event; the host opens the link). A click or Enter on a
   block opens the event as a row does; the arrow keys move between rows and blocks. Declined events
   are hidden unless `showDeclined` (then struck through). An empty day says "No events today."
   **The page knows no zone**: the host gives each timed row `from` / `to` in wall minutes of the
   display zone (`layout.placeOf`: an event from the day before starts at 0, one past midnight ends at
   1440 = 24:00) and the day's `clock` (`time.clockAnchors`: the day's start and, on a DST day, the
   change, each with its wall minute), so the red now line is on the blocks' clock. Between state
   messages the page moves the now line and the strip's marker, the blocks' classes and notes and the
   Next line on its own clock (with the countdowns, every 15 s at most), changing texts, classes and
   positions only. The logic is `panels/timeline.js` (pure, `test/timeline.test.js`).
4. **Tomorrow**: rows as before (time range, title, marks, hover buttons).
5. **Upcoming**: a short list of compact one-line rows `Thu 6 · 10:00 · Title` (all-day: `Thu 6 ·
   all day · Title`) of the next events after tomorrow within `upcomingDays` (default 14), at most
   `upcomingCount` (default 10), then "n more in the next 14 days". No working location or birthday
   chips here.

Row: time range (`10:00–10:30`), calendar stripe, title, a camera mark when there is a join link,
the response mark (✓ accepted, ? maybe, · not answered, ✗ declined when shown, nothing when
organizer), a ⚠ conflict mark (tooltip names the other), Jira key chips (`PROJ-123 · In Progress`
when a lookup knows the status). Click / Enter: the detail view. Hover buttons: Join (when it has a
link), ↗ (the event in Google Calendar: its `htmlLink` with `authuser=<address>` added, Gmail's
lesson about the wrong account), Discuss, New. Keyboard as Gmail. Every button posts an action and
the row key; the host finds the URL itself (never one from the page).

**Badge** (`ctx.badge`, decision 6): the number of invitations waiting (a series counts once);
nothing when none.

## Join

- Panel Join (header, Now / Next card, row hover) and a clicked reminder (0.9.5): the host takes the
  event's `join` from the last poll and calls `ctx.openExternal`. A person's click, never unasked: no
  auto-join at the start time.
- `ccc calendar next` prints the join link (Claude can hand it on); there is no `ccc calendar join`
  (not in the agreed command list).

## Reminders (decision 2)

- Setting `reminders`: minutes before the start, a list (default `[10, 2]`, each 0..120, at most 5;
  `[]` = off; 0 = at the start). Setting `reminderSound` (default true): reminders play a sound.
  Setting `reminderSoundChoice` (cc-cockpit 0.9.5 `"format": "sound"`, default `""`): which sound,
  picked in the app's own sound dropdown (App default, the built-in tones, the system's sound files,
  ▶ Play). The notify's `sound` is `false` with `reminderSound` off, else the picked id, or `true`
  for `""` (`reminderSoundOf`). The app checks the id at the ring (one it does not offer rings its
  own sound) and its "Notification sounds" switch silences everything, so the plugin only passes it
  on (a non-string or one over 1024 characters reads as `""`). Two settings, not one: keeping the
  boolean under its name keeps every saved `reminderSound` valid (a type change would make a saved
  `true` fail the new schema and unload the plugin), and a "None" entry in the picker would be a
  second off switch beside the app's. An app before 0.9.5 shows the field as a text input and
  ignores every notify option, so it needs no feature detection.
- For each timed mine event the person has **not declined**, not focus time / out of office /
  working location / birthday: one notification per offset, text only (no description, no guests:
  a notification shows on a shared screen): `In 10 min: Weekly sync, 10:00–10:30` (`Now:`, `Started 3
  min ago:`), title `Google Calendar`.
- Due reminders come from the 15 s tick against the cached agenda, so a slow poll does not lose one.
  An offset is due from `start - minutes` until the meeting has run 5 minutes; when several offsets
  of one event are due at once (the window opened late, the computer slept) only the latest is shown
  and the earlier ones count as done. The text always says the real time left.
- **One reminder per event and offset across windows**: two project windows signed in to the same
  account would each remind. The host first does `ctx.appStorage.increment("remind:<YYYYMMDD of the
  start>:<sha256(address | iCalUID | start | minutes) 16>")` and notifies only when the answer is 1
  (main applies increments one at a time, so exactly one window wins); a window also remembers its own
  keys. Keys of days before yesterday are deleted when the day rolls. A moved meeting (new start)
  gets a new key: it reminds again for the new time. Without a working `appStorage` the window's own
  memory is the only guard.
- **The notification** (`ctx.notify`): the plugin always calls `ctx.notify(text, { title, sound,
  action })` (`sound` true, false or a sound id, above), `action: { label: 'Join' }` only when the event has a Meet link. cc-cockpit 0.9.5
  resolves `{ clicked }` (a click on the body or the Join button); on `clicked` with a Meet link the
  host calls `ctx.openExternal(join)`. cc-cockpit 0.9.4 and older take `notify(text)` only: the extra
  argument is ignored (checked in the 0.9.4 host source: `notify = (text) => …`) and the promise
  resolves `undefined`. So the result's shape tells the versions apart; a rejection that names the
  options (a strict app) is retried as `ctx.notify(text)`. Until a result has shown that clicks work,
  a notification with a Meet link ends `· Join from the Calendar panel`. A rate-limit refusal (10 a
  minute) is logged, not retried.

## The event detail view (reviewer annotate, as Gmail)

Why it helps: meeting prep with Claude (select a line of the agenda description, add a note,
Discuss). `events.get` fresh on open, then `annotate({ title, html, aside, url, key:
'calendar:<sha>', urlLabel: 'Calendar', label: 'Event', start: 'top' })`.

- html: the title, when (in the display zone; the event's own zone too when it differs; "repeats"
  for an instance), where, the join link and dial-in (`label`, PIN), the person's answer ("you have
  not answered", "you organize it"), the description (Google keeps HTML there: Gmail's sanitizer into
  the reviewer's allow-list, http(s)/mailto links only, no remote images), guests grouped (accepted,
  maybe, not answered, declined; optional marked; rooms apart; "guests hidden by the organizer" when
  `guestsCanSeeOtherGuests` is false), attachments as links (Drive files are links, never
  downloaded), conflicts ("overlaps …").
- aside (`dl.facts`): Calendar, When, Your answer, Organizer, Guests (n: x yes, y maybe, z no answer),
  Busy / Free, Visibility, Type, Conference (`conferenceSolution.name`), Jira issue(s).
- `companion` (reviewer `features()` has it, asked each open raced against 2 s): the first Jira issue
  the event names, as the Jira plugin's `document()`, exactly Gmail's "Jira mail" companion path,
  `label: 'Jira · KEY'`, `urlLabel: 'Jira'`; else the issue's status in the aside.
- RSVP is not in the overlay (the reviewer has no caller buttons): the panel row and the CLI.
- Discuss / New send `About the meeting "<title>" on <date> <time>` + the readable text.
- Without a reviewer: the plugin's own read-only page (Discuss, New session), as Gmail.

## RSVP (the only write; decision 1)

- `events.patch` on the primary calendar's copy with `sendUpdates=all` (decision 3: the organizer is
  told, as Google's own UI does): `{ attendeesOmitted: true, attendees: [{ email: <the person's
  attendee entry's email>, responseStatus }] }`. Built in one function from an answer `accepted |
  tentative | declined`, so no caller can pass other fields; `test/manifest.test.js` checks the
  sources for any other write.
- Only when the event has a `self` attendee entry that is not the organizer ("not an invitation:
  you are not among its guests" otherwise).
- A recurring invitation (decision 5): the series by default (the patch goes to `recurringEventId`,
  which is what a new weekly invite asks); one occurrence with the row's "this one only" and `ccc
  calendar rsvp <id> yes --one`.
- Optimistic as Gmail's read state: the row moves out of Invitations at once (every instance of a
  series), the poll that follows confirms; a failure puts it back with "Could not answer …: <reason>.
  It is shown as before." At most 4 at once and 60 a minute (the bounded gate from Gmail's
  `readstate.createGate`).
- No comment, no "propose a new time", no guest count: out of v1.

## Jira (the bronos.jira `jira` service v1, optional)

- With `ctx.services.available('jira')` and `site()` ready: issue keys from the title, location and
  description (`[A-Z][A-Z0-9_]*-N`, not inside a word; `<site>/browse/KEY` links), at most 3 per
  event, Gmail's `jira.js` finder.
- Rows get chips; the status comes from `issue(key)` through Gmail's lookup cache (10 min, at most 10
  lookups a poll, 300 kept); no lookup without a key.
- The detail view: the companion above. No Jira, no chips: exactly the same panel otherwise.

## Triage

Not in v1 (decision 8): the agenda is ordered by time, and an invitation's answer is the person's
own decision. If wanted later: source `calendar`, items = Invitations rows only.

## CLI

`ccc calendar status | refresh | today | next | upcoming | show <id> | rsvp <id> yes|no|maybe
[--one] | login | logout | client <file> | help`. `--calendar <id>` on `show` and `rsvp` for an event
of a non-primary calendar (else the last poll's first match, primary first). No stdin.

- `status`: client, account, scopes granted (RSVP on / off), display zone, calendars (id, name, found
  or not), last poll, counts (today, tomorrow, upcoming, invitations, conflicts), reminders, Jira on /
  off, reviewer, notifications (clickable or not yet seen), errors.
- `today`: today and tomorrow (the old connector's reach), one line per event,
  `10:00–10:30  Weekly sync  [Meet] ✓  <id>`, all-day first, conflicts marked; what Claude reads to
  plan a day.
- `next`: the next mine meeting with countdown, join link, location, response, id.
- `upcoming`: the Upcoming list, one line each, with ids; then the invitations.
- `show <id>`: the detail view as text (no annotate), never a write.
- `rsvp`: waits for Google (at most 25 s, the CLI deadline), prints the new answer.

## Settings (project)

`clientId`, `clientSecret`, `calendars` `[]`, `upcomingCount` 10 (1..50), `upcomingDays` 14 (2..60),
`inviteDays` 30 (1..90), `pollMinutes` 3 (1..30), `reminders` `[10, 2]` (0..120 each, at most 5),
`reminderSound` true, `reminderSoundChoice` `""` (format sound), `joinEarlyMinutes` 10 (0..30), `showDeclined` false, `showBirthdays` true,
`showWorkingLocation` true, `timeZone` `calendar` | `computer`. No regexes; `"format"` only on `clientSecret` (secret) and `reminderSoundChoice` (sound).

## Left out of v1

Creating, editing, moving or deleting events; RSVP comments, "propose a new time", guest counts;
event colours (`colorId` needs `colors.get`; the calendar's colour is used); free/busy of others;
push (public endpoint); sync tokens; reminders with the window closed (the host lives with the
window); work hours (decision 10); Zoom / Teams links outside conference data (decision 7); triage
(decision 8); several accounts in a project; the recurrence rule in words (an instance says
"repeats"); attachment download; Google Tasks; invitations seen in Gmail mail (the Gmail plugin shows
them as mail).

## Decisions (the user, 2026-11-03)

1. **RSVP writes: yes.** Scope `calendar.events.owned`, `calendar.events` the documented fallback if
   the owned one cannot answer an invitation; the scope is one constant; a 403 says what to change.
2. **Reminders**: a configurable list of minutes before the start (`reminders`, default `[10, 2]`)
   and `reminderSound` (default true; which sound: `reminderSoundChoice`), through the extended `ctx.notify` (cc-cockpit 0.9.5) with a
   Join action, feature-detected; one per event and offset across windows; only for events not
   declined.
3. **RSVP notifies the organizer**: `sendUpdates=all`.
4. **Declined meetings hidden** (`showDeclined`, default false).
5. **Recurring invitation**: the series by default, "only this occurrence" as an option.
6. **Badge**: the number of invitations waiting.
7. **Join links**: Google Meet conference data only (no Zoom / Teams detection).
8. **Triage**: not in v1.
9. **Calendars**: primary plus a `calendars` setting (ids from the calendar list; the panel offers a
   picker).
10. **Work hours**: none.
11. **Layout**: the old cockpit's (Now / Next with countdown and Join, Invitations with Accept /
    Maybe / Decline, Today, Tomorrow; Today became its hour timeline and the card got its day strip,
    2026-11-03) plus an Upcoming short list
    (`upcomingCount` 10, `upcomingDays` 14); title bar meta (the next meeting's countdown), Join and
    refresh. Polling 3 min ± jitter; time zones correct (the calendar's / the person's zone; all-day
    events); several calendars merged with their colours.
