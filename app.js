const STORAGE_KEYS = {
  logs: "interntrack_logs",
  contacts: "interntrack_contacts",
  files: "interntrack_files",
  tone: "interntrack_tone",
  theme: "interntrack_theme",
  internships: "interntrack_internships",
  activeInternshipId: "interntrack_active_internship_id",
  managerName: "interntrack_manager_name",
  yourName: "interntrack_your_name"
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
  return readStore(STORAGE_KEYS.internships, []);
}

function getActiveInternshipId() {
  return readText(STORAGE_KEYS.activeInternshipId, "");
}

function setActiveInternshipId(id) {
  writeText(STORAGE_KEYS.activeInternshipId, id);
}

function scopedKey(baseKey, internshipId = getActiveInternshipId()) {
  return `${baseKey}_${internshipId}`;
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

  [STORAGE_KEYS.managerName, STORAGE_KEYS.yourName].forEach((baseKey) => {
    const scoped = scopedKey(baseKey, defaultId);
    if (localStorage.getItem(scoped) === null && localStorage.getItem(baseKey) !== null) {
      localStorage.setItem(scoped, localStorage.getItem(baseKey));
    }
  });

  localStorage.setItem(migrationFlag, "true");
}

function ensureInternshipWorkspace() {
  let internships = getInternships();

  if (!Array.isArray(internships) || internships.length === 0) {
    internships = [
      {
        id: makeId(),
        name: "Current Internship",
        company: "",
        createdAt: new Date().toISOString()
      }
    ];
    writeStore(STORAGE_KEYS.internships, internships);
  }

  let activeId = getActiveInternshipId();
  const activeExists = internships.some((item) => item.id === activeId);
  if (!activeExists) {
    activeId = internships[0].id;
    setActiveInternshipId(activeId);
  }

  migrateLegacyDataIntoDefaultInternship(activeId);
}

function getInternshipStats(internshipId) {
  return {
    logs: readStore(scopedKey(STORAGE_KEYS.logs, internshipId), []).length,
    contacts: readStore(scopedKey(STORAGE_KEYS.contacts, internshipId), []).length,
    files: readStore(scopedKey(STORAGE_KEYS.files, internshipId), []).length
  };
}

function renderInternshipPanel() {
  const select = document.getElementById("internshipSelect");
  const list = document.getElementById("internshipList");
  if (!select || !list) return;

  const internships = getInternships();
  const activeId = getActiveInternshipId();

  select.innerHTML = internships
    .map((internship) => `<option value="${internship.id}">${escapeHtml(internship.name)}</option>`)
    .join("");
  select.value = activeId;

  list.innerHTML = internships
    .map((internship) => {
      const stats = getInternshipStats(internship.id);
      const label = internship.id === activeId ? "(Active)" : "";
      const companyText = internship.company ? ` · ${escapeHtml(internship.company)}` : "";
      return `
        <li class="list-item">
          <p><strong>${escapeHtml(internship.name)}</strong> ${label}</p>
          <p class="tiny">${companyText.replace(/^ · /, "")}</p>
          <p class="tiny">${stats.logs} logs · ${stats.contacts} contacts · ${stats.files} files</p>
        </li>
      `;
    })
    .join("");
}

function initInternshipPanel() {
  const form = document.getElementById("internshipForm");
  const select = document.getElementById("internshipSelect");
  if (!form || !select) return;

  const error = document.getElementById("internshipError");
  const nameInput = document.getElementById("internshipName");
  const companyInput = document.getElementById("internshipCompany");

  select.addEventListener("change", () => {
    setActiveInternshipId(select.value);
    renderInternshipPanel();
    refreshActivePageData();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";

    const name = nameInput.value.trim();
    const company = companyInput.value.trim();

    if (!name) {
      error.textContent = "Internship name is required.";
      return;
    }

    const internships = getInternships();
    const newInternship = {
      id: makeId(),
      name,
      company,
      createdAt: new Date().toISOString()
    };

    internships.push(newInternship);
    writeStore(STORAGE_KEYS.internships, internships);
    setActiveInternshipId(newInternship.id);

    form.reset();
    renderInternshipPanel();
    refreshActivePageData();
  });

  renderInternshipPanel();
}

function formatDate(value) {
  if (!value) return "No date";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

function getLast7DaysLogs() {
  const logs = readScopedStore(STORAGE_KEYS.logs, []);
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  return logs.filter((log) => {
    const logDate = new Date(`${log.date}T00:00:00`);
    return !Number.isNaN(logDate.getTime()) && logDate >= sevenDaysAgo && logDate <= now;
  });
}

function buildSummary({ logs, managerName, yourName, tone }) {
  const safeManager = managerName?.trim() || "Manager";
  const safeName = yourName?.trim() || "Your Name";

  if (!logs.length) {
    return `Hi ${safeManager},\n\nNo work logs were added in the last 7 days.\n\nBest,\n${safeName}`;
  }

  const bullets = logs.map((log) => `- ${log.text.trim()} (${log.date})`).join("\n");

  if (tone === "casual") {
    return `Hey ${safeManager},\n\nQuick update from this week:\n${bullets}\n\nExcited for next week.\n\nThanks,\n${safeName}`;
  }

  return `Hi ${safeManager},\n\nThis week I worked on:\n${bullets}\n\nLooking forward to next week.\n\nBest,\n${safeName}`;
}

function applyTheme() {
  const theme = localStorage.getItem(STORAGE_KEYS.theme) || "light";
  document.body.classList.toggle("dark", theme === "dark");

  const toggle = document.getElementById("themeToggle");
  if (toggle) {
    toggle.textContent = theme === "dark" ? "☀️ Light" : "🌙 Dark";
  }
}

function initThemeToggle() {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;

  applyTheme();
  toggle.addEventListener("click", () => {
    const isDark = document.body.classList.contains("dark");
    localStorage.setItem(STORAGE_KEYS.theme, isDark ? "light" : "dark");
    applyTheme();
  });
}

function renderLogs() {
  const list = document.getElementById("logList");
  if (!list) return;

  const logs = readScopedStore(STORAGE_KEYS.logs, []).sort((a, b) => b.date.localeCompare(a.date));

  if (!logs.length) {
    list.innerHTML = '<li class="empty">No entries yet.</li>';
    return;
  }

  list.innerHTML = logs
    .map(
      (log) =>
        `<li class="list-item"><p><strong>${formatDate(log.date)}</strong></p><p>${escapeHtml(log.text)}</p></li>`
    )
    .join("");
}

function renderFiles() {
  const list = document.getElementById("fileList");
  if (!list) return;

  const files = readScopedStore(STORAGE_KEYS.files, []).sort((a, b) => b.date.localeCompare(a.date));

  if (!files.length) {
    list.innerHTML = '<li class="empty">No files saved yet.</li>';
    return;
  }

  list.innerHTML = files
    .map(
      (file) => `<li class="list-item"><p><strong>${escapeHtml(file.name)}</strong></p><p>${formatDate(file.date)}</p></li>`
    )
    .join("");
}

function initDashboard() {
  const logForm = document.getElementById("logForm");
  if (!logForm) return;

  const dateInput = document.getElementById("logDate");
  const textInput = document.getElementById("logText");
  const logError = document.getElementById("logError");
  const fileInput = document.getElementById("fileInput");
  const addFileBtn = document.getElementById("addFileBtn");
  const fileError = document.getElementById("fileError");
  const previewBtn = document.getElementById("generatePreviewBtn");
  const previewArea = document.getElementById("summaryPreview");
  const managerNameInput = document.getElementById("managerName");
  const yourNameInput = document.getElementById("yourName");

  const today = new Date().toISOString().split("T")[0];
  dateInput.value = today;

  managerNameInput.addEventListener("input", () => {
    writeScopedText(STORAGE_KEYS.managerName, managerNameInput.value.trim());
  });

  yourNameInput.addEventListener("input", () => {
    writeScopedText(STORAGE_KEYS.yourName, yourNameInput.value.trim());
  });

  logForm.addEventListener("submit", (event) => {
    event.preventDefault();
    logError.textContent = "";

    const date = dateInput.value;
    const text = textInput.value.trim();

    if (!date || !text) {
      logError.textContent = "Date and log text are required.";
      return;
    }

    const logs = readScopedStore(STORAGE_KEYS.logs, []);
    logs.push({ date, text });
    writeScopedStore(STORAGE_KEYS.logs, logs);

    textInput.value = "";
    renderLogs();
    renderInternshipPanel();
  });

  addFileBtn.addEventListener("click", () => {
    fileError.textContent = "";

    if (!fileInput.files || fileInput.files.length === 0) {
      fileError.textContent = "Please choose at least one file.";
      return;
    }

    const todayDate = new Date().toISOString().split("T")[0];
    const files = readScopedStore(STORAGE_KEYS.files, []);

    Array.from(fileInput.files).forEach((file) => {
      files.push({ name: file.name, date: todayDate });
    });

    writeScopedStore(STORAGE_KEYS.files, files);
    fileInput.value = "";
    renderFiles();
    renderInternshipPanel();
  });

  previewBtn.addEventListener("click", () => {
    const logs = getLast7DaysLogs();
    const tone = localStorage.getItem(STORAGE_KEYS.tone) || "formal";
    previewArea.value = buildSummary({
      logs,
      managerName: managerNameInput.value,
      yourName: yourNameInput.value,
      tone
    });
  });

  refreshActivePageData = () => {
    managerNameInput.value = readScopedText(STORAGE_KEYS.managerName, "");
    yourNameInput.value = readScopedText(STORAGE_KEYS.yourName, "");
    previewArea.value = "";
    renderLogs();
    renderFiles();
  };

  refreshActivePageData();
}

function renderContacts() {
  const list = document.getElementById("contactList");
  if (!list) return;

  const contacts = readScopedStore(STORAGE_KEYS.contacts, []);

  if (!contacts.length) {
    list.innerHTML = '<li class="empty">No contacts yet.</li>';
    return;
  }

  list.innerHTML = contacts
    .map(
      (contact, index) => `
      <li class="list-item">
        <p><strong>${escapeHtml(contact.name)}</strong> · ${escapeHtml(contact.email)}</p>
        <p>Met: ${formatDate(contact.dateMet)} | Follow-up: ${formatDate(contact.followUp)}</p>
        <p>${escapeHtml(contact.notes)}</p>
        <button class="btn btn-secondary" data-delete-index="${index}" type="button">Delete</button>
      </li>`
    )
    .join("");

  list.querySelectorAll("[data-delete-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const idx = Number(button.dataset.deleteIndex);
      const updated = readScopedStore(STORAGE_KEYS.contacts, []).filter((_, i) => i !== idx);
      writeScopedStore(STORAGE_KEYS.contacts, updated);
      renderContacts();
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
  const dateMet = document.getElementById("dateMet");
  const notes = document.getElementById("contactNotes");
  const followUp = document.getElementById("followUp");

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.textContent = "";

    const data = {
      name: name.value.trim(),
      email: email.value.trim(),
      dateMet: dateMet.value,
      notes: notes.value.trim(),
      followUp: followUp.value
    };

    if (!data.name || !data.email || !data.dateMet || !data.notes || !data.followUp) {
      error.textContent = "Please fill out all contact fields.";
      return;
    }

    const contacts = readScopedStore(STORAGE_KEYS.contacts, []);
    contacts.push(data);
    writeScopedStore(STORAGE_KEYS.contacts, contacts);

    form.reset();
    renderContacts();
    renderInternshipPanel();
  });

  refreshActivePageData = () => {
    renderContacts();
  };

  refreshActivePageData();
}

async function fetchQuote() {
  try {
    const response = await fetch("https://api.quotable.io/random");
    if (!response.ok) {
      throw new Error("Failed to fetch quote");
    }

    const data = await response.json();
    return `“${data.content}” — ${data.author}`;
  } catch {
    return "Motivation unavailable right now. Keep moving forward.";
  }
}

function renderWeeklyLogs() {
  const weeklyLogsList = document.getElementById("weeklyLogs");
  if (!weeklyLogsList) return [];

  const logs = getLast7DaysLogs().sort((a, b) => a.date.localeCompare(b.date));

  if (!logs.length) {
    weeklyLogsList.innerHTML = '<li class="empty">No logs from the last 7 days.</li>';
    return [];
  }

  weeklyLogsList.innerHTML = logs
    .map((log) => `<li class="list-item"><p><strong>${formatDate(log.date)}</strong></p><p>${escapeHtml(log.text)}</p></li>`)
    .join("");

  return logs;
}

function setToneUI(tone, formalBtn, casualBtn) {
  formalBtn.classList.toggle("btn-secondary", tone !== "formal");
  casualBtn.classList.toggle("btn-secondary", tone !== "casual");
}

function initSummary() {
  const generateBtn = document.getElementById("generateSummaryBtn");
  if (!generateBtn) return;

  const formalBtn = document.getElementById("formalBtn");
  const casualBtn = document.getElementById("casualBtn");
  const copyBtn = document.getElementById("copySummaryBtn");
  const summaryArea = document.getElementById("generatedSummary");
  const quoteText = document.getElementById("quoteText");
  const message = document.getElementById("summaryMessage");
  const managerNameInput = document.getElementById("summaryManagerName");
  const yourNameInput = document.getElementById("summaryYourName");

  managerNameInput.addEventListener("input", () => {
    writeScopedText(STORAGE_KEYS.managerName, managerNameInput.value.trim());
  });

  yourNameInput.addEventListener("input", () => {
    writeScopedText(STORAGE_KEYS.yourName, yourNameInput.value.trim());
  });

  let tone = localStorage.getItem(STORAGE_KEYS.tone) || "formal";
  setToneUI(tone, formalBtn, casualBtn);

  formalBtn.addEventListener("click", () => {
    tone = "formal";
    localStorage.setItem(STORAGE_KEYS.tone, tone);
    setToneUI(tone, formalBtn, casualBtn);
  });

  casualBtn.addEventListener("click", () => {
    tone = "casual";
    localStorage.setItem(STORAGE_KEYS.tone, tone);
    setToneUI(tone, formalBtn, casualBtn);
  });

  generateBtn.addEventListener("click", async () => {
    message.textContent = "";
    const logs = renderWeeklyLogs();

    summaryArea.value = buildSummary({
      logs,
      managerName: managerNameInput.value,
      yourName: yourNameInput.value,
      tone
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
    managerNameInput.value = readScopedText(STORAGE_KEYS.managerName, "");
    yourNameInput.value = readScopedText(STORAGE_KEYS.yourName, "");
    summaryArea.value = "";
    message.textContent = "";
    quoteText.textContent = 'Click "Generate Summary" to load a motivation quote.';
    renderWeeklyLogs();
  };

  refreshActivePageData();
}

function escapeHtml(value = "") {
  return value
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
