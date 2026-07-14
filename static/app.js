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
  document.querySelectorAll(".nav-item").forEach((btn) => {
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

let modalSubmitHandler = null;

function openModal({ eyebrow, title, bodyHtml, onSubmit }) {
  modalEyebrow.textContent = eyebrow || "";
  modalTitle.textContent = title || "";
  modalBody.innerHTML = bodyHtml || "";
  modalSubmitHandler = onSubmit;
  modal.showModal();
  const firstInput = modalBody.querySelector("input, textarea, select");
  if (firstInput) firstInput.focus();
}

function closeModal() {
  modal.close();
  modalForm.reset();
  modalSubmitHandler = null;
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
  const row = document.createElement("div");
  row.className = "list-item" + (item.done ? " done" : "");
  row.dataset.id = item.id;
  row.innerHTML = `
    <input type="checkbox" ${item.done ? "checked" : ""} aria-label="Erledigt">
    <div class="list-item-name">${escapeHtml(item.name)}</div>
    <button type="button" class="list-item-delete" aria-label="Löschen">×</button>
  `;

  row.querySelector('input[type="checkbox"]').addEventListener("change", async () => {
    const res = await fetch(`/api/shopping/${item.id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      const data = await res.json();
      item.done = data.done;
      row.classList.toggle("done", data.done);
      updateQuickShoppingCount();
    }
  });

  row.querySelector(".list-item-delete").addEventListener("click", async () => {
    const res = await fetch(`/api/shopping/${item.id}`, { method: "DELETE" });
    if (res.ok) {
      row.remove();
      updateQuickShoppingCount();
      if (!shoppingListEl.querySelector(".list-item")) {
        shoppingListEl.innerHTML = `<div class="empty-state"><p>Einkaufsliste ist noch leer.</p></div>`;
      }
    }
  });

  return row;
}

function updateQuickShoppingCount() {
  if (!quickShoppingEl) return;
  const open = shoppingListEl.querySelectorAll(".list-item:not(.done)").length;
  quickShoppingEl.textContent = `${open} offen`;
}

async function loadShoppingList() {
  try {
    const res = await fetch("/api/shopping");
    if (!res.ok) throw new Error("Fehler beim Laden");
    const items = await res.json();

    shoppingListEl.innerHTML = "";
    if (items.length === 0) {
      shoppingListEl.innerHTML = `<div class="empty-state"><p>Einkaufsliste ist noch leer.</p></div>`;
    } else {
      items.forEach((item) => shoppingListEl.appendChild(renderShoppingItem(item)));
    }
    updateQuickShoppingCount();
  } catch (err) {
    shoppingListEl.innerHTML = `<div class="empty-state"><p>Liste konnte nicht geladen werden.</p></div>`;
  }
}

function openAddShoppingModal() {
  openModal({
    eyebrow: "Einkauf",
    title: "Artikel hinzufügen",
    bodyHtml: `
      <label>Produktname
        <input type="text" id="shoppingNameInput" placeholder="z. B. Kohle für den Grill" required>
      </label>
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
        const emptyState = shoppingListEl.querySelector(".empty-state");
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
