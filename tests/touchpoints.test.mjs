/**
 * A reach-out is a touchpoint (ORB-96), and the echo dates itself (ORB-97).
 *
 * WHY
 *
 * `markReachedOut` moved `lastContacted` and nothing else. So pressing the
 * button — the core loop, the thing ORB-13 spent a week reducing to one click —
 * left the app believing you had never spoken to that person.
 *
 * That made `interactions` mean **"times you wrote something down"** while every
 * surface read it as **"times you were in touch"**. ORB-80's ledger worst of
 * all: it exists to show what has accumulated with someone, at the moment you
 * might abandon them, and it was counting a fraction of it.
 *
 * THIS IS NOT THE MISTAKE ORB-73 FIXED
 *
 * That bug fabricated a conversation you never had, on a day you merely added
 * someone. This records something you actually did — you said so by pressing
 * the button. It carries no notes and never will, which is what keeps the two
 * apart, and it is asserted below rather than assumed.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * 1. **A touchpoint passing as a conversation.** It must not be quotable, must
 *    not appear in the type picker, and must not inflate the conversation
 *    count — the number ORB-80 uses to argue the relationship is worth keeping.
 *
 * 2. **The just-met trigger eating itself.** ORB-91 fires on "a conversation in
 *    the last four days with no reach-out since". A touchpoint IS the reach-out,
 *    so counting it would fire "you spoke to Marcus today, a note now lands
 *    better" the instant you pressed the button saying you had sent one.
 *
 * 3. **ORB-97: the prompt contradicting itself.** The sentence comes from
 *    `lastContacted`; the quote is the most recent thing you WROTE. They diverge
 *    the moment the button is used, and the prompt read "You last spoke to
 *    Marcus 3 days ago" above words from eight months earlier, presented as
 *    what you last said.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const {
  normalizeContact, markReachedOut, relationshipLedger, ledgerLine,
  conversationsOf, isTouchpoint, TOUCHPOINT_TYPE, INTERACTION_TYPES,
  reachOutPromptHtml, lastConversationWords, lastConversationEntry,
  justMetTrigger, getHealth, todayDateString, conversationPreview
} = main;

const person = (over = {}) => normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(200), interactions: [], ...over
});

const convo = (n, over = {}) => ({
  id: "i" + n, date: daysAgo(n), type: "coffee",
  notes: "Talked about her move to the payments team.", ...over
});

const touch = (n) => ({ id: "t" + n, date: daysAgo(n), type: TOUCHPOINT_TYPE, notes: "" });

const tick = () => new Promise((r) => setTimeout(r, 20));

// ── ORB-96 ────────────────────────────────────────────────────────────────────
group("Pressing the button records that you did");
{
  resetState();
  const c = person();
  state.store.set(c.id, c);
  await markReachedOut(c, async () => {});
  const after = state.store.get("c1");
  eq("one entry now exists where there were none", after.interactions.length, 1);
  eq("dated today", after.interactions[0].date, todayDateString());
  eq("typed as a touchpoint", after.interactions[0].type, TOUCHPOINT_TYPE);
  eq("with no notes invented for you", after.interactions[0].notes, "");
  eq("and no title either", after.interactions[0].title, "");
}
{
  resetState();
  const c = person({ interactions: [convo(200)] });
  state.store.set(c.id, c);
  await markReachedOut(c, async () => {});
  const after = state.store.get("c1");
  eq("existing history is kept", after.interactions.length, 2);
  ok("and the new touchpoint is the most recent",
    isTouchpoint(after.interactions[0]));
}
{
  resetState();
  const c = person({ interactions: [convo(200)] });
  state.store.set(c.id, c);
  await markReachedOut(c, async () => {});
  document.querySelector(".toast .toast-action").click();
  await tick();
  const after = state.store.get("c1");
  eq("Undo removes the touchpoint too", after.interactions.length, 1);
  ok("leaving the real conversation", !isTouchpoint(after.interactions[0]));
}

group("It is not a conversation, anywhere that counts them");
{
  ok("it is not offered in the type picker", !INTERACTION_TYPES.includes(TOUCHPOINT_TYPE));
}
{
  const c = person({ interactions: [convo(200), touch(1), touch(30)] });
  eq("conversationsOf skips it", conversationsOf(c).length, 1);
  const l = relationshipLedger(c);
  eq("the ledger counts one conversation", l.count, 1);
  eq("and two reach-outs, separately", l.touchpoints, 2);
  eq("stated as two different claims",
    ledgerLine(c), "1 conversation over 7 months · 2 reach-outs");
}
{
  const c = person({ interactions: [touch(1), touch(200)] });
  eq("reach-outs alone still say something — this is the undercount, fixed",
    ledgerLine(c), "2 reach-outs over 7 months");
  eq("with nothing claimed about conversations", relationshipLedger(c).count, 0);
}
{
  const c = person({ interactions: [convo(10), touch(1)] });
  eq("the span is stated once, on the first thing named",
    ledgerLine(c), "1 conversation over 9 days · 1 reach-out");
}
{
  const c = person({ interactions: [touch(1)] });
  eq("a touchpoint is never quotable", lastConversationWords(c), "");
  ok("so the prompt shows no echo for it", !/prompt-echo/.test(reachOutPromptHtml(c, getHealth(c))));
  ok("but the reach-out is still counted on screen", /1 reach-out/.test(reachOutPromptHtml(c, getHealth(c))));
}
{
  const c = person({ interactions: [convo(200), touch(1)] });
  ok("the preview quotes the conversation, not the button press",
    /payments team/.test(conversationPreview(c)));
  ok("and counts only the conversation", /1 conversation\b/.test(conversationPreview(c)));
}

group("The just-met trigger does not fire on your own reach-out");
{
  // The failure this prevents: press the button, and the app immediately tells
  // you to follow up on the conversation it thinks you just had.
  const c = person({ interactions: [touch(0)], lastContacted: todayDateString() });
  eq("a touchpoint today is not a conversation today", justMetTrigger(c), null);
}
{
  const c = person({ interactions: [convo(2)], lastContacted: daysAgo(2) });
  ok("a real conversation still fires it", justMetTrigger(c));
}
{
  const c = person({ interactions: [convo(2), touch(0)], lastContacted: todayDateString() });
  eq("and reaching out after one clears it, which is the point",
    justMetTrigger(c), null);
}

// ── ORB-97 ────────────────────────────────────────────────────────────────────
group("The echo dates itself when it disagrees with the sentence above it");
{
  // Exactly the case ORB-96 creates: you reached out three days ago by button,
  // and the last thing you WROTE is from eight months back.
  const c = person({ interactions: [convo(240), touch(3)], lastContacted: daysAgo(3) });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("the sentence uses the reach-out", /You last spoke to Marcus 3 days ago/.test(html));
  ok("the quote is still shown — an old note is the best thing here for remembering someone",
    /payments team/.test(html));
  ok("but it says when it is from", /prompt-echo-when/.test(html));
  ok("in words", /8 months ago/.test(html));
}
{
  const c = person({ interactions: [convo(200)], lastContacted: daysAgo(200) });
  const html = reachOutPromptHtml(c, getHealth(c));
  ok("when they agree, the quote is left alone", !/prompt-echo-when/.test(html));
  ok("and is still there", /payments team/.test(html));
}
{
  const c = person({ interactions: [convo(200)], lastContacted: "" });
  ok("no last-contacted date means nothing to disagree with",
    !/prompt-echo-when/.test(reachOutPromptHtml(c, getHealth(c))));
}
{
  const e = lastConversationEntry(person({ interactions: [convo(200)] }));
  eq("the entry carries its date so callers need not re-derive it", e.date, daysAgo(200));
  eq("and its text", e.text, "Talked about her move to the payments team.");
  eq("nothing written means no entry at all", lastConversationEntry(person()), null);
  eq("and neither does a touchpoint", lastConversationEntry(person({ interactions: [touch(1)] })), null);
}

done();
