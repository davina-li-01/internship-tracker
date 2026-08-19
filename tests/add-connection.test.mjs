/**
 * Adding someone you have not spoken to (ORB-73).
 *
 * The obvious test here is "the form saves a contact". That is not the one that
 * matters. Before this ticket the + could already save a contact — it just also
 * invented a conversation and set `lastContacted` to its date, so a person you
 * had never spoken to was written into the database as freshly contacted and
 * read as healthy on the dashboard.
 *
 * So the assertions below are mostly about what must NOT exist after using the
 * form: no interaction, no fabricated contact date, no "In touch". A suite that
 * only proved the happy path would have passed against the old behaviour too.
 *
 * The chooser is tested for the same reason ORB-65 and ORB-63 needed widening:
 * a component test proves a thing works, not that it is reachable. Here that
 * means asserting the + actually opens the chooser, and that both routes out of
 * it land somewhere.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today, daysAgo, daysAhead } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  addConnectionFormHtml, wireAddConnectionForm, openAddConnectionModal,
  openQuickAddChooser, initQuickAddButton,
  normalizeContact, getHealth, needsAttention, GRACE_DAYS
} = main;

const tick = () => new Promise((r) => setTimeout(r, 0));
const click = (el) => el.dispatchEvent(
  new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));

/** Mounts the bare form, with no modal around it. */
function mountForm(contacts = []) {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById("host");
  host.innerHTML = addConnectionFormHtml();
  const saved = [];
  wireAddConnectionForm(host, () => contacts, async (c, meta) => { saved.push({ c, meta }); });
  return { host, saved, $: (s) => host.querySelector(s) };
}

async function submit($, host) {
  host.querySelector(".ac-form").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(); await tick();
}

// ── The whole point ──────────────────────────────────────────────────────────

group("Adding a person writes a person and nothing else");
{
  resetState();
  const { host, saved, $ } = mountForm();
  $(".ac-name").value = "Priya Raman";
  $(".ac-role").value = "Staff Engineer";
  $(".ac-company").value = "Turno";
  await submit($, host);

  eq("one contact was saved", state.saves.length, 1);
  const c = state.saves[0];
  eq("with the name", c.name, "Priya Raman");
  eq("the role", c.role, "Staff Engineer");
  eq("and the company", c.company, "Turno");

  // The assertion this ticket exists for.
  eq("NO conversation was invented", c.interactions.length, 0);
  eq("lastContacted is empty, not today", c.lastContacted, "");
  ok("and it is certainly not today's date", c.lastContacted !== today());
  eq("dateMet is empty when it was not given", c.dateMet, "");
  eq("the caller was told", saved.length, 1);
}

group("There is nowhere to type a conversation");
{
  const { $ } = mountForm();
  ok("no notes editor", !$(".cw-notes") && !$(".ac-notes"));
  ok("no conversation date field", !$(".cw-date"));
  ok("no conversation type picker", !$(".cw-type"));
  ok("no attachment input", !$("input[type=file]"));
  // Absence is the feature, so it is asserted rather than assumed.
  ok("nothing in the form mentions speaking",
    !/spoke|conversation|talk about/i.test($(".ac-form").textContent.replace(/No conversation is recorded/i, "")));
}

// ── The meeting date ─────────────────────────────────────────────────────────

group("When you met is optional, and never guessed");
{
  const { $ } = mountForm();
  const field = $(".ac-datemet");
  ok("the field exists", Boolean(field));
  ok("it is not required", !field.required);
  ok("it starts empty rather than defaulting to today", field.value === "");
  ok("the label says optional",
    /optional/i.test($("label[for=acDateMet]").textContent));
  ok("and the hint says blank is allowed",
    /do not remember/i.test($(".ac-form").textContent));
}
{
  resetState();
  const { host, $ } = mountForm();
  $(".ac-name").value = "No Idea";
  await submit($, host);
  eq("left blank, it stays blank", state.saves[0].dateMet, "");
}
{
  resetState();
  const { host, $ } = mountForm();
  $(".ac-name").value = "Met At A Talk";
  $(".ac-datemet").value = daysAgo(40);
  await submit($, host);
  eq("supplied, it is kept exactly", state.saves[0].dateMet, daysAgo(40));
  // normalizeContact would otherwise derive lastContacted from it, filing a
  // meeting as a conversation and putting a contact date on a relationship
  // where nothing has been said (ORB-75).
  eq("and it does NOT become a contact date", state.saves[0].lastContacted, "");
}

// ── Cadence: they must surface, and must not read as healthy ─────────────────

group("Someone you have not spoken to owes you a first reach-out");
{
  resetState();
  const { host, $ } = mountForm();
  $(".ac-name").value = "Grace Case";
  await submit($, host);
  const c = normalizeContact(state.saves[0]);

  eq("the deadline is the grace window, not a cadence from nowhere",
    c.nextReminder, daysAhead(GRACE_DAYS));
  const h = getHealth(c);
  ok("they are scheduled", h.scheduled);
  ok("but NOT 'in touch' — nothing has been said yet", h.band !== "good");
  eq("they appear in Reach out next", needsAttention([c]).length, 1);
}
{
  // The case that would otherwise slip through: a recent meeting date would
  // give a natural deadline a month out, and the person would read as healthy
  // without a word having been exchanged — the exact bug ORB-73 is about,
  // re-entering through `dateMet` instead of through a fabricated interaction.
  resetState();
  const { host, $ } = mountForm();
  $(".ac-name").value = "Met Yesterday";
  $(".ac-datemet").value = daysAgo(1);
  await submit($, host);
  const c = normalizeContact(state.saves[0]);

  eq("a recent meeting does not buy a full cadence",
    c.nextReminder, daysAhead(GRACE_DAYS));
  ok("still not 'in touch'", getHealth(c).band !== "good");
  eq("still listed for a reach-out", needsAttention([c]).length, 1);
}
{
  resetState();
  const { host, $ } = mountForm();
  $(".ac-name").value = "On File";
  click($(".ac-adjust"));
  $(".ac-freq").value = "none";
  $(".ac-freq").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await submit($, host);
  const c = normalizeContact(state.saves[0]);
  eq("choosing no schedule means no deadline", c.nextReminder, "");
  eq("and no reminder", c.reminderEnabled, false);
  eq("they are not chased", needsAttention([c]).length, 0);
}

// ── ORB-94 ───────────────────────────────────────────────────────────────────
// This form used to open with "What kind of relationship is this?". Survey 1
// found 3 of 5 could not answer it at that moment, and the 2 who could are now
// served by a star (ORB-93). The tier's INTERVAL survives as the default — the
// form still opens on monthly — it is simply no longer asked about.
group("The tier question is gone, the cadence it implied is not");
{
  const { $ } = mountForm();
  ok("no tier select", !$(".ac-tier"));
  ok("and no tier hint", !$(".ac-tier-hint"));
  ok("the result line still states the default in plain words",
    /every month/i.test($(".ac-cadence-text").textContent));
  ok("the interval control still starts hidden behind Adjust",
    $(".ac-freq-group").classList.contains("hidden"));

  click($(".ac-adjust"));
  ok("Adjust reveals it", !$(".ac-freq-group").classList.contains("hidden"));
  $(".ac-freq").value = "quarterly";
  $(".ac-freq").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  ok("and changing it restates the sentence",
    /3 months/i.test($(".ac-cadence-text").textContent));
}
{
  // The failure worth guarding: adding someone must not record a tier nobody
  // chose. A derived tier saved as a chosen one is what would make ORB-86's
  // evidence — and ORB-57's first metric — meaningless.
  resetState();
  const { host, $ } = mountForm();
  $(".ac-name").value = "Untiered";
  await submit($, host);
  eq("a new connection carries no tier at all", state.saves[0].tier, "");
  eq("but does carry the interval the default implied",
    state.saves[0].followUpFrequency, "monthly");
  eq("and no star either — that is a thing you say, not a default",
    state.saves[0].starred, false);
}

// ── Guardrails ───────────────────────────────────────────────────────────────

group("An existing person is not silently duplicated");
{
  const existing = normalizeContact({
    id: "c1", name: "Marcus Chen", role: "PM", company: "Turno",
    lastContacted: daysAgo(10), followUpFrequency: "monthly"
  });
  resetState();
  const { host, $ } = mountForm([existing]);
  $(".ac-name").value = "Marcus Chen";
  await submit($, host);

  eq("nothing was saved", state.saves.length, 0);
  ok("it says they are already there", /already in your network/i.test($(".ac-error").textContent));
  ok("and offers their profile", Boolean($(".ac-error a[href*='c1']")));
}
{
  const existing = normalizeContact({ id: "c1", name: "Marcus Chen" });
  resetState();
  const { host, $ } = mountForm([existing]);
  $(".ac-name").value = "  marcus chen  ";
  await submit($, host);
  eq("case and padding do not get around it", state.saves.length, 0);
}
{
  const existing = normalizeContact({ id: "c1", name: "Marcus Chen", role: "PM" });
  const { $ } = mountForm([existing]);
  $(".ac-name").value = "Marc";
  $(".ac-name").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const items = $(".combo-list").querySelectorAll(".combo-item");
  eq("typing a partial name surfaces the match", items.length, 1);
  ok("labelled as already added", /already added/i.test(items[0].textContent));
}
{
  // Someone genuinely new whose name merely contains an existing one must not
  // be blocked — the guard is an exact match, not a substring.
  const existing = normalizeContact({ id: "c1", name: "Marcus Chen" });
  resetState();
  const { host, $ } = mountForm([existing]);
  $(".ac-name").value = "Marcus Chenoweth";
  await submit($, host);
  eq("a different person with a similar name is allowed", state.saves.length, 1);
}

group("A name is the only thing required");
{
  resetState();
  const { host, $ } = mountForm();
  $(".ac-name").value = "   ";
  await submit($, host);
  eq("nothing saved without one", state.saves.length, 0);
  ok("and it says so", $(".ac-error").textContent.length > 0);
}
{
  resetState();
  const { host, $ } = mountForm();
  $(".ac-name").value = "Bare Minimum";
  await submit($, host);
  eq("name alone is enough", state.saves.length, 1);
  eq("no role", state.saves[0].role, "");
  eq("no company", state.saves[0].company, "");
  eq("no email", state.saves[0].email, "");
}
{
  resetState();
  state.failSave = true;
  const { host, $ } = mountForm();
  $(".ac-name").value = "Doomed";
  await submit($, host);
  ok("a failed save is reported, not swallowed", /could not save/i.test($(".ac-error").textContent));
  ok("and the button is usable again", !$(".ac-submit").disabled);
  state.failSave = false;
}

// ── The chooser ──────────────────────────────────────────────────────────────

group("The + asks which of the two things you meant");
{
  resetState();
  document.body.innerHTML = '<button id="quickAddBtn"></button>';
  initQuickAddButton(() => [], () => {});
  click(document.getElementById("quickAddBtn"));

  const chooser = document.getElementById("quickAddChooser");
  ok("the + opens the chooser, not a form", Boolean(chooser));
  ok("and not the conversation logger", !document.getElementById("quickAddModal"));

  const opts = chooser.querySelectorAll(".chooser-option");
  eq("three options", opts.length, 3);
  ok("adding a connection comes first", /add a connection/i.test(opts[0].textContent));
  ok("logging a conversation second", /log a conversation/i.test(opts[1].textContent));
  // ORB-81 added the third. Last, because it is the smallest act of the three.
  ok("catching a thought third", /note to self/i.test(opts[2].textContent));
  // Two bare buttons would not have removed the ambiguity — the descriptions
  // are the part that does.
  ok("each explains what it does",
    [...opts].every((o) => o.querySelector(".chooser-desc")));
  ok("both are focusable buttons", [...opts].every((b) => b.tagName === "BUTTON"));
  chooser.remove();
}
{
  resetState();
  openQuickAddChooser([], () => {});
  click(document.getElementById("chooseAddConnection"));
  await tick();
  ok("choosing add opens the add form", Boolean(document.getElementById("addConnectionModal")));
  ok("the chooser is gone", !document.getElementById("quickAddChooser"));
  ok("and the form has no conversation fields",
    !document.querySelector("#addConnectionModal .cw-date"));
  document.getElementById("addConnectionModal")?.remove();
}
{
  resetState();
  openQuickAddChooser([], () => {});
  click(document.getElementById("chooseLogConversation"));
  await tick();
  ok("choosing log still opens the logger", Boolean(document.getElementById("quickAddModal")));
  ok("which is unchanged and still asks who you spoke with",
    /did you speak/i.test(document.getElementById("quickAddModal").textContent));
  document.getElementById("quickAddModal")?.remove();
}
{
  resetState();
  openQuickAddChooser([], () => {});
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  ok("escape dismisses it", !document.getElementById("quickAddChooser"));
}
{
  resetState();
  openQuickAddChooser([], () => {});
  const overlay = document.getElementById("quickAddChooser");
  click(overlay);
  await tick();
  ok("clicking outside dismisses it", !document.getElementById("quickAddChooser"));
}

group("Saving confirms outside the dialog that is about to close");
{
  resetState();
  openAddConnectionModal([], () => {});
  const modal = document.getElementById("addConnectionModal");
  modal.querySelector(".ac-name").value = "Toast Target";
  modal.querySelector(".ac-form").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(); await tick(); await tick();

  ok("the dialog closed", !document.getElementById("addConnectionModal"));
  const toast = document.querySelector(".toast-stack");
  ok("a toast survived it", Boolean(toast));
  ok("naming the person", /Toast Target/.test(toast.textContent));
  ok("and pointing at their profile",
    Boolean(toast.querySelector("a[href*='contact.html?id=']")));
}

done();
