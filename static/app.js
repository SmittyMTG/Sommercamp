// ===========================================================
// Sommercamp 2026 — Grundgerüst
// Screen-Navigation + Countdown. Datenanbindung folgt später.
// ===========================================================

const CAMP_START = new Date("2026-08-04T00:00:00");
const CAMP_END = new Date("2026-08-16T23:59:59");

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
  const seconds = Math.floor((diffMs % 60000) / 1000);

  el.innerHTML = `${days}<small>T</small> ${hours}<small>Std</small> ${minutes}<small>Min</small> ${seconds}<small>Sek</small>`;

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
  
  card.innerHTML = `
    <div class="list-card-content">
      <button type="button" class="list-card-checkbox${item.done ? " checked" : ""}" aria-label="Erledigt"></button>
      <div class="list-card-text">
        <p class="list-card-title">${escapeHtml(item.name)}</p>
      </div>
    </div>
    <div class="list-card-actions">
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

function renderShoppingListItems(items) {
  shoppingListEl.innerHTML = "";
  if (items.length === 0) {
    shoppingListEl.innerHTML = `<div class="empty"><p>Einkaufsliste ist noch leer.</p></div>`;
  } else {
    items.forEach((item) => shoppingListEl.appendChild(renderShoppingItem(item)));
  }
  updateQuickShoppingCount();
}

let lastShoppingSignature = null;

async function loadShoppingList() {
  try {
    const res = await fetch("/api/shopping");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const items = await res.json();
    lastShoppingSignature = JSON.stringify(items);
    renderShoppingListItems(items);
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
    renderShoppingListItems(items);
  } catch (err) {
    // Netzwerkhänger ignorieren, nächster Tick versucht es erneut
  }
}

function openAddShoppingModal() {
  openModal({
    eyebrow: "Einkauf",
    title: "Artikel hinzufügen",
    bodyHtml: `
      <div class="form-stack">
        <label>Produktname
          <input type="text" id="shoppingNameInput" placeholder="z. B. Kohle für den Grill" required>
        </label>
      </div>
    `,
    onSubmit: async () => {
      const input = document.getElementById("shoppingNameInput");
      const name = input.value.trim();
      if (!name) return;

      const res = await fetch("/api/shopping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (res.ok) {
        const newItem = await res.json();
        const emptyState = shoppingListEl.querySelector(".empty");
        if (emptyState) emptyState.remove();
        if (!shoppingListEl.querySelector(`[data-id="${newItem.id}"]`)) {
          shoppingListEl.prepend(renderShoppingItem(newItem));
          updateQuickShoppingCount();
        }
        closeModal();
      }
    },
  });
}

document.getElementById("addShoppingButton").addEventListener("click", openAddShoppingModal);

/* ---------- Kosten & Schulden ---------- */
const balanceHeroEl = document.getElementById("balanceHero");
const expenseListEl = document.getElementById("expenseList");

let cachedUsers = null;
let cachedMe = null;

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

async function loadExpenses() {
  if (!expenseListEl) return;
  try {
    const res = await fetch("/api/expenses");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const expenses = await res.json();

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

async function loadBalance() {
  if (!balanceHeroEl) return;
  try {
    const res = await fetch("/api/expenses/balance");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const balance = await res.json();

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
  card.innerHTML = `
    <div class="list-card-text">
      <p class="list-card-title">${escapeHtml(s.from)} → ${escapeHtml(s.to)}</p>
      <p class="list-card-meta">${formatEuro(s.amount)}</p>
    </div>
    ${isMine ? `<div class="list-card-actions"><button type="button" class="tiny settle-btn">Als bezahlt markieren</button></div>` : ""}
  `;
  if (isMine) {
    card.querySelector(".settle-btn").addEventListener("click", () => openConfirmSettleModal(s));
  }
  return card;
}

async function loadOpenSettlements() {
  if (!openSettlementsListEl) return;
  try {
    const { me } = await fetchUsersAndMe();
    const res = await fetch("/api/expenses/open");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const settlements = await res.json();

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
        <input type="number" step="0.01" min="0.01" inputmode="decimal" class="received-amount-input" placeholder="z. B. ${r.amount.toFixed(2)}">
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

async function loadReceivedPayments() {
  if (!receivedListEl) return;
  try {
    const res = await fetch("/api/expenses/received");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const received = await res.json();

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

async function loadLeaderboard() {
  if (!leaderboardListEl) return;
  try {
    const res = await fetch("/api/expenses/leaderboard");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const ranking = await res.json();

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

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  updateCountdown();
  setInterval(updateCountdown, 1000);
  loadShoppingList();
  setInterval(pollShoppingList, 1000);
  loadExpenses();
  loadBalance();
});
