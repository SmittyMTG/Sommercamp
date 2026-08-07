// ===========================================================
// Sommercamp 2026 — Grundgerüst
// Screen-Navigation + Countdown. Datenanbindung folgt später.
// ===========================================================

const CAMP_START = new Date("2026-08-05T06:00:00");
const CAMP_END = new Date("2026-08-16T23:59:59");
const PARTY_TIME = new Date("2026-08-15T17:00:00"); // Abschlussfeier — Leaderboard schaltet dann frei

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

/* ---------- Screen switching ---------- */
function goToScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.classList.toggle("active", el.id === `screen-${name}`);
  });
  document.querySelectorAll(".bottom-nav button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.screen === name);
  });
  // Nicht mehr window.scrollTo: body scrollt bewusst nicht mehr (siehe CSS),
  // .app-shell ist jetzt der eigentliche Scroll-Container.
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

/* ---------- Countdown ---------- */
// Zählt bis zum Camp-Ende runter (nicht mehr bis zum Start) — die Fortschrittsleiste
// zeigt entsprechend, wie viel vom Zeitraum Start–Ende bereits vergangen ist.
function updateCountdown() {
  const el = document.getElementById("countdown");
  const progressEl = document.getElementById("countdownProgress");
  if (!el) return;

  const now = new Date();

  if (now > CAMP_END) {
    el.innerHTML = `Vorbei <small>🏕️</small>`;
    if (progressEl) progressEl.style.width = "100%";
    return;
  }

  const diffMs = CAMP_END - now;
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);

  el.innerHTML = `${days} <small>T</small> ${hours} <small>Std</small> ${minutes} <small>Min</small>`;

  if (progressEl) {
    const totalMs = CAMP_END - CAMP_START;
    const elapsed = Math.max(0, now - CAMP_START);
    const pct = Math.min(100, Math.max(0, Math.round((elapsed / totalMs) * 100)));
    progressEl.style.width = `${pct}%`;
  }
}

// Countdown bis zur Abschlussfeier für die gesperrte Leaderboard-Ansicht.
function updateLeaderboardCountdown() {
  const el = document.getElementById("leaderboardCountdown");
  if (!el) return;

  const now = new Date();
  if (now > PARTY_TIME) {
    el.innerHTML = `Jetzt <small>🎉</small>`;
    return;
  }

  const diffMs = PARTY_TIME - now;
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);

  el.innerHTML = `${days} <small>T</small> ${hours} <small>Std</small> ${minutes} <small>Min</small>`;
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
  return Array.from(modalBody.querySelectorAll("input, textarea, select"))
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

/* ---------- Einkaufsliste ---------- */
const shoppingListEl = document.getElementById("shoppingList");
const quickShoppingEl = document.getElementById("quickShopping");

function renderShoppingItem(item) {
  const card = document.createElement("div");
  card.className = "list-card" + (item.done ? " done" : "");
  card.dataset.id = item.id;

  const sourceTag = item.woher
    ? `<span class="source-tag" style="background:${escapeHtml(item.woher.farbe)}">${escapeHtml(item.woher.bezeichnung)}</span>`
    : "";

  card.innerHTML = `
    <div class="list-card-content">
      <button type="button" class="list-card-checkbox${item.done ? " checked" : ""}" aria-label="Erledigt"></button>
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(item.name)}</p>
        ${sourceTag}
      </div>
    </div>
    <div class="list-card-actions">
      <button type="button" class="edit-btn" aria-label="Bearbeiten">✏️</button>
      <button type="button" class="delete-btn" aria-label="Löschen">🗑️</button>
    </div>
  `;

  // Der Klick aktualisiert die eigene Ansicht sofort über die HTTP-Antwort.
  // Andere Geräte sehen die Änderung über das Sekunden-Polling (pollShoppingList).
  const checkbox = card.querySelector(".list-card-checkbox");
  checkbox.addEventListener("click", async (e) => {
    e.preventDefault();
    const res = await fetch(`/api/shopping/${item.id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      checkbox.classList.toggle("checked", data.done);
      card.classList.toggle("done", data.done);
      updateQuickShoppingCount();
    }
  });

  card.querySelector(".edit-btn").addEventListener("click", () => openEditShoppingModal(item));

  card.querySelector(".delete-btn").addEventListener("click", () => {
    openModal({
      eyebrow: "Einkauf",
      title: `„${item.name}" löschen?`,
      bodyHtml: `<p class="muted warning-text">Der Artikel wird für alle aus der Liste entfernt. Das lässt sich nicht rückgängig machen.</p>`,
      submitLabel: "Löschen",
      danger: true,
      onSubmit: async () => {
        const res = await fetch(`/api/shopping/${item.id}`, { method: "DELETE" });
        if (res.ok) {
          card.remove();
          updateQuickShoppingCount();
          if (!shoppingListEl.querySelector(".list-card")) {
            shoppingListEl.innerHTML = `<div class="empty"><p>Einkaufsliste ist noch leer.</p></div>`;
          }
        }
        closeModal();
      },
    });
  });

  return card;
}

function updateQuickShoppingCount() {
  if (!quickShoppingEl) return;
  const open = shoppingListEl.querySelectorAll(".list-card:not(.done)").length;
  quickShoppingEl.textContent = `${open} offen`;
}

// Die DB liefert immer dieselbe statische Reihenfolge (Erstellzeit). Sortieren
// nach Name/Woher/Status ist rein clientseitig und ändert nichts an der
// zugrunde liegenden, stabilen Basis-Reihenfolge.
let lastShoppingItems = [];
let shoppingSortMode = "neu";

// Offene Einträge stehen immer vor erledigten; die gewählte Sortierung
// (Name/Woher/Neu) gilt jeweils nur innerhalb dieser beiden Gruppen.
function sortShoppingItems(items, mode) {
  const sortWithin = (arr) => {
    const out = [...arr];
    if (mode === "name") {
      out.sort((a, b) => a.name.localeCompare(b.name, "de"));
    } else if (mode === "woher") {
      out.sort((a, b) => {
        const an = a.woher ? a.woher.bezeichnung : "￿"; // ohne Woher ans Ende
        const bn = b.woher ? b.woher.bezeichnung : "￿";
        return an.localeCompare(bn, "de");
      });
    }
    return out;
  };
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  return [...sortWithin(open), ...sortWithin(done)];
}

function renderShoppingListItems(items) {
  shoppingListEl.innerHTML = "";
  if (items.length === 0) {
    shoppingListEl.innerHTML = `<div class="empty"><p>Einkaufsliste ist noch leer.</p></div>`;
  } else {
    items.forEach((item) => shoppingListEl.appendChild(renderShoppingItem(item)));
  }
  updateQuickShoppingCount();
}

function renderSortedShoppingList() {
  renderShoppingListItems(sortShoppingItems(lastShoppingItems, shoppingSortMode));
}

const shoppingSortSelect = document.getElementById("shoppingSortSelect");
if (shoppingSortSelect) {
  shoppingSortSelect.addEventListener("change", () => {
    shoppingSortMode = shoppingSortSelect.value;
    renderSortedShoppingList();
  });
}

let lastShoppingSignature = null;

async function loadShoppingList() {
  try {
    const res = await fetch("/api/shopping");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const items = await res.json();
    lastShoppingSignature = JSON.stringify(items);
    lastShoppingItems = items;
    renderSortedShoppingList();
  } catch (err) {
    shoppingListEl.innerHTML = `<div class="empty"><p>Liste konnte nicht geladen werden.</p></div>`;
  }
}

// Fragt die Einkaufsliste regelmäßig ab und rendert nur neu, wenn sich
// wirklich etwas geändert hat — so sehen alle Geräte Änderungen anderer
// Nutzer nahezu live, ohne WebSocket/Reverse-Proxy-Abhängigkeit.
async function pollShoppingList() {
  try {
    const res = await fetch("/api/shopping");
    if (!res.ok) return;
    const items = await res.json();
    const signature = JSON.stringify(items);
    if (signature === lastShoppingSignature) return;
    lastShoppingSignature = signature;
    lastShoppingItems = items;
    renderSortedShoppingList();
  } catch (err) {
    // Netzwerkhänger ignorieren, nächster Tick versucht es erneut
  }
}

let cachedShoppingSources = null;

async function fetchShoppingSources(forceRefresh) {
  if (cachedShoppingSources && !forceRefresh) return cachedShoppingSources;
  const res = await fetch("/api/shopping-sources");
  cachedShoppingSources = res.ok ? await res.json() : [];
  return cachedShoppingSources;
}

function shoppingSourceOptionsHtml(sources, selectedId) {
  return sources
    .map(
      (s) =>
        `<option value="${s.id}"${s.id === selectedId ? " selected" : ""}>${escapeHtml(s.bezeichnung)}</option>`
    )
    .join("");
}

function shoppingModalBodyHtml(sources, prefill = {}) {
  const selectedWoherId = prefill.woher ? prefill.woher.id : null;
  return `
    <div class="form-stack">
      <label>Produktname
        <input type="text" id="shoppingNameInput" value="${escapeHtml(prefill.name || "")}" placeholder="z. B. Kohle für den Grill" required>
      </label>
      <label>Woher (optional)
        <select id="shoppingWoherSelect">
          <option value="">— keine Angabe —</option>
          ${shoppingSourceOptionsHtml(sources, selectedWoherId)}
          <option value="__new__">+ Neue Quelle anlegen…</option>
        </select>
      </label>
      <div id="newSourceFields" class="form-stack hidden">
        <label>Farbe
          <input type="color" id="newSourceColor" value="#ffd400">
        </label>
        <label>Bezeichnung
          <input type="text" id="newSourceLabel" maxlength="16" placeholder="z. B. Rewe">
        </label>
        <button type="button" id="createSourceBtn" class="secondary compact">Quelle anlegen</button>
        <p class="error-text hidden new-source-error"></p>
      </div>
    </div>
  `;
}

// Muss NACH openModal() aufgerufen werden (braucht die frisch eingefügten Felder im DOM).
function wireShoppingSourcePicker() {
  const woherSelect = document.getElementById("shoppingWoherSelect");
  const newSourceFields = document.getElementById("newSourceFields");
  woherSelect.addEventListener("change", () => {
    newSourceFields.classList.toggle("hidden", woherSelect.value !== "__new__");
  });

  document.getElementById("createSourceBtn").addEventListener("click", async () => {
    const colorInput = document.getElementById("newSourceColor");
    const labelInput = document.getElementById("newSourceLabel");
    const errEl = document.querySelector(".new-source-error");
    const bezeichnung = labelInput.value.trim();
    errEl.classList.add("hidden");

    if (!bezeichnung) {
      errEl.textContent = "Bitte eine Bezeichnung eingeben.";
      errEl.classList.remove("hidden");
      return;
    }

    const res = await fetch("/api/shopping-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farbe: colorInput.value, bezeichnung }),
    });

    if (res.ok) {
      const created = await res.json();
      const sources = await fetchShoppingSources(true);
      woherSelect.innerHTML = `
        <option value="">— keine Angabe —</option>
        ${shoppingSourceOptionsHtml(sources, created.id)}
        <option value="__new__">+ Neue Quelle anlegen…</option>
      `;
      newSourceFields.classList.add("hidden");
    } else {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || "Konnte nicht angelegt werden.";
      errEl.classList.remove("hidden");
    }
  });
}

function readShoppingForm() {
  const name = document.getElementById("shoppingNameInput").value.trim();
  const woherSelect = document.getElementById("shoppingWoherSelect");
  if (woherSelect.value === "__new__") return null; // erst Quelle anlegen, dann erneut speichern
  const woher_id = woherSelect.value ? parseInt(woherSelect.value, 10) : null;
  if (!name) return null;
  return { name, woher_id };
}

async function openAddShoppingModal() {
  const sources = await fetchShoppingSources();

  openModal({
    eyebrow: "Einkauf",
    title: "Artikel hinzufügen",
    bodyHtml: shoppingModalBodyHtml(sources),
    onSubmit: async () => {
      const form = readShoppingForm();
      if (!form) return;

      const res = await fetch("/api/shopping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        const newItem = await res.json();
        lastShoppingItems = [newItem, ...lastShoppingItems];
        lastShoppingSignature = JSON.stringify(lastShoppingItems);
        renderSortedShoppingList();
        closeModal();
      }
    },
  });

  wireShoppingSourcePicker();
}

async function openEditShoppingModal(item) {
  const sources = await fetchShoppingSources();

  openModal({
    eyebrow: "Einkauf",
    title: "Artikel bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: shoppingModalBodyHtml(sources, item),
    onSubmit: async () => {
      const form = readShoppingForm();
      if (!form) return;

      const res = await fetch(`/api/shopping/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        const updated = await res.json();
        lastShoppingItems = lastShoppingItems.map((i) => (i.id === updated.id ? updated : i));
        lastShoppingSignature = JSON.stringify(lastShoppingItems);
        renderSortedShoppingList();
        closeModal();
      }
    },
  });

  wireShoppingSourcePicker();
}

document.getElementById("addShoppingButton").addEventListener("click", openAddShoppingModal);

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

function formatDeadline(iso) {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
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

// Sortierschlüssel für "Verantwortlich": eigene Aufgaben zuerst, dann die
// übrigen alphabetisch nach zuständiger Person, nicht zugewiesene ("Für alle") ganz am Ende.
function taskResponsibleSortKey(task, meId) {
  const assignee = task.assignees[0];
  if (!assignee) return [2, ""];
  if (assignee.id === meId) return [0, ""];
  return [1, assignee.username.toLowerCase()];
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
  card.className = "list-card" + (task.done ? " done" : "");
  card.dataset.id = task.id;

  const overdue = isTaskOverdue(task);
  const metaParts = [];
  if (task.deadline) {
    const label = `📅 ${formatDeadline(task.deadline)}`;
    metaParts.push(overdue ? `<span class="danger">⚠️ ${label}</span>` : label);
  }
  if (task.assignees.length) {
    metaParts.push(`${task.assignees.map((a) => escapeHtml(a.username)).join(", ")} ist verantwortlich`);
  }

  const categoryTag = task.category
    ? `<span class="source-tag" style="background:${escapeHtml(task.category.farbe)}">${escapeHtml(task.category.bezeichnung)}</span>`
    : "";

  const descHtml = task.beschreibung
    ? `<p class="list-card-meta">${escapeHtml(task.beschreibung)}</p>`
    : "";

  card.innerHTML = `
    <div class="list-card-content">
      <button type="button" class="list-card-checkbox${task.done ? " checked" : ""}" aria-label="Erledigt"></button>
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(task.titel)}</p>
        ${categoryTag}
        ${metaParts.length ? `<p class="list-card-meta">${metaParts.join(" · ")}</p>` : ""}
        ${descHtml}
      </div>
    </div>
    <div class="list-card-actions">
      <button type="button" class="edit-btn" aria-label="Bearbeiten">✏️</button>
      <button type="button" class="delete-btn" aria-label="Löschen">🗑️</button>
    </div>
  `;

  const checkbox = card.querySelector(".list-card-checkbox");
  checkbox.addEventListener("click", async (e) => {
    e.preventDefault();
    const res = await fetch(`/api/tasks/${task.id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      checkbox.classList.toggle("checked", data.done);
      card.classList.toggle("done", data.done);
      task.done = data.done;
    }
  });

  card.querySelector(".edit-btn").addEventListener("click", () => openEditTaskModal(task));

  card.querySelector(".delete-btn").addEventListener("click", () => {
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

  renderMyOpenTasks(me);
}

/* ---------- Dashboard: "Deine Aufgaben"-Vorschau auf der Startseite ---------- */
const myOpenTasksEl = document.getElementById("myOpenTasks");

function renderMyOpenTaskCard(task) {
  const card = document.createElement("div");
  card.className = "list-card clickable";

  const overdue = isTaskOverdue(task);
  const metaParts = [];
  if (task.deadline) {
    const label = `📅 ${formatDeadline(task.deadline)}`;
    metaParts.push(overdue ? `<span class="danger">⚠️ ${label}</span>` : label);
  }
  const metaHtml = metaParts.length ? `<p class="list-card-meta">${metaParts.join(" · ")}</p>` : "";
  const categoryTag = task.category
    ? `<span class="source-tag" style="background:${escapeHtml(task.category.farbe)}">${escapeHtml(task.category.bezeichnung)}</span>`
    : "";

  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${escapeHtml(task.titel)}</p>
      ${categoryTag}
      ${metaHtml}
    </div>
  `;
  card.addEventListener("click", () => goToScreen("more"));
  return card;
}

// Eigene + nicht zugewiesene (= für alle geltende) offene Aufgaben — nächste
// Deadline zuerst, damit heute fällige/überfällige Sachen ganz oben stehen.
// Läuft am Task-Polling mit, braucht also keinen eigenen Fetch.
function renderMyOpenTasks(me) {
  if (!myOpenTasksEl) return;

  const mine = lastTaskItems
    .filter((t) => !t.done && me && isTaskMine(t, me.id))
    .sort((a, b) => {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline) - new Date(b.deadline);
    })
    .slice(0, 4);

  myOpenTasksEl.innerHTML = "";
  if (mine.length === 0) {
    myOpenTasksEl.innerHTML = `<div class="empty-state"><p>Keine offenen Aufgaben für dich.</p></div>`;
  } else {
    mine.forEach((t) => myOpenTasksEl.appendChild(renderMyOpenTaskCard(t)));
  }
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
  // Höchstens eine Person kann verantwortlich sein — ein Dropdown macht das
  // (anders als eine Checkbox-Gruppe) von sich aus unmissverständlich: entweder
  // "Niemand" (Aufgabe gilt für alle) oder genau eine konkret verantwortliche Person.
  const currentAssigneeId =
    prefill.assignees && prefill.assignees.length ? prefill.assignees[0].id : null;
  const assigneeOptions = users
    .map(
      (u) =>
        `<option value="${u.id}"${u.id === currentAssigneeId ? " selected" : ""}>${escapeHtml(u.username)}</option>`
    )
    .join("");

  const currentCategoryId = prefill.category ? prefill.category.id : null;

  // date erwartet "YYYY-MM-DD", der Server liefert ein volles ISO-Format zurück.
  const deadlineValue = prefill.deadline ? prefill.deadline.slice(0, 10) : "";

  return `
    <div class="form-stack">
      <label>Titel
        <input type="text" id="taskTitelInput" maxlength="80" value="${escapeHtml(prefill.titel || "")}" placeholder="z. B. Zelte aufbauen" required>
      </label>
      <label>Beschreibung (optional)
        <textarea id="taskBeschreibungInput" placeholder="Details …">${escapeHtml(prefill.beschreibung || "")}</textarea>
      </label>
      <label>Verantwortlich
        <select id="taskAssigneeSelect">
          <option value="">Alle</option>
          ${assigneeOptions}
        </select>
      </label>
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
          <input type="text" id="newTaskCategoryLabel" maxlength="16" placeholder="z. B. Einkauf">
        </label>
        <button type="button" id="createTaskCategoryBtn" class="secondary compact">Kategorie anlegen</button>
        <p class="error-text hidden new-task-category-error"></p>
      </div>
      <label>Deadline (optional)
        <input type="date" id="taskDeadlineInput" value="${deadlineValue}">
      </label>
    </div>
  `;
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
  const assigneeValue = document.getElementById("taskAssigneeSelect").value;
  const assignee_ids = assigneeValue ? [parseInt(assigneeValue, 10)] : [];
  const deadline = document.getElementById("taskDeadlineInput").value || null;

  const categoryResult = await resolveTaskCategoryId();
  if (!categoryResult.ok) return null;

  return { titel, beschreibung, assignee_ids, category_id: categoryResult.category_id, deadline };
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
}

const addTaskButton = document.getElementById("addTaskButton");
if (addTaskButton) addTaskButton.addEventListener("click", openAddTaskModal);

/* ---------- Camp-Plan (Termine, nur Admins legen an) ---------- */
const planListEl = document.getElementById("planList");
const addPlanButton = document.getElementById("addPlanButton");

function formatWeekdayDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00`);
  const formatted = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" });
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function mapsUrl(location) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
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
             <button type="button" class="icon-button edit-plan-btn" aria-label="Bearbeiten">✏️</button>
             <button type="button" class="icon-button delete-plan-btn" aria-label="Löschen">🗑️</button>
           </div>`
        : "<div></div>"
    }
  `;

  if (isAdmin) {
    card.querySelector(".edit-plan-btn").addEventListener("click", () => openEditPlanModal(event));

    card.querySelector(".delete-plan-btn").addEventListener("click", () => {
      openModal({
        eyebrow: "Camp-Plan",
        title: `„${event.bezeichnung}" löschen?`,
        bodyHtml: `<p class="muted warning-text">Der Termin wird für alle aus dem Plan entfernt. Das lässt sich nicht rückgängig machen.</p>`,
        submitLabel: "Löschen",
        danger: true,
        onSubmit: async () => {
          const res = await fetch(`/api/plan/${event.id}`, { method: "DELETE" });
          if (res.ok) loadPlanList(true);
          closeModal();
        },
      });
    });
  }

  return card;
}

let lastPlanSignature = null;

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

    planListEl.innerHTML = "";
    if (events.length === 0) {
      planListEl.innerHTML = `<div class="empty-state"><p>Hier entsteht der Camp-Plan.</p></div>`;
    } else {
      groupPlanEvents(events).forEach((group) => {
        const block = document.createElement("div");
        block.className = "date-block";
        block.innerHTML = `<h3>${formatWeekdayDate(group.datum)}</h3>`;
        const stack = document.createElement("div");
        stack.className = "stack";
        group.items.forEach((event) => stack.appendChild(renderPlanEvent(event, isAdmin)));
        block.appendChild(stack);
        planListEl.appendChild(block);
      });
    }
  } catch (err) {
    planListEl.innerHTML = `<div class="empty-state"><p>Plan konnte nicht geladen werden.</p></div>`;
  }
}

/* ---------- Heute geplant (Startseite) ---------- */
const todayPlanEl = document.getElementById("todayPlan");
let lastTodayPlanSignature = null;

function todayIsoDate() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function loadTodayPlan() {
  if (!todayPlanEl) return;
  try {
    const res = await fetch("/api/plan");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const events = await res.json();
    const today = todayIsoDate();
    const todaysEvents = events
      .filter((e) => e.datum === today)
      .sort((a, b) => a.uhrzeit.localeCompare(b.uhrzeit));

    const signature = JSON.stringify(todaysEvents);
    if (signature === lastTodayPlanSignature) return;
    lastTodayPlanSignature = signature;

    todayPlanEl.innerHTML = "";
    if (todaysEvents.length === 0) {
      todayPlanEl.innerHTML = `<div class="empty-state"><p>Noch nichts geplant für heute.</p></div>`;
    } else {
      // isAdmin=false: die Startseite ist eine schlanke Übersicht, Bearbeiten/
      // Löschen bleibt der vollen Camp-Plan-Seite vorbehalten.
      todaysEvents.forEach((event) => todayPlanEl.appendChild(renderPlanEvent(event, false)));
    }
  } catch (err) {
    todayPlanEl.innerHTML = `<div class="empty-state"><p>Plan konnte nicht geladen werden.</p></div>`;
  }
}

function planModalBodyHtml(prefill = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="form-stack">
      <label>Datum
        <input type="date" id="planDatumInput" value="${prefill.datum || today}" required>
      </label>
      <label>Uhrzeit
        <input type="time" id="planUhrzeitInput" value="${prefill.uhrzeit || ""}" required>
      </label>
      <label>Bezeichnung
        <input type="text" id="planBezeichnungInput" maxlength="60" value="${escapeHtml(prefill.bezeichnung || "")}" placeholder="z. B. Lagerfeuer-Abend" required>
      </label>
      <label>Location (Adresse)
        <input type="text" id="planLocationInput" maxlength="120" value="${escapeHtml(prefill.location || "")}" placeholder="z. B. Wiese am See, Musterweg 5">
      </label>
      <label>Beschreibung
        <textarea id="planBeschreibungInput" placeholder="Was ist geplant?">${escapeHtml(prefill.beschreibung || "")}</textarea>
      </label>
      <p class="error-text hidden plan-modal-error"></p>
    </div>
  `;
}

async function submitPlanForm(url, method) {
  const datum = document.getElementById("planDatumInput").value;
  const uhrzeit = document.getElementById("planUhrzeitInput").value;
  const bezeichnung = document.getElementById("planBezeichnungInput").value.trim();
  const location = document.getElementById("planLocationInput").value.trim();
  const beschreibung = document.getElementById("planBeschreibungInput").value.trim();

  if (!datum || !uhrzeit || !bezeichnung) return;

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datum, uhrzeit, bezeichnung, location, beschreibung }),
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
    eyebrow: "Camp-Plan",
    title: "Termin hinzufügen",
    bodyHtml: planModalBodyHtml(),
    onSubmit: () => submitPlanForm("/api/plan", "POST"),
  });
}

function openEditPlanModal(event) {
  openModal({
    eyebrow: "Camp-Plan",
    title: "Termin bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: planModalBodyHtml(event),
    onSubmit: () => submitPlanForm(`/api/plan/${event.id}`, "PATCH"),
  });
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
  return { users: cachedUsers, me: cachedMe };
}

function formatEuro(value) {
  return value.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

function formatDate(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
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

function renderExpenseGroup(group, isAdmin) {
  const card = document.createElement("div");
  card.className = "list-card";
  const payer = Array.from(group.glaeubiger).map(escapeHtml).join(", ");
  const breakdown = group.entries
    .map((e) => {
      const label = e.selbst ? `${e.schuldner} (eigen)` : e.schuldner;
      return `${escapeHtml(label)}: ${formatEuro(e.cash)}`;
    })
    .join(" · ");
  const canManage = isAdmin && group.batchId;

  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${escapeHtml(group.betreff)}</p>
      <p class="list-card-meta">${formatDate(group.datum)} · bezahlt von ${payer} · ${formatEuro(group.total)} gesamt</p>
      <p class="list-card-meta">${breakdown}</p>
    </div>
    ${
      canManage
        ? `<div class="list-card-actions">
             <button type="button" class="edit-btn" aria-label="Bearbeiten">✏️</button>
             <button type="button" class="delete-btn" aria-label="Löschen">🗑️</button>
           </div>`
        : ""
    }
  `;

  if (canManage) {
    card.querySelector(".edit-btn").addEventListener("click", () => openEditExpenseModal(group));
    card.querySelector(".delete-btn").addEventListener("click", () => {
      openModal({
        eyebrow: "Kosten",
        title: `„${group.betreff}" löschen?`,
        bodyHtml: `<p class="muted warning-text">Die Ausgabe wird für alle Beteiligten entfernt. Das lässt sich nicht rückgängig machen.</p>`,
        submitLabel: "Löschen",
        danger: true,
        onSubmit: async () => {
          const res = await fetch(`/api/expenses/batch/${group.batchId}`, { method: "DELETE" });
          if (res.ok) {
            loadExpenses();
            loadBalance();
          }
          closeModal();
        },
      });
    });
  }

  return card;
}

/* ---------- Kosten: Ausgaben nach Zahler filtern ---------- */
const expenseFilterSelect = document.getElementById("expenseFilterSelect");
let lastExpenses = [];
let lastExpensesIsAdmin = false;
let expenseFilterUserId = null; // null = alle Personen
let expenseFilterOptionsPopulated = false;

async function populateExpenseFilterOptions() {
  if (expenseFilterOptionsPopulated || !expenseFilterSelect) return;
  const { users, me } = await fetchUsersAndMe();
  users
    .slice()
    .sort((a, b) => a.username.localeCompare(b.username, "de"))
    .forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = me && u.id === me.id ? "Nur von dir bezahlt" : `Nur von ${u.username} bezahlt`;
      expenseFilterSelect.appendChild(opt);
    });
  expenseFilterOptionsPopulated = true;
}

if (expenseFilterSelect) {
  populateExpenseFilterOptions();
  expenseFilterSelect.addEventListener("change", () => {
    const val = expenseFilterSelect.value;
    expenseFilterUserId = val ? parseInt(val, 10) : null;
    renderExpenseList();
  });
}

// Zeigt nur Ausgaben-Vorgänge, die die gewählte Person tatsächlich bezahlt hat
// (nicht nur "war beteiligt") — für jede Person einzeln zum Nachrechnen.
function renderExpenseList() {
  if (!expenseListEl) return;
  const groups = groupExpenses(lastExpenses).filter(
    (g) => expenseFilterUserId === null || g.glaubigerId === expenseFilterUserId
  );

  expenseListEl.innerHTML = "";
  if (groups.length === 0) {
    expenseListEl.innerHTML = `<div class="empty"><p>${
      lastExpenses.length === 0 ? "Noch keine Einträge." : "Keine Ausgaben für diese Auswahl."
    }</p></div>`;
  } else {
    groups.forEach((g) => expenseListEl.appendChild(renderExpenseGroup(g, lastExpensesIsAdmin)));
  }
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

    if (balance.net > 0.005) {
      balanceHeroEl.innerHTML = `
        <div class="eyebrow">Dein Saldo</div>
        <div class="countdown success">+${formatEuro(balance.net)}</div>
        <div class="muted">Du bekommst insgesamt ${formatEuro(balance.net)} zurück.</div>
      `;
    } else if (balance.net < -0.005) {
      balanceHeroEl.innerHTML = `
        <div class="eyebrow">Dein Saldo</div>
        <div class="countdown danger">${formatEuro(balance.net)}</div>
        <div class="muted">Du schuldest insgesamt ${formatEuro(Math.abs(balance.net))}.</div>
      `;
    } else {
      balanceHeroEl.innerHTML = `<div class="muted">Du bist ausgeglichen.</div>`;
    }

    if (myExpensesHeroEl) {
      myExpensesHeroEl.innerHTML = `
        <div class="eyebrow">Deine Ausgaben</div>
        <div class="countdown">${formatEuro(balance.my_total)}</div>
        <div class="muted">Insgesamt für dich angefallene Kosten.</div>
      `;
    }
  } catch (err) {
    balanceHeroEl.innerHTML = `<div class="muted">Saldo konnte nicht geladen werden.</div>`;
    if (myExpensesHeroEl) {
      myExpensesHeroEl.innerHTML = `<div class="muted">Ausgaben konnten nicht geladen werden.</div>`;
    }
  }
}

function expenseModalBodyHtml(users, me, prefill = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const payerId = prefill.glaubigerId != null ? prefill.glaubigerId : me.id;
  const beneficiaryIds = prefill.beneficiaryIds || null;

  const payerOptions = users
    .map((u) => `<option value="${u.id}"${u.id === payerId ? " selected" : ""}>${escapeHtml(u.username)}</option>`)
    .join("");

  const beneficiaryOptions = users
    .map((u) => {
      const checked = beneficiaryIds ? beneficiaryIds.has(u.id) : true;
      return `<label class="check-card"><input type="checkbox" class="beneficiary-checkbox" value="${u.id}"${checked ? " checked" : ""}>${escapeHtml(u.username)}</label>`;
    })
    .join("");

  return `
    <div class="form-stack">
      <label>Bezahlt von
        <select id="expensePayerSelect">${payerOptions}</select>
      </label>
      <div class="checkbox-group">
        <div class="eyebrow">Für wen?</div>
        <div class="action-row">
          <button type="button" id="expensePresetAll" class="secondary compact">Für Allgemeinheit</button>
          <button type="button" id="expensePresetMe" class="secondary compact">Nur für mich</button>
        </div>
        <div id="expenseBeneficiaries" class="checkbox-grid">${beneficiaryOptions}</div>
      </div>
      <label>Betrag gesamt (€)
        <input type="number" id="expenseCashInput" step="0.01" min="0.01" inputmode="decimal" value="${prefill.total != null ? prefill.total.toFixed(2) : ""}" placeholder="z. B. 24.50" required>
      </label>
      <div class="checkbox-group">
        <div class="eyebrow">Individuelle Beträge (optional)</div>
        <div id="expenseFixedAmounts" class="stack"></div>
        <p id="expenseSplitHint" class="muted"></p>
      </div>
      <label>Betreff
        <input type="text" id="expenseBetreffInput" maxlength="40" value="${escapeHtml(prefill.betreff || "")}" placeholder="z. B. Rewe Grillkäse" required>
      </label>
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
          <span>${escapeHtml(u.username)}</span>
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
function wireExpenseForm(users, me, entryAmounts) {
  renderExpenseFixedAmountInputs(users, entryAmounts);

  const checkboxes = () => document.querySelectorAll("#expenseBeneficiaries .beneficiary-checkbox");
  checkboxes().forEach((cb) => {
    cb.addEventListener("change", () => renderExpenseFixedAmountInputs(users, entryAmounts));
  });

  document.getElementById("expenseCashInput").addEventListener("input", updateExpenseSplitHint);

  const presetAll = document.getElementById("expensePresetAll");
  const presetMe = document.getElementById("expensePresetMe");
  if (presetAll) {
    presetAll.addEventListener("click", () => {
      checkboxes().forEach((cb) => (cb.checked = true));
      renderExpenseFixedAmountInputs(users, entryAmounts);
    });
  }
  if (presetMe && me) {
    presetMe.addEventListener("click", () => {
      checkboxes().forEach((cb) => (cb.checked = parseInt(cb.value, 10) === me.id));
      renderExpenseFixedAmountInputs(users, entryAmounts);
    });
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
        loadExpenses();
        loadBalance();
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
        loadExpenses();
        loadBalance();
      }
    },
  });

  // Bestehende Beträge vorausfüllen, damit ein unveränderter Save die aktuelle
  // (ggf. individuelle) Aufteilung nicht stillschweigend auf Gleichverteilung zurücksetzt.
  const entryAmounts = {};
  group.entries.forEach((e) => {
    entryAmounts[e.schuldner_id] = e.cash;
  });
  wireExpenseForm(users, me, entryAmounts);
}

const addExpenseButton = document.getElementById("addExpenseButton");
if (addExpenseButton) addExpenseButton.addEventListener("click", openAddExpenseModal);

/* ---------- Kosten: Reset (nur Admins) ---------- */
const resetExpensesButton = document.getElementById("resetExpensesButton");

function openResetExpensesModal() {
  openModal({
    eyebrow: "Kosten",
    title: "Kostendatenbank wirklich zurücksetzen?",
    submitLabel: "Alles löschen",
    danger: true,
    bodyHtml: `
      <div class="form-stack">
        <p class="muted warning-text">
          Das löscht ALLE Ausgaben, Salden und die komplette Tilgungs-Historie für
          ALLE Camper unwiderruflich. Das lässt sich nicht rückgängig machen.
        </p>
        <label>Tippe <strong>RESET</strong> zur Bestätigung
          <input type="text" id="resetConfirmInput" placeholder="RESET" autocomplete="off">
        </label>
        <p class="error-text hidden reset-modal-error"></p>
      </div>
    `,
    onSubmit: async () => {
      const confirmInput = document.getElementById("resetConfirmInput");
      const errEl = document.querySelector(".reset-modal-error");
      errEl.classList.add("hidden");

      if (confirmInput.value.trim().toUpperCase() !== "RESET") {
        errEl.textContent = "Bitte RESET eintippen, um zu bestätigen.";
        errEl.classList.remove("hidden");
        return;
      }

      const res = await fetch("/api/expenses/reset", { method: "POST" });
      if (res.ok) {
        closeModal();
        loadExpenses();
        loadBalance();
        loadOpenSettlements();
        loadReceivedPayments();
      } else {
        const data = await res.json().catch(() => ({}));
        errEl.textContent = data.error || "Konnte nicht zurückgesetzt werden.";
        errEl.classList.remove("hidden");
      }
    },
  });
}

if (resetExpensesButton) {
  resetExpensesButton.addEventListener("click", openResetExpensesModal);
  // Button ist standardmäßig ausgeblendet (siehe index.html), damit er für
  // Nicht-Admins nie kurz aufblitzt, bis die Rolle bekannt ist.
  fetchUsersAndMe().then(({ me }) => {
    if (me && isAdminRole(me.role)) resetExpensesButton.classList.remove("hidden");
  });
}

/* ---------- Kosten: Ansicht wechseln ---------- */
const costsViewRow = document.getElementById("costsViewRow");
const costsViews = {
  entry: document.getElementById("costsViewEntry"),
  open: document.getElementById("costsViewOpen"),
  received: document.getElementById("costsViewReceived"),
  leaderboard: document.getElementById("costsViewLeaderboard"),
};

function switchCostsView(view) {
  Object.entries(costsViews).forEach(([key, el]) => {
    if (el) el.classList.toggle("hidden", key !== view);
  });
  if (view === "open") loadOpenSettlements();
  if (view === "received") loadReceivedPayments();
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

/* ---------- Kosten: Offene Zahlungen ---------- */
const openSettlementsListEl = document.getElementById("openSettlementsList");

function openConfirmSettleModal(s) {
  openModal({
    eyebrow: "Offene Zahlung",
    title: "Als überwiesen markieren?",
    submitLabel: "Ja, überwiesen",
    bodyHtml: `
      <p class="muted">
        An <strong>${escapeHtml(s.to)}</strong>. Offen sind insgesamt ${formatEuro(s.amount)} — du kannst auch nur
        einen Teilbetrag als überwiesen markieren, der Rest bleibt dann offen.
      </p>
      <label>Überwiesener Betrag
        <input type="number" step="0.01" min="0.01" max="${s.amount}" inputmode="decimal" id="settleAmountInput" value="${s.amount.toFixed(2)}" required>
      </label>
      <p class="muted">${escapeHtml(s.to)} sieht das jetzt hier in der App und muss den Empfang bestätigen — sobald das passiert, siehst auch du es hier und der Betrag gilt als beglichen.</p>
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
        loadOpenSettlements();
        loadBalance();
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
    actionHtml = `<div class="list-card-actions"><span class="pill">Warten auf Bestätigung von ${escapeHtml(s.to)}</span></div>`;
  } else if (isMine) {
    actionHtml = `<div class="list-card-actions"><button type="button" class="tiny settle-btn">Als bezahlt markieren</button></div>`;
  }
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${escapeHtml(s.from)} → ${escapeHtml(s.to)}</p>
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

/* ---------- Kosten: Erhaltene Zahlungen ---------- */
const receivedListEl = document.getElementById("receivedList");

function renderReceivedItem(r) {
  const card = document.createElement("div");
  card.className = "list-card";
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${escapeHtml(r.from)} behauptet: ${formatEuro(r.amount)} überwiesen</p>
      <p class="list-card-meta">${formatDate(r.datum)} · Betrag zur Bestätigung eintippen</p>
      <div class="form-stack">
        <input type="number" step="0.01" min="0.01" inputmode="decimal" class="received-amount-input" placeholder="z. B. ${r.amount.toFixed(2).replace(".", ",")}">
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
      loadReceivedPayments();
      loadBalance();
    } else {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || "Konnte nicht bestätigt werden.";
      errEl.classList.remove("hidden");
    }
  });

  return card;
}

let lastReceivedSignature = null;

async function loadReceivedPayments() {
  if (!receivedListEl) return;
  try {
    const res = await fetch("/api/expenses/received");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const received = await res.json();

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

/* ---------- Kosten: Leaderboard ---------- */
// Bewusst komplett gesperrt bis zur Abschlussparty — auch die eigene
// Platzierung wird nicht mehr vorab angezeigt (siehe #leaderboardLockHero
// in index.html), daher gibt es hier nichts mehr zu laden/rendern.

/* ---------- Kosten: alles alle 3 Sekunden aktualisieren ---------- */
// Läuft unabhängig davon, welche Unteransicht gerade sichtbar ist (gleiches
// Prinzip wie beim Einkaufslisten-Polling) — so ist z. B. sofort sichtbar,
// wenn jemand anderes eine Zahlung bestätigt, ohne dass neu eingeloggt werden muss.
function pollCostsViews() {
  loadBalance();
  loadExpenses();
  loadOpenSettlements();
  loadReceivedPayments();
}

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  updateCountdown();
  updateLeaderboardCountdown();
  setInterval(() => {
    updateCountdown();
    updateLeaderboardCountdown();
  }, 30000); // keine Sekundenanzeige mehr, reicht alle 30s
  loadShoppingList();
  setInterval(pollShoppingList, 3000);
  loadTasks();
  setInterval(loadTasks, 3000);
  loadPlanList();
  setInterval(loadPlanList, 5000);
  loadTodayPlan();
  setInterval(loadTodayPlan, 5000);
  pollCostsViews();
  setInterval(pollCostsViews, 3000);
});
