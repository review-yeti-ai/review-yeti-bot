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
      reason: { type: 'string', minLength: 1, maxLength: 512, description: 'Mandatory bounded rationale for audit logging.' },
    },
    required: ['owner', 'repo', 'pull_number', 'reason'],
    additionalProperties: false,
  },
};

export interface CancelReviewDependencies {
  cancellationRepository?: {
    cancelActiveRunsForPullRequest(input: {
      owner: string;
      repo: string;
      prNumber: number;
      cancelReason: string;
      gateReason: 'operator-cancelled';
      now: number;
    }): Promise<{
      activeRun: { runId: string; attempt: number };
    } | null>;
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
      if (!deps.cancellationRepository) {
        throw new Error('Cancellation service unavailable: transactional dispatch repository is required');
      }

      let attemptId = `review-attempt-${pull_number}-1`;
      let reapedPod: string | undefined;

      const cancellation = await deps.cancellationRepository.cancelActiveRunsForPullRequest({
        owner, repo, prNumber: pull_number, cancelReason: reason,
        gateReason: 'operator-cancelled', now: nowFn(),
      });
      if (!cancellation) {
        throw new Error(
          `Not Found: No active review run found for ${owner}/${repo} PR #${pull_number} to cancel`
        );
      }

      const activeRun = cancellation.activeRun;
      const runId = activeRun.runId;
      attemptId = `review-attempt-${pull_number}-${activeRun.attempt || 1}`;

      if (deps.patchCancellation) {
        const crdName = `ct-review-${runId.replace(/^run_/u, '')}`;
        try {
          const cancelOutcome = await deps.patchCancellation(crdName, namespace, reason);
          if (cancelOutcome.success && cancelOutcome.reapedPod) {
            reapedPod = cancelOutcome.reapedPod;
          }
        } catch {
          // Reaping completes asynchronously via the durable cancellation sweep.
        }
      }

      return buildToolResultJson({
        cancelled: true,
        attempt_id: attemptId,
        reaped_pod: reapedPod,
        message: reapedPod
          ? `Review attempt cancelled and worker cleanup confirmed (reason: ${reason})`
          : `Review attempt cancellation committed; worker cleanup is queued (reason: ${reason})`,
      } satisfies CancelReviewOutput);
    },
  };
}
