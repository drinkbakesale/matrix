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

const TAIL_BYTES = 512 * 1024;
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

  // Only the tail is read: transcripts grow to many megabytes and the latest recap is near the end.
  function readTail(file) {
    const fd = fsImpl.openSync(file, 'r');
    try {
      const size = fsImpl.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fsImpl.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8');
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;   // drop a partial first line
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
      let tail;
      try { tail = readTail(file); } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
      const lines = tail.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('away_summary')) continue;
        let rec;
        try { rec = JSON.parse(lines[i]); } catch { continue; }
        if (rec.type !== 'system' || rec.subtype !== 'away_summary' || typeof rec.content !== 'string') continue;
        const text = rec.content.replace(CONFIG_HINT, '').trim();
        if (!text) continue;
        return { text, at: Date.parse(rec.timestamp) || null };
      }
      return null;
    },
  };
}

module.exports = { createRecapReader };
