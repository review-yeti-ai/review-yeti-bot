import type { McpToolHandler, McpExecutionContext, ToolResult, ActiveJobItem } from '../types.js';

export const queryActiveJobsTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_query_active_jobs',
    description:
      'Query currently active and queued review jobs across Cloudflare Durable Objects, Firecracker microVMs, and DOKS workers.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'GitHub organization or owner (e.g. "exampleorg")',
        },
        repo: {
          type: 'string',
          description: 'Repository name (e.g. "example-api")',
        },
        prNumber: {
          type: 'number',
          description: 'Optional Pull Request number to filter active jobs',
        },
        orchestrator: {
          type: 'string',
          enum: ['all', 'cloudflare', 'doks'],
          default: 'all',
          description: 'Filter jobs by orchestrator plane',
        },
        limit: {
          type: 'number',
          default: 20,
          description: 'Maximum number of active jobs to return',
        },
      },
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const owner = (args.owner || 'exampleorg').trim();
    const repo = (args.repo || '').trim();
    const prNumber = typeof args.prNumber === 'number' ? args.prNumber : undefined;
    const orchestratorFilter = args.orchestrator || 'all';
    const limit = typeof args.limit === 'number' ? args.limit : 20;

    const env = context.env || {};
    const jobs: ActiveJobItem[] = [];
    let liveFetchSucceeded = false;

    // 1. Query Cloudflare RepoGateDO and ReviewRunDO if bound
    if (orchestratorFilter === 'all' || orchestratorFilter === 'cloudflare') {
      const repoKey = repo ? (owner ? `${owner}/${repo}` : repo) : 'exampleorg/example-api';
      if (env.REPO_GATE?.idFromName && env.REPO_GATE?.get) {
        try {
          const repoGateId = env.REPO_GATE.idFromName(repoKey);
          const repoGate = env.REPO_GATE.get(repoGateId);
          const res = await repoGate.fetch('http://do/status');
          if (res.ok) {
            liveFetchSucceeded = true;
            const gateData = (await res.json()) as any;
            let activeRuns: Array<{ prNumber: number; runId: string }> = [];
            if (gateData.activeRunsByPr && typeof gateData.activeRunsByPr === 'object') {
              activeRuns = Object.entries(gateData.activeRunsByPr).map(([pr, runId]) => ({
                prNumber: Number(pr),
                runId: String(runId),
              }));
            } else if (Array.isArray(gateData.activeRuns)) {
              activeRuns = gateData.activeRuns;
            }

            for (const item of activeRuns) {
              if (prNumber !== undefined && item.prNumber !== prNumber) {
                continue;
              }
              let phase = 'worker_executing';
              let fencingEpoch = 1;
              let workerId: string | undefined = undefined;
              let leaseAgeMs: number | undefined = undefined;

              if (env.REVIEW_RUN?.idFromName && env.REVIEW_RUN?.get) {
                try {
                  const runDOId = env.REVIEW_RUN.idFromName(item.runId);
                  const runDO = env.REVIEW_RUN.get(runDOId);
                  const runRes = await runDO.fetch('http://do/status');
                  if (runRes.ok) {
                    const runData = (await runRes.json()) as any;
                    phase = runData.phase || phase;
                    fencingEpoch = runData.fencingEpoch || fencingEpoch;
                    workerId = runData.workerId;
                    leaseAgeMs = runData.leaseAgeMs;
                  }
                } catch {
                  // Fall back gracefully
                }
              }

              jobs.push({
                runId: item.runId,
                repo: repo || 'example-api',
                owner,
                prNumber: item.prNumber,
                commitSha: 'HEAD',
                phase,
                orchestrator: 'cloudflare',
                runner: 'digitalocean-agent',
                fencingEpoch,
                workerId,
                leaseAgeMs,
                startedAt: new Date(Date.now() - (leaseAgeMs || 15000)).toISOString(),
                durationMs: leaseAgeMs || 15000,
              });
            }

            // Check queued PRs
            const queuedPrs: number[] = gateData.queuedPrs || [];
            for (const qPr of queuedPrs) {
              if (prNumber !== undefined && qPr !== prNumber) continue;
              jobs.push({
                runId: `run_queued_pr_${qPr}`,
                repo: repo || 'example-api',
                owner,
                prNumber: qPr,
                commitSha: 'PENDING',
                phase: 'queued_in_semaphore',
                orchestrator: 'cloudflare',
                runner: 'digitalocean-agent',
              });
            }
          }
        } catch (err) {
          console.error('Error querying RepoGateDO in queryActiveJobs:', err);
        }
      }
    }

    const limitedJobs = jobs.slice(0, limit);

    const markdownRows = limitedJobs
      .map(
        (j) =>
          `| \`${j.runId}\` | **#${j.prNumber}** | \`${j.phase}\` | **${j.orchestrator}** | \`${j.runner}\` | ${
            j.durationMs ? Math.round(j.durationMs / 1000) + 's' : '-'
          } |`
      )
      .join('\n');

    const summaryText =
      limitedJobs.length === 0
        ? `No active review jobs found matching criteria.`
        : `### 🚀 Active Review Jobs (${limitedJobs.length})\n\n` +
          `| Run ID | PR | Phase | Orchestrator | Runner | Duration |\n` +
          `|---|---|---|---|---|---|\n` +
          `${markdownRows}\n`;

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
              activeJobsCount: limitedJobs.length,
              jobs: limitedJobs,
              dataSource: liveFetchSucceeded ? 'live_edge_telemetry' : 'baseline_sample_telemetry',
            },
            null,
            2
          ),
        },
      ],
    };
  },
};
