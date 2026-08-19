/**
 * A reason, two triggers, and trigger before timer (ORB-90, ORB-91, ORB-92).
 *
 * WHY
 *
 * Survey 1 asked what prompted the last message people sent a professional
 * contact. **Exactly one of five acted on a reminder they had set themselves** —
 * the mechanism this app was built on. Gollwitzer and Sheeran put if-then plans
 * at **d = .65** across 94 tests: "when X happens, I will do Y" beats "I will do
 * Y eventually" by a wide margin, and a timer is the second dressed as the first.
 *
 * So Reach out next stops being a queue of dates. Every row states why it is
 * there (ORB-90), two of those reasons are real events rather than elapsed time
 * (ORB-91), and events sort above the clock (ORB-92).
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * 1. **The clock quietly winning anyway.** A trigger has to put someone on the
 *    list *without* a lapsed cadence — and for "you just met" the cadence
 *    actively fights it, because having just spoken makes you "in touch". The
 *    one moment a note lands best is the one moment the old dashboard said
 *    there was nothing to do. That case is asserted directly.
 *
 * 2. **Nagging about a job already done.** If you met on Monday and reached out
 *    on Tuesday, the trigger must be gone by Wednesday.
 *
 * 3. **Two rankings.** The reason list and the sort order are the same array,
 *    on purpose. Two lists is how a row shows one reason and sorts by another.
 *
 * 4. **The fallback shouting.** "It has been a while" is the honest reason when
 *    there is no better one, and it is already the sentence ORB-78 prints. A
 *    row must not say it twice with a tag on it.
 *
 * 5. **The year boundary.** On 2 January, a December anniversary is three days
 *    ago and lives in the previous year. Checking only the current year would
 *    skip every December anniversary for anyone who opens the app after New
 *    Year, and would do it silently for eleven months.
 */
import { loadMain } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo, daysAhead } from "./helpers/dates.mjs";

const main = await loadMain();
const {
  normalizeContact, getHealth, needsAttention, reachOutReason, reasonRank,
  justMetTrigger, anniversaryTrigger, reachOutPromptHtml,
  REACH_OUT_REASONS, JUST_MET_DAYS, ANNIVERSARY_WINDOW_DAYS
} = main;

const person = (over = {}) => normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(200), nextReminder: daysAgo(170),
  dateMet: daysAgo(200), interactions: [], ...over
});

const spoke = (n, over = {}) => ({
  id: "i" + n, date: daysAgo(n), type: "coffee", notes: "Talked shop.", ...over
});

/** The same calendar day, n whole years ago. */
const yearsAgo = (n) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setFullYear(d.getFullYear() - n);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")].join("-");
};

// ── ORB-91, trigger A ─────────────────────────────────────────────────────────
group("You just met — the moment the cadence hides");
{
  const c = person({ interactions: [spoke(2)], lastContacted: daysAgo(2) });
  const t = justMetTrigger(c);
  ok("a conversation two days old fires it", t);
  eq("named", t.kind, "just-met");
  ok("and it says why now rather than later", /lands better than one in a month/.test(t.text));
  ok("naming the person and the gap", /You spoke to Marcus 2 days ago/.test(t.text));
}
{
  const c = person({ interactions: [spoke(0)], lastContacted: today() });
  ok("today reads as today, not as '0 days ago'",
    /You spoke to Marcus today —/.test(justMetTrigger(c).text));
}
{
  const c = person({ interactions: [spoke(JUST_MET_DAYS)], lastContacted: daysAgo(JUST_MET_DAYS) });
  ok("the edge of the window still fires", justMetTrigger(c));
  const old = person({
    interactions: [spoke(JUST_MET_DAYS + 1)], lastContacted: daysAgo(JUST_MET_DAYS + 1)
  });
  eq("a day past it does not", justMetTrigger(old), null);
}
{
  // Nagging about a job already done.
  const c = person({ interactions: [spoke(3)], lastContacted: daysAgo(1) });
  eq("reaching out after the conversation clears it", justMetTrigger(c), null);
}
{
  eq("nothing logged, nothing to follow up", justMetTrigger(person()), null);
  const future = person({ interactions: [spoke(-3)], lastContacted: "" });
  eq("a conversation dated in the future is not a trigger", justMetTrigger(future), null);
}
{
  const c = person({
    interactions: [spoke(2), spoke(90, { id: "old" })], lastContacted: daysAgo(2)
  });
  ok("the most recent conversation is the one that counts", justMetTrigger(c));
}

// ── ORB-91, trigger B ─────────────────────────────────────────────────────────
group("The anniversary of meeting — an excuse, which is what people lack");
{
  const c = person({ dateMet: yearsAgo(1) });
  const t = anniversaryTrigger(c);
  ok("a year to the day fires it", t);
  eq("named", t.kind, "anniversary");
  ok("singular at one year", /It is 1 year this week since you met Marcus\./.test(t.text));
}
{
  ok("plural after that",
    /It is 3 years this week/.test(anniversaryTrigger(person({ dateMet: yearsAgo(3) })).text));
}
{
  // A window, not a day. Nobody opens the app on the exact date.
  const soon = person({ dateMet: daysAhead(ANNIVERSARY_WINDOW_DAYS).replace(/^\d{4}/, String(new Date().getFullYear() - 2)) });
  ok("a few days early counts", anniversaryTrigger(soon));
}
{
  eq("under a year is not an anniversary", anniversaryTrigger(person({ dateMet: daysAgo(200) })), null);
  eq("no meeting date, no anniversary", anniversaryTrigger(person({ dateMet: "" })), null);
  eq("and a date mid-year is not one either",
    anniversaryTrigger(person({ dateMet: "2022-06-15" }), "2026-01-02"), null);
}
{
  // The year boundary. On 2 January a 30 December anniversary is three days
  // ago and belongs to the year just gone.
  const c = person({ dateMet: "2023-12-30" });
  const t = anniversaryTrigger(c, "2026-01-02");
  ok("a December anniversary is found from January", t);
  ok("and counted against the year it actually fell in",
    /It is 2 years this week/.test(t.text));
}
{
  const c = person({ dateMet: "2024-01-02" });
  ok("and the other direction still works",
    anniversaryTrigger(c, "2025-12-31"));
}

// ── ORB-90 ────────────────────────────────────────────────────────────────────
group("Every row states why it is there");
{
  const c = person({ followUps: [{ text: "Ask about the move", source: "capture" }] });
  const r = reachOutReason(c, getHealth(c));
  eq("a caught thought wins over everything", r.kind, "capture");
  eq("attributed to the user", r.label, "You noted");
}
{
  const c = person({
    interactions: [spoke(1)], lastContacted: daysAgo(1),
    followUps: [{ text: "Ask about the move", source: "capture" }]
  });
  eq("even over a fresh conversation", reachOutReason(c, getHealth(c)).kind, "capture");
}
{
  const c = person({ interactions: [spoke(1)], lastContacted: daysAgo(1), dateMet: yearsAgo(2) });
  eq("a fresh conversation beats an anniversary",
    reachOutReason(c, getHealth(c)).kind, "just-met");
}
{
  eq("an anniversary beats the clock",
    reachOutReason(person({ dateMet: yearsAgo(2) })).kind, "anniversary");
}
{
  const fresh = normalizeContact({
    id: "n1", name: "Priya Raman", dateMet: daysAgo(90),
    followUpFrequency: "monthly", reminderEnabled: true, interactions: []
  });
  fresh.lastContacted = "";
  const r = reachOutReason(fresh, getHealth(fresh));
  eq("never having spoken is itself a reason", r.kind, "first-contact");
  ok("stated as a beginning, not a failure", /first conversation with Priya/.test(r.text));
}
{
  const r = reachOutReason(person(), getHealth(person()));
  eq("and when there is nothing better, the clock", r.kind, "elapsed");
  eq("which prints no tag of its own", r.text, "");
}

group("The fallback does not shout");
{
  const html = reachOutPromptHtml(person(), getHealth(person()));
  ok("no reason tag on a plain elapsed row", !/prompt-capture/.test(html));
  // ORB-78 already says it, in a full sentence.
  ok("but the elapsed time is still stated", /You last spoke to Marcus/.test(html));
}
{
  const c = person({ dateMet: yearsAgo(2) });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("a real reason is tagged", /prompt-capture-tag/.test(html));
  ok("with its own label", /A year on/.test(html));
  ok("and comes above the elapsed time",
    html.indexOf("prompt-capture") < html.indexOf("prompt-line"));
  ok("which is still there", /You last spoke to Marcus/.test(html));
}
{
  const c = person({ dateMet: yearsAgo(2), name: '<img src=x onerror=alert(1)>' });
  ok("a reason is escaped like everything else",
    !/<img/.test(reachOutPromptHtml(c, getHealth(c))));
}

// ── ORB-92 ────────────────────────────────────────────────────────────────────
group("Trigger before timer");
{
  eq("the reason list and the sort order are one array",
    REACH_OUT_REASONS.join(","), "capture,just-met,anniversary,first-contact,elapsed");
  ok("a caught thought outranks a fresh conversation",
    reasonRank({ kind: "capture" }) < reasonRank({ kind: "just-met" }));
  ok("and the clock is last", reasonRank({ kind: "elapsed" }) === REACH_OUT_REASONS.length - 1);
  ok("an unknown reason sorts after everything rather than first",
    reasonRank({ kind: "invented" }) >= REACH_OUT_REASONS.length);
  eq("and so does no reason at all", reasonRank(null), REACH_OUT_REASONS.length);
}
{
  const noted = person({ id: "noted", name: "Noted", lastContacted: daysAgo(1),
    followUps: [{ text: "x", source: "capture" }] });
  const met = person({ id: "met", name: "Met", interactions: [spoke(2)], lastContacted: daysAgo(2) });
  const anniv = person({ id: "anniv", name: "Anniv", dateMet: yearsAgo(2) });
  const late = person({ id: "late", name: "Late", lastContacted: daysAgo(400), dateMet: daysAgo(400) });
  eq("the whole ranking, in one assertion",
    needsAttention([late, anniv, met, noted]).map((x) => x.contact.name),
    ["Noted", "Met", "Anniv", "Late"]);
}
{
  // THE ONE THAT MATTERS. Having just spoken makes you "in touch", so the
  // cadence would have hidden the exact moment a note lands best.
  const c = person({ interactions: [spoke(1)], lastContacted: daysAgo(1),
    nextReminder: daysAhead(29) });
  eq("someone in touch is on the list because something happened",
    needsAttention([c]).length, 1);
  eq("the health model still says they are fine", getHealth(c).band, "good");
}
{
  const c = person({ followUpFrequency: "none", reminderEnabled: false,
    dateMet: yearsAgo(2), lastContacted: daysAgo(400) });
  eq("and a trigger works with no schedule at all", needsAttention([c]).length, 1);
}
{
  const c = person({ followUpFrequency: "none", reminderEnabled: false,
    lastContacted: daysAgo(400), dateMet: daysAgo(400) });
  eq("but elapsed time alone still needs a cadence to mean anything",
    needsAttention([c]).length, 0);
}
{
  // The star still decides between two rows with the same kind of reason.
  const plain = person({ id: "p", name: "Plain", lastContacted: daysAgo(400), dateMet: daysAgo(400) });
  const mine = person({ id: "m", name: "Mine", lastContacted: daysAgo(200),
    dateMet: daysAgo(200), starred: true });
  eq("within one reason, the star breaks the tie",
    needsAttention([plain, mine]).map((x) => x.contact.name), ["Mine", "Plain"]);
}
{
  // ...but a reason beats a star, which is the ticket's actual claim.
  const starredTimer = person({ id: "s", name: "Starred", lastContacted: daysAgo(400),
    dateMet: daysAgo(400), starred: true });
  const plainTrigger = person({ id: "t", name: "Triggered", dateMet: yearsAgo(2) });
  eq("a reason beats a star", needsAttention([starredTimer, plainTrigger])
    .map((x) => x.contact.name), ["Triggered", "Starred"]);
}
{
  eq("nobody with nothing to say about them appears",
    needsAttention([person({ lastContacted: daysAgo(1), nextReminder: daysAhead(29),
      dateMet: daysAgo(400) })]).length, 0);
}

done();
