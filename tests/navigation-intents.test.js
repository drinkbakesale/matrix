'use strict';
// Loads the whole delivered mobile app (server/public/app.js) in a VM with a stub DOM and
// drives its real visibilitychange and service-worker message handlers. Notification taps and
// the pending-alert auto-open can be in flight simultaneously; the winner is decided by intent
// precedence, never by which /api/sessions response happens to arrive last.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../server/public/app.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

function makeElement(id = '') {
  const el = {
    id, style: {}, dataset: {}, handlers: {}, children: [],
    textContent: '', innerHTML: '', value: '', placeholder: '',
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) { el.children.push(child); return child; },
    append(...kids) { el.children.push(...kids); },
    replaceChildren() { el.children = []; },
    remove() {}, focus() {}, blur() {},
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, width: 0, height: 0 }),
  };
  return el;
}

// Loads app.js and returns handles for driving it. `search` seeds location.search so the
// one-shot ?open= intent path can be exercised too.
function loadApp({ search = '' } = {}) {
  const elements = new Map();
  const swListeners = {};
  const routes = new Map();
  const calls = { opened: [], closed: 0 };
  const clock = { offset: 0 };

  const document = {
    hidden: false,
    handlers: {},
    body: makeElement('body'),
    activeElement: null,
    addEventListener(type, fn) { (document.handlers[type] = document.handlers[type] || []).push(fn); },
    removeEventListener() {},
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeElement(),
    createDocumentFragment: () => makeElement(),
  };

  const navigator = {
    standalone: false,
    serviceWorker: {
      register: () => Promise.resolve({ update() {} }),
      ready: Promise.resolve({
        pushManager: { getSubscription: async () => null, subscribe: async () => { throw new Error('no push'); } },
      }),
      addEventListener(type, fn) { (swListeners[type] = swListeners[type] || []).push(fn); },
    },
    mediaDevices: { getUserMedia: async () => { throw new Error('no mic'); } },
  };

  const DateStub = new Proxy(Date, {
    get(target, prop, receiver) {
      if (prop === 'now') return () => Date.now() + clock.offset;
      return Reflect.get(target, prop, receiver);
    },
  });

  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Date: DateStub,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    document, navigator,
    location: { search, pathname: '/', protocol: 'http:', host: 'localhost:7778' },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    getSelection: () => ({ rangeCount: 0, isCollapsed: true }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    EventSource: class { constructor() { this.onmessage = null; } close() {} },
    WebSocket: class { constructor() { this.readyState = 0; } send() {} close() {} },
    MediaRecorder: class { start() {} stop() {} },
    FormData: class { append() {} },
    Blob: class {},
    fetch: async (url) => {
      const target = String(url);
      for (const [key, handler] of routes) {
        if (target.includes(key)) return { ok: true, status: 200, json: async () => handler() };
      }
      return { ok: true, status: 200, json: async () => ({ sessions: [] }) };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(SOURCE, context);

  // Replace the terminal actions with recorders. app.js declares them as functions, so calls
  // inside it resolve through the global object and see these.
  context.openTerminal = name => { calls.opened.push(name); };
  context.closeTerminal = () => { calls.closed++; };

  return {
    calls, routes, clock,
    fireVisibility: () => {
      document.hidden = false;
      (document.handlers.visibilitychange || []).forEach(fn => { fn(); });
    },
    fireSwMessage: targetSession => {
      (swListeners.message || []).forEach(fn => { fn({ data: { type: 'open-session', targetSession } }); });
    },
  };
}

const LIVE = [{ name: '41', projectName: 'alpha' }, { name: '52', projectName: 'beta' }];

test('a tapped notification wins over an in-flight pending alert, whichever response lands last', async () => {
  const app = loadApp();
  const pendingSessions = deferred();
  const tapSessions = deferred();
  const queue = [pendingSessions.promise, tapSessions.promise];
  app.routes.set('/api/pending-alert', () => ({ alert: { targetSession: '52' } }));
  app.routes.set('/api/sessions', () => (queue.length ? queue.shift() : { sessions: LIVE }));

  app.fireVisibility();           // pending alert for 52 starts first
  await tick(600);                // (current code also sleeps 400ms before navigating)
  app.fireSwMessage('41');        // user taps the notification for 41
  tapSessions.resolve({ sessions: LIVE });
  await tick(80);
  assert.deepEqual(app.calls.opened, ['41'], 'tap should open 41');

  pendingSessions.resolve({ sessions: LIVE });   // stale pending response lands afterwards
  await tick(80);
  assert.deepEqual(app.calls.opened, ['41'], 'stale pending alert must not replace the tapped terminal');
});

test('a pending alert delayed past the intent window still loses to an earlier tap', async () => {
  const app = loadApp();
  const pendingAlert = deferred();
  app.routes.set('/api/pending-alert', () => pendingAlert.promise);
  app.routes.set('/api/sessions', () => ({ sessions: LIVE }));

  app.fireVisibility();           // pending-alert request issued, response withheld
  await tick(30);
  app.fireSwMessage('41');        // tap resolves immediately
  await tick(80);
  assert.deepEqual(app.calls.opened, ['41']);

  app.clock.offset = 10000;       // pending response arrives far beyond any timing window
  pendingAlert.resolve({ alert: { targetSession: '52' } });
  await tick(600);
  assert.deepEqual(app.calls.opened, ['41'], 'a late pending alert must not steal navigation');
});

test('the newest tap wins when two notification taps overlap', async () => {
  const app = loadApp();
  const firstTap = deferred();
  const queue = [firstTap.promise];
  app.routes.set('/api/sessions', () => (queue.length ? queue.shift() : { sessions: LIVE }));

  app.fireSwMessage('41');        // first tap stalls on its session fetch
  await tick(30);
  app.fireSwMessage('52');        // second tap completes
  await tick(80);
  assert.deepEqual(app.calls.opened, ['52']);

  firstTap.resolve({ sessions: LIVE });
  await tick(80);
  assert.deepEqual(app.calls.opened, ['52'], 'the superseded tap must not reopen its terminal');
});

test('an uncontested pending alert still opens its session', async () => {
  const app = loadApp();
  app.routes.set('/api/pending-alert', () => ({ alert: { targetSession: '52' } }));
  app.routes.set('/api/sessions', () => ({ sessions: LIVE }));

  app.fireVisibility();
  await tick(600);
  assert.deepEqual(app.calls.opened, ['52']);
});

test('a tap for a session that is gone returns to the list instead of another terminal', async () => {
  const app = loadApp();
  app.routes.set('/api/sessions', () => ({ sessions: [{ name: '52', projectName: 'alpha' }] }));

  app.fireSwMessage('alpha');
  await tick(80);
  assert.deepEqual(app.calls.opened, []);
  assert.ok(app.calls.closed > 0, 'should fall back to the project list');
});
