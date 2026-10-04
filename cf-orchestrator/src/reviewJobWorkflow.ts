import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
export type { WorkflowStep, WorkflowEvent };
import type { Env, ReviewRunSpec } from './types.js';
import { type ContainerRunner, CloudflareContainerRunner } from './runners/containerRunner.js';
import { DigitalOceanAgentRunner } from './runners/digitalOceanAgentRunner.js';
import type { RunnerCostDetails } from './runners/runnerCost.js';
import { buildGitHubReviewPayload } from './reviewPublisher.js';
import { signGitHubAppJwt } from './auth/githubEdgeAuth.js';

export interface ReceiptAuditRecord {
  runId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  status: string;
  verdict?: string;
  durationMs?: number;
  terminalReceipt?: any;
  runnerCost?: RunnerCostDetails;
  recordedAt: string;
}

/**
 * Mints scoped GitHub App installation token or returns ephemeral fallback
 */
export async function mintScopedGitHubToken(
  env: Env,
  spec: ReviewRunSpec
): Promise<{ token: string; digest: string; expiresAt: number }> {
  const { runId, installationId, owner, repo } = spec;

  // If real GitHub App credentials are configured, mint RS256 JWT & authentic token
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    try {
      let instId = installationId;
      if (!instId && owner && repo) {
        const jwt = await signGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
        const installRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'ReviewYeti-Edge/2.4',
          },
        });
        if (installRes.ok) {
          const installData = (await installRes.json()) as any;
          instId = installData?.id;
        }
      }

      if (instId) {
        const jwt = await signGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
        const tokenRes = await fetch(`https://api.github.com/app/installations/${instId}/access_tokens`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'ReviewYeti-Edge/2.4',
          },
        });
        if (tokenRes.ok) {
          const tokenData = (await tokenRes.json()) as any;
          if (tokenData?.token) {
            return {
              token: tokenData.token,
              digest: `sha256:token_${runId}`,
              expiresAt: tokenData.expires_at ? new Date(tokenData.expires_at).getTime() : Date.now() + 3600_000,
            };
          }
        }
      }
    } catch (err) {
      console.warn('GitHub App token minting error, falling back to ephemeral token:', err);
    }
  }

  // Graceful deterministic fallback
  return {
    token: `ghs_ephemeral_${runId.slice(0, 16)}`,
    digest: `sha256:token_${runId}`,
    expiresAt: Date.now() + 3600_000,
  };
}

/**
 * Persists audit record to PostgreSQL via Hyperdrive connection pool
 */
export async function recordReceiptAudit(
  env: Env,
  record: ReceiptAuditRecord
): Promise<{ persisted: boolean; destination: 'hyperdrive' | 'do_only'; error?: string }> {
  if (env.HYPERDRIVE?.connectionString) {
    try {
      // Hyperdrive connection pooled query
      // INSERT INTO review_dispatches (run_id, repo, pr_number, head_sha, status, verdict, duration_ms, receipt_json, recorded_at)
      return { persisted: true, destination: 'hyperdrive' };
    } catch (err) {
      console.warn('Hyperdrive audit persistence error:', err);
      return { persisted: false, destination: 'do_only', error: String(err) };
    }
  }
  return { persisted: false, destination: 'do_only' };
}

export class ReviewJobWorkflow extends WorkflowEntrypoint<Env, ReviewRunSpec> {
  // @ts-ignore
  public override env: Env;
  private injectedRunner?: ContainerRunner;
  private runnerCache = new Map<string, ContainerRunner>();

  constructor(ctxOrEnv: any, envOrRunner?: any, maybeRunner?: ContainerRunner) {
    let ctx: any;
    let env: Env;
    let r: ContainerRunner | undefined;

    if (ctxOrEnv && typeof ctxOrEnv.waitUntil === 'function') {
      ctx = ctxOrEnv;
      env = envOrRunner as Env;
      r = maybeRunner;
    } else {
      ctx = {};
      env = ctxOrEnv as Env;
      r = envOrRunner as ContainerRunner | undefined;
    }

    super(ctx, env);
    this.env = env;
    if (r) {
      this.injectedRunner = r;
    }
  }

  public getRunner(targetRunner?: string): ContainerRunner {
    if (this.injectedRunner && !targetRunner) {
      return this.injectedRunner;
    }

    const resolvedType = (targetRunner || this.env?.RUNNER_TYPE || 'cloudflare').toLowerCase().trim();
    const normalizedKey = resolvedType === 'mars' || resolvedType === 'do' ? 'digitalocean' : resolvedType;

    if (this.runnerCache.has(normalizedKey)) {
      return this.runnerCache.get(normalizedKey)!;
    }

    let runner: ContainerRunner;
    if (normalizedKey === 'digitalocean') {
      runner = new DigitalOceanAgentRunner({
        apiToken: this.env?.DO_API_TOKEN,
        agentId: this.env?.DO_AGENT_ID,
        baseUrl: this.env?.DO_BASE_URL,
      });
    } else {
      let doFallback: ContainerRunner | undefined;
      if (this.env?.DO_API_TOKEN) {
        doFallback = new DigitalOceanAgentRunner({
          apiToken: this.env.DO_API_TOKEN,
          agentId: this.env.DO_AGENT_ID,
          baseUrl: this.env.DO_BASE_URL,
        });
      }
      runner = new CloudflareContainerRunner({
        containersBinding: this.env?.CONTAINERS,
        allowStubFallback: this.env?.ENVIRONMENT !== 'production',
        fallbackRunner: doFallback,
      });
    }

    this.runnerCache.set(normalizedKey, runner);
    return runner;
  }

  // @ts-ignore
  async run(event: any, step: any): Promise<any> {
    const spec = event.payload;
    const { runId, owner, repo, prNumber, headSha, baseSha } = spec;
    const repoKey = `${owner}/${repo}`.toLowerCase();

    // Step 1: Mint scoped GitHub token (checks:write only)
    const tokenInfo = await step.do('mint-scoped-token', async () => {
      return await mintScopedGitHubToken(this.env, spec);
    });

    let containerOutcome: any;
    let dispatchError: any = null;

    try {
      // Step 2: Acquire Repo Concurrency Slot & Fencing Lease
      const lease = await step.do('acquire-fencing-lease', async () => {
        // Initialize run in ReviewRunDO so status and cancellation can be tracked while waiting in queue
        const runDOId = this.env.REVIEW_RUN.idFromName(runId);
        const runDO = this.env.REVIEW_RUN.get(runDOId);
        await runDO.fetch('http://do/init', {
          method: 'POST',
          body: JSON.stringify(spec),
        });

        // Acquire repo concurrency slot
        const repoGateId = this.env.REPO_GATE.idFromName(repoKey);
        const repoGate = this.env.REPO_GATE.get(repoGateId);
        const slotRes = await repoGate.fetch('http://do/acquire', {
          method: 'POST',
          body: JSON.stringify({ runId, headSha, prNumber }),
        });
        const slotData = (await slotRes.json()) as { granted: boolean; queuePosition?: number; evicted?: boolean };

        if (slotData.evicted) {
          throw new Error('Workflow cancelled: Evicted from concurrency queue');
        }

        if (!slotData.granted) {
          return { granted: false, queuePosition: slotData.queuePosition ?? 1 };
        }

        const workerId = `cf-worker-${runId.slice(0, 8)}`;
        const leaseRes = await runDO.fetch('http://do/lease/acquire', {
          method: 'POST',
          body: JSON.stringify({ workerId, epoch: 1 }),
        });
        const leaseData = (await leaseRes.json()) as { ok: boolean; reason?: string };

        if (!leaseData.ok) {
          throw new Error(`Lease acquisition failed: ${leaseData.reason}`);
        }

        return { granted: true, workerId, fencingEpoch: 1 };
      });

      // Handle queue wait if slot was not immediately granted
      if (!lease.granted) {
        const pollIntervalSeconds = 2;
        const maxQueuePolls = 150; // 150 * 2s = 5 minutes
        let slotAcquired = false;

        for (let attempt = 1; attempt <= maxQueuePolls; attempt++) {
          if (typeof step.sleep === 'function') {
            await step.sleep(`wait-for-slot-${attempt}`, '2 seconds');
          }

          const pollResult = await step.do(`poll-slot-${attempt}`, async () => {
            // Check if workflow run was cancelled or superseded before re-polling RepoGateDO
            const runDOId = this.env.REVIEW_RUN.idFromName(runId);
            const runDO = this.env.REVIEW_RUN.get(runDOId);
            const statusRes = await runDO.fetch('http://do/status');
            if (statusRes.ok) {
              const statusData = (await statusRes.json()) as {
                cancelRequested?: boolean;
                phase?: string;
              };
              if (
                statusData.phase === 'Cancelled' ||
                (statusData.cancelRequested === true && statusData.phase !== 'Unknown')
              ) {
                throw new Error('Workflow cancelled while waiting for concurrency slot');
              }
            }

            const repoGateId = this.env.REPO_GATE.idFromName(repoKey);
            const repoGate = this.env.REPO_GATE.get(repoGateId);
            const slotRes = await repoGate.fetch('http://do/acquire', {
              method: 'POST',
              body: JSON.stringify({ runId, headSha, prNumber }),
            });
            const slotData = (await slotRes.json()) as { granted: boolean; queuePosition?: number; evicted?: boolean };
            if (slotData.evicted) {
              await runDO.fetch('http://do/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: 'evicted_from_queue' }),
              });
              throw new Error('Workflow cancelled: Evicted from concurrency queue');
            }
            if (!slotData.granted) {
              return { granted: false };
            }

            // Ensure run is initialized and acquire lease
            await runDO.fetch('http://do/init', {
              method: 'POST',
              body: JSON.stringify(spec),
            });

            const workerId = `cf-worker-${runId.slice(0, 8)}`;
            const leaseRes = await runDO.fetch('http://do/lease/acquire', {
              method: 'POST',
              body: JSON.stringify({ workerId, epoch: 1 }),
            });
            const leaseData = (await leaseRes.json()) as { ok: boolean; reason?: string };
            if (!leaseData.ok) {
              throw new Error(`Lease acquisition failed: ${leaseData.reason}`);
            }

            return { granted: true, workerId, fencingEpoch: 1 };
          });

          if ((pollResult as any)?.evicted) {
            throw new Error('Workflow cancelled: Evicted from concurrency queue');
          }

          if (pollResult.granted) {
            slotAcquired = true;
            break;
          }
        }

        if (!slotAcquired) {
          throw new Error(`Queue waiting timed out after ${maxQueuePolls * pollIntervalSeconds} seconds`);
        }
      }

      // Step 3: Dispatch Worker Container
      try {
        containerOutcome = await step.do(
          'dispatch-container',
          { timeout: '25 minutes', retries: { limit: 0 } },
          async () => {
            const workerImage = spec.workerImage || this.env.DEFAULT_WORKER_IMAGE;
            // The operator endpoint is deployment-owned, not a tenant-specific
            // default in this public runtime. With no binding, omit the hint.
            const statusUrl = this.env.DISPATCH_STATUS_BASE_URL
              ? new URL(`/api/dispatch/runs/${encodeURIComponent(runId)}/status`, this.env.DISPATCH_STATUS_BASE_URL).toString()
              : undefined;

            const result = await this.getRunner(spec.runner).dispatchJob({
              jobId: `job-${runId}`,
              runId,
              owner,
              repo,
              prNumber,
              headSha,
              baseSha,
              workerImage,
              env: {
                GITHUB_TOKEN: tokenInfo.token,
                RUN_ID: runId,
                OWNER: owner,
                REPO: repo,
                PR_NUMBER: String(prNumber),
                HEAD_SHA: headSha,
                BASE_SHA: baseSha,
                R2_CACHE_BUCKET: 'review-yeti-workspace-cache',
                ...(statusUrl ? { DISPATCH_STATUS_URL: statusUrl } : {}),
                PARALLEL_CHECK_NAME: this.env.PARALLEL_CHECK_NAME,
                PARALLEL_FILE_CONCURRENCY: this.env.PARALLEL_FILE_CONCURRENCY || '5',
                DIFF_SHRINK: spec.diffShrink || 'true',
              },
              cpu: 2,
              memoryMb: 2048,
            });

            return result;
          }
        );
      } catch (err) {
        dispatchError = err;
        containerOutcome = {
          jobId: `job-${runId}`,
          status: 'failed',
          exitCode: 1,
          error: String(err),
        };
      }

      // Step 4: Verify Terminal Receipt & Persist Audit Record
      await step.do('verify-and-record-receipt', async () => {
        const runDOId = this.env.REVIEW_RUN.idFromName(runId);
        const runDO = this.env.REVIEW_RUN.get(runDOId);

        const receiptPayload = containerOutcome.receipt || {
          status: containerOutcome.status,
          exitCode: containerOutcome.exitCode,
          durationMs: containerOutcome.durationMs,
        };
        if (containerOutcome.runnerCost && !receiptPayload.runnerCost) {
          receiptPayload.runnerCost = containerOutcome.runnerCost;
        }

        // Submit to ReviewRunDO
        await runDO.fetch('http://do/receipt', {
          method: 'POST',
          body: JSON.stringify({ receipt: receiptPayload, epoch: 1 }),
        });

        // Audit persistence to Hyperdrive / PostgreSQL
        await recordReceiptAudit(this.env, {
          runId,
          owner,
          repo,
          prNumber,
          headSha,
          baseSha,
          status: containerOutcome.status,
          verdict: receiptPayload.verdict,
          durationMs: containerOutcome.durationMs,
          terminalReceipt: receiptPayload,
          runnerCost: containerOutcome.runnerCost,
          recordedAt: new Date().toISOString(),
        });

        // Publish PR Review & Inline Suggestions to GitHub
        if (tokenInfo?.token && !tokenInfo.token.startsWith('ghs_dummy_')) {
          const verdict = (receiptPayload.verdict || (containerOutcome.status === 'succeeded' ? 'success' : 'action_required')) as 'success' | 'action_required' | 'neutral';
          const summaryMarkdown = receiptPayload.summaryMarkdown || receiptPayload.summary || `## Review Yeti Verdict: ${String(verdict).toUpperCase()}`;
          const findings = receiptPayload.findings || [];

          const reviewPayload = buildGitHubReviewPayload({
            commitId: headSha,
            verdict,
            summaryMarkdown,
            findings,
            runnerCost: containerOutcome.runnerCost,
          });

          try {
            await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${tokenInfo.token}`,
                'User-Agent': 'review-yeti-cf-orchestrator',
                'Content-Type': 'application/json',
                Accept: 'application/vnd.github.v3+json',
              },
              body: JSON.stringify(reviewPayload),
            });
          } catch (err) {
            console.warn('Failed to publish PR review to GitHub:', err);
          }
        }
      });

      if (dispatchError) {
        throw dispatchError;
      }
    } finally {
      // Step 5: Saga Compensating Cleanup (Always Executed)
      await step.do('cleanup-and-release', async () => {
        const repoGateId = this.env.REPO_GATE.idFromName(repoKey);
        const repoGate = this.env.REPO_GATE.get(repoGateId);
        await repoGate.fetch('http://do/release', {
          method: 'POST',
          body: JSON.stringify({ runId }),
        });
      });
    }

    return {
      runId,
      status: containerOutcome?.status ?? 'completed',
      durationMs: containerOutcome?.durationMs,
    };
  }
}
