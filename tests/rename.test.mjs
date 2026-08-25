/**
 * Editing a name saves the name (ORB-127).
 *
 * REPORTED: "there's a bug rn when i edit someones name it doesnt save."
 *
 * THE CAUSE, AND IT IS THE SAME ONE TWICE
 *
 * The name input saved itself on `blur`, independently of the form it sits in.
 * Pressing Save blurs the input first, so two writes started in a row:
 *
 *   1. blur      -> read the contact, write it back with the new name
 *   2. click Save -> read the contact (usually before step 1's write landed),
 *                    write the whole form back over it — name included, from
 *                    stale state
 *
 * Last write wins, the last write held the old name, and nothing errored. The
 * fix is the one already written in this file for the primary email: the form
 * owns the whole record, so it owns the name too. One writer, one read.
 *
 * WHY THE MAIN TEST DOES NOT SIMULATE THE RACE
 *
 * It does not need to. Under the old code, clicking Save without a blur lost
 * the name outright — the only thing that ever wrote it was a handler that had
 * not run. So the plain "type it, press Save" case is a real regression test
 * and does not depend on which of two promises resolves first. The browser's
 * actual blur-then-click order is asserted separately below.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const { normalizeContact, initContactPage } = main;

const click = (el) => el.dispatchEvent(
  new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { await tick(); await tick(); await tick(); };

const PERSON = {
  id: "c1", name: "Hunter Reposa", role: "Copywriter", company: "IQ360",
  followUpFrequency: "monthly", reminderEnabled: true, lastContacted: daysAgo(10),
  emails: [{ label: "personal", address: "hunter@example.com" }],
  interactions: [], companyHistory: [], followUps: []
};

/** The profile, already in edit mode. */
async function editing(over = {}) {
  resetState();
  const c = normalizeContact({ ...PERSON, ...over });
  state.store.set(c.id, c);
  dom.reconfigure({ url: "https://orbit.test/contact.html?id=c1" });
  document.body.innerHTML = "";
  const root = document.createElement("section");
  root.id = "contactPageContent";
  document.body.appendChild(root);
  await initContactPage();
  click(root.querySelector("#cpEditBtn"));
  await settle();
  return root;
}

const stored = () => state.store.get("c1");

// ── The reported bug ─────────────────────────────────────────────────────────

group("Typing a name and pressing Save saves the name");
{
  const root = await editing();
  const input = root.querySelector("#cpNameInput");
  ok("the name is editable in place", Boolean(input));
  eq("and starts as what it was", input.value, "Hunter Reposa");

  input.value = "Hunter Rapoza";
  click(root.querySelector("#cpSaveDetailsBtn"));
  await settle();

  eq("the new name is what is stored", stored().name, "Hunter Rapoza");
  ok("and the page shows it", /Hunter Rapoza/.test(root.textContent));
}
{
  // The browser's real order: mousedown blurs the input, then click fires. This
  // is the sequence that produced the race, so it is asserted as it happens
  // rather than as it is convenient — no await between the two.
  const root = await editing();
  const input = root.querySelector("#cpNameInput");
  input.value = "Hunter Rapoza";
  fire(input, "blur");
  click(root.querySelector("#cpSaveDetailsBtn"));
  await settle();
  eq("blur then click still lands on the new name", stored().name, "Hunter Rapoza");
}
{
  // The rest of the form must survive a rename, and the rename must survive the
  // rest of the form. One write, so neither can clobber the other.
  const root = await editing();
  root.querySelector("#cpNameInput").value = "Hunter Rapoza";
  root.querySelector("#cpRole").value = "Senior account manager";
  click(root.querySelector("#cpSaveDetailsBtn"));
  await settle();
  eq("the name saved", stored().name, "Hunter Rapoza");
  eq("and so did the field beside it", stored().role, "Senior account manager");
  eq("and nothing else moved", stored().company, "IQ360");
}

// ── The edges around it ──────────────────────────────────────────────────────

group("Cancel discards a name like it discards everything else");
{
  const root = await editing();
  root.querySelector("#cpNameInput").value = "Typed and thought better of";
  click(root.querySelector("#cpCancelEdit"));
  await settle();
  eq("the stored name is untouched", stored().name, "Hunter Reposa");
  ok("and the page shows the real one", /Hunter Reposa/.test(root.textContent));
}

group("An empty name is refused out loud");
{
  const root = await editing();
  root.querySelector("#cpNameInput").value = "   ";
  click(root.querySelector("#cpSaveDetailsBtn"));
  await settle();

  eq("nothing is saved", stored().name, "Hunter Reposa");
  const msg = root.querySelector("#cpSaveDetailsMsg");
  ok("and it says why", /name is the one thing required/i.test(msg.textContent));
  // Silently restoring the old name is indistinguishable from the bug this
  // replaces, which is the whole reason it is said out loud.
  eq("as an error, not a success", msg.className, "error");
  ok("the form stays open to fix it", Boolean(root.querySelector("#cpNameInput")));
}

group("A field that saves on its own does not wipe the name");
{
  // Email rows commit on `change` without touching Save, and that write goes
  // through the same applyDetails. It must carry the name currently typed, not
  // an empty string, and not an older one.
  const root = await editing();
  root.querySelector("#cpNameInput").value = "Hunter Rapoza";
  const addr = root.querySelector(".email-address");
  addr.value = "hunter@iq360.com";
  fire(addr, "change");
  await settle();

  eq("the email committed", stored().emails[0].address, "hunter@iq360.com");
  eq("and took the typed name with it", stored().name, "Hunter Rapoza");
}

done();
