/**
 * A caught thought about somebody you have not saved yet (ORB-129).
 *
 * The capture bar used to refuse: "No one in your network by that name yet."
 * So a thought about anybody not already in Orbit had nowhere to go — which is
 * the opposite of what a capture is for, and the state ORB-81 was written to
 * make cheap. The name becomes a connection.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * The two silent failures either side of the question.
 *
 *   - **Guessing.** Attaching "Chris" to the first Chris in the list puts a
 *     note on the wrong person and says nothing.
 *   - **Not guessing hard enough.** Creating a second Chris because the typed
 *     text was not an exact match leaves two of them and no way to tell which
 *     the thought was about.
 *
 * Both are worse than asking, and asking is cheap because it only happens when
 * the answer is genuinely unclear. A full name typed out is not unclear, and is
 * asserted not to prompt.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { daysAgo } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  captureFormHtml, wireCaptureForm, normalizeContact, captureCandidates,
  contactProfileUrl, profileIsBare, bareProfileHtml, describeContact
} = main;

const tick = () => new Promise((r) => setTimeout(r, 0));
const click = (el) => el.dispatchEvent(
  new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

const CHRIS_RULE = normalizeContact({
  id: "c1", name: "Chris Rule", role: "Director of Product", company: "Turno"
});
const CHRIS_PARK = normalizeContact({
  id: "c2", name: "Chris Park", role: "Engineer", company: "IBM"
});
const HUNTER = normalizeContact({ id: "c3", name: "Hunter Rapoza" });

let went = [];
function mount(contacts) {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById("host");
  host.innerHTML = captureFormHtml(contacts);
  went = [];
  wireCaptureForm(host, () => contacts, async () => {}, {
    navigate: (url) => went.push(url)
  });
  return { host, $: (sel) => host.querySelector(sel) };
}
const submit = (host) => {
  host.querySelector(".capture-form")
    .dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  return tick();
};

// ── Who could this be ────────────────────────────────────────────────────────

group("A first name finds the people it could mean");
{
  const all = [CHRIS_RULE, CHRIS_PARK, HUNTER];
  eq("both Chrises", captureCandidates("Chris", all).map((c) => c.id).join(), "c1,c2");
  eq("case does not matter, because it is 2am",
    captureCandidates("chris", all).length, 2);
  eq("half a surname works too", captureCandidates("Rul", all).map((c) => c.id).join(), "c1");
  eq("a full name is not ambiguous and returns only itself",
    captureCandidates("Chris Rule", all).map((c) => c.id).join(), "c1");
  eq("somebody unknown matches nobody", captureCandidates("Adith", all).length, 0);
  eq("and nothing typed matches nobody", captureCandidates("   ", all).length, 0);
}

// ── The question ─────────────────────────────────────────────────────────────

group("Two Chrises is a question, not a guess");
{
  resetState();
  const { host, $ } = mount([CHRIS_RULE, CHRIS_PARK, HUNTER]);
  $(".capture-who").value = "Chris";
  $(".capture-thought").value = "Ask about the new team";
  await submit(host);

  eq("nothing is saved until the question is answered", state.saves.length, 0);
  ok("the question names what was typed", /Which Chris\?/.test($(".capture-disambig").textContent));
  const options = [...host.querySelectorAll(".capture-option")];
  eq("both of them, plus a way out", options.length, 3);
  // A list of identical first names with nothing beside them is not a choice.
  ok("each one is told apart by what they do",
    /Director of Product at Turno/.test(options[0].textContent)
    && /Engineer at IBM/.test(options[1].textContent));
  ok("and the last option is a new person", options[2].hasAttribute("data-pick-new"));
}
{
  resetState();
  const { host } = mount([CHRIS_RULE, CHRIS_PARK]);
  host.querySelector(".capture-who").value = "Chris";
  host.querySelector(".capture-thought").value = "Ask about the new team";
  await submit(host);
  click(host.querySelectorAll(".capture-option")[1]);
  await tick();

  eq("choosing one saves against that one", state.saves.length, 1);
  eq("the right one", state.saves[0].id, "c2");
  eq("with the thought as typed",
    state.saves[0].followUps[0].text, "Ask about the new team");
  eq("and you stay where you are — you are mid-thought", went.length, 0);
}
{
  resetState();
  const { host } = mount([CHRIS_RULE, CHRIS_PARK]);
  host.querySelector(".capture-who").value = "Chris";
  await submit(host);
  click(host.querySelector("[data-pick-new]"));
  await tick();

  eq("a third Chris is allowed, once you say so", state.saves.length, 1);
  eq("named as typed", state.saves[0].name, "Chris");
  eq("and neither of the others is touched",
    state.saves.filter((c) => c.id === "c1" || c.id === "c2").length, 0);
  eq("and you are taken there", went[0], contactProfileUrl(state.saves[0].id));
}
{
  // Typing somebody's whole name is an answer. Asking again would be the app
  // pretending not to understand.
  resetState();
  const { host, $ } = mount([CHRIS_RULE, CHRIS_PARK]);
  $(".capture-who").value = "Chris Rule";
  await submit(host);
  eq("a full name saves without a question", state.saves.length, 1);
  eq("against that person", state.saves[0].id, "c1");
  ok("and nothing was asked", $(".capture-disambig").hidden);
}

// ── Somebody genuinely new ───────────────────────────────────────────────────

group("A name nobody recognises becomes a connection");
{
  resetState();
  const { host, $ } = mount([HUNTER]);
  $(".capture-who").value = "Adith Kannan";
  $(".capture-thought").value = "Ask how the PM rotation went";
  await submit(host);

  const saved = state.saves[0];
  eq("they are saved", saved.name, "Adith Kannan");
  eq("with the thought attached", saved.followUps[0].text, "Ask how the PM rotation went");
  eq("as a capture", saved.followUps[0].source, "capture");
  ok("no question was needed", $(".capture-disambig").hidden);
  eq("and no error", $(".capture-error").textContent, "");
  eq("you land on their profile", went[0], contactProfileUrl(saved.id));

  // Nothing is invented about somebody you have only thought about. ORB-128 for
  // the cadence, ORB-75 for the contact date.
  eq("no cadence assumed", saved.followUpFrequency, "none");
  eq("no reminders", saved.reminderEnabled, false);
  eq("no deadline", saved.nextReminder, "");
  eq("no conversation invented", saved.interactions.length, 0);
  eq("and no contact date", saved.lastContacted, "");
}
{
  resetState();
  const { host, $ } = mount([]);
  $(".capture-who").value = "Adith Kannan";
  await submit(host);
  // A name on its own is a complete intention (ORB-81), so it writes the
  // sentence rather than refusing. First name, as everywhere else (ORB-78).
  eq("the name alone still writes a talking point",
    state.saves[0].followUps[0].text, "Reach out to Adith");
}
{
  resetState();
  state.failSave = true;
  const { host, $ } = mount([]);
  $(".capture-who").value = "Adith Kannan";
  await submit(host);
  ok("a failed save says so", /Could not save/.test($(".capture-error").textContent));
  eq("and does not pretend you went anywhere", went.length, 0);
  state.failSave = false;
}

// ── What to put in, once you are there ───────────────────────────────────────

group("A profile that is only a name says what is worth adding");
{
  const bare = normalizeContact({ id: "n1", name: "Adith Kannan" });
  ok("that state is recognised", profileIsBare(bare));
  ok("but a described person is not", !profileIsBare(CHRIS_RULE));
  ok("nor is one with a conversation", !profileIsBare(normalizeContact({
    id: "n2", name: "Adith Kannan",
    interactions: [{ id: "i1", date: daysAgo(2), type: "call", notes: "x" }]
  })));
  ok("nor one with notes",
    !profileIsBare(normalizeContact({ id: "n3", name: "A", notes: "Met at a talk" })));
}
{
  const html = bareProfileHtml(normalizeContact({ id: "n1", name: "Adith Kannan" }));
  // Each line has to carry a reason. "Complete your profile" is a chore;
  // "so a second Adith is never a guess" is an argument.
  ok("role and company, with why", /role and company/i.test(html) && /never a guess/i.test(html));
  ok("where you know them from, with why", /know them from/i.test(html));
  ok("an email, with why", /email/i.test(html) && /leaving\s+Orbit/i.test(html));
  ok("it uses their first name", /Adith/.test(html) && !/Adith Kannan/.test(html));
  // The one thing it must NOT push, three tickets after the app stopped
  // assuming a schedule.
  ok("and it does not ask for a cadence", /optional/i.test(html));
  ok("with a way straight into the form", /id="cpFillIn"/.test(html));
}

group("One description, used everywhere two people are told apart");
{
  eq("role at company", describeContact(CHRIS_RULE), "Director of Product at Turno");
  eq("role alone", describeContact({ role: "Engineer" }), "Engineer");
  eq("company alone", describeContact({ company: "IBM" }), "IBM");
  eq("neither", describeContact({}), "");
  eq("and whitespace is not a description", describeContact({ role: "  " }), "");
}

done();
