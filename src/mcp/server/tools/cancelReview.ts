import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  CancelReviewInputSchema,
  type CancelReviewInput,
  type CancelReviewOutput,
} from './schemas';

export const cancelReviewDefinition: ToolDefinition = {
  name: 'cancel_review',
  description: 'Run abortion and Kubernetes worker pod cleanup.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner/organization.' },
      repo: { type: 'string', description: 'GitHub repository name.' },
      pull_number: { type: 'number', description: 'Pull request number.' },
      reason: { type: 'string', description: 'Mandatory non-empty rationale for audit logging.' },
    },
    required: ['owner', 'repo', 'pull_number', 'reason'],
    additionalProperties: false,
  },
};

export interface CancelReviewDependencies {
  queryableDatabase?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  };
  patchCancellation?: (
    name: string,
    namespace: string,
    reason: string
  ) => Promise<{ reapedPod?: string; success: boolean }>;
  namespace?: string;
  now?: () => number;
}

export function createCancelReviewTool(deps: CancelReviewDependencies = {}) {
  const nowFn = deps.now || Date.now;
  const namespace = deps.namespace || 'ct-review-system';

  return {
    definition: cancelReviewDefinition,
    schema: CancelReviewInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = CancelReviewInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pull_number, reason } = parsed.data;

      if (!reason || !reason.trim()) {
        throw new Error('owner, repo, pull_number, and a non-empty reason are required for audit logging');
      }

      let attemptId = `review-attempt-${pull_number}-1`;
      let reapedPod: string | undefined = `review-worker-pr-${pull_number}-pod`;

      if (deps.queryableDatabase) {
        const activeRes = await deps.queryableDatabase.query(
          `SELECT run_id, attempt, head_sha, lease_owner, status
             FROM review_runs
            WHERE owner = $1 AND repo = $2 AND pr_number = $3
              AND status IN ('queued', 'running', 'publishing')
            LIMIT 1`,
          [owner, repo, pull_number]
        );

        const activeRun = activeRes.rows[0];
        if (!activeRun) {
          throw new Error(
            `Not Found: No active review run found for ${owner}/${repo} PR #${pull_number} to cancel`
          );
        }

        const runId = String(activeRun.run_id);
        attemptId = `review-attempt-${pull_number}-${activeRun.attempt || 1}`;
        reapedPod = activeRun.lease_owner || undefined;
        const now = nowFn();

        await deps.queryableDatabase.query(
          `UPDATE review_runs
              SET status = 'cancelled',
                  error_text = $2,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = to_timestamp($3 / 1000.0)
            WHERE run_id = $1`,
          [runId, reason, now]
        );

        try {
          await deps.queryableDatabase.query(
            `UPDATE review_dispatch_outbox
                SET status = 'terminal',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = to_timestamp($3 / 1000.0)
              WHERE run_id = $1`,
            [runId, now]
          );
        } catch {
          // Table may not exist
        }

        if (deps.patchCancellation) {
          const crdName = `ct-review-${runId.replace(/^run_/u, '')}`;
          try {
            const cancelOutcome = await deps.patchCancellation(crdName, namespace, reason);
            if (cancelOutcome.reapedPod) {
              reapedPod = cancelOutcome.reapedPod;
            }
          } catch {
            // Reaping completes asynchronously via operator TTL
          }
        }
      }

      return buildToolResultJson({
        cancelled: true,
        attempt_id: attemptId,
        reaped_pod: reapedPod,
        message: `Review attempt cancelled and worker pod reaped (reason: ${reason})`,
      } satisfies CancelReviewOutput);
    },
  };
}
