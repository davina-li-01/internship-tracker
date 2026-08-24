/**
 * A caught thought is visibly a caught thought, and the dialog stops arguing
 * (ORB-105, ORB-110).
 *
 * Both come from the 20 August session and both are about saying less, or
 * saying it in the right place.
 *
 * ORB-105 is the strongest signal in the set — four of the twenty-two items are
 * one problem. "The thought goes to the checklist. Not sure if that's the right
 * place. It's not clear where it goes." ORB-81 shipped the input without the
 * output being legible: a thought caught at 2am arrived on the profile as an
 * unlabelled line among talking points, and the tag styling that existed was
 * orange on orange with the PERSONAL email badge, so it read as contact
 * information rather than as something you wrote.
 *
 * ORB-110 is item 5, and it took apart an argument this codebase had already
 * made. See the ORB-80 group in reach-out-prompt.test.mjs for the reversal.
 *
 * WHAT THIS SUITE GUARDS
 *
 * That the vocabulary does not fork. The dashboard already calls a capture
 * "You noted" (ORB-90); the profile must not invent a synonym, which is ORB-74's
 * failure in miniature and the reason that suite exists at all.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const {
  normalizeContact, normalizeFollowUpItem, renderFollowUpItems, followUpTagHtml,
  reachOutPromptHtml, reachOutReason, getHealth, ledgerLine, FOLLOWUP_TAGS
} = main;

// Midday local, not 09:00 UTC — see talking-points.test.mjs.
const at = (day) => new Date(day + "T12:00:00").toISOString();
const person = (followUps) => normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly", reminderEnabled: true,
  interactions: [{ id: "i1", date: daysAgo(10), type: "coffee chat", notes: "We talked about the move" }],
  followUps
});

// ── ORB-105: which of the four kinds is this ─────────────────────────────────

group("Only what you did not type carries a label");
{
  ok("a caught thought is marked",
    /fu-tag-capture/.test(followUpTagHtml(normalizeFollowUpItem({ text: "x", source: "capture" }))));
  ok("a suggestion is marked",
    /fu-tag-ai/.test(followUpTagHtml(normalizeFollowUpItem({ text: "x", source: "ai" }))));
  // A tag on every row would be noise on the majority to explain the minority.
  eq("a point you typed yourself is not",
    followUpTagHtml(normalizeFollowUpItem({ text: "x", source: "manual" })), "");
}
{
  const html = renderFollowUpItems(person([
    normalizeFollowUpItem({ id: "a", text: "Congratulate him", source: "capture", createdAt: at(daysAgo(1)) }),
    normalizeFollowUpItem({ id: "b", text: "Typed on the profile", source: "manual", createdAt: at(daysAgo(1)) })
  ]));
  eq("exactly one of the two rows is tagged", (html.match(/fu-tag /g) || []).length, 1);
  ok("and the thought is still readable as a sentence", /Congratulate him/.test(html));
}

group("The profile uses the dashboard's word, not a synonym");
{
  // ORB-90 tags the dashboard row "You noted". Two words for one concept is
  // exactly what ORB-74 was written to stop.
  const c = normalizeContact({
    id: "c2", name: "Marcus Chen", followUpFrequency: "monthly", reminderEnabled: true,
    followUps: [normalizeFollowUpItem({ text: "Congratulate him", source: "capture" })]
  });
  const dashboardLabel = reachOutReason(c, getHealth(c)).label;
  eq("the capture tag is the dashboard's label verbatim",
    FOLLOWUP_TAGS.capture.label, dashboardLabel);
}

group("Nothing on a talking point is coloured like an email address");
{
  // The literal finding: the tag styling was rgba(249,115,22,...) with
  // --primary-deep, and so is .email-label. A PERSONAL badge and a caught
  // thought were the same colour.
  // Comments stripped first. The rule that deleted .fu-tag-manual explains why
  // it was deleted, and a test that cannot tell an explanation from a rule is
  // testing prose — the same trap password-reset.test.mjs fell into.
  const css = readFileSync(join(ROOT, "css", "style.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (name) => (css.match(new RegExp("\\n\\." + name + "\\s*\\{[^}]*\\}")) || [""])[0];
  const capture = rule("fu-tag-capture");
  const ai = rule("fu-tag-ai");
  ok("the capture tag has a colour of its own", capture.length > 0);
  ok("and it is not the primary orange", !/primary/.test(capture) && !/249,\s*115,\s*22/.test(capture));
  ok("nor is the suggestion tag", !/primary/.test(ai) && !/249,\s*115,\s*22/.test(ai));
  // Deleted rather than recoloured, so it cannot come back as a third colour.
  ok("and the manual tag is gone entirely, not merely restyled",
    !/\.fu-tag-manual/.test(css));
}

group("Saving says where it went, not that it went somewhere");
{
  const src = readFileSync(join(ROOT, "js", "main.js"), "utf8")
    // A comment explaining the old copy is not the old copy.
    .replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok("the confirmation names the section by its heading",
    /Things to bring up next/.test(src));
  ok('and no longer says only "on your list"', !/it is on your list/.test(src));
}

// ── ORB-110: the dialog is about the message ─────────────────────────────────

group("The ledger argues whether; the quote is material for what");
{
  const c = normalizeContact({
    id: "c3", name: "Marcus Chen", followUpFrequency: "monthly", reminderEnabled: true,
    dateMet: daysAgo(700),
    interactions: [
      { id: "a", date: daysAgo(700), type: "coffee chat", notes: "First met at the meetup" },
      { id: "b", date: daysAgo(120), type: "call", notes: "He is thinking about the move" }
    ]
  });
  ok("this contact has a ledger to suppress", Boolean(ledgerLine(c)));

  const withLedger = reachOutPromptHtml(c, getHealth(c));
  const without = reachOutPromptHtml(c, getHealth(c), { ledger: false });
  ok("the dashboard row keeps it", /prompt-ledger/.test(withLedger));
  ok("the dialog drops it", !/prompt-ledger/.test(without));
  ok("but keeps the person and the silence", /prompt-line/.test(without));
  ok("and keeps their words", /prompt-echo/.test(without));
}
{
  // The two switches are independent: ORB-97's echo toggle predates this and
  // must not have been quietly co-opted into meaning "trim the dialog".
  const c = normalizeContact({
    id: "c4", name: "Marcus Chen", followUpFrequency: "monthly", reminderEnabled: true,
    dateMet: daysAgo(700),
    interactions: [
      { id: "a", date: daysAgo(700), type: "coffee chat", notes: "First met" },
      { id: "b", date: daysAgo(120), type: "call", notes: "The move" }
    ]
  });
  const noEcho = reachOutPromptHtml(c, getHealth(c), { echo: false });
  ok("dropping the echo leaves the ledger alone", /prompt-ledger/.test(noEcho));
  ok("and it really did drop the echo", !/prompt-echo/.test(noEcho));
}

done();
