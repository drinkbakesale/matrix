'use strict';
// Claude Code's "※ recap" becomes the brief: the reader follows the hook's session link to the
// transcript, takes the latest away_summary for the bound window, and the extractive generator
// turns "Goal: <purpose>. <status>." into the two sentences, verbatim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRecapReader } = require('../server/lib/brief-recap');
const { buildEvidence } = require('../server/lib/brief-evidence');
const { createExtractiveGenerator, validateBriefOutput } = require('../server/lib/brief-generator');

// Real away_summary records in the shape Claude Code writes them.
const line = (content, ts) => JSON.stringify({ type: 'system', subtype: 'away_summary', content, timestamp: ts, isMeta: false });
const OLD = line('Goal: rebuild the Matchi page. The hero section is done. (disable recaps in /config)', '2026-10-02T13:25:01.408Z');
const NEW = line('Goal: Matrix audit, a mobile text-copy fix and pinned project summaries. The plan is done and it is building now. Nothing needs you yet. (disable recaps in /config)', '2026-10-02T13:34:17.908Z');

function fixture({ windowId = '@7', transcript = [OLD, '{"type":"user","message":"hi"}', NEW] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-recap-'));
  const transcripts = path.join(root, 'projects');
  const links = path.join(root, 'session-links');
  fs.mkdirSync(path.join(transcripts, '-Users-me'), { recursive: true });
  fs.mkdirSync(links);
  const file = path.join(transcripts, '-Users-me', 'abc.jsonl');
  fs.writeFileSync(file, transcript.join('\n') + '\n');
  fs.writeFileSync(path.join(links, '146.json'), JSON.stringify({ tmuxSession: '146', windowId, paneId: '%9', transcriptPath: file }));
  const reader = createRecapReader({ linksDir: links, transcriptsRoot: transcripts });
  return { reader, root, file, links };
}

test('the latest recap for the bound window is read, without the /config hint', () => {
  const { reader, root } = fixture();
  try {
    const recap = reader.read({ name: '146', target: '@7' });
    assert.match(recap.text, /^Goal: Matrix audit/);
    assert.doesNotMatch(recap.text, /disable recaps/);
    assert.equal(recap.at, Date.parse('2026-10-02T13:34:17.908Z'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no recap for another window, an unlinked session, or a transcript outside ~/.claude/projects', () => {
  const { reader, root, links } = fixture();
  try {
    assert.equal(reader.read({ name: '146', target: '@8' }), null, 'a different window');
    assert.equal(reader.read({ name: '999', target: '@7' }), null, 'no link yet');
    fs.writeFileSync(path.join(links, '146.json'), JSON.stringify({ tmuxSession: '146', windowId: '@7', transcriptPath: '/etc/passwd.jsonl' }));
    assert.equal(reader.read({ name: '146', target: '@7' }), null, 'outside the transcripts root');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a recap becomes both sentences, verbatim, and passes the literal-evidence check', async () => {
  const { reader, root } = fixture();
  try {
    const evidence = buildEvidence({ capture: '', recap: reader.read({ name: '146', target: '@7' }) });
    assert.equal(evidence.items[0].id, 'recap');
    const out = await createExtractiveGenerator().generate({ items: evidence.items });
    const brief = validateBriefOutput(out, evidence.items, { literalRequired: true });
    assert.equal(brief.goal.text, 'Matrix audit, a mobile text-copy fix and pinned project summaries');
    assert.equal(brief.current.text, 'The plan is done and it is building now');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a recap without a "Goal:" label uses its first two sentences', async () => {
  const items = buildEvidence({ capture: '', recap: { text: "We're building the Matchi landing page in scroll-worlds. I've finished the hero and am on the product grid." } }).items;
  const brief = validateBriefOutput(await createExtractiveGenerator().generate({ items }), items, { literalRequired: true });
  assert.equal(brief.goal.text, "We're building the Matchi landing page in scroll-worlds");
  assert.equal(brief.current.text, "I've finished the hero and am on the product grid");
});

test('with no recap the pane-based extraction still applies', async () => {
  const items = buildEvidence({ capture: '> The goal is to improve copy generation quality.\n\n> Right now we are adding a judging step.\n' }).items;
  const brief = validateBriefOutput(await createExtractiveGenerator().generate({ items }), items, { literalRequired: true });
  assert.match(brief.goal.text, /improve copy generation quality/);
});

test('a recap far back in a busy transcript is still found, across chunk boundaries', () => {
  const filler = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ type: 'assistant', n: i, text: 'x'.repeat(500 + (i % 37)) }));
  const { reader, root } = fixture({ transcript: [OLD, NEW, ...filler] });
  try {
    const recap = reader.read({ name: '146', target: '@7' });
    assert.ok(recap, 'found more than 1.5 MB back');
    assert.match(recap.text, /^Goal: Matrix audit/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
