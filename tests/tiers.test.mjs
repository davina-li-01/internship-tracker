/**
 * Relationship tiers (ORB-52).
 *
 * The tier is what you pick; the interval is what runs. Everything downstream —
 * health, digest, dashboard — still reads `followUpFrequency`, so the job of
 * these tests is to prove the tier feeds the interval correctly and never
 * quietly becomes a second source of truth.
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

// ── The picker ───────────────────────────────────────────────────────────────

const CONTACT = {
  id: "t1",
  name: "Assaf Karmon",
  email: "assaf@turno.com",
  followUpFrequency: "custom:150",
  reminderEnabled: true,
  lastContacted: "2026-08-07",
  interactions: [],
  companyHistory: [],
  followUps: []
};

resetState();
state.store.set(CONTACT.id, normalizeContact(CONTACT));
dom.reconfigure({ url: "https://orbit.test/contact.html?id=t1" });
document.body.innerHTML = "";
const root = document.createElement("section");
root.id = "contactPageContent";
document.body.appendChild(root);
await main.initContactPage();

const tierSel = () => root.querySelector("#cpTier");
const freqSel = () => root.querySelector("#cpFrequency");
const days = () => root.querySelector("#cpCustomDays");
const hint = () => root.querySelector("#cpTierHint");
const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));

group("The picker asks the answerable question first");
ok("a tier select is rendered", tierSel());
eq("it offers every tier", tierSel().options.length, TIER_ORDER.length);
// custom:150 is 136–272, so the back-fill would call this professional_network.
eq("it shows the tier the interval implies, not a blank",
  tierSel().value, "professional_network");
ok("the tier control comes before the interval control",
  tierSel().compareDocumentPosition(freqSel()) & 4);
ok("a hint explains what the tier means", hint()?.textContent.length > 0);

group("Choosing a tier fills in that tier's interval");
tierSel().value = "inner_circle";
fire(tierSel(), "change");
eq("a named interval is selected directly", freqSel().value, "monthly");
ok("the custom-days box is hidden for a named interval",
  root.querySelector("#cpCustomDaysGroup").classList.contains("hidden"));
ok("the hint follows the tier", /call/i.test(hint().textContent));

tierSel().value = "met_once";
fire(tierSel(), "change");
eq("a tier with no named equivalent switches to custom", freqSel().value, "custom");
eq("and pre-fills the day count", days().value, "365");
ok("with the day box shown",
  !root.querySelector("#cpCustomDaysGroup").classList.contains("hidden"));

group("The interval stays the override");
// Tier said 365; the user overrides to 200 and both are kept. This is the whole
// design — the tier is the answer to a question, not a lock on the schedule.
days().value = "200";
root.querySelector("#cpSaveReminderBtn").click();
await tick(); await tick();

const saved = state.saves[state.saves.length - 1];
eq("the chosen tier is stored", saved.tier, "met_once");
eq("the overridden interval is stored, not the tier default",
  saved.followUpFrequency, "custom:200");
eq("and reminders stay on", saved.reminderEnabled, true);
// The disagreement is intentional and must survive a reload.
eq("reloading shows the chosen tier, not the one the interval implies",
  effectiveTier(saved), "met_once");
eq("while the interval alone would have said otherwise",
  tierForFrequency(saved.followUpFrequency), "professional_network");

// ── The result line and the override ─────────────────────────────────────────
// Two controls side by side read as two questions. The tier is the question;
// the interval is an escape hatch, and it is placed like one.

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

group("A tier whose interval it already implies hides the override");
{
  const r = await renderProfile({
    id: "m1", name: "Chris Rule", followUpFrequency: "quarterly",
    tier: "mentors_managers", reminderEnabled: true,
    lastContacted: "2026-08-07", interactions: [], companyHistory: [], followUps: []
  });
  ok("the interval control starts hidden",
    r.querySelector("#cpFreqGroup").classList.contains("hidden"));
  eq("the result line says what the tier does",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every 3 months.");

  r.querySelector("#cpAdjust").click();
  ok("Adjust reveals it",
    !r.querySelector("#cpFreqGroup").classList.contains("hidden"));
}

group("An interval the tier would not have produced is never hidden");
{
  // Exactly the seasonal case: a close mentor you can only reach twice a year.
  // The tier stays "mentors and managers"; the interval carries the reality.
  const r = await renderProfile({
    id: "m2", name: "Seasonal Mentor", followUpFrequency: "custom:60",
    tier: "mentors_managers", reminderEnabled: true,
    lastContacted: "2026-08-07", interactions: [], companyHistory: [], followUps: []
  });
  ok("the override is visible without clicking Adjust",
    !r.querySelector("#cpFreqGroup").classList.contains("hidden"));
  ok("and so is the day count",
    !r.querySelector("#cpCustomDaysGroup").classList.contains("hidden"));
  eq("the result line reports the real interval, not the tier default",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every 60 days.");
  eq("and the tier is unchanged by the disagreement",
    r.querySelector("#cpTier").value, "mentors_managers");
}

group("The result line follows every change");
{
  const r = await renderProfile({
    id: "m3", name: "Taylor Smith", followUpFrequency: "quarterly",
    tier: "mentors_managers", reminderEnabled: true,
    lastContacted: "2026-08-07", interactions: [], companyHistory: [], followUps: []
  });
  const t = r.querySelector("#cpTier");
  t.value = "inner_circle";
  t.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  eq("changing the tier restates the cadence",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every month.");

  t.value = "none";
  t.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  eq("opting out reads as a choice, not an empty schedule",
    r.querySelector("#cpCadenceText").textContent, "No reminders — kept on file.");

  t.value = "met_once";
  t.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  eq("a custom preset is described in days",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every 365 days.");

  r.querySelector("#cpAdjust").click();
  const daysEl = r.querySelector("#cpCustomDays");
  daysEl.value = "60";
  daysEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  eq("typing a day count restates it live",
    r.querySelector("#cpCadenceText").textContent, "Reaching out every 60 days.");
}

// ── The quick-add widget ─────────────────────────────────────────────────────
// Creating a contact is where "how many days?" is least answerable, so the tier
// has to be here too — a picker that only exists on the profile leaves the
// original problem in place at the one moment it matters most.

function mountWidget() {
  document.body.innerHTML = '<div id="root"></div>';
  const host = document.getElementById("root");
  host.innerHTML = main.conversationWidgetHtml();
  return host;
}
const submit = async (host) => {
  host.querySelector(".cw-form").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(); await tick();
};

group("The widget asks for a tier when creating someone");
{
  resetState();
  const host = mountWidget();
  main.wireConversationWidget(host, () => [], async () => {});
  const t = host.querySelector(".cw-tier");
  ok("a tier select is present", t);
  // Whether monthly is right for someone just met is ORB-51's question; what
  // matters here is that the two controls do not contradict each other on load.
  eq("it agrees with the interval default rather than contradicting it",
    t.value, tierForFrequency(host.querySelector(".cw-freq").value));
}

group("Choosing a tier sets the interval here too");
{
  resetState();
  const host = mountWidget();
  main.wireConversationWidget(host, () => [], async () => {});
  const t = host.querySelector(".cw-tier");
  t.value = "professional_network";
  t.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  eq("switches to custom", host.querySelector(".cw-freq").value, "custom");
  eq("and pre-fills twice-yearly", host.querySelector(".cw-custom-days").value, "180");
}

group("A saved conversation carries the tier");
{
  resetState();
  const host = mountWidget();
  main.wireConversationWidget(host, () => [], async () => {});
  host.querySelector(".cw-name").value = "Hunter Rapoza";
  host.querySelector(".cw-notes").value = "Met at the meetup.";
  const t = host.querySelector(".cw-tier");
  t.value = "met_once";
  t.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await submit(host);

  eq("one contact written", state.saves.length, 1);
  eq("with the chosen tier", state.saves[0].tier, "met_once");
  eq("and the interval that tier implies", state.saves[0].followUpFrequency, "custom:365");
}

group("Logging against an existing person does not reclassify them");
{
  resetState();
  const existing = normalizeContact({
    id: "e1", name: "Chris Rule", email: "chris@x.com", tier: "inner_circle",
    followUpFrequency: "monthly", reminderEnabled: true,
    lastContacted: "2026-08-01", interactions: []
  });
  state.store.set("e1", existing);

  const host = mountWidget();
  main.wireConversationWidget(host, () => [existing], async () => {});
  host.querySelector(".cw-name").value = "Chris Rule";
  host.querySelector(".cw-name").dispatchEvent(
    new dom.window.Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  document.querySelector(".combo-list li")
    ?.dispatchEvent(new dom.window.Event("mousedown", { bubbles: true }));

  eq("their tier is mirrored into the picker",
    host.querySelector(".cw-tier").value, "inner_circle");

  host.querySelector(".cw-notes").value = "Quarterly catch-up.";
  await submit(host);
  eq("and survives the save unchanged", state.saves[0].tier, "inner_circle");
}

done();
