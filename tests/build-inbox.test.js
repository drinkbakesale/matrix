'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  parseBuildInbox,
  runBuildInbox,
  buildInboxErrorStatus,
  MAX_ITEMS_PER_GROUP,
} = require('../server/lib/build-inbox');

const ARGS = Object.freeze(['inbox', '--json']);

const sample = {
  problems: [{ key: 'watchdog:missing', kind: 'watchdog off', message: 'x' }],
  needs_you: [{ task_id: 't-1', repo: 'voc-miner', state: 'BLOCKED', updated: '31m ago', reason: 'infrastructure_failure', detail: 'long' }],
  running: [{ task_id: 't-2', repo: 'matrix', state: 'BUILDING', updated: 'just now' }],
  finished: [{ task_id: 't-3', repo: 'angles-to-ads', state: 'CANCELLED', updated: '2h ago', report: '/secret/path' }],
};

test('parses the three inbox groups into the compact summary', () => {
  const r = parseBuildInbox(JSON.stringify(sample));
  assert.deepEqual(r.needsYou, [{ taskId: 't-1', project: 'voc-miner', updated: '31m ago', reason: 'infrastructure_failure', state: 'BLOCKED' }]);
  assert.deepEqual(r.running, [{ taskId: 't-2', project: 'matrix', updated: 'just now', stage: 'BUILDING' }]);
  assert.deepEqual(r.finished, [{ taskId: 't-3', project: 'angles-to-ads', updated: '2h ago', result: 'CANCELLED' }]);
  assert.deepEqual(r.counts, { needsYou: 1, running: 1, finished: 1 });
});

test('rejects malformed output', () => {
  for (const bad of ['not json', '[]', 'null', '{"needs_you":[],"running":[]}', '{"needs_you":[1],"running":[],"finished":[]}',
    '{"needs_you":[{"repo":"x"}],"running":[],"finished":[]}']) {
    assert.throws(() => parseBuildInbox(bad), e => e.code === 'malformed_output', bad);
  }
});

test('bounds item counts and field lengths, keeps markup as inert text', () => {
  const many = Array.from({ length: MAX_ITEMS_PER_GROUP + 5 }, (_, i) => ({ task_id: `t-${i}`, repo: '<img src=x onerror=alert(1)>', state: 'x'.repeat(500) }));
  const r = parseBuildInbox(JSON.stringify({ needs_you: [], running: many, finished: [] }));
  assert.equal(r.running.length, MAX_ITEMS_PER_GROUP);
  assert.equal(r.counts.running, MAX_ITEMS_PER_GROUP + 5);
  assert.ok(r.running[0].stage.length <= 160);
  assert.equal(r.running[0].project, '<img src=x onerror=alert(1)>');
});

test('control characters in controller fields become spaces', () => {
  const nul = String.fromCharCode(0);
  const esc = String.fromCharCode(27);
  const r = parseBuildInbox(JSON.stringify({ needs_you: [], running: [{ task_id: 't-9', repo: `vo${nul}c${esc}[31m`, state: 'BUILDING' }], finished: [] }));
  assert.equal(r.running[0].project, 'vo c [31m');
});

function fakeBinary(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-buildctl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'buildctl');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('runs the binary with the fixed argument array', async (t) => {
  const bin = fakeBinary(t, `[ "$1" = inbox ] && [ "$2" = --json ] && [ $# -eq 2 ] || exit 9\ncat <<'EOF'\n${JSON.stringify(sample)}\nEOF`);
  const r = await runBuildInbox({ binary: bin, args: ARGS, execFile });
  assert.equal(r.running[0].taskId, 't-2');
});

test('maps failures to structured errors', async (t) => {
  const cases = [
    [{ binary: 'buildctl' }, 'not_configured', 503],
    [{ binary: '/nonexistent/buildctl' }, 'unavailable', 503],
    [{ binary: fakeBinary(t, 'exit 3') }, 'failed', 502],
    [{ binary: fakeBinary(t, 'echo not-json') }, 'malformed_output', 502],
    [{ binary: fakeBinary(t, 'exec sleep 5'), timeoutMs: 200 }, 'timeout', 504],
    [{ binary: fakeBinary(t, 'head -c 5000 /dev/zero | tr "\\0" a'), maxBuffer: 1024 }, 'output_too_large', 502],
  ];
  for (const [opts, code, status] of cases) {
    await assert.rejects(runBuildInbox({ args: ARGS, execFile, ...opts }), err => {
      assert.equal(err.code, code, JSON.stringify(opts));
      assert.equal(buildInboxErrorStatus(err), status);
      return true;
    });
  }
});
