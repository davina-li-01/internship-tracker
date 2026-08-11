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
/**
 * Two read-only scopes, and both are needed.
 *
 * `calendar.events.readonly` reads events. It does NOT permit calendarList,
 * which is a separate scope — an incorrect assumption that cost a day: without
 * it `refreshAccountInfo()` 403s, so the connected address is never stored, so
 * `requestAccessToken` has no `hint` to pass, so Google shows the account
 * chooser on every reconnect. It also meant "change which calendar" in Settings
 * could never work.
 *
 * `calendar.calendarlist.readonly` is the narrowest scope that fixes both. The
 * broader `calendar.readonly` would also do it and is not worth asking for.
 */
const SCOPE = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
].join(" ");
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

/** Every address a contact can be reached at, lower-cased, primary included. */
export function contactAddresses(contact) {
  const out = new Set();
  const primary = norm(contact?.email);
  if (primary) out.add(primary);
  for (const entry of contact?.emails || []) {
    const address = norm(entry?.address);
    if (address) out.add(address);
  }
  return [...out];
}

/** Calendar returns all-day events as `date` and timed ones as `dateTime`. */
export function eventDate(event) {
  const raw = event?.end?.dateTime || event?.end?.date
    || event?.start?.dateTime || event?.start?.date || "";
  return raw ? String(raw).slice(0, 10) : "";
}

/**
 * When this meeting is over, in ms.
 *
 * Google's all-day `end.date` is EXCLUSIVE — a one-day event on the 10th ends
 * on the 11th — so that date parsed at midnight is already the moment it is
 * over. A timed event ends when it says it does. Returns null when the event
 * carries no usable end at all, and callers treat that as "cannot say".
 */
export function eventEndMs(event) {
  const timed = event?.end?.dateTime || event?.start?.dateTime;
  if (timed) {
    const ms = new Date(timed).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const allDay = event?.end?.date || event?.start?.date;
  if (!allDay) return null;
  const ms = new Date(String(allDay).slice(0, 10) + "T00:00:00").getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Did this meeting actually happen, as far as the calendar knows?
 *
 * A calendar entry is an intention, not a record. Cancelled events, ones you
 * declined, and things still ahead of you are all evidence of nothing.
 *
 * "Still ahead" used to mean a whole DAY ahead, which was the wrong unit. A
 * coffee at four in the afternoon carries today's date from breakfast onwards,
 * so Orbit spent the morning offering to log a conversation that had not
 * happened yet — while the same meeting sat in "Coming up" on the dashboard.
 * The clock is the honest boundary: a meeting is loggable once it is over.
 */
export function eventHappened(event, todayIso, nowMs = Date.now()) {
  if (!event || event.status === "cancelled") return false;

  const date = eventDate(event);
  if (!date || date > todayIso) return false;

  const end = eventEndMs(event);
  if (end === null || end > nowMs) return false;

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
 *
 * EVERY address, not just the primary. People invite you from whichever
 * account is relevant — work for a work meeting, personal for coffee — so
 * matching one stored address missed every invite sent to any of the others,
 * and a missed match is indistinguishable from "no meetings found".
 */
export function attendeesInNetwork(event, contacts) {
  const byEmail = new Map();
  for (const c of contacts) {
    for (const address of contactAddresses(c)) {
      // First contact wins if two share an address; a later one silently
      // stealing the match would be worse than an arbitrary but stable choice.
      if (!byEmail.has(address)) byEmail.set(address, c);
    }
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
    if (!start.iso) continue;
    // Held until it ENDS, not until it starts. Filtering on the start time made
    // a meeting disappear from the dashboard the moment it began and reappear
    // as something to log only once it finished — so the hour you were most
    // likely to be looking at it was the one hour it was invisible.
    const end = eventEndMs(event);
    if ((end === null ? new Date(start.iso).getTime() : end) < nowMs) continue;

    const people = attendeesInNetwork(event, contacts);
    if (!people.length) continue;

    out.push({
      eventId: event.id,
      title: (event.summary || "Untitled meeting").trim(),
      date: start.date,
      time: start.time,
      iso: start.iso,
      endIso: end === null ? start.iso : new Date(end).toISOString(),
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
    // Drop anything that has since finished, so a stale cache cannot show you a
    // meeting you already had as though it were still ahead. Keyed on the end
    // time for the same reason findUpcoming is: a meeting in progress is still
    // worth showing. Falls back to the start for items cached before endIso.
    return raw.items.filter((i) => new Date(i.endIso || i.iso).getTime() >= now);
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
export function findCandidates(events, contacts, todayIso, nowMs = Date.now()) {
  const candidates = [];

  for (const event of events || []) {
    if (!eventHappened(event, todayIso, nowMs)) continue;

    for (const contact of attendeesInNetwork(event, contacts)) {
      if (alreadyLogged(contact, event)) continue;

      // Not the same as alreadyLogged. That answers "is this exact meeting
      // already in the history"; this answers "did you already write something
      // about this person on this day", which is the far more common case —
      // you logged the coffee yourself, in your own words, and the calendar has
      // no way to recognise your wording as the same event. Adding it blindly
      // gives you the conversation twice.
      const date = eventDate(event);
      const sameDay = (contact.interactions || []).find((i) => i.date === date);

      candidates.push({
        contactId: contact.id,
        contactName: contact.name,
        eventId: event.id,
        title: (event.summary || "Untitled meeting").trim(),
        date,
        // When it finished, so the caller can tell "this just happened, ask how
        // it went" apart from "here is a month of backlog" and pick the right
        // interruption for each.
        endedMs: eventEndMs(event),
        type: interactionTypeFor(event),
        existing: sameDay
          ? { id: sameDay.id, notes: sameDay.notes || "", type: sameDay.type }
          : null
      });
    }
  }

  // Most recent first, so the list reads the way the log does.
  return candidates.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * How long after a meeting ends it still counts as "that just happened".
 *
 * The window exists because the two cases deserve different interruptions. A
 * conversation you had this morning is worth a dialog — you still remember it,
 * and the notes are the whole point. A meeting from three weeks ago is worth a
 * line you can ignore, because opening a modal over a month of backlog is an
 * ambush, not a prompt.
 */
export const JUST_ENDED_HOURS = 24;

export function justEnded(candidates, nowMs = Date.now()) {
  const cutoff = nowMs - JUST_ENDED_HOURS * 3600_000;
  return (candidates || []).filter((c) => typeof c.endedMs === "number" && c.endedMs >= cutoff);
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
 * `prompt: ""` on BOTH paths, which is the point. Consent is granted once and
 * Google remembers it — what expires is the hour-long access token, not your
 * permission. Passing "consent" forced the full approval screen on every
 * reconnect, making a renewal that Google was willing to do silently look like
 * being asked to approve the app all over again.
 *
 * With "" Google decides: it shows the consent screen when it genuinely needs
 * to (first grant, revoked access, a new scope) and reissues quietly otherwise.
 *
 * `hint` is the other half, and without it "" is not enough. prompt controls
 * whether Google asks you to APPROVE the app; hint tells it WHICH ACCOUNT to
 * use. With consent already granted but no hint, Google still has to ask who
 * you are — so the account chooser appeared on every reconnect even though
 * nothing needed approving. Passing the address that granted access in the
 * first place removes the only remaining question.
 *
 * @param interactive  Whether a popup is acceptable. On the background path it
 *                     is not: a popup nobody clicked for is blocked anyway, and
 *                     the sync is simply skipped.
 */
export async function requestAccessToken({ interactive = true } = {}) {
  await loadGis();
  const knownAccount = getConnectedAccount();

  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      prompt: "",
      // Only on a reconnect. On a first connect there is nobody to hint at, and
      // guessing would pre-select an account the user may not have meant.
      ...(knownAccount ? { hint: knownAccount, select_account: false } : {}),
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
const REAUTH_KEY = "orbit_calendar_needs_reauth";
const LAST_RESULT_KEY = "orbit_calendar_last_result";

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
  localStorage.removeItem(REAUTH_KEY);
  localStorage.removeItem(LAST_RESULT_KEY);
  localStorage.removeItem("orbit_calendar_account");
  localStorage.removeItem("orbit_calendar_id");
}

// ── Following the account rather than the device (ORB-39) ─────────────────────
//
// All of the above lives in localStorage, which meant the connection was a
// property of the BROWSER: open Orbit somewhere new and it claimed you had
// never connected Google, and "synced 2 hours ago" quietly meant *on this
// device*. The durable copy now lives in `preferences`.
//
// localStorage stays, and is not a fallback — it is the synchronous one. The
// pre-paint script in every page reads `orbit_calendar_connected` to decide the
// Integrations nav item before first paint, and an async read there would
// reintroduce exactly the flash that script was written to remove.
//
// WHAT IS SHARED AND WHAT IS NOT
//
//   shared   connected, account, calendar id, last sync, last result
//            — all facts about the ACCOUNT. A sync writes contacts, so it is
//              genuinely true on every device that the data is fresh.
//
//   local    needs-reauth, reconnect nudge
//            — facts about THIS BROWSER. The access token is memory-only and
//              never stored, so every page load asks Google again; one browser
//              failing that says nothing about another, and syncing the flag
//              would make a working device announce a problem it does not have.

/** Everything worth carrying to another device. */
export function connectionSnapshot() {
  if (!isRemembered()) return null;
  return {
    connected: true,
    account: getConnectedAccount(),
    calendarId: getSelectedCalendarId(),
    lastSyncAt: Number(localStorage.getItem(LAST_SYNC_KEY) || 0) || null,
    lastResult: (() => {
      try { return JSON.parse(localStorage.getItem(LAST_RESULT_KEY) || "null"); }
      catch { return null; }
    })()
  };
}

/**
 * Adopt a connection recorded on another device.
 *
 * Returns true when this browser learned something it did not already know, so
 * the caller can re-render the nav rather than re-rendering unconditionally.
 * Deliberately does NOT set needs-reauth either way: whether Google will grant
 * a token here is a question only this browser can answer, and it will, on the
 * next silent sync.
 */
export function adoptConnection(snapshot) {
  if (!snapshot || !snapshot.connected) return false;
  const wasKnown = isRemembered();

  rememberConnection();
  if (snapshot.account) localStorage.setItem(ACCOUNT_KEY, snapshot.account);
  if (snapshot.calendarId) setSelectedCalendarId(snapshot.calendarId);
  // Keep whichever sync is more recent. A device that synced ten minutes ago
  // must not be pushed back into syncing again by a stale record from one that
  // last ran a week ago.
  if (snapshot.lastSyncAt && snapshot.lastSyncAt > readTime(LAST_SYNC_KEY)) {
    stampTime(LAST_SYNC_KEY, snapshot.lastSyncAt);
    if (snapshot.lastResult) {
      try { localStorage.setItem(LAST_RESULT_KEY, JSON.stringify(snapshot.lastResult)); }
      catch { /* private mode — the timestamp is a nicety */ }
    }
  }
  return !wasKnown;
}

// ── Connection state (ORB-34) ─────────────────────────────────────────────────
//
// Four states, because "connected or not" could not describe the one that
// actually happens most: you connected weeks ago, the grant has since expired,
// and nothing works until you click again. Calling that "connected" is how the
// settings screen ended up lying about a calendar it could not read.

export const DISCONNECTED = "disconnected";
export const CONNECTED = "connected";
export const NEEDS_REAUTH = "needs-reauth";

export function markNeedsReauth() { localStorage.setItem(REAUTH_KEY, "1"); }
export function clearNeedsReauth() { localStorage.removeItem(REAUTH_KEY); }

export function getConnectionState() {
  if (!isRemembered()) return DISCONNECTED;
  return localStorage.getItem(REAUTH_KEY) === "1" ? NEEDS_REAUTH : CONNECTED;
}

/**
 * Every integration Orbit offers (ORB-34).
 *
 * A list of one, deliberately. The nav show-rule is written against the COUNT
 * of unconnected integrations rather than "is Google Calendar connected", so
 * adding a second one needs no change to the rule — only an entry here.
 */
export function integrationStates() {
  return [
    { id: "google-calendar", name: "Google Calendar", state: getConnectionState() }
  ];
}

/**
 * How many integrations have never been connected.
 *
 * NEEDS_REAUTH deliberately does not count. An expired token is a connection
 * that needs a nudge, not an undiscovered feature — resurfacing the nav item
 * every time Google expires a grant would turn a discovery affordance into a
 * recurring error badge. The only way back to zero-connected is an explicit
 * disconnect.
 */
export function countNotConnected() {
  return integrationStates().filter((i) => i.state === DISCONNECTED).length;
}

// ── Which calendar, and whose (ORB-36) ────────────────────────────────────────

const ACCOUNT_KEY = "orbit_calendar_account";
const CALENDAR_KEY = "orbit_calendar_id";

export function getConnectedAccount() { return localStorage.getItem(ACCOUNT_KEY) || ""; }
export function getSelectedCalendarId() { return localStorage.getItem(CALENDAR_KEY) || "primary"; }
export function setSelectedCalendarId(id) {
  localStorage.setItem(CALENDAR_KEY, id || "primary");
}

/**
 * The calendars this account can read.
 *
 * `calendarList` comes with the scope already granted, so showing which account
 * is connected costs no extra permission: a calendar's id IS the address that
 * owns it. Asking for a profile scope just to display an email would be a
 * larger ask for a smaller reason.
 */
export async function fetchCalendarList() {
  if (!accessToken) throw new Error("Not connected to Google Calendar.");
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader",
    { headers: { Authorization: "Bearer " + accessToken } }
  );
  if (!res.ok) throw new Error("Could not read your calendar list (" + res.status + ").");
  const data = await res.json();
  return (data.items || []).map((c) => ({
    id: c.id,
    name: c.summaryOverride || c.summary || c.id,
    primary: Boolean(c.primary)
  }));
}

/**
 * Remembers which account is connected.
 *
 * Not cosmetic: this address becomes the `hint` on the next reconnect, which is
 * what stops Google asking which account to use. A failure here is why the
 * chooser kept appearing, so it warns rather than shrugging — it used to
 * swallow the error entirely and leave no trace of why the hint was missing.
 */
export async function refreshAccountInfo() {
  try {
    const calendars = await fetchCalendarList();
    const primary = calendars.find((c) => c.primary) || calendars[0];
    if (primary) localStorage.setItem(ACCOUNT_KEY, primary.id);
    return calendars;
  } catch (err) {
    console.warn("[calendar] Could not read the calendar list, so the connected "
      + "account is unknown and the next reconnect will ask which account to use. "
      + String(err.message || err));
    return [];
  }
}

/**
 * What the last run actually did (ORB-35).
 *
 * `found` is what the calendar offered; `logged` is what the user confirmed.
 * They are different numbers and only the second one answers "did that button
 * do anything" — a sync that found four meetings and logged none is a sync that
 * did nothing, and saying "4" would be a lie of omission.
 */
export function recordRun({ found = 0, logged = 0 }, now = Date.now()) {
  try {
    localStorage.setItem(LAST_RESULT_KEY, JSON.stringify({ at: now, found, logged }));
  } catch { /* private mode — the timestamp is a nicety, not a requirement */ }
}

export function lastRun() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_RESULT_KEY) || "null");
    if (!raw || typeof raw.at !== "number") return null;
    return { at: raw.at, found: raw.found || 0, logged: raw.logged || 0 };
  } catch {
    return null;
  }
}

export function lastSyncedAt() {
  const value = Number(localStorage.getItem(LAST_SYNC_KEY) || 0);
  return value || null;
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
    clearNeedsReauth();
    return { candidates: findCandidates(events, contacts, todayIso), upcoming };
  } catch {
    // The connection is remembered but no longer usable. That is its own state,
    // not a disconnection — the fix is one click, and forgetting the connection
    // would hide that.
    markNeedsReauth();
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
  const url = "https://www.googleapis.com/calendar/v3/calendars/"
    + encodeURIComponent(getSelectedCalendarId()) + "/events"
    + "?timeMin=" + encodeURIComponent(timeMin)
    + "&timeMax=" + encodeURIComponent(timeMax)
    + "&singleEvents=true&orderBy=startTime&maxResults=250";

  const res = await fetch(url, { headers: { Authorization: "Bearer " + accessToken } });
  if (res.ok) return (await res.json()).items || [];

  // 401 and 403 are NOT the same thing, and treating them alike sent people off
  // to reconnect over and over when the real answer was that the Calendar API
  // was never switched on for the project. Google explains itself in the
  // response body; the job here is to stop swallowing it.
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message || "";
  } catch { /* not JSON — fall through to the status code */ }

  if (res.status === 401) {
    // Genuinely an expired or revoked token. This one IS worth reconnecting.
    accessToken = "";
    throw new Error("Google access expired. Connect again.");
  }

  if (res.status === 403) {
    accessToken = "";
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(detail)) {
      throw new Error(
        "The Google Calendar API is not enabled for this project. "
        + "Google Cloud Console → APIs & Services → Library → Google Calendar API → Enable, "
        + "then wait a minute and try again."
      );
    }
    if (/insufficient|scope/i.test(detail)) {
      throw new Error(
        "Google granted access without calendar permission. Disconnect, then connect "
        + "again and make sure the calendar checkbox stays ticked on the consent screen."
      );
    }
    throw new Error("Google refused the request: " + (detail || "no reason given") + ".");
  }

  throw new Error("Google Calendar returned " + res.status
    + (detail ? ": " + detail : "") + ".");
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
  // The fetch comes BEFORE remembering, deliberately. Marking the connection
  // good on the strength of a token alone meant Settings reported "Connected"
  // while every read failed — a token proves Google knows who you are, not that
  // Orbit can see your calendar. Connected has to mean the round trip worked.
  const events = await fetchEventWindow();
  rememberConnection();
  clearNeedsReauth();
  // Captured here so the NEXT reconnect can hint at this account and skip the
  // chooser. Without this the hint is never available on the path that matters.
  refreshAccountInfo().catch(() => {});
  cacheUpcoming(findUpcoming(events, contacts));
  return findCandidates(events, contacts, todayIso);
}
