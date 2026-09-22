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
import { buildReviewRunIdentity, deriveReviewRunId } from '../../../review/reviewAdmission';
import type { AuthoritativeReviewAdmission } from '../../../review/authoritativeServiceContracts';
import type { ReviewDispatchRepository } from '../../../persistence/reviewDispatchRepository';

export const triggerReviewDefinition: ToolDefinition = {
  name: 'trigger_review',
  description: 'Enqueue an exact-head review through governed authoritative admission.',
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
  authoritativePublishing?: AuthoritativeReviewAdmission;
  queryableDatabase?: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  };
  resolveGitHubPullRequest?: (
    owner: string,
    repo: string,
    pullNumber: number
  ) => Promise<{ headSha: string; baseSha?: string; repositoryId?: number; installationId?: number }>;
  now?: () => number;
}

export function createTriggerReviewTool(deps: TriggerReviewDependencies = {}) {
  const nowFn = deps.now || Date.now;

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

      if (deps.admissionRepository && !deps.resolveGitHubPullRequest) {
        throw new Error('trigger_review requires exact GitHub pull request resolution');
      }

      const requested = { repositoryId, owner, repo, prNumber: pull_number, headSha, baseSha };
      const authoritative = deps.authoritativePublishing;
      if (deps.admissionRepository && !authoritative) {
        throw new Error('trigger_review requires authoritative publishing admission');
      }
      if (authoritative?.acceptNewRequests === false
        || (authoritative && !authoritative.repositoryIds.includes(repositoryId))) {
        throw new Error('trigger_review repository is outside authoritative admission');
      }
      const resolved = authoritative ? await authoritative.resolver.resolve(requested) : undefined;
      const resolvedIdentity = resolved?.identity || buildReviewRunIdentity(requested);
      const resolvedRunId = deriveReviewRunId(resolvedIdentity);

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
          if (!force || activeRun.run_id === resolvedRunId) {
            const err: any = new Error(
              `Conflict: Review attempt ${activeRun.run_id} is currently running for this review identity.`
            );
            err.code = 409;
            err.status = 409;
            throw err;
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
        const admission = await deps.admissionRepository.admit({
          deliveryId,
          eventName: 'mcp.trigger_review',
          repositoryId,
          installationId,
          receivedAt,
          terminalDeadline,
          payloadDigest,
          publicationMode: 'app-gate',
          centralActionDispatch: false,
          debounce: false,
          identity: resolvedIdentity,
          ...(resolved && authoritative ? {
            effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
            authoritativeGate: {
              expectedAppId: authoritative.expectedAppId,
              prepared: resolved.prepared,
            },
          } : {}),
        });

        admittedRunId = admission.run.runId;
        attemptId = `review-attempt-${pull_number}-${admittedRunId.slice(4, 12)}`;
      }

      return buildToolResultJson({
        dispatched: true,
        attempt_id: attemptId,
        // Projection is intentionally asynchronous and owned by the durable
        // review-job dispatcher, never by the internet-facing MCP process.
        job_crd_created: false,
        message: `Review job queued successfully (priority: ${priority})`,
      } satisfies TriggerReviewOutput);
    },
  };
}
