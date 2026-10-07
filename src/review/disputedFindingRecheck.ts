import { z } from 'zod';
import { canonicalJson, sha256 } from './reviewCore';
import { getReviewFindingId } from './findingIdentity';
import type { ReviewExecutionCheckpoint } from './reviewExecutionCheckpoint';
import { parseWorkerReviewCompletion, workerReviewCompletionDigest } from './workerReviewCompletion';

import { MAX_DISPUTE_RECHECKS_PER_BATCH, MAX_DISPUTE_RECHECK_ARGUMENT_CHARACTERS } from './disputedFindingRecheckLimits';
export { MAX_DISPUTE_RECHECKS_PER_BATCH, MAX_DISPUTE_RECHECKS_PER_REVIEW, MAX_DISPUTE_RECHECK_ARGUMENT_CHARACTERS, MAX_DISPUTE_RECHECK_RESPONSE_BYTES } from './disputedFindingRecheckLimits';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const taskId = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u);

const findingSnapshotSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']),
  path: z.string().min(1).max(4_096),
  line: z.number().int().positive().safe(),
  title: z.string().min(1).max(4_000),
  body: z.string().min(1).max(16_000),
}).strict();

export const disputedFindingRecheckSchema = z.object({
  requestId: z.string().uuid(),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  sourceExecutionAttempt: z.number().int().positive().safe(),
  sourceContentDigest: digest,
  sourcePlanDigest: digest,
  sourceGateAttemptId: z.string().min(1).max(256),
  repositoryId: z.number().int().positive().safe(),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  prNumber: z.number().int().positive().safe(),
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  findingId: z.string().min(1).max(256),
  personaId: taskId,
  taskId,
  finding: findingSnapshotSchema,
  counterArgument: z.string().min(1).max(MAX_DISPUTE_RECHECK_ARGUMENT_CHARACTERS),
  counterArgumentDigest: digest,
  requestDigest: digest,
}).strict();

export type DisputedFindingRecheck = z.infer<typeof disputedFindingRecheckSchema>;
export type DisputedFindingRecheckUnsigned = Omit<DisputedFindingRecheck, 'requestDigest'>;

export interface AuthenticatedDisputeTuple {
  findingFingerprint: string;
  priorFindingEventId: string;
  priorEvidenceDigest: string;
}

/** Service-derived and bound by the containing exact-run lifecycle history load. */
export type AuthenticatedDisputesProjection =
  | { status: 'complete'; disputes: readonly AuthenticatedDisputeTuple[]; paths: readonly string[] }
  | { status: 'unavailable'; disputes: readonly AuthenticatedDisputeTuple[]; paths: readonly string[];
      reason: 'source-unavailable' | 'ambiguous-linkage' | 'history-incomplete' };

export function disputedFindingRecheckDigest(value: DisputedFindingRecheckUnsigned): string {
  return sha256(canonicalJson(value));
}

export function parseDisputedFindingRecheck(value: unknown): DisputedFindingRecheck {
  const parsed = disputedFindingRecheckSchema.parse(value);
  const { requestDigest, ...unsigned } = parsed;
  if (disputedFindingRecheckDigest(unsigned) !== requestDigest) {
    throw new Error('Disputed finding recheck digest mismatch');
  }
  if (sha256(parsed.counterArgument) !== parsed.counterArgumentDigest) {
    throw new Error('Disputed finding counter-argument digest mismatch');
  }
  return parsed;
}

export interface DisputedFindingRecheckRunIdentity {
  run_id: string;
  repository_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  effective_policy_digest: string;
  effective_config_digest: string;
}

interface DisputedFindingRecheckQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

function jsonValue(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function findingSnapshot(finding: any): DisputedFindingRecheck['finding'] {
  return {
    severity: finding.severity,
    path: String(finding.path || finding.file_path || finding.file || ''),
    line: Number(finding.line_end || finding.line || 1),
    title: String(finding.title || ''),
    body: String(finding.body || finding.rationale || ''),
  };
}

/** Validate a persisted request against its immutable completion and published source Gate. */
export function validateDisputedFindingRecheckRow(
  row: any,
  run: DisputedFindingRecheckRunIdentity,
  currentAttempt: number,
): DisputedFindingRecheck {
  const request = parseDisputedFindingRecheck({
    requestId: row.request_id,
    runId: row.run_id,
    sourceExecutionAttempt: Number(row.source_execution_attempt),
    sourceContentDigest: row.source_content_digest,
    sourcePlanDigest: row.source_plan_digest,
    sourceGateAttemptId: row.source_gate_attempt_id,
    repositoryId: Number(row.repository_id),
    owner: row.owner,
    repo: row.repo,
    prNumber: Number(row.pr_number),
    headSha: row.head_sha,
    baseSha: row.base_sha,
    policyDigest: row.policy_digest,
    configDigest: row.config_digest,
    findingId: row.finding_id,
    personaId: row.persona_id,
    taskId: row.task_id,
    finding: jsonValue(row.finding),
    counterArgument: row.counter_argument,
    counterArgumentDigest: row.counter_argument_digest,
    requestDigest: row.request_digest,
  });
  if (request.runId !== String(run.run_id) || request.repositoryId !== Number(run.repository_id)
    || request.owner !== String(run.owner) || request.repo !== String(run.repo)
    || request.prNumber !== Number(run.pr_number) || request.headSha !== String(run.head_sha)
    || request.baseSha !== String(run.base_sha) || request.policyDigest !== String(run.effective_policy_digest)
    || request.configDigest !== String(run.effective_config_digest)
    || request.sourceExecutionAttempt >= currentAttempt
    || Number(row.completion_execution_attempt) !== request.sourceExecutionAttempt
    || row.completion_content_digest !== request.sourceContentDigest
    || row.gate_worker_result_digest !== request.sourceContentDigest
    || String(row.bound_gate_attempt_id) !== request.sourceGateAttemptId
    || row.gate_creation_state !== 'bound' || row.gate_check_id == null
    || !['success', 'failure'].includes(String(row.gate_desired_state))
    || Number(row.gate_published_version) < Number(row.gate_desired_version)) {
    throw new Error('Disputed finding source binding is invalid');
  }
  const completion = parseWorkerReviewCompletion(jsonValue(row.completion_payload));
  if (workerReviewCompletionDigest(completion) !== request.sourceContentDigest
    || completion.runId !== request.runId || completion.executionAttempt !== request.sourceExecutionAttempt
    || completion.repositoryId !== request.repositoryId || completion.owner !== request.owner || completion.repo !== request.repo
    || completion.prNumber !== request.prNumber || completion.headSha !== request.headSha || completion.baseSha !== request.baseSha
    || completion.policyDigest !== request.policyDigest || completion.configDigest !== request.configDigest) {
    throw new Error('Disputed finding source completion is invalid');
  }
  const taskPlan = completion.result.taskPlan;
  if (!taskPlan || sha256(canonicalJson(taskPlan)) !== request.sourcePlanDigest
    || !taskPlan.some((task) => task.id === request.taskId && task.id === request.personaId)) {
    throw new Error('Disputed finding task plan binding is invalid');
  }
  const persona = completion.result.personas.find((candidate) => candidate.id === request.personaId);
  const sourceFinding = persona?.findings.find((finding) => getReviewFindingId(completion.runId, persona.id, finding) === request.findingId);
  if (!sourceFinding || canonicalJson(findingSnapshot(sourceFinding)) !== canonicalJson(request.finding)) {
    throw new Error('Disputed finding is absent from its immutable source completion');
  }
  const coordinates = jsonValue(row.gate_coordinates);
  if (!coordinates || typeof coordinates !== 'object' || coordinates.runId !== completion.runId
    || Number(coordinates.repositoryId) !== completion.repositoryId || coordinates.owner !== completion.owner
    || coordinates.repo !== completion.repo || Number(coordinates.prNumber) !== completion.prNumber
    || coordinates.headSha !== completion.headSha || coordinates.baseSha !== completion.baseSha
    || coordinates.policyDigest !== completion.policyDigest
    || Number(coordinates.executionAttempt) !== completion.executionAttempt
    || coordinates.attemptId !== request.sourceGateAttemptId) {
    throw new Error('Disputed finding Gate binding is invalid');
  }
  return request;
}

/** Load this exact execution attempt's admitted batch, failing closed if any row's source archive or Gate was lost. */
export async function loadValidatedDisputedFindingRechecks(
  queryable: DisputedFindingRecheckQueryable,
  run: DisputedFindingRecheckRunIdentity,
  currentAttempt: number,
): Promise<DisputedFindingRecheck[]> {
  if (!Number.isSafeInteger(currentAttempt) || currentAttempt < 1) {
    throw new Error('Disputed finding target execution is invalid');
  }
  if (currentAttempt === 1) return [];
  const sourceAttempt = currentAttempt - 1;
  const rows = (await queryable.query(`
    SELECT request.*,
           completion.execution_attempt AS completion_execution_attempt,
           completion.content_digest AS completion_content_digest,
           completion.payload AS completion_payload,
           gate.attempt_id AS bound_gate_attempt_id,
           gate.worker_result_digest AS gate_worker_result_digest,
           gate.coordinates AS gate_coordinates,
           gate.creation_state AS gate_creation_state,
           gate.check_id AS gate_check_id,
           gate.desired_state AS gate_desired_state,
           gate.desired_version AS gate_desired_version,
           gate.published_version AS gate_published_version
      FROM review_finding_rechecks request
      LEFT JOIN review_worker_completions completion
        ON completion.run_id = request.run_id
       AND completion.execution_attempt = request.source_execution_attempt
      LEFT JOIN review_gate_attempts gate
        ON gate.attempt_id = request.source_gate_attempt_id
       AND gate.run_id = request.run_id
       AND gate.execution_attempt = request.source_execution_attempt
     WHERE request.run_id = $1 AND request.source_execution_attempt = $2
     ORDER BY request.source_execution_attempt, request.created_at, request.request_id
     LIMIT ${MAX_DISPUTE_RECHECKS_PER_BATCH + 1}`, [run.run_id, sourceAttempt])).rows;
  if (rows.length > MAX_DISPUTE_RECHECKS_PER_BATCH) {
    throw new Error('Disputed finding re-review batch exceeds its response bound');
  }
  const requests = rows.map((row) => validateDisputedFindingRecheckRow(row, run, currentAttempt));

  // The admission table is a mutable projection used by dispatch. Do not let a
  // lost projection make a still-admitted request disappear from the Gate's
  // view. Reconcile this exact N-1 -> N batch with the request and target
  // lifecycle events, the source/target reservations, and the Gate reserved by
  // that projection. This intentionally does not count requests from older
  // batches in the same run.
  const admissionRows = (await queryable.query(`SELECT admission.*,
        gate.review_generation AS target_gate_generation,
        gate.execution_attempt AS target_gate_execution_attempt,
        gate.repository_id AS target_gate_repository_id,
        gate.pr_number AS target_gate_pr_number,
        gate.coordinates AS target_gate_coordinates,
        gate.expected_app_id AS target_gate_expected_app_id,
        gate.current_attempt AS target_gate_current_attempt,
        runs.attempt AS current_generation,
        runs.authoritative_gate_app_id
      FROM review_finding_recheck_admissions admission
      LEFT JOIN review_gate_attempts gate
        ON gate.attempt_id = admission.gate_attempt_id AND gate.run_id = admission.run_id
      LEFT JOIN review_runs runs ON runs.run_id = admission.run_id
      WHERE admission.run_id = $1 AND admission.source_execution_attempt = $2`, [run.run_id, sourceAttempt])).rows;
  const lifecycleEvents = (await queryable.query(`SELECT event_id, lifecycle_id, reservation_id, idempotency_key, event_type, run_id, execution_attempt,
        repository_id, pr_number, head_sha, base_sha, policy_digest, config_digest, context_digest,
        evidence_digest, actor_digest, payload
      FROM review_pr_lifecycle_events
      WHERE run_id = $1 AND (
        (event_type = 'finding.recheck_requested' AND execution_attempt = $2)
        OR (event_type = 'finding.recheck_target_admitted' AND execution_attempt = $3))
      ORDER BY event_type, idempotency_key
      LIMIT ${MAX_DISPUTE_RECHECKS_PER_BATCH * 2 + 2}`, [run.run_id, sourceAttempt, currentAttempt])).rows;
  const reservationRows = (await queryable.query(`SELECT reservation.reservation_id, reservation.lifecycle_id,
        reservation.run_id, reservation.execution_attempt, reservation.status, reservation.completion_digest,
        reservation.decision_receipt, reservation.head_sha, reservation.base_sha,
        reservation.policy_digest, reservation.config_digest, reservation.context_digest,
        lifecycle.repository_id, lifecycle.owner, lifecycle.repo, lifecycle.pr_number
      FROM review_pr_review_reservations reservation
      JOIN review_pr_lifecycles lifecycle USING (lifecycle_id)
      WHERE reservation.run_id = $1 AND reservation.execution_attempt IN ($2, $3)
      ORDER BY reservation.execution_attempt`, [run.run_id, sourceAttempt, currentAttempt])).rows;
  const runRows = (await queryable.query('SELECT snapshot_digest, attempt FROM review_runs WHERE run_id = $1', [run.run_id])).rows;
  if (lifecycleEvents.length >= MAX_DISPUTE_RECHECKS_PER_BATCH * 2 + 2) {
    throw new Error('Disputed finding lifecycle batch exceeds its response bound');
  }
  const sourceEvents = lifecycleEvents.filter((event) => event.event_type === 'finding.recheck_requested');
  const targetEvents = lifecycleEvents.filter((event) => event.event_type === 'finding.recheck_target_admitted');
  const hasBatchEvidence = requests.length > 0 || admissionRows.length > 0 || sourceEvents.length > 0 || targetEvents.length > 0;
  if (!hasBatchEvidence) return [];

  const invalidBatch = (): never => { throw new Error('Disputed finding admitted batch evidence is inconsistent'); };
  if (admissionRows.length !== 1 || requests.length === 0 || targetEvents.length !== requests.length) invalidBatch();
  const admission = admissionRows[0]!;
  if (Number(admission.source_execution_attempt) !== sourceAttempt
    || Number(admission.execution_attempt) !== currentAttempt
    || Number(admission.target_gate_execution_attempt) !== currentAttempt
    || Number(admission.target_gate_generation) !== Number(admission.review_generation)
    || Number(admission.current_generation) !== Number(admission.review_generation)
    || Number(admission.target_gate_repository_id) !== Number(run.repository_id)
    || Number(admission.target_gate_pr_number) !== Number(run.pr_number)
    || admission.target_gate_current_attempt !== true
    || admission.authoritative_gate_app_id == null
    || Number(admission.target_gate_expected_app_id) !== Number(admission.authoritative_gate_app_id)) invalidBatch();
  const trigger = requests.find((request) => request.requestId === admission.trigger_request_id);
  if (!trigger || String(admission.requested_by) !== String((rows.find((row) => row.request_id === trigger.requestId))?.requested_by)) {
    invalidBatch();
  }
  const targetGateCoordinates = jsonValue(admission.target_gate_coordinates);
  if (!targetGateCoordinates || typeof targetGateCoordinates !== 'object'
    || targetGateCoordinates.runId !== run.run_id
    || Number(targetGateCoordinates.repositoryId) !== Number(run.repository_id)
    || targetGateCoordinates.owner !== run.owner || targetGateCoordinates.repo !== run.repo
    || Number(targetGateCoordinates.prNumber) !== Number(run.pr_number)
    || targetGateCoordinates.headSha !== run.head_sha || targetGateCoordinates.baseSha !== run.base_sha
    || targetGateCoordinates.policyDigest !== run.effective_policy_digest
    || Number(targetGateCoordinates.executionAttempt) !== currentAttempt
    || targetGateCoordinates.attemptId !== admission.gate_attempt_id) invalidBatch();

  const runState = runRows[0];
  const sourceReservation = reservationRows.find((reservation) => Number(reservation.execution_attempt) === sourceAttempt);
  const targetReservation = reservationRows.find((reservation) => Number(reservation.execution_attempt) === currentAttempt);
  if (!runState || !targetReservation || targetReservation.status !== 'reserved'
    || targetReservation.completion_digest != null || targetReservation.decision_receipt != null
    || Number(targetReservation.repository_id) !== Number(run.repository_id)
    || targetReservation.owner !== run.owner || targetReservation.repo !== run.repo
    || Number(targetReservation.pr_number) !== Number(run.pr_number)
    || targetReservation.head_sha !== run.head_sha || targetReservation.base_sha !== run.base_sha
    || targetReservation.policy_digest !== run.effective_policy_digest
    || targetReservation.config_digest !== run.effective_config_digest
    || targetReservation.context_digest !== runState.snapshot_digest) invalidBatch();

  const requestById = new Map(requests.map((request) => [request.requestId, request]));
  if (requestById.size !== requests.length) invalidBatch();
  const targetEventIds = new Set<string>();
  for (const event of targetEvents) {
    const payload = jsonValue(event.payload);
    const requestId = String(payload?.requestId ?? '');
    const request = requestById.get(requestId);
    const row = rows.find((candidate) => candidate.request_id === requestId);
    if (!request || !row || targetEventIds.has(requestId)
      || event.idempotency_key !== `${requestId}:recheck-target-admitted`
      || event.reservation_id !== targetReservation.reservation_id
      || event.lifecycle_id !== targetReservation.lifecycle_id
      || Number(event.execution_attempt) !== currentAttempt
      || Number(event.repository_id) !== Number(run.repository_id) || Number(event.pr_number) !== Number(run.pr_number)
      || event.head_sha !== request.headSha || event.base_sha !== request.baseSha
      || event.policy_digest !== request.policyDigest || event.config_digest !== request.configDigest
      || event.context_digest !== runState.snapshot_digest || event.evidence_digest !== request.requestDigest
      || event.actor_digest !== row.requested_by || payload.requestDigest !== request.requestDigest
      || payload.sourceRunId !== run.run_id || Number(payload.sourceExecutionAttempt) !== sourceAttempt
      || payload.sourceCompletionDigest !== request.sourceContentDigest
      || payload.sourceContextDigest !== runState.snapshot_digest
      || Number(payload.targetExecutionAttempt) !== currentAttempt
      || canonicalJson(payload.candidate) !== canonicalJson({ headSha: request.headSha, baseSha: request.baseSha,
        policyDigest: request.policyDigest, configDigest: request.configDigest, contextDigest: runState.snapshot_digest })) {
      invalidBatch();
    }
    targetEventIds.add(requestId);
  }
  if (targetEventIds.size !== requestById.size || !targetEventIds.has(String(admission.trigger_request_id))) invalidBatch();

  const sourceEventIds = new Set<string>();
  if (sourceReservation) {
    if (!['completed', 'failed'].includes(String(sourceReservation.status))
      || sourceReservation.completion_digest !== trigger!.sourceContentDigest
      || sourceReservation.context_digest !== runState.snapshot_digest
      || Number(sourceReservation.repository_id) !== Number(run.repository_id)
      || sourceReservation.owner !== run.owner || sourceReservation.repo !== run.repo
      || Number(sourceReservation.pr_number) !== Number(run.pr_number)
      || sourceReservation.head_sha !== run.head_sha || sourceReservation.base_sha !== run.base_sha
      || sourceReservation.policy_digest !== run.effective_policy_digest
      || sourceReservation.config_digest !== run.effective_config_digest
      || sourceEvents.length !== requests.length) invalidBatch();
    for (const event of sourceEvents) {
      const payload = jsonValue(event.payload);
      const requestId = String(payload?.requestId ?? '');
      const request = requestById.get(requestId);
      const row = rows.find((candidate) => candidate.request_id === requestId);
      if (!request || !row || sourceEventIds.has(requestId)
        || event.idempotency_key !== `${requestId}:recheck-requested`
        || event.reservation_id !== sourceReservation.reservation_id
        || event.lifecycle_id !== sourceReservation.lifecycle_id
        || Number(event.execution_attempt) !== sourceAttempt
        || Number(event.repository_id) !== Number(run.repository_id) || Number(event.pr_number) !== Number(run.pr_number)
        || event.head_sha !== request.headSha || event.base_sha !== request.baseSha
        || event.policy_digest !== request.policyDigest || event.config_digest !== request.configDigest
        || event.context_digest !== runState.snapshot_digest || event.evidence_digest !== request.requestDigest
        || event.actor_digest !== row.requested_by || payload.findingId !== request.findingId
        || payload.sourceContentDigest !== request.sourceContentDigest
        || payload.sourceReservationContextDigest !== sourceReservation.context_digest) invalidBatch();
      sourceEventIds.add(requestId);
    }
    if (sourceEventIds.size !== requestById.size) invalidBatch();
  } else if (sourceEvents.length > 0) {
    invalidBatch();
  }

  return requests;
}

/** A task receipt always refers to its immutable source plan and persona. */
export function disputedFindingTaskPlanMatches(
  recheck: DisputedFindingRecheck, plan: ReviewExecutionCheckpoint['plan'],
): boolean {
  return recheck.sourcePlanDigest === sha256(canonicalJson(plan))
    && plan.some((task) => task.id === recheck.taskId && task.id === recheck.personaId);
}

/** Shared plan/identity binding used before work, checkpoint acknowledgement and final Gate acceptance. */
export function disputedFindingTaskMatchesCheckpoint(
  recheck: DisputedFindingRecheck, checkpoint: ReviewExecutionCheckpoint, currentAttempt: number,
): boolean {
  return recheck.runId === checkpoint.runId && recheck.repositoryId === checkpoint.repositoryId
    && recheck.owner === checkpoint.owner && recheck.repo === checkpoint.repo && recheck.prNumber === checkpoint.prNumber
    && recheck.headSha === checkpoint.headSha && recheck.baseSha === checkpoint.baseSha
    && recheck.policyDigest === checkpoint.policyDigest && recheck.configDigest === checkpoint.configDigest
    && recheck.sourceExecutionAttempt < currentAttempt && checkpoint.executionAttempt <= currentAttempt
    && disputedFindingTaskPlanMatches(recheck, checkpoint.plan);
}

/** Acknowledgement is a task receipt. Gate acceptance additionally verifies fresh worker evidence. */
export function pendingDisputedFindingRechecks(
  rechecks: DisputedFindingRecheck[], checkpoint: ReviewExecutionCheckpoint | null, currentAttempt: number,
): DisputedFindingRecheck[] {
  const satisfied = new Set(checkpoint?.satisfiedFindingRecheckIds ?? []);
  const byId = new Map(rechecks.map((recheck) => [recheck.requestId, recheck]));
  if ([...satisfied].some((requestId) => !byId.has(requestId))) {
    throw new Error('Checkpoint contains an unknown disputed finding receipt');
  }
  if (rechecks.length > 0 && !checkpoint) throw new Error('Disputed finding checkpoint is unavailable');
  if (checkpoint) {
    if (checkpoint.executionAttempt > currentAttempt) throw new Error('Checkpoint belongs to a future execution');
    for (const recheck of rechecks) {
      if (!disputedFindingTaskMatchesCheckpoint(recheck, checkpoint, currentAttempt)) {
        throw new Error('Disputed finding request no longer matches the composed task plan');
      }
      if (satisfied.has(recheck.requestId) && !checkpoint.completedTasks.some((task) => task.id === recheck.taskId)) {
        throw new Error('Satisfied disputed finding receipt has no completed task');
      }
    }
  }
  return rechecks.filter((recheck) => !satisfied.has(recheck.requestId));
}


/** Keep unrelated durable task results, while pending rechecks require fresh target-task work. */
export function remainingCheckpointTasksAfterRechecks(
  completedTasks: ReviewExecutionCheckpoint['completedTasks'], rechecks: DisputedFindingRecheck[],
  plan: ReviewExecutionCheckpoint['plan'],
): ReviewExecutionCheckpoint['completedTasks'] {
  if (rechecks.some((recheck) => !disputedFindingTaskPlanMatches(recheck, plan))) {
    throw new Error('Disputed finding re-review does not match a validated resumed task plan');
  }
  const requestedTaskIds = new Set(rechecks.map((recheck) => recheck.taskId));
  return completedTasks.filter((task) => !requestedTaskIds.has(task.id));
}

/** Invalidate checkpoint lanes touching prior blocker paths, while preserving unrelated lanes. */
export function remainingCheckpointTasksForPaths(
  completedTasks: ReviewExecutionCheckpoint['completedTasks'],
  plan: ReviewExecutionCheckpoint['plan'],
  affectedPaths: readonly string[],
): ReviewExecutionCheckpoint['completedTasks'] {
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//u, '');
  const affected = new Set(affectedPaths.map(normalize));
  if (affected.size === 0) return [...completedTasks];
  const pathsByTask = new Map(plan.map((task) => [task.id, new Set(task.paths.map(normalize))] as const));
  return completedTasks.filter((task) => {
    const taskPaths = pathsByTask.get(task.id);
    return Boolean(taskPaths) && ![...taskPaths!].some((path) => affected.has(path));
  });
}
