// Service worker for the Matrix Control app. Scope: /control/ only.
// It caches nothing: Control never shows data it did not just receive.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { return; }
  if (!data || typeof data.event_id !== 'string') return;
  e.waitUntil(self.registration.showNotification(String(data.title || 'Matrix'), {
    body: String(data.body || ''),
    icon: '../icon-192.png',
    tag: data.tag || data.event_id, // a provider retry replaces the same notification
    data: { target: typeof data.target === 'string' ? data.target : '', event_id: data.event_id },
  }));
});

const inScope = (url) => new URL(url).pathname.startsWith(new URL(self.registration.scope).pathname);

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.target) || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const own = list.find((c) => inScope(c.url)); // never a phone/desktop Matrix window
    if (own) {
      return Promise.resolve(own.focus ? own.focus() : own).catch(() => own).then((c) => (c || own).postMessage({ type: 'control-open-session', target }));
    }
    return self.clients.openWindow(`${self.registration.scope}?session=${encodeURIComponent(target)}`);
  }));
});
