// Service Worker für Web Push — wird von main.py unter /sw.js (nicht
// /static/sw.js) ausgeliefert, damit sein Scope die ganze Seite abdeckt.

self.addEventListener("install", () => {
  // Sofort aktiv werden statt auf das Schließen aller offenen Tabs zu warten
  // — passt zum bestehenden Auto-Update-Verhalten der App (siehe
  // checkAppVersion() in app.js).
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let title = "Sommercamp";
  let body = "";
  try {
    const data = event.data ? event.data.json() : {};
    if (data.title) title = data.title;
    if (data.body) body = data.body;
  } catch (err) {
    // Fallback, falls der Payload mal kein JSON ist (sollte mit push.py nicht vorkommen).
    body = event.data ? event.data.text() : "";
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/static/icons/icon-192.png",
      badge: "/static/icons/icon-192.png",
    })
  );
});

// Klick auf die Benachrichtigung: vorhandenen Tab in den Vordergrund holen
// statt immer einen neuen zu öffnen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
