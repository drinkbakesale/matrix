'use strict';
// Shared harness for the notification path: runs the real bin/matrix-notify with fake
// tmux/curl on PATH, and loads the delivered mobile navigation code from
// server/public/app.js so a test can follow one alert from the hook to openTerminal.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '../bin/matrix-notify');
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '../server/public/app.js'), 'utf8');

// realpath: macOS tmpdir is behind a /var symlink and bash reports the physical $PWD.
function makeWorkspace(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-notify-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const matrixHome = path.join(dir, 'matrix');
  for (const d of [bin, home, matrixHome]) fs.mkdirSync(d, { recursive: true });
  return { dir, bin, home, matrixHome, capture: path.join(dir, 'body.json') };
}

// Runs the notifier from `cwd` (default: the fake home) and returns the posted JSON body,
// or null when the notifier suppressed the notification.
function runNotify(t, options = {}) {
  const { tag = '', message, tmuxSession = '12', tmuxPane = '%3' } = options;
  const ws = options.workspace || makeWorkspace(t);
  const conf = options.conf !== undefined ? options.conf : `matrix|${ws.home}|server||Home\n`;
  fs.writeFileSync(path.join(ws.matrixHome, 'projects.conf'), conf);
  fs.writeFileSync(path.join(ws.bin, 'tmux'),
    `#!/bin/sh\ncase "$1" in\n  display-message) echo "${tmuxSession}" ;;\n  show-option) [ -n "${tag}" ] && echo "${tag}" || exit 1 ;;\nesac\n`,
    { mode: 0o755 });
  fs.writeFileSync(path.join(ws.bin, 'curl'),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-d" ]; then printf '%s' "$2" > "${ws.capture}"; fi; shift; done\n`,
    { mode: 0o755 });
  fs.rmSync(ws.capture, { force: true });

  const cwd = options.cwd || ws.home;
  fs.mkdirSync(cwd, { recursive: true });
  const env = { PATH: `${ws.bin}:/usr/bin:/bin`, HOME: ws.home, MATRIX_HOME: ws.matrixHome };
  if (tmuxPane) env.TMUX_PANE = tmuxPane;
  execFileSync('bash', [SCRIPT, ...(message === undefined ? [] : [message])], { cwd, env });

  if (!fs.existsSync(ws.capture)) return null;
  return JSON.parse(fs.readFileSync(ws.capture, 'utf8'));
}

// Runs the delivered navigation code through its final openTerminal/closeTerminal action.
function loadNavigation(liveSessions) {
  const start = APP_SOURCE.indexOf('async function fetchSessions()');
  const end = APP_SOURCE.indexOf('function showToast(', start);
  assert.ok(start >= 0 && end > start, 'navigation function boundaries missing from app.js');
  const state = { opened: null, closed: false };
  const context = vm.createContext({
    GENERIC_CONTROL_LABELS: new Set(['matrix']),
    lastSessionList: [],
    lastNotificationIntentAt: 0,
    Date,
    setTimeout,
    fetch: async () => ({ json: async () => ({ sessions: liveSessions }) }),
    openTerminal: name => { state.opened = name; },
    closeTerminal: () => { state.closed = true; },
  });
  vm.runInContext(APP_SOURCE.slice(start, end), context);
  return { context, state };
}

module.exports = { makeWorkspace, runNotify, loadNavigation };
