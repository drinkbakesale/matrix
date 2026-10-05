'use strict';
// Claude Code treats one burst of keystrokes as a paste, and a return inside that burst does
// not submit: Matrix's "message + \r" in one send-keys left messages of ~90+ characters typed
// but unsent. The text and the return must be two separate writes, in that order, with a gap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { typeInto, ENTER_GAP_MS } = require('../server/lib/pane-stream');

const decode = args => Buffer.from(args.slice(args.indexOf('-H') + 1).map(h => parseInt(h, 16))).toString();

function recorder() {
  const events = [];
  return {
    events,
    run: args => events.push({ type: 'keys', text: decode(args), target: args[args.indexOf('-t') + 1] }),
    wait: async ms => events.push({ type: 'wait', ms }),
  };
}

test('a message and its return are separate writes with a gap between them', async () => {
  const r = recorder();
  const message = 'Please refactor the session list so it builds from three tmux listings and caches them.';
  await typeInto('@4', message + '\r', r);
  assert.deepEqual(r.events, [
    { type: 'keys', text: message, target: '@4' },
    { type: 'wait', ms: ENTER_GAP_MS },
    { type: 'keys', text: '\r', target: '@4' },
  ]);
  assert.ok(ENTER_GAP_MS > 0);
});

test('keys without a trailing return, or a bare return, are one write', async () => {
  for (const data of ['\x1b[A', '\r', 'y']) {
    const r = recorder();
    await typeInto('@4', data, r);
    assert.deepEqual(r.events, [{ type: 'keys', text: data, target: '@4' }], JSON.stringify(data));
  }
});
