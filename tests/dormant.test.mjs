/**
 * A long silence is an opportunity, not a failure (ORB-54).
 *
 * WHY
 *
 * "Overdue" means you failed at something you undertook. That is true for a
 * person you starred and false for everyone else. The dormant-tie research says
 * the contact untouched for two years may be the single most valuable one in
 * the network — they know things and people your recent contacts do not — and
 * Orbit painted exactly that person red.
 *
 * Getting the sign wrong matters more than it sounds. Survey 1's blockers were
 * "just forgot", "got lazy", "procrastination"; a dashboard that greets those
 * people with a wall of red failures is the screen they will stop opening.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * 1. **A fifth band.** The tempting fix, and the same trap ORB-75 documented.
 *    The band drives ordering, membership and every denominator on the
 *    dashboard, so a new one would move these people out of Reach out next and
 *    solve the colour by hiding the person. `tone` is separate from `band` for
 *    exactly that reason, and both halves are asserted: the words and the
 *    colour change, the placement does not.
 *
 * 2. **Softening rather than reframing.** "Quiet a while" would be "Overdue"
 *    with the accusation filed off, and would leave the user no better informed
 *    about what to do. The wording has to point forward.
 *
 * 3. **Losing failure language where it IS true.** A starred person past their
 *    date has failed a commitment they made. That must still read as one, or
 *    the star stops meaning anything.
 */
import { loadMain } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const {
  getHealth, normalizeContact, needsAttention, countByBand,
  healthBarHtml, statusChip, personRowHtml, bandWords,
  DORMANT_META, BAND_META, FIRST_CONTACT_META
} = main;

const lapsed = (over = {}) => normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(200), nextReminder: daysAgo(170),
  interactions: [{ id: "i1", date: daysAgo(200), type: "coffee", notes: "x" }],
  ...over
});

group("The same lapse reads two ways, and the star is the difference");
{
  const mine = getHealth(lapsed({ starred: true }));
  const theirs = getHealth(lapsed());

  eq("a starred lapse is a failure, because you said it mattered",
    bandWords(mine).label, "Overdue");
  eq("an unstarred one is an opportunity", bandWords(theirs).label, "Worth reviving");
  ok("and the wording points forward rather than just softening",
    !/quiet|late|behind|overdue/i.test(DORMANT_META.label));
}
{
  const theirs = getHealth(lapsed());
  eq("the tone changes", theirs.tone, "dormant");
  eq("the band does not", theirs.band, "critical");
  eq("and a starred one keeps both", getHealth(lapsed({ starred: true })).tone, "critical");
}

group("Colour follows the tone; ordering and counts follow the band");
{
  const theirs = getHealth(lapsed());
  const html = healthBarHtml(theirs);
  ok("the bar is not painted with the failure colour", !/fill-critical/.test(html));
  ok("it has its own", /fill-dormant/.test(html));
  ok("so does the label", /text-dormant/.test(html));
  ok("and the chip", /chip-dormant/.test(statusChip(theirs)));

  const mine = getHealth(lapsed({ starred: true }));
  ok("a starred lapse keeps the failure colour", /fill-critical/.test(healthBarHtml(mine)));
  ok("and its chip", /chip-critical/.test(statusChip(mine)));
}
{
  // The ORB-75 trap, restated. Renaming a state must not relocate the person.
  const theirs = lapsed();
  eq("still listed for a reach-out", needsAttention([theirs]).length, 1);
  const counts = countByBand([theirs]);
  eq("still counted as critical", counts.critical, 1);
  eq("and not as some fifth thing", counts.good + counts.warning + counts.none, 0);
}
{
  const counts = countByBand([
    lapsed({ id: "a", starred: true }), lapsed({ id: "b" }), lapsed({ id: "c" })
  ]);
  eq("all three are past their date", counts.critical, 3);
  eq("one of them is someone you said mattered", counts.starredCritical, 1);
  ok("the subset can never exceed the band", counts.starredCritical <= counts.critical);
}
{
  eq("nobody starred means the subset is zero",
    countByBand([lapsed(), lapsed({ id: "b" })]).starredCritical, 0);
}

group("The detail line stops counting how late you are");
{
  ok("an unstarred lapse states elapsed time",
    /quiet 170 days/.test(healthBarHtml(getHealth(lapsed()))));
  ok("and never that it is 'over' anything",
    !/170 days over/.test(healthBarHtml(getHealth(lapsed()))));
  ok("a starred lapse still is over something",
    /170 days over/.test(healthBarHtml(getHealth(lapsed({ starred: true })))));
}
{
  // Singular, because "quiet 1 days" is the kind of thing that ships.
  const oneDay = lapsed({ lastContacted: daysAgo(31), nextReminder: daysAgo(1) });
  ok("one day is singular", /quiet 1 day\b/.test(healthBarHtml(getHealth(oneDay))));
}

group("Only a genuine lapse is reframed");
{
  const soon = lapsed({ lastContacted: daysAgo(25), nextReminder: daysAgo(-5) });
  const h = getHealth(soon);
  eq("someone merely approaching their date is untouched", h.band, "warning");
  eq("and has no dormant tone", h.tone, "warning");
  eq("their words are the ordinary ones", bandWords(h).label, BAND_META.warning.label);
}
{
  const current = lapsed({ lastContacted: daysAgo(2), nextReminder: daysAgo(-28) });
  eq("and someone in touch certainly is not", getHealth(current).tone, "good");
}
{
  // ORB-75 owns this state and keeps it. A person never spoken to is a starting
  // point, which is neither a failure nor a revival.
  const fresh = normalizeContact({
    id: "n1", name: "Priya Raman", dateMet: daysAgo(90),
    followUpFrequency: "monthly", reminderEnabled: true, interactions: []
  });
  fresh.lastContacted = "";
  // Stated outright rather than inferred from the cadence. ORB-124 moved when a
  // never-contacted person becomes late, and this test is not about when — it is
  // about which vocabulary they get once they are.
  fresh.nextReminder = daysAgo(9);
  const h = getHealth(fresh);
  eq("never contacted keeps ORB-75's words, not ORB-54's",
    bandWords(h).label, FIRST_CONTACT_META.label);
  ok("even when they are past the deadline", h.daysLeft < 0);
}
{
  const unscheduled = normalizeContact({
    id: "u1", name: "On File", followUpFrequency: "none",
    reminderEnabled: false, lastContacted: daysAgo(400)
  });
  const h = getHealth(unscheduled);
  eq("someone with no schedule cannot be dormant — there was no rhythm", h.tone, "none");
  eq("and is not chased", needsAttention([unscheduled]).length, 0);
}

group("It reads the same wherever the row is drawn");
{
  const theirs = lapsed();
  const row = personRowHtml(theirs, getHealth(theirs), { showReconnect: true });
  ok("the directory row reframes it", /Worth reviving/.test(row));
  ok("and never says overdue", !/Overdue/.test(row));

  const prompt = personRowHtml(theirs, getHealth(theirs), { showReconnect: true, prompt: true });
  ok("so does the reach-out prompt", /Worth reviving/.test(prompt));
  ok("which still asks for the reach-out", /Reached out/.test(prompt));
}
{
  const mine = lapsed({ starred: true });
  const row = personRowHtml(mine, getHealth(mine), { showReconnect: true });
  ok("a starred lapse still reads as one", /Overdue/.test(row));
  ok("and carries the star", /star-inline/.test(row));
}

done();
