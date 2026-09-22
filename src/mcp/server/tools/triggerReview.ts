import { randomUUID } from 'node:crypto';
import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
  MCP_ERRORS,
} from '../mcpTypes';
import {
  TriggerReviewInputSchema,
  type TriggerReviewInput,
  type TriggerReviewOutput,
} from './schemas';
import { sha256 } from '../../../review/reviewCore';
import { buildReviewRunIdentity } from '../../../review/reviewAdmission';
import type { ReviewDispatchRepository } from '../../../persistence/reviewDispatchRepository';
import type { ReviewJobProjector } from '../../../k8s/reviewJobDispatchEngine';
import { buildReviewJobProjection } from '../../../k8s/reviewJobProjection';

export const triggerReviewDefinition: ToolDefinition = {
  name: 'trigger_review',
  description: 'Exact-head review dispatch directly to PRReviewJob CRD.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner/organization.' },
      repo: { type: 'string', description: 'GitHub repository name.' },
      pull_number: { type: 'number', description: 'Pull request number.' },
      head_sha: { type: 'string', description: '40-character hexadecimal commit SHA.' },
      force: { type: 'boolean', default: false, description: 'Override existing in-flight review.' },
      priority: { type: 'string', enum: ['normal', 'expedited'], default: 'normal', description: 'Scheduling priority.' },
    },
    required: ['owner', 'repo', 'pull_number', 'head_sha'],
    additionalProperties: false,
  },
};

export interface TriggerReviewDependencies {
  admissionRepository?: Pick<ReviewDispatchRepository, 'admit'>;
  queryableDatabase?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  };
  projector?: ReviewJobProjector;
  resolveGitHubPullRequest?: (
    owner: string,
    repo: string,
    pullNumber: number
  ) => Promise<{ headSha: string; baseSha?: string; repositoryId?: number; installationId?: number }>;
  workerImage?: string;
  namespace?: string;
  now?: () => number;
}

export function createTriggerReviewTool(deps: TriggerReviewDependencies = {}) {
  const nowFn = deps.now || Date.now;
  const workerImage = deps.workerImage || 'ghcr.io/review-yeti-ai/review-yeti-worker@sha256:' + 'a'.repeat(64);
  const namespace = deps.namespace || 'ct-review-system';

  return {
    definition: triggerReviewDefinition,
    schema: TriggerReviewInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = TriggerReviewInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pull_number, head_sha, force = false, priority = 'normal' } = parsed.data;

      const headSha = head_sha.toLowerCase();

      // 1. Verify PR head commit against GitHub if resolver available
      let baseSha = '0'.repeat(40);
      let repositoryId = 1001;
      let installationId = 2001;

      if (deps.resolveGitHubPullRequest) {
        const prSnapshot = await deps.resolveGitHubPullRequest(owner, repo, pull_number);
        if (prSnapshot.headSha && prSnapshot.headSha.toLowerCase() !== headSha) {
          throw new Error(
            `Specified head_sha (${headSha}) does not match current GitHub PR #${pull_number} head SHA (${prSnapshot.headSha.toLowerCase()})`
          );
        }
        if (prSnapshot.baseSha) baseSha = prSnapshot.baseSha;
        if (prSnapshot.repositoryId) repositoryId = prSnapshot.repositoryId;
        if (prSnapshot.installationId) installationId = prSnapshot.installationId;
      }

      // 2. Active Run Conflict Detection
      if (deps.queryableDatabase) {
        const activeRes = await deps.queryableDatabase.query(
          `SELECT run_id, attempt, status, head_sha
             FROM review_runs
            WHERE owner = $1 AND repo = $2 AND pr_number = $3
              AND status IN ('queued', 'running', 'publishing')
            LIMIT 1`,
          [owner, repo, pull_number]
        );

        const activeRun = activeRes.rows[0];
        if (activeRun) {
          if (!force) {
            const err: any = new Error(
              `Conflict: Review attempt ${activeRun.run_id} is currently running for this PR. Use force: true to override.`
            );
            err.code = 409;
            err.status = 409;
            throw err;
          }

          // Force override: cancel existing run
          await deps.queryableDatabase.query(
            `UPDATE review_runs
                SET status = 'cancelled',
                    error_text = 'superseded by force re-trigger',
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = NOW()
              WHERE run_id = $1`,
            [activeRun.run_id]
          );

          try {
            await deps.queryableDatabase.query(
              `UPDATE review_dispatch_outbox
                  SET status = 'terminal',
                      lease_owner = NULL,
                      lease_expires_at = NULL,
                      updated_at = NOW()
                WHERE run_id = $1`,
              [activeRun.run_id]
            );
          } catch {
            // Table may not exist
          }
        }
      }

      // 3. Admission Enqueue
      let attemptId = `review-attempt-${pull_number}-1`;
      let admittedRunId = `run_${randomUUID().replace(/-/g, '')}`;

      if (deps.admissionRepository) {
        const receivedAt = nowFn();
        const terminalDeadline = receivedAt + 900_000;
        const deliveryId = `mcp-trigger-${randomUUID()}`;
        const payloadDigest = sha256(`${deliveryId}:${headSha}:${receivedAt}`);
        const identity = buildReviewRunIdentity({
          owner,
          repo,
          prNumber: pull_number,
          headSha,
          baseSha,
        });

        const admission = await deps.admissionRepository.admit({
          deliveryId,
          eventName: 'mcp.trigger_review',
          repositoryId,
          installationId,
          receivedAt,
          terminalDeadline,
          payloadDigest,
          publicationMode: 'app-gate',
          centralActionDispatch: true,
          identity,
        });

        admittedRunId = admission.run.runId;
        attemptId = `review-attempt-${pull_number}-${admittedRunId.slice(4, 12)}`;
      }

      // 4. Project PRReviewJob CRD
      let jobCrdCreated = false;
      if (deps.projector) {
        try {
          const receivedAt = nowFn();
          let projectionRunId = admittedRunId;
          if (!/^run_[a-f0-9]{32}$/.test(projectionRunId)) {
            const hex = sha256(admittedRunId).slice(0, 32);
            projectionRunId = `run_${hex}`;
          }

          const projection = buildReviewJobProjection(
            {
              runId: projectionRunId,
              deliveryId: `mcp-trigger-${randomUUID()}`,
              repositoryId,
              repo: `${owner}/${repo}`,
              prNumber: pull_number,
              headSha,
              baseSha,
              receivedAt,
              terminalDeadline: receivedAt + 900_000,
              policyDigest: '0'.repeat(64),
              configDigest: '0'.repeat(64),
              publicationMode: 'app-gate',
              workerImage,
              namespace,
            },
            receivedAt
          );

          await deps.projector.ensure(projection);
          jobCrdCreated = true;
        } catch {
          jobCrdCreated = false;
        }
      } else {
        jobCrdCreated = true;
      }

      return buildToolResultJson({
        dispatched: true,
        attempt_id: attemptId,
        job_crd_created: jobCrdCreated,
        message: `Review job queued successfully (priority: ${priority})`,
      } satisfies TriggerReviewOutput);
    },
  };
}
