/**
 * Type definitions for Review Yeti Executive & Engineering Analytics Dashboard (M4 / R3).
 */

export type AnalyticsTimeRange = '24h' | '7d' | '30d';

export interface AnalyticsFilterParams {
  range?: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
}

export interface FindingSeverityRatio {
  p0: number;
  p1: number;
  p2: number;
}

export interface AnalyticsSummaryData {
  totalReviews: number;
  totalPrs?: number;
  p95DurationMs: number;
  avgDurationMs: number;
  avgLatencyMs?: number;
  totalSpendUsd: number;
  totalTokens: number;
  totalFindings?: number;
  successRate: number;
  findingSeverityRatio: FindingSeverityRatio;
  acceptanceRate: number;
  dismissalRate?: number;
  activeRepositories?: number;
  memoryRulesCount?: number;
  checkpointHitRatePercent?: number;
  zeroTokenReplaySavingsTokens?: number;
  compactionRatio?: number;
  recheckLaneRuns?: number;
  blockerFastPathCount?: number;
  range: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
  timestamp?: string;
  previousPeriod?: {
    p95DurationMs: number;
    totalSpendUsd: number;
    totalTokens: number;
    acceptanceRate: number;
  };
}

export interface LatencyTimeBucket {
  timestamp: string;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  avg: number;
  count: number;
}

export interface LatencyMetricPoint {
  timestamp: string;
  label?: string;
  p95DurationMs: number;
  p50DurationMs?: number;
  avgDurationMs?: number;
  reviewCount: number;
}

export interface LatencyMetricsResponse {
  success?: boolean;
  range: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
  p50DurationMs: number;
  p90DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  minDurationMs?: number;
  maxDurationMs?: number;
  avgDurationMs?: number;
  totalReviews?: number;
  timeBuckets?: LatencyTimeBucket[];
  data?: LatencyMetricPoint[];
}

export interface RepoSpendItem {
  repo: string;
  spendUsd: number;
  reviewCount: number;
  avgSpendPerPR: number;
  totalTokens: number;
}

export interface ModelSpendItem {
  model: string;
  displayName: string;
  providerId?: string;
  spendUsd: number;
  percentage?: number;
  callCount?: number;
  tokens?: {
    prompt: number;
    completion: number;
  };
  promptTokens?: number;
  completionTokens?: number;
}

export interface CostBreakdownResponse {
  success?: boolean;
  range?: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  totalSpendUsd: number;
  monthlyBudgetUsd: number;
  budgetPercentUsed: number;
  breakdown: ModelSpendItem[];
  byRepo?: RepoSpendItem[];
  repoBreakdown?: RepoSpendItem[];
}

export interface TokenBurnPoint {
  timestamp: string;
  label?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cumulativeTokens: number;
  budgetLimit?: number;
}

export interface TokenBurnResponse extends Array<TokenBurnPoint> {
  success?: boolean;
  range: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  interval?: string;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  data: TokenBurnPoint[];
}

export interface FindingSeverityCounts {
  P0: number;
  P1: number;
  P2: number;
}

export interface FindingsQualityResponse {
  success?: boolean;
  range: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  totalFindings: number;
  activeFindings?: number;
  dismissedFindings?: number;
  resolvedFindings?: number;
  severityCounts: FindingSeverityCounts;
  severityRatio: FindingSeverityRatio;
  acceptanceRate: number;
  dismissalRate: number;
  acceptedCount?: number;
  dismissedCount?: number;
  dismissalReasons?: Record<string, number>;
  categoryDistribution?: Record<string, number>;
}

export interface CheckpointRepoStats {
  repo: string;
  totalSubtasks: number;
  cacheHits: number;
  cacheMisses: number;
  hitRatePercent: number;
  zeroTokenReplaySavingsTokens: number;
  savedLatencyMs: number;
}

export interface CheckpointMetricsResponse {
  success?: boolean;
  range: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
  totalSubtasks: number;
  cacheHits: number;
  cacheMisses: number;
  hitRatePercent: number;
  zeroTokenReplaysCount: number;
  tokensSavedTotal: number;
  estimatedCostSavedUSD: number;
  avgLatencySavedMs: number;
  byRepo?: CheckpointRepoStats[];
  byLane?: Record<string, { hits: number; misses: number; hitRate: number }>;
}

export interface CompactionAnalyticsResponse {
  success?: boolean;
  range: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
  totalReviews: number;
  rawDiffTokensAvg: number;
  compactedTokensAvg: number;
  compactionRatio: number;
  tokensSavedTotal: number;
  diffEvictionReceiptsCount: number;
  getHunkInvocationsCount: number;
  astOutlineCoveragePercent: number;
  flatContextSlopeConfirmed: boolean;
  maxPrTokensHandled: number;
}

export interface IncrementalLifecycleResponse {
  success?: boolean;
  range: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
  recheckLaneRuns: number;
  catch22Preventions: number;
  findingsAutoResolvedCount: number;
  findingsRegressedCount: number;
  resolutionRatePercent: number;
  avgCommitsToResolution: number;
  priorOpenFindingsTracked: number;
}

export interface BlockerFastPathMetricsResponse {
  success?: boolean;
  range: AnalyticsTimeRange;
  window?: AnalyticsTimeRange;
  repo?: string;
  totalFastPathExits: number;
  abortedStreamsCount: number;
  tokensSavedFromAbort: number;
  estimatedCostSavedUSD: number;
  avgTimeToBlockerMs: number;
  normalQuorumLatencyAvgMs: number;
  latencyReductionPercent: number;
  reasonsBreakdown: Record<string, number>;
}
