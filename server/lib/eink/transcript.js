// Incremental reader for a Claude Code transcript (JSONL). Purely extractive:
// it never summarises. It tracks the last human prompt and the last complete
// main-agent text message, and reports every way the file can be untrustworthy
// instead of guessing.
const SUPPORTED = 'claude-code-jsonl/1';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function createTranscriptReader({ path: file, fs = require('fs') }) {
  let offset = 0;
  let ino = null;
  let tail = ''; // bytes after the last newline: an incomplete record, never parsed
  let lineNo = 0;
  let resetThisPoll = false;
  let promptThisPoll = false;
  const state = {
    schema: SUPPORTED,
    fileError: null, // missing/unreadable right now; cleared by the next successful read
    recordError: null, // malformed/unsupported; sticky until a new human prompt is read
    resetNote: null, // replaced/truncated; sticky until a later read brings a new human prompt
    lastPrompt: null, // { text, uuid }
    assistant: null, // { messageId, text, complete } most recent main-agent text since the last prompt
    malformed: 0,
    size: 0,
  };

  function reset(reason) {
    offset = 0;
    tail = '';
    lineNo = 0;
    state.lastPrompt = null;
    state.assistant = null;
    state.recordError = null;
    state.resetNote = reason;
    resetThisPoll = true;
  }

  function humanText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return undefined;
    if (content.some((b) => b && b.type === 'tool_result')) return null; // tool output, not a human prompt
    const texts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    return texts.length ? texts.join('\n') : null;
  }

  function apply(rec) {
    if (rec === null || typeof rec !== 'object' || typeof rec.type !== 'string') {
      state.malformed += 1;
      state.recordError = `transcript line ${lineNo} is not a recognised record`;
      return;
    }
    if (rec.isSidechain === true) return; // subagent content never substitutes for the main agent
    if (rec.type === 'user') {
      if (rec.isMeta === true || rec.isCompactSummary === true) return;
      const msg = rec.message;
      if (!msg || typeof msg !== 'object') {
        state.recordError = `unsupported transcript schema: user record without message (line ${lineNo})`;
        return;
      }
      const text = humanText(msg.content);
      if (text === undefined) {
        state.recordError = `unsupported transcript schema: user content has unexpected shape (line ${lineNo})`;
        return;
      }
      if (text !== null) {
        state.lastPrompt = { text, uuid: rec.uuid || null };
        state.assistant = null;
        state.recordError = null; // a new turn starts from clean evidence
        promptThisPoll = true;
      }
      return;
    }
    if (rec.type === 'assistant') {
      const msg = rec.message;
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
        state.recordError = `unsupported transcript schema: assistant record without content blocks (line ${lineNo})`;
        return;
      }
      const text = msg.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n');
      if (!text) return; // tool_use / thinking blocks are not the message
      const id = msg.id || rec.uuid || `line-${lineNo}`;
      if (state.assistant && state.assistant.messageId === id) state.assistant.text += '\n\n' + text;
      else state.assistant = { messageId: id, text };
    }
    // Every other record type (system, summary, snapshots, queue operations) carries no digest field.
  }

  // Reads whatever was appended since the last call. Returns { grew } and
  // updates state. A shrinking or replaced file resets and is reported.
  function poll() {
    resetThisPoll = false;
    promptThisPoll = false;
    let st;
    try {
      st = fs.statSync(file);
    } catch (err) {
      state.fileError = err.code === 'ENOENT' ? 'transcript file is missing' : `transcript unreadable: ${err.message}`;
      return { grew: false };
    }
    if (ino !== null && st.ino !== ino) reset('transcript file was replaced; re-reading from the start');
    else if (st.size < offset) reset('transcript file was truncated; re-reading from the start');
    ino = st.ino;
    state.size = st.size;
    state.fileError = null;
    if (st.size === offset) return { grew: false };
    let chunk;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(st.size - offset);
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        chunk = buf.subarray(0, n).toString('utf8');
        offset += n;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      state.fileError = `transcript unreadable: ${err.message}`;
      return { grew: false };
    }
    const text = tail + chunk;
    const lines = text.split('\n');
    tail = lines.pop(); // incomplete trailing line stays buffered
    for (const line of lines) {
      lineNo += 1;
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        state.malformed += 1;
        state.recordError = `transcript line ${lineNo} is malformed JSON`;
        continue;
      }
      apply(rec);
    }
    // A truncation/replacement stays reported for the read that discovered it.
    if (!resetThisPoll && promptThisPoll) state.resetNote = null;
    return { grew: true };
  }

  // The prompt/message as of now. `complete` is decided by the caller: only a
  // proven turn boundary (main-agent Stop) makes the assistant text a complete message.
  function view() {
    return {
      error: state.fileError || state.recordError || state.resetNote,
      malformed: state.malformed,
      hasPartialLine: tail.length > 0,
      prompt: state.lastPrompt ? state.lastPrompt.text : null,
      assistantText: state.assistant ? state.assistant.text : null,
      size: state.size,
    };
  }

  return { poll, view, file };
}

module.exports = { createTranscriptReader, WRITE_TOOLS, SUPPORTED };
