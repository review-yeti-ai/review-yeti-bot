import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createReviewExecutionCheckpointHandler } from '../../src/api/reviewExecutionCheckpointRoute';
import { createDisputeFindingTool } from '../../src/mcp/server/tools/disputeFinding';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import { getReviewFindingId } from '../../src/mcp/server/tools/findingIdentity';
import { loadValidatedDisputedFindingRechecks, parseDisputedFindingRecheck } from '../../src/review/disputedFindingRecheck';
import { workerReviewCompletionDigest, type WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import { findingRecheckAdmission } from '../support/findingRecheckAdmission';
import type { ReviewExecutionCheckpoint } from '../../src/review/reviewExecutionCheckpoint';

const workerToken = 'ghs_disputed_finding_fixture';
const identity = {
  runId: `run_${'7'.repeat(32)}`,
  repositoryId: 123,
  owner: 'calltelemetry',
  repo: 'ct-uat',
  prNumber: 1583,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  policyDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
};
const task = {
  id: 'security-reviewer',
  dimension: 'security' as const,
  paths: ['src/auth/guard.ts'],
  question: 'Does the changed authorization guard fail closed?',
  rationale: 'This task covers the changed authorization boundary.',
};
const finding = {
  severity: 'P1' as const,
  path: 'src/auth/guard.ts',
  line: 17,
  title: 'The guard trusts an unbound tenant',
  body: 'The caller can select another tenant because the request identity is not checked.',
};
const completion: WorkerReviewCompletion = {
  version: 'WorkerReviewCompletion.v1',
  ...identity,
  executionAttempt: 1,
  result: {
    version: 'WorkerReviewResult.v1',
    completedAt: '2026-10-01T12:00:00.000Z',
    personas: [{ id: task.id, decision: 'FINDINGS', status: 'COMPLETE', findings: [finding] }],
    taskPlan: [task],
    coverageComplete: true,
    quorumSatisfied: true,
    findingCount: 1,
    blockingFindingCount: 1,
  },
};
const completionDigest = workerReviewCompletionDigest(completion);
const gateAttemptId = `${identity.runId}-g1-e1`;
const gateCoordinates = { ...identity, executionAttempt: 1, attemptId: gateAttemptId };
const checkpointSource: ReviewExecutionCheckpoint = {
  version: 'ReviewExecutionCheckpoint.v1',
  ...identity,
  executionAttempt: 1,
  revision: 4,
  plan: [task],
  completedTasks: [{ id: task.id, findings: [finding] }],
};

function setup() {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const sourcePayload = structuredClone(completion);
  const sourceDigest = completionDigest;
  let currentCheckpoint: unknown = structuredClone(checkpointSource);
  let recheckRow: Record<string, unknown> | undefined;
  let gateCurrentAttempt = true;
  let admissionCreated = false;
  let terminalSourceCompletionBytes = canonicalJson(sourcePayload);
  const transactionClient = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/u.test(sql.trim())) return { rows: [] };
      if (sql.includes('SET LOCAL lock_timeout') || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT repository_id, pr_number FROM review_runs')) {
        return { rows: [{ repository_id: identity.repositoryId, pr_number: identity.prNumber }] };
      }
      if (sql.includes('SELECT runs.status, runs.attempt, outbox.status AS outbox_status')) {
        return { rows: [{ status: 'failed', attempt: 1, outbox_status: 'terminal', execution_attempt: 0 }] };
      }
      if (sql.includes('UPDATE review_runs SET status') || sql.includes('UPDATE review_dispatch_outbox SET status')) {
        return { rows: [{ run_id: identity.runId }] };
      }
      if (sql.includes('UPDATE review_gate_attempts SET current_attempt = false')) {
        gateCurrentAttempt = false;
        return { rows: [{ attempt_id: gateAttemptId }] };
      }
      if (sql.includes('SELECT runs.*, outbox.execution_attempt + 1 AS worker_execution_attempt')) {
        return { rows: [{ ...identity, owner: identity.owner, repo: identity.repo, repository_id: identity.repositoryId,
          pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
          effective_policy_digest: identity.policyDigest, attempt: 2, worker_execution_attempt: 2 }] };
      }
      if (sql.includes('INSERT INTO review_gate_attempts')) {
        return { rows: [{ coordinates: JSON.parse(String(values?.[7])), review_generation: 2, expected_app_id: 4385771,
          external_id: 'fresh-gate', check_id: null, creation_state: 'reserved', desired_state: 'queued',
          desired_version: 0, published_version: -1, current_attempt: true }] };
      }
      if (sql.includes('INSERT INTO review_finding_recheck_admissions')) {
        admissionCreated = true;
        return { rows: [] };
      }
      if (sql.includes('WITH latest_run AS')) {
        return { rows: [{
          ...identity,
          run_id: identity.runId,
          repository_id: identity.repositoryId,
          pr_number: identity.prNumber,
          head_sha: identity.headSha,
          base_sha: identity.baseSha,
          effective_policy_digest: identity.policyDigest,
          effective_config_digest: identity.configDigest,
          attempt: admissionCreated ? 2 : 1,
          status: admissionCreated ? 'queued' : 'failed',
          authoritative_gate_app_id: 4385771, publication_mode: 'app-gate',
          admitted_execution_attempt: admissionCreated ? 2 : null,
          admitted_review_generation: admissionCreated ? 2 : null,
          outbox_execution_attempt: admissionCreated ? 1 : 0,
          outbox_status: admissionCreated ? 'pending' : 'terminal',
          execution_attempt: 1,
          content_digest: sourceDigest,
          payload: sourcePayload,
          gate_attempt_id: gateAttemptId,
          review_generation: 1,
          worker_result_digest: sourceDigest,
          gate_coordinates: gateCoordinates,
          desired_state: 'failure',
          desired_version: 2,
          published_version: 2,
          creation_state: 'bound',
          check_id: 60001,
          current_attempt: gateCurrentAttempt,
        }] };
      }
      if (sql.includes('SELECT payload FROM review_execution_checkpoints')) {
        return { rows: currentCheckpoint ? [{ payload: currentCheckpoint }] : [] };
      }
      if (sql.includes('SELECT request_id, finding_id, counter_argument_digest')) {
        return { rows: recheckRow ? [{
          request_id: recheckRow.request_id,
          finding_id: recheckRow.finding_id,
          counter_argument_digest: recheckRow.counter_argument_digest,
        }] : [] };
      }
      if (sql.includes('SELECT COUNT(*)::int AS count FROM review_finding_rechecks')) {
        return { rows: [{ count: recheckRow ? 1 : 0 }] };
      }
      if (sql.includes('INSERT INTO review_finding_rechecks')) {
        const [requestId, runId, sourceAttempt, sourceContent, sourcePlan, sourceGate, repositoryId, owner, repo,
          prNumber, headSha, baseSha, policyDigest, configDigest, findingId, personaId, taskId, findingJson,
          counterArgument, counterArgumentDigest, requestDigest, requestedBy] = values as unknown[];
        recheckRow = {
          request_id: requestId,
          run_id: runId,
          source_execution_attempt: sourceAttempt,
          source_content_digest: sourceContent,
          source_plan_digest: sourcePlan,
          source_gate_attempt_id: sourceGate,
          repository_id: repositoryId,
          owner,
          repo,
          pr_number: prNumber,
          head_sha: headSha,
          base_sha: baseSha,
          policy_digest: policyDigest,
          config_digest: configDigest,
          finding_id: findingId,
          persona_id: personaId,
          task_id: taskId,
          finding: JSON.parse(String(findingJson)),
          counter_argument: counterArgument,
          counter_argument_digest: counterArgumentDigest,
          request_digest: requestDigest,
          requested_by: requestedBy,
          completion_execution_attempt: 1,
          completion_content_digest: sourceDigest,
          completion_payload: sourcePayload,
          bound_gate_attempt_id: gateAttemptId,
          gate_worker_result_digest: sourceDigest,
          gate_coordinates: gateCoordinates,
          gate_creation_state: 'bound',
          gate_check_id: 60001,
          gate_desired_state: 'failure',
          gate_desired_version: 2,
          gate_published_version: 2,
        };
        return { rows: [] };
      }
      if (sql.includes('SELECT request.*')) return { rows: recheckRow ? [recheckRow] : [] };
      if (sql.includes('SELECT runs.status, outbox.worker_token_digest')) {
        return { rows: [{ status: 'running', worker_token_digest: sha256(workerToken) }] };
      }
      if (sql.includes('SELECT run_id, repository_id, owner, repo, pr_number, head_sha, base_sha')) {
        return { rows: [{ run_id: identity.runId, repository_id: identity.repositoryId, owner: identity.owner,
          repo: identity.repo, pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
          effective_policy_digest: identity.policyDigest,
          effective_config_digest: identity.configDigest }] };
      }
      if (sql.includes('INSERT INTO review_execution_checkpoints')) {
        currentCheckpoint = JSON.parse(String(values?.[5]));
        gateCurrentAttempt = false;
        return { rows: [{ revision: Number(values?.[2]) }] };
      }
      throw new Error(`Unexpected fixture query: ${sql}`);
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => transactionClient) };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.post('/checkpoint', createReviewExecutionCheckpointHandler(pool as never));

  return {
    app,
    calls,
    pool,
    transactionClient,
    get sourcePayload() { return sourcePayload; },
    get sourceDigest() { return sourceDigest; },
    get sourceBytes() { return terminalSourceCompletionBytes; },
    get checkpoint() { return currentCheckpoint as ReviewExecutionCheckpoint | null; },
    get recheck() { return recheckRow; },
    setGateHistorical() { gateCurrentAttempt = false; },
    resetSourceBytes() { terminalSourceCompletionBytes = canonicalJson(sourcePayload); },
  };
}

const caller = {
  authType: 'static_token' as const,
  tokenDigest: 'fixture-token-digest',
  isAdmin: true,
  allowedRepositories: null,
  callerId: 'rel1265-test-operator',
};

describe('REL-1265 dispute re-review flow', () => {
  it.each(['completion_execution_attempt', 'bound_gate_attempt_id'])('rejects a request after its %s source binding is lost', async (missing) => {
    const f = setup();
    const tool = createDisputeFindingTool({ transactionPool: f.pool as never, authoritativePublishing: findingRecheckAdmission(identity) });
    await tool.execute({ owner: identity.owner, repo: identity.repo, pr_number: identity.prNumber,
      finding_id: getReviewFindingId(identity.runId, task.id, finding),
      counter_argument: 'The router binds the authenticated tenant before evaluating this guard.' },
    { caller, authenticatedByConfiguredAuthenticator: true, authorizedRepository: { owner: identity.owner, repo: identity.repo } });
    const run = { run_id: identity.runId, repository_id: identity.repositoryId, owner: identity.owner,
      repo: identity.repo, pr_number: identity.prNumber, head_sha: identity.headSha, base_sha: identity.baseSha,
      effective_policy_digest: identity.policyDigest, effective_config_digest: identity.configDigest };
    await expect(loadValidatedDisputedFindingRechecks(f.transactionClient, run, 2)).resolves.toHaveLength(1);
    const query = vi.fn(async () => ({ rows: [{ ...f.recheck, [missing]: null }] }));
    await expect(loadValidatedDisputedFindingRechecks({ query }, run, 2)).rejects.toThrow('Disputed finding source binding is invalid');
    expect(query).toHaveBeenCalledOnce();
  });

  it('stores an immutable request, authenticates its read, and accepts only its completed-task receipt', async () => {
    const f = setup();
    const sourceBytesBefore = f.sourceBytes;
    const digestBefore = f.sourceDigest;
    const adjudicateDispute = vi.fn();
    const tool = createDisputeFindingTool({ transactionPool: f.pool as never, authoritativePublishing: findingRecheckAdmission(identity), adjudicateDispute });
    const findingId = getReviewFindingId(identity.runId, task.id, finding);
    const requestResult = await tool.execute({
      owner: identity.owner,
      repo: identity.repo,
      pr_number: identity.prNumber,
      finding_id: findingId,
      counter_argument: 'The router binds the authenticated repository before this handler reaches tenant data.',
    }, { caller, authenticatedByConfiguredAuthenticator: true, authorizedRepository: { owner: identity.owner, repo: identity.repo } });
    const requested = JSON.parse((requestResult.content[0] as { text: string }).text);

    expect(requested).toMatchObject({ finding_id: findingId, review_status: 'fresh_re_review_requested',
      remaining_blockers: 1 });
    expect(requested.request_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(adjudicateDispute).not.toHaveBeenCalled();
    expect(f.calls.some(({ sql }) => /UPDATE\s+review_worker_completions/iu.test(sql))).toBe(false);
    expect(f.calls.some(({ sql }) => sql.includes('INSERT INTO review_finding_recheck_admissions'))).toBe(true);
    expect(f.sourceBytes).toBe(sourceBytesBefore);
    expect(workerReviewCompletionDigest(f.sourcePayload)).toBe(digestBefore);

    // Once a retry reserves its own attempt, the source Gate is historical. It remains
    // readable only because the request is bound to the exact published Gate and completion.
    f.setGateHistorical();
    const read = await request(f.app).post('/checkpoint').set('Authorization', `Bearer ${workerToken}`).send({
      version: 'ReviewExecutionCheckpointRead.v1', runId: identity.runId, executionAttempt: 2,
    });
    expect(read.status).toBe(200);
    expect(read.body.disputedFindingRechecks).toHaveLength(1);
    const recheck = parseDisputedFindingRecheck(read.body.disputedFindingRechecks[0]);
    expect(recheck).toMatchObject({ requestId: requested.request_id, findingId, taskId: task.id,
      sourceExecutionAttempt: 1, sourceContentDigest: digestBefore, sourceGateAttemptId: gateAttemptId });
    expect(f.calls.some(({ sql }) => sql.includes('FROM review_finding_rechecks request'))).toBe(true);

    const acceptedCheckpoint = {
      ...checkpointSource,
      executionAttempt: 2,
      revision: 5,
      completedTasks: [{ id: task.id, findings: [] }],
      satisfiedFindingRecheckIds: [requested.request_id],
    };
    const write = await request(f.app).post('/checkpoint').set('Authorization', `Bearer ${workerToken}`).send(acceptedCheckpoint);
    expect(write.status).toBe(200);
    expect(f.checkpoint).toMatchObject({ executionAttempt: 2, satisfiedFindingRecheckIds: [requested.request_id],
      completedTasks: [{ id: task.id, findings: [] }] });
    expect(f.sourceBytes).toBe(sourceBytesBefore);
    expect(workerReviewCompletionDigest(f.sourcePayload)).toBe(digestBefore);
  });

  it('rejects fabricated, uncompleted, or unauthorized satisfaction receipts without checkpoint mutation', async () => {
    const f = setup();
    const tool = createDisputeFindingTool({ transactionPool: f.pool as never, authoritativePublishing: findingRecheckAdmission(identity) });
    const findingId = getReviewFindingId(identity.runId, task.id, finding);
    const requestResult = await tool.execute({
      owner: identity.owner, repo: identity.repo, pr_number: identity.prNumber, finding_id: findingId,
      counter_argument: 'The caller identity is bound to the repository before this handler reads source evidence.',
    }, { caller, authenticatedByConfiguredAuthenticator: true, authorizedRepository: { owner: identity.owner, repo: identity.repo } });
    const requested = JSON.parse((requestResult.content[0] as { text: string }).text);
    f.setGateHistorical();

    const unauthorizedRead = await request(f.app).post('/checkpoint')
      .set('Authorization', `Bearer ${workerToken}-unauthorized`).send({
        version: 'ReviewExecutionCheckpointRead.v1', runId: identity.runId, executionAttempt: 2,
      });
    expect(unauthorizedRead.status).toBe(403);

    const before = f.checkpoint;
    const forgedReceipt = await request(f.app).post('/checkpoint').set('Authorization', `Bearer ${workerToken}`).send({
      ...checkpointSource, executionAttempt: 2, revision: 5,
      satisfiedFindingRecheckIds: ['00000000-0000-4000-8000-000000000001'],
    });
    expect(forgedReceipt.status).toBe(503);
    expect(f.checkpoint).toEqual(before);

    const noCompletedTask = await request(f.app).post('/checkpoint').set('Authorization', `Bearer ${workerToken}`).send({
      ...checkpointSource, executionAttempt: 2, revision: 5, completedTasks: [],
      satisfiedFindingRecheckIds: [requested.request_id],
    });
    expect(noCompletedTask.status).toBe(503);
    expect(f.checkpoint).toEqual(before);
  });
});
