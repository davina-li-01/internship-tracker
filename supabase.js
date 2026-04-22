import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://kctmclcjqpytswwyewti.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjdG1jbGNqcXB5dHN3d3lld3RpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NzEyMDMsImV4cCI6MjA5MjQ0NzIwM30.ujf0ntTY3jwByg-4dE2tl1lHMTrbsygflj0a2_ZZprs";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
