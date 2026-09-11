import { describe, expect, it } from 'vitest';
import {
  createReviewCiLanePlan, normalizeReviewCiBinding, reviewCiAbsentReconciliationSchema,
  reviewCiCoordinatesSchema, reviewCiExecutionSchema, reviewCiIdentityDigest,
  reviewCiRequestEvent, reviewCiRequestEventSchema, reviewCiRunName, reviewCiTerminalReceiptSchema,
  type ReviewCiCoordinates, type ReviewCiValidationBinding, type StoredReviewCiRequest,
} from '../../src/review/reviewCi';
import { PostgresReviewCiRepository } from '../../src/persistence/reviewCiRepository';

const REQUEST_ID = 'b55887e4-3c20-4db7-8a98-7755c532a250';
function coordinates(): ReviewCiCoordinates {
  const runId = `run_${'1'.repeat(32)}`;
  return { repositoryId: 1232078607, owner: 'calltelemetry', repo: 'ct-meta', prNumber: 42,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64),
    runId, reviewGeneration: 0, executionAttempt: 1, attemptId: `${runId}-g0-e1` };
}
function binding(): ReviewCiValidationBinding {
  return { candidateSha: 'd'.repeat(40), workflowId: 3211,
    workflowPath: '.github/workflows/review-yeti-candidate.yml', workflowRef: 'refs/heads/main',
    workflowSha: 'e'.repeat(40), lanePlan: createReviewCiLanePlan(['tools', 'core'], ['validate']) };
}
function request(): StoredReviewCiRequest {
  return { requestId: REQUEST_ID, review: coordinates(), expectedAppId: 4385771, binding: null,
    identityDigest: null, workflowEpoch: 0, execution: null, terminalReceipt: null, state: 'pending' };
}
function execution() {
  return { requestId: REQUEST_ID, epoch: 1, repositoryId: 1232078607, workflowId: 3211,
    workflowSha: binding().workflowSha, candidateSha: binding().candidateSha,
    runId: 100, runAttempt: 1, event: 'workflow_dispatch', runName: reviewCiRunName(REQUEST_ID, 1) };
}

describe('Review CI immutable domain/wire boundaries', () => {
  it('emits only the nine coordinate-only completion fields with the runtime bare digest', () => {
    expect(reviewCiRequestEvent(request())).toEqual({ schema_version: 'review-yeti-ci-request.v1',
      repository_id: 1232078607, repository: 'calltelemetry/ct-meta', pr_number: 42,
      base_sha: 'b'.repeat(40), head_sha: 'a'.repeat(40), attempt_id: coordinates().attemptId,
      policy_digest: 'c'.repeat(64), validation_request_id: REQUEST_ID });
  });
  it.each(['checkId', 'conclusion', 'target', 'resultURL', 'workflowRef', 'token', 'provider', 'script'])('rejects extra completion authority %s', (field) => {
    expect(() => reviewCiRequestEventSchema.parse({ ...reviewCiRequestEvent(request()), [field]: 'untrusted' })).toThrow();
  });
  it.each(['sha256:' + 'c'.repeat(64), 'C'.repeat(64), 'c'.repeat(63), 'c'.repeat(65), 'g'.repeat(64)])('rejects noncanonical digest %s', (policyDigest) => {
    expect(() => reviewCiCoordinatesSchema.parse({ ...coordinates(), policyDigest })).toThrow();
    expect(() => reviewCiRequestEventSchema.parse({ ...reviewCiRequestEvent(request()), policy_digest: policyDigest })).toThrow();
  });
  it('binds review generation and execution to the actual gateAttemptId, including unchanged execution', () => {
    const original = coordinates();
    const next = { ...original, reviewGeneration: 1, attemptId: `${original.runId}-g1-e1` };
    expect(reviewCiCoordinatesSchema.parse(next)).toEqual(next);
    expect(() => reviewCiCoordinatesSchema.parse({ ...next, attemptId: original.attemptId })).toThrow();
    expect(() => reviewCiCoordinatesSchema.parse({ ...original, executionAttempt: 2 })).toThrow();
    expect(() => reviewCiCoordinatesSchema.parse({ ...original, reviewGeneration: -1 })).toThrow();
  });
  it('lane-plan ordering is canonical, digest-checked, and does not mutate callers', () => {
    const lanes = ['tools', 'core']; const jobs = ['validate', 'lint'];
    const plan = createReviewCiLanePlan(lanes, jobs);
    expect(lanes).toEqual(['tools', 'core']); expect(jobs).toEqual(['validate', 'lint']);
    expect(plan).toEqual(createReviewCiLanePlan([...lanes].reverse(), [...jobs].reverse()));
    expect(() => normalizeReviewCiBinding({ ...binding(), lanePlan: { ...plan, lanes: ['different'] } })).toThrow();
    expect(() => createReviewCiLanePlan(['core', 'core'], jobs)).toThrow();
    expect(() => createReviewCiLanePlan(lanes, [])).toThrow();
  });
  it.each(['candidateSha', 'workflowSha', 'workflowId', 'workflowRef', 'workflowPath', 'lanePlan'])('immutable validation digest includes %s independently of request ID', (field) => {
    const identity = { ...request(), binding: binding() };
    const replacements: Record<string, unknown> = { candidateSha: 'f'.repeat(40), workflowSha: 'f'.repeat(40),
      workflowId: 3212, workflowRef: 'refs/tags/trusted', workflowPath: '.github/workflows/other.yml',
      lanePlan: createReviewCiLanePlan(['other'], ['other']) };
    const changed = { ...identity, binding: { ...identity.binding, [field]: replacements[field] } };
    expect(reviewCiIdentityDigest(changed)).not.toBe(reviewCiIdentityDigest(identity));
    expect(reviewCiIdentityDigest({ ...identity, requestId: 'f'.repeat(36) })).toBe(reviewCiIdentityDigest(identity));
  });
  it.each(['a'.repeat(40), 'main', 'refs/heads/../evil', 'refs/heads/.hidden', 'refs/heads/foo.lock/bar',
    'refs/heads/a//b', 'refs/heads/a?b', 'refs/heads/a\\b'])('rejects noncanonical workflow ref %s', (workflowRef) => {
    expect(() => normalizeReviewCiBinding({ ...binding(), workflowRef })).toThrow();
  });
  it('execution rejects old correlation name, foreign event, injected fields, and invalid run attempts', () => {
    const run = execution();
    expect(reviewCiExecutionSchema.parse(run)).toEqual(run);
    expect(() => reviewCiExecutionSchema.parse({ ...run, epoch: 2 })).toThrow();
    expect(() => reviewCiExecutionSchema.parse({ ...run, event: 'push' })).toThrow();
    expect(() => reviewCiExecutionSchema.parse({ ...run, runAttempt: 0 })).toThrow();
    expect(() => reviewCiExecutionSchema.parse({ ...run, conclusion: 'success' })).toThrow();
  });
  it('terminal receipts reject duplicate IDs, cross-run jobs, nonterminal jobs, and extra authority', () => {
    const run = execution();
    const job = { id: 1, runId: run.runId, runAttempt: 1, name: 'validate', status: 'completed', conclusion: 'success' };
    const receipt = { version: 'ReviewCiTerminalReceipt.v1', execution: run, conclusion: 'success', jobs: [job] };
    expect(reviewCiTerminalReceiptSchema.parse(receipt)).toEqual(receipt);
    for (const jobs of [[job, job], [{ ...job, runId: 99 }], [{ ...job, runAttempt: 2 }], [{ ...job, status: 'queued' }]]) {
      expect(() => reviewCiTerminalReceiptSchema.parse({ ...receipt, jobs })).toThrow();
    }
    expect(() => reviewCiTerminalReceiptSchema.parse({ ...receipt, checkId: 1 })).toThrow();
    expect(() => reviewCiTerminalReceiptSchema.parse({ ...receipt, jobs: [{ ...job, resultURL: 'https://evil.invalid' }] })).toThrow();
  });
  it('negative reconciliation is bounded coordinate-only evidence, never arbitrary retained provider data', () => {
    const readback = { outcome: 'absent', requestId: REQUEST_ID, kind: 'workflow', epoch: 1, observedAt: 100 };
    expect(reviewCiAbsentReconciliationSchema.parse(readback)).toEqual(readback);
    expect(() => reviewCiAbsentReconciliationSchema.parse({ ...readback, token: 'not-retained' })).toThrow();
    expect(() => reviewCiAbsentReconciliationSchema.parse({ ...readback, epoch: 0 })).toThrow();
    expect(() => reviewCiAbsentReconciliationSchema.parse({ ...readback, kind: 'repository' })).toThrow();
  });
  it('permits a configured 15-second freshness bound but rejects unbounded settings', () => {
    const pool = { query: async () => ({ rows: [] }), connect: async () => { throw new Error('no I/O'); } };
    expect(() => new PostgresReviewCiRepository(pool, { lifecycleEvents: 'disabled', admissionTimeoutMs: 15_000 })).not.toThrow();
    expect(() => new PostgresReviewCiRepository(pool, { lifecycleEvents: 'disabled', admissionTimeoutMs: 15_001 })).toThrow('bounds');
    expect(() => new PostgresReviewCiRepository(pool, { lifecycleEvents: 'disabled', maxDispatchAttempts: 11 })).toThrow('bounds');
  });
});
