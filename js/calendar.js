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
 *     is no refresh token, nothing in localStorage, nothing in the database.
 *     Close the tab and Orbit's access is gone.
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

/** Drops the token. Nothing was stored, so there is nothing else to clear. */
export function disconnectCalendar() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = "";
}

/** Recent events from the primary calendar. */
export async function fetchRecentEvents(lookbackDays = LOOKBACK_DAYS) {
  if (!accessToken) throw new Error("Not connected to Google Calendar.");

  const timeMin = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const timeMax = new Date().toISOString();
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

/**
 * Connect and return the conversations worth logging.
 * Writes nothing — the caller decides what to keep.
 */
export async function connectCalendar(contacts, todayIso, { interactive = true } = {}) {
  await requestAccessToken({ interactive });
  const events = await fetchRecentEvents();
  return findCandidates(events, contacts, todayIso);
}
