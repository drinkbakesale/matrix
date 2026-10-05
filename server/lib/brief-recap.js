'use strict';
// Claude Code's own recap for a session, as brief evidence.
//
// When you come back to a session Claude Code writes a short "※ recap:" of the goal and where
// things stand, and records it in the conversation transcript as
//   {"type":"system","subtype":"away_summary","content":"Goal: ... (disable recaps in /config)"}.
// The Matrix hook (hooks/matrix-project-tag.js) records which transcript belongs to which
// tmux pane in <MATRIX_HOME>/session-links/<session>.json. This reader follows that link for
// the pane the brief is bound to and returns the latest recap, or null when there is none.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Busy sessions write megabytes between recaps, so the transcript is scanned backwards in
// chunks until a recap turns up, up to SCAN_LIMIT_BYTES from the end.
const CHUNK_BYTES = 512 * 1024;
const SCAN_LIMIT_BYTES = 16 * 1024 * 1024;
const CONFIG_HINT = /\s*\(disable recaps in \/config\)\s*$/i;

function createRecapReader({ linksDir, transcriptsRoot = path.join(os.homedir(), '.claude', 'projects'), fsImpl = fs } = {}) {
  if (!linksDir) throw new Error('recap reader requires the session-links directory');
  const root = path.resolve(transcriptsRoot) + path.sep;

  function readLink(sessionName) {
    let raw;
    try {
      raw = fsImpl.readFileSync(path.join(linksDir, encodeURIComponent(sessionName) + '.json'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;   // the hook has not seen this session yet
      throw err;
    }
    return JSON.parse(raw);
  }

  function latestRecap(rec) {
    if (rec.type !== 'system' || rec.subtype !== 'away_summary' || typeof rec.content !== 'string') return null;
    const text = rec.content.replace(CONFIG_HINT, '').trim();
    return text ? { text, at: Date.parse(rec.timestamp) || null } : null;
  }

  // Newest first: walk back from the end one chunk at a time, carrying any partial line over
  // to the next (earlier) chunk, and stop at the first recap.
  function scanBackwards(file) {
    const fd = fsImpl.openSync(file, 'r');
    try {
      const size = fsImpl.fstatSync(fd).size;
      const floor = Math.max(0, size - SCAN_LIMIT_BYTES);
      let end = size;
      let carry = Buffer.alloc(0);
      while (end > floor) {
        const start = Math.max(floor, end - CHUNK_BYTES);
        const chunk = Buffer.alloc(end - start);
        fsImpl.readSync(fd, chunk, 0, chunk.length, start);
        const buf = Buffer.concat([chunk, carry]);
        const text = buf.toString('utf8');
        const firstBreak = start > floor ? text.indexOf('\n') : -1;
        const complete = firstBreak >= 0 ? text.slice(firstBreak + 1) : text;
        carry = firstBreak >= 0 ? buf.subarray(0, Buffer.byteLength(text.slice(0, firstBreak + 1))) : Buffer.alloc(0);
        const lines = complete.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('away_summary')) continue;
          let rec;
          try { rec = JSON.parse(lines[i]); } catch { continue; }
          const recap = latestRecap(rec);
          if (recap) return recap;
        }
        end = start;
      }
      return null;
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  return {
    // `identity` is the brief's resolved binding: { name, target }, where target is the tmux
    // window id ('@N') the stream shows, or the session id ('$N') when no window was chosen.
    read(identity) {
      if (!identity || !identity.name) return null;
      const link = readLink(identity.name);
      if (!link || typeof link.transcriptPath !== 'string') return null;
      // A recap belongs to one Claude conversation in one pane; only use it for that window.
      if (typeof identity.target === 'string' && identity.target.startsWith('@') && link.windowId !== identity.target) return null;
      const file = path.resolve(link.transcriptPath);
      if (!file.startsWith(root) || !file.endsWith('.jsonl')) return null;   // never read outside transcripts
      try { return scanBackwards(file); } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
  };
}

module.exports = { createRecapReader };
