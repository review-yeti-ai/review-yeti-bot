import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import { publishOperatorPassthroughForTarget } from '../../operatorPassthroughPublisher.js';

export const triggerReviewTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_trigger_review',
    description:
      'Trigger an on-demand review job for a Pull Request or commit SHA across Cloudflare Edge or DigitalOcean runners.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          default: 'exampleorg',
          description: 'GitHub repository owner/org (e.g. "exampleorg")',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository name (e.g. "example-api")',
        },
        prNumber: {
          type: 'number',
          description: 'Pull Request number to trigger review for',
        },
        commitSha: {
          type: 'string',
          description: 'Optional head commit SHA (defaults to latest HEAD)',
        },
        runner: {
          type: 'string',
          enum: ['cloudflare', 'digitalocean'],
          default: 'cloudflare',
          description: 'Target compute runner (default: "cloudflare", option: "digitalocean")',
        },
        mode: {
          type: 'string',
          enum: ['shadow', 'authoritative'],
          default: 'shadow',
          description: 'Review execution mode (shadow canary vs binding authoritative)',
        },
      },
      required: ['repo', 'prNumber'],
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const owner = (args.owner || 'exampleorg').trim();
    const repo = (args.repo || '').trim();
    const prNumber = Number(args.prNumber);
    const commitSha = (args.commitSha || 'latest-head').trim();

    const ALLOWED_RUNNERS = ['cloudflare', 'digitalocean', 'mars', 'do'];
    let runner: string;
    if (args.runner !== undefined && args.runner !== null && String(args.runner).trim() !== '') {
      const normalized = String(args.runner).trim().toLowerCase();
      if (!ALLOWED_RUNNERS.includes(normalized)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error: Invalid runner "${args.runner}". Allowed values are: "cloudflare", "digitalocean".`,
            },
          ],
        };
      }
      runner = normalized === 'mars' || normalized === 'do' ? 'digitalocean' : normalized;
    } else {
      runner = (context.env?.RUNNER_TYPE || 'cloudflare').trim().toLowerCase();
    }
    const mode = args.mode || 'shadow';

    if (!repo || isNaN(prNumber)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: Both "repo" and numeric "prNumber" are required to trigger a review.',
          },
        ],
      };
    }

    const runId = `run_cf_mcp_${Date.now()}_pr${prNumber}`;
    const env = context.env || {};

    if (env.OPERATOR_GLOBAL_PASSTHROUGH === 'true') {
      const expected = commitSha === 'latest-head' ? undefined : { headSha: commitSha };
      const receipt = await publishOperatorPassthroughForTarget(env, { owner, repo, prNumber }, {}, expected);
      const published = receipt.status === 'succeeded' && receipt.mergeEligible && receipt.publicationReceiptAvailable;
      const trackingUrl = receipt.runId
        ? `https://review-yeti-cf-orchestrator.example.workers.dev/api/dispatch/runs/${receipt.runId}/status`
        : null;
      const summary = published
        ? `Operator passthrough publication is current for ${receipt.owner}/${receipt.repo}#${receipt.prNumber} at ${receipt.headSha}. No semantic review ran; zero lanes were started.`
        : `Operator passthrough publication is unavailable for ${owner}/${repo}#${prNumber}. No semantic review ran; merge eligibility is false.`;
      return {
        isError: !published,
        content: [
          { type: 'text', text: summary },
          { type: 'text', text: JSON.stringify({ ...receipt, slotGranted: false, dispatched: published, trackingUrl }, null, 2) },
        ],
      };
    }

    let acquired = false;
    let queuePosition = 0;

    // Acquire slot via RepoGateDO if bound
    const repoKey = `${owner}/${repo}`;
    if (env.REPO_GATE?.idFromName && env.REPO_GATE?.get) {
      try {
        const repoGateId = env.REPO_GATE.idFromName(repoKey);
        const repoGate = env.REPO_GATE.get(repoGateId);
        const res = await repoGate.fetch('http://do/acquire', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, headSha: commitSha, prNumber }),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          if (data.evicted) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Error: Concurrency slot denied by RepoGateDO for repository ${repoKey}. Run was evicted or repository locked.`,
                },
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: false,
                      runId,
                      repo: repoKey,
                      prNumber,
                      commitSha,
                      slotGranted: false,
                      evicted: true,
                      dispatched: false,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          acquired = Boolean(data.granted);
          queuePosition = typeof data.queuePosition === 'number' ? data.queuePosition : 0;
          if (!acquired && queuePosition === 0) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `Error: Concurrency slot denied by RepoGateDO for repository ${repoKey}. Concurrency limit reached or repository locked.`,
                },
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ok: false,
                      runId,
                      repo: repoKey,
                      prNumber,
                      commitSha,
                      slotGranted: false,
                      dispatched: false,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Error: Failed to acquire concurrency slot from RepoGateDO: HTTP ${res.status}`,
              },
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    ok: false,
                    runId,
                    repo: repoKey,
                    prNumber,
                    commitSha,
                    slotGranted: false,
                    dispatched: false,
                    error: `RepoGateDO HTTP ${res.status}`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } catch (err: any) {
        console.error('Error acquiring slot from RepoGateDO:', err);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error: Exception acquiring concurrency slot from RepoGateDO: ${err?.message || String(err)}`,
            },
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: false,
                  runId,
                  repo: repoKey,
                  prNumber,
                  commitSha,
                  slotGranted: false,
                  dispatched: false,
                  error: err?.message || String(err),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }

    const dispatchErrors: string[] = [];

    // 2. Dispatch ReviewJobWorkflow if bound
    let workflowCreated = false;
    if (env.REVIEW_JOB_WORKFLOW && typeof env.REVIEW_JOB_WORKFLOW.create === 'function') {
      try {
        await env.REVIEW_JOB_WORKFLOW.create({
          id: runId,
          params: {
            runId,
            owner,
            repo,
            prNumber,
            headSha: commitSha,
            baseSha: 'master',
            installationId: 0,
            runner,
            mode,
          },
        });
        workflowCreated = true;
      } catch (err: any) {
        const msg = err?.message || String(err);
        dispatchErrors.push(`ReviewJobWorkflow dispatch failed: ${msg}`);
        console.error('Error creating ReviewJobWorkflow:', err);
      }
    }

    // 3. Initialize ReviewRunDO state if bound
    let reviewRunInitialized = false;
    if (env.REVIEW_RUN?.idFromName && env.REVIEW_RUN?.get) {
      try {
        const reviewRunDOId = env.REVIEW_RUN.idFromName(runId);
        const reviewRunDO = env.REVIEW_RUN.get(reviewRunDOId);
        const initRes = await reviewRunDO.fetch('http://do/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId,
            owner,
            repo,
            prNumber,
            headSha: commitSha,
            runner,
            mode,
          }),
        });
        if (initRes.ok) {
          reviewRunInitialized = true;
        } else {
          dispatchErrors.push(`ReviewRunDO init failed: HTTP ${initRes.status}`);
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        dispatchErrors.push(`ReviewRunDO init error: ${msg}`);
        console.error('Error initializing ReviewRunDO in triggerReview:', err);
      }
    }

    // Surface errors if configured dispatch/init failed
    if (dispatchErrors.length > 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: Failed to dispatch review job:\n- ${dispatchErrors.join('\n- ')}`,
          },
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                runId,
                repo: repoKey,
                prNumber,
                commitSha,
                errors: dispatchErrors,
                dispatched: false,
                slotGranted: acquired,
                queuePosition,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const isDispatched = workflowCreated || reviewRunInitialized;
    const isSimulated = !env.REVIEW_JOB_WORKFLOW && !env.REVIEW_RUN && !env.REPO_GATE;
    const trackingUrl = `https://review-yeti-cf-orchestrator.example.workers.dev/api/dispatch/runs/${runId}/status`;

    const summaryText =
      `### 🚀 Review Yeti Job Dispatched${isSimulated ? ' (Simulation / Local Mode)' : ''}\n\n` +
      `- **Run ID:** \`${runId}\`\n` +
      `- **Repository:** \`${repoKey}\` | **PR:** **#${prNumber}**\n` +
      `- **Commit SHA:** \`${commitSha}\`\n` +
      `- **Runner Plane:** \`${runner}\` (${runner === 'digitalocean' ? 'Firecracker microVM' : 'Edge Container'})\n` +
      `- **Execution Mode:** \`${mode}\` (${mode === 'shadow' ? 'Shadow Canary' : 'Authoritative Check'})\n` +
      `- **Workflow Engine:** ${
        workflowCreated
          ? '✅ **Dispatched to Cloudflare Workflow**'
          : reviewRunInitialized
          ? '✅ **Initialized in ReviewRunDO**'
          : 'ℹ️ **Simulated (Unbound / Local Test)**'
      }\n` +
      `- **Concurrency Slot Status:** ${
        acquired
          ? '✅ **Slot Granted (Executing Now)**'
          : queuePosition > 0
          ? `⏳ **Queued (Position #${queuePosition})**`
          : '⚠️ **Unallocated (No Concurrency Slot Granted / Simulated Mode)**'
      }\n` +
      `- **Status Tracking Endpoint:** [${trackingUrl}](${trackingUrl})\n`;

    return {
      content: [
        {
          type: 'text',
          text: summaryText,
        },
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              runId,
              repo: repoKey,
              prNumber,
              commitSha,
              runner,
              mode,
              slotGranted: acquired,
              queuePosition,
              trackingUrl,
              dispatched: isDispatched,
              dryRun: isSimulated,
              dataSource: isDispatched ? 'live_edge_dispatch' : 'baseline_sample_telemetry',
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
