/**
 * main.js — Orbit: a networking tracker
 *
 * ES module. All data access goes through db.js (Supabase).
 * UI state (theme, sidebar) is kept in localStorage only.
 *
 * Pages:
 *   index.html    — Dashboard: KPI row, health rings, who to reach out to
 *   contacts.html — My Network: everyone, searchable and filterable
 *   network.html  — Networking Log: capture widget + chronological log
 *   files.html    — Files (nested under Networking Log)
 *   contact.html  — One connection's profile
 *
 * Every init function returns early when its root element is absent, so the
 * single boot sequence at the bottom works unchanged across all pages.
 */
import { requireAuth, supabase } from "./supabase.js";
import * as db from "./db.js";
import * as calendar from "./calendar.js";
import { MIN_PASSWORD, attachStrengthMeter, passwordAdviceHtml } from "./password.js";

// ── Utilities ─────────────────────────────────────────────────────────────────

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(value) {
  if (!value) return "No date";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function parseDateOnly(value) {
  if (!value) return null;
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A Date to a YYYY-MM-DD string, in the user's own timezone.
 *
 * Not `toISOString().slice(0, 10)`, which is what this used to be. That formats
 * in UTC, while `parseDateOnly` and `daysSince` work in local time — so west of
 * UTC the app spent every afternoon and evening stamping tomorrow's date while
 * measuring elapsed days against today's. In Hawaii that is a ten-hour window,
 * daily, in which clicking "Reached out" recorded a conversation on a date that
 * had not happened yet, and a grace window came out a day too long.
 *
 * Every date in Orbit is a calendar day, not an instant. Calendar days belong
 * to whoever is looking at the calendar.
 */
/**
 * The IANA timezone this browser is in, e.g. "Pacific/Honolulu".
 *
 * Falls back to UTC rather than guessing from the clock offset: an offset
 * cannot distinguish zones that share one today and diverge at the next
 * daylight-saving change, and a stored zone outlives the session that read it.
 */
function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function toDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateString() {
  return toDateString(new Date());
}

/**
 * The calendar day a stored timestamp falls on, in the reader's own zone.
 *
 * Every DATE in this app is local — `todayDateString` builds one from
 * `getFullYear/getMonth/getDate`, and an interaction's `date` comes from a date
 * input. Every TIMESTAMP is UTC, because they are written with `toISOString`.
 * Slicing ten characters off a timestamp therefore gives a UTC day, and
 * comparing that to a local one is wrong for everybody west of Greenwich for
 * part of every evening.
 *
 * It surfaced as a talking point ticked at 8pm on the 23rd being dated the
 * 24th, which is the harmless version. The same slice decides whether a point
 * is "raised since your last conversation" (ORB-121), where an off-by-one day
 * moves it into the wrong group.
 */
function localDayOf(timestamp) {
  if (!timestamp) return "";
  const when = new Date(timestamp);
  return Number.isNaN(when.getTime())
    // Not parseable as a date — fall back to whatever the leading characters
    // are, which is what every caller did before this existed.
    ? String(timestamp).slice(0, 10)
    : toDateString(when);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Notes with light formatting (ORB-63).
 *
 * Notes are stored as plain text with markers, never as HTML. Notes are the one
 * field where other people's words get pasted in, so the injection surface has
 * to stay closed — and CSV export in ORB-12 would start emitting tags the day
 * we stored markup.
 *
 * The order below is the whole security argument: escape FIRST, then translate
 * a fixed set of markers into a fixed set of tags. Nothing the user types can
 * become a tag, because by the time markers are read every `<` is already
 * `&lt;`. Reversing these two lines would undo that.
 *
 *   **bold**   __underline__   *italic*   ==highlight==
 *
 * Bold is matched before italic; `**x**` would otherwise be read as an italic
 * `*` wrapping `x*`.
 */
const NOTE_MARKS = [
  [/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>"],
  [/__([^_\n]+)__/g, "<u>$1</u>"],
  [/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>"],
  [/==([^=\n]+)==/g, "<mark>$1</mark>"]
];

/**
 * A bullet, which is a line and not a span (ORB-77).
 *
 * The other four marks wrap a selection. A bullet marks a whole line, so it
 * cannot be another entry in NOTE_MARKS — the text has to be split into lines
 * first and consecutive bullets gathered into one list.
 *
 * `-` only. `*` is the italic mark, and a line beginning "*this*" is a sentence
 * in italics far more often than it is a bullet. `•` is accepted on the way in
 * because that is what Docs, Notion and the chat tools put on the clipboard,
 * but it is normalised to `-` before it is ever stored.
 */
const BULLET_LINE = /^[ \t]*[-•]\s+(.*)$/;

/** The inline marks only, for one line at a time. */
function renderInlineMarks(value = "") {
  let out = escapeHtml(value);
  for (const [pattern, replacement] of NOTE_MARKS) out = out.replace(pattern, replacement);
  return out;
}

function renderNotes(value = "") {
  const out = [];
  let text = [];
  let list = [];

  const flushText = () => {
    if (text.length) out.push(renderInlineMarks(text.join("\n")));
    text = [];
  };
  const flushList = () => {
    if (list.length) {
      out.push('<ul class="note-list">'
        + list.map((i) => "<li>" + renderInlineMarks(i) + "</li>").join("")
        + "</ul>");
    }
    list = [];
  };

  for (const line of String(value).split("\n")) {
    const bullet = BULLET_LINE.exec(line);
    if (bullet) { flushText(); list.push(bullet[1]); }
    else { flushList(); text.push(line); }
  }
  // The newline that separated a paragraph from a list is deliberately dropped:
  // the <ul> is already a block, and keeping it would leave a blank line under
  // `white-space: pre-wrap`.
  flushText();
  flushList();
  return out.join("");
}

/**
 * The formatting toolbar (ORB-63).
 *
 * Buttons that wrap the selection, so the markers are something you get rather
 * than something you have to learn. Typing them by hand still works.
 */
// A highlighter, drawn rather than an emoji: emoji render differently on every
// platform and cannot take the button's colour.
const HIGHLIGHTER_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">'
  + '<path d="M15.6 3.4a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11.5 17.5l-4-4z"'
  + ' fill="currentColor"/>'
  + '<path d="M7.5 13.5l4 4-2.2 2.2H5.6l-1.4-1.4z" fill="currentColor" opacity="0.55"/>'
  + '</svg>';

const UNDO_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">'
  + '<path d="M8 7H15a5 5 0 0 1 0 10h-4" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M11 4L7.5 7 11 10" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const REDO_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">'
  + '<path d="M16 7H9a5 5 0 0 0 0 10h4" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M13 4l3.5 3L13 10" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const BULLET_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">'
  + '<circle cx="4.5" cy="6.5" r="1.6" fill="currentColor"/>'
  + '<circle cx="4.5" cy="12" r="1.6" fill="currentColor"/>'
  + '<circle cx="4.5" cy="17.5" r="1.6" fill="currentColor"/>'
  + '<path d="M9.5 6.5h11M9.5 12h11M9.5 17.5h11" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round"/></svg>';

/**
 * The toolbar, in three groups (ORB-63, extended by ORB-77).
 *
 * History sits on the far left because that is where every editor puts it, and
 * because it is the one group that is not about the selection. Bullets sit
 * after the inline marks for the opposite reason: a bullet acts on the line,
 * so it does not belong among the four that act on the words.
 */
const NOTE_TOOLS = [
  { action: "undo", label: UNDO_SVG, title: "Undo", cls: "is-undo", raw: true, group: "history" },
  { action: "redo", label: REDO_SVG, title: "Redo", cls: "is-redo", raw: true, group: "history" },
  { mark: "**", label: "B", title: "Bold", cls: "is-bold", group: "inline" },
  { mark: "*",  label: "I", title: "Italic", cls: "is-italic", group: "inline" },
  { mark: "__", label: "U", title: "Underline", cls: "is-underline", group: "inline" },
  { mark: "==", label: HIGHLIGHTER_SVG, title: "Highlight", cls: "is-highlight", raw: true, group: "inline" },
  { action: "bullet", label: BULLET_SVG, title: "Bullet list", cls: "is-bullet", raw: true, group: "block" }
];

function noteToolbarHtml() {
  let html = '<div class="note-toolbar" role="group" aria-label="Formatting">';
  let group = null;
  for (const t of NOTE_TOOLS) {
    if (group && t.group !== group) html += '<span class="note-tool-sep" aria-hidden="true"></span>';
    group = t.group;
    html += '<button type="button" class="note-tool ' + t.cls + '"'
      + (t.mark ? ' data-mark="' + escapeHtml(t.mark) + '"' : "")
      + (t.action ? ' data-action="' + escapeHtml(t.action) + '"' : "")
      + ' title="' + escapeHtml(t.title) + '" aria-label="' + escapeHtml(t.title) + '">'
      // Only the hard-coded SVGs above are ever inserted raw; everything a user
      // could influence still goes through escapeHtml.
      + (t.raw ? t.label : escapeHtml(t.label)) + '</button>';
  }
  return html + '</div>';
}

/**
 * Editing a conversation, in a dialog (ORB-64).
 *
 * The inline version was a four-row textarea wedged into a timeline entry: no
 * room to write, no way to correct the type or the date, and Delete sitting
 * next to the note it would destroy. This carries the same fields as *log a
 * conversation*, so the two are one thing seen twice rather than two
 * half-features.
 *
 * `onSubmit({ date, type, notes, file })` and `onDelete()` do the writing — this
 * function owns the dialog and nothing else, which is what makes it testable
 * without a contact, a database or a page around it.
 */
function openConversationEditor(interaction, { title = "", onSubmit, onDelete } = {}) {
  document.getElementById("convoEditModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "convoEditModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card convo-edit-card">'
    + '<div class="convo-edit-header">'
    + '<h3>' + escapeHtml(title || "Edit conversation") + '</h3>'
    + '<button class="icon-btn" id="convoEditClose" type="button" aria-label="Close">✕</button>'
    + '</div>'

    + '<div class="convo-edit-head-row">'
    + '<div class="field-group"><label for="convoEditDate">When</label>'
    + '<input type="date" id="convoEditDate" value="' + escapeHtml(interaction?.date || "") + '" /></div>'
    + '<div class="field-group"><label for="convoEditType">Type</label>'
    + '<select id="convoEditType">'
    + INTERACTION_TYPES.map((t) => '<option value="' + escapeHtml(t) + '"'
        + (interaction?.type === t ? " selected" : "") + '>'
        + escapeHtml(t.charAt(0).toUpperCase() + t.slice(1)) + '</option>').join("")
    + '</select></div>'
    + '</div>'

    + '<div class="field-group"><label>What did you talk about?</label>'
    + notesEditorHtml({
        id: "convoEditNotes",
        className: "convo-edit-notes",
        placeholder: "What they are working on, what they said, anything you want to bring up next time…"
      })
    + '</div>'

    + '<div class="field-group"><label for="convoEditFile">Attach a transcript or PDF'
    + ' <span class="opt-label">(optional)</span></label>'
    + '<input type="file" id="convoEditFile" accept="' + ATTACH_ACCEPT + '" /></div>'

    + '<p class="convo-edit-err error" aria-live="polite"></p>'

    // Save leads on the left; Delete is pushed to the far right by the footer's
    // own layout, so the destructive action is never adjacent to the safe one.
    + '<div class="convo-edit-footer">'
    + '<div class="convo-edit-primary">'
    + '<button class="btn" id="convoEditSave" type="button">Save</button>'
    + '<button class="btn btn-secondary" id="convoEditCancel" type="button">Cancel</button>'
    + '</div>'
    + '<button class="btn danger-btn convo-edit-delete" id="convoEditDelete" type="button">'
    + 'Delete conversation</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(modal);

  const area = modal.querySelector("#convoEditNotes");
  const notes = wireNotesEditor(modal, area);
  notes.setMarks(interaction?.notes || "");

  const errEl = modal.querySelector(".convo-edit-err");
  const close = () => { modal.remove(); document.removeEventListener("keydown", onKey); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);

  modal.querySelector("#convoEditClose").addEventListener("click", close);
  modal.querySelector("#convoEditCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  modal.querySelector("#convoEditSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const file = modal.querySelector("#convoEditFile")?.files?.[0] || null;
    errEl.textContent = "";
    if (file && !isAllowedAttachment(file)) {
      errEl.textContent = "That file type is not supported — PDF or an image.";
      return;
    }
    btn.disabled = true;
    if (file) btn.textContent = "Uploading…";
    await onSubmit?.({
      date: modal.querySelector("#convoEditDate").value || interaction?.date || "",
      type: modal.querySelector("#convoEditType").value,
      notes: notes.getMarks().trim(),
      file
    });
    close();
  });

  // Confirmed here rather than by the caller, so no path reaches a delete
  // without one. The note is on screen while the question is asked.
  modal.querySelector("#convoEditDelete").addEventListener("click", async () => {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    await onDelete?.();
    close();
  });

  area.focus();
  return modal;
}

/**
 * The editable side of a note (ORB-72).
 *
 * You type into something that shows real bold; what gets stored is still plain
 * text with markers. Storage and display are separable, and conflating them is
 * why the first version made people read `**asterisks**` while writing.
 *
 * The storage decision from ORB-63 is unchanged and load-bearing: markers keep
 * the injection surface shut and keep CSV export free of tags. So this converts
 * at the boundary — markers in on open, markers out on save — and the only HTML
 * that ever exists is inside a contenteditable that never reaches the database.
 *
 * `editorToMarks` is the half that matters and it is pure, so the awkward cases
 * — nested tags, a pasted table, a browser that emits `<b>` where another emits
 * `<strong>` — are testable without a browser.
 */
/** Which element each marker becomes while you are editing. */
const MARK_TAGS = { "**": "strong", "*": "em", "__": "u", "==": "mark" };

const EDITOR_TAG_MARKS = {
  STRONG: "**", B: "**",
  EM: "*", I: "*",
  U: "__",
  MARK: "=="
};

/** Serialise a contenteditable's children back to marked-up plain text. */
/**
 * The mark an inline style is standing in for (ORB-77).
 *
 * Google Docs does not emit `<b>`. It emits `<span style="font-weight:700">`,
 * and Word, Notion and the chat tools all do something similar — so reading
 * only tag names loses every bit of formatting from the places notes are
 * actually pasted from.
 *
 * Weight is a number as often as it is a keyword, and `600` is bold to a reader
 * even though it is not `bold` to a string comparison.
 */
function markFromStyle(el) {
  const style = (el?.getAttribute?.("style") || "").toLowerCase();
  if (!style) return "";
  if (style.includes("background")) return "==";
  const weight = /font-weight:\s*(\d{3}|bold(?:er)?)/.exec(style);
  if (weight && (weight[1] === "bold" || weight[1] === "bolder" || Number(weight[1]) >= 600)) {
    return "**";
  }
  if (/font-style:\s*italic/.test(style)) return "*";
  if (/text-decoration[^;]*underline/.test(style)) return "__";
  return "";
}

function editorToMarks(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {                       // text
      out += child.nodeValue;
      continue;
    }
    if (child.nodeType !== 1) continue;               // comments and the rest
    const tag = child.tagName;
    if (tag === "BR") { out += "\n"; continue; }
    // Nothing inside these is a note. They arrive from a paste, never from the
    // editor, and their text content is markup rather than writing.
    if (tag === "SCRIPT" || tag === "STYLE") continue;

    const inner = editorToMarks(child);

    // A list is lines, so it is handled before the inline marks (ORB-77). The
    // <ul> itself adds nothing — its items have already ended their own lines.
    if (tag === "LI") {
      const item = inner.replace(/\n+$/, "").trim();
      if (item) out += "- " + item + "\n";
      continue;
    }
    if (tag === "UL" || tag === "OL") {
      // A list that follows text needs to start on its own line, or the first
      // bullet is swallowed into the paragraph above it.
      if (out && !out.endsWith("\n")) out += "\n";
      out += inner;
      continue;
    }
    // A heading only ever arrives from a paste — Claude, ChatGPT and Docs all
    // emit them. A note has no heading levels, so it becomes a bold line, which
    // is what the text was doing anyway.
    if (/^H[1-6]$/.test(tag)) {
      const head = inner.trim();
      if (head) out += "**" + head + "**\n";
      continue;
    }

    const mark = EDITOR_TAG_MARKS[tag] || markFromStyle(child);

    if (mark && inner.trim()) out += mark + inner + mark;
    else out += inner;

    // Block-level children end a line. `div` is what contenteditable produces
    // for Enter in most browsers; `p` in the rest.
    if (tag === "DIV" || tag === "P") out += "\n";
  }
  return out;
}

/** Everything an editable note needs: the toolbar and the box itself. */
function notesEditorHtml({ id = "", className = "", placeholder = "" } = {}) {
  return noteToolbarHtml()
    + '<div class="notes-input ' + escapeHtml(className) + '"'
    + (id ? ' id="' + escapeHtml(id) + '"' : "")
    + ' contenteditable="true" role="textbox" aria-multiline="true"'
    + ' data-placeholder="' + escapeHtml(placeholder) + '"></div>';
}

/**
 * Wire an editable note. Returns { getMarks, setMarks } so callers never touch
 * the DOM representation — which is the whole point of the boundary.
 */
function wireNotesEditor(scope, box) {
  const trim = (s) => s.replace(/\n+$/, "");
  const history = createNoteHistory(box);

  // Paste arrives as whatever the source was — a Google Doc, a Claude reply, a
  // whole web page. The HTML is READ but never inserted: it is converted to
  // markers, and those go back through renderNotes, which escapes before it
  // translates. So the note ends up formatted, and the only tags that can ever
  // exist are the ones this file writes (ORB-77).
  box.addEventListener("paste", (e) => {
    e.preventDefault();
    const html = e.clipboardData?.getData("text/html") || "";
    const plain = e.clipboardData?.getData("text/plain") || "";
    const marks = html ? htmlToMarks(html) : normaliseBullets(plain);

    history.record();
    insertMarksAtCaret(box, marks || plain);
    history.record();
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // ── Keyboard ─────────────────────────────────────────────────────────
  // The browser's own undo stack is not usable here: the toolbar edits the DOM
  // directly, so the native stack does not know those edits happened and Cmd+Z
  // walks past them into a state the note was never in. Ours covers every
  // change, which is why it also has to intercept the shortcut.
  box.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const key = e.key.toLowerCase();

    if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) history.redo(); else history.undo();
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (key === "y") {                    // the Windows habit
      e.preventDefault();
      history.redo();
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const shortcut = { b: "**", i: "*", u: "__" }[key];
    if (shortcut) {
      // Without this the browser runs its own bold, which inserts a <b> the
      // history never saw and styles the caret for text not yet typed.
      e.preventDefault();
      history.record();
      applyEditorMark(shortcut);
      history.record();
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });

  // Enter inside a bullet continues the list; Enter on an empty bullet ends it.
  // Without this a list is one item long and every following line is a
  // paragraph, which is not what pressing Enter in a list means anywhere else.
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const li = currentListItem(box);
    if (!li) return;
    e.preventDefault();
    history.record();
    if (!li.textContent.trim()) exitList(li);
    else splitListItem(li);
    history.record();
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // A history button that does nothing when pressed is worse than one that
  // says so. Kept in step with the stack rather than guessed from the content.
  const undoBtn = scope.querySelector('.note-tool[data-action="undo"]');
  const redoBtn = scope.querySelector('.note-tool[data-action="redo"]');
  const syncTools = () => {
    if (undoBtn) undoBtn.disabled = !history.canUndo();
    if (redoBtn) redoBtn.disabled = !history.canRedo();
  };
  syncTools();

  box.addEventListener("input", () => { history.schedule(); syncTools(); });

  scope.querySelectorAll(".note-tool").forEach((tool) => {
    tool.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const action = tool.dataset.action;

      // History buttons do not touch the selection, so they skip the restore
      // dance below — and must not record, or undo would undo itself.
      if (action === "undo" || action === "redo") {
        if (action === "undo") history.undo(); else history.redo();
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }

      // Save the range before focusing. preventDefault keeps focus in the box
      // when it already has it, but if the user selected text and then clicked
      // away, focus() moves the caret and collapses the selection — the tool
      // would then mark nothing at all.
      const sel = window.getSelection();
      const saved = sel && sel.rangeCount && box.contains(sel.anchorNode)
        ? sel.getRangeAt(0).cloneRange()
        : null;
      if (document.activeElement !== box) box.focus();
      if (saved) { sel.removeAllRanges(); sel.addRange(saved); }

      history.record();
      if (action === "bullet") toggleBullets(box);
      else applyEditorMark(tool.dataset.mark);
      history.record();
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  return {
    getMarks: () => trim(editorToMarks(box)),
    setMarks: (text) => {
      box.innerHTML = renderNotes(text || "");
      history.reset();
      syncTools();
    },
    history
  };
}

/**
 * Undo and redo for a contenteditable (ORB-77).
 *
 * Snapshots of innerHTML plus a caret offset. Crude next to a diff, and right
 * for the size: a note is a few hundred characters, and the alternative is
 * modelling every edit as an operation for a box with five formatting rules.
 *
 * Typing is coalesced on a timer so one word is one undo rather than six.
 * Anything deliberate — a toolbar press, a paste, Enter in a list — records on
 * both sides of itself, so it is always exactly one step regardless of timing.
 */
function createNoteHistory(box, { limit = 120, coalesceMs = 400 } = {}) {
  const snap = () => ({ html: box.innerHTML, caret: caretOffset(box) });
  let stack = [snap()];
  let index = 0;
  let timer = null;

  const commit = () => {
    timer = null;
    const next = snap();
    if (stack[index] && stack[index].html === next.html) {
      stack[index] = next;                 // caret moved, content did not
      return;
    }
    stack = stack.slice(0, index + 1);
    stack.push(next);
    if (stack.length > limit) stack.shift();
    index = stack.length - 1;
  };

  const restore = (state) => {
    if (!state) return;
    box.innerHTML = state.html;
    setCaretOffset(box, state.caret);
  };

  return {
    /** Take a snapshot now, cancelling any pending coalesced one. */
    record() {
      if (timer) { clearTimeout(timer); timer = null; }
      commit();
    },
    /** Typing: fold rapid changes into one entry. */
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(commit, coalesceMs);
    },
    undo() {
      this.record();
      if (index <= 0) return false;
      index -= 1;
      restore(stack[index]);
      return true;
    },
    redo() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (index >= stack.length - 1) return false;
      index += 1;
      restore(stack[index]);
      return true;
    },
    /** After setMarks: the loaded note is the beginning, not a step to undo. */
    reset() {
      if (timer) { clearTimeout(timer); timer = null; }
      stack = [snap()];
      index = 0;
    },
    // A burst of typing that has not been committed yet is still undoable —
    // `undo()` flushes it first. Without this the button greys out for the
    // coalescing window every time someone types, which reads as broken.
    canUndo: () => index > 0 || timer !== null,
    canRedo: () => index < stack.length - 1,
    size: () => stack.length
  };
}

/** Characters before the caret, counting only text — enough to put it back. */
function caretOffset(box) {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || !sel.rangeCount || !box.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  const measure = range.cloneRange();
  measure.selectNodeContents(box);
  try { measure.setEnd(range.endContainer, range.endOffset); }
  catch { return null; }
  return measure.toString().length;
}

function setCaretOffset(box, offset) {
  if (offset == null) return;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel) return;
  let remaining = offset;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const len = child.nodeValue.length;
        if (remaining <= len) {
          const range = document.createRange();
          range.setStart(child, remaining);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        }
        remaining -= len;
      } else if (child.nodeType === 1 && walk(child)) return true;
    }
    return false;
  };
  if (!walk(box)) {
    // Past the end, which happens when an undo shortens the note.
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/**
 * Pasted HTML to markers (ORB-77).
 *
 * `DOMParser` builds a detached document: no scripts run, no images load, no
 * styles apply. Only tag names and text are read out of it, and the result is
 * marker text — so nothing from the clipboard can reach the DOM as markup.
 */
function htmlToMarks(html) {
  const Parser = (typeof DOMParser !== "undefined" && DOMParser)
    || (typeof window !== "undefined" && window.DOMParser);
  if (!Parser) return "";
  let doc;
  try { doc = new Parser().parseFromString(String(html), "text/html"); }
  catch { return ""; }
  if (!doc?.body) return "";
  return normaliseBullets(editorToMarks(doc.body))
    .replace(/\n{3,}/g, "\n\n")     // Docs wraps every line in its own <p>
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Bullet characters other tools use, rewritten to the one we store. */
function normaliseBullets(text) {
  return String(text || "").replace(/^[ \t]*[•▪◦‣·]\s+/gm, "- ");
}

/** Insert marker text at the caret, rendered, without trusting the source. */
function insertMarksAtCaret(box, marks) {
  const holder = document.createElement("div");
  holder.innerHTML = renderNotes(marks || "");

  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || !sel.rangeCount || !box.contains(sel.anchorNode)) {
    while (holder.firstChild) box.appendChild(holder.firstChild);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const frag = document.createDocumentFragment();
  let last = null;
  while (holder.firstChild) last = frag.appendChild(holder.firstChild);
  range.insertNode(frag);
  if (last) {
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
  }
}

// ── Bullet lists in the editor ───────────────────────────────────────────────

function currentListItem(box) {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || !sel.rangeCount || !box.contains(sel.anchorNode)) return null;
  const from = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  const li = from?.closest?.("li");
  return li && box.contains(li) ? li : null;
}

function splitListItem(li) {
  const next = document.createElement("li");
  next.appendChild(document.createElement("br"));
  li.parentNode.insertBefore(next, li.nextSibling);
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(next);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Enter on an empty bullet leaves the list rather than adding another. */
function exitList(li) {
  const list = li.parentNode;
  const after = document.createElement("div");
  after.appendChild(document.createElement("br"));
  list.parentNode.insertBefore(after, list.nextSibling);
  li.remove();
  if (!list.children.length) list.remove();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(after);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Turn the selected lines into a list, or back into lines.
 *
 * Done through the marker text rather than by moving nodes. The box is small
 * and the round trip is exact, so rebuilding it is both shorter and less likely
 * to be wrong than the DOM surgery that turns three paragraphs and half a bold
 * run into list items.
 */
function toggleBullets(box) {
  const before = caretOffset(box);
  const marks = editorToMarks(box).replace(/\n+$/, "");
  const lines = marks.split("\n");
  const allBullets = lines.every((l) => !l.trim() || BULLET_LINE.test(l));

  const next = lines
    .map((line) => {
      if (!line.trim()) return line;
      if (allBullets) return line.replace(BULLET_LINE, "$1");
      return BULLET_LINE.test(line) ? line : "- " + line;
    })
    .join("\n");

  box.innerHTML = renderNotes(next);
  setCaretOffset(box, before);
}

/**
 * Apply a mark to the current selection.
 *
 * bold/italic/underline go through execCommand. It is deprecated and it is also
 * the only thing that gets selection edge cases right across browsers without
 * hundreds of lines of Range surgery; the replacement API does not exist yet.
 * Highlight is done by hand because execCommand renders it as a styled span,
 * and a <mark> is what the serialiser and the reader both want.
 */
function applyEditorMark(mark) {
  const tag = MARK_TAGS[mark];
  if (!tag) return;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;

  // Already inside this mark: unwrap, so the button toggles rather than nesting
  // a second identical tag that serialises to doubled markers.
  const from = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  const existing = from?.closest?.(tag);
  if (existing) {
    const parent = existing.parentNode;
    while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    parent.removeChild(existing);
    parent.normalize?.();
    return;
  }

  if (sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const el = document.createElement(tag);
  // surroundContents refuses a range that starts inside one element and ends
  // inside another — selecting across an existing bold, say. Lifting the
  // contents out and re-inserting them handles that case.
  try { range.surroundContents(el); }
  catch { el.appendChild(range.extractContents()); range.insertNode(el); }

  // Keep the words selected, so pressing a second tool applies to the same
  // text instead of to nothing.
  const after = document.createRange();
  after.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(after);
}

/** The same text with markers removed, for previews and anywhere plain. */
function stripNoteMarks(value = "") {
  return String(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/==([^=\n]+)==/g, "$1")
    // The bullet goes too (ORB-77). A one-line preview that opens with "- " is
    // showing punctuation from a list the reader cannot see.
    .replace(/^[ \t]*[-•]\s+/gm, "");
}

/** Whole days between a date-only string and today. Negative means future. */
function daysSince(value) {
  const date = parseDateOnly(value);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today - date) / 86400000);
}

function isDateWithinLastDays(value, days = 7) {
  const elapsed = daysSince(value);
  return elapsed !== null && elapsed >= 0 && elapsed < days;
}

function relativeDayLabel(value) {
  const elapsed = daysSince(value);
  if (elapsed === null) return "no date";
  if (elapsed === 0) return "today";
  if (elapsed === 1) return "yesterday";
  // The future branch only ever ran on "next nudge" dates until the upcoming
  // meetings widget started calling it, where "in 1 days" was on screen.
  if (elapsed === -1) return "tomorrow";
  if (elapsed < 0) return `in ${Math.abs(elapsed)} days`;
  if (elapsed < 30) return `${elapsed} days ago`;
  const months = Math.round(elapsed / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(elapsed / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function initialsFor(name) {
  const parts = (name || "?").trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (parts[0][0] || "?").toUpperCase();
}

// ── Reach-out cadence ─────────────────────────────────────────────────────────
// Deliberately avoids the word "tracking" everywhere it faces the user.

const FREQUENCY_LABELS = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
  bimonthly: "Every 2 months",
  quarterly: "Every 3 months",
  none: "No schedule"
};

const FREQUENCY_DAYS = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  bimonthly: 60,
  quarterly: 90
};

/**
 * Relationship tiers (ORB-52).
 *
 * The tier is what you pick; the interval is what runs. Choosing a tier sets
 * `followUpFrequency` to its default, and editing the interval afterwards is
 * the override — so these numbers are a starting point, never a constraint.
 * Everything downstream (health, digest, dashboard) still reads the interval
 * and is untouched by any of this.
 *
 * Thresholds come from "User Research: Cadence Structure" (Confluence, Aug 11).
 * Read its caveats before treating them as settled: the tier sizes come from
 * secondary coverage of Dunbar rather than the primary papers.
 */
const TIERS = {
  inner_circle: {
    label: "Inner circle",
    hint: "The few you would actually call. About monthly.",
    frequency: "monthly"
  },
  mentors_managers: {
    label: "Mentors and managers",
    hint: "People invested in how you do. About every three months.",
    frequency: "quarterly"
  },
  professional_network: {
    label: "Professional network",
    hint: "Worth staying known to. About twice a year.",
    frequency: "custom:180"
  },
  met_once: {
    label: "Met once",
    hint: "A good conversation, not yet a relationship. About yearly.",
    frequency: "custom:365"
  },
  none: {
    label: "No schedule",
    hint: "On file, never surfaced. A deliberate choice, not a gap.",
    frequency: "none"
  }
};

/** Display order, closest relationships first. */
const TIER_ORDER = [
  "inner_circle", "mentors_managers", "professional_network", "met_once", "none"
];

function tierLabel(tier) {
  return TIERS[tier]?.label || "";
}

function frequencyForTier(tier) {
  return TIERS[tier] ? TIERS[tier].frequency : "none";
}

/**
 * The tier an interval implies, for contacts saved before tiers existed.
 *
 * Mirrors the back-fill in `012_relationship_tiers.sql` exactly — same named
 * frequencies, same day boundaries. If the two ever drift, the same contact
 * shows one tier in the picker and another in the database, which is worse
 * than having no tier at all.
 */
function tierForFrequency(freq) {
  if (freq === "weekly" || freq === "biweekly" || freq === "monthly") return "inner_circle";
  if (freq === "bimonthly" || freq === "quarterly") return "mentors_managers";
  const days = getIntervalDays(freq);
  if (!days) return "none";
  if (days <= 60) return "inner_circle";
  if (days <= 135) return "mentors_managers";
  if (days <= 272) return "professional_network";
  return "met_once";
}

/** The tier to show: what was chosen, else what the interval implies. */
function effectiveTier(contact) {
  return contact?.tier || tierForFrequency(contact?.followUpFrequency);
}

/**
 * What the cadence means, in a sentence — the tier picker's result line.
 *
 * The interval control is the override and lives behind "Adjust", so this is
 * the only place most people ever see what their choice actually does.
 */
function cadenceSentence(freq) {
  if (!freq || freq === "none") return "No reminders — kept on file.";
  return "Reaching out " + getFreqLabel(freq).toLowerCase() + ".";
}

/** `<option>` list for a tier select, with one marked selected. */
function tierOptionsHtml(selected) {
  return TIER_ORDER
    .map((t) => '<option value="' + t + '"' + (selected === t ? " selected" : "") + '>'
      + escapeHtml(TIERS[t].label) + '</option>')
    .join("");
}

function getFreqLabel(freq) {
  if (freq && freq.startsWith("custom:")) {
    const days = parseInt(freq.slice(7), 10);
    return "Every " + days + " day" + (days !== 1 ? "s" : "");
  }
  return FREQUENCY_LABELS[freq] || "No schedule";
}

function getIntervalDays(freq) {
  if (freq && freq.startsWith("custom:")) {
    const days = parseInt(freq.slice(7), 10);
    return Number.isNaN(days) || days <= 0 ? 0 : days;
  }
  return FREQUENCY_DAYS[freq] || 0;
}

function calculateNextReminder(lastContacted, frequency) {
  const interval = getIntervalDays(frequency);
  if (!lastContacted || !interval) return "";
  const date = parseDateOnly(lastContacted) || new Date(lastContacted);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + interval);
  // A date, not an instant. This used to return a full toISOString(), which is
  // a local midnight rendered in UTC — so east of UTC, everything that reads
  // the first ten characters of it got the day before the one intended. The
  // column in Postgres is a `date` anyway, so the time was never stored.
  return toDateString(date);
}

// ── Relationship health ───────────────────────────────────────────────────────
// A connection is "scheduled" when it has a cadence and reminders are on.
// Health decays linearly from 100% right after a touchpoint to 0% once the
// whole interval has elapsed.

/** Days you get to make the first contact after putting someone on a cadence. */
const GRACE_DAYS = 7;

function addDays(dateStr, n) {
  const d = parseDateOnly(dateStr);
  if (!d) return "";
  d.setDate(d.getDate() + n);
  // parseDateOnly built this at LOCAL midnight, so it has to be read back the
  // same way. Going through toISOString here shifted the answer a day east of
  // UTC — the same mismatch that made todayDateString wrong west of it.
  return toDateString(d);
}

/**
 * The deadline a contact is actually judged against. `nextReminder` is the
 * single source of truth — it carries the grace window granted when a cadence
 * is first set, and any "remind me in 3 days" snooze.
 */
function getHealth(contact) {
  const interval = getIntervalDays(contact.followUpFrequency);
  const last = contact.lastContacted || contact.dateMet;
  const elapsed = daysSince(last);

  // Someone added but never spoken to (ORB-75). Both halves are required: no
  // conversation is what "not contacted" means, and no `lastContacted` is what
  // makes it provable — a contact whose only conversation was deleted under
  // ORB-64 has an empty array but a real date behind it, and calling them
  // "not contacted yet" would be a claim the data does not support.
  const firstContact = !(contact.interactions || []).length && !contact.lastContacted;
  // ORB-54 needs this to decide whether failure language is warranted. Carried
  // on health rather than read from the contact at each call site, so the words
  // and the band can never be computed from different inputs.
  const starred = contact.starred === true;

  // ORB-130. Checked BEFORE the cadence, because it is not a cadence that has
  // been satisfied — it is a relationship the question does not apply to. You
  // are in the same standup. A countdown here does not merely say nothing
  // useful, it reports drift between two people who spoke an hour ago.
  //
  // Reported as `scheduled` with a full bar on purpose: this is a deliberate
  // state, and dropping it into "No schedule" would file the healthiest
  // relationships you have under "not set up". No new band, though — ORB-75's
  // rule holds, and the words come from bandWords like the other two overrides.
  if (contact.workingTogether === true) {
    return { scheduled: true, pct: 100, band: "good", tone: "good", elapsed,
             interval: 0, daysLeft: null, grace: false, firstContact, starred,
             working: true };
  }

  if (!interval || !contact.reminderEnabled) {
    return { scheduled: false, pct: 0, band: "none", tone: "none", elapsed, interval: 0, daysLeft: null, grace: false, firstContact, starred, working: false };
  }

  // `elapsed === null` means there is no date to count from — someone was put on
  // a cadence before any contact was recorded. That used to fall out here as
  // "No schedule", which was wrong twice over (ORB-69): firstDeadlineFor already
  // answers this case with the grace window, and the reminder digest queries
  // next_reminder in SQL without consulting this function, so the same contact
  // was emailed while the dashboard denied they were scheduled.
  const naturalNext = addDays(last, interval);
  const next = contact.nextReminder
    ? String(contact.nextReminder).slice(0, 10)
    : (naturalNext || firstDeadlineFor(last, contact.followUpFrequency));

  // A deadline later than the cadence alone would give means the window was
  // deliberately extended — the one-week grace on a fresh schedule, or a snooze.
  // No anchor date is the same situation by definition: you owe a first
  // reach-out and nothing has been measured yet.
  //
  // ORB-124 excludes the never-contacted deliberately. `grace` pins the band to
  // "warning" however much of the window is left, which is what put someone on
  // Reach out next the moment they were added. Moving their deadline out to the
  // cadence without this would have been cosmetic: the right date, still
  // shouting. They now run the ordinary countdown like everybody else.
  const grace = !firstContact
    && (!naturalNext || Boolean(next && next > naturalNext));
  const window = grace ? GRACE_DAYS : interval;

  // daysSince is negative for future dates, so this is "days until the deadline".
  const daysLeft = -daysSince(next);
  const pct = Math.max(0, Math.min(100, Math.round((daysLeft / window) * 100)));

  // Three rules, in order:
  //  - past the deadline is overdue, full stop
  //  - inside a grace window you still owe someone a first reach-out, so it is
  //    never "in touch" no matter how much of the window is left. That keeps it
  //    on the dashboard's "Reach out next" list until you confirm you reached
  //    out, which is the whole point of granting the window.
  //  - otherwise it is the ordinary countdown
  // "Overdue" must mean the deadline actually passed, not merely that the
  // remaining percentage is small. A 90-day cadence at day 80 is down to 11%
  // but still has 10 days left — calling that overdue contradicts the detail.
  const band = daysLeft < 0 ? "critical"
    : grace ? "warning"
    : pct >= 60 ? "good" : "warning";

  // ORB-54. `band` decides ordering, counts and membership; `tone` decides
  // colour. They are the same value except in one case, which is the whole
  // ticket: a long silence with someone you never said mattered is painted as a
  // failure today, and the dormant-tie research says that person may be the
  // most valuable in the network.
  //
  // Splitting them rather than adding a band is ORB-75's rule again — a fifth
  // band would move these people out of Reach out next and solve the colour by
  // hiding the person.
  const tone = band === "critical" && !starred ? "dormant" : band;

  return { scheduled: true, pct, band, tone, elapsed, interval, daysLeft, grace, firstContact, starred, working: false };
}

/**
 * The deadline to use when a cadence is switched on.
 *
 * TWO CASES, AND ORB-124 SEPARATED THEM.
 *
 * Back-filling an old conversation: the last touchpoint already blows the
 * cadence, the natural deadline is in the past, and the contact would land on
 * the dashboard as overdue the instant you saved. GRACE_DAYS from today, granted
 * once at the moment of switching on; logging a conversation moves the deadline
 * onto the normal cadence and it never comes back.
 *
 * Nothing to count from at all: someone was just added and no word has been
 * exchanged. This used to take the same grace window, so adding a person quietly
 * created a seven-day deadline nobody had asked for — on the screen you had just
 * used to do the right thing. Adding someone is not a debt you have taken on.
 * The cadence chosen for them is the answer, and it starts today.
 */
function firstDeadlineFor(lastContacted, frequency) {
  const interval = getIntervalDays(frequency);
  if (!interval) return "";
  const natural = addDays(lastContacted, interval);
  if (!natural) return addDays(todayDateString(), interval);
  return natural < todayDateString()
    ? addDays(todayDateString(), GRACE_DAYS)
    : natural;
}

/**
 * Status vocabulary. Every status is shown as icon + label + number so meaning
 * never rides on color alone — required because the amber sits below 3:1 on
 * this app's light surface.
 *
 * ORB-126. THESE USED TO GIVE ORDERS. "Overdue" and "Reach out soon" are not
 * descriptions of a relationship; they are instructions with a deadline
 * attached, and interview 2 is the clearest possible evidence against them.
 * Asked whether he ever contacts people without a reason, Jack Witt said "I
 * don't randomly reach out — I want to respect their time," and reaches out to
 * the people he values most about once a year. **That is a considered position,
 * and the app was calling it failure.** Interview 1 never cited frequency
 * either, in any direction.
 *
 * So the clock keeps its three steps — they still drive ordering, counts and
 * the rings, and none of that is wrong. What changes is that they now report a
 * fact about silence and leave the decision where it belongs.
 */
const BAND_META = {
  good:     { label: "In touch",     icon: "●", short: "In touch" },
  warning:  { label: "Going quiet",  icon: "◐", short: "Quiet" },
  critical: { label: "Long silence", icon: "▲", short: "Long silence" },
  none:     { label: "No schedule",  icon: "○", short: "No schedule" }
};

/**
 * The words for a status, which are not always the band's own (ORB-75).
 *
 * "Overdue" means a rhythm lapsed. Someone you added and never spoke to has no
 * rhythm to lapse — you owe them a first reach-out, which is a different thing
 * and reads as an accusation when it borrows the vocabulary of a failure.
 *
 * Only the words change. The band still decides colour, ordering and the counts
 * on the dashboard, so a never-contacted person keeps their place in Reach out
 * next instead of being quietly filed somewhere gentler.
 *
 * ORB-75 shipped before ORB-54, so this is the vocabulary ORB-54 reuses when it
 * reframes "overdue" for dormant ties — it should not invent a parallel set.
 */
const FIRST_CONTACT_META = {
  label: "Not contacted yet",
  short: "Not contacted",
  icon: "○"
};

/**
 * A long silence with someone you never said mattered (ORB-54).
 *
 * "Overdue" means you failed at something you undertook. That is true for a
 * person you starred and false for everyone else — and the dormant-tie research
 * says the contact untouched for two years may be the single most valuable one
 * in the network, precisely because they know things and people you do not.
 * Painting them red gets the sign wrong: it is an opportunity described as a
 * debt, on the screen you are least likely to open when you feel behind.
 *
 * So failure language is reserved for the starred, where it is earned. The
 * dormant wording is deliberately forward-looking rather than merely gentler —
 * "Quiet a while" would just be "Overdue" with the accusation filed off.
 */
const DORMANT_META = {
  label: "Worth reviving",
  short: "Worth reviving",
  icon: "◇"
};

/**
 * Already in touch, so there is nothing to count (ORB-130).
 *
 * Third override on the band vocabulary, after ORB-75's and ORB-54's, and for
 * the same reason all three exist: the band is right and the word is wrong.
 * "In touch" would be true but says the cadence is being met; this says there
 * is no cadence and none is wanted.
 */
const WORKING_META = {
  label: "Working together",
  short: "Working together",
  icon: "◈"
};

function bandWords(health) {
  // Ahead of firstContact: you can be working with somebody you have never
  // logged a conversation with, and "Not contacted yet" would be absurd about
  // a person you are in a standup with.
  if (health?.working) return WORKING_META;
  if (health?.firstContact) return FIRST_CONTACT_META;
  if (health?.tone === "dormant") return DORMANT_META;
  return BAND_META[health.band];
}

/**
 * The sentence a reach-out prompt leads with (ORB-78).
 *
 * Survey 1 asked what actually prompted the last message people sent a
 * professional contact. Three of five answered some version of "it had been a
 * while and I felt bad about it." One was moved by a reminder they had set,
 * which is the mechanism this app ships.
 *
 * That answer fuses three things: elapsed time, a named person, and the feeling
 * between them. Orbit had the first two in bureaucratic form — "Reach out soon ·
 * 14 days left" — and none of the third. A countdown is a fact about a schedule.
 * "You last spoke to Marcus 4 months ago" is a fact about a person, and it is
 * the one that moved people.
 *
 * The first name is used deliberately: "Marcus" is who you owe a message, and
 * "Marcus Chen" is a database row.
 */
function firstNameOf(name) {
  return String(name || "").trim().split(/\s+/)[0] || "them";
}

function lastSpokeSentence(contact, health = getHealth(contact)) {
  const who = firstNameOf(contact.name);

  if (!health.firstContact) {
    return "You last spoke to " + who + " " + relativeDayLabel(contact.lastContacted) + ".";
  }
  // Never spoken to. ORB-75 established that this is not a lapse, so it is
  // stated as a fact about a meeting rather than as time owed.
  const metDays = daysSince(contact.dateMet);
  if (metDays === null) return "You have not spoken to " + who + " yet.";
  if (metDays <= 1) {
    return "You met " + who + " " + relativeDayLabel(contact.dateMet) + ". You have not spoken yet.";
  }
  return "You met " + who + " " + relativeDayLabel(contact.dateMet) + " and have not spoken since.";
}

/**
 * The last conversation in its own words (ORB-78).
 *
 * What you actually said is a stronger prompt than any status Orbit can compute
 * — it is the thing that makes the person concrete again. Marks are stripped
 * because this is one line inside a prompt, not the notes view.
 */
function lastConversationEntry(contact, limit = 120) {
  const latest = (contact.interactions || [])
    .filter((i) => (i.notes || "").trim() || (i.title || "").trim())
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  if (!latest) return null;
  const text = stripNoteMarks(latest.notes || latest.title || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return {
    text: text.length > limit ? text.slice(0, limit).trimEnd() + "…" : text,
    date: String(latest.date || "")
  };
}

function lastConversationWords(contact, limit = 120) {
  return lastConversationEntry(contact, limit)?.text || "";
}

/**
 * What has accumulated with this person (ORB-80).
 *
 * Survey 1 asked what people would lose if their system vanished. The two
 * highest-volume respondents answered "Cooked" and "Everything". The one
 * relying on memory answered "not much — I think I rely too heavily on memory".
 *
 * Value scales with what is recorded, which is a good property for a product to
 * have and a useless one if it is invisible at the moment it would change a
 * decision. This is that moment: the reach-out prompt is also where "Remove
 * schedule" lives, so it is the screen on which a relationship gets abandoned.
 *
 * Span is measured across the conversations themselves rather than from dateMet
 * — "6 conversations over 2 years" is a claim about the relationship, and the
 * date you happened to meet is not evidence for it.
 */
function relationshipLedger(contact) {
  // ORB-96. Two numbers, because they are two different claims: a conversation
  // is something you had and wrote up, a touchpoint is something you did. The
  // span runs across both — a year of reach-outs is a year of relationship
  // whether or not any of it was written down.
  const dates = (contact.interactions || [])
    .map((i) => String(i.date || ""))
    .filter(Boolean)
    .sort();
  const count = conversationsOf(contact).length;
  const touchpoints = (contact.interactions || []).filter(isTouchpoint).length;
  const files = (contact.interactions || [])
    .reduce((n, i) => n + ((i.fileIds || []).length), 0);
  const spanDays = dates.length > 1
    ? Math.abs(daysSince(dates[dates.length - 1]) - daysSince(dates[0]))
    : 0;
  return { count, touchpoints, files, spanDays };
}

/**
 * The ledger as one line, or nothing (ORB-80).
 *
 * Nothing is the right answer for a relationship with no history: a prompt that
 * opens "0 conversations" tells someone their network is empty at the exact
 * moment it is asking them to do something about it.
 *
 * A span under a week is dropped rather than printed. Three conversations "over
 * 4 days" reads as a burst of activity, which is not what accumulation means
 * and undersells a relationship the count already described.
 *
 * Attachments are counted here although the ticket says count, span and last
 * exchange. They are the most concretely losable thing in the app — a PDF is
 * the answer to "what would you lose" in a way a row in a table is not — and
 * the same reduce already runs in conversationPreview.
 */
function ledgerLine(contact) {
  const { count, touchpoints, files, spanDays } = relationshipLedger(contact);
  if (!count && !touchpoints && !files) return "";
  const parts = [];
  // The span hangs off whichever of the two comes first, so it is stated once.
  const span = spanDays >= 7 ? " over " + elapsedPhrase(spanDays) : "";
  if (count) {
    parts.push(count + " conversation" + (count === 1 ? "" : "s") + span);
  }
  if (touchpoints) {
    parts.push(touchpoints + " reach-out" + (touchpoints === 1 ? "" : "s")
      + (count ? "" : span));
  }
  if (files) parts.push(files + " file" + (files === 1 ? "" : "s"));
  return parts.join(" · ");
}

/**
 * A gap long enough that the silence itself becomes the obstacle (ORB-79).
 *
 * Below this the dread does not apply — nobody agonises over a fortnight. Two
 * months is where "it would be weird now" starts doing the blocking, which is
 * the point at which the line below is worth spending.
 */
const LONG_SILENCE_DAYS = 60;

function elapsedPhrase(days) {
  if (days < 30) return days + " day" + (days === 1 ? "" : "s");
  if (days < 365) {
    const months = Math.round(days / 30);
    return months + " month" + (months === 1 ? "" : "s");
  }
  const years = Math.round(days / 365);
  return years + " year" + (years === 1 ? "" : "s");
}

/**
 * Permission to send it anyway (ORB-79).
 *
 * Guilt starts the action and then blocks it. The same feeling that produces "I
 * should message her" produces "it would be weird now", and Survey 1 shows both
 * halves — three people acted on the feeling, and the stated blockers were
 * "just forgot", "got lazy", "procrastination".
 *
 * The blocking half is not a preference to be respected. It is factually wrong.
 * Liu et al. (13 preregistered experiments, ~6,000 participants) find people
 * underestimate how much a message out of the blue is appreciated, and that the
 * underestimate GROWS with surprise and social distance — so the longer the
 * silence, the more wrong the dread is. Flynn and Lake find people agree to
 * requests roughly three times more often than the asker predicts.
 *
 * So this is not reassurance. It is a correction, and it is stated as one.
 *
 * ORB-75 removed the accusation from a never-contacted person without putting
 * anything in its place; this is the other half of that.
 */
function longSilenceLine(contact, health = getHealth(contact)) {
  const days = health.elapsed;
  if (days === null || days < LONG_SILENCE_DAYS) return "";
  return "It has been " + elapsedPhrase(days)
    + " — long enough that reaching out feels awkward. It is not: people "
    + "consistently underestimate how welcome an out-of-the-blue message is, "
    + "and the longer the gap the more that holds.";
}

/**
 * The prompt itself: who, how long, and what you last said (ORB-78).
 *
 * One renderer for all three places a reach-out is proposed — the dashboard
 * row, the profile strip and the draft modal — so the vocabulary cannot drift
 * between them. Three lines, in the order the decision is made: who and how
 * long (ORB-78), what you have built with them (ORB-80), and what you last
 * actually said (ORB-78). ORB-54 reframes this same language for dormant ties and should
 * change it here rather than adding a fourth variant.
 *
 * lastSpokeSentence returns plain text and is escaped here rather than
 * escaping the name inside itself. A helper that returns half-escaped HTML
 * is a trap for whoever calls it next.
 */
function reachOutPromptHtml(contact, health = getHealth(contact),
                            { echo = true, ledger = true } = {}) {
  // ORB-97. The sentence above is built from `lastContacted`; the quote is the
  // most recent thing you actually WROTE. Those diverge the moment you use the
  // reach-out button, and the prompt then read "You last spoke to Marcus 3 days
  // ago" over words from eight months earlier, presented as what you last said.
  //
  // The fix is to date the quote rather than hide it — an old note is still the
  // best thing on the screen for remembering who someone is. It is only labelled
  // when it disagrees, so the common case stays clean.
  const entry = echo ? lastConversationEntry(contact) : null;
  const words = entry?.text || "";
  const stale = entry && contact.lastContacted && entry.date
    && entry.date < String(contact.lastContacted).slice(0, 10)
    ? ' <span class="prompt-echo-when">— ' + escapeHtml(relativeDayLabel(entry.date)) + '</span>'
    : "";
  // ORB-110. Off in the draft dialog, and the reason invalidates an argument
  // this codebase made for ORB-80. "The prompt is where a relationship gets
  // abandoned" is true of the dashboard row, where Remove schedule sits beside
  // it and the decision is still open. In the dialog the decision is already
  // made — you are here to write — so the ledger is arguing a case that has
  // been won, above the thing you came to do.
  //
  // The echo stays, and the split is the whole ticket: the ledger argues
  // WHETHER to reach out, the quote is material for WHAT to say.
  const ledgerText = ledger ? ledgerLine(contact) : "";
  // ORB-90. The reason leads, above the elapsed time, because when there is one
  // it is why this person is on the list at all — the clock is incidental. Only
  // the strongest is shown; a stack of them is a to-do list, and the profile is
  // where that already lives.
  //
  // `elapsed` renders nothing: "it has been a while" IS the sentence below, and
  // printing it twice would be the fallback shouting.
  const reason = reachOutReason(contact, health);
  return (reason.kind !== "elapsed"
      ? '<p class="prompt-capture"><span class="prompt-capture-tag">'
        + escapeHtml(reason.label) + '</span> '
        + escapeHtml(reason.text) + '</p>'
      : '')
    + '<p class="prompt-line">' + escapeHtml(lastSpokeSentence(contact, health)) + '</p>'
    + (ledgerText ? '<p class="prompt-ledger">' + escapeHtml(ledgerText) + '</p>' : '')
    + (words ? '<p class="prompt-echo">“' + escapeHtml(words) + '”' + stale + '</p>' : '');
}

function permissionLineHtml(contact, health = getHealth(contact)) {
  const line = longSilenceLine(contact, health);
  return line ? '<p class="permission-line">' + escapeHtml(line) + '</p>' : "";
}

function healthBarHtml(health) {
  const meta = bandWords(health);
  if (!health.scheduled) {
    return '<div class="health health-none">'
      + '<span class="health-label muted"><span class="health-icon" aria-hidden="true">'
      + meta.icon + '</span> ' + meta.label + '</span>'
      + '</div>';
  }
  // ORB-130. No countdown exists, so there is nothing to phrase as one. Said
  // as a fact about how you are in touch rather than left blank, which would
  // read as a value that failed to load.
  if (health.working) {
    return '<div class="health health-good health-working">'
      + '<span class="health-label"><span class="health-icon" aria-hidden="true">'
      + meta.icon + '</span> ' + meta.label + '</span>'
      + '<span class="health-detail muted">no schedule needed</span>'
      + '</div>';
  }
  const days = Math.abs(health.daysLeft);
  const plural = (n) => (n === 1 ? "" : "s");
  // Past the deadline on a first reach-out is stated as elapsed time, not as
  // being "over" something — there was never a schedule to run past (ORB-75).
  const detail = health.firstContact && health.daysLeft < 0
    ? `waiting ${days} day${plural(days)}`
    // "N days over" is the same accusation in numbers, so the dormant case
    // states elapsed time and nothing else (ORB-54).
    : health.tone === "dormant" && health.daysLeft < 0
      ? `quiet ${days} day${plural(days)}`
    // ORB-126. Was "N days over" — the accusation restated as arithmetic, on the
    // one band where it lands hardest. Elapsed time, and nothing more.
    : health.daysLeft < 0
      ? `quiet ${days} day${plural(days)}`
      // Not contacted yet and not yet due (ORB-124). The cadence has this one,
      // and saying so is the difference between a plan and a debt.
      : health.firstContact
        ? (days === 0
            ? "first reach-out due today"
            : `first reach-out in ${days} day${plural(days)}`)
      : health.grace
        ? `${days} day${plural(days)} to first reach-out`
        : `${days} day${plural(days)} left`;
  return '<div class="health">'
    + '<div class="health-track">'
    + '<div class="health-fill fill-' + (health.tone || health.band) + '" style="width:' + health.pct + '%"></div>'
    + '</div>'
    + '<span class="health-label text-' + (health.tone || health.band) + '">'
    + '<span class="health-icon" aria-hidden="true">' + meta.icon + '</span> ' + meta.label + '</span>'
    + '<span class="health-detail">' + detail + '</span>'
    + '</div>';
}

function statusChip(health) {
  const meta = bandWords(health);
  return '<span class="status-chip chip-' + (health.tone || health.band) + '">'
    + '<span aria-hidden="true">' + meta.icon + '</span> ' + escapeHtml(meta.short) + '</span>';
}

// ── Charts ────────────────────────────────────────────────────────────────────
// A ring is a meter: one ratio against a limit. Rounded data-ends, a recessive
// track, and the value printed in the middle so the arc is never the only cue.

function ringHtml({ pct, band, caption, sub }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const safePct = Math.max(0, Math.min(100, pct));
  const filled = (safePct / 100) * circumference;
  // At 0% the round line-cap would still paint a stray dot at 12 o'clock, so
  // the arc is omitted entirely rather than drawn with a zero-length dash.
  const arc = safePct > 0
    ? '<circle class="ring-fill ring-' + band + '" cx="50" cy="50" r="' + radius + '"'
      + ' stroke-dasharray="' + filled.toFixed(2) + ' ' + (circumference - filled).toFixed(2) + '"'
      + ' transform="rotate(-90 50 50)" />'
    : "";
  return '<figure class="ring-fig">'
    + '<svg class="ring" viewBox="0 0 100 100" role="img"'
    + ' aria-label="' + escapeHtml(caption) + ': ' + safePct + ' percent">'
    + '<circle class="ring-track" cx="50" cy="50" r="' + radius + '" />'
    + arc
    + '<text class="ring-value" x="50" y="50">' + safePct + '%</text>'
    + '</svg>'
    + '<figcaption><span class="ring-caption">' + escapeHtml(caption) + '</span>'
    + (sub ? '<span class="ring-sub">' + escapeHtml(sub) + '</span>' : '')
    + '</figcaption>'
    + '</figure>';
}

/** Part-to-whole across the three statuses — a stacked bar, not a pie. */
function splitBarHtml(counts) {
  const total = counts.good + counts.warning + counts.critical;
  if (!total) return "";
  const seg = (band) => counts[band]
    ? '<div class="split-seg fill-' + band + '" style="flex:' + counts[band] + '"'
      + ' title="' + BAND_META[band].label + ': ' + counts[band] + '"></div>'
    : "";
  return '<div class="split-wrap">'
    + '<div class="split-bar">' + seg("good") + seg("warning") + seg("critical") + '</div>'
    + '<ul class="split-legend">'
    + ["good", "warning", "critical"].map((band) =>
        '<li class="split-legend-item">'
        + '<span class="legend-dot dot-' + band + '" aria-hidden="true"></span>'
        + '<span class="legend-label">' + BAND_META[band].label + '</span>'
        + '<span class="legend-count">' + counts[band] + '</span>'
        + '</li>').join("")
    + '</ul>'
    + '</div>';
}

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeInteraction(item = {}) {
  return {
    id: item.id || makeId(),
    date: item.date || todayDateString(),
    type: item.type || "check-in",
    // The meeting name, when there was one (ORB-66). Kept beside the notes
    // rather than inside them, so Orbit's text and the user's text are not the
    // same string — and so editing your notes cannot delete the heading.
    title: (item.title || "").trim(),
    notes: (item.notes || "").trim(),
    outcome: (item.outcome || "").trim(),
    // Ids into storage_files (ORB-20). Held on the interaction rather than as a
    // column on storage_files because interactions are jsonb on contacts, so
    // attaching a PDF to a conversation needs no schema migration. Ids that no
    // longer resolve — the file was deleted from the Files page — are dropped
    // at render time rather than cleaned up here.
    fileIds: Array.isArray(item.fileIds) ? item.fileIds.filter(Boolean) : [],
    // The Google Calendar event this came from, when it came from one (ORB-15).
    // Syncing is re-run every time you open Orbit, so this is what stops the
    // same meeting being logged again on every sync. Empty for anything typed
    // by hand.
    sourceEventId: (item.sourceEventId || "").trim()
  };
}

/**
 * The details, read-only.
 *
 * Default state, because reading a record is the common act and editing it is
 * the rare one. A screen of inputs reads as a form you are expected to fill in;
 * this reads as what you know about someone.
 *
 * Deliberately the same grid as the editor, so switching modes moves nothing.
 */
function detailsViewHtml(c, pastCompanies) {
  const field = (label, value, extraClass = "") =>
    '<div class="field-group view-field ' + extraClass + '">'
    + '<label>' + label + '</label>'
    + '<p class="view-value' + (value ? '' : ' view-empty') + '">'
    + (value ? escapeHtml(value) : "Not set") + '</p>'
    + '</div>';

  return '<div class="inline-edit-grid">'
    + field("Role / Title", c.role)
    + field("Current company", c.company)
    + field("Industry", c.industry)

    + '<div class="field-group view-field field-email">'
    + '<label>Email</label>'
    + (c.emails.length
      ? '<ul class="view-emails">' + c.emails.map((e) =>
          '<li><span class="email-label">' + escapeHtml(e.label) + '</span>'
          + '<a href="mailto:' + escapeHtml(e.address) + '">' + escapeHtml(e.address) + '</a></li>').join("")
        + '</ul>'
      : '<p class="view-value view-empty">Not set</p>')
    + '</div>'

    + '<div class="field-group view-field field-past">'
    + '<label>Past companies</label>'
    + (pastCompanies.length
      ? '<div class="past-tokens">' + pastCompanies.map((co) =>
          '<span class="token token-past">' + escapeHtml(co) + '</span>').join("")
        + '</div>'
      : '<p class="view-value view-empty">None</p>')
    + '</div>'
    + '</div>';
}

/** One editable address row: label, address, and a way to remove it. */
function emailRowHtml(entry, index) {
  return '<div class="email-row" data-email-index="' + index + '">'
    + '<select class="email-kind" aria-label="Type of address">'
    + EMAIL_LABELS.map((l) => '<option value="' + l + '"'
      + (l === entry.label ? ' selected' : '') + '>'
      + l.charAt(0).toUpperCase() + l.slice(1) + '</option>').join("")
    + '</select>'
    + '<input type="email" class="email-address" value="' + escapeHtml(entry.address) + '"'
    + ' placeholder="name@example.com" aria-label="Email address" />'
    // Keeps click-to-email now that the mailto list above is gone.
    + (entry.address
      ? '<a class="icon-btn email-open" href="mailto:' + escapeHtml(entry.address) + '"'
        + ' aria-label="Email ' + escapeHtml(entry.address) + '" title="Send an email">✉</a>'
      : '<span class="icon-btn email-open is-empty" aria-hidden="true">✉</span>')
    + '<button class="icon-btn email-remove" type="button" aria-label="Remove this address">✕</button>'
    + '</div>';
}

/**
 * The past-company chips.
 *
 * Its own function because the editor rebuilds just this block after a company
 * is added, rather than re-rendering the whole page — a full re-render while
 * you are still typing in the form above would throw away the caret and any
 * other field you had part-way through.
 */
function pastTokensHtml(pastCompanies) {
  if (!pastCompanies.length) return "";
  return '<div class="past-tokens">' + pastCompanies.map((co) =>
    '<span class="token token-past">' + escapeHtml(co)
    + '<button class="token-x" type="button" data-remove-company="' + escapeHtml(co)
    + '" aria-label="Remove ' + escapeHtml(co) + '">✕</button></span>').join("")
    + '</div>';
}

/**
 * Addresses a person can be reached at.
 *
 * One field was never enough: people have a work address, a personal one, one
 * from school, one for a side project — and the calendar sends invites to
 * whichever is relevant. Matching on a single stored address silently missed
 * every meeting sent to any of the others, which looks identical to "no
 * meetings found".
 */
const EMAIL_LABELS = ["personal", "work", "school", "other"];

function normalizeEmail(item = {}) {
  const label = EMAIL_LABELS.includes(item.label) ? item.label : "personal";
  return {
    id: item.id || makeId(),
    label,
    address: String(item.address || "").trim()
  };
}

/**
 * The whole list, de-duplicated, with the primary first.
 *
 * `contact.email` is kept as the first address rather than removed, so every
 * existing read — mailto links, the capture form, search — keeps working
 * against one string while matching gets the full set.
 */
function normalizeEmails(contact = {}) {
  const raw = Array.isArray(contact.emails) ? contact.emails : [];
  const list = raw.map(normalizeEmail).filter((e) => e.address);

  // A contact saved before this existed has only the single column, and the
  // capture form still writes one address into it — so an `email` the list does
  // not know about is a new address, and gets promoted to primary.
  //
  // The corollary matters as much: a caller editing the list must not leave a
  // STALE `email` behind, or this puts the address it just removed straight
  // back. See applyDetails on the profile.
  const legacy = String(contact.email || "").trim();
  if (legacy && !list.some((e) => e.address.toLowerCase() === legacy.toLowerCase())) {
    list.unshift(normalizeEmail({ label: "personal", address: legacy }));
  }

  const seen = new Set();
  return list.filter((e) => {
    const key = e.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const FOLLOWUP_SOURCES = ["manual", "ai", "capture"];

/**
 * `capture` is a third provenance (ORB-81), not a new table.
 *
 * A thought caught at 2am and a talking point typed on the profile are the same
 * shape — a sentence about a person, done or not done — so giving the first its
 * own storage would mean two lists to reconcile, two things to complete, and a
 * profile that shows one of them. What differs is where it came from, and that
 * is the only thing recorded.
 *
 * It earns its own value because an OPEN capture pulls someone into Reach out
 * next regardless of their cadence. A manual talking point must not do that —
 * it is preparation for a conversation you already intend to have.
 */
function normalizeFollowUpItem(item = {}) {
  return {
    id: item.id || makeId(),
    text: (item.text || "").trim(),
    source: FOLLOWUP_SOURCES.includes(item.source) ? item.source : "manual",
    completed: item.completed === true,
    // ORB-122's secondary KPI is "points ticked before the next conversation",
    // and `completed` is a bare boolean — it says a point is done and nothing
    // about when, so the KPI could not be read at all. One more jsonb field, no
    // migration. It is only ever set alongside the tick, so a point ticked
    // before today carries "" and the measure starts from here.
    completedAt: item.completed === true ? (item.completedAt || "") : "",
    // ORB-121. The conversation that prompted this, when there was one. Empty
    // for a capture and for anything typed on the profile, which is not a gap
    // — those genuinely came from nowhere in particular.
    //
    // No migration: `follow_ups` is jsonb, the same reason ORB-96 could add a
    // touchpoint type for free. Old items simply read "".
    sourceInteractionId: item.sourceInteractionId || "",
    createdAt: item.createdAt || new Date().toISOString()
  };
}

/**
 * A talking point had no relationship to time (ORB-121).
 *
 * It was created, it sat on the contact, and nothing connected it to the
 * conversation it came from or the one it was for. So the list could not be
 * short — it had no basis on which to drop anything, no way to tell a point
 * raised before last week's coffee from one raised this morning, and no idea
 * whether the coffee happened. Item 21 of the 20 Aug session — "is this section
 * just going to get longer and longer?" — was not a complaint about volume. It
 * was the correct observation that the list has no lifecycle.
 *
 * WHY THIS IS DERIVED AND NOT STORED. A "has been through a conversation" flag
 * would need maintaining, and would go stale the moment a conversation was
 * edited or deleted under ORB-64. A comparison cannot go stale.
 *
 * CONVERSATIONS ONLY, NOT TOUCHPOINTS (ORB-96). Pressing "Reached out" is you
 * sending a message, not a conversation in which a point could have been
 * raised. Counting it would retire talking points for a conversation that never
 * happened.
 */
function lastConversationDate(contact) {
  return conversationsOf(contact)
    .map((i) => String(i.date || ""))
    .filter(Boolean)
    .sort()
    .pop() || "";
}

/**
 * The three groups (ORB-122), in the order the list reads.
 *
 * SAME-DAY COUNTS AS STILL TO COME. `createdAt` is a timestamp and an
 * interaction's `date` is a day, so a point raised on the day of a conversation
 * cannot be ordered against it. It stays in "raised since", because the safe
 * failure is leaving a fresh point visible — and in practice a point typed on
 * the day you logged a conversation is usually for the next one.
 */
const FOLLOWUP_GROUPS = [
  { key: "since", label: "Raised since your last conversation" },
  { key: "carried", label: "Carried over" },
  { key: "ticked", label: "Ticked" }
];

function groupFollowUps(contact) {
  const pivot = lastConversationDate(contact);
  const out = { since: [], carried: [], ticked: [] };
  for (const item of contact?.followUps || []) {
    if (item.completed) { out.ticked.push(item); continue; }
    // No conversation has ever happened, so nothing has had its chance yet.
    const raised = localDayOf(item.createdAt);
    (!pivot || raised >= pivot ? out.since : out.carried).push(item);
  }
  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  return out;
}

/**
 * Two triggers computed from data already stored (ORB-91).
 *
 * Survey 1 found exactly one person in five acted on a reminder they had set
 * themselves. Gollwitzer and Sheeran put if-then plans at **d = .65** across 94
 * tests — "when X happens, I will do Y" beats "I will do Y eventually" by a
 * wide margin — and a timer is the second of those, dressed as the first.
 *
 * DELIBERATELY LIMITED TO WHAT IS ALREADY ON DISK. That constraint is what
 * makes this small. A job change would be the strongest trigger of all and
 * needs LinkedIn or manual entry, so it is explicitly out of scope.
 *
 * TRIGGER A — you just met.
 *
 * A conversation logged in the last few days, with no reach-out since. The
 * follow-up moment is now, not in a month, and the cadence actively hides it:
 * having just spoken makes someone "in touch", so the one moment a note lands
 * best is the one moment the dashboard says there is nothing to do.
 *
 * TRIGGER B — the anniversary of meeting.
 *
 * From `dateMet` (ORB-73). Not a milestone worth celebrating on its own — it is
 * an excuse, and an excuse is what the survey says people are short of.
 */
const JUST_MET_DAYS = 4;
const ANNIVERSARY_WINDOW_DAYS = 3;

function justMetTrigger(contact) {
  // Conversations only (ORB-96). A touchpoint is you having ALREADY followed
  // up, so counting it here would fire "you spoke to Marcus today — a note now
  // lands better" the instant you pressed the button that says you sent one.
  const latest = conversationsOf(contact)
    .map((i) => String(i.date || ""))
    .filter(Boolean)
    .sort()
    .pop();
  if (!latest) return null;
  const since = daysSince(latest);
  if (since === null || since < 0 || since > JUST_MET_DAYS) return null;
  // If lastContacted has moved past the conversation, the follow-up already
  // happened and this would be nagging about a job that is done.
  if (contact.lastContacted && contact.lastContacted > latest) return null;
  const who = firstNameOf(contact.name);
  return {
    kind: "just-met",
    text: since === 0
      ? "You spoke to " + who + " today — a note now lands better than one in a month."
      : "You spoke to " + who + " " + relativeDayLabel(latest)
        + " — a note now lands better than one in a month."
  };
}

function anniversaryTrigger(contact, today = todayDateString()) {
  const met = parseDateOnly(contact.dateMet);
  if (!met) return null;
  const thisYear = Number(today.slice(0, 4));
  const monthDay = String(contact.dateMet).slice(5, 10);
  if (!/^\d{2}-\d{2}$/.test(monthDay)) return null;

  // This year's anniversary, and the ones either side of it. On 2 January the
  // relevant one is three days ago and lives in the PREVIOUS year; on 31
  // December it is two days ahead and lives in the NEXT one. Checking only this
  // year would skip every turn-of-year anniversary, and would do it silently
  // for the other eleven months. The windows are ±3 days out of 365, so they
  // cannot overlap and the order below does not matter.
  //
  // Measured against the `today` that was passed in rather than via daysSince,
  // which always reads the real clock. A trigger whose test can only be written
  // for the day it runs on is a trigger nobody can test at the year boundary.
  const now = parseDateOnly(today);
  if (!now) return null;
  for (const year of [thisYear, thisYear - 1, thisYear + 1]) {
    const years = year - met.getFullYear();
    if (years < 1) continue;
    const on = parseDateOnly(year + "-" + monthDay);
    if (!on) continue;
    const off = Math.round((now - on) / 86400000);
    if (Math.abs(off) > ANNIVERSARY_WINDOW_DAYS) continue;
    return {
      kind: "anniversary",
      text: "It is " + years + " year" + (years === 1 ? "" : "s")
        + " this week since you met " + firstNameOf(contact.name) + "."
    };
  }
  return null;
}

/**
 * Why this person is on the list (ORB-90).
 *
 * Every row states a reason. That is the point of the ticket: a queue of dates
 * gives you nothing to act on, and "it has been a while" — the honest fallback
 * when there is no better one — is still a reason, just the weakest one.
 *
 * The order of the checks is the ranking ORB-92 sorts by, so there is one list
 * rather than two that can disagree.
 */
/**
 * Being somewhere is a reason, and it expires (ORB-131).
 *
 * Interview 1: three of the five people named live in Hawaii, and contact with
 * them clusters entirely around being physically home — "I love just meeting up
 * with them in person." A cadence is exactly wrong for that shape. It never
 * fires on the one week that matters and fires constantly on the fifty that do
 * not, so the person learns to ignore it in both.
 *
 * WHERE YOU ARE IS TOLD, NOT DETECTED. No geolocation, no IP guessing. The
 * match is one string you typed about a contact against one string you typed
 * about yourself, which is crude and is the point: both came from the same
 * person, so they mean the same thing.
 *
 * AND IT ENDS. `until` is asked for because a trip with no end is a toggle, and
 * a toggle nobody remembers to switch off fires for ever — which is the nagging
 * ORB-126 spent a day taking out. A blank end date is still allowed, for "I
 * live here", and that is a thing you say deliberately.
 */
function currentTrip(prefs) {
  const place = String(prefs?.current_location || "").trim();
  if (!place) return null;
  const until = String(prefs?.location_until || "").slice(0, 10);
  if (until && until < todayDateString()) return null;
  return { place, until };
}

function sameePlace(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

/**
 * Where you are, held for the page (ORB-131).
 *
 * Module state, which needs justifying. The alternative is threading a trip
 * through `reachOutReason` → `reachOutPromptHtml` → `personRowHtml` →
 * `needsAttention` and four call sites, to carry one fact that is the same for
 * every contact on the page and changes only when you tell it so. That is a lot
 * of plumbing for a value with no per-contact meaning.
 *
 * It is set once per page load from preferences, and every reader takes it as a
 * default parameter — so a test can pass a trip explicitly and never depends on
 * whatever a previous test left behind.
 */
let currentTripState = null;

/**
 * "Where are you?" — one line on the dashboard (ORB-131).
 *
 * Two states rather than a form that is always open. Once you have said where
 * you are it collapses to a sentence and a way out, because a text input asking
 * your location on every page load is a question nobody wants asked twice.
 */
function tripBarHtml(prefs, contacts) {
  const trip = currentTrip(prefs);
  if (trip) {
    const here = (contacts || []).filter((c) => sameePlace(c.location, trip.place));
    return '<div class="trip-bar trip-on">'
      + '<p class="trip-line"><span class="trip-pin" aria-hidden="true">◎</span> '
      + 'You are in <strong>' + escapeHtml(trip.place) + '</strong>'
      + (trip.until ? ' until ' + escapeHtml(formatDate(trip.until)) : '')
      + ' · ' + here.length + (here.length === 1 ? ' person' : ' people') + ' here'
      + '</p>'
      + '<button type="button" class="link-btn" id="tripClear">Not any more</button>'
      + '</div>';
  }
  return '<div class="trip-bar">'
    + placeDatalist(contacts, "tripPlaces")
    + '<form class="trip-form">'
    + '<label for="tripPlace" class="trip-label">Somewhere different this week?</label>'
    + '<div class="trip-row">'
    + '<input type="text" id="tripPlace" list="tripPlaces" placeholder="Hawaii"'
    + ' aria-label="Where you are" />'
    + '<input type="date" id="tripUntil" aria-label="Until when" />'
    + '<button type="submit" class="btn btn-sm">I am here</button>'
    + '</div>'
    + '<p class="tiny muted">People you have put in that place come to the top of '
    + 'Reach out next while you are there.</p>'
    + '</form>'
    + '</div>';
}

function wireTripBar(root, prefs, onChanged) {
  root.querySelector("#tripClear")?.addEventListener("click", async () => {
    await db.savePreferences({ current_location: "", location_until: null });
    if (onChanged) await onChanged();
  });
  root.querySelector(".trip-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const place = root.querySelector("#tripPlace").value.trim();
    if (!place) return;
    // An end date is asked for, not required. A trip with no end is a toggle,
    // and one nobody remembers to switch off nags for ever (ORB-126) — but
    // "I live here" is a real answer and refusing it would be worse.
    const until = root.querySelector("#tripUntil").value || null;
    await db.savePreferences({ current_location: place, location_until: until });
    if (onChanged) await onChanged();
    showToast("You are in " + place + ". People there come up first.");
  });
}

function setCurrentTrip(prefs) {
  currentTripState = currentTrip(prefs);
  return currentTripState;
}

function inTownTrigger(contact, trip = currentTripState) {
  if (!trip || !sameePlace(contact?.location, trip.place)) return null;
  return {
    kind: "in-town",
    text: "You are in " + trip.place + " and so is "
      + firstNameOf(contact.name) + "."
  };
}

// "in-town" ranks second: a caught thought is something you decided, which
// outranks everything, but a trip closes — the others will still be true next
// month and this will not.
const REACH_OUT_REASONS = ["capture", "in-town", "just-met", "anniversary", "first-contact", "elapsed"];

function reachOutReason(contact, health = getHealth(contact), trip = currentTripState) {
  const caught = openCaptures(contact)[0];
  if (caught) return { kind: "capture", text: caught.text, label: "You noted" };

  // ORB-128. The label said "Just met" and the trigger means "you just spoke" —
  // reported by a user who saw it on somebody they had known for years. The
  // trigger is right and was never about meeting anyone: it fires on a
  // conversation logged in the last few days, whoever they are.
  const inTown = inTownTrigger(contact, trip);
  if (inTown) return { ...inTown, label: "You are both here" };

  const met = justMetTrigger(contact);
  if (met) return { ...met, label: "Just spoke" };

  const anniversary = anniversaryTrigger(contact);
  if (anniversary) return { ...anniversary, label: "A year on" };

  if (health.firstContact) {
    return {
      kind: "first-contact",
      label: "Never spoken",
      text: "You have not had a first conversation with "
        + firstNameOf(contact.name) + " yet."
    };
  }
  return { kind: "elapsed", label: "", text: "" };
}

/** Where a reason sorts. Lower is sooner (ORB-92). */
function reasonRank(reason) {
  const i = REACH_OUT_REASONS.indexOf(reason?.kind);
  return i === -1 ? REACH_OUT_REASONS.length : i;
}

/** Captured thoughts still waiting, newest first. */
function openCaptures(contact) {
  return (contact.followUps || [])
    .filter((f) => f.source === "capture" && !f.completed)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function normalizeContact(contact = {}) {
  const frequency = contact.followUpFrequency || "none";
  const emails = normalizeEmails(contact);
  const interactions = Array.isArray(contact.interactions)
    ? contact.interactions.map(normalizeInteraction)
    : [];
  const sortedInteractions = [...interactions].sort((a, b) => b.date.localeCompare(a.date));
  const latestDate = sortedInteractions[0]?.date || "";
  const lastContacted = contact.lastContacted || latestDate || contact.dateMet || "";
  let nextReminder = contact.nextReminder || "";
  // ORB-130. Somebody you work with has no deadline, and this is the line that
  // enforces it. Clearing `nextReminder` in the toggle's handler was not enough:
  // `followUpFrequency` is deliberately kept so unticking restores the rhythm,
  // and this block would helpfully invent a new deadline from it on the very
  // same save. The digest reads `next_reminder` in SQL and never calls
  // getHealth, so that left a profile reading "Working together" and an email
  // saying they had gone quiet — ORB-69's split, reintroduced by a default.
  if (contact.workingTogether === true) {
    nextReminder = "";
  } else if (!nextReminder && frequency !== "none") {
    // Covers back-filling someone you met months ago: the cadence alone would
    // put the deadline in the past, so they get the grace window instead.
    nextReminder = firstDeadlineFor(lastContacted, frequency);
  }
  return {
    id: contact.id || makeId(),
    name: (contact.name || "").trim(),
    email: emails[0]?.address || "",
    emails,
    company: (contact.company || "").trim(),
    role: (contact.role || "").trim(),
    industry: (contact.industry || "").trim(),
    dateMet: contact.dateMet || "",
    lastContacted,
    followUpFrequency: frequency,
    // Only what the user actually chose is stored. A tier derived from the
    // interval is a display fallback (effectiveTier), not a saved answer —
    // persisting it would make ORB-57's "changed from the default" metric
    // unmeasurable, since every contact would look deliberately classified.
    tier: contact.tier || "",
    // ORB-93. One bit, set by pointing rather than classifying, and the reason
    // the tier above is on its way out (ORB-94). Stored, never inferred — the
    // moment something derives this, ORB-57's first metric stops measuring
    // anything, because every contact would look deliberately marked.
    starred: contact.starred === true,
    // ORB-130. A circumstance, not a schedule: you are already in touch, so
    // there is nothing for a cadence to measure. Stored, never inferred — the
    // app cannot see your Slack and guessing would be worse than not knowing.
    workingTogether: contact.workingTogether === true,
    // ORB-131. Free text. Matched against where YOU say you are, so both
    // strings coming from the same person is the whole mechanism.
    location: (contact.location || "").trim(),
    nextReminder,
    reminderEnabled: frequency !== "none" ? (contact.reminderEnabled !== false) : false,
    notes: (contact.notes || "").trim(),
    interests: (contact.interests || "").trim(),
    adviceGiven: (contact.adviceGiven || "").trim(),
    interactions: sortedInteractions,
    followUps: Array.isArray(contact.followUps)
      ? contact.followUps.map(normalizeFollowUpItem)
      : [],
    companyHistory: Array.isArray(contact.companyHistory)
      ? contact.companyHistory.map((c) => String(c).trim()).filter(Boolean)
      : []
  };
}

// ── Reminder helpers ──────────────────────────────────────────────────────────

function getReminderStatus(contact) {
  if (!contact.reminderEnabled || contact.followUpFrequency === "none" || !contact.nextReminder) {
    return "none";
  }
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 86400000);
  const next = new Date(contact.nextReminder);
  if (next <= now) return "due";
  if (next <= soon) return "soon";
  return "ok";
}

/**
 * One-line preview of the most recent conversation, falling back to the
 * contact-level note. The log is a record of conversations, so what was said
 * most recently is the useful thing to surface.
 */
function conversationPreview(contact, limit = 150) {
  const latest = (contact.interactions || [])
    .filter((i) => i.notes)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  // ORB-102. A conversation whose whole content is an attachment used to fall
  // through to the contact's own notes, or to nothing — so the row said less
  // than the app knew.
  const withFile = (contact.interactions || [])
    .filter((i) => (i.fileIds || []).length)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const text = latest?.notes
    || (withFile && !latest ? conversationHeadline(withFile, []) || "" : "")
    || contact.notes || "";
  const clips = (contact.interactions || [])
    .reduce((n, i) => n + ((i.fileIds || []).length), 0);
  // A conversation logged with only a PDF and no notes used to render nothing
  // here, which is the same "did that save?" problem as ORB-14.
  if (!text && !clips) return "";
  const count = conversationsOf(contact).length;
  return '<p class="connection-note">'
    + (latest ? '<span class="convo-count">' + count
        + (count === 1 ? " conversation" : " conversations") + '</span> ' : '')
    + (clips ? '<span class="convo-count">📎 ' + clips + '</span> ' : '')
    + escapeHtml(stripNoteMarks(text).slice(0, limit))
    + (stripNoteMarks(text).length > limit ? "…" : "")
    + '</p>';
}

/** Which cadence bucket a contact falls in, for filtering. */
function cadenceKey(contact) {
  const freq = contact.followUpFrequency || "none";
  if (!contact.reminderEnabled || freq === "none") return "none";
  return freq.startsWith("custom:") ? "custom" : freq;
}

// ── Shared filter definitions ─────────────────────────────────────────────────
// Used by every page that lists connections, so the same question is asked the
// same way everywhere.

const STARRED_FILTER = { key: "starred", label: "Starred", options: [
  { value: "", label: "Everyone" },
  { value: "1", label: "Starred only" }
] };

const CADENCE_FILTER = { key: "cadence", label: "Cadence", options: [
  { value: "", label: "Any cadence" },
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Every month" },
  { value: "bimonthly", label: "Every 2 months" },
  { value: "quarterly", label: "Every 3 months" },
  { value: "custom", label: "Custom" },
  { value: "none", label: "No cadence set" }
] };

const STATUS_FILTER = { key: "status", label: "Connection health", options: [
  { value: "", label: "Any health" },
  { value: "good", label: "In touch" },
  { value: "warning", label: "Going quiet" },
  { value: "critical", label: "Long silence" },
  { value: "none", label: "Not measured" }
] };

/** Answers "who have I not spoken to in a while?" */
const SILENCE_FILTER = { key: "silent", label: "Last spoke", options: [
  { value: "", label: "Any time" },
  { value: "30", label: "Over a month ago" },
  { value: "90", label: "Over 3 months ago" },
  { value: "180", label: "Over 6 months ago" },
  { value: "365", label: "Over a year ago" }
] };

/** True when a contact passes the cadence / health / silence filters. */
function matchesConnectionFilters(contact, { cadence, status, silent, starred }) {
  // "Starred only" is a filter; there is deliberately no "unstarred only". An
  // outline star means the question was never answered, so a list of them is a
  // list of nothing in particular (ORB-93).
  if (starred === "1" && contact.starred !== true) return false;
  if (cadence && cadenceKey(contact) !== cadence) return false;
  if (status && getHealth(contact).band !== status) return false;
  if (silent) {
    const elapsed = daysSince(contact.lastContacted || contact.dateMet);
    if (elapsed === null || elapsed < Number(silent)) return false;
  }
  return true;
}

/**
 * Scheduled connections that have slipped — starred first, then most overdue.
 *
 * The star is a statement about who matters, so it belongs ahead of the clock
 * rather than beside it (ORB-93). Within each group the old ordering is
 * untouched, so nothing is hidden: a starred person who is barely drifting
 * still sits above an unstarred one who is badly overdue, which is the point.
 *
 * ORB-92 will replace the second term with a trigger. It should keep the first.
 */
function needsAttention(contacts) {
  return contacts
    .map((c) => {
      const health = getHealth(c);
      return { contact: c, health, reason: reachOutReason(c, health) };
    })
    // ORB-81 and ORB-91. A reason outranks a cadence and does not need one: a
    // thought you caught at 2am, a conversation two days old, an anniversary —
    // none of these wait for a timer, and someone with no schedule at all can
    // land here on any of them. `elapsed` and `first-contact` are not reasons
    // that stand on their own; they describe a person the clock already put
    // here, so they still require a lapsed cadence.
    .filter((x) => reasonRank(x.reason) < REACH_OUT_REASONS.indexOf("first-contact")
      || (x.health.scheduled && x.health.band !== "good"))
    // ORB-92. Trigger before timer, which is the whole bet: Survey 1 found 1 in
    // 5 acted on a reminder they set themselves. The clock is demoted to the
    // fallback that catches everyone no trigger fired for — which will be most
    // people, so it is not removed.
    .sort((a, b) => reasonRank(a.reason) - reasonRank(b.reason)
      || (b.contact.starred === true) - (a.contact.starred === true)
      || a.health.pct - b.health.pct);
}

function countByBand(contacts) {
  // `starredCritical` is not a band — it is a subset of `critical`, kept
  // separate so the dashboard can say how many of the people past their date
  // are ones you actually said mattered (ORB-54). Adding it as a band would
  // break every denominator on the page.
  const counts = { good: 0, warning: 0, critical: 0, none: 0, starredCritical: 0 };
  contacts.forEach((c) => {
    const health = getHealth(c);
    counts[health.band]++;
    if (health.band === "critical" && health.starred) counts.starredCritical++;
  });
  return counts;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function initSidebarToggle() {
  const btn = document.getElementById("sidebarToggleBtn");
  const brand = document.getElementById("sidebarBrand");
  const sidebar = document.querySelector(".sidebar");
  if (!btn || !sidebar) return;

  const mobileQuery = window.matchMedia("(max-width: 992px)");
  let overlay = document.querySelector(".mobile-nav-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "mobile-nav-overlay";
    document.body.appendChild(overlay);
  }

  const closeMobileNav = () => {
    document.body.classList.remove("mobile-nav-open");
    btn.setAttribute("aria-expanded", "false");
  };
  const openMobileNav = () => {
    document.body.classList.add("mobile-nav-open");
    btn.setAttribute("aria-expanded", "true");
  };

  const handleDesktopState = () => {
    if (mobileQuery.matches) {
      sidebar.classList.remove("collapsed");
      btn.setAttribute("aria-expanded", document.body.classList.contains("mobile-nav-open") ? "true" : "false");
      return;
    }
    closeMobileNav();
    if (localStorage.getItem("orbit_sidebar_collapsed") === "true") sidebar.classList.add("collapsed");
    btn.setAttribute("aria-expanded", sidebar.classList.contains("collapsed") ? "false" : "true");
  };

  handleDesktopState();
  mobileQuery.addEventListener("change", handleDesktopState);

  const setCollapsed = (collapsed) => {
    sidebar.classList.toggle("collapsed", collapsed);
    localStorage.setItem("orbit_sidebar_collapsed", String(collapsed));
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };

  // The « button closes it; the logo re-opens it (and shows » on hover).
  btn.addEventListener("click", () => {
    if (mobileQuery.matches) {
      if (document.body.classList.contains("mobile-nav-open")) closeMobileNav();
      else openMobileNav();
      return;
    }
    setCollapsed(true);
  });

  brand?.addEventListener("click", () => {
    if (mobileQuery.matches) {
      if (document.body.classList.contains("mobile-nav-open")) closeMobileNav();
      else openMobileNav();
      return;
    }
    // Only acts as a re-open affordance; when expanded the logo is inert.
    if (sidebar.classList.contains("collapsed")) setCollapsed(false);
  });

  overlay.addEventListener("click", closeMobileNav);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMobileNav(); });

  sidebar.querySelectorAll(".s-link, .s-sublink").forEach((link) => {
    link.addEventListener("click", () => { if (mobileQuery.matches) closeMobileNav(); });
  });
}

/**
 * The sub-menu caret.
 *
 * Whether it starts open is decided by the inline script before first paint —
 * doing it here meant the menu rendered closed and then expanded, and since
 * every page is a full page load, Files blinked on every navigation.
 *
 * This only wires the toggle and keeps aria in step. `open` and `closed` are
 * both explicit so a choice made this session beats the remembered default in
 * either direction.
 */
function initNavDropdown() {
  const remembered = document.body.classList.contains("nav-open");

  document.querySelectorAll(".s-group").forEach((group) => {
    const caret = group.querySelector(".s-caret");
    if (!caret) return;

    // A sub-page being current still forces it open, whatever was remembered.
    if (group.querySelector(".s-sublink.active")) group.classList.add("open");

    const isOpen = () => group.classList.contains("open")
      || (remembered && !group.classList.contains("closed"));

    caret.setAttribute("aria-expanded", String(isOpen()));

    caret.addEventListener("click", (e) => {
      e.preventDefault();
      const next = !isOpen();
      group.classList.toggle("open", next);
      group.classList.toggle("closed", !next);
      caret.setAttribute("aria-expanded", String(next));
      localStorage.setItem("orbit_nav_open", String(next));
    });
  });
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme() {
  // Fall back to the pre-rename key so an existing dark preference survives.
  const theme = localStorage.getItem("orbit_theme")
    || localStorage.getItem("interntrack_theme")
    || "light";
  document.body.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

// ── Talking-point suggestions ─────────────────────────────────────────────────

const INTERACTION_TYPES = ["coffee chat", "meeting", "check-in", "email", "phone call", "event"];

/**
 * A reach-out you recorded with the button rather than by writing it up (ORB-96).
 *
 * `markReachedOut` used to move `lastContacted` and nothing else, so pressing
 * the button twenty times left the app believing you had never spoken. That
 * made `interactions` mean "times you wrote something down" while every
 * surface read it as "times you were in touch" — ORB-80's ledger most of all,
 * which exists precisely to show what has accumulated and was counting a
 * fraction of it.
 *
 * NOT the same mistake ORB-73 fixed. That bug fabricated a conversation you
 * never had, on a day you merely added someone. This records something you did
 * — you said so by pressing the button — and records it as what it is. It
 * carries no notes and never will, so nothing downstream can quote it as
 * though you had written one.
 *
 * Deliberately not in INTERACTION_TYPES: it is not an answer to "what kind of
 * conversation was this?", so it must not appear in the picker.
 */
const TOUCHPOINT_TYPE = "reached out";

function isTouchpoint(item) {
  return item?.type === TOUCHPOINT_TYPE;
}

/** Conversations proper — what you actually wrote up. */
function conversationsOf(contact) {
  return (contact.interactions || []).filter((i) => !isTouchpoint(i));
}

/**
 * What may be attached to a conversation or uploaded to Files.
 *
 * Images matter as much as PDFs here: notes taken by hand exist as a photo on a
 * phone, and refusing those meant the most common way people actually take
 * notes could not be filed at all.
 *
 * HEIC is what an iPhone produces by default. Browsers cannot render it, so it
 * uploads and downloads fine but will not preview — worth accepting anyway
 * rather than rejecting the file someone actually has.
 */
const ATTACH_ACCEPT = ".pdf,application/pdf,image/*,.heic,.heif";

function isAllowedAttachment(file) {
  if (!file) return false;
  const type = (file.type || "").toLowerCase();
  if (type === "application/pdf" || type.startsWith("image/")) return true;
  // Some browsers report an empty type for .heic — fall back to the extension.
  return /\.(pdf|jpe?g|png|gif|webp|heic|heif)$/i.test(file.name || "");
}

const ATTACH_REJECT_MSG = "Attach a PDF or an image (a photo of handwritten notes is fine).";

function isImageFile(file) {
  const name = (file.name || "").toLowerCase();
  return /\.(jpe?g|png|gif|webp|heic|heif|avif)$/.test(name);
}

function generateFollowUpSuggestions(contact) {
  const name = contact.name || "them";
  const sentences = [];

  // ORB-121: each sentence remembers which conversation it was lifted from, so
  // the point it becomes can say where it came from. Sentences taken from the
  // contact's own notes have no conversation behind them and carry "".
  for (const interaction of (contact.interactions || []).slice(0, 3)) {
    if (!interaction.notes) continue;
    stripNoteMarks(interaction.notes).split(/[.!?\n]+/).forEach((s) => {
      const trimmed = s.trim();
      if (trimmed.length > 8) {
        sentences.push({ text: trimmed, source: "interaction", interactionId: interaction.id || "" });
      }
    });
  }
  if (contact.notes) {
    contact.notes.split(/[.!?\n]+/).forEach((s) => {
      const trimmed = s.trim();
      if (trimmed.length > 8) sentences.push({ text: trimmed, source: "notes", interactionId: "" });
    });
  }
  if (!sentences.length) {
    return [{ text: "Send " + name + " a quick check-in message", sourceInteractionId: "" }];
  }

  const actionWords = /\b(mentioned|said|working on|planning|considering|wants to|will|might|should|asked|wondering|interested in|excited about|worried about|discussed|brought up|follow up|check back|update|revisit|explore|look into|thinking about|decided|going to|hope|looking for|applied|interviewing|offered|accepted|waiting|heard back|need to|want to)\b/i;

  const scored = sentences.map((s) => ({
    ...s,
    score: (actionWords.test(s.text) ? 2 : 0) + (s.source === "interaction" ? 1 : 0)
  }));
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const suggestions = [];
  for (const s of scored) {
    const key = s.text.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      text: "Follow up on: " + s.text.charAt(0).toUpperCase() + s.text.slice(1),
      sourceInteractionId: s.interactionId || ""
    });
    if (suggestions.length >= 5) break;
  }
  return suggestions;
}

// ── Render helpers ────────────────────────────────────────────────────────────

/**
 * Where a point came from, when it came from somewhere (ORB-121).
 *
 * Only rendered when `sourceInteractionId` resolves to a conversation that
 * still exists — a conversation deleted under ORB-64 leaves the id dangling,
 * and "from a conversation that is no longer here" is worse than silence.
 */
function followUpOriginLabel(item, contact) {
  if (!item.sourceInteractionId) return "";
  const from = (contact?.interactions || [])
    .find((i) => i.id === item.sourceInteractionId);
  return from?.date ? "from " + relativeDayLabel(from.date) : "";
}

/**
 * Which of the four kinds of thing this is (ORB-105).
 *
 * Four of the twenty-two items in the 20 Aug session are one problem: "the
 * thought goes to the checklist. Not sure if that's the right place." ORB-81
 * shipped the capture input without its output being legible — a thought caught
 * at 2am arrived here as an unlabelled line among talking points, so the list
 * showed four different kinds of item and told you apart from none of them.
 *
 * ONLY WHAT YOU DID NOT TYPE IS TAGGED. A point you wrote in the box at the
 * bottom needs no label saying you wrote it; a tag on every row would be noise
 * on the majority to explain the minority.
 *
 * "You noted" is the dashboard's exact wording for the same thing (ORB-90), not
 * a synonym. Two words for one concept is the ORB-74 failure in miniature.
 */
const FOLLOWUP_TAGS = {
  capture: { label: "You noted", cls: "fu-tag-capture" },
  ai: { label: "Suggested", cls: "fu-tag-ai" }
};

function followUpTagHtml(item) {
  const tag = FOLLOWUP_TAGS[item.source];
  if (!tag) return "";
  return '<span class="fu-tag ' + tag.cls + '">' + escapeHtml(tag.label) + '</span>';
}

function followUpItemHtml(item, contact) {
  const origin = followUpOriginLabel(item, contact);
  return [
    '<div class="followup-item ' + (item.completed ? "followup-done" : "") + '" data-fu-id="' + item.id + '">',
    '  <label class="followup-check">',
    '    <input type="checkbox" class="fu-checkbox" data-fu-id="' + item.id + '" ' + (item.completed ? "checked" : "") + ' />',
    '    <span class="followup-text">' + followUpTagHtml(item) + escapeHtml(item.text)
      + (origin ? ' <span class="followup-origin">' + escapeHtml(origin) + '</span>' : '')
      + '</span>',
    '  </label>',
    '  <button class="fu-delete" type="button" data-fu-id="' + item.id + '" title="Delete" aria-label="Delete talking point">✕</button>',
    '</div>'
  ].join("\n");
}

/**
 * The list becomes a filter rather than an archive (ORB-122).
 *
 * Sorting by completed-last was the whole lifecycle: a point raised before a
 * conversation that has since happened sat exactly where it did the day it was
 * written, indistinguishable from one raised this morning. Three groups say
 * which is which, and nothing is deleted to achieve it — the ORB-64 rule holds
 * here too.
 *
 * HEADINGS ONLY WHEN THERE IS SOMETHING TO SEPARATE. The PRD's own risk was
 * that grouping makes a short list feel longer: three headings over four items
 * is furniture, not structure. A single non-empty group renders flat, exactly
 * as it did before this ticket.
 */
function renderFollowUpItems(contact) {
  const items = contact?.followUps || [];
  if (!items.length) {
    return '<p class="empty">No talking points yet. Add one, or use Suggest.</p>';
  }
  const groups = groupFollowUps(contact);
  const filled = FOLLOWUP_GROUPS.filter((g) => groups[g.key].length);
  const headings = filled.length > 1;
  return filled.map((g) =>
    (headings
      ? '<h4 class="followup-group">' + escapeHtml(g.label)
        + ' <span class="followup-group-count">' + groups[g.key].length + '</span></h4>'
      : '')
    + groups[g.key].map((item) => followUpItemHtml(item, contact)).join("\n")
  ).join("\n");
}

/**
 * A document tile: rendered page preview on top, name and actions underneath.
 * The preview is an <object> pointing at the PDF — browsers render page one
 * natively, so there is no PDF library to load.
 */
function renderStorageFileCard(file, contact) {
  const dateStr = file.createdAt ? new Date(file.createdAt).toLocaleDateString() : "";
  const previewUrl = file.fileUrl
    ? escapeHtml(file.fileUrl) + "#toolbar=0&navpanes=0&scrollbar=0&view=FitH"
    : "";
  return '<article class="doc-tile" data-file-id="' + escapeHtml(file.id) + '">'
    + '<div class="doc-preview" role="button" tabindex="0"'
    + ' data-file-url="' + escapeHtml(file.fileUrl) + '" aria-label="Open ' + escapeHtml(file.name) + '">'
    // An <object type="application/pdf"> renders page one of a PDF natively but
    // shows nothing for a photo, so images get a real <img>. HEIC lands here
    // too and will fail to decode — onerror leaves the placeholder rather than
    // a broken-image icon.
    + (!file.fileUrl
      ? '<div class="doc-preview-fallback">📄</div>'
      : isImageFile(file)
        ? '<img class="doc-preview-img" src="' + escapeHtml(file.fileUrl) + '" alt=""'
          + ' loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),'
          + '{className:\'doc-preview-fallback\',textContent:\'🖼\'}))" />'
        : '<object class="doc-preview-frame" data="' + previewUrl + '" type="application/pdf">'
          + '<div class="doc-preview-fallback">📄</div></object>')
    + '<span class="doc-preview-veil"></span>'
    + '</div>'
    + '<div class="doc-foot">'
    + '<p class="doc-name" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</p>'
    + '<p class="doc-meta">'
    + (contact ? escapeHtml(contact.name) : '<span class="muted">Not linked</span>')
    + (dateStr ? ' · ' + dateStr : '')
    + '</p>'
    + '<div class="doc-actions">'
    + '<button class="doc-act doc-rename" type="button" data-file-id="' + escapeHtml(file.id) + '"'
    + ' data-file-name="' + escapeHtml(file.name) + '" title="Rename">Rename</button>'
    + '<button class="doc-act doc-open" type="button" data-file-url="' + escapeHtml(file.fileUrl) + '" title="Open">Open</button>'
    + '<button class="doc-act doc-delete" type="button" data-file-id="' + escapeHtml(file.id) + '"'
    + ' data-storage-path="' + escapeHtml(file.storagePath) + '" title="Delete">✕</button>'
    + '</div>'
    + '</div>'
    + '</article>';
}

function attachStorageFileCardListeners(container, onChange) {
  const open = (url) => { if (url) window.open(url, "_blank"); };

  container.querySelectorAll(".doc-preview").forEach((el) => {
    el.addEventListener("click", () => open(el.dataset.fileUrl));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(el.dataset.fileUrl); }
    });
  });
  container.querySelectorAll(".doc-open").forEach((btn) => {
    btn.addEventListener("click", () => open(btn.dataset.fileUrl));
  });

  container.querySelectorAll(".doc-rename").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tile = btn.closest(".doc-tile");
      const nameEl = tile.querySelector(".doc-name");
      if (tile.querySelector(".doc-rename-input")) return;

      const input = document.createElement("input");
      input.type = "text";
      input.className = "doc-rename-input";
      input.value = btn.dataset.fileName;
      input.setAttribute("aria-label", "File name");
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      let settled = false;
      const finish = async (save) => {
        if (settled) return;
        settled = true;
        const next = input.value.trim();
        if (save && next && next !== btn.dataset.fileName) {
          const updated = await db.renameStorageFile(btn.dataset.fileId, next);
          if (updated && onChange) { await onChange(); return; }
        }
        input.replaceWith(nameEl);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true));
    });
  });

  container.querySelectorAll(".doc-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!window.confirm("Delete this file? This cannot be undone.")) return;
      await db.deleteStorageFile(btn.dataset.fileId, btn.dataset.storagePath);
      if (onChange) await onChange();
    });
  });
}

/**
 * Each conversation is a <details> so it can be opened and closed.
 *
 * @param files  The contact's storage files, so attachments can be resolved from
 *               the ids on each interaction (ORB-20). Ids with no matching file
 *               are skipped — deleting a PDF from the Files page should leave the
 *               conversation intact, not a broken link.
 */
/**
 * The meeting name for a conversation (ORB-66).
 *
 * Synced conversations used to store `title + "\n\n" + notes` in one field, so
 * Orbit's words and the user's words were the same string: the title was read
 * back as a note preview, and editing your notes could delete the heading.
 *
 * `title` is its own key now — jsonb, so no migration. Rows written before this
 * still have it baked in, and there is no back-fill: the split happens at
 * display time and only for calendar-logged rows, because a hand-written note
 * whose first line is short is not a title.
 */
function conversationTitle(item) {
  if (item?.title) return item.title;
  if (!item?.sourceEventId) return "";
  const notes = item.notes || "";
  // The old writer produced either a bare title, or a title, a blank line, then
  // the note. Anything else is a note that merely starts with a short line.
  if (!notes.includes("\n")) return notes.trim();
  return /^[^\n]*\n\s*\n/.test(notes) ? notes.split("\n")[0].trim() : "";
}

/** The note text, with a legacy baked-in title taken back off the front. */
/**
 * What a conversation is called when the row is closed (ORB-102).
 *
 * The meeting name, else the first line of the notes, else **the file you
 * attached**. That last fallback is the ticket: ORB-20 made PDFs attachable and
 * a conversation carrying only a deck still rendered as "no notes", which reads
 * as a conversation you failed to write up rather than one you documented by
 * handing over the document.
 *
 * It is a fallback and not a promotion — a file never displaces words you
 * actually wrote. And it is the file NAME, not its contents: reading the PDF is
 * ORB-95, and this ticket deliberately does not open it.
 */
function conversationHeadline(item, attached = []) {
  const written = stripNoteMarks(
    conversationTitle(item) || (conversationNotes(item) || "").split("\n")[0]).trim();
  if (written) return written;
  const first = attached.find((f) => f && f.name);
  return first ? first.name : "";
}

function conversationNotes(item) {
  const notes = item?.notes || "";
  if (item?.title) return notes;              // already separate
  const title = conversationTitle(item);
  if (!title) return notes;
  return notes.slice(title.length).replace(/^\s*\n\s*\n?/, "");
}

function renderInteractionTimeline(interactions, files = [], { name = "", dateMet = "" } = {}) {
  // An empty history is a beginning, not a fault (ORB-75). "No conversations
  // logged yet." with nothing round it reads like something failed to load, and
  // it is the state every contact added through ORB-73 starts in — so it is a
  // normal view of the app rather than an edge case worth one flat sentence.
  if (!interactions || !interactions.length) {
    const who = name ? escapeHtml(name.split(" ")[0]) : "them";
    return '<div class="empty empty-first">'
      + '<p class="empty-lead">No conversations yet.</p>'
      + '<p class="tiny muted">'
      + (dateMet
        ? 'You met ' + who + ' ' + escapeHtml(relativeDayLabel(dateMet)) + '. '
        : '')
      + 'The first one you log will appear here.</p>'
      + '</div>';
  }
  const byId = new Map(files.map((f) => [f.id, f]));

  return interactions.map((item, i) => {
    const attached = (item.fileIds || []).map((id) => byId.get(id)).filter(Boolean);

    // What the closed row shows: the meeting name if there is one, otherwise
    // the first line of the notes. Markers are stripped either way — a note
    // opening with **Coffee with Marcus** should read as the meeting, not as
    // punctuation someone forgot to close.
    const shownTitle = conversationTitle(item);
    const shownNotes = conversationNotes(item);
    const headline = conversationHeadline(item, attached);

    const summary = '<summary class="convo-summary">'
      + '<span class="convo-caret" aria-hidden="true">▸</span>'
      + '<span class="convo-date">' + formatDate(item.date) + '</span>'
      + '<span class="tag">' + escapeHtml(item.type) + '</span>'
      + (headline
        ? '<span class="convo-headline">' + escapeHtml(headline) + '</span>'
        : '<span class="tiny muted">no notes</span>')
      // Flagged on the summary too, because a collapsed conversation would
      // otherwise hide the fact that anything is attached to it.
      + (attached.length
        ? '<span class="convo-clip" title="' + attached.length + ' attached">📎 ' + attached.length + '</span>'
        : '')
      + (item.sourceEventId
        ? '<span class="convo-source" title="Logged from your calendar">📅</span>'
        : '')
      + '</summary>';

    // Every conversation is editable. Before this, a saved conversation was
    // sealed — which mattered most for calendar-synced ones, whose notes start
    // as nothing but the event title and could never be filled in.
    const body = '<div class="convo-body" data-convo-id="' + escapeHtml(item.id) + '">'
      + (shownTitle
        ? '<p class="convo-title">' + escapeHtml(shownTitle) + '</p>' : '')
      + (shownNotes
        ? '<p class="convo-note">' + renderNotes(shownNotes) + '</p>'
        : '<p class="convo-note muted">No notes yet — what did you talk about?</p>')
      // Delete used to sit here, one slip away from the note it destroys. It
      // lives in the dialog now (ORB-64), where opening it is a deliberate act
      // and the button is the furthest thing from Save.
      + '<div class="convo-actions">'
      + '<button class="convo-edit" type="button" data-edit-convo="' + escapeHtml(item.id) + '">'
      // ORB-128. Was "Edit notes", and Delete lives inside this dialog (ORB-64)
      // — so somebody looking for a way to remove a conversation had no reason
      // to open the only thing that offers it. The dialog edits the date, the
      // type, the notes, the attachment and can delete the whole record, so the
      // label says that rather than naming one field of five.
      + 'Edit conversation' + '</button>'
      + '</div>'
      + '</div>';

    const attachments = attached.length
      ? '<ul class="convo-files">'
        + attached.map((f) => '<li><a class="convo-file" href="' + escapeHtml(f.fileUrl) + '"'
          + ' target="_blank" rel="noopener noreferrer">'
          + '<span class="convo-file-icon" aria-hidden="true">📄</span>'
          + '<span class="convo-file-name">' + escapeHtml(f.name) + '</span></a></li>').join("")
        + '</ul>'
      : '';

    // All collapsed. The headline carries enough to find the one you want, so
    // opening the newest by default just pushed everything else down the page.
    return '<details class="convo">' + summary + body + attachments + '</details>';
  }).join("\n");
}

/**
 * Every place already used in the network (ORB-131).
 *
 * Same shape as companyDatalist and here for a sharper reason: the in-town
 * trigger is a string comparison, so two spellings of one place are two places
 * and the prompt silently never fires. Suggesting what exists is cheaper than
 * normalising names nobody agrees on.
 */
function placeDatalist(contacts, id) {
  const places = [...new Set((contacts || [])
    .map((c) => (c.location || "").trim()).filter(Boolean))].sort();
  return '<datalist id="' + id + '">'
    + places.map((p) => '<option value="' + escapeHtml(p) + '"></option>').join("")
    + '</datalist>';
}

/** <datalist> of every company already in the network, for autocomplete. */
function companyDatalist(contacts, id) {
  const names = new Set();
  contacts.forEach((c) => {
    if (c.company) names.add(c.company);
    (c.companyHistory || []).forEach((co) => names.add(co));
  });
  return '<datalist id="' + id + '">'
    + [...names].sort().map((n) => '<option value="' + escapeHtml(n) + '"></option>').join("")
    + '</datalist>';
}

function industryDatalist(contacts, id) {
  const names = new Set();
  contacts.forEach((c) => { if (c.industry) names.add(c.industry); });
  const common = ["Technology", "Finance", "Healthcare", "Consulting", "Education",
                  "Media", "Retail", "Non-profit", "Government", "Real Estate"];
  common.forEach((n) => names.add(n));
  return '<datalist id="' + id + '">'
    + [...names].sort().map((n) => '<option value="' + escapeHtml(n) + '"></option>').join("")
    + '</datalist>';
}

// ── Filter bar ────────────────────────────────────────────────────────────────
// Search field + funnel button that opens a card of filters. Shared by My
// Network, the Networking Log and Files so all three behave identically.

/**
 * @param opts.placeholder  search input placeholder
 * @param opts.filters      [{ key, label, options:[{value,label}] }]
 */
function filterBarHtml({ placeholder, filters }) {
  return '<div class="filter-bar">'
    + '<input type="search" class="fb-search" placeholder="' + escapeHtml(placeholder) + '"'
    + ' aria-label="' + escapeHtml(placeholder) + '" />'
    + '<div class="fb-anchor">'
    + '<button class="fb-toggle" type="button" aria-expanded="false" aria-haspopup="dialog" title="Filters">'
    + '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
    + '<line x1="2" y1="4" x2="14" y2="4" /><line x1="4" y1="8" x2="12" y2="8" />'
    + '<line x1="6" y1="12" x2="10" y2="12" /></svg>'
    + '<span class="visually-hidden">Filters</span>'
    + '<span class="fb-badge" hidden></span>'
    + '</button>'
    + '<div class="fb-pop" role="dialog" aria-label="Filters" hidden>'
    + '<div class="fb-pop-head"><h3>Filters</h3>'
    + '<button class="icon-btn fb-close" type="button" aria-label="Close">✕</button></div>'
    + filters.map((f) =>
        '<div class="field-group"><label for="fb-' + f.key + '">' + escapeHtml(f.label) + '</label>'
        + '<select id="fb-' + f.key + '" data-filter-key="' + f.key + '">'
        + f.options.map((o) => '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>').join("")
        + '</select></div>').join("")
    + '<button class="btn btn-secondary btn-sm fb-clear" type="button">Clear all</button>'
    + '</div>'
    + '</div>'
    + '<span class="fb-count"></span>'
    + '</div>';
}

/**
 * Wires a filter bar. `onChange` receives { q, <filterKey>: value, … }.
 * Returns { setOptions, setCount, values } for the host page to drive.
 */
function wireFilterBar(root, onChange) {
  const bar = root.querySelector(".filter-bar");
  if (!bar) return null;

  const search = bar.querySelector(".fb-search");
  const toggle = bar.querySelector(".fb-toggle");
  const pop = bar.querySelector(".fb-pop");
  const badge = bar.querySelector(".fb-badge");
  const countEl = bar.querySelector(".fb-count");
  const selects = [...bar.querySelectorAll("[data-filter-key]")];

  const values = () => {
    const out = { q: search.value.trim().toLowerCase() };
    selects.forEach((s) => { out[s.dataset.filterKey] = s.value; });
    return out;
  };

  const refreshBadge = () => {
    const active = selects.filter((s) => s.value).length;
    badge.hidden = active === 0;
    badge.textContent = String(active);
    toggle.classList.toggle("fb-active", active > 0);
  };

  const setOpen = (open) => {
    pop.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(pop.hidden);
  });
  bar.querySelector(".fb-close").addEventListener("click", () => setOpen(false));
  pop.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

  const fire = () => { refreshBadge(); onChange(values()); };
  search.addEventListener("input", fire);
  selects.forEach((s) => s.addEventListener("change", fire));
  bar.querySelector(".fb-clear").addEventListener("click", () => {
    selects.forEach((s) => { s.value = ""; });
    fire();
  });

  return {
    values,
    setCount(text) { countEl.textContent = text; },
    /** Populate a select's options from the data, keeping the current choice. */
    setOptions(key, options) {
      const sel = selects.find((s) => s.dataset.filterKey === key);
      if (!sel) return;
      const keep = sel.value;
      const first = sel.options[0];
      sel.innerHTML = "";
      sel.appendChild(first);
      options.forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o;
        opt.textContent = o;
        sel.appendChild(opt);
      });
      sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
      refreshBadge();
    }
  };
}

// ── Capture widget ────────────────────────────────────────────────────────────
// One form, used inline on the Networking Log and inside the dashboard modal.
// Fields use classes, not ids, so two copies can coexist on a page.

// ── Conversation widget ───────────────────────────────────────────────────────
/**
 * The conversation logger.
 *
 * One form for both jobs: if the name matches someone you already know, pick
 * them from the dropdown and their details fill themselves in — all you write
 * is the conversation. If they are new, you fill the details once and the first
 * conversation is logged with them.
 *
 * Fields are addressed by class, not id, so the inline copy on the Networking
 * Log and the copy inside the quick-add modal can coexist on one page.
 */
function conversationWidgetHtml() {
  const freqOptions = Object.entries(FREQUENCY_LABELS)
    .map(([v, l]) => '<option value="' + v + '"' + (v === "monthly" ? " selected" : "") + '>' + l + '</option>')
    .join("");

  return '<form class="cw-form" autocomplete="off">'

    // ── Who ──────────────────────────────────────────────────────────────
    + '<div class="cw-person">'
    + '<div class="cw-grid">'
    + '<div class="field-group cw-name-field">'
    + '<label>Who did you speak with? <span class="required">*</span></label>'
    + '<div class="combo">'
    + '<input type="text" class="cw-name" placeholder="Start typing a name…" required'
    + ' role="combobox" aria-autocomplete="list" aria-expanded="false" />'
    + '<ul class="combo-list" role="listbox" hidden></ul>'
    + '</div>'
    + '</div>'
    + '<div class="field-group"><label>Role / Title</label>'
    + '<input type="text" class="cw-role" placeholder="Product Manager" /></div>'
    + '<div class="field-group"><label>Company</label>'
    + '<input type="text" class="cw-company" placeholder="Where they work" /></div>'
    + '<div class="field-group"><label>Email</label>'
    + '<input type="email" class="cw-email" placeholder="email@example.com" /></div>'
    // ORB-94 removed the tier picker here too. Logging a conversation is the
    // worst place of the three to be asked to classify a relationship — you are
    // mid-thought about what was said, not about what the person is to you.
    + '<div class="field-group"><label>Reach out again?</label>'
    + '<select class="cw-freq">' + freqOptions
    + '<option value="custom">Custom…</option></select>'
    + '<div class="cw-custom hidden">'
    + '<input type="number" class="cw-custom-days" min="1" max="365" placeholder="45" aria-label="Every how many days" />'
    + '<span class="cw-custom-unit">days</span>'
    + '</div></div>'
    + '</div>'
    + '<p class="cw-linked hidden">'
    + '<span class="cw-linked-text"></span>'
    + '<button type="button" class="cw-unlink">Not them — start a new person</button>'
    + '</p>'
    + '</div>'

    // ── The conversation ─────────────────────────────────────────────────
    + '<div class="cw-convo">'
    + '<div class="cw-convo-head">'
    + '<div class="field-group"><label>When</label>'
    + '<input type="date" class="cw-date" required /></div>'
    + '<div class="field-group"><label>Type</label>'
    + '<select class="cw-type">'
    + INTERACTION_TYPES.map((t) => '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>').join("")
    + '</select></div>'
    + '</div>'
    + '<div class="field-group"><label>What did you talk about?</label>'
    + notesEditorHtml({
        className: "cw-notes",
        placeholder: "What they are working on, what they said, anything you want to bring up next time…"
      })
    + '</div>'
    + '<div class="field-group"><label>Attach a PDF <span class="opt-label">(optional)</span></label>'
    + '<input type="file" class="cw-file" accept="' + ATTACH_ACCEPT + '" /></div>'
    + '</div>'

    + '<p class="error cw-error" aria-live="polite"></p>'
    + '<p class="success cw-success" aria-live="polite"></p>'
    + '<button type="submit" class="btn cw-submit">Save conversation</button>'
    + '</form>';
}

/**
 * @param getContacts  () => contacts, read fresh so the dropdown stays current
 * @param onSaved      called after a successful save
 */
function wireConversationWidget(root, getContacts, onSaved) {
  const form = root.querySelector(".cw-form");
  if (!form) return;

  const $ = (sel) => form.querySelector(sel);
  const nameEl = $(".cw-name");
  const listEl = $(".combo-list");
  const linkedEl = $(".cw-linked");
  const freqEl = $(".cw-freq");
  const customWrap = $(".cw-custom");
  const dateEl = $(".cw-date");

  if (dateEl && !dateEl.value) dateEl.value = todayDateString();

  // The toolbar shipped into the edit dialog and nowhere else, so formatting
  // existed in one of the three places a note gets written. Wired here it
  // covers both the Networking Log page and the quick-add modal, which are the
  // same markup rendered twice.
  const notesEl = $(".cw-notes");
  const notesApi = notesEl ? wireNotesEditor(form, notesEl) : null;

  let linkedId = null;   // set once an existing contact is chosen
  let active = -1;       // highlighted row in the dropdown

  freqEl.addEventListener("change", () => {
    customWrap.classList.toggle("hidden", freqEl.value !== "custom");
    if (freqEl.value === "custom") $(".cw-custom-days").focus();
  });

  // ── Autocomplete ─────────────────────────────────────────────────────
  const closeList = () => {
    listEl.hidden = true;
    listEl.innerHTML = "";
    active = -1;
    nameEl.setAttribute("aria-expanded", "false");
  };

  const setLinked = (contact) => {
    linkedId = contact ? contact.id : null;
    linkedEl.classList.toggle("hidden", !contact);
    if (contact) {
      linkedEl.querySelector(".cw-linked-text").textContent =
        "Adding to " + contact.name + "'s history — " +
        (contact.interactions?.length || 0) + " conversation" +
        ((contact.interactions?.length || 0) === 1 ? "" : "s") + " so far.";
    }
    // Details of a known person are theirs to correct, not to re-enter.
    [".cw-role", ".cw-company", ".cw-email"].forEach((sel) =>
      form.querySelector(sel).classList.toggle("cw-prefilled", Boolean(contact)));
  };

  const choose = (contact) => {
    nameEl.value = contact.name;
    $(".cw-role").value = contact.role || "";
    $(".cw-company").value = contact.company || "";
    $(".cw-email").value = contact.email || "";

    // Mirror their existing cadence so saving does not silently change it.
    const freq = contact.followUpFrequency || "none";
    if (freq.startsWith("custom:")) {
      freqEl.value = "custom";
      customWrap.classList.remove("hidden");
      $(".cw-custom-days").value = freq.slice(7);
    } else {
      freqEl.value = freq;
      customWrap.classList.add("hidden");
    }
    setLinked(contact);
    closeList();
    $(".cw-notes").focus();
  };

  const renderList = () => {
    const q = nameEl.value.trim().toLowerCase();
    if (!q) return closeList();

    const matches = (getContacts() || [])
      .filter((c) => c.name && c.name.toLowerCase().includes(q))
      .slice(0, 6);

    if (!matches.length) return closeList();

    listEl.innerHTML = matches.map((c, i) =>
      '<li class="combo-item" role="option" data-id="' + escapeHtml(c.id) + '"'
      + (i === active ? ' aria-selected="true"' : '') + '>'
      + '<span class="combo-avatar" aria-hidden="true">' + escapeHtml(initialsFor(c.name)) + '</span>'
      + '<span class="combo-main">'
      + '<span class="combo-name">' + escapeHtml(c.name) + '</span>'
      + '<span class="combo-sub">' + escapeHtml(c.role || "Role not set")
      + (c.company ? " @ " + escapeHtml(c.company) : "") + '</span>'
      + '</span>'
      + '<span class="combo-last">' + escapeHtml(relativeDayLabel(c.lastContacted)) + '</span>'
      + '</li>').join("");
    listEl.hidden = false;
    nameEl.setAttribute("aria-expanded", "true");

    listEl.querySelectorAll(".combo-item").forEach((li) => {
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();               // keep focus off the blur handler
        const match = (getContacts() || []).find((c) => c.id === li.dataset.id);
        if (match) choose(match);
      });
    });
  };

  nameEl.addEventListener("input", () => {
    // Typing a different name means you are no longer editing that person.
    if (linkedId) {
      const linked = (getContacts() || []).find((c) => c.id === linkedId);
      if (!linked || linked.name !== nameEl.value) setLinked(null);
    }
    renderList();
  });

  nameEl.addEventListener("keydown", (e) => {
    const items = [...listEl.querySelectorAll(".combo-item")];
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = e.key === "ArrowDown"
        ? Math.min(active + 1, items.length - 1)
        : Math.max(active - 1, 0);
      items.forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
      items[active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const match = (getContacts() || []).find((c) => c.id === items[active].dataset.id);
      if (match) choose(match);
    } else if (e.key === "Escape") {
      closeList();
    }
  });

  nameEl.addEventListener("blur", () => setTimeout(closeList, 120));
  form.querySelector(".cw-unlink").addEventListener("click", () => {
    setLinked(null);
    nameEl.focus();
  });

  // ── Save ─────────────────────────────────────────────────────────────
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errEl = $(".cw-error");
    const okEl = $(".cw-success");
    const submitBtn = $(".cw-submit");
    errEl.textContent = "";
    okEl.textContent = "";

    const name = nameEl.value.trim();
    if (!name) { errEl.textContent = "Who did you speak with?"; return; }

    const when = dateEl.value || todayDateString();
    let frequency = freqEl.value || "none";
    if (frequency === "custom") {
      const days = parseInt($(".cw-custom-days").value, 10);
      if (Number.isNaN(days) || days < 1) {
        errEl.textContent = "Enter how many days between reach-outs.";
        return;
      }
      frequency = "custom:" + days;
    }

    const notes = (notesApi ? notesApi.getMarks() : "").trim();

    const docFile = $(".cw-file")?.files?.[0] || null;
    if (docFile && !isAllowedAttachment(docFile)) {
      errEl.textContent = ATTACH_REJECT_MSG;
      return;
    }

    const interaction = normalizeInteraction({ date: when, type: $(".cw-type").value, notes });

    const existing = linkedId ? (getContacts() || []).find((c) => c.id === linkedId) : null;

    // A brand-new person has no id until the contact is saved, so the upload
    // cannot come first the way it does on the profile page. Saving first also
    // means a storage failure costs the attachment, never the conversation.
    if (docFile && existing) {
      const uploaded = await db.uploadFileToStorage(docFile, { contactId: existing.id });
      if (uploaded) interaction.fileIds = [uploaded.id];
    }

    const base = existing || {};
    const merged = [interaction, ...(existing?.interactions || [])]
      .sort((a, b) => b.date.localeCompare(a.date));
    const wasOff = !existing || !existing.reminderEnabled || existing.followUpFrequency === "none";

    const contact = normalizeContact({
      ...base,
      name,
      role: $(".cw-role").value,
      company: $(".cw-company").value,
      email: $(".cw-email").value,
      dateMet: existing?.dateMet || when,
      interactions: merged,
      lastContacted: merged[0].date,
      followUpFrequency: frequency,
      // ORB-94: the widget no longer asks, so an existing contact keeps
      // whatever tier they already had and a new one gets none.
      tier: base.tier || "",
      reminderEnabled: frequency !== "none",
      // A conversation puts the relationship on its normal rhythm. The grace
      // window only applies when a cadence is switched on without one.
      nextReminder: frequency === "none" ? ""
        : (notes || !wasOff)
          ? calculateNextReminder(merged[0].date, frequency)
          : firstDeadlineFor(merged[0].date, frequency)
    });

    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    const saved = await db.saveContact(contact);
    submitBtn.disabled = false;
    submitBtn.textContent = "Save conversation";

    if (!saved) {
      errEl.textContent = "Could not save. Open the console (F12) for the Supabase error.";
      return;
    }

    // The new-person case: the id only exists now, so upload and then link the
    // attachment onto the interaction in a second write.
    let result = saved;
    let attachmentFailed = Boolean(docFile) && !interaction.fileIds.length && Boolean(existing);
    if (docFile && !existing) {
      const uploaded = await db.uploadFileToStorage(docFile, { contactId: saved.id });
      if (uploaded) {
        const relinked = normalizeContact({
          ...saved,
          interactions: (saved.interactions || []).map((i) =>
            i.id === interaction.id ? { ...i, fileIds: [uploaded.id] } : i)
        });
        const patched = await db.saveContact(relinked);
        if (patched) result = patched;
        else attachmentFailed = true;
      } else {
        attachmentFailed = true;
      }
    }

    form.reset();
    // form.reset() knows nothing about a contenteditable, so without this the
    // note you just saved stays on screen and gets sent again with the next one.
    notesApi?.setMarks("");
    dateEl.value = todayDateString();
    customWrap.classList.add("hidden");
    setLinked(null);
    const confirmation = (existing
      ? "Conversation added to " + name + "."
      : name + " added, with your first conversation.")
      + (attachmentFailed ? " The PDF could not be attached." : "");
    okEl.textContent = confirmation;
    setTimeout(() => { okEl.textContent = ""; }, 3500);
    // Callers that destroy this form on save need the confirmation to outlive it.
    if (onSaved) await onSaved(result, { name, confirmation, isNew: !existing });
  });
}

function openQuickAddModal(contacts, onSaved) {
  document.getElementById("quickAddModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "quickAddModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card quick-add-card">'
    + '<div class="quick-add-header">'
    + '<h3>Log a conversation</h3>'
    + '<button class="icon-btn" id="quickAddClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + conversationWidgetHtml()
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#quickAddClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape" && !modal.querySelector(".combo-list:not([hidden])")) {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });

  // ORB-14: this modal used to print its confirmation into itself and then
  // remove itself 1.1s later, so the only feedback in the app was destroyed with
  // the DOM. Neither page that carries the + button lists conversations either,
  // so saving looked like nothing happened. Close first, then confirm outside —
  // and point at the one page that does show the thing you just wrote.
  wireConversationWidget(modal, () => contacts, async (saved, meta = {}) => {
    close();
    if (onSaved) await onSaved(saved);
    showToast(meta.confirmation || "Conversation saved.", {
      actionLabel: "View in log",
      href: "network.html",
      duration: 7000
    });
  });
  modal.querySelector(".cw-name")?.focus();
}

/**
 * Adding someone you have not spoken to (ORB-73).
 *
 * The + used to open the conversation logger and nothing else, so the only way
 * to get a person into Orbit was to record a conversation with them. Saving
 * always wrote an interaction and set `lastContacted` to its date, which meant
 * a cold relationship was stored as freshly contacted and read as healthy — the
 * exact failure the product exists to prevent, arriving through the front door.
 *
 * This form writes a person and nothing else. There are no conversation fields,
 * and their absence is the feature.
 */
function addConnectionFormHtml() {
  // ORB-128. Monthly used to be selected for you, so every contact arrived on a
  // schedule nobody had asked for and a health bar started counting down
  // immediately. Two interviews say the schedule is the part people do not
  // want; ORB-126 stopped it nagging, and this stops it being assumed.
  //
  // No cadence is now the default and the honest one. You get a health bar when
  // you decide you want one, and it starts from the day you decide.
  const freqOptions = Object.entries(FREQUENCY_LABELS)
    .map(([v, l]) => '<option value="' + v + '"' + (v === "none" ? " selected" : "") + '>' + l + '</option>')
    .join("");
  const defaultTier = tierForFrequency("monthly");

  return '<form class="ac-form" autocomplete="off">'
    + '<div class="ac-grid">'
    + '<div class="field-group ac-name-field">'
    + '<label for="acName">Their name <span class="required">*</span></label>'
    + '<div class="combo">'
    + '<input type="text" id="acName" class="ac-name" placeholder="Start typing a name…" required'
    + ' role="combobox" aria-autocomplete="list" aria-expanded="false" />'
    + '<ul class="combo-list" role="listbox" hidden></ul>'
    + '</div>'
    + '</div>'
    + '<div class="field-group"><label for="acRole">Role / Title</label>'
    + '<input type="text" id="acRole" class="ac-role" placeholder="Product Manager" /></div>'
    + '<div class="field-group"><label for="acCompany">Company</label>'
    + '<input type="text" id="acCompany" class="ac-company" placeholder="Where they work" /></div>'
    + '<div class="field-group"><label for="acEmail">Email</label>'
    + '<input type="email" id="acEmail" class="ac-email" placeholder="email@example.com" /></div>'
    + '</div>'

    // ORB-94 removed the tier picker that stood here. ORB-52 put it first
    // because "what kind of relationship is this" is answerable the moment you
    // meet someone and "how many days" is not — but Survey 1 found 3 of 5 could
    // not answer it either, and the two who could are now served by a star
    // (ORB-93) that costs one click and no taxonomy.
    //
    // The tier's interval no longer survives as the default either (ORB-128):
    // the cadence line starts at "no schedule", because a rhythm chosen for you
    // is the thing two interviews said nobody wants. TIERS and frequencyForTier
    // are kept for ORB-86, if it ever revives tiers as a suggestion.
    + '<p class="cadence-result tiny ac-cadence-line">'
    + '<span class="ac-cadence-text">' + escapeHtml(cadenceSentence("none")) + '</span> '
    + '<button type="button" class="link-btn ac-adjust">Adjust</button></p>'
    + '<div class="field-group hidden ac-freq-group">'
    + '<label for="acFrequency">Reach out again?</label>'
    + '<select id="acFrequency" class="ac-freq">' + freqOptions
    + '<option value="custom">Custom…</option></select>'
    + '<div class="ac-custom hidden">'
    + '<input type="number" class="ac-custom-days" min="1" max="365" placeholder="45"'
    + ' aria-label="Every how many days" />'
    + '<span class="ac-custom-unit">days</span>'
    + '</div></div>'

    // Optional, and said so twice — in the label and under it. "I do not
    // remember when we met" is the normal answer and must never block adding
    // someone. Empty is a valid, permanent value; it is never filled in with
    // today's date, because a guessed date is indistinguishable from a known
    // one once stored.


    // Optional, and said so twice — in the label and under it. "I do not
    // remember when we met" is the normal answer and must never block adding
    // someone. Empty is a valid, permanent value; it is never filled in with
    // today's date, because a guessed date is indistinguishable from a known
    // one once stored.
    //
    // It sits BELOW the cadence line on purpose (ORB-128). Knowing when you met
    // somebody starts nothing — no countdown, no health bar — so it reads as
    // the last optional detail rather than as the beginning of a schedule.
    + '<div class="field-group"><label for="acDateMet">When you met '
    + '<span class="opt-label">(optional)</span></label>'
    + '<input type="date" id="acDateMet" class="ac-datemet" />'
    + '<p class="tiny muted">Leave this blank if you do not remember — it is never guessed for you.</p></div>'

    + '<p class="error ac-error" aria-live="polite"></p>'
    + '<button type="submit" class="btn ac-submit">Add to my network</button>'
    + '</form>';
}

/**
 * @param getContacts  () => contacts, read fresh so the dropdown stays current
 * @param onSaved      called with the saved contact
 */
function wireAddConnectionForm(root, getContacts, onSaved) {
  const form = root.querySelector(".ac-form");
  if (!form) return;

  const $ = (sel) => form.querySelector(sel);
  const nameEl = $(".ac-name");
  const listEl = $(".combo-list");
  const freqEl = $(".ac-freq");
  const freqGroup = $(".ac-freq-group");
  const customWrap = $(".ac-custom");
  const errEl = $(".ac-error");

  let active = -1;

  const chosenFrequency = () => {
    if (freqEl.value !== "custom") return freqEl.value || "none";
    const days = parseInt($(".ac-custom-days").value, 10);
    return Number.isNaN(days) || days < 1 ? "" : "custom:" + days;
  };

  const refreshCadenceLine = () => {
    $(".ac-cadence-text").textContent = cadenceSentence(chosenFrequency());
  };

  // ORB-109. Latches open, matching the profile. It used to toggle, so a second
  // click hid the control you had just asked to see — and the documentation
  // asserted "once open it stays open", which was true of one surface and
  // written as the rule.
  $(".ac-adjust").addEventListener("click", () => {
    freqGroup.classList.remove("hidden");
    freqEl.focus();
  });

  freqEl.addEventListener("change", () => {
    customWrap.classList.toggle("hidden", freqEl.value !== "custom");
    if (freqEl.value === "custom") $(".ac-custom-days").focus();
    refreshCadenceLine();
  });
  $(".ac-custom-days").addEventListener("input", refreshCadenceLine);

  // ── Duplicate guard ──────────────────────────────────────────────────
  // The autocomplete is the whole of ORB-73's deduplication (§4 rules out
  // matching logic). Here it does the opposite job to the conversation
  // widget's: there, picking a match links the conversation onto an existing
  // person; here, a match means the person already exists and adding them
  // again is the mistake. So it offers their profile instead of prefilling.
  const closeList = () => {
    listEl.hidden = true;
    listEl.innerHTML = "";
    active = -1;
    nameEl.setAttribute("aria-expanded", "false");
  };

  const findExisting = (value) => {
    const q = String(value || "").trim().toLowerCase();
    if (!q) return null;
    return (getContacts() || []).find((c) => (c.name || "").trim().toLowerCase() === q) || null;
  };

  const alreadyThere = (contact) => {
    errEl.innerHTML = escapeHtml(contact.name) + ' is already in your network. '
      + '<a href="contact.html?id=' + encodeURIComponent(contact.id) + '">Open their profile</a>'
      + ' to log a conversation or edit their details.';
  };

  const renderList = () => {
    const q = nameEl.value.trim().toLowerCase();
    if (!q) return closeList();

    const matches = (getContacts() || [])
      .filter((c) => c.name && c.name.toLowerCase().includes(q))
      .slice(0, 6);

    if (!matches.length) return closeList();

    listEl.innerHTML = matches.map((c, i) =>
      '<li class="combo-item" role="option" data-id="' + escapeHtml(c.id) + '"'
      + (i === active ? ' aria-selected="true"' : '') + '>'
      + '<span class="combo-avatar" aria-hidden="true">' + escapeHtml(initialsFor(c.name)) + '</span>'
      + '<span class="combo-main">'
      + '<span class="combo-name">' + escapeHtml(c.name) + '</span>'
      + '<span class="combo-sub">' + escapeHtml(c.role || "Role not set")
      + (c.company ? " @ " + escapeHtml(c.company) : "") + '</span>'
      + '</span>'
      + '<span class="combo-last">Already added</span>'
      + '</li>').join("");
    listEl.hidden = false;
    nameEl.setAttribute("aria-expanded", "true");

    listEl.querySelectorAll(".combo-item").forEach((li) => {
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const match = (getContacts() || []).find((c) => c.id === li.dataset.id);
        if (match) {
          nameEl.value = match.name;
          closeList();
          alreadyThere(match);
        }
      });
    });
  };

  nameEl.addEventListener("input", () => {
    errEl.textContent = "";
    renderList();
  });

  nameEl.addEventListener("keydown", (e) => {
    const items = [...listEl.querySelectorAll(".combo-item")];
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = e.key === "ArrowDown"
        ? Math.min(active + 1, items.length - 1)
        : Math.max(active - 1, 0);
      items.forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
      items[active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const match = (getContacts() || []).find((c) => c.id === items[active].dataset.id);
      if (match) {
        nameEl.value = match.name;
        closeList();
        alreadyThere(match);
      }
    } else if (e.key === "Escape") {
      closeList();
    }
  });

  nameEl.addEventListener("blur", () => setTimeout(closeList, 120));

  // ── Save ─────────────────────────────────────────────────────────────
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errEl.textContent = "";

    const name = nameEl.value.trim();
    if (!name) { errEl.textContent = "Who are you adding?"; return; }

    const duplicate = findExisting(name);
    if (duplicate) { alreadyThere(duplicate); return; }

    const frequency = chosenFrequency();
    if (!frequency) {
      errEl.textContent = "Enter how many days between reach-outs.";
      return;
    }

    const contact = normalizeContact({
      name,
      role: $(".ac-role").value,
      company: $(".ac-company").value,
      email: $(".ac-email").value,
      // Kept, and it starts nothing. ORB-128 briefly removed this and that was
      // the wrong half of the problem: the objection was never to being asked
      // when you met somebody, it was to a date quietly becoming a countdown.
      //
      // It cannot. `lastContacted` is cleared below whatever this holds, so a
      // meeting is never filed as a conversation (ORB-75); with no cadence
      // there is no health bar to start; and when a cadence IS chosen,
      // firstDeadlineFor is handed "" rather than this, so an old meeting date
      // cannot make a brand-new contact arrive overdue (ORB-124).
      dateMet: $(".ac-datemet").value || "",
      // No tier. ORB-94 removed the question, and recording the default as
      // though it were an answer is exactly what would rot ORB-86's evidence.
      followUpFrequency: frequency,
      reminderEnabled: frequency !== "none",
      // No conversation has happened, so there is no anchor to count a cadence
      // from — the case firstDeadlineFor answers by starting the cadence today
      // (ORB-124: it used to answer with a seven-day grace window, which turned
      // adding someone into a deadline). Passed explicitly rather than derived,
      // because deriving it would let a `dateMet` from two months ago produce a
      // deadline already in the past and greet a brand-new contact as overdue.
      nextReminder: frequency === "none" ? "" : firstDeadlineFor("", frequency),
      // Stated rather than implied. This is the entire ticket.
      interactions: []
    });

    // `normalizeContact` falls back to `dateMet` for `lastContacted`, which is
    // right for every other caller — they only reach it with a conversation
    // date. Here it would record a meeting as a conversation and put a date on
    // a relationship where nothing has been said, so the guardrail is applied
    // after normalising rather than by weakening the fallback for everyone
    // (ORB-75). Contacts are not re-normalised on read, so this sticks.
    contact.lastContacted = "";

    const submitBtn = $(".ac-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Adding…";
    const saved = await db.saveContact(contact);
    submitBtn.disabled = false;
    submitBtn.textContent = "Add to my network";

    if (!saved) {
      errEl.textContent = "Could not save. Open the console (F12) for the Supabase error.";
      return;
    }

    if (onSaved) await onSaved(saved, { name });
  });
}

function openAddConnectionModal(contacts, onSaved) {
  document.getElementById("addConnectionModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "addConnectionModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card quick-add-card">'
    + '<div class="quick-add-header">'
    + '<h3>Add a connection</h3>'
    + '<button class="icon-btn" id="addConnectionClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + '<p class="tiny muted quick-add-lede">Someone you know but have not spoken to yet. '
    + 'No conversation is recorded.</p>'
    + addConnectionFormHtml()
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#addConnectionClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape" && !modal.querySelector(".combo-list:not([hidden])")) {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });

  // Same shape as ORB-14's fix for the conversation modal: close first, then
  // confirm outside, so the only feedback in the app is not destroyed with the
  // DOM that produced it. Neither page carrying the + shows a new contact.
  wireAddConnectionForm(modal, () => contacts, async (saved, meta = {}) => {
    close();
    if (onSaved) await onSaved(saved);
    showToast(meta.name + " added to your network.", {
      actionLabel: "View profile",
      href: "contact.html?id=" + encodeURIComponent(saved.id),
      duration: 7000
    });
  });
  modal.querySelector(".ac-name")?.focus();
}

/**
 * The chooser behind the + (ORB-73, option B).
 *
 * One control silently meant two things: the button says "Add a new connection"
 * and opened a dialog headed "Log a conversation". Naming both actions where
 * the choice is made is what removes the ambiguity — the descriptions carry the
 * distinction, so these are deliberately not two bare buttons.
 *
 * The cost is one extra click on both paths. Accepted: a click that tells you
 * what you are about to do is worth more than one saved.
 */
/**
 * Catch a thought about someone, in one gesture (ORB-81).
 *
 * Survey 1 asked five students where they were when they realised they had
 * forgotten to follow up with someone. The answers: lying awake (twice),
 * scrolling LinkedIn, going through email, and seeing the person's name
 * somewhere by accident.
 *
 * **Not one of them was inside a system built to tell them, and two were in
 * bed.** That is hard on a reminder-shaped product: a notification at 9am is
 * competing with a thought that arrived at 2am, and losing.
 *
 * So this is not a form. There is one required field — who — and it is the
 * first thing you type. The thought is optional, because "Marcus" on its own is
 * already a complete intention, and requiring a sentence at 2am is how the
 * thought gets lost. Enter saves from either field.
 *
 * WHY IT ATTACHES TO SOMEONE RATHER THAN FLOATING
 *
 * An orphan note needs a home, a review queue and a way to be filed, which is a
 * feature rather than a capture. Attaching it means it resurfaces in the one
 * place already built for "who should I contact" — Reach out next — which is
 * the "usable moment" the ticket asks for.
 */
function captureFormHtml(contacts = []) {
  return '<form class="capture-form" novalidate>'
    + '<div class="capture-row">'
    + '<div class="combo">'
    + '<input type="text" class="capture-who" autocomplete="off" role="combobox"'
    + ' aria-expanded="false" aria-autocomplete="list"'
    + ' placeholder="Who are you thinking about?" aria-label="Who are you thinking about?" />'
    + '<ul class="combo-list capture-list" role="listbox" hidden></ul>'
    + '</div>'
    + '<button type="submit" class="btn btn-sm capture-save">Save</button>'
    + '</div>'
    // Optional, and it says so. The label is the whole argument for this
    // ticket, so it is on screen rather than in a tooltip.
    + '<input type="text" class="capture-thought" maxlength="280"'
    + ' placeholder="What was the thought? (optional)"'
    + ' aria-label="What was the thought? Optional" />'
    // ORB-129. Says where it goes and what happens to a name nobody recognises,
    // before you commit rather than after. The old form said neither, and its
    // answer to an unknown name was to refuse.
    + '<p class="tiny muted capture-hint">Goes to their talking points. '
    + 'A name you have not saved yet becomes a new connection.</p>'
    // Where "is this the Chris you mean?" is asked. Empty until it is needed.
    + '<div class="capture-disambig" hidden></div>'
    + '<p class="capture-error error" aria-live="polite"></p>'
    + '</form>';
}

/**
 * Wires it. `getContacts` is a function because the list changes underneath.
 *
 * Only existing people can be captured against. Creating someone from here
 * would need a role, a company and a cadence to be useful, and that is
 * ORB-73's form — this is capturing an INTENTION, not a person.
 */
/**
 * Everyone the typed text could plausibly mean (ORB-129).
 *
 * Two ways in, because "Chris" and "chris rule" are both things people type:
 * the text appears anywhere in the name, OR it matches a first name exactly.
 * The second is what makes one word find the right person; the first is what
 * makes half a surname do it.
 *
 * An exact full-name match is returned alone. There is nothing to disambiguate
 * when you have typed somebody's whole name, and asking would be the app
 * pretending not to understand.
 */
function captureCandidates(typed, contacts) {
  const q = String(typed || "").trim().toLowerCase();
  if (!q) return [];
  const all = contacts || [];
  const exact = all.filter((c) => (c.name || "").trim().toLowerCase() === q);
  if (exact.length === 1) return exact;
  return all.filter((c) => {
    const name = (c.name || "").toLowerCase();
    return name.includes(q) || firstNameOf(name) === q;
  });
}

/**
 * The one-line "who is this" used wherever two people must be told apart.
 *
 * The same shape the profile heading uses, and the same shape the digest builds
 * server-side. Written once here because ORB-129 needs it in a third place and
 * a third hand-rolled `[role, company].join(" at ")` is how they drift.
 */
/**
 * Nothing here but a name (ORB-129).
 *
 * Deliberately not "has any empty field" — most profiles have some. This is the
 * specific state a capture creates: somebody you thought of, saved before you
 * lost the thought, and have not described yet.
 */
function profileIsBare(contact) {
  return !describeContact(contact)
    && !(contact?.emails || []).length
    && !(contact?.interactions || []).length
    && !(contact?.notes || "").trim();
}

function bareProfileHtml(contact) {
  const who = firstNameOf(contact?.name);
  return '<section class="card bare-profile">'
    + '<h3 class="section-title">All Orbit knows is the name</h3>'
    + '<p class="muted">You saved ' + escapeHtml(who)
    + ' from a thought, which was the right thing to do. '
    + 'Three things are worth adding while you still remember them:</p>'
    + '<ul class="bare-list">'
    + '<li><strong>Their role and company</strong> — so a second '
    + escapeHtml(who) + ' is never a guess, and so a draft has something '
    + 'to work with.</li>'
    + '<li><strong>Where you know them from</strong> — put it in the notes. '
    + 'It is the first thing you will want and the first thing you will '
    + 'forget.</li>'
    + '<li><strong>An email</strong> — otherwise reaching out means leaving '
    + 'Orbit to go and find one.</li>'
    + '</ul>'
    + '<p class="tiny muted">A reach-out schedule is optional and there is no '
    + 'need to set one now. This card goes away on its own.</p>'
    + '<button class="btn" id="cpFillIn" type="button">Add their details</button>'
    + '</section>';
}

function describeContact(contact) {
  return [contact?.role, contact?.company].map((v) => (v || "").trim())
    .filter(Boolean).join(" at ");
}

/** contact.html for one person. Extracted so a test can read it (ORB-108). */
function contactProfileUrl(id) {
  return "contact.html?id=" + encodeURIComponent(id);
}

function wireCaptureForm(root, getContacts, onSaved, {
  navigate = (url) => { window.location.href = url; }
} = {}) {
  const form = root.querySelector(".capture-form");
  if (!form) return;
  const $ = (sel) => form.querySelector(sel);
  const whoEl = $(".capture-who");
  const thoughtEl = $(".capture-thought");
  const listEl = $(".capture-list");
  const errEl = $(".capture-error");
  let chosen = null;
  let active = -1;

  const close = () => {
    listEl.hidden = true;
    listEl.innerHTML = "";
    active = -1;
    whoEl.setAttribute("aria-expanded", "false");
  };

  const render = () => {
    const q = whoEl.value.trim().toLowerCase();
    if (!q) return close();
    const matches = (getContacts() || [])
      .filter((c) => (c.name || "").toLowerCase().includes(q))
      .slice(0, 6);
    if (!matches.length) return close();
    listEl.innerHTML = matches.map((c, i) =>
      '<li class="combo-item' + (i === active ? " active" : "") + '" role="option"'
      + ' aria-selected="' + (i === active ? "true" : "false") + '"'
      + ' data-capture-id="' + escapeHtml(c.id) + '">'
      + '<span class="combo-name">' + escapeHtml(c.name) + '</span>'
      + '</li>').join("");
    listEl.hidden = false;
    whoEl.setAttribute("aria-expanded", "true");
    listEl.querySelectorAll("[data-capture-id]").forEach((li) => {
      // mousedown, not click: blur would close the list first.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick((getContacts() || []).find((c) => c.id === li.dataset.captureId));
      });
    });
  };

  const pick = (contact) => {
    if (!contact) return;
    chosen = contact;
    whoEl.value = contact.name;
    close();
    thoughtEl.focus();
  };

  whoEl.addEventListener("input", () => { chosen = null; render(); });
  whoEl.addEventListener("blur", () => setTimeout(close, 120));
  whoEl.addEventListener("keydown", (e) => {
    const items = [...listEl.querySelectorAll(".combo-item")];
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault(); active = Math.min(active + 1, items.length - 1); render();
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault(); active = Math.max(active - 1, 0); render();
    } else if (e.key === "Enter" && active >= 0 && items[active]) {
      // Enter on a highlighted suggestion chooses it rather than submitting —
      // otherwise the first keystroke of a name saves against the wrong person.
      e.preventDefault();
      pick((getContacts() || []).find((c) => c.id === items[active].dataset.captureId));
    }
  });

  const disambigEl = $(".capture-disambig");

  const hideDisambig = () => {
    disambigEl.hidden = true;
    disambigEl.innerHTML = "";
  };

  /** The thought, or the name on its own — which is already a whole intention. */
  const thoughtFor = (name) =>
    thoughtEl.value.trim() || ("Reach out to " + firstNameOf(name));

  /**
   * Attach the thought to somebody who already exists.
   *
   * Stays on the page: you are mid-thought, the person is already described,
   * and taking you somewhere would interrupt the one gesture this form exists
   * to make cheap (ORB-81).
   */
  async function captureOnto(match) {
    const saved = await db.saveContact(normalizeContact({
      ...match,
      followUps: [
        normalizeFollowUpItem({ text: thoughtFor(match.name), source: "capture" }),
        ...(match.followUps || [])
      ]
    }));
    if (!saved) {
      errEl.textContent = "Could not save that — nothing was recorded.";
      return;
    }
    reset();
    // ORB-105. "It is on your list" was the whole problem stated as a
    // reassurance: there are several lists and this named none of them.
    showToast("Noted about " + firstNameOf(match.name)
      + " — it is in Things to bring up next, on their profile.");
    whoEl.focus();
    if (onSaved) await onSaved(saved);
  }

  /**
   * Somebody new (ORB-129).
   *
   * The old form refused here — "No one in your network by that name yet" — so
   * a thought about anybody not already saved had nowhere to go, which is the
   * opposite of what a capture is for.
   *
   * This one DOES navigate, and the difference from the branch above is the
   * point: a new contact is a name and nothing else, so the profile is where
   * the rest of what you know goes, and now is when you know it. Everything
   * else about them is left blank rather than guessed — no cadence (ORB-128),
   * no meeting date, no conversation.
   */
  async function captureAsNew(name) {
    const fresh = normalizeContact({
      name,
      followUpFrequency: "none",
      reminderEnabled: false,
      interactions: [],
      followUps: [normalizeFollowUpItem({ text: thoughtFor(name), source: "capture" })]
    });
    // normalizeContact falls back to dateMet for lastContacted; there is no
    // dateMet here, but this is stated rather than assumed (ORB-75).
    fresh.lastContacted = "";
    const saved = await db.saveContact(fresh);
    if (!saved) {
      errEl.textContent = "Could not save that — nothing was recorded.";
      return;
    }
    reset();
    showToast(firstNameOf(name) + " added, and your note is on their profile.");
    if (onSaved) await onSaved(saved);
    navigate(contactProfileUrl(saved.id));
  }

  function reset() {
    whoEl.value = "";
    thoughtEl.value = "";
    chosen = null;
    close();
    hideDisambig();
  }

  /**
   * "Do you mean this Chris, or a new one?" (ORB-129)
   *
   * Asked rather than guessed. Picking the first match would attach a thought
   * to the wrong person silently; creating a new one would leave two Chrises
   * and no way to tell which the note was about. Both are worse than a
   * question, and the question only appears when there is a real ambiguity.
   */
  function askWhich(typed, candidates) {
    disambigEl.innerHTML = '<p class="capture-ask">Which ' + escapeHtml(typed) + '?</p>'
      + '<ul class="capture-options">'
      + candidates.map((c) =>
          '<li><button type="button" class="capture-option" data-pick-id="'
          + escapeHtml(c.id) + '">'
          + '<span class="capture-option-name">' + escapeHtml(c.name) + '</span>'
          // Whatever distinguishes them. A list of identical first names with
          // nothing beside them is not a choice anybody can make.
          + (describeContact(c)
            ? '<span class="capture-option-detail">' + escapeHtml(describeContact(c)) + '</span>'
            : '')
          + '</button></li>').join("")
      + '<li><button type="button" class="capture-option capture-option-new" data-pick-new>'
      + '<span class="capture-option-name">Someone new</span>'
      + '<span class="capture-option-detail">Add ' + escapeHtml(typed)
      + ' and open their profile</span>'
      + '</button></li>'
      + '</ul>';
    disambigEl.hidden = false;

    disambigEl.querySelectorAll("[data-pick-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const c = (getContacts() || []).find((x) => x.id === btn.dataset.pickId);
        if (c) captureOnto(c);
      });
    });
    disambigEl.querySelector("[data-pick-new]")
      .addEventListener("click", () => captureAsNew(typed));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errEl.textContent = "";
    hideDisambig();

    const typed = whoEl.value.trim();
    if (!typed) {
      errEl.textContent = "Who is this about?";
      whoEl.focus();
      return;
    }
    // Chosen from the dropdown is an answer already given; do not ask again.
    if (chosen) return captureOnto(chosen);

    const candidates = captureCandidates(typed, getContacts());
    if (!candidates.length) return captureAsNew(typed);
    if (candidates.length === 1
        && (candidates[0].name || "").trim().toLowerCase() === typed.toLowerCase()) {
      return captureOnto(candidates[0]);
    }
    askWhich(typed, candidates);
  });
}

function openCaptureModal(contacts, onSaved) {
  document.getElementById("captureModal")?.remove();
  const modal = document.createElement("div");
  modal.id = "captureModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card capture-card" role="dialog" aria-modal="true"'
    + ' aria-labelledby="captureTitle">'
    + '<div class="quick-add-header">'
    + '<h3 id="captureTitle">Note to self about someone</h3>'
    + '<button class="icon-btn" id="captureClose" type="button" aria-label="Close">\u2715</button>'
    + '</div>'
    + '<p class="muted">It will be waiting on Reach out next.</p>'
    + captureFormHtml(contacts)
    + '</div>';
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#captureClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  wireCaptureForm(modal, () => contacts, async () => {
    close();
    if (onSaved) await onSaved();
  });
  modal.querySelector(".capture-who").focus();
}

/**
 * Importing a spreadsheet of people you already know (ORB-98).
 *
 * This reverses a decision made the same morning. ORB-76 dropped bulk entry
 * because there was no evidence anyone needed it and metric 3 — the only
 * instrument pointed at it — turned out to be structurally incapable of
 * producing any. The evidence arrived hours later and from exactly the
 * direction that decision named: a real user with 50+ contacts already in an
 * Excel sheet, and the observation that people who do not need Orbit still keep
 * a CRM, and every CRM exports CSV.
 *
 * IT IS NOT THE BULK PASTE THAT WAS DROPPED. That was free text typed into a
 * box, which needs a parser that guesses at everything. A file has a header
 * row, and the header row is what makes the guessing tractable.
 */

/**
 * CSV, close enough to RFC 4180 for what spreadsheets actually emit.
 *
 * Written out rather than split on commas because the fields that break a
 * naive split are exactly the ones this feature exists for: "Smith, Jane" in a
 * name column, a note containing a comma, an address wrapped in quotes. A
 * doubled quote inside a quoted field is an escaped quote, which is how Excel,
 * Sheets and every CRM export write one.
 *
 * CRLF is normalised on the way in — Excel on Windows is the single most likely
 * source of these files.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text || "").replace(/\r\n?/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (src[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  // A file not ending in a newline still has a last row, and a trailing newline
  // must not produce an empty one.
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

/**
 * Which Orbit field each column probably is.
 *
 * A guess, shown to the user and correctable — never applied silently. The
 * synonyms come from what LinkedIn, HubSpot, Salesforce and a hand-rolled
 * spreadsheet actually call these columns.
 */
const CSV_FIELDS = [
  { key: "name",    label: "Name",         required: true,
    match: ["name", "full name", "fullname", "contact", "contact name", "person"] },
  { key: "first",   label: "First name",   split: true,
    match: ["first name", "firstname", "given name", "first"],
    avoid: ["contact", "spoke", "date", "message", "activity", "reach"] },
  { key: "last",    label: "Last name",    split: true,
    match: ["last name", "lastname", "surname", "family name", "last"],
    // A column called "Last Contacted" was being imported as a SURNAME, because
    // "last contacted" contains "last" and the partial pass took it (ORB-103).
    // Every one of these words means the column is about time, not a name.
    avoid: ["contact", "spoke", "date", "message", "activity", "reach", "seen"] },
  { key: "role",    label: "Role",
    match: ["role", "title", "job title", "jobtitle", "position", "headline"] },
  { key: "company", label: "Company",
    match: ["company", "organization", "organisation", "employer", "account",
            "company name", "current company"] },
  { key: "email",   label: "Email",
    match: ["email", "e-mail", "email address", "work email", "primary email"] },
  { key: "industry", label: "Industry",
    match: ["industry", "sector", "vertical"] },
  { key: "dateMet", label: "When you met",
    match: ["date met", "met", "met on", "first met", "connected on",
            "connected", "date connected", "connection date"] },
  // ORB-103. The fact a spreadsheet most often carries and Orbit had no field
  // for. Without it a sheet of people you have definitely spoken to imports as
  // "Not contacted yet" — wrong about the recent ones, and equally wrong about
  // the dormant ones, so the whole import reads as one undifferentiated grey.
  { key: "lastContacted", label: "When you last spoke",
    match: ["last contacted", "last contact", "last spoke", "last spoken",
            "last conversation", "last message", "last activity", "last touch",
            "last reach out", "last outreach"] },
  { key: "notes",   label: "Notes",
    match: ["notes", "note", "comments", "description", "about"] }
];

const normHeader = (h) => String(h || "").trim().toLowerCase().replace(/[_\-]+/g, " ")
  .replace(/\s+/g, " ");

function guessColumnMap(headers) {
  const map = {};
  const taken = new Set();
  const norm = headers.map(normHeader);
  // Exact matches first, across every field, before anything falls back to a
  // partial one — otherwise "Company" can be claimed by a "company size"
  // column that happened to come earlier.
  for (const pass of ["exact", "partial"]) {
    for (const f of CSV_FIELDS) {
      if (map[f.key] !== undefined) continue;
      const i = norm.findIndex((h, idx) => !taken.has(idx) && h && (pass === "exact"
        ? f.match.includes(h)
        // `avoid` only applies to partial matching. An exact match is an exact
        // match — a column literally called "last" is a surname.
        : f.match.some((m) => h.includes(m)) && !(f.avoid || []).some((w) => h.includes(w))));
      if (i !== -1) { map[f.key] = i; taken.add(i); }
    }
  }
  return map;
}

/**
 * The rows as contacts, in the shape ORB-73 established.
 *
 * No conversation, no last-contacted date, no tier and no star. Importing
 * fifty people is not fifty conversations, and a star is something you say
 * rather than something a file says for you.
 *
 * The cadence is applied to everyone at once and defaults to none. Fifty
 * contacts imported on a monthly cadence would arrive as fifty overdue people
 * on the dashboard — the exact "contacts with no conversation clutter Reach out
 * next" risk the ORB-73 PRD raised, at fifty times the scale.
 */
function csvRowsToContacts(headers, rows, map, { frequency = "none" } = {}) {
  const at = (row, key) => {
    const i = map[key];
    return i === undefined || i < 0 ? "" : String(row[i] ?? "").trim();
  };
  const out = [];
  for (const row of rows) {
    let name = at(row, "name");
    if (!name) name = [at(row, "first"), at(row, "last")].filter(Boolean).join(" ");
    if (!name) continue;   // a row with no name is not a person
    out.push({
      name,
      role: at(row, "role"),
      company: at(row, "company"),
      email: at(row, "email"),
      industry: at(row, "industry"),
      dateMet: normaliseCsvDate(at(row, "dateMet")),
      // ORB-103. A date, not a conversation — ORB-73's rule is that adding
      // someone does not invent a conversation, and this invents none. It
      // states when you last spoke, which is the thing the app had no way to
      // be told and was guessing at.
      lastContacted: normaliseCsvDate(at(row, "lastContacted")),
      notes: at(row, "notes"),
      followUpFrequency: frequency,
      reminderEnabled: frequency !== "none",
      interactions: []
    });
  }
  return out;
}

/**
 * A date, or nothing.
 *
 * Nothing is the right answer for an unparseable one. `dateMet` anchors a
 * cadence, and ORB-73 established that a guessed date is indistinguishable from
 * a known one once stored — so a column that turns out to be "Q3" or "last
 * spring" must produce an empty field rather than today.
 */
function normaliseCsvDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return raw.slice(0, 10);
  // US-style, which is what a spreadsheet in this market emits. Ambiguous
  // against day-first and knowably so — flagged in the preview rather than
  // resolved by guessing.
  const slash = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})$/.exec(raw);
  if (slash) {
    const [, m, d, y] = slash;
    const year = y.length === 2 ? "20" + y : y;
    const out = [year, m.padStart(2, "0"), d.padStart(2, "0")].join("-");
    return parseDateOnly(out) ? out : "";
  }
  return "";
}

/** Names already in the network, matched the way the rest of the app does. */
function findCsvDuplicates(candidates, existing) {
  const have = new Set((existing || []).map((c) => (c.name || "").trim().toLowerCase()));
  const seen = new Set();
  const dupes = new Set();
  candidates.forEach((c, i) => {
    const key = c.name.trim().toLowerCase();
    // Duplicated against the network, and against earlier rows of the same
    // file — an export that lists someone twice is common and neither half of
    // it should silently win.
    if (have.has(key) || seen.has(key)) dupes.add(i);
    seen.add(key);
  });
  return dupes;
}

/**
 * The import screen: map, preview, then commit (ORB-98).
 *
 * Nothing is written until the preview has been seen. That is the guardrail
 * that makes the guessing safe — a wrong column is obvious in a preview and
 * invisible in a success message, and undoing fifty bad contacts is far worse
 * than undoing one.
 */
function csvImportFormHtml() {
  const freqOptions = Object.entries(FREQUENCY_LABELS)
    .map(([v, l]) => '<option value="' + v + '"' + (v === "none" ? " selected" : "") + '>'
      + escapeHtml(l) + '</option>').join("");
  return '<form class="csv-form" novalidate>'
    + '<div class="field-group"><label for="csvFile">Your spreadsheet</label>'
    + '<input type="file" id="csvFile" class="csv-file" accept=".csv,text/csv" />'
    + '<p class="tiny muted">A CSV exported from LinkedIn, a CRM, Excel or Sheets. '
    + 'Nothing is saved until you have seen the preview.</p></div>'
    + '<div class="csv-mapping hidden"></div>'
    + '<div class="csv-preview hidden"></div>'
    + '<div class="field-group csv-cadence hidden">'
    + '<label for="csvFreq">Reach out to these people…</label>'
    + '<select id="csvFreq" class="csv-freq">' + freqOptions + '</select>'
    + '<p class="tiny muted">Applies to everyone in the file. '
    + 'No schedule is the default — putting fifty people on a cadence at once fills '
    + 'Reach out next with people you have not decided about yet.</p></div>'
    + '<p class="error csv-error" aria-live="polite"></p>'
    + '<button type="submit" class="btn csv-submit hidden">Import</button>'
    + '</form>';
}

/**
 * A file as text.
 *
 * `Blob.text()` is what every current browser offers and what this used to
 * call directly. It is unimplemented in jsdom, which meant the read path — the
 * first thing that runs and the easiest to break — could not be tested at all.
 * FileReader is the fallback and is universally available, so the fast path
 * stays and the code stops being untestable.
 */
function readFileText(file) {
  if (typeof file?.text === "function") return file.text();
  // Looked up rather than referenced bare, for the same reason DOMParser is in
  // htmlToMarks (ORB-77): these live on `window` and are not globals in every
  // environment the module is loaded into.
  const Reader = (typeof FileReader !== "undefined" && FileReader)
    || (typeof window !== "undefined" && window.FileReader);
  if (!Reader) return Promise.reject(new Error("no file reader available"));
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsText(file);
  });
}

function wireCsvImport(root, getContacts, onSaved) {
  const form = root.querySelector(".csv-form");
  if (!form) return;
  const $ = (sel) => form.querySelector(sel);
  const errEl = $(".csv-error");
  let headers = [];
  let rows = [];

  const currentMap = () => {
    const map = {};
    form.querySelectorAll("[data-csv-field]").forEach((sel) => {
      const i = parseInt(sel.value, 10);
      if (!Number.isNaN(i) && i >= 0) map[sel.dataset.csvField] = i;
    });
    return map;
  };

  function renderMapping(guess) {
    const options = (selected) => '<option value="-1">— not in this file —</option>'
      + headers.map((h, i) => '<option value="' + i + '"' + (selected === i ? " selected" : "")
        + '>' + escapeHtml(h || "column " + (i + 1)) + '</option>').join("");
    $(".csv-mapping").innerHTML = '<p class="label">Which column is which?</p>'
      + '<p class="tiny muted">Guessed from the header row. Change anything that is wrong.</p>'
      + '<div class="csv-map-grid">'
      + CSV_FIELDS.map((f) => '<div class="csv-map-row">'
          + '<label for="csvmap-' + f.key + '">' + escapeHtml(f.label)
          + (f.required ? ' <span class="csv-req">required</span>' : '')
          + (f.split ? ' <span class="tiny muted">(if the name is split in two)</span>' : '')
          + '</label>'
          + '<select id="csvmap-' + f.key + '" data-csv-field="' + f.key + '">'
          + options(guess[f.key]) + '</select>'
          + '</div>').join("")
      + '</div>';
    $(".csv-mapping").classList.remove("hidden");
    form.querySelectorAll("[data-csv-field]").forEach((sel) =>
      sel.addEventListener("change", renderPreview));
  }

  function renderPreview() {
    const map = currentMap();
    const people = csvRowsToContacts(headers, rows, map);
    const dupes = findCsvDuplicates(people, getContacts());
    const fresh = people.filter((_, i) => !dupes.has(i));
    const shown = fresh.slice(0, 5);

    const noName = rows.length - people.length;
    $(".csv-preview").innerHTML = '<p class="label">What will be added</p>'
      + (fresh.length
        ? '<ul class="csv-rows">'
          + shown.map((p) => '<li><strong>' + escapeHtml(p.name) + '</strong>'
              + (p.role || p.company
                ? '<span class="tiny muted"> ' + escapeHtml([p.role, p.company].filter(Boolean).join(" at ")) + '</span>'
                : '')
              + (p.email ? '<span class="tiny muted"> · ' + escapeHtml(p.email) + '</span>' : '')
              // ORB-103. Shown because it is the field most likely to be mapped
              // to the wrong column, and the one with the largest consequence
              // if it is — it decides whether this person reads as current or
              // as someone you have lost touch with.
              + (p.lastContacted
                ? '<span class="tiny muted"> · last spoke ' + escapeHtml(relativeDayLabel(p.lastContacted)) + '</span>'
                : '')
              + '</li>').join("")
          + (fresh.length > shown.length
            ? '<li class="tiny muted">and ' + (fresh.length - shown.length) + ' more</li>' : '')
          + '</ul>'
        : '<p class="empty">Nothing to add — check the Name column above.</p>')
      + '<p class="csv-counts">'
      + '<strong>' + fresh.length + '</strong> to add'
      + (dupes.size ? ' · <strong>' + dupes.size + '</strong> already in your network, skipped' : '')
      + (noName > 0 ? ' · ' + noName + ' row' + (noName === 1 ? "" : "s") + ' with no name, skipped' : '')
      + '</p>';
    $(".csv-preview").classList.remove("hidden");
    $(".csv-cadence").classList.toggle("hidden", !fresh.length);
    $(".csv-submit").classList.toggle("hidden", !fresh.length);
    $(".csv-submit").textContent = fresh.length === 1
      ? "Import 1 person" : "Import " + fresh.length + " people";
    return { fresh, dupes };
  }

  $(".csv-file").addEventListener("change", async (e) => {
    errEl.textContent = "";
    const file = e.target.files?.[0];
    if (!file) return;
    let text = "";
    try { text = await readFileText(file); }
    catch { errEl.textContent = "Could not read that file."; return; }

    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      errEl.textContent = "That file has no rows under its header.";
      return;
    }
    headers = parsed[0];
    rows = parsed.slice(1);
    renderMapping(guessColumnMap(headers));
    renderPreview();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errEl.textContent = "";
    const frequency = $(".csv-freq").value;
    const map = currentMap();
    const people = csvRowsToContacts(headers, rows, map, { frequency });
    const dupes = findCsvDuplicates(people, getContacts());
    const fresh = people.filter((_, i) => !dupes.has(i));
    if (!fresh.length) { errEl.textContent = "Nothing to import."; return; }

    const btn = $(".csv-submit");
    btn.disabled = true;
    let saved = 0;
    const failed = [];
    for (const person of fresh) {
      const contact = normalizeContact(person);
      // ORB-73's rule still holds — a spreadsheet row is not a conversation, so
      // normalizeContact's fallback to dateMet is cleared. But ORB-103 draws
      // the line one step further out: if the FILE says when you last spoke,
      // that is a fact you supplied, not one Orbit inferred, and throwing it
      // away is what made every import read "Not contacted yet".
      contact.lastContacted = person.lastContacted || "";
      contact.nextReminder = frequency === "none"
        ? ""
        // firstDeadlineFor grants the grace window when the cadence alone would
        // already be blown, so someone you last spoke to in 2023 gets a week to
        // make the first reach-out rather than arriving overdue. Rows with no
        // last-spoke date have nothing to blow, so they start their cadence
        // today (ORB-124) — importing fifty people does not make fifty of them
        // due next week.
        : firstDeadlineFor(contact.lastContacted, frequency);
      const ok = await db.saveContact(contact);
      if (ok) saved++; else failed.push(person.name);
    }
    btn.disabled = false;

    if (!saved) { errEl.textContent = "Nothing saved — the database refused every row."; return; }
    // Partial success is reported as partial. "Imported 50" when 6 failed is
    // the ORB-14 problem at scale.
    if (failed.length) {
      errEl.textContent = failed.length + " row" + (failed.length === 1 ? "" : "s")
        + " could not be saved: " + failed.slice(0, 3).join(", ")
        + (failed.length > 3 ? "…" : "");
    }
    showToast("Added " + saved + " " + (saved === 1 ? "person" : "people") + " to your network.");
    if (onSaved) await onSaved();
  });
}

function openCsvImportModal(contacts, onSaved) {
  document.getElementById("csvImportModal")?.remove();
  const modal = document.createElement("div");
  modal.id = "csvImportModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card csv-card" role="dialog" aria-modal="true"'
    + ' aria-labelledby="csvTitle">'
    + '<div class="quick-add-header">'
    + '<h3 id="csvTitle">Import from a spreadsheet</h3>'
    + '<button class="icon-btn" id="csvClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + csvImportFormHtml()
    + '</div>';
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#csvClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  wireCsvImport(modal, () => contacts, async () => {
    close();
    if (onSaved) await onSaved();
  });
}

/**
 * One name for one action (ORB-118, ORB-119).
 *
 * Four controls now open this dialog: the floating button on every page, the
 * button in the My Network header, the one in its empty state, and the dialog's
 * own title. ORB-74's rule is that a label agrees with what it opens, and four
 * hand-written strings is four chances for that to stop being true. There is one
 * string, and `entry-points.test.mjs` checks the static HTML against it — the
 * markup cannot import a constant, so a test stands in for the import.
 */
const ADD_TO_NETWORK_LABEL = "Add to your network";

/**
 * The My Network empty state (ORB-119).
 *
 * It used to be five words in a list item: "Nobody in your network yet." A
 * statement of fact with no way out, on the one page whose entire purpose is
 * the thing you cannot do from it. The spreadsheet route is named here because
 * ORB-98 shipped and nothing anywhere announces it — someone with fifty
 * contacts in Excel would otherwise start typing them in one at a time.
 */
function networkEmptyHtml() {
  return '<div class="network-empty">'
    + '<p class="network-empty-title">Nobody in your network yet.</p>'
    + '<p class="tiny muted">Add someone you have met, or bring a whole list in '
    + 'at once — a CSV from LinkedIn, a CRM or a spreadsheet.</p>'
    + '<button type="button" class="btn" id="networkEmptyAdd">'
    + escapeHtml(ADD_TO_NETWORK_LABEL) + '</button>'
    + '</div>';
}

function openQuickAddChooser(contacts, onSaved) {
  document.getElementById("quickAddChooser")?.remove();

  const modal = document.createElement("div");
  modal.id = "quickAddChooser";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card chooser-card" role="dialog" aria-modal="true"'
    + ' aria-labelledby="chooserTitle">'
    + '<div class="quick-add-header">'
    + '<h3 id="chooserTitle">' + escapeHtml(ADD_TO_NETWORK_LABEL) + '</h3>'
    + '<button class="icon-btn" id="chooserClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + '<ul class="chooser-list">'
    // Add first: it is what the button already claims to do, and the action a
    // new account needs most.
    + '<li><button type="button" class="chooser-option" id="chooseAddConnection">'
    + '<span class="chooser-title">Add a connection</span>'
    + '<span class="chooser-desc">Someone you know but have not spoken to yet. '
    + 'No conversation is recorded.</span>'
    + '</button></li>'
    + '<li><button type="button" class="chooser-option" id="chooseLogConversation">'
    + '<span class="chooser-title">Log a conversation</span>'
    + '<span class="chooser-desc">Record a conversation you have already had, '
    + 'with someone new or already in your network.</span>'
    + '</button></li>'
    // Third and last, because it is the smallest act of the three and the one
    // you already know you want when you open this (ORB-81).
    + '<li><button type="button" class="chooser-option" id="chooseImport">'
    + '<span class="chooser-title">Import from a spreadsheet</span>'
    + '<span class="chooser-desc">A CSV from LinkedIn, a CRM or Excel. '
    + 'You map the columns and see a preview before anything is saved.</span>'
    + '</button></li>'
    + '<li><button type="button" class="chooser-option" id="chooseCapture">'
    + '<span class="chooser-title">Note to self about someone</span>'
    + '<span class="chooser-desc">A thought you do not want to lose. '
    + 'One line, and it waits for you on Reach out next.</span>'
    + '</button></li>'
    + '</ul>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#chooserClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });

  modal.querySelector("#chooseAddConnection").addEventListener("click", () => {
    close();
    openAddConnectionModal(contacts, onSaved);
  });
  modal.querySelector("#chooseLogConversation").addEventListener("click", () => {
    close();
    openQuickAddModal(contacts, onSaved);
  });
  modal.querySelector("#chooseCapture").addEventListener("click", () => {
    close();
    openCaptureModal(contacts, onSaved);
  });
  modal.querySelector("#chooseImport").addEventListener("click", () => {
    close();
    openCsvImportModal(contacts, onSaved);
  });

  modal.querySelector("#chooseAddConnection").focus();
}

/**
 * A list with the just-saved contact in it, ready to draw (ORB-128).
 *
 * Replaces rather than prepends when the id is already known, so logging a
 * conversation against an existing person does not put them on screen twice.
 */
function withSaved(contacts, saved) {
  if (!saved || !saved.id) return contacts;
  return [saved, ...(contacts || []).filter((c) => c.id !== saved.id)];
}

function initQuickAddButton(getContacts, onSaved) {
  const btn = document.getElementById("quickAddBtn");
  if (!btn) return;
  btn.addEventListener("click", () => openQuickAddChooser(getContacts(), onSaved));
}

// ── Toast ─────────────────────────────────────────────────────────────────────

/**
 * A confirmation that outlives whatever created it.
 *
 * Two things need this. Logging a conversation used to print "Conversation added
 * to Marcus" inside a modal that deleted itself 1.1s later, so the only feedback
 * in the app went with it (ORB-14). And one-click "Reached out" (ORB-13) is only
 * safe to make one click if the mistake is cheap to take back, which needs a
 * place to put Undo.
 *
 * @param {string} message  Plain text. Name the person — "Logged" alone does not
 *                          tell you the right row was hit.
 * @param {object} [opts]
 * @param {string} [opts.actionLabel]  Text for the trailing button
 * @param {string} [opts.href]         Makes the action a link instead of a button
 * @param {Function} [opts.onAction]   Handler; the toast closes after it resolves
 * @param {number} [opts.duration]     ms before auto-dismiss. Undo gets longer.
 * @returns {{dismiss: Function}}
 */
function showToast(message, opts = {}) {
  const { actionLabel = "", href = "", onAction = null, duration = 5000 } = opts;

  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    // Polite, not assertive: this confirms something the user just did on
    // purpose. It should not interrupt whatever they are reading now.
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  // One at a time. A queue of stale confirmations is noise, not reassurance.
  stack.replaceChildren();

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = '<span class="toast-text">' + escapeHtml(message) + '</span>'
    + (actionLabel
      ? (href
        ? '<a class="toast-action" href="' + escapeHtml(href) + '">' + escapeHtml(actionLabel) + '</a>'
        : '<button class="toast-action" type="button">' + escapeHtml(actionLabel) + '</button>')
      : '')
    + '<button class="toast-close" type="button" aria-label="Dismiss">✕</button>';
  stack.appendChild(toast);

  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
    if (!stack.childElementCount) stack.remove();
  };
  timer = setTimeout(dismiss, duration);

  toast.querySelector(".toast-close").addEventListener("click", dismiss);
  if (onAction) {
    toast.querySelector(".toast-action")?.addEventListener("click", async () => {
      clearTimeout(timer);
      await onAction();
      dismiss();
    });
  }
  // Hovering means they are reading it or reaching for Undo. Do not yank it away.
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, 2500); });

  return { dismiss };
}

// ── Reach-out modal ───────────────────────────────────────────────────────────

function buildReminderEmailText(contact, yourName) {
  const name = contact.name || "there";
  const safeName = (yourName || "").trim() || "[Your Name]";
  return "Subject: Great catching up!\n\nHi " + name + ",\n\nHope you have been doing well! I wanted to reconnect and see how things have been going on your end.\n\nWould love to catch up soon.\n\nBest,\n" + safeName;
}

/**
 * A draft as a mailto: URL.
 *
 * The first line is the subject, by the same convention the draft is written
 * in — `Subject: …` — and everything after the blank line is the body. A draft
 * the user has rewritten without that first line simply has no subject, which
 * is better than guessing one from their words.
 */
function mailtoUrl(email, text) {
  const [subjectLine, ...bodyLines] = String(text || "").split("\n");
  const hasSubject = /^Subject:\s*/i.test(subjectLine);
  const subject = hasSubject ? subjectLine.replace(/^Subject:\s*/i, "") : "";
  const body = (hasSubject ? bodyLines.join("\n") : String(text || ""))
    .replace(/^\n+/, "");
  return "mailto:" + encodeURIComponent(email || "")
    + "?subject=" + encodeURIComponent(subject)
    + "&body=" + encodeURIComponent(body);
}

async function showReminderModal(contact, onChanged) {
  document.getElementById("reminderModal")?.remove();

  const prefs = await db.getPreferences();
  const health = getHealth(contact);
  const emailText = buildReminderEmailText(contact, prefs.your_name || "");
  const nextStr = contact.nextReminder ? formatDate(contact.nextReminder.split("T")[0]) : "Not set";

  const modal = document.createElement("div");
  modal.id = "reminderModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card">'
    + '<div class="quick-add-header">'
    + '<h3>Draft a message to <strong>' + escapeHtml(contact.name) + '</strong></h3>'
    + '<button class="icon-btn" id="modalClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    // This is the point of hesitation: the draft is on screen and the only
    // question left is whether to send it. It led with "Every month · Next: 12
    // Sep", which is the schedule talking. It now leads with the person and the
    // silence (ORB-78), then answers the objection that silence raises (ORB-79).
    + reachOutPromptHtml(contact, health, { ledger: false })
    + permissionLineHtml(contact, health)
    + '<p class="tiny muted">' + escapeHtml(getFreqLabel(contact.followUpFrequency))
    + ' · Next: ' + escapeHtml(nextStr) + '</p>'
    + '<div class="modal-actions">'
    + '<button class="btn" id="modalMarkDone" type="button">I reached out</button>'
    + '<button class="btn btn-secondary" id="modalLater" type="button">Remind me in 3 days</button>'
    + '<button class="btn btn-secondary" id="modalTurnOff" type="button">Remove schedule</button>'
    + '</div>'
    + '<div class="modal-email">'
    + '<p class="label">Draft message</p>'
    // ORB-108. Was readonly, so you could copy a message to a real person and
    // not change a word of it first.
    + '<textarea class="email-draft" rows="8" aria-label="Draft message">'
    + escapeHtml(emailText) + '</textarea>'
    + '<div class="modal-draft-actions">'
    + '<button class="btn btn-secondary" id="modalCopyEmail" type="button">Copy</button>'
    + (contact.email
      ? '<button class="btn btn-secondary" id="modalMailto" type="button">Open in email</button>'
      : '')
    + '</div>'
    + '<p id="modalCopyMsg" class="success" aria-live="polite"></p>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const finish = async () => { modal.remove(); if (onChanged) await onChanged(); };

  // Same helper the one-click row button uses, so marking it done confirms and
  // offers undo wherever you do it from.
  modal.querySelector("#modalMarkDone").addEventListener("click", async () => {
    modal.remove();
    await markReachedOut(contact, onChanged);
  });
  modal.querySelector("#modalLater").addEventListener("click", async () => {
    const saved = await db.saveContact(normalizeContact({
      ...contact,
      nextReminder: addDays(todayDateString(), 3)
    }));
    if (saved) showToast("Snoozed — " + contact.name + " comes back in 3 days.");
    else showToast("Could not save that — " + contact.name + " is unchanged.");
    await finish();
  });
  modal.querySelector("#modalTurnOff").addEventListener("click", async () => {
    const saved = await db.saveContact(normalizeContact({
      ...contact, reminderEnabled: false, followUpFrequency: "none"
    }));
    if (!saved) { showToast("Could not save that — " + contact.name + " is unchanged."); return; }
    showToast("Schedule removed for " + contact.name + ".", {
      actionLabel: "Undo",
      duration: 8000,
      onAction: async () => {
        await db.saveContact(normalizeContact({ ...contact }));
        if (onChanged) await onChanged();
      }
    });
    await finish();
  });
  // ORB-108. Both actions read the textarea rather than the string the dialog
  // was built from, or an edit is silently discarded — which is the worse half
  // of the bug: the box would look editable and quietly not be.
  const draftText = () => modal.querySelector(".email-draft").value;

  modal.querySelector("#modalCopyEmail").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(draftText());
      modal.querySelector("#modalCopyMsg").textContent = "Copied to clipboard.";
    } catch {
      modal.querySelector("#modalCopyMsg").textContent = "Copy failed — please copy manually.";
    }
  });
  // Hands the draft to whatever email client the OS has. Orbit runs entirely in
  // the browser, so it cannot send mail itself — this is the closest it gets.
  //
  // The URL is built by a function rather than inline because `window.location`
  // cannot be stubbed in jsdom, so an inline version is untestable — and what
  // needs testing is that it uses the EDITED draft (ORB-108), not the generated
  // one. **ORB-113** adds Gmail and Outlook beside this.
  modal.querySelector("#modalMailto")?.addEventListener("click", () => {
    window.location.href = mailtoUrl(contact.email, draftText());
  });

  modal.querySelector("#modalClose").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

// ── Marking a reach-out done ──────────────────────────────────────────────────

/**
 * Roll the cadence forward because the user says they reached out.
 *
 * This is one gesture, so it is one click (ORB-13). The old flow made you press
 * "Reach out" — a future-tense label — to report something already done, then
 * press "I reached out" in a modal: two clicks and a dialog, with the label
 * pointing the wrong way in time.
 *
 * It deliberately does NOT capture notes. The open question "do users have notes
 * worth capturing, or do they just want the row gone?" was answered *row gone*,
 * so the fast path stays fast; the conversation logger is still there for the
 * times there is something to write down.
 *
 * Undo is what makes one click safe, so a failed save must not silently look
 * like a success.
 */
async function markReachedOut(contact, onChanged) {
  const restore = {
    lastContacted: contact.lastContacted,
    nextReminder: contact.nextReminder,
    // The captured thoughts as they were, so Undo restores them open (ORB-81),
    // and the history without the touchpoint this is about to add (ORB-96).
    followUps: contact.followUps,
    interactions: contact.interactions
  };
  const today = todayDateString();
  // Reaching out is what a captured thought was FOR, so it closes here. Leaving
  // it open would keep the person pinned to Reach out next after the thing was
  // done, which is the same "did that save?" doubt as ORB-14 from the other
  // direction. Only captures are closed — a manual talking point may well
  // survive the conversation it was written for.
  const followUps = (contact.followUps || []).map((f) =>
    f.source === "capture" && !f.completed
      // completedAt as well as completed (ORB-122): closing a capture from here
      // is still a tick, and leaving it undated would quietly undercount the
      // one KPI that field exists for.
      ? { ...f, completed: true, completedAt: new Date().toISOString() }
      : f);
  // ORB-126. Whatever you waved away, you have now done. Starting the month
  // again from here would be the snooze outliving its own reason.
  clearNudgeSnooze(contact.id);
  const saved = await db.saveContact(normalizeContact({
    ...contact,
    followUps,
    // ORB-96. Recorded as a touchpoint, not a conversation, and with no notes —
    // you pressed a button, you did not write anything, and inventing words for
    // you is the ORB-73 mistake.
    interactions: [
      normalizeInteraction({ date: today, type: TOUCHPOINT_TYPE }),
      ...(contact.interactions || [])
    ],
    lastContacted: today,
    nextReminder: calculateNextReminder(today, contact.followUpFrequency)
  }));

  if (!saved) {
    showToast("Could not save that — " + contact.name + " is unchanged.");
    return false;
  }

  showToast("Marked as reached out — " + contact.name + ".", {
    actionLabel: "Undo",
    duration: 8000,
    onAction: async () => {
      await db.saveContact(normalizeContact({ ...contact, ...restore }));
      if (onChanged) await onChanged();
    }
  });
  if (onChanged) await onChanged();
  return true;
}

// ── Shared row renderers ──────────────────────────────────────────────────────

/**
 * The star (ORB-93).
 *
 * A filled star means "this is one of mine"; an outline means the question has
 * not been answered, which is not the same as answering no. That distinction is
 * why this is `aria-pressed` on a button rather than a checkbox — a toggle with
 * two states, not a field carrying a value.
 *
 * The label names the person because these appear in a list. "Star" repeated
 * forty times tells a screen reader user nothing about which one they are on.
 */
function starButtonHtml(contact) {
  const on = contact.starred === true;
  const label = (on ? "Unstar " : "Star ") + (contact.name || "this person");
  return '<button class="star-btn' + (on ? ' starred' : '') + '" type="button"'
    + ' data-toggle-star="' + escapeHtml(contact.id) + '"'
    + ' aria-pressed="' + (on ? "true" : "false") + '"'
    + ' aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '">'
    + (on ? "\u2605" : "\u2606") + '</button>';
}

/**
 * Toggle it, and say so.
 *
 * Optimistic: the button flips before the save returns, because a star that
 * lags feels broken at the speed people click these. A failed save re-renders
 * from the store and puts it back — silently leaving it lit would be the ORB-14
 * problem, where the screen claims something the database never accepted.
 */
async function toggleStar(contact, onChanged) {
  const next = !(contact.starred === true);
  const saved = await db.saveContact(normalizeContact({ ...contact, starred: next }));
  if (!saved) {
    showToast("Could not save that — " + contact.name + " is unchanged.");
    if (onChanged) await onChanged();
    return false;
  }
  showToast(next
    ? contact.name + " is one of your people."
    : "Unstarred " + contact.name + ".");
  if (onChanged) await onChanged();
  return true;
}

function personRowHtml(contact, health, { showReconnect = false, prompt = false } = {}) {
  return '<li class="person-row" data-open-contact="' + escapeHtml(contact.id) + '" role="button" tabindex="0">'
    + '<div class="person-avatar" aria-hidden="true">' + escapeHtml(initialsFor(contact.name)) + '</div>'
    + '<div class="person-main">'
    + '<p class="person-name">' + escapeHtml(contact.name)
    + (contact.starred === true ? ' <span class="star-inline" aria-hidden="true">\u2605</span>' : '')
    + '</p>'
    + '<p class="tiny">' + escapeHtml(contact.role || "Role not set")
    + (contact.company ? ' @ <strong>' + escapeHtml(contact.company) + '</strong>' : '') + '</p>'
    // Two registers, on purpose. `prompt` is a row that is ASKING for something
    // — Reach out next — and gets the person-and-time sentence plus what you
    // last said (ORB-78). Everywhere else this row is a directory entry, where
    // the cadence is the useful fact and a sentence addressed to the reader
    // would be noise repeated down an alphabetical list.
    //
    // "Last connected no date" was what a never-contacted person got, which
    // reads as a missing field rather than a fact about the relationship
    // (ORB-75). There is nothing to be last, so the line says so instead.
    + (prompt
      ? reachOutPromptHtml(contact, health)
      : '<p class="tiny muted">'
        + (health.firstContact
          ? 'Not contacted yet'
          : 'Last connected ' + relativeDayLabel(contact.lastContacted))
        + (health.scheduled ? ' · ' + escapeHtml(getFreqLabel(contact.followUpFrequency)) : '')
        + '</p>')
    + (contact.industry ? '<span class="token token-industry">' + escapeHtml(contact.industry) + '</span>' : '')
    + '</div>'
    + '<div class="person-side">'
    + starButtonHtml(contact)
    + healthBarHtml(health)
    // Past tense, one click, because this reports something already done.
    // The draft/snooze/remove-schedule options keep their modal, demoted to the
    // icon beside it — they are the rare path, not the common one.
    + (showReconnect && health.scheduled
      ? '<div class="row-actions">'
        + '<button class="btn btn-sm" type="button" data-did-reach-out="'
          + escapeHtml(contact.id) + '">✓ Reached out</button>'
        + '<button class="btn btn-secondary btn-sm row-draft" type="button" data-remind-contact="'
          + escapeHtml(contact.id) + '"'
          + ' aria-label="Draft a message to ' + escapeHtml(contact.name) + '">Draft</button>'
        + '</div>'
      : '')
    + '</div>'
    + '</li>';
}

function wirePersonRows(root, contacts, onChanged) {
  root.querySelectorAll("[data-open-contact]").forEach((row) => {
    const open = () => {
      window.location.href = "contact.html?id=" + encodeURIComponent(row.dataset.openContact);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  root.querySelectorAll("[data-did-reach-out]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const contact = contacts.find((c) => c.id === btn.dataset.didReachOut);
      if (!contact) return;
      btn.disabled = true;
      // onChanged re-renders and replaces this button, so nothing needs to
      // re-enable it. The toast lives on document.body and survives that.
      await markReachedOut(contact, onChanged);
    });
  });
  root.querySelectorAll("[data-toggle-star]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      // The whole row opens the contact. Starring must not.
      e.stopPropagation();
      const contact = contacts.find((c) => c.id === btn.dataset.toggleStar);
      if (!contact) return;
      const next = !(contact.starred === true);
      btn.classList.toggle("starred", next);
      btn.setAttribute("aria-pressed", next ? "true" : "false");
      btn.textContent = next ? "\u2605" : "\u2606";
      await toggleStar(contact, onChanged);
    });
  });
  root.querySelectorAll("[data-remind-contact]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const contact = contacts.find((c) => c.id === btn.dataset.remindContact);
      if (contact) await showReminderModal(contact, onChanged);
    });
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function initDashboard() {
  const root = document.getElementById("dashboardContent");
  if (!root) return;

  let cached = [];

  /**
   * ORB-128. `preloaded` is what makes a save feel like it happened.
   *
   * Reported twice, from two angles: "someone tried to save a contact but it
   * didn't", and "the user was not able to immediately see that their contact
   * was saved." It had saved both times. Two things were hiding it — this
   * function goes back to the database before it can redraw, and on a free-tier
   * project that has been idle that is seconds, not milliseconds; and since
   * ORB-124 a newly added contact is on schedule rather than overdue, so
   * nothing on this page listed them at all.
   *
   * The saved contact is already in hand when `onSaved` fires, so it is drawn
   * from that immediately. The next real load reconciles it.
   */
  let prefs = {};

  async function render(preloaded) {
    const contacts = preloaded || (await db.getContacts()) || [];
    cached = contacts;
    // ORB-131. Read before anything computes a reason, because where you are
    // decides who is at the top of the list.
    prefs = (await db.getPreferences()) || {};
    setCurrentTrip(prefs);

    if (!contacts.length) {
      root.innerHTML = '<div class="card dash-empty">'
        + '<p class="dash-empty-icon">🛰️</p>'
        + '<h2>Your orbit starts here</h2>'
        + '<p class="muted">Add the people you meet, choose how often you want to reach out, '
        + 'and this page will show you who is drifting away.</p>'
        + '<a href="network.html" class="btn">Add your first connection</a>'
        + '</div>';
      return;
    }

    const counts = countByBand(contacts);
    const total = contacts.length;
    const scheduled = counts.good + counts.warning + counts.critical;
    // Denominators are the people you actually put on a cadence — those are the
    // only ones these three states can apply to. Contacts with no cadence are
    // not "failing", they are simply not being measured.
    const healthPct = scheduled ? Math.round((counts.good / scheduled) * 100) : 0;
    const attention = needsAttention(contacts);

    // With nothing scheduled the tiles would all read 0/0, which says nothing.
    const kpiHtml = scheduled
      ? '<div class="kpi-row">'
        + kpiTile("good", "In touch", counts.good, scheduled, "on cadence and current")
        + kpiTile("warning", "Going quiet", counts.warning, scheduled, "window closing")
        // "Overdue" overstated what this counts once ORB-54 reserved failure
        // language for the starred. The tile counts people past their date;
        // the sub-line says how many of them you actually said mattered.
        + kpiTile("critical", "Past their date", counts.critical, scheduled,
            counts.starredCritical
              ? counts.starredCritical + " you starred"
              : "none of them starred")
        + '</div>'
      : '<div class="card kpi-empty">'
        + '<p class="kpi-empty-title">No cadences set yet</p>'
        + '<p class="muted">You have ' + total + ' ' + (total === 1 ? "connection" : "connections") + '. '
        + 'Open someone in <a href="contacts.html">My Network</a> and choose how often to reach out — '
        + 'they will start showing up here.</p>'
        + '</div>';

    // Each chart card is header + centred body, so all three share a baseline
    // and neither the ring nor the empty state gets pushed into a corner.
    const chartCard = (title, sub, body, extraClass) =>
      '<section class="card chart-card' + (extraClass ? " " + extraClass : "") + '">'
      + '<header class="chart-head">'
      + '<h2 class="chart-title">' + escapeHtml(title) + '</h2>'
      + '<p class="chart-sub muted">' + escapeHtml(sub) + '</p>'
      + '</header>'
      + '<div class="chart-body">' + body + '</div>'
      + '</section>';

    // Coming up sits in this row rather than below it, so the four columns line
    // up with the four KPI tiles above: ring 1, breakdown 2, coming up 1 — the
    // last of which lands exactly under the Overdue tile.
    const chartsHtml = '<div class="chart-row">'
      + (scheduled
        ? chartCard("Network health", "Of those on a cadence, how many are current",
            ringHtml({ pct: healthPct,
                       band: healthPct >= 60 ? "good" : healthPct >= 25 ? "warning" : "critical",
                       caption: "In touch", sub: counts.good + " of " + scheduled }))
          + chartCard("Breakdown", "Where your scheduled connections stand",
              splitBarHtml(counts), "chart-card-wide")
        : "")
      + '<section id="upcomingMeetings" class="card chart-card upcoming-slot"></section>'
      + '</div>';

    // ORB-81. Always visible and always empty, at the top of the page you land
    // on. Behind a button it would cost two taps and lose to the thought.
    const captureHtml = '<section class="card capture-card dash-capture">'
      + '<h2 class="capture-heading">Thinking of someone?</h2>'
      + '<p class="muted">One line. It waits for you below.</p>'
      + captureFormHtml(contacts)
      + '</section>';

    const attentionHtml = '<section class="card dash-section">'
      + '<div class="dash-section-header">'
      + '<h2>Reach out next</h2>'
      // Was "People on a schedule who are drifting — most overdue first", which
      // described the query rather than the people (ORB-78). Two reasons land
      // people here now, and the note is the one worth naming (ORB-81).
      // ORB-126. "Then longest since you spoke" is now stated as what it is —
      // an observation you are free to ignore — rather than left to read as
      // the tail of a to-do list.
      + '<p class="muted">Anything you noted first, then the ones it has simply '
      + 'been a while with. Nothing here is owed.</p>'
      + '</div>'
      + (attention.length
        ? '<ul class="person-list">'
          + attention.map(({ contact, health }) =>
              personRowHtml(contact, health, { showReconnect: true, prompt: true })).join("")
          + '</ul>'
        : '<p class="empty">You are current with everyone on a schedule. Nice work.</p>')
      + '</section>';

    root.innerHTML = kpiHtml + tripBarHtml(prefs, contacts)
      + captureHtml + chartsHtml + attentionHtml;
    wireTripBar(root, prefs, () => render());
    wirePersonRows(root, contacts, render);
    wireCaptureForm(root, () => cached, render);
    // Renders from cache immediately; the background sync refreshes it.
    renderUpcomingMeetings();
  }

  function kpiTile(band, label, value, total, sub) {
    const meta = BAND_META[band];
    return '<div class="kpi-tile kpi-' + band + '">'
      + '<div class="kpi-head">'
      + '<span class="kpi-icon" aria-hidden="true">' + meta.icon + '</span>'
      + '<span class="kpi-label">' + escapeHtml(label) + '</span>'
      + '</div>'
      + '<p class="kpi-value">' + value + '<span class="kpi-total">/' + total + '</span></p>'
      + '<p class="kpi-sub">' + escapeHtml(sub) + '</p>'
      + '</div>';
  }

  await render();
  // Lets the calendar review modal refresh whatever page it was opened from,
  // so newly logged meetings appear without a reload (ORB-15).
  window.__orbitRefresh = render;
  // Draw the person the moment they exist, then let the next load confirm it.
  initQuickAddButton(() => cached, (saved) => render(withSaved(cached, saved)));
}

// ── My Network ────────────────────────────────────────────────────────────────

async function initMyNetwork() {
  const list = document.getElementById("myNetworkList");
  const barRoot = document.getElementById("networkFilterBar");
  if (!list || !barRoot) return;

  barRoot.innerHTML = filterBarHtml({
    placeholder: "Search name, role, company, industry…",
    filters: [
      STARRED_FILTER,
      STATUS_FILTER,
      CADENCE_FILTER,
      SILENCE_FILTER,
      { key: "industry", label: "Industry", options: [{ value: "", label: "All industries" }] }
    ]
  });

  let cached = [];
  const bar = wireFilterBar(barRoot, render);

  async function load() {
    cached = (await db.getContacts()) || [];
    // ORB-131. My Network shows the same reasons the dashboard does, so it has
    // to know the same thing about where you are.
    setCurrentTrip((await db.getPreferences()) || {});
    bar.setOptions("industry", [...new Set(cached.map((c) => c.industry).filter(Boolean))].sort());
    render();
  }

  function render() {
    const values = bar.values();
    const { q, industry } = values;

    const people = cached.filter((c) => {
      if (industry && c.industry !== industry) return false;
      if (!matchesConnectionFilters(c, values)) return false;
      if (!q) return true;
      return [c.name, c.role, c.company, c.industry, c.notes,
              ...(c.emails || []).map((e) => e.address)]
        .some((f) => f && f.toLowerCase().includes(q));
    });

    // Alphabetical by first name, with a letter header starting each run.
    people.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    bar.setCount(people.length === cached.length
      ? `${cached.length} ${cached.length === 1 ? "person" : "people"}`
      : `${people.length} of ${cached.length}`);

    if (!people.length) {
      // Two different nothings. Filters matching nobody is fixed by changing the
      // filters, so offering "add someone" there would answer a question nobody
      // asked. An empty network is fixed by adding someone (ORB-119).
      list.innerHTML = cached.length
        ? '<li class="empty">Nobody matches those filters.</li>'
        : '<li class="empty">' + networkEmptyHtml() + '</li>';
      list.querySelector("#networkEmptyAdd")
        ?.addEventListener("click", () => openQuickAddChooser(cached, load));
      return;
    }

    let html = "";
    let currentLetter = "";
    for (const c of people) {
      const first = (c.name || "?").trim()[0] || "#";
      const letter = /[a-z]/i.test(first) ? first.toUpperCase() : "#";
      if (letter !== currentLetter) {
        currentLetter = letter;
        html += '<li class="alpha-header"><span>' + escapeHtml(letter) + '</span></li>';
      }
      html += personRowHtml(c, getHealth(c), { showReconnect: true });
    }
    list.innerHTML = html;
    wirePersonRows(list, cached, load);
  }

  // ORB-119. My Network is where you go when you want to add somebody, and it
  // was the one page with no visible way to do it — the only route was a
  // floating circle you had to click to find out about. Same dialog as the
  // floating button, deliberately: a fifth entry point with its own behaviour is
  // how four ways to add a contact became impossible to reason about.
  document.getElementById("networkAddBtn")
    ?.addEventListener("click", () => openQuickAddChooser(cached, (saved) => {
      if (saved) { cached = withSaved(cached, saved); render(); }
      return load();
    }));

  await load();
  window.__orbitRefresh = load;
  initQuickAddButton(() => cached, (saved) => {
    if (saved) { cached = withSaved(cached, saved); render(); }
    return load();
  });
}

// ── Networking Log ────────────────────────────────────────────────────────────

async function initNetworkingLog() {
  const widgetRoot = document.getElementById("contactWidget");
  const list = document.getElementById("connectionList");
  if (!widgetRoot || !list) return;

  const barRoot = document.getElementById("logFilterBar");
  if (!barRoot) return;

  barRoot.innerHTML = filterBarHtml({
    placeholder: "Search name, role, company, notes…",
    filters: [
      STARRED_FILTER,
      STATUS_FILTER,
      CADENCE_FILTER,
      SILENCE_FILTER,
      { key: "industry", label: "Industry", options: [{ value: "", label: "All industries" }] },
      { key: "sort", label: "Sort by", options: [
        { value: "", label: "Most recent first" },
        { value: "oldest", label: "Oldest first" },
        { value: "name", label: "Name A–Z" }
      ] }
    ]
  });

  let cached = [];
  const bar = wireFilterBar(barRoot, renderList);

  async function reload() {
    try {
      cached = (await db.getContacts()) || [];
    } catch {
      list.innerHTML = '<li class="empty" style="color:var(--danger)">Error loading connections — check the console (F12).</li>';
      return;
    }
    bar.setOptions("industry", [...new Set(cached.map((c) => c.industry).filter(Boolean))].sort());
    renderList();
  }

  function renderList() {
    const values = bar.values();
    const { q: filterText, industry, sort } = values;

    let contacts = cached.filter((c) => {
      if (industry && c.industry !== industry) return false;
      if (!matchesConnectionFilters(c, values)) return false;
      if (!filterText) return true;
      return [c.name, c.role, c.company, c.industry, c.notes,
              ...(c.emails || []).map((e) => e.address)]
        .some((f) => f && f.toLowerCase().includes(filterText));
    });

    bar.setCount(contacts.length === cached.length
      ? `${cached.length} ${cached.length === 1 ? "entry" : "entries"}`
      : `${contacts.length} of ${cached.length}`);

    if (!contacts.length) {
      list.innerHTML = '<li class="empty">'
        + (cached.length ? 'Nobody matches those filters.'
                         : 'No connections logged yet — add your first one above.')
        + '</li>';
      return;
    }

    contacts = [...contacts];
    if (sort === "name") {
      contacts.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      contacts.sort((a, b) => String(b.lastContacted || "").localeCompare(String(a.lastContacted || "")));
      if (sort === "oldest") contacts.reverse();
    }

    // Month headers only make sense while sorted by date.
    const grouped = sort !== "name";
    let html = "";
    let currentGroup = "";
    for (const contact of contacts) {
      if (grouped) {
        const group = monthLabel(contact.lastContacted);
        if (group !== currentGroup) {
          currentGroup = group;
          html += '<li class="connection-group">' + escapeHtml(group) + '</li>';
        }
      }
      html += connectionRowHtml(contact);
    }
    list.innerHTML = html;
    wirePersonRows(list, cached, reload);
  }

  function monthLabel(value) {
    const date = parseDateOnly(value);
    if (!date) return "No date recorded";
    return date.toLocaleString("default", { month: "long", year: "numeric" });
  }

  function connectionRowHtml(contact) {
    const health = getHealth(contact);
    const date = parseDateOnly(contact.lastContacted);
    return '<li class="connection-row" data-open-contact="' + escapeHtml(contact.id) + '" role="button" tabindex="0">'
      + '<div class="connection-date">'
      + '<span class="connection-day">' + (date ? date.getDate() : "—") + '</span>'
      + '<span class="tiny muted">' + escapeHtml(relativeDayLabel(contact.lastContacted)) + '</span>'
      + '</div>'
      + '<div class="person-avatar" aria-hidden="true">' + escapeHtml(initialsFor(contact.name)) + '</div>'
      + '<div class="connection-main">'
      + '<p class="person-name">' + escapeHtml(contact.name) + ' ' + statusChip(health) + '</p>'
      + '<p class="tiny">' + escapeHtml(contact.role || "Role not set")
      + (contact.company ? ' @ <strong>' + escapeHtml(contact.company) + '</strong>' : '') + '</p>'
      + (contact.industry ? '<span class="token token-industry">' + escapeHtml(contact.industry) + '</span>' : '')
      + conversationPreview(contact)
      + '</div>'
      + '</li>';
  }

  widgetRoot.innerHTML = conversationWidgetHtml();
  wireConversationWidget(widgetRoot, () => cached, reload);

  await reload();
  window.__orbitRefresh = reload;
}

// ── Contact profile ───────────────────────────────────────────────────────────

async function initContactPage() {
  const root = document.getElementById("contactPageContent");
  if (!root) return;

  const contactId = new URLSearchParams(window.location.search).get("id");
  let allContacts = [];

  async function freshContact() {
    allContacts = (await db.getContacts()) || [];
    return allContacts.find((c) => c.id === contactId) || null;
  }

  async function save(updateFn) {
    const c = await freshContact();
    if (!c) return;
    await db.saveContact(normalizeContact(updateFn(c)));
  }

  let editing = false;

  async function renderPage() {
    const c = await freshContact();
    if (!c) {
      root.innerHTML = '<div class="card"><p class="error">Connection not found. <a href="contacts.html">Back to My Network</a></p></div>';
      return;
    }
    // Needed to resolve the ids each interaction carries into real attachments.
    const files = await db.fetchStorageFilesByContact(contactId);

    const health = getHealth(c);
    const isCustomFreq = c.followUpFrequency && c.followUpFrequency.startsWith("custom:");
    const freqSelectValue = isCustomFreq ? "custom" : (c.followUpFrequency || "none");
    const freqOptions = Object.entries(FREQUENCY_LABELS)
      .map(([v, l]) => '<option value="' + v + '"' + (freqSelectValue === v ? " selected" : "") + '>' + l + '</option>')
      .join("")
      + '<option value="custom"' + (isCustomFreq ? " selected" : "") + '>Custom…</option>';
    // ORB-94 took the picker away; effectiveTier stays because it is still how
    // "is this interval deliberate?" gets answered below, and because ORB-86
    // may revive tiers as a suggestion rather than a question.
    const shownTier = effectiveTier(c);
    // An interval the tier would not have produced was chosen on purpose — the
    // seasonal mentor you see twice a year, the custom:150 back-fills. Showing
    // the control expanded means a deliberate override is never hidden from the
    // person who made it.
    const isOverridden = (c.followUpFrequency || "none") !== frequencyForTier(shownTier);
    const pastCompanies = (c.companyHistory || []).filter((co) => co !== c.company);

    // The interval picker, or nothing at all (ORB-130). Assembled here rather
    // than wrapping fifteen lines of template in a ternary, which is how a
    // stray '' ends up concatenated into a page.
    //
    // The result line shows the cadence's consequence without a second control
    // competing with it. An interval the tier would not have produced was
    // chosen on purpose, so it opens expanded rather than hiding a deliberate
    // override behind a link.
    const cadenceControls = c.workingTogether ? '' : (
      '<p class="cadence-result tiny" id="cpCadenceLine">'
      + '<span id="cpCadenceText">' + escapeHtml(cadenceSentence(c.followUpFrequency)) + '</span> '
      + '<button type="button" class="link-btn" id="cpAdjust">Adjust</button></p>'
      + '<div class="field-group' + (isOverridden ? '' : ' hidden') + '" id="cpFreqGroup">'
      + '<label for="cpFrequency">Reach out again?</label>'
      + '<select id="cpFrequency">' + freqOptions + '</select></div>'
      + '<div class="field-group' + (isCustomFreq && isOverridden ? '' : ' hidden') + '" id="cpCustomDaysGroup">'
      + '<label for="cpCustomDays">Every how many days?</label>'
      + '<input type="number" id="cpCustomDays" min="1" max="365" placeholder="30" value="'
      + escapeHtml(isCustomFreq ? c.followUpFrequency.slice(7) : "") + '" /></div>'
    );

    root.innerHTML =
      '<a href="contacts.html" class="btn btn-secondary back-btn">← Back to My Network</a>'

      // ── Hero: identity on the left, reach-out panel on the right ──────────
      + '<div class="card profile-hero">'
      + (editing
        ? ''
        : '<button class="btn btn-secondary btn-sm profile-edit" id="cpEditBtn" type="button">Edit</button>')
      + '<div class="profile-identity">'
      + '<div class="profile-avatar" aria-hidden="true">' + escapeHtml(initialsFor(c.name)) + '</div>'
      + '<div class="profile-id-text">'
      + (editing
        ? '<input type="text" id="cpNameInput" class="profile-name-input" value="'
          + escapeHtml(c.name) + '" aria-label="Name" />'
        : '<h1 class="profile-name">' + escapeHtml(c.name || "Unnamed") + '</h1>')
      // The star belongs beside the name, not in the reach-out strip. It is a
      // statement about the person, not about their schedule (ORB-93).
      + (editing ? '' : starButtonHtml(c).replace('class="star-btn',
          'class="star-btn profile-star'))
      // One line, derived, read-only. Every one of these facts used to appear
      // twice — as a labelled block here AND as an input directly below — which
      // is what made this card long and lopsided. A field that is editable in
      // place does not also need displaying above it; the input IS the display.
      // What is worth keeping at a glance is who this person is, in a sentence.
      + '<p class="profile-role">'
      + (describeContact(c)
        ? escapeHtml(describeContact(c))
        : '<span class="profile-role-empty">Add their role and company below</span>')
      + '</p>'

      // View by default, edit on request. Everything used to be an input all
      // the time, which made a record you mostly read look like a form you were
      // expected to fill in — and made an accidental keystroke an edit.
      + '<div class="inline-edit" id="cpInlineEdit">'
      + (editing
        ? companyDatalist(allContacts, "cpCompanies")
          + industryDatalist(allContacts, "cpIndustries")
          + '<div class="inline-edit-grid">'

          + '<div class="field-group"><label for="cpRole">Role / Title</label>'
          + '<input type="text" id="cpRole" value="' + escapeHtml(c.role) + '" placeholder="Product Manager" /></div>'

          + '<div class="field-group"><label for="cpCompany">Current company</label>'
          + '<input type="text" id="cpCompany" list="cpCompanies" value="' + escapeHtml(c.company) + '" placeholder="Where they work now" /></div>'

          + '<div class="field-group"><label for="cpIndustry">Industry '
          + '<span class="opt-label">(optional)</span></label>'
          + '<input type="text" id="cpIndustry" list="cpIndustries" value="' + escapeHtml(c.industry) + '" placeholder="Technology" /></div>'

          // ORB-131. The datalist matters more than it looks: the trigger is a
          // string match against where YOU say you are, so "Hawaii" and
          // "Hawai'i" are different places. Offering what is already in the
          // network is what keeps one spelling.
          + placeDatalist(allContacts, "cpPlaces")
          + '<div class="field-group"><label for="cpLocation">Where they are '
          + '<span class="opt-label">(optional)</span></label>'
          + '<input type="text" id="cpLocation" list="cpPlaces" value="'
          + escapeHtml(c.location) + '" placeholder="Hawaii" />'
          + '<p class="tiny muted">Orbit will bring them up when you say you are '
          + 'there. Nothing else uses it.</p></div>'

          + '<div class="field-group field-multi field-email">'
          + '<div class="field-head"><label>Email</label>'
          + '<button class="field-add" id="cpAddEmail" type="button"'
          + ' aria-label="Add another email address" title="Add another address">+</button></div>'
          + '<div id="cpEmailList" class="email-list">'
          + (c.emails.length
            ? c.emails.map((e, i) => emailRowHtml(e, i)).join("")
            : emailRowHtml(normalizeEmail({ label: "personal" }), 0))
          + '</div></div>'

          + '<div class="field-group field-multi field-past">'
          + '<div class="field-head"><label for="cpAddPast">Past companies</label>'
          + '<button class="field-add" id="cpAddPastBtn" type="button"'
          + ' aria-label="Add a past company" title="Add a past company">+</button></div>'
          + '<div id="cpPastTokens">' + pastTokensHtml(pastCompanies) + '</div>'
          + '<input type="text" id="cpAddPast" list="cpCompanies" placeholder="Add a past company" />'
          + '</div>'

          + '</div>'
          + '<div class="inline-edit-save">'
          + '<button class="btn" id="cpSaveDetailsBtn" type="button">Save</button>'
          + '<button class="btn btn-secondary" id="cpCancelEdit" type="button">Cancel</button>'
          + '<p id="cpSaveDetailsMsg" class="success" aria-live="polite"></p>'
          + '</div>'
        : detailsViewHtml(c, pastCompanies))
      + '</div>'   // .inline-edit
      + '</div>'   // .profile-id-text
      + '</div>'   // .profile-identity

      // Wide horizontal reach-out strip: ring, facts, and controls in one row.
      // A sibling of .profile-identity, not a child — .profile-identity is a
      // flex ROW, so nesting it here put the strip beside the name instead of
      // beneath it and squeezed the details into a ~190px column.
      + '<div class="reachout-strip">'
      + '<div class="reachout-ring">'
      + ringHtml({
          pct: health.scheduled ? health.pct : 0,
          band: health.scheduled ? (health.tone || health.band) : "none",
          caption: bandWords(health).label,
          sub: health.working ? "no schedule needed"
            : !health.scheduled ? "Reach out again?"
            : health.daysLeft < 0 ? Math.abs(health.daysLeft) + " days over"
            : health.grace ? health.daysLeft + " days to first reach-out"
            : health.daysLeft + " days left"
        })
      + '</div>'
      // "Last connected: 4 months ago" was a labelled field. The same fact said
      // as a sentence about a person is what people actually act on (ORB-78),
      // and the last conversation's own words underneath make them concrete
      // again. The deadline stays — it is the one thing here the sentence does
      // not carry.
      + '<div class="reachout-said">'
      + reachOutPromptHtml(c, health)
      + '<dl class="reachout-meta">'
      + '<div><dt>' + (health.grace ? "Reach out by" : "Next nudge") + '</dt>'
      + '<dd>' + (c.nextReminder ? formatDate(c.nextReminder.split("T")[0]) : "—") + '</dd></div>'
      + '</dl>'
      + '</div>'
      + '<div class="reachout-controls">'
      // ORB-130. Above the cadence, and it hides it: this is not one option
      // among the intervals, it is the answer to a different question. Ticking
      // it while a schedule exists switches the reminders off and clears the
      // deadline (see the handler) — the digest reads next_reminder in SQL and
      // never calls getHealth, so a bar saying "working together" while an
      // email says "long silence" is the ORB-69 split all over again.
      + '<label class="working-toggle">'
      + '<input type="checkbox" id="cpWorking"' + (c.workingTogether ? ' checked' : '') + ' /> '
      + '<span>We work together — no schedule needed</span>'
      + '</label>'
      + cadenceControls
      + '<div class="reachout-actions">'
      + (c.workingTogether ? ''
        : '<button class="btn" id="cpSaveReminderBtn" type="button">Save</button>')
      // Same one-click gesture as the dashboard rows (ORB-13), so the habit
      // learned there still works here. Only meaningful on a cadence — and
      // "I reached out" says nothing about somebody you are in Slack with.
      + (health.scheduled && !health.working
        ? '<button class="btn btn-secondary" id="cpMarkDoneBtn" type="button">✓ Reached out</button>'
        : '')
      + '<button class="btn btn-secondary" id="cpOpenReminderBtn" type="button">Draft a message</button>'
      + '</div>'
      + '<p id="cpSaveReminderMsg" class="success" aria-live="polite"></p>'
      + '</div>'
      + (health.grace
        ? '<p class="grace-note">You have ' + GRACE_DAYS + ' days from setting this schedule to '
          + 'make the first reach-out. After that the normal cadence takes over.</p>'
        : '')
      + '</div>'
      + '</div>'

      // ── Body ──────────────────────────────────────────────────────────────
      + '<div class="profile-body">'

      // ORB-129. A contact created from a caught thought arrives with a name
      // and nothing else, and lands you here — so here is where it says what is
      // worth adding. Each line gives the reason, because "complete your
      // profile" is a chore and "so you can tell two Chrises apart" is not.
      //
      // No dismiss button: it disappears when it stops being true.
      + (profileIsBare(c) ? bareProfileHtml(c) : '')

      + '<section class="card">'
      + '<h3 class="section-title">Log a conversation</h3>'
      + '<div class="two-col">'
      + '<div class="field-group"><label for="cpIntDate">Date</label>'
      + '<input type="date" id="cpIntDate" value="' + todayDateString() + '" /></div>'
      + '<div class="field-group"><label for="cpIntType">Type</label>'
      + '<select id="cpIntType">'
      + INTERACTION_TYPES.map((t) => '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>').join("")
      + '</select></div>'
      + '</div>'
      + '<div class="field-group"><label>Notes</label>'
      + notesEditorHtml({
          id: "cpIntNotes",
          placeholder: "What did you talk about? What should you follow up on?"
        })
      + '</div>'
      + '<div class="field-group"><label for="cpIntDocInput">Attach a PDF <span class="opt-label">(optional)</span></label>'
      + '<input type="file" id="cpIntDocInput" accept="' + ATTACH_ACCEPT + '" /></div>'
      + '<p id="cpIntError" class="error" aria-live="polite"></p>'
      + '<button class="btn" id="cpAddIntBtn" type="button">Save conversation</button>'
      + '</section>'

      + '<section class="card">'
      + '<div class="followup-section-header">'
      + '<div><h3 class="section-title">Things to bring up next</h3>'
      + '<p class="section-sub muted">What is still to raise, what carried over from before your last conversation, and what you have ticked off.</p></div>'
      + '<button class="btn btn-secondary btn-sm" id="cpSuggestBtn" type="button">✦ Suggest</button>'
      + '</div>'
      + '<div id="cpFollowUpList">' + renderFollowUpItems(c) + '</div>'
      + '<div class="followup-add-row">'
      + '<input type="text" id="cpNewFollowUp" placeholder="Add a talking point…" />'
      + '<button class="btn" id="cpAddFollowUpBtn" type="button">Add</button>'
      + '</div>'
      + '<p id="cpFollowUpMsg" class="success" aria-live="polite"></p>'
      + '</section>'

      + '<section class="card profile-timeline">'
      // The count says how much is below the fold rather than leaving it to be
      // discovered by scrolling — same reasoning as the "Coming up" card.
      + '<h3 class="section-title">Conversation history'
      + ((c.interactions || []).length > 3
        ? '<span class="chart-count">' + (c.interactions || []).length + '</span>' : '')
      + '</h3>'
      + '<div class="timeline">'
      + renderInteractionTimeline(c.interactions, files, { name: c.name, dateMet: c.dateMet })
      + '</div>'
      + '</section>'

      + '</div>'

      // ── Danger zone, at the bottom where it belongs ───────────────────────
      + '<section class="card danger-zone">'
      + '<div><h3 class="section-title">Delete this connection</h3>'
      + '<p class="section-sub muted">Removes ' + escapeHtml(c.name) + ' and their whole history. This cannot be undone.</p></div>'
      + '<button class="btn danger-btn" id="cpDeleteBtn" type="button">Delete connection</button>'
      + '</section>';

    wireProfile(c);
  }

  function wireProfile(c) {
    const $ = (sel) => root.querySelector(sel);

    // ORB-127. The name used to save itself on blur, independently of the form
    // it sits in, and that is what lost it.
    //
    // Pressing Save blurs the input first, so two writes started in a row: the
    // blur handler read the contact and wrote the new name; the Save handler
    // read the contact — usually before that write had landed — and wrote the
    // whole form back over it, name included, from stale state. Last write
    // wins, the last write was the old name, and nothing errored.
    //
    // The fix is the one already written a few lines below for the primary
    // email: **this form owns the whole record, so it owns the name too.** One
    // writer, one read, no race. It also makes Cancel discard a name edit,
    // which is what Cancel does to every other field on the same card.

    // ORB-93. Uses the same toggleStar as the row so the toast, the failure
    // path and the stored value cannot differ between the two places you can
    // star someone.
    root.querySelector("[data-toggle-star]")?.addEventListener("click", async () => {
      const cur = await freshContact();
      if (cur) await toggleStar(cur, renderPage);
    });

    const startEditing = async () => {
      editing = true;
      await renderPage();
      root.querySelector("#cpRole")?.focus();
    };
    /**
     * ORB-130. Ticking this clears the schedule rather than sitting beside it.
     *
     * `getHealth` is not the only thing that decides who gets contacted. The
     * digest queries `next_reminder` in SQL, server-side, and never calls it —
     * so leaving a deadline behind would show "Working together" on the profile
     * while an email arrived saying it had been a long silence. That is ORB-69's
     * bug exactly, and the fix is the same: make the stored data agree.
     *
     * `followUpFrequency` is KEPT, so unticking restores the rhythm you had
     * instead of making you remember what it was — counted from today, since
     * the months in between were not a lapse.
     */
    $("#cpWorking")?.addEventListener("change", async (e) => {
      const on = e.target.checked;
      await save((cur) => ({
        ...cur,
        workingTogether: on,
        reminderEnabled: on ? false : (cur.followUpFrequency || "none") !== "none",
        nextReminder: on ? ""
          : (cur.followUpFrequency || "none") === "none" ? ""
          : calculateNextReminder(todayDateString(), cur.followUpFrequency)
      }));
      await renderPage();
      showToast(on
        ? "No schedule for " + firstNameOf(c.name) + " — you are already in touch."
        : "Schedule back on for " + firstNameOf(c.name) + ".");
    });

    $("#cpEditBtn")?.addEventListener("click", startEditing);
    // ORB-129. Same gesture as Edit, so there is one way in and not two that
    // could drift apart.
    $("#cpFillIn")?.addEventListener("click", startEditing);

    $("#cpCancelEdit")?.addEventListener("click", async () => {
      // Re-renders from saved state, so cancelling discards rather than keeping
      // whatever was half-typed.
      editing = false;
      await renderPage();
    });

    /** Everything currently typed into the details form. */
    function readDetails() {
      return {
        name: $("#cpNameInput")?.value.trim() ?? "",
        role: $("#cpRole").value.trim(),
        company: $("#cpCompany").value.trim(),
        industry: $("#cpIndustry").value.trim(),
        location: $("#cpLocation")?.value.trim() ?? "",
        emails: readEmailRows()
      };
    }

    /** Applies the form to a contact, moving a replaced company into history. */
    function applyDetails(cur, extraPast = "") {
      const form = readDetails();
      const history = [...(cur.companyHistory || [])];
      if (cur.company && form.company && cur.company !== form.company
          && !history.includes(cur.company)) {
        history.push(cur.company);
      }
      if (extraPast && !history.includes(extraPast)) history.push(extraPast);
      return {
        ...cur,
        // Falls back rather than blanking. commitDetails also runs on field
        // changes elsewhere on the card, where the name input may not be on
        // screen at all — those must not wipe a name they never showed.
        name: form.name || cur.name,
        role: form.role,
        company: form.company,
        industry: form.industry,
        location: form.location,
        emails: form.emails,
        // Set explicitly, because leaving the old value in place made the
        // primary address undeletable: normalizeEmails treats an `email` the
        // list does not contain as a new address to promote, so removing the
        // first row put it straight back and the delete looked like it had
        // silently failed. This form owns the whole list, so it owns the
        // primary too.
        email: form.emails[0]?.address || "",
        companyHistory: history
      };
    }

    /**
     * Save what is on screen, and stay where you are.
     *
     * The repeatable fields commit when you leave them rather than waiting for
     * the Save button, because "type an address, click the next field, lose it"
     * is the failure people actually hit — and a `+` you have to find first is
     * a gesture the rest of the form does not ask for.
     *
     * Deliberately does NOT re-render. You are still in the form; rebuilding it
     * under you would take the caret and anything else half-typed with it.
     */
    async function commitDetails(extraPast = "") {
      await save((cur) => applyDetails(cur, extraPast));
      const msg = $("#cpSaveDetailsMsg");
      if (!msg) return;
      // Shared with the empty-name error above, which swaps the class.
      msg.className = "success";
      // Quiet, and it says what happened. A toast for every field you tab out
      // of would be the app applauding itself.
      msg.textContent = "Saved";
      clearTimeout(commitDetails._timer);
      commitDetails._timer = setTimeout(() => { msg.textContent = ""; }, 2000);
    }

    $("#cpSaveDetailsBtn")?.addEventListener("click", async () => {
      // A name is the one thing required, here as in the add form. Silently
      // restoring the old one would look exactly like the bug this replaces.
      const nameEl = $("#cpNameInput");
      if (nameEl && !nameEl.value.trim()) {
        const msg = $("#cpSaveDetailsMsg");
        if (msg) {
          msg.textContent = "A name is the one thing required.";
          msg.className = "error";
        }
        nameEl.focus();
        return;
      }
      // Whatever is sitting in "Add a past company" counts as typed, the same
      // as every other field. Passing applyDetails bare left extraPast at its
      // default of "" — so a company you typed and then clicked Save on was
      // silently dropped, and only the + button or Enter ever committed it.
      // A form where one field needs a different gesture is a form with a bug.
      await save((cur) => applyDetails(cur, $("#cpAddPast")?.value.trim() || ""));
      editing = false;
      await renderPage();
      showToast("Details saved.");
    });

    /** Reads the rows as typed, so an unsaved edit is never lost on add/remove. */
    function readEmailRows() {
      return [...root.querySelectorAll(".email-row")].map((row) => ({
        label: row.querySelector(".email-kind").value,
        address: row.querySelector(".email-address").value.trim()
      })).filter((e) => e.address);
    }

    function attachEmailListeners() {
      const list = root.querySelector("#cpEmailList");
      if (!list) return;

      root.querySelector("#cpAddEmail")?.addEventListener("click", () => {
        // Rendered from what is on screen rather than from saved state, or
        // adding a row would discard anything typed but not yet saved.
        const current = readEmailRows();
        current.push({ label: "work", address: "" });
        list.innerHTML = current.map((e, i) => emailRowHtml(normalizeEmail(e), i)).join("");
        attachEmailListeners();
        list.querySelector(".email-row:last-child .email-address")?.focus();
      });

      list.querySelectorAll(".email-remove").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.closest(".email-row").remove();
          // An empty list still needs somewhere to type.
          if (!list.querySelector(".email-row")) {
            list.innerHTML = emailRowHtml(normalizeEmail({ label: "personal" }), 0);
            attachEmailListeners();
          }
          // Removing is an edit like any other. Without this, deleting an
          // address and navigating away left it exactly where it was.
          await commitDetails();
        });
      });

      // `change` rather than `blur`: it fires when you leave a field you
      // actually altered, so tabbing through a form you only read does not
      // write to the database on every stop.
      list.querySelectorAll(".email-address, .email-kind").forEach((field) => {
        field.addEventListener("change", () => commitDetails());
      });
    }
    attachEmailListeners();

    /**
     * Commit a past company and show its chip, without rebuilding the form.
     *
     * Only this block is re-rendered. Re-rendering the page instead — which is
     * what this used to do — is fine after a deliberate click on Save, but not
     * when you are simply moving to the next field.
     */
    const addPast = async () => {
      const input = $("#cpAddPast");
      const value = input.value.trim();
      if (!value) return;
      // Saves the rest of the form alongside it, so adding a company never
      // discards something typed above and not yet committed.
      await commitDetails(value);
      input.value = "";

      const slot = $("#cpPastTokens");
      const contact = await freshContact();
      if (slot && contact) {
        slot.innerHTML = pastTokensHtml(
          (contact.companyHistory || []).filter((co) => co !== contact.company)
        );
        wirePastRemovals();
      }
    };

    // Three ways in, because each is something someone will actually do:
    // click +, press Enter, or just move on to the next field.
    $("#cpAddPastBtn")?.addEventListener("click", addPast);
    $("#cpAddPast")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addPast(); } });
    $("#cpAddPast")?.addEventListener("change", addPast);

    function wirePastRemovals() {
      root.querySelectorAll("[data-remove-company]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const target = btn.dataset.removeCompany;
          await save((cur) => ({ ...cur, companyHistory: cur.companyHistory.filter((co) => co !== target) }));
          btn.closest(".token-past")?.remove();
        });
      });
    }
    wirePastRemovals();

    // ORB-130. None of these exist when the contact is marked as somebody you
    // work with — the whole cadence block is absent, not hidden. Every listener
    // below is therefore optional, and the guards are the ticket rather than
    // defensive noise: the first version of this crashed on the re-render
    // immediately after ticking the box.
    const freqSelect = $("#cpFrequency");
    const customGroup = $("#cpCustomDaysGroup");
    const freqGroup = $("#cpFreqGroup");

    /** The interval the controls currently describe, in stored form. */
    const chosenFrequency = () => {
      if (!freqSelect) return "none";
      if (freqSelect.value !== "custom") return freqSelect.value;
      const days = parseInt($("#cpCustomDays")?.value, 10);
      return (!Number.isNaN(days) && days > 0) ? "custom:" + days : "none";
    };
    const refreshCadenceLine = () => {
      const line = $("#cpCadenceText");
      if (line) line.textContent = cadenceSentence(chosenFrequency());
    };

    freqSelect?.addEventListener("change", () => {
      customGroup.classList.toggle("hidden", freqSelect.value !== "custom");
      refreshCadenceLine();
    });
    $("#cpCustomDays")?.addEventListener("input", refreshCadenceLine);

    // The override is one click away rather than a second question competing
    // with the first. Once open it stays open — hiding a control someone just
    // asked for would be worse than the clutter it was meant to avoid.
    $("#cpAdjust")?.addEventListener("click", () => {
      freqGroup.classList.remove("hidden");
      customGroup.classList.toggle("hidden", freqSelect.value !== "custom");
      freqSelect.focus();
    });

    $("#cpSaveReminderBtn")?.addEventListener("click", async () => {
      let newFreq = freqSelect.value;
      if (newFreq === "custom") {
        const days = parseInt($("#cpCustomDays")?.value, 10);
        newFreq = (!Number.isNaN(days) && days > 0) ? "custom:" + days : "none";
      }
      await save((cur) => {
        const wasOff = !cur.reminderEnabled || cur.followUpFrequency === "none";
        const anchor = cur.lastContacted || cur.dateMet;
        // ORB-107. Pressing Save used to recompute the deadline unconditionally,
        // which silently threw away a snooze: "Remind me in 3 days", then Save
        // without touching anything, and the three days were gone. Nothing
        // errored and the button reported success.
        //
        // A deadline is only recomputed when the cadence actually changed.
        // Otherwise `nextReminder` is left exactly as it is — it is the single
        // source of truth precisely because it carries the grace window and any
        // snooze, and recomputing it from the interval discards both.
        const unchanged = !wasOff && newFreq === cur.followUpFrequency;
        return {
          ...cur,
          followUpFrequency: newFreq,
          // The tier is deliberately NOT written here any more (ORB-94). It
          // used to be saved on every schedule save, because pressing Save was
          // the user answering the tier question — there is no longer a tier
          // question, so writing `effectiveTier(c)` would record an inference
          // as a choice. Whatever tier a contact already carries is left
          // exactly as it was, which is what keeps ORB-86's future evidence
          // honest.
          reminderEnabled: newFreq !== "none",
          // Switching a schedule ON grants the one-week grace window if the
          // cadence alone would already be blown. Editing an existing cadence
          // keeps the normal deadline — the grace is not re-granted.
          nextReminder: newFreq === "none" ? ""
            : unchanged ? cur.nextReminder
            : wasOff ? firstDeadlineFor(anchor, newFreq)
                     : calculateNextReminder(anchor, newFreq)
        };
      });
      const msg = $("#cpSaveReminderMsg");
      msg.textContent = "Schedule saved!";
      setTimeout(() => { msg.textContent = ""; }, 2000);
      await renderPage();
    });

    // currentTarget is nulled once dispatch ends, so grab the button before the
    // first await, not after.
    $("#cpMarkDoneBtn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const fresh = await freshContact();
      if (!fresh) { btn.disabled = false; return; }
      await markReachedOut(fresh, renderPage);
    });

    $("#cpOpenReminderBtn")?.addEventListener("click", async () => {
      const fresh = await freshContact();
      if (fresh) await showReminderModal(fresh, renderPage);
    });

    $("#cpDeleteBtn").addEventListener("click", async () => {
      const contact = await freshContact();
      if (!contact || !window.confirm("Delete " + contact.name + " and their whole history?")) return;
      await db.deleteContact(contactId);
      window.location.href = "contacts.html";
    });

    // Third notes box, same treatment — logging from the profile should not be
    // the one place formatting is missing.
    const intNotesEl = $("#cpIntNotes");
    const intNotes = intNotesEl
      ? wireNotesEditor(intNotesEl.closest(".field-group"), intNotesEl) : null;

    $("#cpAddIntBtn").addEventListener("click", async () => {
      const errEl = $("#cpIntError");
      errEl.textContent = "";
      const date = $("#cpIntDate").value;
      if (!date) { errEl.textContent = "Date is required."; return; }

      const docFile = $("#cpIntDocInput")?.files?.[0];
      if (docFile && !isAllowedAttachment(docFile)) {
        errEl.textContent = ATTACH_REJECT_MSG; return;
      }

      const interaction = normalizeInteraction({
        date, type: $("#cpIntType").value,
        notes: (intNotes ? intNotes.getMarks() : "").trim()
      });

      // Upload before saving so the interaction carries the id from the start.
      // The contact id is already known here, so this needs only one write.
      // A failed upload must not cost the user the conversation.
      let attachmentFailed = false;
      if (docFile) {
        const uploaded = await db.uploadFileToStorage(docFile, { contactId });
        if (uploaded) interaction.fileIds = [uploaded.id];
        else attachmentFailed = true;
      }

      await save((cur) => {
        const newInteractions = [interaction, ...cur.interactions].sort((a, b) => b.date.localeCompare(a.date));
        return {
          ...cur,
          interactions: newInteractions,
          lastContacted: newInteractions[0].date,
          nextReminder: calculateNextReminder(newInteractions[0].date, cur.followUpFrequency)
        };
      });
      await renderPage();
      // renderPage rebuilds the form, so errEl is gone by now — the warning has
      // to live outside it.
      if (attachmentFailed) {
        showToast("Conversation saved, but the PDF could not be uploaded.");
      }
    });

    const addFollowUp = async () => {
      const input = $("#cpNewFollowUp");
      const text = input ? input.value.trim() : "";
      if (!text) return;
      await save((cur) => ({ ...cur, followUps: [normalizeFollowUpItem({ text, source: "manual" }), ...(cur.followUps || [])] }));
      if (input) input.value = "";
      await refreshFollowUps();
    };
    $("#cpAddFollowUpBtn").addEventListener("click", addFollowUp);
    $("#cpNewFollowUp").addEventListener("keydown", (e) => { if (e.key === "Enter") addFollowUp(); });

    $("#cpSuggestBtn").addEventListener("click", async () => {
      const fresh = await freshContact();
      if (!fresh) return;
      const existing = new Set((fresh.followUps || []).map((f) => f.text.toLowerCase()));
      const deduped = generateFollowUpSuggestions(fresh)
        .map((s) => normalizeFollowUpItem({
          text: s.text, source: "ai", sourceInteractionId: s.sourceInteractionId
        }))
        .filter((f) => !existing.has(f.text.toLowerCase()));
      const msg = $("#cpFollowUpMsg");
      if (!deduped.length) {
        msg.textContent = "All suggestions already added!";
        setTimeout(() => { msg.textContent = ""; }, 2500);
        return;
      }
      await save((cur) => ({ ...cur, followUps: [...deduped, ...(cur.followUps || [])] }));
      await refreshFollowUps();
      msg.textContent = deduped.length + " suggestion" + (deduped.length !== 1 ? "s" : "") + " added!";
      setTimeout(() => { msg.textContent = ""; }, 2500);
    });

    async function refreshFollowUps() {
      const fresh = await freshContact();
      const listEl = $("#cpFollowUpList");
      if (listEl && fresh) listEl.innerHTML = renderFollowUpItems(fresh);
      attachFollowUpListeners();
    }

    function attachFollowUpListeners() {
      root.querySelectorAll(".fu-checkbox").forEach((cb) => {
        cb.addEventListener("change", async () => {
          await save((cur) => ({
            ...cur,
            followUps: (cur.followUps || []).map((f) => f.id !== cb.dataset.fuId ? f
              // Stamped on the way in and cleared on the way out, so un-ticking
              // does not leave a completion date on a live point.
              : { ...f, completed: cb.checked,
                  completedAt: cb.checked ? new Date().toISOString() : "" })
          }));
          await refreshFollowUps();
        });
      });
      root.querySelectorAll(".fu-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await save((cur) => ({ ...cur, followUps: (cur.followUps || []).filter((f) => f.id !== btn.dataset.fuId) }));
          await refreshFollowUps();
        });
      });
    }
    attachFollowUpListeners();
    attachConversationEditors();
  }

  /**
   * Let any conversation's notes be rewritten in place.
   *
   * Follows the file-rename pattern already in this file: swap the text for an
   * input, commit on blur or Enter, abandon on Escape. Nothing is saved unless
   * the text actually changed, so opening an editor by accident costs nothing.
   */
  function attachConversationEditors() {
    // One dialog does both (ORB-64). Delete lives inside it, so removing a
    // conversation now takes opening the thing you are about to destroy.
    //
    // Deleting is confirmed rather than undoable: unlike a reach-out, a
    // conversation carries notes you cannot reconstruct, and an undo toast that
    // vanishes after eight seconds is a poor guardian of the only copy.
    // ORB-62. A person you talk to often gave an endlessly long profile; the
    // list holds three and scrolls the rest, the same way the dashboard's
    // "Coming up" card does.
    wireScrollFade(root.querySelector(".timeline"));

    root.querySelectorAll("[data-edit-convo]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.editConvo;
        const current = await freshContact();
        const item = (current?.interactions || []).find((i) => i.id === id);
        if (!item) return;

        // A legacy synced row still carries its title inside the notes, so the
        // editor is handed the split version — otherwise you would open it and
        // find Orbit's heading sitting in your own text.
        const shownTitle = conversationTitle(item);
        openConversationEditor(
          { ...item, title: shownTitle, notes: conversationNotes(item) },
          {
          title: shownTitle || (item.type
            ? item.type.charAt(0).toUpperCase() + item.type.slice(1)
            : "Conversation") + " · " + formatDate(item.date),

          onSubmit: async ({ date, type, notes, file }) => {
            // Upload first, but never let it cost the notes: a failed
            // attachment still saves the text and says so.
            let newFileId = null;
            let attachmentFailed = false;
            if (file) {
              const uploaded = await db.uploadFileToStorage(file, { contactId });
              if (uploaded) newFileId = uploaded.id;
              else attachmentFailed = true;
            }

            await save((cur) => {
              const next = (cur.interactions || []).map((i) =>
                i.id === id
                  ? normalizeInteraction({
                      // Saving migrates a legacy row: the title becomes its own
                      // field for good, rather than being re-derived on every
                      // render for the rest of the conversation's life.
                      ...i, date: date || i.date, type, notes,
                      title: shownTitle,
                      fileIds: newFileId ? [...(i.fileIds || []), newFileId] : (i.fileIds || [])
                    })
                  : i);
              // The date is editable here, so the most recent conversation can
              // change identity on save — the same recalculation delete needs.
              const newest = [...next].sort((a, b) => b.date.localeCompare(a.date))[0];
              return {
                ...cur,
                interactions: next,
                lastContacted: newest ? newest.date : (cur.dateMet || ""),
                nextReminder: !cur.reminderEnabled || cur.followUpFrequency === "none"
                  ? cur.nextReminder
                  : calculateNextReminder(
                      newest ? newest.date : (cur.dateMet || todayDateString()),
                      cur.followUpFrequency)
              };
            });
            await renderPage();
            showToast(attachmentFailed
              ? "Saved — the file could not be attached."
              : newFileId ? "Conversation and transcript saved." : "Conversation saved.");
          },

          onDelete: async () => {
            await save((cur) => {
              const kept = (cur.interactions || []).filter((i) => i.id !== id);
              const newest = [...kept].sort((a, b) => b.date.localeCompare(a.date))[0];
              return {
                ...cur,
                interactions: kept,
                // Removing the most recent conversation has to move the
                // relationship back to whatever is now newest, or the health
                // bar keeps counting from a touchpoint that no longer exists.
                lastContacted: newest ? newest.date : (cur.dateMet || ""),
                nextReminder: !cur.reminderEnabled || cur.followUpFrequency === "none"
                  ? cur.nextReminder
                  : calculateNextReminder(
                      newest ? newest.date : (cur.dateMet || todayDateString()),
                      cur.followUpFrequency)
              };
            });
            await renderPage();
            showToast("Conversation deleted.");
          }
        }
        );
      });
    });
  }

  await renderPage();
  window.__orbitRefresh = renderPage;
}

// ── Files ─────────────────────────────────────────────────────────────────────

async function initFilesPage() {
  const fileGrid = document.getElementById("fileGrid");
  if (!fileGrid) return;

  let allFiles = [];
  let contacts = [];
  const byId = new Map();

  const contactSelect = document.getElementById("fileContact");
  const barRoot = document.getElementById("fileFilterBar");

  contacts = (await db.getContacts()) || [];
  contacts.forEach((c) => byId.set(c.id, c));
  const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name));

  if (contactSelect) {
    sorted.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name + (c.company ? " @ " + c.company : "");
      contactSelect.appendChild(opt);
    });
  }

  barRoot.innerHTML = filterBarHtml({
    placeholder: "Search file, person, role, company…",
    filters: [
      { key: "linked", label: "Connection", options: [
        { value: "", label: "All connections" },
        { value: "__none__", label: "Not linked" },
        ...sorted.map((c) => ({ value: c.id, label: c.name }))
      ] },
      { key: "industry", label: "Industry", options: [
        { value: "", label: "All industries" },
        ...[...new Set(contacts.map((c) => c.industry).filter(Boolean))].sort()
          .map((i) => ({ value: i, label: i }))
      ] },
      { key: "role", label: "Role", options: [
        { value: "", label: "All roles" },
        ...[...new Set(contacts.map((c) => c.role).filter(Boolean))].sort()
          .map((r) => ({ value: r, label: r }))
      ] }
    ]
  });
  const bar = wireFilterBar(barRoot, renderGrid);

  // ── Upload ───────────────────────────────────────────────────────────────
  const dropZone = document.getElementById("fileDropZone");
  const fileInput = document.getElementById("fileInput");
  const preview = document.getElementById("fileDropPreview");
  const errEl = document.getElementById("fileUploadError");
  const msgEl = document.getElementById("fileUploadMsg");
  let pendingFile = null;

  function validateAndPreview(file) {
    if (!file) return;
    if (!isAllowedAttachment(file)) {
      if (errEl) errEl.textContent = ATTACH_REJECT_MSG;
      return;
    }
    if (errEl) errEl.textContent = "";
    pendingFile = file;
    if (preview) {
      preview.textContent = "📄 " + file.name + " (" + (file.size / 1024).toFixed(1) + " KB)";
      preview.classList.remove("hidden");
    }
    if (dropZone) dropZone.classList.add("file-drop-zone-ready");
  }

  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("file-drop-zone-hover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("file-drop-zone-hover"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("file-drop-zone-hover");
      validateAndPreview(e.dataTransfer.files[0]);
    });
    dropZone.addEventListener("click", () => fileInput && fileInput.click());
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (fileInput) fileInput.click(); }
    });
  }
  if (fileInput) fileInput.addEventListener("change", () => validateAndPreview(fileInput.files[0]));

  const uploadBtn = document.getElementById("fileUploadBtn");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      if (errEl) errEl.textContent = "";
      if (msgEl) msgEl.textContent = "";
      const file = pendingFile || (fileInput && fileInput.files[0]);
      if (!file) { if (errEl) errEl.textContent = "Please select a PDF first."; return; }
      if (!isAllowedAttachment(file)) { if (errEl) errEl.textContent = ATTACH_REJECT_MSG; return; }

      uploadBtn.disabled = true;
      uploadBtn.textContent = "Uploading…";
      const result = await db.uploadFileToStorage(file, { contactId: contactSelect?.value || null });
      uploadBtn.disabled = false;
      uploadBtn.textContent = "Upload PDF →";

      if (!result) {
        if (errEl) errEl.textContent = "Upload failed. Check that the storage bucket exists.";
        return;
      }
      pendingFile = null;
      if (fileInput) fileInput.value = "";
      if (preview) { preview.classList.add("hidden"); preview.textContent = ""; }
      if (dropZone) dropZone.classList.remove("file-drop-zone-ready");
      if (msgEl) {
        msgEl.textContent = "✅ Uploaded.";
        setTimeout(() => { if (msgEl) msgEl.textContent = ""; }, 3000);
      }
      await loadAndRenderFiles();
    });
  }

  // ── Filter + render ──────────────────────────────────────────────────────
  function renderGrid() {
    const { q, linked, industry, role } = bar.values();

    const filtered = allFiles.filter((f) => {
      const contact = f.contactId ? byId.get(f.contactId) : null;
      if (linked === "__none__" && f.contactId) return false;
      if (linked && linked !== "__none__" && f.contactId !== linked) return false;
      if (industry && (!contact || contact.industry !== industry)) return false;
      if (role && (!contact || contact.role !== role)) return false;
      if (!q) return true;
      return [f.name, contact?.name, contact?.role, contact?.company, contact?.industry]
        .some((field) => field && field.toLowerCase().includes(q));
    });

    bar.setCount(filtered.length === allFiles.length
      ? `${allFiles.length} ${allFiles.length === 1 ? "file" : "files"}`
      : `${filtered.length} of ${allFiles.length}`);

    if (!filtered.length) {
      fileGrid.innerHTML = '<p class="empty" style="padding:1rem 0">'
        + (allFiles.length ? "No files match those filters." : "No files uploaded yet.") + '</p>';
      return;
    }
    fileGrid.innerHTML = filtered
      .map((f) => renderStorageFileCard(f, f.contactId ? byId.get(f.contactId) : null))
      .join("");
    attachStorageFileCardListeners(fileGrid, loadAndRenderFiles);
  }

  async function loadAndRenderFiles() {
    allFiles = await db.fetchAllStorageFiles();
    renderGrid();
  }

  await loadAndRenderFiles();
}

// ── Settings ──────────────────────────────────────────────────────────────────
// `preferences.your_name` signs the draft messages. Without somewhere to set it
// every draft went out as "[Your Name]".

// How often the reach-out nudge is allowed to interrupt you. Stored per device.
const NUDGE_KEY = "orbit_nudge_mode";
const NUDGE_SEEN_KEY = "orbit_nudge_last";

function getNudgeMode() { return localStorage.getItem(NUDGE_KEY) || "daily"; }

/** True when the on-load reach-out modal is allowed to show right now. */
function nudgeAllowed() {
  const mode = getNudgeMode();
  if (mode === "off") return false;
  if (mode === "always") return true;
  return localStorage.getItem(NUDGE_SEEN_KEY) !== todayDateString();
}

function markNudgeShown() {
  localStorage.setItem(NUDGE_SEEN_KEY, todayDateString());
}

/**
 * Dismissing has to dismiss the person, not the box (ORB-126).
 *
 * THE REPORTED BUG. "It keeps saying say thank you to Hunter. I already sent
 * the thank you message. I want to keep dismissing it, but it keeps popping
 * up." Both halves were true and they had different causes.
 *
 * The thank-you note was a capture, and a capture stays open until something
 * closes it. `markReachedOut` does close it — but she sent the message from her
 * own email, so the app never heard. Nothing is wrong with that; **the app
 * cannot see outside itself, and the answer is not to nag until it can.**
 *
 * The second half was a plain defect. The ✕ called `close()`, which removed a
 * DOM node and recorded nothing, so the same person returned the next morning
 * with the same sentence, for ever. Dismissal cost nothing and bought nothing.
 *
 * THIRTY DAYS, AND WHY NOT SEVEN. Jack Witt contacts the people he values most
 * about once a year. A week's silence from a nudge is not a dismissal, it is a
 * pause for breath. The person stays on the dashboard the whole time — they are
 * quieter, not hidden, which is the ORB-64 rule again.
 *
 * localStorage rather than the database, deliberately: the whole nudge feature
 * already lives there (mode, last-shown), the server-side digest has its own
 * opt-out, and a snooze that needed a migration would not have shipped today.
 */
const NUDGE_SNOOZE_KEY = "orbit_nudge_snoozed";
const NUDGE_SNOOZE_DAYS = 30;

function readNudgeSnoozes() {
  try {
    const raw = JSON.parse(localStorage.getItem(NUDGE_SNOOZE_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    // A corrupted value must not take the nudge down with it.
    return {};
  }
}

/** Expired entries are dropped on every write, so the map cannot grow for ever. */
function writeNudgeSnoozes(map) {
  const today = todayDateString();
  const live = Object.fromEntries(
    Object.entries(map).filter(([, until]) => String(until) > today));
  localStorage.setItem(NUDGE_SNOOZE_KEY, JSON.stringify(live));
  return live;
}

function snoozeNudge(contactId, days = NUDGE_SNOOZE_DAYS) {
  if (!contactId) return "";
  const until = addDays(todayDateString(), days);
  writeNudgeSnoozes({ ...readNudgeSnoozes(), [contactId]: until });
  return until;
}

/** Reaching out is a fresh start, so it clears the snooze rather than keeping it. */
function clearNudgeSnooze(contactId) {
  const map = readNudgeSnoozes();
  delete map[contactId];
  writeNudgeSnoozes(map);
}

function nudgeSnoozed(contactId) {
  return String(readNudgeSnoozes()[contactId] || "") > todayDateString();
}

/** Download the whole network as CSV. */
async function exportNetworkCsv() {
  const contacts = (await db.getContacts()) || [];
  const cols = ["name", "role", "company", "industry", "email", "dateMet",
                "lastContacted", "followUpFrequency", "nextReminder", "notes"];
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  const csv = [cols.join(",")]
    .concat(contacts.map((c) => cols.map((k) => cell(c[k])).join(",")))
    .join("\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "orbit-network.csv";
  a.click();
  URL.revokeObjectURL(url);
  return contacts.length;
}

// ── Edit profile ──────────────────────────────────────────────────────────────

async function openProfileModal() {
  document.getElementById("profileModal")?.remove();

  const [prefs, { data: { user } }] = await Promise.all([
    db.getPreferences(), supabase.auth.getUser()
  ]);
  const name = (prefs.your_name || "").trim();
  const display = name || (user?.email || "").split("@")[0] || "You";

  const modal = document.createElement("div");
  modal.id = "profileModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card edit-profile-card">'
    + '<h3>Edit profile</h3>'
    + '<div class="ep-avatar-wrap">'
    + '<div class="ep-avatar" id="epAvatar">' + escapeHtml(initialsFor(display)) + '</div>'
    + '<button class="ep-camera" id="epCamera" type="button" aria-label="Change photo" title="Change photo">'
    + '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">'
    + '<path d="M3 6.5h3l1.2-2h5.6L14 6.5h3v9H3z"/><circle cx="10" cy="11" r="2.8"/></svg>'
    + '</button>'
    + '<input type="file" id="epPhoto" accept="image/*" hidden />'
    + '</div>'
    + '<div class="field-group"><label for="epName">Display name</label>'
    + '<input type="text" id="epName" value="' + escapeHtml(name) + '" placeholder="Davina Li" /></div>'
    + '<div class="field-group"><label for="epEmail">Sign-in email</label>'
    + '<input type="email" id="epEmail" value="' + escapeHtml(user?.email || "") + '" disabled /></div>'
    + '<p class="ep-note">Your name signs the draft messages Orbit writes for you.</p>'
    + '<p id="epMsg" class="success" aria-live="polite"></p>'
    + '<p id="epErr" class="error" aria-live="polite"></p>'
    + '<div class="ep-actions">'
    + '<button class="btn btn-secondary" id="epCancel" type="button">Cancel</button>'
    + '<button class="btn" id="epSave" type="button">Save</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#epCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  // Photo upload reuses the existing bucket; the URL lives on preferences.
  modal.querySelector("#epCamera").addEventListener("click", () =>
    modal.querySelector("#epPhoto").click());
  modal.querySelector("#epPhoto").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const err = modal.querySelector("#epErr");
    err.textContent = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { err.textContent = "Pick an image file."; return; }
    if (file.size > 2 * 1024 * 1024) { err.textContent = "Images must be under 2 MB."; return; }

    const uploaded = await db.uploadFileToStorage(file, { category: "avatar" });
    if (!uploaded) { err.textContent = "Upload failed — check the console (F12)."; return; }
    const result = await db.savePreferences({ avatar_url: uploaded.fileUrl });
    if (result.skipped.includes("avatar_url")) {
      err.textContent = "Photo uploaded, but avatar_url needs supabase/migrations/004_settings_columns.sql first.";
      return;
    }
    const av = modal.querySelector("#epAvatar");
    av.textContent = "";
    av.style.backgroundImage = "url(" + uploaded.fileUrl + ")";
    av.classList.add("has-photo");
    refreshProfileButton();
  });

  modal.querySelector("#epSave").addEventListener("click", async () => {
    const msg = modal.querySelector("#epMsg");
    const err = modal.querySelector("#epErr");
    msg.textContent = ""; err.textContent = "";
    const result = await db.savePreferences({ your_name: modal.querySelector("#epName").value.trim() });
    if (!result.ok) { err.textContent = "Could not save — see the console (F12)."; return; }
    msg.textContent = "Saved.";
    refreshProfileButton();
    setTimeout(close, 700);
  });

  if (prefs.avatar_url) {
    const av = modal.querySelector("#epAvatar");
    av.textContent = "";
    av.style.backgroundImage = "url(" + prefs.avatar_url + ")";
    av.classList.add("has-photo");
  }
  modal.querySelector("#epName").focus();
}

// ── Integrations tab (ORB-34) ─────────────────────────────────────────────────

/** Relative time that stays readable without a library. */
function timeAgo(ms) {
  if (!ms) return "never";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

/**
 * Four states, not two.
 *
 * "Connected or not" could not describe the one that happens most: you
 * connected weeks ago, the grant expired, and nothing works until you click
 * again. Calling that connected is how this screen previously reported a
 * healthy calendar it could not read.
 */
function calendarCardHtml({ connecting = false } = {}) {
  const state = connecting ? "connecting" : calendar.getConnectionState();
  const run = calendar.lastRun();
  const synced = calendar.lastSyncedAt();

  const meta = {
    disconnected: { pill: "Not connected", tone: "idle" },
    connecting:   { pill: "Connecting…",   tone: "busy" },
    connected:    { pill: "Connected",     tone: "ok" },
    "needs-reauth": { pill: "Needs re-authorising", tone: "warn" }
  }[state];

  const status = state === "connected"
    ? 'Checked ' + escapeHtml(timeAgo(synced)) + '. Orbit looks again every few hours.'
    : state === "needs-reauth"
      ? 'Google expired the permission, which it does about weekly for apps in testing. '
        + 'One click puts it back.'
      : state === "connecting"
        ? 'Waiting for Google…'
        : 'Find the meetings you already had with people in your network.';

  const actions = state === "connected"
    ? '<button class="btn btn-sm" id="calSyncBtn" type="button">Sync now</button>'
      + '<button class="btn btn-secondary btn-sm" id="calDisconnectBtn" type="button">Disconnect</button>'
    : state === "needs-reauth"
      ? '<button class="btn btn-sm" id="calSyncBtn" type="button">Reconnect</button>'
        + '<button class="btn btn-secondary btn-sm" id="calDisconnectBtn" type="button">Remove</button>'
      : '<button class="btn btn-sm" id="calSyncBtn" type="button"'
        + (connecting ? ' disabled' : '') + '>'
        + (connecting ? 'Connecting…' : 'Connect') + '</button>';

  return '<article class="int-card int-' + meta.tone + '">'
    + '<div class="int-head">'
    + googleCalendarMark()
    + '<div class="int-title">'
    + '<p class="int-name">Google Calendar</p>'
    + '<p class="int-status">' + status + '</p>'
    + '</div>'
    + '<span class="int-pill int-pill-' + meta.tone + '">' + escapeHtml(meta.pill) + '</span>'
    + '</div>'
    + (run && state === "connected"
      ? '<p class="int-lastrun">Last run: '
        + (run.logged
          ? run.logged + (run.logged === 1 ? ' conversation logged' : ' conversations logged')
          : 'nothing new to log')
        + '</p>'
      : '')
    + '<p id="calMsg" class="success" aria-live="polite"></p>'
    + '<p id="calErr" class="error" aria-live="polite"></p>'
    + '<div class="int-actions">' + actions + '</div>'
    + '<details class="int-details">'
    + '<summary>How it works, and what it can see</summary>'
    + '<ul class="settings-list">'
    + '<li><strong>Read-only.</strong> Orbit cannot create, change or delete anything '
    + 'on your calendar. Google enforces that, not us.</li>'
    + '<li><strong>No token is ever stored.</strong> It lives in this tab and is gone '
    + 'when you close it. Meeting titles for "Coming up" are cached on this device; '
    + 'disconnecting clears them.</li>'
    + '<li><strong>You confirm every entry.</strong> A meeting on a calendar is not '
    + 'proof you spoke, and logging one moves that person&#39;s next reach-out date.</li>'
    + '<li><strong>Matched by email</strong>, so only connections whose email you have '
    + 'saved can be found.</li>'
    + '</ul>'
    + '</details>'
    + '</article>';
}

/**
 * Renders the cards and wires them, in one place so every state change can
 * simply re-render rather than trying to patch the DOM it came from.
 */
function renderIntegrationCards(root, { connecting = false } = {}) {
  if (!root) return;
  root.innerHTML = calendarCardHtml({ connecting });
  // "Evaluate on app load and after every integration state change."
  evaluateIntegrationsNav();

  const msg = root.querySelector("#calMsg");
  const err = root.querySelector("#calErr");

  root.querySelector("#calSyncBtn")?.addEventListener("click", async () => {
    msg.textContent = ""; err.textContent = "";
    renderIntegrationCards(root, { connecting: true });
    try {
      const contacts = (await db.getContacts()) || [];
      if (!contacts.some((c) => (c.email || "").trim())) {
        renderIntegrationCards(root);
        root.querySelector("#calErr").textContent =
          "None of your connections have an email saved, so there is nothing to match "
          + "against. Add emails first.";
        return;
      }

      const candidates = await calendar.connectCalendar(contacts, todayDateString());
      await persistCalendarConnection();
      calendar.markSynced(Date.now());

      if (!candidates.length) {
        calendar.recordRun({ found: 0, logged: 0 });
        renderIntegrationCards(root);
        root.querySelector("#calMsg").textContent =
          "Nothing new in the last " + calendar.LOOKBACK_DAYS + " days.";
        return;
      }
      openCalendarReviewModal(candidates, contacts);
    } catch (error) {
      renderIntegrationCards(root);
      root.querySelector("#calErr").textContent = String(error.message || error);
    }
  });

  root.querySelector("#calDisconnectBtn")?.addEventListener("click", () => {
    calendar.disconnectCalendar();
    persistCalendarConnection();
    renderIntegrationCards(root);
    showToast("Google Calendar disconnected. No token was stored, so there is nothing else to clear.");
  });
}

/**
 * The Google Calendar mark.
 *
 * onerror swaps in the emoji, so a missing or renamed file degrades to what was
 * there before rather than a broken-image icon. The filename has a space in it,
 * hence the encoding.
 */
function googleCalendarMark(cls = "int-icon") {
  return '<img class="' + cls + ' gcal-mark" src="assets/google%20calendar.png"'
    + ' alt="" width="24" height="24" loading="lazy"'
    + ' onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),'
    + '{className:\'' + cls + '\',textContent:\'📅\'}))" />';
}

// ── Integrations in Settings (ORB-36) ─────────────────────────────────────────

/**
 * Management, as opposed to ORB-34's discovery.
 *
 * Present in every state, on purpose. The nav entry point disappears once
 * everything is connected, so if this were conditional too there would be
 * moments — a broken token, a wrong calendar — with nowhere at all to go.
 */
function renderSettingsIntegrations(root, calendars = null) {
  if (!root) return;

  const state = calendar.getConnectionState();
  const account = calendar.getConnectedAccount();
  const synced = calendar.lastSyncedAt();
  const selected = calendar.getSelectedCalendarId();

  const label = {
    disconnected: "Not connected",
    connected: "Connected",
    "needs-reauth": "Needs re-authorising"
  }[state];

  root.innerHTML = '<div class="int-settings">'
    + '<div class="int-head">'
    + googleCalendarMark()
    + '<div class="int-title">'
    + '<p class="int-name">Google Calendar</p>'
    + '<p class="int-status">' + escapeHtml(label)
    + (account ? ' · ' + escapeHtml(account) : '')
    + '</p>'
    + '</div>'
    + '</div>'
    + (state === "disconnected"
      ? '<p class="field-hint">Connect it from <strong>Networking Log → Integrations</strong> '
        + 'in the sidebar.</p>'
      : '<dl class="int-meta">'
        + '<div><dt>Last synced</dt><dd>' + escapeHtml(timeAgo(synced)) + '</dd></div>'
        + '<div><dt>Reading</dt><dd>'
        + (calendars && calendars.length
          ? '<select id="intCalendarPick">'
            + calendars.map((c) => '<option value="' + escapeHtml(c.id) + '"'
              + (c.id === selected ? ' selected' : '') + '>'
              + escapeHtml(c.name) + (c.primary ? ' (main)' : '') + '</option>').join("")
            + '</select>'
          : '<button class="link-btn" id="intLoadCalendars" type="button">'
            + escapeHtml(selected === "primary" ? "Main calendar" : selected)
            + ' — change</button>')
        + '</dd></div>'
        + '</dl>')
    + '<p id="intSettingsMsg" class="success" aria-live="polite"></p>'
    + '<p id="intSettingsErr" class="error" aria-live="polite"></p>'
    + (state === "disconnected" ? '' : '<div class="int-actions">'
      + '<button class="btn btn-secondary btn-sm" id="intReauth" type="button">'
      + (state === "needs-reauth" ? "Re-authorise" : "Re-authorise") + '</button>'
      + '<button class="btn btn-secondary btn-sm int-danger" id="intDisconnect" type="button">'
      + 'Disconnect</button>'
      + '</div>')
    + '</div>';

  const msg = root.querySelector("#intSettingsMsg");
  const err = root.querySelector("#intSettingsErr");

  root.querySelector("#intLoadCalendars")?.addEventListener("click", async () => {
    err.textContent = "";
    try {
      const list = await calendar.refreshAccountInfo();
      if (!list.length) throw new Error("Could not read your calendar list.");
      renderSettingsIntegrations(root, list);
    } catch (e) {
      err.textContent = String(e.message || e) + " Try Re-authorise first.";
    }
  });

  root.querySelector("#intCalendarPick")?.addEventListener("change", (e) => {
    calendar.setSelectedCalendarId(e.target.value);
    persistCalendarConnection();
    msg.textContent = "Saved. The next sync reads that calendar.";
  });

  root.querySelector("#intReauth")?.addEventListener("click", async () => {
    msg.textContent = ""; err.textContent = "";
    try {
      const contacts = (await db.getContacts()) || [];
      const candidates = await calendar.connectCalendar(contacts, todayDateString());
      await persistCalendarConnection();
      await calendar.refreshAccountInfo();
      calendar.markSynced(Date.now());
      renderSettingsIntegrations(root);
      if (candidates.length) {
        document.getElementById("settingsModal")?.remove();
        openCalendarReviewModal(candidates, contacts);
      } else {
        root.querySelector("#intSettingsMsg").textContent = "Re-authorised. Nothing new to log.";
      }
    } catch (e) {
      err.textContent = String(e.message || e);
    }
  });

  root.querySelector("#intDisconnect")?.addEventListener("click", () => {
    openDisconnectModal(root);
  });
}

/**
 * Disconnecting asks what to do with what the calendar logged.
 *
 * Defaulting to keep, because those conversations are real history — you had
 * those meetings — and deleting them as a side effect of unlinking a calendar
 * is not recoverable. Removing them is offered because someone who connected
 * the wrong account wants the mess gone, and hunting them down by hand is
 * worse.
 */
function openDisconnectModal(settingsRoot) {
  document.getElementById("disconnectModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "disconnectModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card">'
    + '<div class="quick-add-header"><h3>Disconnect Google Calendar</h3>'
    + '<button class="icon-btn" id="dcClose" type="button" aria-label="Close">✕</button></div>'
    + '<p class="muted">Orbit will stop reading your calendar. '
    + 'What should happen to the conversations it logged?</p>'
    + '<div class="cal-clash-choices" role="radiogroup" aria-label="Logged conversations">'
    + '<label><input type="radio" name="dcKeep" value="keep" checked /> '
    + '<span><strong>Keep them.</strong> Those meetings happened — the record stays.</span></label>'
    + '<label><input type="radio" name="dcKeep" value="remove" /> '
    + '<span><strong>Remove them.</strong> Deletes every conversation the calendar '
    + 'created, along with any notes you added to them. This cannot be undone.</span></label>'
    + '</div>'
    + '<p id="dcCount" class="tiny muted"></p>'
    + '<div class="modal-actions">'
    + '<button class="btn int-danger" id="dcConfirm" type="button">Disconnect</button>'
    + '<button class="btn btn-secondary" id="dcCancel" type="button">Cancel</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#dcClose").addEventListener("click", close);
  modal.querySelector("#dcCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  // Name the cost before it is chosen, not after.
  db.getContacts().then((contacts) => {
    const n = (contacts || []).reduce((total, c) =>
      total + (c.interactions || []).filter((i) => i.sourceEventId).length, 0);
    const el = modal.querySelector("#dcCount");
    if (el) {
      el.textContent = n
        ? n + (n === 1 ? " conversation was" : " conversations were") + " logged from your calendar."
        : "Nothing has been logged from your calendar yet.";
    }
  });

  modal.querySelector("#dcConfirm").addEventListener("click", async (e) => {
    const remove = modal.querySelector('input[name="dcKeep"]:checked')?.value === "remove";
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Disconnecting…";

    let removed = 0;
    if (remove) {
      const contacts = (await db.getContacts()) || [];
      for (const c of contacts) {
        const kept = (c.interactions || []).filter((i) => !i.sourceEventId);
        if (kept.length === (c.interactions || []).length) continue;
        removed += (c.interactions || []).length - kept.length;
        const newest = [...kept].sort((a, b) => b.date.localeCompare(a.date))[0];
        await db.saveContact(normalizeContact({
          ...c,
          interactions: kept,
          // Health has to stop counting from a touchpoint that no longer exists.
          lastContacted: newest ? newest.date : (c.dateMet || ""),
          nextReminder: !c.reminderEnabled || c.followUpFrequency === "none"
            ? c.nextReminder
            : calculateNextReminder(newest ? newest.date : (c.dateMet || todayDateString()),
                                    c.followUpFrequency)
        }));
      }
    }

    calendar.disconnectCalendar();
    persistCalendarConnection();
    close();
    // Disconnecting is the ONE path that brings the nav entry point back.
    evaluateIntegrationsNav();
    renderSettingsIntegrations(settingsRoot);
    showToast(remove
      ? "Disconnected. " + removed + (removed === 1 ? " conversation removed." : " conversations removed.")
      : "Disconnected. Your logged conversations were kept.");
  });
}

/**
 * The nav entry point (ORB-34).
 *
 * A discovery affordance, not a menu item. It appears only while something is
 * still unconnected and disappears once everything is — because once you have
 * connected a calendar, a permanent link to "connect a calendar" is clutter.
 *
 * It deliberately does NOT come back when a token expires or a sync fails.
 * Those are a working connection needing a nudge, and resurfacing this every
 * time Google expires a grant would turn discovery into a recurring error
 * badge. A broken connection announces itself on the dashboard card (ORB-35);
 * the only route back here is an explicit disconnect (ORB-36).
 *
 * The rule reads the COUNT of unconnected integrations rather than asking about
 * Google Calendar by name, so a second integration needs no change here.
 */
// ── The calendar connection follows the account (ORB-39) ──────────────────────

const CALENDAR_INTEGRATION = "google-calendar";

/**
 * Write this device's connection state up to `preferences`.
 *
 * Called after every deliberate connect, disconnect or calendar change — not on
 * a timer — so the stored record always reflects a decision somebody made
 * rather than whichever tab happened to load last.
 *
 * A disconnect stores `connected: false` instead of removing the entry. The
 * difference matters: "no record" means nobody has ever connected, while
 * "connected: false" means someone deliberately disconnected. Deleting the key
 * would collapse the two, and the next device to load with a stale localStorage
 * would helpfully push the connection back up — the same resurrection bug that
 * made a deleted email address reappear.
 */
async function persistCalendarConnection() {
  const snapshot = calendar.connectionSnapshot() || { connected: false };
  try {
    const prefs = (await db.getPreferences()) || {};
    const integrations = { ...(prefs.integrations || {}) };
    integrations[CALENDAR_INTEGRATION] = snapshot;
    const result = await db.savePreferences({ integrations });
    if (result.skipped?.includes("integrations")) {
      console.warn("[calendar] preferences.integrations is missing, so this "
        + "connection stays on this device only. Run supabase/migrations/010_integrations.sql");
    }
  } catch (err) {
    // Never fatal. Failing to record the connection costs you a reconnect on
    // your next device; throwing here would cost you the connection itself.
    console.warn("[calendar] Could not save the connection to your account.", err);
  }
}

/**
 * Reconcile this browser against the account, once, at boot.
 *
 * The stored record wins on the question of whether you are connected, because
 * that is an account-level fact. Everything else is merged rather than
 * overwritten — see connectionSnapshot() in calendar.js for what is shared and
 * what is deliberately kept per-device.
 */
async function adoptCalendarConnection() {
  let prefs;
  try { prefs = await db.getPreferences(); } catch { return; }
  const stored = prefs?.integrations?.[CALENDAR_INTEGRATION] || null;
  const local = calendar.connectionSnapshot();

  if (stored?.connected) {
    if (calendar.adoptConnection(stored)) evaluateIntegrationsNav();
    return;
  }
  // An explicit disconnect elsewhere ends the connection here too.
  if (stored && stored.connected === false && local) {
    // No write back. The record already says disconnected — echoing it would
    // be a device reporting news it just received.
    calendar.disconnectCalendar();
    evaluateIntegrationsNav();
    return;
  }
  // No record at all: this device connected before the account started keeping
  // one. Carry it up so the next device inherits it.
  if (!stored && local) await persistCalendarConnection();
}

function evaluateIntegrationsNav() {
  const show = calendar.countNotConnected() > 0;
  // A body class rather than the hidden attribute, so the inline script can set
  // the same thing before first paint and this only ever confirms it. Setting
  // `hidden` here meant the item flashed on or off after every page load.
  document.body.classList.toggle("nav-integrations", show);

  // Someone sitting on the page when the last integration connects should not
  // be stranded on a route that is no longer in the nav.
  if (!show && document.body.dataset.page === "integrations") {
    const note = document.getElementById("integrationsAllDone");
    if (note) note.hidden = false;
  }
}

/** The Integrations page (ORB-34). Discovery only — management lives in Settings. */
async function initIntegrationsPage() {
  const root = document.getElementById("integrationCards");
  if (!root) return;
  renderIntegrationCards(root);
  window.__orbitRefresh = () => renderIntegrationCards(root);
}

// ── Calendar auto-sync on load (ORB-15) ───────────────────────────────────────

/**
 * Check the calendar in the background once you have connected it.
 *
 * The first version of this lived behind Settings → Integrations, which is a
 * screen you visit once. A sync you have to remember to run is the same habit
 * problem Orbit exists to fix, so it now runs itself and only speaks up when it
 * has found something.
 *
 * Three things it is careful about:
 *   - it never blocks the page, and never throws
 *   - it never opens a Google popup unprompted; a silent grant that fails just
 *     means no sync this time
 *   - it is throttled, because every page here is a full load and syncing on
 *     each one would hammer Google for no benefit
 */
async function initCalendarAutoSync() {
  if (!calendar.isRemembered()) return;

  const now = Date.now();
  if (!calendar.autoSyncDue(now)) return;

  const contacts = (await db.getContacts()) || [];
  if (!contacts.some((c) => (c.email || "").trim())) return;

  const result = await calendar.silentSync(contacts, todayDateString());
  // Stamped on the ATTEMPT, not on success. Only stamping successes meant a
  // failing sync never backed off: autoSyncDue stayed true, so every page load
  // retried, and every retry asked Google for a token — which is a popup on
  // every single refresh. A backoff that only applies when things are working
  // is not a backoff.
  calendar.markSynced(now);

  const candidates = result?.candidates ?? null;
  if (result) renderUpcomingMeetings();

  if (candidates === null) {
    // Google would need to ask something. Say so at most once a day — an app
    // that nags every page load about a background feature is worse than one
    // that quietly stops.
    if (calendar.reconnectNudgeDue(now)) {
      calendar.markReconnectNudged(now);
      showToast("Calendar access expired.", {
        actionLabel: "Reconnect",
        duration: 8000,
        onAction: async () => {
          try {
            const found = await calendar.connectCalendar(contacts, todayDateString());
            await persistCalendarConnection();
            calendar.markSynced(Date.now());
            if (found.length) openCalendarReviewModal(found, contacts);
            else showToast("No new meetings in the last " + calendar.LOOKBACK_DAYS + " days.");
          } catch (err) {
            showToast(String(err.message || err));
          }
        }
      });
    }
    return;
  }

  calendar.markSynced(now);
  if (!candidates.length) return;

  // Two different moments, two different interruptions. A conversation that
  // finished today is asked about directly — that is the minute you remember
  // what was said, and a toast you can miss wastes it. A month of backlog gets
  // a line you can ignore, because a modal over twenty old meetings is an
  // ambush. Nothing is dropped either way: the dialog lists everything found.
  if (calendar.justEnded(candidates, now).length) {
    openCalendarReviewModal(candidates, contacts, { justHappened: true });
    return;
  }

  showToast(candidates.length + (candidates.length === 1
    ? " meeting found on your calendar." : " meetings found on your calendar."), {
    actionLabel: "Review",
    duration: 10000,
    onAction: () => openCalendarReviewModal(candidates, contacts)
  });
}

// ── Upcoming meetings widget ──────────────────────────────────────────────────

/**
 * What is ahead, paired with what you meant to bring up.
 *
 * The rest of the dashboard is about people you are neglecting. This is the
 * other half: the conversation you are about to have, and the talking points
 * that would otherwise sit unread on a profile until after it.
 *
 * Rendered from the localStorage cache so it appears immediately, then replaced
 * when a sync completes. Waiting on Google before showing a dashboard would be
 * a worse trade than briefly showing a slightly stale list.
 */
function renderUpcomingMeetings() {
  const slot = document.getElementById("upcomingMeetings");
  if (!slot) return;

  // ORB-35: only in connected or needs-reauth. Hidden until a connection
  // exists, because a sync button for a calendar you never linked is noise.
  const connection = calendar.getConnectionState();
  if (connection === calendar.DISCONNECTED) { slot.innerHTML = ""; slot.hidden = true; return; }
  slot.hidden = false;

  // ORB-35: a sync button is only trustworthy next to evidence it ran. The
  // timestamp says when, and the count says whether it did anything — a run
  // that found four meetings and logged none did nothing, and reporting "4"
  // would flatter it.
  const state = connection;
  const run = calendar.lastRun();

  // An expired Google grant is not a broken integration, it is a sign-in that
  // lapsed — Google expires them about weekly for apps still in testing. So the
  // button stays "Sync now" in both states and re-authorising happens inside it:
  // connectCalendar() already prompts when the token is gone, and the sync it
  // was asked for runs straight afterwards. Announcing "nothing is syncing" and
  // sending you to Settings made a routine re-login look like a fault.
  //
  // The state is still stated, quietly, because "Synced 3 days ago" on its own
  // would imply it is still running when it is not.
  const syncBar = '<div class="sync-bar">'
    + '<span class="sync-source">' + googleCalendarMark("sync-mark")
    + '<span>Google Calendar</span></span>'
    + '<span class="sync-status">'
    + 'Synced ' + escapeHtml(timeAgo(calendar.lastSyncedAt()))
    + (state === "needs-reauth"
      ? ' <span class="muted">· sign in again to pick up anything new</span>'
      : (run && run.logged
        ? ' · ' + run.logged + (run.logged === 1 ? ' conversation' : ' conversations') + ' logged'
        : ''))
    + '</span>'
    + '<button class="btn btn-secondary btn-sm" id="dashSyncBtn" type="button">Sync now</button>'
    + '</div>';

  // No slice. The old cap of 5 existed only because the card grew with the
  // list and a long week wrecked the dashboard row; the list scrolls within a
  // fixed height now, so dropping meetings on the floor buys nothing.
  const items = calendar.readUpcoming();
  if (!items.length) {
    slot.innerHTML = '<h3 class="chart-title">Coming up</h3>'
      + '<p class="chart-sub muted">Next ' + calendar.UPCOMING_DAYS + ' days</p>'
      + syncBar
      + '<p class="empty upcoming-empty">Nothing scheduled with anyone in your network.</p>';
    wireDashboardSync(slot);
    return;
  }

  const now = Date.now();
  const rows = items.map((item) => {
    const who = item.people.map((p) => escapeHtml(p.name)).join(", ");
    const points = item.people.flatMap((p) => p.talkingPoints || []);
    // A meeting stays on this list until it ends, so some of them are happening
    // right now. "Today · 9:30 AM" for something you are already in the middle
    // of reads as a thing you might still miss.
    const inProgress = new Date(item.iso).getTime() <= now
      && new Date(item.endIso || item.iso).getTime() >= now;
    return '<li class="upcoming-row' + (inProgress ? ' upcoming-now' : '') + '">'
      + '<div class="upcoming-when">'
      + '<span class="upcoming-day">'
      // Lower case to sit beside "today" and "tomorrow", which is what the
      // other rows in this column say.
      + (inProgress ? "now" : escapeHtml(relativeDayLabel(item.date))) + '</span>'
      + '<span class="tiny muted">' + escapeHtml(item.time) + '</span>'
      + '</div>'
      + '<div class="upcoming-main">'
      + '<p class="upcoming-title">' + escapeHtml(item.title) + '</p>'
      + '<p class="tiny muted">' + who + '</p>'
      + (item.medium.url
        ? '<a class="upcoming-link" href="' + escapeHtml(item.medium.url)
          + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.medium.label) + ' →</a>'
        : '<span class="tiny muted">' + escapeHtml(item.medium.label) + '</span>')
      + (points.length
        ? '<ul class="upcoming-points">'
          + points.map((t) => '<li>' + escapeHtml(t) + '</li>').join("")
          + '</ul>'
        : '')
      + '</div>'
      + '</li>';
  }).join("");

  slot.innerHTML = '<h3 class="chart-title">Coming up'
    + (items.length > 1 ? '<span class="chart-count">' + items.length + '</span>' : '')
    + '</h3>'
    + '<p class="chart-sub muted">And what you wanted to raise</p>'
    + syncBar
    + '<ul class="upcoming-list">' + rows + '</ul>';
  wireScrollFade(slot.querySelector(".upcoming-list"));
  wireDashboardSync(slot);
}

/**
 * The fade at the bottom of the list, on only while there is more to see.
 *
 * Applied from JS rather than always-on in CSS because a permanent fade over a
 * list that fits is just a washed-out last row, and a fade that stays at the
 * bottom of the scroll keeps promising content that has run out.
 */
function wireScrollFade(list) {
  if (!list) return;
  const update = () => {
    const scrollable = list.scrollHeight > list.clientHeight + 1;
    list.classList.toggle("is-scrollable", scrollable);
    list.classList.toggle("at-end",
      !scrollable || list.scrollTop + list.clientHeight >= list.scrollHeight - 2);
  };
  list.addEventListener("scroll", update, { passive: true });
  update();
  // Layout is not settled on the first pass — the card is still being sized by
  // its row — so the initial measurement can be taken against the wrong height.
  requestAnimationFrame(update);
}

/** The Sync now button (ORB-35). Same path as Settings, fewer clicks away. */
function wireDashboardSync(slot) {
  const btn = slot.querySelector("#dashSyncBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const contacts = (await db.getContacts()) || [];
      const candidates = await calendar.connectCalendar(contacts, todayDateString());
      await persistCalendarConnection();
      calendar.markSynced(Date.now());

      if (!candidates.length) {
        calendar.recordRun({ found: 0, logged: 0 });
        renderUpcomingMeetings();
        showToast("Calendar checked — nothing new in the last "
          + calendar.LOOKBACK_DAYS + " days.");
        return;
      }
      openCalendarReviewModal(candidates, contacts);
    } catch (error) {
      showToast(String(error.message || error));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
      renderUpcomingMeetings();
    }
  });
}

// ── Calendar review (ORB-15) ──────────────────────────────────────────────────

/**
 * Confirm what the calendar found before writing any of it.
 *
 * Everything is pre-ticked, so the common case is still one click — the point
 * of ORB-15 is to remove the remembering, not to add a chore. What it does not
 * do is write silently: logging a meeting moves that person's next reach-out
 * date, so a wrong entry makes a drifting relationship look healthy. That is
 * the one failure this app cannot afford.
 */
function openCalendarReviewModal(candidates, contacts, { justHappened = false } = {}) {
  document.getElementById("calReviewModal")?.remove();

  // What this dialog is FOR changes with when the meetings happened, so the
  // heading does too. "3 meetings found" is a report; "How did it go with
  // Marcus?" is a question — and a question is what gets notes written.
  const fresh = calendar.justEnded(candidates);
  const names = [...new Set(fresh.map((c) => c.contactName))];
  const heading = !justHappened || !fresh.length
    ? candidates.length + (candidates.length === 1 ? " meeting found" : " meetings found")
    : names.length === 1
      ? "How did it go with " + escapeHtml(names[0]) + "?"
      : "How did those conversations go?";
  const intro = justHappened && fresh.length
    ? "Just finished. Add what you talked about while it is fresh — that is the part "
      + "you will want later. Untick anything you would rather not log."
    : "Untick anything you would rather not log. Logging one moves that person to "
      + "the back of your reach-out queue.";

  // The notes box is here rather than only on the profile because this is the
  // moment you actually remember the meeting. A synced conversation whose notes
  // are just the event title is a record that it happened, not what was said —
  // and the substance is the part Orbit exists to keep.
  // Open the box for the meeting we are asking about. Asking "how did it go?"
  // and then hiding the answer behind "+ Add notes" is a question with no
  // visible place to reply.
  const freshIds = new Set(justHappened ? fresh.map((c) => c.eventId) : []);

  const rows = candidates.map((c, i) => {
    const clash = c.existing;
    const openNotes = freshIds.has(c.eventId) && !clash;
    // A candidate landing on a day you already wrote about is not a duplicate
    // Orbit can resolve on its own — only you know whether they were the same
    // conversation. So it is unticked, flagged, and offers the three answers
    // that actually exist.
    const clashHtml = clash
      ? '<div class="cal-clash">'
        + '<p class="cal-clash-head">You already logged something with '
        + escapeHtml(c.contactName) + ' on ' + formatDate(c.date) + ':</p>'
        + '<p class="cal-clash-quote">'
        + escapeHtml(stripNoteMarks(clash.notes || "(no notes)").split("\n")[0].slice(0, 140))
        + '</p>'
        + '<div class="cal-clash-choices" role="radiogroup"'
        + ' aria-label="What to do with ' + escapeHtml(c.title) + '">'
        + '<label><input type="radio" name="clash' + i + '" value="skip" checked />'
        + ' Same conversation — skip it</label>'
        + '<label><input type="radio" name="clash' + i + '" value="merge" />'
        + ' Same conversation — add the meeting title to what I wrote</label>'
        + '<label><input type="radio" name="clash' + i + '" value="add" />'
        + ' Different conversation — log it separately</label>'
        + '</div>'
        + '</div>'
      : '';

    return '<li class="cal-row' + (clash ? ' cal-row-clash' : '') + '">'
      + '<label class="cal-check">'
      + '<input type="checkbox" class="cal-pick" data-index="' + i + '"'
      + (clash ? '' : ' checked') + ' />'
      + '<span class="cal-row-main">'
      + '<span class="cal-row-title">' + escapeHtml(c.title) + '</span>'
      + '<span class="tiny muted">' + escapeHtml(c.contactName) + ' · '
      + formatDate(c.date) + ' · ' + escapeHtml(c.type)
      + (clash ? ' · <strong>already logged that day</strong>' : '') + '</span>'
      + '</span>'
      + '</label>'
      + clashHtml
      + '<div class="cal-notes-wrap">'
      + '<button class="cal-notes-toggle" type="button" data-notes-for="' + i + '">'
      + (openNotes ? '− Hide notes' : '+ Add notes') + '</button>'
      + '<textarea class="cal-notes" data-notes-index="' + i + '" rows="3"'
      + (openNotes ? '' : ' hidden')
      + ' placeholder="What did you talk about? What should you bring up next time?"></textarea>'
      // A synced meeting is exactly when a transcript exists — Meet has just
      // produced one. Making you log first and attach later, from the profile,
      // is the trip this dialog is supposed to save.
      + '<div class="cal-attach" data-attach-index="' + i + '"'
      + (openNotes ? '' : ' hidden') + '>'
      + '<label class="tiny muted" for="calFile' + i + '">Transcript or PDF, if you have one</label>'
      + '<input type="file" id="calFile' + i + '" class="cal-file"'
      + ' data-file-index="' + i + '" accept="' + ATTACH_ACCEPT + '" /></div>'
      + '</div>'
      + '</li>';
  }).join("");

  const modal = document.createElement("div");
  modal.id = "calReviewModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card quick-add-card">'
    + '<div class="quick-add-header">'
    + '<h3>' + heading + '</h3>'
    + '<button class="icon-btn" id="calReviewClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + '<p class="muted">' + intro + '</p>'
    + '<ul class="cal-list">' + rows + '</ul>'
    + '<p id="calReviewErr" class="error" aria-live="polite"></p>'
    + '<div class="modal-actions">'
    + '<button class="btn" id="calReviewSave" type="button">Log selected</button>'
    + '<button class="btn btn-secondary" id="calReviewCancel" type="button">Not now</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#calReviewClose").addEventListener("click", close);
  modal.querySelector("#calReviewCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  // Collapsed by default so a long list stays scannable — the notes are
  // optional, and most meetings will not get any.
  modal.querySelectorAll(".cal-notes-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const area = modal.querySelector('[data-notes-index="' + toggle.dataset.notesFor + '"]');
      const attach = modal.querySelector('[data-attach-index="' + toggle.dataset.notesFor + '"]');
      area.hidden = !area.hidden;
      if (attach) attach.hidden = area.hidden;
      toggle.textContent = area.hidden ? "+ Add notes" : "− Hide notes";
      if (!area.hidden) area.focus();
    });
  });

  // Asked once, then remembered — a confirmation you cannot get past is a
  // different bug from the one being fixed.
  let blankNotesConfirmed = false;

  modal.querySelector("#calReviewSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const errEl = modal.querySelector("#calReviewErr");
    errEl.textContent = "";

    const picked = [...modal.querySelectorAll(".cal-pick:checked")]
      .map((el) => {
        const index = Number(el.dataset.index);
        const typed = modal.querySelector('[data-notes-index="' + index + '"]')?.value.trim() || "";
        const choice = modal.querySelector('input[name="clash' + index + '"]:checked')?.value || "add";
        const file = modal.querySelector('[data-file-index="' + index + '"]')?.files?.[0] || null;
        return { ...candidates[index], notes: typed, resolution: choice, file, index };
      })
      .filter((c) => c.resolution !== "skip");
    if (!picked.length) { close(); return; }

    const badFile = picked.find((c) => c.file && !isAllowedAttachment(c.file));
    if (badFile) {
      errEl.textContent = "That file type is not supported — PDF or an image.";
      return;
    }

    // The whole point of asking "how did it go?" is the answer. Saving silently
    // when the box is empty turns the question into a rhetorical one and sends
    // you to the profile afterwards to type what you were just asked for.
    // Only on the just-happened prompt: a first sync pulling in a month of old
    // meetings has no notes by nature, and nagging about that is its own chore.
    const blank = picked.filter((c) => !c.notes);
    if (justHappened && blank.length && !blankNotesConfirmed) {
      blankNotesConfirmed = true;
      errEl.innerHTML = '<span class="cal-confirm">'
        + (blank.length === 1
          ? 'No notes on this one yet. '
          : 'No notes on ' + blank.length + ' of these yet. ')
        + 'That is the part you will want later — press Log again to save without them.'
        + '</span>';
      const first = modal.querySelector('[data-notes-index="' + blank[0].index + '"]');
      if (first) {
        const toggle = modal.querySelector('[data-notes-for="' + blank[0].index + '"]');
        const attach = modal.querySelector('[data-attach-index="' + blank[0].index + '"]');
        first.hidden = false;
        if (attach) attach.hidden = false;
        if (toggle) toggle.textContent = "− Hide notes";
        first.focus();
      }
      btn.textContent = "Log without notes";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Logging…";
    const { logged, failed, attachmentsFailed } = await applyCalendarCandidates(picked, contacts);
    close();

    if (!logged) {
      showToast("Could not log those — nothing was changed.");
      return;
    }
    calendar.recordRun({ found: candidates.length, logged });
    showToast(logged + (logged === 1 ? " conversation logged." : " conversations logged.")
      + (failed ? " " + failed + " could not be saved." : "")
      + (attachmentsFailed
        ? " " + attachmentsFailed + (attachmentsFailed === 1 ? " file" : " files")
          + " could not be attached."
        : ""), {
      actionLabel: "View in log",
      href: "network.html",
      duration: 7000
    });
    if (typeof window.__orbitRefresh === "function") await window.__orbitRefresh();
  });
}

/**
 * Write the confirmed meetings as conversations.
 *
 * Grouped by contact so someone with three meetings costs one write, not three
 * — and so their cadence is recalculated once, from the most recent.
 */
async function applyCalendarCandidates(picked, contacts) {
  const byContact = new Map();
  for (const c of picked) {
    if (!byContact.has(c.contactId)) byContact.set(c.contactId, []);
    byContact.get(c.contactId).push(c);
  }

  let logged = 0;
  let failed = 0;
  // Counted separately from `failed`: the conversation saved, only the file
  // did not, and reporting that as a failed log would be a lie.
  let attachmentsFailed = 0;

  for (const [contactId, items] of byContact) {
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact) { failed += items.length; continue; }

    // "merge" folds the meeting into the conversation already there instead of
    // creating a second one. It keeps what you wrote and adds the title and the
    // event id, so a later sync recognises it and never offers it again.
    const toMerge = items.filter((i) => i.resolution === "merge" && i.existing);
    const toAdd = items.filter((i) => i.resolution !== "merge" || !i.existing);

    // Attachments go up before the contact is written, so one storage failure
    // costs that transcript and nothing else — the conversation still lands.
    // Keyed by eventId because merge and add both need to find their own file.
    const uploadedFor = new Map();
    for (const item of items) {
      if (!item.file) continue;
      const uploaded = await db.uploadFileToStorage(item.file, { contactId });
      if (uploaded) uploadedFor.set(item.eventId, uploaded.id);
      else attachmentsFailed += 1;
    }

    let interactions = (contact.interactions || []).map((existing) => {
      const match = toMerge.find((m) => m.existing.id === existing.id);
      if (!match) return existing;
      const parts = [existing.notes, match.notes].filter(Boolean);
      const fileId = uploadedFor.get(match.eventId);
      return normalizeInteraction({
        ...existing,
        // An existing conversation may already carry a title; the calendar's
        // wins only when there is none, since a name the user set is an answer
        // and the event's is a default.
        title: existing.title || match.title || "",
        notes: parts.join("\n\n"),
        fileIds: fileId ? [...(existing.fileIds || []), fileId] : (existing.fileIds || []),
        sourceEventId: match.eventId
      });
    });

    const added = toAdd.map((item) => normalizeInteraction({
      date: item.date,
      type: item.type,
      // The meeting name is its own field now. Notes hold only what the user
      // wrote, which is why a synced meeting with nothing typed saves empty
      // rather than saving Orbit's own text back as if it were an answer.
      title: item.title,
      notes: item.notes || "",
      fileIds: uploadedFor.has(item.eventId) ? [uploadedFor.get(item.eventId)] : [],
      sourceEventId: item.eventId
    }));

    const merged = [...added, ...interactions]
      .sort((a, b) => b.date.localeCompare(a.date));

    const saved = await db.saveContact(normalizeContact({
      ...contact,
      interactions: merged,
      lastContacted: merged[0].date,
      // A real touchpoint puts the relationship back on its normal rhythm,
      // exactly as logging one by hand does.
      nextReminder: contact.followUpFrequency === "none" || !contact.reminderEnabled
        ? contact.nextReminder
        : calculateNextReminder(merged[0].date, contact.followUpFrequency)
    }));

    if (saved) logged += items.length;
    else failed += items.length;
  }

  return { logged, failed, attachmentsFailed };
}

// ── Settings ──────────────────────────────────────────────────────────────────

const SETTINGS_SECTIONS = [
  { key: "general",       label: "General",          icon: "⚙" },
  { key: "profile",       label: "Profile",          icon: "◍" },
  { key: "notifications", label: "Notifications",    icon: "◔" },
  { key: "integrations",  label: "Integrations",     icon: "⧉" },
  { key: "security",      label: "Security & login", icon: "⛨" },
  { key: "data",          label: "Data controls",    icon: "⬓" }
];

async function openSettingsModal(section = "general") {
  document.getElementById("settingsModal")?.remove();

  const [prefs, { data: { user } }] = await Promise.all([
    db.getPreferences(), supabase.auth.getUser()
  ]);
  const authEmail = user?.email || "";
  const theme = localStorage.getItem("orbit_theme")
    || localStorage.getItem("interntrack_theme") || "light";
  const nudge = getNudgeMode();
  // Unlike the in-app prompt, this one lives in the database — the reminder job
  // runs server-side and can never see localStorage. Anything other than the
  // three known values is treated as off, which is also what an unrun migration
  // looks like.
  // 'daily' and 'weekly' predate the fortnightly rhythm (ORB-27) and still mean
  // opted-in, so an old value shows as on rather than silently reading "Never".
  const emailMode = ["fortnightly", "weekly", "daily"].includes(prefs.email_reminders)
    ? "fortnightly" : "off";
  const reminderTarget = (prefs.your_email || "").trim() || authEmail || "no address saved";

  const modal = document.createElement("div");
  modal.id = "settingsModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card settings-shell">'

    + '<nav class="settings-nav" aria-label="Settings sections">'
    + '<button class="icon-btn settings-close" id="settingsClose" type="button" aria-label="Close">✕</button>'
    + SETTINGS_SECTIONS.map((s) =>
        '<button class="settings-navitem" type="button" data-section="' + s.key + '">'
        + '<span class="sn-icon" aria-hidden="true">' + s.icon + '</span>'
        + '<span>' + escapeHtml(s.label) + '</span></button>').join("")
    + '</nav>'

    + '<div class="settings-body">'

    // ── General ──────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="general">'
    + '<h3 class="settings-h3">General</h3>'
    // Hidden until ORB-21 ships. This callout offered to set up 2FA and the
    // Security pane could not actually do it — an invitation to a dead end.
    // Restore both this and the block in the Security pane together.
    // + '<div class="settings-callout">'
    // + '<p class="sc-icon" aria-hidden="true">⛨</p>'
    // + '<div><p class="sc-title">Secure your account</p>'
    // + '<p class="sc-body">Add two-factor authentication so a stolen password is not enough to get in.</p></div>'
    // + '<button class="btn btn-secondary btn-sm" id="goSecurity" type="button">Set up</button>'
    // + '</div>'
    + settingsRow("Appearance",
        '<select id="setTheme">'
        + '<option value="light"' + (theme === "light" ? " selected" : "") + '>Light</option>'
        + '<option value="dark"' + (theme === "dark" ? " selected" : "") + '>Dark</option></select>')
    + settingsRow("Signed in as", '<span class="settings-static">' + escapeHtml(authEmail) + '</span>')
    + '</section>'

    // ── Profile ──────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="profile">'
    + '<h3 class="settings-h3">Profile</h3>'
    + '<div class="field-group"><label for="setYourName">Full name</label>'
    + '<input type="text" id="setYourName" value="' + escapeHtml(prefs.your_name || "") + '" placeholder="Davina Li" /></div>'
    + '<div class="field-group"><label for="setPhone">Phone number</label>'
    + '<input type="tel" id="setPhone" value="' + escapeHtml(prefs.phone || "") + '" placeholder="+1 555 000 1234" />'
    + '<p class="field-hint">Stored on your profile. Not used for sign-in codes — see Security &amp; login.</p></div>'
    + '<div class="field-group"><label for="setYourEmail">Contact email</label>'
    + '<input type="email" id="setYourEmail" value="' + escapeHtml(prefs.your_email || "") + '" placeholder="you@example.com" />'
    + '<p class="field-hint">Shown in drafts, and where email reminders are sent. '
    + 'Your sign-in email is <strong>' + escapeHtml(authEmail) + '</strong>.</p></div>'
    + '<p id="profileMsg" class="success" aria-live="polite"></p>'
    + '<p id="profileErr" class="error" aria-live="polite"></p>'
    + '<button class="btn" id="saveProfile" type="button">Save profile</button>'
    + '</section>'

    // ── Notifications ────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="notifications">'
    + '<h3 class="settings-h3">Notifications</h3>'
    + '<p class="settings-note">Orbit opens a reach-out prompt when someone is overdue. '
    + 'Choose how often that is allowed to interrupt you.</p>'
    + settingsRow("Reach-out prompt",
        '<select id="setNudge">'
        + '<option value="always"' + (nudge === "always" ? " selected" : "") + '>Every time I open Orbit</option>'
        + '<option value="daily"' + (nudge === "daily" ? " selected" : "") + '>Once a day</option>'
        + '<option value="off"' + (nudge === "off" ? " selected" : "") + '>Never</option></select>')
    + '<p class="field-hint">Long silences still show on the dashboard either way.</p>'

    + '<hr class="settings-rule" />'
    + '<h4 class="settings-h4">Email reminders</h4>'
    + '<p class="settings-note">The prompt above only fires when you open Orbit. '
    + 'This one arrives on its own — a single digest of everyone who is drifting, '
    + 'never one email per person.</p>'
    + settingsRow("Email me",
        '<select id="setEmailReminders">'
        + '<option value="off"' + (emailMode === "off" ? " selected" : "") + '>Never</option>'
        + '<option value="fortnightly"' + (emailMode === "fortnightly" ? " selected" : "")
        + '>Every two weeks</option>'
        + '</select>')
    + '<p class="field-hint">Sent to <strong>' + escapeHtml(reminderTarget) + '</strong> at '
    + 'around <strong>9am</strong> your time (<span class="tz-name">'
    + escapeHtml(browserTimezone()) + '</span>), on the same day every fortnight — one '
    + 'email, everyone who is drifting, most overdue first. Anyone still overdue after '
    + 'three of them stops being listed and becomes a note that their cadence may be '
    + 'wrong.</p>'
    + '<p id="emailRemMsg" class="success" aria-live="polite"></p>'
    + '<p id="emailRemErr" class="error" aria-live="polite"></p>'
    + '<button class="btn btn-secondary btn-sm" id="saveEmailReminders" type="button">Save email setting</button>'
    + '</section>'

    // ── Integrations (ORB-36) ────────────────────────────────────────────
    // Always here, in every state, independent of whether the nav entry point
    // is showing. The nav item is discovery and goes away once you have
    // connected; this is management, and management has to be findable exactly
    // when something has broken.
    + '<section class="settings-pane" data-pane="integrations">'
    + '<h3 class="settings-h3">Integrations</h3>'
    + '<div id="settingsIntegrations"></div>'
    + '</section>'

    // ── Security ─────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="security">'
    + '<h3 class="settings-h3">Security &amp; login</h3>'
    + '<h4 class="settings-h4">Change password</h4>'
    + '<div class="field-group"><label for="setPw1">New password</label>'
    + '<input type="password" id="setPw1" autocomplete="new-password" placeholder="At least '
    + MIN_PASSWORD + ' characters" />'
    + '<div class="pw-meter" id="setPwMeter" hidden>'
    + '<div class="pw-meter-track"><div class="pw-meter-fill"></div></div>'
    + '<p class="pw-meter-label" aria-live="polite"></p>'
    + '</div>'
    + passwordAdviceHtml()
    + '</div>'
    + '<div class="field-group"><label for="setPw2">Confirm new password</label>'
    + '<input type="password" id="setPw2" autocomplete="new-password" /></div>'
    + '<p id="pwMsg" class="success" aria-live="polite"></p>'
    + '<p id="pwErr" class="error" aria-live="polite"></p>'
    + '<button class="btn" id="savePw" type="button">Update password</button>'
    // Hidden until ORB-21 ships. A permanently disabled "not built yet" button
    // is worse than no button: it advertises a security control the account does
    // not have. Change password is real and stays.
    // + '<hr class="settings-rule" />'
    // + '<h4 class="settings-h4">Two-factor authentication</h4>'
    // + '<p class="settings-note">Not enabled. Two options, and they are not equal:</p>'
    // + '<ul class="settings-list">'
    // + '<li><strong>Authenticator app</strong> — free on Supabase, works offline. The one worth building.</li>'
    // + '<li><strong>SMS to your phone</strong> — needs a paid provider (Twilio) and is weaker: '
    // + 'SIM-swap attacks are why security guidance now prefers an app.</li>'
    // + '</ul>'
    // + '<button class="btn btn-secondary" type="button" disabled>Set up authenticator (not built yet)</button>'
    + '</section>'

    // ── Data ─────────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="data">'
    + '<h3 class="settings-h3">Data controls</h3>'
    + '<p class="settings-note">Your network is yours. Take a copy whenever you like.</p>'
    + settingsRow("Export network",
        '<button class="btn btn-secondary btn-sm" id="exportCsv" type="button">Download CSV</button>')
    + '<p id="exportMsg" class="success" aria-live="polite"></p>'
    + '<hr class="settings-rule" />'
    + '<h4 class="settings-h4">Delete account</h4>'
    + '<p class="settings-note">Deleting a Supabase account needs a server-side admin call, which this '
    + 'app does not have — it runs entirely in your browser. For now, delete your account from the '
    + 'Supabase dashboard under Authentication → Users.</p>'
    + '</section>'

    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#settingsClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  const show = (name) => {
    modal.querySelectorAll(".settings-navitem").forEach((b) =>
      b.classList.toggle("active", b.dataset.section === name));
    modal.querySelectorAll(".settings-pane").forEach((p) =>
      p.classList.toggle("active", p.dataset.pane === name));
  };
  modal.querySelectorAll(".settings-navitem").forEach((b) =>
    b.addEventListener("click", () => show(b.dataset.section)));
  // Restore with the 2FA callout above (ORB-21). Left uncommented it would throw
  // on a null button and take the whole settings modal down with it.
  // modal.querySelector("#goSecurity").addEventListener("click", () => show("security"));
  show(section);

  modal.querySelector("#setTheme").addEventListener("change", (e) => {
    localStorage.setItem("orbit_theme", e.target.value);
    applyTheme();
  });

  modal.querySelector("#setNudge").addEventListener("change", (e) => {
    localStorage.setItem(NUDGE_KEY, e.target.value);
  });

  modal.querySelector("#saveProfile").addEventListener("click", async () => {
    const msg = modal.querySelector("#profileMsg");
    const err = modal.querySelector("#profileErr");
    msg.textContent = ""; err.textContent = "";
    const result = await db.savePreferences({
      your_name: modal.querySelector("#setYourName").value.trim(),
      your_email: modal.querySelector("#setYourEmail").value.trim(),
      phone: modal.querySelector("#setPhone").value.trim()
    });
    if (!result.ok) { err.textContent = "Could not save — see the console (F12)."; return; }
    if (result.skipped.length) {
      err.textContent = "Saved, but " + result.skipped.join(" and ")
        + " needs supabase/migrations/004_settings_columns.sql to be run first.";
    }
    msg.textContent = "Profile saved.";
    refreshProfileButton();
    setTimeout(() => { msg.textContent = ""; }, 2500);
  });

  attachStrengthMeter(
    modal.querySelector("#setPw1"),
    modal.querySelector("#setPwMeter"),
    () => authEmail
  );

  renderSettingsIntegrations(modal.querySelector("#settingsIntegrations"));

  modal.querySelector("#saveEmailReminders").addEventListener("click", async () => {
    const msg = modal.querySelector("#emailRemMsg");
    const err = modal.querySelector("#emailRemErr");
    msg.textContent = ""; err.textContent = "";
    const mode = modal.querySelector("#setEmailReminders").value;

    // Turning this on with nowhere to send it would fail silently in a cron job
    // nobody is watching, so it is refused here where there is someone to tell.
    if (mode !== "off" && !((prefs.your_email || "").trim() || authEmail)) {
      err.textContent = "Add a contact email under Profile first — there is nowhere to send these.";
      return;
    }

    // The digest goes out at 9am in YOUR morning, so the job needs to know
    // which morning that is. Detected rather than asked for: a timezone picker
    // is a long list of names to answer a question the browser already knows,
    // and the wrong answer only costs the hour an email arrives.
    const result = await db.savePreferences({ email_reminders: mode, timezone: browserTimezone() });
    if (!result.ok) { err.textContent = "Could not save — see the console (F12)."; return; }
    if (result.skipped.includes("email_reminders")) {
      err.textContent = "Run supabase/migrations/005_reminder_columns.sql and 007_digest_streak.sql first.";
      return;
    }
    prefs.email_reminders = mode;
    msg.textContent = mode === "off"
      ? "Email reminders are off."
      : "Saved. The first digest goes out within a fortnight, around 9am "
        + browserTimezone() + " time, to "
        + ((prefs.your_email || "").trim() || authEmail) + ".";
    setTimeout(() => { msg.textContent = ""; }, 3000);
  });

  modal.querySelector("#savePw").addEventListener("click", async () => {
    const msg = modal.querySelector("#pwMsg");
    const err = modal.querySelector("#pwErr");
    msg.textContent = ""; err.textContent = "";
    const pw1 = modal.querySelector("#setPw1").value;
    const pw2 = modal.querySelector("#setPw2").value;
    if (pw1.length < MIN_PASSWORD) {
      err.textContent = "Use at least " + MIN_PASSWORD + " characters.";
      return;
    }
    if (pw1 !== pw2) { err.textContent = "The two passwords do not match."; return; }
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    if (error) { err.textContent = error.message; return; }
    modal.querySelector("#setPw1").value = "";
    modal.querySelector("#setPw2").value = "";
    msg.textContent = "Password updated.";
  });

  modal.querySelector("#exportCsv").addEventListener("click", async () => {
    const n = await exportNetworkCsv();
    const msg = modal.querySelector("#exportMsg");
    msg.textContent = `Exported ${n} ${n === 1 ? "connection" : "connections"}.`;
    setTimeout(() => { msg.textContent = ""; }, 3000);
  });
}

/** A label-on-the-left, control-on-the-right settings row. */
function settingsRow(label, controlHtml) {
  return '<div class="settings-row">'
    + '<span class="settings-row-label">' + escapeHtml(label) + '</span>'
    + '<div class="settings-row-control">' + controlHtml + '</div>'
    + '</div>';
}

// ── Profile menu (sidebar footer) ─────────────────────────────────────────────

async function refreshProfileButton() {
  const btn = document.getElementById("profileBtn");
  if (!btn) return;
  const [prefs, { data: { user } }] = await Promise.all([
    db.getPreferences(),
    supabase.auth.getUser()
  ]);
  const name = (prefs.your_name || "").trim() || (user?.email || "").split("@")[0] || "You";
  btn.querySelector(".profile-initials").textContent = initialsFor(name);
  btn.querySelector(".profile-name").textContent = name;
  btn.querySelector(".profile-sub").textContent = user?.email || "";
}

function initProfileMenu() {
  const btn = document.getElementById("profileBtn");
  if (!btn) return;

  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; btn.setAttribute("aria-expanded", "false"); };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) { closeMenu(); return; }

    menu = document.createElement("div");
    menu.className = "profile-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML =
      '<button class="pm-item" role="menuitem" data-act="profile">'
      + '<span class="pm-icon" aria-hidden="true">◍</span> Profile</button>'
      + '<button class="pm-item" role="menuitem" data-act="settings">'
      + '<span class="pm-icon" aria-hidden="true">⚙</span> Settings</button>'
      + '<hr class="pm-rule" />'
      + '<button class="pm-item pm-danger" role="menuitem" data-act="signout">'
      + '<span class="pm-icon" aria-hidden="true">⭘</span> Log out</button>';
    btn.parentElement.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");

    menu.addEventListener("click", async (ev) => {
      const act = ev.target.closest(".pm-item")?.dataset.act;
      if (!act) return;
      closeMenu();
      if (act === "profile") openProfileModal();
      if (act === "settings") openSettingsModal("general");
      if (act === "signout") {
        await supabase.auth.signOut();
        window.location.href = "auth.html";
      }
    });
  });

  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  refreshProfileButton();
}

// ── Reach-out nudge on load ───────────────────────────────────────────────────

/**
 * The nudge on open (ORB-58, closing ORB-13).
 *
 * ORB-13 asked why recording a reach-out took two clicks and a modal. The
 * dashboard, My Network and the profile were all answered months ago:
 * `markReachedOut` gives one past-tense click with an 8-second undo, and the
 * dialog is demoted to a secondary Draft button.
 *
 * **The one surface that interrupts you never got the rework.** It opened the
 * old "Draft a message" modal — a dialog, over whatever you were doing, whose
 * first offer is an eight-line draft you did not ask for and whose confirm
 * button is third. That is the worst version of the gesture on the surface with
 * the least patience for it.
 *
 * So the nudge is now a bar, not a dialog. It does not trap focus, it does not
 * cover the page, and its primary action is the same one click as everywhere
 * else. Drafting is still one click away, which is where it belongs — writing a
 * message is the rare path, and saying you already sent one is the common one.
 *
 * WHO IT PICKS
 *
 * `needsAttention()` rather than "first overdue", so it follows ORB-92's
 * ranking: a thought you caught, then a conversation two days old, then an
 * anniversary, then the clock. A nudge that interrupts you about the least
 * interesting person on the list teaches you to dismiss nudges.
 */
function reachOutNudgeHtml(contact, health) {
  const reason = reachOutReason(contact, health);
  return '<div class="nudge" role="region" aria-label="Reach out to '
    + escapeHtml(contact.name) + '">'
    + '<div class="nudge-body">'
    + '<p class="nudge-name">' + escapeHtml(contact.name)
    + (contact.starred === true ? ' <span class="star-inline" aria-hidden="true">\u2605</span>' : '')
    + '</p>'
    + '<p class="nudge-why">'
    + escapeHtml(reason.kind === "elapsed"
        ? lastSpokeSentence(contact, health)
        : reason.text)
    + '</p>'
    + '</div>'
    + '<div class="nudge-actions">'
    + '<button class="btn btn-sm" type="button" data-nudge-done>\u2713 Reached out</button>'
    + '<button class="btn btn-secondary btn-sm" type="button" data-nudge-draft>Draft</button>'
    + '<button class="icon-btn nudge-close" type="button" data-nudge-dismiss'
    + ' aria-label="Not now">\u2715</button>'
    + '</div>'
    + '</div>';
}

function showReachOutNudge(contact, health = getHealth(contact), onChanged) {
  document.querySelector(".nudge")?.remove();
  const host = document.createElement("div");
  host.className = "nudge-slot";
  host.innerHTML = reachOutNudgeHtml(contact, health);
  document.body.appendChild(host);

  const close = () => host.remove();
  const refresh = async () => {
    close();
    // Whatever page opened this re-renders itself, so the row the nudge was
    // about updates behind it rather than going stale (ORB-15's hook).
    if (onChanged) await onChanged();
    else if (window.__orbitRefresh) await window.__orbitRefresh();
  };

  host.querySelector("[data-nudge-done]").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    await markReachedOut(contact, refresh);
  });
  host.querySelector("[data-nudge-draft]").addEventListener("click", async () => {
    close();
    await showReminderModal(contact, onChanged);
  });
  host.querySelector("[data-nudge-dismiss]").addEventListener("click", () => {
    snoozeNudge(contact.id);
    close();
    // Said out loud, because a dismissal that silently changes behaviour for a
    // month is its own surprise — and because the previous ✕ did nothing, so
    // there is a habit to correct.
    showToast("Not for a while — " + firstNameOf(contact.name)
      + " stays on your dashboard, just quietly.");
  });
  return host;
}

async function checkRemindersOnLoad() {
  if (document.querySelector("[data-page='contact']")) return;
  if (!nudgeAllowed()) return;
  setTimeout(async () => {
    const contacts = (await db.getContacts()) || [];
    // ORB-58. Was `contacts.filter(getReminderStatus === "due")[0]`, which is a
    // different question from the one the dashboard answers and could pick
    // someone the list does not even show first.
    // ORB-126. The first person you have not waved away this month, rather than
    // simply the first person. Skipping rather than suppressing the nudge
    // entirely: dismissing one person is not a request to stop being told
    // anything.
    const next = needsAttention(contacts).find((x) => !nudgeSnoozed(x.contact.id));
    if (!next) return;
    markNudgeShown();
    showReachOutNudge(next.contact, next.health);
  }, 900);
}

/**
 * The name you typed at sign-up (ORB-106).
 *
 * `auth.html` collects "Your Name" and stores it on the Supabase Auth user as
 * `user_metadata.full_name`. Drafts read `preferences.your_name` — a different
 * store, written only by the settings modal. So the name was collected and
 * never used, and every draft signed off `[Your Name]` until you went looking
 * for a setting you had no reason to know about.
 *
 * Backfilled rather than written at sign-up, because at sign-up there is no
 * confirmed session to write preferences with — and because this way it also
 * repairs every account created before the bug was found.
 *
 * Runs once, only when the preference is genuinely empty. It must never
 * overwrite a name the user set themselves: the settings field is the answer,
 * and the sign-up metadata is only a better default than nothing.
 */
async function backfillNameFromSignUp(user) {
  const signUpName = String(user?.user_metadata?.full_name || "").trim();
  if (!signUpName) return;
  const prefs = await db.getPreferences();
  if (String(prefs?.your_name || "").trim()) return;
  await db.savePreferences({ your_name: signUpName });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  const user = await requireAuth();
  if (!user) return;
  // Before anything renders a draft. Failing is not worth blocking the app for.
  await backfillNameFromSignUp(user).catch(() => {});
  initSidebarToggle();
  initNavDropdown();
  applyTheme();
  initProfileMenu();
  evaluateIntegrationsNav();
  await initDashboard();
  await initMyNetwork();
  await initNetworkingLog();
  await initContactPage();
  await initFilesPage();
  await initIntegrationsPage();
  await checkRemindersOnLoad();
  // Last, and deliberately not awaited into anything that renders: it talks to
  // Google over the network and must never hold up the page.
  await adoptCalendarConnection();
  initCalendarAutoSync().catch(() => {});
})();
