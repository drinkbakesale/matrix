'use strict';
// The short label shown as the second line of each session row ("resizing Matchi ads to
// 4:5"): Claude Code's latest recap for that session, condensed to a few words by
// server/lib/row-labeler.js. Looked up in the background, never on the session-list request
// path; the transcript is re-read only when it has grown, and a recap is only ever labelled
// once (labels persist in labelsFile across restarts).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRecapReader } = require('./brief-recap');

const MAX_CONCURRENT = 2;
const HINT_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_PROMPTS = 3;
const MAX_PROMPT_CHARS = 300;

// For a session with no recap yet: Claude Code's "ai-title" for it and the user's last few
// typed requests (not tool results, not injected <...> blocks), from the transcript's tail.
function readTranscriptHints(file) {
  const root = path.join(require('os').homedir(), '.claude', 'projects') + path.sep;
  const resolved = path.resolve(file);
  if (!resolved.startsWith(root) || !resolved.endsWith('.jsonl')) return null;
  let text;
  const fd = fs.openSync(resolved, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - HINT_SCAN_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally { fs.closeSync(fd); }
  let title = null;
  const prompts = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"ai-title"') && !line.includes('"type":"user"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') { title = rec.aiTitle; continue; }
    if (rec.type !== 'user' || !rec.message || rec.isMeta) continue;
    const c = rec.message.content;
    const said = typeof c === 'string' ? c
      : Array.isArray(c) && !c.some(p => p && p.type === 'tool_result') ? c.filter(p => p && p.type === 'text').map(p => p.text).join(' ') : '';
    // A request typed in "!" shell mode is stored as <bash-input>...</bash-input>.
    const clean = said.trim().replace(/^<bash-input>([\s\S]*)<\/bash-input>$/, '$1').trim();
    if (clean && !clean.startsWith('<')) prompts.push(clean.slice(0, MAX_PROMPT_CHARS));
  }
  const recent = prompts.slice(-MAX_PROMPTS);
  if (!title && !recent.length) return null;
  return [
    title ? `Session title: ${title}` : null,
    recent.length ? `The user's latest requests, oldest first:\n${recent.map(p => `- ${p}`).join('\n')}` : null,
  ].filter(Boolean).join('\n');
}

function createRowGoals({
  linksDir, labelsFile, labeler,
  reader = createRecapReader({ linksDir }), statImpl = f => fs.statSync(f), readLink,
  hintsOf = readTranscriptHints,
}) {
  if (!labeler) throw new Error('row goals require a labeler');
  const goals = new Map();     // session -> label (or "⚠ ..." when labelling failed)
  const seen = new Map();      // session -> transcript size at the last read
  const wanted = new Map();    // session -> recap key it should show
  const linkOf = readLink || (name => {
    try { return JSON.parse(fs.readFileSync(path.join(linksDir, encodeURIComponent(name) + '.json'), 'utf8')); } catch { return null; }
  });

  let cache = {};
  if (labelsFile) {
    try { cache = JSON.parse(fs.readFileSync(labelsFile, 'utf8')); } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[row-goals] ${labelsFile} unreadable, starting empty: ${err.message}`);
    }
  }
  const save = () => {
    if (!labelsFile) return;
    const tmp = labelsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, labelsFile);
  };

  const queue = [];
  const inFlight = new Set();
  let running = 0;
  function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      running++;
      labeler.label(job).then(label => {
        cache[job.key] = label;
        save();
        for (const [name, key] of wanted) if (key === job.key) goals.set(name, label);
      }, err => {
        console.error(`[row-goals] ${job.name}: ${err.message}`);
        for (const [name, key] of wanted) if (key === job.key) goals.set(name, `⚠ label failed: ${err.message}`);
      }).finally(() => { running--; inFlight.delete(job.key); pump(); });
    }
  }

  function refreshOne(name) {
    const link = linkOf(name);
    if (!link || !link.transcriptPath) return;
    let size;
    try { size = statImpl(link.transcriptPath).size; } catch { return; }
    if (seen.get(name) === size) return;
    seen.set(name, size);
    // The recap is the best account of the work; a session that has none yet is described
    // by Claude Code's own title for it and the user's latest requests.
    const recap = reader.read({ name });
    const source = recap && recap.text ? `Latest session recap:\n${recap.text}` : hintsOf(link.transcriptPath);
    if (!source) return;
    const project = link.project || name;
    const key = crypto.createHash('sha256').update(project + '\n' + source).digest('hex').slice(0, 32);
    wanted.set(name, key);
    if (cache[key]) { goals.set(name, cache[key]); return; }
    // Until the new label arrives the row keeps its previous one.
    if (!inFlight.has(key)) { inFlight.add(key); queue.push({ key, name, project, source }); pump(); }
  }

  return {
    refresh(names) {
      for (const name of names) {
        try { refreshOne(name); } catch (err) { console.error(`[row-goals] ${name}: ${err.message}`); }
      }
      for (const name of [...goals.keys()]) if (!names.includes(name)) { goals.delete(name); seen.delete(name); wanted.delete(name); }
    },
    get: name => goals.get(name) || null,
  };
}

module.exports = { createRowGoals };
