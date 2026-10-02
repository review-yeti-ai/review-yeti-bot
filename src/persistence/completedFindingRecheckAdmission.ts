import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';
import type { DisputedFindingRecheckUnsigned } from '../review/disputedFindingRecheck';
import type { ReviewPrQueryable } from './reviewPrTransaction';
import { PostgresReviewGateRepository } from './reviewGateRepository';

/** Canonical transition shared by source validation and the locked admission update. */
export function completedFindingRecheckCoordinates(sourceExecutionAttempt: number, sourceGeneration: number): {
  executionAttempt: number; generation: number;
} {
  const executionAttempt = sourceExecutionAttempt + 1;
  const generation = sourceGeneration + 1;
  if (!Number.isSafeInteger(sourceExecutionAttempt) || sourceExecutionAttempt < 1
    || !Number.isSafeInteger(executionAttempt) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Invalid completed finding re-review admission');
  }
  return { executionAttempt, generation };
}

/** The caller holds the shared PR lock and has validated the immutable source,
 * current GitHub candidate, trusted policy and authenticated request. A request
 * and its execution admission commit together; neither is a verdict. */
export async function admitCompletedFindingRecheck(
  client: ReviewPrQueryable,
  request: DisputedFindingRecheckUnsigned,
  input: { sourceGeneration: number; expectedAppId: number; actorDigest: string; now: number },
): Promise<void> {
  const { executionAttempt, generation } = completedFindingRecheckCoordinates(request.sourceExecutionAttempt, input.sourceGeneration);
  if (!Number.isSafeInteger(input.now) || !/^[a-f0-9]{64}$/u.test(input.actorDigest)) {
    throw new Error('Invalid completed finding re-review admission');
  }
  const active = (await client.query(`SELECT runs.status, runs.attempt, outbox.status AS outbox_status,
      outbox.execution_attempt, admission.execution_attempt AS admitted_execution_attempt,
      admission.review_generation AS admitted_review_generation
    FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
    LEFT JOIN review_finding_recheck_admissions admission
      ON admission.run_id = runs.run_id AND admission.source_execution_attempt = $2
    WHERE runs.run_id = $1 FOR UPDATE OF runs, outbox`,
  [request.runId, request.sourceExecutionAttempt])).rows[0];
  if (active?.admitted_execution_attempt != null) {
    // Coalesce another task only while the dispatcher cannot have handed the
    // checkpoint to a worker. A repeat of an existing request is handled by the
    // tool before this boundary and does not re-arm a claimed execution.
    if (active.status !== 'queued' || active.outbox_status !== 'pending'
      || Number(active.attempt) !== generation || Number(active.execution_attempt) + 1 !== executionAttempt
      || Number(active.admitted_execution_attempt) !== executionAttempt
      || Number(active.admitted_review_generation) !== generation) {
      throw new Error('The task re-review execution has already started; wait for its fresh completion before requesting another task');
    }
    return;
  }
  const admitted = await client.query(`UPDATE review_runs SET status = 'queued', stage = 'admission',
      attempt = $3, received_at = to_timestamp($4 / 1000.0),
      terminal_deadline = to_timestamp(($4::double precision + $5) / 1000.0), result_digest = NULL,
      error_text = NULL, failure_diagnostics = '{}'::jsonb, publication_fence = NULL,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = to_timestamp($4 / 1000.0)
    WHERE run_id = $1 AND status IN ('succeeded', 'failed') AND attempt = $6
      AND publication_mode = 'app-gate' AND authoritative_gate_app_id = $7
      AND result_digest = $8 AND cancel_requested_at IS NULL
      AND EXISTS (SELECT 1 FROM review_dispatch_outbox outbox WHERE outbox.run_id = $1
        AND outbox.status IN ('projected', 'terminal') AND outbox.execution_attempt + 1 = $2
        AND outbox.cancel_requested_at IS NULL)
    RETURNING run_id`, [request.runId, request.sourceExecutionAttempt, generation, input.now,
    TERMINAL_DEADLINE_MS, input.sourceGeneration, input.expectedAppId, request.sourceContentDigest]);
  if (admitted.rows.length !== 1) throw new Error('Completed review admission no longer matches its accepted source');
  const queued = await client.query(`UPDATE review_dispatch_outbox SET status = 'pending',
      execution_attempt = $2, worker_token_digest = NULL, projection_name = NULL,
      terminal_receipt_digest = NULL, lease_owner = NULL, lease_expires_at = NULL,
      available_at = to_timestamp($3 / 1000.0), updated_at = to_timestamp($3 / 1000.0)
    WHERE run_id = $1 AND status IN ('projected', 'terminal') AND execution_attempt + 1 = $2
      AND cancel_requested_at IS NULL RETURNING run_id`,
  [request.runId, request.sourceExecutionAttempt, input.now]);
  if (queued.rows.length !== 1) throw new Error('Completed review dispatch admission is unavailable');
  // Archive successful as well as failed published source receipts. Reserving
  // a fresh Gate must not rewrite the conclusion of an accepted source Gate.
  const retired = await client.query(`UPDATE review_gate_attempts SET current_attempt = false
    WHERE attempt_id = $1 AND run_id = $2 AND current_attempt
      AND worker_result_digest = $3 AND creation_state = 'bound' AND check_id IS NOT NULL
      AND desired_state IN ('success', 'failure') AND published_version >= desired_version
    RETURNING attempt_id`, [request.sourceGateAttemptId, request.runId, request.sourceContentDigest]);
  if (retired.rows.length !== 1) throw new Error('Published finding source Gate is no longer current');
  const gate = await PostgresReviewGateRepository.reserveInTransaction(client, request.runId, input.expectedAppId, input.now);
  if (!gate || gate.coordinates.executionAttempt !== executionAttempt || gate.reviewGeneration !== generation) {
    throw new Error('Fresh finding re-review Gate reservation is unavailable');
  }
  await client.query(`INSERT INTO review_finding_recheck_admissions
    (run_id, source_execution_attempt, trigger_request_id, execution_attempt, review_generation,
     gate_attempt_id, requested_by, received_at, terminal_deadline)
    VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp(($8::double precision + $9) / 1000.0))`,
  [request.runId, request.sourceExecutionAttempt, request.requestId, executionAttempt, generation,
    gate.coordinates.attemptId, input.actorDigest, input.now, TERMINAL_DEADLINE_MS]);
}
