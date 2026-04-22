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

function normalizeContact(contact = {}) {
  return {
    id: contact.id || makeId(),
    name: (contact.name || "").trim(),
    email: (contact.email || "").trim(),
    role: (contact.role || "").trim(),
    dateMet: contact.dateMet || "",
    lastContacted: contact.lastContacted || "",
    followUpDate: contact.followUpDate || contact.followUp || "",
    notes: (contact.notes || "").trim(),
    interests: (contact.interests || "").trim(),
    adviceGiven: (contact.adviceGiven || "").trim()
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
  const today = parseDateOnly(todayDateString());
  return getContacts().filter((contact) => {
    const followUp = parseDateOnly(contact.followUpDate);
    return followUp && today && today >= followUp;
  });
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

function renderFollowUpAlerts(listId, emptyText = "No follow-ups due today.") {
  const list = document.getElementById(listId);
  if (!list) return;

  const due = getFollowUpsDue();
  if (!due.length) {
    list.innerHTML = `<li class="empty">${escapeHtml(emptyText)}</li>`;
    return;
  }

  list.innerHTML = due
    .map(
      (contact) => `
      <li class="list-item due-item">
        👉 You should reach out to <strong>${escapeHtml(contact.name)}</strong>
        <span class="tiny">(Follow-up: ${formatDate(contact.followUpDate)})</span>
      </li>`
    )
    .join("");
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

function renderContacts() {
  const list = document.getElementById("contactList");
  if (!list) return;

  const contacts = getContacts().sort((a, b) => b.dateMet.localeCompare(a.dateMet));
  if (!contacts.length) {
    list.innerHTML = '<li class="empty">No contacts yet.</li>';
    return;
  }

  const dueIds = new Set(getFollowUpsDue().map((c) => c.id));

  list.innerHTML = contacts
    .map(
      (contact) => `
      <li class="list-item ${dueIds.has(contact.id) ? "due-item" : ""}">
        <p><strong>${escapeHtml(contact.name)}</strong> · ${escapeHtml(contact.email)}</p>
        <p class="tiny">${escapeHtml(contact.role || "Role not set")}</p>
        <p>Met: ${formatDate(contact.dateMet)} | Last contacted: ${formatDate(contact.lastContacted)} | Follow-up: ${formatDate(contact.followUpDate)}</p>
        <p><span class="label">Interests:</span> ${escapeHtml(contact.interests || "-")}</p>
        <p><span class="label">Advice:</span> ${escapeHtml(contact.adviceGiven || "-")}</p>
        <p>${escapeHtml(contact.notes || "")}</p>
        <button class="btn btn-secondary" data-delete-id="${contact.id}" type="button">Delete</button>
      </li>`
    )
    .join("");

  list.querySelectorAll("[data-delete-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.deleteId;
      const next = getContacts().filter((contact) => contact.id !== id);
      saveContacts(next);
      renderContacts();
      renderFollowUpAlerts("networkFollowUps");
      renderInternshipPanel();
    });
  });
}

function initNetworking() {
  const form = document.getElementById("contactForm");
  if (!form) return;

  const error = document.getElementById("contactError");
  const name = document.getElementById("contactName");
  const email = document.getElementById("contactEmail");
  const role = document.getElementById("contactRole");
  const dateMet = document.getElementById("dateMet");
  const lastContacted = document.getElementById("lastContacted");
  const followUpDate = document.getElementById("followUpDate");
  const interests = document.getElementById("interests");
  const adviceGiven = document.getElementById("adviceGiven");
  const notes = document.getElementById("contactNotes");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";

    if (!requireActiveInternship(error)) return;

    const contact = normalizeContact({
      name: name.value,
      email: email.value,
      role: role.value,
      dateMet: dateMet.value,
      lastContacted: lastContacted.value,
      followUpDate: followUpDate.value,
      interests: interests.value,
      adviceGiven: adviceGiven.value,
      notes: notes.value
    });

    if (!contact.name || !contact.email || !contact.dateMet || !contact.followUpDate) {
      error.textContent = "Name, email, date met, and follow-up date are required.";
      return;
    }

    const contacts = getContacts();
    contacts.push(contact);
    saveContacts(contacts);

    form.reset();
    renderContacts();
    renderFollowUpAlerts("networkFollowUps");
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

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

ensureInternshipWorkspace();
initThemeToggle();
initDashboard();
initNetworking();
initSummary();
initInternshipPanel();
