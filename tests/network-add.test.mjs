/**
 * The action lives where the intent is (ORB-119).
 *
 * From the 20 Aug usability session: "I didn't even know about Add a connection
 * until I clicked on the + button." My Network is the page you open when you
 * want to add somebody, and it was the one page with no visible way to do it.
 * Its empty state — the first screen every new account sees — said "Nobody in
 * your network yet." and then offered nothing at all. A statement of fact where
 * an action belongs.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * Not the buttons existing. `labels.test.mjs` already holds the words. This
 * holds the wiring, and specifically the thing that would be easy to get wrong:
 * a new button that opens its own add form instead of the shared chooser. There
 * are four ways into adding a contact and they became hard to reason about at
 * three, so every one of them has to end up in the same dialog with the same
 * options — including the spreadsheet route, which is the whole reason the
 * empty state mentions one.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const { initMyNetwork, normalizeContact, networkEmptyHtml } = main;

const click = (el) => el.dispatchEvent(
  new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));

const PERSON = normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(5),
  interactions: [{ id: "i1", date: daysAgo(5), type: "coffee chat", notes: "Hi" }]
});

/** Mounts contacts.html's shape, not an approximation of it. */
async function mount(people = []) {
  resetState();
  for (const p of people) state.store.set(p.id, p);
  document.getElementById("quickAddChooser")?.remove();
  document.body.innerHTML =
    '<div class="page-header page-header-actions">'
    + '<button id="networkAddBtn" type="button">Add to your network</button>'
    + '</div>'
    + '<div id="networkFilterBar"></div>'
    + '<ul id="myNetworkList" class="person-list"></ul>';
  await initMyNetwork();
  await tick();
  return {
    list: document.getElementById("myNetworkList"),
    addBtn: document.getElementById("networkAddBtn")
  };
}

const chooser = () => document.getElementById("quickAddChooser");

// ── The header button ────────────────────────────────────────────────────────

group("My Network can add someone from the page itself");
{
  const { addBtn } = await mount([PERSON]);
  ok("the header carries the action", Boolean(addBtn));
  click(addBtn);
  await tick();
  ok("and it opens the shared chooser", Boolean(chooser()));
  eq("with every route, not a private add form",
    chooser().querySelectorAll(".chooser-option").length, 4);
  ok("including the spreadsheet one",
    Boolean(chooser().querySelector("#chooseImport")));
  chooser().remove();
}
{
  // The failure that would look fine: wiring the button to an empty list rather
  // than the loaded one. Every dialog would still open, and every one of them
  // would behave as though the network were empty. "Note to self" is the probe
  // because it renders the people it was handed straight into its markup.
  const { addBtn } = await mount([PERSON]);
  click(addBtn);
  await tick();
  click(chooser().querySelector("#chooseCapture"));
  await tick();
  const modal = document.getElementById("captureModal");
  const who = modal.querySelector(".capture-who");
  who.value = "Mar";
  who.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await tick();
  ok("the people already in the network came with it",
    /Marcus Chen/.test(modal.querySelector(".capture-list").textContent));
  modal.remove();
}

// ── The empty state ──────────────────────────────────────────────────────────

group("An empty network is a starting point, not a dead end");
{
  const { list } = await mount([]);
  const btn = list.querySelector("#networkEmptyAdd");
  ok("it still says the network is empty",
    /Nobody in your network yet/.test(list.textContent));
  ok("but it offers a way out of that", Boolean(btn));
  ok("and names the spreadsheet route, which nothing else announces",
    /CSV|spreadsheet/i.test(list.textContent));

  click(btn);
  await tick();
  ok("the empty-state button opens the same chooser", Boolean(chooser()));
  eq("with the same four routes",
    chooser().querySelectorAll(".chooser-option").length, 4);
  chooser().remove();
}
{
  // Filters matching nobody is a different nothing, fixed by changing the
  // filters. Offering "add someone" there answers a question nobody asked.
  const { list } = await mount([PERSON]);
  const search = document.querySelector("#networkFilterBar input");
  search.value = "zzzzz";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await tick(); await tick();

  ok("it says the filters matched nobody",
    /Nobody matches those filters/.test(list.textContent));
  eq("and does not offer to add a contact",
    list.querySelector("#networkEmptyAdd"), null);
}

// ── The markup itself ────────────────────────────────────────────────────────

group("The empty state is written once and reused");
{
  const html = networkEmptyHtml();
  ok("it is a real action, not text dressed as one",
    /<button[^>]*id="networkEmptyAdd"/.test(html));
  ok("the title is a statement, and the help line is separate from it",
    /network-empty-title/.test(html) && /tiny muted/.test(html));
}

done();
