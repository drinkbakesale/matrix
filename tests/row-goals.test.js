'use strict';
// Each row's second line is a few-word label of the session's latest Claude Code recap. The
// transcript is re-read only when it grows, each recap is labelled once (and remembered across
// restarts), and a failed label is shown as a failure rather than hidden.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRowGoals } = require('../server/lib/row-goals');
const { cleanLabel } = require('../server/lib/row-labeler');

const settle = () => new Promise(r => setImmediate(r));

function setup({ labeler, labelsFile, hintsOf = () => null } = {}) {
  const state = { size: 100, reads: 0, recap: { text: "We're making the Matchi ads fit Meta's 4:5 feed size." } };
  const calls = [];
  const g = createRowGoals({
    linksDir: '/none',
    labelsFile,
    hintsOf,
    readLink: name => (name === '142' ? { transcriptPath: '/t/142', project: 'angles-to-ads' } : null),
    statImpl: () => ({ size: state.size }),
    reader: { read: () => { state.reads++; return state.recap; } },
    labeler: labeler || { label: async job => { calls.push(job); return `label ${calls.length}`; } },
  });
  return { g, state, calls };
}

test('label comes from the recap, is made once per recap, and is dropped with the session', async () => {
  const { g, state, calls } = setup();
  g.refresh(['142', '7']);
  assert.equal(g.get('142'), null, 'pending: the row keeps its description');
  await settle();
  assert.equal(g.get('142'), 'label 1');
  assert.equal(calls[0].project, 'angles-to-ads');
  assert.equal(g.get('7'), null, 'no link yet: no label');
  g.refresh(['142']);
  assert.equal(state.reads, 1, 'unchanged transcript is not re-read');
  state.size = 200;
  g.refresh(['142']);
  await settle();
  assert.equal(calls.length, 1, 'transcript grew but the recap is the same: no new label');
  state.size = 300; state.recap = { text: 'You asked why the build controller keeps stalling.' };
  g.refresh(['142']);
  assert.equal(g.get('142'), 'label 1', 'previous label stays while the new one is made');
  await settle();
  assert.equal(g.get('142'), 'label 2');
  g.refresh([]);
  assert.equal(g.get('142'), null, 'a session that ended drops its label');
});

test('labels survive a restart through the labels file', async () => {
  const labelsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rowlabels-')), 'row-labels.json');
  const first = setup({ labelsFile });
  first.g.refresh(['142']);
  await settle();
  const second = setup({ labelsFile, labeler: { label: async () => { throw new Error('must not be called'); } } });
  second.g.refresh(['142']);
  assert.equal(second.g.get('142'), 'label 1');
});

test('a failed label is shown as a failure', async () => {
  const { g } = setup({ labeler: { label: async () => { throw new Error('claude CLI timed out'); } } });
  g.refresh(['142']);
  await settle();
  assert.equal(g.get('142'), '⚠ label failed: claude CLI timed out');
});

test('model output must be a short label', () => {
  assert.equal(cleanLabel('resizing Matchi ads to 4:5\n'), 'resizing Matchi ads to 4:5');
  assert.equal(cleanLabel('"fixing flaky build tests."'), 'fixing flaky build tests');
  assert.throws(() => cleanLabel(''), /empty/);
  assert.throws(() => cleanLabel('this is a whole sentence about what the session has been doing today'), /too long/);
});

test('a session with no recap yet is labelled from its title and latest requests', async () => {
  const { g, state, calls } = setup({ hintsOf: () => 'Session title: Matrix trust prompt' });
  state.recap = null;
  g.refresh(['142']);
  await settle();
  assert.equal(g.get('142'), 'label 1');
  assert.match(calls[0].source, /^Session title: Matrix trust prompt/);
  state.size = 200; state.recap = { text: 'We are fixing the trust prompt.' };
  g.refresh(['142']);
  await settle();
  assert.match(calls[1].source, /^Latest session recap:\nWe are fixing the trust prompt\./, 'the recap wins once there is one');
});
