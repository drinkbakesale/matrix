'use strict';
// Runs bin/matrix-notify with fake tmux/curl on PATH and checks the posted JSON body.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeWorkspace, runNotify } = require('./notify-harness');

test('untagged home-directory session sends its own tmux session', (t) => {
  // The deployed config maps the home directory to "matrix" — the label that used to misroute.
  const body = runNotify(t, {});
  assert.equal(body.project, 'matrix');
  assert.equal(body.tmuxSession, '12');
});

test('tagged session sends the tag and tmux session; message is valid JSON', (t) => {
  const body = runNotify(t, { tag: 'voc-miner', message: 'Needs "input"\\ now' });
  assert.equal(body.project, 'voc-miner');
  assert.equal(body.tmuxSession, '12');
  assert.equal(body.message, 'Needs "input"\\ now');
});

// Builds a workspace holding several project directories plus a config naming only some.
function projectsWorkspace(t, { dirs, conf }) {
  const ws = makeWorkspace(t);
  for (const d of dirs) fs.mkdirSync(path.join(ws.home, d), { recursive: true });
  ws.conf = conf(ws.home);
  return ws;
}

test('a sibling directory never borrows a configured project label', (t) => {
  const ws = projectsWorkspace(t, {
    dirs: ['Projects/app', 'Projects/app-old', 'Projects/application'],
    conf: home => `app|${home}/Projects/app|server||App\n`,
  });
  // No tmux identity: the path match alone decides the label the server will route on.
  for (const dir of ['Projects/app-old', 'Projects/application']) {
    const body = runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, dir), tmuxPane: null });
    assert.equal(body.project, path.basename(dir), `${dir} must not answer to the "app" project`);
    assert.equal(body.session, path.basename(dir));
  }
});

test('the configured path itself and its descendants do match', (t) => {
  const ws = projectsWorkspace(t, {
    dirs: ['Projects/app', 'Projects/app/server/routes'],
    conf: home => `app|${home}/Projects/app|server||App\n`,
  });
  for (const dir of ['Projects/app', 'Projects/app/server/routes']) {
    const body = runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, dir), tmuxPane: null });
    assert.equal(body.project, 'app', dir);
  }
});

test('trailing slashes in the configured path are normalized', (t) => {
  const ws = projectsWorkspace(t, {
    dirs: ['Projects/app', 'Projects/app-old'],
    conf: home => `app|${home}/Projects/app/|server||App\n`,
  });
  assert.equal(runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app'), tmuxPane: null }).project, 'app');
  assert.equal(runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app-old'), tmuxPane: null }).project, 'app-old');
});

test('the longest matching configured path wins', (t) => {
  const ws = projectsWorkspace(t, {
    dirs: ['Projects/app', 'Projects/app/packages/api'],
    conf: home => `app|${home}/Projects/app|server||App\napi|${home}/Projects/app/packages/api|server||Api\n`,
  });
  const body = runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app/packages/api'), tmuxPane: null });
  assert.equal(body.project, 'api');
});

test('home-relative configured paths expand without eval', (t) => {
  const ws = projectsWorkspace(t, {
    dirs: ['Projects/app', 'Projects/other'],
    conf: () => 'app|~/Projects/app|server||App\nother|$HOME/Projects/other|server||Other\n',
  });
  assert.equal(runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app'), tmuxPane: null }).project, 'app');
  assert.equal(runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/other'), tmuxPane: null }).project, 'other');
});

test('a configured path is data, never a command', (t) => {
  const ws = makeWorkspace(t);
  const marker = path.join(ws.dir, 'pwned');
  const dir = path.join(ws.home, 'Projects/app');
  fs.mkdirSync(dir, { recursive: true });
  const conf = `x|$(touch ${marker})${dir}|server||X\ny|\`touch ${marker}\`|server||Y\n`;
  const body = runNotify(t, { workspace: ws, conf, cwd: dir, tmuxPane: null });
  assert.equal(fs.existsSync(marker), false, 'projects.conf must not be executed');
  assert.equal(body.project, 'app', 'an unexpandable config path must not claim the session');
});

test('an explicit tmux project tag outranks any path match', (t) => {
  const ws = projectsWorkspace(t, {
    dirs: ['Projects/app'],
    conf: home => `app|${home}/Projects/app|server||App\n`,
  });
  const body = runNotify(t, { workspace: ws, conf: ws.conf, cwd: path.join(ws.home, 'Projects/app'), tag: 'voc-miner' });
  assert.equal(body.project, 'voc-miner');
  assert.equal(body.tmuxSession, '12');
});
