/**
 * The reach-out prompt says who and how long (ORB-78), and answers the
 * objection that raises (ORB-79).
 *
 * WHY THIS EXISTS
 *
 * Survey 1 asked five people what actually prompted the last message they sent
 * a professional contact. Three said some version of "it had been a while and I
 * felt bad about it." One was moved by a reminder they had set — which is the
 * only mechanism Orbit shipped. The app was reproducing the stimulus that
 * worked for one person in five and none of the one that worked for three.
 *
 * So the prompt now leads with elapsed time attached to a named person, with
 * what you last said underneath, and the countdown demoted to a supporting
 * fact rather than the headline.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * 1. Vocabulary drift. Three surfaces propose a reach-out — the dashboard row,
 *    the profile strip, the draft modal — and they used to word it three ways.
 *    They now share one renderer, and these tests assert all three go through
 *    it, so a fourth variant cannot be added quietly.
 *
 * 2. Over-claiming about someone never spoken to. ORB-75 established that
 *    "overdue" is an accusation for a relationship that has not started. The
 *    same trap applies here: "You last spoke to Marcus 4 months ago" would be a
 *    lie for a contact whose date is a MEETING date, not a conversation. That
 *    case is asserted separately, both halves of it.
 *
 * 3. The escaping boundary. lastSpokeSentence returns PLAIN TEXT and is escaped
 *    by the renderer. Notes are stored as marker text and echoed here, which
 *    means other people's pasted words reach a new surface — the one place
 *    ORB-63 was careful about. Both are tested with live payloads.
 *
 * 4. ORB-79 firing when it should not. The permission line is a factual
 *    correction to a specific false belief — that a long silence makes a
 *    message less welcome. It is not general encouragement, and showing it
 *    after a fortnight would make it wallpaper.
 */
import { loadMain } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const {
  normalizeContact, getHealth, personRowHtml,
  lastSpokeSentence, lastConversationWords, reachOutPromptHtml,
  longSilenceLine, permissionLineHtml, elapsedPhrase, firstNameOf,
  LONG_SILENCE_DAYS
} = main;

const person = (over = {}) => normalizeContact({
  id: "c1", name: "Marcus Chen", role: "PM", company: "Stripe",
  dateMet: daysAgo(200), lastContacted: daysAgo(120),
  followUpFrequency: "monthly", reminderEnabled: true,
  nextReminder: daysAgo(90), interactions: [], ...over
});

/** Someone added through ORB-73: a meeting date, no conversation, no last date. */
const unspoken = (over = {}) => {
  const c = normalizeContact({
    id: "c2", name: "Priya Raman", dateMet: daysAgo(90),
    followUpFrequency: "monthly", reminderEnabled: true,
    interactions: [], ...over
  });
  c.lastContacted = over.lastContacted ?? "";
  return c;
};

const convo = (over = {}) => ({
  id: "i1", date: daysAgo(120), type: "coffee",
  title: "", notes: "Talked about her move to the payments team.", ...over
});

// ── ORB-78, the sentence ──────────────────────────────────────────────────────
group("ORB-78 — the sentence names the person and the gap");
{
  const c = person();
  const line = lastSpokeSentence(c, getHealth(c));
  eq("it is the survey's own framing", line, "You last spoke to Marcus 4 months ago.");
  ok("first name, not the database row", !/Chen/.test(line));
  ok("no schedule vocabulary", !/(days left|overdue|cadence|reminder)/i.test(line));
}
{
  const c = person({ lastContacted: today() });
  ok("today reads as a day, not a duration",
    lastSpokeSentence(c, getHealth(c)) === "You last spoke to Marcus today.");
}
{
  const c = person({ lastContacted: daysAgo(1) });
  ok("and yesterday likewise",
    lastSpokeSentence(c, getHealth(c)) === "You last spoke to Marcus yesterday.");
}
{
  const c = person({ name: "Cher" });
  ok("one-word names survive", /to Cher /.test(lastSpokeSentence(c, getHealth(c))));
  eq("and a missing name does not print 'undefined'", firstNameOf(""), "them");
}

group("ORB-78 — never spoken to is stated as a meeting, not a lapse");
{
  const c = unspoken();
  const line = lastSpokeSentence(c, getHealth(c));
  eq("the meeting is the fact we have", line, "You met Priya 3 months ago and have not spoken since.");
  ok("it never claims a conversation happened", !/last spoke/.test(line));
}
{
  const c = unspoken({ dateMet: today() });
  eq("met today does not read as a gap",
    lastSpokeSentence(c, getHealth(c)), "You met Priya today. You have not spoken yet.");
}
{
  const c = unspoken({ dateMet: "" });
  eq("with no date at all it claims nothing",
    lastSpokeSentence(c, getHealth(c)), "You have not spoken to Priya yet.");
}
{
  // ORB-64: the conversation was deleted, but the date behind it is real. This
  // is the case ORB-75 called out and it must not regress into a meeting claim.
  const c = person({ interactions: [], lastContacted: daysAgo(120) });
  ok("a deleted conversation still counts as having spoken",
    /You last spoke to Marcus/.test(lastSpokeSentence(c, getHealth(c))));
}

// ── ORB-78, their own words ───────────────────────────────────────────────────
group("ORB-78 — the last conversation in its own words");
{
  const c = person({ interactions: [convo()] });
  eq("the notes come through",
    lastConversationWords(c), "Talked about her move to the payments team.");
}
{
  const c = person({ interactions: [
    convo({ id: "old", date: daysAgo(300), notes: "First coffee." }),
    convo({ id: "new", date: daysAgo(120), notes: "Second coffee." })
  ] });
  eq("the most recent one wins", lastConversationWords(c), "Second coffee.");
}
{
  const c = person({ interactions: [convo({ notes: "**Bold** and ==highlighted==." })] });
  eq("markers are stripped, not rendered",
    lastConversationWords(c), "Bold and highlighted.");
}
{
  const c = person({ interactions: [convo({ notes: "line one\nline two" })] });
  eq("it is flattened to one line", lastConversationWords(c), "line one line two");
}
{
  const c = person({ interactions: [convo({ notes: "", title: "Coffee with Marcus" })] });
  eq("the meeting title stands in when there are no notes",
    lastConversationWords(c), "Coffee with Marcus");
}
{
  const c = person({ interactions: [convo({ notes: "x".repeat(400) })] });
  const words = lastConversationWords(c);
  ok("long notes are clipped", words.length <= 121);
  ok("and marked as clipped", words.endsWith("…"));
}
{
  eq("no conversations means no echo", lastConversationWords(person()), "");
  eq("and neither does an empty one",
    lastConversationWords(person({ interactions: [convo({ notes: "   ", title: "" })] })), "");
}

// ── ORB-78, the three surfaces ────────────────────────────────────────────────
group("ORB-78 — Reach out next asks; the directory does not");
{
  const c = person({ interactions: [convo()] });
  const prompt = personRowHtml(c, getHealth(c), { showReconnect: true, prompt: true });
  ok("the row leads with the sentence", /You last spoke to Marcus 4 months ago\./.test(prompt));
  ok("their words are underneath", /payments team/.test(prompt));
  ok("the schedule label is gone from it", !/Every month/.test(prompt));

  const row = personRowHtml(c, getHealth(c), { showReconnect: true });
  ok("the alphabetical list keeps the factual line", /Last connected/.test(row));
  ok("and keeps the cadence, which is the useful fact there", /Every month/.test(row));
  ok("without the sentence addressed to the reader", !/You last spoke/.test(row));
}
{
  // The health bar is not the prompt. It drives colour, ordering and the counts,
  // so ORB-78 must not have quietly removed the countdown with the wording.
  const c = person();
  const prompt = personRowHtml(c, getHealth(c), { showReconnect: true, prompt: true });
  ok("the status band survives", /Overdue/.test(prompt));
  ok("so does the deadline detail", /days over/.test(prompt));
}
{
  const c = unspoken();
  const prompt = personRowHtml(c, getHealth(c), { showReconnect: true, prompt: true });
  ok("a never-contacted person is still asked for", /You met Priya/.test(prompt));
  ok("and keeps ORB-75's vocabulary", /Not contacted yet/.test(prompt));
  ok("never borrowing 'overdue'", !/Overdue/.test(prompt));
}

group("ORB-78 — one renderer, so the three surfaces cannot drift");
{
  const c = person({ interactions: [convo()] });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("it emits the sentence", /class="prompt-line"/.test(html));
  ok("and the echo", /class="prompt-echo"/.test(html));
  ok("the echo is quoted", /“.*payments team.*”/.test(html));

  const bare = reachOutPromptHtml(person(), getHealth(person()));
  ok("no conversation means no empty quote marks", !/prompt-echo/.test(bare));
  ok("but the sentence is always there", /prompt-line/.test(bare));
}
{
  const c = person({ interactions: [convo()] });
  ok("the echo can be suppressed where there is no room",
    !/prompt-echo/.test(reachOutPromptHtml(c, getHealth(c), { echo: false })));
}

group("ORB-78 — escaping, on a surface other people's words now reach");
{
  const c = person({ name: '<img src=x onerror=alert(1)>' });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("no tag survives from the name", !/<img/.test(html));
  ok("it was escaped", /&lt;img/.test(html));
}
{
  const c = person({ interactions: [convo({ notes: '<script>alert(1)</script> hi' })] });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("no tag survives from pasted notes", !/<script/.test(html));
  ok("the text is still shown", /hi/.test(html));
}
{
  // The marker vocabulary must not become HTML on this surface either — the
  // echo strips marks rather than rendering them, so **x** stays literal-safe.
  const c = person({ interactions: [convo({ notes: "**<b>x</b>**" })] });
  ok("stripped marks do not open a tag", !/<b>/.test(reachOutPromptHtml(c, getHealth(c))));
}
{
  eq("the sentence itself is plain text, not half-escaped HTML",
    lastSpokeSentence(person({ name: "<b>Marcus</b> Chen" }), getHealth(person())),
    "You last spoke to <b>Marcus</b> 4 months ago.");
}

// ── ORB-79 ────────────────────────────────────────────────────────────────────
group("ORB-79 — the permission line corrects a specific false belief");
{
  const c = person({ lastContacted: daysAgo(120) });
  const line = longSilenceLine(c, getHealth(c));
  ok("it names the gap", /It has been 4 months/.test(line));
  ok("it concedes the feeling", /awkward/.test(line));
  ok("and then contradicts it", /It is not/.test(line));
  ok("with the finding, not a platitude", /underestimate/.test(line));
  ok("including the part that makes the gap an asset", /the longer the gap/.test(line));
  ok("it never apologises for the user", !/(sorry|guilt|bad)/i.test(line));
}
{
  const c = person({ lastContacted: daysAgo(LONG_SILENCE_DAYS - 1) });
  eq("a short silence gets nothing — nobody agonises over a fortnight",
    longSilenceLine(c, getHealth(c)), "");
  eq("and it renders as nothing at all", permissionLineHtml(c, getHealth(c)), "");
}
{
  const c = person({ lastContacted: daysAgo(LONG_SILENCE_DAYS) });
  ok("the threshold itself fires", longSilenceLine(c, getHealth(c)) !== "");
}
{
  const c = person({ lastContacted: today() });
  eq("someone you spoke to today gets nothing", longSilenceLine(c, getHealth(c)), "");
}
{
  // Never spoken to: the gap is measured from the meeting, which is the only
  // date there is. The correction applies just as much to a first message.
  const c = unspoken({ dateMet: daysAgo(200) });
  ok("a long-cold introduction gets it too", /It has been 7 months/.test(longSilenceLine(c, getHealth(c))));
}
{
  const c = unspoken({ dateMet: "" });
  eq("with no date there is no claim to make", longSilenceLine(c, getHealth(c)), "");
}

group("ORB-79 — the duration reads like a person wrote it");
{
  eq("days below a month", elapsedPhrase(14), "14 days");
  eq("one day is singular", elapsedPhrase(1), "1 day");
  eq("months once past thirty", elapsedPhrase(60), "2 months");
  eq("one month is singular", elapsedPhrase(30), "1 month");
  eq("years once past one", elapsedPhrase(400), "1 year");
  eq("and plural after that", elapsedPhrase(800), "2 years");
}
{
  const c = person({ lastContacted: daysAgo(120) });
  const html = permissionLineHtml(c, getHealth(c));
  ok("it is given its own surface, not set as fine print",
    /class="permission-line"/.test(html));
  ok("and it is escaped like everything else", !/<script/.test(html));
}


// ── The two surfaces that need a real DOM ─────────────────────────────────────
// Asserting reachOutPromptHtml in isolation proves the renderer, not that the
// profile and the modal call it. Both are rendered for real here, because
// "three surfaces share one renderer" is the claim actually worth guarding.
group("ORB-78 — the profile strip leads with the sentence");
{
  const { state, resetState } = await import("./helpers/load-main.mjs");
  resetState();
  const c = person({ interactions: [convo()] });
  state.store.set(c.id, c);

  globalThis.__dom.reconfigure({ url: "https://orbit.test/contact.html?id=c1" });
  const root = document.createElement("section");
  root.id = "contactPageContent";
  document.body.appendChild(root);
  await main.initContactPage();

  const said = root.querySelector(".reachout-said");
  ok("the strip has a said block", said);
  ok("with the sentence in it", /You last spoke to Marcus 4 months ago\./.test(said?.textContent || ""));
  ok("and their own words", /payments team/.test(said?.textContent || ""));
  ok("the labelled 'Last connected' field is gone",
    !/Last connected/.test(root.querySelector(".reachout-strip")?.textContent || ""));
  ok("but the deadline is kept — the sentence does not carry it",
    /Next nudge/.test(root.querySelector(".reachout-meta")?.textContent || ""));
  eq("the strip still has its three columns",
    [...root.querySelector(".reachout-strip").children]
      .map((el) => el.className).filter((n) => !n.includes("grace-note")),
    ["reachout-ring", "reachout-said", "reachout-controls"]);

  const opens = (root.innerHTML.match(/<div\b/g) || []).length;
  const closes = (root.innerHTML.match(/<\/div>/g) || []).length;
  eq("the extra wrapper did not unbalance the hero", opens, closes);
  root.remove();
}

group("ORB-78 / ORB-79 — the draft modal, which is the point of hesitation");
{
  document.getElementById("reminderModal")?.remove();
  const c = person({ interactions: [convo()] });
  await main.showReminderModal(c, async () => {});
  const modal = document.getElementById("reminderModal");
  ok("the modal opened", modal);
  const text = modal.textContent;

  ok("it leads with the person and the gap", /You last spoke to Marcus 4 months ago\./.test(text));
  ok("their words are there too", /payments team/.test(text));
  ok("the ORB-79 correction is on the same screen as the draft",
    /underestimate how welcome an out-of-the-blue message is/.test(text));
  ok("the correction has its own surface", modal.querySelector(".permission-line"));
  ok("the sentence comes before the correction",
    text.indexOf("You last spoke") < text.indexOf("It has been 4 months"));
  ok("the cadence is kept, demoted rather than deleted", /Every month/.test(text));
  ok("the draft itself is untouched", modal.querySelector(".email-draft"));
  modal.remove();
}
{
  // Same modal, someone spoken to last week. ORB-78 still applies — you still
  // want to know who and when. ORB-79 does not: there is nothing to forgive.
  document.getElementById("reminderModal")?.remove();
  await main.showReminderModal(person({ lastContacted: daysAgo(6) }), async () => {});
  const modal = document.getElementById("reminderModal");
  ok("the sentence is unconditional", /You last spoke to Marcus 6 days ago\./.test(modal.textContent));
  ok("the correction is not", !modal.querySelector(".permission-line"));
  modal.remove();
}

done();
