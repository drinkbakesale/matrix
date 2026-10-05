#!/usr/bin/env node
// matrix-project-tag.js — Claude Code hook (PostToolUse, UserPromptSubmit, Stop; async)
// Names the tmux session after the project Claude is working in and records which
// transcript belongs to which pane, so Matrix can label the row and read the session's recap.
//
// - Project: the most specific registered project containing the file a tool touched, or
//   else Claude's working directory; failing a registered match, the first folder under a
//   workspace root (~/Projects/<name>, ~/Desktop/projects/<name>, ...). The latest wins, so a
//   session that moves between projects is named after the one it is in now.
// - Link: <MATRIX_HOME>/session-links/<tmux session>.json with the pane, its window, the
//   transcript path and the cwd. tmux is always addressed through $TMUX_PANE — never "the
//   current client" — and called with argument vectors, never a shell.

const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const homeDir = os.homedir();
// Find projects.conf / project-paths.conf wherever they actually live. When
// Claude Code runs this hook, MATRIX_HOME env var isn't set, so default from
// env, then probe the two standard locations.
const candidateHomes = [
  process.env.MATRIX_HOME,
  path.join(homeDir, '.claude-remote'),
  path.join(homeDir, '.matrix'),
].filter(Boolean);
let matrixHome = candidateHomes[0] || path.join(homeDir, '.matrix');
for (const c of candidateHomes) {
  if (fs.existsSync(path.join(c, 'projects.conf'))) { matrixHome = c; break; }
}
const registryPath = path.join(matrixHome, 'project-paths.conf');
const confPath = path.join(matrixHome, 'projects.conf');

// Decode a Claude Code project-history dir name back to its real filesystem
// path. The encoded form replaces '/' with '-', which is ambiguous because
// folder names can contain '-'. Resolve by greedy forward-match against the
// real filesystem at each level.
function decodeClaudeProjectPath(encoded) {
  const parts = encoded.replace(/^-+/, '').split('-');
  if (parts.length === 0) return null;
  let current = '/';
  let i = 0;
  while (i < parts.length) {
    let matched = false;
    for (let j = parts.length; j > i; j--) {
      const candidate = parts.slice(i, j).join('-');
      if (!candidate) continue;
      const next = path.join(current, candidate);
      try {
        if (fs.statSync(next).isDirectory()) {
          current = next;
          i = j;
          matched = true;
          break;
        }
      } catch {}
    }
    if (!matched) return null;
  }
  return current;
}

function buildRegistry() {
  const entries = [];
  // From project-paths.conf (manual overrides)
  try {
    for (const line of fs.readFileSync(registryPath, 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [rawPath, name] = line.split('|').map(s => s.trim());
      if (rawPath && name) entries.push({ prefix: rawPath.replace(/^~/, homeDir), name });
    }
  } catch {}
  // From projects.conf (manually curated with custom names + descriptions)
  try {
    for (const line of fs.readFileSync(confPath, 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const parts = line.split('|');
      const name = parts[0]?.trim();
      const rawPath = parts[1]?.trim()?.replace(/^~/, homeDir);
      if (name && rawPath && rawPath !== homeDir) entries.push({ prefix: rawPath, name });
    }
  } catch {}
  // From ~/.claude/projects/ — every project Claude Code has ever been opened
  // in. This lets the hook auto-tag sessions for projects that were never
  // manually registered, which is most of them in practice.
  //
  // Rule: skip broad container directories like ~/Desktop, ~/Downloads,
  // ~/Documents, ~/Projects. Those are user-workspace roots, not projects —
  // getting an entry for them would tag every session working anywhere under
  // Desktop as the useless name "desktop".
  const broadContainers = new Set([
    homeDir,
    path.join(homeDir, 'Desktop'),
    path.join(homeDir, 'Downloads'),
    path.join(homeDir, 'Documents'),
    path.join(homeDir, 'Projects'),
    path.join(homeDir, 'Pictures'),
    path.join(homeDir, 'Music'),
    path.join(homeDir, 'Movies'),
    path.join(homeDir, 'Library'),
  ]);
  try {
    const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
    for (const name of fs.readdirSync(claudeProjectsDir)) {
      if (!name.startsWith('-')) continue;
      if (name.startsWith('-private-')) continue;                  // temp battle dirs
      if (name.includes('--claude-mem-')) continue;                // mem-observer
      if (name.includes('generated-apps-')) continue;              // generated scratch dirs
      const decoded = decodeClaudeProjectPath(name);
      if (!decoded) continue;
      if (broadContainers.has(decoded)) continue;                  // not a project
      const projectName = path.basename(decoded).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (projectName) entries.push({ prefix: decoded, name: projectName });
    }
  } catch {}
  // Sort longest prefix first (most specific match wins, handles nested projects)
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return entries;
}

// Workspace roots hold projects; they are never projects themselves. A path below one of
// them is named after its first folder there, even if Claude was never launched in it.
const WORKSPACE_ROOTS = [
  path.join(homeDir, 'Desktop', 'projects'),
  path.join(homeDir, 'Projects'),
  path.join(homeDir, 'Desktop'),
  path.join(homeDir, 'Documents'),
  path.join(homeDir, 'Developer'),
  path.join(homeDir, 'code'),
];
const slug = name => name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

function projectFor(target, registry) {
  if (!target) return null;
  const resolved = path.resolve(String(target).replace(/^~(?=$|\/)/, homeDir));
  const within = prefix => resolved === prefix || resolved.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
  for (const entry of registry) if (within(entry.prefix)) return entry.name;
  for (const root of WORKSPACE_ROOTS) {
    if (!resolved.startsWith(root + '/')) continue;
    const first = resolved.slice(root.length + 1).split('/')[0];
    if (first && !first.startsWith('.') && !WORKSPACE_ROOTS.includes(path.join(root, first))) return slug(first);
  }
  return null;
}

function tmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function writeLink(link) {
  const dir = path.join(matrixHome, 'session-links');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, encodeURIComponent(link.tmuxSession) + '.json');
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(link));
  fs.renameSync(tmp, file);
}

function run(input) {
  const pane = process.env.TMUX_PANE || '';
  if (!/^%\d+$/.test(pane) || !input || typeof input !== 'object') return;
  // session_id ('$N') is tmux's own exact identifier: no name can be misread as a pattern.
  const [session, sessionTarget, windowId, paneId] = tmux(['display-message', '-p', '-t', pane,
    '#{session_name}\t#{session_id}\t#{window_id}\t#{pane_id}']).split('\t');
  if (!session || !sessionTarget) return;

  const registry = buildRegistry();
  const toolPath = input.tool_input && (input.tool_input.file_path || input.tool_input.path);
  const project = projectFor(toolPath, registry) || projectFor(input.cwd, registry);

  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (transcriptPath) {
    writeLink({
      tmuxSession: session, windowId, paneId, transcriptPath,
      sessionId: typeof input.session_id === 'string' ? input.session_id : '',
      cwd: typeof input.cwd === 'string' ? input.cwd : '', project: project || '', updatedAt: Date.now(),
    });
  }
  if (project) {
    let current = '';
    try { current = tmux(['show-option', '-t', sessionTarget, '-v', '@matrix_project']); } catch {}
    if (current !== project) tmux(['set-option', '-t', sessionTarget, '@matrix_project', project]);
  }
  return session;
}

// You typed to this session, or a tool ran (which is how an approved permission prompt
// continues): it no longer needs you, so its Matrix row stops asking for attention.
const CLEARS_ATTENTION = new Set(['UserPromptSubmit', 'PostToolUse']);

function clearAttention(session) {
  const http = require('http');
  const body = JSON.stringify({ tmuxSession: session });
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: parseInt(process.env.MATRIX_PORT, 10) || 7778, path: '/api/attention/clear',
      method: 'POST', timeout: 1500, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);          // Matrix not running: nothing to clear
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(raw);
      const session = run(input);
      if (session && CLEARS_ATTENTION.has(input.hook_event_name)) await clearAttention(session);
    } catch (err) {
      process.stderr.write(`matrix-project-tag: ${err.message}\n`);
    }
  });
}

module.exports = { projectFor, buildRegistry, WORKSPACE_ROOTS, CLEARS_ATTENTION };
