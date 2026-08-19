/**
 * Star the people who matter (ORB-93), and the tier picker's removal (ORB-94).
 *
 * WHY A STAR AND NOT A BETTER TIER
 *
 * Survey 1 asked five students when they knew which contacts genuinely
 * mattered. Two knew from the first conversation. One knew after several
 * months. Two only know looking back, now.
 *
 * Every design that resolves that split by asking a better question is still
 * asking. A tier demanded a classification at the moment you had least
 * information. A star asks you to point: one bit, no taxonomy, no cadence
 * attached, and simply absent for the people who cannot answer yet.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * 1. **Inference.** The star is stored, never derived. The moment anything
 *    computes it, ORB-57's first metric — a user stars at least one person in
 *    their first week — stops measuring anything, because every contact would
 *    look deliberately marked. `starred` must default to false and must only
 *    ever be true because someone said so.
 *
 * 2. **Truthiness.** `starred: "no"` and `starred: 0` are the classic ways a
 *    boolean column starts lying. The normalizer coerces with `=== true`, and
 *    that is asserted rather than assumed.
 *
 * 3. **A star that does not stick.** The button flips optimistically because it
 *    would feel broken otherwise, so a failed save has to put it back. Silently
 *    leaving it lit is the ORB-14 problem — the screen claiming something the
 *    database never accepted.
 *
 * 4. **Hiding people.** Starring changes ORDER, never membership. An unstarred
 *    overdue contact must still be on the list, below the starred ones.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  normalizeContact, needsAttention, personRowHtml, getHealth,
  starButtonHtml, toggleStar, matchesConnectionFilters, STARRED_FILTER,
  wirePersonRows
} = main;

const person = (over = {}) => normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(45), interactions: [], ...over
});

// ── The model ─────────────────────────────────────────────────────────────────
group("A star is something you said, not something inferred");
{
  eq("absent means unanswered, not starred", person().starred, false);
  eq("an explicit star survives", person({ starred: true }).starred, true);
  eq("it is a boolean", typeof person({ starred: true }).starred, "boolean");
}
{
  // The classic ways a boolean column starts lying.
  eq('"no" is not true', person({ starred: "no" }).starred, false);
  eq('"false" is not true', person({ starred: "false" }).starred, false);
  eq("0 is not true", person({ starred: 0 }).starred, false);
  eq("1 is not true either — only true is", person({ starred: 1 }).starred, false);
}
{
  // The whole distinction from ORB-86. Nothing about the relationship's shape
  // may promote someone: not a cadence, not a history, not a tier.
  const busy = person({
    tier: "inner_circle", followUpFrequency: "weekly",
    interactions: Array.from({ length: 12 }, (_, i) => ({ id: "i" + i, date: daysAgo(i * 7) }))
  });
  eq("a close tier does not star anyone", busy.starred, false);
  eq("nor does a thick history", normalizeContact(busy).starred, false);
}

// ── Ordering ──────────────────────────────────────────────────────────────────
group("Starred people come first, and nobody is hidden");
{
  const roster = [
    person({ id: "worst", name: "Worst", lastContacted: daysAgo(200) }),
    person({ id: "mine", name: "Mine", lastContacted: daysAgo(32), starred: true }),
    person({ id: "middling", name: "Middling", lastContacted: daysAgo(60) })
  ];
  const order = needsAttention(roster).map((x) => x.contact.name);
  eq("the starred person leads even while barely drifting", order[0], "Mine");
  eq("everyone else keeps the old ordering", order.slice(1), ["Worst", "Middling"]);
  eq("and nobody dropped off the list", order.length, 3);
}
{
  const roster = [
    person({ id: "a", name: "A", lastContacted: daysAgo(200), starred: true }),
    person({ id: "b", name: "B", lastContacted: daysAgo(40), starred: true })
  ];
  eq("within the starred group the clock still decides",
    needsAttention(roster).map((x) => x.contact.name), ["A", "B"]);
}
{
  // Starring must not rescue someone from the list, or put them on it.
  const current = person({ id: "ok", lastContacted: daysAgo(1), starred: true });
  eq("a starred person in touch is still not chased", needsAttention([current]).length, 0);
  const unscheduled = person({
    id: "off", followUpFrequency: "none", reminderEnabled: false, starred: true
  });
  eq("and a starred person with no schedule is still not chased",
    needsAttention([unscheduled]).length, 0);
}

// ── The control ───────────────────────────────────────────────────────────────
group("The control says which state it is in, and about whom");
{
  const off = starButtonHtml(person());
  ok("an unanswered question is an outline", /☆/.test(off));
  ok("not pressed", /aria-pressed="false"/.test(off));
  ok("the label names the person, because these appear in lists",
    /aria-label="Star Marcus Chen"/.test(off));

  const on = starButtonHtml(person({ starred: true }));
  ok("a star is filled", /★/.test(on));
  ok("and pressed", /aria-pressed="true"/.test(on));
  ok("the label offers the reverse", /aria-label="Unstar Marcus Chen"/.test(on));
  ok("it carries the state as a class too", /class="star-btn starred"/.test(on));
}
{
  const html = starButtonHtml(person({ name: '<img src=x onerror=alert(1)>' }));
  ok("no tag survives into the label", !/<img/.test(html));
  ok("it was escaped", /&lt;img/.test(html));
}
{
  const row = personRowHtml(person({ starred: true }), getHealth(person()), { showReconnect: true });
  ok("the row carries the control", /data-toggle-star/.test(row));
  ok("and the name carries the state, so a scan of the list reads it",
    /class="star-inline"/.test(row));
  ok("an unstarred row shows no inline star",
    !/star-inline/.test(personRowHtml(person(), getHealth(person()), { showReconnect: true })));
}

group("Toggling saves, confirms, and survives a refusal");
{
  resetState();
  const c = person();
  state.store.set(c.id, c);
  let renders = 0;
  const result = await toggleStar(c, async () => { renders++; });
  eq("it reports success", result, true);
  eq("the star is stored", state.store.get("c1").starred, true);
  eq("the page is re-rendered once", renders, 1);
  ok("and it is confirmed by name",
    document.querySelector(".toast")?.textContent.includes("Marcus Chen"));
}
{
  resetState();
  const c = person({ starred: true });
  state.store.set(c.id, c);
  await toggleStar(c, async () => {});
  eq("starring is a toggle, not a one-way door", state.store.get("c1").starred, false);
}
{
  // The ORB-14 failure: the screen claiming something the database refused.
  resetState();
  state.failSave = true;
  const c = person();
  state.store.set(c.id, c);
  let renders = 0;
  const result = await toggleStar(c, async () => { renders++; });
  eq("a refused save reports failure", result, false);
  eq("nothing was stored", state.store.get("c1").starred, false);
  eq("the page is re-rendered anyway, which is what puts the button back", renders, 1);
  ok("and the user is told",
    /Could not save/.test(document.querySelector(".toast")?.textContent || ""));
  state.failSave = false;
}
{
  // Optimism, and the click not opening the contact underneath it.
  resetState();
  const c = person();
  state.store.set(c.id, c);
  document.body.innerHTML = '<ul id="l"></ul>';
  const list = document.getElementById("l");
  list.innerHTML = personRowHtml(c, getHealth(c), { showReconnect: true });
  let opened = false;
  wirePersonRows(list, [c], async () => {});
  list.querySelector(".person-row").addEventListener("click", () => { opened = true; });

  const btn = list.querySelector("[data-toggle-star]");
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  eq("the button flips before the save returns", btn.getAttribute("aria-pressed"), "true");
  ok("and looks it", btn.classList.contains("starred"));
  await new Promise((r) => setTimeout(r, 20));
  eq("the save landed", state.store.get("c1").starred, true);
  eq("and the row underneath did not open", opened, false);
}

// ── The filter ────────────────────────────────────────────────────────────────
group("Starred only is offered; unstarred only is not");
{
  const values = STARRED_FILTER.options.map((o) => o.value);
  eq("two choices", values, ["", "1"]);
  eq("and the default is everyone", STARRED_FILTER.options[0].label, "Everyone");
  // An outline star means the question was never answered, so a list of them is
  // a list of nothing in particular.
  ok("there is no unstarred-only option",
    !STARRED_FILTER.options.some((o) => /unstarred/i.test(o.label)));
}
{
  const yes = person({ starred: true });
  const no = person({ id: "c2", starred: false });
  eq("starred only keeps the starred", matchesConnectionFilters(yes, { starred: "1" }), true);
  eq("and drops the rest", matchesConnectionFilters(no, { starred: "1" }), false);
  eq("no filter keeps everyone", matchesConnectionFilters(no, { starred: "" }), true);
  eq("an absent key changes nothing", matchesConnectionFilters(no, {}), true);
}
{
  // Filters compose. A starred person who fails another filter is still out.
  const yes = person({ starred: true, followUpFrequency: "monthly" });
  eq("the star does not exempt anyone from the other filters",
    matchesConnectionFilters(yes, { starred: "1", cadence: "quarterly" }), false);
}

done();
