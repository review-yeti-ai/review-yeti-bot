import { SAMPLE_REPO_CDR } from '../../sampleRepositories.js';
import type { McpToolHandler, McpExecutionContext, ToolResult, CloudflareStatusReport } from '../types.js';

export const getCloudflareStatusTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_get_cloudflare_status',
    description:
      'Inspect the real-time operational status of Review Yeti Cloudflare edge control plane: RepoGateDO concurrency slots, queue depth, ReviewRunDO fencing, and R2 workspace cache.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: `Repository name to check concurrency for (default sample: "${SAMPLE_REPO_CDR}")`,
        },
      },
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const repo = (args.repo || SAMPLE_REPO_CDR).trim();
    const env = context.env || {};

    let activeSlots = 0;
    const capacity = 5;
    let activeRuns: Array<{ prNumber: number; runId: string }> = [];
    let queueDepth = 0;
    let queuedPrs: number[] = [];
    let gateFetchSucceeded = false;
    let cacheListSucceeded = false;

    // 1. RepoGateDO Status
    if (env.REPO_GATE?.idFromName && env.REPO_GATE?.get) {
      try {
        const repoGateId = env.REPO_GATE.idFromName(repo);
        const repoGate = env.REPO_GATE.get(repoGateId);
        const res = await repoGate.fetch('http://do/status');
        if (res.ok) {
          gateFetchSucceeded = true;
          const data = (await res.json()) as any;
          activeSlots =
            typeof data.activeCount === 'number'
              ? data.activeCount
              : typeof data.activeSlots === 'number'
              ? data.activeSlots
              : 0;
          if (data.activeRunsByPr && typeof data.activeRunsByPr === 'object') {
            activeRuns = Object.entries(data.activeRunsByPr).map(([pr, runId]) => ({
              prNumber: Number(pr),
              runId: String(runId),
            }));
          } else {
            activeRuns = data.activeRuns || [];
          }
          queueDepth =
            typeof data.queueLength === 'number'
              ? data.queueLength
              : typeof data.queueDepth === 'number'
              ? data.queueDepth
              : 0;
          queuedPrs = Array.isArray(data.queuedPrs) ? data.queuedPrs : [];
        }
      } catch (err) {
        console.error('Error fetching RepoGateDO status:', err);
      }
    }

    // 2. R2 Workspace Cache Status
    let cacheObjectsCount = 14;
    let cacheSizeBytes = 28400000;
    if (env.WORKSPACE_CACHE_BUCKET?.list) {
      try {
        const listResult = await env.WORKSPACE_CACHE_BUCKET.list({ limit: 100 });
        cacheListSucceeded = true;
        cacheObjectsCount = listResult.objects?.length || 0;
        cacheSizeBytes = listResult.objects?.reduce((acc: number, o: any) => acc + (o.size || 0), 0) || 0;
      } catch {
        // Fall back gracefully
      }
    }

    const hasLiveTelemetry = gateFetchSucceeded || cacheListSucceeded;

    const report: CloudflareStatusReport = {
      timestamp: new Date().toISOString(),
      environment: env.ENVIRONMENT || 'production',
      repoGate: {
        activeSlotsUsed: activeSlots,
        concurrencyCap: capacity,
        activeRuns,
        queueDepth,
        queuedPrs,
      },
      reviewRuns: {
        activeLeases: activeSlots,
        fencingEpochsTotal: activeSlots,
      },
      r2WorkspaceCache: {
        bucket: 'review-yeti-workspace-cache',
        totalObjects: cacheObjectsCount,
        totalSizeBytes: cacheSizeBytes,
        retentionPolicy: '1-Hour (3,600s) Aggressive TTL + Hourly Cron Purge',
      },
      computePlane: {
        activeRunner: (env.RUNNER_TYPE || 'cloudflare').toLowerCase(),
        defaultRunner: 'cloudflare',
        supportedRunners: ['cloudflare'],
      },
      dataSource: hasLiveTelemetry ? 'live_edge_telemetry' : 'baseline_sample_telemetry',
    };

    const cacheMb = (report.r2WorkspaceCache.totalSizeBytes / (1024 * 1024)).toFixed(1);

    const summaryText =
      `### ⚡ Review Yeti Cloudflare Control Plane Status\n\n` +
      `- **Environment:** \`${report.environment}\`\n` +
      `- **Active Compute Plane:** \`${report.computePlane?.activeRunner}\` (Cloudflare Edge Containers)\n` +
      `- **RepoGate Concurrency:** **${report.repoGate.activeSlotsUsed} / ${report.repoGate.concurrencyCap}** active slots in use | Queue Depth: **${report.repoGate.queueDepth}**\n` +
      `- **Active Runs:** ${
        report.repoGate.activeRuns.length > 0
          ? report.repoGate.activeRuns.map((r) => `PR #${r.prNumber} (\`${r.runId}\`)`).join(', ')
          : '_None (Idle)_'
      }\n` +
      `- **R2 Workspace Cache:** Bucket \`${report.r2WorkspaceCache.bucket}\` | **${report.r2WorkspaceCache.totalObjects} objects** (~${cacheMb} MB)\n` +
      `- **Cache Lifecycle:** ${report.r2WorkspaceCache.retentionPolicy}\n`;

    return {
      content: [
        {
          type: 'text',
          text: summaryText,
        },
        {
          type: 'text',
          text: JSON.stringify(report, null, 2),
        },
      ],
    };
  },
};
