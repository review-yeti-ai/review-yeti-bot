import { RepoGateDO } from '../../src/repoGateDO.js';
import { ReviewRunDO } from '../../src/reviewRunDO.js';
import { ReviewJobWorkflow, type WorkflowStep } from '../../src/reviewJobWorkflow.js';
import worker from '../../src/worker.js';
import type { DebounceMessagePayload, Env, ReviewRunSpec } from '../../src/types.js';
import { MockDurableObjectState } from '../mockDurableObject.js';
import type { ReviewRunReceipt } from '../../src/compareOrchestratorRuns.js';
import { MockContainerRunner, type ContainerRunner } from '../../src/runners/containerRunner.js';

export interface E2ETestHarnessOptions {
  pilotRepositories?: string;
  doksFallbackUrl?: string;
  githubWebhookSecret?: string;
  environment?: string;
  parallelMode?: string;
  parallelCheckName?: string;
  defaultWorkerImage?: string;
  containersBinding?: any;
  customRunner?: ContainerRunner;
}

export interface DispatchedWorkflowRecord {
  id: string;
  params: ReviewRunSpec;
}

export interface SentDebounceRecord {
  message: DebounceMessagePayload;
  options?: { delaySeconds?: number };
}

/**
 * Calculates a valid Web Crypto HMAC-SHA256 signature matching GitHub's X-Hub-Signature-256
 */
export async function signWebhookPayload(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hashArray = Array.from(new Uint8Array(signatureBytes));
  return 'sha256=' + hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Creates an integrated mock Cloudflare edge environment for opaque-box E2E testing
 */
export function createE2EEnvironment(options: E2ETestHarnessOptions = {}) {
  const repoStore = new Map<string, RepoGateDO>();
  const runStore = new Map<string, ReviewRunDO>();

  const dispatchedWorkflows: DispatchedWorkflowRecord[] = [];
  const queuedDebounceMessages: SentDebounceRecord[] = [];
  const recordedRunner = options.customRunner || new MockContainerRunner();

  const env: any = {
    REPO_GATE: {
      idFromName: (name: string) => name.toLowerCase(),
      get: (id: any) => {
        const normalized = String(id).toLowerCase();
        if (!repoStore.has(normalized)) {
          repoStore.set(normalized, new RepoGateDO(new MockDurableObjectState() as any, env));
        }
        const instance = repoStore.get(normalized)!;
        return {
          fetch: async (url: string | URL | Request, init?: any) => {
            const req = url instanceof Request ? url : new Request(url, init);
            return instance.fetch(req);
          },
        };
      },
    },
    REVIEW_RUN: {
      idFromName: (name: string) => name,
      get: (id: any) => {
        const idStr = String(id);
        if (!runStore.has(idStr)) {
          runStore.set(idStr, new ReviewRunDO(new MockDurableObjectState() as any, env));
        }
        const instance = runStore.get(idStr)!;
        return {
          fetch: async (url: string | URL | Request, init?: any) => {
            const req = url instanceof Request ? url : new Request(url, init);
            return instance.fetch(req);
          },
        };
      },
    },
    REVIEW_JOB_WORKFLOW: {
      create: async (params: { id: string; params: ReviewRunSpec }) => {
        dispatchedWorkflows.push(params);
        return { id: params.id };
      },
    },
    REVIEW_DEBOUNCE_QUEUE: {
      send: async (message: DebounceMessagePayload, opts?: { delaySeconds?: number }) => {
        queuedDebounceMessages.push({ message, options: opts });
        return {} as any;
      },
    },
    ENVIRONMENT: options.environment ?? 'staging',
    PARALLEL_MODE: options.parallelMode ?? 'true',
    PARALLEL_CHECK_NAME: options.parallelCheckName ?? 'Review Yeti (Cloudflare Canary)',
    OPERATOR_GLOBAL_PASSTHROUGH: 'false',
    PILOT_REPOSITORIES: options.pilotRepositories ?? 'review-yeti-ai/review-yeti-bot,exampleorg/example-meta',
    DOKS_FALLBACK_URL: options.doksFallbackUrl ?? '',
    GITHUB_WEBHOOK_SECRET: options.githubWebhookSecret ?? 'e2e-default-test-secret',
    DEFAULT_WORKER_IMAGE: options.defaultWorkerImage ?? 'ghcr.io/review-yeti-ai/review-yeti-worker:latest',
  };

  /**
   * Dispatches a webhook request through the worker
   */
  async function dispatchWebhook(
    payload: any,
    headers: Record<string, string> = {},
    rawBodyOverride?: string
  ): Promise<Response> {
    const rawBody = rawBodyOverride ?? (typeof payload === 'string' ? payload : JSON.stringify(payload));
    const requestHeaders = new Headers({
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      ...headers,
    });

    const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
    if (webhookSecret && !requestHeaders.has('X-Hub-Signature-256')) {
      const sig = await signWebhookPayload(webhookSecret, rawBody);
      requestHeaders.set('X-Hub-Signature-256', sig);
    }

    const request = new Request('https://operator.example.internal/api/webhooks/github', {
      method: 'POST',
      headers: requestHeaders,
      body: rawBody,
    });

    return worker.fetch(request, env);
  }

  /**
   * Executes a full durable workflow for a given spec
   */
  async function executeFullWorkflow(
    spec: ReviewRunSpec,
    runner: ContainerRunner = recordedRunner
  ) {
    const workflow = new ReviewJobWorkflow(env, runner);
    const executedSteps: string[] = [];

    const mockStep: any = {
      async do<R>(name: string, configOrFn: any, maybeFn?: any): Promise<R> {
        executedSteps.push(name);
        const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn;
        return fn();
      },
    };

    const result = await workflow.run({ payload: spec }, mockStep);
    return { result, executedSteps };
  }

  /**
   * Drains all queued debounce messages through worker.queue()
   */
  async function drainDebounceQueue() {
    const messagesToProcess = [...queuedDebounceMessages];
    queuedDebounceMessages.length = 0;

    const acknowledged: DebounceMessagePayload[] = [];
    const batch = {
      queue: 'review-yeti-debounce',
      messages: messagesToProcess.map((item) => ({
        id: `msg_${Math.random()}`,
        timestamp: new Date(),
        body: item.message,
        ack: () => {
          acknowledged.push(item.message);
        },
        retry: () => {},
      })),
    };

    await worker.queue(batch as any, env);
    return { processedCount: messagesToProcess.length, acknowledged };
  }

  return {
    env,
    repoStore,
    runStore,
    dispatchedWorkflows,
    queuedDebounceMessages,
    runner: recordedRunner,
    dispatchWebhook,
    executeFullWorkflow,
    drainDebounceQueue,
  };
}

/**
 * Sample PR webhook payload builder
 */
export function createWebhookPayload(
  action: string,
  options: {
    owner?: string;
    repo?: string;
    prNumber?: number;
    headSha?: string;
    baseSha?: string;
    draft?: boolean;
    installationId?: number;
  } = {}
) {
  const owner = options.owner ?? 'review-yeti-ai';
  const repo = options.repo ?? 'review-yeti-bot';
  const prNumber = options.prNumber ?? 42;
  const headSha = options.headSha ?? '0123456789abcdef0123456789abcdef01234567';
  const baseSha = options.baseSha ?? 'fedcba9876543210fedcba9876543210fedcba98';

  return {
    action,
    pull_request: {
      number: prNumber,
      head: { sha: headSha },
      base: { sha: baseSha },
      draft: Boolean(options.draft),
    },
    repository: {
      name: repo,
      full_name: `${owner}/${repo}`,
      owner: { login: owner },
    },
    installation: {
      id: options.installationId ?? 123456,
    },
  };
}

/**
 * Creates standard sample receipts for DOKS and Cloudflare comparison
 */
export function createSampleReceipt(
  orchestrator: 'doks' | 'cloudflare',
  overrides: Partial<ReviewRunReceipt> = {}
): ReviewRunReceipt {
  return {
    orchestrator,
    runId: overrides.runId ?? (orchestrator === 'doks' ? 'doks_run_101' : 'cf_run_101'),
    repo: overrides.repo ?? 'review-yeti-ai/review-yeti-bot',
    prNumber: overrides.prNumber ?? 42,
    headSha: overrides.headSha ?? '0123456789abcdef0123456789abcdef01234567',
    verdict: overrides.verdict ?? 'success',
    findingFingerprints: overrides.findingFingerprints ?? ['fp_sec_001', 'fp_perf_002'],
    durationMs: overrides.durationMs ?? (orchestrator === 'doks' ? 45000 : 38000),
    tokensUsed: overrides.tokensUsed ?? {
      promptTokens: 12000,
      completionTokens: 2500,
      totalTokens: 14500,
    },
    zoektIndexShards: overrides.zoektIndexShards ?? 4,
    completedAt: overrides.completedAt ?? new Date().toISOString(),
  };
}
