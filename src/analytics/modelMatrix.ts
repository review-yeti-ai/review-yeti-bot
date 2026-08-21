import { Modality, OpenRouterModelSpec, openRouterModelService } from '../services/openRouterModelService';

export type BenchmarkType = 'verified' | 'lite';
export type ModelMatrixSortField = 'swe-score' | 'cost' | 'context' | 'efficiency' | 'name';
export type SortOrder = 'asc' | 'desc';

export interface SWEBenchModelScore {
  modelId: string;
  canonicalName: string;
  provider: string;
  verifiedScorePercent: number;
  liteScorePercent: number;
  evalFramework?: string;
  lastUpdated: string;
  aliases?: string[];
}

export interface ModelMatrixEntry {
  id: string;
  name: string;
  provider: string;
  description?: string;
  contextLength: number;
  maxCompletionTokens?: number;
  promptCostPer1M: number;
  completionCostPer1M: number;
  totalCostPer1M: number;
  averageCostPer1M: number;
  blendedCostPer1M: number;
  modalities: Modality[];
  sweScoreVerified: number;
  sweScoreLite: number;
  activeSweScore: number;
  costEfficiency: number;
  evalFramework?: string;
  hasBenchmarkData: boolean;
  isFallback: boolean;
  fetchedAt: number;
}

export interface ModelMatrixQueryOptions {
  benchmarkType?: BenchmarkType;
  minScore?: number;
  maxCostPer1M?: number;
  minContext?: number;
  modality?: Modality;
  query?: string;
  sortBy?: ModelMatrixSortField;
  sortOrder?: SortOrder;
  limit?: number;
  forceRefresh?: boolean;
}

export interface ModelMatrixResult {
  entries: ModelMatrixEntry[];
  totalModels: number;
  benchmarkType: BenchmarkType;
  bestScoreModel: ModelMatrixEntry | null;
  bestEfficiencyModel: ModelMatrixEntry | null;
  cheapestModel: ModelMatrixEntry | null;
  summary: {
    avgScore: number;
    avgBlendedCostPer1M: number;
    avgEfficiency: number;
    modelsWithBenchmarkDataCount: number;
    isUsingFallbackPricing: boolean;
  };
  timestamp: number;
}

export const SWE_BENCH_DATASET: Record<string, SWEBenchModelScore> = {
  'claude-3.7-sonnet': {
    modelId: 'claude-3.7-sonnet',
    canonicalName: 'Claude 3.7 Sonnet',
    provider: 'Anthropic',
    verifiedScorePercent: 70.3,
    liteScorePercent: 64.9,
    evalFramework: 'Hybrid Reasoning Agentic',
    lastUpdated: '2025-02-25',
    aliases: ['openrouter/anthropic/claude-3.7-sonnet', 'anthropic/claude-3.7-sonnet'],
  },
  'gemini-2.5-pro': {
    modelId: 'gemini-2.5-pro',
    canonicalName: 'Gemini 2.5 Pro',
    provider: 'Google',
    verifiedScorePercent: 63.8,
    liteScorePercent: 59.2,
    evalFramework: 'Direct Agentic',
    lastUpdated: '2025-02-15',
    aliases: ['openrouter/google/gemini-2.5-pro', 'google/gemini-2.5-pro'],
  },
  'openrouter/auto': {
    modelId: 'openrouter/auto',
    canonicalName: 'OpenRouter Auto Router',
    provider: 'OpenRouter',
    verifiedScorePercent: 52.0,
    liteScorePercent: 46.5,
    evalFramework: 'Auto-Routing Aggregate',
    lastUpdated: '2025-01-20',
    aliases: ['auto'],
  },
  'deepseek-r1': {
    modelId: 'deepseek-r1',
    canonicalName: 'DeepSeek R1',
    provider: 'DeepSeek',
    verifiedScorePercent: 49.2,
    liteScorePercent: 41.6,
    evalFramework: 'Open Reasoning',
    lastUpdated: '2025-01-22',
    aliases: ['openrouter/deepseek/deepseek-r1', 'deepseek/deepseek-r1'],
  },
  'claude-3.5-sonnet': {
    modelId: 'claude-3.5-sonnet',
    canonicalName: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    verifiedScorePercent: 49.0,
    liteScorePercent: 43.4,
    evalFramework: 'SWE-agent / Direct',
    lastUpdated: '2024-10-22',
    aliases: ['openrouter/anthropic/claude-3.5-sonnet', 'anthropic/claude-3.5-sonnet', 'claude-3-5-sonnet'],
  },
  'deepseek-v3': {
    modelId: 'deepseek-v3',
    canonicalName: 'DeepSeek V3',
    provider: 'DeepSeek',
    verifiedScorePercent: 48.4,
    liteScorePercent: 42.0,
    evalFramework: 'Direct MoE 671B',
    lastUpdated: '2024-12-26',
    aliases: ['openrouter/deepseek/deepseek-v3', 'deepseek/deepseek-v3'],
  },
  'gpt-4o': {
    modelId: 'gpt-4o',
    canonicalName: 'GPT-4o',
    provider: 'OpenAI',
    verifiedScorePercent: 38.8,
    liteScorePercent: 33.2,
    evalFramework: 'SWE-agent Direct',
    lastUpdated: '2024-05-13',
    aliases: ['openrouter/openai/gpt-4o', 'openai/gpt-4o'],
  },
  'qwen-2.5-72b': {
    modelId: 'qwen-2.5-72b-instruct',
    canonicalName: 'Qwen 2.5 72B Instruct',
    provider: 'Qwen',
    verifiedScorePercent: 38.0,
    liteScorePercent: 33.4,
    evalFramework: 'Direct Evaluation',
    lastUpdated: '2024-09-19',
    aliases: ['openrouter/qwen/qwen-2.5-72b-instruct', 'qwen/qwen-2.5-72b-instruct'],
  },
  'llama-3.3-70b': {
    modelId: 'llama-3.3-70b-instruct',
    canonicalName: 'Llama 3.3 70B Instruct',
    provider: 'Meta',
    verifiedScorePercent: 35.8,
    liteScorePercent: 29.5,
    evalFramework: 'Direct Evaluation',
    lastUpdated: '2024-12-06',
    aliases: ['openrouter/meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.3-70b-instruct'],
  },
  'gemini-2.0-flash-lite': {
    modelId: 'gemini-2.0-flash-lite-001',
    canonicalName: 'Gemini 2.0 Flash Lite',
    provider: 'Google',
    verifiedScorePercent: 28.5,
    liteScorePercent: 24.0,
    evalFramework: 'Direct Evaluation',
    lastUpdated: '2025-02-05',
    aliases: ['openrouter/google/gemini-2.0-flash-lite-001', 'google/gemini-2.0-flash-lite-001'],
  },
  'gpt-4o-mini': {
    modelId: 'gpt-4o-mini',
    canonicalName: 'GPT-4o Mini',
    provider: 'OpenAI',
    verifiedScorePercent: 26.2,
    liteScorePercent: 20.5,
    evalFramework: 'SWE-agent Direct',
    lastUpdated: '2024-07-18',
    aliases: ['openrouter/openai/gpt-4o-mini', 'openai/gpt-4o-mini'],
  },
};

function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

export function lookupSWEBenchScore(modelId: string): SWEBenchModelScore | null {
  if (!modelId) return null;
  const cleanId = modelId.trim();

  // 1. Direct key match
  if (SWE_BENCH_DATASET[cleanId]) {
    return SWE_BENCH_DATASET[cleanId];
  }

  const cleanLower = cleanId.toLowerCase();
  const baseIdLower = cleanLower.split(':')[0];

  // 2. Check modelId field & aliases exact match
  for (const key of Object.keys(SWE_BENCH_DATASET)) {
    const entry = SWE_BENCH_DATASET[key];
    if (entry.modelId.toLowerCase() === cleanLower || entry.modelId.toLowerCase() === baseIdLower) {
      return entry;
    }
    if (
      entry.aliases &&
      entry.aliases.some(
        (alias) => alias.toLowerCase() === cleanLower || alias.toLowerCase() === baseIdLower
      )
    ) {
      return entry;
    }
  }

  // 3. Suffix / prefix matching
  for (const key of Object.keys(SWE_BENCH_DATASET)) {
    const entry = SWE_BENCH_DATASET[key];
    const candidates = [key, entry.modelId, ...(entry.aliases || [])];
    for (const cand of candidates) {
      const candLower = cand.toLowerCase();
      if (
        cleanLower === candLower ||
        baseIdLower === candLower ||
        cleanLower.endsWith(`/${candLower}`) ||
        candLower.endsWith(`/${cleanLower}`) ||
        baseIdLower.endsWith(`/${candLower}`) ||
        candLower.endsWith(`/${baseIdLower}`)
      ) {
        return entry;
      }
    }
  }

  return null;
}

function deriveProvider(spec: OpenRouterModelSpec, benchScore: SWEBenchModelScore | null): string {
  if (benchScore?.provider) {
    return benchScore.provider;
  }

  const idLower = spec.id.toLowerCase();
  if (idLower.includes('anthropic')) return 'Anthropic';
  if (idLower.includes('google')) return 'Google';
  if (idLower.includes('openai')) return 'OpenAI';
  if (idLower.includes('deepseek')) return 'DeepSeek';
  if (idLower.includes('meta') || idLower.includes('llama')) return 'Meta';
  if (idLower.includes('qwen')) return 'Qwen';
  if (idLower.includes('openrouter') || idLower === 'auto') return 'OpenRouter';

  if (spec.name.includes(':')) {
    return spec.name.split(':')[0].trim();
  }

  return 'Unknown';
}

export async function buildModelMatrix(
  options?: ModelMatrixQueryOptions,
  serviceOverride?: { getModels: (opts?: { forceRefresh?: boolean }) => Promise<OpenRouterModelSpec[]> }
): Promise<ModelMatrixResult> {
  const benchmarkType = options?.benchmarkType ?? 'verified';
  const sortBy = options?.sortBy ?? 'swe-score';

  const defaultSortOrderMap: Record<ModelMatrixSortField, SortOrder> = {
    'swe-score': 'desc',
    cost: 'asc',
    efficiency: 'desc',
    context: 'desc',
    name: 'asc',
  };
  const sortOrder = options?.sortOrder ?? defaultSortOrderMap[sortBy];

  const fetcher = serviceOverride || openRouterModelService;
  const rawSpecs = await fetcher.getModels({ forceRefresh: options?.forceRefresh });

  let entries: ModelMatrixEntry[] = rawSpecs.map((spec) => {
    const benchScore = lookupSWEBenchScore(spec.id);
    const sweScoreVerified = benchScore ? benchScore.verifiedScorePercent : 0;
    const sweScoreLite = benchScore ? benchScore.liteScorePercent : 0;
    const activeSweScore = benchmarkType === 'lite' ? sweScoreLite : sweScoreVerified;

    const promptCostPer1M = spec.promptCostPer1M;
    const completionCostPer1M = spec.completionCostPer1M;
    const totalCostPer1M = roundTo(promptCostPer1M + completionCostPer1M, 6);
    const averageCostPer1M = roundTo((promptCostPer1M + completionCostPer1M) / 2, 6);
    const blendedCostPer1M = roundTo((3 * promptCostPer1M + completionCostPer1M) / 4, 6);

    const costEfficiency =
      blendedCostPer1M > 0 ? roundTo(activeSweScore / blendedCostPer1M, 4) : activeSweScore * 1000;

    const provider = deriveProvider(spec, benchScore);

    return {
      id: spec.id,
      name: spec.name,
      provider,
      description: spec.description,
      contextLength: spec.contextLength,
      maxCompletionTokens: spec.maxCompletionTokens,
      promptCostPer1M,
      completionCostPer1M,
      totalCostPer1M,
      averageCostPer1M,
      blendedCostPer1M,
      modalities: spec.modalities,
      sweScoreVerified,
      sweScoreLite,
      activeSweScore,
      costEfficiency,
      evalFramework: benchScore?.evalFramework,
      hasBenchmarkData: benchScore !== null,
      isFallback: spec.isFallback,
      fetchedAt: spec.fetchedAt,
    };
  });

  // Filter entries
  if (options?.minScore !== undefined) {
    entries = entries.filter((e) => e.activeSweScore >= options.minScore!);
  }
  if (options?.maxCostPer1M !== undefined) {
    entries = entries.filter((e) => e.blendedCostPer1M <= options.maxCostPer1M!);
  }
  if (options?.minContext !== undefined) {
    entries = entries.filter((e) => e.contextLength >= options.minContext!);
  }
  if (options?.modality !== undefined) {
    entries = entries.filter((e) => e.modalities.includes(options.modality!));
  }
  if (options?.query !== undefined && options.query.trim().length > 0) {
    const q = options.query.trim().toLowerCase();
    entries = entries.filter(
      (e) =>
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.provider.toLowerCase().includes(q) ||
        (e.description && e.description.toLowerCase().includes(q))
    );
  }

  const matchingCount = entries.length;

  // Sort entries
  const orderFactor = sortOrder === 'asc' ? 1 : -1;
  entries.sort((a, b) => {
    let primaryDiff = 0;
    let secondaryDiff = 0;

    switch (sortBy) {
      case 'swe-score':
        primaryDiff = a.activeSweScore - b.activeSweScore;
        secondaryDiff = b.costEfficiency - a.costEfficiency;
        break;
      case 'cost':
        primaryDiff = a.blendedCostPer1M - b.blendedCostPer1M;
        secondaryDiff = b.activeSweScore - a.activeSweScore;
        break;
      case 'efficiency':
        primaryDiff = a.costEfficiency - b.costEfficiency;
        secondaryDiff = b.activeSweScore - a.activeSweScore;
        break;
      case 'context':
        primaryDiff = a.contextLength - b.contextLength;
        secondaryDiff = b.activeSweScore - a.activeSweScore;
        break;
      case 'name':
        primaryDiff = a.name.localeCompare(b.name);
        secondaryDiff = a.id.localeCompare(b.id);
        break;
    }

    if (primaryDiff !== 0) {
      return primaryDiff * orderFactor;
    }
    return secondaryDiff;
  });

  // Calculate best metrics over matching entries before applying limit
  const bestScoreModel =
    entries.length > 0
      ? [...entries].sort((a, b) => b.activeSweScore - a.activeSweScore || b.costEfficiency - a.costEfficiency)[0]
      : null;

  const bestEfficiencyModel =
    entries.length > 0
      ? [...entries].sort((a, b) => b.costEfficiency - a.costEfficiency || b.activeSweScore - a.activeSweScore)[0]
      : null;

  const cheapestModel =
    entries.length > 0
      ? [...entries].sort((a, b) => a.blendedCostPer1M - b.blendedCostPer1M || b.activeSweScore - a.activeSweScore)[0]
      : null;

  const totalScoreSum = entries.reduce((sum, e) => sum + e.activeSweScore, 0);
  const totalBlendedCostSum = entries.reduce((sum, e) => sum + e.blendedCostPer1M, 0);
  const totalEfficiencySum = entries.reduce((sum, e) => sum + e.costEfficiency, 0);
  const modelsWithBenchmarkDataCount = entries.filter((e) => e.hasBenchmarkData).length;
  const isUsingFallbackPricing = entries.some((e) => e.isFallback);

  // Apply limit if specified
  const returnedEntries =
    options?.limit !== undefined && options.limit > 0 ? entries.slice(0, options.limit) : entries;

  return {
    entries: returnedEntries,
    totalModels: matchingCount,
    benchmarkType,
    bestScoreModel,
    bestEfficiencyModel,
    cheapestModel,
    summary: {
      avgScore: matchingCount > 0 ? roundTo(totalScoreSum / matchingCount, 2) : 0,
      avgBlendedCostPer1M: matchingCount > 0 ? roundTo(totalBlendedCostSum / matchingCount, 4) : 0,
      avgEfficiency: matchingCount > 0 ? roundTo(totalEfficiencySum / matchingCount, 2) : 0,
      modelsWithBenchmarkDataCount,
      isUsingFallbackPricing,
    },
    timestamp: Date.now(),
  };
}

export async function getBestModelForBudget(
  maxCostPer1M: number,
  minScore?: number,
  benchmarkType?: BenchmarkType
): Promise<ModelMatrixEntry | null> {
  const result = await buildModelMatrix({
    maxCostPer1M,
    minScore,
    benchmarkType,
    sortBy: 'swe-score',
    sortOrder: 'desc',
  });
  return result.entries[0] ?? null;
}

export async function getMostEfficientModel(
  minScore?: number,
  benchmarkType?: BenchmarkType
): Promise<ModelMatrixEntry | null> {
  const result = await buildModelMatrix({
    minScore,
    benchmarkType,
    sortBy: 'efficiency',
    sortOrder: 'desc',
  });
  return result.entries[0] ?? null;
}

export function formatModelMatrixTable(result: ModelMatrixResult): string {
  const lines: string[] = [];
  lines.push('=== SWE-BENCH PERFORMANCE MATRIX & COST METRICS ===');
  lines.push(
    `Benchmark Type: ${result.benchmarkType.toUpperCase()} | Total Models: ${result.totalModels} | Using Fallback Pricing: ${
      result.summary.isUsingFallbackPricing ? 'Yes' : 'No'
    }`
  );
  lines.push(
    `Avg Score: ${result.summary.avgScore.toFixed(2)}% | Avg Blended Cost/1M: $${result.summary.avgBlendedCostPer1M.toFixed(
      4
    )} | Avg Efficiency: ${result.summary.avgEfficiency.toFixed(2)}`
  );
  lines.push('');

  if (result.entries.length === 0) {
    lines.push('No models found matching criteria.');
    return lines.join('\n');
  }

  const headers = ['MODEL ID', 'PROVIDER', 'SWE-BENCH (%)', 'BLENDED COST/1M ($)', 'EFFICIENCY', 'CONTEXT'];
  const rows: string[][] = result.entries.map((e) => [
    e.id,
    e.provider,
    `${e.activeSweScore.toFixed(1)}%`,
    `$${e.blendedCostPer1M.toFixed(4)}`,
    e.costEfficiency.toFixed(2),
    e.contextLength.toLocaleString(),
  ]);

  const colWidths = headers.map((h, i) => {
    let maxLen = h.length;
    for (const row of rows) {
      if (row[i] && row[i].length > maxLen) {
        maxLen = row[i].length;
      }
    }
    return maxLen;
  });

  const formatRow = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(colWidths[i])).join('  |  ');

  const separator = colWidths.map((w) => '-'.repeat(w)).join('--+--');

  lines.push(formatRow(headers));
  lines.push(separator);
  for (const row of rows) {
    lines.push(formatRow(row));
  }

  return lines.join('\n');
}

export function formatModelMatrixJSON(result: ModelMatrixResult, pretty = true): string {
  return JSON.stringify(result, null, pretty ? 2 : undefined);
}

export function formatModelMatrixMarkdown(result: ModelMatrixResult): string {
  const lines: string[] = [];
  lines.push('# SWE-bench Performance & Cost Efficiency Matrix');
  lines.push('');
  lines.push(`- **Benchmark Type**: ${result.benchmarkType.toUpperCase()}`);
  lines.push(`- **Total Models Analyzed**: ${result.totalModels}`);
  lines.push(`- **Average SWE-bench Score**: ${result.summary.avgScore.toFixed(2)}%`);
  lines.push(`- **Average Blended Cost / 1M Tokens**: $${result.summary.avgBlendedCostPer1M.toFixed(4)}`);
  lines.push(`- **Average Cost Efficiency**: ${result.summary.avgEfficiency.toFixed(2)}`);
  lines.push('');

  if (result.entries.length === 0) {
    lines.push('_No models found matching criteria._');
    return lines.join('\n');
  }

  lines.push('| Model ID | Provider | SWE-bench Score | Blended Cost/1M | Cost Efficiency | Context Window |');
  lines.push('|---|---|---|---|---|---|');
  for (const e of result.entries) {
    lines.push(
      `| ${e.id} | ${e.provider} | ${e.activeSweScore.toFixed(1)}% | $${e.blendedCostPer1M.toFixed(
        4
      )} | ${e.costEfficiency.toFixed(2)} | ${e.contextLength.toLocaleString()} |`
    );
  }

  return lines.join('\n');
}
