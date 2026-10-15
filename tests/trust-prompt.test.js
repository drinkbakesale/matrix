'use strict';
// Matrix answers Claude Code's trust dialog for sessions it starts. The cursor opens on
// "No, exit", so Enter may only be sent once the cursor is seen on the accepting option.
const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptStartupDialogs } = require('../server/lib/trust-prompt');

const dialog = cursorOnYes => [
  ' Quick safety check: Is this a project you created or one you trust?',
  cursorOnYes ? '   No, exit' : ' ❯ No, exit',
  cursorOnYes ? ' ❯ Yes, I trust this folder' : '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');
const ready = '❯ Try "fix typecheck errors"\n  ⏵⏵ bypass permissions on';

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async ms => { t += ms; } };
}

test('moves off "No, exit" before pressing Enter, then leaves the ready prompt alone', async () => {
  const keys = [];
  let screen = dialog(false);
  const tmux = {
    capture: async () => screen,
    sendKey: async (_pane, key) => {
      keys.push(key);
      if (key === 'Down') screen = dialog(true);
      if (key === 'Enter') { assert.equal(screen, dialog(true), 'Enter only with the cursor on Yes'); screen = ready; }
    },
  };
  const accepted = await acceptStartupDialogs('%1', { tmux, timeoutMs: 3000, ...fakeClock() });
  assert.deepEqual(accepted, ['Yes, I trust this folder']);
  assert.deepEqual(keys, ['Down', 'Enter']);
});

test('an already-trusted folder gets no keys at all', async () => {
  const keys = [];
  const tmux = { capture: async () => ready, sendKey: async (_p, k) => { keys.push(k); } };
  assert.deepEqual(await acceptStartupDialogs('%1', { tmux, timeoutMs: 2000, ...fakeClock() }), []);
  assert.deepEqual(keys, []);
});

test('never presses Enter if the cursor will not reach the accepting option', async () => {
  const keys = [];
  const tmux = { capture: async () => dialog(false), sendKey: async (_p, k) => { keys.push(k); } };
  await assert.rejects(acceptStartupDialogs('%1', { tmux, timeoutMs: 2000, ...fakeClock() }), /cursor never reached/);
  assert.ok(!keys.includes('Enter'));
});
