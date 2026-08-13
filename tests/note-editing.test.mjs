/**
 * Bullets, real paste, and undo (ORB-77).
 *
 * All three came from using the app. Pasting a Claude answer or a Google Doc
 * dropped every bit of formatting, there was no way to write a list, and Cmd+Z
 * did nothing — the toolbar edits the DOM directly, so the browser's own undo
 * stack did not know those edits had happened.
 *
 * THE SECURITY PROPERTY IS THE SAME ONE AS ORB-63, UNDER MORE PRESSURE
 *
 * Paste now READS html, which is exactly the thing ORB-63 was written to keep
 * out of a note. It stays out: the clipboard is parsed into marker text, and
 * that text goes back through `renderNotes`, which escapes before it translates.
 * So the only tags that can exist are the ones main.js writes. The assertions
 * at the bottom pass hostile markup through the real paste path and check that
 * nothing survives — a refactor that "simplified" this by inserting the
 * clipboard HTML would pass every formatting test above and fail those.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMain, resetState, ROOT } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  renderNotes, editorToMarks, stripNoteMarks, htmlToMarks, normaliseBullets,
  markFromStyle, createNoteHistory, notesEditorHtml, wireNotesEditor
} = main;

const marksOf = (html) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return editorToMarks(el);
};

// ── Bullets ──────────────────────────────────────────────────────────────────

group("A run of bullets is one list");
{
  eq("two lines, one <ul>", renderNotes("- one\n- two"),
    '<ul class="note-list"><li>one</li><li>two</li></ul>');
  // The obvious implementation gives each line its own <ul>, which renders as
  // three lists with gaps between them rather than one list.
  eq("three lines, still one <ul>",
    (renderNotes("- a\n- b\n- c").match(/<ul/g) || []).length, 1);
  eq("a single bullet still makes a list", renderNotes("- only"),
    '<ul class="note-list"><li>only</li></ul>');
}

group("Text and lists sit next to each other cleanly");
{
  eq("text above", renderNotes("Intro\n- one"),
    'Intro<ul class="note-list"><li>one</li></ul>');
  eq("text below", renderNotes("- one\nOutro"),
    '<ul class="note-list"><li>one</li></ul>Outro');
  eq("two lists split by a paragraph",
    (renderNotes("- a\nmiddle\n- b").match(/<ul/g) || []).length, 2);
}

group("A bullet is a dash, because an asterisk is already italic");
{
  ok("a line of italics is not a list", !/<ul/.test(renderNotes("*emphasis*")));
  eq("it is still italic", renderNotes("*emphasis*"), "<em>emphasis</em>");
  ok("a dash makes a list", /<ul/.test(renderNotes("- item")));
  ok("a dash mid-sentence does not", !/<ul/.test(renderNotes("well-known thing")));
  ok("a bare dash with no text is not a bullet", !/<ul/.test(renderNotes("-")));
  ok("indented bullets still count", /<ul/.test(renderNotes("   - item")));
}

group("Marks work inside a bullet");
{
  eq("bold in an item", renderNotes("- said **yes**"),
    '<ul class="note-list"><li>said <strong>yes</strong></li></ul>');
  eq("and the escaping still happens first", renderNotes("- <script>x</script>"),
    '<ul class="note-list"><li>&lt;script&gt;x&lt;/script&gt;</li></ul>');
}

group("A list survives the round trip");
{
  const html = renderNotes("- one\n- two");
  eq("back to markers", marksOf(html), "- one\n- two\n");
  eq("and a mixed note", marksOf(renderNotes("Intro\n- one\n- two")),
    "Intro\n- one\n- two\n");
  // The round trip has to be exact or opening a note and saving it unchanged
  // rewrites it — the property ORB-72 was built on.
  const note = "Talked about **scope**\n- ship Friday\n- *maybe* Monday";
  eq("nothing is rewritten by opening and saving",
    marksOf(renderNotes(note)).replace(/\n+$/, ""), note);
}

group("A bullet is punctuation, so previews drop it");
{
  eq("stripped", stripNoteMarks("- one\n- two"), "one\ntwo");
  eq("along with the marks", stripNoteMarks("- **bold** item"), "bold item");
  eq("and the pasted bullet character too", stripNoteMarks("• one"), "one");
}

// ── Paste ────────────────────────────────────────────────────────────────────

group("Formatting survives a paste, by tag");
{
  eq("strong", htmlToMarks("<p><strong>bold</strong></p>"), "**bold**");
  eq("b, which is what half of them emit", htmlToMarks("<b>bold</b>"), "**bold**");
  eq("em", htmlToMarks("<em>soft</em>"), "*soft*");
  eq("u", htmlToMarks("<u>under</u>"), "__under__");
  eq("mark", htmlToMarks("<mark>lit</mark>"), "==lit==");
}

group("Formatting survives a paste, by style — which is how Docs sends it");
{
  // Google Docs does not emit <b>. Reading only tag names loses everything
  // from the one source these notes are most often pasted from.
  eq("numeric weight", htmlToMarks('<span style="font-weight:700">bold</span>'), "**bold**");
  eq("600 is bold to a reader", markFromStyle(el('font-weight:600')), "**");
  eq("500 is not", markFromStyle(el('font-weight:500')), "");
  eq("the keyword too", markFromStyle(el('font-weight:bold')), "**");
  eq("italic", markFromStyle(el('font-style:italic')), "*");
  eq("underline", markFromStyle(el('text-decoration:underline')), "__");
  eq("a background is a highlight", markFromStyle(el('background-color:#ff0')), "==");
  eq("nothing interesting", markFromStyle(el('color:#333')), "");
}
function el(style) {
  const n = document.createElement("span");
  n.setAttribute("style", style);
  return n;
}

group("Structure survives a paste");
{
  eq("a list", htmlToMarks("<ul><li>one</li><li>two</li></ul>"), "- one\n- two");
  eq("a numbered list is still a list — notes have one kind",
    htmlToMarks("<ol><li>one</li><li>two</li></ol>"), "- one\n- two");
  eq("a heading becomes a bold line", htmlToMarks("<h2>Topic</h2><p>body</p>"),
    "**Topic**\nbody");
  eq("a list after a paragraph starts on its own line",
    htmlToMarks("<p>Intro</p><ul><li>one</li></ul>"), "Intro\n- one");
}

group("The shapes the real tools actually send");
{
  // Google Docs: everything wrapped in styled spans inside <p>.
  const docs = '<p dir="ltr"><span style="font-weight:700">Priya</span>'
    + '<span style="font-weight:400"> wants the deck by Friday</span></p>';
  eq("Docs", htmlToMarks(docs), "**Priya** wants the deck by Friday");

  // Claude and ChatGPT: clean semantic HTML with real lists.
  const chat = "<p>Three things:</p><ul><li><strong>Scope</strong> is fixed</li>"
    + "<li>Ship <em>Friday</em></li></ul>";
  eq("a chat answer", htmlToMarks(chat),
    "Three things:\n- **Scope** is fixed\n- Ship *Friday*");

  eq("blank lines from one-paragraph-per-line are collapsed",
    htmlToMarks("<p>a</p><p></p><p></p><p>b</p>"), "a\n\nb");
}

group("Plain text still works when there is no HTML on the clipboard");
{
  eq("bullet characters are normalised", normaliseBullets("• one\n• two"), "- one\n- two");
  eq("other glyphs too", normaliseBullets("▪ a\n‣ b"), "- a\n- b");
  eq("a dash is left alone", normaliseBullets("- already"), "- already");
  eq("prose is untouched", normaliseBullets("nothing to do here"), "nothing to do here");
}

// ── History ──────────────────────────────────────────────────────────────────

function boxWith(html = "") {
  const node = document.createElement("div");
  node.innerHTML = html;
  document.body.appendChild(node);
  return node;
}

group("Undo walks back through deliberate edits");
{
  const box = boxWith("one");
  const h = createNoteHistory(box);
  eq("nothing to undo at the start", h.canUndo(), false);

  box.innerHTML = "one two";
  h.record();
  ok("now there is", h.canUndo());

  h.undo();
  eq("the previous state is back", box.innerHTML, "one");
  eq("and can be redone", h.canRedo(), true);

  h.redo();
  eq("forwards again", box.innerHTML, "one two");
}

group("The ends of the stack are not walked off");
{
  const box = boxWith("start");
  const h = createNoteHistory(box);
  eq("undo at the start reports nothing happened", h.undo(), false);
  eq("and leaves the note alone", box.innerHTML, "start");
  eq("redo with no future does nothing", h.redo(), false);
  eq("still alone", box.innerHTML, "start");
}

group("A fresh edit abandons the redo branch");
{
  const box = boxWith("a");
  const h = createNoteHistory(box);
  box.innerHTML = "ab"; h.record();
  box.innerHTML = "abc"; h.record();
  h.undo(); h.undo();
  eq("back at the beginning", box.innerHTML, "a");

  box.innerHTML = "different"; h.record();
  eq("the old future is gone", h.canRedo(), false);
  h.undo();
  eq("and undo returns to where the branch started", box.innerHTML, "a");
}

group("Identical content is not a step");
{
  const box = boxWith("same");
  const h = createNoteHistory(box);
  h.record(); h.record(); h.record();
  eq("recording an unchanged note adds nothing", h.size(), 1);
  eq("so undo has nothing to do", h.canUndo(), false);
}

group("Loading a note is the beginning, not something to undo");
{
  document.body.innerHTML = notesEditorHtml({ className: "t-notes" });
  const box = document.querySelector(".t-notes");
  const api = wireNotesEditor(document, box);

  api.setMarks("**loaded** note");
  eq("it rendered", box.innerHTML, "<strong>loaded</strong> note");
  eq("and there is nothing behind it", api.history.canUndo(), false);
  // Otherwise the first Cmd+Z on an existing conversation empties the box,
  // which looks like the note was deleted.
  api.history.undo();
  eq("undo cannot empty a freshly opened note", api.history.canUndo(), false);
}

group("Typing is folded into one step, deliberate edits are not");
{
  const box = boxWith("x");
  const h = createNoteHistory(box, { coalesceMs: 5 });
  box.innerHTML = "xy"; h.schedule();
  box.innerHTML = "xyz"; h.schedule();
  eq("a pending burst has not been committed yet", h.size(), 1);
  await new Promise((r) => setTimeout(r, 20));
  eq("and lands as a single entry", h.size(), 2);
  h.undo();
  eq("so one undo removes the whole burst", box.innerHTML, "x");
}

group("The keyboard does what it does in every other editor");
{
  document.body.innerHTML = notesEditorHtml({ className: "k-notes" });
  const box = document.querySelector(".k-notes");
  const api = wireNotesEditor(document, box);

  const key = (k, opts = {}) => {
    const e = new dom.window.KeyboardEvent("keydown", {
      key: k, bubbles: true, cancelable: true, metaKey: true, ...opts
    });
    box.dispatchEvent(e);
    return e;
  };

  api.setMarks("first");
  box.innerHTML = "first second";
  api.history.record();

  ok("cmd+z is handled here, not left to the browser", key("z").defaultPrevented);
  eq("and it undoes", box.innerHTML, "first");

  ok("cmd+shift+z redoes", key("z", { shiftKey: true }).defaultPrevented);
  eq("forwards again", box.innerHTML, "first second");

  key("z");
  ok("ctrl+y also redoes, for the Windows habit", key("y").defaultPrevented);
  eq("back forwards", box.innerHTML, "first second");
}
{
  document.body.innerHTML = notesEditorHtml({ className: "s-notes" });
  const box = document.querySelector(".s-notes");
  const api = wireNotesEditor(document, box);
  api.setMarks("make me bold");

  const range = document.createRange();
  range.setStart(box.firstChild, 8);
  range.setEnd(box.firstChild, 12);
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const e = new dom.window.KeyboardEvent("keydown", {
    key: "b", bubbles: true, cancelable: true, metaKey: true
  });
  box.dispatchEvent(e);

  // Left to the browser this inserts a <b> the history never saw, so the next
  // Cmd+Z steps over it into a state the note was never in.
  ok("cmd+b is intercepted", e.defaultPrevented);
  eq("and applies our mark", api.getMarks(), "make me **bold**");
  ok("which is therefore undoable", api.history.canUndo());
}

group("The history buttons say whether they will do anything");
{
  document.body.innerHTML = notesEditorHtml({ className: "d-notes" });
  const box = document.querySelector(".d-notes");
  const api = wireNotesEditor(document, box);
  const undoBtn = document.querySelector('.note-tool[data-action="undo"]');
  const redoBtn = document.querySelector('.note-tool[data-action="redo"]');

  api.setMarks("start");
  ok("nothing to undo on a freshly opened note", undoBtn.disabled);
  ok("nor to redo", redoBtn.disabled);

  box.innerHTML = "start more";
  api.history.record();
  box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  ok("undo lights up after an edit", !undoBtn.disabled);

  api.history.undo();
  box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  ok("and redo lights up after an undo", !redoBtn.disabled);
}

// ── The property that must not regress ───────────────────────────────────────

group("Nothing from the clipboard reaches the DOM as markup");
{
  document.body.innerHTML = notesEditorHtml({ className: "p-notes" });
  const box = document.querySelector(".p-notes");
  wireNotesEditor(document, box);

  const paste = (html, text = "") => {
    const e = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    e.clipboardData = { getData: (t) => (t === "text/html" ? html : text) };
    box.dispatchEvent(e);
  };

  box.innerHTML = "";
  paste('<img src=x onerror="alert(1)">');
  ok("no image element survives", !box.querySelector("img"));
  ok("and no handler text is in the DOM", !/onerror/.test(box.innerHTML));

  box.innerHTML = "";
  paste("<script>alert(1)</script><p>after</p>");
  ok("no script element", !box.querySelector("script"));
  ok("its text is not kept either", !/alert/.test(box.innerHTML));
  ok("the real content is", /after/.test(box.innerHTML));

  box.innerHTML = "";
  paste('<a href="javascript:alert(1)">click</a>');
  ok("a link becomes its words", !box.querySelector("a"));
  ok("with no href anywhere", !/javascript:/.test(box.innerHTML));

  box.innerHTML = "";
  paste("<style>body{display:none}</style><p>text</p>");
  ok("styles do not come along", !box.querySelector("style"));
  ok("nor their rules", !/display:none/.test(box.innerHTML));
}

group("But the formatting a person meant does reach it");
{
  document.body.innerHTML = notesEditorHtml({ className: "q-notes" });
  const box = document.querySelector(".q-notes");
  const api = wireNotesEditor(document, box);
  const e = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  e.clipboardData = {
    getData: (t) => (t === "text/html"
      ? "<p><strong>Scope</strong> fixed</p><ul><li>ship Friday</li></ul>"
      : "Scope fixed ship Friday")
  };
  box.innerHTML = "";
  box.dispatchEvent(e);

  ok("bold arrived as bold", box.querySelector("strong"));
  ok("the list arrived as a list", box.querySelector("ul li"));
  eq("and it serialises to the markers we store",
    api.getMarks(), "**Scope** fixed\n- ship Friday");
}

// ── Read off the stylesheet, since jsdom cannot lay it out ───────────────────
// The box growing with its content is the thing that was reported, and jsdom
// has no layout engine — `scrollHeight` is zero and a height cannot be
// measured. So the rules are read from the source, the same way ORB-62 and
// ORB-65 handle the parts of themselves a DOM cannot see.

const css = readFileSync(join(ROOT, "css", "style.css"), "utf8");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every declaration block whose selector list contains this exact selector.
 *
 * The naive version matched `.notes-input` inside `.cw-notes.notes-input` and
 * inside the shared typography group, and read the wrong block — so it has to
 * anchor on a comma or a line start.
 */
const rule = (sel) => {
  const re = new RegExp("(?:^|[,\\n])\\s*" + esc(sel) + "\\s*\\{([^}]*)\\}", "g");
  let out = "", m;
  while ((m = re.exec(css))) out += m[1] + ";";
  return out;
};

/**
 * The value that actually applies: the last one declared.
 *
 * `.notes-input` is given `resize: vertical` by the shared group and
 * `resize: none` by its own rule further down, and the cascade takes the
 * second. Asserting on "does none appear anywhere" would pass even if the
 * order were wrong, which is the bug worth catching.
 */
const decl = (sel, prop) => {
  const all = [...rule(sel).matchAll(new RegExp("(?:^|[;{\\s])" + esc(prop) + "\\s*:\\s*([^;]+)", "g"))];
  return all.length ? all[all.length - 1][1].trim() : "";
};

group("The note box is a fixed height that scrolls");
{
  ok("it has a real height, not just a floor",
    /^[\d.]+rem$/.test(decl(".notes-input", "height")));
  eq("and scrolls when the note outgrows it", decl(".notes-input", "overflow-y"), "auto");
  // The shared typography group still says `resize: vertical`; this is the
  // rule that overrides it, and the override only works because it comes after.
  eq("dragging it taller is off, and that declaration wins",
    decl(".notes-input", "resize"), "none");
  eq("scrolling it does not drag the dialog behind it",
    decl(".notes-input", "overscroll-behavior"), "contain");
}
{
  // Every surface a note is written in, so one of them cannot keep growing
  // while the others are fixed.
  for (const sel of [".cw-notes.notes-input", ".convo-edit-notes.notes-input",
                     "#cpIntNotes.notes-input"]) {
    ok(sel + " is given a fixed height", /^[\d.]+rem$/.test(decl(sel, "height")));
  }
}

group("The list has margins of its own");
{
  // `.notes-input` is white-space: pre-wrap, which would otherwise leave a
  // blank line above and below every list.
  ok("a note-list rule exists", css.includes(".note-list"));
  ok("with its own margins", /\.note-list[^{]*\{[^}]*margin:/.test(css));
  ok("and normal whitespace inside it, not pre-wrap",
    /\.note-list[^{]*\{[^}]*white-space:\s*normal/.test(css));
}

group("The attachment row is not jammed against the note");
{
  ok("the note box carries space beneath it",
    /^[\d.]+rem$/.test(decl(".notes-input", "margin-bottom")));
}

resetState();
done();
