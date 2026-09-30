import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { createIncompleteP2RecoveryContext } from '../../src/review/incompleteP2Recovery';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { deriveReviewRunId } from '../../src/review/reviewAdmission';
import type { ReviewGenerationRecoveryEvidence } from '../../src/review/reviewGenerationRecovery';
import { sha256 } from '../../src/review/reviewCore';
import type { ReviewAdmissionInput } from '../../src/review/reviewRun';

const recoveryLoader = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('../../src/persistence/incompleteP2Recovery', () => ({
  loadIncompleteP2RecoveryContext: recoveryLoader.load,
}));

const expectedAppId = 4_385_771;
const requested = {
  owner: 'calltelemetry',
  repo: 'cisco-cdr',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  repositoryId: 123,
};
const policyContent = JSON.stringify({
  schema: 'calltelemetry.review-policy.v1',
  review_yeti: { personas: 'security,testing', budget: { max_investigation_turns: 1 } },
});
const policySource = {
  repositoryId: 987,
  repository: 'calltelemetry/review-policies',
  sha: 'f'.repeat(40),
  path: 'policy/review.json',
  contentDigest: createHash('sha256').update(policyContent).digest('hex'),
};
const prepared = preparePublishingPolicy({ source: policySource, content: policyContent }, {
  baseUrl: 'https://gateway.example.invalid/v1',
  model: 'deepseek/deepseek-v4-flash',
});
const identity = buildAuthoritativeReviewIdentity({
  requested,
  current: { ...requested, open: true, draft: false },
  policy: prepared.policy,
});
const runId = deriveReviewRunId(identity);
const receivedAt = 1_790_000_000_000;

function incompleteEvidence(canonicalFindings = 2, rawFindings = 3): ReviewGenerationRecoveryEvidence[] {
  const expectedLanes = 6;
  const completedLanes = 5;
  const summary = `Verdict \`BLOCK\` at \`${identity.headSha}\`.\n\n`
    + `Findings: ${canonicalFindings} (blocking P0/P1: 0; ${rawFindings} raw persona finding(s) before clustering).\n\n`
    + `Coverage: mode=panel; expected lanes=${expectedLanes}; completed lanes=${completedLanes}; failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false.`;
  const gateCheck = {
    id: 4_001,
    name: 'Review Yeti Gate',
    head_sha: identity.headSha,
    external_id: `review-yeti-gate:v1:${'d'.repeat(64)}`,
    status: 'completed',
    conclusion: 'failure',
    app: { id: expectedAppId, slug: 'ct-review-bot' },
    completed_at: '2026-09-24T18:28:58Z',
    output: {
      title: 'Review Yeti Gate: Failed (incomplete panel)',
      summary: 'Review Yeti Gate failed: the panel expected 6 review lane(s) but 5 completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.',
      text: null,
    },
  };

  return [{
    generation: 1,
    checkId: 3_001,
    externalId: `${runId}:a1`,
    conclusion: 'failure',
    title: 'Review Yeti: BLOCK',
    legacyIncompleteRoster: {
      workerSummary: summary,
      workerCompletedAt: '2026-09-24T18:28:56Z',
      gateChecks: [gateCheck],
    },
  }];
}

function admissionInput(incompleteP2Recovery = true): ReviewAdmissionInput {
  return {
    deliveryId: `recovery:${runId}:a2`,
    eventName: 'repository_dispatch',
    repositoryId: requested.repositoryId,
    installationId: 456,
    receivedAt,
    terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
    payloadDigest: 'c'.repeat(64),
    publicationMode: 'app-gate',
    centralActionDispatch: true,
    expectedGeneration: 2,
    identity,
    effectivePolicyDigest: prepared.policy.effectivePolicyDigest,
    retryRequested: true,
    retryAfterExecutionAttempt: 1,
    ...(incompleteP2Recovery ? { incompleteP2Recovery: true } : {}),
    authoritativeGate: { expectedAppId, prepared },
  };
}

function recoveryContext() {
  return createIncompleteP2RecoveryContext({
    version: 'IncompleteP2RecoveryContext.v1',
    runId,
    repositoryId: requested.repositoryId,
    owner: identity.owner,
    repo: identity.repo,
    prNumber: identity.prNumber,
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    policyDigest: prepared.policy.effectivePolicyDigest,
    configDigest: identity.configDigest,
    expectedAppId,
    executionAttempt: 2,
    sources: [{
      executionAttempt: 1,
      workerResultDigest: 'e'.repeat(64),
      workerCheckId: 3_001,
      gateCheckId: 4_001,
      rawFindingCount: 1,
      canonicalFindingCount: 1,
    }],
    findings: [{
      sourceExecutionAttempt: 1,
      sourceWorkerResultDigest: 'e'.repeat(64),
      sourceWorkerCheckId: 3_001,
      sourceGateCheckId: 4_001,
      personaId: 'security',
      findingIndex: 0,
      finding: {
        severity: 'P2',
        path: 'src/recovery.ts',
        line: 17,
        title: 'Keep the recovered finding visible',
        body: 'The original P2 finding remains part of the new review context.',
      },
    }],
  });
}

function transactionHarness() {
  const events: string[] = [];
  const artifacts: Record<string, unknown>[] = [];
  const policyRow = {
    effective_policy_digest: prepared.policy.effectivePolicyDigest,
    version: prepared.version,
    effective_config_digest: prepared.policy.effectiveConfigDigest,
    config: prepared.config,
    transport: prepared.transport,
    sources: prepared.policy.sources,
    expected_persona_ids: prepared.expectedPersonaIds,
    prepared_content_digest: sha256({ version: 'PreparedReviewContent.v1', prepared }),
  };
  const runRow = {
    run_id: runId,
    identity_digest: sha256(identity),
    owner: identity.owner,
    repo: identity.repo,
    pr_number: identity.prNumber,
    head_sha: identity.headSha,
    base_sha: identity.baseSha,
    snapshot_digest: identity.snapshotDigest,
    config_digest: identity.configDigest,
    effective_policy_digest: prepared.policy.effectivePolicyDigest,
    effective_config_digest: prepared.policy.effectiveConfigDigest,
    publication_mode: 'app-gate',
    authoritative_gate_app_id: expectedAppId,
    index_epoch: 0,
    identity,
    status: 'queued',
    stage: 'admission',
    attempt: 1,
    artifacts: {},
    repository_id: requested.repositoryId,
    installation_id: 456,
    delivery_id: admissionInput().deliveryId,
    received_at: new Date(receivedAt),
    terminal_deadline: new Date(receivedAt + TERMINAL_DEADLINE_MS),
    created_at: new Date(receivedAt),
    updated_at: new Date(receivedAt),
  };
  const gateCoordinates = {
    owner: identity.owner,
    repo: identity.repo,
    repositoryId: requested.repositoryId,
    prNumber: identity.prNumber,
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    policyDigest: prepared.policy.effectivePolicyDigest,
    runId,
    executionAttempt: 2,
    attemptId: `${runId}-g1-e2`,
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === 'BEGIN') { events.push('begin'); return { rows: [] }; }
    if (sql === 'COMMIT') { events.push('commit'); return { rows: [] }; }
    if (sql === 'ROLLBACK') { events.push('rollback'); return { rows: [] }; }
    if (/SELECT pg_advisory_xact_lock/u.test(sql)) { events.push('pr-lock'); return { rows: [] }; }
    if (/INSERT INTO prepared_review_policies/u.test(sql)) { events.push('prepared-policy-write'); return { rows: [] }; }
    if (/SELECT effective_policy_digest, version, effective_config_digest/u.test(sql)) {
      events.push('prepared-policy-read'); return { rows: [policyRow] };
    }
    if (/SELECT attempt FROM review_runs WHERE identity_digest/u.test(sql)) {
      events.push('existing-run-read'); return { rows: [{ attempt: 1 }] };
    }
    if (/INSERT INTO github_deliveries/u.test(sql)) {
      events.push('delivery-allocation'); return { rows: [{ delivery_id: admissionInput().deliveryId }] };
    }
    if (/INSERT INTO review_runs/u.test(sql)) {
      events.push('run-allocation');
      artifacts.push(JSON.parse(String(values[24])) as Record<string, unknown>);
      return { rows: [{ ...runRow, artifacts: JSON.parse(String(values[24])) }] };
    }
    if (/SELECT repository_id, pr_number FROM review_runs WHERE run_id/u.test(sql)) {
      return { rows: [{ repository_id: requested.repositoryId, pr_number: identity.prNumber }] };
    }
    if (/SELECT runs\.\*, outbox\.execution_attempt \+ 1 AS worker_execution_attempt/u.test(sql)) {
      return { rows: [{ ...runRow, worker_execution_attempt: 2 }] };
    }
    if (/INSERT INTO review_dispatch_outbox/u.test(sql)) {
      events.push('outbox-allocation'); return { rows: [] };
    }
    if (/INSERT INTO review_generation_recoveries/u.test(sql)) {
      events.push('generation-ledger-write'); return { rows: [] };
    }
    if (/INSERT INTO review_gate_attempts/u.test(sql)) {
      events.push('gate-allocation');
      return { rows: [{
        attempt_id: gateCoordinates.attemptId,
        run_id: runId,
        review_generation: 1,
        execution_attempt: 2,
        repository_id: requested.repositoryId,
        pr_number: identity.prNumber,
        expected_app_id: expectedAppId,
        coordinates: gateCoordinates,
        external_id: `review-yeti-gate:v1:${'f'.repeat(64)}`,
        check_id: null,
        creation_state: 'reserved',
        desired_state: 'queued',
        desired_version: 1,
        published_version: 0,
        current_attempt: true,
      }] };
    }
    if (/INSERT INTO review_event_outbox/u.test(sql)) events.push('lifecycle-write');
    if (/WITH superseded/u.test(sql)) events.push('supersede-check');
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const validateAuthoritativeAdmission = vi.fn(async () => undefined);
  const resolveGenerationRecovery = vi.fn(async (input: ReviewAdmissionInput) =>
    incompleteEvidence(input.incompleteP2Recovery ? 2 : 0, input.incompleteP2Recovery ? 3 : 0));
  const repository = new PostgresReviewDispatchRepository({ connect: vi.fn(async () => client) } as never, undefined, {
    lifecycleEvents: 'disabled',
    validateAuthoritativeAdmission,
    resolveGenerationRecovery,
  });
  return { repository, query, client, events, artifacts, validateAuthoritativeAdmission, resolveGenerationRecovery };
}

describe('incomplete P2 recovery admission', () => {
  it('loads the complete retained archive under the PR lock before allocating generation or outbox state', async () => {
    recoveryLoader.load.mockReset();
    const context = recoveryContext();
    const harness = transactionHarness();
    recoveryLoader.load.mockImplementation(async (_client, lookup) => {
      harness.events.push('archive-load');
      expect(lookup).toMatchObject({
        runId,
        repositoryId: requested.repositoryId,
        identity,
        policyDigest: prepared.policy.effectivePolicyDigest,
        incompleteP2Recovery: true,
        expectedAppId,
        executionAttempt: 2,
        recoveryEvidence: incompleteEvidence(),
      });
      return context;
    });

    const result = await harness.repository.admit(admissionInput());
    const allocationEvents = harness.events.filter((event) => [
      'delivery-allocation', 'run-allocation', 'generation-ledger-write', 'outbox-allocation', 'gate-allocation',
    ].includes(event));

    expect(harness.events.indexOf('pr-lock')).toBeLessThan(harness.events.indexOf('archive-load'));
    expect(harness.events.indexOf('archive-load')).toBeLessThan(harness.events.indexOf('delivery-allocation'));
    expect(harness.events.indexOf('archive-load')).toBeLessThan(harness.events.indexOf('run-allocation'));
    expect(harness.events.indexOf('archive-load')).toBeLessThan(harness.events.indexOf('generation-ledger-write'));
    expect(harness.events.indexOf('archive-load')).toBeLessThan(harness.events.indexOf('outbox-allocation'));
    expect(allocationEvents).toContain('outbox-allocation');
    expect(result.status).toBe('accepted');
    expect(result.run.artifacts).toMatchObject({ incomplete_p2_recovery_digest: context.contextDigest });
    expect(harness.artifacts).toEqual([{ review_engine: 'panel', incomplete_p2_recovery_digest: context.contextDigest }]);
    expect(recoveryLoader.load).toHaveBeenCalledOnce();
    expect(recoveryLoader.load.mock.calls[0][0]).toBe(harness.client);
    expect(harness.events.at(-1)).toBe('commit');
  });

  it.each([
    ['mismatched archive', async () => null],
    ['unavailable archive', async () => { throw new Error('archive unavailable'); }],
  ])('rolls back a centrally authorized retry when the %s cannot be loaded', async (_label, loadArchive) => {
    recoveryLoader.load.mockReset();
    const harness = transactionHarness();
    recoveryLoader.load.mockImplementation(async () => {
      harness.events.push('archive-load');
      return loadArchive();
    });

    await expect(harness.repository.admit(admissionInput())).rejects.toThrow();

    expect(harness.events.indexOf('pr-lock')).toBeLessThan(harness.events.indexOf('archive-load'));
    expect(harness.events).toContain('rollback');
    expect(harness.events).not.toContain('delivery-allocation');
    expect(harness.events).not.toContain('run-allocation');
    expect(harness.events).not.toContain('generation-ledger-write');
    expect(harness.events).not.toContain('outbox-allocation');
    expect(harness.events).not.toContain('gate-allocation');
    expect(recoveryLoader.load).toHaveBeenCalledOnce();
  });

  it('keeps the unflagged zero-finding retry path free of the retained-P2 loader and digest marker', async () => {
    recoveryLoader.load.mockReset();
    const harness = transactionHarness();
    const result = await harness.repository.admit(admissionInput(false));

    expect(result.status).toBe('accepted');
    expect(recoveryLoader.load).not.toHaveBeenCalled();
    expect(harness.events).toContain('outbox-allocation');
    expect(harness.events.at(-1)).toBe('commit');
    expect(result.run.artifacts).not.toHaveProperty('incomplete_p2_recovery_digest');
    expect(harness.artifacts).toEqual([{ review_engine: 'panel' }]);
  });
});
