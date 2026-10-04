#!/usr/bin/env node
// Runs one acceptance group. Each case is a real behavioural test: it starts
// the production server / browser page / host-built client and replaces only
// the outside world (tmux binary, push provider, clock, disk faults, device).
const fs = require('fs');
const path = require('path');

const arg = (n) => process.argv[process.argv.indexOf(`--${n}`) + 1];
const group = arg('group');
const candidate = path.resolve(arg('candidate'));
const artifacts = path.resolve(arg('artifacts'));
const resultFile = path.resolve(arg('result'));

(async () => {
  const lib = require('./lib')({ candidate, artifacts });
  const cases = require(`./groups/${group}.js`)(lib);
  const assertions = [];
  for (const [name, fn] of Object.entries(cases)) {
    const id = `RM2_${group}::${name}`;
    const started = Date.now();
    const notes = [];
    try {
      await fn({ note: (s) => notes.push(String(s)), dir: lib.caseDir(name) });
      assertions.push({ id, status: 'passed', detail: notes.join(' | ').slice(0, 1400) || 'all assertions held' });
    } catch (err) {
      assertions.push({ id, status: 'failed', detail: `${err && err.message}`.slice(0, 1400) });
      fs.writeFileSync(path.join(artifacts, `${name}.error.txt`), `${err && err.stack}\n\nnotes:\n${notes.join('\n')}`);
    }
    fs.writeFileSync(path.join(artifacts, `${name}.notes.txt`), `${id} ${assertions[assertions.length - 1].status} in ${Date.now() - started}ms\n${notes.join('\n')}\n`);
    await lib.cleanup();
  }
  fs.writeFileSync(resultFile, JSON.stringify({ assertions }, null, 1));
  process.exit(assertions.every((a) => a.status === 'passed') ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(2); });
