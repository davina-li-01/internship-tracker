/**
 * A spreadsheet can say when you last spoke (ORB-103), and a file can be the
 * notes (ORB-102).
 *
 * ORB-103 — WHY
 *
 * Davina, on importing a sheet: *"sometimes they add in the dates, and if the
 * dates are pretty recent they shouldn't be considered overdue either."*
 *
 * Orbit could be told two things about a person's history — when you met them,
 * and what you wrote up. Neither is *when did we last speak*. So everyone
 * arriving from a file landed in the same undifferentiated state, and the app
 * was wrong in both directions at once: insulting about the person you spoke to
 * last week, and silent about the one you last spoke to in 2023. An import read
 * as one flat grey.
 *
 * This is NOT a hole in ORB-73's rule. That rule says adding someone does not
 * invent a conversation, and nothing here invents one — no interaction, no
 * notes. It records a date the user supplied, which is the difference between
 * a fact and an inference.
 *
 * Two bugs are fixed with it, both shipped hours earlier in ORB-98:
 *
 *   1. A column called "Last Contacted" was imported as a SURNAME. "last
 *      contacted" contains "last", and the partial-matching pass took it.
 *   2. There was nowhere for the value to go even once matched.
 *
 * ORB-102 — WHY
 *
 * ORB-20 made PDFs attachable and a conversation carrying only a deck still
 * rendered "no notes" — which reads as a conversation you failed to write up
 * rather than one you documented by handing over the document.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  guessColumnMap, csvRowsToContacts, normalizeContact, getHealth, bandWords,
  firstDeadlineFor, csvImportFormHtml, wireCsvImport, needsAttention,
  conversationHeadline, renderInteractionTimeline, conversationPreview,
  normalizeInteraction, CSV_FIELDS
} = main;

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ── ORB-103, the mapping bug ──────────────────────────────────────────────────
group("A date column is never mistaken for a surname");
{
  const m = guessColumnMap(["Name", "Company", "Last Contacted", "Date Met"]);
  eq("the bug, asserted by name: it is not a last name", m.last, undefined);
  eq("it is when you last spoke", m.lastContacted, 2);
  eq("and when you met is untouched", m.dateMet, 3);
}
{
  for (const header of ["Last Spoke", "Last Contact", "Last Message",
                        "Last Activity", "Last Touch", "Last Outreach"]) {
    const m = guessColumnMap(["Name", header]);
    eq('"' + header + '" is a date', m.lastContacted, 1);
    eq("and not a surname", m.last, undefined);
  }
}
{
  // The guard must not overreach: a column that really is a surname still is.
  const m = guessColumnMap(["First Name", "Last Name"]);
  eq("a real surname column still maps", m.last, 1);
  eq("and so does the first name", m.first, 0);
}
{
  const m = guessColumnMap(["First", "Last"]);
  eq("an exact match beats the guard — a column called Last IS a surname", m.last, 1);
}

// ── ORB-103, the missing field ────────────────────────────────────────────────
group("The date the file supplies is the date the app uses");
{
  ok("there is a field for it at all",
    CSV_FIELDS.some((f) => f.key === "lastContacted"));
}
{
  const headers = ["Name", "Last Contacted"];
  const [p] = csvRowsToContacts(headers, [["Marcus Chen", "2026-08-16"]],
    guessColumnMap(headers));
  eq("it survives into the contact", p.lastContacted, "2026-08-16");
  eq("with no conversation invented alongside it", p.interactions.length, 0);
}
{
  const headers = ["Name", "Last Contacted"];
  const [p] = csvRowsToContacts(headers, [["Marcus Chen", "sometime last spring"]],
    guessColumnMap(headers));
  eq("an unreadable date is nothing, never today", p.lastContacted, "");
}

group("Recent reads as current; dormant reads as dormant");
{
  // The whole point. Same import, two dates, two honest answers.
  const build = (last) => {
    const headers = ["Name", "Last Contacted"];
    const [p] = csvRowsToContacts(headers, [["Marcus Chen", last]],
      guessColumnMap(headers), { frequency: "monthly" });
    const c = normalizeContact(p);
    c.lastContacted = p.lastContacted || "";
    c.nextReminder = firstDeadlineFor(c.lastContacted, "monthly");
    return c;
  };
  eq("spoke three days ago", bandWords(getHealth(build(daysAgo(3)))).label, "In touch");
  ok("spoke two years ago is not 'not contacted yet'",
    bandWords(getHealth(build(daysAgo(730)))).label !== "Not contacted yet");
  // firstDeadlineFor grants the grace window when the cadence is already blown,
  // so a stale contact gets a week to make the first reach-out rather than
  // arriving as a failure on the day they are imported.
  ok("and is not overdue on arrival either",
    getHealth(build(daysAgo(730))).band !== "critical");
}
{
  const headers = ["Name"];
  const [p] = csvRowsToContacts(headers, [["Marcus Chen"]], { name: 0 });
  const c = normalizeContact(p);
  c.lastContacted = p.lastContacted || "";
  eq("a file that says nothing still says nothing", c.lastContacted, "");
  // ORB-75 still owns this state and outranks the band's own words, which is
  // why it reads as a beginning rather than "No schedule".
  eq("and ORB-75's wording still applies",
    bandWords(getHealth(c)).label, "Not contacted yet");
}

// ── ORB-103, end to end ───────────────────────────────────────────────────────
function mount(existing = []) {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById("host");
  host.innerHTML = csvImportFormHtml();
  wireCsvImport(host, () => existing, async () => {});
  return { host, $: (s) => host.querySelector(s) };
}
async function load(host, text) {
  const input = host.querySelector(".csv-file");
  Object.defineProperty(input, "files", {
    value: [new dom.window.File([text], "c.csv", { type: "text/csv" })], configurable: true });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await tick();
}

const SHEET = "Name,Company,Last Contacted\n"
  + "Recent Person,Stripe," + daysAgo(3) + "\n"
  + "Dormant Person,Ramp," + daysAgo(730) + "\n";

group("Importing a sheet with dates");
{
  resetState();
  const { host, $ } = mount();
  await load(host, SHEET);
  ok("the preview shows what it read, because this is the field most costly to mis-map",
    /last spoke 3 days ago/.test($(".csv-preview").textContent));
  ok("for the dormant one too", /last spoke 2 years ago/.test($(".csv-preview").textContent));
  ok("and neither is claimed as a surname", !/Stripe.*730|2 years.*surname/.test($(".csv-preview").textContent));
}
{
  resetState();
  const { host, $ } = mount();
  await load(host, SHEET);
  $(".csv-freq").value = "monthly";
  $(".csv-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(80);

  const saved = [...state.store.values()];
  eq("both landed", saved.length, 2);
  const recent = saved.find((c) => c.name === "Recent Person");
  const dormant = saved.find((c) => c.name === "Dormant Person");
  eq("the recent date was kept", recent.lastContacted, daysAgo(3));
  eq("the dormant one too", dormant.lastContacted, daysAgo(730));
  eq("someone you spoke to this week is current", bandWords(getHealth(recent)).label, "In touch");
  ok("and is not on the reach-out list", !needsAttention(saved).some((x) => x.contact.name === "Recent Person"));
  ok("neither of them invented a conversation", saved.every((c) => c.interactions.length === 0));
  ok("nobody reads as never contacted",
    saved.every((c) => bandWords(getHealth(c)).label !== "Not contacted yet"));
}
{
  resetState();
  const { host, $ } = mount();
  await load(host, "Name,Company\nNo Dates,Stripe\n");
  $(".csv-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(80);
  eq("a sheet with no dates still imports clean",
    [...state.store.values()][0].lastContacted, "");
}

// ── ORB-102 ───────────────────────────────────────────────────────────────────
group("A file can be what the conversation is called");
{
  const item = normalizeInteraction({ date: daysAgo(3), type: "meeting", fileIds: ["f1"] });
  const files = [{ id: "f1", name: "Marcus - deck.pdf" }];
  eq("with nothing written, the file names it",
    conversationHeadline(item, files), "Marcus - deck.pdf");
}
{
  const item = normalizeInteraction({ date: daysAgo(3), notes: "We talked about pricing.", fileIds: ["f1"] });
  eq("but words you wrote always win — a file is a fallback, not a promotion",
    conversationHeadline(item, [{ id: "f1", name: "deck.pdf" }]), "We talked about pricing.");
}
{
  const item = normalizeInteraction({ date: daysAgo(3), title: "Coffee with Marcus", fileIds: ["f1"] });
  eq("and so does the meeting name",
    conversationHeadline(item, [{ id: "f1", name: "deck.pdf" }]), "Coffee with Marcus");
}
{
  eq("nothing at all is still nothing",
    conversationHeadline(normalizeInteraction({ date: daysAgo(3) }), []), "");
  eq("and a file that no longer resolves does not invent a name",
    conversationHeadline(normalizeInteraction({ date: daysAgo(3), fileIds: ["gone"] }), []), "");
}
{
  const html = renderInteractionTimeline(
    [normalizeInteraction({ id: "i1", date: daysAgo(3), type: "meeting", fileIds: ["f1"] })],
    [{ id: "f1", name: "Marcus - deck.pdf" }], { name: "Marcus Chen" });
  ok("the timeline names the file", /Marcus - deck\.pdf/.test(html));
  ok("instead of calling it empty", !/no notes/.test(html));
}
{
  const html = renderInteractionTimeline(
    [normalizeInteraction({ id: "i1", date: daysAgo(3), type: "meeting" })],
    [], { name: "Marcus Chen" });
  ok("a conversation with genuinely nothing in it still says so", /no notes/.test(html));
}
{
  const c = normalizeContact({
    id: "c1", name: "Marcus Chen",
    interactions: [{ id: "i1", date: daysAgo(3), type: "meeting", fileIds: ["f1"] }]
  });
  const html = conversationPreview(c);
  ok("the log row stops rendering a conversation that exists as nothing",
    html.length > 0);
  ok("and flags the attachment", /📎/.test(html));
}
{
  const item = normalizeInteraction({ date: daysAgo(3), fileIds: ["f1"] });
  const html = renderInteractionTimeline([item],
    [{ id: "f1", name: '<img src=x onerror=alert(1)>.pdf' }], { name: "X" });
  ok("a file name is other people's text too", !/<img/.test(html));
  ok("and it was escaped", /&lt;img/.test(html));
}

done();
