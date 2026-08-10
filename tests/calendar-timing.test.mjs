/**
 * ORB-15 — when a meeting counts as over.
 *
 * The bug this pins down: "happened" was decided on the DATE, so a coffee at
 * four in the afternoon looked loggable from breakfast onwards. Orbit would sit
 * there asking how a conversation went while the same meeting was still listed
 * under "Coming up" on the dashboard — two answers to the same question, both
 * from the same feed.
 *
 * Everything here is about the boundary between those two lists. The rule is
 * that they must partition: a meeting is upcoming until it ends, loggable
 * afterwards, and never both.
 */
import { eq, ok, group, done } from "./helpers/assert.mjs";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
globalThis.window = {};
globalThis.document = { querySelector: () => null, createElement: () => ({}), head: { appendChild() {} } };

const cal = await import("../js/calendar.js");

const NOW = new Date("2026-08-10T12:00:00Z").getTime();
const TODAY = "2026-08-10";
const at = (h) => new Date(NOW + h * 3600_000).toISOString();

const marcus = { id: "c1", name: "Marcus Chen", email: "marcus@stripe.com", interactions: [], followUps: [] };
const NET = [marcus];

const meeting = (startH, endH, over = {}) => ({
  id: "e1",
  summary: "Coffee with Marcus",
  status: "confirmed",
  start: { dateTime: at(startH) },
  end: { dateTime: at(endH) },
  attendees: [{ email: "me@x.com", self: true }, { email: "marcus@stripe.com", responseStatus: "accepted" }],
  ...over
});

group("When a meeting ends");
eq("a timed event ends at its end time",
  cal.eventEndMs(meeting(-2, -1)), NOW - 3600_000);
eq("with no end, the start stands in",
  cal.eventEndMs({ start: { dateTime: at(-2) } }), NOW - 2 * 3600_000);
// Google's all-day end.date is exclusive: a one-day event on the 10th ends on
// the 11th. Parsed at local midnight, that date IS the moment it is over.
eq("an all-day event ends at the start of its exclusive end date",
  cal.eventEndMs({ start: { date: "2026-08-10" }, end: { date: "2026-08-11" } }),
  new Date("2026-08-11T00:00:00").getTime());
eq("an event with no dates at all cannot say",
  cal.eventEndMs({ summary: "nothing" }), null);

group("Happened means finished, not 'dated today'");
ok("a meeting that ended an hour ago has happened",
  cal.eventHappened(meeting(-2, -1), TODAY, NOW));
ok("a meeting later today has NOT happened",
  !cal.eventHappened(meeting(4, 5), TODAY, NOW));
ok("a meeting in progress has NOT happened",
  !cal.eventHappened(meeting(-1, 1), TODAY, NOW));
ok("the boundary is the end time, not the start",
  !cal.eventHappened(meeting(-3, 0.001), TODAY, NOW));
ok("a meeting that ended one second ago has happened",
  cal.eventHappened(meeting(-3, -0.001), TODAY, NOW));
ok("yesterday's meeting still counts",
  cal.eventHappened(meeting(-30, -29), TODAY, NOW));
ok("cancelled never counts, whenever it ended",
  !cal.eventHappened(meeting(-2, -1, { status: "cancelled" }), TODAY, NOW));

group("Upcoming holds a meeting until it ends");
eq("a meeting still ahead is upcoming",
  cal.findUpcoming([meeting(4, 5)], NET, NOW).map((m) => m.eventId), ["e1"]);
eq("a meeting in progress is STILL upcoming",
  cal.findUpcoming([meeting(-1, 1)], NET, NOW).map((m) => m.eventId), ["e1"]);
eq("a finished meeting is not",
  cal.findUpcoming([meeting(-2, -1)], NET, NOW).map((m) => m.eventId), []);
eq("upcoming carries the end time so the cache can expire it correctly",
  cal.findUpcoming([meeting(4, 5)], NET, NOW)[0].endIso, at(5));

group("The two lists partition — nothing is in both, nothing falls through");
for (const [label, start, end] of [
  ["ahead", 4, 5], ["in progress", -1, 1], ["finished", -2, -1]
]) {
  const e = meeting(start, end);
  const up = cal.findUpcoming([e], NET, NOW).length;
  const cand = cal.findCandidates([e], NET, TODAY, NOW).length;
  eq(label + ": exactly one list claims it", up + cand, 1);
}

group("Just ended — which prompt to use");
const fresh = cal.findCandidates([meeting(-2, -1)], NET, TODAY, NOW);
const old = cal.findCandidates([meeting(-20 * 24, -20 * 24 + 1)], NET, TODAY, NOW);
eq("a candidate records when it finished", fresh[0].endedMs, NOW - 3600_000);
eq("a meeting from an hour ago just ended", cal.justEnded(fresh, NOW).length, 1);
eq("a meeting from three weeks ago did not", cal.justEnded(old, NOW).length, 0);
eq("the boundary is JUST_ENDED_HOURS",
  cal.justEnded([{ endedMs: NOW - cal.JUST_ENDED_HOURS * 3600_000 + 1 }], NOW).length, 1);
eq("and one hour past it is backlog",
  cal.justEnded([{ endedMs: NOW - (cal.JUST_ENDED_HOURS + 1) * 3600_000 }], NOW).length, 0);
eq("a candidate with no end time is never treated as fresh",
  cal.justEnded([{ endedMs: null }], NOW).length, 0);

group("The upcoming cache expires on the end time too");
cal.cacheUpcoming([
  { eventId: "past", iso: at(-3), endIso: at(-2) },
  { eventId: "now", iso: at(-1), endIso: at(1) },
  { eventId: "later", iso: at(4), endIso: at(5) }
], NOW);
eq("a finished meeting is dropped, one in progress is kept",
  cal.readUpcoming(NOW).map((i) => i.eventId), ["now", "later"]);

// Items written before endIso existed must not vanish or linger wrongly.
cal.cacheUpcoming([{ eventId: "legacy", iso: at(4) }], NOW);
eq("an item cached without endIso falls back to its start",
  cal.readUpcoming(NOW).map((i) => i.eventId), ["legacy"]);

done();
