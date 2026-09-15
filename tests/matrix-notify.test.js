'use strict';
// Runs bin/matrix-notify with fake tmux/curl on PATH and checks the posted JSON body.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '../bin/matrix-notify');

function runNotify(t, { tag = '', message }) {
  // realpath: macOS tmpdir is behind a /var symlink and bash reports the physical $PWD.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-notify-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const matrixHome = path.join(dir, 'matrix');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(matrixHome);
  // The deployed config maps the home directory to "matrix" — the label that used to misroute.
  fs.writeFileSync(path.join(matrixHome, 'projects.conf'), `matrix|${home}|server||Home\n`);
  fs.writeFileSync(path.join(bin, 'tmux'),
    `#!/bin/sh\ncase "$1" in\n  display-message) echo "12" ;;\n  show-option) [ -n "${tag}" ] && echo "${tag}" || exit 1 ;;\nesac\n`,
    { mode: 0o755 });
  const capture = path.join(dir, 'body.json');
  fs.writeFileSync(path.join(bin, 'curl'),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-d" ]; then printf '%s' "$2" > "${capture}"; fi; shift; done\n`,
    { mode: 0o755 });

  const args = message === undefined ? [] : [message];
  execFileSync('bash', [SCRIPT, ...args], {
    cwd: home,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, MATRIX_HOME: matrixHome, TMUX_PANE: '%3' },
  });
  return JSON.parse(fs.readFileSync(capture, 'utf8'));
}

test('untagged home-directory session sends its own tmux session', (t) => {
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
