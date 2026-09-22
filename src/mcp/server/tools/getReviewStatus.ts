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
} from './schemas';

export interface ReviewStatusDbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export const getReviewStatusDefinition: ToolDefinition = {
  name: 'get_review_status',
  description: 'Retrieve real-time review status, verdict, phase, and check-runs without GitHub scraping.',
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
                   g.decision, g.current_attempt
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
                   g.decision, g.current_attempt
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
                   r.created_at, r.updated_at, r.artifacts
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
                   r.created_at, r.updated_at, r.artifacts
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

      // Phase resolution
      let phase: 'queued' | 'evaluating_personas' | 'arbitration' | 'completed' = 'queued';
      if (row.run_status === 'queued') {
        phase = 'queued';
      } else if (row.run_status === 'running' || row.run_status === 'publishing') {
        phase = ['arbitration', 'publish'].includes(row.run_stage) ? 'arbitration' : 'evaluating_personas';
      } else {
        phase = 'completed';
      }

      // Verdict resolution
      let verdict: 'SHIP' | 'NACK' | 'COMMENT' | 'FIX_FIRST' | 'PENDING' | 'RUNNING' | 'FAILED' = 'PENDING';
      let decisionObj: any = null;
      if (typeof row.decision === 'string') {
        try {
          decisionObj = JSON.parse(row.decision);
        } catch {
          decisionObj = null;
        }
      } else if (row.decision && typeof row.decision === 'object') {
        decisionObj = row.decision;
      }

      if (decisionObj?.verdict) {
        const v = String(decisionObj.verdict).toUpperCase();
        if (v === 'SHIP') verdict = 'SHIP';
        else if (v === 'FIX_FIRST') verdict = 'FIX_FIRST';
        else if (v === 'BLOCK') verdict = 'NACK';
        else if (v === 'COMMENT') verdict = 'COMMENT';
        else verdict = 'SHIP';
      } else if (row.desired_state) {
        if (row.desired_state === 'success') verdict = 'SHIP';
        else if (row.desired_state === 'failure') verdict = 'FIX_FIRST';
        else if (['cancelled', 'timed_out'].includes(row.desired_state)) verdict = 'FAILED';
        else if (row.desired_state === 'queued') verdict = 'PENDING';
        else if (row.desired_state === 'in_progress') verdict = 'RUNNING';
      } else {
        if (row.run_status === 'queued') verdict = 'PENDING';
        else if (row.run_status === 'running' || row.run_status === 'publishing') verdict = 'RUNNING';
        else if (row.run_status === 'succeeded' || row.run_status === 'complete') verdict = 'SHIP';
        else verdict = 'FAILED';
      }

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
      const activeWorker: ReviewActiveWorker | null =
        row.lease_owner && (leaseExpires > now || !row.lease_expires_at)
          ? {
              pod_name: row.lease_owner,
              started_at: new Date(row.updated_at || row.created_at || now).toISOString(),
              lease_expires_at: row.lease_expires_at
                ? new Date(row.lease_expires_at).toISOString()
                : new Date(now + 300_000).toISOString(),
            }
          : null;

      return buildToolResultJson({
        found: true,
        verdict,
        attempt_id: attemptId,
        head_sha: row.head_sha,
        phase,
        check_run: checkRun,
        active_worker: activeWorker,
      } satisfies ReviewStatusOutput);
    },
  };
}
