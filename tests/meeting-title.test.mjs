/**
 * The meeting name beside the conversation, not inside it (ORB-66).
 *
 * A synced conversation used to store `title + "\n\n" + notes` in one field.
 * Orbit's words and the user's words were the same string, so the event title
 * was read back as a note preview, and editing your notes could delete the
 * heading without anyone meaning to.
 *
 * `title` is its own key now. jsonb, so no migration — and deliberately no
 * back-fill either, which is what makes this suite worth its length: every row
 * already in the database still has the title baked in, and the split is done
 * at display time against real, messy shapes.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const { conversationTitle, conversationNotes, normalizeInteraction } = main;

const legacy = (notes) => ({ id: "x", date: "2026-08-07", type: "coffee chat",
  notes, sourceEventId: "evt1" });
const typed = (notes) => ({ id: "y", date: "2026-08-07", type: "coffee chat",
  notes, sourceEventId: "" });

group("New conversations keep the two apart");
{
  const i = normalizeInteraction({ title: "Coffee with Marcus", notes: "Talked about Ramsey." });
  eq("the title is its own field", i.title, "Coffee with Marcus");
  eq("and the notes hold only what was typed", i.notes, "Talked about Ramsey.");
  eq("the title is read straight back", conversationTitle(i), "Coffee with Marcus");
  eq("and so are the notes", conversationNotes(i), "Talked about Ramsey.");
}
{
  const i = normalizeInteraction({ title: "Standup", notes: "" });
  eq("a synced meeting with nothing typed saves empty notes", i.notes, "");
  eq("rather than storing Orbit's own text as if it were an answer",
    conversationNotes(i), "");
}

group("Rows written before this still split correctly");
{
  const i = legacy("Coffee with Marcus\n\nTalked about the Ramsey referral.");
  eq("the first line is the title", conversationTitle(i), "Coffee with Marcus");
  eq("and the rest is the note",
    conversationNotes(i), "Talked about the Ramsey referral.");
}
{
  const i = legacy("Coffee with Marcus");
  eq("a title with nothing typed under it", conversationTitle(i), "Coffee with Marcus");
  eq("leaves no note behind", conversationNotes(i), "");
}
{
  // Multi-paragraph notes: only the first blank line separates title from body.
  const i = legacy("Sync\n\nOne thing.\n\nAnother thing.");
  eq("the title is just the first line", conversationTitle(i), "Sync");
  eq("and the body keeps its own paragraphs",
    conversationNotes(i), "One thing.\n\nAnother thing.");
}

group("A hand-written note is never carved up");
// This is the failure worth guarding. A note whose first line happens to be
// short is not a title, and treating it as one would hide the user's own first
// sentence behind a heading they never wrote.
{
  const i = typed("Short first line\n\nThen more.");
  eq("no title is invented", conversationTitle(i), "");
  eq("and the note is left whole",
    conversationNotes(i), "Short first line\n\nThen more.");
}
{
  const i = typed("Just one line");
  eq("nor for a single-line note", conversationTitle(i), "");
  eq("which stays as the note", conversationNotes(i), "Just one line");
}
{
  // Synced, but the shape the old writer never produced: consecutive lines
  // with no blank between them. Splitting here would eat a real sentence.
  const i = legacy("First line\nSecond line");
  eq("a synced row without the blank-line shape yields no title",
    conversationTitle(i), "");
  eq("and keeps every line", conversationNotes(i), "First line\nSecond line");
}

group("Nothing throws on the empty cases");
eq("no interaction", conversationTitle(undefined), "");
eq("no notes", conversationTitle(legacy("")), "");
eq("notes of an empty item", conversationNotes({}), "");

group("The timeline shows the name above the note, not as part of it");
{
  const html = main.renderInteractionTimeline([
    normalizeInteraction({ id: "a", date: "2026-08-07", type: "coffee chat",
      title: "Coffee with Marcus", notes: "Talked about Ramsey." })
  ]);
  ok("the title renders in its own element", html.includes('class="convo-title"'));
  ok("the note is separate", html.includes('class="convo-note"'));
  ok("the closed row shows the meeting name",
    html.includes('<span class="convo-headline">Coffee with Marcus</span>'));
  ok("and the note is not duplicated into it",
    !html.includes('<span class="convo-headline">Talked about Ramsey.</span>'));
}
{
  // Legacy row: same result, without anything having been rewritten on disk.
  const html = main.renderInteractionTimeline([
    normalizeInteraction(legacy("Coffee with Marcus\n\nTalked about Ramsey."))
  ]);
  ok("a legacy row renders the same way", html.includes('class="convo-title"'));
  ok("with the title out of the note body",
    !/class="convo-note">[^<]*Coffee with Marcus/.test(html));
}

group("Editing a legacy row migrates it for good");
{
  resetState();
  const item = normalizeInteraction(legacy("Coffee with Marcus\n\nTalked about Ramsey."));
  state.store.set("c9", main.normalizeContact({
    id: "c9", name: "Marcus Reed", followUpFrequency: "monthly",
    reminderEnabled: true, lastContacted: "2026-08-07",
    interactions: [item], companyHistory: [], followUps: []
  }));
  dom.reconfigure({ url: "https://orbit.test/contact.html?id=c9" });
  document.body.innerHTML = "";
  const root = document.createElement("section");
  root.id = "contactPageContent";
  document.body.appendChild(root);
  await main.initContactPage();

  root.querySelector("[data-edit-convo]").click();
  await new Promise((r) => setTimeout(r, 0));

  const box = document.querySelector("#convoEditNotes");
  eq("the editor is handed the note without the heading in it",
    box.textContent, "Talked about Ramsey.");
  eq("and the dialog is titled with the meeting",
    document.querySelector(".convo-edit-header h3").textContent, "Coffee with Marcus");

  document.querySelector("#convoEditSave").click();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  const saved = state.saves[state.saves.length - 1].interactions[0];
  eq("saving writes the title as its own field", saved.title, "Coffee with Marcus");
  eq("and the notes without it", saved.notes, "Talked about Ramsey.");
  // The point of migrating on save: the split stops being re-derived on every
  // render for the rest of this conversation's life.
  eq("so it no longer depends on the legacy shape",
    conversationTitle({ ...saved, sourceEventId: "" }), "Coffee with Marcus");
}

done();
