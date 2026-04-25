/**
 * db.js — Supabase data access layer for InternTrack
 *
 * Replaces all localStorage read/write calls from the original app.
 * Every exported function is async and scoped to the authenticated user
 * via Supabase Row Level Security (user_id = auth.uid()).
 *
 * Tables: preferences, internships, logs, files, contacts
 * Contacts store basic info and interactions. Documents live in storage_files; follow-ups in follow_ups table.
 *
 * AI-assisted: schema design, upsert patterns, JSONB handling.
 */
import { supabase } from "./supabase.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function uid() {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id || null;
}

function dbErr(label, error) {
  console.error(`[DB] ${label}:`, error?.message || error);
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

export async function savePreferences(updates) {
  const userId = await uid();
  if (!userId) return;
  const { error } = await supabase
    .from("preferences")
    .upsert({ user_id: userId, ...updates }, { onConflict: "user_id" });
  if (error) dbErr("savePreferences", error);
}

// ─── Internships ──────────────────────────────────────────────────────────────

export async function getInternships() {
  const userId = await uid();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("internships")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) { dbErr("getInternships", error); return []; }
  return (data || []).map(rowToInternship);
}

export async function saveInternship(internship) {
  const userId = await uid();
  if (!userId) return null;
  const row = internshipToRow(internship, userId);
  const { data, error } = await supabase
    .from("internships")
    .upsert(row, { onConflict: "id" })
    .select()
    .single();
  if (error) { dbErr("saveInternship", error); return null; }
  return rowToInternship(data);
}

export async function deleteInternship(internshipId) {
  const { error } = await supabase.from("internships").delete().eq("id", internshipId);
  if (error) dbErr("deleteInternship", error);
}

function rowToInternship(row) {
  return {
    id: row.id,
    name: row.name || "",
    company: row.company || "",
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    createdAt: row.created_at || ""
  };
}

function internshipToRow(item, userId) {
  return {
    id: item.id,
    user_id: userId,
    name: item.name || "",
    company: item.company || "",
    start_date: item.startDate || null,
    end_date: item.endDate || null
  };
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export async function getLogs(internshipId) {
  const userId = await uid();
  if (!userId || !internshipId) return [];
  const { data, error } = await supabase
    .from("logs")
    .select("*")
    .eq("user_id", userId)
    .eq("internship_id", internshipId)
    .order("date", { ascending: false });
  if (error) { dbErr("getLogs", error); return []; }
  return (data || []).map(rowToLog);
}

export async function saveLog(log, internshipId) {
  const userId = await uid();
  if (!userId || !internshipId) return null;
  const row = logToRow(log, userId, internshipId);
  const { data, error } = await supabase
    .from("logs")
    .upsert(row, { onConflict: "id" })
    .select()
    .single();
  if (error) { dbErr("saveLog", error); return null; }
  return rowToLog(data);
}

export async function deleteLog(logId) {
  const { error } = await supabase.from("logs").delete().eq("id", logId);
  if (error) dbErr("deleteLog", error);
}

function rowToLog(row) {
  return {
    id: row.id,
    date: row.date || "",
    task: row.task || "",
    impact: row.impact || "",
    skills: row.skills || "",
    tags: row.tags ? row.tags.split(",").map(t => t.trim()).filter(Boolean) : [],
    blockers: row.blockers || ""
  };
}

function logToRow(log, userId, internshipId) {
  return {
    id: log.id,
    user_id: userId,
    internship_id: internshipId,
    date: log.date || null,
    task: log.task || "",
    impact: log.impact || "",
    skills: log.skills || "",
    tags: Array.isArray(log.tags) ? log.tags.join(",") : (log.tags || ""),
    blockers: log.blockers || ""
  };
}

// ─── Files ────────────────────────────────────────────────────────────────────

export async function getFiles(internshipId) {
  const userId = await uid();
  if (!userId || !internshipId) return [];
  const { data, error } = await supabase
    .from("files")
    .select("*")
    .eq("user_id", userId)
    .eq("internship_id", internshipId)
    .order("date", { ascending: false });
  if (error) { dbErr("getFiles", error); return []; }
  return (data || []).map(rowToFile);
}

export async function saveFile(file, internshipId) {
  const userId = await uid();
  if (!userId || !internshipId) return null;
  const row = fileToRow(file, userId, internshipId);
  const { data, error } = await supabase
    .from("files")
    .upsert(row, { onConflict: "id" })
    .select()
    .single();
  if (error) { dbErr("saveFile", error); return null; }
  return rowToFile(data);
}

export async function deleteFile(fileId) {
  const { error } = await supabase.from("files").delete().eq("id", fileId);
  if (error) dbErr("deleteFile", error);
}

function rowToFile(row) {
  return {
    id: row.id,
    name: row.name || "",
    data: row.data || "",
    date: row.date || "",
    linkedWeek: row.linked_week || "",
    linkedLogId: row.linked_log_id || ""
  };
}

function fileToRow(file, userId, internshipId) {
  return {
    id: file.id,
    user_id: userId,
    internship_id: internshipId,
    name: file.name || "",
    data: file.data || "",
    date: file.date || null,
    linked_week: file.linkedWeek || null,
    linked_log_id: file.linkedLogId || null
  };
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

export async function saveContact(contact) {
  const userId = await uid();
  if (!userId) return null;
  const row = contactToRow(contact, userId);
  const { data, error } = await supabase
    .from("contacts")
    .upsert(row, { onConflict: "id" })
    .select()
    .single();
  if (error) { dbErr("saveContact", error); return null; }
  return rowToContact(data);
}

export async function deleteContact(contactId) {
  const { error } = await supabase.from("contacts").delete().eq("id", contactId);
  if (error) dbErr("deleteContact", error);
}

function rowToContact(row) {
  return {
    id: row.id,
    internshipId: row.internship_id || null,
    name: row.name || "",
    email: row.email || "",
    company: row.company || "",
    role: row.role || "",
    dateMet: row.date_met || "",
    lastContacted: row.last_contacted || "",
    followUpFrequency: row.follow_up_frequency || "none",
    notes: row.notes || "",
    adviceGiven: row.advice_given || "",
    interests: row.interests || "",
    reminderEnabled: row.reminder_enabled || false,
    nextReminder: row.next_reminder || "",
    interactions: Array.isArray(row.interactions) ? row.interactions : [],
    companyHistory: Array.isArray(row.company_history) ? row.company_history : [],
    followUps: Array.isArray(row.follow_ups) ? row.follow_ups : []
  };
}

function contactToRow(contact, userId) {
  return {
    id: contact.id,
    user_id: userId,
    internship_id: contact.internshipId || null,
    name: contact.name || "",
    email: contact.email || "",
    company: contact.company || "",
    role: contact.role || "",
    date_met: contact.dateMet || null,
    last_contacted: contact.lastContacted || null,
    follow_up_frequency: contact.followUpFrequency || "none",
    notes: contact.notes || "",
    advice_given: contact.adviceGiven || "",
    interests: contact.interests || "",
    reminder_enabled: contact.reminderEnabled || false,
    next_reminder: contact.nextReminder || null,
    interactions: contact.interactions || [],
    company_history: contact.companyHistory || [],
    follow_ups: contact.followUps || []
  };
}

// ─── Storage Files (Supabase Storage + storage_files table) ──────────────────

/**
 * Upload a file to the 'interntrack-files' Supabase Storage bucket,
 * then insert a row into the 'storage_files' table with metadata.
 *
 * Requires Supabase bucket: interntrack-files (public access enabled).
 * Requires table: storage_files (id, user_id, internship_id, contact_id,
 *   name, file_url, storage_path, category, created_at)
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
    internship_id: metadata.internshipId || null,
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

/** Fetch storage files linked to a specific internship. */
export async function fetchStorageFilesByInternship(internshipId) {
  const userId = await uid();
  if (!userId || !internshipId) return [];
  const { data, error } = await supabase
    .from("storage_files")
    .select("*")
    .eq("user_id", userId)
    .eq("internship_id", internshipId)
    .order("created_at", { ascending: false });
  if (error) { dbErr("fetchStorageFilesByInternship", error); return []; }
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
    internshipId: row.internship_id || null,
    contactId: row.contact_id || null,
    createdAt: row.created_at || ""
  };
}
