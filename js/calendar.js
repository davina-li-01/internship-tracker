/**
 * calendar.js — Google Calendar sync (ORB-15)
 *
 * Orbit only works if you remember to log touchpoints, which is exactly the
 * habit that fails. This reads your calendar and finds the meetings you already
 * had with people in your network, so staying current stops depending on memory.
 *
 * Runs entirely in the browser, on purpose:
 *
 *   - The access token lives in a variable and is never written to disk. There
 *     is no refresh token and nothing in the database. Close the tab and
 *     Orbit's access is gone.
 *   - Two things ARE kept in localStorage, and neither can be used to reach
 *     your calendar: a flag saying you connected before, and a cache of
 *     upcoming meeting titles so the dashboard renders without waiting on
 *     Google. Disconnect clears both.
 *   - The client id below is NOT a secret. Google issues these to be shipped in
 *     browser code; that is what makes this design possible without a server.
 *   - The scope is calendar.events.readonly. Orbit cannot create, change or
 *     delete anything on your calendar, and Google enforces that, not us.
 *
 * The cost is that syncing only happens while Orbit is open. That was the
 * deliberate trade (2026-08-09) against storing Google refresh tokens in the
 * database and submitting the app for Google's verification review.
 *
 * Everything above `connectCalendar()` is pure and unit tested. The matching
 * rules are the part that can quietly corrupt relationship health, so they are
 * kept away from the network code.
 */

const CLIENT_ID = "4293730503-517jknqdk0kfkouikg9h20hsektkrcsf.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const GIS_SRC = "https://accounts.google.com/gsi/client";

/** How far back to look. Long enough to catch up after a week away. */
export const LOOKBACK_DAYS = 30;

/**
 * Above this many attendees it is a broadcast, not a conversation. Logging an
 * all-hands as "I caught up with them" would roll their cadence forward and
 * make a cold relationship look healthy — the exact failure Orbit exists to
 * prevent.
 */
export const MAX_ATTENDEES = 12;

// ── Pure matching ─────────────────────────────────────────────────────────────

const norm = (s) => String(s || "").trim().toLowerCase();

/** Calendar returns all-day events as `date` and timed ones as `dateTime`. */
export function eventDate(event) {
  const raw = event?.end?.dateTime || event?.end?.date
    || event?.start?.dateTime || event?.start?.date || "";
  return raw ? String(raw).slice(0, 10) : "";
}

/**
 * Did this meeting actually happen, as far as the calendar knows?
 *
 * A calendar entry is an intention, not a record. Cancelled events, ones you
 * declined, and things still in the future are all evidence of nothing.
 */
export function eventHappened(event, todayIso) {
  if (!event || event.status === "cancelled") return false;

  const date = eventDate(event);
  if (!date || date > todayIso) return false;

  const attendees = event.attendees || [];
  if (attendees.length > MAX_ATTENDEES) return false;

  // `self` marks you among the attendees. If you declined, you were not there.
  const me = attendees.find((a) => a.self);
  if (me && me.responseStatus === "declined") return false;

  return true;
}

/**
 * Which people in the network were on this invite.
 *
 * Matching is by email, because it is the only identifier both sides share. A
 * contact with no email saved can never match — that is the known cost of this
 * approach, and it is why the epic lists it as blocked on real contacts having
 * emails.
 */
export function attendeesInNetwork(event, contacts) {
  const byEmail = new Map();
  for (const c of contacts) {
    const email = norm(c.email);
    if (email) byEmail.set(email, c);
  }

  const found = [];
  const seen = new Set();
  for (const attendee of event.attendees || []) {
    if (attendee.self) continue;
    if (attendee.responseStatus === "declined") continue;
    const contact = byEmail.get(norm(attendee.email));
    if (!contact || seen.has(contact.id)) continue;
    seen.add(contact.id);
    found.push(contact);
  }
  return found;
}

/**
 * Already logged, from a previous sync or by hand on the same day?
 *
 * Two different checks, and which one applies matters. An entry that carries a
 * sourceEventId came from a sync, so its id is authoritative — comparing it any
 * other way would suppress a genuinely different meeting that happened to share
 * a title and a date. Only hand-typed entries need the fuzzy check, and they
 * need it because on day one your history is full of meetings you wrote up
 * yourself that the first sync would otherwise duplicate.
 */
export function alreadyLogged(contact, event) {
  const date = eventDate(event);
  const summary = norm(event.summary);

  return (contact.interactions || []).some((i) => {
    if (i.sourceEventId) return i.sourceEventId === event.id;
    return Boolean(summary) && i.date === date && norm(i.notes).includes(summary);
  });
}

/** How far ahead the dashboard looks. */
export const UPCOMING_DAYS = 7;

/**
 * How you will actually be meeting.
 *
 * Google puts this in three different places depending on how the invite was
 * made, so all three are checked before falling back to the location field.
 */
export function meetingMedium(event) {
  const conf = event?.conferenceData;
  const solution = conf?.conferenceSolution?.name || "";
  const entry = (conf?.entryPoints || []).find((p) => p.entryPointType === "video");

  if (entry?.uri || event?.hangoutLink) {
    const uri = entry?.uri || event.hangoutLink;
    let label = solution;
    if (!label) {
      if (/zoom\./i.test(uri)) label = "Zoom";
      else if (/teams\.microsoft/i.test(uri)) label = "Teams";
      else if (/meet\.google/i.test(uri)) label = "Google Meet";
      else label = "Video call";
    }
    return { label, url: uri };
  }

  const location = (event?.location || "").trim();
  if (!location) return { label: "No location set", url: "" };
  // A bare URL in the location field is still a link, not a place.
  if (/^https?:\/\//i.test(location)) return { label: "Video call", url: location };
  return { label: location, url: "" };
}

/** Start time, as a date plus a rendered clock time. Falls back for all-day. */
export function eventStart(event) {
  const iso = event?.start?.dateTime || "";
  if (!iso) {
    const date = event?.start?.date || "";
    return { date, time: "All day", iso: date ? date + "T00:00:00Z" : "" };
  }
  const d = new Date(iso);
  return {
    date: iso.slice(0, 10),
    time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    iso
  };
}

/**
 * Meetings still ahead of you, with the people from your network on them.
 *
 * Deliberately not filtered the way findCandidates is: an event you have not
 * responded to yet is still worth knowing about, and nothing here writes to
 * your data, so a wrong guess costs a line on a dashboard rather than a
 * corrupted reach-out date.
 */
export function findUpcoming(events, contacts, nowMs = Date.now()) {
  const out = [];

  for (const event of events || []) {
    if (!event || event.status === "cancelled") continue;

    const me = (event.attendees || []).find((a) => a.self);
    if (me && me.responseStatus === "declined") continue;

    const start = eventStart(event);
    if (!start.iso || new Date(start.iso).getTime() < nowMs) continue;

    const people = attendeesInNetwork(event, contacts);
    if (!people.length) continue;

    out.push({
      eventId: event.id,
      title: (event.summary || "Untitled meeting").trim(),
      date: start.date,
      time: start.time,
      iso: start.iso,
      medium: meetingMedium(event),
      people: people.map((c) => ({
        id: c.id,
        name: c.name,
        // The point of showing this at all: what you meant to bring up.
        talkingPoints: (c.followUps || [])
          .filter((f) => !f.completed)
          .slice(0, 3)
          .map((f) => f.text)
      }))
    });
  }

  return out.sort((a, b) => a.iso.localeCompare(b.iso));
}

// ── Cached upcoming meetings ─────────────────────────────────────────────────
//
// Note this is a real change to "nothing is stored": meeting titles, times and
// the matched names are written to localStorage so the dashboard can render the
// widget instantly instead of blocking on Google every time it loads.
//
// The token is still never stored, which is the part that matters for security.
// This is display data, on your own device, and Disconnect clears it.

const UPCOMING_KEY = "orbit_calendar_upcoming";

export function cacheUpcoming(items, now = Date.now()) {
  try {
    localStorage.setItem(UPCOMING_KEY, JSON.stringify({ at: now, items }));
  } catch { /* quota or private mode — the widget just stays empty */ }
}

export function readUpcoming(now = Date.now()) {
  try {
    const raw = JSON.parse(localStorage.getItem(UPCOMING_KEY) || "null");
    if (!raw || !Array.isArray(raw.items)) return [];
    // Drop anything that has since happened, so a stale cache cannot show you
    // a meeting you already had as though it were still ahead.
    return raw.items.filter((i) => new Date(i.iso).getTime() >= now);
  } catch {
    return [];
  }
}

export function clearUpcoming() {
  localStorage.removeItem(UPCOMING_KEY);
}

/** Calendar's own guess at what kind of touchpoint this was. */
export function interactionTypeFor(event) {
  const text = norm(event.summary) + " " + norm(event.location);
  if (/\bcoffee|lunch|breakfast|dinner|drinks\b/.test(text)) return "coffee chat";
  if (/\bcall|phone|dial\b/.test(text)) return "phone call";
  if (/\bconference|meetup|summit|panel|networking\b/.test(text)) return "event";
  return "meeting";
}

/**
 * Turn a calendar feed into a list of conversations worth logging.
 *
 * Returns candidates rather than writing anything. Deliberate: a meeting on the
 * calendar is not proof you spoke, and logging one rolls the cadence forward.
 * Getting that wrong makes a drifting relationship look healthy, which is worse
 * than logging nothing at all. The user confirms; Orbit does the remembering.
 */
export function findCandidates(events, contacts, todayIso) {
  const candidates = [];

  for (const event of events || []) {
    if (!eventHappened(event, todayIso)) continue;

    for (const contact of attendeesInNetwork(event, contacts)) {
      if (alreadyLogged(contact, event)) continue;
      candidates.push({
        contactId: contact.id,
        contactName: contact.name,
        eventId: event.id,
        title: (event.summary || "Untitled meeting").trim(),
        date: eventDate(event),
        type: interactionTypeFor(event)
      });
    }
  }

  // Most recent first, so the list reads the way the log does.
  return candidates.sort((a, b) => b.date.localeCompare(a.date));
}

// ── Google Identity Services ──────────────────────────────────────────────────

let tokenClient = null;
let accessToken = "";        // memory only, deliberately

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Could not load Google sign-in.")));
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Google sign-in."));
    document.head.appendChild(script);
  });
}

/**
 * Ask Google for an access token.
 *
 * @param interactive  false tries to renew silently for an already-granted
 *                     session; true always shows the account chooser.
 */
export async function requestAccessToken({ interactive = true } = {}) {
  await loadGis();

  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      prompt: interactive ? "consent" : "",
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        accessToken = response.access_token;
        resolve(accessToken);
      },
      error_callback: (err) => {
        reject(new Error(err?.type === "popup_closed"
          ? "Google sign-in was closed before finishing."
          : (err?.message || "Google sign-in failed.")));
      }
    });
    tokenClient.requestAccessToken();
  });
}

export function isConnected() {
  return Boolean(accessToken);
}

// ── Remembering that you connected ────────────────────────────────────────────
//
// The token itself is still never stored. All that is kept is a flag saying you
// have granted access before, which is what lets Orbit try for a token silently
// on load instead of making you go and ask for one. Clearing it costs you a
// click, not your data.

const CONNECTED_KEY = "orbit_calendar_connected";
const LAST_SYNC_KEY = "orbit_calendar_last_sync";
const LAST_NUDGE_KEY = "orbit_calendar_last_nudge";

/** Every page load is a fresh load in a multi-page app — do not sync on each. */
export const AUTO_SYNC_HOURS = 4;

/** How often re-connecting may be suggested after a silent grant fails. */
export const RECONNECT_NUDGE_HOURS = 24;

/** Nothing on the background path may wait on Google indefinitely. */
export const SILENT_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out talking to Google.")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

const readTime = (key) => Number(localStorage.getItem(key) || 0);
const stampTime = (key, now) => localStorage.setItem(key, String(now));

export function rememberConnection() {
  localStorage.setItem(CONNECTED_KEY, "1");
}

export function isRemembered() {
  return localStorage.getItem(CONNECTED_KEY) === "1";
}

export function forgetConnection() {
  localStorage.removeItem(CONNECTED_KEY);
  localStorage.removeItem(LAST_SYNC_KEY);
  localStorage.removeItem(LAST_NUDGE_KEY);
}

export function autoSyncDue(now = Date.now()) {
  if (!isRemembered()) return false;
  return now - readTime(LAST_SYNC_KEY) >= AUTO_SYNC_HOURS * 3600_000;
}

export function markSynced(now = Date.now()) { stampTime(LAST_SYNC_KEY, now); }

export function reconnectNudgeDue(now = Date.now()) {
  return now - readTime(LAST_NUDGE_KEY) >= RECONNECT_NUDGE_HOURS * 3600_000;
}

export function markReconnectNudged(now = Date.now()) { stampTime(LAST_NUDGE_KEY, now); }

/**
 * Try to sync without any user interaction.
 *
 * Returns candidates on success, or null if Google would need to ask you
 * something. It never throws and never blocks the page: a failure here is a
 * normal Tuesday (tokens for apps in Testing mode expire in about a week), not
 * an error worth interrupting anyone over.
 *
 * `prompt: ""` asks Google to reissue silently. If it cannot — no active Google
 * session, consent withdrawn, token long expired — it would need a popup, and a
 * popup that nobody clicked for is blocked by the browser anyway. Either way we
 * land in the catch and return null.
 */
export async function silentSync(contacts, todayIso) {
  if (!isRemembered()) return null;
  try {
    // The timeout is not belt and braces — it is required. requestAccessToken
    // only settles when Google invokes its callback, so a script that never
    // loads or a popup the browser blocked without telling us leaves that
    // promise pending forever. On a page-load path that is a leak that also
    // means the sync stamp never gets written, so every future load retries.
    await withTimeout(requestAccessToken({ interactive: false }), SILENT_TIMEOUT_MS);
    const events = await withTimeout(fetchEventWindow(), SILENT_TIMEOUT_MS);
    const upcoming = findUpcoming(events, contacts);
    cacheUpcoming(upcoming);
    return { candidates: findCandidates(events, contacts, todayIso), upcoming };
  } catch {
    return null;
  }
}

/** Drops the token. Nothing was stored, so there is nothing else to clear. */
export function disconnectCalendar() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = "";
  forgetConnection();
  clearUpcoming();
}

/**
 * Events around now, in one request.
 *
 * Past and future come from the same call on purpose: the dashboard wants what
 * is ahead and the sync wants what already happened, and asking Google twice
 * for overlapping windows would be two round trips for one answer.
 */
export async function fetchEventWindow(backDays = LOOKBACK_DAYS, forwardDays = UPCOMING_DAYS) {
  if (!accessToken) throw new Error("Not connected to Google Calendar.");

  const timeMin = new Date(Date.now() - backDays * 86400000).toISOString();
  const timeMax = new Date(Date.now() + forwardDays * 86400000).toISOString();
  const url = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    + "?timeMin=" + encodeURIComponent(timeMin)
    + "&timeMax=" + encodeURIComponent(timeMax)
    + "&singleEvents=true&orderBy=startTime&maxResults=250";

  const res = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });

  if (res.status === 401 || res.status === 403) {
    accessToken = "";
    throw new Error("Google access expired. Connect again.");
  }
  if (!res.ok) {
    throw new Error("Google Calendar returned " + res.status + ".");
  }

  const data = await res.json();
  return data.items || [];
}

/** Kept for callers that only care about what already happened. */
export async function fetchRecentEvents(lookbackDays = LOOKBACK_DAYS) {
  return fetchEventWindow(lookbackDays, 0);
}

/**
 * Connect and return the conversations worth logging.
 * Writes nothing — the caller decides what to keep.
 */
export async function connectCalendar(contacts, todayIso, { interactive = true } = {}) {
  await requestAccessToken({ interactive });
  // Only remembered once a grant has actually succeeded, so a cancelled popup
  // does not leave Orbit trying silently forever.
  rememberConnection();
  const events = await fetchEventWindow();
  cacheUpcoming(findUpcoming(events, contacts));
  return findCandidates(events, contacts, todayIso);
}
