import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recoveryMocks = vi.hoisted(() => ({
  load: vi.fn(),
  requiredDigest: vi.fn(),
}));

vi.mock('../../src/persistence/incompleteP2Recovery', () => ({
  loadIncompleteP2RecoveryContext: recoveryMocks.load,
  requiredIncompleteP2RecoveryDigest: recoveryMocks.requiredDigest,
}));

import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import { deriveReviewGateExternalId } from '../../src/review/reviewCheckIdentity';
import { WorkerCompletionPersistenceError } from '../../src/review/workerCompletionPersistenceError';
import {
  createIncompleteP2RecoveryContext,
  incompleteP2RecoveryClaimFor,
  incompleteP2RecoveryClaimSchema,
} from '../../src/review/incompleteP2Recovery';
import type { IncompleteP2RecoveryContext } from '../../src/review/incompleteP2Recovery';

const RUN = `run_${'1'.repeat(32)}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const POLICY = 'c'.repeat(64);
const CONFIG = 'd'.repeat(64);
const APP_ID = 77;
const WORKER_TOKEN = 'test-worker-token';
const WORKER_TOKEN_DIGEST = createHash('sha256').update(WORKER_TOKEN).digest('hex');
const NOW = Date.parse('2026-09-29T12:01:00.000Z');
const COMPLETED_AT = '2026-09-29T12:00:00.000Z';
const SOURCE_DIGEST = 'e'.repeat(64);

function context(executionAttempt = 2): IncompleteP2RecoveryContext {
  return createIncompleteP2RecoveryContext({
    version: 'IncompleteP2RecoveryContext.v1',
    runId: RUN,
    repositoryId: 123,
    owner: 'example',
    repo: 'candidate',
    prNumber: 42,
    headSha: HEAD,
    baseSha: BASE,
    policyDigest: POLICY,
    configDigest: CONFIG,
    expectedAppId: APP_ID,
    executionAttempt,
    sources: Array.from({ length: executionAttempt - 1 }, (_, index) => ({
      executionAttempt: index + 1,
      workerResultDigest: index === 0 ? SOURCE_DIGEST : 'f'.repeat(64),
      workerCheckId: 1001 + index,
      gateCheckId: 2001 + index,
      rawFindingCount: 1,
      canonicalFindingCount: 1,
    })),
    findings: Array.from({ length: executionAttempt - 1 }, (_, index) => ({
      sourceExecutionAttempt: index + 1,
      sourceWorkerResultDigest: index === 0 ? SOURCE_DIGEST : 'f'.repeat(64),
      sourceWorkerCheckId: 1001 + index,
      sourceGateCheckId: 2001 + index,
      personaId: index === 0 ? 'security' : 'reviewer',
      findingIndex: 0,
      finding: {
        severity: 'P2', path: index === 0 ? 'src/example.ts' : 'src/other.ts', line: 7,
        title: index === 0 ? 'Prior advisory' : 'Second prior advisory',
        body: 'Verify the earlier observation against current source.',
      },
    })),
  });
}

function completion(recoveryContext: IncompleteP2RecoveryContext, options: {
  claim?: unknown;
  incremental?: Record<string, unknown>;
  verdictCache?: Record<string, unknown>;
  documentationOnly?: boolean;
} = {}) {
  const documentationOnly = options.documentationOnly === true;
  return {
    version: 'WorkerReviewCompletion.v1',
    runId: RUN,
    repositoryId: 123,
    owner: 'example',
    repo: 'candidate',
    prNumber: 42,
    headSha: HEAD,
    baseSha: BASE,
    policyDigest: POLICY,
    configDigest: CONFIG,
    executionAttempt: recoveryContext.executionAttempt,
    result: {
      version: 'WorkerReviewResult.v1',
      completedAt: COMPLETED_AT,
      personas: documentationOnly
        ? [{ id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] }]
        : [{ id: 'security', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
      coverageComplete: true,
      quorumSatisfied: true,
      ...(options.claim === undefined ? {} : { incompleteP2Recovery: options.claim }),
      ...(options.incremental === undefined ? {} : { incremental: options.incremental }),
      ...(options.verdictCache === undefined ? {} : { verdictCache: options.verdictCache }),
    },
  };
}

function stateRow(executionAttempt = 2) {
  const coordinates = {
    runId: RUN, repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42,
    headSha: HEAD, baseSha: BASE, policyDigest: POLICY,
    executionAttempt, attemptId: `${RUN}-g${executionAttempt - 1}-e${executionAttempt}`,
  };
  return {
    coordinates,
    review_generation: executionAttempt - 1,
    expected_app_id: APP_ID,
    external_id: deriveReviewGateExternalId(coordinates),
    check_id: 88,
    creation_state: 'bound',
    desired_state: 'pending',
    desired_version: 1,
    published_version: 0,
    current_attempt: true,
    worker_token_digest: WORKER_TOKEN_DIGEST,
    current_execution: executionAttempt - 1,
    run_status: 'queued',
    outbox_status: 'pending',
    effective_config_digest: CONFIG,
    current_generation: executionAttempt - 1,
    authoritative_gate_app_id: APP_ID,
    received_at: '2026-09-29T11:59:00.000Z',
    terminal_deadline: '2026-09-29T12:10:00.000Z',
  };
}

function repositoryFixture(executionAttempt = 2) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.startsWith('SELECT repository_id, pr_number FROM review_runs')) {
        return { rows: [{ repository_id: 123, pr_number: 42 }] };
      }
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT gate.*, runs.status')) return { rows: [stateRow(executionAttempt)] };
      if (sql.startsWith('SELECT repository_id, pr_number, received_at, authoritative_gate_app_id')) {
        return { rows: [{ repository_id: 123, pr_number: 42, received_at: '2026-09-29T11:59:00.000Z', authoritative_gate_app_id: APP_ID }] };
      }
      if (sql.includes('FROM review_finding_rechecks request')) return { rows: [] };
      if (sql.includes('FROM review_worker_completions completions')) return { rows: [] };
      if (sql.startsWith('UPDATE review_gate_attempts')
        || sql.startsWith('INSERT INTO review_worker_completions')
        || sql.startsWith('UPDATE review_dispatch_outbox')
        || sql.startsWith('UPDATE review_runs')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() };
  return {
    calls,
    client,
    repository: new PostgresReviewGateRepository(pool, { lifecycleEvents: 'disabled' }),
  };
}

function trustedCompletion(documentationOnly = false) {
  return async () => ({
    current: {
      repositoryId: 123, prNumber: 42, headSha: HEAD, baseSha: BASE,
      policyDigest: POLICY, open: true, draft: false,
    },
    coverage: {
      expectedPersonaIds: ['security'],
      changedFiles: documentationOnly
        ? [{ path: 'docs/plan.md', patch: 'diff --git a/docs/plan.md b/docs/plan.md\n--- a/docs/plan.md\n+++ b/docs/plan.md\n@@ -1 +1 @@\n-old\n+new\n' }]
        : [{ path: 'src/example.ts', patch: '@@ -0,0 +1 @@\n+const example = 1;\n' }],
      coverageComplete: true,
      quorumSatisfied: true,
    },
  });
}

function gateDecision(calls: Array<{ sql: string; values?: unknown[] }>) {
  const update = calls.find(({ sql }) => sql.startsWith('UPDATE review_gate_attempts'));
  expect(update).toBeDefined();
  return JSON.parse(String(update?.values?.[2])) as { status: string; reason: string };
}

describe('incomplete P2 recovery Gate enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const recoveryContext = context();
    recoveryMocks.requiredDigest.mockResolvedValue(recoveryContext.contextDigest);
    recoveryMocks.load.mockResolvedValue(recoveryContext);
  });

  it('records a fresh canonical SHIP only with the exact service-owned claim', async () => {
    const recoveryContext = context();
    const fixture = repositoryFixture();
    const result = await fixture.repository.recordWorkerResult(
      completion(recoveryContext, { claim: incompleteP2RecoveryClaimFor(recoveryContext) }),
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(),
      NOW,
    );

    expect(result).toBe('recorded');
    expect(gateDecision(fixture.calls)).toEqual({ status: 'success', eligible: true, reason: 'clean-review' });
    expect(fixture.calls.some(({ sql }) => sql === 'COMMIT')).toBe(true);
    expect(fixture.calls.some(({ sql }) => sql === 'ROLLBACK')).toBe(false);
    expect(recoveryMocks.load).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      runId: RUN, executionAttempt: 2, repositoryId: 123, expectedAppId: APP_ID,
      identity: expect.objectContaining({ owner: 'example', repo: 'candidate', prNumber: 42,
        headSha: HEAD, baseSha: BASE, configDigest: CONFIG }),
      policyDigest: POLICY,
    }));
  });

  it('rejects a valid recovery claim when the service has no retained archive', async () => {
    const recoveryContext = context();
    const claim = incompleteP2RecoveryClaimFor(recoveryContext);
    expect(incompleteP2RecoveryClaimSchema.safeParse(claim).success).toBe(true);
    recoveryMocks.requiredDigest.mockResolvedValue(null);

    const fixture = repositoryFixture();
    const event = completion(recoveryContext, { claim });
    expect(event).toMatchObject({
      runId: RUN, repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42,
      headSha: HEAD, baseSha: BASE, policyDigest: POLICY, configDigest: CONFIG,
      executionAttempt: 2,
    });
    const result = await fixture.repository.recordWorkerResult(
      event,
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(),
      NOW,
    );

    expect(result).toBe('recorded');
    expect(gateDecision(fixture.calls)).toEqual({
      status: 'failure', eligible: false, reason: 'invalid-evidence',
    });
    expect(recoveryMocks.requiredDigest).toHaveBeenCalled();
    expect(recoveryMocks.load).not.toHaveBeenCalled();
    expect(fixture.calls.some(({ sql }) => sql === 'COMMIT')).toBe(true);
    expect(fixture.calls.some(({ sql }) => sql === 'ROLLBACK')).toBe(false);
  });

  it('allows an ordinary retry with no recovery claim when no archive is required', async () => {
    const recoveryContext = context();
    recoveryMocks.requiredDigest.mockResolvedValue(null);

    const fixture = repositoryFixture();
    const result = await fixture.repository.recordWorkerResult(
      completion(recoveryContext),
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(),
      NOW,
    );

    expect(result).toBe('recorded');
    expect(gateDecision(fixture.calls)).toEqual({
      status: 'success', eligible: true, reason: 'clean-review',
    });
    expect(recoveryMocks.requiredDigest).toHaveBeenCalled();
    expect(recoveryMocks.load).not.toHaveBeenCalled();
  });

  it.each([
    ['missing claim', (recoveryContext: IncompleteP2RecoveryContext) => ({})],
    ['mismatched claim', (recoveryContext: IncompleteP2RecoveryContext) => ({
      claim: { ...incompleteP2RecoveryClaimFor(recoveryContext), contextDigest: 'f'.repeat(64) },
    })],
  ])('does not let a %s pass Gate enforcement', async (_name, optionsFor) => {
    const recoveryContext = context();
    const options = optionsFor(recoveryContext);
    const fixture = repositoryFixture();
    await fixture.repository.recordWorkerResult(
      completion(recoveryContext, options),
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(),
      NOW,
    );

    expect(gateDecision(fixture.calls)).toEqual({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
    expect(fixture.calls.some(({ sql }) => sql === 'COMMIT')).toBe(true);
  });

  it.each([
    ['executionAttempt', { executionAttempt: 2 }],
    ['workerResultDigest', { workerResultDigest: '0'.repeat(64) }],
    ['workerCheckId', { workerCheckId: 1002 }],
    ['gateCheckId', { gateCheckId: 2002 }],
  ])('rejects a correct-digest Gate claim with altered %s metadata', async (_field, change) => {
    const recoveryContext = context();
    const original = incompleteP2RecoveryClaimFor(recoveryContext);
    const claim = {
      ...original,
      sources: original.sources.map((source, index) => index === 0 ? { ...source, ...change } : source),
    };
    expect(claim.contextDigest).toBe(recoveryContext.contextDigest);
    expect(incompleteP2RecoveryClaimSchema.safeParse(claim).success).toBe(true);

    const fixture = repositoryFixture();
    await fixture.repository.recordWorkerResult(
      completion(recoveryContext, { claim }),
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(),
      NOW,
    );

    expect(gateDecision(fixture.calls)).toEqual({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
  });

  it('rejects a correct-digest Gate claim whose two archived sources are reordered', async () => {
    const recoveryContext = context(3);
    recoveryMocks.requiredDigest.mockResolvedValue(recoveryContext.contextDigest);
    recoveryMocks.load.mockResolvedValue(recoveryContext);
    const original = incompleteP2RecoveryClaimFor(recoveryContext);
    const claim = { ...original, sources: [...original.sources].reverse() };
    expect(claim.contextDigest).toBe(recoveryContext.contextDigest);
    expect(incompleteP2RecoveryClaimSchema.safeParse(claim).success).toBe(true);

    const fixture = repositoryFixture(3);
    await fixture.repository.recordWorkerResult(
      completion(recoveryContext, { claim }),
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(),
      NOW,
    );

    expect(gateDecision(fixture.calls)).toEqual({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
  });

  it.each([
    ['incremental carry-forward', (recoveryContext: IncompleteP2RecoveryContext) => ({
      claim: incompleteP2RecoveryClaimFor(recoveryContext),
      incremental: {
        version: 'IncrementalReview.v1', previousRunId: `run_${'9'.repeat(32)}`,
        previousExecutionAttempt: 1, previousHeadSha: HEAD, previousBaseSha: BASE,
        previousCompletionDigest: 'f'.repeat(64), carriedForwardPaths: ['src/example.ts'],
      },
    })],
    ['verdict-cache carry-forward', (recoveryContext: IncompleteP2RecoveryContext) => ({
      claim: incompleteP2RecoveryClaimFor(recoveryContext),
      verdictCache: {
        version: 'VerdictCache.v1', laneKeys: { security: 'f'.repeat(64) }, entries: [],
        hits: { runId: `run_${'9'.repeat(32)}`, executionAttempt: 1,
          completionDigest: 'f'.repeat(64), paths: ['src/example.ts'] },
      },
    })],
  ])('rejects a fresh claim combined with %s', async (_name, optionsFor) => {
    const recoveryContext = context();
    const fixture = repositoryFixture();
    await fixture.repository.recordWorkerResult(
      completion(recoveryContext, optionsFor(recoveryContext)),
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(),
      NOW,
    );

    expect(gateDecision(fixture.calls)).toEqual({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
  });

  it('rejects an otherwise valid documentation exemption for a recovery attempt', async () => {
    const recoveryContext = context();
    const fixture = repositoryFixture();
    await fixture.repository.recordWorkerResult(
      completion(recoveryContext, {
        claim: incompleteP2RecoveryClaimFor(recoveryContext), documentationOnly: true,
      }),
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(true),
      NOW,
    );

    expect(gateDecision(fixture.calls)).toEqual({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
  });

  it('rolls back and writes no terminal records when the retained archive is unavailable', async () => {
    const recoveryContext = context();
    const fixture = repositoryFixture();
    recoveryMocks.load.mockRejectedValueOnce(new Error('archive unavailable'));

    await expect(fixture.repository.recordWorkerResult(
      completion(recoveryContext, { claim: incompleteP2RecoveryClaimFor(recoveryContext) }),
      { workerTokenDigest: WORKER_TOKEN_DIGEST },
      trustedCompletion(),
      NOW,
    )).rejects.toBeInstanceOf(WorkerCompletionPersistenceError);

    expect(fixture.calls.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
    expect(fixture.calls.some(({ sql }) => sql === 'COMMIT')).toBe(false);
    expect(fixture.calls.some(({ sql }) => sql.startsWith('UPDATE review_gate_attempts'))).toBe(false);
    expect(fixture.calls.some(({ sql }) => sql.startsWith('INSERT INTO review_worker_completions'))).toBe(false);
    expect(fixture.calls.some(({ sql }) => sql.startsWith('UPDATE review_dispatch_outbox'))).toBe(false);
    expect(fixture.calls.some(({ sql }) => sql.startsWith('UPDATE review_runs'))).toBe(false);
  });
});
