export type LiveStreamEventType =
  | 'persona:start'
  | 'persona:chunk'
  | 'persona:complete'
  | 'llm:prompt'
  | 'llm:token'
  | 'llm:error'
  | 'omniroute:metric'
  | 'openrouter:metric'
  | 'ast:lookup'
  | 'nit:suppression'
  | 'job:queued'
  | 'job:dispatched'
  | 'job:complete'
  // Legacy event type shims
  | 'agent_start'
  | 'llm_chunk'
  | 'agent_done'
  | 'indexer_lookup'
  | 'quorum_verdict';

export type LiveStreamPersona =
  | 'security'
  | 'architecture'
  | 'performance'
  | 'quality'
  | 'database'
  | 'api_contract'
  | 'reliability'
  | 'devops'
  | 'docs_compliance'
  | 'finops'
  | 'red_team'
  | 'correctness'
  | 'compliance'
  | 'quorum'
  | string;

export interface LiveStreamEventData {
  personaId?: string;
  charter?: string;
  paths?: string[];
  required?: boolean;
  chunk?: string;
  decision?: string;
  findingsCount?: number;
  durationMs?: number;
  tokensUsed?: number | { prompt: number; completion: number; total: number };
  costUSD?: number | null;
  provider?: string;
  model?: string;
  requestedModel?: string;
  resolvedModel?: string;
  promptSnippet?: string;
  token?: string;
  accumulatedLength?: number;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  symbolName?: string;
  filePath?: string;
  callersCount?: number;
  calleesCount?: number;
  riskScore?: number;
  findingTitle?: string;
  pattern?: string;
  rationale?: string;
  verdict?: string;
  quorumSatisfied?: boolean;
  distinctProviders?: string[];
  totalPersonasExecuted?: number;
  totalFindings?: number;
  totalDurationMs?: number;
  totalCostUSD?: number | null;
  message?: string;
  confidenceScore?: number;
  path?: string;
  isError?: boolean;
  stream?: 'stdout' | 'stderr';
  [key: string]: any;
}

export interface LiveStreamEvent {
  jobId: string;
  timestamp: string;
  type: LiveStreamEventType;
  persona: LiveStreamPersona;
  data: LiveStreamEventData;
}

export type PersonaStatus = 'PENDING' | 'IN PROGRESS' | 'COMPLETED' | 'FAILED';

export interface PersonaProgressState {
  persona: LiveStreamPersona;
  status: PersonaStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  findingsCount?: number;
  lastMessage?: string;
  chunkCount?: number;
  durationMs?: number;
}

export interface TokenMetricHistoryPoint {
  timestamp: string;
  label: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  tokensPerSec: number;
  latencyMs: number;
}

export interface StreamingTokenMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  tokensPerSec: number;
  latencyMs: number;
  astNodes: number;
  nitsFound: number;
}

export interface LiveJobSummary {
  jobId: string;
  repo?: string;
  prNumber?: number;
  title?: string;
  status: 'active' | 'completed' | 'failed';
  personaProgress: Record<string, PersonaProgressState>;
  tokenMetrics: StreamingTokenMetrics;
  startTime: string;
  endTime?: string;
  eventCount: number;
  lastEventTime: string;
}

export interface LiveDashboardState {
  connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  jobId: string | null;
  selectedPersona: string;
  events: LiveStreamEvent[];
  filteredEvents: LiveStreamEvent[];
  personaProgress: Record<string, PersonaProgressState>;
  tokenMetrics: StreamingTokenMetrics;
  tokenHistory: TokenMetricHistoryPoint[];
  activeJobs: LiveJobSummary[];
}
