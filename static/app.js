// ===========================================================
// Sommercamp 2026 — Grundgerüst
// Screen-Navigation + Countdown. Datenanbindung folgt später.
// ===========================================================

const CAMP_START = new Date("2026-08-04T00:00:00");
const CAMP_END = new Date("2026-08-16T23:59:59");

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
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
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
function updateCountdown() {
  const el = document.getElementById("countdown");
  const progressEl = document.getElementById("countdownProgress");
  if (!el) return;

  const now = new Date();

  if (now >= CAMP_START && now <= CAMP_END) {
    el.innerHTML = `Läuft <small>gerade</small>`;
    if (progressEl) progressEl.style.width = "100%";
    return;
  }

  if (now > CAMP_END) {
    el.innerHTML = `Vorbei <small>🏕️</small>`;
    if (progressEl) progressEl.style.width = "100%";
    return;
  }

  const diffMs = CAMP_START - now;
  const days = Math.floor(diffMs / 86400000);
  const hours = Math.floor((diffMs % 86400000) / 3600000);
  const minutes = Math.floor((diffMs % 3600000) / 60000);

  el.innerHTML = `${days} <small>T</small> ${hours} <small>Std</small> ${minutes} <small>Min</small>`;

  if (progressEl) {
    // Fortschritt seit "heute - 60 Tage" als grobe Annäherung, rein optisch
    const windowMs = 60 * 86400000;
    const elapsed = Math.max(0, windowMs - diffMs);
    const pct = Math.min(100, Math.round((elapsed / windowMs) * 100));
    progressEl.style.width = `${pct}%`;
  }
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
}

function closeModal() {
  modal.close();
  modal.classList.remove("delete-dialog");
  modalForm.reset();
  modalSubmitHandler = null;
  modalSubmit.classList.remove("danger");
}

document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modalCancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
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

function sortShoppingItems(items, mode) {
  const arr = [...items];
  if (mode === "name") {
    arr.sort((a, b) => a.name.localeCompare(b.name, "de"));
  } else if (mode === "woher") {
    arr.sort((a, b) => {
      const an = a.woher ? a.woher.bezeichnung : "￿"; // ohne Woher ans Ende
      const bn = b.woher ? b.woher.bezeichnung : "￿";
      return an.localeCompare(bn, "de");
    });
  } else if (mode === "status") {
    arr.sort((a, b) => Number(a.done) - Number(b.done));
  }
  return arr;
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

// Fragt die Einkaufsliste jede Sekunde ab und rendert nur neu, wenn sich
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

/* ---------- Packliste (privat pro User) ---------- */
const packListEl = document.getElementById("packList");

function renderPackItem(item) {
  const card = document.createElement("div");
  card.className = "list-card" + (item.done ? " done" : "");
  card.dataset.id = item.id;

  card.innerHTML = `
    <div class="list-card-content">
      <button type="button" class="list-card-checkbox${item.done ? " checked" : ""}" aria-label="Erledigt"></button>
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(item.name)}</p>
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
    const res = await fetch(`/api/pack/${item.id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      checkbox.classList.toggle("checked", data.done);
      card.classList.toggle("done", data.done);
    }
  });

  card.querySelector(".edit-btn").addEventListener("click", () => openEditPackModal(item, card));

  card.querySelector(".delete-btn").addEventListener("click", () => {
    openModal({
      eyebrow: "Packliste",
      title: `„${item.name}" löschen?`,
      bodyHtml: `<p class="muted warning-text">Der Eintrag wird aus deiner privaten Packliste entfernt. Das lässt sich nicht rückgängig machen.</p>`,
      submitLabel: "Löschen",
      danger: true,
      onSubmit: async () => {
        const res = await fetch(`/api/pack/${item.id}`, { method: "DELETE" });
        if (res.ok) {
          card.remove();
          if (!packListEl.querySelector(".list-card")) {
            packListEl.innerHTML = `<div class="empty-state"><p>Packliste ist leer.</p></div>`;
          }
        }
        closeModal();
      },
    });
  });

  return card;
}

function renderPackListItems(items) {
  packListEl.innerHTML = "";
  if (items.length === 0) {
    packListEl.innerHTML = `<div class="empty-state"><p>Packliste ist leer.</p></div>`;
  } else {
    items.forEach((item) => packListEl.appendChild(renderPackItem(item)));
  }
}

let lastPackSignature = null;

async function loadPackList() {
  if (!packListEl) return;
  try {
    const res = await fetch("/api/pack");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const items = await res.json();
    const signature = JSON.stringify(items);
    if (signature === lastPackSignature) return;
    lastPackSignature = signature;
    renderPackListItems(items);
  } catch (err) {
    packListEl.innerHTML = `<div class="empty-state"><p>Liste konnte nicht geladen werden.</p></div>`;
  }
}

function openAddPackModal() {
  openModal({
    eyebrow: "Packliste",
    title: "Eintrag hinzufügen",
    bodyHtml: `
      <div class="form-stack">
        <label>Was fehlt noch?
          <input type="text" id="packNameInput" placeholder="z. B. Zahnbürste" required>
        </label>
      </div>
    `,
    onSubmit: async () => {
      const input = document.getElementById("packNameInput");
      const name = input.value.trim();
      if (!name) return;

      const res = await fetch("/api/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (res.ok) {
        const newItem = await res.json();
        const emptyState = packListEl.querySelector(".empty-state");
        if (emptyState) emptyState.remove();
        packListEl.prepend(renderPackItem(newItem));
        closeModal();
      }
    },
  });
}

function openEditPackModal(item, card) {
  openModal({
    eyebrow: "Packliste",
    title: "Eintrag bearbeiten",
    submitLabel: "Speichern",
    bodyHtml: `
      <div class="form-stack">
        <label>Was fehlt noch?
          <input type="text" id="packNameInput" value="${escapeHtml(item.name)}" required>
        </label>
      </div>
    `,
    onSubmit: async () => {
      const name = document.getElementById("packNameInput").value.trim();
      if (!name) return;

      const res = await fetch(`/api/pack/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (res.ok) {
        const updated = await res.json();
        item.name = updated.name;
        const titleEl = card.querySelector(".list-card-title");
        if (titleEl) titleEl.textContent = updated.name;
        closeModal();
      }
    },
  });
}

const addPackButton = document.getElementById("addPackButton");
if (addPackButton) addPackButton.addEventListener("click", openAddPackModal);

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
// Darstellung nach Datum + Betreff zu einer Kachel pro Ausgabe-Vorgang. Die DB
// selbst bleibt granular, hier wird nur zusammengefasst, was zusammengehört.
function groupExpenses(expenses) {
  const groups = new Map();
  for (const e of expenses) {
    const key = `${e.datum}|${e.betreff}`;
    if (!groups.has(key)) {
      groups.set(key, { datum: e.datum, betreff: e.betreff, glaeubiger: new Set(), total: 0, entries: [] });
    }
    const g = groups.get(key);
    g.glaeubiger.add(e.glaubiger);
    g.total += e.cash;
    g.entries.push(e);
  }
  return Array.from(groups.values());
}

function renderExpenseGroup(group) {
  const card = document.createElement("div");
  card.className = "list-card";
  const payer = Array.from(group.glaeubiger).map(escapeHtml).join(", ");
  const breakdown = group.entries
    .map((e) => {
      const label = e.selbst ? `${e.schuldner} (eigen)` : e.schuldner;
      return `${escapeHtml(label)}: ${formatEuro(e.cash)}${e.gezahlt ? " ✓" : ""}`;
    })
    .join(" · ");
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${escapeHtml(group.betreff)}</p>
      <p class="list-card-meta">${formatDate(group.datum)} · bezahlt von ${payer} · ${formatEuro(group.total)} gesamt</p>
      <p class="list-card-meta">${breakdown}</p>
    </div>
  `;
  return card;
}

let lastExpensesSignature = null;

async function loadExpenses() {
  if (!expenseListEl) return;
  try {
    const res = await fetch("/api/expenses");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const expenses = await res.json();

    // Nur bei echter Änderung neu rendern — sonst würde jedes Poll-Tick (1s)
    // z. B. offene Eingaben in dieser Ansicht unnötig zerstören.
    const signature = JSON.stringify(expenses);
    if (signature === lastExpensesSignature) return;
    lastExpensesSignature = signature;

    expenseListEl.innerHTML = "";
    if (expenses.length === 0) {
      expenseListEl.innerHTML = `<div class="empty"><p>Noch keine Einträge.</p></div>`;
    } else {
      groupExpenses(expenses).forEach((g) => expenseListEl.appendChild(renderExpenseGroup(g)));
    }
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
  } catch (err) {
    balanceHeroEl.innerHTML = `<div class="muted">Saldo konnte nicht geladen werden.</div>`;
  }
}

async function openAddExpenseModal() {
  const { users, me } = await fetchUsersAndMe();
  if (!me || users.length === 0) return;

  const payerOptions = users
    .map((u) => `<option value="${u.id}"${u.id === me.id ? " selected" : ""}>${escapeHtml(u.username)}</option>`)
    .join("");

  const beneficiaryOptions = users
    .map(
      (u) => `<label class="check-card"><input type="checkbox" value="${u.id}" checked>${escapeHtml(u.username)}</label>`
    )
    .join("");

  const today = new Date().toISOString().slice(0, 10);

  openModal({
    eyebrow: "Kosten",
    title: "Ausgabe hinzufügen",
    submitLabel: "Speichern",
    bodyHtml: `
      <div class="form-stack">
        <label>Bezahlt von
          <select id="expensePayerSelect">${payerOptions}</select>
        </label>
        <div class="checkbox-group">
          <div class="eyebrow">Für wen?</div>
          <div id="expenseBeneficiaries" class="checkbox-grid">${beneficiaryOptions}</div>
        </div>
        <label>Betrag gesamt (€)
          <input type="number" id="expenseCashInput" step="0.01" min="0.01" inputmode="decimal" placeholder="z. B. 24.50" required>
        </label>
        <label>Betreff
          <input type="text" id="expenseBetreffInput" maxlength="40" placeholder="z. B. Rewe Grillkäse" required>
        </label>
        <label>Datum
          <input type="date" id="expenseDatumInput" value="${today}" required>
        </label>
      </div>
    `,
    onSubmit: async () => {
      const glaubiger_id = parseInt(document.getElementById("expensePayerSelect").value, 10);
      const schuldner_ids = Array.from(
        document.querySelectorAll("#expenseBeneficiaries input[type=checkbox]:checked")
      ).map((el) => parseInt(el.value, 10));
      const cash = parseFloat(document.getElementById("expenseCashInput").value);
      const betreff = document.getElementById("expenseBetreffInput").value.trim();
      const datum = document.getElementById("expenseDatumInput").value;

      if (!betreff || !cash || cash <= 0 || schuldner_ids.length === 0) return;

      const res = await fetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ glaubiger_id, schuldner_ids, cash, betreff, datum }),
      });

      if (res.ok) {
        closeModal();
        loadExpenses();
        loadBalance();
      }
    },
  });
}

const addExpenseButton = document.getElementById("addExpenseButton");
if (addExpenseButton) addExpenseButton.addEventListener("click", openAddExpenseModal);

/* ---------- Kosten: Ansicht wechseln ---------- */
const costsViewSelect = document.getElementById("costsViewSelect");
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
  if (view === "leaderboard") loadLeaderboard();
}

if (costsViewSelect) {
  costsViewSelect.addEventListener("change", () => switchCostsView(costsViewSelect.value));
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
        Damit bestätigst du, dass du <strong>${formatEuro(s.amount)}</strong> an <strong>${escapeHtml(s.to)}</strong>
        überwiesen hast. ${escapeHtml(s.to)} sieht das jetzt hier in der App und muss den Empfang bestätigen —
        sobald das passiert, siehst auch du es hier und die Schuld gilt als beglichen.
      </p>
      <p id="settleModalError" class="error-text hidden"></p>
    `,
    onSubmit: async () => {
      const res = await fetch("/api/expenses/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to_id: s.to_id }),
      });
      if (res.ok) {
        closeModal();
        loadOpenSettlements();
        loadBalance();
      } else {
        const data = await res.json().catch(() => ({}));
        const errEl = document.getElementById("settleModalError");
        if (errEl) {
          errEl.textContent = data.error || "Konnte nicht bestätigt werden.";
          errEl.classList.remove("hidden");
        }
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

    // Wichtig: ohne diesen Vergleich würde das 1-Sekunden-Polling das Eingabefeld
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
const leaderboardListEl = document.getElementById("leaderboardList");

function renderLeaderboardItem(entry, rank, isLast) {
  const card = document.createElement("div");
  card.className = "list-card";
  const badgeClass = rank === 1 ? "top" : isLast ? "bottom" : "";
  card.innerHTML = `
    <div class="list-card-content">
      <div class="rank-badge ${badgeClass}">${rank}</div>
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(entry.username)}</p>
      </div>
    </div>
    <p class="list-card-value">${formatEuro(entry.total)}</p>
  `;
  return card;
}

let lastLeaderboardSignature = null;

async function loadLeaderboard() {
  if (!leaderboardListEl) return;
  try {
    const res = await fetch("/api/expenses/leaderboard");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const ranking = await res.json();

    const signature = JSON.stringify(ranking);
    if (signature === lastLeaderboardSignature) return;
    lastLeaderboardSignature = signature;

    leaderboardListEl.innerHTML = "";
    if (ranking.length === 0) {
      leaderboardListEl.innerHTML = `<div class="empty"><p>Noch keine Daten.</p></div>`;
    } else {
      ranking.forEach((entry, idx) => {
        const isLast = idx === ranking.length - 1 && ranking.length > 1;
        leaderboardListEl.appendChild(renderLeaderboardItem(entry, idx + 1, isLast));
      });
    }
  } catch (err) {
    leaderboardListEl.innerHTML = `<div class="empty"><p>Leaderboard konnte nicht geladen werden.</p></div>`;
  }
}

/* ---------- Kosten: alles alle 1 Sekunde aktualisieren ---------- */
// Läuft unabhängig davon, welche Unteransicht gerade sichtbar ist (gleiches
// Prinzip wie beim Einkaufslisten-Polling) — so ist z. B. sofort sichtbar,
// wenn jemand anderes eine Zahlung bestätigt, ohne dass neu eingeloggt werden muss.
function pollCostsViews() {
  loadBalance();
  loadExpenses();
  loadOpenSettlements();
  loadReceivedPayments();
  loadLeaderboard();
}

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  updateCountdown();
  setInterval(updateCountdown, 30000); // keine Sekundenanzeige mehr, reicht alle 30s
  loadShoppingList();
  setInterval(pollShoppingList, 1000);
  loadPackList();
  setInterval(loadPackList, 1000);
  loadPlanList();
  setInterval(loadPlanList, 1000);
  pollCostsViews();
  setInterval(pollCostsViews, 1000);
});
