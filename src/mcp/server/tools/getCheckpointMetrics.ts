import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  GetCheckpointMetricsInputSchema,
  type GetCheckpointMetricsInput,
} from './schemas';
import { dashboardStore } from '../../../persistence/dashboardStore';

export const getCheckpointMetricsDefinition: ToolDefinition = {
  name: 'get_checkpoint_metrics',
  description: 'Inspect content-addressed checkpoint cache statistics, zero-token rebase replay rates, and token/latency savings for repositories and PR reviews.',
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Repository name filter (e.g. reviewyeti-ai/review-yeti-bot)' },
      window_hours: { type: 'number', description: 'Evaluation window in hours (default: 168 / 7d)' },
    },
    additionalProperties: false,
  },
};

export function createGetCheckpointMetricsTool() {
  return {
    definition: getCheckpointMetricsDefinition,
    schema: GetCheckpointMetricsInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = GetCheckpointMetricsInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { repo, window_hours = 168 } = parsed.data;
      const range = window_hours <= 24 ? '24h' : window_hours <= 168 ? '7d' : '30d';

      const metrics = dashboardStore.getCheckpointMetrics(range, repo);

      return buildToolResultJson({
        repo: repo || undefined,
        window_hours,
        data_source: 'content_addressed_checkpoint_engine',
        total_subtasks_evaluated: metrics.totalSubtasks,
        cache_hits: metrics.cacheHits,
        cache_misses: metrics.cacheMisses,
        hit_rate_percent: metrics.hitRatePercent,
        zero_token_replays_count: metrics.zeroTokenReplaysCount,
        tokens_saved_total: metrics.tokensSavedTotal,
        estimated_cost_saved_usd: metrics.estimatedCostSavedUSD,
        avg_latency_saved_ms: metrics.avgLatencySavedMs,
        by_lane: metrics.byLane,
        by_repo: metrics.byRepo,
      });
    },
  };
}
