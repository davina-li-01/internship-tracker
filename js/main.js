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
import { MIN_PASSWORD, attachStrengthMeter, passwordAdviceHtml } from "./password.js";

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

/**
 * A Date to a YYYY-MM-DD string, in the user's own timezone.
 *
 * Not `toISOString().slice(0, 10)`, which is what this used to be. That formats
 * in UTC, while `parseDateOnly` and `daysSince` work in local time — so west of
 * UTC the app spent every afternoon and evening stamping tomorrow's date while
 * measuring elapsed days against today's. In Hawaii that is a ten-hour window,
 * daily, in which clicking "Reached out" recorded a conversation on a date that
 * had not happened yet, and a grace window came out a day too long.
 *
 * Every date in Orbit is a calendar day, not an instant. Calendar days belong
 * to whoever is looking at the calendar.
 */
/**
 * The IANA timezone this browser is in, e.g. "Pacific/Honolulu".
 *
 * Falls back to UTC rather than guessing from the clock offset: an offset
 * cannot distinguish zones that share one today and diverge at the next
 * daylight-saving change, and a stored zone outlives the session that read it.
 */
function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function toDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateString() {
  return toDateString(new Date());
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Notes with light formatting (ORB-63).
 *
 * Notes are stored as plain text with markers, never as HTML. Notes are the one
 * field where other people's words get pasted in, so the injection surface has
 * to stay closed — and CSV export in ORB-12 would start emitting tags the day
 * we stored markup.
 *
 * The order below is the whole security argument: escape FIRST, then translate
 * a fixed set of markers into a fixed set of tags. Nothing the user types can
 * become a tag, because by the time markers are read every `<` is already
 * `&lt;`. Reversing these two lines would undo that.
 *
 *   **bold**   __underline__   *italic*   ==highlight==
 *
 * Bold is matched before italic; `**x**` would otherwise be read as an italic
 * `*` wrapping `x*`.
 */
const NOTE_MARKS = [
  [/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>"],
  [/__([^_\n]+)__/g, "<u>$1</u>"],
  [/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>"],
  [/==([^=\n]+)==/g, "<mark>$1</mark>"]
];

function renderNotes(value = "") {
  let out = escapeHtml(value);
  for (const [pattern, replacement] of NOTE_MARKS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * The formatting toolbar (ORB-63).
 *
 * Buttons that wrap the selection, so the markers are something you get rather
 * than something you have to learn. Typing them by hand still works.
 */
// A highlighter, drawn rather than an emoji: emoji render differently on every
// platform and cannot take the button's colour.
const HIGHLIGHTER_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">'
  + '<path d="M15.6 3.4a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11.5 17.5l-4-4z"'
  + ' fill="currentColor"/>'
  + '<path d="M7.5 13.5l4 4-2.2 2.2H5.6l-1.4-1.4z" fill="currentColor" opacity="0.55"/>'
  + '</svg>';

const NOTE_TOOLS = [
  { mark: "**", label: "B", title: "Bold", cls: "is-bold" },
  { mark: "*",  label: "I", title: "Italic", cls: "is-italic" },
  { mark: "__", label: "U", title: "Underline", cls: "is-underline" },
  { mark: "==", label: HIGHLIGHTER_SVG, title: "Highlight", cls: "is-highlight", raw: true }
];

function noteToolbarHtml() {
  return '<div class="note-toolbar" role="group" aria-label="Formatting">'
    + NOTE_TOOLS.map((t) =>
        '<button type="button" class="note-tool ' + t.cls + '"'
        + ' data-mark="' + escapeHtml(t.mark) + '"'
        + ' title="' + escapeHtml(t.title) + '" aria-label="' + escapeHtml(t.title) + '">'
        // Only the hard-coded SVG above is ever inserted raw; everything a user
        // could influence still goes through escapeHtml.
        + (t.raw ? t.label : escapeHtml(t.label)) + '</button>').join("")
    + '</div>';
}

/**
 * Wrap the selection in `mark`, or unwrap it if it is already wrapped.
 *
 * Pure so the awkward parts — an empty selection, a double click — are testable
 * without a browser. Returns the new value and where the selection should land,
 * because leaving the caret after the closing marker makes the second word you
 * bold feel broken.
 */
function toggleNoteMark(value, start, end, mark) {
  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);
  const m = mark.length;

  // Already wrapped, either inside the selection or immediately around it.
  if (selected.length > 2 * m && selected.startsWith(mark) && selected.endsWith(mark)) {
    const inner = selected.slice(m, -m);
    return { value: before + inner + after, start, end: start + inner.length };
  }
  if (before.endsWith(mark) && after.startsWith(mark)) {
    return {
      value: before.slice(0, -m) + selected + after.slice(m),
      start: start - m,
      end: end - m
    };
  }
  // Nothing selected: drop in the markers and put the caret between them, so
  // typing continues inside the formatting rather than after it.
  if (!selected) {
    return { value: before + mark + mark + after, start: start + m, end: start + m };
  }
  return {
    value: before + mark + selected + mark + after,
    start: start + m,
    end: end + m
  };
}

/** Wire a toolbar to the textarea it belongs to. */
function wireNoteToolbar(scope, textarea) {
  scope.querySelectorAll(".note-tool").forEach((tool) => {
    // mousedown, not click: the textarea loses its selection on blur, and by
    // click time selectionStart and selectionEnd are both sitting at zero.
    tool.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const next = toggleNoteMark(
        textarea.value, textarea.selectionStart, textarea.selectionEnd, tool.dataset.mark);
      textarea.value = next.value;
      textarea.focus();
      textarea.setSelectionRange(next.start, next.end);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
}

/**
 * Editing a conversation, in a dialog (ORB-64).
 *
 * The inline version was a four-row textarea wedged into a timeline entry: no
 * room to write, no way to correct the type or the date, and Delete sitting
 * next to the note it would destroy. This carries the same fields as *log a
 * conversation*, so the two are one thing seen twice rather than two
 * half-features.
 *
 * `onSubmit({ date, type, notes, file })` and `onDelete()` do the writing — this
 * function owns the dialog and nothing else, which is what makes it testable
 * without a contact, a database or a page around it.
 */
function openConversationEditor(interaction, { title = "", onSubmit, onDelete } = {}) {
  document.getElementById("convoEditModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "convoEditModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card convo-edit-card">'
    + '<div class="convo-edit-header">'
    + '<h3>' + escapeHtml(title || "Edit conversation") + '</h3>'
    + '<button class="icon-btn" id="convoEditClose" type="button" aria-label="Close">✕</button>'
    + '</div>'

    + '<div class="convo-edit-head-row">'
    + '<div class="field-group"><label for="convoEditDate">When</label>'
    + '<input type="date" id="convoEditDate" value="' + escapeHtml(interaction?.date || "") + '" /></div>'
    + '<div class="field-group"><label for="convoEditType">Type</label>'
    + '<select id="convoEditType">'
    + INTERACTION_TYPES.map((t) => '<option value="' + escapeHtml(t) + '"'
        + (interaction?.type === t ? " selected" : "") + '>'
        + escapeHtml(t.charAt(0).toUpperCase() + t.slice(1)) + '</option>').join("")
    + '</select></div>'
    + '</div>'

    + '<div class="field-group"><label for="convoEditNotes">What did you talk about?</label>'
    + noteToolbarHtml()
    + '<textarea id="convoEditNotes" class="convo-edit-notes" rows="12"'
    + ' placeholder="What they are working on, what they said, anything you want to bring up next time…"></textarea></div>'

    + '<div class="field-group"><label for="convoEditFile">Attach a transcript or PDF'
    + ' <span class="opt-label">(optional)</span></label>'
    + '<input type="file" id="convoEditFile" accept="' + ATTACH_ACCEPT + '" /></div>'

    + '<p class="convo-edit-err error" aria-live="polite"></p>'

    // Save leads on the left; Delete is pushed to the far right by the footer's
    // own layout, so the destructive action is never adjacent to the safe one.
    + '<div class="convo-edit-footer">'
    + '<div class="convo-edit-primary">'
    + '<button class="btn" id="convoEditSave" type="button">Save</button>'
    + '<button class="btn btn-secondary" id="convoEditCancel" type="button">Cancel</button>'
    + '</div>'
    + '<button class="btn danger-btn convo-edit-delete" id="convoEditDelete" type="button">'
    + 'Delete conversation</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(modal);

  const area = modal.querySelector("#convoEditNotes");
  area.value = interaction?.notes || "";
  wireNoteToolbar(modal, area);

  const errEl = modal.querySelector(".convo-edit-err");
  const close = () => { modal.remove(); document.removeEventListener("keydown", onKey); };
  function onKey(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKey);

  modal.querySelector("#convoEditClose").addEventListener("click", close);
  modal.querySelector("#convoEditCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  modal.querySelector("#convoEditSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const file = modal.querySelector("#convoEditFile")?.files?.[0] || null;
    errEl.textContent = "";
    if (file && !isAllowedAttachment(file)) {
      errEl.textContent = "That file type is not supported — PDF or an image.";
      return;
    }
    btn.disabled = true;
    if (file) btn.textContent = "Uploading…";
    await onSubmit?.({
      date: modal.querySelector("#convoEditDate").value || interaction?.date || "",
      type: modal.querySelector("#convoEditType").value,
      notes: area.value.trim(),
      file
    });
    close();
  });

  // Confirmed here rather than by the caller, so no path reaches a delete
  // without one. The note is on screen while the question is asked.
  modal.querySelector("#convoEditDelete").addEventListener("click", async () => {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    await onDelete?.();
    close();
  });

  area.focus();
  return modal;
}

/** The same text with markers removed, for previews and anywhere plain. */
function stripNoteMarks(value = "") {
  return String(value)
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/==([^=\n]+)==/g, "$1");
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
  // The future branch only ever ran on "next nudge" dates until the upcoming
  // meetings widget started calling it, where "in 1 days" was on screen.
  if (elapsed === -1) return "tomorrow";
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

/**
 * Relationship tiers (ORB-52).
 *
 * The tier is what you pick; the interval is what runs. Choosing a tier sets
 * `followUpFrequency` to its default, and editing the interval afterwards is
 * the override — so these numbers are a starting point, never a constraint.
 * Everything downstream (health, digest, dashboard) still reads the interval
 * and is untouched by any of this.
 *
 * Thresholds come from "User Research: Cadence Structure" (Confluence, Aug 11).
 * Read its caveats before treating them as settled: the tier sizes come from
 * secondary coverage of Dunbar rather than the primary papers.
 */
const TIERS = {
  inner_circle: {
    label: "Inner circle",
    hint: "The few you would actually call. About monthly.",
    frequency: "monthly"
  },
  mentors_managers: {
    label: "Mentors and managers",
    hint: "People invested in how you do. About every three months.",
    frequency: "quarterly"
  },
  professional_network: {
    label: "Professional network",
    hint: "Worth staying known to. About twice a year.",
    frequency: "custom:180"
  },
  met_once: {
    label: "Met once",
    hint: "A good conversation, not yet a relationship. About yearly.",
    frequency: "custom:365"
  },
  none: {
    label: "No schedule",
    hint: "On file, never surfaced. A deliberate choice, not a gap.",
    frequency: "none"
  }
};

/** Display order, closest relationships first. */
const TIER_ORDER = [
  "inner_circle", "mentors_managers", "professional_network", "met_once", "none"
];

function tierLabel(tier) {
  return TIERS[tier]?.label || "";
}

function frequencyForTier(tier) {
  return TIERS[tier] ? TIERS[tier].frequency : "none";
}

/**
 * The tier an interval implies, for contacts saved before tiers existed.
 *
 * Mirrors the back-fill in `012_relationship_tiers.sql` exactly — same named
 * frequencies, same day boundaries. If the two ever drift, the same contact
 * shows one tier in the picker and another in the database, which is worse
 * than having no tier at all.
 */
function tierForFrequency(freq) {
  if (freq === "weekly" || freq === "biweekly" || freq === "monthly") return "inner_circle";
  if (freq === "bimonthly" || freq === "quarterly") return "mentors_managers";
  const days = getIntervalDays(freq);
  if (!days) return "none";
  if (days <= 60) return "inner_circle";
  if (days <= 135) return "mentors_managers";
  if (days <= 272) return "professional_network";
  return "met_once";
}

/** The tier to show: what was chosen, else what the interval implies. */
function effectiveTier(contact) {
  return contact?.tier || tierForFrequency(contact?.followUpFrequency);
}

/**
 * What the cadence means, in a sentence — the tier picker's result line.
 *
 * The interval control is the override and lives behind "Adjust", so this is
 * the only place most people ever see what their choice actually does.
 */
function cadenceSentence(freq) {
  if (!freq || freq === "none") return "No reminders — kept on file.";
  return "Reaching out " + getFreqLabel(freq).toLowerCase() + ".";
}

/** `<option>` list for a tier select, with one marked selected. */
function tierOptionsHtml(selected) {
  return TIER_ORDER
    .map((t) => '<option value="' + t + '"' + (selected === t ? " selected" : "") + '>'
      + escapeHtml(TIERS[t].label) + '</option>')
    .join("");
}

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
  // A date, not an instant. This used to return a full toISOString(), which is
  // a local midnight rendered in UTC — so east of UTC, everything that reads
  // the first ten characters of it got the day before the one intended. The
  // column in Postgres is a `date` anyway, so the time was never stored.
  return toDateString(date);
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
  // parseDateOnly built this at LOCAL midnight, so it has to be read back the
  // same way. Going through toISOString here shifted the answer a day east of
  // UTC — the same mismatch that made todayDateString wrong west of it.
  return toDateString(d);
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

  if (!interval || !contact.reminderEnabled) {
    return { scheduled: false, pct: 0, band: "none", elapsed, interval: 0, daysLeft: null, grace: false };
  }

  // `elapsed === null` means there is no date to count from — someone was put on
  // a cadence before any contact was recorded. That used to fall out here as
  // "No schedule", which was wrong twice over (ORB-69): firstDeadlineFor already
  // answers this case with the grace window, and the reminder digest queries
  // next_reminder in SQL without consulting this function, so the same contact
  // was emailed while the dashboard denied they were scheduled.
  const naturalNext = addDays(last, interval);
  const next = contact.nextReminder
    ? String(contact.nextReminder).slice(0, 10)
    : (naturalNext || firstDeadlineFor(last, contact.followUpFrequency));

  // A deadline later than the cadence alone would give means the window was
  // deliberately extended — the one-week grace on a fresh schedule, or a snooze.
  // No anchor date is the same situation by definition: you owe a first
  // reach-out and nothing has been measured yet.
  const grace = !naturalNext || Boolean(next && next > naturalNext);
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

/**
 * The details, read-only.
 *
 * Default state, because reading a record is the common act and editing it is
 * the rare one. A screen of inputs reads as a form you are expected to fill in;
 * this reads as what you know about someone.
 *
 * Deliberately the same grid as the editor, so switching modes moves nothing.
 */
function detailsViewHtml(c, pastCompanies) {
  const field = (label, value, extraClass = "") =>
    '<div class="field-group view-field ' + extraClass + '">'
    + '<label>' + label + '</label>'
    + '<p class="view-value' + (value ? '' : ' view-empty') + '">'
    + (value ? escapeHtml(value) : "Not set") + '</p>'
    + '</div>';

  return '<div class="inline-edit-grid">'
    + field("Role / Title", c.role)
    + field("Current company", c.company)
    + field("Industry", c.industry)

    + '<div class="field-group view-field field-email">'
    + '<label>Email</label>'
    + (c.emails.length
      ? '<ul class="view-emails">' + c.emails.map((e) =>
          '<li><span class="email-label">' + escapeHtml(e.label) + '</span>'
          + '<a href="mailto:' + escapeHtml(e.address) + '">' + escapeHtml(e.address) + '</a></li>').join("")
        + '</ul>'
      : '<p class="view-value view-empty">Not set</p>')
    + '</div>'

    + '<div class="field-group view-field field-past">'
    + '<label>Past companies</label>'
    + (pastCompanies.length
      ? '<div class="past-tokens">' + pastCompanies.map((co) =>
          '<span class="token token-past">' + escapeHtml(co) + '</span>').join("")
        + '</div>'
      : '<p class="view-value view-empty">None</p>')
    + '</div>'
    + '</div>';
}

/** One editable address row: label, address, and a way to remove it. */
function emailRowHtml(entry, index) {
  return '<div class="email-row" data-email-index="' + index + '">'
    + '<select class="email-kind" aria-label="Type of address">'
    + EMAIL_LABELS.map((l) => '<option value="' + l + '"'
      + (l === entry.label ? ' selected' : '') + '>'
      + l.charAt(0).toUpperCase() + l.slice(1) + '</option>').join("")
    + '</select>'
    + '<input type="email" class="email-address" value="' + escapeHtml(entry.address) + '"'
    + ' placeholder="name@example.com" aria-label="Email address" />'
    // Keeps click-to-email now that the mailto list above is gone.
    + (entry.address
      ? '<a class="icon-btn email-open" href="mailto:' + escapeHtml(entry.address) + '"'
        + ' aria-label="Email ' + escapeHtml(entry.address) + '" title="Send an email">✉</a>'
      : '<span class="icon-btn email-open is-empty" aria-hidden="true">✉</span>')
    + '<button class="icon-btn email-remove" type="button" aria-label="Remove this address">✕</button>'
    + '</div>';
}

/**
 * The past-company chips.
 *
 * Its own function because the editor rebuilds just this block after a company
 * is added, rather than re-rendering the whole page — a full re-render while
 * you are still typing in the form above would throw away the caret and any
 * other field you had part-way through.
 */
function pastTokensHtml(pastCompanies) {
  if (!pastCompanies.length) return "";
  return '<div class="past-tokens">' + pastCompanies.map((co) =>
    '<span class="token token-past">' + escapeHtml(co)
    + '<button class="token-x" type="button" data-remove-company="' + escapeHtml(co)
    + '" aria-label="Remove ' + escapeHtml(co) + '">✕</button></span>').join("")
    + '</div>';
}

/**
 * Addresses a person can be reached at.
 *
 * One field was never enough: people have a work address, a personal one, one
 * from school, one for a side project — and the calendar sends invites to
 * whichever is relevant. Matching on a single stored address silently missed
 * every meeting sent to any of the others, which looks identical to "no
 * meetings found".
 */
const EMAIL_LABELS = ["personal", "work", "school", "other"];

function normalizeEmail(item = {}) {
  const label = EMAIL_LABELS.includes(item.label) ? item.label : "personal";
  return {
    id: item.id || makeId(),
    label,
    address: String(item.address || "").trim()
  };
}

/**
 * The whole list, de-duplicated, with the primary first.
 *
 * `contact.email` is kept as the first address rather than removed, so every
 * existing read — mailto links, the capture form, search — keeps working
 * against one string while matching gets the full set.
 */
function normalizeEmails(contact = {}) {
  const raw = Array.isArray(contact.emails) ? contact.emails : [];
  const list = raw.map(normalizeEmail).filter((e) => e.address);

  // A contact saved before this existed has only the single column, and the
  // capture form still writes one address into it — so an `email` the list does
  // not know about is a new address, and gets promoted to primary.
  //
  // The corollary matters as much: a caller editing the list must not leave a
  // STALE `email` behind, or this puts the address it just removed straight
  // back. See applyDetails on the profile.
  const legacy = String(contact.email || "").trim();
  if (legacy && !list.some((e) => e.address.toLowerCase() === legacy.toLowerCase())) {
    list.unshift(normalizeEmail({ label: "personal", address: legacy }));
  }

  const seen = new Set();
  return list.filter((e) => {
    const key = e.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const emails = normalizeEmails(contact);
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
    email: emails[0]?.address || "",
    emails,
    company: (contact.company || "").trim(),
    role: (contact.role || "").trim(),
    industry: (contact.industry || "").trim(),
    dateMet: contact.dateMet || "",
    lastContacted,
    followUpFrequency: frequency,
    // Only what the user actually chose is stored. A tier derived from the
    // interval is a display fallback (effectiveTier), not a saved answer —
    // persisting it would make ORB-57's "changed from the default" metric
    // unmeasurable, since every contact would look deliberately classified.
    tier: contact.tier || "",
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
    + escapeHtml(stripNoteMarks(text).slice(0, limit))
    + (stripNoteMarks(text).length > limit ? "…" : "")
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

/**
 * The sub-menu caret.
 *
 * Whether it starts open is decided by the inline script before first paint —
 * doing it here meant the menu rendered closed and then expanded, and since
 * every page is a full page load, Files blinked on every navigation.
 *
 * This only wires the toggle and keeps aria in step. `open` and `closed` are
 * both explicit so a choice made this session beats the remembered default in
 * either direction.
 */
function initNavDropdown() {
  const remembered = document.body.classList.contains("nav-open");

  document.querySelectorAll(".s-group").forEach((group) => {
    const caret = group.querySelector(".s-caret");
    if (!caret) return;

    // A sub-page being current still forces it open, whatever was remembered.
    if (group.querySelector(".s-sublink.active")) group.classList.add("open");

    const isOpen = () => group.classList.contains("open")
      || (remembered && !group.classList.contains("closed"));

    caret.setAttribute("aria-expanded", String(isOpen()));

    caret.addEventListener("click", (e) => {
      e.preventDefault();
      const next = !isOpen();
      group.classList.toggle("open", next);
      group.classList.toggle("closed", !next);
      caret.setAttribute("aria-expanded", String(next));
      localStorage.setItem("orbit_nav_open", String(next));
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
    stripNoteMarks(interaction.notes).split(/[.!?\n]+/).forEach((s) => {
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

    // The first line, shown on the closed row. For anything the calendar logged
    // that is the meeting title, which is the thing worth seeing without having
    // to open every entry to find the one you meant.
    // Markers stripped: the closed row shows words, not syntax. A note that
    // opens with **Coffee with Marcus** should read as the meeting, not as
    // punctuation someone forgot to close.
    const headline = stripNoteMarks((item.notes || "").split("\n")[0]).trim();

    const summary = '<summary class="convo-summary">'
      + '<span class="convo-caret" aria-hidden="true">▸</span>'
      + '<span class="convo-date">' + formatDate(item.date) + '</span>'
      + '<span class="tag">' + escapeHtml(item.type) + '</span>'
      + (headline
        ? '<span class="convo-headline">' + escapeHtml(headline) + '</span>'
        : '<span class="tiny muted">no notes</span>')
      // Flagged on the summary too, because a collapsed conversation would
      // otherwise hide the fact that anything is attached to it.
      + (attached.length
        ? '<span class="convo-clip" title="' + attached.length + ' attached">📎 ' + attached.length + '</span>'
        : '')
      + (item.sourceEventId
        ? '<span class="convo-source" title="Logged from your calendar">📅</span>'
        : '')
      + '</summary>';

    // Every conversation is editable. Before this, a saved conversation was
    // sealed — which mattered most for calendar-synced ones, whose notes start
    // as nothing but the event title and could never be filled in.
    const body = '<div class="convo-body" data-convo-id="' + escapeHtml(item.id) + '">'
      + (item.notes
        ? '<p class="convo-note">' + renderNotes(item.notes) + '</p>'
        : '<p class="convo-note muted">No notes yet — what did you talk about?</p>')
      // Delete used to sit here, one slip away from the note it destroys. It
      // lives in the dialog now (ORB-64), where opening it is a deliberate act
      // and the button is the furthest thing from Save.
      + '<div class="convo-actions">'
      + '<button class="convo-edit" type="button" data-edit-convo="' + escapeHtml(item.id) + '">'
      + (item.notes ? 'Edit notes' : 'Add notes') + '</button>'
      + '</div>'
      + '</div>';

    const attachments = attached.length
      ? '<ul class="convo-files">'
        + attached.map((f) => '<li><a class="convo-file" href="' + escapeHtml(f.fileUrl) + '"'
          + ' target="_blank" rel="noopener noreferrer">'
          + '<span class="convo-file-icon" aria-hidden="true">📄</span>'
          + '<span class="convo-file-name">' + escapeHtml(f.name) + '</span></a></li>').join("")
        + '</ul>'
      : '';

    // All collapsed. The headline carries enough to find the one you want, so
    // opening the newest by default just pushed everything else down the page.
    return '<details class="convo">' + summary + body + attachments + '</details>';
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
    // ORB-52: the tier is asked first here too. Creating a contact is exactly
    // where "how many days?" is least answerable — you have just met them.
    // Defaults to the tier matching the existing `monthly` default, so the two
    // controls agree on first render. Whether monthly is the right default for
    // someone you have just met is a separate question and belongs to ORB-51 —
    // it is deliberately not changed here.
    + '<div class="field-group"><label>What kind of relationship?</label>'
    + '<select class="cw-tier">' + tierOptionsHtml(tierForFrequency("monthly")) + '</select></div>'
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
    + noteToolbarHtml()
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

  // The toolbar shipped into the edit dialog and nowhere else, so formatting
  // existed in one of the three places a note gets written. Wired here it
  // covers both the Networking Log page and the quick-add modal, which are the
  // same markup rendered twice.
  const notesEl = $(".cw-notes");
  if (notesEl) wireNoteToolbar(form, notesEl);

  let linkedId = null;   // set once an existing contact is chosen
  let active = -1;       // highlighted row in the dropdown

  freqEl.addEventListener("change", () => {
    customWrap.classList.toggle("hidden", freqEl.value !== "custom");
    if (freqEl.value === "custom") $(".cw-custom-days").focus();
  });

  // Same relationship as on the profile: the tier fills in an interval, the
  // interval remains editable. No focus jump here — unlike the change above,
  // this one was not initiated by someone reaching for the day count.
  const tierEl = $(".cw-tier");
  tierEl?.addEventListener("change", () => {
    const preset = frequencyForTier(tierEl.value);
    if (preset.startsWith("custom:")) {
      freqEl.value = "custom";
      customWrap.classList.remove("hidden");
      $(".cw-custom-days").value = preset.slice(7);
    } else {
      freqEl.value = preset;
      customWrap.classList.add("hidden");
    }
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
    // And their tier, for the same reason — logging a conversation with someone
    // must not silently reclassify the relationship.
    if (tierEl) tierEl.value = effectiveTier(contact);

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
      tier: tierEl ? tierEl.value : (base.tier || ""),
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
      nextReminder: addDays(todayDateString(), 3)
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

    // Coming up sits in this row rather than below it, so the four columns line
    // up with the four KPI tiles above: ring 1, breakdown 2, coming up 1 — the
    // last of which lands exactly under the Overdue tile.
    const chartsHtml = '<div class="chart-row">'
      + (scheduled
        ? chartCard("Network health", "Of those on a cadence, how many are current",
            ringHtml({ pct: healthPct,
                       band: healthPct >= 60 ? "good" : healthPct >= 25 ? "warning" : "critical",
                       caption: "In touch", sub: counts.good + " of " + scheduled }))
          + chartCard("Breakdown", "Where your scheduled connections stand",
              splitBarHtml(counts), "chart-card-wide")
        : "")
      + '<section id="upcomingMeetings" class="card chart-card upcoming-slot"></section>'
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
    // Renders from cache immediately; the background sync refreshes it.
    renderUpcomingMeetings();
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
      return [c.name, c.role, c.company, c.industry, c.notes,
              ...(c.emails || []).map((e) => e.address)]
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
      return [c.name, c.role, c.company, c.industry, c.notes,
              ...(c.emails || []).map((e) => e.address)]
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

  let editing = false;

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
    // ORB-52. Falls back to the tier the interval implies, so a contact saved
    // before tiers existed still shows one rather than an empty select.
    const shownTier = effectiveTier(c);
    const tierOptions = TIER_ORDER
      .map((t) => '<option value="' + t + '"' + (shownTier === t ? " selected" : "") + '>'
        + escapeHtml(TIERS[t].label) + '</option>')
      .join("");
    // An interval the tier would not have produced was chosen on purpose — the
    // seasonal mentor you see twice a year, the custom:150 back-fills. Showing
    // the control expanded means a deliberate override is never hidden from the
    // person who made it.
    const isOverridden = (c.followUpFrequency || "none") !== frequencyForTier(shownTier);
    const pastCompanies = (c.companyHistory || []).filter((co) => co !== c.company);

    root.innerHTML =
      '<a href="contacts.html" class="btn btn-secondary back-btn">← Back to My Network</a>'

      // ── Hero: identity on the left, reach-out panel on the right ──────────
      + '<div class="card profile-hero">'
      + (editing
        ? ''
        : '<button class="btn btn-secondary btn-sm profile-edit" id="cpEditBtn" type="button">Edit</button>')
      + '<div class="profile-identity">'
      + '<div class="profile-avatar" aria-hidden="true">' + escapeHtml(initialsFor(c.name)) + '</div>'
      + '<div class="profile-id-text">'
      + (editing
        ? '<input type="text" id="cpNameInput" class="profile-name-input" value="'
          + escapeHtml(c.name) + '" aria-label="Name" />'
        : '<h1 class="profile-name">' + escapeHtml(c.name || "Unnamed") + '</h1>')
      // One line, derived, read-only. Every one of these facts used to appear
      // twice — as a labelled block here AND as an input directly below — which
      // is what made this card long and lopsided. A field that is editable in
      // place does not also need displaying above it; the input IS the display.
      // What is worth keeping at a glance is who this person is, in a sentence.
      + '<p class="profile-role">'
      + (c.role || c.company
        ? escapeHtml([c.role, c.company].filter(Boolean).join(" at "))
        : '<span class="profile-role-empty">Add their role and company below</span>')
      + '</p>'

      // View by default, edit on request. Everything used to be an input all
      // the time, which made a record you mostly read look like a form you were
      // expected to fill in — and made an accidental keystroke an edit.
      + '<div class="inline-edit" id="cpInlineEdit">'
      + (editing
        ? companyDatalist(allContacts, "cpCompanies")
          + industryDatalist(allContacts, "cpIndustries")
          + '<div class="inline-edit-grid">'

          + '<div class="field-group"><label for="cpRole">Role / Title</label>'
          + '<input type="text" id="cpRole" value="' + escapeHtml(c.role) + '" placeholder="Product Manager" /></div>'

          + '<div class="field-group"><label for="cpCompany">Current company</label>'
          + '<input type="text" id="cpCompany" list="cpCompanies" value="' + escapeHtml(c.company) + '" placeholder="Where they work now" /></div>'

          + '<div class="field-group"><label for="cpIndustry">Industry '
          + '<span class="opt-label">(optional)</span></label>'
          + '<input type="text" id="cpIndustry" list="cpIndustries" value="' + escapeHtml(c.industry) + '" placeholder="Technology" /></div>'

          + '<div class="field-group field-multi field-email">'
          + '<div class="field-head"><label>Email</label>'
          + '<button class="field-add" id="cpAddEmail" type="button"'
          + ' aria-label="Add another email address" title="Add another address">+</button></div>'
          + '<div id="cpEmailList" class="email-list">'
          + (c.emails.length
            ? c.emails.map((e, i) => emailRowHtml(e, i)).join("")
            : emailRowHtml(normalizeEmail({ label: "personal" }), 0))
          + '</div></div>'

          + '<div class="field-group field-multi field-past">'
          + '<div class="field-head"><label for="cpAddPast">Past companies</label>'
          + '<button class="field-add" id="cpAddPastBtn" type="button"'
          + ' aria-label="Add a past company" title="Add a past company">+</button></div>'
          + '<div id="cpPastTokens">' + pastTokensHtml(pastCompanies) + '</div>'
          + '<input type="text" id="cpAddPast" list="cpCompanies" placeholder="Add a past company" />'
          + '</div>'

          + '</div>'
          + '<div class="inline-edit-save">'
          + '<button class="btn" id="cpSaveDetailsBtn" type="button">Save</button>'
          + '<button class="btn btn-secondary" id="cpCancelEdit" type="button">Cancel</button>'
          + '<p id="cpSaveDetailsMsg" class="success" aria-live="polite"></p>'
          + '</div>'
        : detailsViewHtml(c, pastCompanies))
      + '</div>'   // .inline-edit
      + '</div>'   // .profile-id-text
      + '</div>'   // .profile-identity

      // Wide horizontal reach-out strip: ring, facts, and controls in one row.
      // A sibling of .profile-identity, not a child — .profile-identity is a
      // flex ROW, so nesting it here put the strip beside the name instead of
      // beneath it and squeezed the details into a ~190px column.
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
      // Tier first, because "what kind of relationship is this" is a question
      // you can answer; "how many days" is one most people cannot (ORB-51).
      // The interval below stays editable as the override.
      + '<div class="field-group"><label for="cpTier">What kind of relationship?</label>'
      + '<select id="cpTier">' + tierOptions + '</select>'
      + '<p class="tiny muted" id="cpTierHint">' + escapeHtml(TIERS[shownTier].hint) + '</p></div>'
      // The result line, so the tier's consequence is visible without a second
      // control competing with it. An interval that does not match the tier's
      // default is an override the user set deliberately, so it opens expanded
      // rather than hiding a disagreement behind a link.
      + '<p class="cadence-result tiny" id="cpCadenceLine">'
      + '<span id="cpCadenceText">' + escapeHtml(cadenceSentence(c.followUpFrequency)) + '</span> '
      + '<button type="button" class="link-btn" id="cpAdjust">Adjust</button></p>'
      + '<div class="field-group' + (isOverridden ? '' : ' hidden') + '" id="cpFreqGroup">'
      + '<label for="cpFrequency">Reach out again?</label>'
      + '<select id="cpFrequency">' + freqOptions + '</select></div>'
      + '<div class="field-group' + (isCustomFreq && isOverridden ? '' : ' hidden') + '" id="cpCustomDaysGroup">'
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
      + noteToolbarHtml()
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

    $("#cpNameInput")?.addEventListener("blur", async (e) => {
      const newName = e.target.value.trim();
      if (!newName) { e.target.value = (await freshContact())?.name || ""; return; }
      await save((cur) => ({ ...cur, name: newName }));
    });

    $("#cpEditBtn")?.addEventListener("click", async () => {
      editing = true;
      await renderPage();
      $("#cpRole")?.focus();
    });

    $("#cpCancelEdit")?.addEventListener("click", async () => {
      // Re-renders from saved state, so cancelling discards rather than keeping
      // whatever was half-typed.
      editing = false;
      await renderPage();
    });

    /** Everything currently typed into the details form. */
    function readDetails() {
      return {
        role: $("#cpRole").value.trim(),
        company: $("#cpCompany").value.trim(),
        industry: $("#cpIndustry").value.trim(),
        emails: readEmailRows()
      };
    }

    /** Applies the form to a contact, moving a replaced company into history. */
    function applyDetails(cur, extraPast = "") {
      const form = readDetails();
      const history = [...(cur.companyHistory || [])];
      if (cur.company && form.company && cur.company !== form.company
          && !history.includes(cur.company)) {
        history.push(cur.company);
      }
      if (extraPast && !history.includes(extraPast)) history.push(extraPast);
      return {
        ...cur,
        role: form.role,
        company: form.company,
        industry: form.industry,
        emails: form.emails,
        // Set explicitly, because leaving the old value in place made the
        // primary address undeletable: normalizeEmails treats an `email` the
        // list does not contain as a new address to promote, so removing the
        // first row put it straight back and the delete looked like it had
        // silently failed. This form owns the whole list, so it owns the
        // primary too.
        email: form.emails[0]?.address || "",
        companyHistory: history
      };
    }

    /**
     * Save what is on screen, and stay where you are.
     *
     * The repeatable fields commit when you leave them rather than waiting for
     * the Save button, because "type an address, click the next field, lose it"
     * is the failure people actually hit — and a `+` you have to find first is
     * a gesture the rest of the form does not ask for.
     *
     * Deliberately does NOT re-render. You are still in the form; rebuilding it
     * under you would take the caret and anything else half-typed with it.
     */
    async function commitDetails(extraPast = "") {
      await save((cur) => applyDetails(cur, extraPast));
      const msg = $("#cpSaveDetailsMsg");
      if (!msg) return;
      // Quiet, and it says what happened. A toast for every field you tab out
      // of would be the app applauding itself.
      msg.textContent = "Saved";
      clearTimeout(commitDetails._timer);
      commitDetails._timer = setTimeout(() => { msg.textContent = ""; }, 2000);
    }

    $("#cpSaveDetailsBtn")?.addEventListener("click", async () => {
      // Whatever is sitting in "Add a past company" counts as typed, the same
      // as every other field. Passing applyDetails bare left extraPast at its
      // default of "" — so a company you typed and then clicked Save on was
      // silently dropped, and only the + button or Enter ever committed it.
      // A form where one field needs a different gesture is a form with a bug.
      await save((cur) => applyDetails(cur, $("#cpAddPast")?.value.trim() || ""));
      editing = false;
      await renderPage();
      showToast("Details saved.");
    });

    /** Reads the rows as typed, so an unsaved edit is never lost on add/remove. */
    function readEmailRows() {
      return [...root.querySelectorAll(".email-row")].map((row) => ({
        label: row.querySelector(".email-kind").value,
        address: row.querySelector(".email-address").value.trim()
      })).filter((e) => e.address);
    }

    function attachEmailListeners() {
      const list = root.querySelector("#cpEmailList");
      if (!list) return;

      root.querySelector("#cpAddEmail")?.addEventListener("click", () => {
        // Rendered from what is on screen rather than from saved state, or
        // adding a row would discard anything typed but not yet saved.
        const current = readEmailRows();
        current.push({ label: "work", address: "" });
        list.innerHTML = current.map((e, i) => emailRowHtml(normalizeEmail(e), i)).join("");
        attachEmailListeners();
        list.querySelector(".email-row:last-child .email-address")?.focus();
      });

      list.querySelectorAll(".email-remove").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.closest(".email-row").remove();
          // An empty list still needs somewhere to type.
          if (!list.querySelector(".email-row")) {
            list.innerHTML = emailRowHtml(normalizeEmail({ label: "personal" }), 0);
            attachEmailListeners();
          }
          // Removing is an edit like any other. Without this, deleting an
          // address and navigating away left it exactly where it was.
          await commitDetails();
        });
      });

      // `change` rather than `blur`: it fires when you leave a field you
      // actually altered, so tabbing through a form you only read does not
      // write to the database on every stop.
      list.querySelectorAll(".email-address, .email-kind").forEach((field) => {
        field.addEventListener("change", () => commitDetails());
      });
    }
    attachEmailListeners();

    /**
     * Commit a past company and show its chip, without rebuilding the form.
     *
     * Only this block is re-rendered. Re-rendering the page instead — which is
     * what this used to do — is fine after a deliberate click on Save, but not
     * when you are simply moving to the next field.
     */
    const addPast = async () => {
      const input = $("#cpAddPast");
      const value = input.value.trim();
      if (!value) return;
      // Saves the rest of the form alongside it, so adding a company never
      // discards something typed above and not yet committed.
      await commitDetails(value);
      input.value = "";

      const slot = $("#cpPastTokens");
      const contact = await freshContact();
      if (slot && contact) {
        slot.innerHTML = pastTokensHtml(
          (contact.companyHistory || []).filter((co) => co !== contact.company)
        );
        wirePastRemovals();
      }
    };

    // Three ways in, because each is something someone will actually do:
    // click +, press Enter, or just move on to the next field.
    $("#cpAddPastBtn")?.addEventListener("click", addPast);
    $("#cpAddPast")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addPast(); } });
    $("#cpAddPast")?.addEventListener("change", addPast);

    function wirePastRemovals() {
      root.querySelectorAll("[data-remove-company]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const target = btn.dataset.removeCompany;
          await save((cur) => ({ ...cur, companyHistory: cur.companyHistory.filter((co) => co !== target) }));
          btn.closest(".token-past")?.remove();
        });
      });
    }
    wirePastRemovals();

    const freqSelect = $("#cpFrequency");
    const customGroup = $("#cpCustomDaysGroup");
    const freqGroup = $("#cpFreqGroup");
    const tierSelect = $("#cpTier");

    /** The interval the controls currently describe, in stored form. */
    const chosenFrequency = () => {
      if (freqSelect.value !== "custom") return freqSelect.value;
      const days = parseInt($("#cpCustomDays")?.value, 10);
      return (!Number.isNaN(days) && days > 0) ? "custom:" + days : "none";
    };
    const refreshCadenceLine = () => {
      $("#cpCadenceText").textContent = cadenceSentence(chosenFrequency());
    };

    freqSelect.addEventListener("change", () => {
      customGroup.classList.toggle("hidden", freqSelect.value !== "custom");
      refreshCadenceLine();
    });
    $("#cpCustomDays")?.addEventListener("input", refreshCadenceLine);

    // The override is one click away rather than a second question competing
    // with the first. Once open it stays open — hiding a control someone just
    // asked for would be worse than the clutter it was meant to avoid.
    $("#cpAdjust").addEventListener("click", () => {
      freqGroup.classList.remove("hidden");
      customGroup.classList.toggle("hidden", freqSelect.value !== "custom");
      freqSelect.focus();
    });

    // Picking a tier fills in that tier's interval. The two are not locked
    // together: the tier is what the relationship is, the interval is what is
    // realistic for it — a close mentor you can only reach twice a year is a
    // mentor on a long interval, not a lesser tier.
    tierSelect.addEventListener("change", () => {
      const preset = frequencyForTier(tierSelect.value);
      $("#cpTierHint").textContent = TIERS[tierSelect.value]?.hint || "";
      if (preset.startsWith("custom:")) {
        freqSelect.value = "custom";
        if (!freqGroup.classList.contains("hidden")) customGroup.classList.remove("hidden");
        const daysEl = $("#cpCustomDays");
        if (daysEl) daysEl.value = preset.slice(7);
      } else {
        freqSelect.value = preset;
        customGroup.classList.add("hidden");
      }
      refreshCadenceLine();
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
          // Saved even when it matches what the interval already implied —
          // pressing Save is the user answering the question, and ORB-57
          // measures how many answered it rather than took the default.
          tier: tierSelect.value,
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

    // Third notes box, same treatment — logging from the profile should not be
    // the one place formatting is missing.
    const intNotesEl = $("#cpIntNotes");
    if (intNotesEl) wireNoteToolbar(intNotesEl.closest(".field-group"), intNotesEl);

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
    // One dialog does both (ORB-64). Delete lives inside it, so removing a
    // conversation now takes opening the thing you are about to destroy.
    //
    // Deleting is confirmed rather than undoable: unlike a reach-out, a
    // conversation carries notes you cannot reconstruct, and an undo toast that
    // vanishes after eight seconds is a poor guardian of the only copy.
    root.querySelectorAll("[data-edit-convo]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.editConvo;
        const current = await freshContact();
        const item = (current?.interactions || []).find((i) => i.id === id);
        if (!item) return;

        openConversationEditor(item, {
          title: item.title || (item.type
            ? item.type.charAt(0).toUpperCase() + item.type.slice(1)
            : "Conversation") + " · " + formatDate(item.date),

          onSubmit: async ({ date, type, notes, file }) => {
            // Upload first, but never let it cost the notes: a failed
            // attachment still saves the text and says so.
            let newFileId = null;
            let attachmentFailed = false;
            if (file) {
              const uploaded = await db.uploadFileToStorage(file, { contactId });
              if (uploaded) newFileId = uploaded.id;
              else attachmentFailed = true;
            }

            await save((cur) => {
              const next = (cur.interactions || []).map((i) =>
                i.id === id
                  ? normalizeInteraction({
                      ...i, date: date || i.date, type, notes,
                      fileIds: newFileId ? [...(i.fileIds || []), newFileId] : (i.fileIds || [])
                    })
                  : i);
              // The date is editable here, so the most recent conversation can
              // change identity on save — the same recalculation delete needs.
              const newest = [...next].sort((a, b) => b.date.localeCompare(a.date))[0];
              return {
                ...cur,
                interactions: next,
                lastContacted: newest ? newest.date : (cur.dateMet || ""),
                nextReminder: !cur.reminderEnabled || cur.followUpFrequency === "none"
                  ? cur.nextReminder
                  : calculateNextReminder(
                      newest ? newest.date : (cur.dateMet || todayDateString()),
                      cur.followUpFrequency)
              };
            });
            await renderPage();
            showToast(attachmentFailed
              ? "Saved — the file could not be attached."
              : newFileId ? "Conversation and transcript saved." : "Conversation saved.");
          },

          onDelete: async () => {
            await save((cur) => {
              const kept = (cur.interactions || []).filter((i) => i.id !== id);
              const newest = [...kept].sort((a, b) => b.date.localeCompare(a.date))[0];
              return {
                ...cur,
                interactions: kept,
                // Removing the most recent conversation has to move the
                // relationship back to whatever is now newest, or the health
                // bar keeps counting from a touchpoint that no longer exists.
                lastContacted: newest ? newest.date : (cur.dateMet || ""),
                nextReminder: !cur.reminderEnabled || cur.followUpFrequency === "none"
                  ? cur.nextReminder
                  : calculateNextReminder(
                      newest ? newest.date : (cur.dateMet || todayDateString()),
                      cur.followUpFrequency)
              };
            });
            await renderPage();
            showToast("Conversation deleted.");
          }
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
      err.textContent = "Photo uploaded, but avatar_url needs supabase/migrations/004_settings_columns.sql first.";
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

// ── Integrations tab (ORB-34) ─────────────────────────────────────────────────

/** Relative time that stays readable without a library. */
function timeAgo(ms) {
  if (!ms) return "never";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + (mins === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  return days + (days === 1 ? " day ago" : " days ago");
}

/**
 * Four states, not two.
 *
 * "Connected or not" could not describe the one that happens most: you
 * connected weeks ago, the grant expired, and nothing works until you click
 * again. Calling that connected is how this screen previously reported a
 * healthy calendar it could not read.
 */
function calendarCardHtml({ connecting = false } = {}) {
  const state = connecting ? "connecting" : calendar.getConnectionState();
  const run = calendar.lastRun();
  const synced = calendar.lastSyncedAt();

  const meta = {
    disconnected: { pill: "Not connected", tone: "idle" },
    connecting:   { pill: "Connecting…",   tone: "busy" },
    connected:    { pill: "Connected",     tone: "ok" },
    "needs-reauth": { pill: "Needs re-authorising", tone: "warn" }
  }[state];

  const status = state === "connected"
    ? 'Checked ' + escapeHtml(timeAgo(synced)) + '. Orbit looks again every few hours.'
    : state === "needs-reauth"
      ? 'Google expired the permission, which it does about weekly for apps in testing. '
        + 'One click puts it back.'
      : state === "connecting"
        ? 'Waiting for Google…'
        : 'Find the meetings you already had with people in your network.';

  const actions = state === "connected"
    ? '<button class="btn btn-sm" id="calSyncBtn" type="button">Sync now</button>'
      + '<button class="btn btn-secondary btn-sm" id="calDisconnectBtn" type="button">Disconnect</button>'
    : state === "needs-reauth"
      ? '<button class="btn btn-sm" id="calSyncBtn" type="button">Reconnect</button>'
        + '<button class="btn btn-secondary btn-sm" id="calDisconnectBtn" type="button">Remove</button>'
      : '<button class="btn btn-sm" id="calSyncBtn" type="button"'
        + (connecting ? ' disabled' : '') + '>'
        + (connecting ? 'Connecting…' : 'Connect') + '</button>';

  return '<article class="int-card int-' + meta.tone + '">'
    + '<div class="int-head">'
    + googleCalendarMark()
    + '<div class="int-title">'
    + '<p class="int-name">Google Calendar</p>'
    + '<p class="int-status">' + status + '</p>'
    + '</div>'
    + '<span class="int-pill int-pill-' + meta.tone + '">' + escapeHtml(meta.pill) + '</span>'
    + '</div>'
    + (run && state === "connected"
      ? '<p class="int-lastrun">Last run: '
        + (run.logged
          ? run.logged + (run.logged === 1 ? ' conversation logged' : ' conversations logged')
          : 'nothing new to log')
        + '</p>'
      : '')
    + '<p id="calMsg" class="success" aria-live="polite"></p>'
    + '<p id="calErr" class="error" aria-live="polite"></p>'
    + '<div class="int-actions">' + actions + '</div>'
    + '<details class="int-details">'
    + '<summary>How it works, and what it can see</summary>'
    + '<ul class="settings-list">'
    + '<li><strong>Read-only.</strong> Orbit cannot create, change or delete anything '
    + 'on your calendar. Google enforces that, not us.</li>'
    + '<li><strong>No token is ever stored.</strong> It lives in this tab and is gone '
    + 'when you close it. Meeting titles for "Coming up" are cached on this device; '
    + 'disconnecting clears them.</li>'
    + '<li><strong>You confirm every entry.</strong> A meeting on a calendar is not '
    + 'proof you spoke, and logging one moves that person&#39;s next reach-out date.</li>'
    + '<li><strong>Matched by email</strong>, so only connections whose email you have '
    + 'saved can be found.</li>'
    + '</ul>'
    + '</details>'
    + '</article>';
}

/**
 * Renders the cards and wires them, in one place so every state change can
 * simply re-render rather than trying to patch the DOM it came from.
 */
function renderIntegrationCards(root, { connecting = false } = {}) {
  if (!root) return;
  root.innerHTML = calendarCardHtml({ connecting });
  // "Evaluate on app load and after every integration state change."
  evaluateIntegrationsNav();

  const msg = root.querySelector("#calMsg");
  const err = root.querySelector("#calErr");

  root.querySelector("#calSyncBtn")?.addEventListener("click", async () => {
    msg.textContent = ""; err.textContent = "";
    renderIntegrationCards(root, { connecting: true });
    try {
      const contacts = (await db.getContacts()) || [];
      if (!contacts.some((c) => (c.email || "").trim())) {
        renderIntegrationCards(root);
        root.querySelector("#calErr").textContent =
          "None of your connections have an email saved, so there is nothing to match "
          + "against. Add emails first.";
        return;
      }

      const candidates = await calendar.connectCalendar(contacts, todayDateString());
      await persistCalendarConnection();
      calendar.markSynced(Date.now());

      if (!candidates.length) {
        calendar.recordRun({ found: 0, logged: 0 });
        renderIntegrationCards(root);
        root.querySelector("#calMsg").textContent =
          "Nothing new in the last " + calendar.LOOKBACK_DAYS + " days.";
        return;
      }
      openCalendarReviewModal(candidates, contacts);
    } catch (error) {
      renderIntegrationCards(root);
      root.querySelector("#calErr").textContent = String(error.message || error);
    }
  });

  root.querySelector("#calDisconnectBtn")?.addEventListener("click", () => {
    calendar.disconnectCalendar();
    persistCalendarConnection();
    renderIntegrationCards(root);
    showToast("Google Calendar disconnected. No token was stored, so there is nothing else to clear.");
  });
}

/**
 * The Google Calendar mark.
 *
 * onerror swaps in the emoji, so a missing or renamed file degrades to what was
 * there before rather than a broken-image icon. The filename has a space in it,
 * hence the encoding.
 */
function googleCalendarMark(cls = "int-icon") {
  return '<img class="' + cls + ' gcal-mark" src="assets/google%20calendar.png"'
    + ' alt="" width="24" height="24" loading="lazy"'
    + ' onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),'
    + '{className:\'' + cls + '\',textContent:\'📅\'}))" />';
}

// ── Integrations in Settings (ORB-36) ─────────────────────────────────────────

/**
 * Management, as opposed to ORB-34's discovery.
 *
 * Present in every state, on purpose. The nav entry point disappears once
 * everything is connected, so if this were conditional too there would be
 * moments — a broken token, a wrong calendar — with nowhere at all to go.
 */
function renderSettingsIntegrations(root, calendars = null) {
  if (!root) return;

  const state = calendar.getConnectionState();
  const account = calendar.getConnectedAccount();
  const synced = calendar.lastSyncedAt();
  const selected = calendar.getSelectedCalendarId();

  const label = {
    disconnected: "Not connected",
    connected: "Connected",
    "needs-reauth": "Needs re-authorising"
  }[state];

  root.innerHTML = '<div class="int-settings">'
    + '<div class="int-head">'
    + googleCalendarMark()
    + '<div class="int-title">'
    + '<p class="int-name">Google Calendar</p>'
    + '<p class="int-status">' + escapeHtml(label)
    + (account ? ' · ' + escapeHtml(account) : '')
    + '</p>'
    + '</div>'
    + '</div>'
    + (state === "disconnected"
      ? '<p class="field-hint">Connect it from <strong>Networking Log → Integrations</strong> '
        + 'in the sidebar.</p>'
      : '<dl class="int-meta">'
        + '<div><dt>Last synced</dt><dd>' + escapeHtml(timeAgo(synced)) + '</dd></div>'
        + '<div><dt>Reading</dt><dd>'
        + (calendars && calendars.length
          ? '<select id="intCalendarPick">'
            + calendars.map((c) => '<option value="' + escapeHtml(c.id) + '"'
              + (c.id === selected ? ' selected' : '') + '>'
              + escapeHtml(c.name) + (c.primary ? ' (main)' : '') + '</option>').join("")
            + '</select>'
          : '<button class="link-btn" id="intLoadCalendars" type="button">'
            + escapeHtml(selected === "primary" ? "Main calendar" : selected)
            + ' — change</button>')
        + '</dd></div>'
        + '</dl>')
    + '<p id="intSettingsMsg" class="success" aria-live="polite"></p>'
    + '<p id="intSettingsErr" class="error" aria-live="polite"></p>'
    + (state === "disconnected" ? '' : '<div class="int-actions">'
      + '<button class="btn btn-secondary btn-sm" id="intReauth" type="button">'
      + (state === "needs-reauth" ? "Re-authorise" : "Re-authorise") + '</button>'
      + '<button class="btn btn-secondary btn-sm int-danger" id="intDisconnect" type="button">'
      + 'Disconnect</button>'
      + '</div>')
    + '</div>';

  const msg = root.querySelector("#intSettingsMsg");
  const err = root.querySelector("#intSettingsErr");

  root.querySelector("#intLoadCalendars")?.addEventListener("click", async () => {
    err.textContent = "";
    try {
      const list = await calendar.refreshAccountInfo();
      if (!list.length) throw new Error("Could not read your calendar list.");
      renderSettingsIntegrations(root, list);
    } catch (e) {
      err.textContent = String(e.message || e) + " Try Re-authorise first.";
    }
  });

  root.querySelector("#intCalendarPick")?.addEventListener("change", (e) => {
    calendar.setSelectedCalendarId(e.target.value);
    persistCalendarConnection();
    msg.textContent = "Saved. The next sync reads that calendar.";
  });

  root.querySelector("#intReauth")?.addEventListener("click", async () => {
    msg.textContent = ""; err.textContent = "";
    try {
      const contacts = (await db.getContacts()) || [];
      const candidates = await calendar.connectCalendar(contacts, todayDateString());
      await persistCalendarConnection();
      await calendar.refreshAccountInfo();
      calendar.markSynced(Date.now());
      renderSettingsIntegrations(root);
      if (candidates.length) {
        document.getElementById("settingsModal")?.remove();
        openCalendarReviewModal(candidates, contacts);
      } else {
        root.querySelector("#intSettingsMsg").textContent = "Re-authorised. Nothing new to log.";
      }
    } catch (e) {
      err.textContent = String(e.message || e);
    }
  });

  root.querySelector("#intDisconnect")?.addEventListener("click", () => {
    openDisconnectModal(root);
  });
}

/**
 * Disconnecting asks what to do with what the calendar logged.
 *
 * Defaulting to keep, because those conversations are real history — you had
 * those meetings — and deleting them as a side effect of unlinking a calendar
 * is not recoverable. Removing them is offered because someone who connected
 * the wrong account wants the mess gone, and hunting them down by hand is
 * worse.
 */
function openDisconnectModal(settingsRoot) {
  document.getElementById("disconnectModal")?.remove();

  const modal = document.createElement("div");
  modal.id = "disconnectModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card">'
    + '<div class="quick-add-header"><h3>Disconnect Google Calendar</h3>'
    + '<button class="icon-btn" id="dcClose" type="button" aria-label="Close">✕</button></div>'
    + '<p class="muted">Orbit will stop reading your calendar. '
    + 'What should happen to the conversations it logged?</p>'
    + '<div class="cal-clash-choices" role="radiogroup" aria-label="Logged conversations">'
    + '<label><input type="radio" name="dcKeep" value="keep" checked /> '
    + '<span><strong>Keep them.</strong> Those meetings happened — the record stays.</span></label>'
    + '<label><input type="radio" name="dcKeep" value="remove" /> '
    + '<span><strong>Remove them.</strong> Deletes every conversation the calendar '
    + 'created, along with any notes you added to them. This cannot be undone.</span></label>'
    + '</div>'
    + '<p id="dcCount" class="tiny muted"></p>'
    + '<div class="modal-actions">'
    + '<button class="btn int-danger" id="dcConfirm" type="button">Disconnect</button>'
    + '<button class="btn btn-secondary" id="dcCancel" type="button">Cancel</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector("#dcClose").addEventListener("click", close);
  modal.querySelector("#dcCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  // Name the cost before it is chosen, not after.
  db.getContacts().then((contacts) => {
    const n = (contacts || []).reduce((total, c) =>
      total + (c.interactions || []).filter((i) => i.sourceEventId).length, 0);
    const el = modal.querySelector("#dcCount");
    if (el) {
      el.textContent = n
        ? n + (n === 1 ? " conversation was" : " conversations were") + " logged from your calendar."
        : "Nothing has been logged from your calendar yet.";
    }
  });

  modal.querySelector("#dcConfirm").addEventListener("click", async (e) => {
    const remove = modal.querySelector('input[name="dcKeep"]:checked')?.value === "remove";
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Disconnecting…";

    let removed = 0;
    if (remove) {
      const contacts = (await db.getContacts()) || [];
      for (const c of contacts) {
        const kept = (c.interactions || []).filter((i) => !i.sourceEventId);
        if (kept.length === (c.interactions || []).length) continue;
        removed += (c.interactions || []).length - kept.length;
        const newest = [...kept].sort((a, b) => b.date.localeCompare(a.date))[0];
        await db.saveContact(normalizeContact({
          ...c,
          interactions: kept,
          // Health has to stop counting from a touchpoint that no longer exists.
          lastContacted: newest ? newest.date : (c.dateMet || ""),
          nextReminder: !c.reminderEnabled || c.followUpFrequency === "none"
            ? c.nextReminder
            : calculateNextReminder(newest ? newest.date : (c.dateMet || todayDateString()),
                                    c.followUpFrequency)
        }));
      }
    }

    calendar.disconnectCalendar();
    persistCalendarConnection();
    close();
    // Disconnecting is the ONE path that brings the nav entry point back.
    evaluateIntegrationsNav();
    renderSettingsIntegrations(settingsRoot);
    showToast(remove
      ? "Disconnected. " + removed + (removed === 1 ? " conversation removed." : " conversations removed.")
      : "Disconnected. Your logged conversations were kept.");
  });
}

/**
 * The nav entry point (ORB-34).
 *
 * A discovery affordance, not a menu item. It appears only while something is
 * still unconnected and disappears once everything is — because once you have
 * connected a calendar, a permanent link to "connect a calendar" is clutter.
 *
 * It deliberately does NOT come back when a token expires or a sync fails.
 * Those are a working connection needing a nudge, and resurfacing this every
 * time Google expires a grant would turn discovery into a recurring error
 * badge. A broken connection announces itself on the dashboard card (ORB-35);
 * the only route back here is an explicit disconnect (ORB-36).
 *
 * The rule reads the COUNT of unconnected integrations rather than asking about
 * Google Calendar by name, so a second integration needs no change here.
 */
// ── The calendar connection follows the account (ORB-39) ──────────────────────

const CALENDAR_INTEGRATION = "google-calendar";

/**
 * Write this device's connection state up to `preferences`.
 *
 * Called after every deliberate connect, disconnect or calendar change — not on
 * a timer — so the stored record always reflects a decision somebody made
 * rather than whichever tab happened to load last.
 *
 * A disconnect stores `connected: false` instead of removing the entry. The
 * difference matters: "no record" means nobody has ever connected, while
 * "connected: false" means someone deliberately disconnected. Deleting the key
 * would collapse the two, and the next device to load with a stale localStorage
 * would helpfully push the connection back up — the same resurrection bug that
 * made a deleted email address reappear.
 */
async function persistCalendarConnection() {
  const snapshot = calendar.connectionSnapshot() || { connected: false };
  try {
    const prefs = (await db.getPreferences()) || {};
    const integrations = { ...(prefs.integrations || {}) };
    integrations[CALENDAR_INTEGRATION] = snapshot;
    const result = await db.savePreferences({ integrations });
    if (result.skipped?.includes("integrations")) {
      console.warn("[calendar] preferences.integrations is missing, so this "
        + "connection stays on this device only. Run supabase/migrations/010_integrations.sql");
    }
  } catch (err) {
    // Never fatal. Failing to record the connection costs you a reconnect on
    // your next device; throwing here would cost you the connection itself.
    console.warn("[calendar] Could not save the connection to your account.", err);
  }
}

/**
 * Reconcile this browser against the account, once, at boot.
 *
 * The stored record wins on the question of whether you are connected, because
 * that is an account-level fact. Everything else is merged rather than
 * overwritten — see connectionSnapshot() in calendar.js for what is shared and
 * what is deliberately kept per-device.
 */
async function adoptCalendarConnection() {
  let prefs;
  try { prefs = await db.getPreferences(); } catch { return; }
  const stored = prefs?.integrations?.[CALENDAR_INTEGRATION] || null;
  const local = calendar.connectionSnapshot();

  if (stored?.connected) {
    if (calendar.adoptConnection(stored)) evaluateIntegrationsNav();
    return;
  }
  // An explicit disconnect elsewhere ends the connection here too.
  if (stored && stored.connected === false && local) {
    // No write back. The record already says disconnected — echoing it would
    // be a device reporting news it just received.
    calendar.disconnectCalendar();
    evaluateIntegrationsNav();
    return;
  }
  // No record at all: this device connected before the account started keeping
  // one. Carry it up so the next device inherits it.
  if (!stored && local) await persistCalendarConnection();
}

function evaluateIntegrationsNav() {
  const show = calendar.countNotConnected() > 0;
  // A body class rather than the hidden attribute, so the inline script can set
  // the same thing before first paint and this only ever confirms it. Setting
  // `hidden` here meant the item flashed on or off after every page load.
  document.body.classList.toggle("nav-integrations", show);

  // Someone sitting on the page when the last integration connects should not
  // be stranded on a route that is no longer in the nav.
  if (!show && document.body.dataset.page === "integrations") {
    const note = document.getElementById("integrationsAllDone");
    if (note) note.hidden = false;
  }
}

/** The Integrations page (ORB-34). Discovery only — management lives in Settings. */
async function initIntegrationsPage() {
  const root = document.getElementById("integrationCards");
  if (!root) return;
  renderIntegrationCards(root);
  window.__orbitRefresh = () => renderIntegrationCards(root);
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

  const result = await calendar.silentSync(contacts, todayDateString());
  // Stamped on the ATTEMPT, not on success. Only stamping successes meant a
  // failing sync never backed off: autoSyncDue stayed true, so every page load
  // retried, and every retry asked Google for a token — which is a popup on
  // every single refresh. A backoff that only applies when things are working
  // is not a backoff.
  calendar.markSynced(now);

  const candidates = result?.candidates ?? null;
  if (result) renderUpcomingMeetings();

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
            await persistCalendarConnection();
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

  // Two different moments, two different interruptions. A conversation that
  // finished today is asked about directly — that is the minute you remember
  // what was said, and a toast you can miss wastes it. A month of backlog gets
  // a line you can ignore, because a modal over twenty old meetings is an
  // ambush. Nothing is dropped either way: the dialog lists everything found.
  if (calendar.justEnded(candidates, now).length) {
    openCalendarReviewModal(candidates, contacts, { justHappened: true });
    return;
  }

  showToast(candidates.length + (candidates.length === 1
    ? " meeting found on your calendar." : " meetings found on your calendar."), {
    actionLabel: "Review",
    duration: 10000,
    onAction: () => openCalendarReviewModal(candidates, contacts)
  });
}

// ── Upcoming meetings widget ──────────────────────────────────────────────────

/**
 * What is ahead, paired with what you meant to bring up.
 *
 * The rest of the dashboard is about people you are neglecting. This is the
 * other half: the conversation you are about to have, and the talking points
 * that would otherwise sit unread on a profile until after it.
 *
 * Rendered from the localStorage cache so it appears immediately, then replaced
 * when a sync completes. Waiting on Google before showing a dashboard would be
 * a worse trade than briefly showing a slightly stale list.
 */
function renderUpcomingMeetings() {
  const slot = document.getElementById("upcomingMeetings");
  if (!slot) return;

  // ORB-35: only in connected or needs-reauth. Hidden until a connection
  // exists, because a sync button for a calendar you never linked is noise.
  const connection = calendar.getConnectionState();
  if (connection === calendar.DISCONNECTED) { slot.innerHTML = ""; slot.hidden = true; return; }
  slot.hidden = false;

  // ORB-35: a sync button is only trustworthy next to evidence it ran. The
  // timestamp says when, and the count says whether it did anything — a run
  // that found four meetings and logged none did nothing, and reporting "4"
  // would flatter it.
  const state = connection;
  const run = calendar.lastRun();

  // An expired Google grant is not a broken integration, it is a sign-in that
  // lapsed — Google expires them about weekly for apps still in testing. So the
  // button stays "Sync now" in both states and re-authorising happens inside it:
  // connectCalendar() already prompts when the token is gone, and the sync it
  // was asked for runs straight afterwards. Announcing "nothing is syncing" and
  // sending you to Settings made a routine re-login look like a fault.
  //
  // The state is still stated, quietly, because "Synced 3 days ago" on its own
  // would imply it is still running when it is not.
  const syncBar = '<div class="sync-bar">'
    + '<span class="sync-source">' + googleCalendarMark("sync-mark")
    + '<span>Google Calendar</span></span>'
    + '<span class="sync-status">'
    + 'Synced ' + escapeHtml(timeAgo(calendar.lastSyncedAt()))
    + (state === "needs-reauth"
      ? ' <span class="muted">· sign in again to pick up anything new</span>'
      : (run && run.logged
        ? ' · ' + run.logged + (run.logged === 1 ? ' conversation' : ' conversations') + ' logged'
        : ''))
    + '</span>'
    + '<button class="btn btn-secondary btn-sm" id="dashSyncBtn" type="button">Sync now</button>'
    + '</div>';

  // No slice. The old cap of 5 existed only because the card grew with the
  // list and a long week wrecked the dashboard row; the list scrolls within a
  // fixed height now, so dropping meetings on the floor buys nothing.
  const items = calendar.readUpcoming();
  if (!items.length) {
    slot.innerHTML = '<h3 class="chart-title">Coming up</h3>'
      + '<p class="chart-sub muted">Next ' + calendar.UPCOMING_DAYS + ' days</p>'
      + syncBar
      + '<p class="empty upcoming-empty">Nothing scheduled with anyone in your network.</p>';
    wireDashboardSync(slot);
    return;
  }

  const now = Date.now();
  const rows = items.map((item) => {
    const who = item.people.map((p) => escapeHtml(p.name)).join(", ");
    const points = item.people.flatMap((p) => p.talkingPoints || []);
    // A meeting stays on this list until it ends, so some of them are happening
    // right now. "Today · 9:30 AM" for something you are already in the middle
    // of reads as a thing you might still miss.
    const inProgress = new Date(item.iso).getTime() <= now
      && new Date(item.endIso || item.iso).getTime() >= now;
    return '<li class="upcoming-row' + (inProgress ? ' upcoming-now' : '') + '">'
      + '<div class="upcoming-when">'
      + '<span class="upcoming-day">'
      // Lower case to sit beside "today" and "tomorrow", which is what the
      // other rows in this column say.
      + (inProgress ? "now" : escapeHtml(relativeDayLabel(item.date))) + '</span>'
      + '<span class="tiny muted">' + escapeHtml(item.time) + '</span>'
      + '</div>'
      + '<div class="upcoming-main">'
      + '<p class="upcoming-title">' + escapeHtml(item.title) + '</p>'
      + '<p class="tiny muted">' + who + '</p>'
      + (item.medium.url
        ? '<a class="upcoming-link" href="' + escapeHtml(item.medium.url)
          + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.medium.label) + ' →</a>'
        : '<span class="tiny muted">' + escapeHtml(item.medium.label) + '</span>')
      + (points.length
        ? '<ul class="upcoming-points">'
          + points.map((t) => '<li>' + escapeHtml(t) + '</li>').join("")
          + '</ul>'
        : '')
      + '</div>'
      + '</li>';
  }).join("");

  slot.innerHTML = '<h3 class="chart-title">Coming up'
    + (items.length > 1 ? '<span class="chart-count">' + items.length + '</span>' : '')
    + '</h3>'
    + '<p class="chart-sub muted">And what you wanted to raise</p>'
    + syncBar
    + '<ul class="upcoming-list">' + rows + '</ul>';
  wireUpcomingScroll(slot.querySelector(".upcoming-list"));
  wireDashboardSync(slot);
}

/**
 * The fade at the bottom of the list, on only while there is more to see.
 *
 * Applied from JS rather than always-on in CSS because a permanent fade over a
 * list that fits is just a washed-out last row, and a fade that stays at the
 * bottom of the scroll keeps promising content that has run out.
 */
function wireUpcomingScroll(list) {
  if (!list) return;
  const update = () => {
    const scrollable = list.scrollHeight > list.clientHeight + 1;
    list.classList.toggle("is-scrollable", scrollable);
    list.classList.toggle("at-end",
      !scrollable || list.scrollTop + list.clientHeight >= list.scrollHeight - 2);
  };
  list.addEventListener("scroll", update, { passive: true });
  update();
  // Layout is not settled on the first pass — the card is still being sized by
  // its row — so the initial measurement can be taken against the wrong height.
  requestAnimationFrame(update);
}

/** The Sync now button (ORB-35). Same path as Settings, fewer clicks away. */
function wireDashboardSync(slot) {
  const btn = slot.querySelector("#dashSyncBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const contacts = (await db.getContacts()) || [];
      const candidates = await calendar.connectCalendar(contacts, todayDateString());
      await persistCalendarConnection();
      calendar.markSynced(Date.now());

      if (!candidates.length) {
        calendar.recordRun({ found: 0, logged: 0 });
        renderUpcomingMeetings();
        showToast("Calendar checked — nothing new in the last "
          + calendar.LOOKBACK_DAYS + " days.");
        return;
      }
      openCalendarReviewModal(candidates, contacts);
    } catch (error) {
      showToast(String(error.message || error));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
      renderUpcomingMeetings();
    }
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
function openCalendarReviewModal(candidates, contacts, { justHappened = false } = {}) {
  document.getElementById("calReviewModal")?.remove();

  // What this dialog is FOR changes with when the meetings happened, so the
  // heading does too. "3 meetings found" is a report; "How did it go with
  // Marcus?" is a question — and a question is what gets notes written.
  const fresh = calendar.justEnded(candidates);
  const names = [...new Set(fresh.map((c) => c.contactName))];
  const heading = !justHappened || !fresh.length
    ? candidates.length + (candidates.length === 1 ? " meeting found" : " meetings found")
    : names.length === 1
      ? "How did it go with " + escapeHtml(names[0]) + "?"
      : "How did those conversations go?";
  const intro = justHappened && fresh.length
    ? "Just finished. Add what you talked about while it is fresh — that is the part "
      + "you will want later. Untick anything you would rather not log."
    : "Untick anything you would rather not log. Logging one moves that person to "
      + "the back of your reach-out queue.";

  // The notes box is here rather than only on the profile because this is the
  // moment you actually remember the meeting. A synced conversation whose notes
  // are just the event title is a record that it happened, not what was said —
  // and the substance is the part Orbit exists to keep.
  // Open the box for the meeting we are asking about. Asking "how did it go?"
  // and then hiding the answer behind "+ Add notes" is a question with no
  // visible place to reply.
  const freshIds = new Set(justHappened ? fresh.map((c) => c.eventId) : []);

  const rows = candidates.map((c, i) => {
    const clash = c.existing;
    const openNotes = freshIds.has(c.eventId) && !clash;
    // A candidate landing on a day you already wrote about is not a duplicate
    // Orbit can resolve on its own — only you know whether they were the same
    // conversation. So it is unticked, flagged, and offers the three answers
    // that actually exist.
    const clashHtml = clash
      ? '<div class="cal-clash">'
        + '<p class="cal-clash-head">You already logged something with '
        + escapeHtml(c.contactName) + ' on ' + formatDate(c.date) + ':</p>'
        + '<p class="cal-clash-quote">'
        + escapeHtml(stripNoteMarks(clash.notes || "(no notes)").split("\n")[0].slice(0, 140))
        + '</p>'
        + '<div class="cal-clash-choices" role="radiogroup"'
        + ' aria-label="What to do with ' + escapeHtml(c.title) + '">'
        + '<label><input type="radio" name="clash' + i + '" value="skip" checked />'
        + ' Same conversation — skip it</label>'
        + '<label><input type="radio" name="clash' + i + '" value="merge" />'
        + ' Same conversation — add the meeting title to what I wrote</label>'
        + '<label><input type="radio" name="clash' + i + '" value="add" />'
        + ' Different conversation — log it separately</label>'
        + '</div>'
        + '</div>'
      : '';

    return '<li class="cal-row' + (clash ? ' cal-row-clash' : '') + '">'
      + '<label class="cal-check">'
      + '<input type="checkbox" class="cal-pick" data-index="' + i + '"'
      + (clash ? '' : ' checked') + ' />'
      + '<span class="cal-row-main">'
      + '<span class="cal-row-title">' + escapeHtml(c.title) + '</span>'
      + '<span class="tiny muted">' + escapeHtml(c.contactName) + ' · '
      + formatDate(c.date) + ' · ' + escapeHtml(c.type)
      + (clash ? ' · <strong>already logged that day</strong>' : '') + '</span>'
      + '</span>'
      + '</label>'
      + clashHtml
      + '<div class="cal-notes-wrap">'
      + '<button class="cal-notes-toggle" type="button" data-notes-for="' + i + '">'
      + (openNotes ? '− Hide notes' : '+ Add notes') + '</button>'
      + '<textarea class="cal-notes" data-notes-index="' + i + '" rows="3"'
      + (openNotes ? '' : ' hidden')
      + ' placeholder="What did you talk about? What should you bring up next time?"></textarea>'
      // A synced meeting is exactly when a transcript exists — Meet has just
      // produced one. Making you log first and attach later, from the profile,
      // is the trip this dialog is supposed to save.
      + '<div class="cal-attach" data-attach-index="' + i + '"'
      + (openNotes ? '' : ' hidden') + '>'
      + '<label class="tiny muted" for="calFile' + i + '">Transcript or PDF, if you have one</label>'
      + '<input type="file" id="calFile' + i + '" class="cal-file"'
      + ' data-file-index="' + i + '" accept="' + ATTACH_ACCEPT + '" /></div>'
      + '</div>'
      + '</li>';
  }).join("");

  const modal = document.createElement("div");
  modal.id = "calReviewModal";
  modal.className = "modal-overlay";
  modal.innerHTML = '<div class="modal-card quick-add-card">'
    + '<div class="quick-add-header">'
    + '<h3>' + heading + '</h3>'
    + '<button class="icon-btn" id="calReviewClose" type="button" aria-label="Close">✕</button>'
    + '</div>'
    + '<p class="muted">' + intro + '</p>'
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
      const attach = modal.querySelector('[data-attach-index="' + toggle.dataset.notesFor + '"]');
      area.hidden = !area.hidden;
      if (attach) attach.hidden = area.hidden;
      toggle.textContent = area.hidden ? "+ Add notes" : "− Hide notes";
      if (!area.hidden) area.focus();
    });
  });

  // Asked once, then remembered — a confirmation you cannot get past is a
  // different bug from the one being fixed.
  let blankNotesConfirmed = false;

  modal.querySelector("#calReviewSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const errEl = modal.querySelector("#calReviewErr");
    errEl.textContent = "";

    const picked = [...modal.querySelectorAll(".cal-pick:checked")]
      .map((el) => {
        const index = Number(el.dataset.index);
        const typed = modal.querySelector('[data-notes-index="' + index + '"]')?.value.trim() || "";
        const choice = modal.querySelector('input[name="clash' + index + '"]:checked')?.value || "add";
        const file = modal.querySelector('[data-file-index="' + index + '"]')?.files?.[0] || null;
        return { ...candidates[index], notes: typed, resolution: choice, file, index };
      })
      .filter((c) => c.resolution !== "skip");
    if (!picked.length) { close(); return; }

    const badFile = picked.find((c) => c.file && !isAllowedAttachment(c.file));
    if (badFile) {
      errEl.textContent = "That file type is not supported — PDF or an image.";
      return;
    }

    // The whole point of asking "how did it go?" is the answer. Saving silently
    // when the box is empty turns the question into a rhetorical one and sends
    // you to the profile afterwards to type what you were just asked for.
    // Only on the just-happened prompt: a first sync pulling in a month of old
    // meetings has no notes by nature, and nagging about that is its own chore.
    const blank = picked.filter((c) => !c.notes);
    if (justHappened && blank.length && !blankNotesConfirmed) {
      blankNotesConfirmed = true;
      errEl.innerHTML = '<span class="cal-confirm">'
        + (blank.length === 1
          ? 'No notes on this one yet. '
          : 'No notes on ' + blank.length + ' of these yet. ')
        + 'That is the part you will want later — press Log again to save without them.'
        + '</span>';
      const first = modal.querySelector('[data-notes-index="' + blank[0].index + '"]');
      if (first) {
        const toggle = modal.querySelector('[data-notes-for="' + blank[0].index + '"]');
        const attach = modal.querySelector('[data-attach-index="' + blank[0].index + '"]');
        first.hidden = false;
        if (attach) attach.hidden = false;
        if (toggle) toggle.textContent = "− Hide notes";
        first.focus();
      }
      btn.textContent = "Log without notes";
      return;
    }

    btn.disabled = true;
    btn.textContent = "Logging…";
    const { logged, failed, attachmentsFailed } = await applyCalendarCandidates(picked, contacts);
    close();

    if (!logged) {
      showToast("Could not log those — nothing was changed.");
      return;
    }
    calendar.recordRun({ found: candidates.length, logged });
    showToast(logged + (logged === 1 ? " conversation logged." : " conversations logged.")
      + (failed ? " " + failed + " could not be saved." : "")
      + (attachmentsFailed
        ? " " + attachmentsFailed + (attachmentsFailed === 1 ? " file" : " files")
          + " could not be attached."
        : ""), {
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
  // Counted separately from `failed`: the conversation saved, only the file
  // did not, and reporting that as a failed log would be a lie.
  let attachmentsFailed = 0;

  for (const [contactId, items] of byContact) {
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact) { failed += items.length; continue; }

    // "merge" folds the meeting into the conversation already there instead of
    // creating a second one. It keeps what you wrote and adds the title and the
    // event id, so a later sync recognises it and never offers it again.
    const toMerge = items.filter((i) => i.resolution === "merge" && i.existing);
    const toAdd = items.filter((i) => i.resolution !== "merge" || !i.existing);

    // Attachments go up before the contact is written, so one storage failure
    // costs that transcript and nothing else — the conversation still lands.
    // Keyed by eventId because merge and add both need to find their own file.
    const uploadedFor = new Map();
    for (const item of items) {
      if (!item.file) continue;
      const uploaded = await db.uploadFileToStorage(item.file, { contactId });
      if (uploaded) uploadedFor.set(item.eventId, uploaded.id);
      else attachmentsFailed += 1;
    }

    let interactions = (contact.interactions || []).map((existing) => {
      const match = toMerge.find((m) => m.existing.id === existing.id);
      if (!match) return existing;
      const parts = [match.title, existing.notes, match.notes].filter(Boolean);
      const fileId = uploadedFor.get(match.eventId);
      return normalizeInteraction({
        ...existing,
        notes: parts.join("\n\n"),
        fileIds: fileId ? [...(existing.fileIds || []), fileId] : (existing.fileIds || []),
        sourceEventId: match.eventId
      });
    });

    const added = toAdd.map((item) => normalizeInteraction({
      date: item.date,
      type: item.type,
      // Anything typed goes under the meeting name rather than replacing it —
      // "Coffee with Marcus" is worth keeping as the heading for what follows.
      notes: item.notes ? item.title + "\n\n" + item.notes : item.title,
      fileIds: uploadedFor.has(item.eventId) ? [uploadedFor.get(item.eventId)] : [],
      sourceEventId: item.eventId
    }));

    const merged = [...added, ...interactions]
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

  return { logged, failed, attachmentsFailed };
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
  // 'daily' and 'weekly' predate the fortnightly rhythm (ORB-27) and still mean
  // opted-in, so an old value shows as on rather than silently reading "Never".
  const emailMode = ["fortnightly", "weekly", "daily"].includes(prefs.email_reminders)
    ? "fortnightly" : "off";
  const reminderTarget = (prefs.your_email || "").trim() || authEmail || "no address saved";

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
    // Hidden until ORB-21 ships. This callout offered to set up 2FA and the
    // Security pane could not actually do it — an invitation to a dead end.
    // Restore both this and the block in the Security pane together.
    // + '<div class="settings-callout">'
    // + '<p class="sc-icon" aria-hidden="true">⛨</p>'
    // + '<div><p class="sc-title">Secure your account</p>'
    // + '<p class="sc-body">Add two-factor authentication so a stolen password is not enough to get in.</p></div>'
    // + '<button class="btn btn-secondary btn-sm" id="goSecurity" type="button">Set up</button>'
    // + '</div>'
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
        + '<option value="fortnightly"' + (emailMode === "fortnightly" ? " selected" : "")
        + '>Every two weeks</option>'
        + '</select>')
    + '<p class="field-hint">Sent to <strong>' + escapeHtml(reminderTarget) + '</strong> at '
    + 'around <strong>9am</strong> your time (<span class="tz-name">'
    + escapeHtml(browserTimezone()) + '</span>), on the same day every fortnight — one '
    + 'email, everyone who is drifting, most overdue first. Anyone still overdue after '
    + 'three of them stops being listed and becomes a note that their cadence may be '
    + 'wrong.</p>'
    + '<p id="emailRemMsg" class="success" aria-live="polite"></p>'
    + '<p id="emailRemErr" class="error" aria-live="polite"></p>'
    + '<button class="btn btn-secondary btn-sm" id="saveEmailReminders" type="button">Save email setting</button>'
    + '</section>'

    // ── Integrations (ORB-36) ────────────────────────────────────────────
    // Always here, in every state, independent of whether the nav entry point
    // is showing. The nav item is discovery and goes away once you have
    // connected; this is management, and management has to be findable exactly
    // when something has broken.
    + '<section class="settings-pane" data-pane="integrations">'
    + '<h3 class="settings-h3">Integrations</h3>'
    + '<div id="settingsIntegrations"></div>'
    + '</section>'

    // ── Security ─────────────────────────────────────────────────────────
    + '<section class="settings-pane" data-pane="security">'
    + '<h3 class="settings-h3">Security &amp; login</h3>'
    + '<h4 class="settings-h4">Change password</h4>'
    + '<div class="field-group"><label for="setPw1">New password</label>'
    + '<input type="password" id="setPw1" autocomplete="new-password" placeholder="At least '
    + MIN_PASSWORD + ' characters" />'
    + '<div class="pw-meter" id="setPwMeter" hidden>'
    + '<div class="pw-meter-track"><div class="pw-meter-fill"></div></div>'
    + '<p class="pw-meter-label" aria-live="polite"></p>'
    + '</div>'
    + passwordAdviceHtml()
    + '</div>'
    + '<div class="field-group"><label for="setPw2">Confirm new password</label>'
    + '<input type="password" id="setPw2" autocomplete="new-password" /></div>'
    + '<p id="pwMsg" class="success" aria-live="polite"></p>'
    + '<p id="pwErr" class="error" aria-live="polite"></p>'
    + '<button class="btn" id="savePw" type="button">Update password</button>'
    // Hidden until ORB-21 ships. A permanently disabled "not built yet" button
    // is worse than no button: it advertises a security control the account does
    // not have. Change password is real and stays.
    // + '<hr class="settings-rule" />'
    // + '<h4 class="settings-h4">Two-factor authentication</h4>'
    // + '<p class="settings-note">Not enabled. Two options, and they are not equal:</p>'
    // + '<ul class="settings-list">'
    // + '<li><strong>Authenticator app</strong> — free on Supabase, works offline. The one worth building.</li>'
    // + '<li><strong>SMS to your phone</strong> — needs a paid provider (Twilio) and is weaker: '
    // + 'SIM-swap attacks are why security guidance now prefers an app.</li>'
    // + '</ul>'
    // + '<button class="btn btn-secondary" type="button" disabled>Set up authenticator (not built yet)</button>'
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
  // Restore with the 2FA callout above (ORB-21). Left uncommented it would throw
  // on a null button and take the whole settings modal down with it.
  // modal.querySelector("#goSecurity").addEventListener("click", () => show("security"));
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
        + " needs supabase/migrations/004_settings_columns.sql to be run first.";
    }
    msg.textContent = "Profile saved.";
    refreshProfileButton();
    setTimeout(() => { msg.textContent = ""; }, 2500);
  });

  attachStrengthMeter(
    modal.querySelector("#setPw1"),
    modal.querySelector("#setPwMeter"),
    () => authEmail
  );

  renderSettingsIntegrations(modal.querySelector("#settingsIntegrations"));

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

    // The digest goes out at 9am in YOUR morning, so the job needs to know
    // which morning that is. Detected rather than asked for: a timezone picker
    // is a long list of names to answer a question the browser already knows,
    // and the wrong answer only costs the hour an email arrives.
    const result = await db.savePreferences({ email_reminders: mode, timezone: browserTimezone() });
    if (!result.ok) { err.textContent = "Could not save — see the console (F12)."; return; }
    if (result.skipped.includes("email_reminders")) {
      err.textContent = "Run supabase/migrations/005_reminder_columns.sql and 007_digest_streak.sql first.";
      return;
    }
    prefs.email_reminders = mode;
    msg.textContent = mode === "off"
      ? "Email reminders are off."
      : "Saved. The first digest goes out within a fortnight, around 9am "
        + browserTimezone() + " time, to "
        + ((prefs.your_email || "").trim() || authEmail) + ".";
    setTimeout(() => { msg.textContent = ""; }, 3000);
  });

  modal.querySelector("#savePw").addEventListener("click", async () => {
    const msg = modal.querySelector("#pwMsg");
    const err = modal.querySelector("#pwErr");
    msg.textContent = ""; err.textContent = "";
    const pw1 = modal.querySelector("#setPw1").value;
    const pw2 = modal.querySelector("#setPw2").value;
    if (pw1.length < MIN_PASSWORD) {
      err.textContent = "Use at least " + MIN_PASSWORD + " characters.";
      return;
    }
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
  evaluateIntegrationsNav();
  await initDashboard();
  await initMyNetwork();
  await initNetworkingLog();
  await initContactPage();
  await initFilesPage();
  await initIntegrationsPage();
  await checkRemindersOnLoad();
  // Last, and deliberately not awaited into anything that renders: it talks to
  // Google over the network and must never hold up the page.
  await adoptCalendarConnection();
  initCalendarAutoSync().catch(() => {});
})();
