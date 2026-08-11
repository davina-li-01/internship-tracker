/**
 * The digest arrives at 9am in the READER's morning (ORB-16/ORB-27).
 *
 * Imports the Edge Function's logic straight from the .ts — node strips the
 * type annotations, so this is the shipping file rather than a copy of it. The
 * Deno suite alongside it covers the same module; this one exists so the
 * timezone rules run in the same command as everything else.
 *
 * Two bugs are pinned here, and the second is the quiet one:
 *
 *   1. pg_cron is UTC-only, so one daily fire meant a nudge at 2:30am for
 *      anyone far enough west. The cron runs hourly now and the function
 *      decides whose hour it is.
 *
 *   2. "Who is overdue" is a DATE comparison, and the date came from UTC. At
 *      9am local in a zone far enough east the UTC date has not rolled over,
 *      so a contact due today would not be found at all. Same shape as the
 *      todayDateString() bug in the browser, reached by another route.
 */
import { eq, ok, group, done } from "./helpers/assert.mjs";

const R = await import("../supabase/functions/send-reminders/reminders.ts");

const prefs = (over = {}) => ({
  user_id: "u1", your_name: "Davina", your_email: "d@e.com",
  email_reminders: "fortnightly", last_reminder_sent_at: null, timezone: "UTC", ...over
});

const contact = (over = {}) => ({
  id: "c1", user_id: "u1", name: "Marcus Chen", role: "Engineer", company: "Stripe",
  next_reminder: "2026-08-01", last_nudged_at: null, nudge_streak: 0, ...over
});

function harness(users, contactsByUser, now) {
  const sent = [];
  return {
    sent,
    deps: {
      now,
      appUrl: "https://orbit.test/",
      listOptedInUsers: async () => users,
      listDueContacts: async (userId, today) =>
        (contactsByUser[userId] || []).filter((c) => c.next_reminder <= today),
      lookupAuthEmail: async () => "fallback@e.com",
      sendEmail: async (to, subject) => { sent.push({ to, subject }); },
      stampContacts: async () => {},
      stampUser: async () => {}
    }
  };
}

group("Local date and hour, from one formatter call");
// 19:00 UTC is exactly 9am in Honolulu.
const T = new Date("2026-08-10T19:00:00Z");
eq("Honolulu is at the send hour", R.zonedNow(T, "Pacific/Honolulu").hour, R.SEND_HOUR);
eq("and on its own date", R.zonedNow(T, "Pacific/Honolulu").date, "2026-08-10");
eq("New York is six hours further on", R.zonedNow(T, "America/New_York").hour, 15);
eq("Tokyo has already turned over", R.zonedNow(T, "Asia/Tokyo").date, "2026-08-11");

group("An unusable zone costs one person their hour, not everyone their email");
for (const bad of ["Not/AZone", "", null, undefined, "   "]) {
  eq(JSON.stringify(bad) + " falls back to UTC", R.zonedNow(T, bad).zone, "UTC");
}
eq("and still reports a usable date", R.zonedNow(T, "Not/AZone").date, "2026-08-10");

group("The date bug: east of UTC, 9am local is still yesterday in UTC");
// 9am in Auckland (UTC+12) on the 11th is 21:00 UTC on the 10th.
const AKL = new Date("2026-08-10T21:00:00Z");
eq("UTC would say the 10th", AKL.toISOString().slice(0, 10), "2026-08-10");
eq("their day is the 11th", R.zonedNow(AKL, "Pacific/Auckland").date, "2026-08-11");
eq("and it is their send hour", R.zonedNow(AKL, "Pacific/Auckland").hour, R.SEND_HOUR);

// The consequence, end to end: someone due on the 11th must be found.
const dueToday = { u1: [contact({ next_reminder: "2026-08-11" })] };
const akl = harness([prefs({ timezone: "Pacific/Auckland" })], dueToday, AKL);
const aklOut = await R.runReminders(akl.deps, false);
eq("a contact due on their today is emailed about", akl.sent.length, 1);
ok("and not skipped as 'nothing due'", !JSON.stringify(aklOut).includes("nothing due"));

group("Hourly cron, one email");
const at = (iso) => new Date(iso);
for (const [hourUtc, expected] of [
  ["2026-08-10T19:00:00Z", 1],  // 9am Honolulu
  ["2026-08-10T18:00:00Z", 0],  // 8am
  ["2026-08-10T20:00:00Z", 0],  // 10am
  ["2026-08-10T09:00:00Z", 0]   // 11pm the night before
]) {
  const h = harness([prefs({ timezone: "Pacific/Honolulu" })],
    { u1: [contact()] }, at(hourUtc));
  await R.runReminders(h.deps, false);
  eq(hourUtc + " -> " + expected + " email", h.sent.length, expected);
}

group("Two readers, two mornings, one cron");
const both = harness(
  [prefs({ user_id: "u1", timezone: "Pacific/Honolulu", your_email: "hi@hnl" }),
   prefs({ user_id: "u2", timezone: "America/New_York", your_email: "hi@nyc" })],
  { u1: [contact()], u2: [contact({ id: "c2", user_id: "u2" })] },
  T
);
await R.runReminders(both.deps, false);
eq("only the one whose 9am it is gets mail", both.sent.map((s) => s.to), ["hi@hnl"]);

group("A dry run answers at any hour");
// Otherwise ?dry=1 would only be usable for sixty minutes a day, in a timezone
// that is not necessarily the one you are standing in.
const dry = harness([prefs({ timezone: "Pacific/Honolulu" })],
  { u1: [contact()] }, at("2026-08-10T02:00:00Z"));
const report = await R.runReminders(dry.deps, true);
ok("it reports what it would send", JSON.stringify(report).includes("wouldSend"));
eq("without sending anything", dry.sent.length, 0);

group("The fortnight still governs, hour gate or not");
const recent = harness(
  [prefs({ timezone: "Pacific/Honolulu", last_reminder_sent_at: "2026-08-04T19:00:00Z" })],
  { u1: [contact()] }, T
);
const out = await R.runReminders(recent.deps, false);
eq("six days after the last one, nothing goes", recent.sent.length, 0);
ok("and it says why", JSON.stringify(out).includes("within period"));

group("Nothing due does not consume the fortnight");
const quiet = harness([prefs({ timezone: "Pacific/Honolulu" })],
  { u1: [contact({ next_reminder: "2026-12-01" })] }, T);
const quietOut = await R.runReminders(quiet.deps, false);
eq("no email", quiet.sent.length, 0);
ok("skipped as nothing due, not as a send", JSON.stringify(quietOut).includes("nothing due"));

done();
