import { loadMain } from "./helpers/load-main.mjs";
const { getHealth, firstDeadlineFor, normalizeContact, getIntervalDays, calculateNextReminder, GRACE_DAYS, addDays, needsAttention, countByBand } = await loadMain();
// Exercises the grace-window and custom-cadence logic from js/main.js.


let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? (pass++, console.log("  pass  " + label))
     : (fail++, console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`));
};

import { today, daysAgo, daysAhead } from "./helpers/dates.mjs";

console.log("\n── firstDeadlineFor: grace only when already blown ──");
check("stale contact gets today + 7",
  firstDeadlineFor(daysAgo(120), "monthly"), daysAhead(GRACE_DAYS));
check("recent contact keeps its natural deadline",
  firstDeadlineFor(daysAgo(5), "monthly"), daysAhead(25));
check("contacted today keeps natural deadline",
  firstDeadlineFor(today(), "monthly"), daysAhead(30));
// ORB-124. Nothing to count from is not the same situation as a blown cadence.
// A blown cadence is a deadline you have already missed, and the week buys you
// time to fix it. Someone just added has missed nothing — handing them a
// seven-day deadline made adding a person feel like taking on a debt. They
// start their cadence today.
check("no date at all starts the cadence today, not a seven-day window",
  firstDeadlineFor("", "monthly"), daysAhead(30));
check("and the cadence they were given is the one that runs",
  firstDeadlineFor("", "custom:90"), daysAhead(90));
check("no cadence means no deadline",
  firstDeadlineFor(daysAgo(10), "none"), "");
check("custom cadence respected",
  firstDeadlineFor(daysAgo(2), "custom:45"), daysAhead(43));

console.log("\n── a freshly scheduled stale contact is NOT instantly overdue ──");
const fresh = {
  followUpFrequency: "monthly", reminderEnabled: true,
  lastContacted: daysAgo(120), nextReminder: firstDeadlineFor(daysAgo(120), "monthly")
};
const fh = getHealth(fresh);
check("not overdue", fh.band !== "critical", true);
check("but NOT 'in touch' — you still owe them a first reach-out", fh.band, "warning");
check("grace flag set", fh.grace, true);
check("7 days left", fh.daysLeft, GRACE_DAYS);
check("full health at the start of the window", fh.pct, 100);

console.log("\n── the grace window then counts down ──");
const midGrace = { ...fresh, nextReminder: daysAhead(3) };
const mh = getHealth(midGrace);
check("3 days left", mh.daysLeft, 3);
check("scaled against the 7-day window, not the cadence", mh.pct, 43);
check("still grace", mh.grace, true);
check("warning, not overdue", mh.band, "warning");

console.log("\n── missing the grace window IS overdue ──");
const missed = { ...fresh, nextReminder: daysAgo(2) };
const mo = getHealth(missed);
check("overdue", mo.band, "critical");
check("2 days over", mo.daysLeft, -2);

console.log("\n── after reaching out, the normal cadence resumes ──");
const after = {
  followUpFrequency: "monthly", reminderEnabled: true,
  lastContacted: today(), nextReminder: calculateNextReminder(today(), "monthly")
};
const ah = getHealth(after);
check("grace is gone", ah.grace, false);
check("30 days left", ah.daysLeft, 30);
check("healthy", ah.band, "good");

console.log("\n── grace is granted once, not on every save ──");
// Re-normalising a contact that already has a deadline must not extend it.
const kept = normalizeContact({
  name: "X", followUpFrequency: "monthly", reminderEnabled: true,
  lastContacted: daysAgo(120), nextReminder: daysAhead(2)
});
check("existing deadline preserved", kept.nextReminder, daysAhead(2));

console.log("\n── back-filling an old conversation gets the grace window ──");
const backfilled = normalizeContact({
  name: "Met months ago", followUpFrequency: "monthly", dateMet: daysAgo(120)
});
check("deadline is a week out, not in the past", backfilled.nextReminder, daysAhead(GRACE_DAYS));
check("shows as needing a reach-out, not healthy", getHealth(backfilled).band, "warning");

console.log("\n── a brand-new contact met today is unaffected ──");
const todayContact = normalizeContact({ name: "New", followUpFrequency: "monthly", dateMet: today() });
check("normal 30-day deadline", todayContact.nextReminder, daysAhead(30));
check("no grace flag", getHealth(todayContact).grace, false);

console.log("\n── a freshly scheduled person appears in 'Reach out next' ──");
const roster = [
  normalizeContact({ id:"a", name:"Just scheduled", followUpFrequency:"monthly",
                     reminderEnabled:true, lastContacted:daysAgo(120) }),
  normalizeContact({ id:"b", name:"Current",        followUpFrequency:"monthly",
                     reminderEnabled:true, lastContacted:daysAgo(2) })
];
check("the newly scheduled one is listed",
  needsAttention(roster).map((x) => x.contact.id), ["a"]);
check("the current one is not", getHealth(roster[1]).band, "good");
check("it counts under 'Reach out soon', not 'In touch'",
  [countByBand(roster).good, countByBand(roster).warning], [1, 1]);

console.log("\n── custom cadences ──");
check("custom:45 parses", getIntervalDays("custom:45"), 45);
const custom = normalizeContact({ name: "C", followUpFrequency: "custom:10", dateMet: today() });
check("custom deadline", custom.nextReminder, daysAhead(10));
check("custom health window", getHealth(custom).daysLeft, 10);

console.log("\n── addDays ──");
check("crosses a month boundary", addDays("2026-01-28", 7), "2026-02-04");
check("crosses a year boundary", addDays("2026-12-30", 5), "2027-01-04");
check("handles a leap day", addDays("2028-02-28", 1), "2028-02-29");
check("empty in, empty out", addDays("", 7), "");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
