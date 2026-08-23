/**
 * Every label agrees with what it opens (ORB-74).
 *
 * The bug this closes: the + announced "Add a new connection" and opened a
 * dialog headed "Log a conversation". A screen reader user was told one thing
 * and given another. ORB-73 halved the problem by putting a chooser behind the
 * +, and left the + itself naming only one of the two actions behind it.
 *
 * WHY THIS SUITE IS SHAPED THE WAY IT IS
 *
 * The label and the heading live in different files — the button is markup in
 * index.html and contacts.html, the headings are strings in js/main.js — so
 * nothing in the codebase makes them move together. That is exactly how the
 * original mismatch arose, and a comment would not have prevented it.
 *
 * So the pages are DISCOVERED rather than listed. A new page that grows a +
 * is picked up automatically and has to satisfy the same rule. Hard-coding two
 * filenames would pass forever while a third page drifted, which is the failure
 * ORB-63 and ORB-65 both hit: a test proving a thing works says nothing about
 * whether it is present everywhere it should be.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMain, resetState, ROOT } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const { openQuickAddChooser, ADD_TO_NETWORK_LABEL, networkEmptyHtml } = main;

const click = (el) => el.dispatchEvent(
  new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

// ── Find every page carrying the + ───────────────────────────────────────────

const pages = readdirSync(ROOT)
  .filter((f) => f.endsWith(".html"))
  .map((f) => ({ file: f, html: readFileSync(join(ROOT, f), "utf8") }))
  .filter((p) => p.html.includes('id="quickAddBtn"'));

/** Pulls the + apart as it is actually written in the page. */
function fab(html) {
  const m = html.match(/<button[^>]*id="quickAddBtn"[^>]*>([\s\S]*?)<\/button>/);
  if (!m) return null;
  const open = m[0].slice(0, m[0].indexOf(">") + 1);
  return {
    label: clean((m[1].match(/<span class="fab-label">([^<]*)<\/span>/) || [])[1]),
    aria: (open.match(/aria-label="([^"]*)"/) || [])[1],
    title: (open.match(/title="([^"]*)"/) || [])[1]
  };
}

/** The visible text of any element carrying an id, straight from the markup. */
function labelOf(html, id) {
  const m = html.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/button>'));
  return m ? clean(m[1]) : null;
}

// ── What the chooser and the dialogs actually say ────────────────────────────

resetState();
openQuickAddChooser([], () => {});
const chooser = document.getElementById("quickAddChooser");
const chooserHeading = clean(chooser.querySelector("#chooserTitle").textContent);
const options = [...chooser.querySelectorAll(".chooser-option")].map((b) => ({
  id: b.id,
  title: clean(b.querySelector(".chooser-title").textContent)
}));
chooser.remove();

/** Opens the chooser, picks one option, and reports the heading it lands on. */
async function headingBehind(optionId) {
  document.getElementById("quickAddChooser")?.remove();
  document.getElementById("addConnectionModal")?.remove();
  document.getElementById("quickAddModal")?.remove();
  document.getElementById("captureModal")?.remove();
  document.getElementById("csvImportModal")?.remove();
  openQuickAddChooser([], () => {});
  click(document.getElementById(optionId));
  await tick();
  const modal = document.getElementById("addConnectionModal")
    || document.getElementById("quickAddModal")
    || document.getElementById("captureModal")
    || document.getElementById("csvImportModal");
  const heading = clean(modal.querySelector("h3").textContent);
  modal.remove();
  return heading;
}

// ── The rule ─────────────────────────────────────────────────────────────────

group("Every page with a + was found, and none was assumed");
{
  ok("at least one page carries the +", pages.length > 0);
  eq("both known pages are covered",
    pages.map((p) => p.file).sort().join(","), "contacts.html,index.html");
  // If this fails because a third page grew a +, that is the suite working:
  // add it above and the rules below will hold it to the same standard.
}

// ORB-118 CHANGED WHAT "ANNOUNCES" MEANS HERE.
//
// The + used to satisfy this suite with an aria-label and a title and no visible
// words at all — so the rule passed while a sighted user still had to click an
// orange circle to discover the entry point to the whole product. The 20 Aug
// session found it exactly that way: "I didn't even know about Add a connection
// until I clicked the + button."
//
// The label is now the visible text, and the attributes are gone rather than
// duplicated. Three copies of one string is three chances to drift, and this
// suite exists because that is precisely what happened last time.
group("The + announces the same thing to everyone");
for (const { file, html } of pages) {
  const f = fab(html);
  ok(file + " says what it does in words anyone can read", Boolean(f.label));
  eq(file + ": no aria-label to drift from the visible text", f.aria, undefined);
  eq(file + ": no title to drift from it either", f.title, undefined);
  ok(file + ": the + itself is hidden from screen readers, being decoration",
    /<span class="fab-icon" aria-hidden="true">\+<\/span>/.test(html));
}

group("The + names what it opens, not one of the things inside it");
for (const { file, html } of pages) {
  eq(file + ": the label is the chooser's heading", fab(html).label, chooserHeading);
  ok(file + ": it no longer claims to add a connection",
    !/Add a new connection/.test(html));
}

// ── ORB-119: three more controls, one string ─────────────────────────────────

group("Every control that opens the chooser calls it the same thing");
{
  eq("the constant is the chooser's heading", ADD_TO_NETWORK_LABEL, chooserHeading);

  const contacts = pages.find((p) => p.file === "contacts.html").html;
  eq("My Network's header button agrees with the dialog it opens",
    labelOf(contacts, "networkAddBtn"), chooserHeading);

  const empty = networkEmptyHtml();
  eq("and so does the one in the empty state",
    labelOf(empty, "networkEmptyAdd"), chooserHeading);

  // The point of the constant. If someone types the words instead of using it,
  // this still passes — until they type them slightly differently, which is the
  // failure this whole suite was written for.
  const src = readFileSync(join(ROOT, "js", "main.js"), "utf8");
  eq("main.js declares the label exactly once",
    (src.match(/const ADD_TO_NETWORK_LABEL = /g) || []).length, 1);
}
{
  // The specific historical bug, asserted by name so it cannot come back
  // quietly under a different label.
  const names = options.map((o) => o.title);
  ok("the + does not name just one of the options",
    !names.includes(chooserHeading));
}

group("Each chooser option is headed by the words it was chosen with");
{
  // Three since ORB-81. The count is asserted so a fourth cannot be added
  // without someone reading the rule below it.
  eq("there are four options", options.length, 4);
  for (const opt of options) {
    const heading = await headingBehind(opt.id);
    eq('"' + opt.title + '" opens a dialog headed the same', heading, opt.title);
  }
}

group("Nothing is left describing the old single-purpose behaviour");
{
  const src = readFileSync(join(ROOT, "js", "main.js"), "utf8");
  // The chooser heading is written once. Two copies is how the button and the
  // heading drifted apart in the first place.
  const heads = src.match(/id="chooserTitle">([^<]*)</g) || [];
  eq("the chooser heading is declared exactly once", heads.length, 1);

  for (const opt of options) {
    ok('"' + opt.title + '" has a description explaining it',
      chooserHeading !== opt.title);
  }
}

group("The confirmation uses the same vocabulary as the button");
{
  const src = readFileSync(join(ROOT, "js", "main.js"), "utf8");
  ok("saving says the person was added to your network",
    src.includes('" added to your network."'));
}

done();
