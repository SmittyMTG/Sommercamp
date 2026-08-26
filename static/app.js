// ===========================================================
// Sommercamp 2026 — Grundgerüst
// Screen-Navigation + Countdown. Datenanbindung folgt später.
// ===========================================================

// Zentrale 401-Behandlung für ALLE fetch()-Aufrufe in dieser Datei: sobald die
// Session ungültig ist (abgelaufenes Cookie, Logout auf einem anderen Gerät),
// sofort zum Login weiterleiten — statt dass Listen im Hintergrund still
// fehlschlagen und man erst durch manuelles Neuladen merkt, dass man raus ist.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401 && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
  return res;
};

// Ganz oben deklariert (nicht erst im Kosten-Abschnitt), damit fetchUsersAndMe()
// von JEDER Stelle im Skript aus sicher aufgerufen werden kann, auch von Code,
// der weiter oben in der Datei steht — sonst greift die "temporal dead zone"
// von let/const und ein zu früher Aufruf wirft einen ReferenceError.
let cachedUsers = null;
let cachedMe = null;

// Wird von fetchUsersAndMe() bei jedem erfolgreichen Abruf aktualisiert —
// einziger Ort, an dem Farbe/Profilbild pro User zwischengespeichert werden,
// damit nameTag() sie überall synchron (ohne eigenen Fetch) nutzen kann.
let USER_COLORS = {};
let USER_AVATARS = {};
function updateUserLookupMaps(users) {
  (users || []).forEach((u) => {
    if (u.color) USER_COLORS[u.username] = u.color;
    if (u.avatar_path) USER_AVATARS[u.username] = u.avatar_path;
    else delete USER_AVATARS[u.username];
  });
}

/* ---------- Screen switching ---------- */
function goToScreen(name, opts = {}) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.classList.toggle("active", el.id === `screen-${name}`);
  });
  document.querySelectorAll(".bottom-nav button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === name);
  });
  // Schwebende "+"-Buttons liegen außerhalb von .app-shell (siehe
  // index.html) und werden deshalb hier statt über CSS-Verschachtelung
  // pro Screen ein-/ausgeblendet.
  document.querySelectorAll("[data-fab-for]").forEach((btn) => {
    btn.classList.toggle("hidden", btn.dataset.fabFor !== name);
  });
  // Nicht mehr window.scrollTo: body scrollt bewusst nicht mehr (siehe CSS),
  // .app-shell ist jetzt der eigentliche Scroll-Container. preserveScroll
  // wird nur beim Wiederherstellen der letzten Position beim Login gesetzt
  // (siehe restoreUiState) — ein normaler Tab-Wechsel scrollt wie gewohnt
  // nach oben.
  if (!opts.preserveScroll) {
    const shell = document.querySelector(".app-shell");
    if (shell) shell.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
  saveUiState({ screen: name });
}

/* ---------- Zustand pro User merken: zuletzt offener Screen + Scrollposition,
   aktive Filter/Sortierung bei Tasks & Kosten, … — liegt serverseitig
   (GET/PATCH /api/me/ui-state), damit es auch geräteübergreifend erhalten
   bleibt, "bis man es aktiv rausmacht". localStorage dient nur als
   Sofort-Cache: schreibt ohne Netzwerk-Latenz, synct debounced zum Server. */
function uiStateKey(username) {
  return `sommercamp_ui_state_${username}`;
}
let uiStateCache = {};
let pendingUiStatePatch = {};
let uiStateSaveTimeout = null;

function saveUiState(patch) {
  if (!cachedMe) return;
  Object.assign(uiStateCache, patch);
  Object.assign(pendingUiStatePatch, patch);
  try {
    localStorage.setItem(uiStateKey(cachedMe.username), JSON.stringify(uiStateCache));
  } catch (err) {
    // Privater Modus / Speicher voll — Server-Sync unten läuft trotzdem weiter.
  }
  clearTimeout(uiStateSaveTimeout);
  uiStateSaveTimeout = setTimeout(() => {
    const toSend = pendingUiStatePatch;
    pendingUiStatePatch = {};
    if (Object.keys(toSend).length === 0) return;
    fetch("/api/me/ui-state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toSend),
    }).catch(() => {
      // Netzwerkhänger — Zustand bleibt zumindest lokal erhalten (siehe oben).
    });
  }, 500);
}

// Server ist die führende Quelle (geräteübergreifend), localStorage nur der
// Fallback, falls der Request mal fehlschlägt (z. B. offline).
async function loadUiState(username) {
  try {
    const res = await fetch("/api/me/ui-state");
    if (res.ok) {
      const state = await res.json();
      if (state && Object.keys(state).length > 0) {
        uiStateCache = state;
        return state;
      }
    }
  } catch (err) {
    // fällt unten auf localStorage zurück
  }
  try {
    const local = JSON.parse(localStorage.getItem(uiStateKey(username)) || "null");
    if (local) uiStateCache = local;
    return local;
  } catch (err) {
    return null;
  }
}

// Mehrere unabhängige Init-Blöcke (Tasks, Kosten, Screen-Restore) brauchen
// alle den geladenen Zustand — ein geteiltes Promise sorgt dafür, dass
// /api/me/ui-state trotzdem nur EINMAL abgerufen wird, egal wer zuerst dran ist.
let uiStateReadyPromise = null;
function ensureUiStateLoaded(username) {
  if (!uiStateReadyPromise) uiStateReadyPromise = loadUiState(username);
  return uiStateReadyPromise;
}

function initNavigation() {
  document.querySelectorAll("[data-screen]").forEach((btn) => {
    btn.addEventListener("click", () => goToScreen(btn.dataset.screen));
  });
  document.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => goToScreen(btn.dataset.go));
  });
}

/* ---------- Helpers ---------- */
// Ersetzt den Mülleimer-Emoji auf Löschen-Buttons: Emoji ignorieren CSS
// color (fixe bunte Glyphe, kein Hover-Feedback), dieses Icon nutzt
// currentColor und folgt damit .delete-btn's grau→rot-Übergang beim Hover.
const TRASH_ICON_SVG = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11"/><path d="M5.5 4V2.6c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V4"/><path d="M3.4 4l.6 8.8c0 .6.5 1.1 1.1 1.1h5.8c.6 0 1.1-.5 1.1-1.1L12.6 4"/><path d="M6.4 7v4"/><path d="M9.6 7v4"/></svg>`;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function isAdminRole(role) {
  return typeof role === "string" && role.trim().toLowerCase() === "admin";
}

// Blasse Variante einer Hex-Nutzerfarbe (für unausgewählte Chips, siehe
// beneficiaryOptions unten) — rgba() statt CSS color-mix(), damit es auch in
// älteren Browsern funktioniert.
function hexToRgba(hex, alpha) {
  const clean = (hex || "").replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Kleines Profilbild (oder "?"-Platzhalter) vor dem Namen — Admin-verwaltbare
// Farbe (USER_COLORS, aus /api/users) sorgt zusätzlich für Wiedererkennung auf
// einen Blick, unabhängig vom Kontext (Aufgaben, Ausgaben, Zahlungen,
// Geldfluss-Diagramm). Namen ohne Farbeintrag bleiben schlicht (kein Tag).
function avatarCircleHtml(username, size) {
  size = size || 18;
  const avatarPath = USER_AVATARS[username];
  const style = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.55)}px`;
  return avatarPath
    ? `<img class="name-avatar" src="${avatarPath}" alt="" style="${style}">`
    : `<span class="name-avatar name-avatar-fallback" style="${style}">?</span>`;
}

function nameTag(username) {
  const safe = escapeHtml(username);
  const color = USER_COLORS[username];
  const avatar = avatarCircleHtml(username, 16);
  // Avatar + Name als EIN geschlossenes Element: die Farbe umschließt beides
  // (siehe .name-pill in style.css), statt nur als separate Pille neben dem
  // Avatar zu schweben.
  if (!color) return `<span class="name-with-avatar">${avatar}${safe}</span>`;
  return `<span class="name-with-avatar name-pill" style="--tag-color:${color}">${avatar}<span>${safe}</span></span>`;
}

/* ---------- Generic modal ---------- */
const modal = document.getElementById("modal");
const modalForm = document.getElementById("modalForm");
const modalTitle = document.getElementById("modalTitle");
const modalEyebrow = document.getElementById("modalEyebrow");
const modalBody = document.getElementById("modalBody");
const modalSubmit = document.getElementById("modalSubmit");

let modalSubmitHandler = null;

// Ersatz für das native, unstylbare confirm() — gleicher Look wie der Rest
// der App (roter Akzent, siehe .delete-dialog), auch während bereits das
// Haupt-Modal offen ist (verschachtelte <dialog>-Elemente stapeln sich
// zuverlässig, jede mit eigenem Backdrop).
const confirmDialogEl = document.getElementById("confirmDialog");
const confirmDialogMessageEl = document.getElementById("confirmDialogMessage");
const confirmDialogOkBtn = document.getElementById("confirmDialogOk");
const confirmDialogCancelBtn = document.getElementById("confirmDialogCancel");
let confirmDialogResolve = null;

function showConfirm(message, okLabel) {
  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
    confirmDialogMessageEl.textContent = message;
    confirmDialogOkBtn.textContent = okLabel || "Verwerfen";
    confirmDialogEl.showModal();
  });
}
function resolveConfirm(result) {
  if (confirmDialogEl.open) confirmDialogEl.close();
  if (confirmDialogResolve) {
    confirmDialogResolve(result);
    confirmDialogResolve = null;
  }
}
if (confirmDialogOkBtn) confirmDialogOkBtn.addEventListener("click", () => resolveConfirm(true));
if (confirmDialogCancelBtn) confirmDialogCancelBtn.addEventListener("click", () => resolveConfirm(false));
if (confirmDialogEl) {
  confirmDialogEl.addEventListener("cancel", (e) => {
    e.preventDefault();
    resolveConfirm(false);
  });
}

// Schnappschuss aller Feldwerte im Modal, um beim Schließen zu erkennen, ob
// sich seit dem Öffnen etwas geändert hat (siehe hasUnsavedModalChanges).
function snapshotModalFormState() {
  // [data-live-save] Felder (z. B. Teilaufgaben-Checkboxen) speichern sofort
  // eigenständig beim Ändern — sollen daher nicht als "ungespeicherte Eingabe"
  // des Hauptformulars zählen und keinen unnötigen Verwerfen-Dialog auslösen.
  return Array.from(modalBody.querySelectorAll("input, textarea, select"))
    .filter((el) => !el.closest("[data-live-save]"))
    .map((el) => (el.type === "checkbox" || el.type === "radio" ? (el.checked ? "1" : "0") : el.value))
    .join("|");
}

let initialModalSnapshot = null;
let modalOpenToken = 0;

function openModal({ eyebrow, title, bodyHtml, onSubmit, submitLabel, danger }) {
  modalEyebrow.textContent = eyebrow || "";
  modalTitle.textContent = title || "";
  modalBody.innerHTML = bodyHtml || "";
  modalSubmitHandler = onSubmit;
  modalSubmit.textContent = submitLabel || "Speichern";

  modal.classList.toggle("delete-dialog", !!danger);
  modalSubmit.classList.toggle("danger", !!danger);

  modal.showModal();
  const firstInput = modalBody.querySelector("input, textarea, select");
  if (firstInput) firstInput.focus();

  // Erst NACH eventuellem Nach-Wiring (z. B. wireExpenseForm(), das nach
  // openModal() noch synchron weitere Felder befüllt) den Ausgangszustand
  // festhalten — per Timeout, damit der ganze aufrufende Code vorher durchläuft.
  initialModalSnapshot = null;
  modalOpenToken += 1;
  const token = modalOpenToken;
  setTimeout(() => {
    if (token === modalOpenToken) initialModalSnapshot = snapshotModalFormState();
  }, 0);
}

function hasUnsavedModalChanges() {
  return initialModalSnapshot !== null && snapshotModalFormState() !== initialModalSnapshot;
}

function closeModal() {
  modal.close();
  modal.classList.remove("delete-dialog");
  modalForm.reset();
  modalSubmitHandler = null;
  initialModalSnapshot = null;
  modalSubmit.classList.remove("danger");
}

// Fragt bei ungespeicherten Eingaben nach, bevor wirklich geschlossen wird —
// verhindert versehentlichen Datenverlust durch Wegklicken/Zurück/ESC.
async function requestCloseModal() {
  if (hasUnsavedModalChanges() && !(await showConfirm("Was du eingegeben hast, geht sonst verloren."))) {
    return;
  }
  closeModal();
}

document.getElementById("modalClose").addEventListener("click", requestCloseModal);
document.getElementById("modalCancel").addEventListener("click", requestCloseModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) requestCloseModal();
});
// "cancel" feuert, wenn der Dialog nativ per ESC geschlossen werden soll —
// preventDefault() stoppt das native Schließen, damit auch dieser Weg über
// requestCloseModal läuft statt die Bestätigung zu umgehen.
modal.addEventListener("cancel", async (e) => {
  if (hasUnsavedModalChanges()) {
    e.preventDefault();
    if (await showConfirm("Was du eingegeben hast, geht sonst verloren.")) {
      closeModal();
    }
  }
});

modalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (modalSubmitHandler) {
    await modalSubmitHandler();
  }
});

/* ---------- Aufgaben-Kategorien (z. B. "Einkauf", "Aufbau") — wird von der
   privaten "Tasks"-Seite weiterverwendet, siehe unten ---------- */
let cachedTaskCategories = null;

async function fetchTaskCategories(forceRefresh) {
  if (cachedTaskCategories && !forceRefresh) return cachedTaskCategories;
  const res = await fetch("/api/task-categories");
  cachedTaskCategories = res.ok ? await res.json() : [];
  return cachedTaskCategories;
}

function taskCategoryOptionsHtml(categories, selectedId) {
  return categories
    .map(
      (c) =>
        `<option value="${c.id}"${c.id === selectedId ? " selected" : ""}>${escapeHtml(c.bezeichnung)}</option>`
    )
    .join("");
}

/* ---------- "Tasks" (privat/projekt-getaggt, aktuell nur für Felix sichtbar
   über die Nav — Zugriff wird zusätzlich serverseitig geprüft, siehe main.py) ---------- */
const privateTaskListEl = document.getElementById("privateTaskList");
const privateTaskFilterRow = document.getElementById("privateTaskFilterRow");
const privateTaskFilterBtn = document.getElementById("privateTaskFilterBtn");
const privateTaskSortBtn = document.getElementById("privateTaskSortBtn");

let lastPrivateTaskItems = [];
// scopeMode: schnelle Pillen (Alle/Meine/Privat). statusFilter/projectFilterId:
// Detail-Filter aus dem "Filtern"-Fenster. Alle drei kombinieren sich (UND).
let privateTaskScopeMode = "alle";
let privateTaskStatusFilter = "alle";
let privateTaskProjectFilterId = "";
let privateTaskSortMode = "deadline";
let cachedProjects = null;

function formatDeadline(iso) {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
  });
}

function isPrivateTaskOverdue(task) {
  if (task.done || !task.deadline) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(task.deadline) < today;
}

function filterPrivateTasks(items, scopeMode, statusFilter, projectId) {
  let out = items;
  if (scopeMode === "meine" && cachedMe) out = out.filter((t) => t.assignees.some((a) => a.id === cachedMe.id));
  else if (scopeMode === "privat") out = out.filter((t) => !t.project);
  if (statusFilter === "offen") out = out.filter((t) => !t.done);
  else if (statusFilter === "ueberfaellig") out = out.filter((t) => isPrivateTaskOverdue(t));
  if (projectId === "privat") out = out.filter((t) => !t.project);
  else if (projectId) out = out.filter((t) => t.project && String(t.project.id) === String(projectId));
  return out;
}

function sortPrivateTasks(items, mode) {
  const sortWithin = (arr) => {
    const out = [...arr];
    if (mode === "titel") {
      out.sort((a, b) => a.titel.localeCompare(b.titel, "de"));
    } else if (mode === "deadline") {
      out.sort((a, b) => {
        if (!a.deadline && !b.deadline) return 0;
        if (!a.deadline) return 1;
        if (!b.deadline) return -1;
        return new Date(a.deadline) - new Date(b.deadline);
      });
    } else if (mode === "kategorie") {
      out.sort((a, b) => {
        const an = a.category ? a.category.bezeichnung : "￿";
        const bn = b.category ? b.category.bezeichnung : "￿";
        return an.localeCompare(bn, "de");
      });
    } else if (mode === "projekt") {
      out.sort((a, b) => {
        const an = a.project ? a.project.name : "￿";
        const bn = b.project ? b.project.name : "￿";
        return an.localeCompare(bn, "de");
      });
    }
    // "neu" = Server-Reihenfolge (created_at absteigend), keine Änderung nötig
    return out;
  };
  const open = items.filter((t) => !t.done);
  const done = items.filter((t) => t.done);
  return [...sortWithin(open), ...sortWithin(done)];
}

function renderPrivateTaskItem(task) {
  const card = document.createElement("div");
  card.className = "list-card clickable" + (task.done ? " done" : "");
  card.dataset.id = task.id;

  const overdue = isPrivateTaskOverdue(task);
  const metaParts = [];
  if (task.deadline) {
    const label = `📅 ${formatDeadline(task.deadline)}`;
    metaParts.push(overdue ? `<span class="danger">⚠️ ${label}</span>` : label);
  }
  if (task.assignees && task.assignees.length) {
    const verb = task.assignees.length > 1 ? "sind verantwortlich" : "ist verantwortlich";
    metaParts.push(`${task.assignees.map((a) => nameTag(a.username)).join(", ")} ${verb}`);
  }

  const categoryTag = task.category
    ? `<span class="category-tag"><span class="category-tag-dot" style="background:${escapeHtml(task.category.farbe)}"></span>${escapeHtml(task.category.bezeichnung)}</span>`
    : "";
  const projectTag = `<span class="category-tag project-tag">🗂 ${task.project ? escapeHtml(task.project.name) : "Privat"}</span>`;

  const descHtml = task.beschreibung
    ? `<p class="list-card-meta">${escapeHtml(task.beschreibung)}</p>`
    : "";

  const subitems = task.subitems || [];
  const subitemsDone = subitems.filter((s) => s.done).length;
  const subitemsHtml = subitems.length
    ? `
      <p class="list-card-meta subitems-progress">Teilaufgaben: ${subitemsDone}/${subitems.length}</p>
      <div class="subitems-list">
        ${subitems
          .map(
            (s) => `
              <label class="subitem-row${s.done ? " done" : ""}">
                <input type="checkbox" data-sub-id="${s.id}"${s.done ? " checked" : ""}>
                <span>${escapeHtml(s.titel)}</span>
              </label>
            `
          )
          .join("")}
      </div>
    `
    : "";

  card.innerHTML = `
    <div class="list-card-content">
      <button type="button" class="list-card-checkbox${task.done ? " checked" : ""}" aria-label="Erledigt"></button>
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(task.titel)}</p>
        ${categoryTag}${projectTag}
        ${metaParts.length ? `<p class="list-card-meta">${metaParts.join(" · ")}</p>` : ""}
        ${descHtml}
        ${subitemsHtml}
      </div>
    </div>
    <div class="list-card-actions">
      <button type="button" class="delete-btn" aria-label="Löschen">${TRASH_ICON_SVG}</button>
    </div>
  `;

  card.addEventListener("click", () => openEditPrivateTaskModal(task));

  const checkbox = card.querySelector(".list-card-checkbox");
  checkbox.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const res = await fetch(`/api/private-tasks/${task.id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      checkbox.classList.toggle("checked", data.done);
      card.classList.toggle("done", data.done);
      task.done = data.done;
      loadPrivateTasks(true);
    }
  });

  card.querySelectorAll(".subitem-row input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = await fetch(`/api/private-tasks/${task.id}/subitems/${cb.dataset.subId}/toggle`, { method: "PATCH" });
      if (res.ok) loadPrivateTasks(true);
    });
  });

  card.querySelector(".delete-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openModal({
      eyebrow: "Task",
      title: `„${task.titel}" löschen?`,
      bodyHtml: `<p class="muted warning-text">Das lässt sich nicht rückgängig machen.</p>`,
      submitLabel: "Löschen",
      danger: true,
      onSubmit: async () => {
        const res = await fetch(`/api/private-tasks/${task.id}`, { method: "DELETE" });
        if (res.ok) loadPrivateTasks(true);
        closeModal();
      },
    });
  });

  return card;
}

function renderFilteredSortedPrivateTasks() {
  if (!privateTaskListEl) return;
  const filtered = filterPrivateTasks(
    lastPrivateTaskItems,
    privateTaskScopeMode,
    privateTaskStatusFilter,
    privateTaskProjectFilterId
  );
  const sorted = sortPrivateTasks(filtered, privateTaskSortMode);

  privateTaskListEl.innerHTML = "";
  if (sorted.length === 0) {
    privateTaskListEl.innerHTML = `<div class="empty-state"><p>Noch keine Tasks.</p></div>`;
  } else {
    sorted.forEach((t) => privateTaskListEl.appendChild(renderPrivateTaskItem(t)));
  }
}

let lastPrivateTaskSignature = "";
async function loadPrivateTasks(force) {
  if (!privateTaskListEl) return;
  try {
    const res = await fetch("/api/private-tasks");
    if (!res.ok) return;
    const data = await res.json();
    const signature = JSON.stringify(data);
    if (!force && signature === lastPrivateTaskSignature) return;
    lastPrivateTaskSignature = signature;
    lastPrivateTaskItems = data;
    renderFilteredSortedPrivateTasks();
  } catch (err) {
    // Netzwerkhänger ignorieren, nächster Poll versucht es erneut
  }
}

function setPrivateTaskScopeUI(mode) {
  privateTaskScopeMode = mode;
  if (privateTaskFilterRow) {
    privateTaskFilterRow.querySelectorAll(".filter").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === mode);
    });
  }
}

if (privateTaskFilterRow) {
  privateTaskFilterRow.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      setPrivateTaskScopeUI(btn.dataset.filter);
      renderFilteredSortedPrivateTasks();
      saveUiState({ tasksScope: privateTaskScopeMode });
    });
  });
}

// "Filtern" und "Sortieren" markieren sich selbst als aktiv (gleiche Farbe
// wie die Filter-Pillen), solange etwas von "Alle"/"Deadline" abweicht —
// sichtbares Zeichen, dass gerade eingegrenzt/umsortiert ist.
function updatePrivateTaskFilterSortButtons() {
  if (privateTaskFilterBtn) {
    const active = privateTaskStatusFilter !== "alle" || !!privateTaskProjectFilterId;
    privateTaskFilterBtn.classList.toggle("filter-btn-active", active);
  }
  if (privateTaskSortBtn) {
    privateTaskSortBtn.classList.toggle("filter-btn-active", privateTaskSortMode !== "deadline");
  }
}

async function openPrivateTaskFilterModal() {
  const projects = await fetchProjects();
  openModal({
    eyebrow: "Tasks",
    title: "Filtern",
    submitLabel: "Anwenden",
    bodyHtml: `
      <div class="form-stack">
        <label>Status
          <select id="taskFilterStatusSelect">
            <option value="alle">Alle</option>
            <option value="offen">Offen</option>
            <option value="ueberfaellig">Überfällig</option>
          </select>
        </label>
        <label>Projekt
          <select id="taskFilterProjectSelect">
            <option value="">Alle Projekte</option>
            <option value="privat">Privat</option>
            ${privateTaskProjectOptionsHtml(projects, "")}
          </select>
        </label>
      </div>
    `,
    onSubmit: async () => {
      privateTaskStatusFilter = document.getElementById("taskFilterStatusSelect").value;
      privateTaskProjectFilterId = document.getElementById("taskFilterProjectSelect").value;
      closeModal();
      renderFilteredSortedPrivateTasks();
      updatePrivateTaskFilterSortButtons();
      saveUiState({
        tasksStatusFilter: privateTaskStatusFilter,
        tasksProjectFilter: privateTaskProjectFilterId,
      });
    },
  });
  document.getElementById("taskFilterStatusSelect").value = privateTaskStatusFilter;
  document.getElementById("taskFilterProjectSelect").value = privateTaskProjectFilterId;
}

function openPrivateTaskSortModal() {
  openModal({
    eyebrow: "Tasks",
    title: "Sortieren",
    submitLabel: "Anwenden",
    bodyHtml: `
      <div class="form-stack">
        <label>Sortieren nach
          <select id="taskSortModalSelect">
            <option value="deadline">Deadline</option>
            <option value="neu">Neu zuerst</option>
            <option value="titel">Titel (A–Z)</option>
            <option value="kategorie">Kategorie</option>
            <option value="projekt">Projekt</option>
          </select>
        </label>
      </div>
    `,
    onSubmit: async () => {
      privateTaskSortMode = document.getElementById("taskSortModalSelect").value;
      closeModal();
      renderFilteredSortedPrivateTasks();
      updatePrivateTaskFilterSortButtons();
      saveUiState({ tasksSort: privateTaskSortMode });
    },
  });
  document.getElementById("taskSortModalSelect").value = privateTaskSortMode;
}

if (privateTaskFilterBtn) privateTaskFilterBtn.addEventListener("click", openPrivateTaskFilterModal);
if (privateTaskSortBtn) privateTaskSortBtn.addEventListener("click", openPrivateTaskSortModal);

/* ---------- Tasks: Projekte (privat / geteilte Projekt-Tags) ---------- */

async function fetchProjects(forceRefresh) {
  if (cachedProjects && !forceRefresh) return cachedProjects;
  const res = await fetch("/api/projects");
  cachedProjects = res.ok ? await res.json() : [];
  return cachedProjects;
}

function privateTaskProjectOptionsHtml(projects, selectedId) {
  return projects
    .map(
      (p) =>
        `<option value="${p.id}"${String(p.id) === String(selectedId) ? " selected" : ""}>${escapeHtml(p.name)}</option>`
    )
    .join("");
}

function privateTaskModalBodyHtml(categories, projects, isAdmin, prefill = {}, users = []) {
  const currentCategoryId = prefill.category ? prefill.category.id : null;
  const currentProjectId = prefill.project ? prefill.project.id : "";
  const deadlineValue = prefill.deadline ? prefill.deadline.slice(0, 10) : "";

  // Gleiche Chip-Optik wie "Für wen?" bei der Ausgaben-Erfassung — hier aber
  // standardmäßig alle abgewählt (blass), nicht alle ausgewählt: eine Task
  // hat i. d. R. niemanden oder gezielt eine/wenige Personen verantwortlich.
  const currentAssigneeIds = new Set((prefill.assignees || []).map((a) => a.id));
  const assigneeOptions = users
    .map((u) => {
      const checked = currentAssigneeIds.has(u.id);
      const color = USER_COLORS[u.username] || "#ffd400";
      const pale = hexToRgba(color, 0.16);
      return `<label class="beneficiary-chip${checked ? " checked" : ""}" style="--chip-color:${color};--chip-pale:${pale}"><input type="checkbox" class="beneficiary-checkbox" value="${u.id}"${checked ? " checked" : ""}><span>${escapeHtml(u.username)}</span></label>`;
    })
    .join("");

  return `
    <div class="form-stack">
      <div class="checkbox-group">
        <div class="eyebrow">Verantwortlich</div>
        <div id="privTaskAssignees" class="chip-row">${assigneeOptions}</div>
      </div>
      <label>Titel
        <input type="text" id="privTaskTitelInput" maxlength="80" value="${escapeHtml(prefill.titel || "")}" required>
      </label>
      <label>Beschreibung (optional)
        <textarea id="privTaskBeschreibungInput" placeholder="Details …">${escapeHtml(prefill.beschreibung || "")}</textarea>
      </label>
      <label>Projekt
        <select id="privTaskProjectSelect">
          <option value=""${currentProjectId === "" ? " selected" : ""}>Privat</option>
          ${privateTaskProjectOptionsHtml(projects, currentProjectId)}
          ${isAdmin ? `<option value="__new__">+ Neues Projekt anlegen…</option>` : ""}
        </select>
      </label>
      ${
        isAdmin
          ? `
      <div id="newPrivTaskProjectFields" class="form-stack hidden">
        <label>Projektname
          <input type="text" id="newPrivTaskProjectName" maxlength="60">
        </label>
        <button type="button" id="createPrivTaskProjectBtn" class="secondary compact">Projekt anlegen</button>
        <p class="error-text hidden new-priv-task-project-error"></p>
      </div>
      `
          : ""
      }
      <label>Kategorie (optional)
        <select id="privTaskCategorySelect">
          <option value="">— keine Angabe —</option>
          ${taskCategoryOptionsHtml(categories, currentCategoryId)}
          <option value="__new__">+ Neue Kategorie anlegen…</option>
        </select>
      </label>
      <div id="newPrivTaskCategoryFields" class="form-stack hidden">
        <label>Farbe
          <input type="color" id="newPrivTaskCategoryColor" value="#ffd400">
        </label>
        <label>Bezeichnung
          <input type="text" id="newPrivTaskCategoryLabel" maxlength="16">
        </label>
        <button type="button" id="createPrivTaskCategoryBtn" class="secondary compact">Kategorie anlegen</button>
        <p class="error-text hidden new-priv-task-category-error"></p>
      </div>
      <div class="deadline-row">
        <label>Deadline (optional)
          <input type="date" id="privTaskDeadlineInput" value="${deadlineValue}">
        </label>
        <button type="button" id="privTaskDeadlineTodayBtn" class="secondary compact">Heute!</button>
        <button type="button" id="privTaskDeadlineTomorrowBtn" class="secondary compact">Morgen!</button>
      </div>
      ${
        prefill.id
          ? `
        <div class="checkbox-group" data-live-save>
          <div class="eyebrow">Teilaufgaben</div>
          <div id="privTaskSubitemsList" class="stack"></div>
          <div class="action-row">
            <input type="text" id="newPrivSubitemInput" placeholder="Neue Teilaufgabe…" maxlength="120">
            <button type="button" id="addPrivSubitemBtn" class="secondary compact">+ Hinzufügen</button>
          </div>
        </div>
      `
          : ""
      }
    </div>
  `;
}

// Fallback für Browser ohne :has() — siehe syncBeneficiaryChipClasses oben,
// gleiches Prinzip nur auf den Verantwortlich-Chips der Tasks-Seite.
function wirePrivateTaskAssigneeChips() {
  const container = document.getElementById("privTaskAssignees");
  if (!container) return;
  container.querySelectorAll(".beneficiary-chip").forEach((chip) => {
    const cb = chip.querySelector(".beneficiary-checkbox");
    if (!cb) return;
    cb.addEventListener("change", () => chip.classList.toggle("checked", cb.checked));
  });
}

// "Heute!"/"Morgen!" füllen nur das Datumsfeld — gespeichert wird erst beim
// regulären Modal-Submit, kein eigener API-Call nötig.
function wirePrivateTaskDeadlineShortcuts() {
  const input = document.getElementById("privTaskDeadlineInput");
  const todayBtn = document.getElementById("privTaskDeadlineTodayBtn");
  const tomorrowBtn = document.getElementById("privTaskDeadlineTomorrowBtn");
  if (!input || !todayBtn || !tomorrowBtn) return;
  todayBtn.addEventListener("click", () => {
    input.value = isoDateLocal(new Date());
  });
  tomorrowBtn.addEventListener("click", () => {
    input.value = isoDateLocal(addDays(new Date(), 1));
  });
}

function wirePrivateTaskCategoryPicker() {
  const categorySelect = document.getElementById("privTaskCategorySelect");
  const newFields = document.getElementById("newPrivTaskCategoryFields");
  categorySelect.addEventListener("change", () => {
    newFields.classList.toggle("hidden", categorySelect.value !== "__new__");
  });

  document.getElementById("createPrivTaskCategoryBtn").addEventListener("click", async () => {
    const colorInput = document.getElementById("newPrivTaskCategoryColor");
    const labelInput = document.getElementById("newPrivTaskCategoryLabel");
    const errEl = document.querySelector(".new-priv-task-category-error");
    const bezeichnung = labelInput.value.trim();
    errEl.classList.add("hidden");

    if (!bezeichnung) {
      errEl.textContent = "Bitte eine Bezeichnung eingeben.";
      errEl.classList.remove("hidden");
      return;
    }

    const res = await fetch("/api/task-categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farbe: colorInput.value, bezeichnung }),
    });

    if (res.ok) {
      const created = await res.json();
      const categories = await fetchTaskCategories(true);
      categorySelect.innerHTML = `
        <option value="">— keine Angabe —</option>
        ${taskCategoryOptionsHtml(categories, created.id)}
        <option value="__new__">+ Neue Kategorie anlegen…</option>
      `;
      newFields.classList.add("hidden");
    } else {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || "Konnte nicht angelegt werden.";
      errEl.classList.remove("hidden");
    }
  });
}

function wirePrivateTaskProjectPicker() {
  const projectSelect = document.getElementById("privTaskProjectSelect");
  const newFields = document.getElementById("newPrivTaskProjectFields");
  if (!projectSelect || !newFields) return;
  projectSelect.addEventListener("change", () => {
    newFields.classList.toggle("hidden", projectSelect.value !== "__new__");
  });

  const createBtn = document.getElementById("createPrivTaskProjectBtn");
  if (!createBtn) return;
  createBtn.addEventListener("click", async () => {
    const nameInput = document.getElementById("newPrivTaskProjectName");
    const errEl = document.querySelector(".new-priv-task-project-error");
    const name = nameInput.value.trim();
    errEl.classList.add("hidden");

    if (!name) {
      errEl.textContent = "Bitte einen Projektnamen eingeben.";
      errEl.classList.remove("hidden");
      return;
    }

    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (res.ok) {
      const created = await res.json();
      const projects = await fetchProjects(true);
      projectSelect.innerHTML = `
        <option value="">Privat</option>
        ${privateTaskProjectOptionsHtml(projects, created.id)}
        <option value="__new__">+ Neues Projekt anlegen…</option>
      `;
      newFields.classList.add("hidden");
    } else {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || "Konnte nicht angelegt werden.";
      errEl.classList.remove("hidden");
    }
  });
}

async function resolvePrivateTaskCategoryId() {
  const categorySelect = document.getElementById("privTaskCategorySelect");
  if (categorySelect.value !== "__new__") {
    return { ok: true, category_id: categorySelect.value ? parseInt(categorySelect.value, 10) : null };
  }

  const colorInput = document.getElementById("newPrivTaskCategoryColor");
  const labelInput = document.getElementById("newPrivTaskCategoryLabel");
  const errEl = document.querySelector(".new-priv-task-category-error");
  const bezeichnung = labelInput.value.trim();
  errEl.classList.add("hidden");

  if (!bezeichnung) {
    errEl.textContent = "Bitte eine Bezeichnung für die neue Kategorie eingeben.";
    errEl.classList.remove("hidden");
    return { ok: false };
  }

  const res = await fetch("/api/task-categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ farbe: colorInput.value, bezeichnung }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    errEl.textContent = data.error || "Kategorie konnte nicht angelegt werden.";
    errEl.classList.remove("hidden");
    return { ok: false };
  }

  const created = await res.json();
  await fetchTaskCategories(true);
  return { ok: true, category_id: created.id };
}

async function resolvePrivateTaskProjectId() {
  const projectSelect = document.getElementById("privTaskProjectSelect");
  if (projectSelect.value !== "__new__") {
    return { ok: true, project_id: projectSelect.value ? parseInt(projectSelect.value, 10) : null };
  }

  const nameInput = document.getElementById("newPrivTaskProjectName");
  const errEl = document.querySelector(".new-priv-task-project-error");
  const name = nameInput.value.trim();
  errEl.classList.add("hidden");

  if (!name) {
    errEl.textContent = "Bitte einen Projektnamen für das neue Projekt eingeben.";
    errEl.classList.remove("hidden");
    return { ok: false };
  }

  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    errEl.textContent = data.error || "Projekt konnte nicht angelegt werden.";
    errEl.classList.remove("hidden");
    return { ok: false };
  }

  const created = await res.json();
  await fetchProjects(true);
  return { ok: true, project_id: created.id };
}

async function readPrivateTaskForm() {
  const titel = document.getElementById("privTaskTitelInput").value.trim();
  if (!titel) return null;
  const beschreibung = document.getElementById("privTaskBeschreibungInput").value.trim();
  const deadline = document.getElementById("privTaskDeadlineInput").value || null;
  const assignee_ids = Array.from(
    document.querySelectorAll("#privTaskAssignees .beneficiary-checkbox:checked")
  ).map((el) => parseInt(el.value, 10));

  const categoryResult = await resolvePrivateTaskCategoryId();
  if (!categoryResult.ok) return null;

  const projectResult = await resolvePrivateTaskProjectId();
  if (!projectResult.ok) return null;

  return {
    titel,
    beschreibung,
    assignee_ids,
    category_id: categoryResult.category_id,
    project_id: projectResult.project_id,
    deadline,
  };
}

function renderPrivateTaskSubitemsEditor(taskId, subitems) {
  const container = document.getElementById("privTaskSubitemsList");
  if (!container) return;
  container.innerHTML = subitems.length
    ? subitems
        .map(
          (s) => `
            <div class="subitem-edit-row" data-sub-id="${s.id}">
              <label>
                <input type="checkbox" class="subitem-toggle" data-sub-id="${s.id}"${s.done ? " checked" : ""}>
                <span>${escapeHtml(s.titel)}</span>
              </label>
              <button type="button" class="icon-button subitem-delete" data-sub-id="${s.id}" aria-label="Löschen">${TRASH_ICON_SVG}</button>
            </div>
          `
        )
        .join("")
    : `<p class="muted">Noch keine Teilaufgaben.</p>`;

  container.querySelectorAll(".subitem-toggle").forEach((cb) => {
    cb.addEventListener("change", async () => {
      await fetch(`/api/private-tasks/${taskId}/subitems/${cb.dataset.subId}/toggle`, { method: "PATCH" });
      const sub = subitems.find((s) => s.id === parseInt(cb.dataset.subId, 10));
      if (sub) sub.done = cb.checked;
    });
  });
  container.querySelectorAll(".subitem-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`/api/private-tasks/${taskId}/subitems/${btn.dataset.subId}`, { method: "DELETE" });
      const idx = subitems.findIndex((s) => s.id === parseInt(btn.dataset.subId, 10));
      if (idx !== -1) subitems.splice(idx, 1);
      renderPrivateTaskSubitemsEditor(taskId, subitems);
    });
  });
}

function wirePrivateTaskSubitems(taskId, initialSubitems) {
  const subitems = (initialSubitems || []).slice();
  renderPrivateTaskSubitemsEditor(taskId, subitems);

  const addBtn = document.getElementById("addPrivSubitemBtn");
  const input = document.getElementById("newPrivSubitemInput");
  if (!addBtn || !input) return;
  addBtn.addEventListener("click", async () => {
    const titel = input.value.trim();
    if (!titel) return;
    const res = await fetch(`/api/private-tasks/${taskId}/subitems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titel }),
    });
    if (res.ok) {
      const created = await res.json();
      subitems.push(created);
      input.value = "";
      renderPrivateTaskSubitemsEditor(taskId, subitems);
    }
  });
}

async function openAddPrivateTaskModal() {
  const { me, users } = await fetchUsersAndMe();
  const categories = await fetchTaskCategories();
  const projects = await fetchProjects();
  const isAdmin = !!(me && isAdminRole(me.role));

  openModal({
    eyebrow: "Task",
    title: "Task hinzufügen",
    submitLabel: "Speichern",
    bodyHtml: privateTaskModalBodyHtml(categories, projects, isAdmin, {}, users),
    onSubmit: async () => {
      const form = await readPrivateTaskForm();
      if (!form) return;

      const res = await fetch("/api/private-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        closeModal();
        loadPrivateTasks(true);
      }
    },
  });

  wirePrivateTaskAssigneeChips();
  wirePrivateTaskDeadlineShortcuts();
  wirePrivateTaskCategoryPicker();
  if (isAdmin) wirePrivateTaskProjectPicker();
}

async function openEditPrivateTaskModal(task) {
  const { me, users } = await fetchUsersAndMe();
  const categories = await fetchTaskCategories();
  const projects = await fetchProjects();
  const isAdmin = !!(me && isAdminRole(me.role));

  openModal({
    eyebrow: "Task",
    title: "Task bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: privateTaskModalBodyHtml(categories, projects, isAdmin, task, users),
    onSubmit: async () => {
      const form = await readPrivateTaskForm();
      if (!form) return;

      const res = await fetch(`/api/private-tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        closeModal();
        loadPrivateTasks(true);
      }
    },
  });

  wirePrivateTaskAssigneeChips();
  wirePrivateTaskDeadlineShortcuts();
  wirePrivateTaskCategoryPicker();
  if (isAdmin) wirePrivateTaskProjectPicker();
  wirePrivateTaskSubitems(task.id, task.subitems);
}

const addPrivateTaskButton = document.getElementById("addPrivateTaskButton");
if (addPrivateTaskButton) addPrivateTaskButton.addEventListener("click", openAddPrivateTaskModal);

/* ---------- Bottom-Nav: erstmal nur für Admins sichtbar (normale User sehen
   ausschließlich die Kosten-Seite, ohne jede Navigation) ---------- */
fetchUsersAndMe().then(({ me }) => {
  const bottomNavEl = document.getElementById("bottomNav");
  if (bottomNavEl && me && isAdminRole(me.role)) {
    bottomNavEl.classList.remove("hidden");
  }
});

// Scrollposition debounced mitschreiben (nicht bei jedem Pixel), damit beim
// nächsten Login/Reload exakt wieder dort weitergemacht werden kann.
const appShellEl = document.querySelector(".app-shell");
let scrollSaveTimeout = null;
if (appShellEl) {
  appShellEl.addEventListener("scroll", () => {
    clearTimeout(scrollSaveTimeout);
    scrollSaveTimeout = setTimeout(() => saveUiState({ scroll: appShellEl.scrollTop }), 400);
  });
}

// Letzten Screen + Scrollposition wiederherstellen — nur, wenn der Screen
// tatsächlich existiert (z. B. nicht mehr für Nicht-Admins sichtbar, falls
// sich das mal ändert). Verzögert gesetzt, weil der Kalender & Co. ihr DOM
// erst nach dem eigenen (asynchronen) Laden aufbauen — sonst greift
// scrollTop teilweise noch ins Leere.
fetchUsersAndMe().then(async ({ me }) => {
  if (!me) return;
  const state = await ensureUiStateLoaded(me.username);
  if (!state || !state.screen || !document.getElementById(`screen-${state.screen}`)) return;
  goToScreen(state.screen, { preserveScroll: true });
  if (typeof state.scroll === "number") {
    setTimeout(() => {
      if (appShellEl) appShellEl.scrollTop = state.scroll;
    }, 150);
  }
});

/* ---------- Tasks: Sichtbarkeit (nur Felix) + Init ---------- */
fetchUsersAndMe().then(async ({ me }) => {
  if (!me || me.username !== "Felix") return;

  const tasksNavButton = document.querySelector('.bottom-nav [data-screen="tasks"]');
  if (tasksNavButton) tasksNavButton.classList.remove("hidden");

  fetchProjects(true);

  // Zuletzt gewählte Filter/Sortierung wiederherstellen (siehe ui-state).
  const state = await ensureUiStateLoaded(me.username);
  if (state) {
    if (state.tasksScope) setPrivateTaskScopeUI(state.tasksScope);
    if (state.tasksStatusFilter) privateTaskStatusFilter = state.tasksStatusFilter;
    if (typeof state.tasksProjectFilter === "string") privateTaskProjectFilterId = state.tasksProjectFilter;
    if (state.tasksSort) privateTaskSortMode = state.tasksSort;
    updatePrivateTaskFilterSortButtons();
  }

  loadPrivateTasks(true);
  setInterval(loadPrivateTasks, 5000);
});

/* ---------- Profil (Passwort ändern, Profilbild) ---------- */

function applyAvatarToButton(avatarPath, color) {
  const img = document.getElementById("profileAvatarImg");
  const fallback = document.getElementById("profileAvatarFallback");
  if (!img || !fallback) return;
  if (avatarPath) {
    img.src = avatarPath;
    img.classList.remove("hidden");
    fallback.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    fallback.classList.remove("hidden");
  }
  // Global (statt nur am Profil-Button) gesetzt, damit auch andere Elemente
  // (z. B. die schwebenden "+"-Buttons) in der eigenen Nutzerfarbe erscheinen.
  if (color) document.documentElement.style.setProperty("--me-color", color);
}

function profileModalBodyHtml(me) {
  return `
    <div class="form-stack">
      <div class="checkbox-group" data-live-save>
        <div class="eyebrow">Profilbild</div>
        <img id="profileAvatarPreviewImg" class="avatar-preview${me.avatar_path ? "" : " hidden"}" src="${me.avatar_path || ""}" alt="">
        <input type="file" id="profileAvatarFileInput" accept="image/png,image/jpeg,image/webp">
      </div>
      <label>Aktuelles Passwort
        <input type="password" id="profileCurrentPasswordInput" autocomplete="current-password">
      </label>
      <label>Neues Passwort (optional, min. 8 Zeichen)
        <input type="password" id="profileNewPasswordInput" autocomplete="new-password">
      </label>
      <label>Neues Passwort bestätigen
        <input type="password" id="profileNewPasswordConfirmInput" autocomplete="new-password">
      </label>
      <p class="error-text hidden profile-error"></p>
    </div>
  `;
}

async function openProfileModal() {
  const { me } = await fetchUsersAndMe();
  if (!me) return;

  openModal({
    eyebrow: "Profil",
    title: me.username,
    submitLabel: "Speichern",
    bodyHtml: profileModalBodyHtml(me),
    onSubmit: async () => {
      const errEl = document.querySelector(".profile-error");
      errEl.classList.add("hidden");

      const fileInput = document.getElementById("profileAvatarFileInput");
      const file = fileInput.files[0];
      if (file) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/me/avatar", { method: "POST", body: formData });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          errEl.textContent = data.error || "Profilbild konnte nicht gespeichert werden.";
          errEl.classList.remove("hidden");
          return;
        }
        const data = await res.json();
        cachedMe = null;
        applyAvatarToButton(data.avatar_path);
      }

      const currentPassword = document.getElementById("profileCurrentPasswordInput").value;
      const newPassword = document.getElementById("profileNewPasswordInput").value;
      const newPasswordConfirm = document.getElementById("profileNewPasswordConfirmInput").value;

      if (currentPassword || newPassword || newPasswordConfirm) {
        if (newPassword !== newPasswordConfirm) {
          errEl.textContent = "Die neuen Passwörter stimmen nicht überein.";
          errEl.classList.remove("hidden");
          return;
        }
        if (!currentPassword || !newPassword) {
          errEl.textContent = "Bitte aktuelles und neues Passwort eingeben.";
          errEl.classList.remove("hidden");
          return;
        }
        const res = await fetch("/api/me/password", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          errEl.textContent = data.error || "Passwort konnte nicht geändert werden.";
          errEl.classList.remove("hidden");
          return;
        }
      }

      closeModal();
    },
  });
}

const profileButton = document.getElementById("profileButton");
if (profileButton) profileButton.addEventListener("click", openProfileModal);

fetchUsersAndMe().then(({ me }) => {
  if (me) applyAvatarToButton(me.avatar_path, me.color);
});

/* ---------- Admin: Nutzer verwalten ---------- */

function adminUsersModalBodyHtml(users) {
  const rows = users
    .map(
      (u) => `
        <div class="list-card" data-user-row="${u.id}">
          <div class="list-card-content">
            ${avatarCircleHtml(u.username, 32)}
            <div class="list-card-text">
              <p class="list-card-title user-name-title" data-user-id="${u.id}">${escapeHtml(u.username)}</p>
              <p class="list-card-meta">${escapeHtml(u.role || "user")}</p>
              <p class="error-text hidden rename-user-error"></p>
            </div>
          </div>
          <div class="list-card-actions">
            <span class="user-rename-controls">
              <button type="button" class="icon-button rename-user-btn" aria-label="Umbenennen">✏️</button>
            </span>
            <input type="color" class="user-color-input" data-user-id="${u.id}" value="${u.color || "#ffd400"}" aria-label="Farbe von ${escapeHtml(u.username)}">
          </div>
        </div>
      `
    )
    .join("");

  return `
    <div class="form-stack">
      <div class="checkbox-group" data-live-save>
        <div class="eyebrow">Bestehende Nutzer</div>
        <div class="stack">${rows || '<div class="empty-state"><p>Noch keine Nutzer.</p></div>'}</div>
      </div>
      <div class="checkbox-group" data-live-save>
        <div class="eyebrow">Neuen Nutzer anlegen</div>
        <label>Nutzername
          <input type="text" id="newUserUsernameInput" maxlength="40">
        </label>
        <button type="button" id="createUserBtn" class="secondary compact">Nutzer anlegen</button>
        <p class="error-text hidden new-user-error"></p>
        <div id="newUserPasswordResult" class="hidden">
          <div class="eyebrow">Generiertes Passwort (nur jetzt sichtbar)</div>
          <div class="action-row">
            <input type="text" id="newUserGeneratedPassword" readonly>
            <button type="button" id="copyNewUserPasswordBtn" class="secondary compact">📋 Kopieren</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Umbenennen passiert inline in der Kachel statt in einem eigenen Dialog
// (nur ein <dialog> gleichzeitig sinnvoll nutzbar) — Stift-Button wird durch
// Speichern/Abbrechen ersetzt, der Namens-Text durch ein Eingabefeld. Das
// Farbfeld daneben bleibt dabei unangetastet, muss also nicht neu aufgebaut
// werden. Nach Abbrechen/Speichern wird die Funktion erneut aufgerufen, damit
// der Stift-Button wieder funktioniert.
function wireAdminUserRenameButton(userId) {
  const row = document.querySelector(`.list-card[data-user-row="${userId}"]`);
  if (!row) return;
  const controls = row.querySelector(".user-rename-controls");
  const renameBtn = controls.querySelector(".rename-user-btn");

  renameBtn.addEventListener("click", () => {
    const titleEl = row.querySelector(".user-name-title");
    const errEl = row.querySelector(".rename-user-error");
    const currentName = titleEl.textContent;

    titleEl.outerHTML = `<input type="text" class="list-card-title user-name-input" maxlength="40" value="${escapeHtml(currentName)}">`;
    const input = row.querySelector(".user-name-input");
    input.focus();
    input.select();

    controls.innerHTML = `
      <button type="button" class="icon-button rename-user-save" aria-label="Speichern">✓</button>
      <button type="button" class="icon-button rename-user-cancel" aria-label="Abbrechen">×</button>
    `;

    const restoreViewMode = (name) => {
      input.outerHTML = `<p class="list-card-title user-name-title" data-user-id="${userId}">${escapeHtml(name)}</p>`;
      controls.innerHTML = `<button type="button" class="icon-button rename-user-btn" aria-label="Umbenennen">✏️</button>`;
      errEl.classList.add("hidden");
      errEl.textContent = "";
      wireAdminUserRenameButton(userId);
    };

    controls.querySelector(".rename-user-cancel").addEventListener("click", () => restoreViewMode(currentName));

    const save = async () => {
      const newName = input.value.trim();
      if (!newName || newName === currentName) {
        restoreViewMode(currentName);
        return;
      }
      const saveRes = await fetch(`/api/users/${userId}/username`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newName }),
      });
      if (saveRes.ok) {
        cachedUsers = null;
        cachedMe = null;
        await fetchUsersAndMe();
        restoreViewMode(newName);
      } else {
        const data = await saveRes.json().catch(() => ({}));
        errEl.textContent = data.error || "Konnte nicht umbenannt werden.";
        errEl.classList.remove("hidden");
      }
    };
    controls.querySelector(".rename-user-save").addEventListener("click", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        restoreViewMode(currentName);
      }
    });
  });
}

async function openAdminUsersModal() {
  const res = await fetch("/api/users");
  const users = res.ok ? await res.json() : [];

  openModal({
    eyebrow: "Admin",
    title: "Nutzer verwalten",
    submitLabel: "Fertig",
    bodyHtml: adminUsersModalBodyHtml(users),
    onSubmit: async () => {
      closeModal();
    },
  });

  users.forEach((u) => wireAdminUserRenameButton(u.id));

  document.querySelectorAll(".user-color-input").forEach((input) => {
    input.addEventListener("change", async () => {
      const res = await fetch(`/api/users/${input.dataset.userId}/color`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color: input.value }),
      });
      if (res.ok) {
        cachedUsers = null;
        cachedMe = null;
        await fetchUsersAndMe();
      }
    });
  });

  document.getElementById("createUserBtn").addEventListener("click", async () => {
    const usernameInput = document.getElementById("newUserUsernameInput");
    const errEl = document.querySelector(".new-user-error");
    const resultEl = document.getElementById("newUserPasswordResult");
    errEl.classList.add("hidden");

    const username = usernameInput.value.trim();
    if (!username) {
      errEl.textContent = "Bitte einen Nutzernamen eingeben.";
      errEl.classList.remove("hidden");
      return;
    }

    const createRes = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });

    if (!createRes.ok) {
      const data = await createRes.json().catch(() => ({}));
      errEl.textContent = data.error || "Nutzer konnte nicht angelegt werden.";
      errEl.classList.remove("hidden");
      return;
    }

    const created = await createRes.json();
    document.getElementById("newUserGeneratedPassword").value = created.generated_password;
    resultEl.classList.remove("hidden");
    cachedUsers = null;
  });

  document.getElementById("copyNewUserPasswordBtn").addEventListener("click", async () => {
    const input = document.getElementById("newUserGeneratedPassword");
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (err) {
      input.select();
    }
  });
}

const adminUsersButton = document.getElementById("adminUsersButton");
if (adminUsersButton) {
  adminUsersButton.addEventListener("click", openAdminUsersModal);
  fetchUsersAndMe().then(({ me }) => {
    if (me && isAdminRole(me.role)) adminUsersButton.classList.remove("hidden");
  });
}

/* ---------- Kalender: Datums-Helfer ---------- */
function isoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d, n) {
  const res = new Date(d);
  res.setDate(res.getDate() + n);
  return res;
}
function addMonths(d, n) {
  const res = new Date(d);
  res.setMonth(res.getMonth() + n);
  return res;
}
// Woche startet Montag (DE-Konvention), unabhängig von d.getDay()'s
// So-als-0-Zählung.
function startOfWeekMonday(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(d, diff);
}

// Reiner Text wie "Camp" liefert bei Google Maps eine unzuverlässige Suche
// (irgendein Ort namens "Camp" irgendwo) — daher fest auf die echten
// Koordinaten des Camp-Standorts verdrahtet, in jeder Schreibweise
// ("Camp", "camp", " Camp " …), erkannt nach Entfernen aller Leerzeichen.
const CAMP_LOCATION_COORDS = "47.6738659,9.7418924";

function mapsUrl(location) {
  const isCampPlaceholder = location.replace(/\s+/g, "").toLowerCase() === "camp";
  const query = isCampPlaceholder ? CAMP_LOCATION_COORDS : location;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function formatWeekdayDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  const formatted = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" });
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

/* ---------- Kalender: Monats-/Wochen-/Tagesansicht ---------- */
const calendarContainerEl = document.getElementById("calendarContainer");
const calendarLabelEl = document.getElementById("calendarLabel");
const calendarViewSwitchEl = document.getElementById("calendarViewSwitch");

let calendarView = "month"; // "month" | "week" | "day"
let calendarAnchor = new Date();
calendarAnchor.setHours(0, 0, 0, 0);
let lastDatedEvents = [];
let calendarIsAdmin = false;

// Farbe folgt der Person, die den Termin angelegt hat (created_by) — gleiche
// Namensfarbe wie überall sonst im UI, fällt auf Gelb zurück, wenn unbekannt.
function calEventColor(event) {
  return (event.created_by && USER_COLORS[event.created_by]) || "#ffd400";
}
function calEventChipHtml(event, cssClass) {
  const color = calEventColor(event);
  const pale = hexToRgba(color, 0.18);
  return `<div class="${cssClass}" style="--ev-color:${color};--ev-pale:${pale}" data-id="${event.id}">${escapeHtml(event.bezeichnung)}</div>`;
}

// Mehrtägige Termine (datum_ende gesetzt) landen unter JEDEM Tag, den sie
// überspannen, nicht nur unter ihrem Start-Tag — jeweils als flache Kopie mit
// zusätzlichem _dayRole ("start"/"middle"/"end"/"single"), damit Monats- und
// Zeitraster-Ansicht wissen, wie der Termin an genau diesem Tag aussehen soll
// (z. B. am mittleren Tag ganztägig, ohne feste Uhrzeit).
function eventsByDateMap() {
  const map = new Map();
  lastDatedEvents.forEach((e) => {
    const endIso = e.datum_ende || e.datum;
    let cursor = e.datum;
    while (true) {
      const role = cursor === e.datum && cursor === endIso ? "single" : cursor === e.datum ? "start" : cursor === endIso ? "end" : "middle";
      if (!map.has(cursor)) map.set(cursor, []);
      map.get(cursor).push({ ...e, _dayRole: role });
      if (cursor === endIso) break;
      cursor = isoDateLocal(addDays(new Date(`${cursor}T00:00:00`), 1));
    }
  });
  map.forEach((list) => list.sort((a, b) => a.uhrzeit.localeCompare(b.uhrzeit)));
  return map;
}

function calendarLabelText() {
  if (calendarView === "day") return formatWeekdayDate(isoDateLocal(calendarAnchor));
  if (calendarView === "week") {
    const start = startOfWeekMonday(calendarAnchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startStr = start.toLocaleDateString("de-DE", { day: "2-digit", month: sameMonth ? undefined : "2-digit" });
    const endStr = end.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
    return `${startStr}. – ${endStr}`;
  }
  const label = calendarAnchor.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function renderMonthView() {
  const year = calendarAnchor.getFullYear();
  const month = calendarAnchor.getMonth();
  const gridStart = startOfWeekMonday(new Date(year, month, 1));
  const todayIso = isoDateLocal(new Date());
  const eventsByDate = eventsByDateMap();

  const weekdayLabels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  let html = weekdayLabels.map((w) => `<div class="cal-weekday">${w}</div>`).join("");

  // Immer 6 volle Wochen (42 Zellen), damit die Grid-Höhe nicht je nach Monat
  // (4 vs. 6 Zeilen) hin- und herspringt.
  for (let i = 0; i < 42; i++) {
    const cellDate = addDays(gridStart, i);
    const cellIso = isoDateLocal(cellDate);
    const inMonth = cellDate.getMonth() === month;
    const isToday = cellIso === todayIso;
    const dayEvents = eventsByDate.get(cellIso) || [];
    const visible = dayEvents.slice(0, 3);
    const overflow = dayEvents.length - visible.length;

    html += `
      <div class="cal-day-cell${inMonth ? "" : " other-month"}${isToday ? " today" : ""}" data-date="${cellIso}">
        <div class="cal-day-num">${cellDate.getDate()}</div>
        <div class="cal-day-events">
          ${visible.map((e) => calEventChipHtml(e, "cal-event-pill")).join("")}
          ${overflow > 0 ? `<div class="cal-day-more">+${overflow} mehr</div>` : ""}
        </div>
      </div>
    `;
  }

  calendarContainerEl.innerHTML = `<div class="cal-month-grid">${html}</div>`;

  calendarContainerEl.querySelectorAll(".cal-day-cell").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      const chip = e.target.closest(".cal-event-pill");
      if (chip) {
        if (!calendarIsAdmin) return;
        const event = lastDatedEvents.find((ev) => String(ev.id) === chip.dataset.id);
        if (event) openEditPlanModal(event);
        return;
      }
      calendarAnchor = new Date(`${cell.dataset.date}T00:00:00`);
      calendarView = "day";
      updateCalendarViewSwitchUI();
      renderCalendar();
    });
  });
}

// Gemeinsame Stunden-Raster-Ansicht für Woche (7 Spalten) und Tag (1 Spalte).
// Die Stunden-Zellen bilden nur noch das Hintergrundraster (Klicken/Ziehen
// zum Anlegen); Termine liegen als eigene, absolut positionierte Ebene
// darüber (siehe .cal-events-layer in style.css) — Höhe/Position kommen
// direkt aus Start-/Endzeit, dadurch ist die Dauer eines Termins auf einen
// Blick sichtbar, statt dass er nur als Text in einer einzelnen Zelle steht.
const CAL_START_HOUR = 6;
const CAL_END_HOUR = 23;
const CAL_HOUR_PX = 40; // muss zu .cal-hour-cell{min-height:40px} passen

function calMinutesFromMidnight(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

// Ohne Endzeit wird eine kompakte Standarddauer von 30 Minuten angenommen,
// rein fürs Zeichnen — an den gespeicherten Daten ändert das nichts. Bei
// mehrtägigen Terminen (_dayRole aus eventsByDateMap) zählt an diesem
// konkreten Tag nur der jeweilige Ausschnitt: der Start-Tag reicht von der
// Startzeit bis zum Rasterende (geht ja noch weiter), der End-Tag vom
// Rasteranfang bis zur Endzeit, ein Tag dazwischen ganztägig übers ganze
// Raster.
function calEventMinuteSpan(event) {
  const gridStartMin = CAL_START_HOUR * 60;
  const gridEndMin = CAL_END_HOUR * 60 + 60;
  const role = event._dayRole || "single";
  if (role === "start") {
    return { startMin: calMinutesFromMidnight(event.uhrzeit), endMin: gridEndMin };
  }
  if (role === "end") {
    const endMin = event.uhrzeit_ende ? calMinutesFromMidnight(event.uhrzeit_ende) : gridEndMin;
    return { startMin: gridStartMin, endMin };
  }
  if (role === "middle") {
    return { startMin: gridStartMin, endMin: gridEndMin };
  }
  const startMin = calMinutesFromMidnight(event.uhrzeit);
  const endMin = event.uhrzeit_ende ? calMinutesFromMidnight(event.uhrzeit_ende) : startMin + 30;
  return { startMin, endMin };
}

function calEventPixelSpan(event) {
  const { startMin, endMin } = calEventMinuteSpan(event);
  const gridStartMin = CAL_START_HOUR * 60;
  const top = ((startMin - gridStartMin) / 60) * CAL_HOUR_PX;
  const height = Math.max(((endMin - startMin) / 60) * CAL_HOUR_PX, 30);
  return { top, height };
}

// Einfache Bahnen-Zuteilung für zeitlich überlappende Termine am selben Tag:
// jeder Termin bekommt die erste Bahn, deren letzter Termin schon vorbei
// ist, sonst eine neue — überlappende Termine landen dadurch nebeneinander
// statt übereinander.
function assignEventLanes(events) {
  const withSpans = events
    .map((e) => ({ event: e, ...calEventMinuteSpan(e) }))
    .sort((a, b) => a.startMin - b.startMin);
  const laneEndTimes = [];
  const items = withSpans.map(({ event, startMin, endMin }) => {
    let lane = laneEndTimes.findIndex((end) => end <= startMin);
    if (lane === -1) {
      lane = laneEndTimes.length;
      laneEndTimes.push(endMin);
    } else {
      laneEndTimes[lane] = endMin;
    }
    return { event, lane };
  });
  return { items, laneCount: laneEndTimes.length || 1 };
}

function renderTimeGridView(days) {
  const todayIso = isoDateLocal(new Date());
  const eventsByDate = eventsByDateMap();

  // Jede Zelle bekommt ihre grid-row/-column EXPLIZIT statt sich auf den
  // Auto-Placement-Algorithmus zu verlassen: .cal-events-layer weiter unten
  // belegt explizit fast das ganze Raster (grid-column/-row:2/-1) — würden
  // Kopfzeile/Stundenspalte/-zellen stattdessen implizit einsortiert, würde
  // der Browser sie um diese Fläche herum verdrängen (Auto-Placement räumt
  // explizit platzierten Elementen zuerst ihren Platz ein), was genau die
  // vertauschten Spalten verursacht hat.
  let headerHtml = `<div class="cal-corner" style="grid-row:1;grid-column:1"></div>`;
  days.forEach((d, dayIndex) => {
    const iso = isoDateLocal(d);
    const label = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit" });
    headerHtml += `<div class="cal-col-header${iso === todayIso ? " today" : ""}" style="grid-row:1;grid-column:${dayIndex + 2}">${label}</div>`;
  });

  let rowsHtml = "";
  for (let h = CAL_START_HOUR; h <= CAL_END_HOUR; h++) {
    const rowIndex = h - CAL_START_HOUR + 2;
    rowsHtml += `<div class="cal-hour-label" style="grid-row:${rowIndex};grid-column:1">${String(h).padStart(2, "0")}</div>`;
    days.forEach((d, dayIndex) => {
      const iso = isoDateLocal(d);
      rowsHtml += `<div class="cal-hour-cell${iso === todayIso ? " today-col" : ""}" data-date="${iso}" data-hour="${h}" style="grid-row:${rowIndex};grid-column:${dayIndex + 2}"></div>`;
    });
  }

  let eventsHtml = "";
  days.forEach((d, dayIndex) => {
    const iso = isoDateLocal(d);
    const dayEvents = (eventsByDate.get(iso) || []).filter((e) => e.uhrzeit);
    const { items, laneCount } = assignEventLanes(dayEvents);
    const dayWidthPct = 100 / days.length;
    const laneWidthPct = dayWidthPct / laneCount;
    items.forEach(({ event, lane }) => {
      const { top, height } = calEventPixelSpan(event);
      const color = calEventColor(event);
      const pale = hexToRgba(color, 0.18);
      const left = dayIndex * dayWidthPct + lane * laneWidthPct;
      const role = event._dayRole || "single";
      eventsHtml += `
        <div class="cal-time-event" data-id="${event.id}" data-day-role="${role}" style="--ev-color:${color};--ev-pale:${pale};top:${top}px;height:${height}px;left:${left}%;width:calc(${laneWidthPct}% - 2px)">
          <span class="cal-time-event-label">${escapeHtml(event.bezeichnung)}</span>
        </div>
      `;
    });
  });

  // grid-row:2/-1 wäre naheliegend, aber ".cal-time-grid" deklariert kein
  // grid-template-rows (nur -columns) — ohne EXPLIZITES Zeilenraster bezieht
  // sich "-1" auf das Ende des expliziten (hier: leeren) Rasters, nicht auf
  // die zuletzt durch die Stundenzeilen erzeugte implizite Zeile. Die Ebene
  // ist dadurch nur so hoch wie Zeile 1 (Kopfzeile) statt bis ganz nach unten
  // zu reichen — Termine landeten dadurch sichtbar zu weit oben. Deshalb hier
  // die tatsächliche letzte Zeilenlinie explizit ausrechnen statt "-1".
  const lastRowLine = CAL_END_HOUR - CAL_START_HOUR + 1 + 2;
  calendarContainerEl.innerHTML = `
    <div class="cal-time-grid" style="--cal-cols:${days.length}">
      ${headerHtml}${rowsHtml}
      <div class="cal-events-layer" style="grid-row:2/${lastRowLine}">${eventsHtml}</div>
    </div>
  `;

  calendarContainerEl.querySelectorAll(".cal-events-layer .cal-time-event").forEach((block) => {
    block.addEventListener("click", () => {
      // Nach einem abgeschlossenen Rand-Ziehen (siehe wireCalEventResize)
      // feuert oft trotzdem noch ein Klick auf dieselbe Stelle — der hat die
      // neue Zeit schon gespeichert, ein zusätzliches Bearbeiten-Modal wäre falsch.
      if (calSuppressNextClick) {
        calSuppressNextClick = false;
        return;
      }
      if (!calendarIsAdmin) return;
      const event = lastDatedEvents.find((ev) => String(ev.id) === block.dataset.id);
      if (event) openEditPlanModal(event);
    });
  });

  calendarContainerEl.querySelectorAll(".cal-hour-cell").forEach((cell) => {
    cell.addEventListener("click", () => {
      // Nach einem abgeschlossenen Halten+Ziehen (siehe wireCalDayDragCreate)
      // feuert oft trotzdem noch ein Klick auf dieselbe Stelle — der hat hier
      // schon sein Modal geöffnet, ein zweites wäre falsch.
      if (calSuppressNextClick) {
        calSuppressNextClick = false;
        return;
      }
      if (!calendarIsAdmin) return;
      const hour = String(cell.dataset.hour).padStart(2, "0");
      openAddPlanModal({ datum: cell.dataset.date, uhrzeit: `${hour}:00` });
    });
  });
}

// Tagesansicht: Zelle gedrückt halten und dann ziehen erlaubt, die Uhrzeit
// beim Anlegen eines Termins noch anzupassen, statt nur die angetippte volle
// Stunde zu treffen — release übernimmt die Stunde der zuletzt berührten
// Zelle. Delegiert auf #calendarContainer (bleibt über Re-Renders hinweg
// bestehen, anders als das darin neu aufgebaute Grid), daher nur einmal
// verdrahtet statt bei jedem renderTimeGridView erneut.
const CAL_LONG_PRESS_MS = 350;
const CAL_MOVE_CANCEL_PX = 10;
let calDragState = null;
let calSuppressNextClick = false;

function calClearDragHighlight() {
  document.querySelectorAll(".cal-hour-cell.cal-drag-target").forEach((el) => el.classList.remove("cal-drag-target"));
}

// Färbt den gesamten überstrichenen Bereich zwischen Start- und aktueller
// Stunde ein (nicht nur die einzelne Zelle unterm Finger) — so sieht man
// beim Ziehen eine durchgehende Fläche statt einer springenden Einzelzelle.
function calHighlightRange(date, hourA, hourB) {
  calClearDragHighlight();
  const lo = Math.min(hourA, hourB);
  const hi = Math.max(hourA, hourB);
  document.querySelectorAll(`.cal-hour-cell[data-date="${date}"]`).forEach((el) => {
    const h = parseInt(el.dataset.hour, 10);
    if (h >= lo && h <= hi) el.classList.add("cal-drag-target");
  });
}

function calEndDrag() {
  if (calDragState) clearTimeout(calDragState.longPressTimer);
  calClearDragHighlight();
  calDragState = null;
}

// Position innerhalb der Stunden-Zelle (obere/untere Hälfte) bestimmt die
// halbe Stunde — so bleibt die Auflösung bei 30 Minuten, obwohl das Grid
// selbst nur ganze Stunden als Zeilen hat.
function calFractionForPoint(cell, clientY) {
  const rect = cell.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  const hour = parseInt(cell.dataset.hour, 10);
  return hour + (ratio >= 0.5 ? 0.5 : 0);
}
function formatCalFraction(frac) {
  // Geklemmt auf max. 23:30 — ein Ende über Mitternacht hinaus (frac >= 24,
  // z. B. beim Ziehen bis in die untere Hälfte der letzten Stunden-Zeile
  // 23 Uhr) gibt es im Tagesraster nicht.
  const clamped = Math.min(frac, 23.5);
  const h = Math.floor(clamped);
  const m = clamped % 1 >= 0.5 ? "30" : "00";
  return `${String(h).padStart(2, "0")}:${m}`;
}

function wireCalDayDragCreate(container) {
  if (!container) return;

  container.addEventListener("pointerdown", (e) => {
    if (calendarView !== "day" || !calendarIsAdmin) return;
    const cell = e.target.closest(".cal-hour-cell");
    if (!cell || e.target.closest(".cal-time-event")) return;

    const startFraction = calFractionForPoint(cell, e.clientY);
    calDragState = {
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      active: false,
      startDate: cell.dataset.date,
      startHour: parseInt(cell.dataset.hour, 10),
      currentHour: parseInt(cell.dataset.hour, 10),
      startFraction,
      currentFraction: startFraction,
    };
    calDragState.longPressTimer = setTimeout(() => {
      if (!calDragState) return;
      calDragState.active = true;
      try {
        container.setPointerCapture(calDragState.pointerId);
      } catch (err) {
        // Manche Browser mögen setPointerCapture in bestimmten Situationen
        // nicht — der Drag funktioniert (per elementFromPoint) trotzdem.
      }
      calHighlightRange(calDragState.startDate, calDragState.startHour, calDragState.startHour);
      if (navigator.vibrate) navigator.vibrate(15);
    }, CAL_LONG_PRESS_MS);
  });

  container.addEventListener("pointermove", (e) => {
    if (!calDragState) return;
    if (!calDragState.active) {
      const movedX = Math.abs(e.clientX - calDragState.startX);
      const movedY = Math.abs(e.clientY - calDragState.startY);
      // Deutliche Bewegung vor Ablauf des Long-Press: das ist Scrollen
      // gemeint, kein Halten+Ziehen — sauber abbrechen statt zu blockieren.
      if (movedX > CAL_MOVE_CANCEL_PX || movedY > CAL_MOVE_CANCEL_PX) calEndDrag();
      return;
    }
    e.preventDefault();
    const hovered = document.elementFromPoint(e.clientX, e.clientY);
    const cell = hovered && hovered.closest(".cal-hour-cell");
    if (!cell || cell.dataset.date !== calDragState.startDate) return;
    const hour = parseInt(cell.dataset.hour, 10);
    calDragState.currentFraction = calFractionForPoint(cell, e.clientY);
    if (hour === calDragState.currentHour) return;
    calDragState.currentHour = hour;
    calHighlightRange(calDragState.startDate, calDragState.startHour, hour);
  });

  function finishDrag(e) {
    if (!calDragState) return;
    const wasActive = calDragState.active;
    const state = calDragState;
    calEndDrag();
    if (wasActive) {
      calSuppressNextClick = true;
      const rawLo = Math.min(state.startFraction, state.currentFraction);
      const rawHi = Math.max(state.startFraction, state.currentFraction);
      // rawHi ist der Beginn der zuletzt berührten Halbstunden-Zelle, der
      // Termin muss also bis zu deren ENDE reichen (+0.5h) — außer beim
      // kurzen Halten ohne nennenswertes Ziehen, dann 1h Standarddauer.
      const endFraction = rawLo === rawHi ? rawLo + 1 : rawHi + 0.5;
      openAddPlanModal({ datum: state.startDate, uhrzeit: formatCalFraction(rawLo), uhrzeit_ende: formatCalFraction(endFraction) });
    }
  }
  container.addEventListener("pointerup", finishDrag);
  container.addEventListener("pointercancel", () => calEndDrag());
  container.addEventListener("pointerleave", () => {
    // Nur abbrechen, solange der Long-Press noch nicht aktiv ist — läuft der
    // Drag schon, bleibt er dank pointer capture auch bei kurzem Verlassen
    // des Grids aktiv.
    if (calDragState && !calDragState.active) calEndDrag();
  });
}

function calFormatMinutes(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Gedrückt halten am oberen/unteren Rand eines Termin-Blocks (Tag-/Wochen-
// ansicht) und ziehen passt Start- bzw. Endzeit an — gleiches Halten+Ziehen-
// Prinzip wie wireCalDayDragCreate (Long-Press erst, dann per Bewegung
// abbrechbar, damit normales Scrollen nicht versehentlich einen Termin
// verschiebt). Reine PATCH-Anfrage am Ende, kein eigenes Modal nötig.
const CAL_RESIZE_EDGE_PX = 10;
let calResizeState = null;

function calEndResize() {
  if (calResizeState) {
    clearTimeout(calResizeState.longPressTimer);
    calResizeState.block.classList.remove("resizing");
  }
  calResizeState = null;
}

function wireCalEventResize(container) {
  if (!container) return;

  container.addEventListener("pointerdown", (e) => {
    if ((calendarView !== "day" && calendarView !== "week") || !calendarIsAdmin) return;
    const block = e.target.closest(".cal-time-event");
    if (!block) return;
    const rect = block.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    let mode = null;
    if (offsetY <= CAL_RESIZE_EDGE_PX) mode = "start";
    else if (rect.height - offsetY <= CAL_RESIZE_EDGE_PX) mode = "end";
    if (!mode) return; // Mitte des Blocks: normaler Klick öffnet weiterhin Bearbeiten

    // Bei mehrtägigen Terminen steht nur am Start-Tag der obere Rand für die
    // echte Startzeit (sonst ist es nur der Rasteranfang, kein "Ziehen ab
    // Mitternacht" möglich) bzw. nur am End-Tag der untere Rand für die echte
    // Endzeit — an einem Tag dazwischen ist gar kein Rand verschiebbar.
    const dayRole = block.dataset.dayRole || "single";
    if (mode === "start" && dayRole !== "start" && dayRole !== "single") return;
    if (mode === "end" && dayRole !== "end" && dayRole !== "single") return;

    const event = lastDatedEvents.find((ev) => String(ev.id) === block.dataset.id);
    if (!event) return;
    const startMin = calMinutesFromMidnight(event.uhrzeit);
    const endMin = event.uhrzeit_ende ? calMinutesFromMidnight(event.uhrzeit_ende) : startMin + 30;

    calResizeState = {
      mode,
      block,
      event,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      origStartMin: startMin,
      origEndMin: endMin,
      currentStartMin: startMin,
      currentEndMin: endMin,
    };
    calResizeState.longPressTimer = setTimeout(() => {
      if (!calResizeState) return;
      calResizeState.active = true;
      try {
        container.setPointerCapture(calResizeState.pointerId);
      } catch (err) {
        // s. wireCalDayDragCreate — funktioniert per elementFromPoint auch ohne.
      }
      block.classList.add("resizing");
      if (navigator.vibrate) navigator.vibrate(15);
    }, CAL_LONG_PRESS_MS);
  });

  container.addEventListener("pointermove", (e) => {
    if (!calResizeState) return;
    if (!calResizeState.active) {
      const movedX = Math.abs(e.clientX - calResizeState.startX);
      const movedY = Math.abs(e.clientY - calResizeState.startY);
      if (movedX > CAL_MOVE_CANCEL_PX || movedY > CAL_MOVE_CANCEL_PX) calEndResize();
      return;
    }
    e.preventDefault();
    const deltaMin = Math.round(((e.clientY - calResizeState.startY) / CAL_HOUR_PX) * 60 / 30) * 30;
    const gridMin = CAL_START_HOUR * 60;
    // 23:30 statt 24:00 als Obergrenze — "24:00" ist keine gültige Uhrzeit
    // fürs Backend (dt.strptime erwartet 0–23 als Stunde).
    const gridMax = CAL_END_HOUR * 60 + 30;

    if (calResizeState.mode === "start") {
      calResizeState.currentStartMin = Math.min(
        Math.max(calResizeState.origStartMin + deltaMin, gridMin),
        calResizeState.currentEndMin - 30
      );
    } else {
      calResizeState.currentEndMin = Math.max(
        Math.min(calResizeState.origEndMin + deltaMin, gridMax),
        calResizeState.currentStartMin + 30
      );
    }

    const top = ((calResizeState.currentStartMin - gridMin) / 60) * CAL_HOUR_PX;
    const height = Math.max(((calResizeState.currentEndMin - calResizeState.currentStartMin) / 60) * CAL_HOUR_PX, 16);
    calResizeState.block.style.top = `${top}px`;
    calResizeState.block.style.height = `${height}px`;
    const labelEl = calResizeState.block.querySelector(".cal-time-event-label");
    if (labelEl) {
      const timeStr = `${calFormatMinutes(calResizeState.currentStartMin)}–${calFormatMinutes(calResizeState.currentEndMin)}`;
      labelEl.textContent = `${timeStr} ${calResizeState.event.bezeichnung}`;
    }
  });

  function finishResize() {
    if (!calResizeState) return;
    const state = calResizeState;
    calEndResize();
    if (!state.active) return;
    calSuppressNextClick = true;
    if (state.currentStartMin === state.origStartMin && state.currentEndMin === state.origEndMin) return;

    fetch(`/api/plan/${state.event.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        datum: state.event.datum,
        uhrzeit: calFormatMinutes(state.currentStartMin),
        uhrzeit_ende: calFormatMinutes(state.currentEndMin),
        bezeichnung: state.event.bezeichnung,
        location: state.event.location,
        beschreibung: state.event.beschreibung,
        shared_project_id: state.event.shared_project_id,
      }),
    }).then((res) => {
      // Bei Erfolg bringt loadPlanList(true) die frischen, korrekt validierten
      // Daten; bei einem Fehler (z. B. Kollision mit Rundung) rendert
      // renderCalendar() den Block anhand der alten, unveränderten Daten neu.
      if (res.ok) loadPlanList(true);
      else renderCalendar();
    });
  }
  container.addEventListener("pointerup", finishResize);
  container.addEventListener("pointercancel", () => calEndResize());
  container.addEventListener("pointerleave", () => {
    if (calResizeState && !calResizeState.active) calEndResize();
  });
}

function updateCalendarViewSwitchUI() {
  if (!calendarViewSwitchEl) return;
  calendarViewSwitchEl.querySelectorAll(".filter").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.calview === calendarView);
  });
}

function renderCalendar() {
  if (!calendarContainerEl) return;
  if (calendarLabelEl) calendarLabelEl.textContent = calendarLabelText();

  if (calendarView === "month") {
    renderMonthView();
  } else if (calendarView === "week") {
    renderTimeGridView([...Array(7)].map((_, i) => addDays(startOfWeekMonday(calendarAnchor), i)));
  } else {
    renderTimeGridView([calendarAnchor]);
  }
}

if (calendarViewSwitchEl) {
  calendarViewSwitchEl.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      calendarView = btn.dataset.calview;
      updateCalendarViewSwitchUI();
      renderCalendar();
    });
  });
}

wireCalDayDragCreate(calendarContainerEl);
wireCalEventResize(calendarContainerEl);

const calPrevBtn = document.getElementById("calPrevBtn");
const calNextBtn = document.getElementById("calNextBtn");
const calTodayBtn = document.getElementById("calTodayBtn");

function shiftCalendarAnchor(dir) {
  if (calendarView === "month") calendarAnchor = addMonths(calendarAnchor, dir);
  else if (calendarView === "week") calendarAnchor = addDays(calendarAnchor, dir * 7);
  else calendarAnchor = addDays(calendarAnchor, dir);
  renderCalendar();
}
if (calPrevBtn) calPrevBtn.addEventListener("click", () => shiftCalendarAnchor(-1));
if (calNextBtn) calNextBtn.addEventListener("click", () => shiftCalendarAnchor(1));
if (calTodayBtn) {
  calTodayBtn.addEventListener("click", () => {
    calendarAnchor = new Date();
    calendarAnchor.setHours(0, 0, 0, 0);
    renderCalendar();
  });
}

let lastPlanSignature = null;

async function loadPlanList(force) {
  if (!calendarContainerEl) return;
  try {
    const res = await fetch("/api/plan");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const events = await res.json();
    const signature = JSON.stringify(events);
    if (!force && signature === lastPlanSignature) return;
    lastPlanSignature = signature;

    const { me } = await fetchUsersAndMe();
    calendarIsAdmin = !!me && isAdminRole(me.role);

    lastDatedEvents = events;
    renderCalendar();
  } catch (err) {
    calendarContainerEl.innerHTML = `<div class="empty-state"><p>Kalender konnte nicht geladen werden.</p></div>`;
  }
}

// Zwei Felder pro Zeile (Bezeichnung+Datum, Von+Bis) statt jedes für sich —
// braucht deutlich weniger Scroll-Höhe im Erfassungsfenster.
function planModalBodyHtml(prefill = {}, projects = []) {
  const today = isoDateLocal(new Date());
  // Uhrzeit-Felder bekommen IMMER einen vollständigen Wert (nie leer) — ein
  // leeres <input type="time"> zeigt beim Eintippen der Stunde "--" bei den
  // Minuten, bis auch die eingetippt wurden. Mit vorbelegtem Wert steht dort
  // von Anfang an "00", auch wenn nur die Stunde geändert wird.
  return `
    <div class="form-stack">
      <div class="form-row-2col">
        <label>Bezeichnung
          <input type="text" id="planBezeichnungInput" maxlength="60" value="${escapeHtml(prefill.bezeichnung || "")}" required>
        </label>
        <label>Location (Adresse)
          <input type="text" id="planLocationInput" maxlength="120" value="${escapeHtml(prefill.location || "")}">
          ${
            prefill.location
              ? `<a href="${mapsUrl(prefill.location)}" target="_blank" rel="noopener" class="link-button">📍 Auf Karte anzeigen</a>`
              : ""
          }
        </label>
      </div>
      <div class="form-row-2col">
        <label>Von
          <input type="date" id="planDatumInput" value="${prefill.datum || today}" required>
        </label>
        <label>Bis
          <input type="date" id="planDatumEndeInput" value="${prefill.datum_ende || prefill.datum || today}" required>
        </label>
      </div>
      <div class="form-row-2col">
        <input type="time" id="planUhrzeitInput" value="${prefill.uhrzeit || "12:00"}" aria-label="Von Uhrzeit" required>
        <input type="time" id="planUhrzeitEndeInput" value="${prefill.uhrzeit_ende || "13:00"}" aria-label="Bis Uhrzeit">
      </div>
      <label>Beschreibung
        <textarea id="planBeschreibungInput" placeholder="Was ist geplant?">${escapeHtml(prefill.beschreibung || "")}</textarea>
      </label>
      <label>Für Projekt freigeben
        <select id="planProjectSelect">
          <option value="">Nur für dich sichtbar</option>
          ${privateTaskProjectOptionsHtml(projects, prefill.shared_project_id || "")}
        </select>
      </label>
      <p class="error-text hidden plan-modal-error"></p>
      ${prefill.id ? `<button type="button" id="planDeleteBtn" class="link-button danger">🗑 Termin löschen</button>` : ""}
    </div>
  `;
}

async function submitPlanForm(url, method) {
  const datum = document.getElementById("planDatumInput").value;
  const datumEnde = document.getElementById("planDatumEndeInput").value;
  const uhrzeit = document.getElementById("planUhrzeitInput").value;
  const uhrzeitEnde = document.getElementById("planUhrzeitEndeInput").value;
  const bezeichnung = document.getElementById("planBezeichnungInput").value.trim();
  const location = document.getElementById("planLocationInput").value.trim();
  const beschreibung = document.getElementById("planBeschreibungInput").value.trim();
  const projectSelect = document.getElementById("planProjectSelect");
  const sharedProjectId = projectSelect && projectSelect.value ? parseInt(projectSelect.value, 10) : null;

  if (!datum || !uhrzeit || !bezeichnung) return;

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      datum,
      datum_ende: datumEnde || null,
      uhrzeit,
      uhrzeit_ende: uhrzeitEnde || null,
      bezeichnung,
      location,
      beschreibung,
      shared_project_id: sharedProjectId,
    }),
  });

  if (res.ok) {
    closeModal();
    loadPlanList(true);
  } else {
    const data = await res.json().catch(() => ({}));
    const errEl = document.querySelector(".plan-modal-error");
    if (errEl) {
      errEl.textContent = data.error || "Konnte nicht gespeichert werden.";
      errEl.classList.remove("hidden");
    }
  }
}

async function deletePlanEvent(eventId) {
  if (!(await showConfirm("Dieser Termin wird endgültig gelöscht.", "Ja, löschen"))) return;
  const res = await fetch(`/api/plan/${eventId}`, { method: "DELETE" });
  if (res.ok) {
    closeModal();
    loadPlanList(true);
  }
}

async function openAddPlanModal(prefill = {}) {
  const projects = await fetchProjects();
  openModal({
    eyebrow: "Kalender",
    title: "Termin hinzufügen",
    bodyHtml: planModalBodyHtml(prefill, projects),
    onSubmit: () => submitPlanForm("/api/plan", "POST"),
  });
}

async function openEditPlanModal(event) {
  const projects = await fetchProjects();
  openModal({
    eyebrow: "Kalender",
    title: "Termin bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: planModalBodyHtml(event, projects),
    onSubmit: () => submitPlanForm(`/api/plan/${event.id}`, "PATCH"),
  });
  const deleteBtn = document.getElementById("planDeleteBtn");
  if (deleteBtn) deleteBtn.addEventListener("click", () => deletePlanEvent(event.id));
}

const addPlanButton = document.getElementById("addPlanButton");
if (addPlanButton) {
  addPlanButton.addEventListener("click", () => openAddPlanModal({ datum: isoDateLocal(calendarAnchor) }));
}

/* ---------- Kosten & Schulden ---------- */
const balanceHeroEl = document.getElementById("balanceHero");
const myExpensesHeroEl = document.getElementById("myExpensesHero");
const expenseListEl = document.getElementById("expenseList");

async function fetchUsersAndMe() {
  if (cachedUsers && cachedMe) return { users: cachedUsers, me: cachedMe };
  const [usersRes, meRes] = await Promise.all([fetch("/api/users"), fetch("/api/me")]);
  cachedUsers = usersRes.ok ? await usersRes.json() : [];
  cachedMe = meRes.ok ? await meRes.json() : null;
  updateUserLookupMaps(cachedUsers);
  return { users: cachedUsers, me: cachedMe };
}

function formatEuro(value) {
  return value.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

function formatDate(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${d}.${m}.`;
}

/* ---------- Kosten: einfache Seitennummerierung (Ausgaben & Log) ---------- */
// Welche Seitenzahlen tatsächlich als Button gezeigt werden: immer erste,
// letzte und die direkte Umgebung der aktuellen Seite — dazwischenliegende
// Lücken werden im Rendering durch "…" ersetzt, statt jede einzelne Seite
// aufzulisten (bei vielen Seiten sonst unübersichtlich).
function pagerPageNumbers(current, total) {
  const pages = new Set([1, total, current - 1, current, current + 1]);
  return Array.from(pages)
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
}

// Rendert nur, wenn mehr als eine Seite existiert — sonst bleibt der
// Container leer (keine Pager-Leiste bei kurzen Listen). scrollAnchor steuert,
// wohin nach einem Klick gescrollt wird: "end" für den Pager unter der Liste
// (bleibt unten sichtbar, sonst müsste man nach jedem Seitenwechsel wieder
// nach unten scrollen), "start" für die gleichwertige Kopie über der Liste
// (bleibt logischerweise oben, wo man gerade interagiert hat).
function renderPager(container, { total, page, pageSize, onChange, scrollAnchor }) {
  if (!container) return;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(page, 1), totalPages);

  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  let html = `<button type="button" class="pager-nav" data-page="${current - 1}"${current === 1 ? " disabled" : ""} aria-label="Vorherige Seite">‹</button>`;
  let prevPage = 0;
  pagerPageNumbers(current, totalPages).forEach((p) => {
    if (p - prevPage > 1) html += `<span class="pager-ellipsis">…</span>`;
    html += `<button type="button" class="pager-page${p === current ? " active" : ""}" data-page="${p}">${p}</button>`;
    prevPage = p;
  });
  html += `<button type="button" class="pager-nav" data-page="${current + 1}"${current === totalPages ? " disabled" : ""} aria-label="Nächste Seite">›</button>`;

  container.innerHTML = html;
  container.querySelectorAll("button[data-page]:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => {
      onChange(parseInt(btn.dataset.page, 10));
      // scrollIntoView richtet sich nur nach dem Pager-Element selbst — durch
      // das große padding-bottom von .app-shell (Platz für die Bottom-Nav)
      // landet man damit nur "fast" unten, nicht am tatsächlichen Scroll-Ende.
      // appShellEl.scrollTop direkt auf scrollHeight setzen erreicht garantiert
      // die echte Grenze (der Browser klemmt von selbst auf das Maximum).
      if (appShellEl) appShellEl.scrollTop = scrollAnchor === "start" ? 0 : appShellEl.scrollHeight;
    });
  });
}

// Gruppiert die granularen DB-Zeilen (ein Eintrag pro Schuldner) rein für die
// Darstellung nach batch_id zu einer Kachel pro Ausgabe-Vorgang. Die DB selbst
// bleibt granular, hier wird nur zusammengefasst, was zusammengehört. batch_id
// (statt Datum+Betreff) verhindert, dass zwei verschiedene Personen mit
// zufällig gleichem Datum+Betreff fälschlich zusammengruppiert werden.
function groupExpenses(expenses) {
  const groups = new Map();
  for (const e of expenses) {
    const key = e.batch_id || `row-${e.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        batchId: e.batch_id,
        datum: e.datum,
        betreff: e.betreff,
        glaeubiger: new Set(),
        glaubigerId: e.glaubiger_id,
        beneficiaryIds: new Set(),
        createdBy: e.created_by,
        total: 0,
        entries: [],
      });
    }
    const g = groups.get(key);
    g.glaeubiger.add(e.glaubiger);
    g.beneficiaryIds.add(e.schuldner_id);
    g.total += e.cash;
    g.entries.push(e);
  }
  return Array.from(groups.values());
}

function renderExpenseGroup(group, isAdmin, myUsername) {
  const card = document.createElement("div");
  card.className = "list-card";
  const canManage = !!group.batchId && (isAdmin || (!!myUsername && group.createdBy === myUsername));
  if (canManage) card.classList.add("clickable");
  // Namen bleiben hier bewusst unhighlighted — die Randfarbe des Zahlers an
  // der ganzen Kachel reicht als visuelle Zuordnung.
  const payerNames = Array.from(group.glaeubiger);
  const borderColor = USER_COLORS[payerNames[0]];
  if (borderColor) card.style.borderLeft = `4px solid ${borderColor}`;
  // Profilbild des Zahlers dezent transparent im Hintergrund (siehe
  // .list-card.avatar-bg in style.css) — nur bei genau einem Zahler und wenn
  // diese Person überhaupt ein Profilbild hochgeladen hat.
  const payerAvatar = payerNames.length === 1 ? USER_AVATARS[payerNames[0]] : null;
  if (payerAvatar) {
    card.classList.add("avatar-bg");
    card.style.setProperty("--avatar-url", `url('${payerAvatar}')`);
  }
  const payer = payerNames.map((n) => escapeHtml(n)).join(", ");

  // Statt aller Beteiligten mit Anteil nur EINE Person + Durchschnitt: im
  // "Für X"-Filter die gefilterte Person (das ist ja gerade der Fokus der
  // Ansicht), sonst der eigene Anteil — ergibt bei "Für dich" ohnehin
  // dasselbe, da die gefilterte Person dann man selbst ist. Ist man an der
  // Ausgabe gar nicht beteiligt (z. B. "Alle" ohne Filter), bleibt nur der
  // Durchschnitt übrig.
  const focusEntry =
    expenseFilterMode === "fuer" && expenseFilterUserId !== null
      ? group.entries.find((e) => e.schuldner_id === expenseFilterUserId)
      : group.entries.find((e) => e.schuldner === myUsername);
  const breakdownParts = [];
  if (focusEntry) {
    breakdownParts.push(`${escapeHtml(focusEntry.schuldner)}: ${formatEuro(focusEntry.cash)}`);
  }
  // Durchschnitt nur bei mehr als einer Person sinnvoll — bei nur einer
  // Person wäre er ohnehin identisch zu deren Anteil.
  if (group.entries.length > 1) {
    breakdownParts.push(`Ø ${formatEuro(group.total / group.entries.length)}`);
  }
  const breakdown = breakdownParts.join(" ");

  card.innerHTML = `
    <div class="list-card-text no-wrap">
      <p class="list-card-title">${escapeHtml(group.betreff)}</p>
      <p class="list-card-meta">${formatDate(group.datum)} ${payer} ${formatEuro(group.total)}</p>
      <p class="list-card-meta">${breakdown}</p>
    </div>
    ${
      canManage
        ? `<div class="list-card-actions">
             <button type="button" class="delete-btn" aria-label="Löschen">${TRASH_ICON_SVG}</button>
           </div>`
        : ""
    }
  `;

  if (canManage) {
    // Ganze Kachel öffnet Bearbeiten (macht den separaten Stift-Button überflüssig) —
    // nur für Admins oder den:die ursprüngliche:n Ersteller:in sichtbar. Löschen
    // stoppt die Propagation, damit ein Klick darauf nicht zusätzlich den
    // Bearbeiten-Dialog öffnet.
    card.addEventListener("click", () => openEditExpenseModal(group));
    card.querySelector(".delete-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openModal({
        eyebrow: "Kosten",
        title: `„${group.betreff}" löschen?`,
        bodyHtml: `<p class="muted warning-text">Die Ausgabe wird für alle Beteiligten entfernt. Das lässt sich nicht rückgängig machen.</p>`,
        submitLabel: "Löschen",
        danger: true,
        onSubmit: async () => {
          const res = await fetch(`/api/expenses/batch/${group.batchId}`, { method: "DELETE" });
          if (res.ok) {
            refreshAllCostsData();
          }
          closeModal();
        },
      });
    });
  }

  return card;
}

/* ---------- Kosten: Ausgaben nach Person filtern ---------- */
const expenseFilterSelect = document.getElementById("expenseFilterSelect");
let lastExpenses = [];
let lastExpensesIsAdmin = false;
let lastExpensesMeUsername = null;
let expenseFilterMode = null; // "von" | "fuer" | null (= alle)
let expenseFilterUserId = null;
let expenseFilterOptionsPopulated = false;
const EXPENSE_PAGE_SIZE = 25;
let expensePage = 1;
const expensePagerEl = document.getElementById("expensePager");
const expenseJumpTopBtn = document.getElementById("expenseJumpTopBtn");
if (expenseJumpTopBtn) {
  expenseJumpTopBtn.addEventListener("click", () => {
    expensePage = 1;
    renderExpenseList();
    if (appShellEl) appShellEl.scrollTop = 0;
  });
}

async function populateExpenseFilterOptions() {
  if (expenseFilterOptionsPopulated || !expenseFilterSelect) return;
  const { users, me } = await fetchUsersAndMe();
  users
    .slice()
    .sort((a, b) => a.username.localeCompare(b.username, "de"))
    .forEach((u) => {
      const isMe = !!me && u.id === me.id;

      const vonOpt = document.createElement("option");
      vonOpt.value = `von:${u.id}`;
      vonOpt.textContent = isMe ? "Von dir" : `Von ${u.username}`;
      expenseFilterSelect.appendChild(vonOpt);

      const fuerOpt = document.createElement("option");
      fuerOpt.value = `fuer:${u.id}`;
      fuerOpt.textContent = isMe ? "Für dich" : `Für ${u.username}`;
      expenseFilterSelect.appendChild(fuerOpt);
    });
  expenseFilterOptionsPopulated = true;
}

if (expenseFilterSelect) {
  populateExpenseFilterOptions();
  expenseFilterSelect.addEventListener("change", () => {
    const val = expenseFilterSelect.value;
    if (!val) {
      expenseFilterMode = null;
      expenseFilterUserId = null;
    } else {
      const [mode, id] = val.split(":");
      expenseFilterMode = mode;
      expenseFilterUserId = parseInt(id, 10);
    }
    expensePage = 1;
    renderExpenseList();
    saveUiState({ costsExpenseFilter: val });
  });
}

// "Von X": X hat bezahlt (Zahler). "Für X": X war Beteiligter/Nutznießer
// (auch bei sich selbst) — unabhängig davon, wer bezahlt hat.
function renderExpenseList() {
  if (!expenseListEl) return;
  const groups = groupExpenses(lastExpenses).filter((g) => {
    if (expenseFilterUserId === null) return true;
    if (expenseFilterMode === "von") return g.glaubigerId === expenseFilterUserId;
    return g.beneficiaryIds.has(expenseFilterUserId);
  });

  // Nur die 25 aktuellsten Einträge (Liste ist bereits nach Datum absteigend
  // sortiert) auf einmal anzeigen, Rest über die Seitennummerierung darunter.
  const totalPages = Math.max(1, Math.ceil(groups.length / EXPENSE_PAGE_SIZE));
  if (expensePage > totalPages) expensePage = totalPages;
  const pageGroups = groups.slice((expensePage - 1) * EXPENSE_PAGE_SIZE, expensePage * EXPENSE_PAGE_SIZE);

  expenseListEl.innerHTML = "";
  if (groups.length === 0) {
    expenseListEl.innerHTML = `<div class="empty"><p>${
      lastExpenses.length === 0 ? "Noch keine Einträge." : "Keine Ausgaben für diese Auswahl."
    }</p></div>`;
  } else {
    pageGroups.forEach((g) => expenseListEl.appendChild(renderExpenseGroup(g, lastExpensesIsAdmin, lastExpensesMeUsername)));
  }
  if (expenseJumpTopBtn) expenseJumpTopBtn.classList.toggle("hidden", expensePage <= 1);
  renderPager(expensePagerEl, {
    total: groups.length,
    page: expensePage,
    pageSize: EXPENSE_PAGE_SIZE,
    onChange: (p) => {
      expensePage = p;
      renderExpenseList();
    },
    scrollAnchor: "end",
  });

  updateExpensesHeroCard();
}

let lastExpensesSignature = null;

async function loadExpenses() {
  if (!expenseListEl) return;
  try {
    const res = await fetch("/api/expenses");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const expenses = await res.json();

    // Nur bei echter Änderung neu rendern — sonst würde jedes Poll-Tick
    // z. B. offene Eingaben in dieser Ansicht unnötig zerstören.
    const signature = JSON.stringify(expenses);
    if (signature === lastExpensesSignature) return;
    lastExpensesSignature = signature;
    lastExpenses = expenses;

    const { me } = await fetchUsersAndMe();
    lastExpensesIsAdmin = !!me && isAdminRole(me.role);
    lastExpensesMeUsername = me ? me.username : null;

    renderExpenseList();
  } catch (err) {
    expenseListEl.innerHTML = `<div class="empty"><p>Ausgaben konnten nicht geladen werden.</p></div>`;
  }
}

let lastBalanceSignature = null;

async function loadBalance() {
  if (!balanceHeroEl) return;
  try {
    const res = await fetch("/api/expenses/balance");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const balance = await res.json();

    const signature = JSON.stringify(balance);
    if (signature === lastBalanceSignature) return;
    lastBalanceSignature = signature;

    // Dezenter Chip statt großer Karte — sitzt neben der "Offene Zahlungen"-Überschrift.
    if (balance.net > 0.005) {
      balanceHeroEl.innerHTML = `
        <span class="balance-chip-label">Dein Saldo</span>
        <span class="balance-chip-value success">+${formatEuro(balance.net)}</span>
      `;
    } else if (balance.net < -0.005) {
      balanceHeroEl.innerHTML = `
        <span class="balance-chip-label">Dein Saldo</span>
        <span class="balance-chip-value danger">${formatEuro(balance.net)}</span>
      `;
    } else {
      balanceHeroEl.innerHTML = `
        <span class="balance-chip-label">Dein Saldo</span>
        <span class="balance-chip-value muted">ausgeglichen</span>
      `;
    }
  } catch (err) {
    balanceHeroEl.innerHTML = `<div class="muted">Saldo konnte nicht geladen werden.</div>`;
  }
}

// "Ausgaben"-Karte reagiert auf den Personen-Filter darunter — rein clientseitig
// aus den bereits geladenen Ausgaben berechnet, gleiche Regel wie die Liste
// (nur status "offen", keine Tilgungsbuchungen — die kommen aus /api/expenses
// erst gar nicht mit).
function computeFilteredExpenseTotal() {
  if (expenseFilterUserId === null) {
    return lastExpenses.reduce((sum, e) => sum + e.cash, 0);
  }
  if (expenseFilterMode === "von") {
    // Eigenkäufe (X ist Zahler UND einziger Beteiligter) zählen bewusst NICHT
    // mit — "Von X" soll zeigen, was X für ANDERE vorgestreckt hat, nicht was
    // X insgesamt bezahlt hat (siehe Absprache).
    return lastExpenses
      .filter((e) => e.glaubiger_id === expenseFilterUserId && e.schuldner_id !== e.glaubiger_id)
      .reduce((s, e) => s + e.cash, 0);
  }
  return lastExpenses.filter((e) => e.schuldner_id === expenseFilterUserId).reduce((s, e) => s + e.cash, 0);
}

function updateExpensesHeroCard() {
  if (!myExpensesHeroEl) return;

  let title = "Alle Ausgaben";
  if (expenseFilterUserId !== null && cachedUsers) {
    const person = cachedUsers.find((u) => u.id === expenseFilterUserId);
    const isMe = person && cachedMe && person.id === cachedMe.id;
    if (person) {
      if (expenseFilterMode === "von") {
        title = isMe ? "Deine Ausgaben" : `Von ${nameTag(person.username)} gezahlt`;
      } else {
        title = isMe ? "Für dich ausgegeben" : `Für ${nameTag(person.username)} ausgegeben`;
      }
    }
  }

  const total = computeFilteredExpenseTotal();

  myExpensesHeroEl.innerHTML = `
    <span class="balance-chip-label">${title}</span>
    <span class="balance-chip-value">${formatEuro(total)}</span>
  `;
}

function expenseModalBodyHtml(users, me, prefill = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const payerId = prefill.glaubigerId != null ? prefill.glaubigerId : me.id;
  const beneficiaryIds = prefill.beneficiaryIds || null;
  const entryAmounts = prefill.entryAmounts || {};

  // Echtes Dropdown statt <select> (kann weder Farbe noch Profilbild zeigen)
  // und statt dauerhaft sichtbarer Chips: eingeklappt zeigt der Trigger nur
  // die aktuelle Auswahl, aufgeklappt kommen alle User — jeweils als
  // Avatar+Name-Pille (nameTag()), damit's überall gleich aussieht.
  const payerUser = users.find((u) => u.id === payerId) || users[0];
  const payerOptions = users
    .map(
      (u) =>
        `<button type="button" class="payer-dropdown-option${u.id === payerId ? " selected" : ""}" data-id="${u.id}">${nameTag(u.username)}</button>`
    )
    .join("");

  // Chip statt Checkbox+Text: die ganze Kachel ist der Button, blass in der
  // Nutzerfarbe solange nicht ausgewählt, volle Farbe sobald ausgewählt —
  // dadurch auch kompakter, es passen mehr Personen pro Zeile. Ohne Prefill
  // (neue Ausgabe) ist standardmäßig niemand ausgewählt. Das Betragsfeld
  // steht IMMER (für alle User, nicht nur ausgewählte) direkt unter dem
  // jeweiligen Namen im DOM, nur unsichtbar (visibility, nicht display) bis
  // die Person ausgewählt ist — dadurch ändert sich beim Auswählen weder die
  // Höhe des Erfassungsfensters noch die Zuordnung Name↔Betragsfeld.
  const beneficiaryOptions = users
    .map((u) => {
      const checked = beneficiaryIds ? beneficiaryIds.has(u.id) : false;
      const color = USER_COLORS[u.username] || "#ffd400";
      const pale = hexToRgba(color, 0.16);
      const prefillAmount = entryAmounts[u.id] != null ? entryAmounts[u.id].toFixed(2) : "";
      return `
        <div class="beneficiary-slot${checked ? " checked" : ""}" style="--chip-color:${color};--chip-pale:${pale}">
          <label class="beneficiary-chip${checked ? " checked" : ""}">
            <input type="checkbox" class="beneficiary-checkbox" value="${u.id}"${checked ? " checked" : ""}>
            <span>${escapeHtml(u.username)}</span>
          </label>
          <input type="number" step="0.01" min="0.01" inputmode="decimal" class="expense-fixed-input" data-uid="${u.id}" placeholder="auto" value="${prefillAmount}">
        </div>
      `;
    })
    .join("");

  return `
    <div class="form-stack">
      <div class="form-row-2col">
        <label>Betreff
          <input type="text" id="expenseBetreffInput" maxlength="40" value="${escapeHtml(prefill.betreff || "")}" required>
        </label>
        <label>Betrag gesamt (€)
          <input type="number" id="expenseCashInput" step="0.01" min="0.01" inputmode="decimal" value="${prefill.total != null ? prefill.total.toFixed(2) : ""}" required>
        </label>
      </div>
      <div class="checkbox-group">
        <div class="eyebrow">Bezahlt von</div>
        <div class="payer-dropdown-wrap">
          <button type="button" id="expensePayerTrigger" class="payer-dropdown-trigger">
            ${nameTag(payerUser.username)}
            <span class="chevron">▾</span>
          </button>
          <div id="expensePayerDropdown" class="payer-dropdown-list hidden">${payerOptions}</div>
        </div>
        <input type="hidden" id="expensePayerValue" value="${payerUser.id}">
      </div>
      <div class="checkbox-group">
        <div class="eyebrow">Für wen?</div>
        <div id="expenseBeneficiaries" class="beneficiary-grid">${beneficiaryOptions}</div>
        <p id="expenseSplitHint" class="muted"></p>
      </div>
      <label>Datum
        <input type="date" id="expenseDatumInput" value="${prefill.datum || today}" required>
      </label>
    </div>
  `;
}

// Das Betragsfeld existiert für JEDEN User im DOM (siehe expenseModalBodyHtml),
// aber nur die Felder ausgewählter Personen zählen für Summe/Aufteilung —
// unausgewählte sind nur unsichtbar, nicht entfernt.
function checkedExpenseFixedInputs() {
  return Array.from(document.querySelectorAll("#expenseBeneficiaries .expense-fixed-input")).filter((el) => {
    const slot = el.closest(".beneficiary-slot");
    const cb = slot && slot.querySelector(".beneficiary-checkbox");
    return !!(cb && cb.checked);
  });
}

function updateExpenseSplitHint() {
  const hintEl = document.getElementById("expenseSplitHint");
  if (!hintEl) return;

  const fixedInputs = checkedExpenseFixedInputs();
  hintEl.classList.remove("error-text");

  const cash = parseFloat(document.getElementById("expenseCashInput").value) || 0;
  const fixedTotal = fixedInputs.reduce((sum, el) => sum + (parseFloat(el.value) || 0), 0);
  const remaining = Math.round((cash - fixedTotal) * 100) / 100;

  // Niemand ausgewählt: nur der Gesamtbetrag, ohne "auf X Person à Y" — eine
  // Aufteilung ergibt erst Sinn, sobald mindestens eine Person feststeht. Der
  // Satz steht trotzdem von Anfang an da (statt eines leeren Absatzes), damit
  // die Fensterhöhe beim ersten Auswählen nicht durch neu erscheinenden Text
  // springt.
  if (fixedInputs.length === 0) {
    hintEl.textContent = `Rest: ${formatEuro(remaining)}.`;
    return;
  }

  const openCount = fixedInputs.filter((el) => !el.value).length;

  if (remaining < -0.005) {
    hintEl.textContent = `Fixierte Beträge übersteigen den Gesamtbetrag um ${formatEuro(-remaining)}.`;
    hintEl.classList.add("error-text");
  } else if (openCount === 0) {
    hintEl.textContent =
      remaining > 0.005
        ? `Rest von ${formatEuro(remaining)} ist niemandem zugewiesen.`
        : "Alle Beträge sind fest zugewiesen.";
  } else {
    hintEl.textContent = `Rest: ${formatEuro(remaining)} auf ${openCount} Person${openCount === 1 ? "" : "en"} à ${formatEuro(remaining / openCount)}.`;
  }
}

// Muss NACH openModal() aufgerufen werden (braucht die frisch eingefügten Felder im DOM).
// .beneficiary-chip/-slot zeigen die volle/blasse Farbe bzw. das Betragsfeld
// primär über :has(:checked) (siehe style.css) — die .checked-Klasse ist nur
// ein Fallback für Browser ohne :has()-Unterstützung, deshalb hier nach jeder
// Änderung mitgezogen. Beim Abwählen wird der eingetragene Betrag geleert,
// damit kein unsichtbarer Alt-Wert für eine nicht mehr ausgewählte Person
// beim Speichern mitgeschickt wird (Backend lehnt das sonst ab).
function syncBeneficiaryChipClasses() {
  document.querySelectorAll("#expenseBeneficiaries .beneficiary-slot").forEach((slot) => {
    const cb = slot.querySelector(".beneficiary-checkbox");
    const isChecked = !!cb && cb.checked;
    slot.classList.toggle("checked", isChecked);
    slot.querySelector(".beneficiary-chip").classList.toggle("checked", isChecked);
    if (!isChecked) {
      const amountInput = slot.querySelector(".expense-fixed-input");
      if (amountInput) amountInput.value = "";
    }
  });
}

// Eingeklappt (Standard) zeigt der Trigger nur die aktuelle Auswahl als
// Avatar+Name-Pille; Klick öffnet die Liste aller User (ebenfalls als
// Pillen), Klick auf eine Person übernimmt sie und klappt wieder zu.
function wirePayerDropdown(users) {
  const trigger = document.getElementById("expensePayerTrigger");
  const dropdown = document.getElementById("expensePayerDropdown");
  const valueInput = document.getElementById("expensePayerValue");
  if (!trigger || !dropdown || !valueInput) return;

  trigger.addEventListener("click", () => {
    dropdown.classList.toggle("hidden");
    trigger.classList.toggle("open", !dropdown.classList.contains("hidden"));
  });

  dropdown.querySelectorAll(".payer-dropdown-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const user = users.find((u) => String(u.id) === btn.dataset.id);
      if (!user) return;
      valueInput.value = user.id;
      trigger.innerHTML = `${nameTag(user.username)}<span class="chevron">▾</span>`;
      dropdown.querySelectorAll(".payer-dropdown-option").forEach((o) => {
        o.classList.toggle("selected", o === btn);
      });
      dropdown.classList.add("hidden");
      trigger.classList.remove("open");
    });
  });
}

function wireExpenseForm(users) {
  wirePayerDropdown(users);

  document.querySelectorAll("#expenseBeneficiaries .beneficiary-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => {
      syncBeneficiaryChipClasses();
      updateExpenseSplitHint();
    });
  });
  document.querySelectorAll("#expenseBeneficiaries .expense-fixed-input").forEach((el) => {
    el.addEventListener("input", updateExpenseSplitHint);
  });

  document.getElementById("expenseCashInput").addEventListener("input", updateExpenseSplitHint);
  updateExpenseSplitHint();
}

function readExpenseForm() {
  const payerValueInput = document.getElementById("expensePayerValue");
  const glaubiger_id = payerValueInput ? parseInt(payerValueInput.value, 10) : NaN;
  const schuldner_ids = Array.from(
    document.querySelectorAll("#expenseBeneficiaries .beneficiary-checkbox:checked")
  ).map((el) => parseInt(el.value, 10));
  const cash = parseFloat(document.getElementById("expenseCashInput").value);
  const betreff = document.getElementById("expenseBetreffInput").value.trim();
  const datum = document.getElementById("expenseDatumInput").value;

  const fixed_amounts = {};
  checkedExpenseFixedInputs().forEach((el) => {
    const val = parseFloat(el.value);
    if (el.value && val > 0) fixed_amounts[el.dataset.uid] = val;
  });

  if (!betreff || !cash || cash <= 0 || schuldner_ids.length === 0 || Number.isNaN(glaubiger_id)) return null;
  return { glaubiger_id, schuldner_ids, cash, betreff, datum, fixed_amounts };
}

async function openAddExpenseModal() {
  const { users, me } = await fetchUsersAndMe();
  if (!me || users.length === 0) return;

  openModal({
    eyebrow: "Kosten",
    title: "Ausgabe hinzufügen",
    submitLabel: "Speichern",
    bodyHtml: expenseModalBodyHtml(users, me),
    onSubmit: async () => {
      const form = readExpenseForm();
      if (!form) return;

      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        closeModal();
        refreshAllCostsData();
      }
    },
  });

  wireExpenseForm(users);
}

async function openEditExpenseModal(group) {
  const { users, me } = await fetchUsersAndMe();
  if (!me || users.length === 0) return;

  // Nur vormals fest eingetragene Beträge vorausfüllen, damit ein unveränderter
  // Save die individuelle Aufteilung nicht stillschweigend verwirft. Personen, die
  // vorher "auto" waren (Rest gleichmäßig verteilt), bleiben leer, damit sie beim
  // Speichern automatisch neu aufgeteilt werden (z. B. wenn sich Betrag oder
  // Beteiligte geändert haben).
  const entryAmounts = {};
  group.entries.forEach((e) => {
    if (e.fixed) entryAmounts[e.schuldner_id] = e.cash;
  });

  openModal({
    eyebrow: "Kosten",
    title: "Ausgabe bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: expenseModalBodyHtml(users, me, {
      glaubigerId: group.glaubigerId,
      beneficiaryIds: group.beneficiaryIds,
      total: group.total,
      betreff: group.betreff,
      datum: group.datum,
      entryAmounts,
    }),
    onSubmit: async () => {
      const form = readExpenseForm();
      if (!form) return;

      const res = await fetch(`/api/expenses/batch/${group.batchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        closeModal();
        refreshAllCostsData();
      }
    },
  });

  wireExpenseForm(users);
}

const addExpenseButton = document.getElementById("addExpenseButton");
if (addExpenseButton) addExpenseButton.addEventListener("click", openAddExpenseModal);

/* ---------- Kosten: Ansicht wechseln ---------- */
const costsViewRow = document.getElementById("costsViewRow");
const costsViews = {
  entry: document.getElementById("costsViewEntry"),
  open: document.getElementById("costsViewOpen"),
  received: document.getElementById("costsViewReceived"),
  log: document.getElementById("costsViewLog"),
};

function switchCostsView(view, opts = {}) {
  Object.entries(costsViews).forEach(([key, el]) => {
    if (el) el.classList.toggle("hidden", key !== view);
  });
  if (costsViewRow) {
    costsViewRow.querySelectorAll(".filter").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === view);
    });
  }
  if (view === "open") loadOpenSettlements();
  if (view === "received") loadReceivedPayments();
  if (view === "log") loadExpenseLog();
  if (!opts.skipSave) saveUiState({ costsView: view });
}

if (costsViewRow) {
  costsViewRow.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchCostsView(btn.dataset.view);
    });
  });
}

/* ---------- Kosten: Geldfluss-Diagramm (wer zahlt an wen) ---------- */
const moneyFlowCardEl = document.getElementById("moneyFlowCard");
const moneyFlowDiagramEl = document.getElementById("moneyFlowDiagram");
const FLOW_COLOR_VARS = ["--flow-1", "--flow-2", "--flow-3", "--flow-4", "--flow-5", "--flow-6", "--flow-7", "--flow-8"];

// Sankey-artiges Flussdiagramm: links Schuldner, rechts Gläubiger, Bandbreite
// = Betrag. Farbe folgt der Person (feste Namensfarbe, siehe USER_COLORS —
// für alle anderen fällt es auf die Kategorial-Palette zurück) und bleibt auf
// beiden Seiten gleich, damit man dieselbe Person sofort wiedererkennt.
function buildMoneyFlowSvg(settlements) {
  if (settlements.length === 0) return "";
  const totalAmount = settlements.reduce((sum, s) => sum + s.amount, 0);
  if (totalAmount <= 0.005) return "";

  const LABEL_W = 78;
  const NODE_W = 10;
  const MID_W = 150;
  const GAP = 10;
  const TARGET_H = 210;
  const MARGIN_Y = 10;
  const VW = LABEL_W + NODE_W + MID_W + NODE_W + LABEL_W;
  const leftXEnd = LABEL_W + NODE_W;
  const rightXStart = VW - LABEL_W - NODE_W;
  const midX = (leftXEnd + rightXStart) / 2;

  const names = {};
  settlements.forEach((s) => {
    names[s.from_id] = s.from;
    names[s.to_id] = s.to;
  });
  const colorOf = {};
  let autoColorIdx = 0;
  Array.from(new Set(settlements.flatMap((s) => [s.from_id, s.to_id])))
    .sort((a, b) => names[a].localeCompare(names[b], "de"))
    .forEach((id) => {
      if (USER_COLORS[names[id]]) {
        colorOf[id] = USER_COLORS[names[id]];
      } else {
        colorOf[id] = `var(${FLOW_COLOR_VARS[autoColorIdx % FLOW_COLOR_VARS.length]})`;
        autoColorIdx += 1;
      }
    });

  function buildNodes(idKey) {
    const totals = new Map();
    settlements.forEach((s) => totals.set(s[idKey], (totals.get(s[idKey]) || 0) + s.amount));
    return Array.from(totals, ([id, total]) => ({ id, name: names[id], total })).sort(
      (a, b) => b.total - a.total
    );
  }
  let leftNodes = buildNodes("from_id");
  let rightNodes = buildNodes("to_id");

  // Barycenter-Heuristik gegen unnötige Diagonalen/Kreuzungen: eine Seite wird
  // an der (betragsgewichteten) Durchschnittsposition ihrer Gegenstellen
  // ausgerichtet, statt beide Seiten unabhängig nach Betrag zu sortieren —
  // sonst rutscht z. B. ein kleiner Betrag von ganz oben links nach ganz
  // unten rechts und kreuzt dabei alle anderen Bänder unnötig.
  function barycenter(nodeId, key, otherIndex) {
    const otherKey = key === "from_id" ? "to_id" : "from_id";
    let weightedSum = 0;
    let weightTotal = 0;
    settlements.forEach((s) => {
      if (s[key] !== nodeId) return;
      const idx = otherIndex.get(s[otherKey]);
      if (idx === undefined) return;
      weightedSum += idx * s.amount;
      weightTotal += s.amount;
    });
    return weightTotal > 0 ? weightedSum / weightTotal : otherIndex.size / 2;
  }
  for (let pass = 0; pass < 3; pass++) {
    const leftIdx = new Map(leftNodes.map((n, i) => [n.id, i]));
    rightNodes = rightNodes
      .map((n) => ({ n, bary: barycenter(n.id, "to_id", leftIdx) }))
      .sort((a, b) => a.bary - b.bary)
      .map((x) => x.n);

    const rightIdx = new Map(rightNodes.map((n, i) => [n.id, i]));
    leftNodes = leftNodes
      .map((n) => ({ n, bary: barycenter(n.id, "from_id", rightIdx) }))
      .sort((a, b) => a.bary - b.bary)
      .map((x) => x.n);
  }
  const leftIndex = new Map(leftNodes.map((n, i) => [n.id, i]));
  const rightIndex = new Map(rightNodes.map((n, i) => [n.id, i]));

  const scaleFor = (nodes) => (TARGET_H - Math.max(0, nodes.length - 1) * GAP) / totalAmount;
  const scale = Math.max(0.01, Math.min(scaleFor(leftNodes), scaleFor(rightNodes)));

  // Knotenhöhe = Summe der TATSÄCHLICHEN Banddicken (jedes Band einzeln mit
  // 3px-Mindestdicke), nicht aus dem Gesamtbetrag des Knotens berechnet — sonst
  // reicht die Knotenhöhe nicht, sobald eine Person an mehrere Personen zahlt
  // und einer der Beträge so klein ist, dass sein Band auf die Mindestdicke
  // angehoben wird (die Summe der Bänder wäre dann größer als der Knoten).
  function layout(nodes, idKey) {
    const heights = nodes.map((n) =>
      Math.max(
        3,
        settlements
          .filter((s) => s[idKey] === n.id)
          .reduce((sum, s) => sum + Math.max(3, s.amount * scale), 0)
      )
    );
    const columnHeight = heights.reduce((a, b) => a + b, 0) + Math.max(0, nodes.length - 1) * GAP;
    const positions = {};
    let y = 0;
    nodes.forEach((n, i) => {
      positions[n.id] = { y, h: heights[i], cursor: y };
      y += heights[i] + GAP;
    });
    return { positions, columnHeight };
  }
  const left = layout(leftNodes, "from_id");
  const right = layout(rightNodes, "to_id");
  const plotH = Math.max(left.columnHeight, right.columnHeight);
  const leftOffset = MARGIN_Y + (plotH - left.columnHeight) / 2;
  const rightOffset = MARGIN_Y + (plotH - right.columnHeight) / 2;

  // Die Knotenhöhe folgt dem tatsächlichen Betrag (min. 3px, siehe layout()),
  // das zweizeilige Label (Name + Betrag) braucht aber ~24px Platz. Bei sehr
  // kleinen, benachbarten Beträgen reicht der Knotenabstand allein nicht aus
  // und die Labels würden sich überlappen — daher hier, analog zum
  // MIN_LABEL_GAP der Bänder-Labels weiter unten, ein Mindestabstand
  // zwischen den Label-MITTELPUNKTEN erzwungen (die farbigen Balken selbst
  // bleiben unverändert, nur die Textposition wird bei Bedarf verschoben).
  // Etwas kleinere Pille als vorher plus fester Abstand zur Betrags-Zeile
  // darunter, damit sich beide nicht mehr überlappen — Mindestabstand
  // zwischen den Label-MITTELPUNKTEN daher entsprechend größer als die
  // Gesamthöhe von Pille+Lücke+Betrag (NODE_GROUP_H weiter unten).
  const NODE_LABEL_MIN_GAP = 34;
  const NODE_AVATAR_R = 5;
  function nodeLabelCenters(nodes, positions) {
    const centers = nodes.map((n) => positions[n.id].y + positions[n.id].h / 2);
    for (let i = 1; i < centers.length; i++) {
      const minCenter = centers[i - 1] + NODE_LABEL_MIN_GAP;
      if (centers[i] < minCenter) centers[i] = minCenter;
    }
    return centers;
  }
  const leftLabelCenters = nodeLabelCenters(leftNodes, left.positions);
  const rightLabelCenters = nodeLabelCenters(rightNodes, right.positions);

  // Grobe Breiten-Schätzung (kein echtes Text-Measuring im SVG-String
  // verfügbar) — reicht, um die Pille passgenau um Avatar+Name zu legen statt
  // eine großzügige Pauschalbreite anzunehmen.
  function estimateNameWidth(name) {
    return name.length * 6.0;
  }

  const NODE_PILL_PAD_LEFT = 2;
  const NODE_PILL_PAD_RIGHT = 6;
  const NODE_PILL_GAP = 3;
  const NODE_PILL_H = 14;
  const NODE_PILL_TO_AMOUNT_GAP = 4;
  const NODE_AMOUNT_FONT_SIZE = 10;
  const NODE_AMOUNT_ROW_H = 12;
  const NODE_GROUP_H = NODE_PILL_H + NODE_PILL_TO_AMOUNT_GAP + NODE_AMOUNT_ROW_H;

  // Avatar+Name-Pille UND Betrag als ein gemeinsam vertikal zentrierter
  // Wrapper (<g>) — genau wie nameTag() im übrigen UI (siehe .name-pill in
  // style.css): Avatar (oder "?"-Platzhalter) immer LINKS vom Namen, Betrag
  // mit festem Abstand darunter, an derselben Kante verankert. "side"
  // bestimmt nur, ob die Pille von edgeX aus nach links (Schuldner-Spalte,
  // Balken rechts) oder rechts (Gläubiger-Spalte, Balken links) wächst — die
  // Avatar-vor-Name-Reihenfolge bleibt immer gleich. Eigene <clipPath> pro
  // Vorkommen, da dieselbe Person sowohl links als auch rechts auftauchen kann.
  let clipIdCounter = 0;
  function nodeLabelGroupSvg(username, total, side, edgeX, groupCenterY) {
    clipIdCounter += 1;
    const clipId = `mf-avatar-clip-${clipIdCounter}`;
    const color = USER_COLORS[username] || "#ffd400";
    const avatarD = NODE_AVATAR_R * 2;
    const nameWidth = estimateNameWidth(username);
    const pillWidth = NODE_PILL_PAD_LEFT + avatarD + NODE_PILL_GAP + nameWidth + NODE_PILL_PAD_RIGHT;
    const pillLeft = side === "left" ? edgeX - pillWidth : edgeX;

    const groupTop = groupCenterY - NODE_GROUP_H / 2;
    const pillTop = groupTop;
    const pillCenterY = pillTop + NODE_PILL_H / 2;
    const amountBaselineY = pillTop + NODE_PILL_H + NODE_PILL_TO_AMOUNT_GAP + NODE_AMOUNT_FONT_SIZE * 0.8;

    const avatarCx = pillLeft + NODE_PILL_PAD_LEFT + NODE_AVATAR_R;
    const textX = avatarCx + NODE_AVATAR_R + NODE_PILL_GAP;

    const avatarPath = USER_AVATARS[username];
    const avatarSvg = avatarPath
      ? `<clipPath id="${clipId}"><circle cx="${avatarCx.toFixed(1)}" cy="${pillCenterY.toFixed(1)}" r="${NODE_AVATAR_R}"/></clipPath><image href="${avatarPath}" x="${(avatarCx - NODE_AVATAR_R).toFixed(1)}" y="${(pillCenterY - NODE_AVATAR_R).toFixed(1)}" width="${avatarD}" height="${avatarD}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`
      : `<circle cx="${avatarCx.toFixed(1)}" cy="${pillCenterY.toFixed(1)}" r="${NODE_AVATAR_R}" fill="var(--surface2)"/><text x="${avatarCx.toFixed(1)}" y="${pillCenterY.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="${NODE_AVATAR_R}" font-weight="800" fill="var(--muted)">?</text>`;

    const amountAnchor = side === "left" ? "end" : "start";

    return `
      <g>
        <rect x="${pillLeft.toFixed(1)}" y="${pillTop.toFixed(1)}" width="${pillWidth.toFixed(1)}" height="${NODE_PILL_H}" rx="${NODE_PILL_H / 2}" fill="${color}"/>
        ${avatarSvg}
        <text x="${textX.toFixed(1)}" y="${(pillCenterY + 3.5).toFixed(1)}" text-anchor="start" font-size="10" font-weight="800" fill="#111" textLength="${nameWidth.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${escapeHtml(username)}</text>
        <text class="money-flow-node-amount" x="${edgeX.toFixed(1)}" y="${amountBaselineY.toFixed(1)}" text-anchor="${amountAnchor}">${formatEuro(total)}</text>
      </g>
    `;
  }

  let nodesSvg = "";
  leftNodes.forEach((n, i) => {
    const pos = left.positions[n.id];
    const y = pos.y + leftOffset;
    const labelY = leftLabelCenters[i] + leftOffset;
    nodesSvg += `<rect x="${LABEL_W}" y="${y.toFixed(1)}" width="${NODE_W}" height="${pos.h.toFixed(1)}" rx="2" fill="${colorOf[n.id]}"/>`;
    nodesSvg += nodeLabelGroupSvg(n.name, n.total, "left", LABEL_W - 8, labelY);
  });
  rightNodes.forEach((n, i) => {
    const pos = right.positions[n.id];
    const y = pos.y + rightOffset;
    const labelY = rightLabelCenters[i] + rightOffset;
    nodesSvg += `<rect x="${rightXStart.toFixed(1)}" y="${y.toFixed(1)}" width="${NODE_W}" height="${pos.h.toFixed(1)}" rx="2" fill="${colorOf[n.id]}"/>`;
    nodesSvg += nodeLabelGroupSvg(n.name, n.total, "right", VW - LABEL_W + 8, labelY);
  });

  // y0 (Startposition je Band am linken Knoten) und y1 (am rechten Knoten)
  // getrennt berechnen: die Bänder EINES Knotens werden nach dem Rang ihres
  // jeweiligen Gegenknotens einsortiert (nicht nach globalem Betrag) — sonst
  // verdrehen sich mehrere Bänder desselben Knotens unnötig ineinander.
  const y0Map = new Map();
  settlements
    .slice()
    .sort((a, b) => (rightIndex.get(a.to_id) ?? 0) - (rightIndex.get(b.to_id) ?? 0))
    .forEach((s) => {
      const pos = left.positions[s.from_id];
      const thickness = Math.max(3, s.amount * scale);
      y0Map.set(s, pos.cursor + leftOffset);
      pos.cursor += thickness;
    });
  const y1Map = new Map();
  settlements
    .slice()
    .sort((a, b) => (leftIndex.get(a.from_id) ?? 0) - (leftIndex.get(b.from_id) ?? 0))
    .forEach((s) => {
      const pos = right.positions[s.to_id];
      const thickness = Math.max(3, s.amount * scale);
      y1Map.set(s, pos.cursor + rightOffset);
      pos.cursor += thickness;
    });

  // Größte Bänder zuerst zeichnen, damit dünnere beim Überlappen sichtbar bleiben.
  // Jedes Band bekommt seinen Betrag als Label direkt an seinem Ursprung beim
  // Schuldner (linksbündig, in dessen Farbe) statt an der Kreuzungsstelle in
  // der Mitte — dort können sich mehrere Bänder überlagern und es ist nicht
  // auf Anhieb erkennbar, wer zahlen muss. An der Startposition beim Schuldner
  // sind die Bänder eines Knotens durch die Stapel-Reihenfolge garantiert
  // überlappungsfrei (siehe y0Map).
  let ribbonsSvg = "";
  const labelEntries = [];
  settlements
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .forEach((s) => {
      const thickness = Math.max(3, s.amount * scale);
      const y0 = y0Map.get(s);
      const y1 = y1Map.get(s);
      const d = `M${leftXEnd},${y0.toFixed(1)} C${midX},${y0.toFixed(1)} ${midX},${y1.toFixed(1)} ${rightXStart},${y1.toFixed(1)} L${rightXStart},${(y1 + thickness).toFixed(1)} C${midX},${(y1 + thickness).toFixed(1)} ${midX},${(y0 + thickness).toFixed(1)} ${leftXEnd},${(y0 + thickness).toFixed(1)} Z`;
      const opacity = s.pending ? 0.28 : 0.62;
      ribbonsSvg += `<path d="${d}" fill="${colorOf[s.from_id]}" opacity="${opacity}"><title>${escapeHtml(s.from)} → ${escapeHtml(s.to)}: ${formatEuro(s.amount)}${s.pending ? " (wartet auf Bestätigung)" : ""}</title></path>`;

      const pendingSuffix = s.pending ? " ⏳" : "";
      labelEntries.push({
        y: y0 + thickness / 2 + 3,
        text: `${formatEuro(s.amount)}${pendingSuffix}`,
        color: colorOf[s.from_id],
      });
    });

  // Bei sehr kleinen Beträgen (Band nur 3px dick) reicht die eigene Stapel-
  // Position allein nicht als Abstand für den Text — hier zusätzlich ein
  // Mindestabstand erzwungen (nach y sortiert, damit "vorheriger Eintrag"
  // wirklich der vertikal vorherige ist).
  const MIN_LABEL_GAP = 12;
  labelEntries.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labelEntries.length; i++) {
    const minY = labelEntries[i - 1].y + MIN_LABEL_GAP;
    if (labelEntries[i].y < minY) labelEntries[i].y = minY;
  }
  const labelsSvg = labelEntries
    .map(
      (l) =>
        `<text class="money-flow-edge-label" x="${(leftXEnd + 6).toFixed(1)}" y="${l.y.toFixed(1)}" text-anchor="start" fill="${l.color}">${l.text}</text>`
    )
    .join("");

  const maxLabelY = labelEntries.length ? labelEntries[labelEntries.length - 1].y : 0;
  const maxNodeLabelY = Math.max(
    leftLabelCenters.length ? leftLabelCenters[leftLabelCenters.length - 1] + leftOffset : 0,
    rightLabelCenters.length ? rightLabelCenters[rightLabelCenters.length - 1] + rightOffset : 0
  );
  const fullH = Math.max(
    plotH + 2 * MARGIN_Y,
    maxLabelY + MARGIN_Y,
    maxNodeLabelY + NODE_GROUP_H / 2 + MARGIN_Y
  );
  return `<svg viewBox="0 0 ${VW.toFixed(1)} ${fullH.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">${ribbonsSvg}${nodesSvg}${labelsSvg}</svg>`;
}

function renderMoneyFlowDiagram(settlements) {
  if (!moneyFlowCardEl || !moneyFlowDiagramEl) return;
  const svg = buildMoneyFlowSvg(settlements);
  moneyFlowCardEl.classList.toggle("hidden", !svg);
  if (svg) moneyFlowDiagramEl.innerHTML = svg;
}

/* ---------- Kosten: Offene Zahlungen ---------- */
const openSettlementsListEl = document.getElementById("openSettlementsList");

function openConfirmSettleModal(s) {
  openModal({
    eyebrow: "Offene Zahlung",
    title: "Als überwiesen markieren?",
    submitLabel: "Ja, überwiesen",
    bodyHtml: `
      <p class="muted">
        An <strong>${nameTag(s.to)}</strong>. Offen sind insgesamt ${formatEuro(s.amount)} — du kannst auch nur
        einen Teilbetrag als überwiesen markieren, der Rest bleibt dann offen.
      </p>
      <label>Überwiesener Betrag
        <input type="number" step="0.01" min="0.01" max="${s.amount}" inputmode="decimal" id="settleAmountInput" value="${s.amount.toFixed(2)}" required>
      </label>
      <p class="muted">${nameTag(s.to)} sieht das jetzt hier in der App und muss den Empfang bestätigen — sobald das passiert, siehst auch du es hier und der Betrag gilt als beglichen.</p>
      <p id="settleModalError" class="error-text hidden"></p>
    `,
    onSubmit: async () => {
      const errEl = document.getElementById("settleModalError");
      const input = document.getElementById("settleAmountInput");
      const amount = parseFloat(input.value);
      errEl.classList.add("hidden");

      if (!amount || amount <= 0) {
        errEl.textContent = "Bitte einen Betrag eingeben.";
        errEl.classList.remove("hidden");
        return;
      }

      const res = await fetch("/api/expenses/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_id: s.to_id, amount }),
      });
      if (res.ok) {
        closeModal();
        refreshAllCostsData();
      } else {
        const data = await res.json().catch(() => ({}));
        errEl.textContent = data.error || "Konnte nicht bestätigt werden.";
        errEl.classList.remove("hidden");
      }
    },
  });
}

function renderSettlementItem(s, isMine) {
  const card = document.createElement("div");
  card.className = "list-card";
  let actionHtml = "";
  if (isMine && s.pending) {
    actionHtml = `<div class="list-card-actions"><span class="pill">Warten auf Bestätigung von ${nameTag(s.to)}</span></div>`;
  } else if (isMine) {
    actionHtml = `<div class="list-card-actions"><button type="button" class="tiny settle-btn">Als bezahlt markieren</button></div>`;
  }
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${nameTag(s.from)} → ${nameTag(s.to)}</p>
      <p class="list-card-meta">${formatEuro(s.amount)}</p>
    </div>
    ${actionHtml}
  `;
  if (isMine && !s.pending) {
    card.querySelector(".settle-btn").addEventListener("click", () => openConfirmSettleModal(s));
  }
  return card;
}

let lastOpenSettlementsSignature = null;

// Für die Liste (nicht das Schaubild!) eigene Reihenfolge pro Betrachter: erst
// was man selbst zahlen muss, dann was man bekommt, dann der Rest — jeweils in
// der ursprünglichen Reihenfolge der Gruppe. Das Schaubild bekommt bewusst das
// unsortierte Original, damit es für alle User gleich aussieht.
function sortSettlementsForViewer(settlements, meId) {
  if (!meId) return settlements;
  const mine = [];
  const toMine = [];
  const rest = [];
  settlements.forEach((s) => {
    if (s.from_id === meId) mine.push(s);
    else if (s.to_id === meId) toMine.push(s);
    else rest.push(s);
  });
  return [...mine, ...toMine, ...rest];
}

async function loadOpenSettlements() {
  if (!openSettlementsListEl) return;
  try {
    const { me } = await fetchUsersAndMe();
    const res = await fetch("/api/expenses/open");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const settlements = await res.json();

    const signature = JSON.stringify(settlements);
    if (signature === lastOpenSettlementsSignature) return;
    lastOpenSettlementsSignature = signature;

    renderMoneyFlowDiagram(settlements);

    openSettlementsListEl.innerHTML = "";
    if (settlements.length === 0) {
      openSettlementsListEl.innerHTML = `<div class="empty"><p>Keine offenen Zahlungen — alles ausgeglichen.</p></div>`;
    } else {
      sortSettlementsForViewer(settlements, me ? me.id : null).forEach((s) =>
        openSettlementsListEl.appendChild(renderSettlementItem(s, !!me && s.from_id === me.id))
      );
    }
  } catch (err) {
    openSettlementsListEl.innerHTML = `<div class="empty"><p>Konnte nicht geladen werden.</p></div>`;
  }
}

/* ---------- Offene Zahlungen: bereits getilgte Rückzahlungen (Historie) ---------- */
const settledToggleBtn = document.getElementById("settledToggleBtn");
const settledListEl = document.getElementById("settledList");
let lastSettledPayments = [];
let settledListExpanded = false;

function renderSettledItem(s) {
  const card = document.createElement("div");
  card.className = "list-card";
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${nameTag(s.from)} → ${nameTag(s.to)}</p>
      <p class="list-card-meta">${formatEuro(s.amount)} · ${formatDate(s.date)}</p>
    </div>
    <div class="list-card-actions"><span class="pill">✓ bestätigt</span></div>
  `;
  return card;
}

function renderSettledList() {
  if (!settledListEl || !settledToggleBtn) return;
  settledToggleBtn.classList.toggle("hidden", lastSettledPayments.length === 0);
  settledToggleBtn.textContent = settledListExpanded
    ? "Bereits getilgt ausblenden"
    : `Bereits getilgt anzeigen (${lastSettledPayments.length})`;
  settledListEl.classList.toggle("hidden", !settledListExpanded);
  if (!settledListExpanded) return;
  settledListEl.innerHTML = "";
  lastSettledPayments.forEach((s) => settledListEl.appendChild(renderSettledItem(s)));
}

if (settledToggleBtn) {
  settledToggleBtn.addEventListener("click", () => {
    settledListExpanded = !settledListExpanded;
    renderSettledList();
  });
}

let lastSettledSignature = null;

async function loadSettledPayments() {
  if (!settledListEl) return;
  try {
    const res = await fetch("/api/expenses/settled");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const payments = await res.json();
    const signature = JSON.stringify(payments);
    if (signature === lastSettledSignature) return;
    lastSettledSignature = signature;
    lastSettledPayments = payments;
    renderSettledList();
  } catch (err) {
    // Netzwerkhänger ignorieren, nächster Tick versucht es erneut
  }
}

/* ---------- Offene Zahlungen: animierter Rechenweg ---------- */
const explainSettlementsBtn = document.getElementById("explainSettlementsBtn");
const settlementExplainDialog = document.getElementById("settlementExplainDialog");
const settlementExplainCloseBtn = document.getElementById("settlementExplainClose");
const settlementExplainBodyEl = document.getElementById("settlementExplainBody");
const settlementExplainDotsEl = document.getElementById("settlementExplainDots");
const settlementExplainPrevBtn = document.getElementById("settlementExplainPrev");
const settlementExplainNextBtn = document.getElementById("settlementExplainNext");

let explainSlides = [];
let explainSlideIndex = 0;

function explainPairNetRow(p) {
  const netAbs = Math.abs(p.net);
  const settled = netAbs <= 0.005;
  const fromName = p.net >= 0 ? p.a_username : p.b_username;
  const toName = p.net >= 0 ? p.b_username : p.a_username;
  return `
    <div class="explain-pair-net-row">
      <span class="explain-pair-net-names">${nameTag(p.a_username)} ⇄ ${nameTag(p.b_username)}</span>
      <span class="explain-pair-net-calc">
        ${formatEuro(p.a_to_b)} − ${formatEuro(p.b_to_a)} =
        ${settled ? `<em>ausgeglichen</em>` : `<strong>${escapeHtml(fromName)} → ${escapeHtml(toName)}: ${formatEuro(netAbs)}</strong>`}
      </span>
    </div>
  `;
}

function explainChainHop(amount) {
  return `
    <div class="explain-chain-arrow">
      <span class="explain-chain-amount">${formatEuro(amount)}</span>
      <div class="explain-arrow-line"><span class="explain-arrow-head">→</span></div>
    </div>
  `;
}

function explainMergeChain(m, idx, total) {
  const inAfter = Math.max(0, m.amt_in - m.amount);
  const outAfter = Math.max(0, m.amt_out - m.amount);
  return `
    <div class="explain-merge-chain">
      <p class="explain-merge-chain-label">Kette ${idx + 1} von ${total}</p>
      <div class="explain-chain">
        <div class="explain-chain-node">${nameTag(m.u)}</div>
        ${explainChainHop(m.amt_in)}
        <div class="explain-chain-node">${nameTag(m.m)}</div>
        ${explainChainHop(m.amt_out)}
        <div class="explain-chain-node">${nameTag(m.v)}</div>
      </div>
      <p class="explain-transfer-calc">min(${formatEuro(m.amt_in)}, ${formatEuro(m.amt_out)}) = ${formatEuro(m.amount)}</p>
      <div class="explain-example-block">
        <p class="explain-example-direction-title">${formatEuro(m.amount)} wird direkt ${escapeHtml(m.u)} → ${escapeHtml(m.v)} verschoben — ${escapeHtml(m.m)} wird dafür übersprungen:</p>
        <div class="explain-example-item"><span>${escapeHtml(m.u)} → ${escapeHtml(m.m)}</span><span>${formatEuro(m.amt_in)} → ${formatEuro(inAfter)}</span></div>
        <div class="explain-example-item"><span>${escapeHtml(m.m)} → ${escapeHtml(m.v)}</span><span>${formatEuro(m.amt_out)} → ${formatEuro(outAfter)}</span></div>
        <div class="explain-example-item"><span>${escapeHtml(m.u)} → ${escapeHtml(m.v)}</span><span>+${formatEuro(m.amount)}</span></div>
      </div>
    </div>
  `;
}

function explainLedgerEntry(e, fromName, toName) {
  if (e.type === "direct") {
    return `
      <div class="explain-ledger-row">
        <span>${escapeHtml(fromName)} schuldete ${escapeHtml(toName)} schon direkt aus eigenen Ausgaben (Schritt 1)</span>
        <span class="explain-ledger-plus">+${formatEuro(e.amount)}</span>
      </div>
    `;
  }
  const isAdd = e.type === "chain_add";
  const label = isAdd
    ? `Kette ${escapeHtml(e.u)} → ${escapeHtml(e.m)} → ${escapeHtml(e.v)} verschoben hierher (Kette ${e.step} in Schritt 2)`
    : `Diese Verbindung als Zwischenstation für Kette ${escapeHtml(e.u)} → ${escapeHtml(e.m)} → ${escapeHtml(e.v)} verbraucht (Kette ${e.step} in Schritt 2)`;
  return `
    <div class="explain-ledger-row">
      <span>${label}</span>
      <span class="${isAdd ? "explain-ledger-plus" : "explain-ledger-minus"}">${isAdd ? "+" : ""}${formatEuro(e.amount)}</span>
    </div>
  `;
}

function explainLedgerBlock(l) {
  const hasDirect = l.entries.some((e) => e.type === "direct");
  return `
    <div class="explain-merge-chain">
      <p class="explain-merge-chain-label">${nameTag(l.from)} → ${nameTag(l.to)}</p>
      <div class="explain-example-block">
        ${l.entries.map((e) => explainLedgerEntry(e, l.from, l.to)).join("")}
        <div class="explain-example-sum">= ${formatEuro(l.amount)}</div>
      </div>
      ${
        hasDirect
          ? `<p class="muted">Der Startwert ist das, was ${escapeHtml(l.from)} und ${escapeHtml(l.to)} schon aus ihren eigenen gemeinsamen Ausgaben direkt geschuldet haben — unabhängig von jeder Kette. Ketten verändern diesen Wert danach nur noch.</p>`
          : ""
      }
    </div>
  `;
}

// Baut die einzelnen "Folien" der Animation aus denselben Daten, die auch die
// tatsächlichen Zahlungsvorschläge liefern (/api/expenses/open/explain nutzt
// intern exakt dieselbe Berechnung wie /api/expenses/open) — so kann die
// Erklärung nie von der echten Liste abweichen.
function explainExampleDirection(fromName, toName, dir) {
  const itemsHtml = dir.items
    .map(
      (it) => `
    <div class="explain-example-item">
      <span>${escapeHtml(it.betreff)}${it.tilgung ? ` <span class="explain-example-tag">Rückzahlung</span>` : ""}</span>
      <span>${formatEuro(it.cash)}</span>
    </div>
  `
    )
    .join("");
  const moreHtml = dir.more > 0 ? `<div class="explain-example-more">+ ${dir.more} weitere Ausgabe${dir.more === 1 ? "" : "n"}</div>` : "";
  return `
    <div class="explain-example-block">
      <p class="explain-example-direction-title">${nameTag(fromName)} schuldet ${nameTag(toName)}:</p>
      ${dir.items.length ? itemsHtml + moreHtml : `<p class="muted">–</p>`}
      <div class="explain-example-sum">= ${formatEuro(dir.total)}</div>
    </div>
  `;
}

function explainExampleBlock(ex) {
  // Kein Paar-Titel mehr — die Namen stehen schon in explainExampleDirection()
  // ("X schuldet Y:"), die Trennlinie von .explain-merge-chain reicht als
  // optische Abgrenzung zwischen den Paaren.
  return `
    <div class="explain-merge-chain">
      ${explainExampleDirection(ex.a, ex.b, ex.a_to_b)}
      ${explainExampleDirection(ex.b, ex.a, ex.b_to_a)}
    </div>
  `;
}

function buildExplainSlides(data) {
  const { pairs, netted_pairs, merges, steps, examples } = data;

  const slides = [];

  slides.push(() => `
    <div class="explain-slide">
      <p>Jede gemeinsame Ausgabe erzeugt eine direkte Schuld: wer bezahlt hat, bekommt ein Guthaben — wer beteiligt war, schuldet seinen Anteil.</p>
      <p>Zuerst wird das <strong>nur zwischen den zwei beteiligten Personen</strong> verrechnet. Ergibt sich daraus eine Kette (A schuldet B, B schuldet C), wird die Kette danach aufgelöst, damit möglichst wenige Überweisungen nötig sind.</p>
      ${
        examples && examples.length
          ? `
        <p class="explain-slide-label">Beispiele — jedes Paar im Detail</p>
        <div class="explain-merge-list">
          ${examples.map((ex) => explainExampleBlock(ex)).join("")}
        </div>
        <p class="muted">Diese Summen werden im nächsten Schritt pro Paar gegeneinander verrechnet.</p>
      `
          : ""
      }
    </div>
  `);

  slides.push(() => `
    <div class="explain-slide">
      <p class="explain-slide-label">Schritt 1 — Pro Paar verrechnet</p>
      ${pairs.length ? pairs.map((p) => explainPairNetRow(p)).join("") : `<p class="muted">–</p>`}
      <p class="muted">Beide Richtungen werden gegeneinander aufgerechnet — übrig bleibt eine Zahlung pro Paar (oder gar keine, wenn es sich deckt).</p>
    </div>
  `);

  if (merges.length) {
    slides.push(() => `
      <div class="explain-slide">
        <p class="explain-slide-label">Schritt 2 — Ketten auflösen</p>
        <p>Wo eine Person nur "durchreicht" (schuldet UND bekommt was), wird sie so weit wie möglich übersprungen — das spart Überweisungen, führt aber dazu, dass am Ende auch an Personen gezahlt wird, mit denen man nichts direkt hatte.</p>
        <div class="explain-merge-list">
          ${merges.map((m, idx) => explainMergeChain(m, idx, merges.length)).join("")}
        </div>
      </div>
    `);
  }

  const ledgers = data.ledgers || [];
  if (ledgers.length) {
    slides.push(() => `
      <div class="explain-slide">
        <p class="explain-slide-label">Schritt 3 — Wie sich die Ergebnisse aufsummieren</p>
        <p>Jede finale Zahlung ist die Summe aus dem direkten Betrag (Schritt 1) plus allen Kettenschritten, die genau diese Verbindung erhöht haben — abzüglich der Schritte, in denen sie selbst wieder als Zwischenstation für eine andere Kette verbraucht wurde.</p>
        <p class="muted">Die Herleitung für jede der ${ledgers.length} finalen Zahlung${ledgers.length === 1 ? "" : "en"} im Detail:</p>
        <div class="explain-merge-list">
          ${ledgers.map((l) => explainLedgerBlock(l)).join("")}
        </div>
      </div>
    `);
  }

  slides.push(() => `
    <div class="explain-slide">
      <p class="explain-slide-label">Ergebnis</p>
      <div class="stack">
        ${
          steps.length
            ? steps
                .map(
                  (s) => `
          <div class="explain-result-row">${nameTag(s.from)} schuldet ${nameTag(s.to)}: <strong>${formatEuro(s.amount)}</strong></div>
        `
                )
                .join("")
            : `<p class="muted">Alles ausgeglichen.</p>`
        }
      </div>
      <p class="muted">Genau diese ${steps.length} Überweisung${steps.length === 1 ? "" : "en"} siehst du unter "Offen" — von ursprünglich ${netted_pairs.length} Paar-Zahlung${netted_pairs.length === 1 ? "" : "en"} über Ketten auf ${steps.length} reduziert.</p>
    </div>
  `);

  return slides;
}

function renderExplainSlide() {
  if (!settlementExplainBodyEl) return;
  settlementExplainBodyEl.innerHTML = explainSlides[explainSlideIndex]();
  // Ohne das bleibt beim Weiterklicken die Scroll-Position der vorherigen
  // (evtl. heruntergescrollten) Folie stehen — jede Folie soll aber immer
  // oben beginnen.
  settlementExplainBodyEl.scrollTop = 0;
  requestAnimationFrame(() => {
    const slideEl = settlementExplainBodyEl.querySelector(".explain-slide");
    if (slideEl) requestAnimationFrame(() => slideEl.classList.add("in"));
  });

  if (settlementExplainDotsEl) {
    settlementExplainDotsEl.innerHTML = explainSlides
      .map((_, i) => `<span class="explain-dot${i === explainSlideIndex ? " active" : ""}"></span>`)
      .join("");
  }
  if (settlementExplainPrevBtn) settlementExplainPrevBtn.disabled = explainSlideIndex === 0;
  if (settlementExplainNextBtn) {
    settlementExplainNextBtn.textContent = explainSlideIndex === explainSlides.length - 1 ? "Fertig" : "Weiter ›";
  }
}

async function openSettlementExplain() {
  if (!settlementExplainDialog || !settlementExplainBodyEl) return;
  settlementExplainBodyEl.innerHTML = `<p class="muted">Lädt …</p>`;
  if (settlementExplainDotsEl) settlementExplainDotsEl.innerHTML = "";
  if (settlementExplainPrevBtn) settlementExplainPrevBtn.disabled = true;
  if (settlementExplainNextBtn) settlementExplainNextBtn.textContent = "Fertig";
  settlementExplainDialog.showModal();

  try {
    const res = await fetch("/api/expenses/open/explain");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const data = await res.json();

    if (!data.steps || data.steps.length === 0) {
      settlementExplainBodyEl.innerHTML = `<div class="explain-slide in"><p class="muted">Aktuell ist nichts offen — alles ausgeglichen! 🎉</p></div>`;
      explainSlides = [];
      return;
    }

    explainSlides = buildExplainSlides(data);
    explainSlideIndex = 0;
    renderExplainSlide();
  } catch (err) {
    settlementExplainBodyEl.innerHTML = `<p class="muted">Konnte nicht geladen werden.</p>`;
  }
}

if (explainSettlementsBtn) explainSettlementsBtn.addEventListener("click", openSettlementExplain);
if (settlementExplainCloseBtn) {
  settlementExplainCloseBtn.addEventListener("click", () => settlementExplainDialog.close());
}
if (settlementExplainNextBtn) {
  settlementExplainNextBtn.addEventListener("click", () => {
    if (explainSlideIndex >= explainSlides.length - 1) {
      settlementExplainDialog.close();
      return;
    }
    explainSlideIndex += 1;
    renderExplainSlide();
  });
}
if (settlementExplainPrevBtn) {
  settlementExplainPrevBtn.addEventListener("click", () => {
    if (explainSlideIndex > 0) {
      explainSlideIndex -= 1;
      renderExplainSlide();
    }
  });
}

/* ---------- Kosten: Erhaltene Zahlungen ---------- */
const receivedListEl = document.getElementById("receivedList");

function renderReceivedItem(r) {
  const card = document.createElement("div");
  card.className = "list-card";
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${nameTag(r.from)} behauptet: ${formatEuro(r.amount)} überwiesen</p>
      <p class="list-card-meta">${formatDate(r.datum)} · Betrag zur Bestätigung eintippen</p>
      <div class="form-stack">
        <input type="number" step="0.01" min="0.01" inputmode="decimal" class="received-amount-input" placeholder="${r.amount.toFixed(2).replace('.', ',')}">
        <p class="error-text hidden received-error"></p>
      </div>
    </div>
    <div class="list-card-actions">
      <button type="button" class="tiny confirm-received-btn">Bestätigen</button>
    </div>
  `;

  card.querySelector(".confirm-received-btn").addEventListener("click", async () => {
    const input = card.querySelector(".received-amount-input");
    const errEl = card.querySelector(".received-error");
    const amount = parseFloat(input.value);
    errEl.classList.add("hidden");

    if (!amount || amount <= 0) {
      errEl.textContent = "Bitte einen Betrag eingeben.";
      errEl.classList.remove("hidden");
      return;
    }

    const res = await fetch("/api/expenses/settle/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expense_id: r.id, amount }),
    });

    if (res.ok) {
      refreshAllCostsData();
    } else {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || "Konnte nicht bestätigt werden.";
      errEl.classList.remove("hidden");
    }
  });

  return card;
}

let lastReceivedSignature = null;

// Rote Zahl an "Kosten" (Bottom-Nav) und am "Erhaltene Zahlungen"-Tab, solange
// mindestens eine Zahlung auf Bestätigung wartet — auf einen Blick ersichtlich,
// dass hier etwas zu tun ist.
function updateReceivedBadge(count) {
  [document.getElementById("costsNavBadge"), document.getElementById("receivedTabBadge")].forEach((el) => {
    if (!el) return;
    el.textContent = String(count);
    el.classList.toggle("hidden", count === 0);
  });
}

async function loadReceivedPayments() {
  if (!receivedListEl) return;
  try {
    const res = await fetch("/api/expenses/received");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const received = await res.json();
    updateReceivedBadge(received.length);

    // Wichtig: ohne diesen Vergleich würde das Polling das Eingabefeld
    // hier bei jedem Tick neu aufbauen und man könnte nie eine Zahl eintippen,
    // obwohl sich an den Daten gar nichts geändert hat.
    const signature = JSON.stringify(received);
    if (signature === lastReceivedSignature) return;
    lastReceivedSignature = signature;

    receivedListEl.innerHTML = "";
    if (received.length === 0) {
      receivedListEl.innerHTML = `<div class="empty"><p>Keine offenen Bestätigungen.</p></div>`;
    } else {
      received.forEach((r) => receivedListEl.appendChild(renderReceivedItem(r)));
    }
  } catch (err) {
    receivedListEl.innerHTML = `<div class="empty"><p>Konnte nicht geladen werden.</p></div>`;
  }
}

/* ---------- Kosten: Log (wer hat Ausgaben erstellt/bearbeitet/gelöscht) ---------- */
const expenseLogListEl = document.getElementById("expenseLogList");
const expenseLogFilterSelect = document.getElementById("expenseLogFilterSelect");
const expenseLogPagerEl = document.getElementById("expenseLogPager");
const expenseLogJumpTopBtn = document.getElementById("expenseLogJumpTopBtn");
let lastExpenseLog = [];
let expenseLogFilterAction = "";
const EXPENSE_LOG_PAGE_SIZE = 25;
let expenseLogPage = 1;
if (expenseLogJumpTopBtn) {
  expenseLogJumpTopBtn.addEventListener("click", () => {
    expenseLogPage = 1;
    renderExpenseLog();
    if (appShellEl) appShellEl.scrollTop = 0;
  });
}

function formatExpenseLogTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const EXPENSE_LOG_ICONS = {
  expense_created: "💶",
  expense_edited: "✏️",
  expense_deleted: "🗑️",
  payment_reported: "📤",
  payment_confirmed: "✅",
};

function renderExpenseLogItem(entry) {
  const card = document.createElement("div");
  card.className = "list-card";
  const messageHtml = escapeHtml(entry.message).replace(escapeHtml(entry.actor), nameTag(entry.actor));
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${EXPENSE_LOG_ICONS[entry.action] || "•"} ${messageHtml}</p>
      <p class="list-card-meta">${formatExpenseLogTime(entry.created_at)}</p>
    </div>
  `;
  return card;
}

function renderExpenseLog() {
  if (!expenseLogListEl) return;
  const filtered = expenseLogFilterAction
    ? lastExpenseLog.filter((e) => e.action === expenseLogFilterAction)
    : lastExpenseLog;

  // Nur die 25 aktuellsten Einträge auf einmal (Liste kommt bereits absteigend
  // sortiert vom Server), Rest über die Seitennummerierung darunter.
  const totalPages = Math.max(1, Math.ceil(filtered.length / EXPENSE_LOG_PAGE_SIZE));
  if (expenseLogPage > totalPages) expenseLogPage = totalPages;
  const pageEntries = filtered.slice(
    (expenseLogPage - 1) * EXPENSE_LOG_PAGE_SIZE,
    expenseLogPage * EXPENSE_LOG_PAGE_SIZE
  );

  expenseLogListEl.innerHTML = "";
  if (filtered.length === 0) {
    expenseLogListEl.innerHTML = `<div class="empty-state"><p>Noch keine Einträge.</p></div>`;
  } else {
    pageEntries.forEach((e) => expenseLogListEl.appendChild(renderExpenseLogItem(e)));
  }
  if (expenseLogJumpTopBtn) expenseLogJumpTopBtn.classList.toggle("hidden", expenseLogPage <= 1);
  renderPager(expenseLogPagerEl, {
    total: filtered.length,
    page: expenseLogPage,
    pageSize: EXPENSE_LOG_PAGE_SIZE,
    onChange: (p) => {
      expenseLogPage = p;
      renderExpenseLog();
    },
    scrollAnchor: "end",
  });
}

async function loadExpenseLog() {
  if (!expenseLogListEl) return;
  try {
    const res = await fetch("/api/expenses/log");
    if (!res.ok) throw new Error("Fehler beim Laden");
    lastExpenseLog = await res.json();
    renderExpenseLog();
  } catch (err) {
    expenseLogListEl.innerHTML = `<div class="empty-state"><p>Log konnte nicht geladen werden.</p></div>`;
  }
}

if (expenseLogFilterSelect) {
  expenseLogFilterSelect.addEventListener("change", () => {
    expenseLogFilterAction = expenseLogFilterSelect.value;
    expenseLogPage = 1;
    renderExpenseLog();
    saveUiState({ costsLogFilter: expenseLogFilterAction });
  });
}

/* ---------- Kosten: alles alle 3 Sekunden aktualisieren ---------- */
// Läuft unabhängig davon, welche Unteransicht gerade sichtbar ist (gleiches
// Prinzip wie beim Einkaufslisten-Polling) — so ist z. B. sofort sichtbar,
// wenn jemand anderes eine Zahlung bestätigt, ohne dass neu eingeloggt werden muss.
function pollCostsViews() {
  loadBalance();
  loadExpenses();
  loadOpenSettlements();
  loadReceivedPayments();
  loadSettledPayments();
}

// Nach JEDER Änderung an Ausgaben (anlegen/bearbeiten/löschen/Zahlung
// senden/bestätigen) müssen alle davon abhängigen Ansichten neu gerechnet
// werden — nicht nur Liste + Saldo, sondern auch offene Zahlungen, erhaltene
// Zahlungen und das Geldfluss-Diagramm. Die Signaturen werden dafür bewusst
// zurückgesetzt, damit der "nur bei echter Änderung neu rendern"-Vergleich
// nicht fälschlich glaubt, es habe sich nichts geändert (z. B. wenn ein
// Poll-Tick zwischendurch schon denselben Endzustand gesehen hat).
function refreshAllCostsData() {
  lastExpensesSignature = null;
  lastBalanceSignature = null;
  lastOpenSettlementsSignature = null;
  lastReceivedSignature = null;
  lastSettledSignature = null;
  loadExpenses();
  loadBalance();
  loadOpenSettlements();
  loadReceivedPayments();
  loadSettledPayments();
}

/* ---------- Auto-Update: neuen Deploy selbstständig erkennen und neu laden ---------- */
// Kein manuelles Aktualisieren mehr nötig: erkennt eine neue Version (Backend-
// Neustart ODER geänderte app.js/style.css/index.html) und lädt automatisch
// neu — aber nur, wenn gerade kein Formular offen ist, damit nichts Eingegebenes
// verloren geht. Ist ein Modal offen, wird beim nächsten Tick erneut geprüft.
async function checkAppVersion() {
  if (!window.APP_VERSION) return;
  try {
    const res = await fetch("/api/version");
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== window.APP_VERSION && !modal.open) {
      location.reload();
    }
  } catch (err) {
    // Netzwerkhänger ignorieren, nächster Tick versucht es erneut
  }
}

/* ---------- Kosten: zuletzt gewählte Unteransicht + Filter wiederherstellen
   (gleicher Mechanismus wie bei Tasks — siehe ensureUiStateLoaded) ---------- */
fetchUsersAndMe().then(async ({ me }) => {
  if (!me) return;
  const state = await ensureUiStateLoaded(me.username);
  if (!state) return;

  if (state.costsView && costsViews[state.costsView]) {
    switchCostsView(state.costsView, { skipSave: true });
  }
  if (typeof state.costsExpenseFilter === "string" && expenseFilterSelect) {
    await populateExpenseFilterOptions();
    expenseFilterSelect.value = state.costsExpenseFilter;
    if (!state.costsExpenseFilter) {
      expenseFilterMode = null;
      expenseFilterUserId = null;
    } else {
      const [mode, id] = state.costsExpenseFilter.split(":");
      expenseFilterMode = mode;
      expenseFilterUserId = parseInt(id, 10);
    }
    renderExpenseList();
  }
  if (typeof state.costsLogFilter === "string" && expenseLogFilterSelect) {
    expenseLogFilterSelect.value = state.costsLogFilter;
    expenseLogFilterAction = state.costsLogFilter;
    renderExpenseLog();
  }
});

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  // So früh wie möglich, damit USER_COLORS/USER_AVATARS (nameTag()) beim
  // allerersten Render schon befüllt sind statt erst nach dem ersten Poll.
  fetchUsersAndMe();
  loadPlanList();
  setInterval(loadPlanList, 5000);
  pollCostsViews();
  setInterval(pollCostsViews, 3000);
  setInterval(checkAppVersion, 60000);
});
