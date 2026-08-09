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

// Feste Farbe pro Person, überall im UI verwendet, wo ein Name auftaucht —
// Wiedererkennung auf einen Blick, unabhängig vom Kontext (Aufgaben, Ausgaben,
// Zahlungen, Geldfluss-Diagramm). Namen ohne Eintrag bleiben schlicht (kein Tag).
const NAME_COLORS = {
  Henning: "#ffd400",
  Noah: "#ff9f45",
  Claus: "#ff7a7a",
  Nick: "#c9a3ff",
  Felix: "#4fd8cf",
};

function nameTag(username) {
  const safe = escapeHtml(username);
  const color = NAME_COLORS[username];
  return color ? `<span class="name-tag" style="background:${color}">${safe}</span>` : safe;
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
  const urgentTag = item.deadline ? `<p class="list-card-meta danger">❗ wird heute gebraucht</p>` : "";

  card.innerHTML = `
    <div class="list-card-content">
      <button type="button" class="list-card-checkbox${item.done ? " checked" : ""}" aria-label="Erledigt"></button>
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(item.name)}</p>
        ${sourceTag}
        ${urgentTag}
      </div>
    </div>
    <div class="list-card-actions">
      <button type="button" class="urgent-btn${item.deadline ? " active" : ""}" aria-label="Wird heute gebraucht">❗</button>
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

  card.querySelector(".urgent-btn").addEventListener("click", async () => {
    const res = await fetch(`/api/shopping/${item.id}/deadline-today`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      item.deadline = data.deadline;
      renderSortedShoppingList();
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
  if (task.aufwand_min != null) metaParts.push(`⏱ ${task.aufwand_min} Min`);
  if (task.assignees.length) {
    metaParts.push(`${task.assignees.map((a) => nameTag(a.username)).join(", ")} ist verantwortlich`);
  }

  const categoryTag = task.category
    ? `<span class="category-tag"><span class="category-tag-dot" style="background:${escapeHtml(task.category.farbe)}"></span>${escapeHtml(task.category.bezeichnung)}</span>`
    : "";
  const recurringTag = task.recurring ? `<span class="recurring-tag">🔁 wiederkehrend</span>` : "";

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
        ${categoryTag}${recurringTag}
        ${metaParts.length ? `<p class="list-card-meta">${metaParts.join(" · ")}</p>` : ""}
        ${descHtml}
        ${subitemsHtml}
      </div>
    </div>
    <div class="list-card-actions">
      <button type="button" class="urgent-btn${isUrgentToday ? " active" : ""}" aria-label="Deadline auf heute setzen">❗</button>
      <button type="button" class="edit-btn" aria-label="Bearbeiten">✏️</button>
      <button type="button" class="delete-btn" aria-label="Löschen">🗑️</button>
    </div>
  `;

  card.querySelector(".urgent-btn").addEventListener("click", async () => {
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
    const res = await fetch(`/api/tasks/${task.id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      if (data.cloned) {
        // Wiederkehrend: eine neue offene Kopie ist entstanden — komplett neu laden,
        // damit sie in der Liste auftaucht, statt nur diese eine Karte zu aktualisieren.
        loadTasks(true);
        return;
      }
      checkbox.classList.toggle("checked", data.done);
      card.classList.toggle("done", data.done);
      task.done = data.done;
    }
  });

  card.querySelectorAll(".subitem-row input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = await fetch(`/api/tasks/${task.id}/subitems/${cb.dataset.subId}/toggle`, { method: "PATCH" });
      if (res.ok) loadTasks(true);
    });
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
  renderTaskStats();
}

/* ---------- Aufgaben-Statistik ---------- */
// Kompaktes Aufgaben-Dashboard: nur noch pro Person (+ "Für alle") eine Zeile
// mit Mini-Balken erledigt/offen und Zahl — bewusst ohne Kategorie-Aufschlüsselung
// und ohne Aufwands-Gewichtung, um es klein und auf einen Blick lesbar zu halten.
function renderTaskPersonRow(entry) {
  const total = entry.done + entry.open;
  const overdueBadge = entry.overdue > 0 ? `<span class="task-stats-person-overdue" title="${entry.overdue} überfällig">⚠️</span>` : "";
  return `
    <div class="task-stats-person-row">
      <span class="task-stats-person-name">${escapeHtml(entry.label)}</span>
      <div class="task-stats-person-bar">
        ${entry.done > 0 ? `<span class="seg seg-done" style="flex:${entry.done}"></span>` : ""}
        ${entry.open > 0 ? `<span class="seg seg-open" style="flex:${entry.open}"></span>` : ""}
      </div>
      <span class="task-stats-person-count">${entry.done}/${total}${overdueBadge}</span>
    </div>
  `;
}

function renderTaskStats() {
  const totalEl = document.getElementById("taskStatsTotal");
  const byPersonEl = document.getElementById("taskStatsByPerson");
  if (!totalEl || !byPersonEl) return;

  const total = lastTaskItems.length;
  const doneCount = lastTaskItems.filter((t) => t.done).length;
  totalEl.textContent = total ? `${doneCount}/${total} erledigt` : "–";

  if (total === 0) {
    byPersonEl.innerHTML = `<p class="muted">Noch keine Aufgaben angelegt.</p>`;
    return;
  }

  const byPerson = new Map();
  lastTaskItems.forEach((t) => {
    const label = t.assignees.length ? t.assignees[0].username : "Für alle";
    const entry = byPerson.get(label) || { label, done: 0, open: 0, overdue: 0 };
    if (t.done) {
      entry.done += 1;
    } else {
      entry.open += 1;
      if (isTaskOverdue(t)) entry.overdue += 1;
    }
    byPerson.set(label, entry);
  });

  const entries = Array.from(byPerson.values()).sort((a, b) => b.done + b.open - (a.done + a.open));
  byPersonEl.innerHTML = entries.map(renderTaskPersonRow).join("");
}

/* ---------- Dashboard: Wetter am Camp (echte Daten von Open-Meteo) ---------- */
const WEATHER_CODES = {
  0: { icon: "☀️", label: "Klar" },
  1: { icon: "🌤️", label: "Überwiegend klar" },
  2: { icon: "⛅", label: "Teilweise bewölkt" },
  3: { icon: "☁️", label: "Bedeckt" },
  45: { icon: "🌫️", label: "Nebel" },
  48: { icon: "🌫️", label: "Reifnebel" },
  51: { icon: "🌦️", label: "Leichter Nieselregen" },
  53: { icon: "🌦️", label: "Nieselregen" },
  55: { icon: "🌧️", label: "Starker Nieselregen" },
  56: { icon: "🌧️", label: "Gefrierender Niesel" },
  57: { icon: "🌧️", label: "Starker gefrierender Niesel" },
  61: { icon: "🌦️", label: "Leichter Regen" },
  63: { icon: "🌧️", label: "Regen" },
  65: { icon: "🌧️", label: "Starker Regen" },
  66: { icon: "🌧️", label: "Gefrierender Regen" },
  67: { icon: "🌧️", label: "Starker gefrierender Regen" },
  71: { icon: "🌨️", label: "Leichter Schneefall" },
  73: { icon: "🌨️", label: "Schneefall" },
  75: { icon: "❄️", label: "Starker Schneefall" },
  77: { icon: "❄️", label: "Schneekörner" },
  80: { icon: "🌦️", label: "Leichte Schauer" },
  81: { icon: "🌧️", label: "Schauer" },
  82: { icon: "⛈️", label: "Heftige Schauer" },
  85: { icon: "🌨️", label: "Leichte Schneeschauer" },
  86: { icon: "❄️", label: "Starke Schneeschauer" },
  95: { icon: "⛈️", label: "Gewitter" },
  96: { icon: "⛈️", label: "Gewitter mit Hagel" },
  99: { icon: "⛈️", label: "Schweres Gewitter mit Hagel" },
};
function weatherInfo(code) {
  return WEATHER_CODES[code] || { icon: "🌡️", label: "" };
}
function windDirLabel(deg) {
  if (deg == null) return "";
  const dirs = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// Fasst aufeinanderfolgende Warn-Stunden desselben Typs zu einer Zeitspanne
// zusammen, statt für jede einzelne Stunde eine eigene Zeile zu zeigen.
function groupWeatherWarnings(warnings) {
  const groups = [];
  warnings.forEach((w) => {
    const last = groups[groups.length - 1];
    if (last && last.type === w.type && new Date(w.time) - new Date(last.endTime) <= 3600000) {
      last.endTime = w.time;
    } else {
      groups.push({ type: w.type, startTime: w.time, endTime: w.time });
    }
  });
  const fmt = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return groups.map((g) => {
    const icon = g.type === "gewitter" ? "⛈️" : "💨";
    const label = g.type === "gewitter" ? "Gewitter möglich" : "Starke Böen möglich";
    const range = g.startTime === g.endTime ? fmt(g.startTime) : `${fmt(g.startTime)}–${fmt(g.endTime)}`;
    return { icon, text: `${label}, ${range} Uhr` };
  });
}

// Klartext statt Stunde-für-Stunde-Prozentzahlen — 4 % Regenwahrscheinlichkeit
// ist Rauschen und niemandem eine eigene Zeile wert. Ab 30 % gilt es als
// relevant; zusammenhängende Regenstunden werden zu einem Zeitfenster zusammengefasst.
function computePrecipSummary(hourly) {
  const THRESHOLD = 30;
  if (!hourly.length) return "";

  const startIdx = hourly.findIndex((h) => (h.precip_prob || 0) >= THRESHOLD);
  if (startIdx === -1) return "☀️ Bleibt voraussichtlich trocken";

  let endIdx = startIdx;
  while (endIdx + 1 < hourly.length && (hourly[endIdx + 1].precip_prob || 0) >= THRESHOLD) {
    endIdx += 1;
  }
  const window = hourly.slice(startIdx, endIdx + 1);
  const maxProb = Math.max(...window.map((h) => h.precip_prob || 0));

  const start = new Date(hourly[startIdx].time);
  const isToday = start.toDateString() === new Date().toDateString();
  const dayPrefix = isToday ? "" : start.toLocaleDateString("de-DE", { weekday: "long" }) + ", ";
  return `🌧️ Regen ab ${dayPrefix}${start.getHours()} Uhr möglich (${Math.round(maxProb)} %)`;
}

function renderWeather(data) {
  const el = document.getElementById("weatherCard");
  if (!el) return;
  if (!data || !data.current) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");

  const cur = data.current;
  const info = weatherInfo(cur.weather_code);

  const warningsHtml = (data.warnings || []).length
    ? groupWeatherWarnings(data.warnings)
        .map((w) => `<div class="weather-warning">${w.icon} ${escapeHtml(w.text)}</div>`)
        .join("")
    : "";

  const precipSummary = computePrecipSummary(data.hourly || []);

  const dailyHtml = (data.daily || [])
    .map((d) => {
      const dInfo = weatherInfo(d.code);
      const dayLabel = new Date(d.date).toLocaleDateString("de-DE", { weekday: "short" });
      return `
        <div class="weather-day">
          <span class="weather-day-name">${dayLabel}</span>
          <span class="weather-day-icon">${dInfo.icon}</span>
          <span class="weather-day-temp">${Math.round(d.temp_max)}°/${Math.round(d.temp_min)}°</span>
        </div>
      `;
    })
    .join("");

  el.innerHTML = `
    <div class="weather-header">
      <div>
        <div class="eyebrow">Wetter am Camp</div>
        <div class="weather-now"><span class="weather-icon">${info.icon}</span><span class="weather-temp">${Math.round(cur.temperature_2m)}°</span></div>
        <div class="muted">${escapeHtml(info.label)} · Gefühlt ${Math.round(cur.apparent_temperature)}° · Luftfeuchte ${Math.round(cur.relative_humidity_2m)}%</div>
      </div>
    </div>
    ${warningsHtml}
    <p class="weather-precip-summary">${precipSummary}</p>
    <div class="weather-wind-row">💨 ${Math.round(cur.wind_speed_10m)} km/h aus ${windDirLabel(cur.wind_direction_10m)}, Böen bis ${Math.round(cur.wind_gusts_10m)} km/h</div>
    <p class="weather-subhead">Ausblick</p>
    <div class="weather-daily">${dailyHtml}</div>
  `;
}

let lastWeatherSignature = null;

async function loadWeather() {
  try {
    const res = await fetch("/api/weather");
    if (!res.ok) return;
    const data = await res.json();
    const signature = JSON.stringify(data);
    if (signature === lastWeatherSignature) return;
    lastWeatherSignature = signature;
    renderWeather(data);
  } catch (err) {
    // Netzwerkhänger ignorieren, nächster Tick versucht es erneut
  }
}

/* ---------- Dashboard: "Neu für dich" (Activity-Log-Feed) ---------- */
const activityFeedSectionEl = document.getElementById("activityFeedSection");
const activityFeedEl = document.getElementById("activityFeed");

function formatActivityTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

const ACTIVITY_ICONS = {
  task_created: "📋",
  task_done: "✅",
  expense_created: "💶",
  payment_reported: "📤",
  payment_confirmed: "📥",
};

function renderActivityItem(entry) {
  const card = document.createElement("div");
  card.className = "list-card";
  // Name im fertigen Satz einfärben: Nachricht kommt vom Server als reiner
  // Text, escapen und dann den (ebenfalls escapten) Namen gegen den farbigen
  // Tag tauschen — ersetzt nur das erste Vorkommen, das reicht hier immer.
  const messageHtml = escapeHtml(entry.message).replace(escapeHtml(entry.actor), nameTag(entry.actor));
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${ACTIVITY_ICONS[entry.action] || "•"} ${messageHtml}</p>
      <p class="list-card-meta">${formatActivityTime(entry.created_at)}</p>
    </div>
  `;
  return card;
}

let lastActivitySignature = null;

async function loadActivityFeed() {
  if (!activityFeedEl || !activityFeedSectionEl) return;
  try {
    const res = await fetch("/api/activity");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const entries = await res.json();

    const signature = JSON.stringify(entries);
    if (signature === lastActivitySignature) return;
    lastActivitySignature = signature;

    activityFeedSectionEl.classList.toggle("hidden", entries.length === 0);
    activityFeedEl.innerHTML = "";
    entries.forEach((e) => activityFeedEl.appendChild(renderActivityItem(e)));
  } catch (err) {
    // Netzwerkhänger ignorieren, nächster Tick versucht es erneut
  }
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
    ? `<span class="category-tag"><span class="category-tag-dot" style="background:${escapeHtml(task.category.farbe)}"></span>${escapeHtml(task.category.bezeichnung)}</span>`
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
      <label>Aufwand in Minuten (optional)
        <input type="number" id="taskAufwandInput" min="0" step="1" inputmode="numeric" value="${prefill.aufwand_min != null ? prefill.aufwand_min : ""}" placeholder="z. B. 30">
      </label>
      <label class="check-card">
        <input type="checkbox" id="taskRecurringInput"${prefill.recurring ? " checked" : ""}>
        🔁 Wiederkehrend — nach Abschluss erscheint automatisch eine neue, offene Kopie
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
  const assigneeValue = document.getElementById("taskAssigneeSelect").value;
  const assignee_ids = assigneeValue ? [parseInt(assigneeValue, 10)] : [];
  const deadline = document.getElementById("taskDeadlineInput").value || null;
  const aufwandRaw = document.getElementById("taskAufwandInput").value;
  const aufwand_min = aufwandRaw !== "" ? parseInt(aufwandRaw, 10) : null;
  const recurring = document.getElementById("taskRecurringInput").checked;

  const categoryResult = await resolveTaskCategoryId();
  if (!categoryResult.ok) return null;

  return {
    titel,
    beschreibung,
    assignee_ids,
    category_id: categoryResult.category_id,
    deadline,
    aufwand_min,
    recurring,
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
  // Namen bleiben hier bewusst unhighlighted — die Randfarbe des Zahlers an
  // der ganzen Kachel reicht als visuelle Zuordnung.
  const payerNames = Array.from(group.glaeubiger);
  const borderColor = NAME_COLORS[payerNames[0]];
  if (borderColor) card.style.borderLeft = `4px solid ${borderColor}`;
  const payer = payerNames.map((n) => escapeHtml(n)).join(", ");
  const breakdown = group.entries
    .map((e) => {
      const label = e.selbst ? `${escapeHtml(e.schuldner)} (eigen)` : escapeHtml(e.schuldner);
      return `${label}: ${formatEuro(e.cash)}`;
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
    groups.forEach((g) => expenseListEl.appendChild(renderExpenseGroup(g, lastExpensesIsAdmin)));
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
        title = isMe ? "Deine Ausgaben" : `Ausgaben von ${nameTag(person.username)}`;
      } else {
        title = isMe ? "Für dich ausgegeben" : `Für ${nameTag(person.username)} ausgegeben`;
      }
    }
  }

  const total = computeFilteredExpenseTotal();

  // Wenn nach einer bestimmten Person gefiltert ist: Dreisatz-Hochrechnung,
  // was das Camp insgesamt gekostet hätte, wenn ALLE (Gruppengröße) so viel
  // verbraucht/ausgegeben hätten wie diese eine Person — reine "was wäre
  // wenn"-Kennzahl, nutzt dieselbe Zeitbasis wie die Budget-Hochrechnung.
  let hypotheticalHtml = "";
  if (expenseFilterUserId !== null && cachedUsers && cachedUsers.length > 0) {
    const timeBase = projectionTimeBase();
    if (timeBase) {
      const { elapsedDays, totalProjectionDays } = timeBase;
      const personProjected = (total / elapsedDays) * totalProjectionDays;
      const hypothetical = personProjected * cachedUsers.length;
      hypotheticalHtml = `
        <div class="muted" style="margin-top:4px;">
          Wenn alle ${cachedUsers.length} so viel verbraucht hätten: ${formatEuro(hypothetical)}
        </div>
      `;
    }
  }

  myExpensesHeroEl.innerHTML = `
    <div class="eyebrow">${title}</div>
    <div class="countdown">${formatEuro(total)}</div>
    ${hypotheticalHtml}
  `;
}

// Rechenstart bewusst schon der 1. August, nicht CAMP_START (5.8.) — viele
// Ausgaben (Ausrüstung, Vorbereitung) fallen vor den eigentlichen Camp-Beginn
// und würden sonst als "vor Beginn" aus der Hochrechnung rausfallen bzw. den
// Tag-1-Wert künstlich aufblähen. Alles vor dem 1.8. zählt so, als wäre es am
// 1.8. angefallen (elapsedDays wird nie kleiner als 0).
const PROJECTION_START = new Date("2026-08-01T00:00:00");

// Für den Dreisatz gemeinsam genutzte Zeitbasis (elapsedDays/totalProjectionDays) —
// wird von der Personen-Hochrechnung im Filter-Modus verwendet.
function projectionTimeBase() {
  const totalProjectionDays = (CAMP_END - PROJECTION_START) / 86400000;
  const now = new Date();
  if (now < PROJECTION_START || totalProjectionDays <= 0) return null;
  const elapsedDays = Math.max(Math.min(now - PROJECTION_START, CAMP_END - PROJECTION_START) / 86400000, 1 / 24);
  return { elapsedDays, totalProjectionDays };
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
      return `<label class="check-card"><input type="checkbox" class="beneficiary-checkbox" value="${u.id}"${checked ? " checked" : ""}>${nameTag(u.username)}</label>`;
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

/* ---------- Kosten: Geldfluss-Diagramm (wer zahlt an wen) ---------- */
const moneyFlowCardEl = document.getElementById("moneyFlowCard");
const moneyFlowDiagramEl = document.getElementById("moneyFlowDiagram");
const FLOW_COLOR_VARS = ["--flow-1", "--flow-2", "--flow-3", "--flow-4", "--flow-5", "--flow-6", "--flow-7", "--flow-8"];

// Sankey-artiges Flussdiagramm: links Schuldner, rechts Gläubiger, Bandbreite
// = Betrag. Farbe folgt der Person (feste Namensfarbe, siehe NAME_COLORS —
// für alle anderen fällt es auf die Kategorial-Palette zurück) und bleibt auf
// beiden Seiten gleich, damit man dieselbe Person sofort wiedererkennt.
function buildMoneyFlowSvg(settlements) {
  if (settlements.length === 0) return "";
  const totalAmount = settlements.reduce((sum, s) => sum + s.amount, 0);
  if (totalAmount <= 0.005) return "";

  const LABEL_W = 92;
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
      if (NAME_COLORS[names[id]]) {
        colorOf[id] = NAME_COLORS[names[id]];
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
  const leftNodes = buildNodes("from_id");
  const rightNodes = buildNodes("to_id");

  const scaleFor = (nodes) => (TARGET_H - Math.max(0, nodes.length - 1) * GAP) / totalAmount;
  const scale = Math.max(0.01, Math.min(scaleFor(leftNodes), scaleFor(rightNodes)));

  function layout(nodes) {
    const heights = nodes.map((n) => Math.max(3, n.total * scale));
    const columnHeight = heights.reduce((a, b) => a + b, 0) + Math.max(0, nodes.length - 1) * GAP;
    const positions = {};
    let y = 0;
    nodes.forEach((n, i) => {
      positions[n.id] = { y, h: heights[i], cursor: y };
      y += heights[i] + GAP;
    });
    return { positions, columnHeight };
  }
  const left = layout(leftNodes);
  const right = layout(rightNodes);
  const plotH = Math.max(left.columnHeight, right.columnHeight);
  const leftOffset = MARGIN_Y + (plotH - left.columnHeight) / 2;
  const rightOffset = MARGIN_Y + (plotH - right.columnHeight) / 2;

  let nodesSvg = "";
  leftNodes.forEach((n) => {
    const pos = left.positions[n.id];
    const y = pos.y + leftOffset;
    nodesSvg += `<rect x="${LABEL_W}" y="${y.toFixed(1)}" width="${NODE_W}" height="${pos.h.toFixed(1)}" rx="2" fill="${colorOf[n.id]}"/>`;
    nodesSvg += `<text class="money-flow-node-label" x="${LABEL_W - 8}" y="${(y + pos.h / 2 - 3).toFixed(1)}" text-anchor="end">${escapeHtml(n.name)}</text>`;
    nodesSvg += `<text class="money-flow-node-amount" x="${LABEL_W - 8}" y="${(y + pos.h / 2 + 9).toFixed(1)}" text-anchor="end">${formatEuro(n.total)}</text>`;
  });
  rightNodes.forEach((n) => {
    const pos = right.positions[n.id];
    const y = pos.y + rightOffset;
    nodesSvg += `<rect x="${rightXStart.toFixed(1)}" y="${y.toFixed(1)}" width="${NODE_W}" height="${pos.h.toFixed(1)}" rx="2" fill="${colorOf[n.id]}"/>`;
    nodesSvg += `<text class="money-flow-node-label" x="${(VW - LABEL_W + 8).toFixed(1)}" y="${(y + pos.h / 2 - 3).toFixed(1)}" text-anchor="start">${escapeHtml(n.name)}</text>`;
    nodesSvg += `<text class="money-flow-node-amount" x="${(VW - LABEL_W + 8).toFixed(1)}" y="${(y + pos.h / 2 + 9).toFixed(1)}" text-anchor="start">${formatEuro(n.total)}</text>`;
  });

  // Größte Bänder zuerst zeichnen, damit dünnere beim Überlappen sichtbar bleiben.
  // Jedes Band bekommt seinen Betrag direkt als Label an der schmalsten Stelle
  // (Bandmitte) — damit ist im Chart selbst schon alles ablesbar, ganz ohne
  // die Liste darunter zu Rate ziehen zu müssen.
  let ribbonsSvg = "";
  let labelsSvg = "";
  settlements
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .forEach((s) => {
      const thickness = Math.max(3, s.amount * scale);
      const lp = left.positions[s.from_id];
      const rp = right.positions[s.to_id];
      const y0 = lp.cursor + leftOffset;
      const y1 = rp.cursor + rightOffset;
      lp.cursor += thickness;
      rp.cursor += thickness;
      const d = `M${leftXEnd},${y0.toFixed(1)} C${midX},${y0.toFixed(1)} ${midX},${y1.toFixed(1)} ${rightXStart},${y1.toFixed(1)} L${rightXStart},${(y1 + thickness).toFixed(1)} C${midX},${(y1 + thickness).toFixed(1)} ${midX},${(y0 + thickness).toFixed(1)} ${leftXEnd},${(y0 + thickness).toFixed(1)} Z`;
      const opacity = s.pending ? 0.28 : 0.62;
      ribbonsSvg += `<path d="${d}" fill="${colorOf[s.from_id]}" opacity="${opacity}"><title>${escapeHtml(s.from)} → ${escapeHtml(s.to)}: ${formatEuro(s.amount)}${s.pending ? " (wartet auf Bestätigung)" : ""}</title></path>`;

      const labelY = (y0 + y1) / 2 + thickness / 2;
      const pendingSuffix = s.pending ? " ⏳" : "";
      labelsSvg += `<text class="money-flow-edge-label" x="${midX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${formatEuro(s.amount)}${pendingSuffix}</text>`;
    });

  const fullH = plotH + 2 * MARGIN_Y;
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
  loadExpenses();
  loadBalance();
  loadOpenSettlements();
  loadReceivedPayments();
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
  loadActivityFeed();
  setInterval(loadActivityFeed, 5000);
  loadWeather();
  setInterval(loadWeather, 600000);
  pollCostsViews();
  setInterval(pollCostsViews, 3000);
  setInterval(checkAppVersion, 60000);
});
