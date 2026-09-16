'use strict';
// Loads server/public/sw.js in a VM with fake service-worker globals and drives its
// push/notificationclick handlers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SW_SOURCE = fs.readFileSync(path.join(__dirname, '../server/public/sw.js'), 'utf8');
const ORIGIN = 'http://matrix.local:7778';

function loadWorker({ windows = [] } = {}) {
  const listeners = {};
  const calls = { shown: [], opened: [], messages: [], focused: 0 };
  const windowClients = windows.map(url => ({
    url,
    focus() { calls.focused++; return Promise.resolve(this); },
    postMessage(msg) { calls.messages.push({ url, msg }); },
  }));
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting() {},
    registration: { showNotification: (title, opts) => { calls.shown.push({ title, opts }); return Promise.resolve(); } },
  };
  const clients = {
    matchAll: () => Promise.resolve(windowClients),
    openWindow: url => { calls.opened.push(url); return Promise.resolve(); },
  };
  vm.runInNewContext(SW_SOURCE, { self, clients, caches: {}, fetch: () => {}, URL, Promise });
  return { listeners, calls };
}

async function dispatch(listener, event) {
  let pending = Promise.resolve();
  listener({ ...event, waitUntil: p => { pending = p; } });
  await pending;
}

function clickEvent(data) {
  return { notification: { data, close() {} } };
}

test('push payload keeps the resolved target and project label', async () => {
  const { listeners, calls } = loadWorker();
  const payload = { title: 'angles-to-ads', body: 'Claude needs input', session: '49', targetSession: '49', project: 'angles-to-ads' };
  await dispatch(listeners.push, { data: { json: () => payload } });
  assert.equal(calls.shown.length, 1);
  // JSON round-trip: objects built inside the VM have a different Object prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shown[0].opts.data)), { targetSession: '49', project: 'angles-to-ads' });
  assert.equal(calls.shown[0].opts.tag, 'cr-49');
});

test('click with no open app launches the URL for that exact session', async () => {
  const { listeners, calls } = loadWorker();
  await dispatch(listeners.notificationclick, clickEvent({ targetSession: 'rpgclaw-2', project: 'rpgclaw' }));
  assert.deepEqual(calls.opened, ['/?open=rpgclaw-2']);
});

test('click with an open app focuses it and posts the same target', async () => {
  const { listeners, calls } = loadWorker({ windows: [`${ORIGIN}/`] });
  await dispatch(listeners.notificationclick, clickEvent({ targetSession: '49', project: 'angles-to-ads' }));
  assert.equal(calls.opened.length, 0);
  assert.equal(calls.focused, 1);
  assert.equal(calls.messages.length, 1);
  assert.equal(calls.messages[0].msg.type, 'open-session');
  assert.equal(calls.messages[0].msg.targetSession, '49');
});

test('unresolved or legacy notifications never carry a terminal target', async () => {
  const { listeners, calls } = loadWorker();
  await dispatch(listeners.notificationclick, clickEvent({ session: 'matrix' }));
  assert.deepEqual(calls.opened, ['/']);

  const open = loadWorker({ windows: [`${ORIGIN}/`] });
  await dispatch(open.listeners.notificationclick, clickEvent({ targetSession: '', project: 'matrix' }));
  assert.equal(open.calls.messages[0].msg.targetSession, '');
});
