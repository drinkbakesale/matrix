// Mobile notifications: SSE toasts, Web Push subscription, and the permission banner.
// Extracted from app.js; behaviour unchanged.

let notifSource = null;

function setupNotifications() {
  // SSE for in-app toasts
  notifSource = new EventSource('/api/notifications/stream');
  notifSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type !== 'notification') return;
      showToast(data);
    } catch {}
  };

  // Subscribe to Web Push
  subscribeToPush();
}

async function subscribeToPush() {
  const dbg = document.getElementById('push-debug');
  function setDebug(msg) { if (dbg) { dbg.textContent = msg; dbg.style.display = msg ? 'block' : 'none'; } }

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setDebug(`No push: SW=${'serviceWorker' in navigator} PM=${'PushManager' in window}`);
    return false;
  }
  try {
    setDebug(`Perm state: ${Notification.permission}, trying subscribe anyway...`);
    // Don't re-request permission — iOS can return 'denied' even when Settings says allowed
    setDebug('Waiting for SW ready...');
    const reg = await navigator.serviceWorker.ready;
    setDebug('Getting subscription...');
    let sub = await reg.pushManager.getSubscription();
    // Always unsubscribe and resubscribe to ensure VAPID key match
    if (sub) {
      setDebug('Clearing old subscription...');
      await sub.unsubscribe();
    }
    setDebug('Fetching VAPID key...');
    const res = await fetch('/api/push/vapid-key');
    const json = await res.json();
    const publicKey = json.publicKey;
    if (!publicKey) {
      setDebug('VAPID key not configured — run "npm run setup"');
      return false;
    }
    setDebug('Subscribing to push...');
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    setDebug('Registering with server...');
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    setDebug('Push active!');
    setTimeout(() => { if (dbg) dbg.style.display = 'none'; }, 3000);
    return true;
  } catch (err) {
    setDebug(`Error: ${err.message}`);
    return false;
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function showToast(data) {
  if (!currentSession) loadSessions();
  const targetSession = typeof data.targetSession === 'string' ? data.targetSession : '';
  if (targetSession && currentSession === targetSession) return;
  document.querySelector('.notification-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'notification-toast';
  toast.innerHTML = `
    <div class="toast-dot"></div>
    <div class="toast-content">
      <div class="toast-project">${escapeHtml(data.project)}</div>
      <div class="toast-message">${escapeHtml(data.message)}</div>
    </div>
    <div class="toast-action">Open</div>
    <button type="button" class="toast-close" aria-label="Dismiss">×</button>`;
  toast.dataset.session = targetSession;
  toast.querySelector('.toast-close').addEventListener('click', e => {
    e.stopPropagation();
    toast.remove();
  });
  toast.addEventListener('click', () => {
    toast.remove();
    openNotificationTarget(targetSession);
  });
  // No timer: it stays until the user opens the session, dismisses it, or answers it.
  document.body.appendChild(toast);
}

// Called with each fresh session list: a pop-up whose session no longer needs the user goes.
function syncToastWithSessions(sessions) {
  const toast = document.querySelector('.notification-toast');
  if (!toast || !toast.dataset.session) return;
  const s = (sessions || []).find(x => x.name === toast.dataset.session);
  if (!s || !s.needsAttention) toast.remove();
}

// ── Notification Permission Banner ──

async function checkNotificationBanner() {
  const banner = document.getElementById('push-setup');
  if (!banner) return;

  const isStandalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

  // Wait for SW to be ready before checking push support (iOS needs this)
  let hasPush = 'PushManager' in window;
  const hasSW = 'serviceWorker' in navigator;
  if (hasSW && !hasPush) {
    try {
      await navigator.serviceWorker.ready;
      hasPush = 'PushManager' in window;
    } catch {}
  }

  const hasNotif = 'Notification' in window;

  if (hasNotif && hasPush && Notification.permission === 'granted') {
    banner.style.display = 'none';
    subscribeToPush();
    return;
  }

  banner.style.display = 'block';
  const span = banner.querySelector('span');
  const btn = document.getElementById('push-enable-btn');

  if (!isStandalone) {
    span.textContent = 'Add to Home Screen first, then open from there to enable notifications';
    btn.textContent = 'OK';
    btn.onclick = () => { banner.style.display = 'none'; };
  } else if (!hasNotif || !hasPush) {
    // Web push needs HTTPS — ntfy handles notifications, just hide the banner
    banner.style.display = 'none';
    return;
  } else if (Notification.permission === 'denied') {
    span.textContent = 'Notifications blocked — go to Settings > this app to re-enable';
    btn.style.display = 'none';
  } else {
    span.textContent = 'Enable notifications to know when projects need input';
  }
}

async function enableNotifications() {
  const banner = document.getElementById('push-setup');
  const ok = await subscribeToPush();
  if (ok) {
    banner.style.display = 'none';
    // Send a test to confirm it works
    fetch('/api/test-notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Notifications enabled!' }),
    });
  } else {
    banner.innerHTML = '<span>Could not enable notifications. Open from Home Screen as PWA.</span>';
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => reg.update());
  // Handle notification click on an already-open app → open that exact session.
  // Only the server-resolved targetSession is trusted; without one, show the project list.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open-session') return;
    openNotificationTarget(typeof e.data.targetSession === 'string' ? e.data.targetSession : '');
  });
  // Show setup button if permission not yet granted, auto-subscribe if already granted
  const isStandalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const pushSetup = document.getElementById('push-setup');
  if (isStandalone && 'PushManager' in window) {
    // Always try to subscribe — iOS permission state can be unreliable
    subscribeToPush().then(ok => {
      if (!ok && pushSetup) pushSetup.style.display = 'block';
    });
    if (Notification.permission === 'default' && pushSetup) {
      pushSetup.style.display = 'block';
      document.getElementById('push-enable-btn').addEventListener('click', async () => {
        const btn = document.getElementById('push-enable-btn');
        try {
          btn.textContent = 'Requesting permission...';
          const perm = await Notification.requestPermission();
          if (perm === 'granted') {
            btn.textContent = 'Subscribing...';
            const ok = await subscribeToPush();
            if (ok) {
              pushSetup.style.display = 'none';
            } else {
              btn.textContent = 'Subscribe failed — tap to retry';
              btn.style.background = 'var(--amber)';
            }
          } else {
            btn.textContent = `Permission: ${perm} — Check Settings`;
            btn.style.background = 'var(--dim)';
          }
        } catch (err) {
          btn.textContent = `Error: ${err.message}`;
          btn.style.background = 'var(--red)';
        }
      });
    }
  }
}
