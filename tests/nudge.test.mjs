/**
 * The nudge on open answers in one click (ORB-58, closing ORB-13).
 *
 * WHY
 *
 * ORB-13 asked why recording a reach-out took two clicks and a modal: you
 * pressed **Reach out** — a future-tense label — to report something you had
 * already done, then pressed "I reached out" inside a dialog.
 *
 * The dashboard, My Network and the profile were answered months ago.
 * `markReachedOut` gives one past-tense click with an 8-second undo, and the
 * dialog is demoted to a secondary Draft button.
 *
 * **The one surface that interrupts you never got the rework.** Opening Orbit
 * raised the old "Draft a message" dialog: over whatever you were doing, first
 * offering an eight-line draft nobody asked for, with the confirm button third.
 * The worst version of the gesture, on the surface with the least patience.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * 1. **A dialog by another name.** The point is that it does not cover the page
 *    or trap focus. If it grows an overlay it has regressed.
 *
 * 2. **The draft creeping back to the front.** Writing a message is the rare
 *    path; saying you already sent one is the common one. The order of the
 *    buttons IS the ticket.
 *
 * 3. **Interrupting about the wrong person.** It used to take the first contact
 *    whose timer had expired, which is a different question from the one the
 *    dashboard answers — so it could interrupt you about someone the list would
 *    not even show first. It now follows ORB-92's ranking.
 *
 * 4. **Interrupting about nobody.** No one to nudge means no nudge, and the
 *    once-a-day stamp must not be spent on a nudge that never appeared.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo, daysAhead } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  normalizeContact, getHealth, reachOutNudgeHtml, showReachOutNudge,
  checkRemindersOnLoad, markReachedOut, needsAttention
} = main;

const person = (over = {}) => normalizeContact({
  id: "c1", name: "Marcus Chen", followUpFrequency: "monthly",
  reminderEnabled: true, lastContacted: daysAgo(200), nextReminder: daysAgo(170),
  dateMet: daysAgo(400), interactions: [], ...over
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const clearAll = () => {
  document.querySelectorAll(".nudge-slot, .toast-stack, #reminderModal")
    .forEach((n) => n.remove());
};

group("It is a bar, not a dialog");
{
  clearAll();
  const c = person();
  showReachOutNudge(c, getHealth(c));
  const nudge = document.querySelector(".nudge");
  ok("it appears", nudge);
  ok("it does not cover the page", !document.querySelector(".modal-overlay"));
  ok("and does not claim to be a dialog", nudge.getAttribute("role") !== "dialog");
  ok("it is announced as a region with the person's name",
    /Reach out to Marcus Chen/.test(nudge.getAttribute("aria-label") || ""));
  clearAll();
}
{
  clearAll();
  const c = person();
  showReachOutNudge(c, getHealth(c));
  const buttons = [...document.querySelectorAll(".nudge-actions button")];
  ok("confirming comes first", /Reached out/.test(buttons[0].textContent));
  ok("drafting is demoted to second", /Draft/.test(buttons[1].textContent));
  ok("and dismissing is last", /Not now/.test(buttons[2].getAttribute("aria-label")));
  clearAll();
}

group("The primary action is the same one click as everywhere else");
{
  clearAll(); resetState();
  const c = person();
  state.store.set(c.id, c);
  let refreshed = 0;
  showReachOutNudge(c, getHealth(c), async () => { refreshed++; });
  document.querySelector("[data-nudge-done]").click();
  await tick();

  eq("one click records it", state.store.get("c1").lastContacted, main.todayDateString());
  ok("the nudge closes", !document.querySelector(".nudge"));
  eq("and the page behind it re-renders", refreshed, 1);
  ok("with the same undo the dashboard offers",
    document.querySelector(".toast-action")?.textContent === "Undo");
  clearAll();
}
{
  clearAll(); resetState();
  const c = person();
  state.store.set(c.id, c);
  showReachOutNudge(c, getHealth(c), async () => {});
  document.querySelector("[data-nudge-draft]").click();
  await tick();
  ok("Draft still opens the full dialog", document.getElementById("reminderModal"));
  ok("and the bar gets out of its way", !document.querySelector(".nudge"));
  clearAll();
}
{
  clearAll(); resetState();
  const c = person();
  state.store.set(c.id, c);
  showReachOutNudge(c, getHealth(c), async () => {});
  document.querySelector("[data-nudge-dismiss]").click();
  ok("dismissing closes it", !document.querySelector(".nudge"));
  eq("and records nothing", state.saves.length, 0);
  clearAll();
}

group("It says why, in the same words as the list");
{
  clearAll();
  const noted = person({ followUps: [{ text: "Ask about the payments move", source: "capture" }] });
  showReachOutNudge(noted, getHealth(noted));
  ok("a caught thought is the reason it interrupted you",
    /Ask about the payments move/.test(document.querySelector(".nudge").textContent));
  clearAll();
}
{
  clearAll();
  const plain = person();
  showReachOutNudge(plain, getHealth(plain));
  const text = document.querySelector(".nudge").textContent;
  // `elapsed` prints no tag on the list, so the nudge falls back to ORB-78's
  // sentence rather than showing a blank line where a reason should be.
  ok("with no trigger it states the elapsed time instead",
    /You last spoke to Marcus/.test(text));
  ok("and never leaves the reason line empty", text.trim().length > "Marcus Chen".length);
  clearAll();
}
{
  clearAll();
  const c = person({ starred: true });
  showReachOutNudge(c, getHealth(c));
  ok("a starred person is marked here too",
    document.querySelector(".nudge .star-inline"));
  clearAll();
}
{
  clearAll();
  const c = person({ name: '<img src=x onerror=alert(1)>' });
  showReachOutNudge(c, getHealth(c));
  const nudge = document.querySelector(".nudge");
  ok("the name is escaped in the body", !/<img/.test(nudge.innerHTML));
  ok("no element was created from it", !nudge.querySelector("img"));
  // The aria-label holds the name as TEXT. outerHTML shows "<img" inside the
  // attribute because attribute serialisation escapes & and " but not < — that
  // is correct and harmless, so the assertion is about the parsed value rather
  // than the serialised string, which is the thing that would actually bite.
  eq("and the label carries it as a plain value",
    nudge.getAttribute("aria-label"), 'Reach out to <img src=x onerror=alert(1)>');
  clearAll();
}

group("It interrupts about the person the list would show first");
{
  clearAll(); resetState();
  localStorage.removeItem("orbit_nudge_last");
  const late = person({ id: "late", name: "Late", lastContacted: daysAgo(400),
    nextReminder: daysAgo(370), dateMet: daysAgo(400) });
  const noted = person({ id: "noted", name: "Noted", lastContacted: daysAgo(1),
    nextReminder: daysAhead(29), dateMet: daysAgo(400),
    followUps: [{ text: "Congratulate her", source: "capture" }] });
  state.store.set(late.id, late);
  state.store.set(noted.id, noted);

  // The old rule was "first contact whose timer expired", which would have
  // picked Late — and Noted is not even overdue, so it would never be picked.
  eq("the list ranks the noted person first",
    needsAttention([late, noted])[0].contact.name, "Noted");

  await checkRemindersOnLoad();
  await tick(1100);
  ok("and that is who the nudge is about",
    /Noted/.test(document.querySelector(".nudge")?.textContent || ""));
  ok("with the note as the reason",
    /Congratulate her/.test(document.querySelector(".nudge")?.textContent || ""));
  clearAll();
}
{
  clearAll(); resetState();
  localStorage.removeItem("orbit_nudge_last");
  const fine = person({ lastContacted: daysAgo(1), nextReminder: daysAhead(29) });
  state.store.set(fine.id, fine);
  await checkRemindersOnLoad();
  await tick(1100);
  ok("nobody to nudge means no nudge", !document.querySelector(".nudge"));
  eq("and the once-a-day stamp is not spent on it",
    localStorage.getItem("orbit_nudge_last"), null);
  clearAll();
}
{
  clearAll(); resetState();
  localStorage.setItem("orbit_nudge_mode", "off");
  localStorage.removeItem("orbit_nudge_last");
  state.store.set("c1", person());
  await checkRemindersOnLoad();
  await tick(1100);
  ok("Never means never", !document.querySelector(".nudge"));
  localStorage.setItem("orbit_nudge_mode", "daily");
  clearAll();
}
{
  clearAll(); resetState();
  localStorage.setItem("orbit_nudge_last", main.todayDateString());
  state.store.set("c1", person());
  await checkRemindersOnLoad();
  await tick(1100);
  ok("once a day means once a day", !document.querySelector(".nudge"));
  localStorage.removeItem("orbit_nudge_last");
  clearAll();
}
{
  // The profile is where you already went on purpose. Interrupting there was
  // always excluded and stays excluded.
  clearAll(); resetState();
  localStorage.removeItem("orbit_nudge_last");
  state.store.set("c1", person());
  const marker = document.createElement("div");
  marker.setAttribute("data-page", "contact");
  document.body.appendChild(marker);
  await checkRemindersOnLoad();
  await tick(1100);
  ok("the contact page is never interrupted", !document.querySelector(".nudge"));
  marker.remove();
  clearAll();
}

done();
