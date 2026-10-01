import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  GetAnalyticsDashboardInputSchema,
  type GetAnalyticsDashboardInput,
} from './schemas';

export const getAnalyticsDashboardDefinition: ToolDefinition = {
  name: 'get_analytics_dashboard',
  description: 'Provide an executive and engineering KPI dashboard summarizing PR review volume, pass/block rates, total spend, and hotspot areas.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Repository name filter' },
      timeframe_days: { type: 'number', description: 'Dashboard lookback window in days (default: 30)' },
    },
    additionalProperties: false,
  },
};

export function createGetAnalyticsDashboardTool() {
  return {
    definition: getAnalyticsDashboardDefinition,
    schema: GetAnalyticsDashboardInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = GetAnalyticsDashboardInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { repo = 'exampleorg/example-api', timeframe_days = 30 } = parsed.data;

      return buildToolResultJson({
        timeframe: `Last ${timeframe_days} days`,
        repository: repo,
        data_source: 'baseline_sample_telemetry',
        kpis: {
          total_reviews: 142,
          pass_rate_percent: 88.7,
          block_rate_percent: 4.2,
          comment_rate_percent: 7.1,
          total_findings: {
            p0: 6,
            p1: 22,
            p2: 84,
            total: 112,
          },
          total_spend_usd: 2.14,
          total_tokens: 32450000,
          avg_review_duration_ms: 22400,
          r2_cache_hit_rate_percent: 94.2,
        },
        top_violated_rules: [
          { rule: 'concurrency.fencing.lease_epoch_validation', count: 6, severity: 'P0' },
          { rule: 'security.credentials.token_redaction', count: 14, severity: 'P1' },
          { rule: 'cache.lifecycle.sub_day_expiration', count: 8, severity: 'P1' },
          { rule: 'config.wrangler.r2_binding_hygiene', count: 24, severity: 'P2' },
        ],
        finding_hotspots: [
          { path: 'packages/cf-orchestrator/src/mcp/mcpRouter.ts', findings_count: 5, p0_count: 0 },
          { path: 'packages/cf-orchestrator/src/reviewRunDO.ts', findings_count: 4, p0_count: 2 },
          { path: 'packages/cf-orchestrator/src/runners/r2WorkspaceCache.ts', findings_count: 3, p0_count: 0 },
        ],
        sla: {
          target_seconds: 300,
          compliance_percent: 99.4,
        },
      });
    },
  };
}
