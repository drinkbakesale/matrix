'use strict';
// Drives the delivered build-inbox render code (server/public/app.js) against the real
// parser output, so a row can never show a placeholder identity and controller strings
// can never become markup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDocument, nodesByClass, textByClass } = require('./app-harness');
const { parseBuildInbox, buildInboxErrorResponse, BuildInboxError } = require('../server/lib/build-inbox');

const SOURCE = fs.readFileSync(path.join(__dirname, '../server/public/app.js'), 'utf8');
const START = 'const BUILD_INBOX_GROUPS';
const END = '// ── Text Input ──';
const IDS = ['build-inbox-status', 'build-inbox-content', 'build-inbox-view', 'list-view', 'term-view'];

function loadInboxUi({ response } = {}) {
  const start = SOURCE.indexOf(START);
  const end = SOURCE.indexOf(END, start);
  assert.ok(start >= 0 && end > start, 'build inbox render boundaries missing from app.js');
  const document = createDocument(IDS);
  const context = vm.createContext({
    document,
    Date,
    buildInboxLoading: false,
    loadSessions: () => {},
    fetch: async () => {
      if (!response) throw new Error('network down');
      return { ok: response.ok, status: response.status, json: async () => response.body };
    },
  });
  vm.runInContext(SOURCE.slice(start, end), context);
  return {
    context,
    content: document.getElementById('build-inbox-content'),
    status: document.getElementById('build-inbox-status'),
  };
}

const summary = parseBuildInbox(JSON.stringify({
  needs_you: [{ task_id: 't-1', repo: 'voc-miner', state: 'BLOCKED', updated: '31m ago', reason: 'infrastructure_failure' }],
  running: [{ task_id: 't-2', repo: 'matrix', state: 'BUILDING', updated: 'just now' }],
  finished: [{ task_id: 't-3', project: 'angles-to-ads', state: 'CANCELLED', updated: '2h ago' }],
}));

test('renders every group with its task id and project identity', () => {
  const ui = loadInboxUi();
  ui.context.renderBuildInbox({ ok: true, ...summary });

  assert.deepEqual(textByClass(ui.content, 'inbox-group-title'),
    ['Needs you (1)', 'Running (1)', 'Recently finished (1)']);
  assert.deepEqual(textByClass(ui.content, 'inbox-project'), ['voc-miner', 'matrix', 'angles-to-ads']);
  assert.deepEqual(textByClass(ui.content, 'inbox-task'), ['t-1', 't-2', 't-3']);
  assert.deepEqual(textByClass(ui.content, 'inbox-detail'), ['infrastructure_failure', 'BUILDING', 'CANCELLED']);
  assert.deepEqual(textByClass(ui.content, 'inbox-updated'), ['31m ago', 'just now', '2h ago']);
  // No row invents an identity the controller did not supply.
  assert.equal(textByClass(ui.content, 'inbox-project').filter(t => /unknown/i.test(t)).length, 0);
});

test('renders an empty state without inventing rows', () => {
  const ui = loadInboxUi();
  ui.context.renderBuildInbox({ ok: true, needsYou: [], running: [], finished: [], counts: { needsYou: 0, running: 0, finished: 0 } });
  assert.deepEqual(textByClass(ui.content, 'inbox-empty'), ['None', 'None', 'None']);
  assert.equal(nodesByClass(ui.content, 'inbox-item').length, 0);
  assert.match(ui.status.textContent, /Nothing needs you/);
  assert.equal(ui.status.className, 'build-inbox-status');
});

test('controller-derived strings stay inert text', () => {
  const hostile = parseBuildInbox(JSON.stringify({
    needs_you: [],
    running: [{ task_id: '<script>alert(1)</script>', repo: '<img src=x onerror=alert(1)>', state: '</div><b>x' }],
    finished: [],
  }));
  const ui = loadInboxUi();
  ui.context.renderBuildInbox({ ok: true, ...hostile });
  const [project] = nodesByClass(ui.content, 'inbox-project');
  assert.equal(project.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(project.children.length, 0, 'controller text must never become child elements');
  assert.equal(nodesByClass(ui.content, 'inbox-task')[0].textContent, '<script>alert(1)</script>');
});

test('a malformed-output failure renders the panel error state and clears rows', async () => {
  const err = new BuildInboxError('malformed_output', 'buildctl inbox output was not a valid summary (running[0] has no project)');
  const { status, body } = buildInboxErrorResponse(err);
  const ui = loadInboxUi({ response: { ok: false, status, body } });
  ui.context.renderBuildInbox({ ok: true, ...summary });  // stale rows are present first
  assert.equal(nodesByClass(ui.content, 'inbox-item').length, 3);

  await ui.context.loadBuildInbox();
  assert.equal(ui.content.children.length, 0, 'stale rows must be cleared on failure');
  assert.equal(ui.status.className, 'build-inbox-status error');
  assert.match(ui.status.textContent, /^Build inbox unavailable: /);
  assert.match(ui.status.textContent, /has no project/);
});

test('an unreachable server renders an error instead of throwing', async () => {
  const ui = loadInboxUi();  // fetch rejects
  await ui.context.loadBuildInbox();
  assert.equal(ui.status.className, 'build-inbox-status error');
  assert.match(ui.status.textContent, /could not reach Matrix/);
  assert.equal(ui.content.children.length, 0);
});
