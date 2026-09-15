'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchProject,
  resolveProjectIdentity,
  assignInstanceLabels,
  resolveNotificationTarget,
} = require('../server/lib/session-identity');

const HOME = '/Users/dev';
const registry = [
  { prefix: '/Users/dev/Projects/angles-to-ads', name: 'angles-to-ads' },
  { prefix: '/Users/dev/Projects/matrix', name: 'matrix' },
  { prefix: '/Users/dev/Desktop/ad-placement-vl/', name: 'ad-text-placement' },
];

function identity(overrides) {
  return resolveProjectIdentity({ homeDir: HOME, username: 'dev', registry, ...overrides });
}

test('explicit @matrix_project tag wins over registry and cwd', () => {
  const r = identity({ sessionName: '12', explicitProject: 'voc-miner', cwd: '/Users/dev/Projects/matrix' });
  assert.deepEqual(r, { projectName: 'voc-miner', source: 'explicit', confirmed: true });
});

test('registry match beats cwd basename and respects directory boundaries', () => {
  assert.equal(identity({ sessionName: '3', cwd: '/Users/dev/Desktop/ad-placement-vl/src' }).projectName, 'ad-text-placement');
  assert.equal(matchProject('/Users/dev/Projects/matrix-old', registry, HOME), null);
  const r = identity({ sessionName: '3', cwd: '/Users/dev/Projects/matrix-old' });
  assert.deepEqual(r, { projectName: 'matrix-old', source: 'cwd', confirmed: true });
});

test('home-directory sessions never take a registry or cwd identity', () => {
  const named = identity({ sessionName: 'rpgclaw-2', cwd: HOME });
  assert.deepEqual(named, { projectName: 'rpgclaw', source: 'session-name', confirmed: true });
  const numeric = identity({ sessionName: '12', cwd: HOME });
  assert.deepEqual(numeric, { projectName: '12', source: 'fallback', confirmed: false });
});

test('generic matrix control session is only a fallback identity', () => {
  const r = identity({ sessionName: 'matrix', cwd: HOME });
  assert.equal(r.projectName, 'matrix');
  assert.equal(r.confirmed, false);
});

test('pane titles play no part in identity', () => {
  const r = identity({ sessionName: '41', cwd: HOME, paneTitle: 'angles-to-ads' });
  assert.equal(r.projectName, '41');
});

function live(name, projectName, extra = {}) {
  return { name, projectName, projectConfirmed: projectName !== name, lastActivity: 0, ...extra };
}

test('instance suffix only for sessions sharing a project', () => {
  const labeled = assignInstanceLabels([
    live('43', 'angles-to-ads'),
    live('49', 'angles-to-ads'),
    live('rpgclaw', 'rpgclaw', { projectConfirmed: true }),
    live('rpgclaw-2', 'rpgclaw'),
    live('54', 'voc-miner'),
    live('12', '12'),
  ]);
  assert.deepEqual(labeled.map(s => s.displayName), [
    'angles-to-ads · 43',
    'angles-to-ads · 49',
    'rpgclaw',
    'rpgclaw · rpgclaw-2',
    'voc-miner',
    '12',
  ]);
  assert.deepEqual(labeled.map(s => s.projectName), ['angles-to-ads', 'angles-to-ads', 'rpgclaw', 'rpgclaw', 'voc-miner', '12']);
});

const sessions = [
  live('1', 'matrix', { lastActivity: 50 }),
  live('12', '12', { lastActivity: 90 }),
  live('43', 'angles-to-ads', { lastActivity: 10 }),
  live('49', 'angles-to-ads', { lastActivity: 70 }),
  live('54', 'voc-miner', { lastActivity: 5 }),
];

test('hook-supplied tmux session routes exactly, even when the label names another project', () => {
  const r = resolveNotificationTarget({ tmuxSession: '12', session: 'matrix', project: 'matrix' }, sessions);
  assert.deepEqual(r, { targetSession: '12', projectName: '12', via: 'tmux-session' });
});

test('a tmux session that is no longer live is never replaced by a label guess', () => {
  const r = resolveNotificationTarget({ tmuxSession: '99', session: 'voc-miner', project: 'voc-miner' }, sessions);
  assert.equal(r.targetSession, null);
});

test('generic matrix label without a tmux session does not open the matrix project', () => {
  const r = resolveNotificationTarget({ session: 'matrix', project: 'matrix' }, sessions);
  assert.deepEqual(r, { targetSession: null, projectName: null, via: 'unresolved' });
});

test('project label resolves to its live session, exact name first', () => {
  assert.equal(resolveNotificationTarget({ session: 'voc-miner', project: 'voc-miner' }, sessions).targetSession, '54');
  assert.equal(resolveNotificationTarget({ session: 'VOC-Miner' }, sessions).targetSession, '54');
  assert.equal(resolveNotificationTarget({ session: '43' }, sessions).targetSession, '43');
});

test('a project with several live sessions resolves to its most recently active one', () => {
  const r = resolveNotificationTarget({ session: 'angles-to-ads' }, sessions);
  assert.deepEqual(r, { targetSession: '49', projectName: 'angles-to-ads', via: 'project-most-recent' });
});

test('unknown labels resolve to no target', () => {
  assert.equal(resolveNotificationTarget({ session: 'nope' }, sessions).targetSession, null);
  assert.equal(resolveNotificationTarget({}, []).targetSession, null);
});
