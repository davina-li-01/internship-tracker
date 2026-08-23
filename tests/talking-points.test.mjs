/**
 * A talking point knows where it came from, and the list has a lifecycle
 * (ORB-121, ORB-122).
 *
 * Item 21 of the 20 August session — "is this section just going to get longer
 * and longer?" — reads as a complaint about volume and is not one. It is the
 * correct observation that the list has no lifecycle. A point was created, it
 * sat on the contact, and nothing connected it to the conversation it came from
 * or the one it was for. So the list could not be short: it had no basis on
 * which to drop anything.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * Three things, and the first two are the ones that would ship looking fine.
 *
 *   - **Storing a flag instead of deriving one.** "Has been through a
 *     conversation" as a saved boolean goes stale the moment a conversation is
 *     edited or deleted under ORB-64, and nothing would error. It is a
 *     comparison here, and the deleted-conversation case is asserted.
 *   - **Counting a touchpoint as a conversation.** Pressing "Reached out" is you
 *     sending a message (ORB-96). If that retired talking points, every point
 *     would be marked carried-over by the act of following up on it.
 *   - **Grouping making a short list feel longer.** The PRD named this risk
 *     against its own solution. One group renders flat.
 */
import { loadMain, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const {
  normalizeContact, normalizeFollowUpItem, groupFollowUps, lastConversationDate,
  renderFollowUpItems, followUpOriginLabel, generateFollowUpSuggestions,
  FOLLOWUP_GROUPS, TOUCHPOINT_TYPE
} = main;

const at = (day) => day + "T09:00:00.000Z";
const point = (over = {}) => normalizeFollowUpItem({ text: "Ask about the move", ...over });
const convo = (over = {}) => ({
  id: "i1", date: daysAgo(10), type: "coffee chat", notes: "We talked", ...over
});

const person = (interactions, followUps) => normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, interactions, followUps
});

// ── The field ────────────────────────────────────────────────────────────────

group("A point records the conversation behind it, or admits there was none");
{
  eq("nothing typed on the profile came from a conversation",
    point().sourceInteractionId, "");
  eq("and a suggestion can say which one it came from",
    point({ sourceInteractionId: "i7" }).sourceInteractionId, "i7");
  // No migration: follow_ups is jsonb, so items saved before this ticket simply
  // read "" rather than undefined.
  eq("an item written before the field existed normalises to empty",
    normalizeFollowUpItem({ text: "old", createdAt: at(daysAgo(90)) }).sourceInteractionId, "");
}
{
  const c = person([convo({ id: "i1", notes: "She mentioned she is interviewing at Stripe" })], []);
  const suggestions = generateFollowUpSuggestions(c);
  ok("Suggest returns points, not bare strings", typeof suggestions[0] === "object");
  eq("and each one carries the conversation it was lifted from",
    suggestions[0].sourceInteractionId, "i1");
}
{
  // Sentences taken from the contact's own notes have no conversation behind
  // them. Claiming one would be an invented fact about where a point came from.
  const c = person([], []);
  c.notes = "He is thinking about moving into product management next year";
  eq("a point from the contact's notes claims no conversation",
    generateFollowUpSuggestions(c)[0].sourceInteractionId, "");
}
{
  const c = person([], []);
  eq("and the nothing-to-say fallback is the same shape",
    generateFollowUpSuggestions(c)[0].sourceInteractionId, "");
  ok("with real text", generateFollowUpSuggestions(c)[0].text.length > 0);
}

// ── The pivot ────────────────────────────────────────────────────────────────

group("Only a conversation retires a talking point, never a reach-out");
{
  const c = person([convo({ date: daysAgo(20) })], []);
  eq("the pivot is the last real conversation", lastConversationDate(c), daysAgo(20));
}
{
  // ORB-96. Pressing "Reached out" logs a touchpoint, not a conversation. If it
  // counted here, following up on a point would mark that point as having had
  // its chance — the app retiring an intention because you acted on it.
  const c = person([
    { id: "t1", date: today(), type: TOUCHPOINT_TYPE },
    convo({ id: "i1", date: daysAgo(20) })
  ], []);
  eq("a touchpoint today does not move the pivot",
    lastConversationDate(c), daysAgo(20));
}
{
  eq("no conversations means no pivot at all", lastConversationDate(person([], [])), "");
}

// ── The groups ───────────────────────────────────────────────────────────────

group("The list is a filter, not an archive");
{
  const c = person([convo({ date: daysAgo(10) })], [
    point({ id: "a", text: "New thought", createdAt: at(daysAgo(2)) }),
    point({ id: "b", text: "Asked before the coffee", createdAt: at(daysAgo(30)) }),
    point({ id: "c", text: "Done with", createdAt: at(daysAgo(40)), completed: true })
  ]);
  const g = groupFollowUps(c);
  eq("raised since the last conversation", g.since.map((f) => f.id).join(), "a");
  eq("carried over from before it", g.carried.map((f) => f.id).join(), "b");
  eq("and ticked", g.ticked.map((f) => f.id).join(), "c");
}
{
  // A ticked point stays ticked whichever side of the conversation it fell.
  const c = person([convo({ date: daysAgo(10) })], [
    point({ id: "a", createdAt: at(daysAgo(2)), completed: true }),
    point({ id: "b", createdAt: at(daysAgo(30)), completed: true })
  ]);
  eq("completion outranks timing", groupFollowUps(c).ticked.length, 2);
  eq("and nothing leaks into the other groups",
    groupFollowUps(c).since.length + groupFollowUps(c).carried.length, 0);
}
{
  // createdAt is a timestamp and an interaction date is a day, so a point raised
  // on the day of a conversation cannot be ordered against it. It stays visible.
  const c = person([convo({ date: daysAgo(3) })], [point({ createdAt: at(daysAgo(3)) })]);
  eq("same-day is still to come, not carried over", groupFollowUps(c).since.length, 1);
}
{
  const c = person([], [
    point({ id: "a", createdAt: at(daysAgo(200)) }),
    point({ id: "b", createdAt: at(today()) })
  ]);
  eq("with no conversation ever, nothing has had its chance",
    groupFollowUps(c).since.length, 2);
  eq("however old it is", groupFollowUps(c).carried.length, 0);
}
{
  const c = person([convo()], [
    point({ id: "old", createdAt: at(daysAgo(40)) }),
    point({ id: "new", createdAt: at(daysAgo(1)) })
  ]);
  eq("newest first inside a group",
    groupFollowUps(c).since.concat(groupFollowUps(c).carried).map((f) => f.id).join(),
    "new,old");
}

// ── The render ───────────────────────────────────────────────────────────────

group("Headings appear only when there is something to separate");
{
  const c = person([convo({ date: daysAgo(10) })], [
    point({ id: "a", text: "Since", createdAt: at(daysAgo(2)) }),
    point({ id: "b", text: "Before", createdAt: at(daysAgo(30)) })
  ]);
  const html = renderFollowUpItems(c);
  ok("two groups get their headings", /followup-group/.test(html));
  ok("named for what they are",
    html.includes(FOLLOWUP_GROUPS[0].label) && html.includes(FOLLOWUP_GROUPS[1].label));
  ok("and the empty third group is not announced",
    !html.includes(FOLLOWUP_GROUPS[2].label));
}
{
  // The PRD's own risk, against its own solution: three headings over four items
  // is furniture. A single group renders exactly as it did before this ticket.
  const c = person([], [point({ id: "a" }), point({ id: "b" })]);
  const html = renderFollowUpItems(c);
  ok("one group means no headings at all", !/followup-group/.test(html));
  eq("and both points are still there", (html.match(/followup-item/g) || []).length, 2);
}
{
  eq("an empty list still says so, and says what to do",
    /No talking points yet/.test(renderFollowUpItems(person([], []))), true);
}
{
  const c = person([convo({ date: daysAgo(10) })], [
    point({ id: "a", createdAt: at(daysAgo(2)) }),
    point({ id: "b", createdAt: at(daysAgo(30)) })
  ]);
  const html = renderFollowUpItems(c);
  const since = html.indexOf(FOLLOWUP_GROUPS[0].label);
  const carried = html.indexOf(FOLLOWUP_GROUPS[1].label);
  ok("what is still to raise comes before what carried over", since < carried);
}

// ── Provenance on screen ─────────────────────────────────────────────────────

group("Where it came from survives the conversation being deleted");
{
  const c = person([convo({ id: "i1", date: daysAgo(6) })], []);
  eq("a point from a conversation says when that was",
    followUpOriginLabel(point({ sourceInteractionId: "i1" }), c), "from 6 days ago");
  eq("a point from nowhere says nothing",
    followUpOriginLabel(point(), c), "");
}
{
  // ORB-64 lets a conversation be deleted, which leaves the id dangling. "From a
  // conversation that is no longer here" is worse than silence, and a stored
  // label would have frozen the deleted date on screen forever.
  const c = person([convo({ id: "other" })], []);
  eq("a dangling id renders nothing rather than a broken reference",
    followUpOriginLabel(point({ sourceInteractionId: "i1" }), c), "");
}
{
  const c = person([convo({ id: "i1", date: daysAgo(6) })],
    [point({ id: "a", sourceInteractionId: "i1", createdAt: at(daysAgo(1)) })]);
  ok("and it reaches the rendered row",
    /followup-origin/.test(renderFollowUpItems(c)));
}

done();
