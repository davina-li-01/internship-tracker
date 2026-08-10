/**
 * The "Coming up" card (ORB-28/ORB-35).
 *
 * The widget reads from the localStorage cache rather than from Google, so its
 * failure modes are all about what the cache still contains: a meeting you have
 * already had shown as though it were ahead, or — since meetings now stay
 * listed until they END — one you are sitting in labelled as something upcoming.
 */
import { loadMain, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const main = await loadMain();
const cal = await import("../js/calendar.js");

resetState();
localStorage.setItem("orbit_calendar_connected", "1");

const slot = document.createElement("div");
slot.id = "upcomingMeetings";
document.body.appendChild(slot);

const NOW = Date.now();
const at = (h) => new Date(NOW + h * 3600_000).toISOString();
const today = new Date(NOW).toISOString().slice(0, 10);

const person = [{ id: "c1", name: "Marcus Chen", talkingPoints: ["Ask about the platform move"] }];

cal.cacheUpcoming([
  { eventId: "live", title: "Coffee with Marcus", date: today, time: "9:30 AM",
    iso: at(-0.5), endIso: at(0.5), medium: { label: "Blue Bottle", url: "" }, people: person },
  { eventId: "later", title: "Intro call", date: today, time: "4:00 PM",
    iso: at(4), endIso: at(5), medium: { label: "Zoom", url: "https://zoom.us/j/1" }, people: person },
  { eventId: "over", title: "Standup", date: today, time: "8:00 AM",
    iso: at(-3), endIso: at(-2), medium: { label: "Meet", url: "" }, people: person }
], NOW);

main.renderUpcomingMeetings();

group("What the card shows");
const rows = [...slot.querySelectorAll(".upcoming-row")];
eq("the finished meeting is gone, the other two remain", rows.length, 2);
eq("the one in progress is labelled now",
  rows[0].querySelector(".upcoming-day").textContent, "now");
ok("and is marked as such for styling", rows[0].classList.contains("upcoming-now"));
eq("the later one keeps its relative day",
  rows[1].querySelector(".upcoming-day").textContent, "today");
ok("the later one is not marked in progress", !rows[1].classList.contains("upcoming-now"));

group("The clock time is still shown for a meeting in progress");
// "Now · 9:30 AM" — when it started still matters if you are late to it.
ok("the start time survives", rows[0].textContent.includes("9:30 AM"));

group("Talking points are the reason to show any of this");
ok("the talking point is rendered",
  slot.textContent.includes("Ask about the platform move"));

group("A join link is offered when there is one");
eq("the Zoom row links out",
  rows[1].querySelector(".upcoming-link")?.getAttribute("href"), "https://zoom.us/j/1");
eq("the in-person row does not invent one",
  rows[0].querySelector(".upcoming-link"), null);

group("Nothing cached at all");
cal.clearUpcoming();
main.renderUpcomingMeetings();
ok("the card explains itself rather than rendering an empty list",
  slot.querySelector(".upcoming-empty"));
ok("and the sync bar stays, so the button is still reachable",
  slot.querySelector(".sync-bar"));

group("Never connected");
localStorage.removeItem("orbit_calendar_connected");
main.renderUpcomingMeetings();
eq("the whole card is hidden", slot.hidden, true);

done();
