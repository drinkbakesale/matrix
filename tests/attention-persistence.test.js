'use strict';
// A session's "needs you" flag lasts until the user acts. Claude's idle status bar always
// shows a context meter ("████████░░ 83%"); the sweep used to read that as "busy again" and
// wipe every alert within ten seconds. This runs the real sweep against a real tmux server
// (isolated in its own TMUX_TMPDIR) whose pane shows exactly that status bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-sweep-'));
process.env.TMUX_TMPDIR = tmpdir;
delete process.env.TMUX;
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8', env: process.env });

const sessions = require('../server/lib/sessions');
const attention = require('../server/lib/attention');

test.after(() => {
  try { tmux('kill-server'); } catch { /* already gone */ }
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

test('an alert survives the sweep while the pane shows Claude\'s idle context meter', async () => {
  const meter = '  ⬆ /gsd:update │ Opus 5 │ scroll-worlds ████████░░ 83%';
  tmux('new-session', '-d', '-s', 'needs-you', '-x', '120', '-y', '20', `printf '%s\\n' '${meter}'; sleep 600`);
  await new Promise(r => setTimeout(r, 300));
  assert.match(tmux('capture-pane', '-t', '=needs-you:0', '-p'), /83%/, 'the pane shows the meter');

  sessions.resetSessionCache();
  await sessions.listLiveSessions({ maxAgeMs: 0 });   // the sweep works from the last listing
  attention.pendingAttention['needs-you'] = true;
  sessions.sweepAttention();
  await new Promise(r => setTimeout(r, 1500));         // let any capture the sweep started finish
  assert.equal(attention.pendingAttention['needs-you'], true, 'the alert is still set');
});

test('the sweep still drops alerts for sessions that no longer exist', async () => {
  attention.pendingAttention['gone-session'] = true;
  sessions.sweepAttention();
  assert.equal(attention.pendingAttention['gone-session'], undefined);
});
