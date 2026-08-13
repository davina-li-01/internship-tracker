/**
 * Conversation history holds its height (ORB-62).
 *
 * A person you talk to often gave a profile that scrolled forever, with the
 * files card and the danger zone somewhere below the horizon. Three
 * conversations now, then the list scrolls inside itself.
 *
 * WHAT THIS CAN AND CANNOT CHECK
 *
 * The cap is a CSS max-height and the fade is driven by measuring scrollHeight
 * against clientHeight. jsdom has no layout engine, so both are zero and
 * neither can be asserted here — those are read off the stylesheet at the
 * bottom instead, and confirmed by eye.
 *
 * What matters behaviourally is the opposite property: that nothing is
 * dropped. The obvious way to keep a card short is `.slice(0, 3)`, and it is
 * the failure ORB-46 spent a ticket undoing on the dashboard — a fixed-height
 * list that hides things silently is worse than a long one. So the assertions
 * here are that every conversation still renders, and that the heading says
 * how many there are.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMain, state, resetState, ROOT } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const dom = globalThis.__dom;

function conversations(n) {
  return Array.from({ length: n }, (_, i) => main.normalizeInteraction({
    id: "i" + i,
    // Descending dates, so the newest is first and the ids stay readable.
    date: "2026-08-" + String(20 - i).padStart(2, "0"),
    type: "coffee chat",
    notes: "Conversation number " + i
  }));
}

async function profileWith(n) {
  resetState();
  state.store.set("h1", main.normalizeContact({
    id: "h1", name: "Chris Rule", followUpFrequency: "quarterly",
    reminderEnabled: true, lastContacted: "2026-08-20",
    interactions: conversations(n), companyHistory: [], followUps: []
  }));
  dom.reconfigure({ url: "https://orbit.test/contact.html?id=h1" });
  document.body.innerHTML = "";
  const el = document.createElement("section");
  el.id = "contactPageContent";
  document.body.appendChild(el);
  await main.initContactPage();
  return el;
}

group("Nothing is dropped to keep the card short");
{
  const root = await profileWith(12);
  const rows = root.querySelectorAll(".timeline .convo");
  eq("all twelve conversations render", rows.length, 12);
  ok("including the oldest, which a slice would have removed",
    root.querySelector(".timeline").textContent.includes("Conversation number 11"));
  ok("and every one can still be opened",
    root.querySelectorAll("[data-edit-convo]").length === 12);
}

group("The heading says how much is below the fold");
{
  const root = await profileWith(12);
  const heading = root.querySelector(".profile-timeline .section-title");
  eq("the count is shown", heading.querySelector(".chart-count")?.textContent, "12");
}
{
  const root = await profileWith(3);
  const heading = root.querySelector(".profile-timeline .section-title");
  ok("no count when everything already fits",
    !heading.querySelector(".chart-count"));
}
{
  const root = await profileWith(4);
  eq("one past the cap is enough to warrant it",
    root.querySelector(".profile-timeline .chart-count")?.textContent, "4");
}

group("The list is the thing that scrolls, not the card");
{
  const root = await profileWith(12);
  const card = root.querySelector(".profile-timeline");
  const list = root.querySelector(".profile-timeline .timeline");
  ok("the timeline exists inside the card", card && list && card.contains(list));
  // wireScrollFade runs on render and sets these from a measurement. Under
  // jsdom every dimension is zero, so it reports "not scrollable, at the end"
  // — which is the correct answer for a list with no height, and proves the
  // wiring ran rather than proving the fade.
  ok("the fade wiring ran", list.classList.contains("at-end"));
}

// ── Read off the stylesheet, since jsdom cannot lay it out ───────────────────

const css = readFileSync(join(ROOT, "css", "style.css"), "utf8");
const rule = (sel) => {
  const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}"));
  return m ? m[1] : "";
};

group("The cap is a height, not a slice");
{
  const body = rule(".profile-timeline .timeline");
  ok("the timeline has a max-height", /max-height:\s*[\d.]+rem/.test(body));
  ok("and scrolls rather than clipping", /overflow-y:\s*auto/.test(body));
  ok("with scroll chaining contained, so it does not drag the page",
    /overscroll-behavior:\s*contain/.test(body));
}

group("The fade only shows while there is more");
{
  ok("it is bound to is-scrollable and not at-end",
    css.includes(".profile-timeline .timeline.is-scrollable:not(.at-end)"));
  // A permanently-on fade is just a washed-out last row, and one that stays
  // after you reach the bottom implies content that is not there.
  ok("there is no unconditional fade on the timeline",
    !/\.profile-timeline \.timeline \{[^}]*mask-image/.test(css));
}

done();
