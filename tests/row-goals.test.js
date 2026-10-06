'use strict';
// Each row's second line is the goal from the session's latest Claude Code recap, re-read only
// when the transcript has grown, and absent (so the row falls back) when there is no recap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRowGoals } = require('../server/lib/row-goals');

test('goal comes from the recap, is re-read only on growth, and is dropped with the session', () => {
  let size = 100; let reads = 0;
  let recap = { text: 'Goal: ship the Matrix two-line rows. Tests are passing.' };
  const g = createRowGoals({
    linksDir: '/none',
    readLink: name => (name === 'gone-later' || name === '142' ? { transcriptPath: '/t/' + name } : null),
    statImpl: () => ({ size }),
    reader: { read: () => { reads++; return recap; } },
  });
  g.refresh(['142', '7']);
  assert.equal(g.get('142'), 'ship the Matrix two-line rows');
  assert.equal(g.get('7'), null, 'no link yet: no goal, the row keeps its description');
  g.refresh(['142']);
  assert.equal(reads, 1, 'unchanged transcript is not re-read');
  size = 200; recap = { text: 'Goal: fix the stream. Done.' };
  g.refresh(['142']);
  assert.equal(g.get('142'), 'fix the stream');
  g.refresh([]);
  assert.equal(g.get('142'), null, 'a session that ended drops its goal');
});
