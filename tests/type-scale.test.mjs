/**
 * One type scale across the conversation surfaces (ORB-65).
 *
 * WHY A TEST AND NOT A COMMENT
 *
 * The same sentence is written in four boxes and read in one timeline. Before
 * this, a note rendered at 0.82rem in the timeline and 0.88rem in every box
 * that could edit it — the same words, two sizes, depending on where you had
 * opened them. Nobody chose that. It happened because each component picked a
 * number when it was written.
 *
 * The ticket's own words are "or it drifts again the next time a component is
 * added". A comment saying "use the token" does not survive that; a failing
 * test does. So this reads the stylesheet and refuses a literal font-size on
 * any surface that shows conversation text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const css = readFileSync(join(ROOT, "css", "style.css"), "utf8");

/** Every rule block whose selector list mentions `selector`. */
function rulesFor(selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (sel.split(",").some((s) => s.trim() === selector)) out.push(m[2]);
  }
  return out;
}
const literalFontSize = (body) => /font-size:\s*[^;]*\d/.test(body) && !/font-size:\s*var\(/.test(body);

group("The scale is defined once");
for (const token of ["--convo-body", "--convo-body-lh", "--convo-title", "--convo-meta"]) {
  ok(token + " is declared", css.includes(token + ":"));
}
eq("--convo-body is declared exactly once",
  (css.match(/--convo-body:/g) || []).length, 1);

group("Every box a conversation is written in uses it");
// The logger, the edit dialog, the profile's inline log, the calendar review.
for (const sel of [".cw-notes", ".convo-edit-notes", "#cpIntNotes", ".cal-notes"]) {
  const rules = rulesFor(sel);
  ok(sel + " is styled at all", rules.length > 0);
  ok(sel + " sets no literal font-size",
    !rules.some(literalFontSize));
}
ok("and they share one declaration rather than four copies",
  rulesFor(".cw-notes").some((r) => /font-size:\s*var\(--convo-body\)/.test(r)));

group("And so does the place it is read");
{
  const rules = rulesFor(".convo-note");
  ok(".convo-note is styled", rules.length > 0);
  ok(".convo-note sets no literal font-size", !rules.some(literalFontSize));
  ok("it uses the body token",
    rules.some((r) => /font-size:\s*var\(--convo-body\)/.test(r)));
  ok("with the matching line height",
    rules.some((r) => /line-height:\s*var\(--convo-body-lh\)/.test(r)));
}

group("The written and the read text are the same size");
// Stated directly, because this is the complaint the ticket opens with.
{
  const written = rulesFor(".cw-notes").find((r) => /font-size/.test(r));
  const read = rulesFor(".convo-note").find((r) => /font-size/.test(r));
  const sizeOf = (r) => r.match(/font-size:\s*([^;]+)/)[1].trim();
  eq("logger and timeline resolve to one value", sizeOf(written), sizeOf(read));
}

group("Headings are single-sourced too");
{
  const rules = rulesFor(".modal-card h3");
  eq("declared once, not twice with the later one silently winning", rules.length, 1);
  ok("and uses the title token", /font-size:\s*var\(--convo-title\)/.test(rules[0]));
}

group("The replaced inline editor left nothing behind");
// ORB-64 swapped it for a dialog. Dead CSS that still looks authoritative is
// how a second type scale gets reintroduced.
ok("no .convo-textarea rule survives", rulesFor(".convo-textarea").length === 0);
ok("no .convo-editor-actions rule survives", rulesFor(".convo-editor-actions").length === 0);

done();
