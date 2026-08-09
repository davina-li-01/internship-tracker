/**
 * Orbit — reach-out reminder digest logic (ORB-16)
 *
 * Kept separate from index.ts, which is only the server wrapper, so all of this
 * can be tested without a network or a database. That matters more here than
 * anywhere else in the app: this code runs unattended at 13:00 UTC with nobody
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

/** Days before the same person may appear in another digest. */
export const CONTACT_COOLOFF_DAYS = 7;

/** Most names in one email. A wall of them is a guilt trip, not a priority list. */
export const MAX_PER_DIGEST = 8;

export type Contact = {
  id: string;
  user_id: string;
  name: string | null;
  role: string | null;
  company: string | null;
  next_reminder: string | null;
  last_nudged_at: string | null;
};

export type Prefs = {
  user_id: string;
  your_name: string | null;
  your_email: string | null;
  email_reminders: string | null;
  last_reminder_sent_at: string | null;
};

export type Ranked = { contact: Contact; days: number };

export type Deps = {
  /** Users who have opted in. */
  listOptedInUsers: () => Promise<Prefs[]>;
  /** Contacts past their deadline, soonest first. */
  listDueContacts: (userId: string, today: string) => Promise<Contact[]>;
  /** The address they signed up with, used when Settings has no contact email. */
  lookupAuthEmail: (userId: string) => Promise<string>;
  sendEmail: (to: string, subject: string, text: string, html: string) => Promise<void>;
  stampContacts: (ids: string[], at: string) => Promise<void>;
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

/** How often the digest itself may arrive, independent of the per-contact cool-off. */
export function cadenceDaysFor(mode: string | null): number | null {
  if (mode === "daily") return 1;
  if (mode === "weekly") return 7;
  return null; // 'off', null, or anything unrecognised
}

/** Contacts that are due AND out of their cool-off window. */
export function eligibleContacts(due: Contact[], now: Date): Ranked[] {
  return due
    .filter((c) => {
      if (!c.next_reminder) return false;
      if (!c.last_nudged_at) return true;
      return daysBetween(now, new Date(c.last_nudged_at)) >= CONTACT_COOLOFF_DAYS;
    })
    .map((contact) => ({
      contact,
      days: daysBetween(now, new Date(contact.next_reminder + "T00:00:00Z"))
    }))
    // Most overdue first — the digest is a priority list, not a dump.
    .sort((a, b) => b.days - a.days);
}

export function buildEmail(
  name: string,
  rows: Ranked[],
  hiddenCount: number,
  appUrl: string
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
  | { user: string; skipped: string; detail?: number }
  | { user: string; error: string }
  | { user: string; wouldSend: { to: string; subject: string; names: (string | null)[] } }
  | { user: string; sent: number; held: number; to: string };

/**
 * One pass over every opted-in user. Returns a report rather than throwing, so
 * one user's broken state cannot stop everyone else's reminders.
 */
export async function runReminders(deps: Deps, dryRun = false): Promise<UserResult[]> {
  const today = deps.now.toISOString().slice(0, 10);
  const results: UserResult[] = [];

  for (const prefs of await deps.listOptedInUsers()) {
    const cadence = cadenceDaysFor(prefs.email_reminders);
    if (cadence === null) {
      results.push({ user: prefs.user_id, skipped: "reminders off" });
      continue;
    }

    if (prefs.last_reminder_sent_at) {
      const since = daysBetween(deps.now, new Date(prefs.last_reminder_sent_at));
      if (since < cadence) {
        results.push({ user: prefs.user_id, skipped: "within cadence", detail: since });
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

    const ranked = eligibleContacts(due, deps.now);
    if (!ranked.length) {
      results.push({ user: prefs.user_id, skipped: "nothing due" });
      continue;
    }

    const shown = ranked.slice(0, MAX_PER_DIGEST);
    const held = ranked.length - shown.length;

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

    const { subject, text, html } = buildEmail(
      prefs.your_name || "", shown, held, deps.appUrl
    );

    if (dryRun) {
      results.push({
        user: prefs.user_id,
        wouldSend: { to, subject, names: shown.map((s) => s.contact.name) }
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

    // Stamp ONLY what was in the email. A name held back by MAX_PER_DIGEST has
    // not been nudged, so it must stay eligible rather than going quiet for a
    // week without anyone ever being told about it.
    const at = deps.now.toISOString();
    await deps.stampContacts(shown.map((s) => s.contact.id), at);
    await deps.stampUser(prefs.user_id, at);

    results.push({ user: prefs.user_id, sent: shown.length, held, to });
  }

  return results;
}
