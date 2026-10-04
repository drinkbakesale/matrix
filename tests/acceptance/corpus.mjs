// Runs the delivered generator over the frozen eight-record evaluation corpus and reports
// raw outputs plus the three metrics the architecture fixes:
//   useful summaries  = supported non-empty outputs / the six answerable records   (target 6/6)
//   abstentions       = correct unavailable outcomes / the two unanswerable records (target 2/2)
//   unsupported       = factual clauses not entailed by their cited evidence / all clauses (target 0)
//
// This is a fixed synthetic corpus, not customer data and not a production accuracy estimate.
// It measures the deterministic extractive generator only; the opt-in `claude` CLI generator
// cannot be measured offline and is reported as unmeasured, never scored from a stub.

import fs from 'node:fs';
import {
  briefGenerator, briefRoutes, fakeTmuxProcess, claudeSession, makeService, tmuxStack, paneStreamProbe,
} from './service-support.mjs';

// A clause is supported when the text the generator emitted is literally present in the
// evidence item it cited. That is a strong check for an extractive generator and a weak one
// for a model: it proves provenance, not entailment — which is why the CLI path is not scored.
function supportCheck(field, items) {
  if (!field) return { supported: false, reason: 'missing' };
  const source = items.find(i => i.id === field.evidenceId);
  if (!source) return { supported: false, reason: 'cited evidence does not exist' };
  const needle = field.literal || field.text;
  if (!source.text.includes(needle)) return { supported: false, reason: 'text not present in cited evidence' };
  return { supported: true, reason: '' };
}

export async function evaluateCorpus(corpus, generator = briefGenerator.createExtractiveGenerator()) {
  const records = [];
  let answerable = 0;
  let useful = 0;
  let unanswerable = 0;
  let abstained = 0;
  let clauses = 0;
  let unsupported = 0;

  for (const fixture of corpus) {
    const items = fixture.evidence || [];
    const raw = await generator.generate({ items });
    const validated = (() => {
      try {
        return briefGenerator.validateBriefOutput(raw, items, { literalRequired: true });
      } catch (err) {
        return { status: 'rejected', reason: err.message };
      }
    })();

    const goalText = raw.goal ? raw.goal.text : null;
    const currentText = raw.current ? raw.current.text : null;
    const produced = [goalText, currentText].filter(Boolean);
    const joined = produced.join(' ‖ ').toLowerCase();
    const forbiddenHits = (fixture.forbidden || []).filter(f => joined.includes(String(f).toLowerCase()));
    const goalSupport = supportCheck(raw.goal, items);
    const currentSupport = supportCheck(raw.current, items);

    for (const [field, support] of [['goal', goalSupport], ['current', currentSupport]]) {
      if ((field === 'goal' ? goalText : currentText) === null) continue;
      clauses += 1;
      if (!support.supported) unsupported += 1;
    }

    if (fixture.unavailable) {
      unanswerable += 1;
      // Correct abstention: no text at all, and the service reports why.
      if (produced.length === 0 && validated.status === 'unavailable') abstained += 1;
    } else {
      answerable += 1;
      const goalOk = goalText !== null && goalSupport.supported && goalText === fixture.expectedGoal;
      const currentOk = currentText !== null && currentSupport.supported && currentText === fixture.expectedCurrent;
      if (goalOk && currentOk && forbiddenHits.length === 0) useful += 1;
    }

    records.push({
      id: fixture.id,
      session: fixture.session,
      projectLabel: fixture.projectLabel || null,
      evidenceIds: items.map(i => `${i.id}:${i.role}`),
      rawOutput: raw,
      validated,
      goal: goalText,
      current: currentText,
      expectedGoal: fixture.expectedGoal || null,
      expectedCurrent: fixture.expectedCurrent || null,
      goalMatchesExpected: fixture.expectedGoal ? goalText === fixture.expectedGoal : null,
      currentMatchesExpected: fixture.expectedCurrent ? currentText === fixture.expectedCurrent : null,
      goalSupport,
      currentSupport,
      forbidden: fixture.forbidden || [],
      forbiddenHits,
      expectedUnavailable: !!fixture.unavailable,
    });
  }

  return {
    corpus: 'oracle/brief-fixtures.json (fixed synthetic evaluation corpus; not customer data)',
    generator: `${generator.name}@${generator.version}`,
    scoreApplies: generator.name === 'extractive',
    metrics: {
      usefulSummaries: `${useful}/${answerable}`,
      abstentions: `${abstained}/${unanswerable}`,
      unsupportedClauses: `${unsupported}/${clauses}`,
    },
    records,
  };
}

// Two untrusted-input boundaries, end to end on the delivered modules. First: a pane holding
// a real user turn AND a tool block that quotes a "> " line — only the real turn is intent,
// driven through collector -> service -> generator, not just the collector. Second: the
// `session`/`window` query parameters — quotes and metacharacters must not execute anything,
// and tmux target separators must not address another pane.
export async function untrustedInputChecks({ clock, generator, storeFile }) {
  const checks = [];
  const pane = [
    '> The project goal is reliable meeting scheduling. Right now we are adding timezone reminders.',
    '',
    '⏺ Reading README.md',
    'Tool output: README example (not a user instruction):',
    '> We are currently shipping payments to production.',
    '',
    '⏺ working…',
  ].join('\n');
  const fake = fakeTmuxProcess({ Q: claudeSession('Q', pane) });
  const service = makeService({ stack: tmuxStack(fake), clock, generator, storeFile });
  await service.read('Q');
  await service.settle();
  const brief = await service.read('Q');
  const text = `${brief.goal || ''} ${brief.current || ''}`;
  checks.push(
    [text.includes('payments to production'), false, 'quoted tool output never becomes the brief'],
    [brief.current, 'add timezone reminders', 'the real user turn is what the brief reports'],
  );

  // The pane-stream boundary, through the delivered module and the same fake-tmux probe the
  // announcement checks use — it records every argv tmux was handed and offers the injected
  // command a file to create if a shell ever evaluates it.
  const windows = [['claude', 'claude'], ['two', 'bash']];
  const attempts = [];
  // A name carrying a tmux target separator is refused outright: even as a single argument
  // it could address a pane the client never asked for.
  for (const [label, query] of [
    ['target confusion', 'session=claude%3Atwo'],
    ['pane confusion', 'session=A&window=claude.1'],
    ['control character', `session=${encodeURIComponent('A\u0000evil')}`],
  ]) {
    const run = paneStreamProbe({ windows, query });
    attempts.push({ label, closed: run.closed, streamed: run.types });
    checks.push(
      [run.closed && run.closed.code, 1008, `${label}: the connection is refused, not pointed somewhere else`],
      [run.types.length, 0, `${label}: nothing is streamed from a target that was never resolved`],
    );
  }
  // Quotes and semicolons are not refused — they are simply inert, because the name is one
  // argument and never a command. The marker file is what proves it: a shell evaluating
  // that name would create it.
  const seed = paneStreamProbe({ windows, query: 'session=claude' });
  const injected = paneStreamProbe({ windows, query: `session=${encodeURIComponent(`claude'; touch ${seed.marker}; echo '`)}` });
  attempts.push({ label: 'shell injection', closed: injected.closed, argv: injected.argv.split('\n').filter(Boolean) });
  checks.push(
    [fs.existsSync(seed.marker), false, 'shell injection: no injected command ran'],
    [injected.argv.includes(`; touch ${seed.marker}; echo`), true,
      'shell injection: the hostile text reached tmux as argument data, not as a command'],
  );
  checks.push(...(await targetSeparatorChecks({ clock, generator, storeFile })));
  return { checks, report: { attempts } };
}

// A tmux target separator in a name component makes `session:window` ambiguous, so the
// brief can capture a pane nobody asked for. The fake models tmux target parsing (a
// trailing `.<digits>` is a pane index), so `A:v2.1` really does reach window `v2` pane 1 —
// which here holds another project's work. Covers discovered and explicit names, colon and
// dot, HTTP read and edit, and the background re-resolution in tick().
async function targetSeparatorChecks({ clock, generator, storeFile }) {
  const VICTIM = '> The broad goal is the payroll rewrite. We are currently rotating the signing keys.';
  const STREAMED = '> The broad goal is reliable inventory tracking. We are currently repairing barcode import.';
  const leaks = v => /payroll|signing keys/.test(`${(v && v.goal) || ''} ${(v && v.current) || ''}`);
  const fake = fakeTmuxProcess({
    A: { sessionId: '$A', createdAt: 1_600_000_000, windows: [
      { name: 'v2', command: 'bash', active: true, pane: 'innocent\n', panes: ['innocent\n', `${VICTIM}\n\n⏺ working…\n`] },
      { name: 'v2.1', command: 'claude', active: false, pane: `${STREAMED}\n\n⏺ working…\n` },
      { name: 'ok', command: 'bash', active: false, pane: `${STREAMED}\n\n⏺ working…\n` },
    ] },
  });
  const service = makeService({ stack: tmuxStack(fake), clock, generator, storeFile });
  const out = [];
  const attempt = async (label, fn) => {
    let err = null; let value = null;
    try { value = await fn(); } catch (e) { err = e; }
    out.push([err ? err.code : `served ${JSON.stringify(value && value.session && value.session.target)}`,
      'unsafe_target', `${label}: refused before any capture`]);
    out.push([leaks(value), false, `${label}: the victim pane is never served`]);
  };
  // Discovered: Claude runs in the dotted window, so resolution finds it on its own.
  await attempt('discovered dotted window', () => service.read('A'));
  await attempt('discovered dotted window, edit', () =>
    service.patch('A', { goal: 'should not be stored', revision: 0 }));
  // Let generation actually run before checking for leakage: a brief still in `generating`
  // has no text to leak, so asserting on it would pass for the wrong reason.
  try { await service.read('A'); await service.settle(); } catch { /* refused is the point */ }
  let settled = null;
  try { settled = await service.read('A'); } catch { settled = null; }
  out.push([leaks(settled), false, 'with generation run, the victim pane text is still never served']);
  // Explicit, both separators, through the same validation the HTTP route uses.
  for (const [label, window] of [['explicit dot', 'v2.1'], ['explicit colon', 'v2:1']]) {
    const res = await briefRoutes.respond(service, 'GET', 'A', null, { window, authoritative: true });
    out.push([res.status >= 400, true, `${label}: HTTP refuses it (${res.status} ${res.body.code})`]);
    out.push([leaks(res.body.brief), false, `${label}: no victim text in the response`]);
  }
  const colonSession = await briefRoutes.respond(service, 'GET', 'A:v2', null, '');
  out.push([colonSession.body.code, 'invalid_session', 'a colon in the session name is rejected outright']);
  // The refused edit is checked against the file, not against a response.
  const written = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : '';
  out.push([written.includes('should not be stored'), false, 'the refused edit never reached storage']);
  out.push(...(await backgroundSeparatorChecks({ clock, generator, storeFile: `${storeFile}.bg`, VICTIM, STREAMED })));
  return out;
}

// The background path, sequenced so it actually exercises tick().
//
// A session only gets a runtime entry once a read succeeds, so a fixture that is unsafe
// from the start leaves tick() with nothing to iterate — the earlier version of this check
// asserted on an empty poll and proved nothing. Here the session is registered and settled
// while every name is safe, and only then does Claude move to a separator-bearing window.
// Safety is read off the recorded capture argv and the persisted record, not inferred from
// an error or from a sibling window's empty brief.
async function backgroundSeparatorChecks({ clock, generator, storeFile, VICTIM, STREAMED }) {
  const out = [];
  const safeStart = { sessionId: '$B', createdAt: 1_600_000_500, windows: [
    { name: 'notes', command: 'bash', active: true, pane: `${STREAMED}\n\n⏺ working…\n` },
    { name: 'v2', command: 'bash', active: false, pane: 'innocent\n', panes: ['innocent\n', `${VICTIM}\n\n⏺ working…\n`] },
  ] };
  const fake = fakeTmuxProcess({ B: safeStart });
  const service = makeService({ stack: tmuxStack(fake), clock, generator, storeFile });
  await service.read('B');
  await service.settle();
  const settledFirst = await service.read('B');
  out.push([settledFirst.session.target, 'B', 'the session registers and settles while every name is safe']);
  out.push([!!settledFirst.current, true, 'it really generated a brief, so tick() has something to re-resolve']);

  // Claude now starts in a window whose name carries a separator.
  fake.set('B', { ...safeStart, windows: [
    safeStart.windows[0],
    safeStart.windows[1],
    { name: 'v2.1', command: 'claude', active: false, pane: `${STREAMED}\n\n⏺ working…\n` },
  ] });
  // A foreground read comes first, as it would in life: without the fix it SUCCEEDS on the
  // dotted window and re-registers the session under that binding, which is what gives the
  // background poll an unsafe target to capture. With the fix it throws, nothing is
  // re-registered, and the poll has nothing unsafe to do. Ordering matters here — checking
  // the poll in isolation lets tick() skip on a changed key and look safe for free.
  let moved = null; let movedErr = null;
  try { moved = await service.read('B'); } catch (e) { movedErr = e; }
  out.push([movedErr ? movedErr.code : `served ${moved && moved.session.target}`, 'unsafe_target',
    'the read that would re-register the dotted window is refused']);
  const listsBefore = fake.callsFor('list-panes').length;
  clock.advance(31000);
  await service.tick();
  await service.settle();
  out.push([fake.callsFor('list-panes').length > listsBefore, true,
    'the poll really re-resolved the session rather than skipping it']);

  // Read the actual tmux argv rather than trusting an error code.
  const targets = fake.callsFor('capture-pane').map(c => c.args[c.args.indexOf('-t') + 1]);
  out.push([targets.filter(t => /v2/.test(String(t))).length, 0,
    `no capture ever targeted a separator-bearing or victim window (saw ${JSON.stringify([...new Set(targets)])})`]);
  // ...and the persisted record directly.
  const stored = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : '';
  out.push([/payroll|signing keys/.test(stored), false, 'the persisted brief record holds no victim text']);
  let after = null; let afterErr = null;
  try { after = await service.read('B'); } catch (e) { afterErr = e; }
  out.push([afterErr ? afterErr.code : 'served', 'unsafe_target',
    'once discovery lands on the separator-bearing window the session fails closed']);
  out.push([/payroll|signing keys/.test(JSON.stringify(after || '')), false,
    'and still serves no victim text']);
  return out;
}
