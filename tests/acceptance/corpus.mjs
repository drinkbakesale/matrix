// Runs the delivered generator over the frozen eight-record evaluation corpus and reports
// raw outputs plus the three metrics the architecture fixes:
//   useful summaries  = supported non-empty outputs / the six answerable records   (target 6/6)
//   abstentions       = correct unavailable outcomes / the two unanswerable records (target 2/2)
//   unsupported       = factual clauses not entailed by their cited evidence / all clauses (target 0)
//
// This is a fixed synthetic corpus, not customer data and not a production accuracy estimate.
// It measures the deterministic extractive generator only; the opt-in `claude` CLI generator
// cannot be measured offline and is reported as unmeasured, never scored from a stub.

import { briefGenerator } from './service-support.mjs';

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
