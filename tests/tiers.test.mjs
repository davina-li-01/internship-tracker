/**
 * Relationship tiers (ORB-52), and their removal from the flow (ORB-94).
 *
 * The tier is no longer asked for anywhere. Survey 1 found 3 of 5 students
 * could not say which contacts mattered at the moment the picker asked, and the
 * 2 who could are now served by a star (ORB-93) costing one click and no
 * taxonomy.
 *
 * **The model below is deliberately kept.** `TIERS`, `frequencyForTier` and
 * `tierForFrequency` still decide the default interval, still answer "is this
 * interval deliberate?" on the profile, and are what ORB-86 would revive if the
 * evidence ever supports suggesting a tier rather than demanding one. Migration
 * 012 and the column are untouched. So the first half of this suite is unchanged
 * and the second half now proves the question is gone rather than how it behaved.
 *
 * THE ONE THAT MATTERS
 *
 * `tierForFrequency` here and the back-fill in `012_relationship_tiers.sql` are
 * the same rule written twice, in two languages, in two repositories' worth of
 * distance from each other. If they drift, a contact shows one tier in the
 * picker and carries another in the database, and nothing errors. The boundary
 * assertions below are copied off the SQL's own `between` clauses deliberately.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  TIERS, TIER_ORDER, frequencyForTier, tierForFrequency, effectiveTier,
  normalizeContact, getIntervalDays
} = main;

group("The tier model is complete");
eq("every tier is in the display order", TIER_ORDER.length, Object.keys(TIERS).length);
ok("closest relationship comes first", TIER_ORDER[0] === "inner_circle");
ok("the opt-out comes last", TIER_ORDER[TIER_ORDER.length - 1] === "none");
for (const t of TIER_ORDER) {
  ok(t + " has a label, a hint and an interval",
    Boolean(TIERS[t].label && TIERS[t].hint && TIERS[t].frequency));
}

group("Each tier suggests the interval the research gave it");
eq("inner circle is monthly", getIntervalDays(frequencyForTier("inner_circle")), 30);
eq("mentors and managers is quarterly", getIntervalDays(frequencyForTier("mentors_managers")), 90);
eq("professional network is twice yearly", getIntervalDays(frequencyForTier("professional_network")), 180);
eq("met once is yearly", getIntervalDays(frequencyForTier("met_once")), 365);
eq("no schedule has no interval", getIntervalDays(frequencyForTier("none")), 0);
eq("an unknown tier does not invent a cadence", frequencyForTier("nonsense"), "none");

// ── The rule that exists twice ───────────────────────────────────────────────
// Copied off 012's `between` clauses: 1–60, 61–135, 136–272, >272, and the
// named frequencies which the SQL matches BEFORE it looks at day counts.

group("tierForFrequency matches the SQL back-fill, named frequencies");
eq("weekly", tierForFrequency("weekly"), "inner_circle");
eq("biweekly", tierForFrequency("biweekly"), "inner_circle");
eq("monthly", tierForFrequency("monthly"), "inner_circle");
eq("bimonthly", tierForFrequency("bimonthly"), "mentors_managers");
eq("quarterly", tierForFrequency("quarterly"), "mentors_managers");
eq("none", tierForFrequency("none"), "none");
eq("missing", tierForFrequency(""), "none");
eq("garbage custom value", tierForFrequency("custom:abc"), "none");

group("tierForFrequency matches the SQL back-fill, at every boundary");
eq("custom:1 → inner circle", tierForFrequency("custom:1"), "inner_circle");
eq("custom:60 is the last inner circle day", tierForFrequency("custom:60"), "inner_circle");
eq("custom:61 crosses to mentors", tierForFrequency("custom:61"), "mentors_managers");
eq("custom:135 is the last mentor day", tierForFrequency("custom:135"), "mentors_managers");
eq("custom:136 crosses to professional", tierForFrequency("custom:136"), "professional_network");
eq("custom:272 is the last professional day", tierForFrequency("custom:272"), "professional_network");
eq("custom:273 crosses to met once", tierForFrequency("custom:273"), "met_once");
eq("custom:365 → met once", tierForFrequency("custom:365"), "met_once");

// bimonthly is 60 days, which the day-count rule would call inner_circle. The
// SQL checks the name first and lands on mentors_managers, so this asserts the
// precedence rather than the arithmetic.
eq("a named frequency wins over its day count",
  [tierForFrequency("bimonthly"), tierForFrequency("custom:60")],
  ["mentors_managers", "inner_circle"]);

// Every tier's own default must classify back to itself, or picking a tier and
// reloading the page would show a different one.
group("Each tier's default interval round-trips to that tier");
for (const t of TIER_ORDER) {
  eq(t + " survives the round trip", tierForFrequency(frequencyForTier(t)), t);
}

group("A stored answer beats a derived one");
eq("no stored tier falls back to the interval",
  effectiveTier({ followUpFrequency: "quarterly" }), "mentors_managers");
eq("a stored tier is used as-is",
  effectiveTier({ tier: "inner_circle", followUpFrequency: "quarterly" }), "inner_circle");
eq("a stored tier survives even when it contradicts the interval — the interval "
  + "is the override, so disagreement is expected",
  effectiveTier({ tier: "met_once", followUpFrequency: "weekly" }), "met_once");
eq("an empty contact does not throw", effectiveTier({}), "none");
eq("an absent contact does not throw", effectiveTier(undefined), "none");

group("normalizeContact never invents a tier");
// ORB-57 measures "sit in a tier the user changed from the default". Persisting
// a derived tier would make every contact look deliberately classified and the
// metric unreadable.
eq("a contact with an interval but no tier stays blank",
  normalizeContact({ name: "X", followUpFrequency: "quarterly" }).tier, "");
eq("a chosen tier is kept",
  normalizeContact({ name: "X", tier: "inner_circle" }).tier, "inner_circle");

// ── The picker is gone (ORB-94) ──────────────────────────────────────────────
// Three surfaces asked "what kind of relationship is this?" — the profile, the
// add-connection form and the conversation widget. All three no longer do.
//
// WHAT THESE ARE ACTUALLY GUARDING
//
// Not the absence of a select. The real risk is that removing the question
// leaves something still WRITING an answer: `effectiveTier` derives a tier from
// the interval, and it is one line from being saved as though the user had
// chosen it. That would make ORB-86's future evidence worthless — every contact
// would look deliberately classified — and it is exactly what the old profile
// save did on purpose. So the assertions below are mostly about what does not
// reach the database.

async function renderProfile(contact) {
  resetState();
  state.store.set(contact.id, normalizeContact(contact));
  dom.reconfigure({ url: "https://orbit.test/contact.html?id=" + contact.id });
  document.body.innerHTML = "";
  const el = document.createElement("section");
  el.id = "contactPageContent";
  document.body.appendChild(el);
  await main.initContactPage();
  return el;
}

const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));

const PROFILE = {
  id: "t1", name: "Assaf Karmon", followUpFrequency: "custom:150",
  tier: "professional_network", reminderEnabled: true,
  lastContacted: "2026-08-07", interactions: [], companyHistory: [], followUps: []
};

group("No surface asks for a tier any more");
{
  const r = await renderProfile(PROFILE);
  ok("the profile has no tier select", !r.querySelector("#cpTier"));
  ok("and no tier hint", !r.querySelector("#cpTierHint"));
  ok("but the interval control is still there", r.querySelector("#cpFrequency"));
  ok("and the cadence sentence still is", r.querySelector("#cpCadenceText"));

  document.body.innerHTML = '<div id="w"></div>';
  const w = document.getElementById("w");
  w.innerHTML = main.conversationWidgetHtml();
  ok("the conversation widget has no tier select", !w.querySelector(".cw-tier"));
  ok("it still asks how often", w.querySelector(".cw-freq"));

  document.body.innerHTML = '<div id="a"></div>';
  const a = document.getElementById("a");
  a.innerHTML = main.addConnectionFormHtml([]);
  ok("the add-connection form has no tier select", !a.querySelector(".ac-tier"));
  ok("nor its hint", !a.querySelector(".ac-tier-hint"));
  ok("the cadence result line survives", a.querySelector(".ac-cadence-text"));
}

group("Saving a schedule no longer writes a tier");
{
  // The one that matters. This save used to set `tier: tierSelect.value` on
  // every press, which with the picker gone would mean writing a DERIVED tier
  // as though it were a chosen one.
  const r = await renderProfile(PROFILE);
  r.querySelector("#cpAdjust").click();
  r.querySelector("#cpFrequency").value = "monthly";
  fire(r.querySelector("#cpFrequency"), "change");
  r.querySelector("#cpSaveReminderBtn").click();
  await tick(); await tick();

  const saved = state.saves[state.saves.length - 1];
  eq("the interval is saved", saved.followUpFrequency, "monthly");
  eq("the existing tier is left exactly as it was",
    saved.tier, "professional_network");
  ok("and it is NOT the tier the new interval implies",
    saved.tier !== tierForFrequency("monthly"));
}
{
  // A contact who never had a tier must not acquire one by being edited.
  const r = await renderProfile({ ...PROFILE, id: "t2", tier: "" });
  r.querySelector("#cpSaveReminderBtn").click();
  await tick(); await tick();
  eq("an untiered contact stays untiered", state.saves[state.saves.length - 1].tier, "");
  ok("even though the interval would have implied one",
    tierForFrequency("custom:150") !== "");
}

group("The interval is now the only cadence control, and still behaves");
{
  const r = await renderProfile({
    id: "m1", name: "Chris Rule", followUpFrequency: "quarterly",
    tier: "mentors_managers", reminderEnabled: true,
    lastContacted: "2026-08-07", interactions: [], companyHistory: [], followUps: []
  });
  // effectiveTier still runs — it is how "did someone deliberately override
  // this?" is answered, which is the last job the tier model does on screen.
  ok("an interval matching the tier keeps the control tucked away",
    r.querySelector("#cpFreqGroup").classList.contains("hidden"));
  eq("the result line says what it does",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every 3 months.");
  r.querySelector("#cpAdjust").click();
  ok("Adjust reveals it", !r.querySelector("#cpFreqGroup").classList.contains("hidden"));
}
{
  const r = await renderProfile({
    id: "m2", name: "Seasonal Mentor", followUpFrequency: "custom:60",
    tier: "mentors_managers", reminderEnabled: true,
    lastContacted: "2026-08-07", interactions: [], companyHistory: [], followUps: []
  });
  ok("a deliberate override is never hidden from the person who made it",
    !r.querySelector("#cpFreqGroup").classList.contains("hidden"));
  ok("and neither is the day count",
    !r.querySelector("#cpCustomDaysGroup").classList.contains("hidden"));
  eq("the result line reports the real interval",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every 60 days.");
}
{
  const r = await renderProfile({
    id: "m3", name: "Taylor Smith", followUpFrequency: "quarterly",
    tier: "mentors_managers", reminderEnabled: true,
    lastContacted: "2026-08-07", interactions: [], companyHistory: [], followUps: []
  });
  r.querySelector("#cpAdjust").click();
  const f = r.querySelector("#cpFrequency");
  f.value = "monthly"; fire(f, "change");
  eq("the sentence follows the interval",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every month.");
  f.value = "none"; fire(f, "change");
  eq("opting out reads as a choice, not an empty schedule",
    r.querySelector("#cpCadenceText").textContent, "No reminders — kept on file.");
  f.value = "custom"; fire(f, "change");
  const daysEl = r.querySelector("#cpCustomDays");
  daysEl.value = "60"; fire(daysEl, "input");
  eq("typing a day count restates it live",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every 60 days.");
}

group("Logging a conversation never reclassifies anyone");
{
  resetState();
  const existing = normalizeContact({
    id: "e1", name: "Priya Raman", followUpFrequency: "quarterly",
    tier: "mentors_managers", reminderEnabled: true, interactions: []
  });
  state.store.set(existing.id, existing);

  document.body.innerHTML = '<div id="w"></div>';
  const host = document.getElementById("w");
  host.innerHTML = main.conversationWidgetHtml();
  main.wireConversationWidget(host, () => [existing], async () => {});
  host.querySelector(".cw-name").value = "Priya Raman";
  fire(host.querySelector(".cw-name"), "input");
  host.querySelector(".combo-item")?.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  host.querySelector(".cw-notes").value = "Caught up about the payments team.";
  host.querySelector(".cw-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(); await tick();

  const saved = state.saves[state.saves.length - 1];
  ok("something was saved", saved);
  eq("their tier is untouched", saved.tier, "mentors_managers");
}
{
  // A brand-new person created through the widget arrives with no tier at all,
  // rather than with the default the picker used to pre-select.
  resetState();
  document.body.innerHTML = '<div id="w"></div>';
  const host = document.getElementById("w");
  host.innerHTML = main.conversationWidgetHtml();
  main.wireConversationWidget(host, () => [], async () => {});
  host.querySelector(".cw-name").value = "Brand New";
  host.querySelector(".cw-notes").value = "First coffee.";
  host.querySelector(".cw-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(); await tick();
  eq("a new person carries no tier", state.saves[state.saves.length - 1].tier, "");
}

done();
