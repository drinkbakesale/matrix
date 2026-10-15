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

function createRowGoals({
  linksDir, labelsFile, labeler,
  reader = createRecapReader({ linksDir }), statImpl = f => fs.statSync(f), readLink,
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
    const recap = reader.read({ name });
    if (!recap || !recap.text) return;
    const project = link.project || name;
    const key = crypto.createHash('sha256').update(project + '\n' + recap.text).digest('hex').slice(0, 32);
    wanted.set(name, key);
    if (cache[key]) { goals.set(name, cache[key]); return; }
    // Until the new label arrives the row keeps its previous one.
    if (!inFlight.has(key)) { inFlight.add(key); queue.push({ key, name, project, recap: recap.text }); pump(); }
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
