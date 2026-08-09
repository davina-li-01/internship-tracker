/**
 * ORB-20 — PDF attached to a conversation.
 *
 * Same harness approach as helpers/load-main.mjs: the real js/main.js is loaded with
 * its two import specifiers rewritten to stubs, so these exercise the shipped
 * code rather than a copy.
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

// jsdom cannot set input.files from a real File, so stand one in.
function attachFakeFile(form, name = "notes.pdf", type = "application/pdf") {
  const el = form.querySelector(".cw-file");
  Object.defineProperty(el, "files", { value: [{ name, type }], configurable: true });
  return el;
}

function mountWidget() {
  const root = document.getElementById("root");
  root.innerHTML = __t.conversationWidgetHtml();
  return root.querySelector(".cw-form");
}
const submit = async (form) => {
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 30));
};
const reset = () => {
  state.store.clear();
  state.saves.length = 0;
  state.uploads.length = 0;
  state.files.length = 0;
  state.failUpload = false;
  state.failSave = false;
  document.querySelectorAll(".toast-stack").forEach(n => n.remove());
};

console.log("\nORB-20 — the interaction model");
{
  eq("interactions carry fileIds", __t.normalizeInteraction({}).fileIds, []);
  eq("existing ids survive", __t.normalizeInteraction({ fileIds: ["f1", "f2"] }).fileIds, ["f1", "f2"]);
  eq("junk is dropped", __t.normalizeInteraction({ fileIds: ["f1", null, ""] }).fileIds, ["f1"]);
  eq("a non-array is not trusted", __t.normalizeInteraction({ fileIds: "f1" }).fileIds, []);
}

console.log("\nORB-20 — the field exists on the log widget");
{
  const html = __t.conversationWidgetHtml();
  ok("there is a file input", html.includes('class="cw-file"'));
  ok("it accepts PDFs", /accept="[^"]*application\/pdf/.test(html));
  ok("and images, so handwritten notes can be photographed",
     /accept="[^"]*image\/\*/.test(html));
  ok("it is marked optional", html.includes("Attach a PDF"));
}

console.log("\nORB-20 — attaching to an existing person");
{
  reset();
  const existing = __t.normalizeContact({
    id: "c1", name: "Marcus Chen", interactions: [], dateMet: "2026-01-01",
    lastContacted: "2026-01-01", followUpFrequency: "monthly", reminderEnabled: true
  });
  state.store.set("c1", existing);

  const form = mountWidget();
  let savedArg = null;
  __t.wireConversationWidget(document.getElementById("root"), () => [existing],
    async (s) => { savedArg = s; });
  form.querySelector(".cw-name").value = "Marcus Chen";
  form.querySelector(".cw-notes").value = "Talked about the new team.";
  attachFakeFile(form);
  // Simulate having picked the existing person from the combobox.
  form.querySelector(".cw-name").dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  const option = document.querySelector(".combo-list li");
  if (option) option.dispatchEvent(new window.Event("mousedown", { bubbles: true }));
  await submit(form);

  eq("the file was uploaded once", state.uploads.length, 1);
  eq("and linked to the right person", state.uploads[0].contactId, "c1");
  eq("one write, not two", state.saves.length, 1);
  const convo = state.store.get("c1").interactions[0];
  eq("the conversation carries the file id", convo.fileIds, ["f1"]);
  eq("the notes are intact", convo.notes, "Talked about the new team.");
}

console.log("\nORB-20 — attaching while creating a brand-new person");
{
  reset();
  const form = mountWidget();
  __t.wireConversationWidget(document.getElementById("root"), () => [], async () => {});
  form.querySelector(".cw-name").value = "Priya Raghunathan";
  form.querySelector(".cw-notes").value = "Met at the meetup.";
  attachFakeFile(form, "deck.pdf");
  await submit(form);

  eq("the person was created", state.store.size, 1);
  const c = [...state.store.values()][0];
  eq("uploaded against the new id", state.uploads[0].contactId, c.id);
  eq("two writes — id first, then the link", state.saves.length, 2);
  eq("the conversation ends up linked", c.interactions[0].fileIds, ["f1"]);
  eq("the notes survived both writes", c.interactions[0].notes, "Met at the meetup.");
}

console.log("\nORB-20 — a failed upload must never cost the conversation");
{
  reset();
  state.failUpload = true;
  const form = mountWidget();
  __t.wireConversationWidget(document.getElementById("root"), () => [], async () => {});
  form.querySelector(".cw-name").value = "Sam Patel";
  form.querySelector(".cw-notes").value = "Important context I do not want to lose.";
  attachFakeFile(form);
  await submit(form);

  eq("the conversation was still saved", state.store.size, 1);
  const c = [...state.store.values()][0];
  eq("with its notes", c.interactions[0].notes, "Important context I do not want to lose.");
  eq("and no phantom attachment", c.interactions[0].fileIds, []);
  ok("the failure is reported", form.querySelector(".cw-success").textContent.includes("could not be attached"));
}

console.log("\nORB-20 — a photo of handwritten notes is attachable");
{
  reset();
  const form = mountWidget();
  __t.wireConversationWidget(document.getElementById("root"), () => [], async () => {});
  form.querySelector(".cw-name").value = "Alex Kim";
  attachFakeFile(form, "IMG_4821.jpg", "image/jpeg");
  await submit(form);

  eq("the photo was uploaded", state.uploads.length, 1);
  const c = [...state.store.values()][0];
  eq("and attached to the conversation", c.interactions[0].fileIds, ["f1"]);
}

console.log("\nORB-20 — a file that is neither is still refused");
{
  reset();
  const form = mountWidget();
  __t.wireConversationWidget(document.getElementById("root"), () => [], async () => {});
  form.querySelector(".cw-name").value = "Alex Kim";
  attachFakeFile(form, "notes.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  await submit(form);

  eq("nothing was uploaded", state.uploads.length, 0);
  eq("nothing was saved", state.saves.length, 0);
  ok("and it says what is allowed",
     form.querySelector(".cw-error").textContent.includes("PDF or an image"));
}

console.log("\nORB-20 — no file still means no extra work");
{
  reset();
  const form = mountWidget();
  __t.wireConversationWidget(document.getElementById("root"), () => [], async () => {});
  form.querySelector(".cw-name").value = "Dana Cruz";
  await submit(form);
  eq("no upload attempted", state.uploads.length, 0);
  eq("exactly one write", state.saves.length, 1);
  ok("no failure claimed", !form.querySelector(".cw-success").textContent.includes("could not"));
}

console.log("\nORB-20 — showing attachments in the history");
{
  const files = [
    { id: "f1", name: "one-pager.pdf", fileUrl: "https://cdn.test/one-pager.pdf" },
    { id: "f2", name: "deck.pdf", fileUrl: "https://cdn.test/deck.pdf" }
  ];
  const interactions = [
    { id: "i1", date: "2026-08-01", type: "coffee", notes: "Great chat", fileIds: ["f1", "f2"] },
    { id: "i2", date: "2026-07-01", type: "call", notes: "Intro", fileIds: [] }
  ];
  const html = __t.renderInteractionTimeline(interactions, files);
  ok("the file name is shown", html.includes("one-pager.pdf"));
  ok("both attachments render", html.includes("deck.pdf"));
  ok("it links to the file", html.includes('href="https://cdn.test/deck.pdf"'));
  ok("opened safely in a new tab", html.includes('rel="noopener noreferrer"'));
  eq("a collapsed conversation still flags them", (html.match(/convo-clip/g) || []).length, 1);
  eq("only the conversation with files gets a list", (html.match(/convo-files/g) || []).length, 1);

  const dangling = __t.renderInteractionTimeline(
    [{ id: "i1", date: "2026-08-01", type: "coffee", notes: "x", fileIds: ["gone"] }], files);
  ok("a deleted file leaves no broken link", !dangling.includes("convo-files"));
  ok("and no misleading clip", !dangling.includes("convo-clip"));
  ok("the conversation itself survives", dangling.includes("Great chat") === false && dangling.includes("convo-note"));

  ok("no files at all is fine", !__t.renderInteractionTimeline(interactions).includes("convo-files"));
}

console.log("\nORB-20 — the Networking Log reflects an attachment");
{
  const withBoth = { interactions: [{ id: "i1", date: "2026-08-01", notes: "Good chat", fileIds: ["f1"] }] };
  const p1 = __t.conversationPreview(withBoth);
  ok("the note still shows", p1.includes("Good chat"));
  ok("and the attachment is counted", p1.includes("\u{1F4CE} 1"));

  const onlyFile = { interactions: [{ id: "i1", date: "2026-08-01", notes: "", fileIds: ["f1"] }] };
  ok("a PDF with no notes no longer vanishes", __t.conversationPreview(onlyFile).includes("\u{1F4CE} 1"));

  const nothing = { interactions: [{ id: "i1", date: "2026-08-01", notes: "", fileIds: [] }] };
  eq("but an empty conversation still renders nothing", __t.conversationPreview(nothing), "");

  const noFiles = { interactions: [{ id: "i1", date: "2026-08-01", notes: "Just talk", fileIds: [] }] };
  ok("no clip when there is nothing attached", !__t.conversationPreview(noFiles).includes("\u{1F4CE}"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
