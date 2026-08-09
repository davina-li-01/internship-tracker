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
import * as calendar from "./calendar.js";

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

/** Days you get to make the first contact after putting someone on a cadence. */
const GRACE_DAYS = 7;

function addDays(dateStr, n) {
  const d = parseDateOnly(dateStr);
  if (!d) return "";
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The deadline a contact is actually judged against. `nextReminder` is the
 * single source of truth — it carries the grace window granted when a cadence
 * is first set, and any "remind me in 3 days" snooze.
 */
function getHealth(contact) {
  const interval = getIntervalDays(contact.followUpFrequency);
  const last = contact.lastContacted || contact.dateMet;
  const elapsed = daysSince(last);

  if (!interval || !contact.reminderEnabled || elapsed === null) {
    return { scheduled: false, pct: 0, band: "none", elapsed, interval: 0, daysLeft: null, grace: false };
  }

  const naturalNext = addDays(last, interval);
  const next = contact.nextReminder ? String(contact.nextReminder).slice(0, 10) : naturalNext;

  // A deadline later than the cadence alone would give means the window was
  // deliberately extended — the one-week grace on a fresh schedule, or a snooze.
  const grace = Boolean(next && naturalNext && next > naturalNext);
  const window = grace ? GRACE_DAYS : interval;

  // daysSince is negative for future dates, so this is "days until the deadline".
  const daysLeft = -daysSince(next);
  const pct = Math.max(0, Math.min(100, Math.round((daysLeft / window) * 100)));

  // Three rules, in order:
  //  - past the deadline is overdue, full stop
  //  - inside a grace window you still owe someone a first reach-out, so it is
  //    never "in touch" no matter how much of the window is left. That keeps it
  //    on the dashboard's "Reach out next" list until you confirm you reached
  //    out, which is the whole point of granting the window.
  //  - otherwise it is the ordinary countdown
  // "Overdue" must mean the deadline actually passed, not merely that the
  // remaining percentage is small. A 90-day cadence at day 80 is down to 11%
  // but still has 10 days left — calling that overdue contradicts the detail.
  const band = daysLeft < 0 ? "critical"
    : grace ? "warning"
    : pct >= 60 ? "good" : "warning";

  return { scheduled: true, pct, band, elapsed, interval, daysLeft, grace };
}

/**
 * The deadline to use when a cadence is switched on.
 *
 * If the last touchpoint already blows the cadence — which is the norm when you
 * are back-filling old conversations — the natural deadline is in the past and
 * the contact would land on the dashboard as overdue the instant you saved.
 * Instead you get GRACE_DAYS from today to make that first reach-out. This is
 * granted once, at the moment of switching on; logging a conversation moves the
 * deadline onto the normal cadence and it never comes back.
 */
function firstDeadlineFor(lastContacted, frequency) {
  const interval = getIntervalDays(frequency);
  if (!interval) return "";
  const natural = addDays(lastContacted, interval);
  const graceUntil = addDays(todayDateString(), GRACE_DAYS);
  if (!natural) return graceUntil;
  return natural < todayDateString() ? graceUntil : natural;
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
  const days = Math.abs(health.daysLeft);
  const detail = health.daysLeft < 0
    ? `${days} day${days === 1 ? "" : "s"} over`
    : health.grace
      ? `${days} day${days === 1 ? "" : "s"} to first reach-out`
      : `${days} day${days === 1 ? "" : "s"} left`;
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
    outcome: (item.outcome || "").trim(),
    // Ids into storage_files (ORB-20). Held on the interaction rather than as a
    // column on storage_files because interactions are jsonb on contacts, so
    // attaching a PDF to a conversation needs no schema migration. Ids that no
    // longer resolve — the file was deleted from the Files page — are dropped
    // at render time rather than cleaned up here.
    fileIds: Array.isArray(item.fileIds) ? item.fileIds.filter(Boolean) : [],
    // The Google Calendar event this came from, when it came from one (ORB-15).
    // Syncing is re-run every time you open Orbit, so this is what stops the
    // same meeting being logged again on every sync. Empty for anything typed
    // by hand.
    sourceEventId: (item.sourceEventId || "").trim()
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
  if (!nextReminder && frequency !== "none") {
    // Covers back-filling someone you met months ago: the cadence alone would
    // put the deadline in the past, so they get the grace window instead.
    nextReminder = firstDeadlineFor(lastContacted, frequency);
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

/**
 * One-line preview of the most recent conversation, falling back to the
 * contact-level note. The log is a record of conversations, so what was said
 * most recently is the useful thing to surface.
 */
function conversationPreview(contact, limit = 150) {
  const latest = (contact.interactions || [])
    .filter((i) => i.notes)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const text = latest?.notes || contact.notes || "";
  const clips = (contact.interactions || [])
    .reduce((n, i) => n + ((i.fileIds || []).length), 0);
  // A conversation logged with only a PDF and no notes used to render nothing
  // here, which is the same "did that save?" problem as ORB-14.
  if (!text && !clips) return "";
  const count = (contact.interactions || []).length;
  return '<p class="connection-note">'
    + (latest ? '<span class="convo-count">' + count
        + (count === 1 ? " conversation" : " conversations") + '</span> ' : '')
    + (clips ? '<span class="convo-count">📎 ' + clips + '</span> ' : '')
    + escapeHtml(text.slice(0, limit)) + (text.length > limit ? "…" : "")
    + '</p>';
}

/** Which cadence bucket a contact falls in, for filtering. */
function cadenceKey(contact) {
  const freq = contact.followUpFrequency || "none";
  if (!contact.reminderEnabled || freq === "none") return "none";
  return freq.startsWith("custom:") ? "custom" : freq;
}

// ── Shared filter definitions ─────────────────────────────────────────────────
// Used by every page that lists connections, so the same question is asked the
// same way everywhere.

const CADENCE_FILTER = { key: "cadence", label: "Cadence", options: [
  { value: "", label: "Any cadence" },
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Every month" },
  { value: "bimonthly", label: "Every 2 months" },
  { value: "quarterly", label: "Every 3 months" },
  { value: "custom", label: "Custom" },
  { value: "none", label: "No cadence set" }
] };

const STATUS_FILTER = { key: "status", label: "Connection health", options: [
  { value: "", label: "Any health" },
  { value: "good", label: "In touch" },
  { value: "warning", label: "Reach out soon" },
  { value: "critical", label: "Overdue" },
  { value: "none", label: "Not measured" }
] };

/** Answers "who have I not spoken to in a while?" */
const SILENCE_FILTER = { key: "silent", label: "Last spoke", options: [
  { value: "", label: "Any time" },
  { value: "30", label: "Over a month ago" },
  { value: "90", label: "Over 3 months ago" },
  { value: "180", label: "Over 6 months ago" },
  { value: "365", label: "Over a year ago" }
] };

/** True when a contact passes the cadence / health / silence filters. */
function matchesConnectionFilters(contact, { cadence, status, silent }) {
  if (cadence && cadenceKey(contact) !== cadence) return false;
  if (status && getHealth(contact).band !== status) return false;
  if (silent) {
    const elapsed = daysSince(contact.lastContacted || contact.dateMet);
    if (elapsed === null || elapsed < Number(silent)) return false;
  }
  return true;
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
  document.documentElement.style.colorScheme = theme;
}

// ── Talking-point suggestions ─────────────────────────────────────────────────

const INTERACTION_TYPES = ["coffee chat", "meeting", "check-in", "email", "phone call", "event"];

/**
 * What may be attached to a conversation or uploaded to Files.
 *
 * Images matter as much as PDFs here: notes taken by hand exist as a photo on a
 * phone, and refusing those meant the most common way people actually take
 * notes could not be filed at all.
 *
 * HEIC is what an iPhone produces by default. Browsers cannot render it, so it
 * uploads and downloads fine but will not preview — worth accepting anyway
 * rather than rejecting the file someone actually has.
 */
const ATTACH_ACCEPT = ".pdf,application/pdf,image/*,.heic,.heif";

function isAllowedAttachment(file) {
  if (!file) return false;
  const type = (file.type || "").toLowerCase();
  if (type === "application/pdf" || type.startsWith("image/")) return true;
  // Some browsers report an empty type for .heic — fall back to the extension.
  return /\.(pdf|jpe?g|png|gif|webp|heic|heif)$/i.test(file.name || "");
}

const ATTACH_REJECT_MSG = "Attach a PDF or an image (a photo of handwritten notes is fine).";

function isImageFile(file) {
  const name = (file.name || "").toLowerCase();
  return /\.(jpe?g|png|gif|webp|heic|heif|avif)$/.test(name);
}

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

/**
 * A document tile: rendered page preview on top, name and actions underneath.
 * The preview is an <object> pointing at the PDF — browsers render page one
 * natively, so there is no PDF library to load.
 */
function renderStorageFileCard(file, contact) {
  const dateStr = file.createdAt ? new Date(file.createdAt).toLocaleDateString() : "";
  const previewUrl = file.fileUrl
    ? escapeHtml(file.fileUrl) + "#toolbar=0&navpanes=0&scrollbar=0&view=FitH"
    : "";
  return '<article class="doc-tile" data-file-id="' + escapeHtml(file.id) + '">'
    + '<div class="doc-preview" role="button" tabindex="0"'
    + ' data-file-url="' + escapeHtml(file.fileUrl) + '" aria-label="Open ' + escapeHtml(file.name) + '">'
    // An <object type="application/pdf"> renders page one of a PDF natively but
    // shows nothing for a photo, so images get a real <img>. HEIC lands here
    // too and will fail to decode — onerror leaves the placeholder rather than
    // a broken-image icon.
    + (!file.fileUrl
      ? '<div class="doc-preview-fallback">📄</div>'
      : isImageFile(file)
        ? '<img class="doc-preview-img" src="' + escapeHtml(file.fileUrl) + '" alt=""'
          + ' loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),'
          + '{className:\'doc-preview-fallback\',textContent:\'🖼\'}))" />'
        : '<object class="doc-preview-frame" data="' + previewUrl + '" type="application/pdf">'
          + '<div class="doc-preview-fallback">📄</div></object>')
    + '<span class="doc-preview-veil"></span>'
    + '</div>'
    + '<div class="doc-foot">'
    + '<p class="doc-name" title="' + escapeHtml(file.name) + '">' + escapeHtml(file.name) + '</p>'
    + '<p class="doc-meta">'
    + (contact ? escapeHtml(contact.name) : '<span class="muted">Not linked</span>')
    + (dateStr ? ' · ' + dateStr : '')
    + '</p>'
    + '<div class="doc-actions">'
    + '<button class="doc-act doc-rename" type="button" data-file-id="' + escapeHtml(file.id) + '"'
    + ' data-file-name="' + escapeHtml(file.name) + '" title="Rename">Rename</button>'
    + '<button class="doc-act doc-open" type="button" data-file-url="' + escapeHtml(file.fileUrl) + '" title="Open">Open</button>'
    + '<button class="doc-act doc-delete" type="button" data-file-id="' + escapeHtml(file.id) + '"'
    + ' data-storage-path="' + escapeHtml(file.storagePath) + '" title="Delete">✕</button>'
    + '</div>'
    + '</div>'
    + '</article>';
}

function attachStorageFileCardListeners(container, onChange) {
  const open = (url) => { if (url) window.open(url, "_blank"); };

  container.querySelectorAll(".doc-preview").forEach((el) => {
    el.addEventListener("click", () => open(el.dataset.fileUrl));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(el.dataset.fileUrl); }
    });
  });
  container.querySelectorAll(".doc-open").forEach((btn) => {
    btn.addEventListener("click", () => open(btn.dataset.fileUrl));
  });

  container.querySelectorAll(".doc-rename").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tile = btn.closest(".doc-tile");
      const nameEl = tile.querySelector(".doc-name");
      if (tile.querySelector(".doc-rename-input")) return;

      const input = document.createElement("input");
      input.type = "text";
      input.className = "doc-rename-input";
      input.value = btn.dataset.fileName;
      input.setAttribute("aria-label", "File name");
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      let settled = false;
      const finish = async (save) => {
        if (settled) return;
        settled = true;
        const next = input.value.trim();
        if (save && next && next !== btn.dataset.fileName) {
          const updated = await db.renameStorageFile(btn.dataset.fileId, next);
          if (updated && onChange) { await onChange(); return; }
        }
        input.replaceWith(nameEl);
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
      input.addEventListener("blur", () => finish(true));
    });
  });

  container.querySelectorAll(".doc-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!window.confirm("Delete this file? This cannot be undone.")) return;
      await db.deleteStorageFile(btn.dataset.fileId, btn.dataset.storagePath);
      if (onChange) await onChange();
    });
  });
}

/**
 * Each conversation is a <details> so it can be opened and closed.
 *
 * @param files  The contact's storage files, so attachments can be resolved from
 *               the ids on each interaction (ORB-20). Ids with no matching file
 *               are skipped — deleting a PDF from the Files page should leave the
 *               conversation intact, not a broken link.
 */
function renderInteractionTimeline(interactions, files = []) {
  if (!interactions || !interactions.length) return '<p class="empty">No conversations logged yet.</p>';
  const byId = new Map(files.map((f) => [f.id, f]));

  return interactions.map((item, i) => {
    const attached = (item.fileIds || []).map((id) => byId.get(id)).filter(Boolean);

    const summary = '<summary class="convo-summary">'
      + '<span class="convo-caret" aria-hidden="true">▸</span>'
      + '<span class="convo-date">' + formatDate(item.date) + '</span>'
      + '<span class="tag">' + escapeHtml(item.type) + '</span>'
      // Flagged on the summary too, because a collapsed conversation would
      // otherwise hide the fact that anything is attached to it.
      + (attached.length
        ? '<span class="convo-clip" title="' + attached.length + ' attached">📎 ' + attached.length + '</span>'
        : '')
      + (item.notes ? '' : '<span class="tiny muted">no notes</span>')
      + '</summary>';

    // Every conversation is editable. Before this, a saved conversation was
    // sealed — which mattered most for calendar-synced ones, whose notes start
    // as nothing but the event title and could never be filled in.
    const body = '<div class="convo-body" data-convo-id="' + escapeHtml(item.id) + '">'
      + (item.notes
        ? '<p class="convo-note">' + escapeHtml(item.notes) + '</p>'
        : '<p class="convo-note muted">No notes yet — what did you talk about?</p>')
      + '<button class="convo-edit" type="button" data-edit-convo="' + escapeHtml(item.id) + '">'
      + (item.notes ? 'Edit notes' : 'Add notes') + '</button>'
      + '</div>';

    const attachments = attached.length
      ? '<ul class="convo-files">'
        + attached.map((f) => '<li><a class="convo-file" href="' + escapeHtml(f.fileUrl) + '"'
          + ' target="_blank" rel="noopener noreferrer">'
          + '<span class="convo-file-icon" aria-hidden="true">📄</span>'
          + '<span class="convo-file-name">' + escapeHtml(f.name) + '</span></a></li>').join("")
        + '</ul>'
      : '';

    // Newest conversation starts open; the rest stay collapsed.
    return '<details class="convo"' + (i === 0 ? " open" : "") + '>'
      + summary + body + attachments + '</details>';
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

// ── Filter bar ────────────────────────────────────────────────────────────────
// Search field + funnel button that opens a card of filters. Shared by My
// Network, the Networking Log and Files so all three behave identically.

/**
 * @param opts.placeholder  search input placeholder
 * @param opts.filters      [{ key, label, options:[{value,label}] }]
 */
function filterBarHtml({ placeholder, filters }) {
  return '<div class="filter-bar">'
    + '<input type="search" class="fb-search" placeholder="' + escapeHtml(placeholder) + '"'
    + ' aria-label="' + escapeHtml(placeholder) + '" />'
    + '<div class="fb-anchor">'
    + '<button class="fb-toggle" type="button" aria-expanded="false" aria-haspopup="dialog" title="Filters">'
    + '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
    + '<line x1="2" y1="4" x2="14" y2="4" /><line x1="4" y1="8" x2="12" y2="8" />'
    + '<line x1="6" y1="12" x2="10" y2="12" /></svg>'
    + '<span class="visually-hidden">Filters</span>'
    + '<span class="fb-badge" hidden></span>'
    + '</button>'
    + '<div class="fb-pop" role="dialog" aria-label="Filters" hidden>'
    + '<div class="fb-pop-head"><h3>Filters</h3>'
    + '<button class="icon-btn fb-close" type="button" aria-label="Close">✕</button></div>'
    + filters.map((f) =>
        '<div class="field-group"><label for="fb-' + f.key + '">' + escapeHtml(f.label) + '</label>'
        + '<select id="fb-' + f.key + '" data-filter-key="' + f.key + '">'
        + f.options.map((o) => '<option value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</option>').join("")
        + '</select></div>').join("")
    + '<button class="btn btn-secondary btn-sm fb-clear" type="button">Clear all</button>'
    + '</div>'
    + '</div>'
    + '<span class="fb-count"></span>'
    + '</div>';
}

/**
 * Wires a filter bar. `onChange` receives { q, <filterKey>: value, … }.
 * Returns { setOptions, setCount, values } for the host page to drive.
 */
function wireFilterBar(root, onChange) {
  const bar = root.querySelector(".filter-bar");
  if (!bar) return null;

  const search = bar.querySelector(".fb-search");
  const toggle = bar.querySelector(".fb-toggle");
  const pop = bar.querySelector(".fb-pop");
  const badge = bar.querySelector(".fb-badge");
  const countEl = bar.querySelector(".fb-count");
  const selects = [...bar.querySelectorAll("[data-filter-key]")];

  const values = () => {
    const out = { q: search.value.trim().toLowerCase() };
    selects.forEach((s) => { out[s.dataset.filterKey] = s.value; });
    return out;
  };

  const refreshBadge = () => {
    const active = selects.filter((s) => s.value).length;
    badge.hidden = active === 0;
    badge.textContent = String(active);
    toggle.classList.toggle("fb-active", active > 0);
  };

  const setOpen = (open) => {
    pop.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(pop.hidden);
  });
  bar.querySelector(".fb-close").addEventListener("click", () => setOpen(false));
  pop.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

  const fire = () => { refreshBadge(); onChange(values()); };
  search.addEventListener("input", fire);
  selects.forEach((s) => s.addEventListener("change", fire));
  bar.querySelector(".fb-clear").addEventListener("click", () => {
    selects.forEach((s) => { s.value = ""; });
    fire();
  });

  return {
    values,
    setCount(text) { countEl.textContent = text; },
    /** Populate a select's options from the data, keeping the current choice. */
    setOptions(key, options) {
      const sel = selects.find((s) => s.dataset.filterKey === key);
      if (!sel) return;
      const keep = sel.value;
      const first = sel.options[0];
      sel.innerHTML = "";
      sel.appendChild(first);
      options.forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o;
        opt.textContent = o;
        sel.appendChild(opt);
      });
      sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
      refreshBadge();
    }
  };
}

// ── Capture widget ────────────────────────────────────────────────────────────
// One form, used inline on the Networking Log and inside the dashboard modal.
// Fields use classes, not ids, so two copies can coexist on a page.

// ── Conversation widget ───────────────────────────────────────────────────────
/**
 * The conversation logger.
 *
 * One form for both jobs: if the name matches someone you already know, pick
 * them from the dropdown and their details fill themselves in — all you write
 * is the conversation. If they are new, you fill the details once and the first
 * conversation is logged with them.
 *
 * Fields are addressed by class, not id, so the inline copy on the Networking
 * Log and the copy inside the quick-add modal can coexist on one page.
 */
function conversationWidgetHtml() {
  const freqOptions = Object.entries(FREQUENCY_LABELS)
    .map(([v, l]) => '<option value="' + v + '"' + (v === "monthly" ? " selected" : "") + '>' + l + '</option>')
    .join("");

  return '<form class="cw-form" autocomplete="off">'

    // ── Who ──────────────────────────────────────────────────────────────
    + '<div class="cw-person">'
    + '<div class="cw-grid">'
    + '<div class="field-group cw-name-field">'
    + '<label>Who did you speak with? <span class="required">*</span></label>'
    + '<div class="combo">'
    + '<input type="text" class="cw-name" placeholder="Start typing a name…" required'
    + ' role="combobox" aria-autocomplete="list" aria-expanded="false" />'
    + '<ul class="combo-list" role="listbox" hidden></ul>'
    + '</div>'
    + '</div>'
    + '<div class="field-group"><label>Role / Title</label>'
    + '<input type="text" class="cw-role" placeholder="Product Manager" /></div>'
    + '<div class="field-group"><label>Company</label>'
    + '<input type="text" class="cw-company" placeholder="Where they work" /></div>'
    + '<div class="field-group"><label>Email</label>'
    + '<input type="email" class="cw-email" placeholder="email@example.com" /></div>'
    + '<div class="field-group"><label>Reach out again?</label>'
    + '<select class="cw-freq">' + freqOptions
    + '<option value="custom">Custom…</option></select>'
    + '<div class="cw-custom hidden">'
    + '<input type="number" class="cw-custom-days" min="1" max="365" placeholder="45" aria-label="Every how many days" />'
    + '<span class="cw-custom-unit">days</span>'
    + '</div></div>'
    + '</div>'
    + '<p class="cw-linked hidden">'
    + '<span class="cw-linked-text"></span>'
    + '<button type="button" class="cw-unlink">Not them — start a new person</button>'
    + '</p>'
    + '</div>'

    // ── The conversation ─────────────────────────────────────────────────
    + '<div class="cw-convo">'
    + '<div class="cw-convo-head">'
    + '<div class="field-group"><label>When</label>'
    + '<input type="date" class="cw-date" required /></div>'
    + '<div class="field-group"><label>Type</label>'
    + '<select class="cw-type">'
    + INTERACTION_TYPES.map((t) => '<option value="' + t + '">' + t.charAt(0).toUpperCase() + t.slice(1) + '</option>').join("")
    + '</select></div>'
    + '</div>'
    + '<div class="field-group"><label>What did you talk about?</label>'
    + '<textarea class="cw-notes" rows="5" placeholder="What they are working on, what they said, anything you want to bring up next time…"></textarea></div>'
    + '<div class="field-group"><label>Attach a PDF <span class="opt-label">(optional)</span></label>'
    + '<input type="file" class="cw-file" accept="' + ATTACH_ACCEPT + '" /></div>'
    + '</div>'

    + '<p class="error cw-error" aria-live="polite"></p>'
    + '<p class="success cw-success" aria-live="polite"></p>'
    + '<button type="submit" class="btn cw-submit">Save conversation</button>'
    + '</form>';
}

/**
 * @param getContacts  () => contacts, read fresh so the dropdown stays current
 * @param onSaved      called after a successful save
 */
function wireConversationWidget(root, getContacts, onSaved) {
  const form = root.querySelector(".cw-form");
  if (!form) return;

  const $ = (sel) => form.querySelector(sel);
  const nameEl = $(".cw-name");
  const listEl = $(".combo-list");
  const linkedEl = $(".cw-linked");
  const freqEl = $(".cw-freq");
  const customWrap = $(".cw-custom");
  const dateEl = $(".cw-date");

  if (dateEl && !dateEl.value) dateEl.value = todayDateString();

  let linkedId = null;   // set once an existing contact is chosen
  let active = -1;       // highlighted row in the dropdown

  freqEl.addEventListener("change", () => {
    customWrap.classList.toggle("hidden", freqEl.value !== "custom");
    if (freqEl.value === "custom") $(".cw-custom-days").focus();
  });

  // ── Autocomplete ─────────────────────────────────────────────────────
  const closeList = () => {
    listEl.hidden = true;
    listEl.innerHTML = "";
    active = -1;
    nameEl.setAttribute("aria-expanded", "false");
  };

  const setLinked = (contact) => {
    linkedId = contact ? contact.id : null;
    linkedEl.classList.toggle("hidden", !contact);
    if (contact) {
      linkedEl.querySelector(".cw-linked-text").textContent =
        "Adding to " + contact.name + "'s history — " +
        (contact.interactions?.length || 0) + " conversation" +
        ((contact.interactions?.length || 0) === 1 ? "" : "s") + " so far.";
    }
    // Details of a known person are theirs to correct, not to re-enter.
    [".cw-role", ".cw-company", ".cw-email"].forEach((sel) =>
      form.querySelector(sel).classList.toggle("cw-prefilled", Boolean(contact)));
  };

  const choose = (contact) => {
    nameEl.value = contact.name;
    $(".cw-role").value = contact.role || "";
    $(".cw-company").value = contact.company || "";
    $(".cw-email").value = contact.email || "";

    // Mirror their existing cadence so saving does not silently change it.
    const freq = contact.followUpFrequency || "none";
    if (freq.startsWith("custom:")) {
      freqEl.value = "custom";
      customWrap.classList.remove("hidden");
      $(".cw-custom-days").value = freq.slice(7);
    } else {
      freqEl.value = freq;
      customWrap.classList.add("hidden");
    }

    setLinked(contact);
    closeList();
    $(".cw-notes").focus();
  };

  const renderList = () => {
    const q = nameEl.value.trim().toLowerCase();
    if (!q) return closeList();

    const matches = (getContacts() || [])
      .filter((c) => c.name && c.name.toLowerCase().includes(q))
      .slice(0, 6);

    if (!matches.length) return closeList();

    listEl.innerHTML = matches.map((c, i) =>
      '<li class="combo-item" role="option" data-id="' + escapeHtml(c.id) + '"'
      + (i === active ? ' aria-selected="true"' : '') + '>'
      + '<span class="combo-avatar" aria-hidden="true">' + escapeHtml(initialsFor(c.name)) + '</span>'
      + '<span class="combo-main">'
      + '<span class="combo-name">' + escapeHtml(c.name) + '</span>'
      + '<span class="combo-sub">' + escapeHtml(c.role || "Role not set")
      + (c.company ? " @ " + escapeHtml(c.company) : "") + '</span>'
      + '</span>'
      + '<span class="combo-last">' + escapeHtml(relativeDayLabel(c.lastContacted)) + '</span>'
      + '</li>').join("");
    listEl.hidden = false;
    nameEl.setAttribute("aria-expanded", "true");

    listEl.querySelectorAll(".combo-item").forEach((li) => {
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();               // keep focus off the blur handler
        const match = (getContacts() || []).find((c) => c.id === li.dataset.id);
        if (match) choose(match);
      });
    });
  };

  nameEl.addEventListener("input", () => {
    // Typing a different name means you are no longer editing that person.
    if (linkedId) {
      const linked = (getContacts() || []).find((c) => c.id === linkedId);
      if (!linked || linked.name !== nameEl.value) setLinked(null);
    }
    renderList();
  });

  nameEl.addEventListener("keydown", (e) => {
    const items = [...listEl.querySelectorAll(".combo-item")];
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = e.key === "ArrowDown"
        ? Math.min(active + 1, items.length - 1)
        : Math.max(active - 1, 0);
      items.forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
      items[active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const match = (getContacts() || []).find((c) => c.id === items[active].dataset.id);
      if (match) choose(match);
    } else if (e.key === "Escape") {
      closeList();
    }
  });

  nameEl.addEventListener("blur", () => setTimeout(closeList, 120));
  form.querySelector(".cw-unlink").addEventListener("click", () => {
    setLinked(null);
    nameEl.focus();
  });

  // ── Save ─────────────────────────────────────────────────────────────
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const errEl = $(".cw-error");
    const okEl = $(".cw-success");
    const submitBtn = $(".cw-submit");
    errEl.textContent = "";
    okEl.textContent = "";

    const name = nameEl.value.trim();
    if (!name) { errEl.textContent = "Who did you speak with?"; return; }

    const when = dateEl.value || todayDateString();
    let frequency = freqEl.value || "none";
    if (frequency === "custom") {
      const days = parseInt($(".cw-custom-days").value, 10);
      if (Number.isNaN(days) || days < 1) {
        errEl.textContent = "Enter how many days between reach-outs.";
        return;
      }
      frequency = "custom:" + days;
    }

    const notes = $(".cw-notes").value.trim();

    const docFile = $(".cw-file")?.files?.[0] || null;
    if (docFile && !isAllowedAttachment(docFile)) {
      errEl.textContent = ATTACH_REJECT_MSG;
      return;
    }

    const interaction = normalizeInteraction({ date: when, type: $(".cw-type").value, notes });

    const existing = linkedId ? (getContacts() || []).find((c) => c.id === linkedId) : null;

    // A brand-new person has no id until the contact is saved, so the upload
    // cannot come first the way it does on the profile page. Saving first also
    // means a storage failure costs the attachment, never the conversation.
    if (docFile && existing) {
      const uploaded = await db.uploadFileToStorage(docFile, { contactId: existing.id });
      if (uploaded) interaction.fileIds = [uploaded.id];
    }

    const base = existing || {};
    const merged = [interaction, ...(existing?.interactions || [])]
      .sort((a, b) => b.date.localeCompare(a.date));
    const wasOff = !existing || !existing.reminderEnabled || existing.followUpFrequency === "none";

    const contact = normalizeContact({
      ...base,
      name,
      role: $(".cw-role").value,
      company: $(".cw-company").value,
      email: $(".cw-email").value,
      dateMet: existing?.dateMet || when,
      interactions: merged,
      lastContacted: merged[0].date,
      followUpFrequency: frequency,
      reminderEnabled: frequency !== "none",
      // A conversation puts the relationship on its normal rhythm. The grace
      // window only applies when a cadence is switched on without one.
      nextReminder: frequency === "none" ? ""
        : (notes || !wasOff)
          ? calculateNextReminder(merged[0].date, frequency)
          : firstDeadlineFor(merged[0].date, frequency)
    });

    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    const saved = await db.saveContact(contact);
    submitBtn.disabled = false;
    submitBtn.textContent = "Save conversation";

    if (!saved) {
      errEl.textContent = "Could not save. Open the console (F12) for the Supabase error.";
      return;
    }

    // The new-person case: the id only exists now, so upload and then link the
    // attachment onto the interaction in a second write.
    let result = saved;
    let attachmentFailed = Boolean(docFile) && !interaction.fileIds.length && Boolean(existing);
    if (docFile && !existing) {
      const uploaded = await db.uploadFileToStorage(docFile, { contactId: saved.id });
      if (uploaded) {
        const relinked = normalizeContact({
          ...saved,
          interactions: (saved.interactions || []).map((i) =>
            i.id === interaction.id ? { ...i, fileIds: [uploaded.id] } : i)
        });
        const patched = await db.saveContact(relinked);
        if (patched) result = patched;
        else attachmentFailed = true;
      } else {
        attachmentFailed = true;
      }
    }

    form.reset();
    dateEl.value = todayDateString();
    customWrap.classList.add("hidden");
    setLinked(null);
    const confirmation = (existing
      ? "Conversation added to " + name + "."
      : name + " added, with your first conversation.")
      + (attachmentFailed ? " The PDF could not be attached." : "");
    okEl.textContent = confirmation;
    setTimeout(() => { okEl.textContent = ""; }, 3500);
    // Callers that destroy this form on save need the confirmation to outlive it.
    if (onSaved) await onSaved(result, { name, confirmation, isNew: !existing });
  });
}

function openQuickAddModal(contacts, onSaved) {
  document.getElementById("quickAddModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "quickAddModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card quick-add-card">'
    + '<div class="quick-add-header">'
    + '<h3>Log a conversation</h3>'
    + '<button class="icon-btn" id="quickAddClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + conversationWidgetHtml()
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#quickAddClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape" && !modal.querySelector(".combo-list:not([hidden])")) {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });

  // ORB-14: this modal used to print its confirmation into itself and then
  // remove itself 1.1s later, so the only feedback in the app was destroyed with
  // the DOM. Neither page that carries the + button lists conversations either,
  // so saving looked like nothing happened. Close first, then confirm outside —
  // and point at the one page that does show the thing you just wrote.
  wireConversationWidget(modal, () => contacts, async (saved, meta = {}) => {
    close();
    if (onSaved) await onSaved(saved);
    showToast(meta.confirmation || "Conversation saved.", {
      actionLabel: "View in log",
      href: "network.html",
      duration: 7000
    });
  });
  modal.querySelector(".cw-name")?.focus();
}

function initQuickAddButton(getContacts, onSaved) {
  const btn = document.getElementById("quickAddBtn");
  if (!btn) return;
  btn.addEventListener("click", () => openQuickAddModal(getContacts(), onSaved));
}

// ── Toast ─────────────────────────────────────────────────────────────────────

/**
 * A confirmation that outlives whatever created it.
 *
 * Two things need this. Logging a conversation used to print "Conversation added
 * to Marcus" inside a modal that deleted itself 1.1s later, so the only feedback
 * in the app went with it (ORB-14). And one-click "Reached out" (ORB-13) is only
 * safe to make one click if the mistake is cheap to take back, which needs a
 * place to put Undo.
 *
 * @param {string} message  Plain text. Name the person — "Logged" alone does not
 *                          tell you the right row was hit.
 * @param {object} [opts]
 * @param {string} [opts.actionLabel]  Text for the trailing button
 * @param {string} [opts.href]         Makes the action a link instead of a button
 * @param {Function} [opts.onAction]   Handler; the toast closes after it resolves
 * @param {number} [opts.duration]     ms before auto-dismiss. Undo gets longer.
 * @returns {{dismiss: Function}}
 */
function showToast(message, opts = {}) {
  const { actionLabel = "", href = "", onAction = null, duration = 5000 } = opts;

  let stack = document.querySelector(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    // Polite, not assertive: this confirms something the user just did on
    // purpose. It should not interrupt whatever they are reading now.
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  // One at a time. A queue of stale confirmations is noise, not reassurance.
  stack.replaceChildren();

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = '<span class="toast-text">' + escapeHtml(message) + '</span>'
    + (actionLabel
      ? (href
        ? '<a class="toast-action" href="' + escapeHtml(href) + '">' + escapeHtml(actionLabel) + '</a>'
        : '<button class="toast-action" type="button">' + escapeHtml(actionLabel) + '</button>')
      : '')
    + '<button class="toast-close" type="button" aria-label="Dismiss">✕</button>';
  stack.appendChild(toast);

  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    toast.remove();
    if (!stack.childElementCount) stack.remove();
  };
  timer = setTimeout(dismiss, duration);

  toast.querySelector(".toast-close").addEventListener("click", dismiss);
  if (onAction) {
    toast.querySelector(".toast-action")?.addEventListener("click", async () => {
      clearTimeout(timer);
      await onAction();
      dismiss();
    });
  }
  // Hovering means they are reading it or reaching for Undo. Do not yank it away.
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, 2500); });

  return { dismiss };
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
    + '<h3>Draft a message to <strong>' + escapeHtml(contact.name) + '</strong></h3>'
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
    + '<div class="modal-draft-actions">'
    + '<button class="btn btn-secondary" id="modalCopyEmail" type="button">Copy</button>'
    + (contact.email
      ? '<button class="btn btn-secondary" id="modalMailto" type="button">Open in email</button>'
      : '')
    + '</div>'
    + '<p id="modalCopyMsg" class="success" aria-live="polite"></p>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const finish = async () => { modal.remove(); if (onChanged) await onChanged(); };

  // Same helper the one-click row button uses, so marking it done confirms and
  // offers undo wherever you do it from.
  modal.querySelector("#modalMarkDone").addEventListener("click", async () => {
    modal.remove();
    await markReachedOut(contact, onChanged);
  });
  modal.querySelector("#modalLater").addEventListener("click", async () => {
    const saved = await db.saveContact(normalizeContact({
      ...contact,
      nextReminder: new Date(Date.now() + 3 * 86400000).toISOString()
    }));
    if (saved) showToast("Snoozed — " + contact.name + " comes back in 3 days.");
    else showToast("Could not save that — " + contact.name + " is unchanged.");
    await finish();
  });
  modal.querySelector("#modalTurnOff").addEventListener("click", async () => {
    const saved = await db.saveContact(normalizeContact({
      ...contact, reminderEnabled: false, followUpFrequency: "none"
    }));
    if (!saved) { showToast("Could not save that — " + contact.name + " is unchanged."); return; }
    showToast("Schedule removed for " + contact.name + ".", {
      actionLabel: "Undo",
      duration: 8000,
      onAction: async () => {
        await db.saveContact(normalizeContact({ ...contact }));
        if (onChanged) await onChanged();
      }
    });
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
  // Hands the draft to whatever email client the OS has. Orbit runs entirely in
  // the browser, so it cannot send mail itself — this is the closest it gets.
  modal.querySelector("#modalMailto")?.addEventListener("click", () => {
    const [subjectLine, ...bodyLines] = emailText.split("\n");
    const subject = subjectLine.replace(/^Subject:\s*/i, "");
    const body = bodyLines.join("\n").replace(/^\n+/, "");
    window.location.href = "mailto:" + encodeURIComponent(contact.email)
      + "?subject=" + encodeURIComponent(subject)
      + "&body=" + encodeURIComponent(body);
  });

  modal.querySelector("#modalClose").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

// ── Marking a reach-out done ──────────────────────────────────────────────────

/**
 * Roll the cadence forward because the user says they reached out.
 *
 * This is one gesture, so it is one click (ORB-13). The old flow made you press
 * "Reach out" — a future-tense label — to report something already done, then
 * press "I reached out" in a modal: two clicks and a dialog, with the label
 * pointing the wrong way in time.
 *
 * It deliberately does NOT capture notes. The open question "do users have notes
 * worth capturing, or do they just want the row gone?" was answered *row gone*,
 * so the fast path stays fast; the conversation logger is still there for the
 * times there is something to write down.
 *
 * Undo is what makes one click safe, so a failed save must not silently look
 * like a success.
 */
async function markReachedOut(contact, onChanged) {
  const restore = {
    lastContacted: contact.lastContacted,
    nextReminder: contact.nextReminder
  };
  const today = todayDateString();
  const saved = await db.saveContact(normalizeContact({
    ...contact,
    lastContacted: today,
    nextReminder: calculateNextReminder(today, contact.followUpFrequency)
  }));

  if (!saved) {
    showToast("Could not save that — " + contact.name + " is unchanged.");
    return false;
  }

  showToast("Marked as reached out — " + contact.name + ".", {
    actionLabel: "Undo",
    duration: 8000,
    onAction: async () => {
      await db.saveContact(normalizeContact({ ...contact, ...restore }));
      if (onChanged) await onChanged();
    }
  });
  if (onChanged) await onChanged();
  return true;
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
    // Past tense, one click, because this reports something already done.
    // The draft/snooze/remove-schedule options keep their modal, demoted to the
    // icon beside it — they are the rare path, not the common one.
    + (showReconnect && health.scheduled
      ? '<div class="row-actions">'
        + '<button class="btn btn-sm" type="button" data-did-reach-out="'
          + escapeHtml(contact.id) + '">✓ Reached out</button>'
        + '<button class="btn btn-secondary btn-sm row-draft" type="button" data-remind-contact="'
          + escapeHtml(contact.id) + '"'
          + ' aria-label="Draft a message to ' + escapeHtml(contact.name) + '">Draft</button>'
        + '</div>'
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
  root.querySelectorAll("[data-did-reach-out]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const contact = contacts.find((c) => c.id === btn.dataset.didReachOut);
      if (!contact) return;
      btn.disabled = true;
      // onChanged re-renders and replaces this button, so nothing needs to
      // re-enable it. The toast lives on document.body and survives that.
      await markReachedOut(contact, onChanged);
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
    // Denominators are the people you actually put on a cadence — those are the
    // only ones these three states can apply to. Contacts with no cadence are
    // not "failing", they are simply not being measured.
    const healthPct = scheduled ? Math.round((counts.good / scheduled) * 100) : 0;
    const attention = needsAttention(contacts);

    // With nothing scheduled the tiles would all read 0/0, which says nothing.
    const kpiHtml = scheduled
      ? '<div class="kpi-row">'
        + kpiTile("good", "In touch", counts.good, scheduled, "on cadence and current")
        + kpiTile("warning", "Reach out soon", counts.warning, scheduled, "window closing")
        + kpiTile("critical", "Overdue", counts.critical, scheduled, "past due")
        + '</div>'
      : '<div class="card kpi-empty">'
        + '<p class="kpi-empty-title">No cadences set yet</p>'
        + '<p class="muted">You have ' + total + ' ' + (total === 1 ? "connection" : "connections") + '. '
        + 'Open someone in <a href="contacts.html">My Network</a> and choose how often to reach out — '
        + 'they will start showing up here.</p>'
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

    const chartsHtml = scheduled
      ? '<div class="chart-row">'
        + chartCard("Network health", "Of those on a cadence, how many are current",
            ringHtml({ pct: healthPct,
                       band: healthPct >= 60 ? "good" : healthPct >= 25 ? "warning" : "critical",
                       caption: "In touch", sub: counts.good + " of " + scheduled }))
        + chartCard("Breakdown", "Where your scheduled connections stand",
            splitBarHtml(counts), "chart-card-wide")
        + '</div>'
      : "";

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
  // Lets the calendar review modal refresh whatever page it was opened from,
  // so newly logged meetings appear without a reload (ORB-15).
  window.__orbitRefresh = render;
  initQuickAddButton(() => cached, render);
}

// ── My Network ────────────────────────────────────────────────────────────────

async function initMyNetwork() {
  const list = document.getElementById("myNetworkList");
  const barRoot = document.getElementById("networkFilterBar");
  if (!list || !barRoot) return;

  barRoot.innerHTML = filterBarHtml({
    placeholder: "Search name, role, company, industry…",
    filters: [
      STATUS_FILTER,
      CADENCE_FILTER,
      SILENCE_FILTER,
      { key: "industry", label: "Industry", options: [{ value: "", label: "All industries" }] }
    ]
  });

  let cached = [];
  const bar = wireFilterBar(barRoot, render);

  async function load() {
    cached = (await db.getContacts()) || [];
    bar.setOptions("industry", [...new Set(cached.map((c) => c.industry).filter(Boolean))].sort());
    render();
  }

  function render() {
    const values = bar.values();
    const { q, industry } = values;

    const people = cached.filter((c) => {
      if (industry && c.industry !== industry) return false;
      if (!matchesConnectionFilters(c, values)) return false;
      if (!q) return true;
      return [c.name, c.role, c.company, c.industry, c.notes]
        .some((f) => f && f.toLowerCase().includes(q));
    });

    // Alphabetical by first name, with a letter header starting each run.
    people.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    bar.setCount(people.length === cached.length
      ? `${cached.length} ${cached.length === 1 ? "person" : "people"}`
      : `${people.length} of ${cached.length}`);

    if (!people.length) {
      list.innerHTML = '<li class="empty">'
        + (cached.length ? "Nobody matches those filters." : "Nobody in your network yet.")
        + '</li>';
      return;
    }

    let html = "";
    let currentLetter = "";
    for (const c of people) {
      const first = (c.name || "?").trim()[0] || "#";
      const letter = /[a-z]/i.test(first) ? first.toUpperCase() : "#";
      if (letter !== currentLetter) {
        currentLetter = letter;
        html += '<li class="alpha-header"><span>' + escapeHtml(letter) + '</span></li>';
      }
      html += personRowHtml(c, getHealth(c), { showReconnect: true });
    }
    list.innerHTML = html;
    wirePersonRows(list, cached, load);
  }

  await load();
  window.__orbitRefresh = load;
  initQuickAddButton(() => cached, load);
}

// ── Networking Log ────────────────────────────────────────────────────────────

async function initNetworkingLog() {
  const widgetRoot = document.getElementById("contactWidget");
  const list = document.getElementById("connectionList");
  if (!widgetRoot || !list) return;

  const barRoot = document.getElementById("logFilterBar");
  if (!barRoot) return;

  barRoot.innerHTML = filterBarHtml({
    placeholder: "Search name, role, company, notes…",
    filters: [
      STATUS_FILTER,
      CADENCE_FILTER,
      SILENCE_FILTER,
      { key: "industry", label: "Industry", options: [{ value: "", label: "All industries" }] },
      { key: "sort", label: "Sort by", options: [
        { value: "", label: "Most recent first" },
        { value: "oldest", label: "Oldest first" },
        { value: "name", label: "Name A–Z" }
      ] }
    ]
  });

  let cached = [];
  const bar = wireFilterBar(barRoot, renderList);

  async function reload() {
    try {
      cached = (await db.getContacts()) || [];
    } catch {
      list.innerHTML = '<li class="empty" style="color:var(--danger)">Error loading connections — check the console (F12).</li>';
      return;
    }
    bar.setOptions("industry", [...new Set(cached.map((c) => c.industry).filter(Boolean))].sort());
    renderList();
  }

  function renderList() {
    const values = bar.values();
    const { q: filterText, industry, sort } = values;

    let contacts = cached.filter((c) => {
      if (industry && c.industry !== industry) return false;
      if (!matchesConnectionFilters(c, values)) return false;
      if (!filterText) return true;
      return [c.name, c.role, c.company, c.industry, c.notes]
        .some((f) => f && f.toLowerCase().includes(filterText));
    });

    bar.setCount(contacts.length === cached.length
      ? `${cached.length} ${cached.length === 1 ? "entry" : "entries"}`
      : `${contacts.length} of ${cached.length}`);

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
      + conversationPreview(contact)
      + '</div>'
      + '</li>';
  }

  widgetRoot.innerHTML = conversationWidgetHtml();
  wireConversationWidget(widgetRoot, () => cached, reload);

  await reload();
  window.__orbitRefresh = reload;
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
    // Needed to resolve the ids each interaction carries into real attachments.
    const files = await db.fetchStorageFilesByContact(contactId);

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
          sub: !health.scheduled ? "Reach out again?"
            : health.daysLeft < 0 ? Math.abs(health.daysLeft) + " days over"
            : health.grace ? health.daysLeft + " days to first reach-out"
            : health.daysLeft + " days left"
        })
      + '</div>'
      + '<dl class="reachout-meta">'
      + '<div><dt>Last connected</dt><dd>' + escapeHtml(relativeDayLabel(c.lastContacted)) + '</dd></div>'
      + '<div><dt>' + (health.grace ? "Reach out by" : "Next nudge") + '</dt>'
      + '<dd>' + (c.nextReminder ? formatDate(c.nextReminder.split("T")[0]) : "—") + '</dd></div>'
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
      // Same one-click gesture as the dashboard rows (ORB-13), so the habit
      // learned there still works here. Only meaningful on a cadence.
      + (health.scheduled
        ? '<button class="btn btn-secondary" id="cpMarkDoneBtn" type="button">✓ Reached out</button>'
        : '')
      + '<button class="btn btn-secondary" id="cpOpenReminderBtn" type="button">Draft a message</button>'
      + '</div>'
      + '<p id="cpSaveReminderMsg" class="success" aria-live="polite"></p>'
      + '</div>'
      + (health.grace
        ? '<p class="grace-note">You have ' + GRACE_DAYS + ' days from setting this schedule to '
          + 'make the first reach-out. After that the normal cadence takes over.</p>'
        : '')
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
      + '<input type="file" id="cpIntDocInput" accept="' + ATTACH_ACCEPT + '" /></div>'
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
      + '<div class="timeline">' + renderInteractionTimeline(c.interactions, files) + '</div>'
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
      await save((cur) => {
        const wasOff = !cur.reminderEnabled || cur.followUpFrequency === "none";
        const anchor = cur.lastContacted || cur.dateMet;
        return {
          ...cur,
          followUpFrequency: newFreq,
          reminderEnabled: newFreq !== "none",
          // Switching a schedule ON grants the one-week grace window if the
          // cadence alone would already be blown. Editing an existing cadence
          // keeps the normal deadline — the grace is not re-granted.
          nextReminder: newFreq === "none" ? ""
            : wasOff ? firstDeadlineFor(anchor, newFreq)
                     : calculateNextReminder(anchor, newFreq)
        };
      });
      const msg = $("#cpSaveReminderMsg");
      msg.textContent = "Schedule saved!";
      setTimeout(() => { msg.textContent = ""; }, 2000);
      await renderPage();
    });

    // currentTarget is nulled once dispatch ends, so grab the button before the
    // first await, not after.
    $("#cpMarkDoneBtn")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const fresh = await freshContact();
      if (!fresh) { btn.disabled = false; return; }
      await markReachedOut(fresh, renderPage);
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
      if (docFile && !isAllowedAttachment(docFile)) {
        errEl.textContent = ATTACH_REJECT_MSG; return;
      }

      const interaction = normalizeInteraction({
        date, type: $("#cpIntType").value, notes: $("#cpIntNotes").value.trim()
      });

      // Upload before saving so the interaction carries the id from the start.
      // The contact id is already known here, so this needs only one write.
      // A failed upload must not cost the user the conversation.
      let attachmentFailed = false;
      if (docFile) {
        const uploaded = await db.uploadFileToStorage(docFile, { contactId });
        if (uploaded) interaction.fileIds = [uploaded.id];
        else attachmentFailed = true;
      }

      await save((cur) => {
        const newInteractions = [interaction, ...cur.interactions].sort((a, b) => b.date.localeCompare(a.date));
        return {
          ...cur,
          interactions: newInteractions,
          lastContacted: newInteractions[0].date,
          nextReminder: calculateNextReminder(newInteractions[0].date, cur.followUpFrequency)
        };
      });
      await renderPage();
      // renderPage rebuilds the form, so errEl is gone by now — the warning has
      // to live outside it.
      if (attachmentFailed) {
        showToast("Conversation saved, but the PDF could not be uploaded.");
      }
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
    attachConversationEditors();
  }

  /**
   * Let any conversation's notes be rewritten in place.
   *
   * Follows the file-rename pattern already in this file: swap the text for an
   * input, commit on blur or Enter, abandon on Escape. Nothing is saved unless
   * the text actually changed, so opening an editor by accident costs nothing.
   */
  function attachConversationEditors() {
    root.querySelectorAll("[data-edit-convo]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const wrap = btn.closest(".convo-body");
        const noteEl = wrap.querySelector(".convo-note");
        const original = noteEl.classList.contains("muted") ? "" : noteEl.textContent;

        const editor = document.createElement("div");
        editor.className = "convo-editor";
        editor.innerHTML = '<textarea class="convo-textarea" rows="4"'
          + ' placeholder="What did you talk about? What should you follow up on?"></textarea>'
          + '<div class="convo-editor-actions">'
          + '<button class="btn btn-sm convo-save" type="button">Save</button>'
          + '<button class="btn btn-secondary btn-sm convo-cancel" type="button">Cancel</button>'
          + '</div>';

        noteEl.hidden = true;
        btn.hidden = true;
        wrap.appendChild(editor);

        const area = editor.querySelector(".convo-textarea");
        area.value = original;
        area.focus();

        const restore = () => { editor.remove(); noteEl.hidden = false; btn.hidden = false; };

        editor.querySelector(".convo-cancel").addEventListener("click", restore);
        area.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { e.preventDefault(); restore(); }
        });

        editor.querySelector(".convo-save").addEventListener("click", async (e) => {
          const next = area.value.trim();
          if (next === original.trim()) { restore(); return; }
          e.currentTarget.disabled = true;
          const id = btn.dataset.editConvo;
          await save((cur) => ({
            ...cur,
            interactions: (cur.interactions || []).map((i) =>
              i.id === id ? { ...i, notes: next } : i)
          }));
          await renderPage();
          showToast("Notes saved.");
        });
      });
    });
  }

  await renderPage();
  window.__orbitRefresh = renderPage;
}

// ── Files ─────────────────────────────────────────────────────────────────────

async function initFilesPage() {
  const fileGrid = document.getElementById("fileGrid");
  if (!fileGrid) return;

  let allFiles = [];
  let contacts = [];
  const byId = new Map();

  const contactSelect = document.getElementById("fileContact");
  const barRoot = document.getElementById("fileFilterBar");

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

  barRoot.innerHTML = filterBarHtml({
    placeholder: "Search file, person, role, company…",
    filters: [
      { key: "linked", label: "Connection", options: [
        { value: "", label: "All connections" },
        { value: "__none__", label: "Not linked" },
        ...sorted.map((c) => ({ value: c.id, label: c.name }))
      ] },
      { key: "industry", label: "Industry", options: [
        { value: "", label: "All industries" },
        ...[...new Set(contacts.map((c) => c.industry).filter(Boolean))].sort()
          .map((i) => ({ value: i, label: i }))
      ] },
      { key: "role", label: "Role", options: [
        { value: "", label: "All roles" },
        ...[...new Set(contacts.map((c) => c.role).filter(Boolean))].sort()
          .map((r) => ({ value: r, label: r }))
      ] }
    ]
  });
  const bar = wireFilterBar(barRoot, renderGrid);

  // ── Upload ───────────────────────────────────────────────────────────────
  const dropZone = document.getElementById("fileDropZone");
  const fileInput = document.getElementById("fileInput");
  const preview = document.getElementById("fileDropPreview");
  const errEl = document.getElementById("fileUploadError");
  const msgEl = document.getElementById("fileUploadMsg");
  let pendingFile = null;

  function validateAndPreview(file) {
    if (!file) return;
    if (!isAllowedAttachment(file)) {
      if (errEl) errEl.textContent = ATTACH_REJECT_MSG;
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
      if (!isAllowedAttachment(file)) { if (errEl) errEl.textContent = ATTACH_REJECT_MSG; return; }

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
    const { q, linked, industry, role } = bar.values();

    const filtered = allFiles.filter((f) => {
      const contact = f.contactId ? byId.get(f.contactId) : null;
      if (linked === "__none__" && f.contactId) return false;
      if (linked && linked !== "__none__" && f.contactId !== linked) return false;
      if (industry && (!contact || contact.industry !== industry)) return false;
      if (role && (!contact || contact.role !== role)) return false;
      if (!q) return true;
      return [f.name, contact?.name, contact?.role, contact?.company, contact?.industry]
        .some((field) => field && field.toLowerCase().includes(q));
    });

    bar.setCount(filtered.length === allFiles.length
      ? `${allFiles.length} ${allFiles.length === 1 ? "file" : "files"}`
      : `${filtered.length} of ${allFiles.length}`);

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

  await loadAndRenderFiles();
}

// ── Settings ──────────────────────────────────────────────────────────────────
// `preferences.your_name` signs the draft messages. Without somewhere to set it
// every draft went out as "[Your Name]".

// How often the reach-out nudge is allowed to interrupt you. Stored per device.
const NUDGE_KEY = "orbit_nudge_mode";
const NUDGE_SEEN_KEY = "orbit_nudge_last";

function getNudgeMode() { return localStorage.getItem(NUDGE_KEY) || "daily"; }

/** True when the on-load reach-out modal is allowed to show right now. */
function nudgeAllowed() {
  const mode = getNudgeMode();
  if (mode === "off") return false;
  if (mode === "always") return true;
  return localStorage.getItem(NUDGE_SEEN_KEY) !== todayDateString();
}

function markNudgeShown() {
  localStorage.setItem(NUDGE_SEEN_KEY, todayDateString());
}

/** Download the whole network as CSV. */
async function exportNetworkCsv() {
  const contacts = (await db.getContacts()) || [];
  const cols = ["name", "role", "company", "industry", "email", "dateMet",
                "lastContacted", "followUpFrequency", "nextReminder", "notes"];
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join("; ") : String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  const csv = [cols.join(",")]
    .concat(contacts.map((c) => cols.map((k) => cell(c[k])).join(",")))
    .join("\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "orbit-network.csv";
  a.click();
  URL.revokeObjectURL(url);
  return contacts.length;
}

// ── Edit profile ──────────────────────────────────────────────────────────────

async function openProfileModal() {
  document.getElementById("profileModal")?.remove();

  const [prefs, { data: { user } }] = await Promise.all([
    db.getPreferences(), supabase.auth.getUser()
  ]);
  const name = (prefs.your_name || "").trim();
  const display = name || (user?.email || "").split("@")[0] || "You";

  const modal = document.createElement("div");
  modal.id = "profileModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card edit-profile-card">'
    + '<h3>Edit profile</h3>'
    + '<div class="ep-avatar-wrap">'
    + '<div class="ep-avatar" id="epAvatar">' + escapeHtml(initialsFor(display)) + '</div>'
    + '<button class="ep-camera" id="epCamera" type="button" aria-label="Change photo" title="Change photo">'
    + '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">'
    + '<path d="M3 6.5h3l1.2-2h5.6L14 6.5h3v9H3z"/><circle cx="10" cy="11" r="2.8"/></svg>'
    + '</button>'
    + '<input type="file" id="epPhoto" accept="image/*" hidden />'
    + '</div>'
    + '<div class="field-group"><label for="epName">Display name</label>'
    + '<input type="text" id="epName" value="' + escapeHtml(name) + '" placeholder="Davina Li" /></div>'
    + '<div class="field-group"><label for="epEmail">Sign-in email</label>'
    + '<input type="email" id="epEmail" value="' + escapeHtml(user?.email || "") + '" disabled /></div>'
    + '<p class="ep-note">Your name signs the draft messages Orbit writes for you.</p>'
    + '<p id="epMsg" class="success" aria-live="polite"></p>'
    + '<p id="epErr" class="error" aria-live="polite"></p>'
    + '<div class="ep-actions">'
    + '<button class="btn btn-secondary" id="epCancel" type="button">Cancel</button>'
    + '<button class="btn" id="epSave" type="button">Save</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#epCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  // Photo upload reuses the existing bucket; the URL lives on preferences.
  modal.querySelector("#epCamera").addEventListener("click", () =>
    modal.querySelector("#epPhoto").click());
  modal.querySelector("#epPhoto").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    const err = modal.querySelector("#epErr");
    err.textContent = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { err.textContent = "Pick an image file."; return; }
    if (file.size > 2 * 1024 * 1024) { err.textContent = "Images must be under 2 MB."; return; }

    const uploaded = await db.uploadFileToStorage(file, { category: "avatar" });
    if (!uploaded) { err.textContent = "Upload failed — check the console (F12)."; return; }
    const result = await db.savePreferences({ avatar_url: uploaded.fileUrl });
    if (result.skipped.includes("avatar_url")) {
      err.textContent = "Photo uploaded, but avatar_url needs supabase/add-settings-columns.sql first.";
      return;
    }
    const av = modal.querySelector("#epAvatar");
    av.textContent = "";
    av.style.backgroundImage = "url(" + uploaded.fileUrl + ")";
    av.classList.add("has-photo");
    refreshProfileButton();
  });

  modal.querySelector("#epSave").addEventListener("click", async () => {
    const msg = modal.querySelector("#epMsg");
    const err = modal.querySelector("#epErr");
    msg.textContent = ""; err.textContent = "";
    const result = await db.savePreferences({ your_name: modal.querySelector("#epName").value.trim() });
    if (!result.ok) { err.textContent = "Could not save — see the console (F12)."; return; }
    msg.textContent = "Saved.";
    refreshProfileButton();
    setTimeout(close, 700);
  });

  if (prefs.avatar_url) {
    const av = modal.querySelector("#epAvatar");
    av.textContent = "";
    av.style.backgroundImage = "url(" + prefs.avatar_url + ")";
    av.classList.add("has-photo");
  }
  modal.querySelector("#epName").focus();
}

// ── Calendar auto-sync on load (ORB-15) ───────────────────────────────────────

/**
 * Check the calendar in the background once you have connected it.
 *
 * The first version of this lived behind Settings → Integrations, which is a
 * screen you visit once. A sync you have to remember to run is the same habit
 * problem Orbit exists to fix, so it now runs itself and only speaks up when it
 * has found something.
 *
 * Three things it is careful about:
 *   - it never blocks the page, and never throws
 *   - it never opens a Google popup unprompted; a silent grant that fails just
 *     means no sync this time
 *   - it is throttled, because every page here is a full load and syncing on
 *     each one would hammer Google for no benefit
 */
async function initCalendarAutoSync() {
  if (!calendar.isRemembered()) return;

  const now = Date.now();
  if (!calendar.autoSyncDue(now)) return;

  const contacts = (await db.getContacts()) || [];
  if (!contacts.some((c) => (c.email || "").trim())) return;

  const candidates = await calendar.silentSync(contacts, todayDateString());

  if (candidates === null) {
    // Google would need to ask something. Say so at most once a day — an app
    // that nags every page load about a background feature is worse than one
    // that quietly stops.
    if (calendar.reconnectNudgeDue(now)) {
      calendar.markReconnectNudged(now);
      showToast("Calendar access expired.", {
        actionLabel: "Reconnect",
        duration: 8000,
        onAction: async () => {
          try {
            const found = await calendar.connectCalendar(contacts, todayDateString());
            calendar.markSynced(Date.now());
            if (found.length) openCalendarReviewModal(found, contacts);
            else showToast("No new meetings in the last " + calendar.LOOKBACK_DAYS + " days.");
          } catch (err) {
            showToast(String(err.message || err));
          }
        }
      });
    }
    return;
  }

  calendar.markSynced(now);
  if (!candidates.length) return;

  showToast(candidates.length + (candidates.length === 1
    ? " meeting found on your calendar." : " meetings found on your calendar."), {
    actionLabel: "Review",
    duration: 10000,
    onAction: () => openCalendarReviewModal(candidates, contacts)
  });
}

// ── Calendar review (ORB-15) ──────────────────────────────────────────────────

/**
 * Confirm what the calendar found before writing any of it.
 *
 * Everything is pre-ticked, so the common case is still one click — the point
 * of ORB-15 is to remove the remembering, not to add a chore. What it does not
 * do is write silently: logging a meeting moves that person's next reach-out
 * date, so a wrong entry makes a drifting relationship look healthy. That is
 * the one failure this app cannot afford.
 */
function openCalendarReviewModal(candidates, contacts) {
  document.getElementById("calReviewModal")?.remove();

  // The notes box is here rather than only on the profile because this is the
  // moment you actually remember the meeting. A synced conversation whose notes
  // are just the event title is a record that it happened, not what was said —
  // and the substance is the part Orbit exists to keep.
  const rows = candidates.map((c, i) => '<li class="cal-row">'
    + '<label class="cal-check">'
    + '<input type="checkbox" class="cal-pick" data-index="' + i + '" checked />'
    + '<span class="cal-row-main">'
    + '<span class="cal-row-title">' + escapeHtml(c.title) + '</span>'
    + '<span class="tiny muted">' + escapeHtml(c.contactName) + ' · '
    + formatDate(c.date) + ' · ' + escapeHtml(c.type) + '</span>'
    + '</span>'
    + '</label>'
    + '<div class="cal-notes-wrap">'
    + '<button class="cal-notes-toggle" type="button" data-notes-for="' + i + '">'
    + '+ Add notes</button>'
    + '<textarea class="cal-notes" data-notes-index="' + i + '" rows="3" hidden'
    + ' placeholder="What did you talk about? What should you bring up next time?"></textarea>'
    + '</div>'
    + '</li>').join("");

  const modal = document.createElement("div");
  modal.id = "calReviewModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card quick-add-card">'
    + '<div class="quick-add-header">'
    + '<h3>' + candidates.length + (candidates.length === 1 ? ' meeting' : ' meetings') + ' found</h3>'
    + '<button class="icon-btn" id="calReviewClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + '<p class="muted">Untick anything you would rather not log. Logging one moves '
    + 'that person to the back of your reach-out queue.</p>'
    + '<ul class="cal-list">' + rows + '</ul>'
    + '<p id="calReviewErr" class="error" aria-live="polite"></p>'
    + '<div class="modal-actions">'
    + '<button class="btn" id="calReviewSave" type="button">Log selected</button>'
    + '<button class="btn btn-secondary" id="calReviewCancel" type="button">Not now</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#calReviewClose").addEventListener("click", close);
  modal.querySelector("#calReviewCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  // Collapsed by default so a long list stays scannable — the notes are
  // optional, and most meetings will not get any.
  modal.querySelectorAll(".cal-notes-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const area = modal.querySelector('[data-notes-index="' + toggle.dataset.notesFor + '"]');
      area.hidden = !area.hidden;
      toggle.textContent = area.hidden ? "+ Add notes" : "− Hide notes";
      if (!area.hidden) area.focus();
    });
  });

  modal.querySelector("#calReviewSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const picked = [...modal.querySelectorAll(".cal-pick:checked")]
      .map((el) => {
        const index = Number(el.dataset.index);
        const typed = modal.querySelector('[data-notes-index="' + index + '"]')?.value.trim() || "";
        return { ...candidates[index], notes: typed };
      });
    if (!picked.length) { close(); return; }

    btn.disabled = true;
    btn.textContent = "Logging…";
    const { logged, failed } = await applyCalendarCandidates(picked, contacts);
    close();

    if (!logged) {
      showToast("Could not log those — nothing was changed.");
      return;
    }
    showToast(logged + (logged === 1 ? " conversation logged." : " conversations logged.")
      + (failed ? " " + failed + " could not be saved." : ""), {
      actionLabel: "View in log",
      href: "network.html",
      duration: 7000
    });
    if (typeof window.__orbitRefresh === "function") await window.__orbitRefresh();
  });
}

/**
 * Write the confirmed meetings as conversations.
 *
 * Grouped by contact so someone with three meetings costs one write, not three
 * — and so their cadence is recalculated once, from the most recent.
 */
async function applyCalendarCandidates(picked, contacts) {
  const byContact = new Map();
  for (const c of picked) {
    if (!byContact.has(c.contactId)) byContact.set(c.contactId, []);
    byContact.get(c.contactId).push(c);
  }

  let logged = 0;
  let failed = 0;

  for (const [contactId, items] of byContact) {
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact) { failed += items.length; continue; }

    const added = items.map((item) => normalizeInteraction({
      date: item.date,
      type: item.type,
      // Anything typed goes under the meeting name rather than replacing it —
      // "Coffee with Marcus" is worth keeping as the heading for what follows.
      notes: item.notes ? item.title + "\n\n" + item.notes : item.title,
      sourceEventId: item.eventId
    }));

    const merged = [...added, ...(contact.interactions || [])]
      .sort((a, b) => b.date.localeCompare(a.date));

    const saved = await db.saveContact(normalizeContact({
      ...contact,
      interactions: merged,
      lastContacted: merged[0].date,
      // A real touchpoint puts the relationship back on its normal rhythm,
      // exactly as logging one by hand does.
      nextReminder: contact.followUpFrequency === "none" || !contact.reminderEnabled
        ? contact.nextReminder
        : calculateNextReminder(merged[0].date, contact.followUpFrequency)
    }));

    if (saved) logged += items.length;
    else failed += items.length;
  }

  return { logged, failed };
}

// ── Settings ──────────────────────────────────────────────────────────────────

const SETTINGS_SECTIONS = [
  { key: "general",       label: "General",          icon: "⚙" },
  { key: "profile",       label: "Profile",          icon: "◍" },
  { key: "notifications", label: "Notifications",    icon: "◔" },
  { key: "integrations",  label: "Integrations",     icon: "⧉" },
  { key: "security",      label: "Security & login", icon: "⛨" },
  { key: "data",          label: "Data controls",    icon: "⬓" }
];

async function openSettingsModal(section = "general") {
  document.getElementById("settingsModal")?.remove();

  const [prefs, { data: { user } }] = await Promise.all([
    db.getPreferences(), supabase.auth.getUser()
  ]);
  const authEmail = user?.email || "";
  const theme = localStorage.getItem("orbit_theme")
    || localStorage.getItem("interntrack_theme") || "light";
  const nudge = getNudgeMode();
  // Unlike the in-app prompt, this one lives in the database — the reminder job
  // runs server-side and can never see localStorage. Anything other than the
  // three known values is treated as off, which is also what an unrun migration
  // looks like.
  const emailMode = ["daily", "weekly"].includes(prefs.email_reminders)
    ? prefs.email_reminders : "off";
  const reminderTarget = (prefs.your_email || "").trim() || authEmail || "no address saved";
  const calendarLinked = calendar.isRemembered();

  const modal = document.createElement("div");
  modal.id = "settingsModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card settings-shell">'

    + '<nav class="settings-nav" aria-label="Settings sections">'
    + '<button class="icon-btn settings-close" id="settingsClose" type="button" aria-label="Close">✕</button>'
    + SETTINGS_SECTIONS.map((s) =>
        '<button class="settings-navitem" type="button" data-section="' + s.key + '">'
        + '<span class="sn-icon" aria-hidden="true">' + s.icon + '</span>'
        + '<span>' + escapeHtml(s.label) + '</span></button>').join("")
    + '</nav>'

    + '<div class="settings-body">'

    // ── General ──────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="general">'
    + '<h3 class="settings-h3">General</h3>'
    + '<div class="settings-callout">'
    + '<p class="sc-icon" aria-hidden="true">⛨</p>'
    + '<div><p class="sc-title">Secure your account</p>'
    + '<p class="sc-body">Add two-factor authentication so a stolen password is not enough to get in.</p></div>'
    + '<button class="btn btn-secondary btn-sm" id="goSecurity" type="button">Set up</button>'
    + '</div>'
    + settingsRow("Appearance",
        '<select id="setTheme">'
        + '<option value="light"' + (theme === "light" ? " selected" : "") + '>Light</option>'
        + '<option value="dark"' + (theme === "dark" ? " selected" : "") + '>Dark</option></select>')
    + settingsRow("Signed in as", '<span class="settings-static">' + escapeHtml(authEmail) + '</span>')
    + '</section>'

    // ── Profile ──────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="profile">'
    + '<h3 class="settings-h3">Profile</h3>'
    + '<div class="field-group"><label for="setYourName">Full name</label>'
    + '<input type="text" id="setYourName" value="' + escapeHtml(prefs.your_name || "") + '" placeholder="Davina Li" /></div>'
    + '<div class="field-group"><label for="setPhone">Phone number</label>'
    + '<input type="tel" id="setPhone" value="' + escapeHtml(prefs.phone || "") + '" placeholder="+1 555 000 1234" />'
    + '<p class="field-hint">Stored on your profile. Not used for sign-in codes — see Security &amp; login.</p></div>'
    + '<div class="field-group"><label for="setYourEmail">Contact email</label>'
    + '<input type="email" id="setYourEmail" value="' + escapeHtml(prefs.your_email || "") + '" placeholder="you@example.com" />'
    + '<p class="field-hint">Shown in drafts, and where email reminders are sent. '
    + 'Your sign-in email is <strong>' + escapeHtml(authEmail) + '</strong>.</p></div>'
    + '<p id="profileMsg" class="success" aria-live="polite"></p>'
    + '<p id="profileErr" class="error" aria-live="polite"></p>'
    + '<button class="btn" id="saveProfile" type="button">Save profile</button>'
    + '</section>'

    // ── Notifications ────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="notifications">'
    + '<h3 class="settings-h3">Notifications</h3>'
    + '<p class="settings-note">Orbit opens a reach-out prompt when someone is overdue. '
    + 'Choose how often that is allowed to interrupt you.</p>'
    + settingsRow("Reach-out prompt",
        '<select id="setNudge">'
        + '<option value="always"' + (nudge === "always" ? " selected" : "") + '>Every time I open Orbit</option>'
        + '<option value="daily"' + (nudge === "daily" ? " selected" : "") + '>Once a day</option>'
        + '<option value="off"' + (nudge === "off" ? " selected" : "") + '>Never</option></select>')
    + '<p class="field-hint">Overdue people still show on the dashboard either way.</p>'

    + '<hr class="settings-rule" />'
    + '<h4 class="settings-h4">Email reminders</h4>'
    + '<p class="settings-note">The prompt above only fires when you open Orbit. '
    + 'This one arrives on its own — a single digest of everyone who is drifting, '
    + 'never one email per person.</p>'
    + settingsRow("Email me",
        '<select id="setEmailReminders">'
        + '<option value="off"' + (emailMode === "off" ? " selected" : "") + '>Never</option>'
        + '<option value="daily"' + (emailMode === "daily" ? " selected" : "") + '>At most once a day</option>'
        + '<option value="weekly"' + (emailMode === "weekly" ? " selected" : "") + '>At most once a week</option>'
        + '</select>')
    + '<p class="field-hint">Sent to <strong>' + escapeHtml(reminderTarget) + '</strong>. '
    + 'The same person will not appear again for a week, so a long-overdue contact '
    + 'does not turn into a daily guilt trip.</p>'
    + '<p id="emailRemMsg" class="success" aria-live="polite"></p>'
    + '<p id="emailRemErr" class="error" aria-live="polite"></p>'
    + '<button class="btn btn-secondary btn-sm" id="saveEmailReminders" type="button">Save email setting</button>'
    + '</section>'

    // ── Integrations ─────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="integrations">'
    + '<h3 class="settings-h3">Integrations</h3>'
    + '<h4 class="settings-h4">Google Calendar</h4>'
    + '<p class="settings-note">Orbit only works if you remember to log the people you '
    + 'spoke to — which is the habit that fails. Connect your calendar and it finds '
    + 'those meetings for you.</p>'
    + '<ul class="settings-list">'
    + '<li><strong>Read-only.</strong> Orbit cannot create, change or delete anything '
    + 'on your calendar. Google enforces that, not us.</li>'
    + '<li><strong>Nothing is stored.</strong> The access token lives in this tab and '
    + 'is gone when you close it. No refresh token, nothing in the database.</li>'
    + '<li><strong>You confirm every entry.</strong> A meeting on a calendar is not '
    + 'proof you spoke, and logging one moves that person\'s next reach-out date.</li>'
    + '<li><strong>Matched by email</strong>, so only connections whose email you have '
    + 'saved can be found.</li>'
    + '</ul>'
    + settingsRow("Status", '<span class="settings-static">'
        + (calendarLinked
          ? 'Connected — checked automatically every few hours'
          : 'Not connected')
        + '</span>')
    + '<p class="field-hint">' + (calendarLinked
        ? 'When it finds something, Orbit tells you on whichever page you are on. '
          + 'You still confirm each one before it is logged.'
        : 'Once connected, Orbit checks in the background and only speaks up when '
          + 'it has found something.') + '</p>'
    + '<p id="calMsg" class="success" aria-live="polite"></p>'
    + '<p id="calErr" class="error" aria-live="polite"></p>'
    + '<div class="modal-actions">'
    + '<button class="btn" id="calSyncBtn" type="button">'
    + (calendarLinked ? 'Check now' : 'Connect Google Calendar') + '</button>'
    + (calendarLinked
      ? '<button class="btn btn-secondary" id="calDisconnectBtn" type="button">Disconnect</button>'
      : '')
    + '</div>'
    + '</section>'

    // ── Security ─────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="security">'
    + '<h3 class="settings-h3">Security &amp; login</h3>'
    + '<h4 class="settings-h4">Change password</h4>'
    + '<div class="field-group"><label for="setPw1">New password</label>'
    + '<input type="password" id="setPw1" autocomplete="new-password" placeholder="At least 8 characters" /></div>'
    + '<div class="field-group"><label for="setPw2">Confirm new password</label>'
    + '<input type="password" id="setPw2" autocomplete="new-password" /></div>'
    + '<p id="pwMsg" class="success" aria-live="polite"></p>'
    + '<p id="pwErr" class="error" aria-live="polite"></p>'
    + '<button class="btn" id="savePw" type="button">Update password</button>'
    + '<hr class="settings-rule" />'
    + '<h4 class="settings-h4">Two-factor authentication</h4>'
    + '<p class="settings-note">Not enabled. Two options, and they are not equal:</p>'
    + '<ul class="settings-list">'
    + '<li><strong>Authenticator app</strong> — free on Supabase, works offline. The one worth building.</li>'
    + '<li><strong>SMS to your phone</strong> — needs a paid provider (Twilio) and is weaker: '
    + 'SIM-swap attacks are why security guidance now prefers an app.</li>'
    + '</ul>'
    + '<button class="btn btn-secondary" type="button" disabled>Set up authenticator (not built yet)</button>'
    + '</section>'

    // ── Data ─────────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="data">'
    + '<h3 class="settings-h3">Data controls</h3>'
    + '<p class="settings-note">Your network is yours. Take a copy whenever you like.</p>'
    + settingsRow("Export network",
        '<button class="btn btn-secondary btn-sm" id="exportCsv" type="button">Download CSV</button>')
    + '<p id="exportMsg" class="success" aria-live="polite"></p>'
    + '<hr class="settings-rule" />'
    + '<h4 class="settings-h4">Delete account</h4>'
    + '<p class="settings-note">Deleting a Supabase account needs a server-side admin call, which this '
    + 'app does not have — it runs entirely in your browser. For now, delete your account from the '
    + 'Supabase dashboard under Authentication → Users.</p>'
    + '</section>'

    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#settingsClose").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); }
  });

  const show = (name) => {
    modal.querySelectorAll(".settings-navitem").forEach((b) =>
      b.classList.toggle("active", b.dataset.section === name));
    modal.querySelectorAll(".settings-pane").forEach((p) =>
      p.classList.toggle("active", p.dataset.pane === name));
  };
  modal.querySelectorAll(".settings-navitem").forEach((b) =>
    b.addEventListener("click", () => show(b.dataset.section)));
  modal.querySelector("#goSecurity").addEventListener("click", () => show("security"));
  show(section);

  modal.querySelector("#setTheme").addEventListener("change", (e) => {
    localStorage.setItem("orbit_theme", e.target.value);
    applyTheme();
  });

  modal.querySelector("#setNudge").addEventListener("change", (e) => {
    localStorage.setItem(NUDGE_KEY, e.target.value);
  });

  modal.querySelector("#saveProfile").addEventListener("click", async () => {
    const msg = modal.querySelector("#profileMsg");
    const err = modal.querySelector("#profileErr");
    msg.textContent = ""; err.textContent = "";
    const result = await db.savePreferences({
      your_name: modal.querySelector("#setYourName").value.trim(),
      your_email: modal.querySelector("#setYourEmail").value.trim(),
      phone: modal.querySelector("#setPhone").value.trim()
    });
    if (!result.ok) { err.textContent = "Could not save — see the console (F12)."; return; }
    if (result.skipped.length) {
      err.textContent = "Saved, but " + result.skipped.join(" and ")
        + " needs supabase/add-settings-columns.sql to be run first.";
    }
    msg.textContent = "Profile saved.";
    refreshProfileButton();
    setTimeout(() => { msg.textContent = ""; }, 2500);
  });

  modal.querySelector("#saveEmailReminders").addEventListener("click", async () => {
    const msg = modal.querySelector("#emailRemMsg");
    const err = modal.querySelector("#emailRemErr");
    msg.textContent = ""; err.textContent = "";
    const mode = modal.querySelector("#setEmailReminders").value;

    // Turning this on with nowhere to send it would fail silently in a cron job
    // nobody is watching, so it is refused here where there is someone to tell.
    if (mode !== "off" && !((prefs.your_email || "").trim() || authEmail)) {
      err.textContent = "Add a contact email under Profile first — there is nowhere to send these.";
      return;
    }

    const result = await db.savePreferences({ email_reminders: mode });
    if (!result.ok) { err.textContent = "Could not save — see the console (F12)."; return; }
    if (result.skipped.includes("email_reminders")) {
      err.textContent = "Run supabase/add-reminder-columns.sql first — the column does not exist yet.";
      return;
    }
    prefs.email_reminders = mode;
    msg.textContent = mode === "off"
      ? "Email reminders are off."
      : "Saved. Reminders go to " + ((prefs.your_email || "").trim() || authEmail) + ".";
    setTimeout(() => { msg.textContent = ""; }, 3000);
  });

  modal.querySelector("#calSyncBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const msg = modal.querySelector("#calMsg");
    const err = modal.querySelector("#calErr");
    msg.textContent = ""; err.textContent = "";
    btn.disabled = true;
    btn.textContent = "Checking your calendar…";
    try {
      const contacts = (await db.getContacts()) || [];
      const withEmail = contacts.filter((c) => (c.email || "").trim());
      if (!withEmail.length) {
        err.textContent = "None of your connections have an email saved, so there is "
          + "nothing to match against. Add emails first.";
        return;
      }
      const candidates = await calendar.connectCalendar(contacts, todayDateString());
      calendar.markSynced(Date.now());
      if (!candidates.length) {
        msg.textContent = "No new meetings found in the last "
          + calendar.LOOKBACK_DAYS + " days. Orbit will keep checking on its own.";
        return;
      }
      modal.remove();
      openCalendarReviewModal(candidates, contacts);
    } catch (error) {
      err.textContent = String(error.message || error);
    } finally {
      btn.disabled = false;
      btn.textContent = calendarLinked ? "Check now" : "Connect Google Calendar";
    }
  });

  modal.querySelector("#calDisconnectBtn")?.addEventListener("click", () => {
    calendar.disconnectCalendar();
    modal.remove();
    showToast("Google Calendar disconnected. Nothing was stored, so nothing to clean up.");
  });

  modal.querySelector("#savePw").addEventListener("click", async () => {
    const msg = modal.querySelector("#pwMsg");
    const err = modal.querySelector("#pwErr");
    msg.textContent = ""; err.textContent = "";
    const pw1 = modal.querySelector("#setPw1").value;
    const pw2 = modal.querySelector("#setPw2").value;
    if (pw1.length < 8) { err.textContent = "Use at least 8 characters."; return; }
    if (pw1 !== pw2) { err.textContent = "The two passwords do not match."; return; }
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    if (error) { err.textContent = error.message; return; }
    modal.querySelector("#setPw1").value = "";
    modal.querySelector("#setPw2").value = "";
    msg.textContent = "Password updated.";
  });

  modal.querySelector("#exportCsv").addEventListener("click", async () => {
    const n = await exportNetworkCsv();
    const msg = modal.querySelector("#exportMsg");
    msg.textContent = `Exported ${n} ${n === 1 ? "connection" : "connections"}.`;
    setTimeout(() => { msg.textContent = ""; }, 3000);
  });
}

/** A label-on-the-left, control-on-the-right settings row. */
function settingsRow(label, controlHtml) {
  return '<div class="settings-row">'
    + '<span class="settings-row-label">' + escapeHtml(label) + '</span>'
    + '<div class="settings-row-control">' + controlHtml + '</div>'
    + '</div>';
}

// ── Profile menu (sidebar footer) ─────────────────────────────────────────────

async function refreshProfileButton() {
  const btn = document.getElementById("profileBtn");
  if (!btn) return;
  const [prefs, { data: { user } }] = await Promise.all([
    db.getPreferences(),
    supabase.auth.getUser()
  ]);
  const name = (prefs.your_name || "").trim() || (user?.email || "").split("@")[0] || "You";
  btn.querySelector(".profile-initials").textContent = initialsFor(name);
  btn.querySelector(".profile-name").textContent = name;
  btn.querySelector(".profile-sub").textContent = user?.email || "";
}

function initProfileMenu() {
  const btn = document.getElementById("profileBtn");
  if (!btn) return;

  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; btn.setAttribute("aria-expanded", "false"); };

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu) { closeMenu(); return; }

    menu = document.createElement("div");
    menu.className = "profile-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML =
      '<button class="pm-item" role="menuitem" data-act="profile">'
      + '<span class="pm-icon" aria-hidden="true">◍</span> Profile</button>'
      + '<button class="pm-item" role="menuitem" data-act="settings">'
      + '<span class="pm-icon" aria-hidden="true">⚙</span> Settings</button>'
      + '<hr class="pm-rule" />'
      + '<button class="pm-item pm-danger" role="menuitem" data-act="signout">'
      + '<span class="pm-icon" aria-hidden="true">⭘</span> Log out</button>';
    btn.parentElement.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");

    menu.addEventListener("click", async (ev) => {
      const act = ev.target.closest(".pm-item")?.dataset.act;
      if (!act) return;
      closeMenu();
      if (act === "profile") openProfileModal();
      if (act === "settings") openSettingsModal("general");
      if (act === "signout") {
        await supabase.auth.signOut();
        window.location.href = "auth.html";
      }
    });
  });

  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  refreshProfileButton();
}

// ── Reach-out nudge on load ───────────────────────────────────────────────────

async function checkRemindersOnLoad() {
  if (document.querySelector("[data-page='contact']")) return;
  if (!nudgeAllowed()) return;
  setTimeout(async () => {
    const contacts = (await db.getContacts()) || [];
    const due = contacts.filter((c) => getReminderStatus(c) === "due");
    if (due.length) { markNudgeShown(); showReminderModal(due[0]); }
  }, 900);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  const user = await requireAuth();
  if (!user) return;
  initSidebarToggle();
  initNavDropdown();
  applyTheme();
  initProfileMenu();
  await initDashboard();
  await initMyNetwork();
  await initNetworkingLog();
  await initContactPage();
  await initFilesPage();
  await checkRemindersOnLoad();
  // Last, and deliberately not awaited into anything that renders: it talks to
  // Google over the network and must never hold up the page.
  initCalendarAutoSync().catch(() => {});
})();
