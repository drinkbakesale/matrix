// Versioned adapter that reads the permission choices actually displayed in a
// Claude Code terminal pane. It recognises one prompt layout and nothing else:
// an unknown layout yields "choices unavailable", never invented options.
//
// Recognised layout (claude-permission-prompt/1): near the bottom of the pane,
// a question line ending in "?" followed by consecutively numbered options
// starting at 1, the highlighted one prefixed by "❯".
const VERSION = 'claude-permission-prompt/1';
const OPTION = /^\s*(?:[│|]\s*)?(❯|>)?\s*(\d)\.\s+(.+?)\s*(?:[│|])?\s*$/;

function parsePermissionPrompt(paneText) {
  const lines = String(paneText || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  // Find the last run of consecutive numbered option lines.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OPTION.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { version: VERSION, ok: false, reason: 'no numbered choices visible in the terminal' };
  let start = end;
  while (start - 1 >= 0 && OPTION.test(lines[start - 1])) start -= 1;
  const options = [];
  let sawCursor = false;
  for (let i = start; i <= end; i++) {
    const m = OPTION.exec(lines[i]);
    if (m[1]) sawCursor = true;
    options.push({ key: m[2], label: m[3] });
  }
  const sequential = options.every((o, i) => o.key === String(i + 1));
  if (!sequential || options.length < 2 || options.length > 9) {
    return { version: VERSION, ok: false, reason: 'terminal choices are not a recognised numbered list' };
  }
  if (!sawCursor) return { version: VERSION, ok: false, reason: 'numbered list has no selection cursor; not a recognised prompt' };
  let question = '';
  for (let i = start - 1; i >= 0 && i >= start - 6; i--) {
    const t = lines[i].replace(/^[\s│|]+|[\s│|]+$/g, '');
    if (t.endsWith('?')) { question = t; break; }
  }
  if (!question) return { version: VERSION, ok: false, reason: 'no question line above the terminal choices' };
  return { version: VERSION, ok: true, question, options };
}

module.exports = { parsePermissionPrompt, VERSION };
