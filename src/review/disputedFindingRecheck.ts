import { z } from 'zod';
import { canonicalJson, sha256 } from './reviewCore';
import { getReviewFindingId } from './findingIdentity';
import type { ReviewExecutionCheckpoint } from './reviewExecutionCheckpoint';
import { parseWorkerReviewCompletion, workerReviewCompletionDigest } from './workerReviewCompletion';

import { MAX_DISPUTE_RECHECKS_PER_REVIEW, MAX_DISPUTE_RECHECK_ARGUMENT_CHARACTERS } from './disputedFindingRecheckLimits';
export { MAX_DISPUTE_RECHECKS_PER_REVIEW, MAX_DISPUTE_RECHECK_ARGUMENT_CHARACTERS, MAX_DISPUTE_RECHECK_RESPONSE_BYTES } from './disputedFindingRecheckLimits';

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

/** Load every persisted request, failing closed if a row's source archive or Gate was lost. */
export async function loadValidatedDisputedFindingRechecks(
  queryable: DisputedFindingRecheckQueryable,
  run: DisputedFindingRecheckRunIdentity,
  currentAttempt: number,
): Promise<DisputedFindingRecheck[]> {
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
     WHERE request.run_id = $1
     ORDER BY request.source_execution_attempt, request.created_at, request.request_id
     LIMIT ${MAX_DISPUTE_RECHECKS_PER_REVIEW + 1}`, [run.run_id])).rows;
  if (rows.length > MAX_DISPUTE_RECHECKS_PER_REVIEW) {
    throw new Error('Too many disputed finding re-review requests');
  }
  return rows.map((row) => validateDisputedFindingRecheckRow(row, run, currentAttempt));
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
