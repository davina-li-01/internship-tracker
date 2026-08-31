/**
 * Four things the first two outside users hit (ORB-128).
 *
 * Reported on 25 August by the two people using Orbit who did not build it.
 * They are grouped because they share a cause: **the app was deciding things on
 * their behalf and then not saying what it had decided.**
 *
 *   1. "Why did it say just met when they talked to them a while ago?"
 *   2. They wanted to delete a conversation and could not find how.
 *   3. A contact was saved and they could not see that it had been.
 *   4. A health bar appeared for a schedule nobody set.
 *
 * The date-met field and the no-cadence default are asserted in
 * add-connection.test.mjs, next to the rest of that form.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const {
  normalizeContact, reachOutReason, getHealth, withSaved,
  renderInteractionTimeline, normalizeInteraction, justMetTrigger
} = main;

const person = (over = {}) => normalizeContact({
  id: "c1", name: "Hunter Rapoza", followUpFrequency: "monthly",
  reminderEnabled: true, ...over
});

// ── 1. The label was wrong, the trigger never was ────────────────────────────

group("A conversation two days ago is not meeting someone");
{
  // The reported case: somebody known for years, spoken to on Sunday. The old
  // label announced "Just met", which is a claim about the relationship the app
  // has no basis for — and in this case a false one.
  const old_friend = person({
    dateMet: daysAgo(900),
    interactions: [{ id: "i1", date: daysAgo(2), type: "coffee chat", notes: "Caught up" }]
  });
  old_friend.lastContacted = daysAgo(2);

  const reason = reachOutReason(old_friend, getHealth(old_friend));
  eq("the trigger still fires, because it is the right trigger",
    reason.kind, "just-met");
  eq("but it is labelled for what actually happened", reason.label, "Just spoke");
  ok("and never claims they met", !/just met/i.test(reason.label + " " + reason.text));
  ok("the sentence was always about speaking", /spoke to Hunter/.test(reason.text));
}
{
  // Unchanged, and worth pinning: the window is about recency of a
  // conversation, not about how long you have known someone.
  const long_known = person({
    dateMet: daysAgo(900),
    interactions: [{ id: "i1", date: daysAgo(30), type: "call", notes: "x" }]
  });
  long_known.lastContacted = daysAgo(30);
  eq("a conversation a month old does not fire it",
    justMetTrigger(long_known), null);
}

// ── 2. Delete was there. Nothing said so ─────────────────────────────────────

group("The way into a conversation names what is behind it");
{
  const html = renderInteractionTimeline([
    normalizeInteraction({ id: "i1", date: daysAgo(5), type: "coffee chat", notes: "Talked" })
  ]);
  // ORB-64 put Delete inside the dialog deliberately, so a slip cannot destroy
  // a note. That reasoning stands; the entry point was the problem. "Edit
  // notes" named one of the five things the dialog does, and not the one the
  // user was looking for.
  ok("the button opens the whole record", /Edit conversation/.test(html));
  ok("and does not name a single field of it", !/Edit notes/.test(html));
}
{
  const html = renderInteractionTimeline([
    normalizeInteraction({ id: "i1", date: daysAgo(5), type: "email", notes: "" })
  ]);
  ok("a conversation with no notes says the same thing",
    /Edit conversation/.test(html));
  ok("and still invites you to write some", /what did you talk about/i.test(html));
  // Delete must never sit on the row itself — one slip from the note it removes.
  ok("no delete on the row", !/data-delete-convo|Delete conversation/.test(html));
}

// ── 3. Saved, and visibly so ─────────────────────────────────────────────────

group("A saved contact is on screen before the round trip");
{
  // Reported as "it didn't save" and as "I couldn't immediately see it was
  // saved". It had saved both times. The page went back to the database before
  // it could redraw — seconds on an idle free-tier project — and since ORB-124
  // a new contact is on schedule rather than overdue, so nothing listed them.
  const existing = [person({ id: "c1" }), person({ id: "c2", name: "Chris Rule" })];
  const fresh = person({ id: "c3", name: "Patrick Buelle" });

  const list = withSaved(existing, fresh);
  eq("the new one is there immediately", list.length, 3);
  eq("and first, where it can be seen", list[0].id, "c3");
}
{
  const existing = [person({ id: "c1", name: "Hunter Rapoza" })];
  const updated = person({ id: "c1", name: "Hunter Rapoza", company: "IQ360" });
  const list = withSaved(existing, updated);
  // Logging a conversation against somebody already in the network saves them
  // too. Prepending blindly would show them twice.
  eq("saving an existing person does not duplicate them", list.length, 1);
  eq("and the fresher copy wins", list[0].company, "IQ360");
}
{
  eq("nothing saved changes nothing", withSaved([person()], null).length, 1);
  eq("and a save with no id is ignored rather than trusted",
    withSaved([person()], { name: "No id" }).length, 1);
}

// ── 4. No schedule means no bar ──────────────────────────────────────────────

group("A health bar is a thing you asked for");
{
  const c = normalizeContact({
    id: "c9", name: "On File", followUpFrequency: "none", reminderEnabled: false
  });
  const h = getHealth(c);
  eq("no cadence, no bar", h.scheduled, false);
  eq("and nothing to be a percentage of", h.pct, 0);
  eq("nor a band to sort by", h.band, "none");
}
{
  // And the moment you do set one it starts from that day, not from whenever
  // you happened to add them (ORB-124).
  const c = normalizeContact({
    id: "c9", name: "Now Scheduled", followUpFrequency: "bimonthly",
    reminderEnabled: true, nextReminder: main.addDays(today(), 60)
  });
  const h = getHealth(c);
  eq("choosing one starts the bar", h.scheduled, true);
  eq("at the top of the window", h.pct, 100);
  eq("with the full interval ahead", h.daysLeft, 60);
}

done();
