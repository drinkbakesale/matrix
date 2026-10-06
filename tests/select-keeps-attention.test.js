'use strict';
// Opening, or switching away from, a waiting session is not answering it. The desktop used to
// dismiss the session it was leaving, which snoozed the alert and dropped the row to the
// bottom although the user had neither answered nor dismissed it.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { slice } = require('./client-sources');

const SOURCE = slice('desktop.js', 'function selectProject(', 'function connectWS(');

test('switching between sessions keeps every waiting session waiting', () => {
  const dismissed = [];
  const el = () => ({ style: {}, textContent: '', value: '', focus() {}, classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    currentSession: null, detectedPorts: [], ws: null,
    sessions: [{ name: 'A' }, { name: 'B' }],
    sessionAttention: { A: true, B: true },
    document: { getElementById: el, querySelectorAll: () => [] },
    transcript: { clear() {}, newEpoch() {} }, copyUi: null,
    briefView: { open() {}, close() {} },
    sessionLabel: s => s && s.name, renderSidebar() {}, updateChatStatus() {}, connectWS() {},
    dismissSession: name => dismissed.push(name), encodeURIComponent,
  });
  vm.runInContext(SOURCE + '\nthis.selectProject = selectProject;', context);
  context.selectProject('A');
  context.selectProject('B');
  context.selectProject('A');
  assert.deepEqual(dismissed, [], 'nothing was dismissed by looking');
  assert.deepEqual(Object.keys(context.sessionAttention).sort(), ['A', 'B'], 'both are still waiting');
});
