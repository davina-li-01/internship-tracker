/**
 * Formatting in conversation notes (ORB-63).
 *
 * THE DECISION THIS SUITE DEFENDS
 *
 * Notes are stored as plain text with markers, never as HTML. Notes are the one
 * field where other people's words get pasted in — a transcript, an email, a
 * job description — so the injection surface has to stay closed, and CSV export
 * in ORB-12 would start emitting tags the day we stored markup.
 *
 * That safety rests entirely on one ordering: escape first, then translate a
 * fixed set of markers into a fixed set of tags. By the time markers are read,
 * every `<` is already `&lt;`, so nothing a user types can become a tag. The
 * first group below is that property stated as tests, because a future
 * refactor that swaps those two lines would still pass every formatting
 * assertion while quietly reopening the hole.
 */
import { loadMain } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const { renderNotes, stripNoteMarks, toggleNoteMark, noteToolbarHtml, wireNoteToolbar } = main;
const dom = globalThis.__dom;

group("Escaping happens before formatting, and cannot be got round");
eq("a script tag is inert text",
  renderNotes('<script>alert(1)</script>'),
  '&lt;script&gt;alert(1)&lt;/script&gt;');
eq("an img with an onerror handler is inert text",
  renderNotes('<img src=x onerror=alert(1)>'),
  '&lt;img src=x onerror=alert(1)&gt;');
eq("markers around a tag still cannot produce one",
  renderNotes('**<b>hi</b>**'),
  '<strong>&lt;b&gt;hi&lt;/b&gt;</strong>');
eq("quotes and ampersands survive as text",
  renderNotes(`Tom & "Jerry" 's`),
  'Tom &amp; &quot;Jerry&quot; &#39;s');
ok("no unescaped angle bracket can reach the output",
  !/[<>]/.test(renderNotes("a < b > c").replace(/&[a-z#0-9]+;/g, "")));

group("The four marks render");
eq("bold", renderNotes("**loud**"), "<strong>loud</strong>");
eq("italic", renderNotes("*soft*"), "<em>soft</em>");
eq("underline", renderNotes("__under__"), "<u>under</u>");
eq("highlight", renderNotes("==note this=="), "<mark>note this</mark>");
eq("several in one line",
  renderNotes("**a** and *b* and ==c=="),
  "<strong>a</strong> and <em>b</em> and <mark>c</mark>");

group("Bold is read before italic");
// `**x**` under an italic-first rule becomes <em>*</em>x* — the classic bug.
eq("double asterisks are bold, not nested italics",
  renderNotes("**x**"), "<strong>x</strong>");
eq("bold inside a sentence leaves neighbouring text alone",
  renderNotes("say **this** now"), "say <strong>this</strong> now");

group("Plain text is left alone");
eq("an unmatched marker is literal", renderNotes("2 * 3 = 6"), "2 * 3 = 6");
eq("a lone underscore is literal", renderNotes("file_name"), "file_name");
eq("markers do not span lines",
  renderNotes("**start\nend**"), "**start\nend**");
eq("empty input", renderNotes(""), "");
eq("undefined input", renderNotes(undefined), "");

group("Previews show the words, not the syntax");
eq("marks are stripped", stripNoteMarks("**a** *b* __c__ ==d=="), "a b c d");
eq("plain text is unchanged", stripNoteMarks("nothing to do"), "nothing to do");
eq("an unmatched marker stays", stripNoteMarks("2 * 3"), "2 * 3");

// ── The toolbar ──────────────────────────────────────────────────────────────
// Pure, because the awkward cases are selection maths and they should not need
// a browser to check.

group("Wrapping a selection");
{
  const r = toggleNoteMark("hello world", 6, 11, "**");
  eq("the selection is wrapped", r.value, "hello **world**");
  eq("and stays selected", [r.start, r.end], [8, 13]);
}
{
  const r = toggleNoteMark("hi", 0, 2, "==");
  eq("highlight wraps too", r.value, "==hi==");
}

group("Pressing the same button again unwraps");
{
  // Selection includes the markers — what you get by selecting the rendered word
  // plus its syntax.
  const r = toggleNoteMark("say **this** now", 4, 12, "**");
  eq("the markers come off", r.value, "say this now");
  eq("and the bare word stays selected", [r.start, r.end], [4, 8]);
}
{
  // Selection is just the word, markers sit immediately outside it.
  const r = toggleNoteMark("say **this** now", 6, 10, "**");
  eq("markers outside the selection are also removed", r.value, "say this now");
  eq("selection follows the text left", [r.start, r.end], [4, 8]);
}

group("Nothing selected puts the caret inside the markers");
{
  const r = toggleNoteMark("", 0, 0, "**");
  eq("markers are inserted", r.value, "****");
  eq("and the caret sits between them so typing lands inside",
    [r.start, r.end], [2, 2]);
}

group("The toolbar is wired to the box it belongs to");
{
  document.body.innerHTML = '<div id="w">' + noteToolbarHtml()
    + '<textarea class="convo-textarea"></textarea></div>';
  const scope = document.getElementById("w");
  const area = scope.querySelector("textarea");
  eq("one button per mark", scope.querySelectorAll(".note-tool").length, 4);

  area.value = "keep this";
  area.setSelectionRange(5, 9);
  wireNoteToolbar(scope, area);

  // mousedown, not click: by click time the textarea has blurred and the
  // selection has collapsed to zero, which is the bug this guards.
  scope.querySelector('[data-mark="**"]')
    .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  eq("the selected words are wrapped", area.value, "keep **this**");

  ok("and the note renders as bold",
    renderNotes(area.value) === "keep <strong>this</strong>");
}

// ── Every box you can write a note in ────────────────────────────────────────
// The toolbar shipped into the edit dialog and nowhere else. Every assertion
// above still passed, because they all tested the toolbar in isolation and
// never asked whether the places people actually type had one. These do.

group("The toolbar exists wherever a note is written");
{
  const html = main.conversationWidgetHtml();
  ok("the logger renders one", html.includes("note-toolbar"));
  ok("above its notes box, not below",
    html.indexOf("note-toolbar") < html.indexOf("cw-notes"));
}

group("And it is wired, not just drawn");
{
  // A toolbar that renders and does nothing is worse than no toolbar: it
  // promises a feature and silently drops the click.
  document.body.innerHTML = '<div id="root">' + main.conversationWidgetHtml() + "</div>";
  const host = document.getElementById("root");
  main.wireConversationWidget(host, () => [], async () => {});

  const area = host.querySelector(".cw-notes");
  area.value = "the platform team";
  area.setSelectionRange(4, 17);
  host.querySelector('.note-toolbar [data-mark="**"]')
    .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  eq("bold wraps the selection in the logger", area.value, "the **platform team**");

  area.setSelectionRange(0, 3);
  host.querySelector('.note-toolbar [data-mark="=="]')
    .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  eq("and so does highlight", area.value, "==the== **platform team**");
}

group("The highlighter is drawn, not an emoji");
{
  const html = main.noteToolbarHtml();
  ok("it ships an inline svg", /<svg[^>]*viewBox/.test(html));
  ok("which takes the button's colour", html.includes("currentColor"));
  ok("and is hidden from screen readers, since the button is labelled",
    /aria-hidden="true"/.test(html));
  // Counted off the buttons, not the string — the group wrapper carries an
  // aria-label of its own and a naive match counts five.
  document.body.innerHTML = html;
  const tools = [...document.querySelectorAll(".note-tool")];
  eq("four tools", tools.length, 4);
  ok("each has an accessible name, including the icon-only one",
    tools.every((t) => (t.getAttribute("aria-label") || "").length > 0));
  eq("and the group itself is named",
    document.querySelector(".note-toolbar").getAttribute("aria-label"), "Formatting");
}

done();
