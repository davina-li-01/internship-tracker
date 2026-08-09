/**
 * Chart rendering — rings and the part-to-whole split bar.
 *
 * These exist because a 0% ring used to paint a stray dot at the top of the
 * circle: an arc of length zero still renders a round line cap. Reading the
 * code did not show it; rendering it did.
 */
import { loadMain } from "./helpers/load-main.mjs";
import { ok, group, done } from "./helpers/assert.mjs";
const { ringHtml, splitBarHtml } = await loadMain();

group("Charts");

const zero = ringHtml({ pct: 0, band: "none", caption: "Nothing", sub: "x" });
ok("0% draws no arc (no stray dot)", !zero.includes("ring-fill"));
ok("0% still draws the track", zero.includes("ring-track"));
ok("0% prints 0%", zero.includes(">0%<"));

const half = ringHtml({ pct: 50, band: "good", caption: "Half" });
ok("50% draws an arc", half.includes("ring-fill ring-good"));
ok("50% arc is half the circumference", /stroke-dasharray="131\.9\d? 131\.9\d?"/.test(half));

const over = ringHtml({ pct: 140, band: "good", caption: "Over" });
ok("clamps above 100", over.includes(">100%<"));
const neg = ringHtml({ pct: -20, band: "none", caption: "Neg" });
ok("clamps below 0 and draws no arc", neg.includes(">0%<") && !neg.includes("ring-fill"));

const bar = splitBarHtml({ good: 2, warning: 1, critical: 3 });
ok("split bar renders 3 segments", (bar.match(/split-seg/g) || []).length === 3);
ok("split bar legend shows counts", bar.includes(">2<") && bar.includes(">1<") && bar.includes(">3<"));
const barZero = splitBarHtml({ good: 0, warning: 0, critical: 0 });
ok("empty split bar renders nothing", barZero === "");
const barPartial = splitBarHtml({ good: 0, warning: 2, critical: 0 });
ok("zero-count bands are omitted as segments", (barPartial.match(/split-seg/g) || []).length === 1);

done();
