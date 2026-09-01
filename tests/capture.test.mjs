/**
 * Catching a thought about someone, in one gesture (ORB-81).
 *
 * WHY
 *
 * Survey 1 asked five students where they were when they realised they had
 * forgotten to follow up with someone. Lying awake (twice). Scrolling LinkedIn.
 * Going through email. Seeing the name somewhere by accident.
 *
 * **Not one of them was inside a system built to tell them, and two were in
 * bed.** A notification at 9am is competing with a thought that arrived at 2am,
 * and losing. So the product has to be reachable at the moment of realisation
 * rather than at the moment it considers convenient.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * 1. **Turning it back into a form.** Every added required field is a reason
 *    the thought does not get written down. The name is the only one, and the
 *    thought itself must stay optional — "Marcus" alone is a complete
 *    intention. The fallback text is asserted, not the emptiness.
 *
 * 2. **A capture that goes nowhere.** The entire value is resurfacing. An open
 *    capture must put its person on Reach out next EVEN WITH NO CADENCE, and
 *    must show the thought as the reason. A note that only lives on the profile
 *    is a note the 2am version of you will never see again.
 *
 * 3. **A capture that never closes.** Reaching out is what it was for. If it
 *    stays open the person stays pinned to the list after the thing is done,
 *    which teaches people to ignore the list.
 *
 * 4. **Collateral damage to manual talking points.** They share the followUps
 *    array. A manual item must NOT pull someone onto the dashboard, and must
 *    NOT be completed by reaching out — it may well survive the conversation.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  normalizeContact, normalizeFollowUpItem, openCaptures, needsAttention,
  captureFormHtml, wireCaptureForm, openCaptureModal, reachOutPromptHtml,
  getHealth, markReachedOut, FOLLOWUP_SOURCES, openQuickAddChooser
} = main;

const person = (over = {}) => normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(5), interactions: [], ...over
});

const capture = (over = {}) => ({ text: "Ask about the payments move", source: "capture", ...over });

const tick = () => new Promise((r) => setTimeout(r, 20));

// `went` collects where the form tried to send you. Navigation is injected
// rather than read off window.location, which jsdom will not let anyone
// redefine — the same seam ORB-108 cut for mailto.
let went = [];
function mount(contacts) {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById("host");
  host.innerHTML = captureFormHtml(contacts);
  went = [];
  wireCaptureForm(host, () => contacts, async () => {}, {
    navigate: (url) => went.push(url)
  });
  return { host, $: (sel) => host.querySelector(sel) };
}

const submit = (host) => {
  host.querySelector(".capture-form")
    .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  return tick();
};

// ── The model ─────────────────────────────────────────────────────────────────
group("A capture is a follow-up with a provenance, not a second list");
{
  eq("three sources, no more", FOLLOWUP_SOURCES.sort().join(","), "ai,capture,manual");
  eq("capture is preserved", normalizeFollowUpItem({ source: "capture" }).source, "capture");
  eq("manual is still the default", normalizeFollowUpItem({}).source, "manual");
  eq("an unknown source falls back rather than persisting",
    normalizeFollowUpItem({ source: "smuggled" }).source, "manual");
}
{
  const c = person({ followUps: [
    capture({ id: "a", createdAt: "2026-08-01T00:00:00Z" }),
    capture({ id: "b", createdAt: "2026-08-10T00:00:00Z" }),
    capture({ id: "done", completed: true, createdAt: "2026-08-12T00:00:00Z" }),
    { id: "m", text: "Manual point", source: "manual" }
  ] });
  eq("only open captures count", openCaptures(c).map((f) => f.id), ["b", "a"]);
  eq("newest first", openCaptures(c)[0].id, "b");
  eq("nothing captured means nothing open", openCaptures(person()).length, 0);
}

// ── Resurfacing ───────────────────────────────────────────────────────────────
group("An open capture is a reason to appear, on its own");
{
  // The one that matters. This person is in touch and would never otherwise be
  // on the list.
  const c = person({ followUps: [capture()] });
  eq("someone in touch is pulled onto the list by a note", needsAttention([c]).length, 1);
}
{
  const c = person({
    followUpFrequency: "none", reminderEnabled: false, followUps: [capture()]
  });
  eq("even with no schedule at all — you did not write it down for a timer",
    needsAttention([c]).length, 1);
}
{
  const noted = person({ id: "noted", name: "Noted", lastContacted: daysAgo(2), followUps: [capture()] });
  const starred = person({ id: "star", name: "Starred", lastContacted: daysAgo(200), starred: true });
  const late = person({ id: "late", name: "Late", lastContacted: daysAgo(400) });
  eq("a note outranks a star, and a star outranks the clock",
    needsAttention([late, starred, noted]).map((x) => x.contact.name),
    ["Noted", "Starred", "Late"]);
}
{
  const c = person({ followUps: [capture({ completed: true })] });
  eq("a completed capture stops pulling them in", needsAttention([c]).length, 0);
}
{
  // Collateral damage check. Manual talking points share the array.
  const c = person({ followUps: [{ text: "Ask about the team", source: "manual" }] });
  eq("a manual talking point does not put anyone on the dashboard",
    needsAttention([c]).length, 0);
}

group("The prompt leads with the thought, because that is why they are there");
{
  const c = person({ followUps: [capture()] });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("the note is shown", /Ask about the payments move/.test(html));
  ok("and attributed to the user, not to Orbit", /You noted/.test(html));
  ok("it comes before the elapsed time",
    html.indexOf("prompt-capture") < html.indexOf("prompt-line"));
  ok("the elapsed time is still there", /You last spoke to Marcus/.test(html));
}
{
  const c = person({ followUps: [
    capture({ id: "old", text: "Older thought", createdAt: "2026-08-01T00:00:00Z" }),
    capture({ id: "new", text: "Newer thought", createdAt: "2026-08-12T00:00:00Z" })
  ] });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("only the newest is shown — a stack of them is a to-do list", !/Older thought/.test(html));
  ok("and it is the newest", /Newer thought/.test(html));
}
{
  ok("no note means no tag at all", !/prompt-capture/.test(reachOutPromptHtml(person(), getHealth(person()))));
}
{
  const c = person({ followUps: [capture({ text: '<img src=x onerror=alert(1)>' })] });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("a captured thought is escaped like every other user string", !/<img/.test(html));
  ok("and it was escaped, not dropped", /&lt;img/.test(html));
}

// ── Closing the loop ──────────────────────────────────────────────────────────
group("Reaching out closes what the note was for");
{
  resetState();
  const c = person({ followUps: [
    capture({ id: "cap" }),
    { id: "man", text: "Manual point", source: "manual" }
  ] });
  state.store.set(c.id, c);
  await markReachedOut(c, async () => {});
  const after = state.store.get("c1");
  eq("the capture is completed", after.followUps.find((f) => f.id === "cap").completed, true);
  eq("the manual point is untouched — it may outlive the conversation",
    after.followUps.find((f) => f.id === "man").completed, false);
  eq("and they drop off the list", needsAttention([after]).length, 0);
}
{
  resetState();
  const c = person({ followUps: [capture({ id: "cap" })] });
  state.store.set(c.id, c);
  await markReachedOut(c, async () => {});
  document.querySelector(".toast .toast-action").click();
  await tick();
  eq("Undo reopens it, so the thought is not lost by a misclick",
    state.store.get("c1").followUps.find((f) => f.id === "cap").completed, false);
}

// ── The gesture ───────────────────────────────────────────────────────────────
group("One required field, and it is the first thing you type");
{
  const { $ } = mount([person()]);
  ok("there is a who field", $(".capture-who"));
  ok("and a thought field", $(".capture-thought"));
  ok("the thought says it is optional", /optional/i.test($(".capture-thought").placeholder));
  ok("neither is marked required", ![...$(".capture-form").querySelectorAll("[required]")].length);
}
{
  resetState();
  const marcus = person();
  const { host, $ } = mount([marcus]);
  $(".capture-who").value = "Marcus Chen";
  await submit(host);
  const saved = state.saves[state.saves.length - 1];
  ok("a name on its own saves", saved);
  eq("as a capture", saved.followUps[0].source, "capture");
  // First name, matching every other prompt in the app: "Marcus" is who you
  // owe a message and "Marcus Chen" is a database row (ORB-78).
  eq("with a sentence written for you rather than a blank",
    saved.followUps[0].text, "Reach out to Marcus");
  eq("and it is open", saved.followUps[0].completed, false);
}
{
  resetState();
  const { host, $ } = mount([person()]);
  $(".capture-who").value = "marcus chen";
  $(".capture-thought").value = "Congratulate him on the move";
  await submit(host);
  const saved = state.saves[state.saves.length - 1];
  eq("the name match is case-insensitive, because it is 2am", saved.id, "c1");
  eq("the thought is stored as typed", saved.followUps[0].text, "Congratulate him on the move");
  eq("the form empties for the next one", $(".capture-who").value, "");
  eq("both fields", $(".capture-thought").value, "");
  const toast = document.querySelector(".toast")?.textContent || "";
  ok("and it is confirmed by name", /Marcus/.test(toast));
  // ORB-105. It used to end "it is on your list", which is the reported problem
  // stated as a reassurance: there are several lists and it named none of them.
  // Four of the twenty-two findings were people not knowing where the thought
  // went, so the confirmation now says the section by its heading.
  ok("and the confirmation says which list, by the name on the screen",
    /Things to bring up next/.test(toast));
}
{
  resetState();
  const existing = person({ followUps: [{ id: "m", text: "Old point", source: "manual" }] });
  const { host, $ } = mount([existing]);
  $(".capture-who").value = "Marcus Chen";
  await submit(host);
  const saved = state.saves[state.saves.length - 1];
  eq("the new note goes on top", saved.followUps[0].source, "capture");
  eq("and nothing already there is lost", saved.followUps.length, 2);
}
{
  resetState();
  const { host, $ } = mount([person()]);
  await submit(host);
  eq("an empty form saves nothing", state.saves.length, 0);
  ok("and says what is missing", /Who is this about/.test($(".capture-error").textContent));
}
{
  // ORB-129 REVERSED THIS. It used to refuse — "No one in your network by that
  // name yet" — so a thought about anybody not already saved had nowhere to go,
  // which is the opposite of what a capture is for. The name becomes a
  // connection and you land on their profile to say who they are.
  resetState();
  const { host, $ } = mount([person()]);
  $(".capture-who").value = "Someone Unknown";
  await submit(host);
  eq("a stranger is saved rather than refused", state.saves.length, 1);
  eq("under the name as typed", state.saves[0].name, "Someone Unknown");
  eq("carrying the thought", state.saves[0].followUps[0].source, "capture");
  eq("and nothing is refused", $(".capture-error").textContent, "");
  eq("and you are taken there to fill them in",
    went[0], "contact.html?id=" + state.saves[0].id);
}
{
  resetState();
  state.failSave = true;
  const { host, $ } = mount([person()]);
  $(".capture-who").value = "Marcus Chen";
  $(".capture-thought").value = "Do not lose this";
  await submit(host);
  ok("a refused save says so", /Could not save/.test($(".capture-error").textContent));
  eq("and the thought is still on screen to retry", $(".capture-thought").value, "Do not lose this");
  state.failSave = false;
}

group("The name field suggests, and Enter on a suggestion picks rather than saves");
{
  resetState();
  const { host, $ } = mount([person(), person({ id: "c2", name: "Marcus Aurelius" })]);
  const who = $(".capture-who");
  who.value = "marc";
  who.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const items = host.querySelectorAll(".combo-item");
  eq("both Marcuses are offered", items.length, 2);

  who.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  who.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  eq("Enter fills the name instead of saving a half-typed one", who.value, "Marcus Chen");
  eq("nothing was saved yet", state.saves.length, 0);

  await submit(host);
  eq("and the next Enter saves against the chosen person",
    state.saves[state.saves.length - 1].id, "c1");
}

group("It is reachable from the + on every page");
{
  document.getElementById("quickAddChooser")?.remove();
  openQuickAddChooser([person()], () => {});
  const opts = [...document.querySelectorAll(".chooser-option")];
  eq("four ways in", opts.length, 4);
  const capture = opts.find((o) => /note to self/i.test(o.textContent));
  ok("catching a thought is one of them", capture);
  capture.click();
  ok("and it opens the capture, not a form", document.getElementById("captureModal"));
  ok("headed by the words it was chosen with",
    /Note to self about someone/.test(document.querySelector("#captureModal h3").textContent));
  document.getElementById("captureModal").remove();
}

done();
