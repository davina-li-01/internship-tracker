const STORAGE_KEYS = {
  logs: "interntrack_logs",
  contacts: "interntrack_contacts",
  files: "interntrack_files",
  tone: "interntrack_tone",
  theme: "interntrack_theme",
  internships: "interntrack_internships",
  activeInternshipId: "interntrack_active_internship_id",
  managerName: "interntrack_manager_name",
  yourName: "interntrack_your_name",
  nextSteps: "interntrack_next_steps"
};

let refreshActivePageData = () => {};

function readStore(key, fallback = []) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readText(key, fallback = "") {
  return localStorage.getItem(key) ?? fallback;
}

function writeText(key, value) {
  localStorage.setItem(key, value);
}

function makeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getInternships() {
  const internships = readStore(STORAGE_KEYS.internships, []);
  return Array.isArray(internships)
    ? internships.map((item) => ({
        id: item.id || makeId(),
        name: (item.name || "").trim(),
        company: (item.company || "").trim(),
        startDate: item.startDate || "",
        endDate: item.endDate || "",
        createdAt: item.createdAt || new Date().toISOString()
      }))
    : [];
}

function getActiveInternshipId() {
  return readText(STORAGE_KEYS.activeInternshipId, "");
}

function setActiveInternshipId(id) {
  writeText(STORAGE_KEYS.activeInternshipId, id);
}

function scopedKey(baseKey, internshipId = getActiveInternshipId()) {
  return `${baseKey}_${internshipId || "__none__"}`;
}

function hasActiveInternship() {
  return Boolean(getActiveInternshipId());
}

function requireActiveInternship(errorEl, message = "Please add or select an internship first.") {
  if (hasActiveInternship()) return true;
  if (errorEl) errorEl.textContent = message;
  return false;
}

function deleteInternshipScopedData(internshipId) {
  [
    STORAGE_KEYS.logs,
    STORAGE_KEYS.contacts,
    STORAGE_KEYS.files,
    STORAGE_KEYS.managerName,
    STORAGE_KEYS.yourName,
    STORAGE_KEYS.nextSteps
  ].forEach((baseKey) => {
    localStorage.removeItem(scopedKey(baseKey, internshipId));
  });
}

function readScopedStore(baseKey, fallback = []) {
  return readStore(scopedKey(baseKey), fallback);
}

function writeScopedStore(baseKey, value) {
  writeStore(scopedKey(baseKey), value);
}

function readScopedText(baseKey, fallback = "") {
  return readText(scopedKey(baseKey), fallback);
}

function writeScopedText(baseKey, value) {
  writeText(scopedKey(baseKey), value);
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
  if (Array.isArray(tagsValue)) {
    return tagsValue.map((tag) => String(tag).trim()).filter(Boolean);
  }
  if (typeof tagsValue === "string") {
    return tagsValue
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeLog(log = {}) {
  return {
    id: log.id || makeId(),
    date: log.date || "",
    task: (log.task || log.text || "").trim(),
    impact: (log.impact || "").trim(),
    skills: (log.skills || "").trim(),
    tags: splitTags(log.tags)
  };
}

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
      : []
  };
}

function normalizeFile(file = {}) {
  return {
    id: file.id || makeId(),
    name: file.name || "Untitled.pdf",
    data: file.data || "",
    date: file.date || todayDateString(),
    linkedWeek: file.linkedWeek || "",
    linkedLogId: file.linkedLogId || ""
  };
}

function getLogs() {
  if (!hasActiveInternship()) return [];
  return readScopedStore(STORAGE_KEYS.logs, []).map(normalizeLog);
}

function saveLogs(logs) {
  if (!hasActiveInternship()) return;
  writeScopedStore(STORAGE_KEYS.logs, logs.map(normalizeLog));
}

function getContacts() {
  if (!hasActiveInternship()) return [];
  return readScopedStore(STORAGE_KEYS.contacts, []).map(normalizeContact);
}

function saveContacts(contacts) {
  if (!hasActiveInternship()) return;
  writeScopedStore(STORAGE_KEYS.contacts, contacts.map(normalizeContact));
}

function getFiles() {
  if (!hasActiveInternship()) return [];
  return readScopedStore(STORAGE_KEYS.files, []).map(normalizeFile);
}

function saveFiles(files) {
  if (!hasActiveInternship()) return;
  writeScopedStore(STORAGE_KEYS.files, files.map(normalizeFile));
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

function getLast7DaysLogs() {
  return getLogs().filter((log) => isDateWithinLastDays(log.date, 7));
}

function getPeopleConnectedThisWeek() {
  return getContacts().filter((contact) => isDateWithinLastDays(contact.dateMet, 7));
}

function getFollowUpsDue() {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  return getContacts().filter((contact) => {
    if (!contact.reminderEnabled || !contact.nextReminder) return false;
    return new Date(contact.nextReminder) <= now;
  });
}

function getFollowUpsSoon() {
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 86400000);
  now.setHours(23, 59, 59, 999);
  return getContacts().filter((contact) => {
    if (!contact.reminderEnabled || !contact.nextReminder) return false;
    const next = new Date(contact.nextReminder);
    return next > now && next <= soon;
  });
}

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

function getInternshipStats(internshipId) {
  const logs = readStore(scopedKey(STORAGE_KEYS.logs, internshipId), []).length;
  const contacts = readStore(scopedKey(STORAGE_KEYS.contacts, internshipId), []).length;
  const files = readStore(scopedKey(STORAGE_KEYS.files, internshipId), []).length;
  return { logs, contacts, files };
}

function migrateLegacyDataIntoDefaultInternship(defaultId) {
  if (!defaultId) return;
  const migrationFlag = `interntrack_migrated_${defaultId}`;
  if (localStorage.getItem(migrationFlag) === "true") return;

  [STORAGE_KEYS.logs, STORAGE_KEYS.contacts, STORAGE_KEYS.files].forEach((baseKey) => {
    const scoped = scopedKey(baseKey, defaultId);
    if (localStorage.getItem(scoped) === null && localStorage.getItem(baseKey) !== null) {
      localStorage.setItem(scoped, localStorage.getItem(baseKey));
    }
  });

  [STORAGE_KEYS.managerName, STORAGE_KEYS.yourName, STORAGE_KEYS.nextSteps].forEach((baseKey) => {
    const scoped = scopedKey(baseKey, defaultId);
    if (localStorage.getItem(scoped) === null && localStorage.getItem(baseKey) !== null) {
      localStorage.setItem(scoped, localStorage.getItem(baseKey));
    }
  });

  localStorage.setItem(migrationFlag, "true");
}

function ensureInternshipWorkspace() {
  let internships = getInternships();

  if (!Array.isArray(internships)) {
    internships = [];
    writeStore(STORAGE_KEYS.internships, internships);
  }

  const cleaned = internships.filter((item) => {
    const looksLikeLegacyDefault =
      item.name === "Current Internship" &&
      !item.company &&
      !item.startDate &&
      !item.endDate &&
      getInternshipStats(item.id).logs === 0 &&
      getInternshipStats(item.id).contacts === 0 &&
      getInternshipStats(item.id).files === 0;
    return !looksLikeLegacyDefault;
  });

  if (cleaned.length !== internships.length) {
    internships = cleaned;
    writeStore(STORAGE_KEYS.internships, internships);
  }

  let activeId = getActiveInternshipId();
  const activeExists = internships.some((item) => item.id === activeId);
  if (!activeExists) {
    activeId = internships[0]?.id || "";
    setActiveInternshipId(activeId);
  }

  migrateLegacyDataIntoDefaultInternship(activeId);
}

function renderInternshipPanel() {
  const select = document.getElementById("internshipSelect");
  const list = document.getElementById("internshipList");
  if (!select || !list) return;

  const internships = getInternships();
  const activeId = getActiveInternshipId();

  if (!internships.length) {
    select.innerHTML = '<option value="">No internships yet</option>';
    select.disabled = true;
  } else {
    select.disabled = false;
    select.innerHTML = internships
      .map((internship) => `<option value="${internship.id}">${escapeHtml(internship.name)}</option>`)
      .join("");
    select.value = activeId;
  }

  if (!internships.length) {
    list.innerHTML = '<li class="empty">No internships yet. Click + New Internship.</li>';
    return;
  }

  list.innerHTML = internships
    .map((internship) => {
      const stats = getInternshipStats(internship.id);
      const activeLabel = internship.id === activeId ? '<span class="badge">Active</span>' : "";
      const duration = internship.startDate || internship.endDate
        ? `${formatDate(internship.startDate)} → ${formatDate(internship.endDate)}`
        : "Duration not set";
      return `
        <li class="list-item">
          <p><strong>${escapeHtml(internship.name)}</strong> ${activeLabel}</p>
          <p class="tiny">${escapeHtml(internship.company || "No company set")}</p>
          <p class="tiny">${escapeHtml(duration)}</p>
          <p class="tiny">${stats.logs} logs · ${stats.contacts} contacts · ${stats.files} files</p>
          <div class="row wrap internship-actions">
            <button class="btn btn-secondary" type="button" data-internship-action="edit" data-internship-id="${internship.id}">Edit</button>
            <button class="btn btn-secondary" type="button" data-internship-action="delete" data-internship-id="${internship.id}">Delete</button>
          </div>
        </li>
      `;
    })
    .join("");
}

function initInternshipPanel() {
  const select = document.getElementById("internshipSelect");
  const list = document.getElementById("internshipList");
  const addBtn = document.getElementById("addInternshipBtn");
  if (!select || !list || !addBtn) return;

  const error = document.getElementById("internshipError");

  const promptInternshipPayload = (seed = {}) => {
    const name = window.prompt("Internship name", seed.name || "")?.trim() || "";
    if (!name) return null;
    const company = window.prompt("Company", seed.company || "")?.trim() || "";
    const startDate = window.prompt("Start date (YYYY-MM-DD)", seed.startDate || "")?.trim() || "";
    const endDate = window.prompt("End date (YYYY-MM-DD)", seed.endDate || "")?.trim() || "";
    return { name, company, startDate, endDate };
  };

  select.addEventListener("change", () => {
    setActiveInternshipId(select.value);
    renderInternshipPanel();
    refreshActivePageData();
  });

  addBtn.addEventListener("click", () => {
    error.textContent = "";

    const payload = promptInternshipPayload({
      name: "",
      company: "",
      startDate: "",
      endDate: ""
    });

    if (!payload) return;

    const internships = getInternships();
    const next = { id: makeId(), ...payload, createdAt: new Date().toISOString() };
    internships.push(next);

    writeStore(STORAGE_KEYS.internships, internships);
    setActiveInternshipId(next.id);
    renderInternshipPanel();
    refreshActivePageData();
  });

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-internship-action]");
    if (!button) return;

    const internshipId = button.dataset.internshipId;
    const action = button.dataset.internshipAction;
    const internships = getInternships();
    const target = internships.find((item) => item.id === internshipId);
    if (!target) return;

    if (action === "edit") {
      const payload = promptInternshipPayload(target);
      if (!payload) return;

      const updated = internships.map((item) =>
        item.id === internshipId
          ? {
              ...item,
              ...payload
            }
          : item
      );

      writeStore(STORAGE_KEYS.internships, updated);
      renderInternshipPanel();
      refreshActivePageData();
      return;
    }

    if (action === "delete") {
      const confirmed = window.confirm(`Delete internship "${target.name}" and all associated logs, files, and contacts?`);
      if (!confirmed) return;

      const remaining = internships.filter((item) => item.id !== internshipId);
      writeStore(STORAGE_KEYS.internships, remaining);
      deleteInternshipScopedData(internshipId);

      if (getActiveInternshipId() === internshipId) {
        setActiveInternshipId(remaining[0]?.id || "");
      }

      renderInternshipPanel();
      refreshActivePageData();
    }
  });

  renderInternshipPanel();
}

function renderFollowUpAlerts(listId, emptyText = "No follow-ups due.") {
  const list = document.getElementById(listId);
  if (!list) return;

  const due = getFollowUpsDue();
  const soon = getFollowUpsSoon();
  const combined = [
    ...due.map((c) => ({ contact: c, status: "due" })),
    ...soon.map((c) => ({ contact: c, status: "soon" }))
  ];

  if (!combined.length) {
    list.innerHTML = `<li class="empty">${escapeHtml(emptyText)}</li>`;
    return;
  }

  list.innerHTML = combined
    .map(
      ({ contact, status }) => `
      <li class="list-item ${status === "due" ? "due-item" : "soon-item"}">
        <div class="reminder-row">
          <span>
            ${status === "due" ? "🔴" : "🟡"}
            ${status === "due" ? "👉 Time to reconnect with" : "Coming up:"}
            <strong>${escapeHtml(contact.name)}</strong>
            <span class="tiny">(${formatDate(contact.nextReminder)})</span>
          </span>
          <button class="btn btn-secondary reminder-trigger" type="button" data-contact-id="${contact.id}">Manage</button>
        </div>
      </li>`
    )
    .join("");

  list.querySelectorAll(".reminder-trigger").forEach((btn) => {
    btn.addEventListener("click", () => {
      const contactId = btn.dataset.contactId;
      const contact = getContacts().find((c) => c.id === contactId);
      if (contact) showContactProfile(contact);
    });
  });
}

function renderLogs() {
  const list = document.getElementById("logList");
  if (!list) return;

  const logs = getLogs().sort((a, b) => b.date.localeCompare(a.date));
  if (!logs.length) {
    list.innerHTML = '<li class="empty">No impact logs yet.</li>';
    return;
  }

  list.innerHTML = logs
    .map(
      (log) => `
      <li class="list-item">
        <p><strong>${formatDate(log.date)}</strong></p>
        <p><span class="label">Did:</span> ${escapeHtml(log.task)}</p>
        <p><span class="label">Impact:</span> ${escapeHtml(log.impact)}</p>
        <p><span class="label">Skills:</span> ${escapeHtml(log.skills)}</p>
        <div class="tag-row">${log.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
      </li>`
    )
    .join("");
}

function renderFiles() {
  const list = document.getElementById("fileList");
  if (!list) return;

  const files = getFiles().sort((a, b) => b.date.localeCompare(a.date));
  if (!files.length) {
    list.innerHTML = '<li class="empty">No PDFs uploaded yet.</li>';
    return;
  }

  list.innerHTML = files
    .map(
      (file) => `
      <li class="list-item">
        <p><strong>${escapeHtml(file.name)}</strong> <span class="tiny">${formatDate(file.date)}</span></p>
        <div class="row wrap">
          <a class="btn btn-secondary" href="${file.data}" target="_blank" rel="noopener">Open</a>
          <a class="btn" href="${file.data}" download="${escapeHtml(file.name)}">Download</a>
        </div>
      </li>`
    )
    .join("");
}

function scoreImpact(log) {
  return (log.impact || "").length + (log.skills || "").length * 0.2 + log.tags.length * 3;
}

function renderTopAchievements() {
  const list = document.getElementById("topAchievements");
  if (!list) return;

  const top = getLast7DaysLogs()
    .sort((a, b) => scoreImpact(b) - scoreImpact(a))
    .slice(0, 3);

  if (!top.length) {
    list.innerHTML = '<li class="empty">Add logs to surface top achievements.</li>';
    return;
  }

  list.innerHTML = top
    .map(
      (log) => `
      <li class="list-item">
        <p><strong>${escapeHtml(log.task)}</strong></p>
        <p>${escapeHtml(log.impact)}</p>
      </li>`
    )
    .join("");
}

function renderWeeklyConnections(listId) {
  const list = document.getElementById(listId);
  if (!list) return;

  const people = getPeopleConnectedThisWeek().sort((a, b) => b.dateMet.localeCompare(a.dateMet));
  if (!people.length) {
    list.innerHTML = '<li class="empty">No new contacts in the last 7 days.</li>';
    return;
  }

  list.innerHTML = people
    .map(
      (person) => `
      <li class="list-item">
        <p><strong>${escapeHtml(person.name)}</strong> · ${escapeHtml(person.role || "Role not set")}</p>
        <p class="tiny">Met: ${formatDate(person.dateMet)}</p>
      </li>`
    )
    .join("");
}

function renderProgressWidget() {
  const statLogs = document.getElementById("statLogs");
  const statContacts = document.getElementById("statContacts");
  const statFollowUps = document.getElementById("statFollowUps");
  if (!statLogs || !statContacts || !statFollowUps) return;

  statLogs.textContent = String(getLast7DaysLogs().length);
  statContacts.textContent = String(getPeopleConnectedThisWeek().length);
  statFollowUps.textContent = String(getFollowUpsDue().length);
}

function buildSummary({ logs, managerName, yourName, nextSteps }) {
  const safeManager = managerName?.trim() || "Manager";
  const safeName = yourName?.trim() || "Your Name";
  const safeNextSteps = nextSteps?.trim();

  if (!logs.length) {
    return `Hi ${safeManager},\n\nThis week I:\n\n• Completed: No impact logs submitted.\n• Achieved: No impact details submitted.\n• Learned: No skills noted yet.\n\nKey highlight:\nNo key highlight yet.\n\nNext steps:\n${safeNextSteps || "Continue building momentum next week."}\n\nBest,\n${safeName}`;
  }

  const completed = logs.map((log) => `${log.task} (${log.date})`).join("; ");
  const achieved = logs.map((log) => log.impact).filter(Boolean).join("; ");
  const learned = logs.map((log) => log.skills).filter(Boolean).join("; ");
  const best = [...logs].sort((a, b) => scoreImpact(b) - scoreImpact(a))[0];

  return `Hi ${safeManager},\n\nThis week I:\n\n• Completed: ${completed}\n• Achieved: ${achieved || "No impact details recorded."}\n• Learned: ${learned || "No skills recorded."}\n\nKey highlight:\n${best?.impact || "No key highlight recorded."}\n\nNext steps:\n${safeNextSteps || "Continue progressing on current priorities."}\n\nBest,\n${safeName}`;
}

async function fetchQuote() {
  try {
    const response = await fetch("https://api.quotable.io/random");
    if (!response.ok) throw new Error("Quote unavailable");
    const data = await response.json();
    return `“${data.content}” — ${data.author}`;
  } catch {
    return "Weekly Insight for Growth is unavailable right now. Keep showing up consistently.";
  }
}

function applyTheme() {
  const theme = localStorage.getItem(STORAGE_KEYS.theme) || "light";
  document.body.classList.toggle("dark", theme === "dark");
  const toggle = document.getElementById("themeToggle");
  if (toggle) toggle.textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
}

function initThemeToggle() {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;
  applyTheme();
  toggle.addEventListener("click", () => {
    const next = document.body.classList.contains("dark") ? "light" : "dark";
    localStorage.setItem(STORAGE_KEYS.theme, next);
    applyTheme();
  });
}

function readPdfFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

function initDashboard() {
  const logForm = document.getElementById("logForm");
  if (!logForm) return;

  const logDate = document.getElementById("logDate");
  const logTask = document.getElementById("logTask");
  const logImpact = document.getElementById("logImpact");
  const logSkills = document.getElementById("logSkills");
  const logTags = document.getElementById("logTags");
  const logError = document.getElementById("logError");

  const fileInput = document.getElementById("fileInput");
  const addFileBtn = document.getElementById("addFileBtn");
  const fileError = document.getElementById("fileError");

  const managerNameInput = document.getElementById("managerName");
  const yourNameInput = document.getElementById("yourName");
  const nextStepsInput = document.getElementById("nextSteps");
  const previewBtn = document.getElementById("generatePreviewBtn");
  const previewArea = document.getElementById("summaryPreview");
  const refreshInsightBtn = document.getElementById("refreshInsightBtn");
  const dashboardQuote = document.getElementById("dashboardQuote");

  logDate.value = todayDateString();

  managerNameInput.addEventListener("input", () => {
    if (hasActiveInternship()) writeScopedText(STORAGE_KEYS.managerName, managerNameInput.value);
  });
  yourNameInput.addEventListener("input", () => {
    if (hasActiveInternship()) writeScopedText(STORAGE_KEYS.yourName, yourNameInput.value);
  });
  nextStepsInput.addEventListener("input", () => {
    if (hasActiveInternship()) writeScopedText(STORAGE_KEYS.nextSteps, nextStepsInput.value);
  });

  logForm.addEventListener("submit", (event) => {
    event.preventDefault();
    logError.textContent = "";

    if (!requireActiveInternship(logError)) return;

    const entry = normalizeLog({
      date: logDate.value,
      task: logTask.value,
      impact: logImpact.value,
      skills: logSkills.value,
      tags: logTags.value
    });

    if (!entry.date || !entry.task || !entry.impact || !entry.skills) {
      logError.textContent = "Date, task, impact, and skills are required.";
      return;
    }

    const logs = getLogs();
    logs.push(entry);
    saveLogs(logs);

    logTask.value = "";
    logImpact.value = "";
    logSkills.value = "";
    logTags.value = "";

    renderLogs();
    renderProgressWidget();
    renderTopAchievements();
    renderInternshipPanel();
  });

  addFileBtn.addEventListener("click", async () => {
    fileError.textContent = "";

    if (!requireActiveInternship(fileError)) return;

    const selected = Array.from(fileInput.files || []);
    if (!selected.length) {
      fileError.textContent = "Please choose at least one PDF.";
      return;
    }

    if (selected.some((file) => !file.name.toLowerCase().endsWith(".pdf"))) {
      fileError.textContent = "Only PDF files are supported.";
      return;
    }

    try {
      const existing = getFiles();
      const date = todayDateString();
      const encoded = await Promise.all(
        selected.map(async (file) => ({
          id: makeId(),
          name: file.name,
          data: await readPdfFile(file),
          date
        }))
      );

      saveFiles([...existing, ...encoded]);
      fileInput.value = "";
      renderFiles();
      renderInternshipPanel();
    } catch {
      fileError.textContent = "Upload failed. Try again with a smaller PDF.";
    }
  });

  previewBtn.addEventListener("click", () => {
    if (!requireActiveInternship(logError, "Add/select an internship to generate a summary.")) return;
    previewArea.value = buildSummary({
      logs: getLast7DaysLogs(),
      managerName: managerNameInput.value,
      yourName: yourNameInput.value,
      nextSteps: nextStepsInput.value
    });
  });

  if (refreshInsightBtn && dashboardQuote) {
    refreshInsightBtn.addEventListener("click", async () => {
      dashboardQuote.textContent = await fetchQuote();
    });
  }

  refreshActivePageData = async () => {
    managerNameInput.value = hasActiveInternship() ? readScopedText(STORAGE_KEYS.managerName, "") : "";
    yourNameInput.value = hasActiveInternship() ? readScopedText(STORAGE_KEYS.yourName, "") : "";
    nextStepsInput.value = hasActiveInternship() ? readScopedText(STORAGE_KEYS.nextSteps, "") : "";
    previewArea.value = "";
    renderLogs();
    renderFiles();
    renderFollowUpAlerts("dashboardFollowUps");
    renderProgressWidget();
    renderTopAchievements();
    renderWeeklyConnections("recentPeopleDashboard");
    if (dashboardQuote) {
      dashboardQuote.textContent = await fetchQuote();
    }
  };

  refreshActivePageData();
}

function reminderBadge(contact) {
  const status = getReminderStatus(contact);
  if (status === "due") return '<span class="badge badge-due">🔴 Due</span>';
  if (status === "soon") return '<span class="badge badge-soon">🟡 Soon</span>';
  if (status === "ok") return '<span class="badge badge-ok">🟢 Up to date</span>';
  return '';
}

function renderContacts() {
  const list = document.getElementById("contactList");
  if (!list) return;

  const contacts = getContacts().sort((a, b) => b.dateMet.localeCompare(a.dateMet));
  if (!contacts.length) {
    list.innerHTML = '<li class="empty">No contacts yet. Add your first contact above.</li>';
    return;
  }

  list.innerHTML = contacts
    .map((contact) => {
      const status = getReminderStatus(contact);
      const freqLabel = FREQUENCY_LABELS[contact.followUpFrequency] || "No reminders";
      const interactionCount = contact.interactions?.length || 0;
      return `
      <li class="contact-card ${status === "due" ? "due-item" : status === "soon" ? "soon-item" : ""}" data-open-contact="${contact.id}" role="button" tabindex="0">
        <div class="contact-header">
          <div class="contact-summary">
            <p class="contact-name"><strong>${escapeHtml(contact.name)}</strong></p>
            <p class="tiny">${escapeHtml(contact.role || "Role not set")} · ${escapeHtml(contact.email)}</p>
          </div>
          <div class="badge-col">${reminderBadge(contact)}</div>
        </div>
        <div class="contact-meta">
          <span class="tiny">Last contacted: ${formatDate(contact.lastContacted)}</span>
          <span class="tiny">Next: ${contact.nextReminder ? formatDate(contact.nextReminder.split("T")[0]) : "—"}</span>
          <span class="tiny">${interactionCount} interaction${interactionCount !== 1 ? "s" : ""}</span>
          <span class="tiny">${escapeHtml(freqLabel)}</span>
        </div>
        <p class="contact-hint tiny muted">Click to view full profile →</p>
      </li>`;
    })
    .join("");

  list.querySelectorAll("[data-open-contact]").forEach((card) => {
    const open = () => {
      const contact = getContacts().find((c) => c.id === card.dataset.openContact);
      if (contact) showContactProfile(contact);
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(); });
  });
}

function initNetworking() {
  const form = document.getElementById("contactForm");
  if (!form) return;

  const error = document.getElementById("contactError");
  const nameEl = document.getElementById("contactName");
  const emailEl = document.getElementById("contactEmail");
  const roleEl = document.getElementById("contactRole");
  const dateMetEl = document.getElementById("dateMet");
  const lastContactedEl = document.getElementById("lastContacted");
  const followUpFrequencyEl = document.getElementById("followUpFrequency");
  const interestsEl = document.getElementById("interests");
  const adviceEl = document.getElementById("adviceGiven");
  const notesEl = document.getElementById("contactNotes");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";

    if (!requireActiveInternship(error)) return;

    const frequency = followUpFrequencyEl?.value || "none";
    const lastContactedValue = lastContactedEl?.value || dateMetEl?.value || todayDateString();

    const contact = normalizeContact({
      name: nameEl.value,
      email: emailEl.value,
      role: roleEl.value,
      dateMet: dateMetEl.value,
      lastContacted: lastContactedValue,
      followUpFrequency: frequency,
      interests: interestsEl.value,
      adviceGiven: adviceEl.value,
      notes: notesEl.value,
      interactions: [],
      documents: []
    });

    if (!contact.name || !contact.email || !contact.dateMet) {
      error.textContent = "Name, email, and date met are required.";
      return;
    }

    const contacts = getContacts();
    contacts.push(contact);
    saveContacts(contacts);

    form.reset();
    renderContacts();
    renderFollowUpAlerts("networkFollowUps");
    renderProgressWidget();
    renderInternshipPanel();
  });

  refreshActivePageData = () => {
    renderContacts();
    renderFollowUpAlerts("networkFollowUps");
  };

  refreshActivePageData();
}

function renderWeeklyLogs() {
  const weeklyLogsList = document.getElementById("weeklyLogs");
  if (!weeklyLogsList) return [];

  const logs = getLast7DaysLogs().sort((a, b) => a.date.localeCompare(b.date));
  if (!logs.length) {
    weeklyLogsList.innerHTML = '<li class="empty">No impact logs from the last 7 days.</li>';
    return [];
  }

  weeklyLogsList.innerHTML = logs
    .map(
      (log) => `
      <li class="list-item">
        <p><strong>${formatDate(log.date)}</strong></p>
        <p><span class="label">Completed:</span> ${escapeHtml(log.task)}</p>
        <p><span class="label">Achieved:</span> ${escapeHtml(log.impact)}</p>
        <p><span class="label">Learned:</span> ${escapeHtml(log.skills)}</p>
      </li>`
    )
    .join("");

  return logs;
}

function initSummary() {
  const generateBtn = document.getElementById("generateSummaryBtn");
  if (!generateBtn) return;

  const copyBtn = document.getElementById("copySummaryBtn");
  const summaryArea = document.getElementById("generatedSummary");
  const quoteText = document.getElementById("quoteText");
  const message = document.getElementById("summaryMessage");
  const managerNameInput = document.getElementById("summaryManagerName");
  const yourNameInput = document.getElementById("summaryYourName");
  const nextStepsInput = document.getElementById("summaryNextSteps");

  managerNameInput.addEventListener("input", () => {
    if (hasActiveInternship()) writeScopedText(STORAGE_KEYS.managerName, managerNameInput.value);
  });
  yourNameInput.addEventListener("input", () => {
    if (hasActiveInternship()) writeScopedText(STORAGE_KEYS.yourName, yourNameInput.value);
  });
  nextStepsInput.addEventListener("input", () => {
    if (hasActiveInternship()) writeScopedText(STORAGE_KEYS.nextSteps, nextStepsInput.value);
  });

  generateBtn.addEventListener("click", async () => {
    message.textContent = "";
    if (!requireActiveInternship(message, "Add/select an internship first.")) return;
    const logs = renderWeeklyLogs();
    renderWeeklyConnections("weeklyConnections");

    summaryArea.value = buildSummary({
      logs,
      managerName: managerNameInput.value,
      yourName: yourNameInput.value,
      nextSteps: nextStepsInput.value
    });

    quoteText.textContent = await fetchQuote();
  });

  copyBtn.addEventListener("click", async () => {
    message.textContent = "";
    if (!summaryArea.value.trim()) {
      message.textContent = "Generate a summary first.";
      return;
    }
    try {
      await navigator.clipboard.writeText(summaryArea.value);
      message.textContent = "Summary copied to clipboard.";
    } catch {
      message.textContent = "Copy failed. Please copy manually.";
    }
  });

  refreshActivePageData = () => {
    managerNameInput.value = hasActiveInternship() ? readScopedText(STORAGE_KEYS.managerName, "") : "";
    yourNameInput.value = hasActiveInternship() ? readScopedText(STORAGE_KEYS.yourName, "") : "";
    nextStepsInput.value = hasActiveInternship() ? readScopedText(STORAGE_KEYS.nextSteps, "") : "";
    summaryArea.value = "";
    message.textContent = "";
    quoteText.textContent = 'Click "Generate Summary" to load a weekly insight.';
    renderWeeklyLogs();
    renderWeeklyConnections("weeklyConnections");
  };

  refreshActivePageData();
}

const INTERACTION_TYPES = ["coffee chat", "meeting", "check-in", "email", "phone call", "event"];

function renderInteractionTimeline(interactions) {
  if (!interactions.length) {
    return '<p class="empty">No interactions logged yet.</p>';
  }
  return interactions
    .map(
      (item) => `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div class="timeline-body">
          <p class="timeline-date">${formatDate(item.date)} <span class="tag">${escapeHtml(item.type)}</span></p>
          ${item.notes ? `<p>${escapeHtml(item.notes)}</p>` : ""}
          ${item.outcome ? `<p class="tiny"><span class="label">Outcome:</span> ${escapeHtml(item.outcome)}</p>` : ""}
        </div>
      </div>`
    )
    .join("");
}

function renderContactDocuments(docs) {
  if (!docs.length) return '<p class="empty">No documents uploaded yet.</p>';
  return docs
    .map(
      (doc) => `
      <div class="row wrap doc-row">
        <span><strong>${escapeHtml(doc.name)}</strong> <span class="tiny">${formatDate(doc.date)}</span></span>
        <div class="row">
          <a class="btn btn-secondary" href="${doc.data}" target="_blank" rel="noopener">Open</a>
          <a class="btn btn-secondary" href="${doc.data}" download="${escapeHtml(doc.name)}">Download</a>
          <button class="btn btn-secondary" type="button" data-remove-doc="${doc.id}">Remove</button>
        </div>
      </div>`
    )
    .join("");
}

function showContactProfile(contactData) {
  const existing = document.getElementById("contactProfileModal");
  if (existing) existing.remove();

  const freshContact = () => getContacts().find((c) => c.id === contactData.id) || contactData;

  const modal = document.createElement("div");
  modal.id = "contactProfileModal";
  modal.className = "modal-overlay";
  document.body.appendChild(modal);

  function rerender() {
    const c = freshContact();
    const freqLabel = FREQUENCY_LABELS[c.followUpFrequency] || "No reminders";
    const status = getReminderStatus(c);

    modal.innerHTML = `
      <div class="modal-card profile-modal">

        <!-- Header -->
        <div class="profile-header">
          <div>
            <h2 class="profile-name" id="pName">${escapeHtml(c.name)}</h2>
            <p class="muted" id="pRole">${escapeHtml(c.role || "Role not set")} · ${escapeHtml(c.email)}</p>
            <p class="tiny">Met: ${formatDate(c.dateMet)}</p>
          </div>
          <div class="profile-header-right">
            ${reminderBadge(c)}
            <button class="btn btn-secondary" id="profileClose" type="button">✕ Close</button>
          </div>
        </div>

        <!-- Two-column body -->
        <div class="profile-body">

          <!-- LEFT: Timeline + Add Interaction -->
          <div class="profile-left">
            <section class="profile-section">
              <h3>Interaction Timeline</h3>
              <div class="timeline" id="profileTimeline">${renderInteractionTimeline(c.interactions)}</div>
            </section>

            <section class="profile-section">
              <h3>Add Interaction</h3>
              <div class="field-group">
                <label>Date</label>
                <input type="date" id="newIntDate" value="${todayDateString()}" />
              </div>
              <div class="field-group">
                <label>Type</label>
                <select id="newIntType">
                  ${INTERACTION_TYPES.map((t) => `<option value="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</option>`).join("")}
                </select>
              </div>
              <div class="field-group">
                <label>Notes</label>
                <textarea id="newIntNotes" rows="3"></textarea>
              </div>
              <div class="field-group">
                <label>Outcome</label>
                <textarea id="newIntOutcome" rows="2"></textarea>
              </div>
              <p id="newIntError" class="error" aria-live="polite"></p>
              <button class="btn" id="addInteractionBtn" type="button">+ Add Interaction</button>
            </section>
          </div>

          <!-- RIGHT: Info + Docs + Reminder -->
          <div class="profile-right">
            <section class="profile-section">
              <h3>Notes &amp; Details</h3>
              <div class="field-group">
                <label>Interests</label>
                <input type="text" id="editInterests" value="${escapeHtml(c.interests)}" />
              </div>
              <div class="field-group">
                <label>Advice Given</label>
                <textarea id="editAdvice" rows="2">${escapeHtml(c.adviceGiven)}</textarea>
              </div>
              <div class="field-group">
                <label>Notes</label>
                <textarea id="editNotes" rows="3">${escapeHtml(c.notes)}</textarea>
              </div>
              <button class="btn btn-secondary" id="saveNotesBtn" type="button">Save Notes</button>
              <p id="saveNotesMsg" class="success" aria-live="polite"></p>
            </section>

            <section class="profile-section">
              <h3>Documents</h3>
              <div id="profileDocs">${renderContactDocuments(c.documents)}</div>
              <div class="row wrap" style="margin-top:0.5rem">
                <input type="file" id="profileDocInput" accept=".pdf,application/pdf" multiple />
                <button class="btn btn-secondary" id="profileDocUpload" type="button">Upload PDF</button>
              </div>
              <p id="profileDocError" class="error" aria-live="polite"></p>
            </section>

            <section class="profile-section">
              <h3>Reminder Settings</h3>
              <p class="tiny">Last contacted: ${formatDate(c.lastContacted)}</p>
              <p class="tiny">Next reminder: ${c.nextReminder ? formatDate(c.nextReminder.split("T")[0]) : "—"}</p>
              <div class="field-group" style="margin-top:0.6rem">
                <label>Frequency</label>
                <select id="profileFrequency">
                  ${Object.entries(FREQUENCY_LABELS).map(([v, l]) => `<option value="${v}" ${c.followUpFrequency === v ? "selected" : ""}>${l}</option>`).join("")}
                </select>
              </div>
              <div class="row" style="margin-top:0.4rem">
                <input type="checkbox" id="profileReminderEnabled" ${c.reminderEnabled ? "checked" : ""} />
                <label for="profileReminderEnabled">Reminders enabled</label>
              </div>
              <button class="btn btn-secondary" id="saveReminderBtn" type="button" style="margin-top:0.6rem">Save Reminder Settings</button>
              <p id="saveReminderMsg" class="success" aria-live="polite"></p>
              <hr class="profile-divider" />
              <button class="btn btn-secondary" id="profileOpenReminder" type="button">${status !== "none" ? "Manage Reminder Popup" : "Send Reconnect Email"}</button>
            </section>

            <section class="profile-section danger-zone">
              <button class="btn btn-secondary" id="deleteContactBtn" type="button">🗑 Delete Contact</button>
            </section>
          </div>
        </div>
      </div>
    `;

    // Close
    modal.querySelector("#profileClose").addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

    // Add interaction
    modal.querySelector("#addInteractionBtn").addEventListener("click", () => {
      const errEl = modal.querySelector("#newIntError");
      errEl.textContent = "";
      const date = modal.querySelector("#newIntDate").value;
      const type = modal.querySelector("#newIntType").value;
      const notes = modal.querySelector("#newIntNotes").value.trim();
      const outcome = modal.querySelector("#newIntOutcome").value.trim();
      if (!date) { errEl.textContent = "Date is required."; return; }
      const interaction = normalizeInteraction({ date, type, notes, outcome });
      const contacts = getContacts();
      const updated = contacts.map((c) => {
        if (c.id !== contactData.id) return c;
        const newInteractions = [interaction, ...c.interactions].sort((a, b) => b.date.localeCompare(a.date));
        const newLastContacted = newInteractions[0].date;
        return {
          ...c,
          interactions: newInteractions,
          lastContacted: newLastContacted,
          nextReminder: calculateNextReminder(newLastContacted, c.followUpFrequency)
        };
      });
      saveContacts(updated);
      renderContacts();
      renderFollowUpAlerts("networkFollowUps");
      renderFollowUpAlerts("dashboardFollowUps");
      renderProgressWidget();
      rerender();
    });

    // Save notes
    modal.querySelector("#saveNotesBtn").addEventListener("click", () => {
      const contacts = getContacts();
      const updated = contacts.map((c) =>
        c.id !== contactData.id ? c : {
          ...c,
          interests: modal.querySelector("#editInterests").value.trim(),
          adviceGiven: modal.querySelector("#editAdvice").value.trim(),
          notes: modal.querySelector("#editNotes").value.trim()
        }
      );
      saveContacts(updated);
      renderContacts();
      modal.querySelector("#saveNotesMsg").textContent = "Saved!";
      setTimeout(() => { const m = modal.querySelector("#saveNotesMsg"); if (m) m.textContent = ""; }, 2000);
    });

    // Save reminder settings
    modal.querySelector("#saveReminderBtn").addEventListener("click", () => {
      const newFreq = modal.querySelector("#profileFrequency").value;
      const enabled = modal.querySelector("#profileReminderEnabled").checked;
      const contacts = getContacts();
      const updated = contacts.map((c) => {
        if (c.id !== contactData.id) return c;
        return {
          ...c,
          followUpFrequency: newFreq,
          reminderEnabled: enabled && newFreq !== "none",
          nextReminder: calculateNextReminder(c.lastContacted || c.dateMet, newFreq)
        };
      });
      saveContacts(updated);
      renderContacts();
      renderFollowUpAlerts("networkFollowUps");
      renderFollowUpAlerts("dashboardFollowUps");
      modal.querySelector("#saveReminderMsg").textContent = "Reminder settings saved!";
      setTimeout(() => { const m = modal.querySelector("#saveReminderMsg"); if (m) m.textContent = ""; }, 2000);
      rerender();
    });

    // Open reminder modal
    modal.querySelector("#profileOpenReminder").addEventListener("click", () => {
      modal.remove();
      showReminderModal(freshContact());
    });

    // Document upload
    modal.querySelector("#profileDocUpload").addEventListener("click", async () => {
      const errEl = modal.querySelector("#profileDocError");
      errEl.textContent = "";
      const files = Array.from(modal.querySelector("#profileDocInput").files || []);
      if (!files.length) { errEl.textContent = "Select at least one PDF."; return; }
      if (files.some((f) => !f.name.toLowerCase().endsWith(".pdf"))) {
        errEl.textContent = "Only PDF files supported.";
        return;
      }
      try {
        const encoded = await Promise.all(
          files.map(async (f) => normalizeContactDocument({ name: f.name, data: await readPdfFile(f) }))
        );
        const contacts = getContacts();
        const updated = contacts.map((c) =>
          c.id !== contactData.id ? c : { ...c, documents: [...(c.documents || []), ...encoded] }
        );
        saveContacts(updated);
        renderContacts();
        rerender();
      } catch {
        errEl.textContent = "Upload failed. Try a smaller file.";
      }
    });

    // Document remove
    modal.querySelectorAll("[data-remove-doc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const docId = btn.dataset.removeDoc;
        const contacts = getContacts();
        const updated = contacts.map((c) =>
          c.id !== contactData.id ? c : { ...c, documents: c.documents.filter((d) => d.id !== docId) }
        );
        saveContacts(updated);
        renderContacts();
        rerender();
      });
    });

    // Delete contact
    modal.querySelector("#deleteContactBtn").addEventListener("click", () => {
      if (!window.confirm(`Delete ${freshContact().name} and all their data?`)) return;
      saveContacts(getContacts().filter((c) => c.id !== contactData.id));
      renderContacts();
      renderFollowUpAlerts("networkFollowUps");
      renderFollowUpAlerts("dashboardFollowUps");
      renderProgressWidget();
      renderInternshipPanel();
      modal.remove();
    });
  }

  rerender();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildReminderEmailText(contact, yourName = "") {
  const name = contact.name || "there";
  const safeName = yourName.trim() || "[Your Name]";
  return `Subject: Great catching up!\n\nHi ${name},\n\nHope you've been doing well! I wanted to reconnect and see how things have been going on your end.\n\nWould love to catch up soon.\n\nBest,\n${safeName}`;
}

function showReminderModal(contact) {
  const existing = document.getElementById("reminderModal");
  if (existing) existing.remove();

  const yourName = readScopedText(STORAGE_KEYS.yourName, "");
  const emailText = buildReminderEmailText(contact, yourName);

  const modal = document.createElement("div");
  modal.id = "reminderModal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-card">
      <h3>Time to reconnect with <strong>${escapeHtml(contact.name)}</strong></h3>
      <p class="muted">Frequency: ${escapeHtml(FREQUENCY_LABELS[contact.followUpFrequency] || "—")} · Next: ${contact.nextReminder ? formatDate(contact.nextReminder.split("T")[0]) : "—"}</p>
      <div class="modal-actions">
        <button class="btn" id="modalMarkDone" type="button">✅ Mark as done</button>
        <button class="btn btn-secondary" id="modalLater" type="button">⏰ Remind me in 3 days</button>
        <button class="btn btn-secondary" id="modalTurnOff" type="button">❌ Turn off reminders</button>
      </div>
      <div class="modal-email">
        <p class="label">Copy reminder email draft:</p>
        <textarea class="email-draft" readonly rows="8">${escapeHtml(emailText)}</textarea>
        <button class="btn btn-secondary" id="modalCopyEmail" type="button">📋 Copy email</button>
        <p id="modalCopyMsg" class="success" aria-live="polite"></p>
      </div>
      <button class="btn btn-secondary modal-close" id="modalClose" type="button">Close</button>
    </div>
  `;
  document.body.appendChild(modal);

  const refresh = () => {
    renderContacts();
    renderFollowUpAlerts("dashboardFollowUps");
    renderFollowUpAlerts("networkFollowUps");
    renderProgressWidget();
    modal.remove();
  };

  modal.querySelector("#modalMarkDone").addEventListener("click", () => {
    const contacts = getContacts();
    const updated = contacts.map((c) =>
      c.id !== contact.id
        ? c
        : {
            ...c,
            lastContacted: todayDateString(),
            nextReminder: calculateNextReminder(new Date().toISOString(), c.followUpFrequency)
          }
    );
    saveContacts(updated);
    refresh();
  });

  modal.querySelector("#modalLater").addEventListener("click", () => {
    const contacts = getContacts();
    const updated = contacts.map((c) =>
      c.id !== contact.id
        ? c
        : { ...c, nextReminder: new Date(Date.now() + 3 * 86400000).toISOString() }
    );
    saveContacts(updated);
    refresh();
  });

  modal.querySelector("#modalTurnOff").addEventListener("click", () => {
    const contacts = getContacts();
    const updated = contacts.map((c) =>
      c.id !== contact.id ? c : { ...c, reminderEnabled: false, followUpFrequency: "none" }
    );
    saveContacts(updated);
    refresh();
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

function checkRemindersOnLoad() {
  setTimeout(() => {
    if (!hasActiveInternship()) return;
    const due = getFollowUpsDue();
    if (due.length > 0) {
      showReminderModal(due[0]);
    }
  }, 800);
}

ensureInternshipWorkspace();
initThemeToggle();
initDashboard();
initNetworking();
initSummary();
initInternshipPanel();
checkRemindersOnLoad();
