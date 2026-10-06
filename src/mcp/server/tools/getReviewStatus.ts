import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  GetReviewStatusInputSchema,
  type GetReviewStatusInput,
  type ReviewCheckRun,
  type ReviewActiveWorker,
  type ReviewActiveProjection,
  type ReviewStatusOutput,
  type ReviewTiming,
} from './schemas';
import {
  isTerminalReviewRunStatus,
  projectReviewExecutionLiveness,
  projectReviewStatusPhase,
  projectReviewStatusVerdict,
  matchesReviewStatusIdentity,
} from '../reviewStatusVerdict';
import { normalizeOperationalTelemetry, type OperationalTelemetry } from '../../../review/workerCompletion';
import {
  awaitOperatorPassthroughOperation,
  operatorPassthroughOperationExpired,
  operatorPassthroughOperationRemainingMs,
  operatorPassthroughReadyForShip,
  OperatorPassthroughOperationDeadlineExceededError,
  withOperatorPassthroughReceiptBudget,
  type OperatorPassthroughOperationScope,
} from '../../../review/operatorPassthrough';
import { REVIEW_DISPATCH_OUTBOX_STATUS } from '../../../persistence/reviewDispatchStatus';
import { authoritativeRepositoryForName, expectedReviewAppIdFor } from '../../../auth/repositoryReviewAuthority';
import { isPausedAuthorityReadUnavailable } from '../../../github/authoritativeReadFailure';
import type { AuthoritativeReviewAdmission } from '../../../review/authoritativeServiceContracts';
import { AuthoritativeCandidateChangedError } from '../../../review/authoritativePublishingResolver';

export interface ReviewStatusDbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
  connect?: () => Promise<ReviewStatusDbConnection>;
}

export interface ReviewStatusDbConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
  release(error?: Error): void;
}

/** A pause-only bounded read. Pool clients get a real read-only transaction and
 * server statement deadline; timeout destroys only that checked-out client. */
async function queryOperatorPassthroughStatus(db: ReviewStatusDbClient, sql: string, values: unknown[]): Promise<{ rows: any[] }> {
  return withOperatorPassthroughReceiptBudget(async (scope: OperatorPassthroughOperationScope) => {
    if (!db.connect) return awaitOperatorPassthroughOperation(() => db.query(sql, values), scope);
    let connecting: Promise<ReviewStatusDbConnection> | undefined;
    let client: ReviewStatusDbConnection;
    try {
      client = await awaitOperatorPassthroughOperation(() => {
        connecting = db.connect!();
        return connecting;
      }, scope);
    } catch (error) {
      if (connecting) {
        void connecting.then((lateClient) => lateClient.release(new Error('Operator pause status receipt deadline expired')),
          () => undefined);
      }
      throw error;
    }
    let releaseError: Error | undefined;
    try {
      await awaitOperatorPassthroughOperation(() => client.query('BEGIN READ ONLY'), scope);
      const statementTimeout = Math.max(1, Math.floor(operatorPassthroughOperationRemainingMs(scope)));
      await awaitOperatorPassthroughOperation(
        () => client.query(`SET LOCAL statement_timeout = '${statementTimeout}ms'`), scope);
      const lockTimeout = Math.max(1, Math.min(5_000, Math.floor(operatorPassthroughOperationRemainingMs(scope))));
      await awaitOperatorPassthroughOperation(
        () => client.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`), scope);
      const result = await awaitOperatorPassthroughOperation(() => client.query(sql, values), scope);
      await awaitOperatorPassthroughOperation(() => client.query('COMMIT'), scope);
      return result;
    } catch (error) {
      if (operatorPassthroughOperationExpired(scope)
        || error instanceof OperatorPassthroughOperationDeadlineExceededError) {
        // node-postgres client.release(error) discards this connection, stopping
        // a late server query without changing the shared pool or other users.
        releaseError = new Error('Operator pause status receipt deadline expired');
      } else {
        try {
          await awaitOperatorPassthroughOperation(() => client.query('ROLLBACK'), scope);
        } catch {
          releaseError = new Error('Operator pause status read could not be rolled back');
        }
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  });
}

const OPERATOR_PASSTHROUGH_STATUS_COLUMNS = `publication_id,owner,repo,pr_number,head_sha,base_sha,policy_digest,expected_app_id,
  audit_digest,review_check_id,review_creation_state,gate_check_id,gate_creation_state,
  retirement_requested_at,retired_at`;

/**
 * `review_runs`-native timing columns, shared by every query branch.
 *
 * This exists so a timing column cannot be added to one branch and forgotten in
 * another: the branches differ only in their predicate and ordering, and all
 * four SELECT lists interpolate this one constant. (A per-branch copy is exactly
 * how this class of omission ships.)
 */
const REVIEW_RUN_TIMING_COLUMNS = `
                   r.received_at, r.burst_started_at, r.cancel_requested_at,
                   r.cancel_propagated_at, r.terminal_deadline`;

/**
 * Durable execution markers for the selected attempt, not every retry of a run.
 *
 * `review_runs` has no started_at/completed_at column -- verified against the
 * live production schema. Execution start and finish are recorded only as
 * `review.lifecycle.*` rows in `review_event_outbox`, each with `occurred_at`.
 * This read is deliberately independent of the branches above so it cannot go
 * missing when one branch is edited.
 */
const LIFECYCLE_MARKER_SQL = `
  SELECT event_kind, MIN(occurred_at) AS occurred_at
    FROM review_event_outbox
   WHERE run_id = $1 AND event_kind = ANY($2::text[])
     AND (($3::text IS NOT NULL AND payload->>'attempt_id' = $3)
       OR ($3::text IS NULL AND payload->>'attempt_id' IS NULL
           AND occurred_at >= $4::timestamptz))
   GROUP BY event_kind
`;

const LIFECYCLE_MARKER_KINDS = [
  'review.lifecycle.dispatched',
  'review.lifecycle.started',
  'review.lifecycle.terminal',
];

const DISPATCH_PROJECTION_SQL = `
  SELECT status AS dispatch_status, projection_name, updated_at AS dispatch_updated_at
    FROM review_dispatch_outbox
   WHERE run_id = $1
`;

interface DispatchProjection {
  dispatch_status: unknown;
  projection_name: unknown;
  dispatch_updated_at: unknown;
}

/**
 * Statuses in which a run has genuinely terminated. Deliberately an allowlist:
 * an unrecognised future status is treated as NOT terminal, so the conservative
 * failure mode is a null duration rather than an invented one.
 */
function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Seconds between two durable instants, or null if either end is missing. */
function secondsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const delta = (end - start) / 1000;
  return delta >= 0 ? delta : null;
}

export function buildReviewTiming(
  row: any,
  markers: Map<string, string>,
  runStatus: unknown,
): ReviewTiming {
  const receivedAt = isoOrNull(row.received_at);
  const createdAt = isoOrNull(row.created_at);
  const dispatchedAt = markers.get('review.lifecycle.dispatched') ?? null;
  const startedAt = markers.get('review.lifecycle.started') ?? null;
  const terminalMarker = markers.get('review.lifecycle.terminal') ?? null;

  const runIsTerminal = isTerminalReviewRunStatus(runStatus);

  // completed_at is populated ONLY for a genuinely terminal run. This is the
  // load-bearing guard: a still-running review reports null rather than a
  // count-up to "now", and a partial span (some sub-step done, the rest still
  // running) is never published as a final duration. The durable terminal
  // marker is preferred; the terminal updated_at write is the fallback.
  const completedAt = runIsTerminal ? (terminalMarker ?? isoOrNull(row.updated_at)) : null;

  // The queue span ends at the durable control-plane start/projection (or
  // dispatch claim). Actual worker scheduling may happen later.
  const claimedAt = startedAt ?? dispatchedAt;

  return {
    basis: 'control_plane_lifecycle',
    received_at: receivedAt,
    created_at: createdAt,
    burst_started_at: isoOrNull(row.burst_started_at),
    dispatched_at: dispatchedAt,
    started_at: startedAt,
    completed_at: completedAt,
    cancel_requested_at: isoOrNull(row.cancel_requested_at),
    cancel_propagated_at: isoOrNull(row.cancel_propagated_at),
    terminal_deadline: isoOrNull(row.terminal_deadline),
    // Prefer the receipt; created_at is the same instant for ~97% of rows.
    queue_seconds: secondsBetween(receivedAt ?? createdAt, claimedAt),
    // Requires BOTH a durable start and a terminal instant, so an unfinished
    // run -- or one with no start marker at all -- yields null.
    execution_seconds: secondsBetween(startedAt, completedAt),
  };
}

async function readLifecycleMarkers(
  db: ReviewStatusDbClient,
  runId: unknown,
  attemptId: unknown,
  receivedAt: unknown,
): Promise<Map<string, string>> {
  const markers = new Map<string, string>();
  if (typeof runId !== 'string' || runId.length === 0) return markers;
  try {
    // Legacy events without identity are usable only within this receipt's
    // window. Never fall back to another identified attempt's timestamps.
    const result = await db.query(LIFECYCLE_MARKER_SQL, [
      runId, LIFECYCLE_MARKER_KINDS,
      typeof attemptId === 'string' && attemptId.length > 0 ? attemptId : null,
      isoOrNull(receivedAt),
    ]);
    for (const row of result?.rows ?? []) {
      const occurredAt = isoOrNull(row.occurred_at);
      if (typeof row.event_kind === 'string' && occurredAt) markers.set(row.event_kind, occurredAt);
    }
  } catch {
    // The marker ledger is an enrichment, not the status answer. A deployment
    // without review_event_outbox still returns the run itself; every timing
    // duration then resolves to null rather than a fabricated value.
  }
  return markers;
}

async function readDispatchProjection(
  db: ReviewStatusDbClient,
  runId: unknown,
): Promise<DispatchProjection | null> {
  if (typeof runId !== 'string' || runId.length === 0) return null;
  try {
    return (await db.query(DISPATCH_PROJECTION_SQL, [runId])).rows[0] ?? null;
  } catch {
    // Older or partial schemas may not have the durable dispatch outbox. The
    // review row and lifecycle ledger still produce a conservative answer.
    return null;
  }
}

/** Narrow authenticated-failure enrichment. Never select raw diagnostics or provider text. */
async function readOperationalTelemetry(db: ReviewStatusDbClient, row: any): Promise<OperationalTelemetry | undefined> {
  if(row.run_status!=='failed'||typeof row.run_id!=='string'||typeof row.attempt_id!=='string'
    ||typeof row.head_sha!=='string'||! /^[a-f0-9]{40}$/i.test(row.head_sha))return undefined;
  try {
    const result=await db.query(`
      SELECT r.failure_diagnostics->'operationalTelemetry' AS operational_telemetry
        FROM review_runs r JOIN review_gate_attempts g ON g.run_id=r.run_id
        JOIN review_dispatch_outbox o ON o.run_id=r.run_id
        JOIN review_worker_completions w ON w.run_id=r.run_id AND w.execution_attempt=g.execution_attempt
       WHERE r.run_id=$1 AND r.head_sha=$2 AND r.status='failed'
         AND g.attempt_id=$3 AND g.current_attempt=true
         AND g.review_generation=r.attempt AND g.execution_attempt=o.execution_attempt+1
         AND g.coordinates->>'headSha'=r.head_sha AND g.coordinates->>'baseSha'=r.base_sha
         AND g.coordinates->>'policyDigest'=r.effective_policy_digest
         AND w.payload->>'configDigest'=r.effective_config_digest
         AND g.worker_result_digest IS NOT NULL AND g.worker_result_digest=r.result_digest
         AND w.content_digest=g.worker_result_digest
         AND r.failure_diagnostics->>'executionAttempt'=g.execution_attempt::text
         AND r.failure_diagnostics->>'failureClass' IS NOT NULL
       LIMIT 1
    `,[row.run_id,row.head_sha,row.attempt_id]);
    return normalizeOperationalTelemetry(result.rows[0]?.operational_telemetry);
  } catch { return undefined; }
}

export const getReviewStatusDefinition: ToolDefinition = {
  name: 'get_review_status',
  description: 'Retrieve versioned ReviewStatus.v2 status, verdict, phase, exact check-runs, and worker identity from durable control-plane records and current candidate authority.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (e.g. exampleorg)' },
      repo: { type: 'string', description: 'Repository name (e.g. example-api)' },
      pull_number: { type: 'number', description: 'Pull request number' },
      head_sha: { type: 'string', description: 'Optional commit SHA' },
    },
    required: ['owner', 'repo', 'pull_number'],
    additionalProperties: false,
  },
};

export interface GetReviewStatusOptions {
  passthroughEnabled?: boolean;
  /** False until the dispatcher has completed its storage schema bootstrap. */
  storageInitialized?: () => boolean;
  authoritativePublishing?: Pick<AuthoritativeReviewAdmission,
    'expectedAppId' | 'expectedAppIdFor' | 'repositoryIds' | 'repositoryIdentities' | 'resolver'>;
  resolveGitHubPullRequest?: (owner: string, repo: string, pullNumber: number) => Promise<{
    headSha: string; baseSha?: string; repositoryId?: number;
  }>;
}

interface ResolvedPauseCandidateBase {
  repositoryId: number;
  owner: string;
  repo: string;
  prNumber: number;
  requestedHeadPrefix: string | null;
}
type ResolvedPauseCandidate = ResolvedPauseCandidateBase & (
  { authorityAvailable: true; current: true; headSha: string; baseSha: string; policyDigest: string; expectedAppId: number }
  | { authorityAvailable: true; current: false; headSha: string; baseSha: string; policyDigest: null; expectedAppId: number }
  | { authorityAvailable: false; current: false; headSha: null; baseSha: null; policyDigest: null; expectedAppId: null }
);

async function resolveOperatorPauseCandidate(input: GetReviewStatusInput,
  options: GetReviewStatusOptions): Promise<ResolvedPauseCandidate> {
  const admission = options.authoritativePublishing;
  if (!admission) {
    throw new Error('Operator SHIP status requires current authoritative candidate resolution');
  }
  const mappedIdentity = authoritativeRepositoryForName(admission, input.owner, input.repo);
  if (!mappedIdentity) {
    throw new Error('Operator SHIP status requires an enrolled local repository identity mapping');
  }
  if (typeof admission.resolver.readCurrentCandidate !== 'function') {
    throw new Error('Operator SHIP status requires the authoritative current-candidate reader');
  }
  if (options.storageInitialized?.() === false) {
    return { authorityAvailable: false, current: false, repositoryId: mappedIdentity.repositoryId,
      owner: mappedIdentity.owner, repo: mappedIdentity.repo, prNumber: input.pull_number,
      headSha: null, baseSha: null, requestedHeadPrefix: input.head_sha?.toLowerCase() ?? null,
      policyDigest: null, expectedAppId: null };
  }
  let snapshot: { repositoryId?: number; owner?: string; repo?: string; prNumber?: number; headSha: string; baseSha?: string };
  try {
    snapshot = await admission.resolver.readCurrentCandidate({ ...mappedIdentity, prNumber: input.pull_number });
  } catch (error) {
    if (isPausedAuthorityReadUnavailable(error)) {
      return { authorityAvailable: false, current: false, repositoryId: mappedIdentity.repositoryId,
        owner: mappedIdentity.owner, repo: mappedIdentity.repo, prNumber: input.pull_number,
        headSha: null, baseSha: null, requestedHeadPrefix: input.head_sha?.toLowerCase() ?? null,
        policyDigest: null, expectedAppId: null };
    }
    throw error;
  }
  if (!Number.isSafeInteger(snapshot.repositoryId) || Number(snapshot.repositoryId) <= 0
    || typeof snapshot.headSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(snapshot.headSha)
    || typeof snapshot.baseSha !== 'string' || !/^[a-f0-9]{40}$/iu.test(snapshot.baseSha)) {
    throw new Error('Current pull request identity is unavailable');
  }
  if (mappedIdentity && (snapshot.repositoryId !== mappedIdentity.repositoryId
    || snapshot.owner !== mappedIdentity.owner || snapshot.repo !== mappedIdentity.repo
    || snapshot.prNumber !== input.pull_number)) {
    throw new Error('Current pull request identity conflicts with local repository enrollment');
  }
  const headSha = snapshot.headSha.toLowerCase();
  const baseSha = snapshot.baseSha.toLowerCase();
  const repositoryId = Number(snapshot.repositoryId);
  if (!admission.repositoryIds.includes(repositoryId)) {
    throw new Error('Operator SHIP status is outside authoritative repository admission');
  }
  const requested = { repositoryId, owner: mappedIdentity?.owner ?? input.owner, repo: mappedIdentity?.repo ?? input.repo,
    prNumber: input.pull_number, headSha, baseSha };
  const expectedAppId = expectedReviewAppIdFor(admission, requested);
  const result: ResolvedPauseCandidate = { ...requested, requestedHeadPrefix: input.head_sha?.toLowerCase() ?? null,
    policyDigest: null, expectedAppId, current: false, authorityAvailable: true };
  if (input.head_sha && !headSha.startsWith(input.head_sha.toLowerCase())) return result;
  try {
    const resolved = await admission.resolver.resolve(requested);
    const policyDigest = resolved.prepared.policy.effectivePolicyDigest;
    if (resolved.current.headSha !== headSha || resolved.current.baseSha !== baseSha) {
      throw new AuthoritativeCandidateChangedError();
    }
    if (typeof policyDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(policyDigest)) {
      throw new Error('Current policy identity is unavailable');
    }
    return { ...result, policyDigest, current: true, authorityAvailable: true };
  } catch (error) {
    if (error instanceof AuthoritativeCandidateChangedError) return result;
    if (isPausedAuthorityReadUnavailable(error)) {
      return { authorityAvailable: false, current: false, repositoryId, owner: input.owner,
        repo: input.repo, prNumber: input.pull_number, headSha: null, baseSha: null,
        requestedHeadPrefix: input.head_sha?.toLowerCase() ?? null, policyDigest: null, expectedAppId: null };
    }
    throw error;
  }
}

function validateOperatorPublicationRow(row: any, input: GetReviewStatusInput,
  candidate: ResolvedPauseCandidate): boolean {
  return row?.owner === input.owner && row?.repo === input.repo
    && Number(row?.pr_number) === input.pull_number
    && typeof row?.publication_id === 'string' && /^[a-f0-9]{64}$/u.test(row.publication_id)
    && typeof row?.audit_digest === 'string' && /^[a-f0-9]{64}$/u.test(row.audit_digest)
    && typeof row?.head_sha === 'string' && /^[a-f0-9]{40}$/u.test(row.head_sha)
    && typeof row?.base_sha === 'string' && /^[a-f0-9]{40}$/u.test(row.base_sha)
    && typeof row?.policy_digest === 'string' && /^[a-f0-9]{64}$/u.test(row.policy_digest)
    && Number.isSafeInteger(Number(row?.expected_app_id)) && Number(row.expected_app_id) > 0
    && row.head_sha === candidate.headSha && row.base_sha === candidate.baseSha
    && row.policy_digest === candidate.policyDigest && Number(row.expected_app_id) === candidate.expectedAppId
    && (row?.review_check_id == null || Number.isSafeInteger(Number(row.review_check_id)) && Number(row.review_check_id) > 0)
    && (row?.gate_check_id == null || Number.isSafeInteger(Number(row.gate_check_id)) && Number(row.gate_check_id) > 0)
    && (row?.review_creation_state === 'bound' || row?.review_creation_state === 'creating'
      || row?.review_creation_state === 'reserved' || row?.review_creation_state === 'not-created')
    && (row?.gate_creation_state === 'bound' || row?.gate_creation_state === 'creating'
      || row?.gate_creation_state === 'reserved' || row?.gate_creation_state === 'not-created')
    && row?.retirement_requested_at == null && row?.retired_at == null;
}

function historicalUnavailableStatus(candidate: ResolvedPauseCandidate, message: string): ToolResult {
  return buildToolResultJson({ schema_version: 'ReviewStatus.v2', found: false, verdict: 'PENDING',
    attempt_id: null, head_sha: candidate.requestedHeadPrefix ?? candidate.headSha, phase: 'unknown',
    check_run: null, active_worker: null, active_projection: null, message } satisfies ReviewStatusOutput);
}

function validateHistoricalOperatorPublicationRow(row: any, input: GetReviewStatusInput,
  candidate: ResolvedPauseCandidate): boolean {
  const requestedHead = candidate.requestedHeadPrefix ?? candidate.headSha;
  return row?.owner === input.owner && row?.repo === input.repo
    && Number(row?.pr_number) === input.pull_number
    && typeof row?.publication_id === 'string' && /^[a-f0-9]{64}$/u.test(row.publication_id)
    && typeof row?.audit_digest === 'string' && /^[a-f0-9]{64}$/u.test(row.audit_digest)
    && typeof row?.head_sha === 'string' && /^[a-f0-9]{40}$/u.test(row.head_sha)
    && row.head_sha.startsWith(requestedHead)
    && typeof row?.base_sha === 'string' && /^[a-f0-9]{40}$/u.test(row.base_sha)
    && typeof row?.policy_digest === 'string' && /^[a-f0-9]{64}$/u.test(row.policy_digest)
    && Number(row?.expected_app_id) === candidate.expectedAppId
    && (row?.review_check_id == null || Number.isSafeInteger(Number(row.review_check_id)) && Number(row.review_check_id) > 0)
    && (row?.gate_check_id == null || Number.isSafeInteger(Number(row.gate_check_id)) && Number(row.gate_check_id) > 0)
    && (row?.review_creation_state === 'bound' || row?.review_creation_state === 'creating'
      || row?.review_creation_state === 'reserved' || row?.review_creation_state === 'not-created')
    && (row?.gate_creation_state === 'bound' || row?.gate_creation_state === 'creating'
      || row?.gate_creation_state === 'reserved' || row?.gate_creation_state === 'not-created')
    && row?.retirement_requested_at == null && row?.retired_at == null;
}

async function historicalOperatorPassthroughStatus(db: ReviewStatusDbClient | undefined,
  input: GetReviewStatusInput, candidate: ResolvedPauseCandidate): Promise<ToolResult> {
  if (!db) return historicalUnavailableStatus(candidate,
    'This candidate is no longer current; publication history is unavailable and no current SHIP exemption is asserted.');
  const requestedHead = candidate.requestedHeadPrefix ?? candidate.headSha;
  let rows: any[];
  try {
    rows = (await queryOperatorPassthroughStatus(db, `SELECT ${OPERATOR_PASSTHROUGH_STATUS_COLUMNS}
      FROM review_operator_passthrough_publications
      WHERE owner=$1 AND repo=$2 AND pr_number=$3 AND retirement_requested_at IS NULL AND retired_at IS NULL
        AND head_sha LIKE ($4 || '%')
      ORDER BY publication_sequence DESC,created_at DESC LIMIT 2`,
    [input.owner, input.repo, input.pull_number, requestedHead])).rows;
  } catch {
    return historicalUnavailableStatus(candidate,
      'This candidate is no longer current; publication history could not be read and no current SHIP exemption is asserted.');
  }
  if (rows.length === 0 || rows.length > 1 && rows[0].head_sha !== rows[1].head_sha
    || !validateHistoricalOperatorPublicationRow(rows[0], input, candidate)) {
    return historicalUnavailableStatus(candidate,
      'This candidate is no longer current; no unambiguous durable pause receipt is available, so no current SHIP exemption is asserted.');
  }
  const row = rows[0];
  const published = operatorPassthroughReadyForShip({ reviewCreationState: row.review_creation_state,
    reviewCheckId: row.review_check_id, gateCreationState: row.gate_creation_state,
    gateCheckId: row.gate_check_id, retirementRequestedAt: row.retirement_requested_at, retiredAt: row.retired_at });
  const gateCheckId = row.gate_check_id == null ? null : Number(row.gate_check_id);
  return buildToolResultJson({ schema_version: 'ReviewStatus.v2', found: true, verdict: 'SHIP', attempt_id: null,
    head_sha: row.head_sha, phase: 'completed', check_run: gateCheckId === null ? null : {
      id: gateCheckId, url: `https://github.com/${input.owner}/${input.repo}/runs/${gateCheckId}`,
      conclusion: published ? 'success' : null,
    }, active_worker: null, active_projection: null,
    operator_exemption: { candidate_state: 'historical', publication_id: row.publication_id, audit_digest: row.audit_digest,
      base_sha: row.base_sha, policy_digest: row.policy_digest, expected_app_id: Number(row.expected_app_id),
      expected_lanes: 0, completed_lanes: 0, review_started: false,
      publication_state: published ? 'published' : 'pending', publication_receipt_available: true,
      review_check_id: row.review_check_id == null ? null : Number(row.review_check_id),
      gate_check_id: gateCheckId, merge_eligible: false },
    message: published
      ? 'This historical candidate has a durable zero-lane SHIP receipt and successful official checks; it is not eligible for the current merge.'
      : 'This historical candidate has a durable zero-lane SHIP receipt; official check publication is pending and it is not eligible for the current merge.',
  } satisfies ReviewStatusOutput);
}

function unavailableOperatorStatus(candidate: ResolvedPauseCandidate & { current: true },
  publicationReceiptAvailable: boolean | null): ToolResult {
  const receiptText = publicationReceiptAvailable === true
    ? 'A durable publication receipt exists and can be retried by the service.'
    : publicationReceiptAvailable === false
      ? 'No active durable publication receipt is available for retry.'
      : 'Durable publication receipt availability could not be confirmed.';
  return buildToolResultJson({
    schema_version: 'ReviewStatus.v2', found: true, verdict: 'SHIP', attempt_id: null,
    head_sha: candidate.headSha, phase: 'completed', check_run: null, active_worker: null,
    active_projection: null,
    operator_exemption: { candidate_state: 'current', publication_id: null, audit_digest: null, base_sha: candidate.baseSha,
      policy_digest: candidate.policyDigest, expected_app_id: candidate.expectedAppId,
      expected_lanes: 0, completed_lanes: 0, review_started: false,
      publication_state: 'unavailable', publication_receipt_available: publicationReceiptAvailable,
      review_check_id: null, gate_check_id: null, merge_eligible: false },
    message: `Operator pause authorizes SHIP with zero review lanes. Official check publication is unavailable. ${receiptText} Protected merge eligibility is false.`,
  } satisfies ReviewStatusOutput);
}

function unavailableCandidateOperatorStatus(candidate: ResolvedPauseCandidate & { authorityAvailable: false }): ToolResult {
  return buildToolResultJson({
    schema_version: 'ReviewStatus.v2', found: true, verdict: 'SHIP', attempt_id: null,
    head_sha: null, phase: 'completed', check_run: null, active_worker: null, active_projection: null,
    operator_exemption: { candidate_state: 'unavailable', publication_id: null, audit_digest: null,
      base_sha: null, policy_digest: null, expected_app_id: null,
      expected_lanes: 0, completed_lanes: 0, review_started: false,
      publication_state: 'unavailable', publication_receipt_available: null,
      review_check_id: null, gate_check_id: null, merge_eligible: false },
    message: `Operator pause preserves logical SHIP with zero review lanes. Current candidate and policy authority could not be confirmed; no current coordinates or durable publication receipt are asserted. Protected merge eligibility is false.`,
  } satisfies ReviewStatusOutput);
}

async function operatorPassthroughStatus(db: ReviewStatusDbClient | undefined, input: GetReviewStatusInput,
  candidate: ResolvedPauseCandidate & { current: true }): Promise<ToolResult> {
  if (!db) return unavailableOperatorStatus(candidate, null);
  let result: { rows: any[] };
  try {
    const resultSet = await queryOperatorPassthroughStatus(db, `SELECT ${OPERATOR_PASSTHROUGH_STATUS_COLUMNS}
        FROM review_operator_passthrough_publications
        WHERE owner=$1 AND repo=$2 AND pr_number=$3 AND retirement_requested_at IS NULL AND retired_at IS NULL
          AND head_sha=$4
        ORDER BY publication_sequence DESC,created_at DESC LIMIT 1`,
      [input.owner, input.repo, input.pull_number, candidate.headSha]);
    result = resultSet;
  } catch {
    return unavailableOperatorStatus(candidate, null);
  }
  const row = result.rows[0];
  if (!row) return unavailableOperatorStatus(candidate, false);
  if (!validateOperatorPublicationRow(row, input, candidate)) return unavailableOperatorStatus(candidate, null);
  const mergeEligible = operatorPassthroughReadyForShip({
    reviewCreationState: row.review_creation_state,
    reviewCheckId: row.review_check_id,
    gateCreationState: row.gate_creation_state,
    gateCheckId: row.gate_check_id,
    retirementRequestedAt: row.retirement_requested_at,
    retiredAt: row.retired_at,
  });
  const gateCheckId = row.gate_check_id == null ? null : Number(row.gate_check_id);
  const reviewCheckId = row.review_check_id == null ? null : Number(row.review_check_id);
  return buildToolResultJson({
    schema_version: 'ReviewStatus.v2', found: true, verdict: 'SHIP', attempt_id: null,
    head_sha: row.head_sha, phase: 'completed',
    check_run: gateCheckId === null ? null : {
      id: gateCheckId, url: `https://github.com/${input.owner}/${input.repo}/runs/${gateCheckId}`,
      conclusion: mergeEligible ? 'success' : null,
    },
    active_worker: null, active_projection: null,
    operator_exemption: {
      candidate_state: 'current',
      publication_id: row.publication_id, audit_digest: row.audit_digest,
      base_sha: row.base_sha, policy_digest: row.policy_digest, expected_app_id: Number(row.expected_app_id),
      expected_lanes: 0, completed_lanes: 0, review_started: false,
      publication_state: mergeEligible ? 'published' : 'pending',
      publication_receipt_available: true,
      review_check_id: reviewCheckId, gate_check_id: gateCheckId, merge_eligible: mergeEligible,
    },
    message: mergeEligible
      ? 'Operator pause is enabled; this exact candidate has an auditable SHIP exemption and both official checks succeeded with zero review lanes.'
      : 'Operator pause authorizes SHIP for this exact candidate with zero review lanes; official check publication is still pending and protected merge is not eligible.',
  } satisfies ReviewStatusOutput);
}

export function createGetReviewStatusTool(db?: ReviewStatusDbClient, options: GetReviewStatusOptions = {}) {
  return {
    definition: getReviewStatusDefinition,
    schema: GetReviewStatusInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = GetReviewStatusInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pull_number, head_sha } = parsed.data;

      if (options.passthroughEnabled === true) {
        const candidate = await resolveOperatorPauseCandidate(parsed.data, options);
        if (!candidate.authorityAvailable) return unavailableCandidateOperatorStatus(candidate);
        if (!candidate.current) return historicalOperatorPassthroughStatus(db, parsed.data, candidate);
        return operatorPassthroughStatus(db, parsed.data, candidate);
      }

      if (!db) {
        return buildToolResultJson({
          schema_version: 'ReviewStatus.v2',
          found: false,
          verdict: 'PENDING',
          attempt_id: null,
          head_sha: head_sha ?? null,
          phase: 'unknown',
          check_run: null,
          active_worker: null,
          active_projection: null,
          message: 'Database service is unavailable',
        } satisfies ReviewStatusOutput);
      }

      let result: { rows: any[] };
      try {
        if (head_sha) {
          const sql = `
            SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha, r.status AS run_status,
                   r.stage AS run_stage, r.attempt, r.lease_owner, r.lease_expires_at,
                   r.created_at, r.updated_at, g.attempt_id, g.check_id, g.desired_state,
                   g.decision, g.current_attempt,${REVIEW_RUN_TIMING_COLUMNS}
              FROM review_runs r
              LEFT JOIN review_gate_attempts g ON g.run_id = r.run_id AND g.current_attempt = true
             WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
               AND (r.head_sha = $4 OR r.head_sha LIKE ($4 || '%'))
             ORDER BY r.created_at DESC
             LIMIT 1
          `;
          result = await db.query(sql, [owner, repo, pull_number, head_sha]);
        } else {
          const sql = `
            SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha, r.status AS run_status,
                   r.stage AS run_stage, r.attempt, r.lease_owner, r.lease_expires_at,
                   r.created_at, r.updated_at, g.attempt_id, g.check_id, g.desired_state,
                   g.decision, g.current_attempt,${REVIEW_RUN_TIMING_COLUMNS}
              FROM review_runs r
              LEFT JOIN review_gate_attempts g ON g.run_id = r.run_id AND g.current_attempt = true
             WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
             ORDER BY
               CASE WHEN r.status IN ('queued', 'running', 'publishing') THEN 0
                    WHEN r.status IN ('succeeded', 'complete') THEN 1 ELSE 2 END ASC,
               r.created_at DESC
             LIMIT 1
          `;
          result = await db.query(sql, [owner, repo, pull_number]);
        }
      } catch {
        // Fallback if review_gate_attempts does not exist in schema
        try {
          if (head_sha) {
            const sql = `
              SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha, r.status AS run_status,
                     r.stage AS run_stage, r.attempt, r.lease_owner, r.lease_expires_at,
                     r.created_at, r.updated_at, r.artifacts,${REVIEW_RUN_TIMING_COLUMNS}
                FROM review_runs r
               WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
                 AND (r.head_sha = $4 OR r.head_sha LIKE ($4 || '%'))
               ORDER BY r.created_at DESC
               LIMIT 1
            `;
            result = await db.query(sql, [owner, repo, pull_number, head_sha]);
          } else {
            const sql = `
              SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha, r.status AS run_status,
                     r.stage AS run_stage, r.attempt, r.lease_owner, r.lease_expires_at,
                     r.created_at, r.updated_at, r.artifacts,${REVIEW_RUN_TIMING_COLUMNS}
                FROM review_runs r
               WHERE r.owner = $1 AND r.repo = $2 AND r.pr_number = $3
               ORDER BY
                 CASE WHEN r.status IN ('queued', 'running', 'publishing') THEN 0
                      WHEN r.status IN ('succeeded', 'complete') THEN 1 ELSE 2 END ASC,
                 r.created_at DESC
               LIMIT 1
            `;
            result = await db.query(sql, [owner, repo, pull_number]);
          }
        } catch {
          // Read uncertainty is metadata only: never render database error text
          // or imply a queued/completed review from an unavailable service.
          result = { rows: [] };
        }
      }

      if (!result || !matchesReviewStatusIdentity(result.rows[0], { owner, repo, pullNumber: pull_number, headSha: head_sha })) {
        return buildToolResultJson({
          schema_version: 'ReviewStatus.v2',
          found: false,
          verdict: 'PENDING',
          attempt_id: null,
          head_sha: head_sha ?? null,
          phase: 'unknown',
          check_run: null,
          active_worker: null,
          active_projection: null,
          message: `No review run found for ${owner}/${repo} PR #${pull_number}`,
        } satisfies ReviewStatusOutput);
      }

      const row = result.rows[0];
      const now = Date.now();
      const [markers, projection] = await Promise.all([
        readLifecycleMarkers(db, row.run_id, row.attempt_id, row.received_at ?? row.created_at),
        readDispatchProjection(db, row.run_id),
      ]);
      const terminalDeadline = isoOrNull(row.terminal_deadline);
      const projectionName = typeof projection?.projection_name === 'string'
        ? projection.projection_name.trim() : '';
      const durableExecutionStarted = markers.has('review.lifecycle.started');
      const execution = projectReviewExecutionLiveness({
        runStatus: row.run_status,
        desiredState: row.desired_state,
        hasProjectedWorker: projection?.dispatch_status === REVIEW_DISPATCH_OUTBOX_STATUS.projected
          && projectionName.length > 0,
        durableExecutionStarted,
        terminalDeadlineMs: terminalDeadline === null ? null : Date.parse(terminalDeadline),
        nowMs: now,
      });
      const { effectiveRunStatus, projectionIsCurrent } = execution;

      const phase = projectReviewStatusPhase({
        desiredState: row.desired_state,
        runStatus: effectiveRunStatus,
        runStage: row.run_stage,
      });
      const verdict = projectReviewStatusVerdict({
        decision: row.decision,
        desiredState: row.desired_state,
        runStatus: effectiveRunStatus,
      });

      const attemptId = row.attempt_id || (row.run_id ? `review-attempt-${pull_number}-${row.attempt || 1}` : null);
      const checkId = row.check_id ? Number(row.check_id) : null;
      const checkRun: ReviewCheckRun | null = checkId
        ? {
            id: checkId,
            url: `https://github.com/${owner}/${repo}/runs/${checkId}`,
            conclusion: ['success', 'failure', 'cancelled', 'timed_out'].includes(row.desired_state)
              ? row.desired_state
              : row.run_status === 'succeeded' || row.run_status === 'complete'
              ? 'success'
              : row.run_status === 'failed'
              ? 'failure'
              : null,
          }
        : null;

      const leaseExpires = row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
      const leasedWorker: ReviewActiveWorker | null =
        row.lease_owner && (leaseExpires > now || !row.lease_expires_at)
          ? {
              pod_name: row.lease_owner,
              started_at: new Date(row.updated_at || row.created_at || now).toISOString(),
              lease_expires_at: row.lease_expires_at
                ? new Date(row.lease_expires_at).toISOString()
                : new Date(now + 300_000).toISOString(),
            }
          : null;

      // DOKS releases the short dispatcher lease after it has durably created
      // the PRReviewJob. From that point onward, the projection row is the
      // authoritative execution identity and keeps the projected phase live
      // even though the legacy active_worker field honestly becomes null. The
      // operator records the current worker Job name in PRReviewJob status,
      // but that status is not persisted here and continuation jobs do not use
      // the initial `-worker` suffix. Report only the authoritative projection
      // identity instead of inventing a Job or Pod identity.
      const activeProjection: ReviewActiveProjection | null = projectionIsCurrent
        ? {
            projection_name: projectionName,
            started_at: markers.get('review.lifecycle.started')
              ?? isoOrNull(projection?.dispatch_updated_at)
              ?? isoOrNull(row.updated_at)
              ?? isoOrNull(row.created_at)
              ?? new Date(now).toISOString(),
            // projectReviewExecutionLiveness can mark a projection current
            // only when this parsed deadline is non-null and still in the future.
            terminal_deadline: terminalDeadline!,
          }
        : null;

      // Timing is computed from the row plus its durable lifecycle markers. The
      // marker read is best-effort and never changes the status answer: if the
      // ledger is unavailable, every duration resolves to null.
      const timing = buildReviewTiming(row, markers, row.run_status);
      const operationalTelemetry = await readOperationalTelemetry(db, row);

      return buildToolResultJson({
        schema_version: 'ReviewStatus.v2',
        found: true,
        verdict,
        attempt_id: attemptId,
        head_sha: row.head_sha,
        phase,
        check_run: checkRun,
        active_worker: leasedWorker,
        active_projection: activeProjection,
        timing,
        ...(operationalTelemetry ? {operational_telemetry:operationalTelemetry}:{}),
      } satisfies ReviewStatusOutput);
    },
  };
}
