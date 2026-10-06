import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  QueryActiveJobsInputSchema,
  type QueryActiveJobsInput,
} from './schemas';

export interface ActiveJobsDbClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export const queryActiveJobsDefinition: ToolDefinition = {
  name: 'query_active_jobs',
  description: 'Query in-flight and active review jobs across the system with duration, worker state, and phase.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner (default: all)' },
      repo: { type: 'string', description: 'Repository name (default: all)' },
      limit: { type: 'number', description: 'Maximum number of active jobs to return (default: 50)' },
    },
    additionalProperties: false,
  },
};

/**
 * review_runs has no verdict column (verdicts live in review_logs / the
 * arbiter result). A run is active until it reaches a terminal status.
 */
export const ACTIVE_REVIEW_RUN_STATUSES = ['queued', 'running', 'publishing'] as const;

export const ACTIVE_JOBS_BASE_SQL = `
          SELECT r.run_id, r.owner, r.repo, r.pr_number, r.head_sha,
                 r.status, r.created_at, r.received_at, r.burst_started_at,
                 r.terminal_deadline
            FROM review_runs r
           WHERE r.status IN ('queued', 'running', 'publishing')
        `;

export function createQueryActiveJobsTool(db?: ActiveJobsDbClient) {
  return {
    definition: queryActiveJobsDefinition,
    schema: QueryActiveJobsInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = QueryActiveJobsInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, limit = 50 } = parsed.data;

      if (!db) {
        return buildToolResultJson({
          active_jobs: [],
          total_count: 0,
          status: 'idle',
        });
      }

      try {
        let sql = ACTIVE_JOBS_BASE_SQL;
        const values: unknown[] = [];
        if (owner) {
          values.push(owner);
          sql += ` AND r.owner = $${values.length}`;
        }
        if (repo) {
          values.push(repo);
          sql += ` AND r.repo = $${values.length}`;
        }
        values.push(limit);
        sql += ` ORDER BY r.created_at DESC LIMIT $${values.length}`;

        const res = await db.query(sql, values);
        const now = Date.now();
        const activeJobs = res.rows.map((row) => {
          const startedAt = row.burst_started_at ? new Date(row.burst_started_at).getTime() : new Date(row.created_at).getTime();
          const durationSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
          return {
            run_id: row.run_id,
            owner: row.owner,
            repo: row.repo,
            pull_number: row.pr_number,
            pr_number: row.pr_number,
            head_sha: row.head_sha,
            status: row.status || 'running',
            created_at: row.created_at,
            duration_seconds: durationSeconds,
            terminal_deadline: row.terminal_deadline,
          };
        });

        return buildToolResultJson({
          active_jobs: activeJobs,
          total_count: activeJobs.length,
          status: activeJobs.length > 0 ? 'busy' : 'idle',
        });
      } catch (err: any) {
        return buildToolResultJson({
          active_jobs: [],
          total_count: 0,
          status: 'idle',
          error: err?.message || 'Failed to query active jobs',
        });
      }
    },
  };
}
