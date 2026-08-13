/**
 * The calendar review dialog — the prompt that asks "how did it go?"
 *
 * Two behaviours added on 2026-08-11, both from the same complaint: answering
 * yes saved the meeting immediately, with no way to write down what was said or
 * attach the transcript, so the notes had to be added afterwards from the
 * profile. That is a trip this dialog exists to save.
 *
 * The dialog had no coverage at all before this file, which is why the gap
 * survived: nothing was asserting that the answer to its own question could be
 * typed anywhere.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
const __t = await loadMain();

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok" : "FAIL"}  ${n}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (n, c) => eq(n, Boolean(c), true);

const tick = () => new Promise((r) => setTimeout(r, 0));

function seedContact() {
  const c = __t.normalizeContact({
    id: "c1", name: "Marcus Reed", followUpFrequency: "monthly",
    reminderEnabled: true, lastContacted: "2026-07-01", interactions: []
  });
  state.store.set(c.id, c);
  return c;
}

/** A meeting that ended a moment ago, so justEnded() picks it up. */
function candidate(over = {}) {
  return {
    eventId: "e1", contactId: "c1", contactName: "Marcus Reed",
    title: "Coffee with Marcus", date: "2026-08-11", type: "coffee",
    endedMs: Date.now() - 60_000, existing: null, ...over
  };
}

const modal = () => document.getElementById("calReviewModal");
const saveBtn = () => modal().querySelector("#calReviewSave");
const errText = () => modal()?.querySelector("#calReviewErr")?.textContent || "";

function fakeFile(index, name = "transcript.pdf", type = "application/pdf") {
  const el = modal().querySelector(`[data-file-index="${index}"]`);
  Object.defineProperty(el, "files", { value: [{ name, type }], configurable: true });
  return el;
}

async function open(candidates, opts) {
  document.getElementById("calReviewModal")?.remove();
  __t.openCalendarReviewModal(candidates, [...state.store.values()], opts);
  await tick();
}

// ── The notes box exists at all ───────────────────────────────────────────────

resetState(); seedContact();
await open([candidate()], { justHappened: true });
ok("asks the question in the heading", /How did it go with Marcus Reed/.test(modal().textContent));
ok("notes box is open, not hidden behind a toggle",
  modal().querySelector('[data-notes-index="0"]').hidden === false);
ok("attachment input is present and visible with the notes",
  modal().querySelector('[data-file-index="0"]')
  && modal().querySelector('[data-attach-index="0"]').hidden === false);

// ── Empty notes are confirmed once, not blocked ───────────────────────────────

resetState(); seedContact();
await open([candidate()], { justHappened: true });
saveBtn().click();
await tick();
ok("first save with no notes asks rather than saving", /No notes on this one/.test(errText()));
eq("and nothing was written", state.saves.length, 0);
ok("the dialog is still open", Boolean(modal()));
eq("the button relabels so the second press is a deliberate one",
  saveBtn().textContent, "Log without notes");

saveBtn().click();
await tick(); await tick();
eq("pressing again goes through — the confirm is not a wall", state.saves.length, 1);

// ── Notes typed means no interruption ─────────────────────────────────────────

resetState(); seedContact();
await open([candidate()], { justHappened: true });
modal().querySelector('[data-notes-index="0"]').value = "Talked about the Ramsey referral.";
saveBtn().click();
await tick(); await tick();
eq("with notes, one click is enough", state.saves.length, 1);
// ORB-66: the meeting name is its own field now. It used to be prepended to
// the notes, which made Orbit's text and the user's text the same string.
eq("the meeting name is stored beside the notes",
  state.saves[0].interactions[0].title, "Coffee with Marcus");
eq("and the notes hold only what was typed",
  state.saves[0].interactions[0].notes, "Talked about the Ramsey referral.");

// ── A bulk historical sync is not nagged ──────────────────────────────────────

resetState(); seedContact();
await open([candidate({ endedMs: Date.now() - 40 * 24 * 3600_000 })], { justHappened: false });
saveBtn().click();
await tick(); await tick();
eq("an old meeting with no notes saves straight through", state.saves.length, 1);

// ── Attaching a transcript ────────────────────────────────────────────────────

resetState(); seedContact();
await open([candidate()], { justHappened: true });
modal().querySelector('[data-notes-index="0"]').value = "Went well.";
fakeFile(0);
saveBtn().click();
await tick(); await tick();
eq("the file is uploaded once", state.uploads.length, 1);
eq("filed against the contact, so it lands on the Files page too",
  state.uploads[0].contactId, "c1");
eq("and the conversation carries the file id",
  state.saves[0].interactions[0].fileIds.length, 1);

// ── A rejected file type stops before anything is written ─────────────────────

resetState(); seedContact();
await open([candidate()], { justHappened: true });
modal().querySelector('[data-notes-index="0"]').value = "Went well.";
fakeFile(0, "notes.exe", "application/x-msdownload");
saveBtn().click();
await tick();
ok("an unsupported file is refused", /not supported/.test(errText()));
eq("and nothing is saved", state.saves.length, 0);
eq("and nothing is uploaded", state.uploads.length, 0);

// ── A failed upload must not cost the conversation ────────────────────────────

resetState(); seedContact();
state.failUpload = true;
await open([candidate()], { justHappened: true });
modal().querySelector('[data-notes-index="0"]').value = "Went well.";
fakeFile(0);
saveBtn().click();
await tick(); await tick();
eq("the conversation still saves when storage fails", state.saves.length, 1);
eq("with no dangling file id", state.saves[0].interactions[0].fileIds.length, 0);
ok("and the toast admits the attachment was lost",
  /could not be attached/.test(document.body.textContent));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
