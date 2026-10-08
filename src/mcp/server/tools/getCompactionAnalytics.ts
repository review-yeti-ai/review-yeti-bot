import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  GetCompactionAnalyticsInputSchema,
  type GetCompactionAnalyticsInput,
} from './schemas';
import { dashboardStore } from '../../../persistence/dashboardStore';

export const getCompactionAnalyticsDefinition: ToolDefinition = {
  name: 'get_compaction_analytics',
  description: 'Query unbounded AST streaming and context compaction analytics, including diff eviction receipts, get_hunk retrieval frequency, and compression ratios.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Repository name filter' },
      window_hours: { type: 'number', description: 'Evaluation window in hours (default: 168 / 7d)' },
    },
    additionalProperties: false,
  },
};

export function createGetCompactionAnalyticsTool() {
  return {
    definition: getCompactionAnalyticsDefinition,
    schema: GetCompactionAnalyticsInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = GetCompactionAnalyticsInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { repo, window_hours = 168 } = parsed.data;
      const range = window_hours <= 24 ? '24h' : window_hours <= 168 ? '7d' : '30d';

      const metrics = dashboardStore.getCompactionAnalytics(range, repo);

      return buildToolResultJson({
        repo: repo || undefined,
        window_hours,
        data_source: 'ast_outline_diff_compaction_engine',
        total_reviews: metrics.totalReviews,
        raw_diff_tokens_avg: metrics.rawDiffTokensAvg,
        compacted_tokens_avg: metrics.compactedTokensAvg,
        compaction_ratio: metrics.compactionRatio,
        tokens_saved_total: metrics.tokensSavedTotal,
        diff_eviction_receipts_count: metrics.diffEvictionReceiptsCount,
        get_hunk_invocations_count: metrics.getHunkInvocationsCount,
        ast_outline_coverage_percent: metrics.astOutlineCoveragePercent,
        flat_context_slope_confirmed: metrics.flatContextSlopeConfirmed,
        max_pr_tokens_handled: metrics.maxPrTokensHandled,
        hard_context_limit_abolished: true,
      });
    },
  };
}
