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
  monthly: "Monthly",
  bimonthly: "Every 2 months",
  quarterly: "Quarterly",
  none: "No reminders"
};

function calculateNextReminder(lastContacted, frequency) {
  if (!lastContacted || frequency === "none") return "";
  const date = new Date(lastContacted);
  if (frequency === "monthly") date.setMonth(date.getMonth() + 1);
  if (frequency === "bimonthly") date.setMonth(date.getMonth() + 2);
  if (frequency === "quarterly") date.setMonth(date.getMonth() + 3);
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
      : []
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
  const suggestions = [];
  const interests = (contact.interests || "").toLowerCase();
  const notes = (contact.notes || "").toLowerCase();
  const advice = (contact.adviceGiven || "").toLowerCase();
  const role = (contact.role || "").toLowerCase();
  const name = contact.name || "them";

  if (interests.includes("ai") || interests.includes("machine learning") || notes.includes("ai"))
    suggestions.push("Send an article about recent AI trends");
  if (interests.includes("design") || interests.includes("ux") || interests.includes("product"))
    suggestions.push("Share a product design case study or article");
  if (interests.includes("startup") || interests.includes("entrepreneur"))
    suggestions.push("Share a startup story or resource they might find interesting");
  if (interests.includes("open source") || interests.includes("github"))
    suggestions.push("Invite " + name + " to collaborate on an open-source project");
  if (advice)
    suggestions.push("Follow up on their advice and share your progress since your last talk");
  if (role.includes("engineer") || role.includes("developer") || role.includes("software"))
    suggestions.push("Share a technical article, repo, or tool relevant to their work");
  if (role.includes("manager") || role.includes("director") || role.includes("lead"))
    suggestions.push("Ask for feedback on your growth since your last conversation");
  if (role.includes("recruiter") || role.includes("talent") || role.includes("hr"))
    suggestions.push("Send an updated resume or LinkedIn summary");
  const interactionCount = contact.interactions?.length || 0;
  if (interactionCount === 0)
    suggestions.push("Send a quick intro message to break the ice with " + name);
  else if (interactionCount >= 3)
    suggestions.push("Consider asking to grab coffee (virtual or in-person)");
  if (notes.includes("referral") || notes.includes("refer"))
    suggestions.push("Follow up about the referral they mentioned");
  if (notes.includes("project") || notes.includes("work"))
    suggestions.push("Ask for an update on the project they mentioned");
  if (notes.includes("conference") || notes.includes("event") || notes.includes("meetup"))
    suggestions.push("Share a recap or resource from the event you both attended");
  suggestions.push("Schedule a quick check-in call");
  suggestions.push("Send " + name + " a thoughtful update on what you have been working on");
  return [...new Set(suggestions)].slice(0, 5);
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderFollowUpItems(followUps) {
  if (!followUps.length) {
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

function renderInteractionTimeline(interactions) {
  if (!interactions.length) return '<p class="empty">No interactions logged yet.</p>';
  return interactions.map((item) => [
    '<div class="timeline-item">',
    '  <div class="timeline-dot"></div>',
    '  <div class="timeline-body">',
    '    <p class="timeline-date">' + formatDate(item.date) + ' <span class="tag">' + escapeHtml(item.type) + '</span></p>',
    item.notes ? '    <p>' + escapeHtml(item.notes) + '</p>' : '',
    item.outcome ? '    <p class="tiny"><span class="label">Outcome:</span> ' + escapeHtml(item.outcome) + '</p>' : '',
    '  </div>',
    '</div>'
  ].filter(Boolean).join("\n")).join("\n");
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
  const freqLabel = FREQUENCY_LABELS[contact.followUpFrequency] || "Unknown";
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
  const contacts = await db.getContacts();
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

async function renderLogs() {
  const list = document.getElementById("logList");
  if (!list) return;
  const activeId = getActiveInternshipId();
  if (!activeId) { list.innerHTML = '<li class="empty">Select an internship to view logs.</li>'; return; }
  const logs = (await db.getLogs(activeId)).sort((a, b) => b.date.localeCompare(a.date));
  if (!logs.length) { list.innerHTML = '<li class="empty">No impact logs yet.</li>'; return; }
  list.innerHTML = logs.map((log) =>
    '<li class="list-item">'
    + '<p><strong>' + formatDate(log.date) + '</strong></p>'
    + '<p><span class="label">Did:</span> ' + escapeHtml(log.task) + '</p>'
    + '<p><span class="label">Impact:</span> ' + escapeHtml(log.impact) + '</p>'
    + '<p><span class="label">Skills:</span> ' + escapeHtml(log.skills) + '</p>'
    + '<div class="tag-row">' + log.tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join("") + '</div>'
    + '</li>'
  ).join("");
}

async function renderFiles() {
  const list = document.getElementById("fileList");
  if (!list) return;
  const activeId = getActiveInternshipId();
  if (!activeId) { list.innerHTML = '<li class="empty">Select an internship to view files.</li>'; return; }
  const files = (await db.getFiles(activeId)).sort((a, b) => b.date.localeCompare(a.date));
  if (!files.length) { list.innerHTML = '<li class="empty">No PDFs uploaded yet.</li>'; return; }
  list.innerHTML = files.map((file) =>
    '<li class="list-item">'
    + '<p><strong>' + escapeHtml(file.name) + '</strong> <span class="tiny">' + formatDate(file.date) + '</span></p>'
    + '<div class="row wrap">'
    + '<a class="btn btn-secondary" href="' + file.data + '" target="_blank" rel="noopener">Open</a>'
    + '<a class="btn" href="' + file.data + '" download="' + escapeHtml(file.name) + '">Download</a>'
    + '</div></li>'
  ).join("");
}

async function renderTopAchievements() {
  const list = document.getElementById("topAchievements");
  if (!list) return;
  const activeId = getActiveInternshipId();
  if (!activeId) { list.innerHTML = '<li class="empty">Select an internship first.</li>'; return; }
  const allLogs = await db.getLogs(activeId);
  const top = allLogs.filter((log) => isDateWithinLastDays(log.date, 7)).sort((a, b) => scoreImpact(b) - scoreImpact(a)).slice(0, 3);
  if (!top.length) { list.innerHTML = '<li class="empty">Add logs to surface top achievements.</li>'; return; }
  list.innerHTML = top.map((log) => '<li class="list-item"><p><strong>' + escapeHtml(log.task) + '</strong></p><p>' + escapeHtml(log.impact) + '</p></li>').join("");
}

async function renderWeeklyConnections(listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const contacts = await db.getContacts();
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
  const allContacts = await db.getContacts();
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
  let contacts = await db.getContacts();
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
  // Group into alphabetical buckets by first letter
  const buckets = new Map();
  contacts.forEach((c) => {
    const letter = (c.name[0] || '#').toUpperCase();
    if (!buckets.has(letter)) buckets.set(letter, []);
    buckets.get(letter).push(c);
  });
  let html = '';
  buckets.forEach((group, letter) => {
    html += '<li class="contact-alpha-header">' + letter + '</li>';
    group.forEach((contact) => {
      const status = getReminderStatus(contact);
      const freqLabel = FREQUENCY_LABELS[contact.followUpFrequency] || 'No reminders';
      html += '<li class="contact-card ' + (status === 'due' ? 'due-item' : status === 'soon' ? 'soon-item' : '') + '" data-open-contact="' + contact.id + '" role="button" tabindex="0">'
        + '<div class="contact-header">'
        + '<div class="contact-summary">'
        + '<p class="contact-name"><strong>' + escapeHtml(contact.name) + '</strong></p>'
        + '<p class="tiny">' + escapeHtml(contact.role || 'Role not set') + (contact.company ? ' @ <strong>' + escapeHtml(contact.company) + '</strong>' : '') + '</p>'
        + '</div>'
        + '<div class="badge-col">' + reminderBadge(contact) + '</div>'
        + '</div>'
        + '<div class="contact-meta">'
        + '<span class="tiny">Last met: ' + formatDate(contact.lastContacted) + '</span>'
        + (contact.nextReminder ? '<span class="tiny">Next reminder: ' + formatDate(contact.nextReminder.split('T')[0]) + '</span>' : '')
        + '<span class="tiny">' + escapeHtml(freqLabel) + '</span>'
        + '</div>'
        + '</li>';
    });
  });
  list.innerHTML = html;
  list.querySelectorAll('[data-open-contact]').forEach((card) => {
    const open = () => { window.location.href = 'contact.html?id=' + encodeURIComponent(card.dataset.openContact); };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(); });
  });
}

// ── Weekly Focus ──────────────────────────────────────────────────────────────

/** In-memory list of manually added focus items for the current session. */
let manualFocusItems = [];

async function renderWeeklyFocus() {
  const container = document.getElementById("weeklyFocusContainer");
  const countEl   = document.getElementById("focusCount");
  if (!container) return;

  const activeId = getActiveInternshipId();
  if (!activeId) {
    container.innerHTML = '<p class="empty">Select an internship to see this week\'s logs.</p>';
    if (countEl) countEl.textContent = "";
    return;
  }

  const allLogs  = await db.getLogs(activeId);
  const weekLogs = allLogs
    .filter((l) => isDateWithinLastDays(l.date, 7))
    .sort((a, b) => scoreImpact(b) - scoreImpact(a));

  const preselectedIds = new Set(weekLogs.slice(0, 5).map((l) => l.id));

  let html = "";
  if (!weekLogs.length && !manualFocusItems.length) {
    html = '<p class="empty focus-empty">No logs this week yet — add some using the Daily Log above.</p>';
  } else {
    weekLogs.forEach((log) => {
      const checked = preselectedIds.has(log.id) ? "checked" : "";
      html += '<label class="focus-item">'
        + '<input type="checkbox" class="focus-checkbox" data-log-id="' + escapeHtml(log.id) + '" ' + checked + ' />'
        + '<span class="focus-item-body">'
        + '<span class="focus-text">' + escapeHtml(log.task) + '</span>'
        + (log.impact ? '<span class="focus-impact">→ ' + escapeHtml(log.impact) + '</span>' : '')
        + '</span>'
        + '<span class="focus-date">' + formatDate(log.date) + '</span>'
        + '</label>';
    });
    manualFocusItems.forEach((item, idx) => {
      html += '<label class="focus-item focus-item-manual">'
        + '<input type="checkbox" class="focus-checkbox" data-manual-idx="' + idx + '" checked />'
        + '<span class="focus-item-body">'
        + '<span class="focus-text">' + escapeHtml(item) + '</span>'
        + '<span class="focus-manual-tag">manual</span>'
        + '</span>'
        + '<button class="focus-remove" type="button" data-manual-idx="' + idx + '" title="Remove">×</button>'
        + '</label>';
    });
  }

  container.innerHTML = html;

  container.querySelectorAll(".focus-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      manualFocusItems.splice(parseInt(btn.dataset.manualIdx), 1);
      renderWeeklyFocus();
    });
  });

  function updateCount() {
    if (countEl) {
      const n = container.querySelectorAll(".focus-checkbox:checked").length;
      countEl.textContent = n + " item" + (n !== 1 ? "s" : "") + " selected";
    }
  }
  container.querySelectorAll(".focus-checkbox").forEach((cb) => {
    cb.addEventListener("change", updateCount);
  });
  updateCount();
}

function initWeeklyFocus() {
  const addBtn = document.getElementById("addManualFocusBtn");
  const input  = document.getElementById("manualFocusInput");
  if (!addBtn || !input) return;
  const add = () => {
    const text = input.value.trim();
    if (!text) return;
    manualFocusItems.push(text);
    input.value = "";
    renderWeeklyFocus();
  };
  addBtn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
}

// -- Workspace timeline -------------------------------------------------------

async function renderWorkspaceTimeline() {
  const container = document.getElementById("timelineContainer");
  if (!container) return;
  const activeId = getActiveInternshipId();
  if (!activeId) {
    container.innerHTML = '<p class="timeline-empty">Select or add an internship to start logging.</p>';
    return;
  }
  const allLogs = await db.getLogs(activeId);
  if (!allLogs.length) {
    container.innerHTML = '<p class="timeline-empty">No logs yet. Use the form above to record your first entry. 🎉</p>';
    return;
  }

  function getWeekMonday(dateStr) {
    const d = parseDateOnly(dateStr);
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
    const weekLabel = "Week of " + formatDate(weekMon) + " \u2013 " + formatDate(friDate.toISOString().split("T")[0]);

    const sortedLogs = [...logs].sort((a, b) => b.date.localeCompare(a.date));
    const rows = sortedLogs.map((log) => {
      const blockerHtml = log.blockers
        ? '<span class="log-blocker-badge">\u26a0 ' + escapeHtml(log.blockers) + "</span>"
        : "";
      return '<div class="log-row">'
        + '<span class="log-row-date">' + formatDate(log.date) + "</span>"
        + '<div class="log-row-body">'
        + '<p class="log-task">' + escapeHtml(log.task) + "</p>"
        + (log.impact ? '<p class="log-impact"><span class="entry-arrow">\u2192</span> ' + escapeHtml(log.impact) + "</p>" : "")
        + blockerHtml
        + "</div>"
        + "</div>";
    }).join("");

    html += '<div class="week-section">'
      + '<p class="week-label">' + weekLabel + "</p>"
      + '<div class="week-entries">' + rows + "</div>"
      + "</div>";
  });

  container.innerHTML = html;
}

// ── Internship panel ──────────────────────────────────────────────────────────

async function renderInternshipPanel() {
  const list = document.getElementById("internshipList");
  if (!list) return;
  const internships = await db.getInternships();
  const activeId = getActiveInternshipId();
  if (!internships.length) {
    list.innerHTML = '<li class="empty" style="font-size:0.78rem;padding:0.4rem 0.5rem">No internships yet.</li>';
    return;
  }
  list.innerHTML = internships.map((internship) => {
    const isActive = internship.id === activeId;
    return '<li class="intern-item' + (isActive ? ' intern-item-active' : '') + '">'
      + '<button class="intern-name-btn" type="button" data-internship-action="switch" data-internship-id="' + internship.id + '">'
      + '<span class="intern-name">' + escapeHtml(internship.name) + '</span>'
      + (internship.company ? '<span class="intern-co">' + escapeHtml(internship.company) + '</span>' : '')
      + '</button>'
      + '<div class="intern-item-actions">'
      + '<button class="intern-action-btn" type="button" data-internship-action="edit" data-internship-id="' + internship.id + '">Edit</button>'
      + '<button class="intern-action-btn" type="button" data-internship-action="delete" data-internship-id="' + internship.id + '">Delete</button>'
      + '</div></li>';
  }).join("");
}

let refreshActivePageData = async () => {};

async function initInternshipPanel() {
  const list = document.getElementById("internshipList");
  const addBtn = document.getElementById("addInternshipBtn");
  if (!list || !addBtn) return;

  const form       = document.getElementById("internshipForm");
  const editIdEl   = document.getElementById("internshipEditId");
  const nameEl     = document.getElementById("internshipName");
  const companyEl  = document.getElementById("internshipCompany");
  const startEl    = document.getElementById("internshipStart");
  const endEl      = document.getElementById("internshipEnd");
  const cancelBtn  = document.getElementById("internshipCancelBtn");
  const error      = document.getElementById("internshipError");

  function openForm(seed) {
    seed = seed || {};
    editIdEl.value   = seed.id || "";
    nameEl.value     = seed.name || "";
    companyEl.value  = seed.company || "";
    startEl.value    = seed.startDate || "";
    endEl.value      = seed.endDate || "";
    if (error) error.textContent = "";
    form.classList.remove("hidden");
    addBtn.classList.add("hidden");
    nameEl.focus();
  }

  function closeForm() {
    form.classList.add("hidden");
    addBtn.classList.remove("hidden");
    form.reset();
  }

  addBtn.addEventListener("click", () => openForm());
  cancelBtn.addEventListener("click", closeForm);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (error) error.textContent = "";
    const name = nameEl.value.trim();
    if (!name) { if (error) error.textContent = "Name is required."; return; }
    const payload = { name, company: companyEl.value.trim(), startDate: startEl.value, endDate: endEl.value };
    const existingId = editIdEl.value;
    if (existingId) {
      const internships = await db.getInternships();
      const target = internships.find((i) => i.id === existingId);
      if (target) await db.saveInternship({ ...target, ...payload });
    } else {
      const next = { id: makeId(), ...payload, createdAt: new Date().toISOString() };
      await db.saveInternship(next);
      setActiveInternshipId(next.id);
    }
    closeForm();
    await renderInternshipPanel();
    await refreshActivePageData();
  });

  list.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-internship-action]");
    if (!button) return;
    const internshipId = button.dataset.internshipId;
    const action = button.dataset.internshipAction;
    const internships = await db.getInternships();
    const target = internships.find((i) => i.id === internshipId);
    if (!target) return;
    if (action === "switch") {
      setActiveInternshipId(internshipId);
      await renderInternshipPanel();
      await refreshActivePageData();
    } else if (action === "edit") {
      openForm(target);
    } else if (action === "delete") {
      const confirmed = window.confirm('Delete "' + target.name + '" and all its logs? This cannot be undone.');
      if (!confirmed) return;
      await db.deleteInternship(internshipId);
      if (getActiveInternshipId() === internshipId) {
        const remaining = await db.getInternships();
        setActiveInternshipId(remaining.length ? remaining[0].id : "");
      }
      await renderInternshipPanel();
      await refreshActivePageData();
    }
  });

  const internships = await db.getInternships();
  const activeId = getActiveInternshipId();
  if (internships.length && !internships.some((i) => i.id === activeId)) {
    setActiveInternshipId(internships[0].id);
  }
  await renderInternshipPanel();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function initDashboard() {
  const logForm = document.getElementById("logForm");
  if (!logForm) return;
  const logDate = document.getElementById("logDate");
  const logTask = document.getElementById("logTask");
  const logImpact = document.getElementById("logImpact");
  const logBlockers = document.getElementById("logBlockers");
  const logError = document.getElementById("logError");

  if (logDate) logDate.value = todayDateString();

  logForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (logError) logError.textContent = "";
    if (!requireActiveInternship(logError)) return;
    const entry = normalizeLog({
      date: logDate ? logDate.value : todayDateString(),
      task: logTask ? logTask.value : "",
      impact: logImpact ? logImpact.value : "",
      blockers: logBlockers ? logBlockers.value : ""
    });
    if (!entry.date || !entry.task) { if (logError) logError.textContent = "What did you work on? Task is required."; return; }
    await db.saveLog(entry, getActiveInternshipId());
    if (logTask) logTask.value = "";
    if (logImpact) logImpact.value = "";
    if (logBlockers) logBlockers.value = "";
    await renderWorkspaceTimeline();
    await renderWeeklyFocus();
    await renderInternshipPanel();
  });
}

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
    await db.saveContact(contact);
    form.reset();
    if (dateMetEl) dateMetEl.value = todayDateString();
    if (filterEl) filterEl.value = "";
    await renderContacts();
    await renderWeeklyConnections("weeklyConnections");
    await renderFollowUpAlerts("networkFollowUps");
  });

  refreshActivePageData = async () => {
    await renderContacts(filterEl ? filterEl.value : "");
    await renderWeeklyConnections("weeklyConnections");
    await renderFollowUpAlerts("networkFollowUps");
  };

  await refreshActivePageData();
}

// ── Summary page ──────────────────────────────────────────────────────────────

async function renderWeeklyLogs() {
  const weeklyLogsList = document.getElementById("weeklyLogs");
  if (!weeklyLogsList) return [];
  const activeId = getActiveInternshipId();
  if (!activeId) { weeklyLogsList.innerHTML = '<li class="empty">Select an internship to view logs.</li>'; return []; }
  const allLogs = await db.getLogs(activeId);
  const logs = allLogs.filter((l) => isDateWithinLastDays(l.date, 7)).sort((a, b) => a.date.localeCompare(b.date));
  if (!logs.length) { weeklyLogsList.innerHTML = '<li class="empty">No impact logs from the last 7 days.</li>'; return []; }
  weeklyLogsList.innerHTML = logs.map((log) =>
    '<li class="list-item">'
    + '<p><strong>' + formatDate(log.date) + '</strong></p>'
    + '<p><span class="label">Completed:</span> ' + escapeHtml(log.task) + '</p>'
    + '<p><span class="label">Achieved:</span> ' + escapeHtml(log.impact) + '</p>'
    + '<p><span class="label">Learned:</span> ' + escapeHtml(log.skills) + '</p>'
    + '</li>'
  ).join("");
  return logs;
}

async function initSummary() {
  const generateBtn = document.getElementById("generateSummaryBtn");
  if (!generateBtn) return;
  const copyBtn = document.getElementById("copySummaryBtn");
  const summaryArea = document.getElementById("generatedSummary");
  const message = document.getElementById("summaryMessage");
  const managerNameInput = document.getElementById("managerName");
  const yourNameInput = document.getElementById("yourName");
  const nextStepsInput = document.getElementById("nextSteps");

  const prefs = await db.getPreferences();
  if (managerNameInput) managerNameInput.value = prefs.manager_name || "";
  if (yourNameInput) yourNameInput.value = prefs.your_name || "";
  if (nextStepsInput) nextStepsInput.value = prefs.next_steps || "";

  if (managerNameInput) managerNameInput.addEventListener("input", () => { db.savePreferences({ manager_name: managerNameInput.value }); });
  if (yourNameInput) yourNameInput.addEventListener("input", () => { db.savePreferences({ your_name: yourNameInput.value }); });
  if (nextStepsInput) nextStepsInput.addEventListener("input", () => { db.savePreferences({ next_steps: nextStepsInput.value }); });

  generateBtn.addEventListener("click", async () => {
    if (message) message.textContent = "";
    if (!requireActiveInternship(message, "Add or select an internship first.")) return;
    const activeId  = getActiveInternshipId();
    const allLogs   = activeId ? await db.getLogs(activeId) : [];
    const weekLogs  = allLogs.filter((l) => isDateWithinLastDays(l.date, 7));

    // Collect selections from the Weekly Focus section
    const focusContainer = document.getElementById("weeklyFocusContainer");
    const selectedLogIds  = new Set();
    const selectedManuals = [];
    if (focusContainer) {
      focusContainer.querySelectorAll(".focus-checkbox:checked").forEach((cb) => {
        if (cb.dataset.logId) selectedLogIds.add(cb.dataset.logId);
        if (cb.dataset.manualIdx !== undefined) {
          const item = manualFocusItems[parseInt(cb.dataset.manualIdx)];
          if (item) selectedManuals.push(item);
        }
      });
    }

    const topLogs       = weekLogs.filter((l) => selectedLogIds.has(l.id));
    const remainingLogs = weekLogs.filter((l) => !selectedLogIds.has(l.id));
    const blockers      = weekLogs.map((l) => l.blockers).filter(Boolean);

    const safeManager = ((managerNameInput ? managerNameInput.value : "") || "").trim() || "Manager";
    const safeName    = ((yourNameInput    ? yourNameInput.value    : "") || "").trim() || "Your Name";

    const today = new Date();
    const dow   = today.getDay();
    const mon   = new Date(today);
    mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
    const fri   = new Date(mon);
    fri.setDate(mon.getDate() + 4);
    const weekRange = formatDate(mon.toISOString().split("T")[0]) + " \u2013 " + formatDate(fri.toISOString().split("T")[0]);

    const allSelected = [
      ...topLogs.map((l) => l.task + (l.impact ? " \u2014 " + l.impact : "")),
      ...selectedManuals
    ];

    let text = "Hi " + safeManager + ",\n\nHere\u2019s my update for the week of " + weekRange + ":\n\n";

    if (allSelected.length) {
      text += "Top " + allSelected.length + " thing" + (allSelected.length !== 1 ? "s" : "") + " I accomplished:\n";
      allSelected.forEach((item, i) => { text += (i + 1) + ". " + item + "\n"; });
    } else {
      text += "Top accomplishments:\n(Select items from the Weekly Focus section above.)\n";
    }

    if (remainingLogs.length) {
      text += "\nOther work this week:\n";
      remainingLogs.forEach((l) => { text += "\u2022 " + l.task + "\n"; });
    }

    if (blockers.length) {
      text += "\nQuestions / Blockers:\n";
      blockers.forEach((b) => { text += "\u2022 " + b + "\n"; });
    }

    text += "\nBest,\n" + safeName;
    if (summaryArea) summaryArea.value = text;
  });

  if (copyBtn) copyBtn.addEventListener("click", async () => {
    if (message) message.textContent = "";
    if (!summaryArea || !summaryArea.value.trim()) { if (message) message.textContent = "Generate a summary first."; return; }
    try { await navigator.clipboard.writeText(summaryArea.value); if (message) message.textContent = "Copied to clipboard."; }
    catch { if (message) message.textContent = "Copy failed. Please select and copy manually."; }
  });

  refreshActivePageData = async () => {
    const p = await db.getPreferences();
    if (managerNameInput) managerNameInput.value = p.manager_name || "";
    if (yourNameInput) yourNameInput.value = p.your_name || "";
    if (summaryArea) summaryArea.value = "";
    if (message) message.textContent = "";
    await renderWorkspaceTimeline();
    await renderWeeklyFocus();
  };

  await refreshActivePageData();
}

// ── Contact page ──────────────────────────────────────────────────────────────

async function initContactPage() {
  const root = document.getElementById("contactPageContent");
  if (!root) return;
  const params = new URLSearchParams(window.location.search);
  const contactId = params.get("id");
  refreshActivePageData = renderPage;

  async function freshContact() {
    const contacts = await db.getContacts();
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
    const freqLabel = FREQUENCY_LABELS[c.followUpFrequency] || "No reminders";
    const interactionTypeOptions = INTERACTION_TYPES.map((t) => '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>').join("");
    const freqOptions = Object.entries(FREQUENCY_LABELS).map(([v, l]) => '<option value="' + v + '"' + (c.followUpFrequency === v ? ' selected' : '') + '>' + l + '</option>').join("");

    root.innerHTML = '<div class="card contact-page-header">'
      + '<a href="network.html" class="btn btn-secondary back-btn">Back to Networking</a>'
      + '<div class="contact-page-hero">'
      + '<div class="contact-page-identity">'
      + '<h2>' + escapeHtml(c.name) + '</h2>'
      + '<p class="muted">' + escapeHtml(c.role || "Role not set") + (c.company ? ' @ ' + escapeHtml(c.company) : '') + ' &middot; <a href="mailto:' + escapeHtml(c.email) + '">' + escapeHtml(c.email) + '</a></p>'
      + '<p class="tiny">Met: ' + formatDate(c.dateMet) + ' &middot; Last contacted: ' + formatDate(c.lastContacted) + '</p>'
      + '</div>'
      + '<div class="contact-page-badges">'
      + reminderBadge(c)
      + '<button class="btn btn-secondary" id="cpOpenReminderBtn" type="button">' + (status !== "none" ? "Manage Reminder" : "Send Email") + '</button>'
      + '<button class="btn btn-secondary danger-btn" id="cpDeleteBtn" type="button">Delete Contact</button>'
      + '</div></div></div>'
      + '<div class="contact-page-body">'
      + '<div class="contact-page-left">'
      + '<section class="card"><h3 class="section-title">Interaction Timeline</h3><div class="timeline" id="cpTimeline">' + renderInteractionTimeline(c.interactions) + '</div></section>'
      + '<section class="card"><h3 class="section-title">Add Interaction</h3>'
      + '<div class="two-col"><div class="field-group"><label>Date</label><input type="date" id="cpIntDate" value="' + todayDateString() + '" /></div>'
      + '<div class="field-group"><label>Type</label><select id="cpIntType">' + interactionTypeOptions + '</select></div></div>'
      + '<div class="field-group"><label>Notes</label><textarea id="cpIntNotes" rows="3"></textarea></div>'
      + '<div class="field-group"><label>Outcome</label><textarea id="cpIntOutcome" rows="2"></textarea></div>'
      + '<p id="cpIntError" class="error" aria-live="polite"></p>'
      + '<button class="btn" id="cpAddIntBtn" type="button">Add Interaction</button></section>'
      + '<section class="card"><div class="followup-section-header"><h3 class="section-title">Next Steps</h3><button class="btn btn-secondary" id="cpSuggestBtn" type="button">Suggest Follow-Ups</button></div>'
      + '<div id="cpFollowUpList">' + renderFollowUpItems(c.followUps) + '</div>'
      + '<div class="followup-add-row"><input type="text" id="cpNewFollowUp" placeholder="Add a follow-up task" /><button class="btn" id="cpAddFollowUpBtn" type="button">Add</button></div>'
      + '<p id="cpFollowUpMsg" class="success" aria-live="polite"></p></section>'
      + '</div>'
      + '<div class="contact-page-right">'
      + '<section class="card"><h3 class="section-title">Notes and Details</h3>'
      + '<div class="two-col"><div class="field-group"><label>Company</label><input type="text" id="cpCompany" value="' + escapeHtml(c.company) + '" placeholder="e.g. Google" /></div>'
      + '<div class="field-group"><label>Role</label><input type="text" id="cpRole" value="' + escapeHtml(c.role) + '" placeholder="e.g. Software Engineer" /></div></div>'
      + '<div class="field-group"><label>Interests</label><input type="text" id="cpInterests" value="' + escapeHtml(c.interests) + '" /></div>'
      + '<div class="field-group"><label>Advice Given</label><textarea id="cpAdvice" rows="3">' + escapeHtml(c.adviceGiven) + '</textarea></div>'
      + '<div class="field-group"><label>Notes</label><textarea id="cpNotes" rows="4">' + escapeHtml(c.notes) + '</textarea></div>'
      + '<button class="btn" id="cpSaveNotesBtn" type="button">Save Notes</button>'
      + '<p id="cpSaveNotesMsg" class="success" aria-live="polite"></p></section>'
      + '<section class="card"><h3 class="section-title">Documents</h3>'
      + '<div id="cpDocList">' + renderContactDocuments(c.documents) + '</div>'
      + '<div class="followup-add-row" style="margin-top:0.75rem"><input type="file" id="cpDocInput" accept=".pdf,application/pdf" multiple /><button class="btn btn-secondary" id="cpDocUploadBtn" type="button">Upload PDF</button></div>'
      + '<p id="cpDocError" class="error" aria-live="polite"></p></section>'
      + '<section class="card"><h3 class="section-title">Reminder Settings</h3>'
      + '<p class="tiny">Frequency: <strong>' + escapeHtml(freqLabel) + '</strong></p>'
      + '<p class="tiny">Next reminder: ' + (c.nextReminder ? formatDate(c.nextReminder.split("T")[0]) : "Not set") + '</p>'
      + '<div class="field-group" style="margin-top:0.75rem"><label>Stay-in-touch frequency</label><select id="cpFrequency">' + freqOptions + '</select></div>'
      + '<label class="row" style="margin-top:0.4rem;gap:0.5rem;cursor:pointer"><input type="checkbox" id="cpReminderEnabled"' + (c.reminderEnabled ? ' checked' : '') + ' /> Reminders enabled</label>'
      + '<button class="btn" id="cpSaveReminderBtn" type="button" style="margin-top:0.75rem">Save Reminder Settings</button>'
      + '<p id="cpSaveReminderMsg" class="success" aria-live="polite"></p></section>'
      + '</div></div>';

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
      const interaction = normalizeInteraction({ date, type, notes, outcome });
      await save((c) => {
        const newInteractions = [interaction, ...c.interactions].sort((a, b) => b.date.localeCompare(a.date));
        return { ...c, interactions: newInteractions, lastContacted: newInteractions[0].date, nextReminder: calculateNextReminder(newInteractions[0].date, c.followUpFrequency) };
      });
      const fresh = await freshContact();
      const hasOpen = (fresh ? fresh.followUps || [] : []).some((f) => !f.completed);
      await renderPage();
      if (!hasOpen) {
        const msg = root.querySelector("#cpFollowUpMsg");
        if (msg) { msg.textContent = "Interaction saved! Use Suggest Follow-Ups to generate next steps."; setTimeout(() => { if (msg) msg.textContent = ""; }, 4000); }
      }
    });
    root.querySelector("#cpSaveNotesBtn").addEventListener("click", async () => {
      await save((c) => ({ ...c, company: root.querySelector("#cpCompany").value.trim(), role: root.querySelector("#cpRole").value.trim(), interests: root.querySelector("#cpInterests").value.trim(), adviceGiven: root.querySelector("#cpAdvice").value.trim(), notes: root.querySelector("#cpNotes").value.trim() }));
      const msg = root.querySelector("#cpSaveNotesMsg");
      msg.textContent = "Saved!";
      setTimeout(() => { if (msg) msg.textContent = ""; }, 2000);
      await renderPage();
    });
    root.querySelector("#cpSaveReminderBtn").addEventListener("click", async () => {
      const newFreq = root.querySelector("#cpFrequency").value;
      const enabled = root.querySelector("#cpReminderEnabled").checked;
      await save((c) => ({ ...c, followUpFrequency: newFreq, reminderEnabled: enabled && newFreq !== "none", nextReminder: calculateNextReminder(c.lastContacted || c.dateMet, newFreq) }));
      const msg = root.querySelector("#cpSaveReminderMsg");
      msg.textContent = "Reminder settings saved!";
      setTimeout(() => { if (msg) msg.textContent = ""; }, 2000);
      await renderPage();
    });
    root.querySelector("#cpDocUploadBtn").addEventListener("click", async () => {
      const errEl = root.querySelector("#cpDocError");
      errEl.textContent = "";
      const files = Array.from(root.querySelector("#cpDocInput").files || []);
      if (!files.length) { errEl.textContent = "Select at least one PDF."; return; }
      if (files.some((f) => !f.name.toLowerCase().endsWith(".pdf"))) { errEl.textContent = "Only PDF files supported."; return; }
      try {
        const encoded = await Promise.all(files.map(async (f) => normalizeContactDocument({ name: f.name, data: await readPdfFile(f) })));
        await save((c) => ({ ...c, documents: [...(c.documents || []), ...encoded] }));
        await renderPage();
      } catch { errEl.textContent = "Upload failed. Try a smaller file."; }
    });
    root.querySelectorAll("[data-remove-doc]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await save((c) => ({ ...c, documents: c.documents.filter((d) => d.id !== btn.dataset.removeDoc) }));
        await renderPage();
      });
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
    const contacts = await db.getContacts();
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const due = contacts.filter((c) => c.reminderEnabled && c.nextReminder && new Date(c.nextReminder) <= now);
    if (due.length > 0) showReminderModal(due[0]);
  }, 800);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// requireAuth() redirects to auth.html if the user is not signed in.
// All init functions are no-ops on pages where their root element is absent,
// so this single boot sequence works across all four app pages.

(async () => {
  const user = await requireAuth();
  if (!user) return;
  initThemeToggle();
  initSignOut();
  await initDashboard();
  initWeeklyFocus();
  await initNetworking();
  await initSummary();
  await initContactPage();
  await initInternshipPanel();
  await checkRemindersOnLoad();
})();
