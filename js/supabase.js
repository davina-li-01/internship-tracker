/**
 * supabase.js — Supabase client singleton and auth helpers
 *
 * Exports the shared `supabase` client used by db.js and auth.html.
 * requireAuth() is called at the top of the boot IIFE in app.js to
 * redirect unauthenticated users to auth.html before any data loads.
 *
 * AI-assisted: overall structure and requireAuth pattern.
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://kctmclcjqpytswwyewti.supabase.co";

// Publishable key (new-style Supabase API key). This replaced the legacy anon
// JWT when the project migrated to the new key system — the old key stopped
// resolving to a usable role, so every request came back PGRST205 "table not
// found in the schema cache" even though the tables were there all along.
// Safe to commit: publishable keys are meant to ship in client-side code, and
// access is still enforced by Row Level Security.
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ufLO9d6dSo7y1PtkVyzp1g_6aSu8ud2";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

/** Returns the current session's user, or null */
export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/** Redirect to auth.html if not logged in */
export async function requireAuth() {
  const user = await getUser();
  if (!user) {
    window.location.href = "auth.html";
  }
  return user;
}
