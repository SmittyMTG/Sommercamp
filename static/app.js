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
function goToScreen(name) {
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
  // .app-shell ist jetzt der eigentliche Scroll-Container.
  // Camp-Plan startet ganz oben (nicht mehr beim heutigen Tag), damit das
  // eingeklappte "Vergangene Termine"-Panel direkt sichtbar ist.
  const shell = document.querySelector(".app-shell");
  if (shell) shell.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
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
  const nameHtml = color ? `<span class="name-tag" style="background:${color}">${safe}</span>` : safe;
  return `<span class="name-with-avatar">${avatarCircleHtml(username)}${nameHtml}</span>`;
}

/* ---------- Generic modal ---------- */
const modal = document.getElementById("modal");
const modalForm = document.getElementById("modalForm");
const modalTitle = document.getElementById("modalTitle");
const modalEyebrow = document.getElementById("modalEyebrow");
const modalBody = document.getElementById("modalBody");
const modalSubmit = document.getElementById("modalSubmit");

let modalSubmitHandler = null;

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
function requestCloseModal() {
  if (hasUnsavedModalChanges() && !confirm("Eingaben verwerfen? Was du eingegeben hast, geht sonst verloren.")) {
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
modal.addEventListener("cancel", (e) => {
  if (hasUnsavedModalChanges()) {
    e.preventDefault();
    if (confirm("Eingaben verwerfen? Was du eingegeben hast, geht sonst verloren.")) {
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

/* ---------- Aufgaben (geteilt, mehrere Personen zuweisbar, mit Deadline) ---------- */
const taskListEl = document.getElementById("taskList");
const taskSortSelect = document.getElementById("taskSortSelect");
const taskFilterRow = document.getElementById("taskFilterRow");

let lastTaskItems = [];
let taskSortMode = "deadline";
let taskFilterMode = "alle";

// Deadlines sind reine Datumsangaben (kein Uhrzeit-Anteil) — "heute fällig"
// gilt daher bewusst noch nicht als überfällig, erst ab dem Folgetag.
function isTaskOverdue(task) {
  if (task.done || !task.deadline) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(task.deadline) < today;
}

// Für den ❗-Schnellaktion-Button: zeigt "aktiv", solange die Deadline auf
// heute steht (egal ob bei Aufgaben — Datum+Zeit — oder Einkaufsliste — nur Datum).
function isDeadlineToday(iso) {
  if (!iso) return false;
  return new Date(iso).toDateString() === new Date().toDateString();
}

function formatDeadline(iso) {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
  });
}

// Eine Aufgabe ohne Zuweisung gilt für alle — zählt daher überall wie "meine".
function isTaskMine(task, meId) {
  return task.assignees.length === 0 || task.assignees.some((a) => a.id === meId);
}

function filterTasks(items, mode, meId) {
  if (mode === "meine") return items.filter((t) => isTaskMine(t, meId));
  if (mode === "offen") return items.filter((t) => !t.done);
  if (mode === "ueberfaellig") return items.filter((t) => isTaskOverdue(t));
  return items;
}

// Sortierschlüssel für "Verantwortlich": eigene Aufgaben zuerst (auch wenn man
// nur einer von mehreren Zuständigen ist), dann die übrigen alphabetisch nach
// den zuständigen Personen, nicht zugewiesene ("Für alle") ganz am Ende.
function taskResponsibleSortKey(task, meId) {
  if (task.assignees.length === 0) return [2, ""];
  if (task.assignees.some((a) => a.id === meId)) return [0, ""];
  return [1, task.assignees.map((a) => a.username.toLowerCase()).sort().join(", ")];
}

// Offene Aufgaben stehen immer vor erledigten; die gewählte Sortierung gilt
// jeweils nur innerhalb dieser beiden Gruppen.
function sortTasks(items, mode, meId) {
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
    } else if (mode === "verantwortlich") {
      out.sort((a, b) => {
        const ka = taskResponsibleSortKey(a, meId);
        const kb = taskResponsibleSortKey(b, meId);
        return ka[0] !== kb[0] ? ka[0] - kb[0] : ka[1].localeCompare(kb[1], "de");
      });
    } else if (mode === "kategorie") {
      out.sort((a, b) => {
        const an = a.category ? a.category.bezeichnung : "￿"; // ohne Kategorie ans Ende
        const bn = b.category ? b.category.bezeichnung : "￿";
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

function renderTaskItem(task) {
  const card = document.createElement("div");
  card.className = "list-card clickable" + (task.done ? " done" : "");
  card.dataset.id = task.id;

  const overdue = isTaskOverdue(task);
  const metaParts = [];
  if (task.deadline) {
    const label = `📅 ${formatDeadline(task.deadline)}`;
    metaParts.push(overdue ? `<span class="danger">⚠️ ${label}</span>` : label);
  }
  if (task.aufwand_min != null) metaParts.push(`⏱ ${task.aufwand_min} Min`);
  if (task.assignees.length) {
    const verb = task.assignees.length > 1 ? "sind verantwortlich" : "ist verantwortlich";
    metaParts.push(`${task.assignees.map((a) => nameTag(a.username)).join(", ")} ${verb}`);
  }

  const categoryTag = task.category
    ? `<span class="category-tag"><span class="category-tag-dot" style="background:${escapeHtml(task.category.farbe)}"></span>${escapeHtml(task.category.bezeichnung)}</span>`
    : "";

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

  const isUrgentToday = isDeadlineToday(task.deadline);

  card.innerHTML = `
    <div class="list-card-content">
      <button type="button" class="list-card-checkbox${task.done ? " checked" : ""}" aria-label="Erledigt"></button>
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(task.titel)}</p>
        ${categoryTag}
        ${metaParts.length ? `<p class="list-card-meta">${metaParts.join(" · ")}</p>` : ""}
        ${descHtml}
        ${subitemsHtml}
      </div>
    </div>
    <div class="list-card-actions">
      <button type="button" class="urgent-btn${isUrgentToday ? " active" : ""}" aria-label="Deadline auf heute setzen">❗</button>
      <button type="button" class="delete-btn" aria-label="Löschen">🗑️</button>
    </div>
  `;

  // Ganze Kachel öffnet Bearbeiten (macht den separaten Stift-Button überflüssig)
  // — alle anderen interaktiven Elemente in der Karte stoppen die Propagation,
  // damit ein Klick darauf nicht zusätzlich den Bearbeiten-Dialog öffnet.
  card.addEventListener("click", () => openEditTaskModal(task));

  card.querySelector(".urgent-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await fetch(`/api/tasks/${task.id}/deadline-today`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      task.deadline = data.deadline;
      loadTasks(true);
    }
  });

  const checkbox = card.querySelector(".list-card-checkbox");
  checkbox.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const res = await fetch(`/api/tasks/${task.id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      checkbox.classList.toggle("checked", data.done);
      card.classList.toggle("done", data.done);
      task.done = data.done;
      // Badge (rote Zahl am Aufgaben-Icon) hängt sonst am nächsten Poll-Takt
      // (bis zu 3s) statt sich sofort mit dem Klick zu aktualisieren.
      loadTasks(true);
    }
  });

  card.querySelectorAll(".subitem-row input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = await fetch(`/api/tasks/${task.id}/subitems/${cb.dataset.subId}/toggle`, { method: "PATCH" });
      if (res.ok) loadTasks(true);
    });
  });

  card.querySelector(".delete-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openModal({
      eyebrow: "Aufgabe",
      title: `„${task.titel}" löschen?`,
      bodyHtml: `<p class="muted warning-text">Die Aufgabe wird für alle entfernt. Das lässt sich nicht rückgängig machen.</p>`,
      submitLabel: "Löschen",
      danger: true,
      onSubmit: async () => {
        const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
        if (res.ok) loadTasks(true);
        closeModal();
      },
    });
  });

  return card;
}

async function renderFilteredSortedTasks() {
  if (!taskListEl) return;
  const { me } = await fetchUsersAndMe();
  const filtered = filterTasks(lastTaskItems, taskFilterMode, me ? me.id : null);
  const sorted = sortTasks(filtered, taskSortMode, me ? me.id : null);

  taskListEl.innerHTML = "";
  if (sorted.length === 0) {
    taskListEl.innerHTML = `<div class="empty-state"><p>Keine Aufgaben.</p></div>`;
  } else {
    sorted.forEach((t) => taskListEl.appendChild(renderTaskItem(t)));
  }

  updateMyTasksBadge(me);
}

// Rote Zahl am "Aufgaben"-Icon in der Bottom-Nav, solange mindestens eine
// offene Aufgabe explizit dir zugewiesen ist ("für alle"-Aufgaben ohne
// Zuweisung zählen bewusst nicht mit) — auf einen Blick ersichtlich, dass
// hier etwas für dich persönlich zu tun ist.
function updateMyTasksBadge(me) {
  const el = document.getElementById("myTasksNavBadge");
  if (!el) return;
  const count = me
    ? lastTaskItems.filter((t) => !t.done && t.assignees.some((a) => a.id === me.id)).length
    : 0;
  el.textContent = String(count);
  el.classList.toggle("hidden", count === 0);
}

let lastTaskSignature = null;

async function loadTasks(force) {
  if (!taskListEl) return;
  try {
    const res = await fetch("/api/tasks");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const items = await res.json();
    const signature = JSON.stringify(items);
    if (!force && signature === lastTaskSignature) return;
    lastTaskSignature = signature;
    lastTaskItems = items;
    renderFilteredSortedTasks();
  } catch (err) {
    taskListEl.innerHTML = `<div class="empty-state"><p>Aufgaben konnten nicht geladen werden.</p></div>`;
  }
}

if (taskSortSelect) {
  taskSortSelect.addEventListener("change", () => {
    taskSortMode = taskSortSelect.value;
    renderFilteredSortedTasks();
  });
}

if (taskFilterRow) {
  taskFilterRow.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      taskFilterRow.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      taskFilterMode = btn.dataset.filter;
      renderFilteredSortedTasks();
    });
  });
}

/* ---------- Aufgaben: Kategorien (z. B. "Einkauf", "Aufbau") ---------- */
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

function taskModalBodyHtml(users, categories, prefill = {}) {
  // Mehrere Personen können gemeinsam verantwortlich sein — keine Auswahl
  // bedeutet: die Aufgabe gilt für alle.
  const currentAssigneeIds = new Set((prefill.assignees || []).map((a) => a.id));
  const assigneeOptions = users
    .map(
      (u) =>
        `<label class="check-card"><input type="checkbox" class="assignee-checkbox" value="${u.id}"${currentAssigneeIds.has(u.id) ? " checked" : ""}>${nameTag(u.username)}</label>`
    )
    .join("");

  const currentCategoryId = prefill.category ? prefill.category.id : null;

  // date erwartet "YYYY-MM-DD", der Server liefert ein volles ISO-Format zurück.
  const deadlineValue = prefill.deadline ? prefill.deadline.slice(0, 10) : "";

  return `
    <div class="form-stack">
      <label>Titel
        <input type="text" id="taskTitelInput" maxlength="80" value="${escapeHtml(prefill.titel || "")}" required>
      </label>
      <label>Beschreibung (optional)
        <textarea id="taskBeschreibungInput" placeholder="Details …">${escapeHtml(prefill.beschreibung || "")}</textarea>
      </label>
      <div class="checkbox-group">
        <div class="eyebrow">Verantwortlich (leer = gilt für alle)</div>
        <div id="taskAssigneeOptions" class="checkbox-grid">${assigneeOptions}</div>
      </div>
      <label>Kategorie (optional)
        <select id="taskCategorySelect">
          <option value="">— keine Angabe —</option>
          ${taskCategoryOptionsHtml(categories, currentCategoryId)}
          <option value="__new__">+ Neue Kategorie anlegen…</option>
        </select>
      </label>
      <div id="newTaskCategoryFields" class="form-stack hidden">
        <label>Farbe
          <input type="color" id="newTaskCategoryColor" value="#ffd400">
        </label>
        <label>Bezeichnung
          <input type="text" id="newTaskCategoryLabel" maxlength="16">
        </label>
        <button type="button" id="createTaskCategoryBtn" class="secondary compact">Kategorie anlegen</button>
        <p class="error-text hidden new-task-category-error"></p>
      </div>
      <label>Deadline (optional)
        <input type="date" id="taskDeadlineInput" value="${deadlineValue}">
      </label>
      <label>Aufwand in Minuten (optional)
        <input type="number" id="taskAufwandInput" min="0" step="1" inputmode="numeric" value="${prefill.aufwand_min != null ? prefill.aufwand_min : ""}">
      </label>
      ${
        prefill.id
          ? `
        <div class="checkbox-group" data-live-save>
          <div class="eyebrow">Teilaufgaben</div>
          <div id="taskSubitemsList" class="stack"></div>
          <div class="action-row">
            <input type="text" id="newSubitemInput" placeholder="Neue Teilaufgabe…" maxlength="120">
            <button type="button" id="addSubitemBtn" class="secondary compact">+ Hinzufügen</button>
          </div>
        </div>
      `
          : ""
      }
    </div>
  `;
}

// Muss NACH openModal() aufgerufen werden — nur im Bearbeiten-Modus vorhanden
// (eine neue Aufgabe hat noch keine ID, der Server bräuchte die für die Subitems).
function renderTaskSubitemsEditor(taskId, subitems) {
  const container = document.getElementById("taskSubitemsList");
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
              <button type="button" class="icon-button subitem-delete" data-sub-id="${s.id}" aria-label="Löschen">🗑️</button>
            </div>
          `
        )
        .join("")
    : `<p class="muted">Noch keine Teilaufgaben.</p>`;

  container.querySelectorAll(".subitem-toggle").forEach((cb) => {
    cb.addEventListener("change", async () => {
      await fetch(`/api/tasks/${taskId}/subitems/${cb.dataset.subId}/toggle`, { method: "PATCH" });
      const sub = subitems.find((s) => s.id === parseInt(cb.dataset.subId, 10));
      if (sub) sub.done = cb.checked;
    });
  });
  container.querySelectorAll(".subitem-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`/api/tasks/${taskId}/subitems/${btn.dataset.subId}`, { method: "DELETE" });
      const idx = subitems.findIndex((s) => s.id === parseInt(btn.dataset.subId, 10));
      if (idx !== -1) subitems.splice(idx, 1);
      renderTaskSubitemsEditor(taskId, subitems);
    });
  });
}

function wireTaskSubitems(taskId, initialSubitems) {
  const subitems = (initialSubitems || []).slice();
  renderTaskSubitemsEditor(taskId, subitems);

  const addBtn = document.getElementById("addSubitemBtn");
  const input = document.getElementById("newSubitemInput");
  if (!addBtn || !input) return;
  addBtn.addEventListener("click", async () => {
    const titel = input.value.trim();
    if (!titel) return;
    const res = await fetch(`/api/tasks/${taskId}/subitems`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titel }),
    });
    if (res.ok) {
      const created = await res.json();
      subitems.push(created);
      input.value = "";
      renderTaskSubitemsEditor(taskId, subitems);
    }
  });
}

// Muss NACH openModal() aufgerufen werden (braucht die frisch eingefügten Felder im DOM).
function wireTaskCategoryPicker() {
  const categorySelect = document.getElementById("taskCategorySelect");
  const newFields = document.getElementById("newTaskCategoryFields");
  categorySelect.addEventListener("change", () => {
    newFields.classList.toggle("hidden", categorySelect.value !== "__new__");
  });

  document.getElementById("createTaskCategoryBtn").addEventListener("click", async () => {
    const colorInput = document.getElementById("newTaskCategoryColor");
    const labelInput = document.getElementById("newTaskCategoryLabel");
    const errEl = document.querySelector(".new-task-category-error");
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

// Falls im Kategorie-Dropdown noch "+ Neue Kategorie anlegen…" ausgewählt ist,
// wird sie hier direkt beim Speichern miterstellt — kein separater Klick auf
// "Kategorie anlegen" nötig. Gibt die category_id zurück, oder null bei Fehler
// (dann steht die Fehlermeldung im .new-task-category-error-Feld).
async function resolveTaskCategoryId() {
  const categorySelect = document.getElementById("taskCategorySelect");
  if (categorySelect.value !== "__new__") {
    return { ok: true, category_id: categorySelect.value ? parseInt(categorySelect.value, 10) : null };
  }

  const colorInput = document.getElementById("newTaskCategoryColor");
  const labelInput = document.getElementById("newTaskCategoryLabel");
  const errEl = document.querySelector(".new-task-category-error");
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

async function readTaskForm() {
  const titel = document.getElementById("taskTitelInput").value.trim();
  if (!titel) return null;
  const beschreibung = document.getElementById("taskBeschreibungInput").value.trim();
  const assignee_ids = Array.from(
    document.querySelectorAll("#taskAssigneeOptions .assignee-checkbox:checked")
  ).map((el) => parseInt(el.value, 10));
  const deadline = document.getElementById("taskDeadlineInput").value || null;
  const aufwandRaw = document.getElementById("taskAufwandInput").value;
  const aufwand_min = aufwandRaw !== "" ? parseInt(aufwandRaw, 10) : null;

  const categoryResult = await resolveTaskCategoryId();
  if (!categoryResult.ok) return null;

  return {
    titel,
    beschreibung,
    assignee_ids,
    category_id: categoryResult.category_id,
    deadline,
    aufwand_min,
  };
}

async function openAddTaskModal() {
  const { users } = await fetchUsersAndMe();
  const categories = await fetchTaskCategories();

  openModal({
    eyebrow: "Aufgabe",
    title: "Aufgabe hinzufügen",
    submitLabel: "Speichern",
    bodyHtml: taskModalBodyHtml(users, categories),
    onSubmit: async () => {
      const form = await readTaskForm();
      if (!form) return;

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        closeModal();
        loadTasks(true);
      }
    },
  });

  wireTaskCategoryPicker();
}

async function openEditTaskModal(task) {
  const { users } = await fetchUsersAndMe();
  const categories = await fetchTaskCategories();

  openModal({
    eyebrow: "Aufgabe",
    title: "Aufgabe bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: taskModalBodyHtml(users, categories, task),
    onSubmit: async () => {
      const form = await readTaskForm();
      if (!form) return;

      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        closeModal();
        loadTasks(true);
      }
    },
  });

  wireTaskCategoryPicker();
  wireTaskSubitems(task.id, task.subitems);
}

const addTaskButton = document.getElementById("addTaskButton");
if (addTaskButton) addTaskButton.addEventListener("click", openAddTaskModal);

/* ---------- "Tasks" (privat/projekt-getaggt, aktuell nur für Felix sichtbar
   über die Nav — Zugriff wird zusätzlich serverseitig geprüft, siehe main.py) ---------- */
const privateTaskListEl = document.getElementById("privateTaskList");
const privateTaskSortSelect = document.getElementById("privateTaskSortSelect");
const privateTaskFilterRow = document.getElementById("privateTaskFilterRow");
const privateTaskProjectFilterSelect = document.getElementById("privateTaskProjectFilterSelect");

let lastPrivateTaskItems = [];
let privateTaskSortMode = "deadline";
let privateTaskFilterMode = "alle";
let privateTaskProjectFilterId = "";
let cachedProjects = null;

function isPrivateTaskOverdue(task) {
  if (task.done || !task.deadline) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(task.deadline) < today;
}

function filterPrivateTasks(items, mode, projectId) {
  let out = items;
  if (mode === "offen") out = out.filter((t) => !t.done);
  else if (mode === "ueberfaellig") out = out.filter((t) => isPrivateTaskOverdue(t));
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
  if (task.aufwand_min != null) metaParts.push(`⏱ ${task.aufwand_min} Min`);

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

  const isUrgentToday = isDeadlineToday(task.deadline);

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
      <button type="button" class="urgent-btn${isUrgentToday ? " active" : ""}" aria-label="Deadline auf heute setzen">❗</button>
      <button type="button" class="delete-btn" aria-label="Löschen">🗑️</button>
    </div>
  `;

  card.addEventListener("click", () => openEditPrivateTaskModal(task));

  card.querySelector(".urgent-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await fetch(`/api/private-tasks/${task.id}/deadline-today`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      task.deadline = data.deadline;
      loadPrivateTasks(true);
    }
  });

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
  const filtered = filterPrivateTasks(lastPrivateTaskItems, privateTaskFilterMode, privateTaskProjectFilterId);
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

if (privateTaskFilterRow) {
  privateTaskFilterRow.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      privateTaskFilterRow.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      privateTaskFilterMode = btn.dataset.filter;
      renderFilteredSortedPrivateTasks();
    });
  });
}

if (privateTaskSortSelect) {
  privateTaskSortSelect.addEventListener("change", () => {
    privateTaskSortMode = privateTaskSortSelect.value;
    renderFilteredSortedPrivateTasks();
  });
}

if (privateTaskProjectFilterSelect) {
  privateTaskProjectFilterSelect.addEventListener("change", () => {
    privateTaskProjectFilterId = privateTaskProjectFilterSelect.value;
    renderFilteredSortedPrivateTasks();
  });
}

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

function populateProjectFilterSelect(projects) {
  if (!privateTaskProjectFilterSelect) return;
  const current = privateTaskProjectFilterSelect.value;
  privateTaskProjectFilterSelect.innerHTML = `
    <option value="">Alle Projekte</option>
    <option value="privat">Privat</option>
    ${privateTaskProjectOptionsHtml(projects, "")}
  `;
  privateTaskProjectFilterSelect.value = current;
}

function privateTaskModalBodyHtml(categories, projects, isAdmin, prefill = {}) {
  const currentCategoryId = prefill.category ? prefill.category.id : null;
  const currentProjectId = prefill.project ? prefill.project.id : "";
  const deadlineValue = prefill.deadline ? prefill.deadline.slice(0, 10) : "";

  return `
    <div class="form-stack">
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
      <label>Deadline (optional)
        <input type="date" id="privTaskDeadlineInput" value="${deadlineValue}">
      </label>
      <label>Aufwand in Minuten (optional)
        <input type="number" id="privTaskAufwandInput" min="0" step="1" inputmode="numeric" value="${prefill.aufwand_min != null ? prefill.aufwand_min : ""}">
      </label>
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
      populateProjectFilterSelect(projects);
      projectSelect.innerHTML = `
        <option value="">Privat</option>
        ${privateTaskProjectOptionsHtml(projects, created.id)}
        <option value="__new__">+ Neues Projekt anlegen…</option>
      `;
      newFields.classList.add("hidden");
      renderProjectAdminPanel();
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
  const aufwandRaw = document.getElementById("privTaskAufwandInput").value;
  const aufwand_min = aufwandRaw !== "" ? parseInt(aufwandRaw, 10) : null;

  const categoryResult = await resolvePrivateTaskCategoryId();
  if (!categoryResult.ok) return null;

  const projectResult = await resolvePrivateTaskProjectId();
  if (!projectResult.ok) return null;

  return {
    titel,
    beschreibung,
    category_id: categoryResult.category_id,
    project_id: projectResult.project_id,
    deadline,
    aufwand_min,
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
              <button type="button" class="icon-button subitem-delete" data-sub-id="${s.id}" aria-label="Löschen">🗑️</button>
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
  const { me } = await fetchUsersAndMe();
  const categories = await fetchTaskCategories();
  const projects = await fetchProjects();
  const isAdmin = !!(me && isAdminRole(me.role));

  openModal({
    eyebrow: "Task",
    title: "Task hinzufügen",
    submitLabel: "Speichern",
    bodyHtml: privateTaskModalBodyHtml(categories, projects, isAdmin),
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

  wirePrivateTaskCategoryPicker();
  if (isAdmin) wirePrivateTaskProjectPicker();
}

async function openEditPrivateTaskModal(task) {
  const { me } = await fetchUsersAndMe();
  const categories = await fetchTaskCategories();
  const projects = await fetchProjects();
  const isAdmin = !!(me && isAdminRole(me.role));

  openModal({
    eyebrow: "Task",
    title: "Task bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: privateTaskModalBodyHtml(categories, projects, isAdmin, task),
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

  wirePrivateTaskCategoryPicker();
  if (isAdmin) wirePrivateTaskProjectPicker();
  wirePrivateTaskSubitems(task.id, task.subitems);
}

const addPrivateTaskButton = document.getElementById("addPrivateTaskButton");
if (addPrivateTaskButton) addPrivateTaskButton.addEventListener("click", openAddPrivateTaskModal);

/* ---------- Tasks: Projekte verwalten (nur Admins) ---------- */

const projectAdminPanelEl = document.getElementById("projectAdminPanel");
const projectAdminListEl = document.getElementById("projectAdminList");

function projectEditModalBodyHtml(users, project) {
  const currentMemberIds = new Set((project.members || []).map((m) => m.id));
  const memberOptions = users
    .map(
      (u) =>
        `<label class="check-card"><input type="checkbox" class="project-member-checkbox" value="${u.id}"${currentMemberIds.has(u.id) ? " checked" : ""}>${nameTag(u.username)}</label>`
    )
    .join("");

  return `
    <div class="form-stack">
      <label>Projektname
        <input type="text" id="projectNameInput" maxlength="60" value="${escapeHtml(project.name)}" required>
      </label>
      <div class="checkbox-group">
        <div class="eyebrow">Zugriff (welche User sehen dieses Projekt?)</div>
        <div class="checkbox-grid">${memberOptions}</div>
      </div>
    </div>
  `;
}

async function openEditProjectModal(project) {
  const { users } = await fetchUsersAndMe();

  openModal({
    eyebrow: "Projekt",
    title: `„${project.name}" bearbeiten`,
    submitLabel: "Speichern",
    bodyHtml: projectEditModalBodyHtml(users, project),
    onSubmit: async () => {
      const name = document.getElementById("projectNameInput").value.trim();
      if (!name) return;
      const member_ids = Array.from(document.querySelectorAll(".project-member-checkbox:checked")).map((el) =>
        parseInt(el.value, 10)
      );

      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, member_ids }),
      });

      if (res.ok) {
        closeModal();
        const projects = await fetchProjects(true);
        populateProjectFilterSelect(projects);
        renderProjectAdminPanel();
      }
    },
  });
}

function renderProjectCard(project) {
  const card = document.createElement("div");
  card.className = "list-card clickable";
  const members = project.members || [];
  const memberLabel = members.length ? members.map((m) => nameTag(m.username)).join(", ") : "Niemand freigeschaltet";
  card.innerHTML = `
    <div class="list-card-content">
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(project.name)}</p>
        <p class="list-card-meta">${memberLabel}</p>
      </div>
    </div>
  `;
  card.addEventListener("click", () => openEditProjectModal(project));
  return card;
}

async function renderProjectAdminPanel() {
  if (!projectAdminListEl) return;
  const projects = await fetchProjects(true);
  projectAdminListEl.innerHTML = "";
  if (projects.length === 0) {
    projectAdminListEl.innerHTML = `<div class="empty-state"><p>Noch keine Projekte.</p></div>`;
  } else {
    projects.forEach((p) => projectAdminListEl.appendChild(renderProjectCard(p)));
  }
}

async function openAddProjectModal() {
  openModal({
    eyebrow: "Projekt",
    title: "Projekt anlegen",
    submitLabel: "Anlegen",
    bodyHtml: `
      <div class="form-stack">
        <label>Projektname
          <input type="text" id="newProjectNameInput" maxlength="60" required>
        </label>
      </div>
    `,
    onSubmit: async () => {
      const name = document.getElementById("newProjectNameInput").value.trim();
      if (!name) return;
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        closeModal();
        const projects = await fetchProjects(true);
        populateProjectFilterSelect(projects);
        renderProjectAdminPanel();
      }
    },
  });
}

const addProjectButton = document.getElementById("addProjectButton");
if (addProjectButton) addProjectButton.addEventListener("click", openAddProjectModal);

/* ---------- Bottom-Nav: erstmal nur für Admins sichtbar (normale User sehen
   ausschließlich die Kosten-Seite, ohne jede Navigation) ---------- */
fetchUsersAndMe().then(({ me }) => {
  const bottomNavEl = document.getElementById("bottomNav");
  if (bottomNavEl && me && isAdminRole(me.role)) {
    bottomNavEl.classList.remove("hidden");
  }
});

/* ---------- Tasks: Sichtbarkeit (nur Felix) + Init ---------- */
fetchUsersAndMe().then(({ me }) => {
  if (!me || me.username !== "Felix") return;

  const tasksNavButton = document.querySelector('.bottom-nav [data-screen="tasks"]');
  const bottomNavEl = document.getElementById("bottomNav");
  if (tasksNavButton) tasksNavButton.classList.remove("hidden");
  if (bottomNavEl) bottomNavEl.classList.add("nav-4");

  fetchProjects(true).then((projects) => populateProjectFilterSelect(projects));
  loadPrivateTasks(true);
  setInterval(loadPrivateTasks, 5000);

  if (isAdminRole(me.role) && projectAdminPanelEl) {
    projectAdminPanelEl.classList.remove("hidden");
    renderProjectAdminPanel();
  }
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
        <div class="list-card">
          <div class="list-card-content">
            ${avatarCircleHtml(u.username, 32)}
            <div class="list-card-text">
              <p class="list-card-title">${escapeHtml(u.username)}</p>
              <p class="list-card-meta">${escapeHtml(u.role || "user")}</p>
            </div>
          </div>
          <div class="list-card-actions">
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

/* ---------- Camp-Plan (Termine, nur Admins legen an) ---------- */
const planListEl = document.getElementById("planList");
const addPlanButton = document.getElementById("addPlanButton");

function formatWeekdayDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  const formatted = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" });
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
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

function groupPlanEvents(events) {
  const groups = new Map();
  for (const e of events) {
    if (!groups.has(e.datum)) groups.set(e.datum, []);
    groups.get(e.datum).push(e);
  }
  return Array.from(groups.entries()).map(([datum, items]) => ({ datum, items }));
}

function renderPlanEvent(event, isAdmin) {
  const card = document.createElement("div");
  card.className = "plan-card";

  const detailsParts = [];
  if (event.location) {
    detailsParts.push(
      `📍 <a href="${mapsUrl(event.location)}" target="_blank" rel="noopener">${escapeHtml(event.location)}</a>`
    );
  }
  if (event.beschreibung) {
    detailsParts.push(escapeHtml(event.beschreibung));
  }

  card.innerHTML = `
    <div class="time">${escapeHtml(event.uhrzeit)}</div>
    <div>
      <div class="title">${escapeHtml(event.bezeichnung)}</div>
      ${detailsParts.length ? `<div class="details">${detailsParts.join("<br>")}</div>` : ""}
    </div>
    ${
      isAdmin
        ? `<div class="list-card-actions">
             <button type="button" class="icon-button delete-plan-btn" aria-label="Löschen">🗑️</button>
           </div>`
        : "<div></div>"
    }
  `;

  if (isAdmin) {
    // Ganze Kachel öffnet Bearbeiten (macht den separaten Stift-Button
    // überflüssig) — Löschen-Button und der Maps-Link stoppen die Propagation,
    // damit ein Klick darauf nicht zusätzlich den Bearbeiten-Dialog öffnet.
    card.classList.add("clickable");
    card.addEventListener("click", () => openEditPlanModal(event));

    const locationLink = card.querySelector(".details a");
    if (locationLink) locationLink.addEventListener("click", (e) => e.stopPropagation());

    card.querySelector(".delete-plan-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openModal({
        eyebrow: "Kalender",
        title: `„${event.bezeichnung}" löschen?`,
        bodyHtml: `<p class="muted warning-text">Der Termin wird für alle aus dem Plan entfernt. Das lässt sich nicht rückgängig machen.</p>`,
        submitLabel: "Löschen",
        danger: true,
        onSubmit: async () => {
          const res = await fetch(`/api/plan/${event.id}`, { method: "DELETE" });
          if (res.ok) {
            loadPlanList(true);
          }
          closeModal();
        },
      });
    });
  }

  return card;
}

let lastPlanSignature = null;

// Vergangene Tage sind standardmäßig eingeklappt (siehe loadPlanList) — das
// planListEl wird bei jedem Poll neu aufgebaut, daher hier gemerkt, ob
// zuletzt aufgeklappt wurde, damit der Zustand über Re-Renders hinweg
// erhalten bleibt (ein neuer Render erfolgt eh nur bei echten Datenänderungen,
// siehe lastPlanSignature-Check).
let planPastExpanded = false;

/* ---------- Camp-Plan: "noch offene" (datumslose) Events schnell auf heute legen ---------- */
const planOpenPanelEl = document.getElementById("planOpenPanel");
const planOpenListEl = document.getElementById("planOpenList");
const planOpenToggleBtn = document.getElementById("planOpenToggle");

if (planOpenToggleBtn) {
  planOpenToggleBtn.addEventListener("click", () => {
    planOpenPanelEl.classList.toggle("collapsed");
  });
}

function renderOpenPlanEvent(event) {
  const card = document.createElement("div");
  card.className = "plan-card";

  const detailsParts = [];
  if (event.location) detailsParts.push(`📍 ${escapeHtml(event.location)}`);
  if (event.beschreibung) detailsParts.push(escapeHtml(event.beschreibung));

  // Kein Datum -> auch keine Uhrzeit (siehe _validate_plan_payload) — daher
  // hier keine Zeit-Spalte wie bei den fest eingeplanten Terminen.
  card.innerHTML = `
    <div>
      <div class="title">${escapeHtml(event.bezeichnung)}</div>
      ${detailsParts.length ? `<div class="details">${detailsParts.join(" · ")}</div>` : ""}
    </div>
    <div></div>
  `;

  // Panel wird ohnehin nur Admins angezeigt (siehe loadPlanList) — ganze
  // Kachel öffnet Bearbeiten, macht den separaten 📅-Button überflüssig.
  card.classList.add("clickable");
  card.addEventListener("click", () => openEditPlanModal(event));

  return card;
}

async function loadPlanList(force) {
  if (!planListEl) return;
  try {
    const res = await fetch("/api/plan");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const events = await res.json();
    const signature = JSON.stringify(events);
    if (!force && signature === lastPlanSignature) return;
    lastPlanSignature = signature;

    const { me } = await fetchUsersAndMe();
    const isAdmin = !!me && isAdminRole(me.role);

    // Termine ohne Datum ("noch offen") gehören nur ins Panel oben, nicht in
    // die nach Tag gruppierte Liste — sonst würden sie doppelt erscheinen.
    const openEvents = events
      .filter((e) => !e.datum)
      .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung));
    const datedEvents = events.filter((e) => e.datum);

    if (planOpenPanelEl && planOpenListEl) {
      if (isAdmin && openEvents.length > 0) {
        planOpenListEl.innerHTML = "";
        openEvents.forEach((event) => planOpenListEl.appendChild(renderOpenPlanEvent(event)));
        planOpenPanelEl.classList.remove("hidden");
      } else {
        planOpenPanelEl.classList.add("hidden");
      }
    }

    planListEl.innerHTML = "";
    if (datedEvents.length === 0) {
      planListEl.innerHTML = `<div class="empty-state"><p>Hier entsteht der Camp-Plan.</p></div>`;
    } else {
      const today = todayIsoDate();

      function buildDateBlock(group) {
        const block = document.createElement("div");
        block.className = "date-block";
        const isToday = group.datum === today;
        // Vergangene Tage optisch zurücknehmen, damit auf einen Blick klar ist,
        // was schon passiert ist — "Heute" bekommt zusätzlich ein eigenes Badge
        // als klaren Anker zwischen Vergangenheit und Zukunft.
        if (group.datum < today) block.classList.add("past");
        block.innerHTML = `<h3>${formatWeekdayDate(group.datum)}${isToday ? ' <span class="today-badge">Heute</span>' : ""}</h3>`;
        const stack = document.createElement("div");
        stack.className = "stack";
        group.items.forEach((event) => stack.appendChild(renderPlanEvent(event, isAdmin)));
        block.appendChild(stack);
        return block;
      }

      const groups = groupPlanEvents(datedEvents);
      const pastGroups = groups.filter((g) => g.datum < today);
      const upcomingGroups = groups.filter((g) => g.datum >= today);

      // Vergangene Termine sind schon passiert und interessieren im Alltag
      // kaum noch — sie werden daher gesammelt hinter einem eingeklappten
      // Panel versteckt statt die Liste nach oben hin vollzustopfen, und
      // lassen sich bei Bedarf per Klick aufklappen.
      if (pastGroups.length > 0) {
        const panel = document.createElement("div");
        panel.className = "plan-past-panel";
        if (!planPastExpanded) panel.classList.add("collapsed");

        const count = pastGroups.reduce((n, g) => n + g.items.length, 0);
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "plan-open-toggle";
        toggle.innerHTML = `<span>Vergangene Termine (${count})</span><span class="chevron">▾</span>`;
        toggle.addEventListener("click", () => {
          planPastExpanded = !planPastExpanded;
          panel.classList.toggle("collapsed", !planPastExpanded);
        });
        panel.appendChild(toggle);

        const content = document.createElement("div");
        content.className = "plan-past-content";
        pastGroups.forEach((group) => content.appendChild(buildDateBlock(group)));
        panel.appendChild(content);

        planListEl.appendChild(panel);
      }

      upcomingGroups.forEach((group) => planListEl.appendChild(buildDateBlock(group)));
    }
  } catch (err) {
    planListEl.innerHTML = `<div class="empty-state"><p>Plan konnte nicht geladen werden.</p></div>`;
  }
}

function planModalBodyHtml(prefill = {}) {
  // Uhrzeit ohne Datum ergibt keinen Sinn ("noch offen" hat bewusst keine Zeit)
  // — daher nur vorbefüllen, wenn auch ein Datum feststeht. wirePlanForm()
  // hält das beim Ändern des Datums danach synchron.
  const uhrzeitDefault = prefill.uhrzeit || (prefill.datum ? "12:00" : "");
  return `
    <div class="form-stack">
      <label>Datum <span class="muted">(leer lassen = noch offen)</span>
        <input type="date" id="planDatumInput" value="${prefill.datum || ""}">
      </label>
      <label>Uhrzeit
        <input type="time" id="planUhrzeitInput" value="${uhrzeitDefault}">
      </label>
      <label>Bezeichnung
        <input type="text" id="planBezeichnungInput" maxlength="60" value="${escapeHtml(prefill.bezeichnung || "")}" required>
      </label>
      <label>Location (Adresse)
        <input type="text" id="planLocationInput" maxlength="120" value="${escapeHtml(prefill.location || "")}">
      </label>
      <label>Beschreibung
        <textarea id="planBeschreibungInput" placeholder="Was ist geplant?">${escapeHtml(prefill.beschreibung || "")}</textarea>
      </label>
      <p class="error-text hidden plan-modal-error"></p>
    </div>
  `;
}

// Muss NACH openModal() aufgerufen werden (braucht die frisch eingefügten
// Felder im DOM) — hält Uhrzeit mit Datum synchron: ohne Datum ergibt eine
// Uhrzeit keinen Sinn ("noch offen"), daher wird sie beim Leeren des Datums
// automatisch mit geleert und beim erstmaligen Setzen eines Datums mit 12:00
// vorbefüllt.
function wirePlanForm() {
  const datumInput = document.getElementById("planDatumInput");
  const uhrzeitInput = document.getElementById("planUhrzeitInput");
  if (!datumInput || !uhrzeitInput) return;
  datumInput.addEventListener("input", () => {
    if (!datumInput.value) {
      uhrzeitInput.value = "";
    } else if (!uhrzeitInput.value) {
      uhrzeitInput.value = "12:00";
    }
  });
}

async function submitPlanForm(url, method) {
  const datum = document.getElementById("planDatumInput").value;
  const uhrzeit = document.getElementById("planUhrzeitInput").value;
  const bezeichnung = document.getElementById("planBezeichnungInput").value.trim();
  const location = document.getElementById("planLocationInput").value.trim();
  const beschreibung = document.getElementById("planBeschreibungInput").value.trim();

  if (!bezeichnung) return;
  if (datum && !uhrzeit) return;

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datum: datum || null, uhrzeit: uhrzeit || null, bezeichnung, location, beschreibung }),
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

function openAddPlanModal() {
  openModal({
    eyebrow: "Kalender",
    title: "Termin hinzufügen",
    bodyHtml: planModalBodyHtml(),
    onSubmit: () => submitPlanForm("/api/plan", "POST"),
  });
  wirePlanForm();
}

function openEditPlanModal(event) {
  openModal({
    eyebrow: "Kalender",
    title: "Termin bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: planModalBodyHtml(event),
    onSubmit: () => submitPlanForm(`/api/plan/${event.id}`, "PATCH"),
  });
  wirePlanForm();
}

if (addPlanButton) {
  addPlanButton.addEventListener("click", openAddPlanModal);
  // Button ist standardmäßig ausgeblendet (siehe index.html), damit er für
  // Nicht-Admins nie kurz aufblitzt, bis die Rolle bekannt ist.
  fetchUsersAndMe().then(({ me }) => {
    if (me && isAdminRole(me.role)) addPlanButton.classList.remove("hidden");
  });
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
  const payer = payerNames.map((n) => escapeHtml(n)).join(", ");
  const breakdown = group.entries
    .map((e) => {
      const label = e.selbst ? `${escapeHtml(e.schuldner)} (eigen)` : escapeHtml(e.schuldner);
      return `${label}: ${formatEuro(e.cash)}`;
    })
    .join(" · ");

  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${escapeHtml(group.betreff)}</p>
      <p class="list-card-meta">${formatDate(group.datum)} · bezahlt von ${payer} · ${formatEuro(group.total)} gesamt</p>
      <p class="list-card-meta">${breakdown}</p>
    </div>
    ${
      canManage
        ? `<div class="list-card-actions">
             <button type="button" class="delete-btn" aria-label="Löschen">🗑️</button>
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
    renderExpenseList();
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

  expenseListEl.innerHTML = "";
  if (groups.length === 0) {
    expenseListEl.innerHTML = `<div class="empty"><p>${
      lastExpenses.length === 0 ? "Noch keine Einträge." : "Keine Ausgaben für diese Auswahl."
    }</p></div>`;
  } else {
    groups.forEach((g) => expenseListEl.appendChild(renderExpenseGroup(g, lastExpensesIsAdmin, lastExpensesMeUsername)));
  }

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
    <div class="eyebrow">${title}</div>
    <div class="countdown">${formatEuro(total)}</div>
  `;
}

function expenseModalBodyHtml(users, me, prefill = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const payerId = prefill.glaubigerId != null ? prefill.glaubigerId : me.id;
  const beneficiaryIds = prefill.beneficiaryIds || null;

  const payerOptions = users
    .map((u) => `<option value="${u.id}"${u.id === payerId ? " selected" : ""}>${escapeHtml(u.username)}</option>`)
    .join("");

  // Chip statt Checkbox+Text: die ganze Kachel ist der Button, blass in der
  // Nutzerfarbe solange nicht ausgewählt, volle Farbe sobald ausgewählt —
  // dadurch auch kompakter, es passen mehr Personen pro Zeile.
  const beneficiaryOptions = users
    .map((u) => {
      const checked = beneficiaryIds ? beneficiaryIds.has(u.id) : true;
      const color = USER_COLORS[u.username] || "#ffd400";
      const pale = hexToRgba(color, 0.16);
      return `<label class="beneficiary-chip${checked ? " checked" : ""}" style="--chip-color:${color};--chip-pale:${pale}"><input type="checkbox" class="beneficiary-checkbox" value="${u.id}"${checked ? " checked" : ""}><span>${escapeHtml(u.username)}</span></label>`;
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
      <label>Bezahlt von
        <select id="expensePayerSelect">${payerOptions}</select>
      </label>
      <div class="checkbox-group">
        <div class="eyebrow">Für wen?</div>
        <div id="expenseBeneficiaries" class="chip-row">${beneficiaryOptions}</div>
      </div>
      <div class="checkbox-group">
        <button type="button" id="expenseFixedAmountsToggle" class="plan-open-toggle">
          <span>Individuelle Beträge (optional)</span>
          <span class="chevron">▾</span>
        </button>
        <div id="expenseFixedAmountsPanel" class="stack hidden">
          <div id="expenseFixedAmounts" class="stack"></div>
          <p id="expenseSplitHint" class="muted"></p>
        </div>
      </div>
      <label>Datum
        <input type="date" id="expenseDatumInput" value="${prefill.datum || today}" required>
      </label>
    </div>
  `;
}

// Baut pro aktuell ausgewählter Person eine Zeile mit optionalem Festbetrag.
// Wer keinen Wert einträgt, teilt sich später den Rest gleichmäßig auf (siehe
// updateExpenseSplitHint). Bereits eingetragene Werte bleiben beim Umschalten
// der Checkboxen erhalten, solange die Person weiterhin ausgewählt ist.
function renderExpenseFixedAmountInputs(users, entryAmounts) {
  const container = document.getElementById("expenseFixedAmounts");
  if (!container) return;

  const checkedIds = Array.from(
    document.querySelectorAll("#expenseBeneficiaries .beneficiary-checkbox:checked")
  ).map((el) => parseInt(el.value, 10));

  const existingValues = {};
  container.querySelectorAll(".expense-fixed-input").forEach((el) => {
    if (el.value) existingValues[parseInt(el.dataset.uid, 10)] = el.value;
  });

  const byId = new Map(users.map((u) => [u.id, u]));
  container.innerHTML = checkedIds
    .map((uid) => {
      const u = byId.get(uid);
      if (!u) return "";
      const prefillValue =
        existingValues[uid] ?? (entryAmounts[uid] != null ? entryAmounts[uid].toFixed(2) : "");
      return `
        <div class="fixed-amount-row">
          <span>${nameTag(u.username)}</span>
          <input type="number" step="0.01" min="0.01" inputmode="decimal" class="expense-fixed-input" data-uid="${uid}" placeholder="auto" value="${prefillValue}">
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".expense-fixed-input").forEach((el) => {
    el.addEventListener("input", updateExpenseSplitHint);
  });

  updateExpenseSplitHint();
}

function updateExpenseSplitHint() {
  const hintEl = document.getElementById("expenseSplitHint");
  if (!hintEl) return;

  const fixedInputs = Array.from(document.querySelectorAll(".expense-fixed-input"));
  hintEl.classList.remove("error-text");

  if (fixedInputs.length === 0) {
    hintEl.textContent = "";
    return;
  }

  const cash = parseFloat(document.getElementById("expenseCashInput").value) || 0;
  const fixedTotal = fixedInputs.reduce((sum, el) => sum + (parseFloat(el.value) || 0), 0);
  const openCount = fixedInputs.filter((el) => !el.value).length;
  const remaining = Math.round((cash - fixedTotal) * 100) / 100;

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
// .beneficiary-chip zeigt die volle/blasse Farbe primär über :has(:checked)
// (siehe style.css) — die .checked-Klasse ist nur ein Fallback für Browser
// ohne :has()-Unterstützung, deshalb hier nach jeder Änderung mitgezogen.
function syncBeneficiaryChipClasses() {
  document.querySelectorAll("#expenseBeneficiaries .beneficiary-chip").forEach((chip) => {
    const cb = chip.querySelector(".beneficiary-checkbox");
    chip.classList.toggle("checked", !!cb && cb.checked);
  });
}

function wireExpenseForm(users, me, entryAmounts) {
  renderExpenseFixedAmountInputs(users, entryAmounts);

  const checkboxes = () => document.querySelectorAll("#expenseBeneficiaries .beneficiary-checkbox");
  checkboxes().forEach((cb) => {
    cb.addEventListener("change", () => {
      syncBeneficiaryChipClasses();
      renderExpenseFixedAmountInputs(users, entryAmounts);
    });
  });

  document.getElementById("expenseCashInput").addEventListener("input", updateExpenseSplitHint);

  // Aufklappbare "Individuelle Beträge" — standardmäßig eingeklappt, damit
  // das Formular kompakt bleibt; beim Bearbeiten einer Ausgabe mit bereits
  // fest eingetragenen Beträgen automatisch offen, statt den bestehenden
  // Zustand zu verstecken.
  const fixedToggle = document.getElementById("expenseFixedAmountsToggle");
  const fixedPanel = document.getElementById("expenseFixedAmountsPanel");
  if (fixedToggle && fixedPanel) {
    fixedToggle.addEventListener("click", () => {
      fixedPanel.classList.toggle("hidden");
      fixedToggle.classList.toggle("collapsed", fixedPanel.classList.contains("hidden"));
    });
    if (Object.keys(entryAmounts || {}).length > 0) {
      fixedPanel.classList.remove("hidden");
    } else {
      fixedToggle.classList.add("collapsed");
    }
  }
}

function readExpenseForm() {
  const glaubiger_id = parseInt(document.getElementById("expensePayerSelect").value, 10);
  const schuldner_ids = Array.from(
    document.querySelectorAll("#expenseBeneficiaries .beneficiary-checkbox:checked")
  ).map((el) => parseInt(el.value, 10));
  const cash = parseFloat(document.getElementById("expenseCashInput").value);
  const betreff = document.getElementById("expenseBetreffInput").value.trim();
  const datum = document.getElementById("expenseDatumInput").value;

  const fixed_amounts = {};
  document.querySelectorAll(".expense-fixed-input").forEach((el) => {
    const val = parseFloat(el.value);
    if (el.value && val > 0) fixed_amounts[el.dataset.uid] = val;
  });

  if (!betreff || !cash || cash <= 0 || schuldner_ids.length === 0) return null;
  return { glaubiger_id, schuldner_ids, cash, betreff, datum, fixed_amounts };
}

// Idiotensicherung gegen versehentliches Doppelt-Erfassen: gleicher Zahler +
// (fast) gleicher Gesamtbetrag wie eine bereits bestehende Ausgabe.
function findPossibleDuplicateExpense(form) {
  return groupExpenses(lastExpenses).find(
    (g) => g.glaubigerId === form.glaubiger_id && Math.abs(g.total - form.cash) < 0.01
  );
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

      const duplicate = findPossibleDuplicateExpense(form);
      if (duplicate) {
        const payerName = Array.from(duplicate.glaeubiger)[0] || "?";
        const proceed = confirm(
          `⚠️ ${payerName} hat schon eine Ausgabe über ${formatEuro(duplicate.total)} erfasst ("${duplicate.betreff}", ${formatDate(duplicate.datum)}). Meintest du diese Zahlung? Trotzdem als neue, separate Ausgabe speichern?`
        );
        if (!proceed) return;
      }

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

  wireExpenseForm(users, me, {});
}

async function openEditExpenseModal(group) {
  const { users, me } = await fetchUsersAndMe();
  if (!me || users.length === 0) return;

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

  // Nur vormals fest eingetragene Beträge vorausfüllen, damit ein unveränderter
  // Save die individuelle Aufteilung nicht stillschweigend verwirft. Personen, die
  // vorher "auto" waren (Rest gleichmäßig verteilt), bleiben leer, damit sie beim
  // Speichern automatisch neu aufgeteilt werden (z. B. wenn sich Betrag oder
  // Beteiligte geändert haben).
  const entryAmounts = {};
  group.entries.forEach((e) => {
    if (e.fixed) entryAmounts[e.schuldner_id] = e.cash;
  });
  wireExpenseForm(users, me, entryAmounts);
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

function switchCostsView(view) {
  Object.entries(costsViews).forEach(([key, el]) => {
    if (el) el.classList.toggle("hidden", key !== view);
  });
  if (view === "open") loadOpenSettlements();
  if (view === "received") loadReceivedPayments();
  if (view === "log") loadExpenseLog();
}

if (costsViewRow) {
  costsViewRow.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      costsViewRow.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
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
  // das zweizeilige Label (Name + Betrag) plus Profilbild darunter braucht
  // aber ~44px Platz. Bei sehr kleinen, benachbarten Beträgen reicht der
  // Knotenabstand allein nicht aus und die Labels würden sich überlappen —
  // daher hier, analog zum MIN_LABEL_GAP der Bänder-Labels weiter unten, ein
  // Mindestabstand zwischen den Label-MITTELPUNKTEN erzwungen (die farbigen
  // Balken selbst bleiben unverändert, nur die Textposition wird bei Bedarf
  // verschoben).
  const NODE_LABEL_MIN_GAP = 44;
  const NODE_AVATAR_R = 7;
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

  // Profilbild (oder "?"-Platzhalter) unter Name+Betrag — eigene <clipPath>
  // pro Vorkommen, da dieselbe Person sowohl links (schuldet) als auch rechts
  // (bekommt) auftauchen kann.
  let clipIdCounter = 0;
  function nodeAvatarSvg(username, cx, cy) {
    clipIdCounter += 1;
    const clipId = `mf-avatar-clip-${clipIdCounter}`;
    const avatarPath = USER_AVATARS[username];
    if (avatarPath) {
      return `<clipPath id="${clipId}"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${NODE_AVATAR_R}"/></clipPath><image href="${avatarPath}" x="${(cx - NODE_AVATAR_R).toFixed(1)}" y="${(cy - NODE_AVATAR_R).toFixed(1)}" width="${NODE_AVATAR_R * 2}" height="${NODE_AVATAR_R * 2}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"/>`;
    }
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${NODE_AVATAR_R}" fill="var(--surface2)"/><text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="${NODE_AVATAR_R}" font-weight="800" fill="var(--muted)">?</text>`;
  }

  let nodesSvg = "";
  leftNodes.forEach((n, i) => {
    const pos = left.positions[n.id];
    const y = pos.y + leftOffset;
    const labelY = leftLabelCenters[i] + leftOffset;
    const avatarCx = LABEL_W - 8;
    const avatarCy = labelY + 9 + 6 + NODE_AVATAR_R;
    nodesSvg += `<rect x="${LABEL_W}" y="${y.toFixed(1)}" width="${NODE_W}" height="${pos.h.toFixed(1)}" rx="2" fill="${colorOf[n.id]}"/>`;
    nodesSvg += `<text class="money-flow-node-label" x="${LABEL_W - 8}" y="${(labelY - 3).toFixed(1)}" text-anchor="end">${escapeHtml(n.name)}</text>`;
    nodesSvg += `<text class="money-flow-node-amount" x="${LABEL_W - 8}" y="${(labelY + 9).toFixed(1)}" text-anchor="end">${formatEuro(n.total)}</text>`;
    nodesSvg += nodeAvatarSvg(n.name, avatarCx, avatarCy);
  });
  rightNodes.forEach((n, i) => {
    const pos = right.positions[n.id];
    const y = pos.y + rightOffset;
    const labelY = rightLabelCenters[i] + rightOffset;
    const avatarCx = VW - LABEL_W + 8;
    const avatarCy = labelY + 9 + 6 + NODE_AVATAR_R;
    nodesSvg += `<rect x="${rightXStart.toFixed(1)}" y="${y.toFixed(1)}" width="${NODE_W}" height="${pos.h.toFixed(1)}" rx="2" fill="${colorOf[n.id]}"/>`;
    nodesSvg += `<text class="money-flow-node-label" x="${(VW - LABEL_W + 8).toFixed(1)}" y="${(labelY - 3).toFixed(1)}" text-anchor="start">${escapeHtml(n.name)}</text>`;
    nodesSvg += `<text class="money-flow-node-amount" x="${(VW - LABEL_W + 8).toFixed(1)}" y="${(labelY + 9).toFixed(1)}" text-anchor="start">${formatEuro(n.total)}</text>`;
    nodesSvg += nodeAvatarSvg(n.name, avatarCx, avatarCy);
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
    maxNodeLabelY + 15 + NODE_AVATAR_R * 2 + MARGIN_Y
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
      settlements.forEach((s) =>
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
      <p class="muted">Genau diese ${steps.length} Überweisung${steps.length === 1 ? "" : "en"} siehst du unter "Offene Zahlungen" — von ursprünglich ${netted_pairs.length} Paar-Zahlung${netted_pairs.length === 1 ? "" : "en"} über Ketten auf ${steps.length} reduziert.</p>
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
let lastExpenseLog = [];
let expenseLogFilterAction = "";

function formatExpenseLogTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const EXPENSE_LOG_ICONS = {
  expense_created: "💶",
  expense_edited: "✏️",
  expense_deleted: "🗑️",
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

  expenseLogListEl.innerHTML = "";
  if (filtered.length === 0) {
    expenseLogListEl.innerHTML = `<div class="empty-state"><p>Noch keine Einträge.</p></div>`;
  } else {
    filtered.forEach((e) => expenseLogListEl.appendChild(renderExpenseLogItem(e)));
  }
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
    renderExpenseLog();
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

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  // So früh wie möglich, damit USER_COLORS/USER_AVATARS (nameTag()) beim
  // allerersten Render schon befüllt sind statt erst nach dem ersten Poll.
  fetchUsersAndMe();
  loadTasks();
  setInterval(loadTasks, 3000);
  loadPlanList();
  setInterval(loadPlanList, 5000);
  pollCostsViews();
  setInterval(pollCostsViews, 3000);
  setInterval(checkAppVersion, 60000);
});
