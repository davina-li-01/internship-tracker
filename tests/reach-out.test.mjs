/**
 * ORB-13 / ORB-14 logic tests.
 *
 * js/main.js imports js/db.js -> js/supabase.js, which fetches the client from a
 * CDN and cannot be imported in node. So the module is loaded with those two
 * import specifiers rewritten to local stubs, which lets the REAL markReachedOut,
 * showToast, personRowHtml and wirePersonRows run against a fake database.
 * Nothing is copy-pasted, so these cannot drift from the source.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
const __t = await loadMain();

// ── helpers ───────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond) => eq(name, Boolean(cond), true);
const toast = () => document.querySelector(".toast");
const clearToasts = () => document.querySelectorAll(".toast-stack").forEach(n => n.remove());

const person = (over = {}) => __t.normalizeContact({
  id: "c1", name: "Marcus Chen", role: "PM", company: "Stripe",
  dateMet: "2026-01-10", lastContacted: "2026-06-01",
  followUpFrequency: "monthly", reminderEnabled: true,
  nextReminder: "2026-07-01", interactions: [], ...over
});

// ── ORB-13 ────────────────────────────────────────────────────────────────────
console.log("\nORB-13 — one-click reached out");
{
  clearToasts(); resetState(); state.failSave = false;
  const c = person(); state.store.set(c.id, c);
  let renders = 0;
  const result = await __t.markReachedOut(c, async () => { renders++; });

  eq("returns true on success", result, true);
  eq("re-renders the page once", renders, 1);
  eq("lastContacted moves to today", state.store.get("c1").lastContacted, __t.todayDateString());
  eq("deadline rolls forward on the cadence",
     state.store.get("c1").nextReminder,
     __t.calculateNextReminder(__t.todayDateString(), "monthly"));
  ok("the person is now in touch", __t.getHealth(state.store.get("c1")).band === "good");
  ok("confirmation names the person", toast()?.textContent.includes("Marcus Chen"));
  ok("confirmation offers undo", toast()?.querySelector(".toast-action")?.textContent === "Undo");
  // Was "no notes were invented … length, 0". ORB-96 records the reach-out as a
  // TOUCHPOINT: pressing the button is something you did, and leaving it
  // unrecorded made `interactions` mean "times you wrote something down" while
  // every surface read it as "times you were in touch". The no-notes half of
  // the original assertion is the part that mattered and it is kept.
  eq("the reach-out is recorded", state.store.get("c1").interactions.length, 1);
  eq("as a touchpoint, not a conversation",
     state.store.get("c1").interactions[0].type, "reached out");
  eq("still with no notes invented", state.store.get("c1").interactions[0].notes, "");
  eq("and it does not count as a conversation",
     __t.relationshipLedger(state.store.get("c1")).count, 0);
}

console.log("\nORB-13 — undo");
{
  clearToasts(); resetState();
  const before = person();
  state.store.set(before.id, before);
  await __t.markReachedOut(before, async () => {});
  const rolled = { ...state.store.get("c1") };
  toast().querySelector(".toast-action").click();
  await new Promise(r => setTimeout(r, 20));

  eq("lastContacted is restored", state.store.get("c1").lastContacted, "2026-06-01");
  eq("deadline is restored", state.store.get("c1").nextReminder, "2026-07-01");
  ok("undo actually changed something", rolled.lastContacted !== state.store.get("c1").lastContacted);
  eq("the toast is dismissed after undo", toast(), null);
  ok("the person is overdue again", __t.getHealth(state.store.get("c1")).band === "critical");
}

console.log("\nORB-13 — a failed save must not look like success");
{
  clearToasts(); resetState(); state.failSave = true;
  const c = person(); state.store.set(c.id, c);
  let renders = 0;
  const result = await __t.markReachedOut(c, async () => { renders++; });

  eq("returns false", result, false);
  eq("does not re-render", renders, 0);
  ok("says it could not save", toast()?.textContent.includes("Could not save"));
  ok("offers no undo for a thing that did not happen", !toast()?.querySelector(".toast-action"));
  eq("the contact is untouched", state.store.get("c1").lastContacted, "2026-06-01");
  state.failSave = false;
}

console.log("\nORB-13 — the row markup");
{
  const c = person();
  const html = __t.personRowHtml(c, __t.getHealth(c), { showReconnect: true });
  ok("primary action is past tense", html.includes("✓ Reached out"));
  ok("the future-tense label is gone", !/>Reach out</.test(html));
  ok("the modal is still reachable", html.includes('data-remind-contact="c1"'));
  ok("one-click action is wired", html.includes('data-did-reach-out="c1"'));

  const unscheduled = person({ followUpFrequency: "none", reminderEnabled: false });
  const html2 = __t.personRowHtml(unscheduled, __t.getHealth(unscheduled), { showReconnect: true });
  ok("no actions without a cadence", !html2.includes("data-did-reach-out"));
}

console.log("\nORB-13 — clicking the row button end to end");
{
  clearToasts(); state.store.clear();
  const c = person(); state.store.set(c.id, c);
  const root = document.getElementById("root");
  let renders = 0;
  root.innerHTML = "<ul>" + __t.personRowHtml(c, __t.getHealth(c), { showReconnect: true }) + "</ul>";
  __t.wirePersonRows(root, [c], async () => { renders++; root.innerHTML = "<ul>re-rendered</ul>"; });

  root.querySelector("[data-did-reach-out]").click();
  await new Promise(r => setTimeout(r, 20));
  eq("one click is enough — no modal opened", document.querySelector("#reminderModal"), null);
  eq("the page re-rendered", renders, 1);
  ok("the toast survives the re-render", toast() !== null);
  eq("the cadence rolled forward", state.store.get("c1").lastContacted, __t.todayDateString());
}

// ── ORB-14 ────────────────────────────────────────────────────────────────────
console.log("\nORB-14 — the confirmation outlives its modal");
{
  clearToasts();
  const t = __t.showToast("Conversation added to Marcus Chen.", {
    actionLabel: "View in log", href: "network.html", duration: 7000
  });
  // Simulate the modal being torn down, which is what used to destroy the message.
  document.getElementById("root").innerHTML = "";
  ok("confirmation still on screen", toast() !== null);
  ok("it names the person", toast().textContent.includes("Marcus Chen"));
  const action = toast().querySelector(".toast-action");
  eq("the action is a link, not a button", action.tagName, "A");
  eq("it points at the page that shows conversations", action.getAttribute("href"), "network.html");
  t.dismiss();
  eq("dismiss removes it", toast(), null);
  eq("and cleans up the stack", document.querySelector(".toast-stack"), null);
}

console.log("\nToast hygiene");
{
  clearToasts();
  __t.showToast("first");
  __t.showToast("second");
  eq("only the newest is shown", document.querySelectorAll(".toast").length, 1);
  eq("and it is the newest", document.querySelector(".toast-text").textContent, "second");
  const stack = document.querySelector(".toast-stack");
  eq("announced politely", stack.getAttribute("aria-live"), "polite");
  eq("as a status region", stack.getAttribute("role"), "status");
  __t.showToast('<img src=x onerror="alert(1)">');
  ok("message text is escaped", !document.querySelector(".toast-text").innerHTML.includes("<img"));
  clearToasts();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
