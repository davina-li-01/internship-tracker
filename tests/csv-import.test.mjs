/**
 * Importing a spreadsheet of people you already know (ORB-98).
 *
 * WHY THIS EXISTS, AND WHY IT NEARLY DID NOT
 *
 * ORB-76 dropped bulk entry on the morning of 19 August: no evidence anyone
 * needed it, and metric 3 — the only instrument pointed at it — turned out to
 * be structurally incapable of producing any. The evidence arrived hours later
 * and from exactly the direction that decision named: a real user with 50+
 * contacts already in an Excel sheet, and the observation that people who do
 * not need Orbit still keep a CRM, and every CRM exports CSV.
 *
 * It is not the bulk paste that was dropped. That was free text in a box, which
 * needs a parser that guesses at everything. A file has a header row, and the
 * header row is what makes the guessing tractable.
 *
 * WHAT THIS SUITE IS GUARDING AGAINST
 *
 * 1. **A naive parser.** The fields that break a split on commas are exactly
 *    the ones this feature exists for — "Smith, Jane" in a name column, a note
 *    with a comma in it, a quoted address. Asserted with the real shapes.
 *
 * 2. **Silent guessing.** The column map is a guess. It is shown and it is
 *    correctable, and nothing may be written before a preview exists.
 *
 * 3. **Inventing history at scale.** ORB-73 established that adding someone is
 *    not a conversation. Fifty rows is not fifty conversations, and it is not
 *    fifty stars either. A date that will not parse must be empty, never today.
 *
 * 4. **Flooding the dashboard.** Fifty people on a monthly cadence arrive as
 *    fifty overdue faces — the ORB-73 PRD's "contacts with no conversation
 *    clutter Reach out next" risk, at fifty times the scale. No schedule is the
 *    default and that is asserted.
 *
 * 5. **Claiming more than happened.** A partial import must report as partial.
 */
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";
import { today } from "./helpers/dates.mjs";

const main = await loadMain();
const dom = globalThis.__dom;
const {
  parseCsv, guessColumnMap, csvRowsToContacts, findCsvDuplicates, normaliseCsvDate,
  csvImportFormHtml, wireCsvImport, normalizeContact, getHealth, needsAttention,
  openQuickAddChooser
} = main;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── The parser ────────────────────────────────────────────────────────────────
group("It parses what spreadsheets actually emit");
{
  eq("plain rows", parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  eq("a quoted field with a comma — the case a split would destroy",
    parseCsv('name,role\n"Smith, Jane",PM'), [["name", "role"], ["Smith, Jane", "PM"]]);
  eq("a doubled quote is an escaped quote",
    parseCsv('note\n"She said ""yes"""'), [["note"], ['She said "yes"']]);
  eq("a newline inside a quoted field stays in the field",
    parseCsv('note\n"line one\nline two"'), [["note"], ["line one\nline two"]]);
  eq("Windows line endings — the likeliest source of these files",
    parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  eq("a missing final newline still yields the last row",
    parseCsv("a\n1"), [["a"], ["1"]]);
  eq("blank lines are dropped, not turned into empty people",
    parseCsv("a,b\n1,2\n\n\n3,4"), [["a", "b"], ["1", "2"], ["3", "4"]]);
  eq("empty fields survive as empty", parseCsv("a,b,c\n1,,3"), [["a","b","c"], ["1","","3"]]);
  eq("an empty file is nothing at all", parseCsv(""), []);
}

// ── The guess ─────────────────────────────────────────────────────────────────
group("It guesses the columns, from what exports actually call them");
{
  const m = guessColumnMap(["Full Name", "Job Title", "Company", "Email Address"]);
  eq("name", m.name, 0);
  eq("role", m.role, 1);
  eq("company", m.company, 2);
  eq("email", m.email, 3);
}
{
  const m = guessColumnMap(["First Name", "Last Name", "Position", "Current Company"]);
  eq("a split name is recognised as two columns", [m.first, m.last], [0, 1]);
  eq("and there is no single name column to find", m.name, undefined);
  eq("LinkedIn's wording for role", m.role, 2);
  eq("and for company", m.company, 3);
}
{
  // The failure this prevents: a partial match claiming a column an exact match
  // wanted. "Company Size" contains "company" and comes first.
  const m = guessColumnMap(["Company Size", "Company"]);
  eq("exact matches are resolved before partial ones", m.company, 1);
}
{
  const m = guessColumnMap(["name", "unrelated", "vibes"]);
  eq("a column it cannot place is left alone", m.role, undefined);
  eq("and no field is mapped twice", new Set(Object.values(m)).size, Object.values(m).length);
}
{
  const m = guessColumnMap(["Name", "Notes", "Date Met", "Sector"]);
  eq("notes", m.notes, 1);
  eq("when you met", m.dateMet, 2);
  eq("industry, under another name", m.industry, 3);
}

// ── Dates ─────────────────────────────────────────────────────────────────────
group("A date it cannot read becomes nothing, never today");
{
  eq("ISO passes through", normaliseCsvDate("2026-03-14"), "2026-03-14");
  eq("and a timestamp is trimmed to the day", normaliseCsvDate("2026-03-14T09:00:00Z"), "2026-03-14");
  eq("US slashes", normaliseCsvDate("3/14/2026"), "2026-03-14");
  eq("two-digit years", normaliseCsvDate("3/14/26"), "2026-03-14");
  // ORB-73: a guessed date is indistinguishable from a known one once stored,
  // and dateMet anchors a cadence.
  eq("prose is not a date", normaliseCsvDate("last spring"), "");
  eq("nor is a quarter", normaliseCsvDate("Q3"), "");
  eq("empty stays empty", normaliseCsvDate(""), "");
  ok("and nothing ever becomes today", normaliseCsvDate("whenever") !== today());
}

// ── Rows to people ────────────────────────────────────────────────────────────
group("Fifty rows is not fifty conversations");
{
  const headers = ["Name", "Title", "Company"];
  const rows = [["Marcus Chen", "PM", "Stripe"]];
  const [p] = csvRowsToContacts(headers, rows, guessColumnMap(headers));
  eq("the fields land", [p.name, p.role, p.company], ["Marcus Chen", "PM", "Stripe"]);
  eq("with no conversation invented", p.interactions.length, 0);
  eq("no cadence by default", p.followUpFrequency, "none");
  eq("and no reminder", p.reminderEnabled, false);
  eq("a spreadsheet does not star anyone", normalizeContact(p).starred, false);
  eq("nor assign a tier", normalizeContact(p).tier, "");
}
{
  const headers = ["First Name", "Last Name", "Company"];
  const rows = [["Marcus", "Chen", "Stripe"], ["Priya", "", "Ramp"]];
  const out = csvRowsToContacts(headers, rows, guessColumnMap(headers));
  eq("a split name is joined", out[0].name, "Marcus Chen");
  eq("and a missing half does not leave a trailing space", out[1].name, "Priya");
}
{
  const headers = ["Name", "Company"];
  const rows = [["", "Stripe"], ["   ", "Ramp"], ["Real Person", "Ramp"]];
  const out = csvRowsToContacts(headers, rows, guessColumnMap(headers));
  eq("a row with no name is not a person", out.length, 1);
  eq("the real one survives", out[0].name, "Real Person");
}
{
  const headers = ["Name"];
  const out = csvRowsToContacts(headers, [["Marcus Chen"]], { name: 0 }, { frequency: "monthly" });
  eq("a cadence is applied to everyone when one is chosen", out[0].followUpFrequency, "monthly");
  eq("and reminders come on with it", out[0].reminderEnabled, true);
}
{
  // Deliberately unmapped columns must not leak into the wrong field.
  const headers = ["Name", "Salary", "Notes"];
  const [p] = csvRowsToContacts(headers, [["Marcus Chen", "180000", "Met at a talk"]],
    { name: 0, notes: 2 });
  eq("only mapped columns are read", p.notes, "Met at a talk");
  ok("and the unmapped one appears nowhere",
    !JSON.stringify(p).includes("180000"));
}

group("Duplicates are surfaced, not merged and not silently added");
{
  const people = [{ name: "Marcus Chen" }, { name: "Priya Raman" }];
  const dupes = findCsvDuplicates(people, [normalizeContact({ id: "x", name: "marcus chen" })]);
  eq("matched case-insensitively, like the rest of the app", [...dupes], [0]);
}
{
  // An export that lists someone twice is common, and neither copy should win
  // silently.
  const dupes = findCsvDuplicates(
    [{ name: "Marcus Chen" }, { name: "Marcus Chen" }, { name: "Other" }], []);
  eq("a repeat inside the same file counts too", [...dupes], [1]);
}

// ── The screen ────────────────────────────────────────────────────────────────
function mount(existing = []) {
  document.body.innerHTML = '<div id="host"></div>';
  const host = document.getElementById("host");
  host.innerHTML = csvImportFormHtml();
  wireCsvImport(host, () => existing, async () => {});
  return { host, $: (s) => host.querySelector(s) };
}

/** The file input, with a real File — this is what the code actually reads. */
async function load(host, text) {
  const input = host.querySelector(".csv-file");
  const file = new dom.window.File([text], "contacts.csv", { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await tick();
}

const CSV = 'Full Name,Job Title,Company,Email\n'
  + '"Smith, Jane",PM,Stripe,jane@stripe.com\n'
  + 'Marcus Chen,Engineer,Ramp,marcus@ramp.com\n';

group("Nothing is written before a preview exists");
{
  resetState();
  const { host, $ } = mount();
  ok("no mapping before a file", $(".csv-mapping").classList.contains("hidden"));
  ok("no preview", $(".csv-preview").classList.contains("hidden"));
  ok("and no way to submit", $(".csv-submit").classList.contains("hidden"));

  await load(host, CSV);
  ok("the mapping appears", !$(".csv-mapping").classList.contains("hidden"));
  ok("so does the preview", !$(".csv-preview").classList.contains("hidden"));
  ok("and only now the button", !$(".csv-submit").classList.contains("hidden"));
  eq("still nothing saved", state.saves.length, 0);
}
{
  resetState();
  const { host, $ } = mount();
  await load(host, CSV);
  ok("the preview names the people", /Smith, Jane/.test($(".csv-preview").textContent));
  ok("with their role and company", /PM at Stripe/.test($(".csv-preview").textContent));
  ok("and counts them", /2 to add/.test($(".csv-preview").textContent));
  ok("the button says how many", /Import 2 people/.test($(".csv-submit").textContent));
}
{
  resetState();
  const { host, $ } = mount();
  await load(host, "Name\n");
  ok("a header with no rows is refused", /no rows/.test($(".csv-error").textContent));
  ok("and nothing is offered", $(".csv-submit").classList.contains("hidden"));
}
{
  resetState();
  const { host, $ } = mount([normalizeContact({ id: "x", name: "Marcus Chen" })]);
  await load(host, CSV);
  ok("someone already in the network is counted as skipped",
    /1 already in your network, skipped/.test($(".csv-preview").textContent));
  ok("and only the rest are offered", /Import 1 person/.test($(".csv-submit").textContent));
}
{
  resetState();
  const { host, $ } = mount();
  await load(host, "Name,Company\n,Stripe\nReal Person,Ramp\n");
  ok("nameless rows are reported rather than dropped in silence",
    /1 row with no name, skipped/.test($(".csv-preview").textContent));
}

group("The guess is correctable, and correcting it re-previews");
{
  resetState();
  const { host, $ } = mount();
  await load(host, "Alpha,Beta\nMarcus Chen,Engineer\n");
  // Neither header is recognisable, so nothing is guessed and nothing is offered.
  ok("an unguessable file offers nothing to import",
    /Nothing to add/.test($(".csv-preview").textContent));

  const sel = host.querySelector('[data-csv-field="name"]');
  sel.value = "0";
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await tick(0);
  ok("pointing at the name column fixes it", /Marcus Chen/.test($(".csv-preview").textContent));
  ok("and the count follows", /1 to add/.test($(".csv-preview").textContent));
}

group("Importing");
{
  resetState();
  const { host, $ } = mount();
  await load(host, CSV);
  $(".csv-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(60);

  eq("both people are saved", state.store.size, 2);
  const saved = [...state.store.values()];
  ok("the quoted name survived the parser", saved.some((c) => c.name === "Smith, Jane"));
  ok("nobody has a conversation", saved.every((c) => c.interactions.length === 0));
  ok("nobody has a last-contacted date — a row is not a conversation",
    saved.every((c) => !c.lastContacted));
  ok("nobody is starred", saved.every((c) => c.starred === false));
  ok("and it is confirmed", /Added 2 people/.test(document.querySelector(".toast")?.textContent || ""));
}
{
  // The flooding case. Fifty people on a cadence would arrive as fifty overdue
  // faces on the dashboard.
  resetState();
  const { host, $ } = mount();
  await load(host, CSV);
  eq("no schedule is the default", $(".csv-freq").value, "none");
  $(".csv-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(60);
  eq("so nobody lands on Reach out next", needsAttention([...state.store.values()]).length, 0);
  ok("and none of them reads as overdue",
    [...state.store.values()].every((c) => getHealth(c).band === "none"));
}
{
  resetState();
  const { host, $ } = mount();
  await load(host, CSV);
  $(".csv-freq").value = "monthly";
  $(".csv-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(60);
  const saved = [...state.store.values()];
  ok("choosing a cadence applies it to everyone",
    saved.every((c) => c.followUpFrequency === "monthly"));
  ok("with the grace window, not an instant overdue",
    saved.every((c) => getHealth(c).band !== "critical"));
}
{
  resetState();
  state.failSave = true;
  const { host, $ } = mount();
  await load(host, CSV);
  $(".csv-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await tick(60);
  eq("a total failure saves nothing", state.store.size, 0);
  ok("and says so rather than claiming success",
    /refused every row/.test($(".csv-error").textContent));
  state.failSave = false;
}

group("Other people's text is still other people's text");
{
  resetState();
  const { host, $ } = mount();
  await load(host, 'Name,Company\n"<img src=x onerror=alert(1)>",Stripe\n');
  const html = $(".csv-preview").innerHTML;
  ok("the preview escapes it", !/<img/.test(html));
  ok("visibly", /&lt;img/.test(html));
  ok("and no element was created", !$(".csv-preview").querySelector("img"));
}

group("It is reachable from the + on every page");
{
  document.getElementById("quickAddChooser")?.remove();
  document.getElementById("csvImportModal")?.remove();
  openQuickAddChooser([], () => {});
  const opts = [...document.querySelectorAll(".chooser-option")];
  eq("four ways in", opts.length, 4);
  const importer = opts.find((o) => /spreadsheet/i.test(o.textContent));
  ok("importing is one of them", importer);
  importer.click();
  ok("it opens the importer", document.getElementById("csvImportModal"));
  ok("headed by the words it was chosen with",
    /Import from a spreadsheet/.test(document.querySelector("#csvImportModal h3").textContent));
  document.getElementById("csvImportModal").remove();
}

done();
