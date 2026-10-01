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
  HYPERDRIVE?: {
    connectionString: string;
  };

  // Variables
  ENVIRONMENT: string;
  PARALLEL_MODE: string;
  PARALLEL_CHECK_NAME: string;
  PILOT_REPOSITORIES: string;
  DOKS_FALLBACK_URL: string;
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
  GITHUB_APP_PRIVATE_KEY?: string;
  REVIEW_YETI_MCP_AUTH_TOKEN?: string;
}

