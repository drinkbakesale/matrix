'use strict';
// "Start a new session": the router may only choose a listed folder or a safe new name; the
// launcher answers start-up, waits for Claude, types the request and opens iTerm2; the
// route registers a new project and reports the step that failed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listCandidates, parseChoice } = require('../server/lib/session-router');
const { createSessionLauncher } = require('../server/lib/session-launcher');
const newSessionRoutes = require('../server/lib/new-session-routes');

const candidates = [
  { name: 'home', path: '/Users/me' },
  { name: 'matrix', path: '/Users/me/Projects/matrix' },
];

test('router answers are held to the list or a safe new folder name', () => {
  assert.deepEqual(parseChoice('{"pick": 1}', candidates, '/Users/me/Projects'), { name: 'matrix', path: '/Users/me/Projects/matrix', created: false });
  assert.deepEqual(parseChoice('Sure: {"new": "garden-planner"}', candidates, '/Users/me/Projects'),
    { name: 'garden-planner', path: '/Users/me/Projects/garden-planner', created: true });
  assert.throws(() => parseChoice('{"pick": 7}', candidates, '/p'), /not on the list/);
  assert.throws(() => parseChoice('{"new": "../etc"}', candidates, '/p'), /neither/);
  assert.throws(() => parseChoice('matrix', candidates, '/p'), /did not return JSON/);
});

test('candidates: home first, then configured, then history by recency; no worktrees or missing folders', () => {
  const list = listCandidates({
    home: '/h',
    exists: p => !p.includes('gone'),
    readProjects: () => [{ name: 'a', path: '/h/Projects/a', description: 'A' }],
    readHistory: () => [
      { name: 'old', path: '/h/Projects/old', lastActivity: 1 },
      { name: 'new', path: '/h/Projects/new', lastActivity: 9 },
      { name: 'wt', path: '/h/x/worktrees/t-1', lastActivity: 10 },
      { name: 'gone', path: '/h/Projects/gone', lastActivity: 11 },
      { name: 'a-again', path: '/h/Projects/a', lastActivity: 12 },
    ],
  });
  assert.deepEqual(list.map(c => c.name), ['home', 'a', 'new', 'old']);
  const more = listCandidates({
    home: '/h', exists: () => true, readProjects: () => [], readHistory: () => [{ name: 'projects', path: '/h/Projects', lastActivity: 50 }],
    readFolders: () => [{ name: 'lab', path: '/h/Projects/lab', lastActivity: 5 }],
    readSessions: () => [{ name: 'brand-store', path: '/h/brand-store', lastActivity: 7 }],
  });
  assert.deepEqual(more.map(c => c.name), ['home', 'brand-store', 'lab'], 'folders and session cwds join; ~/Projects itself does not');
});

test('launcher: start Claude, wait for it, type the request, then open iTerm2', async () => {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push([bin, ...args].join(' '));
    if (bin === '/usr/bin/which') return '/opt/homebrew/bin/tmux\n';
    return args[0] === 'new-session' ? '42\t%7\n' : '';
  };
  const launcher = createSessionLauncher({
    exec,
    tmux: { capture: async () => '❯ \n  ⏵⏵ bypass permissions on', sendKey: async () => {} },
    acceptDialogs: async () => [],
    sleep: async () => {},
  });
  const out = await launcher.launch({ cwd: '/h/Projects/matrix', request: 'fix the "quote" bug' });
  assert.deepEqual(out, { session: '42', pane: '%7' });
  assert.equal(calls[0], "tmux new-session -d -P -F #{session_name}\t#{pane_id} -c /h/Projects/matrix");
  assert.equal(calls[1], 'tmux send-keys -t %7 exec claude --dangerously-skip-permissions Enter');
  assert.equal(calls[2], 'tmux send-keys -t %7 -l fix the "quote" bug');
  assert.equal(calls[3], 'tmux send-keys -t %7 Enter');
  assert.equal(calls[4], '/usr/bin/which tmux');
  assert.match(calls[5], /^osascript -e .*create window with default profile command "\/opt\/homebrew\/bin\/tmux attach -t 42"/s);
  assert.doesNotMatch(calls[5], /write text/, 'never typed into a shell the profile may already have wrapped in tmux');
});

test('launcher: never types the request if Claude is not ready', async () => {
  const calls = [];
  const launcher = createSessionLauncher({
    exec: async (bin, args) => { calls.push(args[0]); return args[0] === 'new-session' ? '3\t%1' : ''; },
    tmux: { capture: async () => 'zsh: command not found: claude', sendKey: async () => {} },
    acceptDialogs: async () => [],
    sleep: async () => {},
  });
  await assert.rejects(launcher.launch({ cwd: '/h', request: 'hi' }), /did not reach its input box/);
  assert.ok(!calls.includes('-l') && calls.filter(c => c === 'send-keys').length === 1);
});

function fakeApp() {
  const routes = {};
  return { post: (p, h) => { routes[p] = h; }, call: async (p, body) => {
    let status = 200; let json;
    await routes[p]({ body }, { status(s) { status = s; return this; }, json(j) { json = j; return this; } });
    return { status, json };
  } };
}

test('route: a new project gets its folder and a projects.conf line before Claude starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsess-'));
  const conf = path.join(dir, 'projects.conf');
  const launched = [];
  const app = fakeApp();
  newSessionRoutes.mount(app, {
    router: { route: async () => ({ name: 'garden', path: path.join(dir, 'garden'), created: true }) },
    launcher: { launch: async opts => { launched.push(opts); return { session: '9' }; } },
    confPath: conf, readConf: () => [], readHistory: () => [], readFolders: () => [], readSessions: () => [],
  });
  const r = await app.call('/api/sessions/new', { request: 'plan my garden' });
  assert.equal(r.status, 200);
  assert.equal(r.json.session, '9');
  assert.ok(fs.statSync(path.join(dir, 'garden')).isDirectory());
  assert.equal(fs.readFileSync(conf, 'utf8'), `garden|${path.join(dir, 'garden')}|server|\n`);
  assert.deepEqual(launched, [{ cwd: path.join(dir, 'garden'), request: 'plan my garden', parts: null }]);
});

test('route: empty request is refused and a failure names its step', async () => {
  const app = fakeApp();
  newSessionRoutes.mount(app, {
    router: { route: async () => { throw new Error('claude CLI timed out'); } },
    launcher: { launch: async () => { throw new Error('unreachable'); } },
    readConf: () => [], readHistory: () => [], readFolders: () => [], readSessions: () => [],
  });
  assert.equal((await app.call('/api/sessions/new', { request: '  ' })).status, 400);
  const r = await app.call('/api/sessions/new', { request: 'x' });
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'Failed while choosing the project: claude CLI timed out');
});
