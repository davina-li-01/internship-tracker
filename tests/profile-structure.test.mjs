/**
 * The contact profile's DOM shape.
 *
 * WHY THIS SUITE EXISTS
 *
 * The profile is built by concatenating strings, and one `</div>` went missing
 * when the view/edit split landed. Nothing threw. The tests passed. The page
 * rendered — into a shape where `.reachout-strip` was a CHILD of
 * `.profile-identity` instead of a sibling. `.profile-identity` is a flex ROW,
 * so the whole reach-out panel lined up beside the name and squeezed the detail
 * grid into about 190px, where the labels overlapped each other. Every card
 * below it ended up nested inside the hero card too.
 *
 * A missing close tag is invisible to unit tests of pure functions and to the
 * browser, which silently repairs it. The only thing that catches it is asking
 * the parsed DOM what contains what — so that is what this does.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const dom = globalThis.__dom;

const CONTACT = {
  id: "c1",
  name: "Assaf Karmon",
  email: "assaf@turno.com",
  emails: [
    { label: "work", address: "assaf@turno.com" },
    { label: "personal", address: "assaf.k@gmail.com" }
  ],
  company: "Turno",
  role: "CEO",
  industry: "",
  dateMet: "2026-02-01",
  lastContacted: "2026-08-07",
  followUpFrequency: "custom:150",
  notes: "",
  adviceGiven: "",
  interests: "",
  reminderEnabled: true,
  nextReminder: "2027-01-04",
  interactions: [],
  companyHistory: ["Turno", "Ramp"],
  followUps: []
};

resetState();
state.store.set(CONTACT.id, CONTACT);

dom.reconfigure({ url: "https://orbit.test/contact.html?id=c1" });
const root = document.createElement("section");
root.id = "contactPageContent";
document.body.appendChild(root);

await main.initContactPage();

const hero = root.querySelector(".profile-hero");
const identity = root.querySelector(".profile-identity");
const strip = root.querySelector(".reachout-strip");

group("The hero closes where it should");
ok("the hero card exists", hero);
eq("the reach-out strip is a child of the hero", strip?.parentElement === hero, true);
// The failure mode, stated directly. .profile-identity is a flex row; anything
// inside it lands beside the name rather than beneath it.
eq("the reach-out strip is NOT inside the identity block",
  identity?.contains(strip), false);
eq("the identity block holds only the avatar and the text column",
  [...identity.children].map((el) => el.className),
  ["profile-avatar", "profile-id-text"]);

group("The cards below the hero are siblings of it, not children");
for (const sel of [".profile-body", ".danger-zone", ".profile-timeline"]) {
  const el = root.querySelector(sel);
  ok(sel + " exists", el);
  eq(sel + " is outside the hero card", hero.contains(el), false);
}
// A card nested in a card is the visible symptom: doubled padding, doubled
// border, and a "danger zone" that looks like part of someone's profile.
eq("no card is nested inside another card",
  [...root.querySelectorAll(".card .card")].length, 0);

group("Every div that opens, closes");
// Re-parsing the generated string and re-serialising it is the check: if a tag
// is missing, the browser's repair shows up as a difference in tag count.
const opens = (root.innerHTML.match(/<div\b/g) || []).length;
const closes = (root.innerHTML.match(/<\/div>/g) || []).length;
eq("open and close div tags balance", opens, closes);

group("View mode is the default");
ok("the name is a heading, not an input", root.querySelector("h1.profile-name"));
ok("there is no name input", !root.querySelector("#cpNameInput"));
ok("an Edit button is offered", root.querySelector("#cpEditBtn"));
ok("no details editor is rendered", !root.querySelector("#cpRole"));

group("Every address on file is shown");
const shown = [...root.querySelectorAll(".view-emails a")].map((a) => a.textContent);
eq("both addresses are listed", shown, ["assaf@turno.com", "assaf.k@gmail.com"]);
eq("each carries its label",
  [...root.querySelectorAll(".view-emails .email-label")].map((e) => e.textContent),
  ["work", "personal"]);
eq("and each is a mailto link",
  [...root.querySelectorAll(".view-emails a")].every((a) => a.getAttribute("href").startsWith("mailto:")),
  true);

group("Edit mode keeps the same shape");
root.querySelector("#cpEditBtn").click();
await new Promise((r) => setTimeout(r, 20));

const heroEdit = root.querySelector(".profile-hero");
eq("the strip is still a sibling of the identity block",
  root.querySelector(".reachout-strip").parentElement === heroEdit, true);
eq("open and close div tags still balance",
  (root.innerHTML.match(/<div\b/g) || []).length,
  (root.innerHTML.match(/<\/div>/g) || []).length);
ok("the name is now an input", root.querySelector("#cpNameInput"));
ok("no heading is left behind", !root.querySelector("h1.profile-name"));
eq("every address is editable",
  [...root.querySelectorAll("#cpEmailList .email-address")].map((i) => i.value),
  ["assaf@turno.com", "assaf.k@gmail.com"]);
ok("Cancel is offered beside Save", root.querySelector("#cpCancelEdit"));

group("Cancel discards, and returns to reading");
root.querySelector("#cpNameInput").value = "Typed over";
root.querySelector("#cpCancelEdit").click();
await new Promise((r) => setTimeout(r, 20));
eq("the typed name was not saved", state.saves.length, 0);
eq("the heading shows the stored name",
  root.querySelector("h1.profile-name")?.textContent, "Assaf Karmon");

group("Typing a past company and clicking Save keeps it");
// The bug: Save called applyDetails bare, so extraPast defaulted to "" and
// whatever sat in the input was dropped. Only + or Enter ever committed it.
root.querySelector("#cpEditBtn").click();
await new Promise((r) => setTimeout(r, 20));
root.querySelector("#cpAddPast").value = "Airtable";
root.querySelector("#cpSaveDetailsBtn").click();
await new Promise((r) => setTimeout(r, 20));
eq("the typed company reached the database",
  state.store.get("c1").companyHistory.includes("Airtable"), true);
eq("and shows in the read-only view",
  [...root.querySelectorAll(".token-past")].map((t) => t.textContent).includes("Airtable"), true);
eq("nothing else was lost",
  state.store.get("c1").role, "CEO");

group("Leaving a field saves it — no Save button required");
// "Type an address, click the next field, lose it" is the failure people
// actually hit, and a + you have to find first is a gesture nothing else on
// this form asks for.
document.querySelectorAll(".toast-stack").forEach((n) => n.remove());
root.querySelector("#cpEditBtn").click();
await new Promise((r) => setTimeout(r, 20));

const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));
const addressInputs = () => [...root.querySelectorAll("#cpEmailList .email-address")];
const stored = () => state.store.get("c1");

const third = root.querySelector("#cpAddEmail");
third.click();
await new Promise((r) => setTimeout(r, 20));
const fresh = addressInputs().at(-1);
fresh.value = "taylor@hostready.ai";
fire(fresh, "change");
await new Promise((r) => setTimeout(r, 20));

eq("the new address was saved on leaving the field",
  stored().emails.map((e) => e.address).includes("taylor@hostready.ai"), true);
eq("and you are still in the form", Boolean(root.querySelector("#cpEmailList")), true);
ok("with quiet confirmation, not a toast",
  root.querySelector("#cpSaveDetailsMsg").textContent === "Saved"
  && !document.querySelector(".toast-stack"));

const kind = root.querySelector("#cpEmailList .email-kind");
kind.value = "school";
fire(kind, "change");
await new Promise((r) => setTimeout(r, 20));
eq("changing the label saves too", stored().emails[0].label, "school");

group("Removing an address is an edit like any other");
// Including the FIRST one. normalizeEmails used to fold contact.email back in
// whenever the list did not contain it, so deleting the primary put it
// straight back and the delete looked like it had silently failed.
const before = stored().emails.length;
const primary = stored().emails[0].address;
root.querySelector("#cpEmailList .email-remove").click();
await new Promise((r) => setTimeout(r, 20));
eq("the removal reached the database", stored().emails.length, before - 1);
eq("the primary address is genuinely gone",
  stored().emails.some((e) => e.address === primary), false);
eq("and the primary moved to whatever is now first",
  stored().email, stored().emails[0].address);

group("Removing every address leaves none");
while (root.querySelectorAll("#cpEmailList .email-row").length > 1) {
  root.querySelector("#cpEmailList .email-remove").click();
  await new Promise((r) => setTimeout(r, 20));
}
root.querySelector("#cpEmailList .email-remove").click();
await new Promise((r) => setTimeout(r, 20));
eq("the list is empty, not silently repopulated", stored().emails.length, 0);
eq("and the primary column is cleared with it", stored().email, "");

// Put one back for the rest of the suite.
const again = root.querySelector("#cpEmailList .email-address");
again.value = "taylor@hostready.ai";
fire(again, "change");
await new Promise((r) => setTimeout(r, 20));

group("A past company commits when you move on");
const past = root.querySelector("#cpAddPast");
past.value = "Expedia";
fire(past, "change");
await new Promise((r) => setTimeout(r, 30));
eq("it was saved without clicking +",
  stored().companyHistory.includes("Expedia"), true);
eq("its chip appears straight away",
  [...root.querySelectorAll(".token-past")].some((t) => t.textContent.startsWith("Expedia")), true);
eq("and the input is clear for the next one", past.value, "");
ok("the form was not rebuilt underneath you", root.querySelector("#cpAddPast") === past);

group("Removing a chip sticks");
const chipX = [...root.querySelectorAll("[data-remove-company]")]
  .find((b) => b.dataset.removeCompany === "Expedia");
chipX.click();
await new Promise((r) => setTimeout(r, 20));
eq("gone from the database", stored().companyHistory.includes("Expedia"), false);
eq("and gone from the screen",
  [...root.querySelectorAll(".token-past")].some((t) => t.textContent.startsWith("Expedia")), false);

group("An empty field writes nothing");
const savesBefore = state.saves.length;
past.value = "   ";
fire(past, "change");
await new Promise((r) => setTimeout(r, 20));
eq("blank input is not a company", state.saves.length, savesBefore);

done();
