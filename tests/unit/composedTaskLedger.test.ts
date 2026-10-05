import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import {
  createComposedTaskPlan, createComposedTaskOutcome, MAX_COMPOSED_LEDGER_BYTES,
  ComposedTaskLedgerError, verifyComposedTaskPlan, verifyComposedTaskOutcome,
} from '../../src/review/composedTaskLedger';
import { completeSourceDeliveryFixture, ledgerFixture } from '../support/composedTaskLedgerFixture';

describe('composed task retention contract (not execution or approval)', () => {
  it('binds ordered normalized tasks, exact epoch and immutable source/image provenance', () => {
    const { trusted, tasks } = ledgerFixture();
    const plan = createComposedTaskPlan(trusted, tasks);
    expect(plan.digest).toBe(sha256(canonicalJson(plan.payload)));
    expect(plan.byteLength).toBe(Buffer.byteLength(canonicalJson(plan.payload), 'utf8'));
    expect(plan.payload.tasks).toEqual(tasks);
    expect(plan.payload.changedPathsDigest).toBe(sha256(trusted.changedFiles.map(file => file.path)));
    expect(verifyComposedTaskPlan(trusted, plan)).toEqual(plan);
    for (const identity of [
      { ...trusted.identity, headSha: '8'.repeat(40) },
      { ...trusted.identity, policySources: [{ ...trusted.identity.policySources[0], sha: '8'.repeat(40) }] },
      { ...trusted.identity, engine: { ...trusted.identity.engine, imageDigest: `sha256:${'8'.repeat(64)}` } },
      { ...trusted.identity, semanticDiffDigest: '8'.repeat(64) },
    ]) expect(createComposedTaskPlan({ ...trusted, identity }, tasks).digest).not.toBe(plan.digest);
  });

  it('never normalizes a rejected/un-normalized/raw plan into silently different retained evidence', () => {
    const { trusted, tasks } = ledgerFixture();
    for (const candidate of [[], [...tasks, tasks[0]], Array.from({ length: 9 }, (_, i) => ({ ...tasks[0], id: `t${i}` })),
      [{ ...tasks[0], paths: ['not-changed.ts'] }, tasks[1]],
      [{ ...tasks[0], id: 'TEST-SHAPE' }, tasks[1]],
      [{ ...tasks[0], question: 'x'.repeat(401) }, tasks[1]],
      [{ ...tasks[0], rawPrompt: 'DO NOT STORE' }, tasks[1]],
    ]) expect(() => createComposedTaskPlan(trusted, candidate)).toThrow(ComposedTaskLedgerError);
  });

  it.each(['../escape.ts', '/absolute.ts', './relative.ts', 'back\\slash.ts', 'bad\u0000path.ts'])
    ('rejects unsafe trusted paths: %s', path => {
      const { trusted, tasks } = ledgerFixture();
      expect(() => createComposedTaskPlan({ ...trusted, changedFiles: [{ path }] }, tasks)).toThrow();
    });

  it('requires the canonical eight-task bound and preserves security coverage', () => {
    const { trusted, tasks } = ledgerFixture();
    const eight = [tasks[1], ...Array.from({ length: 7 }, (_, i) => ({ ...tasks[0], id: `t${i}` }))];
    expect(createComposedTaskPlan(trusted, eight).payload.tasks).toHaveLength(8);
    expect(() => createComposedTaskPlan(trusted, [tasks[0]])).toThrow();
  });

  it('rejects eight otherwise valid testing tasks that cover auth paths without a security task', () => {
    const { trusted, tasks } = ledgerFixture();
    const eight = Array.from({ length: 8 }, (_, index) => ({ ...tasks[0], id: `testing-${index}`,
      paths: trusted.changedFiles.map(file => file.path) }));
    expect(eight).toHaveLength(8);
    expect(eight.every(task => task.dimension === 'testing')).toBe(true);
    // Both paths are covered and cardinality is valid. The missing security
    // dimension, not an unrelated coverage gap or ninth task, must refuse it.
    expect(() => createComposedTaskPlan(trusted, eight)).toThrow('Composed task retention: invalid-plan');
  });

  it.each(['attemptId', 'runId', 'expectedAppId', 'executionAttempt', 'reviewGeneration', 'receivedAt', 'terminalDeadline'])
    ('rejects malformed identity %s', field => {
      const { trusted, tasks } = ledgerFixture();
      expect(() => createComposedTaskPlan({ ...trusted, identity: { ...trusted.identity, [field]: 'invalid' } }, tasks)).toThrow();
    });

  it('retains a validated finding without reclassification, and never a verdict or raw tool transcript', () => {
    const { trusted, tasks, usage, finding } = ledgerFixture();
    const plan = createComposedTaskPlan(trusted, tasks);
    const outcome = createComposedTaskOutcome(plan, { planDigest: plan.digest, taskId: tasks[0].id,
      status: 'complete', findings: [finding], usage,
      sourceDelivery: completeSourceDeliveryFixture(trusted, tasks[0]) }, trusted.changedFiles);
    expect(outcome.payload.status).toBe('complete');
    expect(outcome.payload).toMatchObject({ findings: [finding] });
    expect(outcome.payload).not.toHaveProperty('verdict');
    expect(verifyComposedTaskOutcome(plan, outcome, trusted.changedFiles)).toEqual(outcome);
    for (const extra of [{ nonce: 'do-not-retain' }, { toolCalls: [{ args: 'secret' }] },
      { rawResponse: 'do-not-retain' }, { verdict: 'SHIP' }, { env: {} }]) {
      expect(() => createComposedTaskOutcome(plan, { ...outcome.payload, ...extra }, trusted.changedFiles)).toThrow();
    }
  });

  it('rejects unknown tasks, wrong plan digest, off-task paths, malformed findings and unanchored lines', () => {
    const { trusted, tasks, usage, finding } = ledgerFixture();
    const plan = createComposedTaskPlan(trusted, tasks);
    const input = { planDigest: plan.digest, taskId: tasks[0].id, status: 'complete', findings: [finding], usage,
      sourceDelivery: completeSourceDeliveryFixture(trusted, tasks[0]) };
    for (const delta of [{ taskId: 'missing' }, { planDigest: '8'.repeat(64) },
      { findings: [{ ...finding, path: 'src/auth.ts' }] }, { findings: [{ ...finding, line: 2 }] },
      { findings: [{ ...finding, severity: 'P3' }] }, { findings: [{ ...finding, title: '' }] },
      { findings: [{ ...finding, nonce: 'raw' }] }, { findings: new Array(401).fill(finding) }]) {
      expect(() => createComposedTaskOutcome(plan, { ...input, ...delta }, trusted.changedFiles)).toThrow();
    }
  });

  it('stores blocked and exhausted as failures, with enum-only diagnostics and honest unknown physical calls', () => {
    const { trusted, tasks, usage, diagnostics } = ledgerFixture();
    const plan = createComposedTaskPlan(trusted, tasks);
    const base = { planDigest: plan.digest, taskId: tasks[0].id, usage };
    expect(createComposedTaskOutcome(plan, { ...base, status: 'blocked' }, trusted.changedFiles).payload.status).toBe('blocked');
    expect(createComposedTaskOutcome(plan, { ...base, status: 'exhausted', diagnostics }, trusted.changedFiles).payload.status).toBe('exhausted');
    for (const delta of [{ status: 'blocked', findings: [] }, { status: 'exhausted' },
      { status: 'exhausted', diagnostics: { ...diagnostics, rawResponse: 'secret' } },
      { status: 'exhausted', diagnostics: { ...diagnostics, reason: 'provider-text' } },
      { status: 'exhausted', diagnostics: { ...diagnostics, turnsUsed: 3 } },
      { status: 'complete', findings: [], usage: { ...usage, totalTokens: 119 } },
      { status: 'complete', findings: [], usage: { ...usage, toolTurns: 3 } }]) {
      expect(() => createComposedTaskOutcome(plan, { ...base, ...delta }, trusted.changedFiles)).toThrow();
    }
  });

  it('bounds UTF-8 bytes, detects corrupt digest/length/payload and does not retain thrown candidate text', () => {
    const { trusted, tasks, usage, finding } = ledgerFixture();
    const plan = createComposedTaskPlan(trusted, tasks);
    expect(() => createComposedTaskOutcome(plan, { planDigest: plan.digest, taskId: tasks[0].id,
      status: 'complete', findings: [finding], usage }, trusted.changedFiles)).toThrow('invalid-outcome');
    expect(() => verifyComposedTaskPlan(trusted, { ...plan, digest: '8'.repeat(64) })).toThrow();
    expect(() => verifyComposedTaskPlan(trusted, { ...plan, byteLength: plan.byteLength + 1 })).toThrow();
    const huge = Array.from({ length: 40 }, () => ({ ...finding, body: '界'.repeat(16_000) }));
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(MAX_COMPOSED_LEDGER_BYTES);
    expect(() => createComposedTaskOutcome(plan, { planDigest: plan.digest, taskId: tasks[0].id,
      status: 'complete', findings: huge, usage,
      sourceDelivery: completeSourceDeliveryFixture(trusted, tasks[0]) }, trusted.changedFiles)).toThrow();
    try { createComposedTaskPlan(trusted, [{ nonce: 'PRIVATE_NONCE_DO_NOT_ECHO' }]); }
    catch (error) { expect(String(error)).not.toContain('PRIVATE_NONCE_DO_NOT_ECHO'); }
  });

  it.each(['digest', 'byteLength', 'payload'] as const)('rejects tampered retained outcome %s', field => {
    const { trusted, tasks, usage, finding } = ledgerFixture();
    const plan = createComposedTaskPlan(trusted, tasks);
    const outcome = createComposedTaskOutcome(plan, { planDigest: plan.digest, taskId: tasks[0].id,
      status: 'complete', findings: [finding], usage,
      sourceDelivery: completeSourceDeliveryFixture(trusted, tasks[0]) }, trusted.changedFiles);
    expect(verifyComposedTaskOutcome(plan, outcome, trusted.changedFiles)).toEqual(outcome);
    const tampered = { ...outcome,
      ...(field === 'digest' ? { digest: '8'.repeat(64) } : {}),
      ...(field === 'byteLength' ? { byteLength: outcome.byteLength + 1 } : {}),
      ...(field === 'payload' ? { payload: { ...outcome.payload, usage: { ...outcome.payload.usage,
        promptTokens: usage.promptTokens + 1, totalTokens: usage.totalTokens + 1 } } } : {}),
    };
    expect(() => verifyComposedTaskOutcome(plan, tampered, trusted.changedFiles))
      .toThrow('Composed task retention: integrity');
  });

  it('rejects executable/cyclic/sparse input without invoking accessors or retaining hidden fields', () => {
    const { trusted, tasks, usage } = ledgerFixture();
    const plan = createComposedTaskPlan(trusted, tasks);
    const base = { planDigest: plan.digest, taskId: tasks[0].id, status: 'complete', findings: [], usage };
    let reads = 0;
    const accessor = { ...base };
    Object.defineProperty(accessor, 'planDigest', { enumerable: true, get() { reads++; return plan.digest; } });
    const cyclic: Record<string, unknown> = { ...base }; cyclic.self = cyclic;
    const sparse = { ...base, findings: Array(1) };
    const hidden = { ...base }; Object.defineProperty(hidden, 'secret', { value: 'not-for-storage' });
    for (const value of [accessor, cyclic, sparse, hidden, { ...base, callback: () => 'raw' }]) {
      expect(() => createComposedTaskOutcome(plan, value, trusted.changedFiles)).toThrow();
    }
    expect(reads).toBe(0);
  });
});
