/**
 * MCP (Model Context Protocol) JSON-RPC 2.0 and Review Yeti Tool Definitions
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'review-yeti-cf-orchestrator';
export const MCP_SERVER_VERSION = '1.0.0';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface McpExecutionContext {
  env?: any;
  callerIdentity?: string;
  now?: () => number;
}

export interface McpToolHandler {
  definition: ToolDefinition;
  execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult>;
}

// -------------------------------------------------------------
// Tool Payloads & Domain Data Models
// -------------------------------------------------------------

export interface ActiveJobItem {
  runId: string;
  repo: string;
  owner: string;
  prNumber: number;
  commitSha: string;
  phase: string;
  orchestrator: 'cloudflare' | 'doks';
  runner: 'digitalocean-agent' | 'cloudflare-container' | 'doks-pod';
  fencingEpoch?: number;
  workerId?: string;
  leaseAgeMs?: number;
  startedAt?: string;
  durationMs?: number;
}

export interface ReviewFindingItem {
  findingId?: string;
  runId?: string;
  repo: string;
  prNumber: number;
  path: string;
  line: number;
  endLine?: number;
  severity: 'P0' | 'P1' | 'P2';
  title: string;
  rule: string;
  body: string;
  suggestedPatch?: string;
  status: 'open' | 'disputed' | 'dismissed' | 'resolved';
  authorPersona?: string;
}

export interface CloudflareStatusReport {
  timestamp: string;
  environment: string;
  parallelMode: boolean;
  repoGate: {
    activeSlotsUsed: number;
    concurrencyCap: number;
    activeRuns: Array<{ prNumber: number; runId: string }>;
    queueDepth: number;
    queuedPrs: number[];
  };
  reviewRuns: {
    activeLeases: number;
    fencingEpochsTotal: number;
  };
  r2WorkspaceCache: {
    bucket: string;
    totalObjects: number;
    totalSizeBytes: number;
    retentionPolicy: string;
  };
  shadowParity: {
    status: 'MATCHING' | 'DIVERGENT' | 'STANDALONE';
    consecutiveMatches: number;
    doksFallbackConfigured: boolean;
    dataSource?: string;
  };
  computePlane?: {
    activeRunner: string;
    defaultRunner: string;
    supportedRunners: string[];
    aliases?: Record<string, string[]>;
  };
  dataSource?: string;
}

export interface BillableRuntimeReport {
  timeframe: {
    startDate: string;
    endDate: string;
  };
  filter: {
    repo?: string;
    prNumber?: number;
    runnerType?: string;
  };
  summary: {
    totalRuns: number;
    totalBillableSeconds: number;
    totalComputeCostUSD: number;
    totalTokenCostUSD: number;
    totalSpendUSD: number;
    estimatedDoksBaselineCostUSD: number;
    netSavingsUSD: number;
    savingsPercent: number;
  };
  breakdownByRunner: Record<
    string,
    {
      runs: number;
      runtimeSeconds: number;
      computeCostUSD: number;
      tokenCostUSD: number;
      totalCostUSD: number;
    }
  >;
  items?: Array<{
    runId: string;
    repo: string;
    prNumber: number;
    runner: string;
    durationMs: number;
    computeCostUSD: number;
    tokenCostUSD: number;
    totalCostUSD: number;
    createdAt: string;
  }>;
  dataSource?: 'live_telemetry' | 'live_edge_telemetry' | 'baseline_sample_telemetry';
}

export interface RuntimeMetricsReport {
  repo?: string;
  windowHours: number;
  sampleCount: number;
  dataSource?: 'live_telemetry' | 'live_edge_telemetry' | 'baseline_sample_telemetry';
  percentilesWallLatencyMs: {
    p50: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
    avg: number;
  };
  stageBreakdownMs: {
    ingressHmacAndDebounce: number;
    repoGateAcquire: number;
    diffPartitionAndTriage: number;
    r2CacheHydration: number;
    runnerExecution: number;
    githubPublishing: number;
  };
  comparisonVsDoks?: {
    doksAvgMs: number;
    cfAvgMs: number;
    speedupRatio: number;
    latencyReductionPercent: number;
  };
}

export interface AnalyticsDashboardReport {
  timeframe: string;
  dataSource?: 'live_telemetry' | 'live_edge_telemetry' | 'baseline_sample_telemetry';
  kpis: {
    totalReviews: number;
    passRatePercent: number;
    blockRatePercent: number;
    commentRatePercent: number;
    totalFindings: {
      p0: number;
      p1: number;
      p2: number;
      total: number;
    };
    totalSpendUSD: number;
    totalTokens: number;
    avgReviewDurationMs: number;
    r2CacheHitRatePercent: number;
  };
  topViolatedRules: Array<{
    rule: string;
    count: number;
    severity: string;
  }>;
  findingHotspots: Array<{
    path: string;
    findingsCount: number;
    p0Count: number;
  }>;
  recentActivity: Array<{
    runId: string;
    repo: string;
    prNumber: number;
    verdict: string;
    findingsCount: number;
    durationMs: number;
    costUSD: number;
    timestamp: string;
  }>;
}
