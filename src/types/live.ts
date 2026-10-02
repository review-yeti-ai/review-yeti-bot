export type LiveStreamEventType =
  | 'connection:open'
  | 'task:plan'
  | 'task:progress'
  | 'task:complete'
  | 'context:compaction'
  | 'finding:anchored'
  | 'ping'
  | 'log:chunk'
  | 'persona:start'
  | 'persona:chunk'
  | 'persona:reasoning'
  | 'reasoning:chunk'
  | 'persona:finding'
  | 'persona:complete'
  | 'tool:start'
  | 'tool:result'
  | 'tool:error'
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
  | 'stage:transition'
  | 'turn:step'
  | 'token:update'
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

export type TaskDimension =
  | 'security'
  | 'performance'
  | 'architecture'
  | 'testing'
  | 'dependencies'
  | 'contract'
  | 'licensing';

/**
 * The bus-side persona/token shapes. REL-573: these previously lived in `src/live/liveStreamBus.ts`
 * and were imported back into this module, which made the canonical type module depend on a
 * concrete infrastructure module and created a `types/live` <-> `liveStreamBus` import cycle.
 * They live here now and the bus imports them, restoring the documented direction: this file is
 * the single source of truth, and infrastructure depends on it, never the reverse.
 *
 * They remain distinct from `PersonaProgressState` / `StreamingTokenMetrics` below, which are the
 * richer frontend shapes -- two legitimate producers, not a duplication.
 */
export interface PersonaProgress {
  persona: LiveStreamPersona;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  findingsCount?: number;
  lastMessage?: string;
}

export interface TokenMetrics {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUSD?: number;
}

export interface ReasoningChunkPayload {
  jobId: string;
  personaId: string;
  reasoning: string;
  turn?: number;
  accumulatedLength?: number;
  timestamp: string;
}

export interface ToolExecutionPayload {
  jobId: string;
  personaId: string;
  tool: string;
  args: Record<string, unknown>;
  output?: string;
  outputLength?: number;
  error?: string;
  scope?: string;
  isExhaustive?: boolean;
  durationMs?: number;
  turn?: number;
  timestamp: string;
}

export interface LiveFindingPayload {
  jobId: string;
  personaId: string;
  findingId: string;
  severity: 'P0' | 'P1' | 'P2';
  path: string;
  line: number;
  startLine?: number;
  title: string;
  description: string;
  suggestion?: string;
  replacementCode?: string;
  timestamp: string;
}

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
  reasoning?: string;
  tool?: string;
  toolName?: string;
  args?: Record<string, unknown> | any;
  output?: string;
  outputLength?: number;
  error?: string;
  scope?: string;
  isExhaustive?: boolean;
  findingId?: string;
  finding?: any;
  turn?: number;
  severity?: 'P0' | 'P1' | 'P2' | string;
  line?: number;
  startLine?: number;
  title?: string;
  description?: string;
  suggestion?: string;
  replacementCode?: string;
  [key: string]: any;
}

export interface LiveStreamEvent {
  jobId: string;
  timestamp: string;
  type: LiveStreamEventType;
  persona: LiveStreamPersona;
  data: LiveStreamEventData;
}

/**
 * The authoritative identity carried by a Review Yeti event envelope.  This
 * is deliberately separate from LiveStreamEvent: the latter is a permissive,
 * in-process compatibility API and its data map must never be serialized as a
 * durable event without passing through the event sanitizer.
 */
export interface ReviewEventIdentity {
  repositoryId: number;
  prNumber: number;
  baseSha: string;
  headSha: string;
  attemptId: string;
  runId: string;
  sequence: number;
  correlationId: string;
  traceId: string;
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
  personaProgress: Record<string, PersonaProgressState | PersonaProgress>;
  // Widened union: LiveStreamBus's own `TokenMetrics` omits
  // tokensPerSec/latencyMs/astNodes/nitsFound, which useSSE's
  // `StreamingTokenMetrics` always populates.
  tokenMetrics: StreamingTokenMetrics | TokenMetrics;
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

export type ReviewStage =
  | 'admission'
  | 'compaction'
  | 'planning'
  | 'execution'
  | 'arbitration'
  | 'publication'
  | 'complete';

export interface StageState {
  stage: ReviewStage;
  label: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface TurnStepRecord {
  id: string;
  jobId: string;
  personaId: string;
  taskId?: string;
  turn: number;
  maxTurns: number;
  action: 'planning' | 'tool_call' | 'reasoning' | 'finding_formulation' | 'finalization' | string;
  tool?: string;
  input?: any;
  output?: any;
  tokensBurned?: number;
  latencyMs?: number;
  timestamp: string;
}

