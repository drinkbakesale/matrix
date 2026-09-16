'use strict';
// Delivered sources must stay plain text: a raw NUL or other control byte makes git store
// the file as binary, so its patch loses reviewable content.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'bin/matrix-notify',
  'server/server.js',
  'server/lib/build-inbox.js',
  'server/lib/session-identity.js',
  'server/public/app.js',
  'server/public/desktop.js',
  'server/public/index.html',
  'server/public/style.css',
  'server/public/sw.js',
  ...fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => `tests/${f}`),
];

const ALLOWED = new Set([9, 10, 13]);

test('delivered sources contain no raw control bytes', () => {
  for (const rel of FILES) {
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    const offsets = [];
    bytes.forEach((b, i) => {
      if ((b < 32 && !ALLOWED.has(b)) || b === 127) offsets.push(i);
    });
    assert.deepEqual(offsets, [], `${rel} has control bytes at ${offsets.slice(0, 5).join(', ')}`);
  }
});
