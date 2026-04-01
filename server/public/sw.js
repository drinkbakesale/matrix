const CACHE_VERSION = 'v5';

// Force activate immediately
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first: always fetch fresh, no caching
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});

// Web Push: show notification when received
self.addEventListener('push', (e) => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title || 'Matrix', {
      body: data.body || 'Claude needs input',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `cr-${data.session || 'default'}`,
      renotify: true,
      data: { session: data.session || '' },
    })
  );
});

// Notification click: open the app to that session
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const session = e.notification.data?.session || '';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If app is already open, focus it and navigate
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.postMessage({ type: 'open-session', session });
          return;
        }
      }
      // Otherwise open the app
      return clients.openWindow(`/?open=${encodeURIComponent(session)}`);
    })
  );
});
