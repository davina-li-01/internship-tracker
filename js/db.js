/**
 * db.js — Supabase data access layer
 *
 * Every exported function is async and scoped to the authenticated user via
 * Supabase Row Level Security (user_id = auth.uid()).
 *
 * Tables: preferences, contacts, storage_files
 * Contacts carry their interactions, company history, and follow-ups as jsonb
 * columns. Uploaded documents live in the `interntrack-files` storage bucket
 * with metadata rows in `storage_files`.
 */
import { supabase } from "./supabase.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function uid() {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id || null;
}

function dbErr(label, error) {
  console.error(`[DB] ${label}:`, error?.message || error);
  reportBackendProblem(error);
}

// ─── Backend health banner ────────────────────────────────────────────────────
// Every read path in this file returns [] or null when Supabase fails, so an
// unreachable backend renders as a normal-looking empty app with nothing but a
// console message. Surface the two failures that mean "the app cannot work"
// rather than "you have no data yet", so they can't go unnoticed.

let bannerShown = false;

function reportBackendProblem(error) {
  if (bannerShown || typeof document === "undefined") return;

  const code = error?.code || "";
  const message = String(error?.message || error || "");

  // PGRST205/42P01: table missing — schema was never created or was lost.
  // Match the table-specific phrasing only: PostgREST also says "schema cache"
  // for a missing *column*, which is a different (and much smaller) problem.
  const schemaMissing = code === "PGRST205" || code === "42P01"
    || /could not find the table/i.test(message);
  // supabase-js wraps DNS/offline failures as a generic fetch error.
  const unreachable = /failed to fetch|networkerror|fetch failed/i.test(message);

  if (!schemaMissing && !unreachable) return;
  bannerShown = true;

  const text = unreachable
    ? "Can't reach the database. The Supabase project may be paused — check your dashboard."
    : "The database is reachable but a table is missing. Check the Supabase dashboard, and that the API key in js/supabase.js is current.";

  const show = () => {
    const el = document.createElement("div");
    el.setAttribute("role", "alert");
    el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;padding:12px 16px;"
      + "background:#b42318;color:#fff;font:500 14px/1.4 Inter,system-ui,sans-serif;text-align:center";
    el.textContent = text;
    document.body.appendChild(el);
  };

  if (document.body) show();
  else document.addEventListener("DOMContentLoaded", show, { once: true });
}

// ─── Preferences ──────────────────────────────────────────────────────────────

export async function getPreferences() {
  const userId = await uid();
  if (!userId) return {};
  const { data, error } = await supabase
    .from("preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) dbErr("getPreferences", error);
  return data || {};
}

// your_email and phone are newer columns. If the database predates them the
// upsert fails with PGRST204; rather than losing the whole save we drop the
// offending key and retry, so an unrun migration costs one field, not all of them.
const OPTIONAL_PREF_COLUMNS = ["your_email", "phone", "avatar_url", "email_reminders", "timezone", "integrations"];

export async function savePreferences(updates) {
  const userId = await uid();
  if (!userId) return { ok: false, skipped: [] };

  const row = { user_id: userId, ...updates };
  const skipped = [];

  for (let attempt = 0; attempt <= OPTIONAL_PREF_COLUMNS.length; attempt++) {
    const { error } = await supabase
      .from("preferences")
      .upsert(row, { onConflict: "user_id" });

    if (!error) return { ok: true, skipped };

    const missing = OPTIONAL_PREF_COLUMNS.find(
      (col) => col in row && isMissingColumn(error, col)
    );
    if (!missing) { dbErr("savePreferences", error); return { ok: false, skipped }; }

    console.warn(
      `[DB] preferences.${missing} is missing — saving without it. ` +
      "Run supabase/add-settings-columns.sql to enable it."
    );
    delete row[missing];
    skipped.push(missing);
  }
  return { ok: false, skipped };
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export async function getContacts() {
  const userId = await uid();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) { dbErr("getContacts", error); return []; }
  return (data || []).map(rowToContact);
}

// `industry` is a newer column. If the database predates it, the first save
// fails with PGRST204 and we permanently fall back to saving without it, so a
// missing migration costs you the industry tag rather than the whole save.
let industrySupported = true;
let emailsSupported = true;

/**
 * True when `error` says this specific column is missing.
 * PostgREST names it: "Could not find the 'phone' column of 'preferences'…".
 * Matching on the name matters — keying off code PGRST204 alone would match any
 * missing column and make the retry loop drop the wrong field.
 */
function isMissingColumn(error, column) {
  const message = String(error?.message || "");
  if (new RegExp(`'${column}'`, "i").test(message)) return true;
  // Fall back to the code only when the message names no column at all.
  return error?.code === "PGRST204" && !/'[a-z_]+'/i.test(message);
}

export async function saveContact(contact) {
  const userId = await uid();
  if (!userId) return null;

  const upsert = (row) => supabase
    .from("contacts")
    .upsert(row, { onConflict: "id" })
    .select()
    .single();

  const row = contactToRow(contact, userId);
  if (!industrySupported) delete row.industry;
  if (!emailsSupported) delete row.emails;

  let { data, error } = await upsert(row);

  if (error && emailsSupported && isMissingColumn(error, "emails")) {
    console.warn(
      "[DB] contacts.emails is missing — saving only the primary address. " +
      "To store several per person run supabase/add-contact-emails.sql"
    );
    emailsSupported = false;
    delete row.emails;
    ({ data, error } = await upsert(row));
  }

  if (error && industrySupported && isMissingColumn(error, "industry")) {
    console.warn(
      "[DB] contacts.industry is missing — saving without it. To enable industry tags run:\n" +
      "     alter table public.contacts add column industry text default '';"
    );
    industrySupported = false;
    delete row.industry;
    ({ data, error } = await upsert(row));
  }

  if (error) { dbErr("saveContact", error); return null; }
  return rowToContact(data);
}

/** False once a save has proven the column is absent — the UI hides the field. */
export function isIndustrySupported() {
  return industrySupported;
}

export async function deleteContact(contactId) {
  const { error } = await supabase.from("contacts").delete().eq("id", contactId);
  if (error) dbErr("deleteContact", error);
}

/**
 * The address list, always usable.
 *
 * This is where the legacy single column is folded in, rather than in the app's
 * normalizer — here we can actually tell "the database has no list for this
 * person" (an old row, or the `emails` column not yet added) apart from "the
 * list is empty because every address was deleted". The normalizer sees only
 * an object and cannot distinguish the two, which is how deleting the primary
 * address used to put it straight back.
 */
function rowEmails(row) {
  if (Array.isArray(row.emails) && row.emails.length) return row.emails;
  const legacy = String(row.email || "").trim();
  if (!legacy) return [];
  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return [{ id, label: "personal", address: legacy }];
}

function rowToContact(row) {
  return {
    id: row.id,
    name: row.name || "",
    email: row.email || "",
    company: row.company || "",
    role: row.role || "",
    industry: row.industry || "",
    dateMet: row.date_met || "",
    lastContacted: row.last_contacted || "",
    followUpFrequency: row.follow_up_frequency || "none",
    notes: row.notes || "",
    adviceGiven: row.advice_given || "",
    interests: row.interests || "",
    reminderEnabled: row.reminder_enabled || false,
    nextReminder: row.next_reminder || "",
    emails: rowEmails(row),
    interactions: Array.isArray(row.interactions) ? row.interactions : [],
    companyHistory: Array.isArray(row.company_history) ? row.company_history : [],
    followUps: Array.isArray(row.follow_ups) ? row.follow_ups : []
  };
}

function contactToRow(contact, userId) {
  return {
    id: contact.id,
    user_id: userId,
    name: contact.name || "",
    email: contact.email || "",
    // The full labelled list. `email` stays as the primary so anything reading
    // a single address keeps working, and so the column is still useful if
    // this one is missing.
    emails: contact.emails || [],
    company: contact.company || "",
    role: contact.role || "",
    industry: contact.industry || "",
    date_met: contact.dateMet || null,
    last_contacted: contact.lastContacted || null,
    follow_up_frequency: contact.followUpFrequency || "none",
    notes: contact.notes || "",
    advice_given: contact.adviceGiven || "",
    interests: contact.interests || "",
    reminder_enabled: contact.reminderEnabled || false,
    next_reminder: contact.nextReminder || null,
    // NOTE: no `starred` here — the contacts table has no such column, so
    // writing it would make every contact save fail. To enable starring:
    //   alter table public.contacts add column starred boolean not null default false;
    // then add `starred: contact.starred || false,` to this object and to
    // rowToContact() above.
    interactions: contact.interactions || [],
    company_history: contact.companyHistory || [],
    follow_ups: contact.followUps || []
  };
}

// ─── Storage files (Supabase Storage + storage_files table) ──────────────────

/**
 * Upload a file to the 'interntrack-files' bucket, then record its metadata.
 *
 * Requires bucket: interntrack-files (public read).
 * Requires table:  storage_files (id, user_id, contact_id, name, file_url,
 *                  storage_path, category, created_at)
 */
export async function uploadFileToStorage(file, metadata = {}) {
  const userId = await uid();
  if (!userId) return null;

  const safeName = file.name.replace(/\s+/g, "_");
  const filePath = `${userId}/${Date.now()}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from("interntrack-files")
    .upload(filePath, file);
  if (uploadError) { dbErr("uploadFileToStorage upload", uploadError); return null; }

  const { data: urlData } = supabase.storage
    .from("interntrack-files")
    .getPublicUrl(filePath);

  const id = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const row = {
    id,
    user_id: userId,
    contact_id: metadata.contactId || null,
    name: file.name,
    file_url: urlData.publicUrl,
    storage_path: filePath,
    category: metadata.category || "general"
  };

  const { data, error } = await supabase
    .from("storage_files")
    .insert([row])
    .select()
    .single();
  if (error) { dbErr("uploadFileToStorage insert", error); return null; }
  return rowToStorageFile(data);
}

/** Fetch all storage files for the current user, newest first. */
export async function fetchAllStorageFiles() {
  const userId = await uid();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("storage_files")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) { dbErr("fetchAllStorageFiles", error); return []; }
  return (data || []).map(rowToStorageFile);
}

/** Fetch storage files linked to a specific contact. */
export async function fetchStorageFilesByContact(contactId) {
  const userId = await uid();
  if (!userId || !contactId) return [];
  const { data, error } = await supabase
    .from("storage_files")
    .select("*")
    .eq("user_id", userId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });
  if (error) { dbErr("fetchStorageFilesByContact", error); return []; }
  return (data || []).map(rowToStorageFile);
}

/**
 * Rename a file's display name. Only the `storage_files` row changes — the
 * object keeps its original storage path, so existing public URLs keep working.
 */
export async function renameStorageFile(fileId, newName) {
  const userId = await uid();
  if (!userId || !fileId) return null;
  const name = String(newName || "").trim();
  if (!name) return null;

  const { data, error } = await supabase
    .from("storage_files")
    .update({ name })
    .eq("id", fileId)
    .eq("user_id", userId)
    .select()
    .single();
  if (error) { dbErr("renameStorageFile", error); return null; }
  return rowToStorageFile(data);
}

/** Delete a storage file from both the bucket and the database. */
export async function deleteStorageFile(fileId, storagePath) {
  if (storagePath) {
    const { error: storageErr } = await supabase.storage
      .from("interntrack-files")
      .remove([storagePath]);
    if (storageErr) dbErr("deleteStorageFile bucket", storageErr);
  }
  const { error } = await supabase.from("storage_files").delete().eq("id", fileId);
  if (error) dbErr("deleteStorageFile db", error);
}

function rowToStorageFile(row) {
  return {
    id: row.id,
    name: row.name || "",
    fileUrl: row.file_url || "",
    storagePath: row.storage_path || "",
    category: row.category || "general",
    contactId: row.contact_id || null,
    createdAt: row.created_at || ""
  };
}
