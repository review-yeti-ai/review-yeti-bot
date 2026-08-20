import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FALSIFICATION_LIMITS,
  applyFalsificationOutcomes,
  buildFalsificationMessages,
  normalizeFalsificationLimits,
  runFindingFalsification,
} from '../../src/review/findingFalsification';

const changedFiles = [
  { path: 'src/app.js', patch: '@@ -1,3 +1,3 @@\n-old\n+new\n context' },
  { path: 'tests/app.test.js', patch: '@@ -1,2 +1,2 @@\n-assert(old)\n+assert(new)' },
];

function finding(overrides: Record<string, unknown> = {}) {
  return {
    severity: 'P1',
    path: 'src/app.js',
    side: 'RIGHT',
    line: 2,
    title: 'Guard removed',
    body: 'The new code drops the null guard, so a null payload now throws.',
    suggestion: 'Restore the guard.',
    ...overrides,
  };
}

function confirmResponse(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    content: JSON.stringify({
      complete: true,
      verdict: 'CONFIRM',
      violated_invariant: 'payload may be null at this call site and must be guarded',
      failure_path: 'caller passes null -> new code dereferences payload.id -> TypeError',
      benign_explanation_check: 'no upstream validation exists in the diff or its callers; the removed guard was the only check',
      ...extra,
    }),
    usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140, costUSD: 0.001 },
  };
}

function refuteResponse() {
  return {
    ok: true,
    content: JSON.stringify({
      complete: true,
      verdict: 'REFUTE',
      benign_explanation: 'the rename is behavior-preserving; the guard moved to the caller in the same diff',
    }),
    usage: { promptTokens: 90, completionTokens: 30, totalTokens: 120, costUSD: 0.001 },
  };
}

describe('normalizeFalsificationLimits', () => {
  it('applies defaults and hard caps', () => {
    const limits = normalizeFalsificationLimits({});
    expect(limits.maxCandidates).toBe(DEFAULT_FALSIFICATION_LIMITS.maxCandidates);
    const capped = normalizeFalsificationLimits({ maxCandidates: 10_000, maxCalls: 10_000 });
    expect(capped.maxCandidates).toBeLessThanOrEqual(DEFAULT_FALSIFICATION_LIMITS.maxCandidates);
    expect(capped.maxCalls).toBeLessThanOrEqual(capped.maxCandidates);
  });
});

describe('buildFalsificationMessages', () => {
  it('carries the hypothesis and the diff as untrusted data and demands the strict schema', () => {
    const messages = buildFalsificationMessages({ finding: finding(), changedFiles });
    const text = messages.map((message) => message.content).join('\n');
    expect(text).toContain('<hypothesis>');
    expect(text).toContain('<changed_files>');
    expect(text).toContain('Guard removed');
    expect(text).toContain('untrusted');
    expect(text).toContain('REFUTE');
    expect(text).toContain('ABSTAIN');
    // The persona's charter or transcript must never leak into the verifier context.
    expect(text).not.toContain('risk_plan');
  });
});

describe('runFindingFalsification', () => {
  it('publishes only CONFIRM verdicts; REFUTE and ABSTAIN both withhold', async () => {
    const verdicts = [confirmResponse(), refuteResponse(), { ok: true, content: JSON.stringify({ complete: true, verdict: 'ABSTAIN' }) }];
    let call = 0;
    const result = await runFindingFalsification({
      findings: [finding({ title: 'a' }), finding({ title: 'b' }), finding({ title: 'c' })],
      changedFiles,
      falsifyTurn: async () => verdicts[call++],
    });
    expect(result.outcomes.map((outcome) => outcome.verdict)).toEqual(['CONFIRM', 'REFUTE', 'ABSTAIN']);
    expect(result.receipt.summary).toMatchObject({ candidates: 3, confirmed: 1, refuted: 1, abstained: 1 });
  });

  it('downgrades a CONFIRM that skips the causal reconstruction to abstention after one corrective re-ask', async () => {
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const result = await runFindingFalsification({
      findings: [finding()],
      changedFiles,
      falsifyTurn: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
        calls.push(messages);
        return { ok: true, content: JSON.stringify({ complete: true, verdict: 'CONFIRM' }) };
      },
    });
    expect(calls.length).toBe(2); // corrective re-ask happened
    expect(result.outcomes[0].verdict).toBe('ABSTAIN');
    expect(result.outcomes[0].reason).toBe('contract_incomplete');
  });

  it('treats provider failure as abstention (never publication) after one retry', async () => {
    let attempts = 0;
    const result = await runFindingFalsification({
      findings: [finding()],
      changedFiles,
      falsifyTurn: async () => {
        attempts += 1;
        return { ok: false, error: 'network failure' };
      },
    });
    expect(attempts).toBe(2);
    expect(result.outcomes[0].verdict).toBe('ABSTAIN');
    expect(result.outcomes[0].reason).toBe('verifier_unavailable');
  });

  it('rejects unknown response fields via the corrective path', async () => {
    const responses = [
      { ok: true, content: JSON.stringify({ complete: true, verdict: 'CONFIRM', extra: 'field' }) },
      confirmResponse(),
    ];
    let call = 0;
    const result = await runFindingFalsification({
      findings: [finding()],
      changedFiles,
      falsifyTurn: async () => responses[call++],
    });
    expect(result.outcomes[0].verdict).toBe('CONFIRM');
  });

  it('abstains beyond the call budget instead of publishing unexamined findings', async () => {
    const findings = Array.from({ length: 4 }, (_value, index) => finding({ title: `f${index}`, line: index + 1 }));
    const result = await runFindingFalsification({
      findings,
      changedFiles,
      limits: { maxCandidates: 4, maxCalls: 2 },
      falsifyTurn: async () => confirmResponse(),
    });
    expect(result.outcomes.filter((outcome) => outcome.verdict === 'CONFIRM').length).toBe(2);
    expect(result.outcomes.filter((outcome) => outcome.reason === 'call_budget_exhausted').length).toBe(2);
  });

  it('prioritizes higher-severity findings when the budget cannot cover all of them', async () => {
    const findings = [finding({ severity: 'P2', title: 'low' }), finding({ severity: 'P0', title: 'high' })];
    const seen: string[] = [];
    await runFindingFalsification({
      findings,
      changedFiles,
      limits: { maxCalls: 1 },
      falsifyTurn: async ({ finding: candidate }: { finding: { title: string } }) => {
        seen.push(candidate.title);
        return confirmResponse();
      },
    });
    expect(seen).toEqual(['high']);
  });

  it('aggregates verifier usage into the receipt', async () => {
    const result = await runFindingFalsification({
      findings: [finding()],
      changedFiles,
      falsifyTurn: async () => confirmResponse(),
    });
    expect(result.receipt.usage.totalTokens).toBe(140);
    expect(result.receipt.usage.costUSD).toBeCloseTo(0.001);
  });
});

describe('applyFalsificationOutcomes', () => {
  it('narrows lanes to confirmed findings and reports withheld counts', async () => {
    const lanes = [
      { personaId: 'testing', findings: [finding({ title: 'keep' }), finding({ title: 'drop' })] },
      { personaId: 'security', findings: [finding({ title: 'abstained' })] },
    ];
    const responses: Record<string, { ok: boolean; content?: string; error?: string }> = {
      keep: confirmResponse(),
      drop: refuteResponse(),
      abstained: { ok: true, content: JSON.stringify({ complete: true, verdict: 'ABSTAIN' }) },
    };
    const flat = lanes.flatMap((lane, laneIndex) => lane.findings.map((entry, findingIndex) => ({ entry, laneIndex, findingIndex })));
    const result = await runFindingFalsification({
      findings: flat.map((item) => item.entry),
      changedFiles,
      falsifyTurn: async ({ finding: candidate }: { finding: { title: string } }) => responses[candidate.title],
    });
    const applied = applyFalsificationOutcomes(lanes, flat.map(({ laneIndex, findingIndex }) => ({ laneIndex, findingIndex })), result);
    expect(applied.personaResults[0].findings.map((entry: { title: string }) => entry.title)).toEqual(['keep']);
    expect(applied.personaResults[1].findings).toEqual([]);
    expect(applied.refuted).toBe(1);
    expect(applied.abstained).toBe(1);
    expect(applied.confirmed).toBe(1);
  });
});
