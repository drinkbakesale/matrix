'use strict';
// The stream commits only lines that have scrolled into tmux history, by exact count; the
// visible screen (Claude's spinner, input box, status bar, "Update installed" banner) is never
// committed. Counting every captured line instead saved those redrawn rows into the
// transcript repeatedly and skipped reply lines later drawn into the same rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot, planHistory } = require('../server/lib/pane-stream');

// A fake tmux answering the one chained "history_size ; capture-pane" invocation.
const fake = (history, visible) => args => {
  const start = args[args.indexOf('-S') + 1];
  const n = start === '-' ? history.length : Math.min(history.length, -parseInt(start, 10));
  return `${history.length}\n${history.slice(history.length - n).concat(visible).join('\n')}\n`;
};
const LIVE = ['✻ Pondering…', '────', '❯ ', '────', '  ⏵⏵ bypass permissions on', '   ✔ Update installed · Restart to update'];

test('new history lines are committed exactly once and the live area never is', () => {
  const before = snapshot('@1', 2000, fake(['a', 'b'], ['reply-1', 'reply-2', ...LIVE]));
  // The reply grows: reply-1..3 scroll into history; a redrawn live area is on screen.
  const after = snapshot('@1', 2000, fake(['a', 'b', 'reply-1', 'reply-2', 'reply-3'], ['reply-4', ...LIVE]));
  assert.deepEqual(planHistory(before.history, after).lines, ['reply-1', 'reply-2', 'reply-3']);
  assert.deepEqual(after.lines.slice(after.historyInCapture), ['reply-4', ...LIVE], 'the screen is everything after history');
  assert.deepEqual(planHistory(after.history, after).lines, [], 'nothing new, nothing sent');
});

test('more new history than the capture window holds asks for a resync; a cleared history sends nothing', () => {
  const big = Array.from({ length: 50 }, (_, i) => 'l' + i);
  assert.equal(planHistory(0, snapshot('@1', 10, fake(big, LIVE))).resync, true);
  assert.deepEqual(planHistory(500, snapshot('@1', 10, fake(['x'], LIVE))), { lines: [] });
});
