'use strict';
// The delivered client scripts, in the order each HTML page loads them.
//
// The clients are several files rather than one, so a test that drives "the whole mobile
// app" must load the same set the browser does. The order is read out of the HTML so a
// future script tag can never be silently missed by the tests.

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'server', 'public');

function scriptsFor(htmlFile) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, htmlFile), 'utf8');
  const out = [];
  for (const m of html.matchAll(/<script src="([^"?]+)(?:\?[^"]*)?"><\/script>/g)) out.push(m[1]);
  if (out.length === 0) throw new Error(`no script tags found in ${htmlFile}`);
  return out;
}

function readClient(htmlFile) {
  return scriptsFor(htmlFile)
    .map(rel => `// ===== ${rel} =====\n${fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8')}`)
    .join('\n;\n');
}

function readFile(rel) {
  return fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
}

// Cut one named region out of a delivered source file, so a test drives the real code.
function slice(rel, startMarker, endMarker) {
  const source = readFile(rel);
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`start marker ${JSON.stringify(startMarker)} missing from ${rel}`);
  const end = endMarker ? source.indexOf(endMarker, start) : source.length;
  if (end <= start) throw new Error(`end marker ${JSON.stringify(endMarker)} missing from ${rel}`);
  return source.slice(start, end);
}

module.exports = { PUBLIC_DIR, scriptsFor, readClient, readFile, slice };
