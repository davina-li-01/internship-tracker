import { loadMain } from "./helpers/load-main.mjs";
const { normalizeContact, cadenceKey, matchesConnectionFilters, countByBand } = await loadMain();

let pass=0, fail=0;
const check=(l,a,e)=>{const ok=JSON.stringify(a)===JSON.stringify(e);
  ok?(pass++,console.log("  pass  "+l)):(fail++,console.log(`  FAIL  ${l}\n        expected ${JSON.stringify(e)}\n        got      ${JSON.stringify(a)}`));};
import { daysAgo } from "./helpers/dates.mjs";
const C=(o)=>normalizeContact(o);

console.log("\n── cadenceKey ──");
check("monthly", cadenceKey(C({name:"a",followUpFrequency:"monthly",dateMet:daysAgo(1)})), "monthly");
check("custom collapses to 'custom'", cadenceKey(C({name:"a",followUpFrequency:"custom:45",dateMet:daysAgo(1)})), "custom");
check("none", cadenceKey(C({name:"a",followUpFrequency:"none"})), "none");
check("reminders off counts as none",
  cadenceKey({followUpFrequency:"monthly", reminderEnabled:false}), "none");

console.log("\n── silence filter: who have I not spoken to? ──");
const roster = [
  C({name:"Recent",   followUpFrequency:"monthly",   dateMet:daysAgo(5),   lastContacted:daysAgo(5)}),
  C({name:"TwoMonth", followUpFrequency:"monthly",   dateMet:daysAgo(65),  lastContacted:daysAgo(65)}),
  C({name:"HalfYear", followUpFrequency:"quarterly", dateMet:daysAgo(200), lastContacted:daysAgo(200)}),
  C({name:"Ancient",  followUpFrequency:"none",      dateMet:daysAgo(500), lastContacted:daysAgo(500)})
];
const names = (f) => roster.filter((c)=>matchesConnectionFilters(c,f)).map((c)=>c.name);
check("no filters -> everyone", names({}), ["Recent","TwoMonth","HalfYear","Ancient"]);
check("over a month", names({silent:"30"}), ["TwoMonth","HalfYear","Ancient"]);
check("over 3 months", names({silent:"90"}), ["HalfYear","Ancient"]);
check("over 6 months", names({silent:"180"}), ["HalfYear","Ancient"]);
check("over a year", names({silent:"365"}), ["Ancient"]);

console.log("\n── cadence filter ──");
check("monthly only", names({cadence:"monthly"}), ["Recent","TwoMonth"]);
check("no cadence set", names({cadence:"none"}), ["Ancient"]);
check("quarterly", names({cadence:"quarterly"}), ["HalfYear"]);

console.log("\n── filters combine ──");
check("monthly AND silent 30+", names({cadence:"monthly", silent:"30"}), ["TwoMonth"]);
check("impossible combination is empty", names({cadence:"weekly", silent:"365"}), []);

console.log("\n── health filter ──");
check("unmeasured = the one with no cadence", names({status:"none"}), ["Ancient"]);
const measured = names({status:"good"}).concat(names({status:"warning"}), names({status:"critical"})).sort();
check("every scheduled contact lands in exactly one band",
  measured, ["HalfYear","Recent","TwoMonth"]);

console.log("\n── dashboard denominator ──");
const counts = countByBand(roster);
check("three scheduled, one not",
  [counts.good+counts.warning+counts.critical, counts.none], [3, 1]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail?1:0);
