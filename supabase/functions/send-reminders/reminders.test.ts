/**
 * Tests for the reminder digest (ORB-16).
 *
 * Run: deno test --allow-none supabase/functions/send-reminders/reminders.test.ts
 *
 * This code runs unattended with nobody watching, so the failure modes worth
 * guarding are the quiet ones: emailing the same person every day, sending five
 * emails instead of one digest, or silently stamping someone as nudged when
 * they were never mentioned.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildDigest, buildEmail, describe, isOptedIn, overdueLabel, rankOverdue,
  runReminders, CHRONIC_AFTER, MAX_PER_DIGEST, PERIOD_DAYS,
  type Contact, type Deps, type Prefs
} from "./reminders.ts";

const NOW = new Date("2026-08-09T13:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const dateAgo = (n: number) => daysAgo(n).slice(0, 10);

function contact(over: Partial<Contact> = {}): Contact {
  return {
    id: "c1", user_id: "u1", name: "Marcus Chen", role: "PM", company: "Stripe",
    next_reminder: dateAgo(3), last_nudged_at: null, nudge_streak: 0, ...over
  };
}
function prefs(over: Partial<Prefs> = {}): Prefs {
  return {
    user_id: "u1", your_name: "Davina", your_email: "davina@example.com",
    email_reminders: "fortnightly", last_reminder_sent_at: null, ...over
  };
}

type Sent = { to: string; subject: string; text: string };
function harness(users: Prefs[], contactsByUser: Record<string, Contact[]>) {
  const sent: Sent[] = [];
  const stampedContacts: { id: string; streak: number }[] = [];
  const stampedUsers: string[] = [];
  const deps: Deps = {
    now: NOW,
    appUrl: "https://orbit.test/",
    listOptedInUsers: () => Promise.resolve(users),
    listDueContacts: (userId, today) =>
      Promise.resolve((contactsByUser[userId] || [])
        .filter((c) => c.next_reminder !== null && c.next_reminder <= today)),
    lookupAuthEmail: () => Promise.resolve("fallback@example.com"),
    sendEmail: (to, subject, text) => { sent.push({ to, subject, text }); return Promise.resolve(); },
    stampContacts: (updates) => { stampedContacts.push(...updates); return Promise.resolve(); },
    stampUser: (id) => { stampedUsers.push(id); return Promise.resolve(); }
  };
  return { deps, sent, stampedContacts, stampedUsers };
}

// ── Labels ────────────────────────────────────────────────────────────────────

Deno.test("overdue labels stay readable as the gap grows", () => {
  assertEquals(overdueLabel(0), "due today");
  assertEquals(overdueLabel(-2), "due today");   // clock skew must not say "-2 days overdue"
  assertEquals(overdueLabel(1), "1 day overdue");
  assertEquals(overdueLabel(5), "5 days overdue");
  assertEquals(overdueLabel(21), "3 weeks overdue");
  assertEquals(overdueLabel(90), "3 months overdue");
});

Deno.test("a person is described by whatever is known", () => {
  assertEquals(describe(contact()), "PM at Stripe");
  assertEquals(describe(contact({ company: null })), "PM");
  assertEquals(describe(contact({ role: null })), "Stripe");
  assertEquals(describe(contact({ role: null, company: null })), "");
  assertEquals(describe(contact({ role: "  ", company: "  " })), "");
});

// ── The fortnightly rhythm ────────────────────────────────────────────────────

Deno.test("only the three known opt-in values count", () => {
  assert(isOptedIn("fortnightly"));
  // Legacy values from before ORB-27. Honoured rather than silently switched
  // off — a migration that stops someone's email without telling them is worse
  // than one that changes its rhythm.
  assert(isOptedIn("weekly"));
  assert(isOptedIn("daily"));
  assert(!isOptedIn("off"));
  assert(!isOptedIn(null));
  assert(!isOptedIn("hourly"));
});

Deno.test("everyone overdue is ranked, most overdue first", () => {
  const ranked = rankOverdue([
    contact({ id: "a", next_reminder: dateAgo(2) }),
    contact({ id: "b", next_reminder: dateAgo(40) }),
    contact({ id: "c", next_reminder: dateAgo(9) })
  ], NOW);
  assertEquals(ranked.map((r) => r.contact.id), ["b", "c", "a"]);
});

Deno.test("a first appearance is streak 1", () => {
  assertEquals(rankOverdue([contact()], NOW)[0].streak, 1);
});

Deno.test("consecutive digests advance the streak", () => {
  const seen = contact({ nudge_streak: 2, last_nudged_at: daysAgo(PERIOD_DAYS) });
  assertEquals(rankOverdue([seen], NOW)[0].streak, 3);
});

Deno.test("someone who lapsed and came back starts again", () => {
  // Not a chronic case — a normal one that came round again. Carrying the old
  // streak would demote them to a summary line on their first reminder.
  const returning = contact({ nudge_streak: 5, last_nudged_at: daysAgo(90) });
  assertEquals(rankOverdue([returning], NOW)[0].streak, 1);
});

Deno.test("past the threshold, a name is summarised rather than listed", () => {
  const digest = buildDigest([
    { contact: contact({ id: "fresh" }), days: 5, streak: 1 },
    { contact: contact({ id: "chronic" }), days: 90, streak: CHRONIC_AFTER + 1 }
  ]);
  assertEquals(digest.shown.map((r) => r.contact.id), ["fresh"]);
  assertEquals(digest.chronic.map((r) => r.contact.id), ["chronic"]);
});

Deno.test("the threshold itself is still listed", () => {
  const digest = buildDigest([
    { contact: contact({ id: "edge" }), days: 5, streak: CHRONIC_AFTER }
  ]);
  assertEquals(digest.shown.length, 1);
  assertEquals(digest.chronic.length, 0);
});

// ── The digest ────────────────────────────────────────────────────────────────

Deno.test("five overdue people produce ONE email, not five", async () => {
  const people = ["a", "b", "c", "d", "e"].map((id, i) =>
    contact({ id, name: `Person ${id}`, next_reminder: dateAgo(i + 1) }));
  const h = harness([prefs()], { u1: people });

  const results = await runReminders(h.deps);

  assertEquals(h.sent.length, 1);
  assertEquals(h.sent[0].subject, "5 people to reach out to");
  for (const p of people) assert(h.sent[0].text.includes(p.name!));
  assertEquals(results[0], { user: "u1", sent: 5, held: 0, to: "davina@example.com" });
});

Deno.test("one overdue person gets named in the subject", async () => {
  const h = harness([prefs()], { u1: [contact()] });
  await runReminders(h.deps);
  assertEquals(h.sent[0].subject, "Reach out to Marcus Chen");
});

Deno.test("nothing due means nothing sent", async () => {
  const h = harness([prefs()], { u1: [contact({ next_reminder: "2099-01-01" })] });
  const results = await runReminders(h.deps);
  assertEquals(h.sent.length, 0);
  assertEquals(results[0], { user: "u1", skipped: "nothing due" });
});

Deno.test("nothing arrives inside the fortnight", async () => {
  const h = harness(
    [prefs({ last_reminder_sent_at: daysAgo(9) })], { u1: [contact()] });
  const results = await runReminders(h.deps);
  assertEquals(h.sent.length, 0);
  assertEquals(results[0], { user: "u1", skipped: "within period", detail: 9 });
});

Deno.test("and arrives once the fortnight is up", async () => {
  const h = harness(
    [prefs({ last_reminder_sent_at: daysAgo(PERIOD_DAYS) })], { u1: [contact()] });
  await runReminders(h.deps);
  assertEquals(h.sent.length, 1);
});

Deno.test("an empty fortnight does not push the next one further out", async () => {
  // Nothing due must not stamp the period. Otherwise a quiet fortnight would
  // silently become a month.
  const h = harness([prefs()], { u1: [contact({ next_reminder: "2099-01-01" })] });
  await runReminders(h.deps);
  assertEquals(h.stampedUsers.length, 0);
});

Deno.test("each user gets their own digest, never each other's names", async () => {
  const h = harness(
    [prefs({ user_id: "u1", your_email: "one@example.com" }),
     prefs({ user_id: "u2", your_email: "two@example.com", your_name: "Sam" })],
    {
      u1: [contact({ id: "c1", user_id: "u1", name: "Marcus Chen" })],
      u2: [contact({ id: "c2", user_id: "u2", name: "Priya Raghunathan" })]
    });

  await runReminders(h.deps);

  assertEquals(h.sent.length, 2);
  assertEquals(h.sent[0].to, "one@example.com");
  assert(h.sent[0].text.includes("Marcus Chen"));
  assert(!h.sent[0].text.includes("Priya"));
  assert(h.sent[1].text.includes("Priya Raghunathan"));
  assert(!h.sent[1].text.includes("Marcus"));
});

// ── The overflow rule ─────────────────────────────────────────────────────────

Deno.test("a long list is capped, and the overflow is NOT stamped", async () => {
  // The subtle one. Stamping someone who was never mentioned would silence them
  // for a week without the user ever having been told about them.
  const many = Array.from({ length: MAX_PER_DIGEST + 4 }, (_, i) =>
    contact({ id: `c${i}`, name: `Person ${i}`, next_reminder: dateAgo(i + 1) }));
  const h = harness([prefs()], { u1: many });

  const results = await runReminders(h.deps);

  assertEquals(h.sent.length, 1);
  assertEquals(h.stampedContacts.length, MAX_PER_DIGEST);
  assertEquals(results[0], { user: "u1", sent: MAX_PER_DIGEST, held: 4, to: "davina@example.com" });
  assert(h.sent[0].text.includes("…and 4 more waiting."));

  // The four held back are the least overdue, and none of them were stamped.
  const leastOverdue = many.slice(0, 4).map((c) => c.id);
  const stampedIds = h.stampedContacts.map((c) => c.id);
  for (const id of leastOverdue) assert(!stampedIds.includes(id));
});

// ── Stamping ──────────────────────────────────────────────────────────────────

Deno.test("a successful send stamps both the contacts and the user", async () => {
  const h = harness([prefs()], { u1: [contact({ id: "c1" }), contact({ id: "c2" })] });
  await runReminders(h.deps);
  assertEquals(h.stampedContacts.map((c) => c.id).sort(), ["c1", "c2"]);
  assertEquals(h.stampedUsers, ["u1"]);
});

Deno.test("a failed send stamps NOTHING, so the next run retries", async () => {
  const h = harness([prefs()], { u1: [contact()] });
  h.deps.sendEmail = () => Promise.reject(new Error("Resend 422"));
  const results = await runReminders(h.deps);
  assertEquals(h.stampedContacts.length, 0);
  assertEquals(h.stampedUsers.length, 0);
  assert("error" in results[0]);
});

Deno.test("one user's failure does not stop the next user's reminders", async () => {
  const h = harness(
    [prefs({ user_id: "u1" }), prefs({ user_id: "u2", your_email: "two@example.com" })],
    { u1: [contact()], u2: [contact({ id: "c2", user_id: "u2" })] });
  h.deps.listDueContacts = (userId, today) => userId === "u1"
    ? Promise.reject(new Error("boom"))
    : Promise.resolve([contact({ id: "c2", user_id: "u2" })]);

  const results = await runReminders(h.deps);

  assert("error" in results[0]);
  assertEquals(h.sent.length, 1);
  assertEquals(h.sent[0].to, "two@example.com");
});

// ── Addressing ────────────────────────────────────────────────────────────────

Deno.test("a blank contact email falls back to the sign-in address", async () => {
  const h = harness([prefs({ your_email: "  " })], { u1: [contact()] });
  await runReminders(h.deps);
  assertEquals(h.sent[0].to, "fallback@example.com");
});

Deno.test("no address anywhere reports an error rather than sending nowhere", async () => {
  const h = harness([prefs({ your_email: null })], { u1: [contact()] });
  h.deps.lookupAuthEmail = () => Promise.resolve("");
  const results = await runReminders(h.deps);
  assertEquals(h.sent.length, 0);
  assertEquals(results[0], { user: "u1", error: "no email address on file" });
});

// ── Dry run ───────────────────────────────────────────────────────────────────

Deno.test("a dry run sends nothing and stamps nothing", async () => {
  const h = harness([prefs()], { u1: [contact()] });
  const results = await runReminders(h.deps, true);
  assertEquals(h.sent.length, 0);
  assertEquals(h.stampedContacts.length, 0);
  assertEquals(h.stampedUsers.length, 0);
  assert("wouldSend" in results[0]);
});

// ── Email content ─────────────────────────────────────────────────────────────

Deno.test("names are escaped so a quote in a name cannot break the HTML", () => {
  const { html } = buildEmail("Davina",
    [{ contact: contact({ name: 'Ada <script>"O\'Neil"' }), days: 3, streak: 1 }], 0, "https://orbit.test/");
  assert(!html.includes("<script>"));
  assert(html.includes("&lt;script&gt;"));
});

Deno.test("the email always says how to stop it", () => {
  const { text, html } = buildEmail("Davina", [{ contact: contact(), days: 3, streak: 1 }], 0, "https://orbit.test/");
  assert(text.includes("Never"));
  assert(html.includes("Never"));
  assert(html.includes("https://orbit.test/"));
});

Deno.test("a missing name does not render 'null'", () => {
  const { text, subject } = buildEmail("", [{ contact: contact({ name: null }), days: 1, streak: 1 }], 0, "https://orbit.test/");
  assert(!text.includes("null"));
  assert(!subject.includes("null"));
  assert(text.startsWith("Hi,"));
});
