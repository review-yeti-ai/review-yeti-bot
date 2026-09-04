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

// src/review/findingFalsification.js is untyped runtime JS (out of this worker's file scope
// to annotate); runFindingFalsification()'s return type resolves to `any`, so array methods on
// `result.outcomes` need an explicit callback parameter type. Mirrors outcome()'s literal shape.
interface FalsificationOutcome {
  verdict: string;
  reason?: string;
  [key: string]: unknown;
}

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

  it('covers the measured reasoning-verdict tail per call while hard-bounding the stage wall clock', () => {
    // 2026-08-21 measurement: 9 of 27 hypotheses timed out at the old 60s per-call cap and
    // were withheld unverified. The per-call default must cover that tail; the stage budget,
    // not the per-call cap, is what bounds worst-case lane latency.
    const limits = normalizeFalsificationLimits({});
    expect(limits.timeoutMs).toBe(180_000);
    expect(limits.stageBudgetMs).toBe(300_000);
    const maxed = normalizeFalsificationLimits({ timeoutMs: 10_000_000, stageBudgetMs: 10_000_000 });
    expect(maxed.timeoutMs).toBe(300_000);
    expect(maxed.stageBudgetMs).toBe(900_000);
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
    expect(result.outcomes.map((outcome: FalsificationOutcome) => outcome.verdict)).toEqual(['CONFIRM', 'REFUTE', 'ABSTAIN']);
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

  it('records a per-call deadline collision as verifier_timeout, distinct from provider failure', async () => {
    const result = await runFindingFalsification({
      findings: [finding()],
      changedFiles,
      falsifyTurn: async () => ({ ok: false, error: 'timed out after 180000ms', timedOut: true }),
    });
    expect(result.outcomes[0].verdict).toBe('ABSTAIN');
    expect(result.outcomes[0].reason).toBe('verifier_timeout');
    expect(result.receipt.summary).toMatchObject({ timedOut: 1, unavailable: 0, neverVerified: 1 });
  });

  it('passes the effective per-call timeout (never more than the remaining stage budget) to the verifier turn', async () => {
    const seenTimeouts: number[] = [];
    await runFindingFalsification({
      findings: [finding()],
      changedFiles,
      falsifyTurn: async ({ timeoutMs }: { timeoutMs: number }) => {
        seenTimeouts.push(timeoutMs);
        return confirmResponse();
      },
    });
    expect(seenTimeouts).toEqual([180_000]);
    const cappedByBudget: number[] = [];
    await runFindingFalsification({
      findings: [finding()],
      changedFiles,
      limits: { stageBudgetMs: 5_000 },
      falsifyTurn: async ({ timeoutMs }: { timeoutMs: number }) => {
        cappedByBudget.push(timeoutMs);
        return confirmResponse();
      },
    });
    expect(cappedByBudget.length).toBe(1);
    expect(cappedByBudget[0]).toBeLessThanOrEqual(5_000);
  });

  it('abstains with stage_budget_exhausted, without calling the verifier, once the stage wall clock is spent', async () => {
    let calls = 0;
    const result = await runFindingFalsification({
      findings: [finding({ title: 'a' }), finding({ title: 'b' })],
      changedFiles,
      limits: { stageBudgetMs: 1 },
      falsifyTurn: async () => {
        calls += 1;
        return confirmResponse();
      },
    });
    expect(calls).toBe(0);
    expect(result.outcomes.map((outcome: FalsificationOutcome) => outcome.reason)).toEqual(['stage_budget_exhausted', 'stage_budget_exhausted']);
    expect(result.receipt.summary).toMatchObject({ budgetExhausted: 2, neverVerified: 2, confirmed: 0 });
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
    expect(result.outcomes.filter((outcome: FalsificationOutcome) => outcome.verdict === 'CONFIRM').length).toBe(2);
    expect(result.outcomes.filter((outcome: FalsificationOutcome) => outcome.reason === 'call_budget_exhausted').length).toBe(2);
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
    // A model that examined the claim and said ABSTAIN is not "never verified".
    expect(applied.neverVerified).toBe(0);
  });

  it('reports never-verified withholdings separately from examined abstentions', async () => {
    const lanes = [{ personaId: 'testing', findings: [finding({ title: 'unreached' })] }];
    const result = await runFindingFalsification({
      findings: lanes[0].findings,
      changedFiles,
      falsifyTurn: async () => ({ ok: false, error: 'timed out after 180000ms', timedOut: true }),
    });
    const applied = applyFalsificationOutcomes(lanes, [{ laneIndex: 0, findingIndex: 0 }], result);
    expect(applied.abstained).toBe(1);
    expect(applied.neverVerified).toBe(1);
    expect(applied.personaResults[0].findings).toEqual([]);
  });
});
