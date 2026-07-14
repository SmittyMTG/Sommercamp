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

  const checkbox = card.querySelector(".list-card-checkbox");
  checkbox.addEventListener("click", async (e) => {
    e.preventDefault();
    const res = await fetch(`/api/shopping/${item.id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      item.done = data.done;
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

async function loadShoppingList() {
  try {
    const res = await fetch("/api/shopping");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const items = await res.json();

    shoppingListEl.innerHTML = "";
    if (items.length === 0) {
      shoppingListEl.innerHTML = `<div class="empty"><p>Einkaufsliste ist noch leer.</p></div>`;
    } else {
      items.forEach((item) => shoppingListEl.appendChild(renderShoppingItem(item)));
    }
    updateQuickShoppingCount();
  } catch (err) {
    shoppingListEl.innerHTML = `<div class="empty"><p>Liste konnte nicht geladen werden.</p></div>`;
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
        const item = await res.json();
        const emptyState = shoppingListEl.querySelector(".empty");
        if (emptyState) emptyState.remove();
        shoppingListEl.prepend(renderShoppingItem(item));
        updateQuickShoppingCount();
        closeModal();
      }
    },
  });
}

document.getElementById("addShoppingButton").addEventListener("click", openAddShoppingModal);

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  updateCountdown();
  setInterval(updateCountdown, 1000);
  loadShoppingList();
});
