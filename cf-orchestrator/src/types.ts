export type ReviewRunPhase = 'Pending' | 'Running' | 'Cancelled' | 'Completed' | 'Failed';

export interface ReviewRunSpec {
  runId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  installationId: number;
  publicationMode?: 'publishing' | 'disabled';
  workerImage?: string;
  diffShrink?: string;
  thinkingEffort?: 'low' | 'medium' | 'high' | 'max';
  explainTarget?: string;
  runner?: string;
  mode?: string;
}

export interface ReviewRunState {
  spec: ReviewRunSpec;
  phase: ReviewRunPhase;
  fencingEpoch: number;
  cancelRequested: boolean;
  cancelReason?: string;
  workerId?: string;
  leaseExpiresAt?: number;
  startedAt?: number;
  completedAt?: number;
  terminalReceipt?: any;
}

export interface DebounceMessagePayload {
  runId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  installationId: number;
  burstStartedAt: number;
  enqueuedAt: number;
}

export interface Env {
  // Bindings
  REPO_GATE: DurableObjectNamespace;
  REVIEW_RUN: DurableObjectNamespace;
  REVIEW_JOB_WORKFLOW: any; // Workflow binding
  REVIEW_DEBOUNCE_QUEUE: Queue<DebounceMessagePayload>;
  WORKSPACE_CACHE_BUCKET?: R2Bucket;
  CONTAINERS?: any; // Cloudflare Containers binding / Durable Object namespace
  ASSETS?: Fetcher;
  HYPERDRIVE?: {
    connectionString: string;
  };
  DB?: any; // D1 Database binding
  AUTH_CACHE?: any; // KV Namespace for GitHub App auth tokens

  // Variables
  ENVIRONMENT: string;
  PARALLEL_MODE: string;
  PARALLEL_CHECK_NAME: string;
  PILOT_REPOSITORIES: string;
  DOKS_FALLBACK_URL?: string;
  /** Deployment-owned operator origin for optional dispatch status callbacks. */
  DISPATCH_STATUS_BASE_URL?: string;
  /** Base host of the operator run-status API; deployments bind the real internal operator host here. */
  OPERATOR_STATUS_BASE_URL?: string;
  /** Comma-separated full names of the repositories whose live gate state the dashboard reports. */
  REVIEWED_REPOSITORIES?: string;
  /** Comma-separated browser origins allowed for the MCP endpoint (exact origin or `*.suffix`). */
  ALLOWED_ORIGINS?: string;
  DEFAULT_WORKER_IMAGE: string;
  MAX_CONCURRENT_JOBS?: string;
  DEBOUNCE_WINDOW_SECONDS?: string;
  PARALLEL_FILE_CONCURRENCY?: string;
  RUNNER_TYPE?: string; // 'cloudflare' (default) | 'digitalocean' | 'mars' | 'do'
  DO_API_TOKEN?: string;
  DO_AGENT_ID?: string;
  DO_BASE_URL?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  REVIEW_YETI_MCP_AUTH_TOKEN?: string;
  GITHUB_TOKEN?: string;
}

export type ReviewStage =
  | 'admission'
  | 'compaction'
  | 'planning'
  | 'execution'
  | 'arbitration'
  | 'publication'
  | 'complete';

export interface StageTransitionPayload {
  stage: ReviewStage;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress?: number;
  overallProgress?: number;
  message?: string;
  durationMs?: number;
}

export interface TurnStepPayload {
  id?: string;
  jobId: string;
  personaId: string;
  taskId?: string;
  turn: number;
  maxTurns: number;
  action: string;
  tool?: string;
  input?: any;
  output?: any;
  tokensBurned?: number;
  latencyMs?: number;
  timestamp?: string;
}
