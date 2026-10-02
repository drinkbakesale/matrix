// Shared result envelope for the acceptance runners.
//
// Every expected case id is pre-registered as failed, so a runner that crashes before it
// reaches a case reports that case as a failure rather than silently omitting (or skipping)
// it. Only the JSON assertions envelope goes to the result file; traces go beside it.

import fs from 'node:fs';
import path from 'node:path';

export function createRun(expectedIds) {
  const results = new Map(expectedIds.map(id => [id, {
    id, status: 'failed', detail: 'case did not run',
  }]));
  const artifacts = {};

  function record(id, status, detail) {
    if (!results.has(id)) throw new Error(`unexpected case id: ${id}`);
    results.set(id, { id, status, detail });
  }

  async function runCase(id, fn) {
    const checks = [];
    const probe = {
      ok(condition, detail) { checks.push({ ok: !!condition, detail }); return !!condition; },
      eq(actual, expected, detail) {
        const same = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
        checks.push({ ok: same, detail: `${detail} — actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}` });
        return same;
      },
      includes(haystack, needle, detail) {
        const found = String(haystack).includes(needle);
        checks.push({ ok: found, detail: `${detail} — ${JSON.stringify(needle)} not in ${JSON.stringify(String(haystack).slice(0, 220))}` });
        return found;
      },
      note(key, value) { artifacts[key] = value; },
      checks,
    };
    let thrown = null;
    try {
      await fn(probe);
    } catch (err) {
      thrown = err;
    }
    const failed = checks.filter(c => !c.ok);
    if (thrown) record(id, 'failed', `threw: ${String(thrown && thrown.stack || thrown)}`);
    else if (failed.length) record(id, 'failed', failed.map(c => c.detail).join(' | ').slice(0, 4000));
    else record(id, 'passed', `${checks.length} checks passed`);
  }

  function finish(resultFile, traceFile) {
    const assertions = [...results.values()];
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify({ assertions }, null, 2));
    if (traceFile) {
      fs.mkdirSync(path.dirname(traceFile), { recursive: true });
      fs.writeFileSync(traceFile, JSON.stringify(artifacts, null, 2));
    }
    const failed = assertions.filter(a => a.status !== 'passed');
    for (const a of assertions) console.log(`${a.status === 'passed' ? 'PASS' : 'FAIL'} ${a.id}: ${a.detail}`);
    process.exitCode = failed.length ? 1 : 0;
    return failed.length === 0;
  }

  return { runCase, record, finish, artifacts };
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}
