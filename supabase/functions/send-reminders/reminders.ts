/**
 * Orbit — reach-out reminder digest logic (ORB-16)
 *
 * Kept separate from index.ts, which is only the server wrapper, so all of this
 * can be tested without a network or a database. That matters more here than
 * anywhere else in the app: this code runs unattended, hourly, with nobody
 * watching, so a bug does not show up as a broken page — it shows up as silence,
 * or as somebody's inbox filling with guilt.
 *
 * Two rules shape the whole thing:
 *
 *   1. ONE EMAIL, NOT ONE PER PERSON. Five overdue connections must produce one
 *      digest listing five names. Anything else trains you to ignore it.
 *
 *   2. IT NEVER RECOMPUTES HEALTH. `contacts.next_reminder` is the deadline the
 *      app already calculated and stored, so the only question here is whether
 *      that date has passed. Re-deriving bands, grace windows and intervals in
 *      TypeScript is how the email would end up disagreeing with the dashboard.
 */

/**
 * The rhythm (ORB-27).
 *
 * The first version emailed whenever someone crossed their deadline, then
 * fought the consequences with a per-contact cool-off and a per-user throttle.
 * Event-driven delivery arrives unpredictably, so it can never become a habit —
 * it can only ever interrupt, and interruption is what gets email muted.
 *
 * A fixed period fixes that structurally: one email per fortnight, by
 * construction rather than by throttling, containing whoever is drifting at
 * that moment. The schedule IS the grouping, so no batching heuristic is
 * needed.
 *
 * The rhythm anchors itself. Fourteen days is exactly two weeks, so once the
 * first digest goes out on a Tuesday, every subsequent one is a Tuesday —
 * without this function having to pick a weekday on anyone's behalf. It does
 * now know about timezones, but only to choose the HOUR (see SEND_HOUR); the
 * fortnightly spacing is still what makes it a rhythm.
 */
export const PERIOD_DAYS = 14;

/** Most names in one email. A wall of them is a guilt trip, not a priority list. */
export const MAX_PER_DIGEST = 8;

/**
 * The hour, in the READER's timezone, that a digest goes out.
 *
 * The job used to run once a day at 13:00 UTC for everyone, which is a fine
 * mid-morning in London and half past two in the morning in Honolulu. A nudge
 * that lands overnight is read the next day with everything else — the whole
 * point of a fixed rhythm is that it arrives when you can act on it.
 *
 * The cron runs hourly now and this gate decides whose turn it is. Nine is
 * early enough to catch the start of a working day and late enough not to be
 * the first thing on a phone at dawn.
 */
export const SEND_HOUR = 9;

/**
 * The reader's local date and hour.
 *
 * Both, and from one formatter call, because they have to agree. `today` is
 * what decides who is overdue, and taking it from UTC while sending at 9am
 * local puts it a day out for every zone far enough east — a contact due today
 * simply would not be found. This is the same fault that once made
 * `todayDateString()` stamp tomorrow's date in the browser, arriving by a
 * different route.
 *
 * en-CA gives ISO-ordered date parts, which is the only reason it is used.
 * An unusable timezone falls back to UTC rather than skipping the user: a bad
 * string in one row should cost that person a well-timed email, not every email.
 */
export function zonedNow(now: Date, timeZone: string | null | undefined) {
  const zone = (timeZone || "").trim() || "UTC";
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", hour12: false
      }).formatToParts(now).map((p) => [p.type, p.value])
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      // Some engines render midnight as "24" under hour12:false.
      hour: Number(parts.hour) % 24,
      zone
    };
  } catch {
    return { date: now.toISOString().slice(0, 10), hour: now.getUTCHours(), zone: "UTC" };
  }
}

/**
 * After this many consecutive digests, a name stops being listed.
 *
 * Repeating someone you have ignored three times is nagging, and by then the
 * problem has changed: it is no longer that you forgot, it is that you said
 * monthly and meant quarterly. So they collapse into one line pointing at the
 * cadence, which is a settings fix rather than a guilt trip.
 */
export const CHRONIC_AFTER = 3;

export type Contact = {
  id: string;
  user_id: string;
  name: string | null;
  role: string | null;
  company: string | null;
  next_reminder: string | null;
  last_nudged_at: string | null;
  nudge_streak: number | null;
};

export type Prefs = {
  user_id: string;
  your_name: string | null;
  your_email: string | null;
  email_reminders: string | null;
  last_reminder_sent_at: string | null;
  /** IANA name, e.g. "Pacific/Honolulu". Null or unknown is treated as UTC. */
  timezone: string | null;
};

export type Ranked = { contact: Contact; days: number; streak: number };

/** What one digest contains: names to act on, plus a count of the chronic ones. */
export type Digest = { shown: Ranked[]; held: number; chronic: Ranked[] };

export type Deps = {
  /** Users who have opted in. */
  listOptedInUsers: () => Promise<Prefs[]>;
  /** Contacts past their deadline, soonest first. */
  listDueContacts: (userId: string, today: string) => Promise<Contact[]>;
  /** The address they signed up with, used when Settings has no contact email. */
  lookupAuthEmail: (userId: string) => Promise<string>;
  sendEmail: (to: string, subject: string, text: string, html: string) => Promise<void>;
  stampContacts: (updates: { id: string; streak: number }[], at: string) => Promise<void>;
  stampUser: (userId: string, at: string) => Promise<void>;
  now: Date;
  appUrl: string;
};

export const daysBetween = (a: Date, b: Date) =>
  Math.floor((a.getTime() - b.getTime()) / 86_400_000);

export function overdueLabel(days: number): string {
  if (days <= 0) return "due today";
  if (days === 1) return "1 day overdue";
  if (days < 14) return `${days} days overdue`;
  if (days < 60) return `${Math.floor(days / 7)} weeks overdue`;
  return `${Math.floor(days / 30)} months overdue`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function describe(c: Contact): string {
  const role = (c.role || "").trim();
  const company = (c.company || "").trim();
  if (role && company) return `${role} at ${company}`;
  return role || company || "";
}

/**
 * Is this user opted in?
 *
 * 'daily' and 'weekly' are legacy values from before ORB-27 and are honoured as
 * opted-in rather than silently switched off — a migration that stops someone's
 * email without telling them is worse than one that changes its rhythm.
 */
export function isOptedIn(mode: string | null): boolean {
  return mode === "fortnightly" || mode === "weekly" || mode === "daily";
}

/**
 * Rank everyone overdue, carrying how many digests running they have appeared in.
 *
 * A streak only continues if the last nudge was recent. Someone who lapsed,
 * was contacted, and drifted again starts from one — they are not a chronic
 * case, they are a normal one that came back around.
 */
export function rankOverdue(due: Contact[], now: Date): Ranked[] {
  return due
    .filter((c) => Boolean(c.next_reminder))
    .map((contact) => {
      const sinceNudge = contact.last_nudged_at
        ? daysBetween(now, new Date(contact.last_nudged_at))
        : Infinity;
      const continuing = sinceNudge <= PERIOD_DAYS * 2;
      return {
        contact,
        days: daysBetween(now, new Date(contact.next_reminder + "T00:00:00Z")),
        streak: continuing ? (contact.nudge_streak || 0) + 1 : 1
      };
    })
    // Most overdue first — the digest is a priority list, not a dump.
    .sort((a, b) => b.days - a.days);
}

/** Split the ranked list into what gets named and what gets summarised. */
export function buildDigest(ranked: Ranked[]): Digest {
  const chronic = ranked.filter((r) => r.streak > CHRONIC_AFTER);
  const fresh = ranked.filter((r) => r.streak <= CHRONIC_AFTER);
  return {
    shown: fresh.slice(0, MAX_PER_DIGEST),
    held: Math.max(0, fresh.length - MAX_PER_DIGEST),
    chronic
  };
}

export function buildEmail(
  name: string,
  rows: Ranked[],
  hiddenCount: number,
  appUrl: string,
  chronicCount = 0
): { subject: string; text: string; html: string } {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const count = rows.length;
  const subject = count === 1
    ? `Reach out to ${rows[0].contact.name || "someone"}`
    : `${count} people to reach out to`;

  const lead = count === 1
    ? "One person in your orbit is drifting."
    : `${count} people in your orbit are drifting.`;

  const text = [
    greeting,
    "",
    lead,
    "",
    ...rows.map(({ contact, days }) => {
      const detail = describe(contact);
      return `• ${contact.name || "Unnamed"}${detail ? ` — ${detail}` : ""} (${overdueLabel(days)})`;
    }),
    ...(hiddenCount > 0 ? ["", `…and ${hiddenCount} more waiting.`] : []),
    ...(chronicCount > 0 ? ["",
      `${chronicCount} ${chronicCount === 1 ? "person has" : "people have"} been overdue `
      + "for a while now — the cadence you set for them may be wrong."] : []),
    "",
    `Open Orbit: ${appUrl}`,
    "",
    "To stop these, set Notifications → Email reminders to Never in Orbit's settings."
  ].join("\n");

  const htmlRows = rows.map(({ contact, days }) => {
    const detail = describe(contact);
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #EEE8E0;">
        <div style="font-weight:600;color:#1C1917;font-size:15px;">${escapeHtml(contact.name || "Unnamed")}</div>
        ${detail ? `<div style="color:#78716C;font-size:13px;margin-top:2px;">${escapeHtml(detail)}</div>` : ""}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #EEE8E0;text-align:right;white-space:nowrap;color:#B45309;font-size:13px;font-weight:600;">
        ${escapeHtml(overdueLabel(days))}
      </td>
    </tr>`;
  }).join("");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#FAF6F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#FFFCF8;border-radius:16px;padding:28px;">
    <!-- Wordmark only. The ◍ glyph used in the app falls back to whatever font
         the mail client has and rendered as the wrong shape entirely. -->
    <div style="font-size:18px;font-weight:700;color:#EA580C;letter-spacing:-0.01em;">Orbit</div>
    <p style="color:#57534E;font-size:15px;line-height:1.5;margin:20px 0 4px;">${escapeHtml(greeting)}</p>
    <p style="color:#57534E;font-size:15px;line-height:1.5;margin:0 0 20px;">${escapeHtml(lead)}</p>
    <table style="width:100%;border-collapse:collapse;">${htmlRows}</table>
    ${hiddenCount > 0
      ? `<p style="color:#A8A29E;font-size:13px;margin:14px 0 0;">…and ${hiddenCount} more waiting.</p>`
      : ""}
    ${chronicCount > 0
      ? `<p style="color:#78716C;font-size:13px;line-height:1.5;margin:14px 0 0;padding:10px 12px;`
        + `background:#F5EDE3;border-radius:8px;">`
        + `<strong>${chronicCount} ${chronicCount === 1 ? "person has" : "people have"} been overdue for a while.</strong> `
        + `The cadence you set for them may be wrong — worth changing it rather than `
        + `seeing them here again.</p>`
      : ""}
    <a href="${escapeHtml(appUrl)}"
       style="display:inline-block;margin-top:24px;background:#F97316;color:#fff;text-decoration:none;
              padding:11px 22px;border-radius:10px;font-weight:600;font-size:14px;">Open Orbit</a>
    <p style="color:#A8A29E;font-size:12px;line-height:1.5;margin:24px 0 0;">
      To stop these, set Notifications → Email reminders to <strong>Never</strong> in Orbit's settings.
    </p>
  </div>
</body></html>`;

  return { subject, text, html };
}

export type UserResult =
  | { user: string; skipped: string; detail?: number | string }
  | { user: string; error: string }
  | { user: string; wouldSend: { to: string; subject: string; names: (string | null)[] } }
  | { user: string; sent: number; held: number; to: string };

/**
 * One pass over every opted-in user. Returns a report rather than throwing, so
 * one user's broken state cannot stop everyone else's reminders.
 */
export async function runReminders(deps: Deps, dryRun = false): Promise<UserResult[]> {
  const results: UserResult[] = [];

  for (const prefs of await deps.listOptedInUsers()) {
    if (!isOptedIn(prefs.email_reminders)) {
      results.push({ user: prefs.user_id, skipped: "reminders off" });
      continue;
    }

    // Everything below is decided in the reader's own day, not the server's.
    const local = zonedNow(deps.now, prefs.timezone);
    const today = local.date;

    // The cron fires hourly; this is what makes it one email a fortnight
    // rather than 24. A dry run deliberately ignores it — the point of ?dry=1
    // is to see what would be sent, and making that only answerable at 9am in
    // your own timezone would be a poor way to test a mail job.
    if (!dryRun && local.hour !== SEND_HOUR) {
      results.push({ user: prefs.user_id, skipped: "not their hour", detail: `${local.hour}:00 ${local.zone}` });
      continue;
    }

    // The whole throttle, in one check. One email per period, by construction.
    // Because the period is exactly two weeks, the rhythm anchors itself to
    // whatever weekday the first digest landed on and stays there.
    if (prefs.last_reminder_sent_at) {
      const since = daysBetween(deps.now, new Date(prefs.last_reminder_sent_at));
      if (since < PERIOD_DAYS) {
        results.push({ user: prefs.user_id, skipped: "within period", detail: since });
        continue;
      }
    }

    let due: Contact[];
    try {
      due = await deps.listDueContacts(prefs.user_id, today);
    } catch (err) {
      results.push({ user: prefs.user_id, error: String(err) });
      continue;
    }

    const ranked = rankOverdue(due, deps.now);
    if (!ranked.length) {
      // Nothing to say. Deliberately does NOT stamp the period — an empty
      // fortnight should not push the next digest two weeks further out.
      results.push({ user: prefs.user_id, skipped: "nothing due" });
      continue;
    }

    const digest = buildDigest(ranked);
    if (!digest.shown.length && !digest.chronic.length) {
      results.push({ user: prefs.user_id, skipped: "nothing to say" });
      continue;
    }

    let to = (prefs.your_email || "").trim();
    if (!to) {
      try {
        to = await deps.lookupAuthEmail(prefs.user_id);
      } catch {
        to = "";
      }
    }
    if (!to) {
      results.push({ user: prefs.user_id, error: "no email address on file" });
      continue;
    }

    // Everyone chronic and nobody fresh means the only thing to say is "your
    // cadences are wrong", which is not worth an email of its own every
    // fortnight. It rides along with real names or it waits.
    if (!digest.shown.length) {
      results.push({ user: prefs.user_id, skipped: "only chronic overdue" });
      continue;
    }

    const { subject, text, html } = buildEmail(
      prefs.your_name || "", digest.shown, digest.held, deps.appUrl, digest.chronic.length
    );

    if (dryRun) {
      results.push({
        user: prefs.user_id,
        wouldSend: { to, subject, names: digest.shown.map((s) => s.contact.name) }
      });
      continue;
    }

    try {
      await deps.sendEmail(to, subject, text, html);
    } catch (err) {
      // Nothing is stamped, so the next run tries these same people again.
      results.push({ user: prefs.user_id, error: String(err) });
      continue;
    }

    // Streaks advance for everyone the digest accounted for, named or
    // summarised — a chronic case that was counted has still been reported.
    // Names held back by MAX_PER_DIGEST are NOT stamped: they were never
    // mentioned, so their streak must not advance on their behalf.
    const at = deps.now.toISOString();
    await deps.stampContacts(
      [...digest.shown, ...digest.chronic].map((r) => ({ id: r.contact.id, streak: r.streak })),
      at
    );
    await deps.stampUser(prefs.user_id, at);

    results.push({
      user: prefs.user_id,
      sent: digest.shown.length,
      held: digest.held,
      to
    });
  }

  return results;
}
