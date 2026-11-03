'use strict'
// The setup guide the panel shows while not signed in (design "Setup"): numbered steps with the exact
// Google Cloud console pages. The page gets the steps with link ids only; a click posts the id and the
// host opens the fixed URL here with ctx.openExternal, so a page (or anything that reached it) cannot
// make the host open an address of its choosing. The README has the same steps in more words.
// (From bronos.chat's setup.js; the steps are Calendar's.)

const LINKS = {
  project: 'https://console.cloud.google.com/projectcreate',
  calendarApi: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
  branding: 'https://console.cloud.google.com/auth/branding',
  audience: 'https://console.cloud.google.com/auth/audience',
  scopes: 'https://console.cloud.google.com/auth/scopes',
  clients: 'https://console.cloud.google.com/auth/clients/create',
  readme: 'https://github.com/BronOS/cc-cockpit-calendar#set-up-google-cloud',
  permissions: 'https://myaccount.google.com/connections',
}

/** The steps: `{ text, links: [{ id, label }] }`. */
const STEPS = [
  {
    text: 'Create a Google Cloud project (or use the one you made for the Gmail or Chat plugin). It is yours: nobody else sees your calendar through it. A personal Google account works as well as a Workspace one.',
    links: [{ id: 'project', label: 'New project' }],
  },
  { text: 'Enable the Google Calendar API in that project.', links: [{ id: 'calendarApi', label: 'Calendar API' }] },
  {
    text: 'Set up the consent screen (Google Auth Platform > Get started): an app name and your address. Audience: Internal for a Workspace account (no verification, no expiry); a personal account: External, then Publish app (In production: a Testing app\'s sign-in ends every 7 days).',
    links: [{ id: 'branding', label: 'Branding' }, { id: 'audience', label: 'Audience' }],
  },
  {
    text: 'Data access: add the scopes .../auth/calendar.calendarlist.readonly, .../auth/calendar.events.readonly and .../auth/calendar.events.owned (Google Calendar API). Google calls them "sensitive", not restricted. The only change the plugin makes is your own answer to an invitation (Accept / Maybe / Decline).',
    links: [{ id: 'scopes', label: 'Data access' }],
  },
  { text: 'Clients > Create client: application type "Desktop app", any name. Download the JSON file Google offers (the Gmail or Chat plugin\'s file works too).', links: [{ id: 'clients', label: 'Create client' }] },
  {
    text: 'Paste the whole file below and press Save client (or run `ccc calendar client <file>`), then Sign in with Google and leave every box ticked. A personal account sees "Google hasn\'t verified this app" once: Advanced > Go to <your app name>.',
    links: [],
  },
]

/** The URL of a link id from the page, or null for any other value. */
function linkUrl(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(LINKS, id) ? LINKS[id] : null
}

module.exports = { LINKS, STEPS, linkUrl }
