const CACHE_VERSION = 'v6';

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
  let data = {};
  try { data = e.data.json() || {}; } catch {}
  // targetSession is the tmux session the server resolved ('' when none could be resolved).
  const targetSession = typeof data.targetSession === 'string' ? data.targetSession : '';
  e.waitUntil(
    self.registration.showNotification(data.title || 'Matrix', {
      body: data.body || 'Claude needs input',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `cr-${targetSession || 'default'}`,
      renotify: true,
      data: { targetSession, project: typeof data.project === 'string' ? data.project : '' },
    })
  );
});

// URL the app consumes on launch; no target means the plain project list.
function notificationUrl(targetSession) {
  return targetSession ? `/?open=${encodeURIComponent(targetSession)}` : '/';
}

// Notification click: open the app to that exact session
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  // Only a server-resolved target may open a terminal. Older notifications carried a project
  // label in `session`, which is what used to open the wrong project.
  const targetSession = typeof data.targetSession === 'string' ? data.targetSession : '';
  const message = { type: 'open-session', targetSession, session: targetSession, project: data.project || '' };

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If app is already open, focus it and hand it the same target
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin) {
          return Promise.resolve(client.focus ? client.focus() : client)
            .catch(() => client)
            .then(focused => (focused || client).postMessage(message));
        }
      }
      // Otherwise open the app with the target encoded in the URL
      return clients.openWindow(notificationUrl(targetSession));
    })
  );
});
