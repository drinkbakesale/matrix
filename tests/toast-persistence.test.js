'use strict';
// The phone's "needs your input" pop-up (server/public/app-notifications.js) stays until the
// user acts: it has no timer, it closes from its own × or by opening the session, and it goes
// away once a fresh session list shows the session no longer needs them.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { slice } = require('./client-sources');

const SOURCE = slice('app-notifications.js', 'function showToast(', '// ── Notification Permission Banner');

function element(className) {
  const listeners = {};
  const node = {
    className, dataset: {}, children: [], parent: null,
    set innerHTML(html) {
      node.children = [...String(html).matchAll(/class="([^"]+)"/g)].map(m => {
        const child = element(m[1]); child.parent = node; return child;
      });
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    click() { for (const fn of listeners.click || []) fn({ stopPropagation() { node.stopped = true; } }); },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      const walk = n => n.children.flatMap(c => [c, ...walk(c)]);
      return walk(node).find(c => c.className.split(/\s+/).includes(cls)) || null;
    },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node); node.parent = null; },
  };
  return node;
}

function load() {
  const body = element('body');
  const timers = [];
  const opened = [];
  const document = {
    body,
    createElement: () => element(''),
    querySelector: sel => body.querySelector(sel),
  };
  body.appendChild = child => { child.parent = body; body.children.push(child); };
  const context = vm.createContext({
    document,
    currentSession: 'other',
    loadSessions() {},
    escapeHtml: s => String(s),
    openNotificationTarget: s => opened.push(s),
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; },
  });
  vm.runInContext(SOURCE, context);
  return { context, body, timers, opened, toast: () => body.querySelector('.notification-toast') };
}

const alert = { project: 'angles-to-ads', message: 'Claude needs your permission', targetSession: '143' };

test('the pop-up sets no timer and stays until the user acts', () => {
  const { context, timers, toast } = load();
  context.showToast(alert);
  assert.ok(toast(), 'shown');
  assert.deepEqual(timers, [], 'no auto-dismiss timer');
  context.syncToastWithSessions([{ name: '143', needsAttention: true }]);
  assert.ok(toast(), 'still shown while the session needs the user');
});

test('its × dismisses it without opening the session', () => {
  const { context, toast, opened } = load();
  context.showToast(alert);
  toast().querySelector('.toast-close').click();
  assert.equal(toast(), null);
  assert.deepEqual(opened, []);
});

test('it goes once the session no longer needs the user, or no longer exists', () => {
  for (const list of [[{ name: '143', needsAttention: false }], []]) {
    const { context, toast } = load();
    context.showToast(alert);
    context.syncToastWithSessions(list);
    assert.equal(toast(), null);
  }
});

test('tapping it opens the session', () => {
  const { context, toast, opened } = load();
  context.showToast(alert);
  toast().click();
  assert.equal(toast(), null);
  assert.deepEqual(opened, ['143']);
});
