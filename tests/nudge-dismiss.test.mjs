/**
 * Dismissing has to dismiss the person, not the box (ORB-126).
 *
 * REPORTED, IN HER WORDS: "It keeps saying say thank you to Hunter. I already
 * sent the thank you message. I want to keep dismissing it, but it keeps
 * popping up."
 *
 * Two causes, and only one of them was a defect.
 *
 *   1. The thank-you was a capture, and a capture stays open until something
 *      closes it. `markReachedOut` does close it — but the message was sent
 *      from her own email, so the app never heard. **That is not a bug and it
 *      cannot be fixed by trying harder to notice.** The app cannot see outside
 *      itself, and the answer is to make being wrong cheap rather than to nag
 *      until it is right.
 *   2. The ✕ called a function that removed a DOM node and recorded nothing.
 *      The same person came back the next morning with the same sentence, for
 *      ever. Dismissal cost nothing and bought nothing.
 *
 * WHAT THIS SUITE GUARDS
 *
 * That dismissing one person does not turn the whole feature off — the nudge
 * moves to the next person tomorrow — and that the snoozed person stays on the
 * dashboard the entire time. Quieter is not hidden. That is the ORB-64 rule,
 * and it is the difference between this and a mute button.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo, daysAhead } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  normalizeContact, needsAttention, snoozeNudge, clearNudgeSnooze, nudgeSnoozed,
  readNudgeSnoozes, showReachOutNudge, checkRemindersOnLoad, markReachedOut,
  NUDGE_SNOOZE_DAYS, NUDGE_SNOOZE_KEY, getHealth
} = main;

const click = (el) => el.dispatchEvent(
  new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const lapsed = (over = {}) => normalizeContact({
  id: "c1", name: "Hunter Rapoza", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(200), nextReminder: daysAgo(60),
  interactions: [{ id: "i1", date: daysAgo(200), type: "coffee chat", notes: "x" }],
  ...over
});

const clearStorage = () => localStorage.removeItem(NUDGE_SNOOZE_KEY);

// ── The store ────────────────────────────────────────────────────────────────

group("Not now is written down");
{
  clearStorage();
  eq("nobody is snoozed to begin with", nudgeSnoozed("c1"), false);
  const until = snoozeNudge("c1");
  eq("dismissing books it a month out", until, daysAhead(NUDGE_SNOOZE_DAYS));
  eq("and the person is snoozed", nudgeSnoozed("c1"), true);
  eq("but only that person", nudgeSnoozed("c2"), false);
}
{
  clearStorage();
  snoozeNudge("c1", 1);
  eq("a snooze that has not expired holds", nudgeSnoozed("c1"), true);
  // Yesterday's snooze is over. Written directly, because the alternative is a
  // test that waits a day.
  localStorage.setItem(NUDGE_SNOOZE_KEY, JSON.stringify({ c1: daysAgo(1) }));
  eq("one that has expired does not", nudgeSnoozed("c1"), false);
  eq("and today's own date is already past", nudgeSnoozed("c9"), false);
}
{
  // The map must not grow for ever, so every write drops what has expired.
  localStorage.setItem(NUDGE_SNOOZE_KEY, JSON.stringify({
    old1: daysAgo(40), old2: daysAgo(1), live: daysAhead(5)
  }));
  snoozeNudge("fresh");
  const map = readNudgeSnoozes();
  eq("expired entries are swept on write",
    Object.keys(map).sort().join(","), "fresh,live");
}
{
  localStorage.setItem(NUDGE_SNOOZE_KEY, "not json at all");
  eq("a corrupted value does not take the nudge down", nudgeSnoozed("c1"), false);
  eq("and reads as empty", Object.keys(readNudgeSnoozes()).length, 0);
  localStorage.setItem(NUDGE_SNOOZE_KEY, JSON.stringify(["an", "array"]));
  eq("nor does the wrong shape", Object.keys(readNudgeSnoozes()).length, 0);
  clearStorage();
}

// ── The button ───────────────────────────────────────────────────────────────

group("The ✕ books the snooze and says so");
{
  clearStorage();
  resetState();
  const c = lapsed();
  const host = showReachOutNudge(c, getHealth(c));
  click(host.querySelector("[data-nudge-dismiss]"));
  await tick();

  eq("the box goes", document.querySelector(".nudge"), null);
  eq("and the person is snoozed", nudgeSnoozed("c1"), true);
  // The previous ✕ did nothing, so there is a habit to correct: a dismissal
  // that silently changes behaviour for a month is its own surprise.
  const toast = document.querySelector(".toast")?.textContent || "";
  ok("the change is said out loud", /Not for a while/.test(toast));
  ok("and it promises they are not gone", /dashboard/.test(toast));
}

group("Reaching out is a fresh start");
{
  clearStorage();
  resetState();
  const c = lapsed();
  state.store.set(c.id, c);
  snoozeNudge("c1");
  await markReachedOut(c, async () => {});
  eq("the snooze does not outlive the reason for it", nudgeSnoozed("c1"), false);
}
{
  // ORB-122's secondary KPI. Closing a capture from the reach-out button is
  // still a tick, and an undated one is invisible to the measure.
  clearStorage();
  resetState();
  const c = lapsed({
    followUps: [{ id: "f1", text: "Say thank you to Hunter", source: "capture", completed: false }]
  });
  state.store.set(c.id, c);
  await markReachedOut(c, async () => {});
  const saved = state.store.get("c1").followUps[0];
  eq("the capture closes", saved.completed, true);
  eq("and the tick is dated", main.localDayOf(saved.completedAt), today());
}

// ── The whole feature does not switch off ────────────────────────────────────

group("Dismissing one person is not a request to hear nothing");
{
  clearStorage();
  resetState();
  localStorage.removeItem("orbit_nudge_last");
  document.querySelector(".nudge-slot")?.remove();
  document.body.innerHTML = "";

  const first = lapsed({ id: "c1", name: "Hunter Rapoza", nextReminder: daysAgo(90) });
  const second = lapsed({ id: "c2", name: "Chris Rule", nextReminder: daysAgo(30) });
  state.store.set(first.id, first);
  state.store.set(second.id, second);

  eq("Hunter would be first", needsAttention([first, second])[0].contact.id, "c1");
  snoozeNudge("c1");

  await checkRemindersOnLoad();
  await wait(1000);
  const shown = document.querySelector(".nudge");
  ok("so the nudge still appears", Boolean(shown));
  ok("about the next person instead", /Chris/.test(shown.textContent));
  ok("and not about the one waved away", !/Hunter/.test(shown.textContent));
  document.querySelector(".nudge-slot")?.remove();
}
{
  // The point of the whole ticket: quieter, not hidden. A snoozed person is
  // still on the dashboard, still counted, still reachable.
  clearStorage();
  const c = lapsed();
  snoozeNudge("c1");
  eq("a snoozed person is still on Reach out next", needsAttention([c]).length, 1);
  eq("and still carries their real status", getHealth(c).band, "critical");
  clearStorage();
}

done();
