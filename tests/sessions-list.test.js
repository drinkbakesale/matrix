'use strict';
// The session list is built from three whole-server tmux listings, whatever the number of
// sessions, and concurrent requests share one listing. The previous form ran three shell
// commands per session synchronously, which froze the server for seconds with ~80 sessions.
const test = require('node:test');
const assert = require('node:assert/strict');
const sessions = require('../server/lib/sessions');
const attention = require('../server/lib/attention');

const T = '\t';
function fakeTmux(count) {
  const calls = [];
  const run = async args => {
    calls.push(args.slice(0, 2).join(' '));
    const names = Array.from({ length: count }, (_, i) => `s${i}`);
    if (args[0] === 'list-sessions') {
      return names.map((n, i) => [n, '2', '0', '/tmp', String(1000 + i), `$${i}`, '1', i === 0 ? 'alpha' : ''].join(T)).join('\n');
    }
    if (args[0] === 'list-windows') {
      return names.flatMap(n => [[n, '0', 'claude', '1'].join(T), [n, '1', 'shell', '0'].join(T)]).join('\n');
    }
    if (args[0] === 'list-panes') {
      return names.flatMap(n => [[n, 'zsh', '/tmp/shell', 'sh'].join(T), [n, '2.1.289', '/tmp/work', 'topic'].join(T)]).join('\n');
    }
    throw new Error('unexpected tmux call ' + args.join(' '));
  };
  return { run, calls };
}

test('three tmux listings build every session, however many there are', async () => {
  sessions.resetSessionCache();
  const { run, calls } = fakeTmux(80);
  const list = await sessions.listLiveSessions({ run, maxAgeMs: 0 });
  assert.equal(list.length, 80);
  assert.deepEqual(calls.sort(), ['list-panes -a', 'list-sessions -F', 'list-windows -a']);
  const s0 = list.find(s => s.name === 's0');
  assert.equal(s0.projectName, 'alpha', '@matrix_project comes from the session listing');
  assert.equal(s0.claudeRunning, true);
  assert.equal(s0.path, '/tmp/work', 'the Claude pane, not the first pane, gives the path');
  assert.deepEqual(s0.windowList.map(w => w.name), ['claude', 'shell']);
});

test('concurrent requests share one listing and attention is applied when served', async () => {
  sessions.resetSessionCache();
  const { run, calls } = fakeTmux(5);
  const [a, b] = await Promise.all([
    sessions.listLiveSessions({ run, maxAgeMs: 0 }),
    sessions.listLiveSessions({ run, maxAgeMs: 0 }),
  ]);
  assert.equal(calls.length, 3, 'one listing for two concurrent callers');
  assert.equal(a.length, b.length);
  attention.pendingAttention.s3 = true;
  try {
    const served = await sessions.listLiveSessions({ run, maxAgeMs: 60000 });
    assert.equal(calls.length, 3, 'a fresh listing is reused');
    assert.equal(served[0].name, 's3', 'a session needing attention is served first');
    assert.equal(served[0].needsAttention, true);
  } finally {
    delete attention.pendingAttention.s3;
  }
});

test('no tmux server is an empty list; any other tmux failure is an error', async () => {
  sessions.resetSessionCache();
  const none = async () => { const e = new Error('x'); e.stderr = 'no server running on /tmp/tmux-501/default'; throw e; };
  assert.deepEqual(await sessions.listLiveSessions({ run: none, maxAgeMs: 0 }), []);
  sessions.resetSessionCache();
  const broken = async () => { throw new Error('tmux: permission denied'); };
  await assert.rejects(sessions.listLiveSessions({ run: broken, maxAgeMs: 0 }), /permission denied/);
});
