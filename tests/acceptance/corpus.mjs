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
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  briefGenerator, briefRoutes, briefTmux, fakeTmuxProcess, claudeSession, makeService, tmuxStack,
  paneStreamProbe, tempDir,
} from './service-support.mjs';

// The two panes every target case discriminates between: the window the client is streaming,
// and a pane belonging to somebody else that an ambiguous target would reach instead.
const VICTIM = '> The broad goal is the payroll rewrite. We are currently rotating the signing keys.';
const STREAMED = '> The broad goal is reliable inventory tracking. We are currently repairing barcode import.';
const COLON = '> The broad goal is the invoicing service. We are currently fixing the VAT rounding.';
const leaks = v => /payroll|signing keys/.test(JSON.stringify(v || ''));
const paneOf = text => `${text}\n\n⏺ working…\n`;

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

// Untrusted input and tmux target resolution, end to end on the delivered modules.
//
// First: a pane holding a real user turn AND a tool block that quotes a "> " line — only the
// real turn is intent, driven through collector -> service -> generator. Then the
// `session`/`window` query parameters, and then the two halves that have to hold together:
// a live name carrying `.` or `:` must stay fully usable (compatibility), while no target
// the delivered code builds may ever be reinterpretable (isolation).
export async function targetAndInputChecks({ clock, generator, storeFile }) {
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
  // announcement checks use — it records every argv tmux was handed and offers an injected
  // command a file to create if a shell ever evaluates it.
  const windows = [['claude', 'claude'], ['two', 'bash'], ['v2.1', 'bash']];
  const attempts = [];
  // A name that no live session or window answers to is refused. Nothing is "sanitised":
  // resolution is exact equality against what tmux itself reported, so an unmatched name
  // simply has nowhere to go.
  for (const [label, query] of [
    ['unknown session', 'session=claude%3Atwo'],
    ['unknown window', 'session=A&window=claude.1'],
    ['control character', `session=${encodeURIComponent('A\u0000evil')}`],
  ]) {
    const run = paneStreamProbe({ windows, query });
    attempts.push({ label, closed: run.closed, streamed: run.types });
    checks.push(
      [run.closed && run.closed.code, 1008, `${label}: the connection is refused, not pointed somewhere else`],
      [run.types.length, 0, `${label}: nothing is streamed from a target that was never resolved`],
    );
  }
  // ...while a window that really exists under a separator-bearing name streams normally and
  // is announced by its resolved identifier, not by a name the client could re-point.
  const dotted = paneStreamProbe({ windows, query: 'session=A&window=v2.1' });
  attempts.push({ label: 'separator-bearing window', first: dotted.first });
  checks.push(
    [dotted.closed, null, 'a live window called v2.1 is streamed, not refused'],
    [dotted.first && dotted.first.window, 'v2.1', 'the announcement names the window the client asked for'],
    [dotted.first && dotted.first.target, '@2', 'the announced target is the resolved window id'],
    [/A:v2\.1/.test(dotted.argv), false, 'no tmux call was addressed to a name-built target'],
  );
  // Quotes and semicolons are inert: the name is matched against tmux's own output and the
  // target is an id, so the hostile text is never a command and never even a target. The
  // marker file is the proof — a shell evaluating that name would create it.
  const probeDir = tempDir('matrix-marker-');
  const marker = path.join(probeDir, 'executed');
  const hostile = `claude'; touch ${marker}; echo '`;
  const injected = paneStreamProbe({ session: hostile, windows, query: `session=${encodeURIComponent(hostile)}` });
  attempts.push({ label: 'shell metacharacters', closed: injected.closed, streamed: injected.types });
  checks.push(
    [fs.existsSync(marker), false, 'shell metacharacters: no injected command ran'],
    [injected.closed, null, 'shell metacharacters: a session really named that is still streamable'],
    [injected.first && injected.first.target, '@0', 'shell metacharacters: it is streamed through a resolved id'],
    [injected.argv.includes(`touch ${marker}`), false,
      'shell metacharacters: the hostile text never reached tmux as an argument at all'],
  );
  const resolution = await targetResolutionChecks({ clock, generator, storeFile });
  const real = await realTmuxChecks({ clock, generator, storeFile: `${storeFile}.real` });
  checks.push(...resolution.checks, ...real.checks);
  return { checks, report: { attempts, resolution: resolution.report, realTmux: real.report } };
}

// Compatibility and isolation, which only mean anything together.
//
// tmux window names legitimately contain `.` and `:` (verified on tmux 3.6a; session names
// cannot — tmux rewrites both to `_`). `A:v2.1` is read as window `v2`, pane 1, so a target
// built out of names reaches somebody else's pane. The fix is not to refuse the name: it is
// to resolve the name against the live list and then address the resolved window id. So both
// halves are asserted on one fixture — the dotted window stays fully usable, AND no target
// the delivered code ever hands tmux is one that could be reinterpreted.
async function targetResolutionChecks({ clock, generator, storeFile }) {
  const out = [];
  const fake = fakeTmuxProcess({
    A: { sessionId: '$A', createdAt: 1_600_000_000, windows: [
      { name: 'v2', command: 'bash', active: true, pane: 'innocent\n', panes: ['innocent\n', paneOf(VICTIM)] },
      { name: 'v2.1', command: 'claude', active: false, pane: paneOf(STREAMED) },
      { name: 'c:d', command: 'bash', active: false, pane: paneOf(COLON) },
    ] },
  });
  const service = makeService({ stack: tmuxStack(fake), clock, generator, storeFile });

  // Discovery lands on the dotted window because that is where Claude runs.
  await service.read('A');
  await service.settle();
  const discovered = await service.read('A');
  out.push(
    [discovered.session.window, 'v2.1', 'a discovered window called v2.1 is usable, not refused'],
    [discovered.session.target, fake.windowId('A', 'v2.1'), 'and it is addressed by its resolved window id'],
    [discovered.current, 'repair barcode import', 'the brief describes that window\'s own pane'],
    [leaks(discovered), false, 'the pane an ambiguous target would have reached never appears'],
  );
  // An edit against it is accepted and really persists.
  const edited = await service.patch('A', { goal: 'inventory tracking, as edited', revision: discovered.revision });
  out.push(
    [edited.goal, 'inventory tracking, as edited', 'an edit against a dotted window is accepted'],
    [fs.readFileSync(storeFile, 'utf8').includes('inventory tracking, as edited'), true, 'and reaches storage'],
  );
  // Explicit bindings, both separators, through the same validation the HTTP route uses.
  for (const [label, window, want] of [['dot', 'v2.1', 'repair barcode import'], ['colon', 'c:d', 'fix the VAT rounding']]) {
    const res = await briefRoutes.respond(service, 'GET', 'A', null, { window, authoritative: true });
    out.push([res.status, 200, `explicit ${label} window: HTTP serves it`]);
    await service.settle();
    const after = await briefRoutes.respond(service, 'GET', 'A', null, { window, authoritative: true });
    out.push(
      [after.body.brief.session.target, fake.windowId('A', window), `explicit ${label} window: bound to its own id`],
      [after.body.brief.current, want, `explicit ${label} window: describes its own pane`],
      [leaks(after.body), false, `explicit ${label} window: no victim text`],
    );
  }
  // Isolation, read off the recorded argv rather than inferred from an error.
  const targets = [...fake.targetsFor('capture-pane'), ...fake.targetsFor('display-message')].map(String);
  const ids = new Set([fake.windowId('A', 'v2.1'), fake.windowId('A', 'c:d'), '$A']);
  out.push(
    [targets.length > 0, true, 'the pane really was captured through the process boundary'],
    [targets.every(t => ids.has(t)), true,
      `every target was a resolved identifier (saw ${JSON.stringify([...new Set(targets)])})`],
    [targets.some(t => /[.:]/.test(t.slice(1))), false, 'no target carried a tmux separator at all'],
  );
  // ...and the hazard the ids avoid is real on this fixture: the name-built target that the
  // delivered code no longer constructs does reach the victim pane.
  const unsafe = await tmuxStack(fake).tmux.run(['capture-pane', '-t', 'A:v2.1', '-p', '-S', '-400']);
  out.push([/signing keys/.test(unsafe), true,
    'control: the name-built target `A:v2.1` really does reach window v2 pane 1']);
  // A name no live session answers to is still refused, so exact resolution is the gate.
  for (const [label, name, code] of [
    ['a colon-bearing session name', 'A:v2', 'unknown_session'],
    ['a forged path', '../../etc/passwd', 'invalid_session'],
  ]) {
    const res = await briefRoutes.respond(service, 'GET', name, null, '');
    out.push([res.body.code, code, `${label} is rejected (${res.status})`]);
  }
  out.push(...(await backgroundTargetChecks({ clock, generator, storeFile: `${storeFile}.bg` })));
  return { checks: out, report: { targets: [...new Set(targets)] } };
}

// The background path, sequenced so it actually exercises tick().
//
// A session only gets a runtime entry once a read succeeds, so the session is registered and
// settled on a plain window first; only then does Claude move to a separator-bearing one.
// The poll must FOLLOW it — re-resolving to the new window's id — and must still never
// address a pane by name.
async function backgroundTargetChecks({ clock, generator, storeFile }) {
  const out = [];
  const start = { sessionId: '$B', createdAt: 1_600_000_500, windows: [
    { name: 'notes', command: 'claude', active: true, pane: paneOf(COLON) },
    { name: 'v2', command: 'bash', active: false, pane: 'innocent\n', panes: ['innocent\n', paneOf(VICTIM)] },
  ] };
  const fake = fakeTmuxProcess({ B: start });
  const service = makeService({ stack: tmuxStack(fake), clock, generator, storeFile });
  await service.read('B');
  await service.settle();
  const first = await service.read('B');
  out.push(
    [first.session.target, fake.windowId('B', 'notes'), 'the session registers and settles on its plain window'],
    [first.current, 'fix the VAT rounding', 'it really generated a brief, so tick() has something to re-resolve'],
  );

  // Claude quits `notes` and starts in a window whose name carries a separator.
  fake.set('B', { ...start, windows: [
    { ...start.windows[0], command: 'bash' },
    start.windows[1],
    { name: 'v2.1', command: 'claude', active: false, pane: paneOf(STREAMED) },
  ] });
  const moved = await service.read('B');
  out.push([moved.session.target, fake.windowId('B', 'v2.1'), 'a reopened read follows Claude to the dotted window']);
  const listsBefore = fake.callsFor('list-panes').length;
  clock.advance(31000);
  await service.tick();
  await service.settle();
  out.push([fake.callsFor('list-panes').length > listsBefore, true,
    'the poll really re-resolved the session rather than skipping it']);
  const after = await service.read('B');
  out.push(
    [after.session.target, fake.windowId('B', 'v2.1'), 'the background poll holds the same resolved id'],
    [after.current, 'repair barcode import', 'and generates from the dotted window\'s own pane'],
    [leaks(after), false, 'the victim pane is never served'],
  );
  const targets = fake.targetsFor('capture-pane').map(String);
  out.push([targets.some(t => /^[^@$]/.test(t) || /[.:]/.test(t.slice(1))), false,
    `no background capture used a name-built target (saw ${JSON.stringify([...new Set(targets)])})`]);
  out.push([/payroll|signing keys/.test(fs.readFileSync(storeFile, 'utf8')), false,
    'the persisted brief record holds no victim text']);
  return out;
}

// Real tmux, on a PRIVATE socket with disposable sessions, killed on the way out.
//
// Everything above runs against a fake process that models tmux target parsing. This proves
// the model: the installed tmux really does read `S:v2.1` as window `v2` pane 1, really does
// accept `@id`/`$id`, and really does let the delivered resolver, capture, brief, edit and
// pane-stream work on names carrying `.` and `:`. The user's own tmux server is never
// contacted — a `-L` socket is a separate server, and nothing here runs without one.
export async function realTmuxChecks({ clock, generator, storeFile }) {
  const out = [];
  let tmuxBin = '';
  try { tmuxBin = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim(); } catch { tmuxBin = ''; }
  out.push([!!tmuxBin, true, 'tmux is installed, so the real-tmux regression can run (a missing engine is a failure, not a skip)']);
  if (!tmuxBin) return { checks: out, report: { ran: false, reason: 'tmux not on PATH' } };

  const dir = tempDir('matrix-realtmux-');
  // A socket PATH inside this test's own temp directory, not a named socket in the shared
  // tmux socket directory: a separate server that goes away with the directory.
  const socket = path.join(dir, 'tmux.sock');
  const S = `mx-acc-${process.pid}`;
  const tm = (...a) => execFileSync(tmuxBin, ['-S', socket, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // A copy of the tmux binary under another name is a pane process that blocks forever
  // (`wait-for` on a channel nothing signals) and whose `pane_current_command` is whatever we
  // called the copy — the only way to make a pane look like a real Claude pane offline.
  const procNamed = name => {
    const p = path.join(dir, name);
    fs.copyFileSync(tmuxBin, p);
    fs.chmodSync(p, 0o755);
    return p;
  };
  const claudeBin = procNamed('claude');
  const holdBin = procNamed('holdproc');
  const seed = (bin, text) => ['/bin/sh', '-c',
    `printf %b ${JSON.stringify(text)}; exec ${JSON.stringify(bin)} -S ${JSON.stringify(socket)} wait-for mx-hold`];
  const shimDir = path.join(dir, 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  const shim = path.join(shimDir, 'tmux');
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(tmuxBin)} -S ${JSON.stringify(socket)} "$@"\n`, { mode: 0o755 });

  const report = { ran: true, socket, normalization: null, windows: null };
  try {
    // Wide panes: an 80-column pane wraps a long user turn mid-word and the evidence parser
    // would see a truncated sentence, which would be a fixture artefact, not a finding.
    tm('new-session', '-d', '-x', '240', '-y', '50', '-s', S, '-n', 'main', ...seed(holdBin, 'main window\\n'));
    tm('new-window', '-t', S, '-n', 'v2', ...seed(holdBin, 'innocent pane zero\\n'));
    const wins = () => tm('list-windows', '-t', S, '-F', '#{window_id}|#{window_name}').split('\n').filter(Boolean);
    const idOf = n => { const r = wins().find(x => x.slice(x.indexOf('|') + 1) === n); return r ? r.split('|')[0] : null; };
    tm('split-window', '-t', idOf('v2'), ...seed(holdBin, `${VICTIM}\\n\\n`));
    tm('new-window', '-t', S, '-n', 'v2.1', ...seed(claudeBin, `${STREAMED}\\n\\n`));
    tm('new-window', '-t', S, '-n', 'c:d', ...seed(holdBin, `${COLON}\\n\\n`));
    // tmux rewrites `.` and `:` out of a SESSION name but keeps them in a window name.
    tm('new-session', '-d', '-s', 'mx.dot:name', ...seed(holdBin, 'x\\n'));
    report.normalization = tm('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean);
    // Each pane runs `sh -c 'printf …; exec <bin>'`, so wait for the exec to land rather
    // than sleeping a guessed interval: until it does, tmux still reports the pane command
    // as `sh` and this would be a fixture race rather than a finding.
    const ready = () => tm('list-panes', '-s', '-t', S, '-F', '#{pane_current_command}|#{window_name}')
      .includes('claude|v2.1');
    for (let i = 0; i < 100 && !ready(); i += 1) await new Promise(r => setTimeout(r, 50));
    out.push([ready(), true, 'real tmux: the fixture panes reached their final commands']);
    report.windows = wins();
    out.push([report.normalization.includes('mx_dot_name'), true,
      `tmux normalises separators out of a session name (saw ${JSON.stringify(report.normalization)})`]);

    // The delivered resolver/capture stack, pointed at the private socket through a shim
    // that is `tmux -L <socket>` and nothing else.
    const tmux = briefTmux.createTmux({ binary: shim });
    const live = {
      tmux,
      resolver: briefTmux.createSessionResolver({ tmux }),
      capture: briefTmux.createPaneCapture({ tmux }),
    };
    const service = makeService({ stack: live, clock, generator, storeFile });

    // Discovery over real tmux, onto a window whose name carries a separator.
    const resolved = await live.resolver.resolve(S, '', {});
    out.push(
      [resolved && resolved.window, 'v2.1', 'real tmux: discovery finds the Claude window called v2.1'],
      [resolved && resolved.target, idOf('v2.1'), 'real tmux: it is targeted by the window id tmux issued'],
    );
    await service.read(S);
    await service.settle();
    const brief = await service.read(S);
    out.push(
      [brief.current, 'repair barcode import', 'real tmux: the brief comes from that window\'s own pane'],
      [leaks(brief), false, 'real tmux: the neighbouring pane never leaks into it'],
    );
    // The hazard, on the installed tmux: the name-built target reaches window v2, pane 1.
    const unsafe = tm('capture-pane', '-t', `${S}:v2.1`, '-p', '-S', '-50');
    out.push([/signing keys/.test(unsafe), true,
      'real tmux control: `S:v2.1` really does capture window v2 pane 1']);

    // An explicit colon-bearing binding, an edit, and persistence.
    const colon = { window: 'c:d', authoritative: true };
    const res = await briefRoutes.respond(service, 'GET', S, null, colon);
    await service.settle();
    const colonBrief = (await briefRoutes.respond(service, 'GET', S, null, colon)).body.brief;
    out.push(
      [res.status, 200, 'real tmux: an explicit `c:d` binding is served'],
      [colonBrief.session.target, idOf('c:d'), 'real tmux: bound to that window\'s id'],
      [colonBrief.current, 'fix the VAT rounding', 'real tmux: and describes its own pane'],
    );
    const edit = await briefRoutes.respond(service, 'PATCH', S, { goal: 'edited over real tmux', revision: colonBrief.revision }, colon);
    out.push(
      [edit.status, 200, 'real tmux: an edit against a colon-bearing window is accepted'],
      [fs.readFileSync(storeFile, 'utf8').includes('edited over real tmux'), true, 'real tmux: and it persists'],
    );

    // pane-stream over real tmux, and the binding it announces must be the one the brief uses.
    const stream = paneStreamProbe({ binDir: shimDir, query: `session=${encodeURIComponent(S)}` });
    out.push(
      [stream.closed, null, 'real tmux: pane-stream streams the session'],
      [stream.first && stream.first.window, 'v2.1', 'real tmux: it announces the separator-bearing window'],
      [stream.first && stream.first.target, idOf('v2.1'), 'real tmux: announced as the resolved window id'],
      [stream.first && stream.first.target, brief.session.target,
        'real tmux: the transcript and the brief resolve to the same binding'],
    );
    const colonStream = paneStreamProbe({ binDir: shimDir, query: `session=${encodeURIComponent(S)}&window=${encodeURIComponent('c:d')}` });
    out.push(
      [colonStream.first && colonStream.first.window, 'c:d', 'real tmux: an explicit colon-bearing window streams too'],
      [colonStream.first && colonStream.first.target, idOf('c:d'), 'real tmux: through its own id'],
    );

    // Reconnect: the streamed window closes, a retained binding to it fails loudly, and a
    // fresh discovery moves to the next Claude window — also separator-bearing.
    const goneId = idOf('v2.1');
    tm('new-window', '-t', S, '-n', 'v3.2', ...seed(claudeBin, `${STREAMED}\\n\\n`));
    tm('kill-window', '-t', goneId);
    let gone = null;
    try { await service.read(S, { window: 'v2.1', authoritative: true }); } catch (e) { gone = e; }
    out.push([gone && gone.code, 'unknown_window', 'real tmux: a retained binding to a closed window fails loudly']);
    const rediscovered = await service.read(S);
    out.push(
      [rediscovered.session.window, 'v3.2', 'real tmux: a reconnect rediscovers the next Claude window'],
      [rediscovered.session.target, idOf('v3.2'), 'real tmux: and binds to its id'],
    );
  } finally {
    try { tm('kill-server'); } catch { /* the server is gone either way */ }
  }
  return { checks: out, report };
}

