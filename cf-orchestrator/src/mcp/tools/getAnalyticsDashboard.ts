import type { McpToolHandler, McpExecutionContext, ToolResult, AnalyticsDashboardReport } from '../types.js';
import { formatCostUsd, formatDuration } from '../../runners/runnerCost.js';
import { SAMPLE_REPO_CDR, SAMPLE_REPO_CDR_SLUG } from '../../sampleRepositories.js';
import { fetchReviewsFromDb, fetchFindingsFromDb } from '../../storage/d1Client.js';

export const getAnalyticsDashboardTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_get_analytics_dashboard',
    description:
      'Retrieve high-level Review Yeti analytics, executive KPI summaries, pass/block rates, finding hotspots, and rule violation frequencies.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: `Repository name to filter dashboard (e.g. "${SAMPLE_REPO_CDR_SLUG}")`,
        },
        timeframe: {
          type: 'string',
          enum: ['24h', '7d', '30d'],
          default: '7d',
          description: 'Dashboard aggregation window',
        },
      },
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const repo = (args.repo || SAMPLE_REPO_CDR).trim();
    const timeframe = args.timeframe || '7d';

    const hasDb = Boolean(context.env?.DB);
    let totalReviews = 0;
    let p0 = 0;
    let p1 = 0;
    let p2 = 0;
    let totalSpendUSD = 0;
    let totalTokens = 0;
    let avgReviewDurationMs = 0;
    let passRatePercent = 0;
    let blockRatePercent = 0;
    let commentRatePercent = 0;
    let recentActivity: any[] = [];
    let topViolatedRules: any[] = [];
    let findingHotspots: any[] = [];

    if (hasDb) {
      const [reviews, findings] = await Promise.all([
        fetchReviewsFromDb(context.env.DB, { limit: 100, repo: repo || undefined }),
        fetchFindingsFromDb(context.env.DB, { limit: 500 }),
      ]);

      totalReviews = reviews.length;
      for (const f of findings) {
        if (f.severity === 'P0') p0++;
        else if (f.severity === 'P1') p1++;
        else if (f.severity === 'P2') p2++;
      }

      let sumDuration = 0;
      let passCount = 0;
      let blockCount = 0;
      for (const r of reviews) {
        totalSpendUSD += r.spendUsd || 0;
        totalTokens += r.totalTokens || 0;
        sumDuration += r.durationMs || 0;
        if (r.verdict === 'SHIP') passCount++;
        else if (r.verdict === 'BLOCK') blockCount++;
      }

      if (totalReviews > 0) {
        avgReviewDurationMs = Math.round(sumDuration / totalReviews);
        passRatePercent = Number(((passCount / totalReviews) * 100).toFixed(1));
        blockRatePercent = Number(((blockCount / totalReviews) * 100).toFixed(1));
        commentRatePercent = Number((((totalReviews - passCount - blockCount) / totalReviews) * 100).toFixed(1));
      }

      totalSpendUSD = Number(totalSpendUSD.toFixed(3));

      // Build hotspots from findings
      const hotspotMap = new Map<string, { findingsCount: number; p0Count: number }>();
      for (const f of findings) {
        const entry = hotspotMap.get(f.path) || { findingsCount: 0, p0Count: 0 };
        entry.findingsCount++;
        if (f.severity === 'P0') entry.p0Count++;
        hotspotMap.set(f.path, entry);
      }
      findingHotspots = Array.from(hotspotMap.entries())
        .sort((a, b) => b[1].findingsCount - a[1].findingsCount)
        .slice(0, 5)
        .map(([p, stats]) => ({ path: p, findingsCount: stats.findingsCount, p0Count: stats.p0Count }));

      recentActivity = reviews.slice(0, 5).map((r) => ({
        runId: r.id,
        repo: r.repo,
        prNumber: r.prNumber,
        verdict: r.verdict,
        findingsCount: 0,
        durationMs: r.durationMs,
        costUSD: r.spendUsd,
        timestamp: new Date(r.createdAt).toISOString(),
      }));
    } else {
      // Mock test harness fallback
      const days = timeframe === '24h' || timeframe === '1d' ? 1 : timeframe === '30d' ? 30 : 7;
      const scale = days / 7;
      totalReviews = Math.max(1, Math.round(84 * scale));
      p0 = Math.max(0, Math.round(4 * scale));
      p1 = Math.max(0, Math.round(28 * scale));
      p2 = Math.max(0, Math.round(52 * scale));
      totalSpendUSD = Number((2.148 * scale).toFixed(3));
      totalTokens = Math.round(1450200 * scale);
      avgReviewDurationMs = 24800;
      passRatePercent = 88.1;
      blockRatePercent = 4.8;
      commentRatePercent = 7.1;
      topViolatedRules = [
        { rule: 'concurrency.fencing.lease_epoch_validation', count: 18, severity: 'P0' },
        { rule: 'security.credentials.token_redaction', count: 14, severity: 'P1' },
        { rule: 'cache.lifecycle.sub_day_expiration', count: 11, severity: 'P1' },
        { rule: 'config.wrangler.r2_binding_hygiene', count: 9, severity: 'P2' },
        { rule: 'telemetry.audit.action_prefix_required', count: 8, severity: 'P2' },
      ];
      findingHotspots = [
        { path: 'packages/cf-orchestrator/src/worker.ts', findingsCount: 16, p0Count: 2 },
        { path: 'packages/cf-orchestrator/src/reviewRunDO.ts', findingsCount: 12, p0Count: 1 },
        { path: 'packages/cf-orchestrator/scripts/restore-r2-cache.sh', findingsCount: 9, p0Count: 1 },
        { path: 'packages/cf-orchestrator/src/reviewJobWorkflow.ts', findingsCount: 7, p0Count: 0 },
        { path: 'packages/cf-orchestrator/wrangler.toml', findingsCount: 6, p0Count: 0 },
      ];
      recentActivity = [
        {
          runId: 'run_cf_bd36035bf508024da7457527fa0fa4f5',
          repo,
          prNumber: 5290,
          verdict: 'SHIP (Pass)',
          findingsCount: 2,
          durationMs: 18450,
          costUSD: 0.0035,
          timestamp: new Date(Date.now() - 3600000).toISOString(),
        },
        {
          runId: 'run_cf_45ca09576fc84c3f1a9627354e341121',
          repo,
          prNumber: 5262,
          verdict: 'SHIP (Pass)',
          findingsCount: 15,
          durationMs: 248100,
          costUSD: 0.0456,
          timestamp: new Date(Date.now() - 7200000).toISOString(),
        },
        {
          runId: 'run_cf_d94fde4fe8',
          repo,
          prNumber: 5294,
          verdict: 'SHIP (Pass)',
          findingsCount: 1,
          durationMs: 28450,
          costUSD: 0.0056,
          timestamp: new Date(Date.now() - 10800000).toISOString(),
        },
      ];
    }

    const dashboard: AnalyticsDashboardReport = {
      timeframe,
      kpis: {
        totalReviews,
        passRatePercent,
        blockRatePercent,
        commentRatePercent,
        totalFindings: {
          p0,
          p1,
          p2,
          total: p0 + p1 + p2,
        },
        totalSpendUSD,
        totalTokens,
        avgReviewDurationMs,
        r2CacheHitRatePercent: hasDb ? (totalReviews > 0 ? 100 : 0) : 94.2,
      },
      topViolatedRules,
      findingHotspots,
      recentActivity,
      dataSource: hasDb ? 'live_telemetry' : 'baseline_sample_telemetry',
    };

    const kpi = dashboard.kpis;

    const summaryText =
      `### 📈 Review Yeti Executive & Engineering Analytics Dashboard\n\n` +
      `- **Data Source:** \`${dashboard.dataSource}\`\n` +
      `- **Repository:** \`${repo}\` | **Timeframe:** \`${timeframe}\`\n\n` +
      `#### 🎯 Core Key Performance Indicators (KPIs)\n` +
      `| Metric | Value | Target / Benchmark |\n` +
      `|---|---|---|\n` +
      `| **Total PR Reviews** | **${kpi.totalReviews}** | Continuous Automation |\n` +
      `| **Pass Rate (SHIP)** | **${kpi.passRatePercent}%** | > 85% healthy PR flow |\n` +
      `| **Block Rate (P0)** | **${kpi.blockRatePercent}%** | < 10% critical safety gate |\n` +
      `| **Average Turn Duration** | **${formatDuration(kpi.avgReviewDurationMs)}** | < 30s target |\n` +
      `| **R2 Workspace Cache Hit Rate** | **${kpi.r2CacheHitRatePercent}%** | > 90% (sub-1.5s unpack) |\n` +
      `| **Total Cloud Compute Spend** | **${formatCostUsd(kpi.totalSpendUSD)} USD** | > 85% savings vs DOKS |\n` +
      `| **Total Tokens Consumed** | **${(kpi.totalTokens / 1_000_000).toFixed(2)}M tokens** | Efficient diff targeting |\n\n` +
      `#### 🚨 Top Rule Violations\n` +
      dashboard.topViolatedRules
        .map((r, i) => `${i + 1}. \`${r.rule}\` [${r.severity}]: **${r.count} violations**`)
        .join('\n') +
      `\n\n` +
      `#### 🔥 Code Hotspots (Most Findings)\n` +
      dashboard.findingHotspots
        .map((h, i) => `${i + 1}. \`${h.path}\`: **${h.findingsCount} findings** (${h.p0Count} blockers)`)
        .join('\n') +
      `\n\n` +
      `#### 🕒 Recent Review Activity\n` +
      dashboard.recentActivity
        .map(
          (a) =>
            `- PR **#${a.prNumber}** (\`${a.runId.slice(0, 16)}...\`): **${a.verdict}** in ${formatDuration(
              a.durationMs
            )} (${a.findingsCount} findings, ${formatCostUsd(a.costUSD)})`
        )
        .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: summaryText,
        },
        {
          type: 'text',
          text: JSON.stringify(dashboard, null, 2),
        },
      ],
    };
  },
};
