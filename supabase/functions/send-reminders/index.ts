/**
 * Orbit — scheduled reach-out reminders (ORB-16)
 *
 * A browser tab cannot wake up in seven days and send mail. This is the piece
 * that runs when Orbit is closed: invoked daily by pg_cron, it finds overdue
 * connections and sends each user one digest.
 *
 * This file is only the wiring — HTTP, auth, Supabase and Resend. All the
 * decisions live in reminders.ts, which has no I/O and is unit tested.
 *
 * Deployment, secrets and scheduling: docs/REMINDERS-SETUP.md
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { runReminders, type Contact, type Deps, type Prefs } from "./reminders.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });

async function sendViaResend(to: string, subject: string, text: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const from = Deno.env.get("REMINDER_FROM") || "Orbit <onboarding@resend.dev>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to, subject, text, html })
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  // This runs with the service-role key and can read every user's rows, so it
  // must never be openly invocable. pg_cron passes the shared secret.
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected) return json({ error: "CRON_SECRET is not configured" }, 500);
  if (req.headers.get("x-cron-secret") !== expected) {
    return json({ error: "unauthorized" }, 401);
  }

  // ?dry=1 reports what it would send, without sending or stamping anything.
  const dryRun = new URL(req.url).searchParams.get("dry") === "1";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const deps: Deps = {
    now: new Date(),
    appUrl: Deno.env.get("ORBIT_APP_URL") || "https://davina-li-01.github.io/orbit/",

    listOptedInUsers: async () => {
      const { data, error } = await supabase
        .from("preferences")
        .select("user_id, your_name, your_email, email_reminders, last_reminder_sent_at")
        .in("email_reminders", ["fortnightly", "weekly", "daily"]);
      if (error) throw new Error(error.message);
      return (data || []) as Prefs[];
    },

    // The only health question asked anywhere: has the stored deadline passed?
    listDueContacts: async (userId, today) => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id, user_id, name, role, company, next_reminder, last_nudged_at, nudge_streak")
        .eq("user_id", userId)
        .eq("reminder_enabled", true)
        .not("next_reminder", "is", null)
        .lte("next_reminder", today)
        .order("next_reminder", { ascending: true });
      if (error) throw new Error(error.message);
      return (data || []) as Contact[];
    },

    lookupAuthEmail: async (userId) => {
      const { data } = await supabase.auth.admin.getUserById(userId);
      return data?.user?.email || "";
    },

    sendEmail: sendViaResend,

    // Each row gets its own streak, so this cannot be one bulk update. The list
    // is capped at MAX_PER_DIGEST plus however many are chronic, so the write
    // count stays small.
    stampContacts: async (updates, at) => {
      for (const { id, streak } of updates) {
        await supabase.from("contacts")
          .update({ last_nudged_at: at, nudge_streak: streak })
          .eq("id", id);
      }
    },

    stampUser: async (userId, at) => {
      await supabase.from("preferences")
        .update({ last_reminder_sent_at: at }).eq("user_id", userId);
    }
  };

  try {
    const results = await runReminders(deps, dryRun);
    return json({ ok: true, dryRun, ranAt: deps.now.toISOString(), results });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});
