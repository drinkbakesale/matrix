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
  ...fs.readdirSync(path.join(ROOT, 'server/lib')).filter(f => f.endsWith('.js')).map(f => `server/lib/${f}`),
  ...fs.readdirSync(path.join(ROOT, 'server/public'))
    .filter(f => /\.(js|css|html)$/.test(f))
    .map(f => `server/public/${f}`),
  ...fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).map(f => `tests/${f}`),
  ...fs.readdirSync(path.join(__dirname, 'acceptance'))
    .filter(f => /\.(mjs|js)$/.test(f))
    .map(f => `tests/acceptance/${f}`),
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
