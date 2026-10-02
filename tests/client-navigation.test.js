'use strict';
// Drives the delivered mobile navigation code (server/public/app.js) in a VM through its
// final openTerminal/closeTerminal action. A resolved targetSession is an opaque tmux name:
// anything but an exact, case-sensitive live match must return to the project list.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { slice } = require('./client-sources');

const NAVIGATION = slice('app.js', 'async function fetchSessions()', '// ── Dismissed Sessions ──');

function loadNavigation({ failFetchTimes = 0 } = {}) {
  const state = { sessions: [], opened: null, closed: false, fetches: 0 };
  const context = vm.createContext({
    GENERIC_CONTROL_LABELS: new Set(['matrix']),
    lastSessionList: [],
    lastNotificationIntentAt: 0,
    Date,
    setTimeout,
    fetch: async () => {
      state.fetches++;
      if (state.fetches <= failFetchTimes) throw new Error('network down');
      return { json: async () => ({ sessions: state.sessions }) };
    },
    openTerminal: name => { state.opened = name; },
    closeTerminal: () => { state.closed = true; },
  });
  vm.runInContext(NAVIGATION, context);
  return { context, state };
}

async function navigate(target, live, opts) {
  const { context, state } = loadNavigation(opts);
  state.sessions = live;
  await context.openNotificationTarget(target);
  return state;
}

test('opens the exact live tmux session named by the target', async () => {
  const r = await navigate('41', [{ name: '41', projectName: 'alpha' }, { name: '52', projectName: '41' }]);
  assert.equal(r.opened, '41');
  assert.equal(r.closed, false);
});

test('a stale target equal to another session project name opens nothing', async () => {
  const r = await navigate('alpha', [{ name: '52', projectName: 'alpha' }]);
  assert.equal(r.opened, null);
  assert.equal(r.closed, true);
});

test('a stale target differing only by case opens nothing', async () => {
  const r = await navigate('ALPHA', [{ name: 'alpha', projectName: 'different-project' }]);
  assert.equal(r.opened, null);
  assert.equal(r.closed, true);
});

test('an empty target and an empty session list return to the list', async () => {
  for (const [target, live] of [['', [{ name: '41', projectName: 'alpha' }]], ['41', []]]) {
    const r = await navigate(target, live);
    assert.equal(r.opened, null);
    assert.equal(r.closed, true);
  }
});

test('a transient fetch failure retries and still opens only the exact match', async () => {
  const r = await navigate('41', [{ name: '41', projectName: 'alpha' }], { failFetchTimes: 1 });
  assert.equal(r.opened, '41');
  assert.ok(r.fetches >= 2);
});
