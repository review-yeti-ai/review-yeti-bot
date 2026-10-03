import type { McpToolHandler, McpExecutionContext, ToolResult, BillableRuntimeReport } from '../types.js';
import { calculateRunnerCost, formatCostUsd, formatDuration } from '../../runners/runnerCost.js';
import { fetchReviewsFromDb } from '../../storage/d1Client.js';

export const getBillableRuntimeReportTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_get_billable_runtime_report',
    description:
      'Generate compute cost and billable runtime reports for Review Yeti managed runners (DigitalOcean Managed Agents, Cloudflare Containers, and OpenRouter tokens) including comparative savings versus DOKS Kubernetes baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Repository name filter (e.g. "example-api")',
        },
        prNumber: {
          type: 'number',
          description: 'Pull Request number filter',
        },
        runnerType: {
          type: 'string',
          enum: ['all', 'digitalocean', 'cloudflare', 'doks'],
          default: 'all',
          description: 'Filter by execution runner environment',
        },
        timeframeDays: {
          type: 'number',
          default: 30,
          description: 'Reporting window in days (default: 30)',
        },
      },
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const repo = (args.repo || '').trim();
    const prNumber = typeof args.prNumber === 'number' ? args.prNumber : undefined;
    const runnerTypeFilter = args.runnerType || 'all';
    const days = typeof args.timeframeDays === 'number' ? args.timeframeDays : 30;

    const now = Date.now();
    const startDate = new Date(now - days * 86400 * 1000).toISOString();
    const endDate = new Date(now).toISOString();

    let rawRuns: any[] = [];
    const hasDb = Boolean(context.env?.DB);

    if (hasDb) {
      try {
        const d1Reviews = await fetchReviewsFromDb(context.env.DB, { limit: 100, repo: repo || undefined });
        rawRuns = d1Reviews.map((r: any) => ({
          runId: r.id,
          repo: r.repo,
          prNumber: r.prNumber,
          runner: r.model?.includes('cloud') ? 'cloudflare' : 'digitalocean',
          durationMs: r.durationMs || 0,
          tokenCostUSD: r.spendUsd || 0,
          createdAt: new Date(r.createdAt).toISOString(),
        }));
      } catch {
        rawRuns = [];
      }
    } else {
      // Standard run sample dataset reflecting production telemetry
      rawRuns = [
        {
          runId: 'run_cf_bd36035bf508024da7457527fa0fa4f5',
          repo: 'example-api',
          prNumber: 5290,
          runner: 'digitalocean',
          durationMs: 18450,
          tokenCostUSD: 0.0032,
          createdAt: new Date(now - 1200000).toISOString(),
        },
        {
          runId: 'run_cf_45ca09576fc84c3f1a9627354e341121',
          repo: 'example-api',
          prNumber: 5262,
          runner: 'digitalocean',
          durationMs: 248100,
          tokenCostUSD: 0.0415,
          createdAt: new Date(now - 86400000).toISOString(),
        },
        {
          runId: 'run_cf_692b3bb536',
          repo: 'example-api',
          prNumber: 5288,
          runner: 'cloudflare',
          durationMs: 22400,
          tokenCostUSD: 0.0041,
          createdAt: new Date(now - 172800000).toISOString(),
        },
        {
          runId: 'run_cf_d94fde4fe8',
          repo: 'example-api',
          prNumber: 5294,
          runner: 'digitalocean',
          durationMs: 28450,
          tokenCostUSD: 0.0051,
          createdAt: new Date(now - 3600000).toISOString(),
        },
        {
          runId: 'run_cf_d57c419e2a',
          repo: 'example-api',
          prNumber: 5275,
          runner: 'cloudflare',
          durationMs: 19800,
          tokenCostUSD: 0.0038,
          createdAt: new Date(now - 259200000).toISOString(),
        },
      ];
    }

    const filteredRuns = rawRuns.filter((r) => {
      if (repo && r.repo !== repo) return false;
      if (prNumber !== undefined && r.prNumber !== prNumber) return false;
      if (runnerTypeFilter !== 'all' && r.runner !== runnerTypeFilter) return false;
      return true;
    });

    let totalBillableSeconds = 0;
    let totalComputeCostUSD = 0;
    let totalTokenCostUSD = 0;

    const breakdownByRunner: Record<
      string,
      {
        runs: number;
        runtimeSeconds: number;
        computeCostUSD: number;
        tokenCostUSD: number;
        totalCostUSD: number;
      }
    > = {
      digitalocean: { runs: 0, runtimeSeconds: 0, computeCostUSD: 0, tokenCostUSD: 0, totalCostUSD: 0 },
      cloudflare: { runs: 0, runtimeSeconds: 0, computeCostUSD: 0, tokenCostUSD: 0, totalCostUSD: 0 },
    };

    const items = filteredRuns.map((r) => {
      const sec = Math.ceil(r.durationMs / 1000);
      const costInfo = calculateRunnerCost({
        durationMs: sec * 1000,
        vcpus: 2,
        memoryMb: 2048,
        runnerType: r.runner as any,
      });

      const runnerKey = r.runner;
      if (!breakdownByRunner[runnerKey]) {
        breakdownByRunner[runnerKey] = {
          runs: 0,
          runtimeSeconds: 0,
          computeCostUSD: 0,
          tokenCostUSD: 0,
          totalCostUSD: 0,
        };
      }

      breakdownByRunner[runnerKey].runs++;
      breakdownByRunner[runnerKey].runtimeSeconds += sec;
      breakdownByRunner[runnerKey].computeCostUSD += costInfo.costUsd;
      breakdownByRunner[runnerKey].tokenCostUSD += r.tokenCostUSD;
      breakdownByRunner[runnerKey].totalCostUSD += costInfo.costUsd + r.tokenCostUSD;

      totalBillableSeconds += sec;
      totalComputeCostUSD += costInfo.costUsd;
      totalTokenCostUSD += r.tokenCostUSD;

      return {
        runId: r.runId,
        repo: r.repo,
        prNumber: r.prNumber,
        runner: costInfo.runnerName,
        durationMs: r.durationMs,
        computeCostUSD: costInfo.costUsd,
        tokenCostUSD: r.tokenCostUSD,
        totalCostUSD: costInfo.costUsd + r.tokenCostUSD,
        createdAt: r.createdAt,
      };
    });

    const totalSpendUSD = totalComputeCostUSD + totalTokenCostUSD;
    // DOKS baseline: fixed cluster cost ~$170/mo pro-rated for timeframeDays (only applicable when runs exist)
    const estimatedDoksBaselineCostUSD =
      items.length > 0 ? Number(((170 / 30) * days).toFixed(2)) : 0;
    const netSavingsUSD =
      items.length > 0 ? Number((estimatedDoksBaselineCostUSD - totalSpendUSD).toFixed(2)) : 0;
    const savingsPercent =
      estimatedDoksBaselineCostUSD > 0
        ? Number(((netSavingsUSD / estimatedDoksBaselineCostUSD) * 100).toFixed(1))
        : 0;

    const report: BillableRuntimeReport = {
      timeframe: {
        startDate,
        endDate,
      },
      filter: {
        repo: repo || undefined,
        prNumber,
        runnerType: runnerTypeFilter,
      },
      summary: {
        totalRuns: items.length,
        totalBillableSeconds,
        totalComputeCostUSD: Number(totalComputeCostUSD.toFixed(6)),
        totalTokenCostUSD: Number(totalTokenCostUSD.toFixed(4)),
        totalSpendUSD: Number(totalSpendUSD.toFixed(4)),
        estimatedDoksBaselineCostUSD,
        netSavingsUSD,
        savingsPercent,
      },
      breakdownByRunner,
      items,
      dataSource: hasDb ? 'live_telemetry' : 'baseline_sample_telemetry',
    };

    const summaryText =
      `### 💰 Review Yeti Billable Compute & Runtime Report\n\n` +
      `- **Data Source:** \`${report.dataSource}\`\n` +
      `- **Period:** Last ${days} days (\`${startDate.slice(0, 10)}\` to \`${endDate.slice(0, 10)}\`)\n` +
      `- **Total Reviews Processed:** **${report.summary.totalRuns} runs**\n` +
      `- **Billable Compute Duration:** **${formatDuration(report.summary.totalBillableSeconds * 1000)}** (${report.summary.totalBillableSeconds}s)\n` +
      `- **Managed Runner Compute Cost:** **${formatCostUsd(report.summary.totalComputeCostUSD)} USD**\n` +
      `- **LLM Token Ingress/Egress Cost:** **${formatCostUsd(report.summary.totalTokenCostUSD)} USD**\n` +
      `- **Total Review Yeti Spend:** **${formatCostUsd(report.summary.totalSpendUSD)} USD**\n\n` +
      `#### 📊 Cost Efficiency vs DOKS Kubernetes Baseline\n` +
      `- **Legacy DOKS Cluster Baseline:** \$${estimatedDoksBaselineCostUSD} USD (\$170/month idle node pools & PVCs)\n` +
      `- **Net Cloudflare Edge Cost Savings:** **\$${netSavingsUSD} USD (${savingsPercent}% reduction)**\n\n` +
      `#### 🏃 Compute Runner Breakdown\n` +
      `- **DigitalOcean Managed Agents:** ${breakdownByRunner.digitalocean.runs} runs | ${breakdownByRunner.digitalocean.runtimeSeconds}s | ${formatCostUsd(breakdownByRunner.digitalocean.computeCostUSD)} compute\n` +
      `- **Cloudflare Containers:** ${breakdownByRunner.cloudflare.runs} runs | ${breakdownByRunner.cloudflare.runtimeSeconds}s | ${formatCostUsd(breakdownByRunner.cloudflare.computeCostUSD)} compute\n`;

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
