'use strict';
// Files in Matrix message boxes: the message is split so attached paths are PASTED (Claude
// Code attaches a pasted image path, not a typed one); a dropped file keeps its original path
// only when exactly one file on the Mac matches name + size + modified time; uploads land in
// the uploads folder under a safe name.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { typeParts, checkParts } = require('../server/lib/type-parts');
const { locateOne, safeName, mount } = require('../server/lib/file-routes');

global.document = undefined;
const MatrixFiles = require('../server/public/matrix-files');

test('message parts: attached paths split out wherever they appear', () => {
  const input = {};
  assert.equal(MatrixFiles.parts(input, 'no files here'), null);
  MatrixFiles.track(input, '/u/a b.png');
  MatrixFiles.track(input, '/u/a b.png.txt');
  assert.deepEqual(MatrixFiles.parts(input, 'compare /u/a b.png.txt with /u/a b.png now'), [
    { text: 'compare ' }, { paste: '/u/a b.png.txt' }, { text: ' with ' }, { paste: '/u/a b.png' }, { text: ' now' },
  ], 'the longer path wins where one path starts with another');
  assert.deepEqual(MatrixFiles.parts(input, '/u/a b.png'), [{ paste: '/u/a b.png' }]);
  assert.equal(MatrixFiles.parts(input, 'the user deleted the path'), null, 'a removed path is just text');
  MatrixFiles.reset(input);
  assert.equal(MatrixFiles.parts(input, '/u/a b.png'), null, 'reset after send forgets attachments');
});

test('typeParts types text, pastes paths, then submits', async () => {
  const calls = []; const waits = []; const checks = [];
  await typeParts('%3', [{ text: 'look at ' }, { paste: '/Users/me/a b.png' }, { text: ' please' }],
    { run: async a => { if (a[0] === 'display-message') { checks.push(a); return '0'; } calls.push(a); return ''; }, wait: async ms => { waits.push(ms); } });
  assert.equal(checks.length, 1, 'checks for scroll mode once before typing');
  assert.equal(calls[0][0], 'send-keys');
  assert.deepEqual(calls[1].slice(0, 2), ['set-buffer', '-b']);
  assert.deepEqual(calls[1].slice(3), ['--', '/Users/me/a b.png']);
  assert.deepEqual(calls[2].slice(0, 2), ['paste-buffer', '-p']);
  assert.equal(calls[2][calls[2].indexOf('-b') + 1], calls[1][2], 'pastes the buffer it just set');
  assert.equal(calls[3][0], 'send-keys');
  assert.deepEqual(calls[4], ['send-keys', '-t', '%3', '-H', '0x0d']);
  assert.ok(waits.includes(1000), 'Enter waits for Claude to take in the pasted file');
});

test('parts are validated before anything is typed', () => {
  assert.throws(() => checkParts([]), /missing/);
  assert.throws(() => checkParts([{ paste: 'relative/path' }]), /absolute/);
  assert.throws(() => checkParts([{ paste: '/a\nb' }]), /absolute/);
  assert.throws(() => checkParts([{ text: 'x', paste: '/a' }]), /neither/);
  assert.doesNotThrow(() => checkParts([{ text: 'x' }, { paste: '/a/b.png' }]));
});

test('locate keeps the original only for exactly one name+size+mtime match', async () => {
  const st = (size, mtimeMs) => ({ isFile: () => true, size, mtimeMs });
  const files = { '/x/brief.pdf': st(10, 1000), '/y/brief.pdf': st(10, 1000), '/z/brief.pdf': st(11, 1000), '/w/old-brief.pdf': st(10, 1000) };
  const search = async () => Object.keys(files);
  const statImpl = p => files[p];
  assert.equal(await locateOne({ name: 'brief.pdf', size: 10, lastModified: 1000 }, { search, statImpl }), null, 'two copies: ambiguous');
  delete files['/y/brief.pdf'];
  assert.equal(await locateOne({ name: 'brief.pdf', size: 10, lastModified: 1500 }, { search, statImpl }), '/x/brief.pdf');
  assert.equal(await locateOne({ name: 'brief.pdf', size: 10, lastModified: 9000 }, { search, statImpl }), null, 'different time');
  assert.equal(await locateOne({ name: '../brief.pdf', size: 10, lastModified: 1000 }, { search, statImpl }), null);
});

test('upload names are reduced to a safe file name', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('my photo (1).HEIC'), 'my photo _1_.HEIC');
  assert.equal(safeName('...'), 'file');
});

test('upload route saves the file under uploads/<date>/ and returns its path', async () => {
  const express = require('express');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mxup-'));
  const app = express();
  app.use(express.json());
  mount(app, { uploadsRoot: root, now: () => new Date('2026-10-15T12:34:56Z') });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const form = new FormData();
    form.append('files', new Blob([Buffer.from('hello')]), 'note one.txt');
    const res = await fetch(`http://127.0.0.1:${port}/api/files/upload`, { method: 'POST', body: form });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.paths.length, 1);
    assert.ok(data.paths[0].startsWith(path.join(root, '2026-10-15') + path.sep));
    assert.match(path.basename(data.paths[0]), /^123456-[0-9a-f]{6}-note one\.txt$/);
    assert.equal(fs.readFileSync(data.paths[0], 'utf8'), 'hello');
  } finally { server.close(); }
});

test('a scrolled-up pane is brought out of scroll mode before typing; a stuck mode is refused', async () => {
  const { leaveScrollMode } = require('../server/lib/type-parts');
  let inMode = '1'; const calls = [];
  const run = async a => { calls.push(a.join(' ')); if (a[0] === 'display-message') return inMode; if (a.includes('cancel')) inMode = '0'; return ''; };
  assert.equal(await leaveScrollMode('@0', run), true);
  assert.deepEqual(calls, ['display-message -p -t @0 #{pane_in_mode}', 'send-keys -t @0 -X cancel', 'display-message -p -t @0 #{pane_in_mode}']);
  const stuck = async a => (a[0] === 'display-message' ? '1' : '');
  await assert.rejects(leaveScrollMode('@0', stuck), /could not leave/);
});
