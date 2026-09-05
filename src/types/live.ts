import type {
  PersonaProgress as BusPersonaProgress,
  TokenMetrics as BusTokenMetrics,
} from '../live/liveStreamBus';

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

export type PersonaStatus =
  | 'PENDING'
  | 'IN PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  // Legacy lowercase/underscore status values assigned by the server-side
  // LiveStreamBus job tracker's own `PersonaProgress` shape (REL-573
  // LiveJobSummary consolidation). Kept as additional members rather than
  // narrowing so `LiveJobSummary.personaProgress` can legitimately hold
  // either shape without a lossy cast.
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed';

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
  // Widened union: the LiveStreamBus job tracker (src/live/liveStreamBus.ts)
  // also assigns 'queued' and 'dispatched' before a job goes active.
  status: 'queued' | 'active' | 'completed' | 'failed' | 'dispatched';
  // Widened union: LiveStreamBus populates this map with its own
  // `PersonaProgress` shape (no `progress` percentage field, lowercase
  // status strings); front-end producers (useSSE) populate it with the
  // richer `PersonaProgressState` shape. Both are legitimate producers, so
  // the survivor type accepts either rather than narrowing to one.
  personaProgress: Record<string, PersonaProgressState | BusPersonaProgress>;
  // Widened union: LiveStreamBus's own `TokenMetrics` omits
  // tokensPerSec/latencyMs/astNodes/nitsFound, which useSSE's
  // `StreamingTokenMetrics` always populates.
  tokenMetrics: StreamingTokenMetrics | BusTokenMetrics;
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
