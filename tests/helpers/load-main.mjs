/**
 * Loads the real js/main.js into node so it can be tested.
 *
 * main.js imports js/supabase.js, which fetches the Supabase client from a CDN
 * and cannot be imported outside a browser. So the module is read from disk, its
 * two import specifiers are rewritten to local stubs, and an export line is
 * appended exposing the internals under test.
 *
 * WHY THIS EXISTS RATHER THAN A COPY
 *
 * These tests used to import from a hand-made copy of main.js. It passed 133
 * assertions right up until anyone looked: the copy predated the reach-out
 * rework, the toast, calendar sync and conversation attachments, so a third of
 * the suite was proving things about code that had not been running for days.
 *
 * Nothing here is copied. The source is read at load time, so a suite that
 * passes is a suite that passed against what ships.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
const HARNESS = join(HERE, "..", ".harness");

/**
 * Fake database, shared by every suite.
 *
 * Backed by a Map rather than assertions about calls, so tests can ask what the
 * data actually looks like afterwards — which is the thing that matters.
 */
export const state = {
  store: new Map(),
  saves: [],
  uploads: [],
  files: [],
  // Preferences are a real store now, not a constant — ORB-106 backfills into
  // them, so a test has to be able to see what was written.
  prefs: { your_name: "Davina" },
  prefSaves: [],
  failSave: false,
  failUpload: false
};

export function resetState() {
  state.store.clear();
  state.saves.length = 0;
  state.uploads.length = 0;
  state.files.length = 0;
  state.prefs = { your_name: "Davina" };
  state.prefSaves.length = 0;
  state.failSave = false;
  state.failUpload = false;
  document.querySelectorAll(".toast-stack").forEach((n) => n.remove());
}

const DB_STUB = `
export async function getContacts() { return [...globalThis.__orbit.store.values()]; }
export async function saveContact(c) {
  globalThis.__orbit.saves.push(JSON.parse(JSON.stringify(c)));
  if (globalThis.__orbit.failSave) return null;
  globalThis.__orbit.store.set(c.id, JSON.parse(JSON.stringify(c)));
  return JSON.parse(JSON.stringify(c));
}
export async function deleteContact(id) { globalThis.__orbit.store.delete(id); return true; }
export async function uploadFileToStorage(file, meta = {}) {
  globalThis.__orbit.uploads.push({ name: file.name, contactId: meta.contactId });
  if (globalThis.__orbit.failUpload) return null;
  const f = {
    id: "f" + globalThis.__orbit.uploads.length,
    name: file.name,
    fileUrl: "https://cdn.test/" + file.name,
    storagePath: "p/" + file.name,
    category: "general",
    contactId: meta.contactId || null,
    createdAt: ""
  };
  globalThis.__orbit.files.push(f);
  return f;
}
export async function fetchStorageFilesByContact(id) {
  return globalThis.__orbit.files.filter((f) => f.contactId === id);
}
export async function fetchAllStorageFiles() { return globalThis.__orbit.files; }
export async function getPreferences() { return { ...globalThis.__orbit.prefs }; }
export async function savePreferences(updates) {
  globalThis.__orbit.prefSaves.push(updates);
  Object.assign(globalThis.__orbit.prefs, updates);
  return { ok: true, skipped: [] };
}
export function isIndustrySupported() { return true; }
export async function renameStorageFile() { return true; }
export async function deleteStorageFile() { return true; }
`;

const SUPABASE_STUB = `
export const supabase = { auth: {
  getUser: async () => ({ data: { user: { id: "u1", email: "d@e.com" } } }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  signOut: async () => ({}),
  updateUser: async () => ({ error: null })
} };
export const getUser = async () => ({ id: "u1", email: "d@e.com" });
export const requireAuth = async () => ({ id: "u1", email: "d@e.com" });
export const signOut = async () => {};
`;

/**
 * Everything any suite needs. One list, so every suite loads the same module
 * instance — node caches by URL, and generating per-suite variants would mean
 * silently getting whichever was imported first.
 */
const EXPORTS = [
  // health and cadence
  "getHealth", "getIntervalDays", "calculateNextReminder", "firstDeadlineFor",
  "GRACE_DAYS", "addDays", "daysSince", "needsAttention", "countByBand",
  "getFreqLabel", "relativeDayLabel", "todayDateString", "localDayOf",
  // relationship tiers
  "TIERS", "TIER_ORDER", "tierLabel", "frequencyForTier", "tierForFrequency",
  "effectiveTier",
  // model
  "normalizeContact", "normalizeInteraction",
  // filtering
  "cadenceKey", "matchesConnectionFilters",
  // rendering
  "ringHtml", "splitBarHtml", "personRowHtml", "wirePersonRows",
  "renderNotes", "stripNoteMarks", "noteToolbarHtml", "cadenceSentence",
  "openConversationEditor", "editorToMarks", "notesEditorHtml", "wireNotesEditor",
  // bullets, rich paste and history (ORB-77)
  "htmlToMarks", "normaliseBullets", "createNoteHistory", "toggleBullets",
  "renderInlineMarks", "markFromStyle",
  "renderInteractionTimeline", "conversationPreview", "renderStorageFileCard",
  "conversationTitle", "conversationNotes",
  "renderUpcomingMeetings", "healthBarHtml", "statusChip", "BAND_META",
  // the reach-out prompt and the permission line (ORB-78, ORB-79)
  "lastSpokeSentence", "lastConversationWords", "reachOutPromptHtml",
  "longSilenceLine", "permissionLineHtml", "elapsedPhrase", "firstNameOf",
  "LONG_SILENCE_DAYS", "showReminderModal",
  // what has accumulated (ORB-80)
  "relationshipLedger", "ledgerLine",
  // the star (ORB-93)
  "starButtonHtml", "toggleStar", "STARRED_FILTER",
  // failure language reserved for the starred (ORB-54)
  "DORMANT_META", "FIRST_CONTACT_META", "bandWords",
  // catching a thought in one gesture (ORB-81)
  "captureFormHtml", "wireCaptureForm", "openCaptureModal", "openCaptures",
  "normalizeFollowUpItem", "FOLLOWUP_SOURCES",
  // a talking point knows where it came from, and the list has a lifecycle
  // (ORB-121, ORB-122)
  "lastConversationDate", "groupFollowUps", "FOLLOWUP_GROUPS",
  "renderFollowUpItems", "followUpItemHtml", "followUpOriginLabel",
  // a capture is visibly a capture (ORB-105)
  "followUpTagHtml", "FOLLOWUP_TAGS",
  "generateFollowUpSuggestions",
  // a reason, two triggers, and trigger before timer (ORB-90/91/92)
  "reachOutReason", "reasonRank", "justMetTrigger", "anniversaryTrigger",
  "REACH_OUT_REASONS", "JUST_MET_DAYS", "ANNIVERSARY_WINDOW_DAYS",
  // the nudge on open, one click like everywhere else (ORB-58, ORB-13)
  // reach-outs are touchpoints; the echo dates itself (ORB-96, ORB-97)
  "TOUCHPOINT_TYPE", "isTouchpoint", "conversationsOf", "lastConversationEntry",
  "INTERACTION_TYPES",
  // importing a spreadsheet (ORB-98)
  // a file can name the conversation (ORB-102)
  "conversationHeadline",
  "parseCsv", "guessColumnMap", "csvRowsToContacts", "findCsvDuplicates",
  "normaliseCsvDate", "CSV_FIELDS", "csvImportFormHtml", "wireCsvImport",
  "openCsvImportModal",
  // the 20 Aug usability fixes (ORB-106..109)
  "backfillNameFromSignUp", "buildReminderEmailText", "mailtoUrl",
  "reachOutNudgeHtml", "showReachOutNudge", "checkRemindersOnLoad",
  "nudgeAllowed", "markNudgeShown", "getNudgeMode",
  // dismissing has to dismiss the person, not the box (ORB-126)
  "snoozeNudge", "clearNudgeSnooze", "nudgeSnoozed", "readNudgeSnoozes",
  "NUDGE_SNOOZE_DAYS", "NUDGE_SNOOZE_KEY",
  // behaviour
  "markReachedOut", "showToast",
  "conversationWidgetHtml", "wireConversationWidget",
  // adding a person with no conversation (ORB-73)
  "addConnectionFormHtml", "wireAddConnectionForm", "openAddConnectionModal",
  "openQuickAddChooser", "openQuickAddModal", "initQuickAddButton",
  // attachments
  "isAllowedAttachment", "isImageFile", "ATTACH_ACCEPT",
  // integrations
  "calendarCardHtml", "timeAgo",
  "openCalendarReviewModal", "applyCalendarCandidates",
  // one name for one action, and the action where the intent is (ORB-118/119)
  "ADD_TO_NETWORK_LABEL", "networkEmptyHtml",
  // whole-page renderers, for structural tests
  "initContactPage", "initMyNetwork"
];

let cached = null;

/** Sets up a DOM, writes the stubs, and returns the loaded module. */
export async function loadMain() {
  if (cached) return cached;

  const dom = new JSDOM(
    '<!doctype html><body data-page="index"><div id="root"></div></body>',
    { url: "https://orbit.test/index.html", pretendToBeVisual: true }
  );

  for (const key of [
    "window", "document", "HTMLElement", "Node", "Event", "CustomEvent", "File",
    "navigator", "localStorage", "getComputedStyle", "requestAnimationFrame"
  ]) {
    const value = key === "window" ? dom.window : dom.window[key];
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  globalThis.__orbit = state;
  globalThis.__dom = dom;

  mkdirSync(HARNESS, { recursive: true });
  writeFileSync(join(HARNESS, "db.js"), DB_STUB);
  writeFileSync(join(HARNESS, "supabase.js"), SUPABASE_STUB);
  // calendar.js and password.js are pure and need no stubbing — copied so the
  // relative imports inside main.js resolve.
  for (const name of ["calendar.js", "password.js"]) {
    writeFileSync(join(HARNESS, name), readFileSync(join(ROOT, "js", name), "utf8"));
  }

  const source = readFileSync(join(ROOT, "js", "main.js"), "utf8")
    + "\nexport { " + EXPORTS.join(", ") + " };\n";
  writeFileSync(join(HARNESS, "main.js"), source);

  cached = await import(join(HARNESS, "main.js"));
  return cached;
}

/** js/calendar.js has no imports, so it loads directly from source. */
export async function loadCalendar() {
  return import(join(ROOT, "js", "calendar.js"));
}
