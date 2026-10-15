'use strict';
// Project discovery, output browsing, dev-port detection, session start/kill and the skills
// list. Extracted from server.js with no behaviour change.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { CONF_PATH, searchDirs } = require('./matrix-config');
const { readProjects, readClaudeProjectHistory } = require('./projects');
const attention = require('./attention');
const { acceptStartupDialogs } = require('./trust-prompt');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
const DEV_PORT_RANGES = [
  [3000, 3010], [4000, 4010], [5000, 5010], [5173, 5175],
  [8000, 8010], [8080, 8090], [8180, 8190], [8888, 8888],
  [9000, 9010], [4200, 4200], [4321, 4322],
];
const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
let skillsCache = [];
let skillsCacheTime = 0;

function scanOutputs(dir, prefix, files, images, session) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { scanOutputs(fullPath, relPath, files, images, session); continue; }
      const stat = fs.statSync(fullPath);
      const ext = path.extname(entry.name).toLowerCase();
      files.push({ name: relPath, size: stat.size, mtime: stat.mtimeMs, ext });
      if (IMAGE_EXTS.includes(ext)) {
        images.push({
          name: relPath,
          path: `/api/file?session=${encodeURIComponent(session)}&path=${encodeURIComponent(relPath)}`,
        });
      }
    }
  } catch {}
}

function mount(app) {
  app.get('/api/outputs/:session', (req, res) => {
    const session = req.params.session;
    const project = readProjects().find(p => p.name === session);
    if (!project) return res.json({ files: [], images: [] });
    const projectPath = project.path.replace('~', os.homedir());
    const files = [];
    const images = [];
    scanOutputs(path.join(projectPath, 'output'), '', files, images, session);
    files.sort((a, b) => b.mtime - a.mtime);
    images.sort((a, b) => {
      const fa = files.find(f => f.name === a.name);
      const fb = files.find(f => f.name === b.name);
      return (fb?.mtime || 0) - (fa?.mtime || 0);
    });
    res.json({ files: files.slice(0, 100), images: images.slice(0, 50) });
  });

  app.get('/api/file', (req, res) => {
    const session = req.query.session;
    const filePath = req.query.path;
    if (!session || !filePath) return res.status(400).send('missing session or path');
    const project = readProjects().find(p => p.name === session);
    if (!project) return res.status(404).send('not found');
    const projectPath = project.path.replace('~', os.homedir());
    const fullPath = path.resolve(path.join(projectPath, 'output', filePath));
    if (!fullPath.startsWith(path.resolve(path.join(projectPath, 'output')))) {
      return res.status(403).send('forbidden');
    }
    res.sendFile(fullPath);
  });

  app.get('/api/ports/:session', (req, res) => {
    const session = req.params.session;
    const isDevPort = p => DEV_PORT_RANGES.some(([lo, hi]) => p >= lo && p <= hi);
    try {
      const pids = execSync(`tmux list-panes -s -t '${session}' -F '#{pane_pid}' 2>/dev/null`, { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
      const ports = new Set();
      for (const pid of pids) {
        try {
          const children = execSync(`pgrep -P ${pid} 2>/dev/null`, { encoding: 'utf8' })
            .trim().split('\n').filter(Boolean);
          children.push(pid);
          for (const cpid of children) {
            try {
              const lsof = execSync(`lsof -iTCP -sTCP:LISTEN -P -n -p ${cpid} 2>/dev/null`, { encoding: 'utf8' });
              for (const m of lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
                const p = parseInt(m[1]);
                if (isDevPort(p)) ports.add(p);
              }
            } catch {}
          }
        } catch {}
      }
      res.json({ ports: [...ports].sort((a, b) => a - b).map(p => ({ port: p, url: `http://localhost:${p}` })) });
    } catch {
      res.json({ ports: [] });
    }
  });

  app.get('/api/projects/discover', (req, res) => {
    const found = [];
    for (const dir of searchDirs()) {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          const hasClaude = fs.existsSync(path.join(full, 'CLAUDE.md'));
          const hasGit = fs.existsSync(path.join(full, '.git'));
          const hasPkg = fs.existsSync(path.join(full, 'package.json'));
          const hasPy = fs.existsSync(path.join(full, 'setup.py')) || fs.existsSync(path.join(full, 'pyproject.toml'));
          if (hasClaude || hasGit || hasPkg || hasPy) {
            found.push({ name: e.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'), path: full, hasClaude, hasGit });
          }
        }
      } catch {}
    }
    const configured = new Set(readProjects().map(p => p.path));
    res.json({ projects: found.filter(p => !configured.has(p.path)) });
  });

  // Merges projects.conf (curated names + descriptions) with ~/.claude/projects/ history.
  app.get('/api/projects/inactive', (req, res) => {
    let running = new Set();
    try {
      const raw = execSync(`tmux list-sessions -F '#{session_name}' 2>/dev/null`, { encoding: 'utf8' }).trim();
      running = new Set(raw.split('\n').filter(Boolean));
    } catch {}

    const activeDisplayNames = new Set();
    const activePaths = new Set();
    for (const s of attention.lastSessions()) {
      if (s.displayName) activeDisplayNames.add(s.displayName.toLowerCase());
      activeDisplayNames.add(s.name.toLowerCase());
      if (s.projectName) activeDisplayNames.add(s.projectName.toLowerCase());
      if (s.path) activePaths.add(s.path);
    }

    const byPath = new Map();
    for (const p of readProjects()) {
      if (!p.path) continue;
      byPath.set(p.path, { name: p.name, path: p.path, description: p.description || '' });
    }
    for (const p of readClaudeProjectHistory()) {
      if (byPath.has(p.path)) byPath.get(p.path).lastActivity = p.lastActivity;
      else byPath.set(p.path, { name: p.name, path: p.path, description: '', lastActivity: p.lastActivity });
    }

    const merged = [];
    for (const p of byPath.values()) {
      if (running.has(p.name) || activeDisplayNames.has(p.name.toLowerCase())) continue;
      if (activePaths.has(p.path)) continue;
      let lastActivity = p.lastActivity || 0;
      if (!lastActivity) {
        const encoded = '-' + p.path.replace(/^\//, '').split('/').join('-');
        const claudeDir = path.join(os.homedir(), '.claude', 'projects', encoded);
        try { lastActivity = fs.statSync(claudeDir).mtimeMs; } catch {}
      }
      if (!lastActivity) {
        try {
          const ts = execSync(`git -C '${p.path}' log -1 --format=%ct 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
          if (ts) lastActivity = parseInt(ts) * 1000;
        } catch {}
      }
      if (!lastActivity) {
        try { lastActivity = fs.statSync(p.path).mtimeMs; } catch {}
      }
      merged.push({ ...p, lastActivity });
    }
    res.json({ projects: merged });
  });

  app.post('/api/projects/start', (req, res) => {
    const { name, projectPath } = req.body;
    if (!name || !projectPath) return res.status(400).json({ error: 'name and projectPath required' });
    if (!readProjects().find(p => p.name === name)) {
      fs.mkdirSync(path.dirname(CONF_PATH), { recursive: true });
      fs.appendFileSync(CONF_PATH, `${name}|${projectPath}|server|\n`);
    }
    try {
      execSync(`tmux has-session -t '${name}' 2>/dev/null`);
      return res.json({ ok: true, message: 'already running' });
    } catch {}
    try {
      const pane = execSync(`tmux new-session -d -P -F '#{pane_id}' -s '${name}' -n claude -c '${projectPath}'`, { encoding: 'utf8' }).trim();
      execSync(`tmux send-keys -t '${pane}' 'exec claude --dangerously-skip-permissions' Enter`);
      execSync(`tmux new-window -t '${name}' -n shell -c '${projectPath}'`);
      // Nobody can press the trust-this-folder keys from the phone, so Matrix answers for it.
      acceptStartupDialogs(pane).then(
        accepted => { if (accepted.length) console.log(`[trust] ${name}: accepted ${accepted.join(', ')}`); },
        err => console.error(`[trust] ${name}: ${err.message}`));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/projects/open-iterm', (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ error: 'session required' });
    try {
      execSync(`osascript -e '
      tell application "iTerm"
        activate
        create window with default profile
        tell current session of current window
          write text "tmux attach -t '"'"'${session}'"'"'"
        end tell
      end tell
    '`, { timeout: 5000 });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/sessions/:name', (req, res) => {
    try {
      execSync(`tmux kill-session -t '${req.params.name}' 2>/dev/null`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/skills', (req, res) => {
    const now = Date.now();
    if (now - skillsCacheTime > 30000) {
      try {
        skillsCache = fs.readdirSync(SKILLS_DIR)
          .filter(name => {
            try { return fs.statSync(path.join(SKILLS_DIR, name)).isDirectory(); } catch { return false; }
          })
          .sort();
      } catch { skillsCache = []; }
      skillsCacheTime = now;
    }
    res.json(skillsCache);
  });
}

module.exports = { mount };
