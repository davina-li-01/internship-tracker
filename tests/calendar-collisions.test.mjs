/**
 * Same-day collisions, deleting, and the collapsed conversation row.
 *
 * The case that prompted all of this: a meeting was found on a day the user had
 * already written up in their own words. `alreadyLogged` could not recognise it
 * — their wording had nothing to do with the event title — so Orbit offered to
 * log the same conversation a second time, and there was no way to delete
 * either copy.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import * as cal from "../js/calendar.js";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const { renderInteractionTimeline, normalizeInteraction } = await loadMain();

const TODAY = "2026-08-09";
const marcus = (interactions = []) => ({
  id: "c1", name: "Marcus Chen", email: "marcus@stripe.com", interactions
});
const ev = (over = {}) => ({
  id: "e1", summary: "Coffee with Marcus", status: "confirmed",
  start: { dateTime: "2026-08-05T10:00:00Z" }, end: { dateTime: "2026-08-05T11:00:00Z" },
  attendees: [{ email: "me@x.com", self: true }, { email: "marcus@stripe.com" }],
  ...over
});

group("A conversation already written that day is flagged, not assumed");
{
  const typed = { id: "i1", date: "2026-08-05", notes: "Great chat about the platform team", sourceEventId: "" };
  const found = cal.findCandidates([ev()], [marcus([typed])], TODAY);

  eq("it is still offered", found.length, 1);
  ok("but carries what is already there", Boolean(found[0].existing));
  eq("naming the entry it collides with", found[0].existing.id, "i1");
  eq("and quoting it back", found[0].existing.notes, "Great chat about the platform team");
}

group("No collision when the day is clear");
{
  const other = { id: "i1", date: "2026-07-01", notes: "Earlier call", sourceEventId: "" };
  const found = cal.findCandidates([ev()], [marcus([other])], TODAY);
  eq("nothing to reconcile", found[0].existing, null);
}

group("An exact re-sync is still silently skipped");
{
  // alreadyLogged wins before collision detection: this is the same event, not
  // a judgement call, and asking about it every sync would be noise.
  const synced = { id: "i1", date: "2026-08-05", notes: "Coffee with Marcus", sourceEventId: "e1" };
  eq("not offered at all", cal.findCandidates([ev()], [marcus([synced])], TODAY).length, 0);
}

group("The collapsed row carries the meeting name");
{
  const html = renderInteractionTimeline([
    normalizeInteraction({ id: "i1", date: "2026-08-05", type: "coffee chat",
      notes: "Coffee with Marcus\n\nTalked about the platform team", sourceEventId: "e1" }),
    normalizeInteraction({ id: "i2", date: "2026-07-01", type: "call", notes: "Intro call" })
  ]);

  ok("nothing starts open", !html.includes("<details class=\"convo\" open"));
  ok("the meeting title shows on the closed row", html.includes("Coffee with Marcus"));
  // The headline is the first line only; the rest belongs in the body, which
  // legitimately holds the whole note.
  ok("the headline span holds just the first line",
     html.includes('<span class="convo-headline">Coffee with Marcus</span>'));
  ok("while the body keeps everything", html.includes("Talked about the platform team"));
  ok("calendar-logged entries are marked as such", html.includes("convo-source"));
  eq("and only those", (html.match(/convo-source/g) || []).length, 1);
  ok("every conversation can be deleted", (html.match(/data-delete-convo/g) || []).length === 2);
}

group("An empty conversation still says so");
{
  const html = renderInteractionTimeline([
    normalizeInteraction({ id: "i1", date: "2026-08-05", type: "email", notes: "" })
  ]);
  ok("no notes is stated", html.includes("no notes"));
  ok("and it offers to add them", html.includes("Add notes"));
}

done();
