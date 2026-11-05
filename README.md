# Google Calendar for cc-cockpit

`bronos.calendar` shows your Google Calendar in a cc-cockpit panel beside your Claude tabs, reminds
you before a meeting starts, and hands an event to Claude to discuss. **It changes nothing in Google
Calendar but your own answer to an invitation** (Accept, Maybe, Decline). It never creates, moves,
edits or deletes an event.

- **The day strip** at the top: today in half-hour cells from 08:00 to 19:00 (wider when a meeting
  is outside), blue where you are busy, striped amber where only an invitation you have not
  answered sits, grey where you are free (declined and "free" events do not count), a red mark at
  now, and "Next: Design review in 40 min · 4 left today".
- **Now / Next**: the meeting running (with a progress bar and how long it has left) and the next
  one with a countdown and **Join** (Google Meet).
- **Invitations**: invitations waiting for your answer, with Accept, Maybe and Decline. A recurring
  invitation is one row and answers the whole series; "this one only" answers the next occurrence.
  The panel's badge is the number of invitations waiting.
- **Today** as an hour timeline: the hours down the side, each meeting a block as long as it lasts,
  meetings at the same time side by side, the ones that are over faded, the one running green ("now ·
  12 min left"), one you have not answered amber ("? not answered"), a clash marked "⚠ overlaps",
  **Join** on a Meet meeting, and a red line at now that moves with the clock. All-day events are
  chips above it; the header says what tomorrow starts with ("Tomorrow: 4 events, first 09:30
  Standup"). Click a block (or Enter on it) to open the event.
- **Tomorrow** and **Upcoming**: short lists; Upcoming is the next events after tomorrow, one line
  each (day · time · title).
- **Reminders**: a desktop notification 10 and 2 minutes before each meeting you have not declined
  (settings `reminders`, `reminderSound`, `reminderSoundChoice`). One per meeting and time, however many project windows
  are open. On cc-cockpit 0.9.5 and later the notification has a **Join** button; clicking it opens
  the meeting.
- **The title bar**: the meeting now or next and its countdown, **Join** (from a few minutes before
  the start until the end), refresh.
- **Open an event** (click a row or a block): it opens in the reviewer overlay as a clean page with the
  details column (when, your answer, organizer, guests, conference), notes, Discuss (the Claude tab
  you are looking at) and New session. With the Jira plugin enabled, an issue key in the event
  (`ACME-12`) gets a status chip on the row and the issue opens beside the event.
- **Open in Calendar** (↗) and **Join** open your browser.
- Several calendars merged, each with its colour: your primary calendar, the ones in the
  `calendars` setting, and the ones you switch on in the panel's Calendars picker.
- `ccc calendar ...` from any tab of the project.

Each project signs in on its own: two projects can use different Google accounts.

## Inbox

From 0.2.0 the plugin provides the `calendar` service (v1) to other plugins of the project, for the
Inbox plugin: `day({ date? })` (the events of a day and what tomorrow holds), `upcoming({ count,
days })`, `respond(id, 'accepted' | 'tentative' | 'declined')` (the same answer as Accept, Maybe and
Decline in the panel) and `open(id)` (the event page, as a click in the panel opens it). Reads come
from the last poll and make no Google call; declined events are left out unless "Show declined
events" is on; a Meet link is passed on only when it is https. A `changed` event follows each poll
and each answer. Nothing to set up, and it works on an app without Inbox support.

## Agenda slot

From 0.3.0 the plugin fills the `agenda` slot another plugin places in its panel (the Inbox draws it above or
below its list; pick the provider in Settings > This project if several plugins offer one): today as a
small timeline with the now line, the meeting now or next with a countdown and Join, and the invitations
waiting for your answer with Accept and Decline. Join opens a Meet link only when it is https. The slot needs a
cc-cockpit with slots (0.10 or later); on an older app the plugin works as before, without it. It
adds no `inbox-feed`: the Inbox reads the `calendar` service.

## Requirements

- **cc-cockpit 0.9.4 or later** (plugin API 1 with `ctx.oauth` reporting the granted scopes,
  `ctx.secrets`, the panel title bar, `ctx.openExternal`, `ctx.appStorage`). On an older app the
  panel says so and the plugin does nothing. cc-cockpit 0.9.5 adds clickable reminders with a Join
  button; on 0.9.4 the reminder is text only and says to join from the panel.
  The agenda slot needs cc-cockpit 0.10.0 and Inbox 0.2.0 (the plugin that places the slot); the rest works
  on 0.9.4.
- **A Google account**, personal or Workspace.
- **Your own Google Cloud OAuth client** (free; the steps are below and in the panel). The client
  file of the Gmail or Chat plugin works here too.
- Optional: the **reviewer** (bundled with cc-cockpit) for the event page with notes; without it the
  plugin opens its own read-only page with Discuss and New session. The **Jira plugin**
  (`bronos.jira`) for issue chips and the issue beside the event.

## Set up Google Cloud

About ten minutes, once per Google account. The panel shows the same steps with buttons that open
each console page.

1. **A project**: <https://console.cloud.google.com/projectcreate> (or the one you made for the Gmail
   or Chat plugin). It is yours alone: nobody else sees your calendar through it.
2. **Enable the Google Calendar API** in that project:
   <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>.
3. **The consent screen**: Google Auth Platform > Get started
   (<https://console.cloud.google.com/auth/branding>): an app name and your address. **Audience**
   (<https://console.cloud.google.com/auth/audience>):
   - a Workspace account: user type **Internal** (no verification, no warning, no expiry);
   - a personal account: **External**, then **Publish app** (In production). A Testing app's
     sign-ins end every 7 days; a published app that is not verified shows "Google hasn't verified
     this app" once at sign-in (Advanced > Go to <your app name>). Verification is not needed for
     your own use.
4. **Data access** (<https://console.cloud.google.com/auth/scopes>): Add or remove scopes, and tick
   (Google Calendar API)
   - `.../auth/calendar.calendarlist.readonly` ("See the list of Google calendars you're subscribed
     to")
   - `.../auth/calendar.events.readonly` ("View events on all your calendars")
   - `.../auth/calendar.events.owned` ("See, create, change, and delete events on Google calendars
     you own"): only for your answer to an invitation; the plugin writes nothing else.

   Update, Save. All three are "sensitive", none "restricted".
5. **The client** (<https://console.cloud.google.com/auth/clients/create>): application type
   **Desktop app**, any name, Create, then **Download JSON**. A "Web application" client does not
   work (the sign-in returns to `127.0.0.1` on a random port, which only a Desktop client allows).
6. **Give the client to the plugin**: paste the whole file into the box in the Google Calendar panel
   and press **Save client**, or from a tab `ccc calendar client ~/Downloads/client_secret_<id>.json`.
   (Or enter the client ID and secret in Settings > This project > Google Calendar; a pasted file
   wins.)
7. **Sign in**: **Sign in with Google** in the panel (or `ccc calendar login`) and leave every box
   ticked. A box left unticked is named in the panel: without the first two nothing can be shown;
   without the third the agenda works but invitations cannot be answered from here.

   **"Access blocked"** (Error 403 access_denied): the app is in Testing and this account is not a
   test user (or belongs to another organisation). Publish the app, set it to Internal, or add the
   account as a test user, then press **Start over** in the panel (or run `ccc calendar login`
   again): Google's error page never returns to the app, and Start over cancels the stuck sign-in.

To stop: **Sign out** in the panel (or `ccc calendar logout`) deletes the stored sign-in; to revoke
the app at Google: <https://myaccount.google.com/connections>. Uninstalling the plugin deletes its
keychain entries (the sign-in) on purpose; the pasted client file is kept with the project's plugin
storage, so after a reinstall you only sign in again.

### If Google refuses the RSVP scope

The plugin answers invitations with `calendar.events.owned`, the narrowest scope Google's
`events.patch` takes: an invitation's copy lives on your primary calendar, which you own. Google's
documentation does not say in words that this scope covers answering an invitation. If Accept,
Maybe or Decline fails with "Google refused the answer for its scope (403) although this sign-in
holds calendar.events.owned", change one line:

1. In `dist/lib/oauth-client.js` set
   `const RSVP_SCOPE = \`${G}calendar.events\`` (instead of `calendar.events.owned`).
2. On the console's Data access page add `.../auth/calendar.events` ("View and edit events on all
   your calendars").
3. **Sign in again** in the panel.

Nothing else needs to change: every text and check reads that constant. The plugin still writes only
your own answer (the one request shape `dist/lib/http.js` allows).

## Answering an invitation

- The answer is one `events.patch` of the event on your primary calendar with exactly
  `{ "attendeesOmitted": true, "attendees": [{ "email": <you>, "responseStatus": <answer> }] }` and
  `sendUpdates=all`: the organizer is told, as when you answer in Google Calendar. Nothing else of
  the event can be sent (`dist/lib/http.js` refuses any other body).
- A recurring invitation answers the whole series (the patch goes to the recurring event); "this one
  only" (or `ccc calendar rsvp <id> yes --one`) answers that occurrence.
- The row changes at once and leaves Invitations; when Google refuses, it is put back and a notice
  says why ("Could not answer ... It is shown as before."). The next poll replaces the guess with
  what Google says.
- Only an invitation on your primary calendar where you are a guest can be answered; an event you
  organize, or one of another calendar, is refused before any call.

## Reminders

For each timed meeting of yours that you have not declined (not focus time, out of office, working
location or birthdays): one notification per offset of `reminders` (default 10 and 2 minutes
before), up to 5 minutes into the meeting. When several are due at once (the window opened late,
the computer slept) only the latest shows, with the real time left: "In 2 min: Weekly sync (Google
Meet), 10:00–10:30". Each project window runs its own plugin, and they agree through cc-cockpit's
app-wide store which one shows it, so you get one notification. A meeting that moves reminds again
for its new time. Reminders run only while a project window with the plugin is open.

## Settings (per project)

Settings > This project > Google Calendar, or from a tab: `ccc plugin config bronos.calendar
<key>=<value>` (everything but the client secret).

| Setting | Default | |
|---|---|---|
| `clientId` | | your Desktop client's ID (ends in `.apps.googleusercontent.com`); a pasted client file wins; changing it signs you out |
| `clientSecret` | | secret, Settings only; the same client's secret |
| `calendars` | `[]` | calendar ids shown beside your primary one (an address, or `…@group.calendar.google.com` from the calendar's settings); each must be in your calendar list |
| `upcomingCount` | 10 | events after tomorrow in the Upcoming list (1 to 50) |
| `upcomingDays` | 14 | how far ahead Upcoming looks, and how far each calendar is read (2 to 60) |
| `inviteDays` | 30 | how far ahead the primary calendar is read for invitations (1 to 90) |
| `pollMinutes` | 3 | only while the project's window is open, ±25% so windows do not poll together |
| `reminders` | `[10, 2]` | minutes before a meeting (0: at the start); `[]`: no reminders |
| `reminderSound` | `true` | reminders play a sound (the app's Notification sounds switch still silences all) |
| `reminderSoundChoice` | `""` | which sound: a picker in Settings with ▶ Play; `""` (App default) is the app's Sound; needs cc-cockpit 0.9.5 |
| `joinEarlyMinutes` | 10 | from how long before the start the title bar's Join opens the meeting |
| `showDeclined` | `false` | declined events, struck through (never reminded, never Now / Next) |
| `showBirthdays` | `true` | |
| `showWorkingLocation` | `true` | the Home / Office chip of the day |
| `timeZone` | `calendar` | `calendar` (your primary calendar's zone, as Google Calendar shows it) or `computer` |

```sh
ccc plugin config bronos.calendar 'reminders=[15,5]' upcomingCount=20
ccc plugin config bronos.calendar 'calendars=["acme-team@group.calendar.google.com"]'
```

## How a poll works

Every `pollMinutes` while the window is open, and with the refresh icon in the title bar:

1. Your calendar list (`calendarList.list`), at most once an hour: names, colours, the primary
   calendar (its id is your address, its time zone the display zone).
2. Each shown calendar's events from today's midnight on (`events.list` with `singleEvents`: every
   occurrence of a recurring event is its own row), two calendars at a time: `upcomingDays` ahead,
   the primary one `inviteDays` ahead for invitations. Cancelled events are left out.
3. The calendars merged: one event on two calendars shows once (your primary copy first); overlaps
   of your busy meetings are marked ⚠.

Between polls a 15 s tick moves the clock (Now / Next, the countdowns, reminders, a new day polls at
once). When Google is busy (429 or 5xx) the interval doubles, up to 30 minutes, with a notice. A
calendar that fails keeps its last events and is named.

Times are shown in your primary calendar's zone (or the computer's, with `timeZone: computer`); the
footer says when the two differ. All-day events keep their dates whatever the zone.

Click a row (or Enter) to open it. The hover buttons: **Join**, **↗** (Open in Calendar),
**Discuss**, **New**. Keyboard: Tab to a row, arrows move, Enter or Space opens, Tab goes on to the
row's buttons.

## CLI

```
ccc calendar status              client, account, scopes, time zone, calendars, last poll, counts, errors
ccc calendar refresh             poll Google Calendar now and print the counts
ccc calendar today               today and tomorrow, one line per event (with its id)
ccc calendar next                the next meeting: countdown, join link, where, your answer
ccc calendar upcoming            the events after tomorrow, then the invitations
ccc calendar show <id>           an event as readable text (guests, description, join link)
ccc calendar rsvp <id> yes|no|maybe [--one]
ccc calendar login | logout
ccc calendar client <file>       use the OAuth client file downloaded from Google Cloud
ccc calendar help
```

`show` and `rsvp` take `--calendar <id>` for an event of another calendar (`today` prints it).

## Privacy

- The plugin talks to Google only: the sign-in through cc-cockpit's OAuth (your browser,
  `accounts.google.com` and `oauth2.googleapis.com`), your calendar through `www.googleapis.com`
  (Calendar API v3, three request shapes, checked in `dist/lib/http.js`). The access token goes
  nowhere else, never in a URL, and never follows a redirect. Tokens and the client secret are never
  logged, shown in the panel or printed by `ccc calendar`.
- The only change it makes in Google Calendar is your answer to an invitation.
- The refresh token is in the OS keychain (cc-cockpit's secrets store) under a key of this project
  and client; the access token stays in memory. A pasted client file is kept in the plugin's storage
  for this project (Google does not treat a Desktop client's secret as confidential).
- An event's description is shown through the same HTML sanitizer as the Gmail plugin's: no script,
  no remote picture, links only to http(s) and mailto.
- Discuss and New session put the event's text (title, time, guests, description) into a Claude
  Code session, which sends it to Anthropic like anything else you type there. Nothing else leaves.
- Kept in the project's data folder: the last agenda (`agenda.json`: the shown calendars' events in
  the window, compact). In the app-wide store: one counter per reminder shown, deleted after two
  days.

## Development

Plain JavaScript, no build step and no dependencies: `dist/host.js` and `dist/lib/*.js` run as they
are. `npm test` (`node --test test/`) runs the suites (node:test, a fake Google Calendar and sign-in
with a made-up week; nothing reaches the network). Design: `docs/design.md`. Where the cc-cockpit
guide fell short while building it: `FRICTION.md`.

Link a checkout from a cc-cockpit tab: `ccc plugin link <folder>`; logs: `ccc plugin logs
bronos.calendar`.

## License

MIT, see LICENSE.
