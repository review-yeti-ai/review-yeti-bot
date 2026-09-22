import {
  type ToolDefinition,
  type ToolResult,
  buildToolResultJson,
} from '../mcpTypes';
import {
  GetModelMatrixInputSchema,
  type GetModelMatrixInput,
  type ModelMatrixOutput,
} from './schemas';
import { buildModelMatrix, type ModelMatrixQueryOptions, type ModelMatrixResult } from '../../../analytics/modelMatrix';

export const getModelMatrixDefinition: ToolDefinition = {
  name: 'get_model_matrix',
  description: 'Query SWE-bench routing table, capability scores, and token pricing.',
  inputSchema: {
    type: 'object',
    properties: {
      benchmark_type: {
        type: 'string',
        enum: ['verified', 'lite'],
        default: 'verified',
        description: 'SWE-bench evaluation benchmark suite',
      },
      sort_by: {
        type: 'string',
        enum: ['swe-score', 'cost', 'efficiency', 'context', 'name'],
        default: 'swe-score',
        description: 'Field to sort model routing matrix by',
      },
      limit: {
        type: 'number',
        default: 20,
        description: 'Maximum number of models to return (1-100)',
      },
    },
    additionalProperties: false,
  },
};

export function createGetModelMatrixTool(matrixBuilder: (options?: ModelMatrixQueryOptions) => Promise<ModelMatrixResult> = buildModelMatrix) {
  return {
    definition: getModelMatrixDefinition,
    schema: GetModelMatrixInputSchema,
    execute: async (rawArgs: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = GetModelMatrixInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { benchmark_type = 'verified', sort_by = 'swe-score', limit = 20 } = parsed.data;

      const result = await matrixBuilder({
        benchmarkType: benchmark_type,
        sortBy: sort_by,
        limit,
      });

      const models = result.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        description: entry.description,
        context_length: entry.contextLength,
        max_completion_tokens: entry.maxCompletionTokens,
        swe_score: entry.activeSweScore,
        swe_score_verified: entry.sweScoreVerified,
        swe_score_lite: entry.sweScoreLite,
        prompt_cost_per_1m: entry.promptCostPer1M,
        completion_cost_per_1m: entry.completionCostPer1M,
        total_cost_per_1m: entry.totalCostPer1M,
        blended_cost_per_1m: entry.blendedCostPer1M,
        cost_efficiency: entry.costEfficiency,
        eval_framework: entry.evalFramework,
        has_benchmark_data: entry.hasBenchmarkData,
        is_fallback: entry.isFallback,
      }));

      const summary = {
        avg_score: result.summary.avgScore,
        avg_blended_cost_per_1m: result.summary.avgBlendedCostPer1M,
        avg_efficiency: result.summary.avgEfficiency,
        models_with_benchmark_data_count: result.summary.modelsWithBenchmarkDataCount,
        is_using_fallback_pricing: result.summary.isUsingFallbackPricing,
        best_score_model: result.bestScoreModel
          ? {
              id: result.bestScoreModel.id,
              name: result.bestScoreModel.name,
              score: result.bestScoreModel.activeSweScore,
            }
          : null,
        best_efficiency_model: result.bestEfficiencyModel
          ? {
              id: result.bestEfficiencyModel.id,
              name: result.bestEfficiencyModel.name,
              efficiency: result.bestEfficiencyModel.costEfficiency,
            }
          : null,
        cheapest_model: result.cheapestModel
          ? {
              id: result.cheapestModel.id,
              name: result.cheapestModel.name,
              blended_cost: result.cheapestModel.blendedCostPer1M,
            }
          : null,
      };

      return buildToolResultJson({
        benchmark_type: result.benchmarkType,
        total_models: result.totalModels,
        returned_models: models.length,
        models,
        summary,
        timestamp: result.timestamp,
      } satisfies ModelMatrixOutput);
    },
  };
}
