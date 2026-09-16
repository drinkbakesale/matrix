'use strict';
// End-to-end regression for one alert: the real bin/matrix-notify decides the label,
// the server resolves it against live sessions, and the delivered mobile navigation code
// performs its final action. An alert raised in one directory must never open another
// project's terminal at the end of that chain.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeWorkspace, runNotify, loadNavigation } = require('./notify-harness');
const { resolveNotificationTarget } = require('../server/lib/session-identity');

const LIVE = [
  { name: '41', projectName: 'app', projectConfirmed: true },
  { name: '52', projectName: 'voc-miner', projectConfirmed: true },
];

// The server only puts a resolved target in the payload, so the client navigates only then.
async function deliver(body, live = LIVE) {
  const resolved = resolveNotificationTarget(body, live);
  const { context, state } = loadNavigation(live);
  if (resolved.targetSession) await context.openNotificationTarget(resolved.targetSession);
  return { resolved, ...state };
}

function workspace(t, { dirs, conf }) {
  const ws = makeWorkspace(t);
  for (const d of dirs) fs.mkdirSync(path.join(ws.home, d), { recursive: true });
  ws.conf = conf(ws.home);
  return ws;
}

test('an alert from a sibling directory never opens the configured project terminal', async (t) => {
  const ws = workspace(t, {
    dirs: ['Projects/app', 'Projects/app-old'],
    conf: home => `app|${home}/Projects/app|server||App\n`,
  });
  const body = runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app-old'), tmuxPane: null });

  assert.equal(body.project, 'app-old');
  const r = await deliver(body);
  assert.equal(r.resolved.targetSession, null, 'no live session belongs to app-old');
  assert.equal(r.opened, null);
  assert.notEqual(r.opened, '41', "the unrelated app terminal must never open");
});

test('an alert from the configured project opens that project terminal', async (t) => {
  const ws = workspace(t, {
    dirs: ['Projects/app/server'],
    conf: home => `app|${home}/Projects/app|server||App\n`,
  });
  const body = runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app/server'), tmuxPane: null });

  assert.equal(body.project, 'app');
  const r = await deliver(body);
  assert.equal(r.resolved.targetSession, '41');
  assert.equal(r.opened, '41');
});

test('tmux identity carries the alert to its own terminal whatever the label says', async (t) => {
  const ws = workspace(t, {
    dirs: ['Projects/app-old'],
    conf: home => `app|${home}/Projects/app|server||App\n`,
  });
  const body = runNotify(t, {
    workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app-old'),
    tag: 'app', tmuxSession: '52',
  });

  assert.equal(body.tmuxSession, '52');
  const r = await deliver(body);
  assert.equal(r.resolved.via, 'tmux-session');
  assert.equal(r.opened, '52', 'the originating terminal wins over the project label');
});

test('an alert whose tmux session has closed opens nothing', async (t) => {
  const ws = workspace(t, {
    dirs: ['Projects/app'],
    conf: home => `app|${home}/Projects/app|server||App\n`,
  });
  const body = runNotify(t, {
    workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app'),
    tag: 'app', tmuxSession: '99',
  });

  const r = await deliver(body);
  assert.equal(r.resolved.targetSession, null);
  assert.equal(r.resolved.via, 'tmux-session-not-live');
  assert.equal(r.opened, null, 'a dead target must not fall back to the project label');
});
