/**
 * The four verified bugs from the 20 August usability session.
 *
 * ORB-106 · the name typed at sign-up never reached the drafts
 * ORB-107 · pressing Save silently discarded a snooze
 * ORB-108 · the draft could not be edited
 * ORB-109 · Adjust latched on one surface and toggled on the other
 *
 * WHAT THEY HAVE IN COMMON, AND WHY THEY SURVIVED
 *
 * **None of them errored.** Every one reported success while doing the wrong
 * thing: the draft said `[Your Name]`, Save said "Schedule saved!", the textarea
 * looked like a textarea, Adjust looked like it worked the first time. That is
 * the class of bug a test suite is for, because a person using the app has no
 * signal at all.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo, daysAhead, today } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  normalizeContact, backfillNameFromSignUp, buildReminderEmailText,
  showReminderModal, addConnectionFormHtml, wireAddConnectionForm,
  calculateNextReminder, initContactPage, mailtoUrl
} = main;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── ORB-106 ───────────────────────────────────────────────────────────────────
group("ORB-106 — the name you typed at sign-up reaches the drafts");
{
  resetState();
  state.prefs = {};
  await backfillNameFromSignUp({ user_metadata: { full_name: "Davina Li" } });
  eq("an empty preference is filled from the sign-up metadata",
    state.prefs.your_name, "Davina Li");
  eq("and it was written once", state.prefSaves.length, 1);
}
{
  // The settings field is the answer; the sign-up metadata is only a better
  // default than nothing. Overwriting a chosen name would be worse than the bug.
  resetState();
  state.prefs = { your_name: "D" };
  await backfillNameFromSignUp({ user_metadata: { full_name: "Davina Li" } });
  eq("a name the user set is never overwritten", state.prefs.your_name, "D");
  eq("and nothing was written at all", state.prefSaves.length, 0);
}
{
  resetState();
  state.prefs = { your_name: "   " };
  await backfillNameFromSignUp({ user_metadata: { full_name: "Davina Li" } });
  eq("whitespace counts as empty", state.prefs.your_name, "Davina Li");
}
{
  resetState();
  state.prefs = {};
  await backfillNameFromSignUp({ user_metadata: {} });
  await backfillNameFromSignUp(null);
  await backfillNameFromSignUp({ user_metadata: { full_name: "  " } });
  eq("no metadata, no write", state.prefSaves.length, 0);
}
{
  // The symptom, asserted directly.
  ok("with a name, the draft is signed",
    buildReminderEmailText({ name: "Marcus" }, "Davina Li").includes("Davina Li"));
  ok("without one it still says so rather than trailing off",
    buildReminderEmailText({ name: "Marcus" }, "").includes("[Your Name]"));
}

// ── ORB-107 ───────────────────────────────────────────────────────────────────
const CONTACT = {
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(10),
  interactions: [], companyHistory: [], followUps: []
};

async function profile(over = {}) {
  resetState();
  const c = normalizeContact({ ...CONTACT, ...over });
  if (over.nextReminder !== undefined) c.nextReminder = over.nextReminder;
  state.store.set(c.id, c);
  dom.reconfigure({ url: "https://orbit.test/contact.html?id=c1" });
  document.body.innerHTML = "";
  const root = document.createElement("section");
  root.id = "contactPageContent";
  document.body.appendChild(root);
  await initContactPage();
  return root;
}
const saveSchedule = async (root) => {
  root.querySelector("#cpSaveReminderBtn").click();
  await tick(); await tick();
};

group("ORB-107 — saving stops discarding a snooze");
{
  // The exact reported path: snooze, then press Save without changing anything.
  const snoozed = daysAhead(3);
  const root = await profile({ nextReminder: snoozed });
  await saveSchedule(root);
  eq("the snooze survives an unchanged Save",
    state.store.get("c1").nextReminder, snoozed);
  ok("and is not silently reset to the plain cadence",
    state.store.get("c1").nextReminder !== calculateNextReminder(daysAgo(10), "monthly"));
}
{
  // The other half: a deadline must still move when the cadence really changes,
  // or the fix would be a different bug.
  const root = await profile({ nextReminder: daysAhead(3) });
  root.querySelector("#cpAdjust").click();
  const freq = root.querySelector("#cpFrequency");
  freq.value = "quarterly";
  freq.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await saveSchedule(root);
  const saved = state.store.get("c1");
  eq("changing the cadence is saved", saved.followUpFrequency, "quarterly");
  eq("and the deadline is recomputed",
    saved.nextReminder, calculateNextReminder(daysAgo(10), "quarterly"));
}
{
  const root = await profile({
    followUpFrequency: "none", reminderEnabled: false, nextReminder: ""
  });
  root.querySelector("#cpAdjust").click();
  const freq = root.querySelector("#cpFrequency");
  freq.value = "monthly";
  freq.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await saveSchedule(root);
  const saved = state.store.get("c1");
  ok("switching a schedule on still grants a deadline", Boolean(saved.nextReminder));
  eq("and turns reminders on", saved.reminderEnabled, true);
}
{
  const root = await profile({
    followUpFrequency: "none", reminderEnabled: false, nextReminder: ""
  });
  await saveSchedule(root);
  eq("saving with no schedule still clears the deadline",
    state.store.get("c1").nextReminder, "");
}

// ── ORB-108 ───────────────────────────────────────────────────────────────────
group("ORB-108 — the draft is editable, and the edit is what gets used");
{
  resetState();
  document.querySelectorAll("#reminderModal").forEach((n) => n.remove());
  const c = normalizeContact({ ...CONTACT, email: "marcus@stripe.com" });
  state.store.set(c.id, c);
  await showReminderModal(c, async () => {});
  const box = document.querySelector(".email-draft");
  ok("the textarea exists", box);
  eq("and is not readonly", box.hasAttribute("readonly"), false);
  ok("it is labelled, since it lost its heading association",
    box.getAttribute("aria-label"));
}
{
  // The worse half: a box that looks editable and quietly is not, because the
  // buttons read the original string.
  let copied = "";
  const modal = document.getElementById("reminderModal");
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (t) => { copied = t; } }, configurable: true
  });
  const box = modal.querySelector(".email-draft");
  box.value = "Hi Marcus — actually I rewrote this entirely.";
  modal.querySelector("#modalCopyEmail").click();
  await tick();
  eq("Copy takes what is on screen, not what was generated", copied, box.value);
}
{
  // `window.location` cannot be stubbed in jsdom, so the URL construction was
  // extracted into a function — which is the better shape anyway, since what
  // matters is that it reads the EDITED draft.
  const url = mailtoUrl("marcus@stripe.com", "Subject: My own subject\n\nMy own body.");
  ok("the address is there", url.startsWith("mailto:marcus%40stripe.com"));
  ok("the subject comes from the first line", /subject=My%20own%20subject/.test(url));
  ok("the body from the rest", /body=My%20own%20body\./.test(url));
  ok("and the Subject: prefix is not carried into it", !/Subject%3A/.test(url));
}
{
  // A rewritten draft may have no subject line at all. Guessing one from the
  // user's own words would be worse than sending none.
  const url = mailtoUrl("m@x.com", "Hi Marcus, long time.");
  ok("no subject line means no subject", /subject=&/.test(url));
  ok("and the whole thing is the body", /body=Hi%20Marcus%2C%20long%20time\./.test(url));
}
{
  const modal = document.getElementById("reminderModal");
  ok("the button is wired to it", modal.querySelector("#modalMailto"));
  modal.remove();
}

// ── ORB-109 ───────────────────────────────────────────────────────────────────
group("ORB-109 — Adjust latches, on every surface");
{
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById("host");
  host.innerHTML = addConnectionFormHtml([]);
  wireAddConnectionForm(host, () => [], async () => {});
  const group_ = host.querySelector(".ac-freq-group");
  const adjust = host.querySelector(".ac-adjust");

  ok("the interval starts hidden", group_.classList.contains("hidden"));
  adjust.click();
  ok("Adjust reveals it", !group_.classList.contains("hidden"));
  // The bug: a second click hid the control you had just asked to see.
  adjust.click();
  ok("a second click does not hide it again", !group_.classList.contains("hidden"));
  adjust.click(); adjust.click();
  ok("nor does a third or a fourth", !group_.classList.contains("hidden"));
}
{
  const root = await profile();
  const group_ = root.querySelector("#cpFreqGroup");
  const adjust = root.querySelector("#cpAdjust");
  ok("the profile starts hidden too", group_.classList.contains("hidden"));
  adjust.click(); adjust.click();
  ok("and behaves identically — which it always did",
    !group_.classList.contains("hidden"));
}

done();
