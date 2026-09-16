'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanLabel,
  matchProject,
  resolveProjectIdentity,
  assignInstanceLabels,
  resolveNotificationTarget,
  describeFromPaneTitle,
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

function describe(paneTitle, cwd = HOME, homeDir = HOME) {
  return describeFromPaneTitle({ paneTitle, cwd, homeDir, username: 'dev', hostname: 'devs-Mac.local' });
}

test('a Claude conversation topic in the pane title becomes the description', () => {
  assert.equal(describe('✳ Amazon reviews scraping for VOC mining'), 'Amazon reviews scraping for VOC mining');
  assert.equal(describe('_ Yoro proposal'), 'Yoro proposal');
  assert.equal(describe('x'.repeat(90)), 'x'.repeat(77) + '...');
});

test('a pane title that only echoes the user, host, or folder is not a description', () => {
  // Codex titles every home-directory session with the folder name, i.e. the username.
  assert.equal(describe('dev'), '');
  assert.equal(describe('DEV'), '');
  assert.equal(describe('scratch', '/Users/dev/scratch'), '');
  assert.equal(describe('devs-Mac.local'), '');
  assert.equal(describe('✳ Claude Code'), '');
  assert.equal(describe(''), '');
  assert.equal(describe('devhome', '/home/devhome', '/home/devhome'), '');
});

test('a topic that merely mentions the user or folder is still a description', () => {
  assert.equal(describe('dev server logs'), 'dev server logs');
  assert.equal(describe('✳ Fix scratch loader', '/Users/dev/scratch'), 'Fix scratch loader');
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

test('a project label matching several live sessions is unresolved, not a guess', () => {
  // Recent activity cannot identify which terminal raised the alert.
  const r = resolveNotificationTarget({ session: 'angles-to-ads' }, sessions);
  assert.deepEqual(r, { targetSession: null, projectName: null, via: 'ambiguous-label' });
  assert.equal(resolveNotificationTarget({ project: 'ANGLES-TO-ADS' }, sessions).targetSession, null);
});

test('an explicit tmux target wins over an ambiguous project label', () => {
  const r = resolveNotificationTarget({ tmuxSession: '43', session: 'angles-to-ads', project: 'angles-to-ads' }, sessions);
  assert.deepEqual(r, { targetSession: '43', projectName: 'angles-to-ads', via: 'tmux-session' });
});

test('labels drop control characters', () => {
  const nul = String.fromCharCode(0);
  const unit = String.fromCharCode(31);
  const del = String.fromCharCode(127);
  assert.equal(cleanLabel(`vo${nul}c-mi${unit}ner${del}\n`), 'voc-miner');
  assert.equal(cleanLabel(42), '42');
  assert.equal(cleanLabel({}), '');
});

test('unknown labels resolve to no target', () => {
  assert.equal(resolveNotificationTarget({ session: 'nope' }, sessions).targetSession, null);
  assert.equal(resolveNotificationTarget({}, []).targetSession, null);
});
