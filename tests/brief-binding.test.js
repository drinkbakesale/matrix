'use strict';
// Drives the delivered brief view (server/public/matrix-brief.js) in a VM. When a session is
// opened without an explicit window, the server does not yet know which pane the stream will
// show; a brief fetched before the stream announces its target may describe a different pane
// and must never reach the screen or the editor.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { readFile } = require('./client-sources');

const SOURCE = readFile('matrix-brief.js');
const IDS = ['brief', 'brief-goal', 'brief-current', 'brief-age', 'brief-status', 'brief-body', 'brief-toggle'];

function fakeDocument() {
  const nodes = {};
  for (const id of IDS) {
    const attrs = {};
    nodes[id] = {
      id, hidden: false, className: '', textContent: '',
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k] ?? null; },
      addEventListener() {},
      replaceChildren() {},
    };
  }
  return { getElementById: id => nodes[id] || null, createElement: () => ({ addEventListener() {} }), nodes };
}

function brief(goal) {
  return { session: { name: 'A' }, goal, current: 'now', overrides: { goal: null, current: null }, revision: 1,
    status: 'ok', generatedAt: 1, evidenceAt: 1, stale: false, error: null, unavailable: null, storageError: null };
}

function load() {
  const document = fakeDocument();
  const calls = [];
  const fetch = (url, init) => new Promise(resolve => {
    calls.push({ url, method: (init && init.method) || 'GET',
      respond: b => resolve({ ok: true, status: 200, json: async () => ({ ok: true, brief: b }) }) });
  });
  const context = vm.createContext({ globalThis: null, JSON, Math, encodeURIComponent });
  context.globalThis = context;
  vm.runInContext(SOURCE, context);
  const view = context.MatrixBrief.create({ document, fetch, now: () => 1 });
  return { view, calls, document };
}

const settle = () => new Promise(r => setImmediate(r));

test('an auto-selected open sends no brief request until the stream announces its pane', async () => {
  const { view, calls, document } = load();
  view.open('A', '');
  await settle();
  assert.equal(calls.length, 0, 'no unbound request may be issued: ' + calls.map(c => c.url).join(', '));
  assert.equal(document.nodes['brief'].getAttribute('data-status'), 'loading');

  view.bindWindow('A', 'claude');
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /window=claude/);
  assert.match(calls[0].url, /bound=1/);
  calls[0].respond(brief('pane goal'));
  await settle();
  assert.equal(view.current().goal, 'pane goal');
});

test('an explicitly selected window is bound at open and fetched at once', async () => {
  const { view, calls } = load();
  view.open('A', 'shell');
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /window=shell/);
  assert.match(calls[0].url, /bound=1/);
  assert.equal(view.bindWindow('A', 'shell'), false, 'the matching announcement is not a rebinding');
});
