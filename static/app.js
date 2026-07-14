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

/* ---------- Init ---------- */
document.addEventListener("DOMContentLoaded", () => {
  initNavigation();
  updateCountdown();
  setInterval(updateCountdown, 1000);
});
