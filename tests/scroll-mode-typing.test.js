'use strict';
// Regression (2026-10-15): a message sent to a pane scrolled up in tmux copy mode froze the
// whole Matrix server. With emacs mode-keys, "t" opens copy mode's jump prompt and a
// command-line `tmux send-keys` waits on it forever. Against REAL tmux: typing must return
// promptly, leave the pane out of copy mode, and deliver the text to the program.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { typeInto } = require('../server/lib/pane-stream');

let haveTmux = true;
try { execFileSync('tmux', ['-V']); } catch { haveTmux = false; }

test('typing into a scrolled-up pane returns, leaves copy mode, and delivers the text', { skip: !haveTmux && 'tmux not installed', timeout: 20000 }, async () => {
  const name = `mx-scrolltest-${process.pid}`;
  const tm = (...a) => execFileSync('tmux', a, { encoding: 'utf8' });
  tm('new-session', '-d', '-s', name, '-x', '80', '-y', '20', 'cat');
  try {
    const pane = tm('display-message', '-p', '-t', name, '#{pane_id}').trim();
    tm('set-option', '-w', '-t', pane, 'mode-keys', 'emacs');
    tm('copy-mode', '-t', pane);
    assert.equal(tm('display-message', '-p', '-t', pane, '#{pane_in_mode}').trim(), '1');
    const started = Date.now();
    await typeInto(pane, 'take file 42 png\r');
    assert.ok(Date.now() - started < 5000, 'typing returned promptly');
    assert.equal(tm('display-message', '-p', '-t', pane, '#{pane_in_mode}').trim(), '0', 'left copy mode');
    await new Promise(r => setTimeout(r, 300));
    assert.match(tm('capture-pane', '-p', '-t', pane), /take file 42 png/);
  } finally {
    try { tm('kill-session', '-t', name); } catch {}
  }
});
