import { loadMain } from "./helpers/load-main.mjs";
const { getHealth, relativeDayLabel, getIntervalDays, normalizeContact, calculateNextReminder, getFreqLabel, needsAttention, countByBand } = await loadMain();
// Exercises the real functions from js/main.js (via a stubbed-import copy).


let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  pass  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`); }
}
function checkFn(label, fn) {
  try { const r = fn(); if (r) { pass++; console.log(`  pass  ${label}`); } else { fail++; console.log(`  FAIL  ${label}`); } }
  catch (e) { fail++; console.log(`  FAIL  ${label} — threw ${e.message}`); }
}

const daysAgo = (n) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

console.log("\n── getIntervalDays ──");
check("weekly", getIntervalDays("weekly"), 7);
check("monthly", getIntervalDays("monthly"), 30);
check("quarterly", getIntervalDays("quarterly"), 90);
check("custom:45", getIntervalDays("custom:45"), 45);
check("none -> 0", getIntervalDays("none"), 0);
check("garbage -> 0", getIntervalDays("custom:abc"), 0);
check("negative custom -> 0", getIntervalDays("custom:-5"), 0);
check("undefined -> 0", getIntervalDays(undefined), 0);

console.log("\n── getHealth: bands ──");
const tracked = (last, freq) => getHealth({ followUpFrequency: freq, reminderEnabled: true, lastContacted: last });

check("just contacted, monthly -> 100% strong",
  (() => { const h = tracked(daysAgo(0), "monthly"); return [h.pct, h.band]; })(), [100, "good"]);
check("15/30 days -> 50% fading",
  (() => { const h = tracked(daysAgo(15), "monthly"); return [h.pct, h.band]; })(), [50, "warning"]);
check("28/30 days -> 7% but NOT yet overdue",
  (() => { const h = tracked(daysAgo(28), "monthly"); return [h.pct, h.band]; })(), [7, "warning"]);
check("exactly at the deadline is not overdue",
  tracked(daysAgo(30), "monthly").band, "warning");
check("one day past the deadline IS overdue",
  tracked(daysAgo(31), "monthly").band, "critical");
check("long cadence with days remaining is not overdue",
  tracked(daysAgo(80), "quarterly").band, "warning");
check("long cadence still reports days left",
  tracked(daysAgo(80), "quarterly").daysLeft, 10);
check("band never contradicts daysLeft",
  [7, 15, 29, 30, 31, 45, 80, 200].every((d) => {
    const h = tracked(daysAgo(d), "monthly");
    return (h.band === "critical") === (h.daysLeft < 0);
  }), true);
check("past due clamps at 0",
  (() => { const h = tracked(daysAgo(90), "monthly"); return [h.pct, h.band]; })(), [0, "critical"]);
check("boundary 60% is strong",
  tracked(daysAgo(12), "monthly").band, "good");
check("boundary 25% is fading",
  tracked(daysAgo(22), "monthly").pct >= 25 ? tracked(daysAgo(22), "monthly").band : "n/a", "warning");

console.log("\n── getHealth: unscheduled cases ──");
check("frequency none -> unscheduled", tracked(daysAgo(5), "none").scheduled, false);
check("reminders off -> unscheduled",
  getHealth({ followUpFrequency: "monthly", reminderEnabled: false, lastContacted: daysAgo(5) }).scheduled, false);
check("no date -> unscheduled",
  getHealth({ followUpFrequency: "monthly", reminderEnabled: true, lastContacted: "" }).scheduled, false);
checkFn("empty contact does not throw", () => getHealth({}).scheduled === false);

console.log("\n── getHealth: daysLeft ──");
check("10 days into a 30-day cadence -> 20 left", tracked(daysAgo(10), "monthly").daysLeft, 20);
check("40 days into a 30-day cadence -> -10", tracked(daysAgo(40), "monthly").daysLeft, -10);

console.log("\n── relativeDayLabel ──");
check("today", relativeDayLabel(daysAgo(0)), "today");
check("yesterday", relativeDayLabel(daysAgo(1)), "yesterday");
check("5 days", relativeDayLabel(daysAgo(5)), "5 days ago");
check("2 months", relativeDayLabel(daysAgo(60)), "2 months ago");
check("1 year", relativeDayLabel(daysAgo(365)), "1 year ago");
check("no value", relativeDayLabel(""), "no date");

console.log("\n── calculateNextReminder ──");
check("monthly from a fixed date",
  calculateNextReminder("2026-01-01", "monthly").slice(0, 10), "2026-01-31");
check("weekly from a fixed date",
  calculateNextReminder("2026-01-01", "weekly").slice(0, 10), "2026-01-08");
check("none -> empty", calculateNextReminder("2026-01-01", "none"), "");
check("no date -> empty", calculateNextReminder("", "monthly"), "");

console.log("\n── getFreqLabel ──");
check("monthly", getFreqLabel("monthly"), "Every month");
check("custom:45", getFreqLabel("custom:45"), "Every 45 days");
check("custom:1 singular", getFreqLabel("custom:1"), "Every 1 day");
check("unknown", getFreqLabel("zzz"), "No schedule");

console.log("\n── normalizeContact ──");
const n = normalizeContact({ name: "  Ada Lovelace  ", followUpFrequency: "monthly", dateMet: daysAgo(3) });
check("trims name", n.name, "Ada Lovelace");
check("derives lastContacted from dateMet", n.lastContacted, daysAgo(3));
check("derives nextReminder", n.nextReminder.length > 0, true);
check("defaults arrays", [n.interactions, n.followUps, n.companyHistory], [[], [], []]);
check("no starred key (column does not exist)", "starred" in n, false);
checkFn("empty object does not throw", () => normalizeContact({}).name === "");

console.log("\n── needsAttention ordering ──");
const roster = [
  { id: "a", name: "Strong", followUpFrequency: "monthly", reminderEnabled: true, lastContacted: daysAgo(1) },
  { id: "b", name: "Overdue", followUpFrequency: "monthly", reminderEnabled: true, lastContacted: daysAgo(45) },
  { id: "c", name: "Fading", followUpFrequency: "monthly", reminderEnabled: true, lastContacted: daysAgo(18) },
  { id: "d", name: "Untracked", followUpFrequency: "none", reminderEnabled: false, lastContacted: daysAgo(99) }
];
const att = needsAttention(roster);
check("excludes strong and unscheduled", att.map((x) => x.contact.id), ["b", "c"]);
check("most overdue first", att[0].contact.id, "b");


console.log("\n── industry + countByBand ──");
const ind = normalizeContact({ name: "X", industry: "  Finance " });
check("industry trimmed", ind.industry, "Finance");
check("industry defaults empty", normalizeContact({ name: "Y" }).industry, "");
const cb = countByBand(roster);
check("counts by band", [cb.good, cb.warning, cb.critical, cb.none], [1, 1, 1, 1]);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
