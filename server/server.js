const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { execSync, exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const webpush = require('web-push');

// ── Configurable Paths ──
const MATRIX_HOME = process.env.MATRIX_HOME || path.join(os.homedir(), '.matrix');
const CONF_PATH = path.join(MATRIX_HOME, 'projects.conf');
const PATH_REGISTRY_PATH = path.join(MATRIX_HOME, 'project-paths.conf');
const VAPID_PATH = path.join(MATRIX_HOME, 'vapid.json');
const SUBS_PATH = path.join(MATRIX_HOME, 'push-subscriptions.json');
const LOGS_DIR = path.join(MATRIX_HOME, 'logs');
const PYTHON_PATH = process.env.PYTHON_PATH || 'python3';
const PORT = parseInt(process.env.MATRIX_PORT, 10) || 7778;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Web Push Setup ──
let vapid = null;
try {
  vapid = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
  webpush.setVapidDetails('mailto:matrix@localhost', vapid.publicKey, vapid.privateKey);
} catch (err) {
  console.warn(`[web-push] Could not load VAPID keys from ${VAPID_PATH}`);
  console.warn('[web-push] Run "npm run setup" to generate VAPID keys, or create vapid.json manually.');
  console.warn('[web-push] Push notifications will be disabled until vapid.json exists.');
}

let pushSubscriptions = [];
try { pushSubscriptions = JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8')); } catch {}

function saveSubs() {
  try {
    fs.mkdirSync(path.dirname(SUBS_PATH), { recursive: true });
    fs.writeFileSync(SUBS_PATH, JSON.stringify(pushSubscriptions));
  } catch (err) {
    console.error('[push] failed to save subscriptions:', err.message);
  }
}

async function sendPush(title, body, session) {
  if (!vapid) return; // Push not configured
  const payload = JSON.stringify({ title, body, session });
  const dead = [];
  for (let i = 0; i < pushSubscriptions.length; i++) {
    try {
      await webpush.sendNotification(pushSubscriptions[i], payload);
      console.log(`[push] sent to sub ${i}`);
    } catch (err) {
      console.error(`[push] failed sub ${i}:`, err.statusCode || err.message, err.body || '');
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(i);
    }
  }
  if (dead.length) {
    pushSubscriptions = pushSubscriptions.filter((_, i) => !dead.includes(i));
    saveSubs();
  }
}

// ── SSE Notification System ──

const sseClients = new Set();

// No-cache headers for development
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// SSE: notification stream
app.get('/api/notifications/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// GET: VAPID public key for push subscription
app.get('/api/push/vapid-key', (req, res) => {
  if (!vapid) return res.status(503).json({ error: 'VAPID keys not configured. Run npm run setup.' });
  res.json({ publicKey: vapid.publicKey });
});

// POST: register push subscription
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  // Avoid duplicates
  if (!pushSubscriptions.find(s => s.endpoint === sub.endpoint)) {
    pushSubscriptions.push(sub);
    saveSubs();
  }
  res.json({ ok: true });
});

// Pending notifications — cleared when app fetches them
let pendingAlerts = [];
let pendingAttention = {}; // session → true when notification fired, cleared when user sends input
let lastSeenQuestions = {}; // session → last question text (to avoid re-triggering)

// POST: receive notification from cr-notify hook
app.post('/api/notify', (req, res) => {
  const { message, project, session } = req.body;
  const sess = session || project || '';
  const msg = message || 'Claude needs input';
  const notification = {
    type: 'notification',
    message: msg,
    project: project || '',
    session: sess,
    timestamp: Date.now(),
  };
  // Track pending alert so PWA can auto-open session on foreground
  pendingAlerts.push({ session: sess, message: msg, timestamp: Date.now() });
  // Mark session as needing attention (cleared when user sends input via /api/send or WS)
  pendingAttention[sess] = true;
  // SSE toast (in-app)
  const payload = `data: ${JSON.stringify(notification)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
  // Web Push (works when app is backgrounded)
  sendPush(project || 'Matrix', msg, sess);
  res.json({ ok: true, delivered: sseClients.size, pushSubs: pushSubscriptions.length });
});

// POST: transcribe audio (voice-to-text via whisper)
const audioUploadDir = path.join(os.tmpdir(), 'matrix-audio');
const upload = require('multer')({ dest: audioUploadDir });
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no audio' });
  const webmPath = req.file.path;
  const wavPath = webmPath + '.wav';
  try {
    // Convert webm to wav
    execSync(`ffmpeg -y -i '${webmPath}' -ar 16000 -ac 1 '${wavPath}' 2>/dev/null`);
    // Transcribe with whisper (tiny model for speed)
    const result = execSync(
      `${PYTHON_PATH} -c "
import whisper, json, sys
model = whisper.load_model('tiny')
r = model.transcribe('${wavPath}', fp16=False)
print(json.dumps({'text': r['text'].strip()}))
"`,
      { encoding: 'utf8', timeout: 30000 }
    );
    const { text } = JSON.parse(result.trim());
    res.json({ text });
  } catch (err) {
    console.error('[transcribe] error:', err.message);
    res.json({ text: '' });
  } finally {
    try { fs.unlinkSync(webmPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
});

// GET: list output files for a project
app.get('/api/outputs/:session', (req, res) => {
  const session = req.params.session;
  // Find project path from config
  const projects = readProjects ? readProjects() : [];
  const project = projects.find(p => p.name === session);
  if (!project) return res.json({ files: [], images: [] });

  const projectPath = project.path.replace('~', os.homedir());
  const outputDir = path.join(projectPath, 'output');

  const files = [];
  const images = [];
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];

  function scanDir(dir, prefix) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          scanDir(fullPath, relPath);
        } else {
          const stat = fs.statSync(fullPath);
          const ext = path.extname(entry.name).toLowerCase();
          const item = {
            name: relPath,
            size: stat.size,
            mtime: stat.mtimeMs,
            ext: ext,
          };
          files.push(item);
          if (imageExts.includes(ext)) {
            images.push({ name: relPath, path: `/api/file?session=${encodeURIComponent(session)}&path=${encodeURIComponent(relPath)}` });
          }
        }
      }
    } catch {}
  }

  scanDir(outputDir, '');
  // Sort by most recent first
  files.sort((a, b) => b.mtime - a.mtime);
  images.sort((a, b) => {
    const fa = files.find(f => f.name === a.name);
    const fb = files.find(f => f.name === b.name);
    return (fb?.mtime || 0) - (fa?.mtime || 0);
  });

  res.json({ files: files.slice(0, 100), images: images.slice(0, 50) });
});

// GET: serve a file from a project's output directory
app.get('/api/file', (req, res) => {
  const session = req.query.session;
  const filePath = req.query.path;
  if (!session || !filePath) return res.status(400).send('missing session or path');

  const projects = readProjects ? readProjects() : [];
  const project = projects.find(p => p.name === session);
  if (!project) return res.status(404).send('not found');

  const projectPath = project.path.replace('~', os.homedir());
  const fullPath = path.resolve(path.join(projectPath, 'output', filePath));

  // Prevent directory traversal
  if (!fullPath.startsWith(path.resolve(path.join(projectPath, 'output')))) {
    return res.status(403).send('forbidden');
  }

  res.sendFile(fullPath);
});

// GET: detect localhost ports for a project (only common dev server ports)
app.get('/api/ports/:session', (req, res) => {
  const session = req.params.session;
  // Common dev server port ranges
  const devPortRanges = [
    [3000, 3010], [4000, 4010], [5000, 5010], [5173, 5175],
    [8000, 8010], [8080, 8090], [8180, 8190], [8888, 8888],
    [9000, 9010], [4200, 4200], [4321, 4322],
  ];
  function isDevPort(p) {
    return devPortRanges.some(([lo, hi]) => p >= lo && p <= hi);
  }

  try {
    const pids = execSync(
      `tmux list-panes -s -t '${session}' -F '#{pane_pid}' 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim().split('\n').filter(Boolean);

    const ports = new Set();
    for (const pid of pids) {
      try {
        // Get direct child process tree (2 levels deep)
        const children = execSync(
          `pgrep -P ${pid} 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim().split('\n').filter(Boolean);
        children.push(pid);

        for (const cpid of children) {
          try {
            const lsof = execSync(
              `lsof -iTCP -sTCP:LISTEN -P -n -p ${cpid} 2>/dev/null`,
              { encoding: 'utf8' }
            );
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

// GET: check for pending alerts (PWA polls on foreground)
app.get('/api/pending-alert', (req, res) => {
  if (pendingAlerts.length === 0) return res.json({ alert: null });
  const latest = pendingAlerts[pendingAlerts.length - 1];
  pendingAlerts = [];
  res.json({ alert: latest });
});

// API: test notification
app.post('/api/test-notify', (req, res) => {
  const notification = {
    type: 'notification',
    message: req.body.message || 'Test notification from Matrix',
    project: 'test',
    session: 'test',
    timestamp: Date.now(),
  };
  const payload = `data: ${JSON.stringify(notification)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
  res.json({ ok: true, delivered: sseClients.size });
});

// API: list tmux sessions with window info
app.get('/api/sessions', (req, res) => {
  try {
    const raw = execSync(
      `tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_attached}|#{session_path}|#{session_activity}' 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();

    const sessions = raw.split('\n').filter(Boolean).map(line => {
      const [name, windows, attached, sessionPath, activityTs] = line.split('|');

      let windowList = [];
      try {
        const winRaw = execSync(
          `tmux list-windows -t '${name}' -F '#{window_index}|#{window_name}|#{window_active}' 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();
        windowList = winRaw.split('\n').filter(Boolean).map(w => {
          const [index, wname, active] = w.split('|');
          return { index: parseInt(index), name: wname, active: active === '1' };
        });
      } catch {}

      let claudeRunning = false;
      let projectPath = sessionPath;
      let paneTitle = '';
      try {
        const paneInfo = execSync(
          `tmux list-panes -s -t '${name}' -F '#{pane_current_command}|#{pane_current_path}|#{pane_title}' 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();
        const panes = paneInfo.split('\n');
        // Claude CLI shows as 'claude' or as version number like '2.1.85'
        const isClaudeCmd = (cmd) => cmd.includes('claude') || /^\d+\.\d+\.\d+$/.test(cmd.trim());
        claudeRunning = panes.some(p => isClaudeCmd(p.split('|')[0]));
        // Get info from the first claude pane, or first pane
        const claudePane = panes.find(p => isClaudeCmd(p.split('|')[0]));
        const parts = (claudePane || panes[0])?.split('|');
        if (parts?.[1]) projectPath = parts[1];
        if (parts?.[2]) paneTitle = parts[2];
      } catch {}

      // Derive display name using a priority chain:
      // 1. tmux @matrix_project variable (explicit, highest priority)
      // 2. Path registry match on pane cwd
      // 3. Path registry match on file paths found in scrollback
      // 4. Pane cwd folder name (if not ~)
      // 5. Scrollback heuristic (most-referenced project folder)
      // 6. tmux session name (if not a number)
      // 7. Fallback: raw session name
      const homeDir = os.homedir();
      const registry = buildPathRegistry();
      const folderName = projectPath ? path.basename(projectPath) : '';
      const isHomeDir = !projectPath || projectPath === homeDir || folderName === os.userInfo().username;

      let displayName = '';

      // Method 1: explicit tmux variable (set by session or hook)
      try {
        const explicit = execSync(
          `tmux show-option -t '${name}' -v @matrix_project 2>/dev/null`,
          { encoding: 'utf8', timeout: 1000 }
        ).trim();
        if (explicit) displayName = explicit;
      } catch {}

      // Method 2: match pane cwd against path registry (skip home dir — too broad)
      if (!displayName && projectPath && projectPath !== homeDir) {
        const match = matchProject(projectPath, registry);
        if (match) displayName = match;
      }

      // Method 3: scan RECENT scrollback (last 50 lines) for file paths,
      // match against registry. Only recent lines matter — old scrollback
      // contains stale references from previous work in this session.
      let scrollback = '';
      const systemNoisePaths = [
        '/.claude/hooks', '/.claude/settings', '/.claude/projects/',
        '/.claude/telemetry', '/.claude/rules/', '/.claude/plugins/',
        '/.pyenv/', '/.npm/', '/.nvm/', '/.ssh/', '/Library/',
      ];
      if (!displayName) {
        try {
          scrollback = execSync(
            `tmux capture-pane -t '${name}:0' -p -S -50 2>/dev/null`,
            { encoding: 'utf8', timeout: 2000 }
          );
          const pathRe = /(?:\/Users\/\w+|~)\/[^\s"',;:()[\]{}|>]+/g;
          const projectHits = {};
          let m;
          while ((m = pathRe.exec(scrollback)) !== null) {
            const filePath = m[0];
            const resolved = filePath.replace(/^~/, homeDir);
            if (systemNoisePaths.some(noise => resolved.includes(noise))) continue;
            const proj = matchProject(filePath, registry);
            if (proj) {
              projectHits[proj] = (projectHits[proj] || 0) + 1;
            }
          }
          // Require ≥3 hits in recent scrollback to be confident
          const sorted = Object.entries(projectHits)
            .filter(([, count]) => count >= 3)
            .sort((a, b) => b[1] - a[1]);
          if (sorted.length > 0) {
            displayName = sorted[0][0];
          }
        } catch {}
      }

      // Method 4: pane is in a project directory (not ~)
      if (!displayName && !isHomeDir && folderName) {
        displayName = folderName;
      }

      // Method 5: scrollback heuristic — most-referenced project folder in recent lines
      if (!displayName) {
        try {
          if (!scrollback) {
            scrollback = execSync(
              `tmux capture-pane -t '${name}:0' -p -S -50 2>/dev/null`,
              { encoding: 'utf8', timeout: 2000 }
            );
          }
          const re = /(?:~|\/Users\/\w+)\/(Desktop|Projects|Downloads|Documents)\/([^\s/"',;:()[\]{}]+)/g;
          const projCounts = {};
          let m;
          while ((m = re.exec(scrollback)) !== null) {
            const dir = m[2];
            if (dir.length > 2 && !dir.startsWith('.')) {
              projCounts[dir] = (projCounts[dir] || 0) + 1;
            }
          }
          const sorted = Object.entries(projCounts).sort((a, b) => b[1] - a[1]);
          if (sorted.length > 0) {
            displayName = sorted[0][0];
          }
        } catch {}
      }

      // Method 6: derive from tmux session name (strip numeric suffix)
      if (!displayName) {
        const baseName = name.replace(/-\d+$/, '');
        if (!/^\d+$/.test(baseName)) {
          displayName = baseName;
        }
      }

      // Method 7: fallback to session name
      if (!displayName) {
        displayName = name;
      }

      // Look up description from projects.conf or auto-detect
      const confProjects = readProjects();
      let description = '';
      const confMatch = confProjects.find(p =>
        p.name === name || p.name === displayName?.toLowerCase() ||
        p.path === projectPath
      );
      if (confMatch?.description) {
        description = confMatch.description;
      } else {
        description = detectDescription(projectPath);
      }

      // needsAttention is driven by notification hooks, not tmux parsing.
      // Check by session name AND by displayName (cr-notify may use either)
      let needsAttention = !!pendingAttention[name] ||
        !!pendingAttention[displayName] ||
        !!pendingAttention[displayName.toLowerCase()];

      const lastActivity = parseInt(activityTs) || 0;

      return {
        name,
        displayName,
        description,
        windows: parseInt(windows),
        attached: attached === '1',
        path: projectPath,
        windowList,
        claudeRunning,
        needsAttention,
        lastActivity
      };
    });

    // Deduplicate: one entry per displayName. When multiple sessions share
    // the same project name, keep the most recently active one.
    // Sessions whose displayName is just their number (undetected) stay individual.
    const groups = new Map(); // displayName (lowercase) → best session

    for (const s of sessions) {
      const key = s.displayName.toLowerCase();

      // Undetected sessions (displayName is just the tmux number) are unique — never merge
      if (/^\d+$/.test(key)) {
        groups.set(`__numbered_${s.name}`, s);
        continue;
      }

      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, s);
      } else {
        // Pick winner: Claude running beats not, then most recent activity
        const newWins =
          (s.claudeRunning && !existing.claudeRunning) ||
          (s.claudeRunning === existing.claudeRunning && s.lastActivity > existing.lastActivity);
        const winner = newWins ? s : existing;
        const loser = newWins ? existing : s;

        // Merge attention: if ANY session for this project needs attention, show it
        if (loser.needsAttention) winner.needsAttention = true;

        groups.set(key, winner);
      }
    }

    const deduped = [...groups.values()];

    // Sort: needs-attention first, then by most recent activity
    deduped.sort((a, b) => {
      if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
      return b.lastActivity - a.lastActivity;
    });

    global._lastSessions = deduped;
    res.json({ sessions: deduped });
  } catch {
    res.json({ sessions: [] });
  }
});

// API: send text to a tmux pane
app.post('/api/send', (req, res) => {
  const { session, text } = req.body;
  if (!session || !text) return res.status(400).json({ error: 'session and text required' });
  try {
    execSync(`tmux send-keys -t '${session}' ${JSON.stringify(text)} Enter`);
    delete pendingAttention[session];
    delete lastSeenQuestions[session];
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: list all known projects from projects.conf (not just running ones)

function readProjects() {
  try {
    return fs.readFileSync(CONF_PATH, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.trim().startsWith('#'))
      .map(l => {
        const parts = l.split('|');
        const [name, rawPath, mode, roles, description] = parts;
        const fullPath = rawPath.replace(/^~/, os.homedir());
        return { name, path: fullPath, description: description || '' };
      });
  } catch { return []; }
}

// Build a sorted (longest-first) list of path→projectName mappings
// from projects.conf + project-paths.conf
function buildPathRegistry() {
  const entries = []; // { prefix, name }
  const homeDir = os.homedir();

  // From projects.conf: path → name (skip home dir — too broad)
  for (const p of readProjects()) {
    if (p.path && p.name && p.path !== homeDir) {
      entries.push({ prefix: p.path, name: p.name });
    }
  }

  // From project-paths.conf: path|name
  try {
    const lines = fs.readFileSync(PATH_REGISTRY_PATH, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [rawPath, name] = line.split('|').map(s => s.trim());
      if (rawPath && name) {
        const fullPath = rawPath.replace(/^~/, os.homedir());
        entries.push({ prefix: fullPath, name });
      }
    }
  } catch {}

  // Sort longest prefix first (most specific match wins)
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return entries;
}

// Match a file path against the registry
function matchProject(filePath, registry) {
  if (!filePath) return null;
  const resolved = filePath.replace(/^~/, os.homedir());
  for (const entry of registry) {
    if (resolved.startsWith(entry.prefix)) {
      return entry.name;
    }
  }
  return null;
}

// Auto-detect a project description from common files
function detectDescription(projectPath) {
  if (!projectPath || projectPath === os.homedir()) return '';
  try {
    // Try package.json description
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.description) return pkg.description;
    }
    // Try pyproject.toml description
    const pyprojectPath = path.join(projectPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      const content = fs.readFileSync(pyprojectPath, 'utf8');
      const m = content.match(/description\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
    // Try first heading line from README.md (skip the title, get the description line)
    for (const readme of ['README.md', 'readme.md', 'Readme.md']) {
      const readmePath = path.join(projectPath, readme);
      if (fs.existsSync(readmePath)) {
        const lines = fs.readFileSync(readmePath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          // Skip empty lines, headings, badges, and HTML
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') ||
              trimmed.startsWith('<') || trimmed.startsWith('!')) continue;
          if (trimmed.length > 10 && trimmed.length < 200) return trimmed;
        }
      }
    }
  } catch {}
  return '';
}

// Auto-discover projects: scan common dirs for CLAUDE.md or .git
app.get('/api/projects/discover', (req, res) => {
  const searchDirs = ['~/Desktop', '~/Projects', '~/Downloads', '~/Documents'].map(d => d.replace('~', os.homedir()));
  const found = [];
  for (const dir of searchDirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
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
  // Filter out already-configured projects
  const configured = new Set(readProjects().map(p => p.path));
  const available = found.filter(p => !configured.has(p.path));
  res.json({ projects: available });
});

// API: list configured but not-running projects with last activity timestamps
app.get('/api/projects/inactive', (req, res) => {
  const configured = readProjects();
  let running = new Set();
  try {
    const raw = execSync(`tmux list-sessions -F '#{session_name}' 2>/dev/null`, { encoding: 'utf8' }).trim();
    running = new Set(raw.split('\n').filter(Boolean));
  } catch {}

  // Also check which displayNames are active (to dedup against scrollback-detected names)
  let activeDisplayNames = new Set();
  try {
    const sessData = global._lastSessions || [];
    for (const s of sessData) {
      activeDisplayNames.add(s.displayName.toLowerCase());
      activeDisplayNames.add(s.name.toLowerCase());
    }
  } catch {}

  const inactive = configured
    .filter(p => !running.has(p.name) && !activeDisplayNames.has(p.name.toLowerCase()))
    .map(p => {
      let lastActivity = 0;
      const projPath = p.path;
      // Try git log for last commit date
      try {
        const ts = execSync(
          `git -C '${projPath}' log -1 --format=%ct 2>/dev/null`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        if (ts) lastActivity = parseInt(ts) * 1000;
      } catch {}
      // Fallback: directory mtime
      if (!lastActivity) {
        try {
          const stat = fs.statSync(projPath);
          lastActivity = stat.mtimeMs;
        } catch {}
      }
      return { ...p, lastActivity };
    });

  res.json({ projects: inactive });
});

// API: add a project to projects.conf and start it
app.post('/api/projects/start', (req, res) => {
  const { name, projectPath } = req.body;
  if (!name || !projectPath) return res.status(400).json({ error: 'name and projectPath required' });

  // Add to projects.conf if not already there
  const configured = readProjects();
  if (!configured.find(p => p.name === name)) {
    fs.mkdirSync(path.dirname(CONF_PATH), { recursive: true });
    fs.appendFileSync(CONF_PATH, `${name}|${projectPath}|server|\n`);
  }

  // Start tmux session with claude
  try {
    execSync(`tmux has-session -t '${name}' 2>/dev/null`);
    return res.json({ ok: true, message: 'already running' });
  } catch {}

  try {
    execSync(`tmux new-session -d -s '${name}' -n claude -c '${projectPath}'`);
    execSync(`tmux send-keys -t '${name}:claude' 'exec claude --dangerously-skip-permissions' Enter`);
    execSync(`tmux new-window -t '${name}' -n shell -c '${projectPath}'`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: open a tmux session in iTerm2
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

// API: kill a tmux session
app.delete('/api/sessions/:name', (req, res) => {
  const { name } = req.params;
  try {
    execSync(`tmux kill-session -t '${name}' 2>/dev/null`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket: tmux pane streaming via capture-pane polling ──

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const session = url.searchParams.get('session');
  let window = url.searchParams.get('window') || '';

  if (!session) {
    ws.close(1008, 'session parameter required');
    return;
  }

  // Auto-detect window with claude running
  if (!window) {
    try {
      const panes = execSync(
        `tmux list-panes -s -t '${session}' -F '#{window_name}|#{pane_current_command}' 2>/dev/null`,
        { encoding: 'utf8' }
      ).trim().split('\n');
      const claudePane = panes.find(p => {
        const cmd = p.split('|')[1] || '';
        return cmd.includes('claude') || /^\d+\.\d+\.\d+$/.test(cmd.trim());
      });
      if (claudePane) window = claudePane.split('|')[0];
    } catch {}
  }

  const target = window ? `${session}:${window}` : session;
  console.log(`[ws] streaming tmux target: ${target}`);

  let pollInterval = null;
  let captureErrors = 0;
  let lastLineCount = 0;    // how many lines we've sent from scrollback
  let lastFullText = '';     // full capture text for change detection

  // Get current tmux pane size (never resize it — local iTerm2 owns the size)
  function getPaneSize() {
    try {
      const info = execSync(
        `tmux display-message -t '${target}' -p '#{pane_width}|#{pane_height}' 2>/dev/null`,
        { encoding: 'utf8' }
      ).trim();
      const [w, h] = info.split('|');
      return { cols: parseInt(w) || 80, rows: parseInt(h) || 24 };
    } catch {
      return { cols: 80, rows: 24 };
    }
  }

  // Capture full scrollback + visible screen as plain text (no ANSI)
  function captureAll() {
    try {
      return execSync(
        `tmux capture-pane -t '${target}' -p -S - 2>/dev/null`,
        { encoding: 'utf8' }
      );
    } catch {
      return '';
    }
  }

  // The phone is a LOG VIEWER, not a screen mirror.
  // We NEVER clear the screen. We only APPEND new lines.
  // This preserves scrollback so the user can scroll up through conversation.
  function initStreaming() {
    const size = getPaneSize();
    ws.send(JSON.stringify({ type: 'pane-size', cols: size.cols, rows: size.rows }));

    // Send full scrollback + visible screen on connect
    const all = captureAll();
    if (all.trim()) {
      ws.send(JSON.stringify({ type: 'output', data: all.replace(/\n/g, '\r\n') }));
    }
    const lines = all.split('\n');
    lastLineCount = lines.length;
    lastFullText = all;

    // Poll for new content at ~100ms for near-realtime updates.
    // Sends new scrollback lines AND visible-screen changes.
    let lastVisibleText = '';
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(() => {
      if (ws.readyState !== 1) {
        clearInterval(pollInterval);
        return;
      }
      try {
        const current = captureAll();
        captureErrors = 0;

        if (current === lastFullText) return; // nothing changed

        const currentLines = current.split('\n');

        if (currentLines.length > lastLineCount) {
          // Scrollback grew — send genuinely new lines
          const newLines = currentLines.slice(lastLineCount);
          ws.send(JSON.stringify({ type: 'output', data: newLines.join('\r\n') + '\r\n' }));
          lastVisibleText = '';
        } else if (currentLines.length === lastLineCount) {
          // Same line count but content changed — visible screen update.
          // Send the changed visible portion as a screen refresh.
          const size = getPaneSize();
          const visibleLines = currentLines.slice(-size.rows);
          const visibleText = visibleLines.join('\n');
          if (visibleText !== lastVisibleText) {
            ws.send(JSON.stringify({ type: 'screen', data: visibleText }));
            lastVisibleText = visibleText;
          }
        }

        lastLineCount = currentLines.length;
        lastFullText = current;
      } catch {
        captureErrors++;
        if (captureErrors > 20) {
          clearInterval(pollInterval);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'exit', code: 0 }));
            ws.close();
          }
        }
      }
    }, 100);
  }

  // Start streaming immediately
  initStreaming();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input') {
        const hex = Buffer.from(msg.data).toString('hex').match(/.{2}/g).map(h => '0x' + h).join(' ');
        execSync(`tmux send-keys -t '${target}' -H ${hex} 2>/dev/null`);
        // Clear attention — user just sent input
        delete pendingAttention[session];
        delete lastSeenQuestions[session];
      } else if (msg.type === 'resize') {
        // Re-send pane size (phone may have rotated or keyboard toggled)
        const size = getPaneSize();
        ws.send(JSON.stringify({ type: 'pane-size', cols: size.cols, rows: size.rows }));
      }
    } catch {}
  });

  // Ping keepalive every 15s to prevent mobile timeout
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.ping(); } catch {}
    } else {
      clearInterval(pingInterval);
    }
  }, 15000);

  ws.on('close', () => {
    console.log(`[ws] client disconnected from ${target}`);
    clearInterval(pollInterval);
    clearInterval(pingInterval);
  });
});

// Periodically clear pendingAttention for sessions where Claude is no longer idle
// (user responded via iTerm or Claude started processing a new task)
setInterval(() => {
  for (const name of Object.keys(pendingAttention)) {
    try {
      const tail = execSync(
        `tmux capture-pane -t '${name}:0' -p -S -5 2>/dev/null`,
        { encoding: 'utf8', timeout: 1000 }
      );
      const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
      // If the last non-status lines show active processing, clear attention
      const hasSpinner = lines.some(l => /^[✻✳⏺]\s/.test(l) || /Running…|Working/i.test(l));
      const hasProgress = lines.some(l => /\d+%/.test(l) && (l.includes('░') || l.includes('█')));
      if (hasSpinner || hasProgress) {
        delete pendingAttention[name];
      }
    } catch {}
  }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Matrix running on http://0.0.0.0:${PORT}`);
  console.log(`Config directory: ${MATRIX_HOME}`);
  console.log(`SSE notifications enabled (${sseClients.size} clients)`);
  if (!vapid) {
    console.log('WARNING: Push notifications disabled — run "npm run setup" to configure VAPID keys');
  }
});
