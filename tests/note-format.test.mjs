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
const { renderNotes, stripNoteMarks, noteToolbarHtml, editorToMarks } = main;
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

// ── Back out of the editor ───────────────────────────────────────────────────
// You type into something that shows real bold (ORB-72); what gets stored is
// still plain text with markers. This is that boundary, and it is pure, so the
// cases a browser would make awkward are cheap to state.

const marksOf = (html) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return editorToMarks(el);
};

group("Every tag a browser might produce comes back as a marker");
eq("strong", marksOf("<strong>loud</strong>"), "**loud**");
// Safari and old execCommand emit <b> and <i> where others emit <strong>/<em>.
eq("b is treated as strong", marksOf("<b>loud</b>"), "**loud**");
eq("em", marksOf("<em>soft</em>"), "*soft*");
eq("i is treated as em", marksOf("<i>soft</i>"), "*soft*");
eq("u", marksOf("<u>under</u>"), "__under__");
eq("mark", marksOf("<mark>lit</mark>"), "==lit==");
// execCommand renders a highlight as a styled span rather than a <mark>.
eq("a span with a background colour is a highlight",
  marksOf('<span style="background-color: rgb(253, 224, 71)">lit</span>'), "==lit==");

group("Structure survives the trip");
eq("plain text", marksOf("just words"), "just words");
eq("mixed marks in a line",
  marksOf("<strong>a</strong> and <em>b</em>"), "**a** and *b*");
eq("a line break", marksOf("one<br>two"), "one\ntwo");
eq("divs are lines, which is what Enter produces",
  marksOf("<div>one</div><div>two</div>"), "one\ntwo\n");
eq("paragraphs too", marksOf("<p>one</p><p>two</p>"), "one\ntwo\n");
eq("nesting composes rather than dropping one",
  marksOf("<strong><em>both</em></strong>"), "***both***");
eq("empty", marksOf(""), "");

group("Nothing unexpected becomes a marker");
// A pasted table, a link, a heading: unknown tags contribute their text and
// nothing else, so no formatting can enter that the four marks cannot express.
eq("a link keeps its words only", marksOf('<a href="http://x">click</a>'), "click");
eq("a heading is just text", marksOf("<h1>Title</h1>"), "Title");
eq("a table contributes cells, not structure",
  marksOf("<table><tr><td>a</td><td>b</td></tr></table>"), "ab");
eq("an empty tag adds no stray markers", marksOf("<strong></strong>"), "");
eq("a whitespace-only tag adds none either", marksOf("<strong>   </strong>"), "   ");

group("A note survives a round trip unchanged");
// The property that matters: open a saved note, change nothing, save it back,
// and get the same string. Anything else silently rewrites people's notes.
for (const original of [
  "plain words",
  "**bold**",
  "*italic*",
  "__under__",
  "==lit==",
  "**a** and *b* and ==c==",
  "line one\nline two"
]) {
  eq(JSON.stringify(original), marksOf(renderNotes(original)), original);
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
  //
  // Bold, italic and underline go through document.execCommand, which jsdom
  // does not implement — so those are verified in a browser, not here, and
  // this asserts the wiring and the one tool that does not need it. The
  // serialisation that turns any of them back into markers is covered below
  // and is where the real risk lives.
  document.body.innerHTML = '<div id="root">' + main.conversationWidgetHtml() + "</div>";
  const host = document.getElementById("root");
  main.wireConversationWidget(host, () => [], async () => {});

  const box = host.querySelector(".cw-notes");
  ok("the notes box is editable", box.getAttribute("contenteditable") === "true");
  ok("and announces itself as a text box", box.getAttribute("role") === "textbox");

  box.textContent = "the platform team";
  const range = document.createRange();
  range.setStart(box.firstChild, 4);
  range.setEnd(box.firstChild, 17);
  const sel = dom.window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  host.querySelector('.note-toolbar [data-mark="=="]')
    .dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  eq("highlight wraps the selection in the logger",
    main.editorToMarks(box), "the ==platform team==");
}

group("Pasting brings words, never markup");
{
  // The reason markers are safe is that nothing else can get in. A note is
  // exactly where someone pastes a styled email or half a Google Doc, and a
  // contenteditable will happily accept all of it unless stopped.
  document.body.innerHTML = '<div id="p">'
    + main.notesEditorHtml({ className: "cw-notes" }) + "</div>";
  const scope = document.getElementById("p");
  const box = scope.querySelector(".notes-input");
  main.wireNotesEditor(scope, box);

  const paste = (html, text) => {
    const e = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    e.clipboardData = { getData: (t) => (t === "text/plain" ? text : html) };
    box.dispatchEvent(e);
  };

  paste('<b>bold</b> <script>alert(1)</script>', "bold alert(1)");
  ok("no tags came through", !/<[a-z]/i.test(box.innerHTML));
  ok("the words did", box.textContent.includes("bold"));
  eq("and it serialises to plain text with no markers",
    main.editorToMarks(box), "bold alert(1)");
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
