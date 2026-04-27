/**
 * app.js — InternTrack main application logic
 *
 * ES module. All data access goes through db.js (Supabase).
 * UI state (active internship, theme) is kept in localStorage only.
 *
 * Page-level init functions are guarded by requireAuth() at boot.
 * Each page calls only the init functions relevant to its DOM.
 *
 * AI-assisted: architecture, async refactor, follow-up suggestion logic,
 * reminder modal, contact page dynamic render. See README for details.
 */
import { requireAuth, supabase } from "./supabase.js";
import * as db from "./db.js";

// ── Active internship (UI state — localStorage only) ──────────────────────────
// Only the selected internship ID is kept in localStorage.
// All actual internship data lives in Supabase.

function getActiveInternshipId() {
  return localStorage.getItem("interntrack_active_internship_id") || "";
}

function setActiveInternshipId(id) {
  localStorage.setItem("interntrack_active_internship_id", id || "");
}

function hasActiveInternship() {
  return Boolean(getActiveInternshipId());
}

function requireActiveInternship(errorEl, message = "Please add or select an internship first.") {
  if (hasActiveInternship()) return true;
  if (errorEl) errorEl.textContent = message;
  return false;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
// Pure helper functions — no side effects, no async.

/** Generate a unique ID using crypto.randomUUID when available. */
function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(value) {
  if (!value) return "No date";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function parseDateOnly(value) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function todayDateString() {
  return new Date().toISOString().split("T")[0];
}

function splitTags(tagsValue) {
  if (Array.isArray(tagsValue)) return tagsValue.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tagsValue === "string") return tagsValue.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isDateWithinLastDays(value, days = 7) {
  const date = parseDateOnly(value);
  if (!date) return false;
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return date >= start && date <= end;
}

// ── Normalizers ───────────────────────────────────────────────────────────────
// Each normalizer fills in defaults and ensures consistent shape before
// saving to Supabase. Called on both read (db.js) and write paths.

function normalizeLog(log = {}) {
  return {
    id: log.id || makeId(),
    date: log.date || "",
    task: (log.task || log.text || "").trim(),
    impact: (log.impact || "").trim(),
    skills: (log.skills || "").trim(),
    tags: splitTags(log.tags),
    blockers: (log.blockers || "").trim()
  };
}

/** Human-readable labels for follow-up reminder frequencies. */
const FREQUENCY_LABELS = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  bimonthly: "Every 2 months",
  quarterly: "Quarterly",
  none: "No reminders"
};

function getFreqLabel(freq) {
  if (freq && freq.startsWith("custom:")) {
    const days = parseInt(freq.slice(7), 10);
    return "Every " + days + " day" + (days !== 1 ? "s" : "");
  }
  return FREQUENCY_LABELS[freq] || "No reminders";
}

function calculateNextReminder(lastContacted, frequency) {
  if (!lastContacted || frequency === "none") return "";
  const date = new Date(lastContacted);
  if (frequency === "weekly") date.setDate(date.getDate() + 7);
  else if (frequency === "biweekly") date.setDate(date.getDate() + 14);
  else if (frequency === "monthly") date.setMonth(date.getMonth() + 1);
  else if (frequency === "bimonthly") date.setMonth(date.getMonth() + 2);
  else if (frequency === "quarterly") date.setMonth(date.getMonth() + 3);
  else if (frequency.startsWith("custom:")) {
    const days = parseInt(frequency.slice(7), 10);
    if (!isNaN(days) && days > 0) date.setDate(date.getDate() + days);
  }
  return date.toISOString();
}

function normalizeInteraction(item = {}) {
  return {
    id: item.id || makeId(),
    date: item.date || todayDateString(),
    type: item.type || "check-in",
    notes: (item.notes || "").trim(),
    outcome: (item.outcome || "").trim()
  };
}

function normalizeContactDocument(doc = {}) {
  return {
    id: doc.id || makeId(),
    name: doc.name || "Untitled.pdf",
    data: doc.data || "",
    date: doc.date || todayDateString()
  };
}

function normalizeFollowUpItem(item = {}) {
  return {
    id: item.id || makeId(),
    text: (item.text || "").trim(),
    source: item.source === "ai" ? "ai" : "manual",
    completed: item.completed === true,
    createdAt: item.createdAt || new Date().toISOString()
  };
}

function normalizeContact(contact = {}) {
  const frequency = contact.followUpFrequency || "none";
  const interactions = Array.isArray(contact.interactions)
    ? contact.interactions.map(normalizeInteraction)
    : [];
  const sortedInteractions = [...interactions].sort((a, b) => b.date.localeCompare(a.date));
  const latestDate = sortedInteractions[0]?.date || "";
  const lastContacted = contact.lastContacted || latestDate || contact.dateMet || "";
  let nextReminder = contact.nextReminder || "";
  if (!nextReminder && frequency !== "none" && lastContacted) {
    nextReminder = calculateNextReminder(lastContacted, frequency);
  }
  return {
    id: contact.id || makeId(),
    name: (contact.name || "").trim(),
    email: (contact.email || "").trim(),
    company: (contact.company || "").trim(),
    role: (contact.role || "").trim(),
    dateMet: contact.dateMet || "",
    lastContacted,
    followUpFrequency: frequency,
    nextReminder,
    reminderEnabled: frequency !== "none" ? (contact.reminderEnabled !== false) : false,
    notes: (contact.notes || "").trim(),
    interests: (contact.interests || "").trim(),
    adviceGiven: (contact.adviceGiven || "").trim(),
    interactions: sortedInteractions,
    documents: Array.isArray(contact.documents)
      ? contact.documents.map(normalizeContactDocument)
      : [],
    followUps: Array.isArray(contact.followUps)
      ? contact.followUps.map(normalizeFollowUpItem)
      : [],
    companyHistory: Array.isArray(contact.companyHistory)
      ? contact.companyHistory.map((c) => String(c).trim()).filter(Boolean)
      : [],
    starred: contact.starred === true
  };
}

function normalizeFile(file = {}) {
  return {
    id: file.id || makeId(),
    name: file.name || "Untitled.pdf",
    data: file.data || "",
    date: file.date || todayDateString()
  };
}

// ── Reminder helpers ──────────────────────────────────────────────────────────

function getReminderStatus(contact) {
  if (!contact.reminderEnabled || contact.followUpFrequency === "none" || !contact.nextReminder) {
    return "none";
  }
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 86400000);
  const next = new Date(contact.nextReminder);
  if (next <= now) return "due";
  if (next <= soon) return "soon";
  return "ok";
}

function reminderBadge(contact) {
  const status = getReminderStatus(contact);
  if (status === "due") return '<span class="badge badge-due">Due</span>';
  if (status === "soon") return '<span class="badge badge-soon">Soon</span>';
  if (status === "ok") return '<span class="badge badge-ok">Up to date</span>';
  return "";
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────

function initSidebarToggle() {
  const btn = document.getElementById("sidebarToggleBtn");
  const sidebar = document.querySelector(".sidebar");
  if (!btn || !sidebar) return;
  if (localStorage.getItem("interntrack_sidebar_collapsed") === "true") sidebar.classList.add("collapsed");
  btn.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    localStorage.setItem("interntrack_sidebar_collapsed", sidebar.classList.contains("collapsed").toString());
  });
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme() {
  const theme = localStorage.getItem("interntrack_theme") || "light";
  document.body.classList.toggle("dark", theme === "dark");
  const toggle = document.getElementById("themeToggle");
  if (toggle) toggle.textContent = theme === "dark" ? "Light Mode" : "Dark Mode";
  document.documentElement.style.colorScheme = theme;
}

function initThemeToggle() {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;
  applyTheme();
  toggle.addEventListener("click", () => {
    const next = document.body.classList.contains("dark") ? "light" : "dark";
    localStorage.setItem("interntrack_theme", next);
    applyTheme();
  });
}

// ── PDF helper ────────────────────────────────────────────────────────────────

function readPdfFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

// ── Follow-up suggestions ─────────────────────────────────────────────────────

/** Supported interaction types for the timeline log form. */
const INTERACTION_TYPES = ["coffee chat", "meeting", "check-in", "email", "phone call", "event"];

/**
 * AI-assisted: Generate personalised follow-up suggestions based on
 * contact interests, role, notes, and interaction history.
 * Returns up to 5 de-duplicated suggestion strings.
 */
function generateFollowUpSuggestions(contact) {
  const name = contact.name || "them";
  const sentences = [];

  // Pull sentences from recent interactions (most recent 3)
  const recentInteractions = (contact.interactions || []).slice(0, 3);
  for (const interaction of recentInteractions) {
    for (const field of [interaction.notes, interaction.outcome]) {
      if (!field) continue;
      // Split on sentence boundaries
      field.split(/[.!?\n]+/).forEach((s) => {
        const trimmed = s.trim();
        if (trimmed.length > 8) sentences.push({ text: trimmed, source: "interaction" });
      });
    }
  }

  // Pull sentences from contact-level notes
  if (contact.notes) {
    contact.notes.split(/[.!?\n]+/).forEach((s) => {
      const trimmed = s.trim();
      if (trimmed.length > 8) sentences.push({ text: trimmed, source: "notes" });
    });
  }

  if (!sentences.length) return ["Send " + name + " a quick check-in message"];

  // Score sentences: prefer ones that suggest ongoing topics or action items
  const actionWords = /\b(mentioned|said|working on|planning|considering|wants to|will|might|should|asked|wondering|interested in|excited about|worried about|discussed|brought up|follow up|check back|update|revisit|explore|look into|thinking about|decided|going to|hope|looking for|applied|interviewing|offered|accepted|waiting|heard back|need to|want to)\b/i;

  const scored = sentences.map((s) => ({
    ...s,
    score: (actionWords.test(s.text) ? 2 : 0) + (s.source === "interaction" ? 1 : 0)
  }));

  scored.sort((a, b) => b.score - a.score);

  // Format as follow-up talking points
  const seen = new Set();
  const suggestions = [];
  for (const s of scored) {
    const key = s.text.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    // Capitalize first letter
    const text = s.text.charAt(0).toUpperCase() + s.text.slice(1);
    suggestions.push("Follow up on: " + text);
    if (suggestions.length >= 5) break;
  }

  return suggestions;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderFollowUpItems(followUps) {
  if (!followUps || !followUps.length) {
    return '<p class="empty">No next steps yet. Add one manually or use Suggest.</p>';
  }
  const sorted = [...followUps].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return sorted.map((item) => [
    '<div class="followup-item ' + (item.completed ? "followup-done" : "") + '" data-fu-id="' + item.id + '">',
    '  <label class="followup-check">',
    '    <input type="checkbox" class="fu-checkbox" data-fu-id="' + item.id + '" ' + (item.completed ? "checked" : "") + ' />',
    '    <span class="followup-text">' + escapeHtml(item.text) + '</span>',
    '  </label>',
    '  <div class="followup-right">',
    '    <span class="fu-tag ' + (item.source === "ai" ? "fu-tag-ai" : "fu-tag-manual") + '">' + (item.source === "ai" ? "AI" : "Manual") + '</span>',
    '    <button class="btn btn-secondary fu-delete" type="button" data-fu-id="' + item.id + '" title="Delete">X</button>',
    '  </div>',
    '</div>'
  ].join("\n")).join("\n");
}

function renderContactDocuments(docs) {
  if (!docs.length) return '<p class="empty">No documents uploaded yet.</p>';
  return docs.map((doc) => [
    '<div class="row wrap doc-row">',
    '  <span><strong>' + escapeHtml(doc.name) + '</strong> <span class="tiny">' + formatDate(doc.date) + '</span></span>',
    '  <div class="row">',
    '    <a class="btn btn-secondary" href="' + doc.data + '" target="_blank" rel="noopener">Open</a>',
    '    <a class="btn btn-secondary" href="' + doc.data + '" download="' + escapeHtml(doc.name) + '">Download</a>',
    '    <button class="btn btn-secondary" type="button" data-remove-doc="' + doc.id + '">Remove</button>',
    '  </div>',
    '</div>'
  ].join("\n")).join("\n");
}

// ── Storage file card helpers ─────────────────────────────────────────────────
// Shared by the Files page, Contact profile docs section, and workspace panel.

const FILE_CATEGORY_META = {
  project:      { label: "Project",      cls: "file-tag-project" },
  conversation: { label: "Conversation", cls: "file-tag-conversation" },
  general:      { label: "General",      cls: "file-tag-general" }
};

function renderStorageFileCard(file) {
  const meta = FILE_CATEGORY_META[file.category] || FILE_CATEGORY_META.general;
  const dateStr = file.createdAt
    ? new Date(file.createdAt).toLocaleDateString()
    : "";
  return '<div class="file-card"'
    + ' data-file-id="' + escapeHtml(file.id) + '"'
    + ' data-storage-path="' + escapeHtml(file.storagePath) + '">'
    + '<div class="file-card-icon">📄</div>'
    + '<div class="file-card-body">'
    + '<p class="file-card-name" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</p>'
    + (dateStr ? '<p class="file-card-date">' + dateStr + '</p>' : '')
    + '</div>'
    + '<div class="file-card-footer">'
    + '<span class="file-tag ' + meta.cls + '">' + meta.label + '</span>'
    + '<div class="file-card-actions">'
    + '<button class="file-action-btn file-open-btn" type="button"'
    + ' data-file-url="' + escapeHtml(file.fileUrl) + '" title="Open file">Open</button>'
    + '<button class="file-action-btn file-delete-btn" type="button"'
    + ' data-file-id="' + escapeHtml(file.id) + '"'
    + ' data-storage-path="' + escapeHtml(file.storagePath) + '" title="Delete file">✕</button>'
    + '</div>'
    + '</div>'
    + '</div>';
}

/**
 * Attach open/delete listeners to .file-card elements inside `container`.
 * `onDelete` is called (async) after a successful delete so the caller can
 * re-render the list without a full page reload.
 */
function attachStorageFileCardListeners(container, onDelete) {
  container.querySelectorAll(".file-open-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.fileUrl) window.open(btn.dataset.fileUrl, "_blank");
    });
  });
  container.querySelectorAll(".file-delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!window.confirm("Delete this file? This cannot be undone.")) return;
      await db.deleteStorageFile(btn.dataset.fileId, btn.dataset.storagePath);
      if (onDelete) await onDelete();
    });
  });
}

function renderInteractionTimeline(interactions) {
  if (!interactions || !interactions.length) return '<p class="empty">No interactions logged yet.</p>';
  return interactions.map((item) => {
    const hasNotes = item.notes || item.outcome;
    const notesBody = [
      item.notes ? '<p>' + escapeHtml(item.notes) + '</p>' : '',
      item.outcome ? '<p class="tiny"><span class="label">Outcome:</span> ' + escapeHtml(item.outcome) + '</p>' : ''
    ].filter(Boolean).join('');
    return [
      '<div class="timeline-item">',
      '  <div class="timeline-dot"></div>',
      '  <div class="timeline-body">',
      '    <p class="timeline-date">' + formatDate(item.date) + ' <span class="tag">' + escapeHtml(item.type) + '</span></p>',
      hasNotes ? '    <details class="timeline-notes"><summary>Meeting notes</summary>' + notesBody + '</details>' : '',
      '  </div>',
      '</div>'
    ].filter(Boolean).join("\n");
  }).join("\n");
}

// ── Summary builder ───────────────────────────────────────────────────────────
// Builds a plain-text weekly manager update from impact logs.
// AI-assisted: email template structure and scoring heuristic.

/** Score a log entry by richness — used to pick the "key highlight". */
function scoreImpact(log) {
  return (log.impact || "").length + (log.skills || "").length * 0.2 + log.tags.length * 3;
}

function buildSummary({ logs, managerName, yourName, nextSteps }) {
  const safeManager = (managerName || "").trim() || "Manager";
  const safeName = (yourName || "").trim() || "Your Name";
  const safeNextSteps = (nextSteps || "").trim();
  if (!logs.length) {
    return "Hi " + safeManager + ",\n\nThis week I:\n\nCompleted: No impact logs submitted.\nAchieved: No impact details submitted.\nLearned: No skills noted yet.\n\nKey highlight:\nNo key highlight yet.\n\nNext steps:\n" + (safeNextSteps || "Continue building momentum next week.") + "\n\nBest,\n" + safeName;
  }
  const completed = logs.map((log) => log.task + " (" + log.date + ")").join("; ");
  const achieved = logs.map((log) => log.impact).filter(Boolean).join("; ");
  const learned = logs.map((log) => log.skills).filter(Boolean).join("; ");
  const best = [...logs].sort((a, b) => scoreImpact(b) - scoreImpact(a))[0];
  return "Hi " + safeManager + ",\n\nThis week I:\n\nCompleted: " + completed + "\nAchieved: " + (achieved || "No impact details recorded.") + "\nLearned: " + (learned || "No skills recorded.") + "\n\nKey highlight:\n" + (best ? best.impact || "No key highlight recorded." : "No key highlight recorded.") + "\n\nNext steps:\n" + (safeNextSteps || "Continue progressing on current priorities.") + "\n\nBest,\n" + safeName;
}

/**
 * Fetch a random motivational quote from the Quotable public API.
 * Falls back to a static string on error so the UI never breaks.
 * API integration requirement — external fetch (api.quotable.io).
 */
async function fetchQuote() {
  try {
    const response = await fetch("https://api.quotable.io/random");
    if (!response.ok) throw new Error("Quote unavailable");
    const data = await response.json();
    return '"' + data.content + '" — ' + data.author;
  } catch {
    return "Weekly Insight for Growth is unavailable right now. Keep showing up consistently.";
  }
}

// ── Reminder modal ────────────────────────────────────────────────────────────
// AI-assisted: modal structure and email draft template.

function buildReminderEmailText(contact, yourName) {
  const name = contact.name || "there";
  const safeName = (yourName || "").trim() || "[Your Name]";
  return "Subject: Great catching up!\n\nHi " + name + ",\n\nHope you have been doing well! I wanted to reconnect and see how things have been going on your end.\n\nWould love to catch up soon.\n\nBest,\n" + safeName;
}

async function showReminderModal(contact) {
  const existing = document.getElementById("reminderModal");
  if (existing) existing.remove();
  const prefs = await db.getPreferences();
  const yourName = prefs.your_name || "";
  const emailText = buildReminderEmailText(contact, yourName);
  const freqLabel = getFreqLabel(contact.followUpFrequency);
  const nextStr = contact.nextReminder ? formatDate(contact.nextReminder.split("T")[0]) : "Not set";
  const modal = document.createElement("div");
  modal.id = "reminderModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card">'
    + '<h3>Time to reconnect with <strong>' + escapeHtml(contact.name) + '</strong></h3>'
    + '<p class="muted">Frequency: ' + escapeHtml(freqLabel) + ' · Next: ' + nextStr + '</p>'
    + '<div class="modal-actions">'
    + '<button class="btn" id="modalMarkDone" type="button">Mark as done</button>'
    + '<button class="btn btn-secondary" id="modalLater" type="button">Remind me in 3 days</button>'
    + '<button class="btn btn-secondary" id="modalTurnOff" type="button">Turn off reminders</button>'
    + '</div>'
    + '<div class="modal-email">'
    + '<p class="label">Copy reminder email draft:</p>'
    + '<textarea class="email-draft" readonly rows="8">' + escapeHtml(emailText) + '</textarea>'
    + '<button class="btn btn-secondary" id="modalCopyEmail" type="button">Copy email</button>'
    + '<p id="modalCopyMsg" class="success" aria-live="polite"></p>'
    + '</div>'
    + '<button class="btn btn-secondary modal-close" id="modalClose" type="button">Close</button>'
    + '</div>';
  document.body.appendChild(modal);

  const refresh = async () => {
    await renderContacts();
    await renderFollowUpAlerts("dashboardFollowUps");
    await renderFollowUpAlerts("networkFollowUps");
    await renderProgressWidget();
    modal.remove();
  };

  modal.querySelector("#modalMarkDone").addEventListener("click", async () => {
    await db.saveContact(normalizeContact({ ...contact, lastContacted: todayDateString(), nextReminder: calculateNextReminder(new Date().toISOString(), contact.followUpFrequency) }));
    await refresh();
  });
  modal.querySelector("#modalLater").addEventListener("click", async () => {
    await db.saveContact(normalizeContact({ ...contact, nextReminder: new Date(Date.now() + 3 * 86400000).toISOString() }));
    await refresh();
  });
  modal.querySelector("#modalTurnOff").addEventListener("click", async () => {
    await db.saveContact(normalizeContact({ ...contact, reminderEnabled: false, followUpFrequency: "none" }));
    await refresh();
  });
  modal.querySelector("#modalCopyEmail").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(emailText);
      modal.querySelector("#modalCopyMsg").textContent = "Email copied to clipboard!";
    } catch {
      modal.querySelector("#modalCopyMsg").textContent = "Copy failed — please copy manually.";
    }
  });
  modal.querySelector("#modalClose").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

// ── Render functions ──────────────────────────────────────────────────────────

async function renderFollowUpAlerts(listId, emptyText) {
  emptyText = emptyText || "No follow-ups due.";
  const list = document.getElementById(listId);
  if (!list) return;
  const contacts = (await db.getContacts()) || [];
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  const soon = new Date(now.getTime() + 7 * 86400000);
  const due = contacts.filter((c) => c.reminderEnabled && c.nextReminder && new Date(c.nextReminder) <= now);
  const soonList = contacts.filter((c) => {
    if (!c.reminderEnabled || !c.nextReminder) return false;
    const next = new Date(c.nextReminder);
    return next > now && next <= soon;
  });
  const combined = [...due.map((c) => ({ contact: c, status: "due" })), ...soonList.map((c) => ({ contact: c, status: "soon" }))];
  if (!combined.length) {
    list.innerHTML = '<li class="empty">' + escapeHtml(emptyText) + '</li>';
    return;
  }
  list.innerHTML = combined.map(({ contact, status }) =>
    '<li class="list-item ' + (status === "due" ? "due-item" : "soon-item") + '">'
    + '<div class="reminder-row">'
    + '<span>' + (status === "due" ? "Time to reconnect with" : "Coming up:") + ' <strong>' + escapeHtml(contact.name) + '</strong> <span class="tiny">(' + formatDate(contact.nextReminder) + ')</span></span>'
    + '<button class="btn btn-secondary reminder-trigger" type="button" data-contact-id="' + contact.id + '">Manage</button>'
    + '</div></li>'
  ).join("");
  list.querySelectorAll(".reminder-trigger").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.contactId) window.location.href = "contact.html?id=" + encodeURIComponent(btn.dataset.contactId);
    });
  });
}


async function renderWeeklyConnections(listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const contacts = (await db.getContacts()) || [];
  // All contacts met in the last 7 days, sorted A→Z
  const people = contacts
    .filter((c) => isDateWithinLastDays(c.dateMet, 7))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!people.length) {
    list.innerHTML = '<p class="empty">No new contacts added in the last 7 days.</p>';
    return;
  }
  list.innerHTML = people.map((person) =>
    '<div class="weekly-contact-card">'
    + '<div class="weekly-contact-main">'
    + '<p class="weekly-contact-name">' + escapeHtml(person.name) + '</p>'
    + '<p class="tiny">' + escapeHtml(person.role || 'Role not set') + (person.company ? ' @ <strong>' + escapeHtml(person.company) + '</strong>' : '') + '</p>'
    + '</div>'
    + '<div class="weekly-contact-meta">'
    + reminderBadge(person)
    + '<span class="tiny">Met ' + formatDate(person.dateMet) + '</span>'
    + '</div>'
    + '</div>'
  ).join('');
}

async function renderProgressWidget() {
  const statLogs = document.getElementById("statLogs");
  const statContacts = document.getElementById("statContacts");
  const statFollowUps = document.getElementById("statFollowUps");
  if (!statLogs || !statContacts || !statFollowUps) return;
  const activeId = getActiveInternshipId();
  const allLogs = activeId ? await db.getLogs(activeId) : [];
  const allContacts = (await db.getContacts()) || [];
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  statLogs.textContent = String(allLogs.filter((l) => isDateWithinLastDays(l.date, 7)).length);
  statContacts.textContent = String(allContacts.filter((c) => isDateWithinLastDays(c.dateMet, 7)).length);
  statFollowUps.textContent = String(allContacts.filter((c) => c.reminderEnabled && c.nextReminder && new Date(c.nextReminder) <= now).length);
}

/**
 * Render the contact list on network.html.
 * Sorted A→Z by first name. Optionally filtered by company/role search term.
 */
async function renderContacts(filterText) {
  const list = document.getElementById("contactList");
  if (!list) return;
  let contacts;
  try {
    contacts = (await db.getContacts()) || [];
  } catch (err) {
    list.innerHTML = '<li class="empty" style="color:var(--danger)">Error loading contacts — check the console (F12).</li>';
    return;
  }
  // Sort A→Z by name
  contacts = contacts.sort((a, b) => a.name.localeCompare(b.name));
  // Apply filter
  if (filterText && filterText.trim()) {
    const q = filterText.trim().toLowerCase();
    contacts = contacts.filter((c) =>
      (c.name && c.name.toLowerCase().includes(q)) ||
      (c.role && c.role.toLowerCase().includes(q)) ||
      (c.company && c.company.toLowerCase().includes(q))
    );
  }
  if (!contacts.length) {
    list.innerHTML = '<li class="empty">' + (filterText ? 'No contacts match "' + escapeHtml(filterText) + '".' : 'No contacts yet. Add your first contact above.') + '</li>';
    return;
  }

  function contactCardHtml(contact) {
    const status = getReminderStatus(contact);
    const nameParts = (contact.name || '?').trim().split(/\s+/);
    const initials = nameParts.length >= 2
      ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
      : (nameParts[0][0] || '?').toUpperCase();
    return '<li class="contact-card ' + (status === 'due' ? 'due-item' : status === 'soon' ? 'soon-item' : '') + '" data-open-contact="' + contact.id + '" role="button" tabindex="0">'
      + '<div class="contact-header">'
      + '<div class="contact-avatar-sm" aria-hidden="true">' + escapeHtml(initials) + '</div>'
      + '<div class="contact-summary">'
      + '<p class="contact-name"><strong>' + escapeHtml(contact.name) + '</strong>'
      + '<button class="contact-star-btn' + (contact.starred ? ' starred' : '') + '" data-star-contact="' + contact.id + '" type="button" title="' + (contact.starred ? 'Remove star' : 'Star as potential mentor') + '" aria-label="' + (contact.starred ? 'Remove star' : 'Star contact') + '">' + (contact.starred ? '★' : '☆') + '</button>'
      + '</p>'
      + '<p class="tiny">' + escapeHtml(contact.role || 'Role not set') + (contact.company ? ' @ <strong>' + escapeHtml(contact.company) + '</strong>' : '') + '</p>'
      + '</div>'
      + '<div class="badge-col">' + reminderBadge(contact) + '</div>'
      + '</div>'
      + '<div class="contact-meta">'
      + '<span class="tiny">Last met: ' + formatDate(contact.lastContacted) + '</span>'
      + (contact.nextReminder ? '<span class="tiny">Next reminder: ' + formatDate(contact.nextReminder.split('T')[0]) + '</span>' : '')
      + '</div>'
      + '</li>';
  }

  const starred = contacts.filter((c) => c.starred);
  const unstarred = contacts.filter((c) => !c.starred);

  let html = '';

  // Potential Mentors section
  if (starred.length) {
    html += '<li class="contact-alpha-header mentor-header">★ Potential Mentors</li>';
    starred.forEach((contact) => { html += contactCardHtml(contact); });
  }

  // Alphabetical buckets for the rest
  if (unstarred.length) {
    const buckets = new Map();
    unstarred.forEach((c) => {
      const letter = (c.name[0] || '#').toUpperCase();
      if (!buckets.has(letter)) buckets.set(letter, []);
      buckets.get(letter).push(c);
    });
    buckets.forEach((group, letter) => {
      html += '<li class="contact-alpha-header">' + letter + '</li>';
      group.forEach((contact) => { html += contactCardHtml(contact); });
    });
  }

  list.innerHTML = html;

  list.querySelectorAll('[data-open-contact]').forEach((card) => {
    const open = () => { window.location.href = 'contact.html?id=' + encodeURIComponent(card.dataset.openContact); };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });
  });

  list.querySelectorAll('[data-star-contact]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const allContacts = await db.getContacts();
      const contact = allContacts.find((c) => c.id === btn.dataset.starContact);
      if (!contact) return;
      await db.saveContact(normalizeContact({ ...contact, starred: !contact.starred }));
      await renderContacts(filterText);
    });
  });
}


// ── Contact calendar ──────────────────────────────────────────────────────────
// Renders a simple month grid (Sun→Sat) with orange dots on days where
// contacts were first met. Allows month navigation.

let calendarYear  = new Date().getFullYear();
let calendarMonth = new Date().getMonth(); // 0-indexed

async function renderCalendarView() {
  const grid     = document.getElementById("calendarGrid");
  const label    = document.getElementById("calMonthLabel");
  const tooltip  = document.getElementById("calTooltip");
  if (!grid) return;

  const contacts = (await db.getContacts()) || [];

  // Build a map: "YYYY-MM-DD" → [contact names]
  const dayMap = new Map();
  contacts.forEach((c) => {
    const d = c.dateMet || c.lastContacted;
    if (!d) return;
    const key = d.slice(0, 10); // normalise to YYYY-MM-DD
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(c.name);
  });

  const year  = calendarYear;
  const month = calendarMonth;

  if (label) {
    label.textContent = new Date(year, month, 1)
      .toLocaleString("default", { month: "long", year: "numeric" });
  }

  // Day-of-week headers
  const DOW_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  let html = '<div class="cal-row cal-header">'
    + DOW_LABELS.map((d) => '<span class="cal-cell cal-dow">' + d + '</span>').join("")
    + '</div>';

  const firstDow   = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMon  = new Date(year, month + 1, 0).getDate();

  // Weeks
  let dayNum = 1;
  for (let week = 0; week < 6; week++) {
    if (dayNum > daysInMon) break;
    html += '<div class="cal-row">';
    for (let dow = 0; dow < 7; dow++) {
      const cellDay = week * 7 + dow - firstDow + 1;
      if (cellDay < 1 || cellDay > daysInMon) {
        html += '<span class="cal-cell cal-empty"></span>';
      } else {
        const key  = year + "-" + String(month + 1).padStart(2, "0") + "-" + String(cellDay).padStart(2, "0");
        const has  = dayMap.has(key);
        const names = has ? dayMap.get(key) : [];
        const isToday = key === todayDateString();
        html += '<span class="cal-cell'
          + (isToday ? " cal-today" : "")
          + (has ? " cal-has-contact" : "")
          + '" data-cal-key="' + key + '" data-cal-names="' + escapeHtml(names.join(", ")) + '">'
          + cellDay
          + (has ? '<span class="cal-dot"></span>' : "")
          + '</span>';
        dayNum = cellDay;
      }
    }
    html += '</div>';
    dayNum++;
  }

  grid.innerHTML = html;

  // Hover tooltip
  grid.querySelectorAll(".cal-has-contact").forEach((cell) => {
    cell.addEventListener("mouseenter", () => {
      if (tooltip) tooltip.textContent = formatDate(cell.dataset.calKey) + ": " + cell.dataset.calNames;
    });
    cell.addEventListener("mouseleave", () => {
      if (tooltip) tooltip.textContent = "";
    });
  });
}

function initCalendarNav() {
  const prev = document.getElementById("calPrevBtn");
  const next = document.getElementById("calNextBtn");
  if (!prev || !next) return;
  prev.addEventListener("click", () => {
    calendarMonth--;
    if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
    renderCalendarView();
  });
  next.addEventListener("click", () => {
    calendarMonth++;
    if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
    renderCalendarView();
  });
}

// ── Internship panel ──────────────────────────────────────────────────────────

// ── Networking ────────────────────────────────────────────────────────────────

async function initNetworking() {
  const form = document.getElementById("contactForm");
  if (!form) return;
  const error = document.getElementById("contactError");
  const nameEl = document.getElementById("contactName");
  const emailEl = document.getElementById("contactEmail");
  const companyEl = document.getElementById("contactCompany");
  const roleEl = document.getElementById("contactRole");
  const dateMetEl = document.getElementById("dateMet");
  const followUpFrequencyEl = document.getElementById("followUpFrequency");
  const notesEl = document.getElementById("contactNotes");
  const filterEl = document.getElementById("contactFilter");

  // Pre-fill date to today
  if (dateMetEl && !dateMetEl.value) dateMetEl.value = todayDateString();

  // Live filter
  if (filterEl) {
    filterEl.addEventListener("input", () => renderContacts(filterEl.value));
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    const frequency = (followUpFrequencyEl ? followUpFrequencyEl.value : "") || "none";
    const dateMet = (dateMetEl ? dateMetEl.value : "") || todayDateString();
    const contact = normalizeContact({
      name: nameEl.value,
      email: emailEl.value,
      company: companyEl ? companyEl.value : "",
      role: roleEl ? roleEl.value : "",
      dateMet,
      lastContacted: dateMet,
      followUpFrequency: frequency,
      reminderEnabled: frequency !== "none",
      notes: notesEl ? notesEl.value : "",
      interactions: [],
      documents: []
    });
    if (!contact.name || !contact.email || !contact.dateMet || !contact.company) { error.textContent = "Name, email, company, and date last met are required."; return; }
    const saved = await db.saveContact(contact);
    if (!saved) { error.textContent = "Failed to save contact. Check the browser console (F12) for the Supabase error — it's usually a missing table column or RLS policy."; return; }
    form.reset();
    if (dateMetEl) dateMetEl.value = todayDateString();
    if (filterEl) filterEl.value = "";
    error.textContent = "";
    const successEl = document.getElementById("contactSuccess");
    if (successEl) { successEl.textContent = "Contact added!"; setTimeout(() => { successEl.textContent = ""; }, 3000); }
    await renderContacts();
    await renderWeeklyConnections("weeklyConnections");
    await renderFollowUpAlerts("networkFollowUps");
    await renderCalendarView();
  });

  refreshActivePageData = async () => {
    await renderContacts(filterEl ? filterEl.value : "");
    await renderWeeklyConnections("weeklyConnections");
    await renderFollowUpAlerts("networkFollowUps");
    await renderCalendarView();
  };

  await refreshActivePageData();
}

// ── Summary page ──────────────────────────────────────────────────────────────

// ── Contact page ──────────────────────────────────────────────────────────────

async function initContactPage() {
  const root = document.getElementById("contactPageContent");
  if (!root) return;
  const params = new URLSearchParams(window.location.search);
  const contactId = params.get("id");
  refreshActivePageData = renderPage;

  async function freshContact() {
    const contacts = (await db.getContacts()) || [];
    return contacts.find((c) => c.id === contactId) || null;
  }

  async function save(updateFn) {
    const c = await freshContact();
    if (!c) return;
    await db.saveContact(normalizeContact(updateFn(c)));
  }

  async function renderPage() {
    const c = await freshContact();
    if (!c) {
      root.innerHTML = '<div class="card"><p class="error">Contact not found. <a href="network.html">Back to Networking</a></p></div>';
      return;
    }
    const status = getReminderStatus(c);
    const freqLabel = getFreqLabel(c.followUpFrequency);
    const interactionTypeOptions = INTERACTION_TYPES.map((t) => '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>').join("");
    const isCustomFreq = c.followUpFrequency && c.followUpFrequency.startsWith("custom:");
    const customFreqDays = isCustomFreq ? c.followUpFrequency.slice(7) : "";
    const freqSelectValue = isCustomFreq ? "custom" : (c.followUpFrequency || "none");
    const freqOptions = Object.entries(FREQUENCY_LABELS).map(([v, l]) => '<option value="' + v + '"' + (freqSelectValue === v ? ' selected' : '') + '>' + l + '</option>').join("")
      + '<option value="custom"' + (isCustomFreq ? ' selected' : '') + '>Custom…</option>';

    // ── Avatar initials ──────────────────────────────────────────
    const nameParts = (c.name || "?").trim().split(/\s+/);
    const initials = nameParts.length >= 2
      ? (nameParts[0][0] + nameParts[nameParts.length - 1][0]).toUpperCase()
      : (nameParts[0][0] || "?").toUpperCase();

    // ── Company pills (current + history) ───────────────────────
    const pastCompanies = (c.companyHistory || []).filter((co) => co !== c.company);

    root.innerHTML =
      // ── Profile hero card ──────────────────────────────────────
      '<div class="card cp-profile-card">'
      + '<a href="network.html" class="btn btn-secondary back-btn">← Back to Networking</a>'
      + '<div class="cp-hero">'
      + '<div class="cp-avatar" aria-hidden="true">' + escapeHtml(initials) + '</div>'
      + '<div class="cp-identity">'
      + '<div class="cp-name-row">'
      + '<input type="text" id="cpNameInput" class="cp-name cp-name-input" value="' + escapeHtml(c.name) + '" aria-label="Contact name" />'
      + '<button class="cp-star-btn' + (c.starred ? ' starred' : '') + '" id="cpStarBtn" type="button" title="' + (c.starred ? 'Remove star' : 'Star as potential mentor') + '" aria-label="' + (c.starred ? 'Remove star' : 'Star contact') + '">' + (c.starred ? '★' : '☆') + '</button>'
      + (reminderBadge(c) ? '<div class="cp-hero-badges">' + reminderBadge(c) + '</div>' : '')
      + '</div>'
      + (c.role ? '<p class="cp-role">' + escapeHtml(c.role) + '</p>' : '')
      + '<div class="cp-companies">' + (c.company ? '<span class="cp-company-pill current">' + escapeHtml(c.company) + '</span>' : '<span class="muted" style="font-size:0.82rem">No company set</span>') + '</div>'
      + (pastCompanies.length ? '<div class="cp-prev-companies-row"><span class="cp-dates-label">Previous:</span><div class="cp-companies">' + pastCompanies.map((co) => '<span class="cp-company-pill past">' + escapeHtml(co) + '</span>').join("") + '</div></div>' : '')
      + (c.email ? '<a href="mailto:' + escapeHtml(c.email) + '" class="cp-email">✉ ' + escapeHtml(c.email) + '</a>' : '')
      + '</div>'
      + '<div class="cp-hero-actions">'
      + '<button class="btn btn-secondary" id="cpOpenReminderBtn" type="button">' + (status !== "none" ? "Manage Reminder" : "Send Email") + '</button>'
      + '<button class="btn btn-secondary danger-btn" id="cpDeleteBtn" type="button">Delete</button>'
      + '</div>'
      + '</div>'
      + '</div>'

      // ── Two-column body (flat grid, 4 items across 2 cols × 3 rows) ──
      + '<div class="contact-page-body">'

      // Col 1, rows 1–2: Log a Conversation
      + '<section class="card cp-log-card"><h3 class="section-title">Log a Conversation</h3>'
      + '<div class="two-col"><div class="field-group"><label>Date</label><input type="date" id="cpIntDate" value="' + todayDateString() + '" /></div>'
      + '<div class="field-group"><label>Type</label><select id="cpIntType">' + interactionTypeOptions + '</select></div></div>'
      + '<div class="field-group cp-log-notes-group"><label>Notes</label><textarea id="cpIntNotes" placeholder="What did you talk about?"></textarea></div>'
      + '<div class="field-group cp-log-notes-group"><label>Outcome / Action items</label><textarea id="cpIntOutcome" placeholder="What will you or they do next?"></textarea></div>'
      + '<div class="field-group"><label>Attach document <span class="cp-section-sub" style="font-weight:400">(optional PDF)</span></label><input type="file" id="cpIntDocInput" accept=".pdf,application/pdf" /></div>'
      + '<p id="cpIntError" class="error" aria-live="polite"></p>'
      + '<button class="btn" id="cpAddIntBtn" type="button">Save Conversation</button></section>'

      // Col 2, row 1: Things to Bring Up Next
      + '<section class="card cp-checkin-card">'
      + '<div class="followup-section-header">'
      + '<div><h3 class="section-title">Things to Bring Up Next</h3><p class="cp-section-sub">Check off items after discussing them.</p></div>'
      + '<button class="btn btn-secondary" id="cpSuggestBtn" type="button">✦ Suggest</button>'
      + '</div>'
      + '<div id="cpFollowUpList">' + renderFollowUpItems(c.followUps) + '</div>'
      + '<div class="followup-add-row"><input type="text" id="cpNewFollowUp" placeholder="Add a talking point…" /><button class="btn" id="cpAddFollowUpBtn" type="button">Add</button></div>'
      + '<p id="cpFollowUpMsg" class="success" aria-live="polite"></p>'
      + '</section>'

      // Col 2, row 2: Work History
      + '<section class="card">'
      + '<h3 class="section-title">Work History</h3>'
      + '<div class="two-col">'
      + '<div class="field-group"><label>Current Company</label><input type="text" id="cpCompany" value="' + escapeHtml(c.company) + '" placeholder="e.g. Google" /></div>'
      + '<div class="field-group"><label>Role / Title</label><input type="text" id="cpRole" value="' + escapeHtml(c.role) + '" placeholder="e.g. Software Engineer" /></div>'
      + '</div>'
      + '<div class="field-group">'
      + '<label>Past Companies <span class="cp-section-sub" style="font-weight:400">(comma-separated)</span></label>'
      + '<input type="text" id="cpCompanyHistory" value="' + escapeHtml((c.companyHistory || []).join(", ")) + '" placeholder="Meta, Apple, Stripe…" />'
      + '</div>'
      + '<button class="btn" id="cpSaveDetailsBtn" type="button">Save</button>'
      + '<p id="cpSaveDetailsMsg" class="success" aria-live="polite"></p>'
      + '</section>'

      // Col 1, row 3: Interaction Timeline
      + '<section class="card cp-timeline-col"><h3 class="section-title">Interaction Timeline</h3><div class="timeline" id="cpTimeline">' + renderInteractionTimeline(c.interactions) + '</div></section>'

      // Col 2, row 3: Stay in Touch
      + '<section class="card cp-reminder-card">'
      + '<div class="cp-reminder-header">'
      + '<h3 class="section-title">Stay in Touch</h3>'
      + '<div class="cp-reminder-toggle-row">'
      + '<label class="cp-toggle" aria-label="Reminders enabled"><input type="checkbox" id="cpReminderEnabled"' + (c.reminderEnabled ? ' checked' : '') + ' /><span class="cp-toggle-track"></span></label>'
      + '<span class="cp-toggle-label">Reminders enabled</span>'
      + '</div>'
      + '</div>'
      + '<div class="cp-reminder-meta">'
      + '<div class="cp-reminder-meta-item"><span class="cp-dates-label">Frequency</span><span class="cp-freq-badge">' + escapeHtml(freqLabel) + '</span></div>'
      + '<div class="cp-reminder-meta-item"><span class="cp-dates-label">Next reminder</span><span class="cp-date-chip">' + (c.nextReminder ? formatDate(c.nextReminder.split("T")[0]) : "Not set") + '</span></div>'
      + '</div>'
      + '<div class="cp-reminder-freq-row" style="margin-top:0.9rem">'
      + '<label class="cp-reminder-freq-label">Frequency</label>'
      + '<select id="cpFrequency">' + freqOptions + '</select>'
      + '<button class="btn" id="cpSaveReminderBtn" type="button">Save</button>'
      + '</div>'
      + '<div class="field-group" id="cpCustomDaysGroup"' + (isCustomFreq ? '' : ' style="display:none"') + '><label>Every how many days?</label><input type="number" id="cpCustomDays" min="1" max="365" placeholder="30" value="' + escapeHtml(customFreqDays) + '" /></div>'
      + '<p id="cpSaveReminderMsg" class="success" aria-live="polite"></p>'
      + '</section>'

      + '</div>';

    root.querySelector("#cpNameInput").addEventListener("blur", async (e) => {
      const newName = e.target.value.trim();
      if (!newName) { e.target.value = (await freshContact())?.name || ""; return; }
      await save((c) => ({ ...c, name: newName }));
    });
    root.querySelector("#cpStarBtn").addEventListener("click", async () => {
      await save((c) => ({ ...c, starred: !c.starred }));
      await renderPage();
    });
    root.querySelector("#cpOpenReminderBtn").addEventListener("click", async () => { showReminderModal(await freshContact()); });
    root.querySelector("#cpDeleteBtn").addEventListener("click", async () => {
      const contact = await freshContact();
      if (!contact || !window.confirm("Delete " + contact.name + " and all their data?")) return;
      await db.deleteContact(contactId);
      window.location.href = "network.html";
    });
    root.querySelector("#cpAddIntBtn").addEventListener("click", async () => {
      const errEl = root.querySelector("#cpIntError");
      errEl.textContent = "";
      const date = root.querySelector("#cpIntDate").value;
      const type = root.querySelector("#cpIntType").value;
      const notes = root.querySelector("#cpIntNotes").value.trim();
      const outcome = root.querySelector("#cpIntOutcome").value.trim();
      if (!date) { errEl.textContent = "Date is required."; return; }
      const docInput = root.querySelector("#cpIntDocInput");
      const docFile = docInput?.files?.[0];
      if (docFile && docFile.type !== "application/pdf") { errEl.textContent = "Only PDF files are allowed."; return; }
      const interaction = normalizeInteraction({ date, type, notes, outcome });
      await save((c) => {
        const newInteractions = [interaction, ...c.interactions].sort((a, b) => b.date.localeCompare(a.date));
        return { ...c, interactions: newInteractions, lastContacted: newInteractions[0].date, nextReminder: calculateNextReminder(newInteractions[0].date, c.followUpFrequency) };
      });
      if (docFile) {
        const uploadResult = await db.uploadFileToStorage(docFile, { contactId, category: "conversation" });
        if (!uploadResult) errEl.textContent = "Conversation saved but document upload failed.";
      }
      const fresh = await freshContact();
      const hasOpen = (fresh ? fresh.followUps || [] : []).some((f) => !f.completed);
      await renderPage();
      if (!hasOpen) {
        const msg = root.querySelector("#cpFollowUpMsg");
        if (msg) { msg.textContent = "Interaction saved! Use Suggest Follow-Ups to generate next steps."; setTimeout(() => { if (msg) msg.textContent = ""; }, 4000); }
      }
    });
    root.querySelector("#cpSaveDetailsBtn").addEventListener("click", async () => {
      const newCompany = root.querySelector("#cpCompany").value.trim();
      const newRole = root.querySelector("#cpRole").value.trim();
      const historyRaw = root.querySelector("#cpCompanyHistory").value;
      const newHistory = historyRaw.split(",").map((s) => s.trim()).filter(Boolean);
      await save((c) => ({ ...c, company: newCompany, role: newRole, companyHistory: newHistory }));
      const msg = root.querySelector("#cpSaveDetailsMsg");
      msg.textContent = "Details saved!";
      setTimeout(() => { if (msg) msg.textContent = ""; }, 2000);
      await renderPage();
    });
    const freqSelect = root.querySelector("#cpFrequency");
    const customDaysGroup = root.querySelector("#cpCustomDaysGroup");
    if (freqSelect && customDaysGroup) {
      freqSelect.addEventListener("change", () => {
        customDaysGroup.style.display = freqSelect.value === "custom" ? "" : "none";
      });
    }
    root.querySelector("#cpSaveReminderBtn").addEventListener("click", async () => {
      let newFreq = root.querySelector("#cpFrequency").value;
      if (newFreq === "custom") {
        const days = parseInt(root.querySelector("#cpCustomDays")?.value, 10);
        newFreq = (!isNaN(days) && days > 0) ? "custom:" + days : "none";
      }
      const enabled = root.querySelector("#cpReminderEnabled").checked;
      await save((c) => ({ ...c, followUpFrequency: newFreq, reminderEnabled: enabled && newFreq !== "none", nextReminder: calculateNextReminder(c.lastContacted || c.dateMet, newFreq) }));
      const msg = root.querySelector("#cpSaveReminderMsg");
      msg.textContent = "Saved!";
      setTimeout(() => { if (msg) msg.textContent = ""; }, 2000);
      await renderPage();
    });
    const addFollowUp = async () => {
      const input = root.querySelector("#cpNewFollowUp");
      const text = input ? input.value.trim() : "";
      if (!text) return;
      await save((c) => ({ ...c, followUps: [normalizeFollowUpItem({ text, source: "manual" }), ...(c.followUps || [])] }));
      if (input) input.value = "";
      await refreshFollowUpList();
    };
    root.querySelector("#cpAddFollowUpBtn").addEventListener("click", addFollowUp);
    root.querySelector("#cpNewFollowUp").addEventListener("keydown", (e) => { if (e.key === "Enter") addFollowUp(); });
    root.querySelector("#cpSuggestBtn").addEventListener("click", async () => {
      const fresh = await freshContact();
      if (!fresh) return;
      const suggestions = generateFollowUpSuggestions(fresh);
      const existingTexts = new Set((fresh.followUps || []).map((f) => f.text.toLowerCase()));
      const deduped = suggestions.map((text) => normalizeFollowUpItem({ text, source: "ai" })).filter((f) => !existingTexts.has(f.text.toLowerCase()));
      const msg = root.querySelector("#cpFollowUpMsg");
      if (!deduped.length) { if (msg) { msg.textContent = "All suggestions already added!"; setTimeout(() => { if (msg) msg.textContent = ""; }, 2500); } return; }
      await save((c) => ({ ...c, followUps: [...deduped, ...(c.followUps || [])] }));
      await refreshFollowUpList();
      if (msg) { msg.textContent = deduped.length + " suggestion" + (deduped.length !== 1 ? "s" : "") + " added!"; setTimeout(() => { if (msg) msg.textContent = ""; }, 2500); }
    });

    async function refreshFollowUpList() {
      const fresh = await freshContact();
      const listEl = root.querySelector("#cpFollowUpList");
      if (listEl && fresh) listEl.innerHTML = renderFollowUpItems(fresh.followUps);
      attachFollowUpListeners();
    }
    function attachFollowUpListeners() {
      root.querySelectorAll(".fu-checkbox").forEach((cb) => {
        cb.addEventListener("change", async () => {
          await save((c) => ({ ...c, followUps: (c.followUps || []).map((f) => f.id !== cb.dataset.fuId ? f : { ...f, completed: cb.checked }) }));
          await refreshFollowUpList();
        });
      });
      root.querySelectorAll(".fu-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await save((c) => ({ ...c, followUps: (c.followUps || []).filter((f) => f.id !== btn.dataset.fuId) }));
          await refreshFollowUpList();
        });
      });
    }
    attachFollowUpListeners();
  }

  await renderPage();
}

// ── Files page ────────────────────────────────────────────────────────────────

async function initFilesPage() {
  const fileGrid = document.getElementById("fileGrid");
  if (!fileGrid) return;

  let activeFilter = "all";
  let allFiles = [];

  // ── Populate dropdowns ───────────────────────────────────────────────────
  const internshipSelect = document.getElementById("fileInternship");
  const contactSelect    = document.getElementById("fileContact");

  const [internships, contacts] = await Promise.all([db.getInternships(), db.getContacts()]);

  if (internshipSelect) {
    internships.forEach((i) => {
      const opt = document.createElement("option");
      opt.value = i.id;
      opt.textContent = i.name + (i.company ? " @ " + i.company : "");
      internshipSelect.appendChild(opt);
    });
    const activeId = getActiveInternshipId();
    if (activeId) internshipSelect.value = activeId;
  }

  if (contactSelect) {
    contacts.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name + (c.company ? " @ " + c.company : "");
      contactSelect.appendChild(opt);
    });
  }

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const dropZone  = document.getElementById("fileDropZone");
  const fileInput = document.getElementById("fileInput");
  const preview   = document.getElementById("fileDropPreview");
  const errEl     = document.getElementById("fileUploadError");
  const msgEl     = document.getElementById("fileUploadMsg");
  let pendingFile = null;

  function validateAndPreview(file) {
    if (!file) return;
    if (file.type !== "application/pdf") {
      if (errEl) errEl.textContent = "Only PDF files are allowed.";
      return;
    }
    if (errEl) errEl.textContent = "";
    pendingFile = file;
    if (preview) {
      preview.textContent = "📄 " + file.name + " (" + (file.size / 1024).toFixed(1) + " KB)";
      preview.classList.remove("hidden");
    }
    if (dropZone) dropZone.classList.add("file-drop-zone-ready");
  }

  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("file-drop-zone-hover");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("file-drop-zone-hover");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("file-drop-zone-hover");
      validateAndPreview(e.dataTransfer.files[0]);
    });
    dropZone.addEventListener("click", () => {
      if (fileInput) fileInput.click();
    });
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (fileInput) fileInput.click(); }
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", () => validateAndPreview(fileInput.files[0]));
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  const uploadBtn = document.getElementById("fileUploadBtn");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      if (errEl) errEl.textContent = "";
      if (msgEl) msgEl.textContent = "";

      const file = pendingFile || (fileInput && fileInput.files[0]);
      if (!file) { if (errEl) errEl.textContent = "Please select a PDF file first."; return; }
      if (file.type !== "application/pdf") { if (errEl) errEl.textContent = "Only PDF files are allowed."; return; }

      const category     = document.getElementById("fileCategory")?.value || "general";
      const internshipId = internshipSelect?.value || null;
      const contactId    = contactSelect?.value || null;

      uploadBtn.disabled    = true;
      uploadBtn.textContent = "Uploading…";

      const result = await db.uploadFileToStorage(file, {
        category,
        internshipId: internshipId || null,
        contactId:    contactId    || null
      });

      uploadBtn.disabled    = false;
      uploadBtn.textContent = "Upload PDF →";

      if (!result) {
        if (errEl) errEl.textContent = "Upload failed. Check the bucket exists and try again.";
        return;
      }

      pendingFile = null;
      if (fileInput) fileInput.value = "";
      if (preview)  { preview.classList.add("hidden"); preview.textContent = ""; }
      if (dropZone) dropZone.classList.remove("file-drop-zone-ready");
      if (msgEl)    {
        msgEl.textContent = "✅ File uploaded successfully!";
        setTimeout(() => { if (msgEl) msgEl.textContent = ""; }, 3000);
      }
      await loadAndRenderFiles();
    });
  }

  // ── Filter tabs ──────────────────────────────────────────────────────────
  const filterTabsEl = document.getElementById("fileFilterTabs");
  if (filterTabsEl) {
    filterTabsEl.addEventListener("click", (e) => {
      const tab = e.target.closest(".filter-tab");
      if (!tab) return;
      activeFilter = tab.dataset.filter;
      filterTabsEl.querySelectorAll(".filter-tab").forEach((t) =>
        t.classList.toggle("filter-tab-active", t === tab)
      );
      renderGrid();
    });
  }

  // ── Render grid ──────────────────────────────────────────────────────────
  function renderGrid() {
    const filtered = activeFilter === "all"
      ? allFiles
      : allFiles.filter((f) => f.category === activeFilter);

    if (!filtered.length) {
      const msg = activeFilter === "all"
        ? "No files uploaded yet."
        : "No " + activeFilter + " files yet.";
      fileGrid.innerHTML = '<p class="empty" style="padding:1rem 0">' + msg + '</p>';
      return;
    }
    fileGrid.innerHTML = filtered.map((f) => renderStorageFileCard(f)).join("");
    attachStorageFileCardListeners(fileGrid, loadAndRenderFiles);
  }

  async function loadAndRenderFiles() {
    allFiles = await db.fetchAllStorageFiles();
    renderGrid();
  }

  await loadAndRenderFiles();
  refreshActivePageData = loadAndRenderFiles;
}

// ── Sign out ──────────────────────────────────────────────────────────────────

function initSignOut() {
  const btn = document.getElementById("signOutBtn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    window.location.href = "auth.html";
  });
}

// ── Check reminders on load ───────────────────────────────────────────────────

async function checkRemindersOnLoad() {
  if (document.querySelector("[data-page='contact']")) return;
  setTimeout(async () => {
    const contacts = (await db.getContacts()) || [];
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const due = contacts.filter((c) => c.reminderEnabled && c.nextReminder && new Date(c.nextReminder) <= now);
    if (due.length > 0) showReminderModal(due[0]);
  }, 800);
}

// ── Workspace ─────────────────────────────────────────────────────────────────
// Per-internship workspace: grid view → detail view.
// Each internship is its own "module" with daily log, weekly update, resume widget.

let workspaceCurrentInternshipId = "";
let weeklyUpdateOffset = 0;
let pendingLogFiles = [];
let refreshActivePageData = async () => {};

// ── Week helpers ──────────────────────────────────────────────────────────────

function getWeekRange(offset) {
  offset = offset || 0;
  const now = new Date();
  const dow = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return {
    start: mon.toISOString().split("T")[0],
    end:   sun.toISOString().split("T")[0],
    label: formatDate(mon.toISOString().split("T")[0]) + " – " + formatDate(sun.toISOString().split("T")[0])
  };
}

function isDateInWeek(dateStr, start, end) {
  if (!dateStr || !start || !end) return false;
  return dateStr >= start && dateStr <= end;
}

// ── API key management ────────────────────────────────────────────────────────

function getApiKey() { return localStorage.getItem("interntrack_anthropic_key") || ""; }
function setApiKey(key) { localStorage.setItem("interntrack_anthropic_key", key || ""); }

function promptForApiKey() {
  return new Promise((resolve) => {
    const existing = document.getElementById("apiKeyModal");
    if (existing) { resolve(); return; }
    const modal = document.createElement("div");
    modal.id = "apiKeyModal";
    modal.className = "modal-overlay";
    modal.innerHTML = '<div class="modal-card">'
      + '<h3>Add Anthropic API Key</h3>'
      + '<p class="muted" style="font-size:0.85rem;margin-bottom:0.75rem">Your key is stored only in your browser (localStorage) and is sent directly to the Anthropic API for AI generation features.</p>'
      + '<div class="field-group" style="margin-bottom:0.75rem"><label>API Key</label>'
      + '<input type="password" id="apiKeyInput" placeholder="sk-ant-…" style="font-family:monospace" /></div>'
      + '<div class="modal-actions">'
      + '<button class="btn" id="apiKeySave" type="button">Save & Continue</button>'
      + '<button class="btn btn-secondary" id="apiKeyCancel" type="button">Cancel</button>'
      + '</div>'
      + '<p id="apiKeyError" class="error" style="margin-top:0.5rem"></p>'
      + '</div>';
    document.body.appendChild(modal);
    modal.querySelector("#apiKeySave").addEventListener("click", () => {
      const val = (modal.querySelector("#apiKeyInput").value || "").trim();
      if (!val) { modal.querySelector("#apiKeyError").textContent = "Please enter your API key."; return; }
      setApiKey(val);
      modal.remove();
      resolve();
    });
    modal.querySelector("#apiKeyCancel").addEventListener("click", () => { modal.remove(); resolve(); });
    modal.querySelector("#apiKeyInput").focus();
  });
}

async function callAnthropicAPI(prompt, maxTokens) {
  maxTokens = maxTokens || 300;
  const key = getApiKey();
  if (!key) return null;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || "API error " + response.status);
    }
    const data = await response.json();
    return data.content?.[0]?.text || "";
  } catch (err) {
    console.error("[AI]", err.message);
    return null;
  }
}

// ── Workspace navigation ──────────────────────────────────────────────────────

async function navigateToGrid() {
  const grid   = document.getElementById("workspaceGrid");
  const detail = document.getElementById("workspaceDetail");
  if (!grid || !detail) return;
  workspaceCurrentInternshipId = "";
  sessionStorage.removeItem("interntrack_session_workspace_id");
  detail.classList.add("hidden");
  grid.classList.remove("hidden");
  await renderInternshipGrid();
}

async function navigateToInternship(id) {
  const grid   = document.getElementById("workspaceGrid");
  const detail = document.getElementById("workspaceDetail");
  if (!grid || !detail) return;
  workspaceCurrentInternshipId = id;
  sessionStorage.setItem("interntrack_session_workspace_id", id);
  setActiveInternshipId(id);
  grid.classList.add("hidden");
  detail.classList.remove("hidden");
  const internships = await db.getInternships();
  const internship  = internships.find((i) => i.id === id);
  if (!internship) return;
  renderInternshipDetailHeader(internship);
  initResumeWidget(internship);
  weeklyUpdateOffset = 0;
  pendingLogFiles = [];
  resetWorkspaceTabs();
  renderWeekIndicator();
  const logDate = document.getElementById("logDate");
  if (logDate) logDate.value = todayDateString();
  await renderWorkspaceTimeline();
  await renderWeeklyUpdate();
  await renderManagerHighlights(id);
}

// ── Internship grid ───────────────────────────────────────────────────────────

async function renderInternshipGrid() {
  const grid = document.getElementById("internshipModuleGrid");
  if (!grid) return;
  const internships = await db.getInternships();
  if (!internships.length) {
    grid.innerHTML = '<div class="intern-grid-empty">'
      + '<p class="intern-grid-empty-title">No internship workspaces yet.</p>'
      + '<p class="muted">Click "+ New Internship" above to create your first workspace.</p>'
      + '</div>';
    return;
  }
  const today = todayDateString();
  grid.innerHTML = internships.map((item) => {
    const isPast   = item.endDate && item.endDate < today;
    const badge    = isPast
      ? '<span class="intern-status-badge intern-badge-past">Completed</span>'
      : '<span class="intern-status-badge intern-badge-active">Active</span>';
    const dateRow  = [
      item.startDate ? formatDate(item.startDate) : null,
      item.endDate   ? formatDate(item.endDate)   : "Ongoing"
    ].filter(Boolean).join(" → ");
    return '<div class="intern-module-card ' + (isPast ? "intern-card-past" : "intern-card-active") + '">'
      + '<div class="intern-card-header">'
      + '<div class="intern-card-titles">'
      + '<h3 class="intern-card-role">' + escapeHtml(item.name) + '</h3>'
      + '<p class="intern-card-company">' + escapeHtml(item.company || "") + '</p>'
      + '</div>'
      + badge
      + '</div>'
      + '<p class="intern-card-dates">' + escapeHtml(dateRow) + '</p>'
      + (isPast ? '<p class="intern-card-resume-hint">✨ Resume points available</p>' : '')
      + '<div class="intern-card-actions">'
      + '<button class="btn intern-enter-btn" type="button" data-intern-id="' + item.id + '">Enter Workspace →</button>'
      + '<div class="intern-card-secondary-actions">'
      + '<button class="btn btn-secondary btn-sm" type="button" data-intern-edit="' + item.id + '">Edit</button>'
      + '<button class="btn btn-secondary btn-sm danger-btn" type="button" data-intern-delete="' + item.id + '">Delete</button>'
      + '</div></div></div>';
  }).join("");

  grid.querySelectorAll(".intern-enter-btn").forEach((btn) => {
    btn.addEventListener("click", () => navigateToInternship(btn.dataset.internId));
  });
  grid.querySelectorAll("[data-intern-edit]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openInternshipForm(internships.find((i) => i.id === btn.dataset.internEdit));
    });
  });
  grid.querySelectorAll("[data-intern-delete]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const target = internships.find((i) => i.id === btn.dataset.internDelete);
      if (!target || !window.confirm('Delete "' + target.name + '" and all its logs? This cannot be undone.')) return;
      await db.deleteInternship(btn.dataset.internDelete);
      if (workspaceCurrentInternshipId === btn.dataset.internDelete) workspaceCurrentInternshipId = "";
      await renderInternshipGrid();
    });
  });
}

// ── Internship form ───────────────────────────────────────────────────────────

function openInternshipForm(seed) {
  seed = seed || {};
  const card    = document.getElementById("internshipFormCard");
  const title   = document.getElementById("internshipFormTitle");
  const editId  = document.getElementById("internshipEditId");
  const nameEl  = document.getElementById("internshipName");
  const coEl    = document.getElementById("internshipCompany");
  const startEl = document.getElementById("internshipStart");
  const endEl   = document.getElementById("internshipEnd");
  const errEl   = document.getElementById("internshipError");
  if (!card) return;
  if (title)  title.textContent  = seed.id ? "Edit Internship" : "Add Internship";
  if (editId) editId.value       = seed.id || "";
  if (nameEl) nameEl.value       = seed.name || "";
  if (coEl)   coEl.value         = seed.company || "";
  if (startEl) startEl.value     = seed.startDate || "";
  if (endEl)  endEl.value        = seed.endDate || "";
  if (errEl)  errEl.textContent  = "";
  card.classList.remove("hidden");
  card.scrollIntoView({ behavior: "smooth", block: "start" });
  if (nameEl) nameEl.focus();
}

function closeInternshipForm() {
  const card = document.getElementById("internshipFormCard");
  const form = document.getElementById("internshipForm");
  if (card) card.classList.add("hidden");
  if (form) form.reset();
}

// ── Internship detail header ──────────────────────────────────────────────────

function renderInternshipDetailHeader(internship) {
  const el = document.getElementById("internshipDetailHeader");
  if (!el) return;
  const today   = todayDateString();
  const isPast  = internship.endDate && internship.endDate < today;
  const dateStr = [
    internship.startDate ? formatDate(internship.startDate) : null,
    internship.endDate   ? formatDate(internship.endDate)   : "Ongoing"
  ].filter(Boolean).join(" → ");
  el.innerHTML = '<div class="detail-header-content">'
    + '<h1 class="detail-role">' + escapeHtml(internship.name) + '</h1>'
    + (internship.company ? '<p class="detail-company">' + escapeHtml(internship.company) + '</p>' : '')
    + '<p class="detail-dates">' + escapeHtml(dateStr)
    + (isPast ? ' <span class="intern-status-badge intern-badge-past">Completed</span>' : '') + '</p>'
    + '</div>';
}

// ── Resume Points Widget ──────────────────────────────────────────────────────

function initResumeWidget(internship) {
  const widget = document.getElementById("resumeWidget");
  if (!widget) return;

  // Reset listeners by cloning nodes
  const freshWidget = widget.cloneNode(true);
  widget.parentNode.replaceChild(freshWidget, widget);
  const wDismiss  = freshWidget.querySelector("#resumeWidgetDismiss");
  const wGenerate = freshWidget.querySelector("#generateResumeBtn");
  const wCopy     = freshWidget.querySelector("#copyResumeBtn");

  const today      = todayDateString();
  const isPast     = internship.endDate && internship.endDate < today;
  const dismissKey = "interntrack_resume_dismissed_" + internship.id;

  if (!isPast || sessionStorage.getItem(dismissKey) === "1") {
    freshWidget.classList.add("hidden");
    return;
  }
  freshWidget.classList.remove("hidden");

  wDismiss?.addEventListener("click", () => {
    sessionStorage.setItem(dismissKey, "1");
    freshWidget.classList.add("hidden");
  });

  wGenerate?.addEventListener("click", async () => {
    const statusEl  = freshWidget.querySelector("#resumeGenStatus");
    const content   = freshWidget.querySelector("#resumeContent");
    const pointsEl  = freshWidget.querySelector("#resumePoints");
    if (content) content.classList.remove("hidden");
    if (statusEl) statusEl.textContent = "Generating resume points…";
    if (wGenerate) { wGenerate.disabled = true; wGenerate.textContent = "Generating…"; }

    if (!getApiKey()) {
      await promptForApiKey();
      if (!getApiKey()) {
        if (statusEl) statusEl.textContent = "API key required. Click the button again after adding your key.";
        if (wGenerate) { wGenerate.disabled = false; wGenerate.textContent = "Generate Points ✨"; }
        return;
      }
    }

    const allLogs  = await db.getLogs(internship.id);
    const logLines = allLogs.map((l) =>
      "- " + l.date + ": " + l.task + (l.impact ? " → " + l.impact : "")
    ).join("\n") || "No logs recorded.";

    const prompt = "You are helping an intern write strong resume bullet points. Based on their work log from their role as "
      + internship.name + " at " + (internship.company || "a company")
      + ", generate 4-6 resume bullet points.\n\nEach bullet should:\n- Start with a strong action verb\n- Be concise (one line)\n- Quantify impact where mentioned\n- Sound professional\n\nWork log:\n" + logLines
      + "\n\nReturn only the bullet points, one per line, each starting with a dash (-). No headers or extra text.";

    const result = await callAnthropicAPI(prompt, 600);
    if (wGenerate) { wGenerate.disabled = false; wGenerate.textContent = "Regenerate ✨"; }

    if (!result) {
      if (statusEl) statusEl.textContent = "Generation failed — verify your API key and try again.";
      return;
    }
    if (statusEl) statusEl.textContent = "";
    const bullets = result.split("\n").filter((l) => l.trim().startsWith("-"));
    if (pointsEl) {
      pointsEl.innerHTML = bullets.map((b) =>
        '<div class="resume-point-item">'
        + '<textarea class="resume-point-textarea" rows="2">' + escapeHtml(b.replace(/^-\s*/, "")) + '</textarea>'
        + '</div>'
      ).join("");
    }
  });

  wCopy?.addEventListener("click", async () => {
    const areas = freshWidget.querySelectorAll(".resume-point-textarea");
    const text  = Array.from(areas).map((t) => "• " + t.value.trim()).filter(Boolean).join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const orig = wCopy.textContent;
      wCopy.textContent = "Copied!";
      setTimeout(() => { wCopy.textContent = orig; }, 2000);
    } catch {
      alert("Copy failed — please select and copy manually.");
    }
  });
}

// ── Daily Log (detail view) ───────────────────────────────────────────────────

function initDetailLog() {
  const logForm    = document.getElementById("logForm");
  if (!logForm) return;
  const logDate    = document.getElementById("logDate");
  const logTask    = document.getElementById("logTask");
  const logBlockers = document.getElementById("logBlockers");
  const logImpact  = document.getElementById("logImpact");
  const logError   = document.getElementById("logError");
  const genBtn     = document.getElementById("generateImpactBtn");
  const statusEl   = document.getElementById("impactGenStatus");
  const dropZone   = document.getElementById("logDropZone");
  const fileInput  = document.getElementById("logFileInput");
  const pendingEl  = document.getElementById("logPendingFiles");

  function addPendingFiles(files) {
    Array.from(files).forEach((f) => {
      if (!pendingLogFiles.some((p) => p.file.name === f.name && p.file.size === f.size)) {
        pendingLogFiles.push({ file: f, uid: makeId() });
      }
    });
    renderPendingFiles();
  }

  function renderPendingFiles() {
    if (!pendingEl) return;
    if (!pendingLogFiles.length) { pendingEl.innerHTML = ""; return; }
    pendingEl.innerHTML = pendingLogFiles.map((p) =>
      '<div class="pending-file-item" data-uid="' + p.uid + '">'
      + '<span class="pending-file-icon">📄</span>'
      + '<span class="pending-file-name">' + escapeHtml(p.file.name) + '</span>'
      + '<span class="pending-file-size">' + (p.file.size / 1024).toFixed(1) + ' KB</span>'
      + '<button type="button" class="pending-file-remove" data-uid="' + p.uid + '">✕</button>'
      + '</div>'
    ).join("");
    pendingEl.querySelectorAll(".pending-file-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        pendingLogFiles = pendingLogFiles.filter((p) => p.uid !== btn.dataset.uid);
        renderPendingFiles();
      });
    });
  }

  if (dropZone) {
    dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("log-drop-zone-hover"); });
    dropZone.addEventListener("dragleave", ()  => dropZone.classList.remove("log-drop-zone-hover"));
    dropZone.addEventListener("drop",      (e) => {
      e.preventDefault();
      dropZone.classList.remove("log-drop-zone-hover");
      addPendingFiles(e.dataTransfer.files);
    });
    dropZone.addEventListener("click", (e) => {
      if (e.target.tagName !== "LABEL" && e.target.tagName !== "INPUT") fileInput?.click();
    });
  }
  if (fileInput) {
    fileInput.addEventListener("change", () => { addPendingFiles(fileInput.files); fileInput.value = ""; });
  }

  genBtn?.addEventListener("click", async () => {
    const task     = logTask?.value.trim() || "";
    const blockers = logBlockers?.value.trim() || "";
    if (!task) { if (statusEl) statusEl.textContent = "Describe your tasks first."; return; }
    if (!getApiKey()) {
      await promptForApiKey();
      if (!getApiKey()) { if (statusEl) statusEl.textContent = "API key required for AI generation."; return; }
    }
    if (genBtn) { genBtn.disabled = true; genBtn.textContent = "Generating…"; }
    if (statusEl) statusEl.textContent = "Generating impact statement…";
    const fileNames = pendingLogFiles.map((p) => p.file.name).join(", ");
    const prompt = "Write a concise 1-2 sentence impact statement in first person for an intern's daily work log.\n\nTasks completed: " + task
      + (blockers ? "\nQuestions/blockers: " + blockers : "")
      + (fileNames ? "\nFiles worked with: " + fileNames : "")
      + "\n\nReturn only the impact statement. Start with an action verb. Be specific and professional. No quotation marks.";
    const result = await callAnthropicAPI(prompt, 150);
    if (genBtn) { genBtn.disabled = false; genBtn.textContent = "Generate ✨"; }
    if (result) {
      if (logImpact) logImpact.value = result.trim();
      if (statusEl)  statusEl.textContent = "";
    } else {
      if (statusEl) statusEl.textContent = "Generation failed — check your API key or write the impact manually.";
    }
  });

  logForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (logError) logError.textContent = "";
    const activeId = workspaceCurrentInternshipId;
    if (!activeId) { if (logError) logError.textContent = "No internship selected."; return; }
    const entry = normalizeLog({
      date:     logDate?.value     || todayDateString(),
      task:     logTask?.value     || "",
      impact:   logImpact?.value   || "",
      blockers: logBlockers?.value || ""
    });
    if (!entry.date || !entry.task) { if (logError) logError.textContent = "Tasks completed is required."; return; }
    const saved = await db.saveLog(entry, activeId);
    if (!saved) { if (logError) logError.textContent = "Failed to save log. Check console for details."; return; }
    for (const p of pendingLogFiles) {
      await db.uploadFileToStorage(p.file, { internshipId: activeId, category: "daily-log" });
    }
    pendingLogFiles = [];
    renderPendingFiles();
    if (logTask)     logTask.value     = "";
    if (logImpact)   logImpact.value   = "";
    if (logBlockers) logBlockers.value = "";
    if (statusEl)    statusEl.textContent = "";
    await renderWorkspaceTimeline();
    await renderWeeklyUpdate();
  });

  refreshActivePageData = async () => {
    await renderWorkspaceTimeline();
    await renderWeeklyUpdate();
    await renderManagerHighlights(workspaceCurrentInternshipId);
  };
}

// ── Workspace timeline ────────────────────────────────────────────────────────

async function renderWorkspaceTimeline() {
  const container = document.getElementById("timelineContainer");
  if (!container) return;
  const activeId = workspaceCurrentInternshipId || getActiveInternshipId();
  if (!activeId) {
    container.innerHTML = '<p class="timeline-empty">Select an internship to view logs.</p>';
    return;
  }
  const [allLogs, allFiles] = await Promise.all([
    db.getLogs(activeId),
    db.fetchStorageFilesByInternship(activeId)
  ]);
  if (!allLogs.length) {
    container.innerHTML = '<p class="timeline-empty">No logs yet. Use the form above to record your first entry.</p>';
    return;
  }

  const filesByDate = new Map();
  allFiles.forEach((f) => {
    if (f.category !== "daily-log") return;
    const date = f.createdAt ? f.createdAt.slice(0, 10) : "";
    if (!date) return;
    if (!filesByDate.has(date)) filesByDate.set(date, []);
    filesByDate.get(date).push(f);
  });

  function getWeekMonday(dateStr) {
    const d   = parseDateOnly(dateStr);
    const dow = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return mon.toISOString().split("T")[0];
  }

  const weekMap = new Map();
  allLogs.forEach((log) => {
    const wk = getWeekMonday(log.date);
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk).push(log);
  });
  const sortedWeeks = Array.from(weekMap.entries()).sort(([a], [b]) => b.localeCompare(a));

  let html = "";
  sortedWeeks.forEach(([weekMon, logs]) => {
    const monDate = parseDateOnly(weekMon);
    const friDate = new Date(monDate);
    friDate.setDate(monDate.getDate() + 4);
    const weekLabel = "Week of " + formatDate(weekMon) + " – " + formatDate(friDate.toISOString().split("T")[0]);
    const rows = [...logs].sort((a, b) => b.date.localeCompare(a.date)).map((log) => {
      const dateFiles = filesByDate.get(log.date) || [];
      const filesHtml = dateFiles.length
        ? '<div class="log-row-files">' + dateFiles.map((f) =>
            '<a class="log-file-chip" href="' + escapeHtml(f.fileUrl) + '" target="_blank" rel="noopener">📄 ' + escapeHtml(f.name) + '</a>'
          ).join("") + '</div>'
        : "";
      return '<div class="log-row">'
        + '<span class="log-row-date">' + formatDate(log.date) + "</span>"
        + '<div class="log-row-body">'
        + '<p class="log-task">' + escapeHtml(log.task) + "</p>"
        + (log.impact ? '<p class="log-impact"><span class="entry-arrow">→</span> ' + escapeHtml(log.impact) + "</p>" : "")
        + (log.blockers ? '<span class="log-blocker-badge">⚠ ' + escapeHtml(log.blockers) + "</span>" : "")
        + filesHtml
        + "</div></div>";
    }).join("");
    html += '<div class="week-section"><p class="week-label">' + weekLabel + "</p>"
      + '<div class="week-entries">' + rows + "</div></div>";
  });
  container.innerHTML = html;
}

// ── Weekly Manager Update ─────────────────────────────────────────────────────

async function renderWeeklyUpdate() {
  const area     = document.getElementById("generatedSummary");
  const navLabel = document.getElementById("weekNavLabel");
  const nextBtn  = document.getElementById("nextWeekBtn");
  if (!area) return;
  const week = getWeekRange(weeklyUpdateOffset);
  if (navLabel) navLabel.textContent = week.label;
  if (nextBtn)  nextBtn.disabled = weeklyUpdateOffset >= 0;
  const activeId  = workspaceCurrentInternshipId || getActiveInternshipId();
  if (!activeId) { area.value = ""; return; }
  const allLogs   = await db.getLogs(activeId);
  const weekLogs  = allLogs.filter((l) => isDateInWeek(l.date, week.start, week.end));
  const manager   = (document.getElementById("managerName")?.value    || "").trim() || "[Manager Name]";
  const yourName  = (document.getElementById("yourName")?.value      || "").trim() || "[Your Name]";
  const nextPlans = (document.getElementById("nextPlansInput")?.value  || "").trim();
  const blockNote = (document.getElementById("blockersNoteInput")?.value || "").trim();

  const subject = "Subject: Weekly Update — " + week.label;

  const top5 = [...weekLogs].sort((a, b) => scoreImpact(b) - scoreImpact(a)).slice(0, 5);
  const lines = Array.from({ length: 5 }, (_, i) => {
    const log = top5[i];
    return (i + 1) + ". " + (log ? (log.impact || log.task || "") : "");
  });

  const autoBlockers = weekLogs.map((l) => l.blockers).filter(Boolean).join("; ");
  const blockersLine = blockNote || autoBlockers || "";

  area.value = subject
    + "\n\nHi " + manager + ","
    + "\n\nHere’s a quick update on what I worked on this week:\n\n"
    + lines.join("\n")
    + "\n\nNext week I’m planning to: " + nextPlans
    + "\n\nAny blockers or things I need from you: " + blockersLine
    + "\n\nThanks! — " + yourName;
}

// ── Manager Highlights Widget ──────────────────────────────────────────────────

async function renderManagerHighlights(internshipId) {
  const list = document.getElementById("managerHighlightsList");
  if (!list || !internshipId) return;

  const week       = getWeekRange(0);
  const items      = list.querySelectorAll(".highlight-item");
  const storageKey = "interntrack_highlights_" + internshipId + "_" + week.start;
  const saved      = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || "null"); } catch { return null; } })();

  if (saved && Array.isArray(saved) && saved.length === 5) {
    saved.forEach((text, i) => { if (items[i]) items[i].value = text; });
    return;
  }

  const allLogs  = await db.getLogs(internshipId);
  const weekLogs = allLogs.filter((l) => isDateInWeek(l.date, week.start, week.end));
  const top5     = [...weekLogs].sort((a, b) => scoreImpact(b) - scoreImpact(a)).slice(0, 5);
  items.forEach((el, i) => { el.value = top5[i] ? (top5[i].impact || top5[i].task || "") : ""; });
}

function initManagerHighlights() {
  const saveBtn  = document.getElementById("saveHighlightsBtn");
  const regenBtn = document.getElementById("regenHighlightsBtn");
  const msgEl    = document.getElementById("highlightsSaveMsg");
  if (!saveBtn) return;

  const currentKey = () => {
    const week = getWeekRange(0);
    return "interntrack_highlights_" + workspaceCurrentInternshipId + "_" + week.start;
  };

  saveBtn.addEventListener("click", () => {
    if (!workspaceCurrentInternshipId) return;
    const values = Array.from(document.querySelectorAll(".highlight-item")).map((el) => el.value.trim());
    localStorage.setItem(currentKey(), JSON.stringify(values));
    if (msgEl) { msgEl.textContent = "Saved!"; setTimeout(() => { msgEl.textContent = ""; }, 2000); }
  });

  regenBtn?.addEventListener("click", async () => {
    if (!workspaceCurrentInternshipId) return;
    localStorage.removeItem(currentKey());
    await renderManagerHighlights(workspaceCurrentInternshipId);
    if (msgEl) { msgEl.textContent = "Refreshed from logs."; setTimeout(() => { msgEl.textContent = ""; }, 2000); }
  });
}

async function initWeeklyUpdate() {
  const prevBtn   = document.getElementById("prevWeekBtn");
  const nextBtn   = document.getElementById("nextWeekBtn");
  const regenBtn  = document.getElementById("regenerateSummaryBtn");
  const copyBtn   = document.getElementById("copySummaryBtn");
  const emailBtn  = document.getElementById("emailSummaryBtn");
  const msgEl     = document.getElementById("summaryMessage");
  const managerEl   = document.getElementById("managerName");
  const nameEl      = document.getElementById("yourName");
  const emailEl     = document.getElementById("yourEmail");
  const nextPlansEl = document.getElementById("nextPlansInput");
  const blockersEl  = document.getElementById("blockersNoteInput");
  if (!regenBtn) return;

  renderWeekIndicator();

  const prefs = await db.getPreferences();
  if (managerEl)   managerEl.value   = prefs.manager_name || "";
  if (nameEl)      nameEl.value      = prefs.your_name    || "";
  if (emailEl)     emailEl.value     = prefs.your_email   || "";
  if (nextPlansEl) nextPlansEl.value = localStorage.getItem("interntrack_next_plans")    || "";
  if (blockersEl)  blockersEl.value  = localStorage.getItem("interntrack_blockers_note") || "";

  const savePrefs = async () => {
    await db.savePreferences({
      manager_name: managerEl?.value || "",
      your_name:    nameEl?.value    || "",
      your_email:   emailEl?.value   || ""
    });
    if (nextPlansEl) localStorage.setItem("interntrack_next_plans",    nextPlansEl.value);
    if (blockersEl)  localStorage.setItem("interntrack_blockers_note", blockersEl.value);
  };
  managerEl?.addEventListener("blur",   savePrefs);
  nameEl?.addEventListener("blur",      savePrefs);
  emailEl?.addEventListener("blur",     savePrefs);
  nextPlansEl?.addEventListener("blur", savePrefs);
  blockersEl?.addEventListener("blur",  savePrefs);

  prevBtn?.addEventListener("click",  async () => { weeklyUpdateOffset--; await renderWeeklyUpdate(); });
  nextBtn?.addEventListener("click",  async () => { if (weeklyUpdateOffset < 0) { weeklyUpdateOffset++; await renderWeeklyUpdate(); } });
  regenBtn?.addEventListener("click", async () => { await savePrefs(); await renderWeeklyUpdate(); });

  copyBtn?.addEventListener("click", async () => {
    const area = document.getElementById("generatedSummary");
    if (!area?.value.trim()) { if (msgEl) msgEl.textContent = "Nothing to copy yet."; return; }
    try {
      await navigator.clipboard.writeText(area.value);
      if (msgEl) { msgEl.textContent = "Copied to clipboard!"; setTimeout(() => { msgEl.textContent = ""; }, 2000); }
    } catch {
      if (msgEl) msgEl.textContent = "Copy failed — please select and copy manually.";
    }
  });

  emailBtn?.addEventListener("click", () => {
    const area  = document.getElementById("generatedSummary");
    const text  = area?.value.trim() || "";
    const email = emailEl?.value.trim() || "";
    if (!text) { if (msgEl) msgEl.textContent = "No update to send yet."; return; }
    const week    = getWeekRange(weeklyUpdateOffset);
    const subject = "Weekly Update — " + week.label;
    window.open("mailto:" + encodeURIComponent(email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(text), "_blank");
    if (msgEl) { msgEl.textContent = "Opening your email client…"; setTimeout(() => { msgEl.textContent = ""; }, 3000); }
  });
}

// ── Workspace tabs ────────────────────────────────────────────────────────────

function initWorkspaceTabs() {
  const tabBar = document.querySelector(".ws-tab-bar");
  if (!tabBar) return;
  tabBar.addEventListener("click", (e) => {
    const tab = e.target.closest(".ws-tab");
    if (!tab) return;
    const target = tab.dataset.tab;
    tabBar.querySelectorAll(".ws-tab").forEach((t) => t.classList.toggle("active", t === tab));
    ["logs", "stories", "files"].forEach((id) => {
      const panel = document.getElementById("wsTab" + id.charAt(0).toUpperCase() + id.slice(1));
      if (panel) panel.classList.toggle("hidden", id !== target);
    });
    if (target === "stories") renderStoriesTab(workspaceCurrentInternshipId);
    if (target === "files")   renderWsFilesTab(workspaceCurrentInternshipId);
  });
}

function resetWorkspaceTabs() {
  const tabBar = document.querySelector(".ws-tab-bar");
  if (!tabBar) return;
  tabBar.querySelectorAll(".ws-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "logs"));
  ["wsTabLogs", "wsTabStories", "wsTabFiles"].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("hidden", i !== 0);
  });
}

// ── Week indicator ────────────────────────────────────────────────────────────

function renderWeekIndicator() {
  const el = document.getElementById("weekIndicatorRange");
  if (!el) return;
  el.textContent = getWeekRange(0).label;
}

// ── Stories tab ───────────────────────────────────────────────────────────────

function getStoriesFromStorage(internshipId) {
  try { return JSON.parse(localStorage.getItem("interntrack_stories_" + internshipId) || "[]"); } catch { return []; }
}
function setStoriesInStorage(internshipId, stories) {
  localStorage.setItem("interntrack_stories_" + internshipId, JSON.stringify(stories));
}

function renderStoriesTab(internshipId) {
  const container = document.getElementById("storiesList");
  if (!container || !internshipId) return;
  const stories = getStoriesFromStorage(internshipId).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  if (!stories.length) {
    container.innerHTML = '<p class="empty" style="padding:0.5rem 0">No stories yet. Document a win or challenge above.</p>';
    return;
  }
  container.innerHTML = stories.map((s) => `
    <div class="story-card" data-story-id="${escapeHtml(s.id)}">
      <div class="story-card-header">
        <div class="story-card-meta">
          ${s.title ? `<span class="story-card-title">${escapeHtml(s.title)}</span>` : ""}
          <span class="story-card-date">${s.date ? formatDate(s.date) : "No date"}</span>
        </div>
        <button class="story-delete-btn" data-delete-story="${escapeHtml(s.id)}" type="button">Delete</button>
      </div>
      <div class="story-card-body">${escapeHtml(s.content)}</div>
      <div class="story-card-actions">
        <button class="story-expand-btn" data-expand-story type="button">Show more</button>
      </div>
    </div>`).join("");
  container.querySelectorAll("[data-delete-story]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.deleteStory;
      const updated = getStoriesFromStorage(internshipId).filter((s) => s.id !== id);
      setStoriesInStorage(internshipId, updated);
      renderStoriesTab(internshipId);
    });
  });
  container.querySelectorAll("[data-expand-story]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const body = btn.closest(".story-card")?.querySelector(".story-card-body");
      if (!body) return;
      const expanded = body.classList.toggle("expanded");
      btn.textContent = expanded ? "Show less" : "Show more";
    });
  });
}

function initStoriesTab() {
  const form      = document.getElementById("storyForm");
  const dateEl    = document.getElementById("storyDate");
  const titleEl   = document.getElementById("storyTitle");
  const contentEl = document.getElementById("storyContent");
  const errorEl   = document.getElementById("storyError");
  if (!form) return;
  if (dateEl) dateEl.value = todayDateString();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = workspaceCurrentInternshipId;
    if (!id) return;
    const content = (contentEl?.value || "").trim();
    if (!content) { if (errorEl) errorEl.textContent = "Content is required."; return; }
    if (errorEl) errorEl.textContent = "";
    const story = {
      id: makeId(),
      date: dateEl?.value || "",
      title: (titleEl?.value || "").trim(),
      content,
      createdAt: new Date().toISOString()
    };
    const stories = getStoriesFromStorage(id);
    stories.unshift(story);
    setStoriesInStorage(id, stories);
    form.reset();
    if (dateEl) dateEl.value = todayDateString();
    renderStoriesTab(id);
  });
}

// ── Workspace files tab ───────────────────────────────────────────────────────

async function renderWsFilesTab(internshipId) {
  const list = document.getElementById("wsFileList");
  if (!list || !internshipId) return;
  const files = await db.fetchStorageFilesByInternship(internshipId);
  if (!files.length) {
    list.innerHTML = '<p class="empty" style="padding:0.5rem 0">No files uploaded yet.</p>';
    return;
  }
  list.innerHTML = files.map((f) => `
    <div class="ws-file-item">
      <span class="ws-file-item-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="ws-file-item-date">${f.createdAt ? formatDate(f.createdAt.slice(0, 10)) : ""}</span>
      ${f.fileUrl ? `<a class="ws-file-item-link" href="${escapeHtml(f.fileUrl)}" target="_blank" rel="noopener">Open ↗</a>` : ""}
    </div>`).join("");
}

function initWsFilesTab() {
  const dropZone  = document.getElementById("wsFileDropZone");
  const fileInput = document.getElementById("wsFileInput");
  const msgEl     = document.getElementById("wsFileUploadMsg");
  if (!dropZone || !fileInput) return;

  async function uploadFiles(fileList) {
    const id = workspaceCurrentInternshipId;
    if (!id || !fileList.length) return;
    if (msgEl) msgEl.textContent = "Uploading…";
    for (const file of fileList) {
      await db.uploadFileToStorage(file, { internshipId: id, category: "workspace" });
    }
    if (msgEl) { msgEl.textContent = "Uploaded!"; setTimeout(() => { msgEl.textContent = ""; }, 2000); }
    await renderWsFilesTab(id);
  }

  fileInput.addEventListener("change", () => { if (fileInput.files?.length) uploadFiles(fileInput.files); fileInput.value = ""; });
  dropZone.addEventListener("dragover",  (e) => { e.preventDefault(); dropZone.classList.add("log-drop-zone-hover"); });
  dropZone.addEventListener("dragleave", ()  => dropZone.classList.remove("log-drop-zone-hover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault(); dropZone.classList.remove("log-drop-zone-hover");
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
  });
}

// ── Main workspace init ───────────────────────────────────────────────────────

async function initWorkspace() {
  const grid = document.getElementById("workspaceGrid");
  if (!grid) return;

  document.getElementById("addInternshipBtn")?.addEventListener("click", () => openInternshipForm());
  document.getElementById("internshipCancelBtn")?.addEventListener("click", closeInternshipForm);

  document.getElementById("internshipForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl   = document.getElementById("internshipError");
    if (errEl) errEl.textContent = "";
    const name    = (document.getElementById("internshipName")?.value    || "").trim();
    const company = (document.getElementById("internshipCompany")?.value || "").trim();
    const start   = document.getElementById("internshipStart")?.value    || "";
    const end     = document.getElementById("internshipEnd")?.value      || "";
    if (!name)    { if (errEl) errEl.textContent = "Role / Title is required.";  return; }
    if (!company) { if (errEl) errEl.textContent = "Company is required.";       return; }
    if (!start)   { if (errEl) errEl.textContent = "Start date is required.";    return; }
    const editId = document.getElementById("internshipEditId")?.value || "";
    if (editId) {
      const all    = await db.getInternships();
      const target = all.find((i) => i.id === editId);
      if (target) await db.saveInternship({ ...target, name, company, startDate: start, endDate: end });
    } else {
      const newItem = { id: makeId(), name, company, startDate: start, endDate: end, createdAt: new Date().toISOString() };
      const saved   = await db.saveInternship(newItem);
      if (!saved) { if (errEl) errEl.textContent = "Failed to save. Check console for details."; return; }
    }
    closeInternshipForm();
    await renderInternshipGrid();
  });

  document.getElementById("backToGridBtn")?.addEventListener("click", navigateToGrid);

  document.getElementById("editInternshipDetailBtn")?.addEventListener("click", async () => {
    const all     = await db.getInternships();
    const current = all.find((i) => i.id === workspaceCurrentInternshipId);
    if (!current) return;
    await navigateToGrid();
    openInternshipForm(current);
  });

  document.getElementById("deleteInternshipDetailBtn")?.addEventListener("click", async () => {
    const all     = await db.getInternships();
    const current = all.find((i) => i.id === workspaceCurrentInternshipId);
    if (!current || !window.confirm('Delete "' + current.name + '" and all its logs? This cannot be undone.')) return;
    await db.deleteInternship(workspaceCurrentInternshipId);
    await navigateToGrid();
  });

  initDetailLog();
  initManagerHighlights();
  initWorkspaceTabs();
  initStoriesTab();
  initWsFilesTab();
  await initWeeklyUpdate();

  const sessionId = sessionStorage.getItem("interntrack_session_workspace_id");
  if (sessionId) {
    const internships = await db.getInternships();
    const match = internships.find((i) => i.id === sessionId);
    if (match) {
      await navigateToInternship(match.id);
    } else {
      await renderInternshipGrid();
    }
  } else {
    await renderInternshipGrid();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// requireAuth() redirects to auth.html if the user is not signed in.
// All init functions are no-ops on pages where their root element is absent,
// so this single boot sequence works across all four app pages.

(async () => {
  const user = await requireAuth();
  if (!user) return;
  initSidebarToggle();
  initThemeToggle();
  initSignOut();
  await initWorkspace();
  await initNetworking();
  await initContactPage();
  await initFilesPage();
  initCalendarNav();
  await renderCalendarView();
  await checkRemindersOnLoad();
})();
