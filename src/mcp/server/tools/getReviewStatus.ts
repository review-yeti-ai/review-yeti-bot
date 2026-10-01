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
  type ReviewStatusOutput,
  type ReviewTiming,
} from './schemas';
import {
  isTerminalReviewRunStatus,
  projectReviewExecutionLiveness,
  projectReviewStatusPhase,
  projectReviewStatusVerdict,
} from '../reviewStatusVerdict';
import { REVIEW_DISPATCH_OUTBOX_STATUS } from '../../../persistence/reviewDispatchStatus';

export interface ReviewStatusDbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

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

  // The queue wait ends when a worker actually claimed the run: the started
  // marker when present, else the dispatch marker. Null until that happens.
  const claimedAt = startedAt ?? dispatchedAt;

  return {
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

export const getReviewStatusDefinition: ToolDefinition = {
  name: 'get_review_status',
  description: 'Retrieve versioned ReviewStatus.v2 real-time status, verdict, phase, check-runs, and explicit Pod-or-Job worker identity without GitHub scraping.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (e.g. calltelemetry)' },
      repo: { type: 'string', description: 'Repository name (e.g. cisco-cdr)' },
      pull_number: { type: 'number', description: 'Pull request number' },
      head_sha: { type: 'string', description: 'Optional commit SHA' },
    },
    required: ['owner', 'repo', 'pull_number'],
    additionalProperties: false,
  },
};

export function createGetReviewStatusTool(db?: ReviewStatusDbClient) {
  return {
    definition: getReviewStatusDefinition,
    schema: GetReviewStatusInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = GetReviewStatusInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pull_number, head_sha } = parsed.data;

      if (!db) {
        return buildToolResultJson({
          schema_version: 'ReviewStatus.v2',
          found: false,
          verdict: 'PENDING',
          attempt_id: null,
          head_sha: head_sha ?? null,
          phase: 'queued',
          check_run: null,
          active_worker: null,
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
      }

      if (!result || result.rows.length === 0) {
        return buildToolResultJson({
          schema_version: 'ReviewStatus.v2',
          found: false,
          verdict: 'PENDING',
          attempt_id: null,
          head_sha: head_sha ?? null,
          phase: 'queued',
          check_run: null,
          active_worker: null,
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
              identity_kind: 'pod',
              started_at: new Date(row.updated_at || row.created_at || now).toISOString(),
              lease_expires_at: row.lease_expires_at
                ? new Date(row.lease_expires_at).toISOString()
                : new Date(now + 300_000).toISOString(),
            }
          : null;

      // DOKS releases the short dispatcher lease after it has durably created
      // the PRReviewJob. From that point onward, the projection row is the
      // authoritative execution identity; treating the cleared dispatcher
      // lease as "no worker" is what made live reviews look queued. The
      // operator records the current worker Job name in PRReviewJob status,
      // but that status is not persisted here and continuation jobs do not use
      // the initial `-worker` suffix. Report only the authoritative projection
      // identity instead of inventing a Job or Pod identity.
      const projectedWorker: ReviewActiveWorker | null = projectionIsCurrent
        ? {
            identity_kind: 'projection',
            projection_name: projectionName,
            started_at: markers.get('review.lifecycle.started')
              ?? isoOrNull(projection?.dispatch_updated_at)
              ?? isoOrNull(row.updated_at)
              ?? isoOrNull(row.created_at)
              ?? new Date(now).toISOString(),
            // projectReviewExecutionLiveness can mark a projection current
            // only when this parsed deadline is non-null and still in the future.
            lease_expires_at: terminalDeadline!,
          }
        : null;
      const activeWorker = leasedWorker ?? projectedWorker;

      // Timing is computed from the row plus its durable lifecycle markers. The
      // marker read is best-effort and never changes the status answer: if the
      // ledger is unavailable, every duration resolves to null.
      const timing = buildReviewTiming(row, markers, row.run_status);

      return buildToolResultJson({
        schema_version: 'ReviewStatus.v2',
        found: true,
        verdict,
        attempt_id: attemptId,
        head_sha: row.head_sha,
        phase,
        check_run: checkRun,
        active_worker: activeWorker,
        timing,
      } satisfies ReviewStatusOutput);
    },
  };
}
