/**
 * ORB-15 — Google Calendar matching.
 *
 * js/calendar.js has no imports, so the real module is loaded directly. These
 * are the rules that decide whether a meeting gets written into someone's
 * history, and writing one moves their next reach-out date — so a false match
 * makes a drifting relationship look healthy. That is the failure worth
 * guarding hardest.
 */
import * as cal from "../js/calendar.js";

const TODAY = "2026-08-09";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok" : "FAIL"}  ${n}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (n, c) => eq(n, Boolean(c), true);

const marcus = { id: "c1", name: "Marcus Chen", email: "marcus@stripe.com", interactions: [] };
const priya  = { id: "c2", name: "Priya R", email: "Priya@Airtable.com", interactions: [] };
const noEmail = { id: "c3", name: "Sam", email: "", interactions: [] };
const NETWORK = [marcus, priya, noEmail];

const ev = (over = {}) => ({
  id: "e1",
  summary: "Coffee with Marcus",
  status: "confirmed",
  start: { dateTime: "2026-08-05T10:00:00Z" },
  end:   { dateTime: "2026-08-05T11:00:00Z" },
  attendees: [
    { email: "davinali723@gmail.com", self: true, responseStatus: "accepted" },
    { email: "marcus@stripe.com", responseStatus: "accepted" }
  ],
  ...over
});

console.log("\nORB-15 — did the meeting happen?");
{
  ok("a past confirmed meeting counts", cal.eventHappened(ev(), TODAY));
  ok("a cancelled one does not", !cal.eventHappened(ev({ status: "cancelled" }), TODAY));
  ok("a future one does not", !cal.eventHappened(
    ev({ start: { dateTime: "2026-09-01T10:00:00Z" }, end: { dateTime: "2026-09-01T11:00:00Z" } }), TODAY));
  ok("today's meeting counts", cal.eventHappened(
    ev({ end: { dateTime: TODAY + "T09:00:00Z" } }), TODAY));

  // You declining is the clearest possible evidence you were not there.
  ok("one you declined does not count", !cal.eventHappened(ev({
    attendees: [
      { email: "davinali723@gmail.com", self: true, responseStatus: "declined" },
      { email: "marcus@stripe.com", responseStatus: "accepted" }
    ]
  }), TODAY));

  // An all-hands is a broadcast, not a conversation.
  const crowd = Array.from({ length: cal.MAX_ATTENDEES + 1 }, (_, i) => ({ email: `p${i}@x.com` }));
  ok("a big invite does not count", !cal.eventHappened(ev({ attendees: crowd }), TODAY));
  ok("an invite at the limit still counts", cal.eventHappened(
    ev({ attendees: crowd.slice(0, cal.MAX_ATTENDEES) }), TODAY));

  ok("an all-day event resolves a date", cal.eventHappened(
    ev({ start: { date: "2026-08-04" }, end: { date: "2026-08-04" } }), TODAY));
}

console.log("\nORB-15 — who on the invite is in the network?");
{
  eq("the matching contact is found",
     cal.attendeesInNetwork(ev(), NETWORK).map((c) => c.id), ["c1"]);

  eq("email matching ignores case",
     cal.attendeesInNetwork(ev({
       attendees: [{ email: "PRIYA@airtable.com", responseStatus: "accepted" }]
     }), NETWORK).map((c) => c.id), ["c2"]);

  eq("you are never matched against yourself",
     cal.attendeesInNetwork(ev({
       attendees: [{ email: "marcus@stripe.com", self: true }]
     }), NETWORK), []);

  eq("someone who declined is skipped",
     cal.attendeesInNetwork(ev({
       attendees: [{ email: "marcus@stripe.com", responseStatus: "declined" }]
     }), NETWORK), []);

  eq("a stranger is not invented",
     cal.attendeesInNetwork(ev({
       attendees: [{ email: "nobody@example.com", responseStatus: "accepted" }]
     }), NETWORK), []);

  // The known cost of email matching, and why the epic calls this blocked on
  // contacts having emails saved.
  eq("a contact with no email can never match",
     cal.attendeesInNetwork(ev({ attendees: [{ email: "" }] }), NETWORK), []);

  eq("the same person twice on one invite is counted once",
     cal.attendeesInNetwork(ev({
       attendees: [
         { email: "marcus@stripe.com", responseStatus: "accepted" },
         { email: "MARCUS@stripe.com", responseStatus: "tentative" }
       ]
     }), NETWORK).length, 1);
}

console.log("\nORB-15 — never log the same meeting twice");
{
  // The whole point of storing sourceEventId: sync runs again every session.
  const synced = { ...marcus, interactions: [
    { id: "i1", date: "2026-08-05", notes: "Coffee with Marcus", sourceEventId: "e1", fileIds: [] }
  ] };
  ok("a previously synced event is skipped", cal.alreadyLogged(synced, ev()));
  ok("a renamed meeting is still recognised by id",
     cal.alreadyLogged(synced, ev({ summary: "Coffee w/ Marcus (moved)" })));
  ok("a different meeting is not skipped", !cal.alreadyLogged(synced, ev({ id: "e2" })));

  // Day one: you typed it up yourself before ever connecting the calendar.
  const typed = { ...marcus, interactions: [
    { id: "i1", date: "2026-08-05", notes: "Coffee with Marcus went well", sourceEventId: "", fileIds: [] }
  ] };
  ok("a hand-typed entry for the same day is not duplicated", cal.alreadyLogged(typed, ev()));

  const other = { ...marcus, interactions: [
    { id: "i1", date: "2026-08-05", notes: "Totally unrelated call", sourceEventId: "", fileIds: [] }
  ] };
  ok("an unrelated entry on the same day does not block it", !cal.alreadyLogged(other, ev()));
}

console.log("\nORB-15 — guessing the touchpoint type");
{
  eq("coffee", cal.interactionTypeFor({ summary: "Coffee with Marcus" }), "coffee chat");
  eq("lunch is also a coffee chat", cal.interactionTypeFor({ summary: "Lunch catch-up" }), "coffee chat");
  eq("call", cal.interactionTypeFor({ summary: "Intro call" }), "phone call");
  eq("conference", cal.interactionTypeFor({ summary: "AI Summit panel" }), "event");
  eq("anything else is a meeting", cal.interactionTypeFor({ summary: "1:1" }), "meeting");
  eq("a missing summary does not throw", cal.interactionTypeFor({}), "meeting");
}

console.log("\nORB-15 — the full sweep");
{
  const events = [
    ev({ id: "e1", summary: "Coffee with Marcus", end: { dateTime: "2026-08-05T11:00:00Z" } }),
    ev({ id: "e2", summary: "Intro call with Priya",
         end: { dateTime: "2026-08-07T15:00:00Z" },
         attendees: [
           { email: "davinali723@gmail.com", self: true },
           { email: "priya@airtable.com", responseStatus: "accepted" }
         ] }),
    ev({ id: "e3", summary: "Cancelled thing", status: "cancelled" }),
    ev({ id: "e4", summary: "Dentist", attendees: [] }),
    ev({ id: "e5", summary: "Next week", start: { dateTime: "2026-08-20T10:00:00Z" },
         end: { dateTime: "2026-08-20T11:00:00Z" } })
  ];

  const found = cal.findCandidates(events, NETWORK, TODAY);

  eq("only the two real meetings surface", found.length, 2);
  eq("most recent first", found.map((c) => c.eventId), ["e2", "e1"]);
  eq("each names its person", found.map((c) => c.contactName), ["Priya R", "Marcus Chen"]);
  eq("types are guessed", found.map((c) => c.type), ["phone call", "coffee chat"]);
  eq("the event id is carried through for dedupe",
     found.every((c) => Boolean(c.eventId)), true);

  // Re-running a sync must not re-offer what was already accepted.
  const after = NETWORK.map((c) => c.id !== "c1" ? c : {
    ...c, interactions: [{ id: "x", date: "2026-08-05", notes: "Coffee with Marcus", sourceEventId: "e1", fileIds: [] }]
  });
  eq("a second sync only offers what is still new",
     cal.findCandidates(events, after, TODAY).map((c) => c.eventId), ["e2"]);

  eq("an empty calendar yields nothing", cal.findCandidates([], NETWORK, TODAY), []);
  eq("a null feed does not throw", cal.findCandidates(null, NETWORK, TODAY), []);
}

console.log("\nORB-15 — one meeting with two contacts");
{
  const group = ev({
    id: "e9", summary: "Team sync",
    attendees: [
      { email: "davinali723@gmail.com", self: true },
      { email: "marcus@stripe.com", responseStatus: "accepted" },
      { email: "priya@airtable.com", responseStatus: "accepted" }
    ]
  });
  const found = cal.findCandidates([group], NETWORK, TODAY);
  eq("both people get an entry", found.length, 2);
  eq("from the same event", [...new Set(found.map((c) => c.eventId))], ["e9"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
