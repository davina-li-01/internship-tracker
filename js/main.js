/**
 * main.js — Orbit: a networking tracker
 *
 * ES module. All data access goes through db.js (Supabase).
 * UI state (theme, sidebar) is kept in localStorage only.
 *
 * Pages:
 *   index.html    — Dashboard: KPI row, health rings, who to reach out to
 *   contacts.html — My Network: everyone, searchable and filterable
 *   network.html  — Networking Log: capture widget + chronological log
 *   files.html    — Files (nested under Networking Log)
 *   contact.html  — One connection's profile
 *
 * Every init function returns early when its root element is absent, so the
 * single boot sequence at the bottom works unchanged across all pages.
 */
import { requireAuth, supabase } from "./supabase.js";
import * as db from "./db.js";

// ── Utilities ─────────────────────────────────────────────────────────────────

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(value) {
  if (!value) return "No date";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function parseDateOnly(value) {
  if (!value) return null;
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function todayDateString() {
  return new Date().toISOString().split("T")[0];
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Whole days between a date-only string and today. Negative means future. */
function daysSince(value) {
  const date = parseDateOnly(value);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today - date) / 86400000);
}

function isDateWithinLastDays(value, days = 7) {
  const elapsed = daysSince(value);
  return elapsed !== null && elapsed >= 0 && elapsed < days;
}

function relativeDayLabel(value) {
  const elapsed = daysSince(value);
  if (elapsed === null) return "no date";
  if (elapsed === 0) return "today";
  if (elapsed === 1) return "yesterday";
  if (elapsed < 0) return `in ${Math.abs(elapsed)} days`;
  if (elapsed < 30) return `${elapsed} days ago`;
  const months = Math.round(elapsed / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(elapsed / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function initialsFor(name) {
  const parts = (name || "?").trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (parts[0][0] || "?").toUpperCase();
}

// ── Reach-out cadence ─────────────────────────────────────────────────────────
// Deliberately avoids the word "tracking" everywhere it faces the user.

const FREQUENCY_LABELS = {
  weekly: "Every week",
  biweekly: "Every 2 weeks",
  monthly: "Every month",
  bimonthly: "Every 2 months",
  quarterly: "Every 3 months",
  none: "No schedule"
};

const FREQUENCY_DAYS = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  bimonthly: 60,
  quarterly: 90
};

function getFreqLabel(freq) {
  if (freq && freq.startsWith("custom:")) {
    const days = parseInt(freq.slice(7), 10);
    return "Every " + days + " day" + (days !== 1 ? "s" : "");
  }
  return FREQUENCY_LABELS[freq] || "No schedule";
}

function getIntervalDays(freq) {
  if (freq && freq.startsWith("custom:")) {
    const days = parseInt(freq.slice(7), 10);
    return Number.isNaN(days) || days <= 0 ? 0 : days;
  }
  return FREQUENCY_DAYS[freq] || 0;
}

function calculateNextReminder(lastContacted, frequency) {
  const interval = getIntervalDays(frequency);
  if (!lastContacted || !interval) return "";
  const date = parseDateOnly(lastContacted) || new Date(lastContacted);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + interval);
  return date.toISOString();
}

// ── Relationship health ───────────────────────────────────────────────────────
// A connection is "scheduled" when it has a cadence and reminders are on.
// Health decays linearly from 100% right after a touchpoint to 0% once the
// whole interval has elapsed.

function getHealth(contact) {
  const interval = getIntervalDays(contact.followUpFrequency);
  const last = contact.lastContacted || contact.dateMet;
  const elapsed = daysSince(last);

  if (!interval || !contact.reminderEnabled || elapsed === null) {
    return { scheduled: false, pct: 0, band: "none", elapsed, interval: 0, daysLeft: null };
  }

  const pct = Math.max(0, Math.min(100, Math.round((1 - elapsed / interval) * 100)));
  // "Overdue" must mean the deadline actually passed, not merely that the
  // remaining percentage is small. A 90-day cadence at day 80 is down to 11%
  // but still has 10 days left — calling that overdue contradicts the detail.
  const band = elapsed > interval ? "critical" : pct >= 60 ? "good" : "warning";
  return { scheduled: true, pct, band, elapsed, interval, daysLeft: interval - elapsed };
}

/**
 * Status vocabulary. Every status is shown as icon + label + number so meaning
 * never rides on color alone — required because the amber sits below 3:1 on
 * this app's light surface.
 */
const BAND_META = {
  good:     { label: "In touch",       icon: "●", short: "In touch" },
  warning:  { label: "Reach out soon", icon: "◐", short: "Soon" },
  critical: { label: "Overdue",        icon: "▲", short: "Overdue" },
  none:     { label: "No schedule",    icon: "○", short: "No schedule" }
};

function healthBarHtml(health) {
  const meta = BAND_META[health.band];
  if (!health.scheduled) {
    return '<div class="health health-none">'
      + '<span class="health-label muted"><span class="health-icon" aria-hidden="true">'
      + meta.icon + '</span> ' + meta.label + '</span>'
      + '</div>';
  }
  const detail = health.daysLeft >= 0
    ? `${health.daysLeft} day${health.daysLeft === 1 ? "" : "s"} left`
    : `${Math.abs(health.daysLeft)} day${Math.abs(health.daysLeft) === 1 ? "" : "s"} over`;
  return '<div class="health">'
    + '<div class="health-track">'
    + '<div class="health-fill fill-' + health.band + '" style="width:' + health.pct + '%"></div>'
    + '</div>'
    + '<span class="health-label text-' + health.band + '">'
    + '<span class="health-icon" aria-hidden="true">' + meta.icon + '</span> ' + meta.label + '</span>'
    + '<span class="health-detail">' + detail + '</span>'
    + '</div>';
}

function statusChip(health) {
  const meta = BAND_META[health.band];
  return '<span class="status-chip chip-' + health.band + '">'
    + '<span aria-hidden="true">' + meta.icon + '</span> ' + escapeHtml(meta.short) + '</span>';
}

// ── Charts ────────────────────────────────────────────────────────────────────
// A ring is a meter: one ratio against a limit. Rounded data-ends, a recessive
// track, and the value printed in the middle so the arc is never the only cue.

function ringHtml({ pct, band, caption, sub }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const safePct = Math.max(0, Math.min(100, pct));
  const filled = (safePct / 100) * circumference;
  // At 0% the round line-cap would still paint a stray dot at 12 o'clock, so
  // the arc is omitted entirely rather than drawn with a zero-length dash.
  const arc = safePct > 0
    ? '<circle class="ring-fill ring-' + band + '" cx="50" cy="50" r="' + radius + '"'
      + ' stroke-dasharray="' + filled.toFixed(2) + ' ' + (circumference - filled).toFixed(2) + '"'
      + ' transform="rotate(-90 50 50)" />'
    : "";
  return '<figure class="ring-fig">'
    + '<svg class="ring" viewBox="0 0 100 100" role="img"'
    + ' aria-label="' + escapeHtml(caption) + ': ' + safePct + ' percent">'
    + '<circle class="ring-track" cx="50" cy="50" r="' + radius + '" />'
    + arc
    + '<text class="ring-value" x="50" y="50">' + safePct + '%</text>'
    + '</svg>'
    + '<figcaption><span class="ring-caption">' + escapeHtml(caption) + '</span>'
    + (sub ? '<span class="ring-sub">' + escapeHtml(sub) + '</span>' : '')
    + '</figcaption>'
    + '</figure>';
}

/** Part-to-whole across the three statuses — a stacked bar, not a pie. */
function splitBarHtml(counts) {
  const total = counts.good + counts.warning + counts.critical;
  if (!total) return "";
  const seg = (band) => counts[band]
    ? '<div class="split-seg fill-' + band + '" style="flex:' + counts[band] + '"'
      + ' title="' + BAND_META[band].label + ': ' + counts[band] + '"></div>'
    : "";
  return '<div class="split-wrap">'
    + '<div class="split-bar">' + seg("good") + seg("warning") + seg("critical") + '</div>'
    + '<ul class="split-legend">'
    + ["good", "warning", "critical"].map((band) =>
        '<li class="split-legend-item">'
        + '<span class="legend-dot dot-' + band + '" aria-hidden="true"></span>'
        + '<span class="legend-label">' + BAND_META[band].label + '</span>'
        + '<span class="legend-count">' + counts[band] + '</span>'
        + '</li>').join("")
    + '</ul>'
    + '</div>';
}

// ── Normalizers ───────────────────────────────────────────────────────────────

function normalizeInteraction(item = {}) {
  return {
    id: item.id || makeId(),
    date: item.date || todayDateString(),
    type: item.type || "check-in",
    notes: (item.notes || "").trim(),
    outcome: (item.outcome || "").trim()
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
    industry: (contact.industry || "").trim(),
    dateMet: contact.dateMet || "",
    lastContacted,
    followUpFrequency: frequency,
    nextReminder,
    reminderEnabled: frequency !== "none" ? (contact.reminderEnabled !== false) : false,
    notes: (contact.notes || "").trim(),
    interests: (contact.interests || "").trim(),
    adviceGiven: (contact.adviceGiven || "").trim(),
    interactions: sortedInteractions,
    followUps: Array.isArray(contact.followUps)
      ? contact.followUps.map(normalizeFollowUpItem)
      : [],
    companyHistory: Array.isArray(contact.companyHistory)
      ? contact.companyHistory.map((c) => String(c).trim()).filter(Boolean)
      : []
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

/** Scheduled connections that have slipped, most overdue first. */
function needsAttention(contacts) {
  return contacts
    .map((c) => ({ contact: c, health: getHealth(c) }))
    .filter((x) => x.health.scheduled && x.health.band !== "good")
    .sort((a, b) => a.health.pct - b.health.pct);
}

function countByBand(contacts) {
  const counts = { good: 0, warning: 0, critical: 0, none: 0 };
  contacts.forEach((c) => { counts[getHealth(c).band]++; });
  return counts;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function initSidebarToggle() {
  const btn = document.getElementById("sidebarToggleBtn");
  const brand = document.getElementById("sidebarBrand");
  const sidebar = document.querySelector(".sidebar");
  if (!btn || !sidebar) return;

  const mobileQuery = window.matchMedia("(max-width: 992px)");
  let overlay = document.querySelector(".mobile-nav-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "mobile-nav-overlay";
    document.body.appendChild(overlay);
  }

  const closeMobileNav = () => {
    document.body.classList.remove("mobile-nav-open");
    btn.setAttribute("aria-expanded", "false");
  };
  const openMobileNav = () => {
    document.body.classList.add("mobile-nav-open");
    btn.setAttribute("aria-expanded", "true");
  };

  const handleDesktopState = () => {
    if (mobileQuery.matches) {
      sidebar.classList.remove("collapsed");
      btn.setAttribute("aria-expanded", document.body.classList.contains("mobile-nav-open") ? "true" : "false");
      return;
    }
    closeMobileNav();
    if (localStorage.getItem("orbit_sidebar_collapsed") === "true") sidebar.classList.add("collapsed");
    btn.setAttribute("aria-expanded", sidebar.classList.contains("collapsed") ? "false" : "true");
  };

  handleDesktopState();
  mobileQuery.addEventListener("change", handleDesktopState);

  const setCollapsed = (collapsed) => {
    sidebar.classList.toggle("collapsed", collapsed);
    localStorage.setItem("orbit_sidebar_collapsed", String(collapsed));
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };

  // The « button closes it; the logo re-opens it (and shows » on hover).
  btn.addEventListener("click", () => {
    if (mobileQuery.matches) {
      if (document.body.classList.contains("mobile-nav-open")) closeMobileNav();
      else openMobileNav();
      return;
    }
    setCollapsed(true);
  });

  brand?.addEventListener("click", () => {
    if (mobileQuery.matches) {
      if (document.body.classList.contains("mobile-nav-open")) closeMobileNav();
      else openMobileNav();
      return;
    }
    // Only acts as a re-open affordance; when expanded the logo is inert.
    if (sidebar.classList.contains("collapsed")) setCollapsed(false);
  });

  overlay.addEventListener("click", closeMobileNav);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMobileNav(); });

  sidebar.querySelectorAll(".s-link, .s-sublink").forEach((link) => {
    link.addEventListener("click", () => { if (mobileQuery.matches) closeMobileNav(); });
  });
}

function initNavDropdown() {
  document.querySelectorAll(".s-group").forEach((group) => {
    const caret = group.querySelector(".s-caret");
    if (!caret) return;
    const startOpen = group.querySelector(".s-sublink.active")
      || localStorage.getItem("orbit_nav_open") === "true";
    group.classList.toggle("open", Boolean(startOpen));
    caret.setAttribute("aria-expanded", String(Boolean(startOpen)));
    caret.addEventListener("click", (e) => {
      e.preventDefault();
      const open = !group.classList.contains("open");
      group.classList.toggle("open", open);
      caret.setAttribute("aria-expanded", String(open));
      localStorage.setItem("orbit_nav_open", String(open));
    });
  });
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme() {
  // Fall back to the pre-rename key so an existing dark preference survives.
  const theme = localStorage.getItem("orbit_theme")
    || localStorage.getItem("interntrack_theme")
    || "light";
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
    localStorage.setItem("orbit_theme", next);
    applyTheme();
  });
}

// ── Talking-point suggestions ─────────────────────────────────────────────────

const INTERACTION_TYPES = ["coffee chat", "meeting", "check-in", "email", "phone call", "event"];

function generateFollowUpSuggestions(contact) {
  const name = contact.name || "them";
  const sentences = [];

  for (const interaction of (contact.interactions || []).slice(0, 3)) {
    if (!interaction.notes) continue;
    interaction.notes.split(/[.!?\n]+/).forEach((s) => {
      const trimmed = s.trim();
      if (trimmed.length > 8) sentences.push({ text: trimmed, source: "interaction" });
    });
  }
  if (contact.notes) {
    contact.notes.split(/[.!?\n]+/).forEach((s) => {
      const trimmed = s.trim();
      if (trimmed.length > 8) sentences.push({ text: trimmed, source: "notes" });
    });
  }
  if (!sentences.length) return ["Send " + name + " a quick check-in message"];

  const actionWords = /\b(mentioned|said|working on|planning|considering|wants to|will|might|should|asked|wondering|interested in|excited about|worried about|discussed|brought up|follow up|check back|update|revisit|explore|look into|thinking about|decided|going to|hope|looking for|applied|interviewing|offered|accepted|waiting|heard back|need to|want to)\b/i;

  const scored = sentences.map((s) => ({
    ...s,
    score: (actionWords.test(s.text) ? 2 : 0) + (s.source === "interaction" ? 1 : 0)
  }));
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const suggestions = [];
  for (const s of scored) {
    const key = s.text.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push("Follow up on: " + s.text.charAt(0).toUpperCase() + s.text.slice(1));
    if (suggestions.length >= 5) break;
  }
  return suggestions;
}

// ── Render helpers ────────────────────────────────────────────────────────────

function renderFollowUpItems(followUps) {
  if (!followUps || !followUps.length) {
    return '<p class="empty">No talking points yet. Add one, or use Suggest.</p>';
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
    '  <button class="fu-delete" type="button" data-fu-id="' + item.id + '" title="Delete" aria-label="Delete talking point">✕</button>',
    '</div>'
  ].join("\n")).join("\n");
}

function renderStorageFileCard(file, contact) {
  const dateStr = file.createdAt ? new Date(file.createdAt).toLocaleDateString() : "";
  return '<div class="file-card" data-file-id="' + escapeHtml(file.id) + '">'
    + '<div class="file-card-icon">📄</div>'
    + '<div class="file-card-body">'
    + '<p class="file-card-name" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</p>'
    + (contact
      ? '<p class="file-card-link">' + escapeHtml(contact.name)
        + (contact.company ? ' · ' + escapeHtml(contact.company) : '') + '</p>'
      : '<p class="file-card-link muted">Not linked</p>')
    + (dateStr ? '<p class="file-card-date">' + dateStr + '</p>' : '')
    + '</div>'
    + '<div class="file-card-actions">'
    + '<button class="file-action-btn file-open-btn" type="button"'
    + ' data-file-url="' + escapeHtml(file.fileUrl) + '" title="Open file">Open</button>'
    + '<button class="file-action-btn file-delete-btn" type="button"'
    + ' data-file-id="' + escapeHtml(file.id) + '"'
    + ' data-storage-path="' + escapeHtml(file.storagePath) + '" title="Delete file">✕</button>'
    + '</div>'
    + '</div>';
}

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

/** Each conversation is a <details> so it can be opened and closed. */
function renderInteractionTimeline(interactions) {
  if (!interactions || !interactions.length) return '<p class="empty">No conversations logged yet.</p>';
  return interactions.map((item, i) => {
    const summary = '<summary class="convo-summary">'
      + '<span class="convo-caret" aria-hidden="true">▸</span>'
      + '<span class="convo-date">' + formatDate(item.date) + '</span>'
      + '<span class="tag">' + escapeHtml(item.type) + '</span>'
      + (item.notes ? '' : '<span class="tiny muted">no notes</span>')
      + '</summary>';
    const body = item.notes
      ? '<p class="convo-note">' + escapeHtml(item.notes) + '</p>'
      : '<p class="convo-note muted">No notes were saved for this conversation.</p>';
    // Newest conversation starts open; the rest stay collapsed.
    return '<details class="convo"' + (i === 0 ? " open" : "") + '>' + summary + body + '</details>';
  }).join("\n");
}

/** <datalist> of every company already in the network, for autocomplete. */
function companyDatalist(contacts, id) {
  const names = new Set();
  contacts.forEach((c) => {
    if (c.company) names.add(c.company);
    (c.companyHistory || []).forEach((co) => names.add(co));
  });
  return '<datalist id="' + id + '">'
    + [...names].sort().map((n) => '<option value="' + escapeHtml(n) + '"></option>').join("")
    + '</datalist>';
}

function industryDatalist(contacts, id) {
  const names = new Set();
  contacts.forEach((c) => { if (c.industry) names.add(c.industry); });
  const common = ["Technology", "Finance", "Healthcare", "Consulting", "Education",
                  "Media", "Retail", "Non-profit", "Government", "Real Estate"];
  common.forEach((n) => names.add(n));
  return '<datalist id="' + id + '">'
    + [...names].sort().map((n) => '<option value="' + escapeHtml(n) + '"></option>').join("")
    + '</datalist>';
}

// ── Capture widget ────────────────────────────────────────────────────────────
// One form, used inline on the Networking Log and inside the dashboard modal.
// Fields use classes, not ids, so two copies can coexist on a page.

function contactWidgetHtml(contacts = []) {
  const freqOptions = Object.entries(FREQUENCY_LABELS)
    .map(([v, l]) => '<option value="' + v + '"' + (v === "monthly" ? " selected" : "") + '>' + l + '</option>')
    .join("");
  const listId = "cwCompanies_" + Math.random().toString(36).slice(2, 8);
  const indId = "cwIndustries_" + Math.random().toString(36).slice(2, 8);

  return '<form class="cw-form" autocomplete="off">'
    + companyDatalist(contacts, listId)
    + industryDatalist(contacts, indId)
    + '<div class="cw-grid">'
    + '<div class="field-group"><label>Name <span class="required">*</span></label>'
    + '<input type="text" class="cw-name" placeholder="Full name" required /></div>'
    + '<div class="field-group"><label>Role / Title</label>'
    + '<input type="text" class="cw-role" placeholder="Product Manager" /></div>'
    + '<div class="field-group"><label>Company</label>'
    + '<input type="text" class="cw-company" list="' + listId + '" placeholder="Where they work" /></div>'
    + '<div class="field-group"><label>Industry</label>'
    + '<input type="text" class="cw-industry" list="' + indId + '" placeholder="Technology" /></div>'
    + '<div class="field-group"><label>Email</label>'
    + '<input type="email" class="cw-email" placeholder="email@example.com" /></div>'
    + '<div class="field-group"><label>When you connected <span class="required">*</span></label>'
    + '<input type="date" class="cw-date" required /></div>'
    + '<div class="field-group"><label>Reach out again?</label>'
    + '<select class="cw-freq">' + freqOptions + '</select></div>'
    + '</div>'
    + '<div class="field-group"><label>Notes — what to bring up next time</label>'
    + '<textarea class="cw-notes" rows="2" placeholder="What you talked about, what they are working on, what to ask next…"></textarea></div>'
    + '<p class="error cw-error" aria-live="polite"></p>'
    + '<p class="success cw-success" aria-live="polite"></p>'
    + '<button type="submit" class="btn cw-submit">Add to network</button>'
    + '</form>';
}

function wireContactWidget(root, onSaved) {
  const form = root.querySelector(".cw-form");
  if (!form) return;

  const dateEl = form.querySelector(".cw-date");
  if (dateEl && !dateEl.value) dateEl.value = todayDateString();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errEl = form.querySelector(".cw-error");
    const okEl = form.querySelector(".cw-success");
    const submitBtn = form.querySelector(".cw-submit");
    errEl.textContent = "";
    okEl.textContent = "";

    const frequency = form.querySelector(".cw-freq").value || "none";
    const connectedOn = form.querySelector(".cw-date").value || todayDateString();
    const contact = normalizeContact({
      name: form.querySelector(".cw-name").value,
      role: form.querySelector(".cw-role").value,
      company: form.querySelector(".cw-company").value,
      industry: form.querySelector(".cw-industry").value,
      email: form.querySelector(".cw-email").value,
      dateMet: connectedOn,
      lastContacted: connectedOn,
      followUpFrequency: frequency,
      reminderEnabled: frequency !== "none",
      notes: form.querySelector(".cw-notes").value,
      interactions: []
    });

    if (!contact.name) { errEl.textContent = "A name is required."; return; }
    if (!contact.dateMet) { errEl.textContent = "Please set when you connected."; return; }

    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    const saved = await db.saveContact(contact);
    submitBtn.disabled = false;
    submitBtn.textContent = "Add to network";

    if (!saved) {
      errEl.textContent = "Could not save. Open the console (F12) for the Supabase error.";
      return;
    }

    form.reset();
    if (dateEl) dateEl.value = todayDateString();
    okEl.textContent = contact.name + " added to your network.";
    setTimeout(() => { okEl.textContent = ""; }, 3000);
    if (onSaved) await onSaved(saved);
  });
}

function openQuickAddModal(contacts, onSaved) {
  document.getElementById("quickAddModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "quickAddModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card quick-add-card">'
    + '<div class="quick-add-header">'
    + '<h3>Add someone to your network</h3>'
    + '<button class="icon-btn" id="quickAddClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + contactWidgetHtml(contacts)
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#quickAddClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  wireContactWidget(modal, async (saved) => {
    if (onSaved) await onSaved(saved);
    setTimeout(close, 900);
  });
  modal.querySelector(".cw-name")?.focus();
}

function initQuickAddButton(getContacts, onSaved) {
  const btn = document.getElementById("quickAddBtn");
  if (!btn) return;
  btn.addEventListener("click", () => openQuickAddModal(getContacts(), onSaved));
}

// ── Reach-out modal ───────────────────────────────────────────────────────────

function buildReminderEmailText(contact, yourName) {
  const name = contact.name || "there";
  const safeName = (yourName || "").trim() || "[Your Name]";
  return "Subject: Great catching up!\n\nHi " + name + ",\n\nHope you have been doing well! I wanted to reconnect and see how things have been going on your end.\n\nWould love to catch up soon.\n\nBest,\n" + safeName;
}

async function showReminderModal(contact, onChanged) {
  document.getElementById("reminderModal")?.remove();

  const prefs = await db.getPreferences();
  const emailText = buildReminderEmailText(contact, prefs.your_name || "");
  const nextStr = contact.nextReminder ? formatDate(contact.nextReminder.split("T")[0]) : "Not set";

  const modal = document.createElement("div");
  modal.id = "reminderModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card">'
    + '<div class="quick-add-header">'
    + '<h3>Reach out to <strong>' + escapeHtml(contact.name) + '</strong></h3>'
    + '<button class="icon-btn" id="modalClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + '<p class="muted">' + escapeHtml(getFreqLabel(contact.followUpFrequency)) + ' · Next: ' + nextStr + '</p>'
    + '<div class="modal-actions">'
    + '<button class="btn" id="modalMarkDone" type="button">I reached out</button>'
    + '<button class="btn btn-secondary" id="modalLater" type="button">Remind me in 3 days</button>'
    + '<button class="btn btn-secondary" id="modalTurnOff" type="button">Remove schedule</button>'
    + '</div>'
    + '<div class="modal-email">'
    + '<p class="label">Draft message</p>'
    + '<textarea class="email-draft" readonly rows="8">' + escapeHtml(emailText) + '</textarea>'
    + '<button class="btn btn-secondary" id="modalCopyEmail" type="button">Copy</button>'
    + '<p id="modalCopyMsg" class="success" aria-live="polite"></p>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const finish = async () => { modal.remove(); if (onChanged) await onChanged(); };

  modal.querySelector("#modalMarkDone").addEventListener("click", async () => {
    const today = todayDateString();
    await db.saveContact(normalizeContact({
      ...contact,
      lastContacted: today,
      nextReminder: calculateNextReminder(today, contact.followUpFrequency)
    }));
    await finish();
  });
  modal.querySelector("#modalLater").addEventListener("click", async () => {
    await db.saveContact(normalizeContact({
      ...contact,
      nextReminder: new Date(Date.now() + 3 * 86400000).toISOString()
    }));
    await finish();
  });
  modal.querySelector("#modalTurnOff").addEventListener("click", async () => {
    await db.saveContact(normalizeContact({
      ...contact, reminderEnabled: false, followUpFrequency: "none"
    }));
    await finish();
  });
  modal.querySelector("#modalCopyEmail").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(emailText);
      modal.querySelector("#modalCopyMsg").textContent = "Copied to clipboard.";
    } catch {
      modal.querySelector("#modalCopyMsg").textContent = "Copy failed — please copy manually.";
    }
  });
  modal.querySelector("#modalClose").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

// ── Shared row renderers ──────────────────────────────────────────────────────

function personRowHtml(contact, health, { showReconnect = false } = {}) {
  return '<li class="person-row" data-open-contact="' + escapeHtml(contact.id) + '" role="button" tabindex="0">'
    + '<div class="person-avatar" aria-hidden="true">' + escapeHtml(initialsFor(contact.name)) + '</div>'
    + '<div class="person-main">'
    + '<p class="person-name">' + escapeHtml(contact.name) + '</p>'
    + '<p class="tiny">' + escapeHtml(contact.role || "Role not set")
    + (contact.company ? ' @ <strong>' + escapeHtml(contact.company) + '</strong>' : '') + '</p>'
    + '<p class="tiny muted">Last connected ' + relativeDayLabel(contact.lastContacted)
    + (health.scheduled ? ' · ' + escapeHtml(getFreqLabel(contact.followUpFrequency)) : '') + '</p>'
    + (contact.industry ? '<span class="token token-industry">' + escapeHtml(contact.industry) + '</span>' : '')
    + '</div>'
    + '<div class="person-side">'
    + healthBarHtml(health)
    + (showReconnect && health.scheduled
      ? '<button class="btn btn-secondary btn-sm" type="button" data-remind-contact="'
        + escapeHtml(contact.id) + '">Reach out</button>'
      : '')
    + '</div>'
    + '</li>';
}

function wirePersonRows(root, contacts, onChanged) {
  root.querySelectorAll("[data-open-contact]").forEach((row) => {
    const open = () => {
      window.location.href = "contact.html?id=" + encodeURIComponent(row.dataset.openContact);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  root.querySelectorAll("[data-remind-contact]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const contact = contacts.find((c) => c.id === btn.dataset.remindContact);
      if (contact) await showReminderModal(contact, onChanged);
    });
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function initDashboard() {
  const root = document.getElementById("dashboardContent");
  if (!root) return;

  let cached = [];

  async function render() {
    const contacts = (await db.getContacts()) || [];
    cached = contacts;

    if (!contacts.length) {
      root.innerHTML = '<div class="card dash-empty">'
        + '<p class="dash-empty-icon">🛰️</p>'
        + '<h2>Your orbit starts here</h2>'
        + '<p class="muted">Add the people you meet, choose how often you want to reach out, '
        + 'and this page will show you who is drifting away.</p>'
        + '<a href="network.html" class="btn">Add your first connection</a>'
        + '</div>';
      return;
    }

    const counts = countByBand(contacts);
    const total = contacts.length;
    const scheduled = counts.good + counts.warning + counts.critical;
    // Denominators are the WHOLE network, so the four tiles always add up to
    // everyone you know — "0 of 0" was meaningless when nobody had a schedule.
    const healthPct = scheduled ? Math.round((counts.good / scheduled) * 100) : 0;
    const coveragePct = total ? Math.round((scheduled / total) * 100) : 0;
    const attention = needsAttention(contacts);

    const kpiHtml = '<div class="kpi-row">'
      + kpiTile("good", "In touch", counts.good, total, "on schedule and current")
      + kpiTile("warning", "Reach out soon", counts.warning, total, "window closing")
      + kpiTile("critical", "Overdue", counts.critical, total, "past due")
      + kpiTile("none", "No schedule", counts.none, total, "not on a cadence")
      + '</div>';

    // Each chart card is header + centred body, so all three share a baseline
    // and neither the ring nor the empty state gets pushed into a corner.
    const chartCard = (title, sub, body, extraClass) =>
      '<section class="card chart-card' + (extraClass ? " " + extraClass : "") + '">'
      + '<header class="chart-head">'
      + '<h2 class="chart-title">' + escapeHtml(title) + '</h2>'
      + '<p class="chart-sub muted">' + escapeHtml(sub) + '</p>'
      + '</header>'
      + '<div class="chart-body">' + body + '</div>'
      + '</section>';

    const chartsHtml = '<div class="chart-row">'
      + chartCard("Network health", "Of those on a cadence, how many are current",
          scheduled
            ? ringHtml({ pct: healthPct,
                         band: healthPct >= 60 ? "good" : healthPct >= 25 ? "warning" : "critical",
                         caption: "In touch", sub: counts.good + " of " + scheduled })
            : ringHtml({ pct: 0, band: "none", caption: "No cadences yet", sub: "Set one to begin" }))
      + chartCard("Coverage", "How much of your network is on a cadence",
          ringHtml({ pct: coveragePct, band: coveragePct > 0 ? "good" : "none",
                     caption: "On a cadence", sub: scheduled + " of " + total }))
      + chartCard("Breakdown", "Where your scheduled connections stand",
          scheduled
            ? splitBarHtml(counts)
            : '<p class="empty chart-empty">No cadences set yet — '
              + 'pick someone in <a href="contacts.html">My Network</a>.</p>',
          "chart-card-wide")
      + '</div>';

    const attentionHtml = '<section class="card dash-section">'
      + '<div class="dash-section-header">'
      + '<h2>Reach out next</h2>'
      + '<p class="muted">People on a schedule who are drifting — most overdue first.</p>'
      + '</div>'
      + (attention.length
        ? '<ul class="person-list">'
          + attention.map(({ contact, health }) => personRowHtml(contact, health, { showReconnect: true })).join("")
          + '</ul>'
        : '<p class="empty">You are current with everyone on a schedule. Nice work.</p>')
      + '</section>';

    root.innerHTML = kpiHtml + chartsHtml + attentionHtml;
    wirePersonRows(root, contacts, render);
  }

  function kpiTile(band, label, value, total, sub) {
    const meta = BAND_META[band];
    return '<div class="kpi-tile kpi-' + band + '">'
      + '<div class="kpi-head">'
      + '<span class="kpi-icon" aria-hidden="true">' + meta.icon + '</span>'
      + '<span class="kpi-label">' + escapeHtml(label) + '</span>'
      + '</div>'
      + '<p class="kpi-value">' + value + '<span class="kpi-total">/' + total + '</span></p>'
      + '<p class="kpi-sub">' + escapeHtml(sub) + '</p>'
      + '</div>';
  }

  await render();
  initQuickAddButton(() => cached, render);
}

// ── My Network ────────────────────────────────────────────────────────────────

async function initMyNetwork() {
  const list = document.getElementById("myNetworkList");
  if (!list) return;

  const searchEl = document.getElementById("networkSearch");
  const industryEl = document.getElementById("networkIndustry");
  const statusEl = document.getElementById("networkStatus");
  const countEl = document.getElementById("networkCount");
  let cached = [];

  async function load() {
    cached = (await db.getContacts()) || [];
    // Industry filter options, derived from the data.
    if (industryEl && industryEl.options.length <= 1) {
      [...new Set(cached.map((c) => c.industry).filter(Boolean))].sort().forEach((ind) => {
        const opt = document.createElement("option");
        opt.value = ind;
        opt.textContent = ind;
        industryEl.appendChild(opt);
      });
    }
    render();
  }

  function render() {
    const q = (searchEl?.value || "").trim().toLowerCase();
    const industry = industryEl?.value || "";
    const status = statusEl?.value || "";

    let people = cached.filter((c) => {
      if (industry && c.industry !== industry) return false;
      if (status && getHealth(c).band !== status) return false;
      if (!q) return true;
      return [c.name, c.role, c.company, c.industry, c.notes]
        .some((f) => f && f.toLowerCase().includes(q));
    });

    people.sort((a, b) => a.name.localeCompare(b.name));

    if (countEl) {
      countEl.textContent = people.length === cached.length
        ? `${cached.length} ${cached.length === 1 ? "person" : "people"}`
        : `${people.length} of ${cached.length}`;
    }

    if (!people.length) {
      list.innerHTML = '<li class="empty">Nobody matches those filters.</li>';
      return;
    }
    list.innerHTML = people
      .map((c) => personRowHtml(c, getHealth(c), { showReconnect: true }))
      .join("");
    wirePersonRows(list, cached, load);
  }

  searchEl?.addEventListener("input", render);
  industryEl?.addEventListener("change", render);
  statusEl?.addEventListener("change", render);

  await load();
  initQuickAddButton(() => cached, load);
}

// ── Networking Log ────────────────────────────────────────────────────────────

async function initNetworkingLog() {
  const widgetRoot = document.getElementById("contactWidget");
  const list = document.getElementById("connectionList");
  if (!widgetRoot || !list) return;

  const filterEl = document.getElementById("contactFilter");
  const industryEl = document.getElementById("logIndustry");
  const statusEl = document.getElementById("logStatus");
  const sortEl = document.getElementById("logSort");
  const clearEl = document.getElementById("logClearFilters");
  const countEl = document.getElementById("logCount");
  let cached = [];

  async function reload() {
    try {
      cached = (await db.getContacts()) || [];
    } catch {
      list.innerHTML = '<li class="empty" style="color:var(--danger)">Error loading connections — check the console (F12).</li>';
      return;
    }
    if (industryEl && industryEl.options.length <= 1) {
      [...new Set(cached.map((c) => c.industry).filter(Boolean))].sort().forEach((ind) => {
        const opt = document.createElement("option");
        opt.value = ind;
        opt.textContent = ind;
        industryEl.appendChild(opt);
      });
    }
    renderList();
  }

  function renderList() {
    const filterText = filterEl ? filterEl.value.trim().toLowerCase() : "";
    const industry = industryEl?.value || "";
    const status = statusEl?.value || "";
    const sort = sortEl?.value || "recent";

    let contacts = cached.filter((c) => {
      if (industry && c.industry !== industry) return false;
      if (status && getHealth(c).band !== status) return false;
      if (!filterText) return true;
      return [c.name, c.role, c.company, c.industry, c.notes]
        .some((f) => f && f.toLowerCase().includes(filterText));
    });

    if (countEl) {
      countEl.textContent = contacts.length === cached.length
        ? `${cached.length} ${cached.length === 1 ? "entry" : "entries"}`
        : `${contacts.length} of ${cached.length}`;
    }

    if (!contacts.length) {
      list.innerHTML = '<li class="empty">'
        + (cached.length ? 'Nobody matches those filters.'
                         : 'No connections logged yet — add your first one above.')
        + '</li>';
      return;
    }

    contacts = [...contacts];
    if (sort === "name") {
      contacts.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      contacts.sort((a, b) => String(b.lastContacted || "").localeCompare(String(a.lastContacted || "")));
      if (sort === "oldest") contacts.reverse();
    }

    // Month headers only make sense while sorted by date.
    const grouped = sort !== "name";
    let html = "";
    let currentGroup = "";
    for (const contact of contacts) {
      if (grouped) {
        const group = monthLabel(contact.lastContacted);
        if (group !== currentGroup) {
          currentGroup = group;
          html += '<li class="connection-group">' + escapeHtml(group) + '</li>';
        }
      }
      html += connectionRowHtml(contact);
    }
    list.innerHTML = html;
    wirePersonRows(list, cached, reload);
  }

  function monthLabel(value) {
    const date = parseDateOnly(value);
    if (!date) return "No date recorded";
    return date.toLocaleString("default", { month: "long", year: "numeric" });
  }

  function connectionRowHtml(contact) {
    const health = getHealth(contact);
    const date = parseDateOnly(contact.lastContacted);
    return '<li class="connection-row" data-open-contact="' + escapeHtml(contact.id) + '" role="button" tabindex="0">'
      + '<div class="connection-date">'
      + '<span class="connection-day">' + (date ? date.getDate() : "—") + '</span>'
      + '<span class="tiny muted">' + escapeHtml(relativeDayLabel(contact.lastContacted)) + '</span>'
      + '</div>'
      + '<div class="person-avatar" aria-hidden="true">' + escapeHtml(initialsFor(contact.name)) + '</div>'
      + '<div class="connection-main">'
      + '<p class="person-name">' + escapeHtml(contact.name) + ' ' + statusChip(health) + '</p>'
      + '<p class="tiny">' + escapeHtml(contact.role || "Role not set")
      + (contact.company ? ' @ <strong>' + escapeHtml(contact.company) + '</strong>' : '') + '</p>'
      + (contact.industry ? '<span class="token token-industry">' + escapeHtml(contact.industry) + '</span>' : '')
      + (contact.notes
        ? '<p class="connection-note">' + escapeHtml(contact.notes.slice(0, 140))
          + (contact.notes.length > 140 ? '…' : '') + '</p>'
        : '')
      + '</div>'
      + '</li>';
  }

  const seed = (await db.getContacts()) || [];
  widgetRoot.innerHTML = contactWidgetHtml(seed);
  wireContactWidget(widgetRoot, reload);

  filterEl?.addEventListener("input", renderList);
  industryEl?.addEventListener("change", renderList);
  statusEl?.addEventListener("change", renderList);
  sortEl?.addEventListener("change", renderList);
  clearEl?.addEventListener("click", () => {
    if (filterEl) filterEl.value = "";
    if (industryEl) industryEl.value = "";
    if (statusEl) statusEl.value = "";
    if (sortEl) sortEl.value = "recent";
    renderList();
  });

  await reload();
}

// ── Contact profile ───────────────────────────────────────────────────────────

async function initContactPage() {
  const root = document.getElementById("contactPageContent");
  if (!root) return;

  const contactId = new URLSearchParams(window.location.search).get("id");
  let allContacts = [];

  async function freshContact() {
    allContacts = (await db.getContacts()) || [];
    return allContacts.find((c) => c.id === contactId) || null;
  }

  async function save(updateFn) {
    const c = await freshContact();
    if (!c) return;
    await db.saveContact(normalizeContact(updateFn(c)));
  }

  async function renderPage() {
    const c = await freshContact();
    if (!c) {
      root.innerHTML = '<div class="card"><p class="error">Connection not found. <a href="contacts.html">Back to My Network</a></p></div>';
      return;
    }

    const health = getHealth(c);
    const isCustomFreq = c.followUpFrequency && c.followUpFrequency.startsWith("custom:");
    const freqSelectValue = isCustomFreq ? "custom" : (c.followUpFrequency || "none");
    const freqOptions = Object.entries(FREQUENCY_LABELS)
      .map(([v, l]) => '<option value="' + v + '"' + (freqSelectValue === v ? " selected" : "") + '>' + l + '</option>')
      .join("")
      + '<option value="custom"' + (isCustomFreq ? " selected" : "") + '>Custom…</option>';
    const pastCompanies = (c.companyHistory || []).filter((co) => co !== c.company);

    root.innerHTML =
      '<a href="contacts.html" class="btn btn-secondary back-btn">← Back to My Network</a>'

      // ── Hero: identity on the left, reach-out panel on the right ──────────
      + '<div class="card profile-hero">'
      + '<div class="profile-identity">'
      + '<div class="profile-avatar" aria-hidden="true">' + escapeHtml(initialsFor(c.name)) + '</div>'
      + '<div class="profile-id-text">'
      + '<input type="text" id="cpNameInput" class="profile-name-input" value="' + escapeHtml(c.name) + '" aria-label="Name" />'
      + '<p class="profile-role">' + escapeHtml(c.role || "Role not set") + '</p>'

      + '<div class="company-block">'
      + '<span class="company-label">Current company</span>'
      + (c.company
        ? '<span class="company-current">' + escapeHtml(c.company) + '</span>'
        : '<span class="company-current company-empty">Not set</span>')
      + '</div>'

      + (c.industry
        ? '<span class="token token-industry">' + escapeHtml(c.industry) + '</span>'
        : '')

      + (pastCompanies.length
        ? '<div class="company-past"><span class="company-label">Previously</span>'
          + pastCompanies.map((co) =>
              '<span class="token token-past">' + escapeHtml(co)
              + '<button class="token-x" type="button" data-remove-company="' + escapeHtml(co) + '" aria-label="Remove ' + escapeHtml(co) + '">✕</button></span>').join("")
          + '</div>'
        : '')

      + (c.email ? '<a href="mailto:' + escapeHtml(c.email) + '" class="profile-email">✉ ' + escapeHtml(c.email) + '</a>' : '')

      + '<button class="btn btn-secondary btn-sm add-detail-btn" id="cpToggleEdit" type="button">+ Add role, company or industry</button>'

      // Inline editor replaces the old separate "Roles & Companies" card.
      + '<div class="inline-edit hidden" id="cpInlineEdit">'
      + companyDatalist(allContacts, "cpCompanies")
      + industryDatalist(allContacts, "cpIndustries")
      + '<div class="inline-edit-grid">'
      + '<div class="field-group"><label>Role / Title</label>'
      + '<input type="text" id="cpRole" value="' + escapeHtml(c.role) + '" placeholder="Product Manager" /></div>'
      + '<div class="field-group"><label>Current company</label>'
      + '<input type="text" id="cpCompany" list="cpCompanies" value="' + escapeHtml(c.company) + '" placeholder="Where they work now" /></div>'
      + '<div class="field-group"><label>Industry</label>'
      + '<input type="text" id="cpIndustry" list="cpIndustries" value="' + escapeHtml(c.industry) + '" placeholder="Technology" /></div>'
      + '<div class="field-group"><label>Email</label>'
      + '<input type="email" id="cpEmail" value="' + escapeHtml(c.email) + '" placeholder="email@example.com" /></div>'
      + '</div>'
      + '<div class="inline-edit-actions">'
      + '<input type="text" id="cpAddPast" list="cpCompanies" placeholder="Add a past company…" />'
      + '<button class="btn btn-secondary" id="cpAddPastBtn" type="button">Add past</button>'
      + '</div>'
      + '<button class="btn" id="cpSaveDetailsBtn" type="button">Save details</button>'
      + '<p id="cpSaveDetailsMsg" class="success" aria-live="polite"></p>'
      + '</div>'

      + '</div>'
      + '</div>'

      // Wide horizontal reach-out strip: ring, facts, and controls in one row.
      + '<div class="reachout-strip">'
      + '<div class="reachout-ring">'
      + ringHtml({
          pct: health.scheduled ? health.pct : 0,
          band: health.scheduled ? health.band : "none",
          caption: BAND_META[health.band].label,
          sub: health.scheduled
            ? (health.daysLeft >= 0 ? health.daysLeft + " days left" : Math.abs(health.daysLeft) + " days over")
            : "Reach out again?"
        })
      + '</div>'
      + '<dl class="reachout-meta">'
      + '<div><dt>Last connected</dt><dd>' + escapeHtml(relativeDayLabel(c.lastContacted)) + '</dd></div>'
      + '<div><dt>Next nudge</dt><dd>' + (c.nextReminder ? formatDate(c.nextReminder.split("T")[0]) : "—") + '</dd></div>'
      + '</dl>'
      + '<div class="reachout-controls">'
      + '<div class="field-group"><label for="cpFrequency">Reach out again?</label>'
      + '<select id="cpFrequency">' + freqOptions + '</select></div>'
      + '<div class="field-group' + (isCustomFreq ? '' : ' hidden') + '" id="cpCustomDaysGroup">'
      + '<label for="cpCustomDays">Every how many days?</label>'
      + '<input type="number" id="cpCustomDays" min="1" max="365" placeholder="30" value="'
      + escapeHtml(isCustomFreq ? c.followUpFrequency.slice(7) : "") + '" /></div>'
      + '<div class="reachout-actions">'
      + '<button class="btn" id="cpSaveReminderBtn" type="button">Save</button>'
      + '<button class="btn btn-secondary" id="cpOpenReminderBtn" type="button">Draft a message</button>'
      + '</div>'
      + '<p id="cpSaveReminderMsg" class="success" aria-live="polite"></p>'
      + '</div>'
      + '</div>'
      + '</div>'

      // ── Body ──────────────────────────────────────────────────────────────
      + '<div class="profile-body">'

      + '<section class="card">'
      + '<h3 class="section-title">Log a conversation</h3>'
      + '<div class="two-col">'
      + '<div class="field-group"><label for="cpIntDate">Date</label>'
      + '<input type="date" id="cpIntDate" value="' + todayDateString() + '" /></div>'
      + '<div class="field-group"><label for="cpIntType">Type</label>'
      + '<select id="cpIntType">'
      + INTERACTION_TYPES.map((t) => '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>').join("")
      + '</select></div>'
      + '</div>'
      + '<div class="field-group"><label for="cpIntNotes">Notes</label>'
      + '<textarea id="cpIntNotes" rows="5" placeholder="What did you talk about? What should you follow up on?"></textarea></div>'
      + '<div class="field-group"><label for="cpIntDocInput">Attach a PDF <span class="opt-label">(optional)</span></label>'
      + '<input type="file" id="cpIntDocInput" accept=".pdf,application/pdf" /></div>'
      + '<p id="cpIntError" class="error" aria-live="polite"></p>'
      + '<button class="btn" id="cpAddIntBtn" type="button">Save conversation</button>'
      + '</section>'

      + '<section class="card">'
      + '<div class="followup-section-header">'
      + '<div><h3 class="section-title">Things to bring up next</h3>'
      + '<p class="section-sub muted">Check items off once you have discussed them.</p></div>'
      + '<button class="btn btn-secondary btn-sm" id="cpSuggestBtn" type="button">✦ Suggest</button>'
      + '</div>'
      + '<div id="cpFollowUpList">' + renderFollowUpItems(c.followUps) + '</div>'
      + '<div class="followup-add-row">'
      + '<input type="text" id="cpNewFollowUp" placeholder="Add a talking point…" />'
      + '<button class="btn" id="cpAddFollowUpBtn" type="button">Add</button>'
      + '</div>'
      + '<p id="cpFollowUpMsg" class="success" aria-live="polite"></p>'
      + '</section>'

      + '<section class="card profile-timeline">'
      + '<h3 class="section-title">Conversation history</h3>'
      + '<div class="timeline">' + renderInteractionTimeline(c.interactions) + '</div>'
      + '</section>'

      + '</div>'

      // ── Danger zone, at the bottom where it belongs ───────────────────────
      + '<section class="card danger-zone">'
      + '<div><h3 class="section-title">Delete this connection</h3>'
      + '<p class="section-sub muted">Removes ' + escapeHtml(c.name) + ' and their whole history. This cannot be undone.</p></div>'
      + '<button class="btn danger-btn" id="cpDeleteBtn" type="button">Delete connection</button>'
      + '</section>';

    wireProfile(c);
  }

  function wireProfile(c) {
    const $ = (sel) => root.querySelector(sel);

    $("#cpNameInput").addEventListener("blur", async (e) => {
      const newName = e.target.value.trim();
      if (!newName) { e.target.value = (await freshContact())?.name || ""; return; }
      await save((cur) => ({ ...cur, name: newName }));
    });

    const inlineEdit = $("#cpInlineEdit");
    $("#cpToggleEdit").addEventListener("click", () => {
      // classList.toggle returns true when the class was ADDED — i.e. now hidden.
      const isHidden = inlineEdit.classList.toggle("hidden");
      $("#cpToggleEdit").textContent = isHidden ? "+ Add role, company or industry" : "− Hide details";
      if (!isHidden) $("#cpRole").focus();
    });

    $("#cpSaveDetailsBtn").addEventListener("click", async () => {
      const company = $("#cpCompany").value.trim();
      await save((cur) => {
        // Moving to a new company pushes the old one into history automatically.
        const history = [...(cur.companyHistory || [])];
        if (cur.company && company && cur.company !== company && !history.includes(cur.company)) {
          history.push(cur.company);
        }
        return {
          ...cur,
          role: $("#cpRole").value.trim(),
          company,
          industry: $("#cpIndustry").value.trim(),
          email: $("#cpEmail").value.trim(),
          companyHistory: history
        };
      });
      const msg = $("#cpSaveDetailsMsg");
      msg.textContent = "Saved!";
      setTimeout(() => { msg.textContent = ""; }, 2000);
      await renderPage();
    });

    const addPast = async () => {
      const value = $("#cpAddPast").value.trim();
      if (!value) return;
      await save((cur) => ({
        ...cur,
        companyHistory: cur.companyHistory.includes(value) ? cur.companyHistory : [...cur.companyHistory, value]
      }));
      await renderPage();
    };
    $("#cpAddPastBtn").addEventListener("click", addPast);
    $("#cpAddPast").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addPast(); } });

    root.querySelectorAll("[data-remove-company]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const target = btn.dataset.removeCompany;
        await save((cur) => ({ ...cur, companyHistory: cur.companyHistory.filter((co) => co !== target) }));
        await renderPage();
      });
    });

    const freqSelect = $("#cpFrequency");
    const customGroup = $("#cpCustomDaysGroup");
    freqSelect.addEventListener("change", () => {
      customGroup.classList.toggle("hidden", freqSelect.value !== "custom");
    });

    $("#cpSaveReminderBtn").addEventListener("click", async () => {
      let newFreq = freqSelect.value;
      if (newFreq === "custom") {
        const days = parseInt($("#cpCustomDays")?.value, 10);
        newFreq = (!Number.isNaN(days) && days > 0) ? "custom:" + days : "none";
      }
      await save((cur) => ({
        ...cur,
        followUpFrequency: newFreq,
        reminderEnabled: newFreq !== "none",
        nextReminder: calculateNextReminder(cur.lastContacted || cur.dateMet, newFreq)
      }));
      const msg = $("#cpSaveReminderMsg");
      msg.textContent = "Schedule saved!";
      setTimeout(() => { msg.textContent = ""; }, 2000);
      await renderPage();
    });

    $("#cpOpenReminderBtn").addEventListener("click", async () => {
      const fresh = await freshContact();
      if (fresh) await showReminderModal(fresh, renderPage);
    });

    $("#cpDeleteBtn").addEventListener("click", async () => {
      const contact = await freshContact();
      if (!contact || !window.confirm("Delete " + contact.name + " and their whole history?")) return;
      await db.deleteContact(contactId);
      window.location.href = "contacts.html";
    });

    $("#cpAddIntBtn").addEventListener("click", async () => {
      const errEl = $("#cpIntError");
      errEl.textContent = "";
      const date = $("#cpIntDate").value;
      if (!date) { errEl.textContent = "Date is required."; return; }

      const docFile = $("#cpIntDocInput")?.files?.[0];
      if (docFile && docFile.type !== "application/pdf") {
        errEl.textContent = "Only PDF files are allowed."; return;
      }

      const interaction = normalizeInteraction({
        date, type: $("#cpIntType").value, notes: $("#cpIntNotes").value.trim()
      });
      await save((cur) => {
        const newInteractions = [interaction, ...cur.interactions].sort((a, b) => b.date.localeCompare(a.date));
        return {
          ...cur,
          interactions: newInteractions,
          lastContacted: newInteractions[0].date,
          nextReminder: calculateNextReminder(newInteractions[0].date, cur.followUpFrequency)
        };
      });
      if (docFile) {
        const uploaded = await db.uploadFileToStorage(docFile, { contactId });
        if (!uploaded) errEl.textContent = "Conversation saved but the file upload failed.";
      }
      await renderPage();
    });

    const addFollowUp = async () => {
      const input = $("#cpNewFollowUp");
      const text = input ? input.value.trim() : "";
      if (!text) return;
      await save((cur) => ({ ...cur, followUps: [normalizeFollowUpItem({ text, source: "manual" }), ...(cur.followUps || [])] }));
      if (input) input.value = "";
      await refreshFollowUps();
    };
    $("#cpAddFollowUpBtn").addEventListener("click", addFollowUp);
    $("#cpNewFollowUp").addEventListener("keydown", (e) => { if (e.key === "Enter") addFollowUp(); });

    $("#cpSuggestBtn").addEventListener("click", async () => {
      const fresh = await freshContact();
      if (!fresh) return;
      const existing = new Set((fresh.followUps || []).map((f) => f.text.toLowerCase()));
      const deduped = generateFollowUpSuggestions(fresh)
        .map((text) => normalizeFollowUpItem({ text, source: "ai" }))
        .filter((f) => !existing.has(f.text.toLowerCase()));
      const msg = $("#cpFollowUpMsg");
      if (!deduped.length) {
        msg.textContent = "All suggestions already added!";
        setTimeout(() => { msg.textContent = ""; }, 2500);
        return;
      }
      await save((cur) => ({ ...cur, followUps: [...deduped, ...(cur.followUps || [])] }));
      await refreshFollowUps();
      msg.textContent = deduped.length + " suggestion" + (deduped.length !== 1 ? "s" : "") + " added!";
      setTimeout(() => { msg.textContent = ""; }, 2500);
    });

    async function refreshFollowUps() {
      const fresh = await freshContact();
      const listEl = $("#cpFollowUpList");
      if (listEl && fresh) listEl.innerHTML = renderFollowUpItems(fresh.followUps);
      attachFollowUpListeners();
    }

    function attachFollowUpListeners() {
      root.querySelectorAll(".fu-checkbox").forEach((cb) => {
        cb.addEventListener("change", async () => {
          await save((cur) => ({
            ...cur,
            followUps: (cur.followUps || []).map((f) => f.id !== cb.dataset.fuId ? f : { ...f, completed: cb.checked })
          }));
          await refreshFollowUps();
        });
      });
      root.querySelectorAll(".fu-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
          await save((cur) => ({ ...cur, followUps: (cur.followUps || []).filter((f) => f.id !== btn.dataset.fuId) }));
          await refreshFollowUps();
        });
      });
    }
    attachFollowUpListeners();
  }

  await renderPage();
}

// ── Files ─────────────────────────────────────────────────────────────────────

async function initFilesPage() {
  const fileGrid = document.getElementById("fileGrid");
  if (!fileGrid) return;

  let allFiles = [];
  let contacts = [];
  const byId = new Map();

  const contactSelect = document.getElementById("fileContact");
  const searchEl = document.getElementById("fileSearch");
  const industryEl = document.getElementById("fileIndustry");
  const linkEl = document.getElementById("fileLinkFilter");

  contacts = (await db.getContacts()) || [];
  contacts.forEach((c) => byId.set(c.id, c));
  const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name));

  if (contactSelect) {
    sorted.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name + (c.company ? " @ " + c.company : "");
      contactSelect.appendChild(opt);
    });
  }
  if (linkEl) {
    sorted.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      linkEl.appendChild(opt);
    });
  }
  if (industryEl) {
    [...new Set(contacts.map((c) => c.industry).filter(Boolean))].sort().forEach((ind) => {
      const opt = document.createElement("option");
      opt.value = ind;
      opt.textContent = ind;
      industryEl.appendChild(opt);
    });
  }

  // ── Upload ───────────────────────────────────────────────────────────────
  const dropZone = document.getElementById("fileDropZone");
  const fileInput = document.getElementById("fileInput");
  const preview = document.getElementById("fileDropPreview");
  const errEl = document.getElementById("fileUploadError");
  const msgEl = document.getElementById("fileUploadMsg");
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
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("file-drop-zone-hover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("file-drop-zone-hover"));
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("file-drop-zone-hover");
      validateAndPreview(e.dataTransfer.files[0]);
    });
    dropZone.addEventListener("click", () => fileInput && fileInput.click());
    dropZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (fileInput) fileInput.click(); }
    });
  }
  if (fileInput) fileInput.addEventListener("change", () => validateAndPreview(fileInput.files[0]));

  const uploadBtn = document.getElementById("fileUploadBtn");
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      if (errEl) errEl.textContent = "";
      if (msgEl) msgEl.textContent = "";
      const file = pendingFile || (fileInput && fileInput.files[0]);
      if (!file) { if (errEl) errEl.textContent = "Please select a PDF first."; return; }
      if (file.type !== "application/pdf") { if (errEl) errEl.textContent = "Only PDF files are allowed."; return; }

      uploadBtn.disabled = true;
      uploadBtn.textContent = "Uploading…";
      const result = await db.uploadFileToStorage(file, { contactId: contactSelect?.value || null });
      uploadBtn.disabled = false;
      uploadBtn.textContent = "Upload PDF →";

      if (!result) {
        if (errEl) errEl.textContent = "Upload failed. Check that the storage bucket exists.";
        return;
      }
      pendingFile = null;
      if (fileInput) fileInput.value = "";
      if (preview) { preview.classList.add("hidden"); preview.textContent = ""; }
      if (dropZone) dropZone.classList.remove("file-drop-zone-ready");
      if (msgEl) {
        msgEl.textContent = "✅ Uploaded.";
        setTimeout(() => { if (msgEl) msgEl.textContent = ""; }, 3000);
      }
      await loadAndRenderFiles();
    });
  }

  // ── Filter + render ──────────────────────────────────────────────────────
  function renderGrid() {
    const q = (searchEl?.value || "").trim().toLowerCase();
    const industry = industryEl?.value || "";
    const linkedTo = linkEl?.value || "";

    const filtered = allFiles.filter((f) => {
      const contact = f.contactId ? byId.get(f.contactId) : null;
      if (linkedTo === "__none__" && f.contactId) return false;
      if (linkedTo && linkedTo !== "__none__" && f.contactId !== linkedTo) return false;
      if (industry && (!contact || contact.industry !== industry)) return false;
      if (!q) return true;
      return [f.name, contact?.name, contact?.role, contact?.company, contact?.industry]
        .some((field) => field && field.toLowerCase().includes(q));
    });

    if (!filtered.length) {
      fileGrid.innerHTML = '<p class="empty" style="padding:1rem 0">'
        + (allFiles.length ? "No files match those filters." : "No files uploaded yet.") + '</p>';
      return;
    }
    fileGrid.innerHTML = filtered
      .map((f) => renderStorageFileCard(f, f.contactId ? byId.get(f.contactId) : null))
      .join("");
    attachStorageFileCardListeners(fileGrid, loadAndRenderFiles);
  }

  async function loadAndRenderFiles() {
    allFiles = await db.fetchAllStorageFiles();
    renderGrid();
  }

  searchEl?.addEventListener("input", renderGrid);
  industryEl?.addEventListener("change", renderGrid);
  linkEl?.addEventListener("change", renderGrid);

  // Funnel button reveals the filter panel; the badge shows when filters are on.
  const filterToggle = document.getElementById("fileFilterToggle");
  const filterPanel = document.getElementById("fileFilterPanel");
  filterToggle?.addEventListener("click", () => {
    const isHidden = filterPanel.classList.toggle("hidden");
    filterToggle.setAttribute("aria-expanded", String(!isHidden));
  });

  document.getElementById("fileClearFilters")?.addEventListener("click", () => {
    if (industryEl) industryEl.value = "";
    if (linkEl) linkEl.value = "";
    renderGrid();
    filterToggle?.classList.remove("filter-active");
  });

  const markActive = () => {
    const on = Boolean(industryEl?.value || linkEl?.value);
    filterToggle?.classList.toggle("filter-active", on);
  };
  industryEl?.addEventListener("change", markActive);
  linkEl?.addEventListener("change", markActive);

  await loadAndRenderFiles();
}

// ── Settings ──────────────────────────────────────────────────────────────────
// `preferences.your_name` signs the draft messages. Without somewhere to set it
// every draft went out as "[Your Name]".

async function openSettingsModal() {
  document.getElementById("settingsModal")?.remove();
  const prefs = await db.getPreferences();

  const modal = document.createElement("div");
  modal.id = "settingsModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card settings-card">'
    + '<div class="quick-add-header">'
    + '<h3>Settings</h3>'
    + '<button class="icon-btn" id="settingsClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + '<p class="muted settings-intro">Used to sign the draft messages Orbit writes for you.</p>'
    + '<div class="field-group"><label for="setYourName">Your name</label>'
    + '<input type="text" id="setYourName" value="' + escapeHtml(prefs.your_name || "") + '" placeholder="Ada Lovelace" /></div>'
    + '<div class="field-group"><label for="setYourEmail">Your email</label>'
    + '<input type="email" id="setYourEmail" value="' + escapeHtml(prefs.your_email || "") + '" placeholder="you@example.com" /></div>'
    + '<p id="settingsMsg" class="success" aria-live="polite"></p>'
    + '<button class="btn" id="settingsSave" type="button">Save</button>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#settingsClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  modal.querySelector("#settingsSave").addEventListener("click", async () => {
    await db.savePreferences({
      your_name: modal.querySelector("#setYourName").value.trim(),
      your_email: modal.querySelector("#setYourEmail").value.trim()
    });
    const msg = modal.querySelector("#settingsMsg");
    msg.textContent = "Saved!";
    setTimeout(close, 800);
  });

  modal.querySelector("#setYourName").focus();
}

function initSettings() {
  document.getElementById("settingsBtn")?.addEventListener("click", openSettingsModal);
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

// ── Reach-out nudge on load ───────────────────────────────────────────────────

async function checkRemindersOnLoad() {
  if (document.querySelector("[data-page='contact']")) return;
  setTimeout(async () => {
    const contacts = (await db.getContacts()) || [];
    const due = contacts.filter((c) => getReminderStatus(c) === "due");
    if (due.length) showReminderModal(due[0]);
  }, 900);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  const user = await requireAuth();
  if (!user) return;
  initSidebarToggle();
  initNavDropdown();
  initThemeToggle();
  initSettings();
  initSignOut();
  await initDashboard();
  await initMyNetwork();
  await initNetworkingLog();
  await initContactPage();
  await initFilesPage();
  await checkRemindersOnLoad();
})();
