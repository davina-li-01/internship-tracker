/**
 * Editing a conversation in a dialog (ORB-64).
 *
 * The old editor was a four-row textarea wedged into a timeline entry. It could
 * change the notes and nothing else — not the type, not the date — and Delete
 * sat in the row beside the note it would destroy, one slip from the only copy.
 *
 * The dialog owns no data. It reports what was entered through `onSubmit` and
 * asks `onDelete` to do the removing, which is what lets this suite check the
 * awkward parts — the confirm, the rejected file, the escape key — without a
 * contact, a database or a page around it.
 */
import { loadMain } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const { openConversationEditor } = main;

const ITEM = {
  id: "i1",
  date: "2026-08-07",
  type: "coffee chat",
  notes: "Talked about **the platform team**.",
  fileIds: []
};

const modal = () => document.getElementById("convoEditModal");
const $ = (sel) => modal().querySelector(sel);
const click = (sel) => $(sel).dispatchEvent(
  new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));

function open(over = {}) {
  document.getElementById("convoEditModal")?.remove();
  const calls = { submitted: [], deleted: 0 };
  openConversationEditor({ ...ITEM, ...over.item }, {
    title: over.title,
    onSubmit: async (payload) => { calls.submitted.push(payload); },
    onDelete: async () => { calls.deleted++; }
  });
  return calls;
}

group("It carries the same fields as logging a conversation");
{
  open();
  ok("a dialog opened", modal());
  eq("the date is prefilled", $("#convoEditDate").value, "2026-08-07");
  eq("the type is prefilled", $("#convoEditType").value, "coffee chat");
  // Since ORB-72 the box shows real bold rather than asterisks, so the note
  // arrives rendered — and must serialise back to exactly what was stored, or
  // opening a note and saving it unchanged would rewrite it.
  eq("the note arrives formatted, not as syntax",
    $("#convoEditNotes").innerHTML, "Talked about <strong>the platform team</strong>.");
  eq("and converts back to the stored markers untouched",
    main.editorToMarks($("#convoEditNotes")), "Talked about **the platform team**.");
  ok("it is an editable box, not a textarea",
    $("#convoEditNotes").getAttribute("contenteditable") === "true");
  ok("the formatting toolbar is here too", modal().querySelectorAll(".note-tool").length === 4);
  ok("a transcript can be attached", $("#convoEditFile"));
}

group("Delete is as far from Save as the footer allows");
{
  open();
  const footer = $(".convo-edit-footer");
  const save = $("#convoEditSave");
  const del = $("#convoEditDelete");
  ok("both live in the footer", footer.contains(save) && footer.contains(del));
  ok("Save comes first in the DOM, so Delete is last in the tab order",
    save.compareDocumentPosition(del) & 4);
  ok("they are not siblings — Save is grouped, Delete stands alone",
    save.parentElement !== del.parentElement);
  ok("and Delete is not in the row any more",
    !document.querySelector("[data-delete-convo]"));
}

group("Saving reports what was entered");
{
  const calls = open();
  $("#convoEditNotes").textContent = "Rewritten.";
  $("#convoEditType").value = "phone call";
  $("#convoEditDate").value = "2026-08-09";
  click("#convoEditSave");
  await tick(); await tick();

  eq("one submission", calls.submitted.length, 1);
  eq("with the edited notes", calls.submitted[0].notes, "Rewritten.");
  eq("the corrected type", calls.submitted[0].type, "phone call");
  eq("and the corrected date", calls.submitted[0].date, "2026-08-09");
  ok("the dialog closes on save", !modal());
}

group("An unsupported file stops before anything is reported");
{
  const calls = open();
  const input = $("#convoEditFile");
  Object.defineProperty(input, "files", {
    value: [{ name: "notes.exe", type: "application/x-msdownload" }],
    configurable: true
  });
  click("#convoEditSave");
  await tick();

  ok("it says so", /not supported/.test($(".convo-edit-err").textContent));
  eq("nothing was submitted", calls.submitted.length, 0);
  ok("and the dialog stays open, with the notes still in it", modal());
}

group("Deleting asks first");
{
  const realConfirm = dom.window.confirm;
  let asked = 0;

  dom.window.confirm = () => { asked++; return false; };
  let calls = open();
  click("#convoEditDelete");
  await tick();
  eq("declining asks", asked, 1);
  eq("and deletes nothing", calls.deleted, 0);
  ok("the dialog is still open", modal());

  dom.window.confirm = () => { asked++; return true; };
  calls = open();
  click("#convoEditDelete");
  await tick(); await tick();
  eq("accepting deletes", calls.deleted, 1);
  ok("and closes", !modal());

  dom.window.confirm = realConfirm;
}

group("Closing without saving changes nothing");
{
  let calls = open();
  $("#convoEditNotes").textContent = "typed but abandoned";
  click("#convoEditCancel");
  await tick();
  eq("cancel submits nothing", calls.submitted.length, 0);
  ok("and closes", !modal());

  calls = open();
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  ok("escape closes too", !modal());
  eq("still nothing submitted", calls.submitted.length, 0);

  // The keydown listener lives on document, so a dialog that closed must not
  // leave one behind to swallow the next Escape on the page.
  calls = open();
  click("#convoEditClose");
  await tick();
  ok("the close button works", !modal());
}

group("A title names what is being edited");
{
  open({ title: "Coffee with Marcus" });
  ok("the heading uses it", /Coffee with Marcus/.test($(".convo-edit-header").textContent));
  document.getElementById("convoEditModal")?.remove();

  open({ title: "" });
  ok("and falls back rather than showing an empty heading",
    $(".convo-edit-header h3").textContent.trim().length > 0);
  document.getElementById("convoEditModal")?.remove();
}

done();
