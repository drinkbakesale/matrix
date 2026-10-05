'use strict';
// Notification intake, Web Push fan-out, SSE toasts, attention and tmux input.
//
// Exact-target routing is the contract clients depend on: a notification only ever carries
// a server-resolved tmux session, and an unresolved alert carries none so no client opens
// somebody else's terminal. Extracted from server.js with no behaviour change.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const webpush = require('web-push');
const { cleanLabel } = require('./session-identity');
const { VAPID_PATH, SUBS_PATH } = require('./matrix-config');
const attention = require('./attention');
const { resolveLiveNotificationTarget } = require('./sessions');

// VAPID "sub" must be a valid mailto:/https: URI with a routable domain — Apple Push
// Services rejects localhost/non-routable domains with 403 BadJwtToken.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:matrix@example.com';

const sseClients = new Set();
let pendingAlerts = [];
let vapid = null;
let pushSubscriptions = [];

function loadVapid() {
  try {
    vapid = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
    webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);
  } catch {
    console.warn(`[web-push] Could not load VAPID keys from ${VAPID_PATH}`);
    console.warn('[web-push] Run "npm run setup" to generate VAPID keys, or create vapid.json manually.');
    console.warn('[web-push] Push notifications will be disabled until vapid.json exists.');
  }
  try { pushSubscriptions = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8')); } catch {}
  return vapid;
}

function saveSubs() {
  try {
    fs.mkdirSync(path.dirname(SUBS_PATH), { recursive: true });
    fs.writeFileSync(SUBS_PATH, JSON.stringify(pushSubscriptions));
  } catch (err) {
    console.error('[push] failed to save subscriptions:', err.message);
  }
}

// targetSession is the resolved tmux session ('' when none); project is the human label.
async function sendPush(title, body, targetSession, project) {
  if (!vapid) return; // Push not configured
  const payload = JSON.stringify({ title, body, session: targetSession, targetSession, project });
  const dead = [];
  for (let i = 0; i < pushSubscriptions.length; i++) {
    try {
      await webpush.sendNotification(pushSubscriptions[i], payload);
      console.log(`[push] sent to sub ${i}`);
    } catch (err) {
      const detail = err.statusCode || err.message || err.code || err.name || String(err);
      console.error(`[push] failed sub ${i}: ${detail}`, err.body || '');
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(i);
    }
  }
  if (dead.length) {
    pushSubscriptions = pushSubscriptions.filter((_, i) => !dead.includes(i));
    saveSubs();
  }
}

function broadcast(notification) {
  const payload = `data: ${JSON.stringify(notification)}\n\n`;
  for (const client of sseClients) client.write(payload);
  return sseClients.size;
}

function mount(app) {
  app.get('/api/notifications/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.get('/api/push/vapid-key', (req, res) => {
    if (!vapid) return res.status(503).json({ error: 'VAPID keys not configured. Run npm run setup.' });
    res.json({ publicKey: vapid.publicKey });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
    if (!pushSubscriptions.find(s => s.endpoint === sub.endpoint)) {
      pushSubscriptions.push(sub);
      saveSubs();
    }
    res.json({ ok: true });
  });

  // The hook sends a project/session label and (newer hooks) its own tmux session. Resolve
  // that to one live tmux session; when nothing resolves, deliver the alert with no target.
  app.post('/api/notify', async (req, res) => {
    const body = req.body || {};
    const msg = typeof body.message === 'string' && body.message ? body.message : 'Claude needs input';

    // Ignore the "how is Claude doing" session check — not a real question
    if (/how is claude/i.test(msg)) return res.json({ ok: true, ignored: true });

    const target = await resolveLiveNotificationTarget({
      tmuxSession: body.tmuxSession, session: body.session, project: body.project,
    });
    const targetSession = target.targetSession || '';
    const projectLabel = target.projectName || cleanLabel(body.project) || cleanLabel(body.session) || 'Matrix';
    const dismissKey = targetSession || cleanLabel(body.session) || cleanLabel(body.project);

    // '*' suppresses everything; a specific message suppresses only that exact repeat.
    const dismissedMsg = attention.dismissedUntilChange[dismissKey];
    if (dismissedMsg && (dismissedMsg === '*' || dismissedMsg === msg)) {
      return res.json({ ok: true, suppressed: true });
    }
    delete attention.dismissedUntilChange[dismissKey];

    const notification = {
      type: 'notification', message: msg, project: projectLabel,
      session: targetSession, targetSession, timestamp: Date.now(),
    };
    pendingAlerts.push({ session: targetSession, targetSession, project: projectLabel, message: msg, timestamp: Date.now() });
    if (targetSession) {
      attention.pendingAttention[targetSession] = true;
      attention.lastSeenQuestions[targetSession] = msg;
    }
    const delivered = broadcast(notification);
    sendPush(projectLabel, msg, targetSession, projectLabel);
    res.json({
      ok: true, delivered, pushSubs: pushSubscriptions.length,
      targetSession: targetSession || null, via: target.via,
    });
  });

  app.get('/api/pending-alert', (req, res) => {
    if (pendingAlerts.length === 0) return res.json({ alert: null });
    const latest = pendingAlerts[pendingAlerts.length - 1];
    pendingAlerts = [];
    res.json({ alert: latest });
  });

  app.post('/api/test-notify', (req, res) => {
    const delivered = broadcast({
      type: 'notification', message: req.body.message || 'Test notification from Matrix',
      project: 'test', session: '', targetSession: '', timestamp: Date.now(),
    });
    res.json({ ok: true, delivered });
  });

  app.post('/api/dismiss', (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ error: 'session required' });
    attention.dismissSession(session);
    res.json({ ok: true });
  });

  app.post('/api/send', (req, res) => {
    const { session, text } = req.body;
    if (!session || !text) return res.status(400).json({ error: 'session and text required' });
    try {
      execSync(`tmux send-keys -t '${session}' ${JSON.stringify(text)} Enter`);
      attention.clearForSession(session);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { mount, loadVapid, sseClients, hasVapid: () => !!vapid };
