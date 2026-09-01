/**
 * Two relationships that do not run on a clock (ORB-130, ORB-131).
 *
 * A cadence answers "how often should I contact this person". By 1 September
 * two interviews and the app's own owner had all said that is the wrong
 * question for most people. These are the two circumstances that replace it —
 * one permanent, one temporary.
 *
 *   **Working together.** You are in the same standup. A countdown does not
 *   merely say nothing useful here; it reports drift between two people who
 *   spoke an hour ago.
 *
 *   **Being in the same place.** Interview 1 found three of five named contacts
 *   gated entirely by geography — "I don't really reach out unless I'm back
 *   home, I love meeting up with them in person." A clock never fires on the
 *   one week that matters and fires constantly on the fifty that do not.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 *   - **A fifth band.** ORB-75 established that a new band moves people out of
 *     Reach out next and breaks every denominator. Both of these change words
 *     and reasons, never the band vocabulary.
 *   - **The client and the server disagreeing.** The digest reads
 *     `next_reminder` in SQL and never calls getHealth. A profile saying
 *     "Working together" while an email says "long silence" is ORB-69 again.
 *   - **A trip that never ends.** A toggle nobody remembers to switch off fires
 *     for ever, which is the nagging ORB-126 spent a day removing.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo, daysAhead } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  normalizeContact, getHealth, bandWords, needsAttention, countByBand,
  healthBarHtml, reachOutReason, currentTrip, setCurrentTrip, inTownTrigger,
  tripBarHtml, wireTripBar, placeDatalist, WORKING_META, REACH_OUT_REASONS
} = main;

const tick = () => new Promise((r) => setTimeout(r, 0));
const click = (el) => el.dispatchEvent(
  new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

const lapsed = (over = {}) => normalizeContact({
  id: "c1", name: "Hunter Rapoza", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(200), nextReminder: daysAgo(60),
  interactions: [{ id: "i1", date: daysAgo(200), type: "coffee chat", notes: "x" }],
  ...over
});

// ── ORB-130 ──────────────────────────────────────────────────────────────────

group("Somebody you work with is not drifting");
{
  const h = getHealth(lapsed({ workingTogether: true }));
  eq("the bar is full", h.pct, 100);
  eq("and good", h.band, "good");
  eq("even though the cadence is two months blown", h.working, true);
  eq("there is no countdown to show", h.daysLeft, null);
  // Not "No schedule". Dropping it there would file the healthiest
  // relationships you have under "not set up".
  eq("and it says why rather than saying nothing", bandWords(h).label, "Working together");
  eq("which is WORKING_META, not a fourth string", bandWords(h), WORKING_META);
}
{
  // ORB-75's rule. A fifth band would move these people out of Reach out next
  // and break every denominator on the dashboard.
  const counts = countByBand([lapsed({ workingTogether: true })]);
  eq("no new band is invented",
    Object.keys(counts).filter((k) => k !== "starredCritical").sort().join(","),
    "critical,good,none,warning");
  eq("they are counted as current, which they are", counts.good, 1);
}
{
  const c = lapsed({ workingTogether: true });
  eq("two months past the deadline, they are still off the list",
    needsAttention([c]).length, 0);
  const html = healthBarHtml(getHealth(c));
  ok("the bar says the state", /Working together/.test(html));
  ok("and explains it instead of counting", /no schedule needed/.test(html));
  ok("with no days anywhere", !/day/.test(html));
}
{
  // It wins before the cadence is consulted, so it works on somebody who never
  // had one — which is the common case since ORB-128.
  const h = getHealth(normalizeContact({
    id: "c2", name: "Deskmate", followUpFrequency: "none",
    reminderEnabled: false, workingTogether: true
  }));
  eq("no cadence needed for it to apply", h.scheduled, true);
  eq("full", h.pct, 100);
  // And ahead of ORB-75's words: "Not contacted yet" would be absurd about
  // somebody you are in a standup with.
  eq("and it outranks not-contacted-yet", bandWords(h).label, "Working together");
}
{
  // A caught thought still surfaces them. Working together suppresses the
  // clock, not everything you meant to say.
  const c = lapsed({
    workingTogether: true,
    followUps: [{ id: "f1", text: "Ask about the promo cycle", source: "capture", completed: false }]
  });
  eq("a note you left still brings them up", needsAttention([c]).length, 1);
  eq("for the reason you left it", reachOutReason(c, getHealth(c), null).kind, "capture");
}

group("The digest cannot disagree with the profile");
{
  // ORB-69's bug, and the one this feature could most easily reintroduce. The
  // reminder job reads next_reminder in SQL, server-side, and never calls
  // getHealth — so a stored deadline would email somebody about a long silence
  // while their profile said "Working together".
  const c = normalizeContact({
    id: "c1", name: "Deskmate", followUpFrequency: "monthly",
    reminderEnabled: true, nextReminder: daysAgo(3), workingTogether: true
  });
  eq("no deadline survives normalising", c.nextReminder, "");
  // And it is normalizeContact that has to do it, not just the toggle's
  // handler: followUpFrequency is kept on purpose, so the next save would
  // otherwise invent a fresh deadline from it.
  eq("even though the interval is kept for later", c.followUpFrequency, "monthly");
  const again = normalizeContact({ ...c, nextReminder: "" });
  eq("and a second save does not put one back", again.nextReminder, "");
}
{
  // Unticking restores the rhythm rather than making you remember it — counted
  // from today, because the months in between were not a lapse.
  const back = normalizeContact({
    id: "c1", name: "Deskmate", followUpFrequency: "monthly",
    reminderEnabled: true, nextReminder: "", workingTogether: false
  });
  ok("the deadline comes back", Boolean(back.nextReminder));
  ok("in the future, not in the past", back.nextReminder >= today());
}

// ── ORB-131 ──────────────────────────────────────────────────────────────────

group("A trip is a reason, and it ends");
{
  eq("no place, no trip", currentTrip({ current_location: "" }), null);
  eq("blank preferences are not a trip", currentTrip({}), null);
  eq("a place with no end date is still a trip — 'I live here'",
    currentTrip({ current_location: "Hawaii" }).place, "Hawaii");
  eq("one that has not ended holds",
    currentTrip({ current_location: "Hawaii", location_until: daysAhead(3) }).place, "Hawaii");
  eq("today is still today", 
    currentTrip({ current_location: "Hawaii", location_until: today() }).place, "Hawaii");
  // The whole reason an end date is asked for.
  eq("one that has ended is over",
    currentTrip({ current_location: "Hawaii", location_until: daysAgo(1) }), null);
}
{
  const trip = { place: "Hawaii", until: "" };
  const hunter = normalizeContact({ id: "c1", name: "Hunter Rapoza", location: "Hawaii" });
  const patrick = normalizeContact({ id: "c2", name: "Patrick Buelle", location: "New York" });
  const nowhere = normalizeContact({ id: "c3", name: "Chris Rule" });

  ok("somebody in the same place fires", inTownTrigger(hunter, trip));
  eq("and says so plainly", inTownTrigger(hunter, trip).text,
    "You are in Hawaii and so is Hunter.");
  eq("somebody elsewhere does not", inTownTrigger(patrick, trip), null);
  eq("somebody with no place does not", inTownTrigger(nowhere, trip), null);
  eq("and with no trip, nobody does", inTownTrigger(hunter, null), null);
  // Two strings typed by one person, so case and padding cannot be the thing
  // that decides whether a prompt ever appears.
  ok("case and spacing do not decide it",
    inTownTrigger(normalizeContact({ id: "c4", name: "T", location: "  hawaii " }), trip));
}
{
  const hunter = normalizeContact({
    id: "c1", name: "Hunter Rapoza", location: "Hawaii",
    followUpFrequency: "none", reminderEnabled: false
  });
  // No cadence at all — the case the whole feature exists for. Interview 1's
  // three Hawaii contacts would each look exactly like this.
  eq("with no trip they are on nobody's list",
    needsAttention([hunter]).length, 0);

  setCurrentTrip({ current_location: "Hawaii" });
  eq("in town, they surface without any schedule",
    needsAttention([hunter]).length, 1);
  eq("with the trip as the stated reason",
    reachOutReason(hunter, getHealth(hunter)).kind, "in-town");
  eq("labelled for a person, not a database",
    reachOutReason(hunter, getHealth(hunter)).label, "You are both here");
  setCurrentTrip({});
}
{
  // Ranked above a fresh conversation because it expires — the others will
  // still be true next month.
  ok("a trip outranks just-spoke",
    REACH_OUT_REASONS.indexOf("in-town") < REACH_OUT_REASONS.indexOf("just-met"));
  ok("but a thought you had outranks a trip",
    REACH_OUT_REASONS.indexOf("capture") < REACH_OUT_REASONS.indexOf("in-town"));
}

group("Where you are is asked once, then stated");
{
  const contacts = [
    normalizeContact({ id: "c1", name: "Hunter Rapoza", location: "Hawaii" }),
    normalizeContact({ id: "c2", name: "Tim Roy", location: "Hawaii" }),
    normalizeContact({ id: "c3", name: "Patrick Buelle", location: "New York" })
  ];
  const asking = tripBarHtml({}, contacts);
  ok("with no trip it asks", /Somewhere different this week/.test(asking));
  ok("offering the places already in the network", /<option value="Hawaii">/.test(asking));
  ok("and New York", /<option value="New York">/.test(asking));

  const stated = tripBarHtml({ current_location: "Hawaii", location_until: daysAhead(6) }, contacts);
  ok("once answered it stops being a form", !/Somewhere different/.test(stated));
  ok("and says where you are", /You are in <strong>Hawaii<\/strong>/.test(stated));
  ok("how many people that is", /2 people here/.test(stated));
  ok("and offers a way out", /id="tripClear"/.test(stated));
}
{
  const one = tripBarHtml({ current_location: "New York" },
    [normalizeContact({ id: "c1", name: "P", location: "New York" })]);
  ok("one person is not 1 people", /1 person here/.test(one));
}
{
  resetState();
  document.body.innerHTML = '<div id="h"></div>';
  const host = document.getElementById("h");
  host.innerHTML = tripBarHtml({}, []);
  let reloads = 0;
  wireTripBar(host, {}, async () => { reloads++; });
  host.querySelector("#tripPlace").value = "Hawaii";
  host.querySelector("#tripUntil").value = daysAhead(5);
  host.querySelector(".trip-form").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(); await tick();

  eq("the trip is stored on preferences", state.prefs.current_location, "Hawaii");
  eq("with its end date", state.prefs.location_until, daysAhead(5));
  eq("and the page redraws", reloads, 1);
}
{
  resetState();
  state.prefs = { current_location: "Hawaii", location_until: daysAhead(5) };
  document.body.innerHTML = '<div id="h"></div>';
  const host = document.getElementById("h");
  host.innerHTML = tripBarHtml(state.prefs, []);
  wireTripBar(host, state.prefs, async () => {});
  click(host.querySelector("#tripClear"));
  await tick(); await tick();
  eq("leaving clears the place", state.prefs.current_location, "");
  eq("and the date with it", state.prefs.location_until, null);
}
{
  const html = placeDatalist([
    normalizeContact({ id: "a", name: "A", location: "Hawaii" }),
    normalizeContact({ id: "b", name: "B", location: "Hawaii" }),
    normalizeContact({ id: "c", name: "C", location: "" })
  ], "x");
  eq("each place once", (html.match(/<option/g) || []).length, 1);
  ok("and blanks are not a place", !/value=""/.test(html));
}

done();
