// firebase-messaging-sw.js
//
// Must live at the site's ROOT (same place as index.html) — service workers
// only control pages at or below the folder they're served from.
//
// Handles push notifications that arrive while nobody has the site open
// (background/closed tab). A message that arrives while someone IS looking
// at the app is handled in-page instead (via onMessage in firebase-init.js
// consumers), so it can show as an in-app toast instead of a duplicate OS
// popup — not wired up yet since there's no messaging UI to toast into.

importScripts("https://www.gstatic.com/firebasejs/12.18.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging-compat.js");

// Same public config as firebase-init.js — keep in sync if the project ever changes.
firebase.initializeApp({
  apiKey: "AIzaSyCAXlbDG9HupA9njhcH0-_yWNtFFgugQO4",
  authDomain: "dw-app-2beee.firebaseapp.com",
  projectId: "dw-app-2beee",
  storageBucket: "dw-app-2beee.firebasestorage.app",
  messagingSenderId: "653844931615",
  appId: "1:653844931615:web:b5691989aaf8bc81daa12a",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  if (!title) return; // data-only message, nothing to show
  self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png", // TODO: doesn't exist yet — add an app icon set
    data: payload.data,
  });
});

// Clicking the notification focuses an existing tab if one's open, instead
// of always spawning a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.click_action || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
