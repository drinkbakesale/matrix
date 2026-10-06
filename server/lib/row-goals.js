'use strict';
// The goal shown as the second line of each session row: the "Goal:" part of Claude Code's
// latest recap for that session (the same source as the pinned brief). Looked up in the
// background, never on the session-list request path, and re-read only when the session's
// transcript has grown since the last look.

const fs = require('fs');
const { createRecapReader } = require('./brief-recap');
const { buildEvidence } = require('./brief-evidence');
const { recapFields } = require('./brief-generator');

function createRowGoals({ linksDir, reader = createRecapReader({ linksDir }), statImpl = f => fs.statSync(f), readLink }) {
  const goals = new Map();
  const seen = new Map();   // session -> transcript size at the last read
  const linkOf = readLink || (name => {
    try { return JSON.parse(fs.readFileSync(require('path').join(linksDir, encodeURIComponent(name) + '.json'), 'utf8')); } catch { return null; }
  });

  function refreshOne(name) {
    const link = linkOf(name);
    if (!link || !link.transcriptPath) return;
    let size;
    try { size = statImpl(link.transcriptPath).size; } catch { return; }
    if (seen.get(name) === size) return;
    seen.set(name, size);
    const recap = reader.read({ name });
    const fields = recap ? recapFields(buildEvidence({ capture: '', recap }).items) : null;
    if (fields && fields.goal) goals.set(name, fields.goal.raw);
  }

  return {
    refresh(names) {
      for (const name of names) {
        try { refreshOne(name); } catch (err) { console.error(`[row-goals] ${name}: ${err.message}`); }
      }
      for (const name of [...goals.keys()]) if (!names.includes(name)) { goals.delete(name); seen.delete(name); }
    },
    get: name => goals.get(name) || null,
  };
}

module.exports = { createRowGoals };
