/**
 * A person you have not spoken to reads as a starting point (ORB-75).
 *
 * ORB-73 made the state reachable; this makes it legible. Two things were
 * wrong once contacts could exist with no conversation:
 *
 *   - They were called **Overdue**. "Overdue" means a rhythm lapsed, and there
 *     is no rhythm to lapse before the first conversation. It reads as an
 *     accusation for a relationship that has not started.
 *   - Their profile said "No conversations logged yet." and nothing else, which
 *     looks like a card that failed to load rather than a deliberate state.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * The tempting fix is a fifth health band. That would have been wrong: the band
 * drives colour, ordering and the dashboard counts, so a new one would quietly
 * move these people out of Reach out next — solving the wording by hiding the
 * person. So only the words change, and the assertions below check both halves:
 * the vocabulary is different AND the placement is identical.
 *
 * The other risk is over-claiming. A contact whose only conversation was deleted
 * under ORB-64 has an empty array too, but a real `lastContacted` behind it —
 * calling them "not contacted yet" would state something the data cannot
 * support. That case is asserted explicitly.
 */
import { loadMain, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo, daysAhead } from "./helpers/dates.mjs";

const main = await loadMain();
const {
  getHealth, normalizeContact, needsAttention, countByBand,
  statusChip, healthBarHtml, personRowHtml, renderInteractionTimeline,
  firstDeadlineFor, GRACE_DAYS
} = main;

/**
 * Someone added through ORB-73, shaped exactly as the form saves them.
 *
 * The trailing override is not decoration: `normalizeContact` derives
 * `lastContacted` from `dateMet`, so the add path clears it afterwards. Without
 * that, recording a known meeting date would file the meeting as a
 * conversation. `add-connection.test.mjs` asserts the form really does this;
 * here it is mirrored so the vocabulary is tested against the shipped shape.
 */
const added = (over = {}) => ({
  ...normalizeContact({
    id: "n1", name: "Priya Raman", followUpFrequency: "monthly",
    reminderEnabled: true, interactions: [],
    nextReminder: firstDeadlineFor("", "monthly"),
    ...over
  }),
  lastContacted: over.lastContacted ?? ""
});

// Deliberately recent: a contact 120 days stale would sit in grace and be
// "warning" too, which would let the placement assertions below pass for the
// wrong reason.
const spokenTo = normalizeContact({
  id: "s1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(5),
  nextReminder: daysAhead(25),
  interactions: [{ id: "i1", date: daysAgo(5), type: "coffee chat", notes: "Hello" }]
});

// ── Who counts as never contacted ────────────────────────────────────────────

group("The flag is only set when the data actually supports it");
{
  ok("added with no conversation and no date", getHealth(added()).firstContact);
  ok("still true when a meeting date is known — meeting is not speaking",
    getHealth(added({ dateMet: daysAgo(30) })).firstContact);
  // The fallback itself is deliberately left alone: every other caller reaches
  // normalizeContact with a real conversation date, and weakening it for them
  // would be a cadence change smuggled inside a wording ticket.
  eq("normalizeContact still derives lastContacted from dateMet for everyone else",
    normalizeContact({ name: "X", dateMet: daysAgo(30) }).lastContacted, daysAgo(30));
  ok("false once a conversation exists", !getHealth(spokenTo).firstContact);
  // The ORB-64 case: the conversation was deleted, the contact stayed. The
  // array is empty but they were demonstrably contacted, so the app must not
  // claim otherwise.
  ok("false when a conversation was deleted but the date survived",
    !getHealth(normalizeContact({
      name: "Deleted", followUpFrequency: "monthly", reminderEnabled: true,
      lastContacted: daysAgo(40), interactions: []
    })).firstContact);
  ok("false for someone with no cadence at all but a history",
    !getHealth(normalizeContact({
      name: "On file", followUpFrequency: "none", lastContacted: daysAgo(9)
    })).firstContact);
}
{
  // The flag has to survive the unscheduled branch too, or the vocabulary
  // silently reverts for anyone kept on file.
  const onFile = getHealth(added({ followUpFrequency: "none", reminderEnabled: false }));
  ok("set even when nothing is scheduled", onFile.firstContact);
  eq("and they are still unscheduled", onFile.scheduled, false);
}

// ── The words ────────────────────────────────────────────────────────────────

group("They are not called overdue");
{
  const fresh = getHealth(added());
  ok("the chip does not say overdue", !/overdue/i.test(statusChip(fresh)));
  ok("it says not contacted", /Not contacted/.test(statusChip(fresh)));
  ok("the health bar agrees", /Not contacted yet/.test(healthBarHtml(fresh)));
}
{
  // Past the grace window is the case that used to read worst: "Overdue,
  // 14 days over" for someone you simply had not got round to yet.
  const late = getHealth(added({ nextReminder: daysAgo(14) }));
  eq("the band is still critical, so ordering is untouched", late.band, "critical");
  ok("but the word is not overdue", !/overdue/i.test(healthBarHtml(late)));
  ok("it still says not contacted yet", /Not contacted yet/.test(healthBarHtml(late)));
  ok("the elapsed time is stated without blame",
    /waiting 14 days/.test(healthBarHtml(late)));
  ok("and not as being over something", !/14 days over/.test(healthBarHtml(late)));
}
{
  const late = getHealth(added({ nextReminder: daysAgo(1) }));
  ok("one day reads singular", /waiting 1 day\b/.test(healthBarHtml(late)));
}

group("The old vocabulary survives wherever it is still true");
{
  const overdue = getHealth(normalizeContact({
    name: "Lapsed", followUpFrequency: "monthly", reminderEnabled: true,
    lastContacted: daysAgo(200), nextReminder: daysAgo(9),
    interactions: [{ id: "i1", date: daysAgo(200), type: "coffee chat", notes: "x" }]
  }));
  ok("someone with a lapsed rhythm is still overdue", /Overdue/.test(healthBarHtml(overdue)));
  ok("and still counted in days over", /9 days over/.test(healthBarHtml(overdue)));
  ok("their chip says so too", /Overdue/.test(statusChip(overdue)));
}

// ── Placement must not change ────────────────────────────────────────────────

group("Renaming the state does not hide the person");
{
  const c = added();
  eq("still listed in Reach out next", needsAttention([c]).length, 1);
  const counts = countByBand([c, spokenTo]);
  eq("still counted under a real band, not a new one",
    Object.keys(counts).sort().join(","), "critical,good,none,warning");
  eq("the never-contacted person lands in warning during grace", counts.warning, 1);
  ok("no band is undefined", !Object.values(counts).some((n) => Number.isNaN(n)));
}
{
  const late = added({ nextReminder: daysAgo(3) });
  eq("past the window they sort as critical", getHealth(late).band, "critical");
  eq("and are still in the list", needsAttention([late]).length, 1);
}

// ── The row ──────────────────────────────────────────────────────────────────

group("The reach-out row states a fact, not a missing field");
{
  const c = added();
  const row = personRowHtml(c, getHealth(c), { showReconnect: true });
  ok("it says not contacted yet", /Not contacted yet/.test(row));
  ok("and never 'Last connected no date'", !/Last connected no date/.test(row));
  ok("the cadence is still shown", /Every month/.test(row));
  ok("the reached-out action is still offered", /data-did-reach-out/.test(row));
}
{
  const row = personRowHtml(spokenTo, getHealth(spokenTo));
  ok("someone with history still shows when you last spoke",
    /Last connected/.test(row));
}

// ── The profile ──────────────────────────────────────────────────────────────

group("An empty history reads as a beginning");
{
  const html = renderInteractionTimeline([], [], { name: "Priya Raman" });
  ok("it does not use the bare old sentence",
    !/^<p class="empty">No conversations logged yet\.<\/p>$/.test(html));
  ok("it says there are none yet", /No conversations yet/.test(html));
  ok("and says what will happen", /first one you log will appear here/i.test(html));
}
{
  const html = renderInteractionTimeline([], [], {
    name: "Priya Raman", dateMet: daysAgo(30)
  });
  ok("a known meeting date is used", /You met Priya/.test(html));
  ok("phrased relatively", /month ago|30 days ago/.test(html));
}
{
  const html = renderInteractionTimeline([], [], { name: "Priya Raman" });
  ok("no meeting date means no invented sentence about one", !/You met/.test(html));
}
{
  const html = renderInteractionTimeline([], [], { name: "" });
  ok("it still renders without a name", /No conversations yet/.test(html));
  ok("and does not print an empty gap where the name goes", !/  /.test(html));
}
{
  const withOne = renderInteractionTimeline(
    [main.normalizeInteraction({ id: "i1", date: today(), type: "coffee chat", notes: "Hi" })],
    [], { name: "Priya Raman" });
  ok("a contact with history gets the timeline, not the empty state",
    !/No conversations yet/.test(withOne));
  ok("the conversation renders", /Hi/.test(withOne));
}

group("The empty state is escaped like everything else");
{
  // The name is only rendered alongside a known meeting date, so the date has
  // to be present for this to exercise anything at all.
  const html = renderInteractionTimeline([], [], {
    name: '<img src=x onerror=alert(1)>', dateMet: daysAgo(3)
  });
  ok("no raw tag survives", !/<img/.test(html));
  ok("it was escaped", /&lt;img/.test(html));
}
{
  const html = renderInteractionTimeline([], [], { name: '<img src=x>' });
  ok("and with no meeting date the name is never printed at all",
    !/img/.test(html));
}

done();
