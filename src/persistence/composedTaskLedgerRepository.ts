import { timingSafeEqual } from 'node:crypto';
import { canonicalJson, sha256 } from '../review/reviewCore';
import { MAX_TASKS_HARD_CAP } from '../reviewTaskContract';
import type { WorkerCompletionProof } from '../review/workerCompletion';
import { createComposedTaskPlan, createComposedTaskOutcome, verifyComposedTaskPlan, verifyComposedTaskOutcome,
  parseComposedTaskOutcomeInput, validateComposedTaskLedgerContext, ComposedTaskLedgerError, MAX_COMPOSED_LEDGER_BYTES,
  type ComposedTaskPlan, type ComposedTaskOutcome, type ComposedTaskRecord,
  type TrustedComposedTaskLedgerContext } from '../review/composedTaskLedger';
import { lockReviewPr, withReviewPrTransaction, type ReviewPrQueryable, type ReviewPrTransactionPool } from './reviewPrTransaction';

/** Additive bootstrap only; no API enrollment or worker adoption. Text stores
 * canonical JSON so the DB enforces the exact UTF-8 byte count, not jsonb's
 * differently spaced rendering. Immutable UPDATE guard permits run FK cleanup. */
export const COMPOSED_TASK_LEDGER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS composed_task_plans (
    attempt_id TEXT PRIMARY KEY REFERENCES review_gate_attempts(attempt_id) ON DELETE CASCADE,
    content_digest VARCHAR(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
    payload TEXT NOT NULL CHECK (jsonb_typeof(payload::jsonb) = 'object'),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= ${MAX_COMPOSED_LEDGER_BYTES}
      AND byte_length = octet_length(payload)),
    task_count INTEGER NOT NULL CHECK (task_count BETWEEN 1 AND ${MAX_TASKS_HARD_CAP}),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (attempt_id, content_digest),
    CHECK ((payload::jsonb->>'version' = 'ComposedTaskLedger.v1') IS TRUE),
    CHECK ((payload::jsonb->'identity'->>'attemptId' = attempt_id) IS TRUE),
    CHECK ((jsonb_array_length(payload::jsonb->'tasks') = task_count) IS TRUE)
  );
  CREATE TABLE IF NOT EXISTS composed_task_outcomes (
    attempt_id TEXT NOT NULL,
    plan_digest VARCHAR(64) NOT NULL,
    task_id TEXT NOT NULL CHECK (task_id ~ '^[a-z][a-z0-9_-]{0,127}$'),
    task_index INTEGER NOT NULL CHECK (task_index BETWEEN 0 AND ${MAX_TASKS_HARD_CAP - 1}),
    status TEXT NOT NULL CHECK (status IN ('complete', 'blocked', 'exhausted')),
    content_digest VARCHAR(64) NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
    payload TEXT NOT NULL CHECK (jsonb_typeof(payload::jsonb) = 'object'),
    byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= ${MAX_COMPOSED_LEDGER_BYTES}
      AND byte_length = octet_length(payload)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (attempt_id, task_id), UNIQUE (attempt_id, task_index),
    FOREIGN KEY (attempt_id, plan_digest) REFERENCES composed_task_plans(attempt_id, content_digest) ON DELETE CASCADE,
    CHECK ((payload::jsonb->>'version' = 'ComposedTaskOutcome.v1') IS TRUE),
    CHECK ((payload::jsonb->>'planDigest' = plan_digest) IS TRUE),
    CHECK ((payload::jsonb->>'taskId' = task_id) IS TRUE), CHECK ((payload::jsonb->>'status' = status) IS TRUE)
  );
  CREATE OR REPLACE FUNCTION composed_task_ledger_reject_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'composed task ledger is immutable'; END $$;
  DROP TRIGGER IF EXISTS composed_task_plan_immutable ON composed_task_plans;
  CREATE TRIGGER composed_task_plan_immutable BEFORE UPDATE ON composed_task_plans
    FOR EACH ROW EXECUTE FUNCTION composed_task_ledger_reject_update();
  DROP TRIGGER IF EXISTS composed_task_outcome_immutable ON composed_task_outcomes;
  CREATE TRIGGER composed_task_outcome_immutable BEFORE UPDATE ON composed_task_outcomes
    FOR EACH ROW EXECUTE FUNCTION composed_task_ledger_reject_update();
  -- A client can pause after the last SELECT but before COMMIT. Deferred
  -- constraints recheck the DB clock at the commit boundary, while the native
  -- PR/Gate/run/outbox locks still fence cancellation and replacement.
  CREATE OR REPLACE FUNCTION composed_task_ledger_commit_fence() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM review_gate_attempts gate JOIN review_runs runs USING(run_id)
        JOIN review_dispatch_outbox outbox USING(run_id)
        WHERE gate.attempt_id = NEW.attempt_id AND gate.current_attempt
          AND gate.creation_state = 'bound' AND gate.check_id IS NOT NULL
          AND gate.desired_state IN ('queued','in_progress') AND gate.worker_result_digest IS NULL
          AND runs.authoritative_gate_app_id = gate.expected_app_id AND runs.publication_mode = 'app-gate'
          AND runs.attempt = gate.review_generation AND outbox.execution_attempt + 1 = gate.execution_attempt
          AND runs.status IN ('queued','running') AND outbox.status IN ('pending','claimed','projected')
          AND runs.cancel_requested_at IS NULL AND outbox.cancel_requested_at IS NULL
          AND runs.terminal_deadline > clock_timestamp()
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'composed_task_commit_fence',
          MESSAGE = 'composed task commit fence rejected';
      END IF;
      RETURN NEW;
    END $$;
  DROP TRIGGER IF EXISTS composed_task_plan_commit_fence ON composed_task_plans;
  CREATE CONSTRAINT TRIGGER composed_task_plan_commit_fence AFTER INSERT ON composed_task_plans
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composed_task_ledger_commit_fence();
  DROP TRIGGER IF EXISTS composed_task_outcome_commit_fence ON composed_task_outcomes;
  CREATE CONSTRAINT TRIGGER composed_task_outcome_commit_fence AFTER INSERT ON composed_task_outcomes
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composed_task_ledger_commit_fence();
`;

export type ComposedTaskRetentionTransition = 'recorded' | 'duplicate' | 'conflict' | 'stale' | 'unauthorized' | 'missing-plan';
export interface ComposedTaskRetentionResult { status: ComposedTaskRetentionTransition; digest?: string }
export interface RetainedComposedTasks {
  plan: ComposedTaskRecord<ComposedTaskPlan>;
  outcomes: ComposedTaskRecord<ComposedTaskOutcome>[];
}
function sameToken(stored: unknown, supplied: unknown): boolean {
  return typeof stored === 'string' && typeof supplied === 'string'
    && /^[a-f0-9]{64}$/u.test(stored) && /^[a-f0-9]{64}$/u.test(supplied)
    && timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(supplied, 'hex'));
}
function json(value: unknown): any { return typeof value === 'string' ? JSON.parse(value) : value; }
function stored<T>(row: any): ComposedTaskRecord<T> {
  // Parse/verify errors are sanitized by the caller; neither raw SQL errors nor
  // persisted candidate data are included in the error or its cause.
  if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > MAX_COMPOSED_LEDGER_BYTES) throw new Error();
  return { digest: row.content_digest, byteLength: Number(row.byte_length), payload: JSON.parse(row.payload) as T };
}

/** Internal retention port. It does not acknowledge task execution, advance a
 * cursor, amend deadlines, publish events/checks, or make any Gate decision. */
export class PostgresComposedTaskLedgerRepository {
  constructor(private readonly pool: ReviewPrTransactionPool) {}

  private async transaction<T>(trusted: TrustedComposedTaskLedgerContext,
    operation: (client: ReviewPrQueryable) => Promise<T>): Promise<T> {
    try {
      return await withReviewPrTransaction(this.pool, async client => {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await lockReviewPr(client, trusted.identity.repositoryId, trusted.identity.prNumber);
        return operation(client);
      });
    } catch (error) {
      if (error instanceof ComposedTaskLedgerError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23514'
        && 'constraint' in error && error.constraint === 'composed_task_commit_fence') {
        throw new ComposedTaskLedgerError('fence-expired');
      }
      throw new ComposedTaskLedgerError('storage-unavailable');
    }
  }

  /** Same lock domain/order as current native completion/cancellation: PR lock,
   * then current Gate/run/outbox rows, THEN immutable ledger rows. No new lease:
   * markProjected deliberately clears the dispatcher's claim lease. Its worker
   * is instead fenced by generation/execution/token/cancel/terminal deadline. */
  private async fence(client: ReviewPrQueryable, trusted: TrustedComposedTaskLedgerContext,
    proof: WorkerCompletionProof): Promise<'current' | 'stale' | 'unauthorized'> {
    const i = trusted.identity;
    const row = (await client.query(`SELECT gate.*, runs.owner, runs.repo, runs.head_sha, runs.base_sha,
      runs.repository_id AS run_repository_id, runs.pr_number AS run_pr_number,
      runs.status AS run_status, runs.attempt AS current_generation, runs.snapshot_digest,
      runs.effective_config_digest, runs.effective_policy_digest, runs.identity,
      runs.authoritative_gate_app_id, runs.publication_mode, runs.received_at, runs.terminal_deadline,
      runs.cancel_requested_at AS run_cancel, runs.artifacts, outbox.cancel_requested_at AS dispatch_cancel,
      outbox.worker_token_digest, outbox.execution_attempt AS current_execution, outbox.status AS outbox_status,
      runs.terminal_deadline > clock_timestamp() AS deadline_current
      FROM review_gate_attempts gate JOIN review_runs runs USING(run_id)
      JOIN review_dispatch_outbox outbox USING(run_id)
      WHERE gate.run_id=$1 AND gate.current_attempt FOR UPDATE OF gate,runs,outbox`, [i.runId])).rows[0];
    if (!row) return 'stale';
    if (!sameToken(row.worker_token_digest, proof?.workerTokenDigest)) return 'unauthorized';
    if (row.deadline_current !== true) return 'stale';
    const coordinates = json(row.coordinates);
    const identity = json(row.identity);
    if (Number(row.authoritative_gate_app_id) !== i.expectedAppId || Number(row.expected_app_id) !== i.expectedAppId
      || Number(row.current_generation) !== i.reviewGeneration || Number(row.review_generation) !== i.reviewGeneration
      || Number(row.current_execution) + 1 !== i.executionAttempt || Number(row.execution_attempt) !== i.executionAttempt
      || row.attempt_id !== i.attemptId || row.effective_config_digest !== i.configDigest
      || row.effective_policy_digest !== i.policyDigest || row.snapshot_digest !== i.snapshotDigest
      || row.owner !== i.owner || row.repo !== i.repo || row.head_sha !== i.headSha || row.base_sha !== i.baseSha
      || Number(row.run_repository_id) !== i.repositoryId || Number(row.run_pr_number) !== i.prNumber
      || Number(row.repository_id) !== i.repositoryId || Number(row.pr_number) !== i.prNumber
      || new Date(row.received_at).toISOString() !== i.receivedAt
      || new Date(row.terminal_deadline).toISOString() !== i.terminalDeadline
      || ['owner','repo','prNumber','headSha','baseSha','snapshotDigest','configDigest']
        .some(key => identity?.[key] !== i[key as keyof typeof i])
      || identity?.reviewPolicy?.version !== 'ReviewPolicyIdentity.v1'
      || identity?.reviewPolicy?.repositoryId !== i.repositoryId || identity?.reviewPolicy?.effectivePolicyDigest !== i.policyDigest
      || canonicalJson(identity?.reviewPolicy?.sources) !== canonicalJson(i.policySources)
      || ['runId','repositoryId','owner','repo','prNumber','headSha','baseSha','policyDigest','executionAttempt','attemptId']
        .some(key => coordinates?.[key] !== i[key as keyof typeof i])) return 'unauthorized';
    if (row.publication_mode !== 'app-gate' || json(row.artifacts)?.review_engine !== 'composed'
      || !['queued', 'running'].includes(row.run_status) || !['pending', 'claimed', 'projected'].includes(row.outbox_status)
      || row.run_cancel != null || row.dispatch_cancel != null || row.deadline_current !== true
      || row.creation_state !== 'bound' || row.check_id == null
      || !['queued', 'in_progress'].includes(row.desired_state) || row.worker_result_digest != null) return 'stale';
    return 'current';
  }

  private async plan(client: ReviewPrQueryable, trusted: TrustedComposedTaskLedgerContext): Promise<ComposedTaskRecord<ComposedTaskPlan> | null> {
    const rows = (await client.query('SELECT * FROM composed_task_plans WHERE attempt_id=$1', [trusted.identity.attemptId])).rows;
    if (!rows.length) return null;
    try {
      const candidate = stored<ComposedTaskPlan>(rows[0]);
      // Verify the original immutable identity before comparing it with a new
      // candidate. Different trusted provenance is a conflict, not corruption.
      return verifyComposedTaskPlan({ identity: candidate.payload.identity,
        changedFiles: candidate.payload.changedPaths.map(path => ({ path })) }, candidate);
    }
    catch { throw new ComposedTaskLedgerError('integrity'); }
  }

  async recordPlan(context: TrustedComposedTaskLedgerContext, tasks: unknown,
    proof: WorkerCompletionProof): Promise<ComposedTaskRetentionResult> {
    const trusted = validateComposedTaskLedgerContext(context);
    const candidate = createComposedTaskPlan(trusted, tasks);
    return this.transaction(trusted, async client => {
      const fence = await this.fence(client, trusted, proof);
      if (fence !== 'current') return { status: fence };
      // Revalidate the stored body before any duplicate/conflict acknowledgement.
      const existing = await this.plan(client, trusted);
      if (existing) {
        const current = await this.fence(client, trusted, proof);
        return current !== 'current' ? { status: current }
          : { status: existing.digest === candidate.digest ? 'duplicate' : 'conflict', digest: existing.digest };
      }
      await client.query(`INSERT INTO composed_task_plans (attempt_id,content_digest,payload,byte_length,task_count)
        VALUES ($1,$2,$3,$4,$5)`, [trusted.identity.attemptId, candidate.digest,
        canonicalJson(candidate.payload), candidate.byteLength, candidate.payload.tasks.length]);
      // DB wall clock AFTER waits/insert: transaction-start NOW() and caller
      // clocks must never admit a late commit. Any changed fence rolls back.
      if (await this.fence(client, trusted, proof) !== 'current') throw new ComposedTaskLedgerError('fence-expired');
      return { status: 'recorded', digest: candidate.digest };
    });
  }

  async recordTask(context: TrustedComposedTaskLedgerContext, input: unknown,
    proof: WorkerCompletionProof): Promise<ComposedTaskRetentionResult> {
    const trusted = validateComposedTaskLedgerContext(context);
    const parsedInput = parseComposedTaskOutcomeInput(input);
    return this.transaction(trusted, async client => {
      const fence = await this.fence(client, trusted, proof);
      if (fence !== 'current') return { status: fence };
      const plan = await this.plan(client, trusted);
      if (!plan) return { status: 'missing-plan' };
      if (canonicalJson(plan.payload.identity) !== canonicalJson(trusted.identity)
        || plan.payload.changedPathsDigest !== sha256(trusted.changedFiles.map(file => file.path))) {
        return { status: 'conflict', digest: plan.digest };
      }
      // A different valid digest is an immutable-plan conflict, not permission
      // to replace it. All other fields still pass the closed outcome contract.
      if (parsedInput.planDigest !== plan.digest) return { status: 'conflict', digest: plan.digest };
      const candidate = createComposedTaskOutcome(plan, parsedInput, trusted.changedFiles);
      const index = plan.payload.tasks.findIndex(task => task.id === candidate.payload.taskId);
      const retained = await this.outcomes(client, trusted, plan);
      const existing = retained.find(outcome => outcome.payload.taskId === candidate.payload.taskId);
      if (existing) {
        const current = await this.fence(client, trusted, proof);
        return current !== 'current' ? { status: current }
          : { status: existing.digest === candidate.digest ? 'duplicate' : 'conflict', digest: existing.digest };
      }
      if (plan.byteLength + retained.reduce((sum, outcome) => sum + outcome.byteLength, 0)
        + candidate.byteLength > MAX_COMPOSED_LEDGER_BYTES) throw new ComposedTaskLedgerError('byte-bound');
      await client.query(`INSERT INTO composed_task_outcomes (attempt_id,plan_digest,task_id,task_index,status,
        content_digest,payload,byte_length) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [trusted.identity.attemptId, plan.digest, candidate.payload.taskId, index, candidate.payload.status,
        candidate.digest, canonicalJson(candidate.payload), candidate.byteLength]);
      if (await this.fence(client, trusted, proof) !== 'current') throw new ComposedTaskLedgerError('fence-expired');
      return { status: 'recorded', digest: candidate.digest };
    });
  }

  private async outcomes(client: ReviewPrQueryable, trusted: TrustedComposedTaskLedgerContext,
    plan: ComposedTaskRecord<ComposedTaskPlan>): Promise<ComposedTaskRecord<ComposedTaskOutcome>[]> {
    const rows = (await client.query('SELECT * FROM composed_task_outcomes WHERE attempt_id=$1 ORDER BY task_index',
      [trusted.identity.attemptId])).rows;
    try {
      if (rows.length > plan.payload.tasks.length) throw new Error();
      const outcomes = rows.map(row => {
        const outcome = verifyComposedTaskOutcome(plan, stored<ComposedTaskOutcome>(row), trusted.changedFiles);
        if (row.plan_digest !== plan.digest || row.task_id !== outcome.payload.taskId || row.status !== outcome.payload.status
          || plan.payload.tasks[Number(row.task_index)]?.id !== row.task_id) throw new Error();
        return outcome;
      });
      if (plan.byteLength + outcomes.reduce((sum, outcome) => sum + outcome.byteLength, 0) > MAX_COMPOSED_LEDGER_BYTES) throw new Error();
      return outcomes;
    } catch { throw new ComposedTaskLedgerError('integrity'); }
  }

  /** Internal historical evidence read. No live worker authorization/resume
   * is implied. Missing is null, NEVER an empty successful/completed review. */
  async readRetained(context: TrustedComposedTaskLedgerContext): Promise<RetainedComposedTasks | null> {
    const trusted = validateComposedTaskLedgerContext(context);
    return this.transaction(trusted, async client => {
      const plan = await this.plan(client, trusted);
      if (!plan) return null;
      if (canonicalJson(plan.payload.identity) !== canonicalJson(trusted.identity)
        || plan.payload.changedPathsDigest !== sha256(trusted.changedFiles.map(file => file.path))) {
        throw new ComposedTaskLedgerError('identity-mismatch');
      }
      return { plan, outcomes: await this.outcomes(client, trusted, plan) };
    });
  }
}
