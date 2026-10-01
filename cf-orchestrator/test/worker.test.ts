import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { evictQueuedRunsForPR, isPilotRepository, verifyGitHubSignature } from '../src/worker.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { MockDurableObjectState } from './mockDurableObject.js';
import type { DebounceMessagePayload, Env, ReviewRunSpec } from '../src/types.js';

/**
 * Calculates a valid Web Crypto HMAC-SHA256 signature matching GitHub's X-Hub-Signature-256
 */
async function signPayload(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

interface MockTestContext {
  env: Env;
  repoGateStore: Map<string, any>;
  reviewRunStore: Map<string, any>;
  dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
  queuedDebounceItems: Array<{ message: DebounceMessagePayload; delaySeconds?: number }>;
  doksFanoutRequests: Array<{ url: string; headers: Headers; body: string }>;
  waitUntilPromises: Array<Promise<any>>;
  mockCtx: { waitUntil: (p: Promise<any>) => void };
  evictedPrs: number[];
}

function createWorkerTestEnv(overrides: Partial<Record<string, any>> = {}): MockTestContext {
  const repoGateStore = new Map<string, any>();
  const reviewRunStore = new Map<string, any>();
  const dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }> = [];
  const queuedDebounceItems: Array<{ message: DebounceMessagePayload; delaySeconds?: number }> = [];
  const doksFanoutRequests: Array<{ url: string; headers: Headers; body: string }> = [];
  const waitUntilPromises: Array<Promise<any>> = [];
  const evictedPrs: number[] = [];

  const mockCtx = {
    waitUntil: (p: Promise<any>) => {
      waitUntilPromises.push(p);
    },
  };

  const env: any = {
    REPO_GATE: {
      idFromName: (name: string) => name.toLowerCase(),
      get: (id: string) => {
        const key = id.toLowerCase();
        if (!repoGateStore.has(key)) {
          // Mock RepoGate supporting active run lookup per PR
          const activeJobs = new Set<string>();
          const activeRunsByPr = new Map<number, string>();
          repoGateStore.set(key, {
            activeJobs,
            activeRunsByPr,
            async fetch(input: string | Request, init?: RequestInit) {
              const req = typeof input === 'string' ? new Request(input, init) : input;
              const url = new URL(req.url);
              if (req.method === 'POST' && url.pathname === '/acquire') {
                const body = (await req.json()) as { runId: string; headSha: string; prNumber?: number };
                activeJobs.add(body.runId);
                if (body.prNumber) {
                  activeRunsByPr.set(body.prNumber, body.runId);
                }
                return Response.json({ granted: true });
              }
              if (req.method === 'POST' && url.pathname === '/release') {
                const body = (await req.json()) as { runId: string };
                activeJobs.delete(body.runId);
                for (const [pr, rId] of activeRunsByPr.entries()) {
                  if (rId === body.runId) activeRunsByPr.delete(pr);
                }
                return Response.json({ released: true });
              }
              if (req.method === 'POST' && url.pathname === '/evict') {
                const body = (await req.json()) as { runId?: string; prNumber?: number };
                if (body.prNumber !== undefined) {
                  evictedPrs.push(body.prNumber);
                }
                return Response.json({ evicted: true, count: 1 });
              }
              const activeMatch = url.pathname.match(/^\/active-run\/(\d+)$/);
              if (req.method === 'GET' && activeMatch) {
                const prNumber = parseInt(activeMatch[1], 10);
                const activeRunId = activeRunsByPr.get(prNumber) || null;
                return Response.json({ activeRunId });
              }
              if (req.method === 'GET' && url.pathname === '/status') {
                return Response.json({ activeCount: activeJobs.size, activeJobs: Array.from(activeJobs), queueLength: 0 });
              }
              return new Response('Not Found', { status: 404 });
            },
          });
        }
        return repoGateStore.get(key);
      },
    },

    REVIEW_RUN: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!reviewRunStore.has(id)) {
          const state = new MockDurableObjectState();
          const runDO = new ReviewRunDO(state as any, env);
          reviewRunStore.set(id, runDO);
        }
        const instance = reviewRunStore.get(id);
        return {
          fetch: async (url: string, init?: any) => {
            const req = new Request(url, init);
            return instance.fetch(req);
          },
        };
      },
    },

    REVIEW_JOB_WORKFLOW: {
      create: async (payload: { id: string; params: ReviewRunSpec }) => {
        dispatchedWorkflows.push(payload);
        return { id: payload.id };
      },
    },

    REVIEW_DEBOUNCE_QUEUE: {
      send: async (message: DebounceMessagePayload, opts?: { delaySeconds?: number }) => {
        queuedDebounceItems.push({ message, delaySeconds: opts?.delaySeconds });
        return {} as any;
      },
    },

    ENVIRONMENT: overrides.ENVIRONMENT ?? 'staging',
    PARALLEL_MODE: overrides.PARALLEL_MODE ?? 'true',
    PARALLEL_CHECK_NAME: overrides.PARALLEL_CHECK_NAME ?? 'Review Yeti (Cloudflare Canary)',
    PILOT_REPOSITORIES: overrides.PILOT_REPOSITORIES ?? 'review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta',
    DOKS_FALLBACK_URL: overrides.DOKS_FALLBACK_URL ?? 'https://doks-internal.calltelemetry.com/api/webhooks/github',
    GITHUB_WEBHOOK_SECRET: overrides.GITHUB_WEBHOOK_SECRET ?? 'webhook-secret-xyz123',
    REVIEW_YETI_MCP_AUTH_TOKEN: overrides.REVIEW_YETI_MCP_AUTH_TOKEN ?? 'mock-mcp-token-xyz',
    DEFAULT_WORKER_IMAGE: 'ghcr.io/review-yeti-ai/review-yeti-worker:latest',
  };

  return {
    env,
    repoGateStore,
    reviewRunStore,
    dispatchedWorkflows,
    queuedDebounceItems,
    doksFanoutRequests,
    waitUntilPromises,
    mockCtx,
    evictedPrs,
  };
}

function createWebhookPayload(action: string, options: {
  owner?: string;
  repo?: string;
  prNumber?: number;
  headSha?: string;
  baseSha?: string;
  draft?: boolean;
} = {}) {
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
      id: 998877,
    },
  };
}

describe('Webhook Ingress Worker (src/worker.ts)', () => {
  describe('Helper: isPilotRepository', () => {
    it('returns true when repository matches exactly', () => {
      assert.equal(isPilotRepository('review-yeti-ai/review-yeti-bot', 'review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta'), true);
    });

    it('returns true case-insensitively with leading/trailing whitespace in list', () => {
      assert.equal(isPilotRepository('Review-Yeti-AI/Review-Yeti-Bot', ' review-yeti-ai/review-yeti-bot , calltelemetry/ct-meta '), true);
    });

    it('returns true when pilot list is "all" or "ALL"', () => {
      assert.equal(isPilotRepository('any-org/any-repo', 'all'), true);
      assert.equal(isPilotRepository('any-org/any-repo', 'ALL'), true);
    });

    it('returns false when repository is not in list', () => {
      assert.equal(isPilotRepository('unknown-org/unknown-repo', 'review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta'), false);
    });

    it('returns false when pilot list is empty or undefined', () => {
      assert.equal(isPilotRepository('review-yeti-ai/review-yeti-bot', ''), false);
      assert.equal(isPilotRepository('review-yeti-ai/review-yeti-bot', undefined), false);
    });
  });

  describe('Helper: verifyGitHubSignature', () => {
    const secret = 'test-secret-key-42';
    const body = JSON.stringify({ hello: 'world' });

    it('returns true for matching HMAC-SHA256 signature', async () => {
      const validSig = await signPayload(secret, body);
      const res = await verifyGitHubSignature(secret, validSig, body);
      assert.equal(res, true);
    });

    it('returns false for tampered body', async () => {
      const validSig = await signPayload(secret, body);
      const res = await verifyGitHubSignature(secret, validSig, body + 'tampered');
      assert.equal(res, false);
    });

    it('returns false for wrong secret', async () => {
      const validSig = await signPayload('different-secret', body);
      const res = await verifyGitHubSignature(secret, validSig, body);
      assert.equal(res, false);
    });

    it('returns false for missing or non-sha256 header', async () => {
      assert.equal(await verifyGitHubSignature(secret, null, body), false);
      assert.equal(await verifyGitHubSignature(secret, 'sha1=12345', body), false);
      assert.equal(await verifyGitHubSignature(secret, 'invalid-format', body), false);
    });

    it('returns false for invalid hex string length', async () => {
      assert.equal(await verifyGitHubSignature(secret, 'sha256=tooshort', body), false);
    });
  });

  describe('Health and Readiness Probes', () => {
    it('GET /health returns 200 with environment metadata', async () => {
      const { env } = createWorkerTestEnv();
      const req = new Request('https://operator.internal/health');
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ok');
      assert.equal(data.environment, 'staging');
      assert.equal(data.parallelMode, 'true');
    });

    it('GET /ready returns 200 with environment metadata', async () => {
      const { env } = createWorkerTestEnv();
      const req = new Request('https://operator.internal/ready');
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ok');
    });

    it('GET /unmapped returns 404', async () => {
      const { env } = createWorkerTestEnv();
      const req = new Request('https://operator.internal/unmapped');
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 404);
    });

    it('POST /api/cache/purge-expired purges expired R2 cache objects', async () => {
      const deleted: string[] = [];
      const mockR2 = {
        async list() {
          return {
            objects: [
              { key: 'calltelemetry/cisco-cdr/pr-1.tar.zst', uploaded: new Date(Date.now() - 7200000) }, // 2h old
              { key: 'calltelemetry/cisco-cdr/pr-2.tar.zst', uploaded: new Date(Date.now() - 1800000) }, // 30m old
            ],
            truncated: false,
          };
        },
        async delete(keys: string | string[]) {
          const arr = Array.isArray(keys) ? keys : [keys];
          deleted.push(...arr);
        },
      };

      const { env } = createWorkerTestEnv();
      env.WORKSPACE_CACHE_BUCKET = mockR2 as any;

      const req = new Request('https://operator.internal/api/cache/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-mcp-token-xyz' },
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ok');
      assert.equal(data.deletedCount, 1);
      assert.deepEqual(data.deletedKeys, ['calltelemetry/cisco-cdr/pr-1.tar.zst']);
      assert.deepEqual(deleted, ['calltelemetry/cisco-cdr/pr-1.tar.zst']);
    });

    it('GET /api/cache/purge-expired is rejected with 405 Method Not Allowed', async () => {
      const { env } = createWorkerTestEnv();
      const getReq = new Request('https://operator.internal/api/cache/purge-expired', { method: 'GET' });
      const getRes = await worker.fetch(getReq, env);
      assert.equal(getRes.status, 405);
    });

    it('POST /api/cache/purge-expired rejects unauthenticated requests with 401', async () => {
      const { env } = createWorkerTestEnv();
      const unauthReq = new Request('https://operator.internal/api/cache/purge-expired', { method: 'POST' });
      const unauthRes = await worker.fetch(unauthReq, env);
      assert.equal(unauthRes.status, 401);
    });

    it('POST /api/cache/purge-expired rejects invalid authorization token with 401', async () => {
      const { env } = createWorkerTestEnv();
      const badAuthReq = new Request('https://operator.internal/api/cache/purge-expired', {
        method: 'POST',
        headers: { Authorization: 'Bearer bad_token' },
      });
      const badAuthRes = await worker.fetch(badAuthReq, env);
      assert.equal(badAuthRes.status, 401);
    });

    it('POST /api/cache/purge-expired safely clamps maxAgeSeconds=0 to 1800s floor', async () => {
      const { env } = createWorkerTestEnv();
      const mockR2 = {
        async list() {
          return { objects: [], truncated: false };
        },
        async delete() {},
      };
      env.WORKSPACE_CACHE_BUCKET = mockR2 as any;

      const wipeReq = new Request('https://operator.internal/api/cache/purge-expired?maxAgeSeconds=0', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-mcp-token-xyz' },
      });
      const wipeRes = await worker.fetch(wipeReq, env);
      assert.equal(wipeRes.status, 200);
      const wipeData = (await wipeRes.json()) as any;
      assert.equal(wipeData.maxAgeSeconds, 1800, 'Must clamp maxAgeSeconds to 1800s minimum floor');
    });
  });

  describe('Pull-path Worker Status Polling', () => {
    it('GET /api/dispatch/runs/:runId/status queries ReviewRunDO', async () => {
      const { env, reviewRunStore } = createWorkerTestEnv();

      // Pre-initialize a run in ReviewRunDO
      const runDO = reviewRunStore.get('run_poller_1') || env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName('run_poller_1'));
      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: 'run_poller_1',
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'abc1234',
          baseSha: 'def5678',
          installationId: 1,
        }),
      });

      const req = new Request('https://operator.internal/api/dispatch/runs/run_poller_1/status');
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.isCurrentHead, true);
      assert.equal(data.phase, 'Pending');
      assert.equal(data.cancelRequested, false);
      assert.equal(data.fencingEpoch, 1);
    });
  });

  describe('HMAC Webhook Ingress Security', () => {
    it('rejects unsigned webhook missing X-Hub-Signature-256 with HTTP 401', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const payload = createWebhookPayload('opened');
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
        },
        body: JSON.stringify(payload),
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 401);
      const text = await res.text();
      assert.match(text, /Invalid HMAC signature/);
    });

    it('rejects webhook with mismatched HMAC signature with HTTP 401', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const payload = createWebhookPayload('opened');
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
        },
        body: JSON.stringify(payload),
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 401);
      const text = await res.text();
      assert.match(text, /Invalid HMAC signature/);
    });

    it('rejects non-JSON payload with HTTP 400 Bad Request', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const rawBody = 'INVALID_JSON{{{';
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 400);
      assert.match(await res.text(), /Invalid JSON/);
    });

    it('accepts valid HMAC signature and processes webhook', async () => {
      const { env, mockCtx, dispatchedWorkflows } = createWorkerTestEnv();
      const payload = createWebhookPayload('opened');
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'dispatched_immediate');
      assert.equal(dispatchedWorkflows.length, 1);
    });
  });

  describe('Pilot Repository Filtering', () => {
    it('ignores pull request for non-pilot repository', async () => {
      const { env, mockCtx, dispatchedWorkflows } = createWorkerTestEnv({
        PILOT_REPOSITORIES: 'review-yeti-ai/review-yeti-bot',
      });
      const payload = createWebhookPayload('opened', { owner: 'other-org', repo: 'other-repo' });
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ignored');
      assert.equal(data.reason, 'not_pilot_repository');
      assert.equal(dispatchedWorkflows.length, 0);
    });
  });

  describe('DOKS Fallback Fanout', () => {
    it('forwards raw webhook asynchronously to DOKS_FALLBACK_URL with ctx.waitUntil', async () => {
      let forwardedUrl = '';
      let forwardedBody = '';
      let forwardedSignature = '';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        const urlStr = typeof input === 'string' ? input : input.url;
        if (urlStr === 'https://doks.custom.domain/api/webhooks/github') {
          forwardedUrl = urlStr;
          forwardedBody = init.body;
          forwardedSignature = init.headers?.get?.('X-Hub-Signature-256') || init.headers?.['X-Hub-Signature-256'];
          return new Response('OK', { status: 200 });
        }
        return originalFetch(input, init);
      };

      try {
        const { env, mockCtx, waitUntilPromises } = createWorkerTestEnv({
          DOKS_FALLBACK_URL: 'https://doks.custom.domain/api/webhooks/github',
        });
        const payload = createWebhookPayload('opened');
        const rawBody = JSON.stringify(payload);
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: rawBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 200);

        // Await background fanout promises registered with ctx.waitUntil
        await Promise.all(waitUntilPromises);

        assert.equal(forwardedUrl, 'https://doks.custom.domain/api/webhooks/github');
        assert.equal(forwardedBody, rawBody);
        assert.equal(forwardedSignature, sig);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('tolerates network errors in DOKS fanout without failing Cloudflare response', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        const urlStr = typeof input === 'string' ? input : input.url;
        if (urlStr === 'https://doks.failing.endpoint/api/webhooks/github') {
          throw new Error('Connection refused / ECONNREFUSED');
        }
        return originalFetch(input, init);
      };

      try {
        const { env, mockCtx, waitUntilPromises } = createWorkerTestEnv({
          DOKS_FALLBACK_URL: 'https://doks.failing.endpoint/api/webhooks/github',
        });
        const payload = createWebhookPayload('opened');
        const rawBody = JSON.stringify(payload);
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: rawBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 200);

        // Even with network error in fanout, promise settles gracefully
        await Promise.all(waitUntilPromises);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('completely suppresses DOKS fanout when PARALLEL_MODE is "false"', async () => {
      let fanoutAttempted = false;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        const urlStr = typeof input === 'string' ? input : input.url;
        if (urlStr === 'https://doks.custom.domain/api/webhooks/github') {
          fanoutAttempted = true;
          return new Response('OK', { status: 200 });
        }
        return originalFetch(input, init);
      };

      try {
        const { env, mockCtx, waitUntilPromises } = createWorkerTestEnv({
          PARALLEL_MODE: 'false',
          DOKS_FALLBACK_URL: 'https://doks.custom.domain/api/webhooks/github',
        });
        const payload = createWebhookPayload('opened');
        const rawBody = JSON.stringify(payload);
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: rawBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 200);

        await Promise.all(waitUntilPromises);
        assert.equal(fanoutAttempted, false, 'DOKS fanout must be completely skipped when PARALLEL_MODE is false');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });


  describe('Pull Request Immediate Triggers (opened, ready_for_review)', () => {
    it('ignores draft pull request on opened action', async () => {
      const { env, mockCtx, dispatchedWorkflows } = createWorkerTestEnv();
      const payload = createWebhookPayload('opened', { draft: true });
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ignored');
      assert.equal(data.reason, 'draft_pr');
      assert.equal(dispatchedWorkflows.length, 0);
    });

    it('dispatches immediate workflow on ready_for_review for non-draft PR', async () => {
      const { env, mockCtx, dispatchedWorkflows } = createWorkerTestEnv();
      const payload = createWebhookPayload('ready_for_review', { draft: false });
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'dispatched_immediate');
      assert.equal(dispatchedWorkflows.length, 1);
      assert.equal(dispatchedWorkflows[0].params.prNumber, 42);
    });
  });

  describe('Commit Supersession (synchronize)', () => {
    it('when no active run exists: enqueues new commit to REVIEW_DEBOUNCE_QUEUE with 60s delay', async () => {
      const { env, mockCtx, queuedDebounceItems } = createWorkerTestEnv();
      const payload = createWebhookPayload('synchronize', { prNumber: 42, headSha: 'commit_new_sha' });
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'queued_debounced');
      assert.equal(data.delaySeconds, 60);
      assert.equal(data.supersededRunId, null);

      assert.equal(queuedDebounceItems.length, 1);
      assert.equal(queuedDebounceItems[0].delaySeconds, 60);
      assert.equal(queuedDebounceItems[0].message.headSha, 'commit_new_sha');
    });

    it('when active run exists: cancels active run in ReviewRunDO with superseded_by_commit, bumps fencingEpoch, and enqueues new commit', async () => {
      const { env, mockCtx, queuedDebounceItems } = createWorkerTestEnv();
      const repoKey = 'review-yeti-ai/review-yeti-bot';

      // 1. Simulate an active run in flight for PR 42
      const activeRunId = 'run_inflight_commit_1';
      const repoGate = env.REPO_GATE.get(env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: activeRunId, headSha: 'commit_old_sha', prNumber: 42 }),
      });

      // 2. Initialize that run in ReviewRunDO and acquire worker lease
      const runDO = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(activeRunId));
      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: activeRunId,
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'commit_old_sha',
          baseSha: 'base_sha',
          installationId: 123,
        }),
      });
      await runDO.fetch('http://do/lease/acquire', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'worker_1', epoch: 1 }),
      });

      // Assert run is currently Running with fencingEpoch 1
      const initialStatus = (await (await runDO.fetch('http://do/status')).json()) as any;
      assert.equal(initialStatus.phase, 'Running');
      assert.equal(initialStatus.fencingEpoch, 1);
      assert.equal(initialStatus.isCurrentHead, true);

      // 3. New commit arrives on PR 42 (synchronize)
      const payload = createWebhookPayload('synchronize', { prNumber: 42, headSha: 'commit_new_sha' });
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'queued_debounced');
      assert.equal(data.supersededRunId, activeRunId);

      // 4. Assert old in-flight run was IMMEDIATELY cancelled in ReviewRunDO with bumped fencingEpoch
      const cancelledStatus = (await (await runDO.fetch('http://do/status')).json()) as any;
      assert.equal(cancelledStatus.phase, 'Cancelled');
      assert.equal(cancelledStatus.cancelRequested, true);
      assert.equal(cancelledStatus.isCurrentHead, false);
      assert.equal(cancelledStatus.fencingEpoch, 2); // Fencing epoch incremented from 1 to 2!

      // 5. Worker lease heartbeat from old worker MUST now fail
      const hbRes = (await (await runDO.fetch('http://do/lease/heartbeat', {
        method: 'POST',
        body: JSON.stringify({ workerId: 'worker_1', epoch: 1 }),
      })).json()) as any;
      assert.equal(hbRes.ok, false);

      // 6. Assert new commit was enqueued with 60s delay
      assert.equal(queuedDebounceItems.length, 1);
      assert.equal(queuedDebounceItems[0].delaySeconds, 60);
      assert.equal(queuedDebounceItems[0].message.headSha, 'commit_new_sha');
    });
  });

  describe('Ingress Cancellation Routing (closed, converted_to_draft)', () => {
    it('when PR closed with active run: cancels the specific active run in ReviewRunDO with reason pr_closed', async () => {
      const { env, mockCtx, evictedPrs } = createWorkerTestEnv();
      const repoKey = 'review-yeti-ai/review-yeti-bot';
      const activeRunId = 'run_active_for_closure';

      // Register active run in RepoGateDO
      const repoGate = env.REPO_GATE.get(env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: activeRunId, headSha: 'sha_closed', prNumber: 42 }),
      });

      // Initialize run in ReviewRunDO
      const runDO = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(activeRunId));
      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: activeRunId,
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'sha_closed',
          baseSha: 'base_sha',
          installationId: 123,
        }),
      });

      // PR closed event arrives
      const payload = createWebhookPayload('closed', { prNumber: 42 });
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'cancelled');
      assert.equal(data.action, 'closed');
      assert.equal(data.runId, activeRunId);
      assert.equal(data.cancelled, true);

      // Verify DO state
      const status = (await (await runDO.fetch('http://do/status')).json()) as any;
      assert.equal(status.phase, 'Cancelled');
      assert.equal(status.cancelRequested, true);
      assert.equal(status.fencingEpoch, 2);
      assert.ok(evictedPrs.includes(42), 'RepoGateDO POST /evict must be called with prNumber 42 on PR closed');
    });

    it('when PR converted_to_draft with active run: cancels the active run with reason pr_converted_to_draft', async () => {
      const { env, mockCtx, evictedPrs } = createWorkerTestEnv();
      const repoKey = 'review-yeti-ai/review-yeti-bot';
      const activeRunId = 'run_active_for_draft';

      const repoGate = env.REPO_GATE.get(env.REPO_GATE.idFromName(repoKey));
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: activeRunId, headSha: 'sha_draft', prNumber: 42 }),
      });

      const runDO = env.REVIEW_RUN.get(env.REVIEW_RUN.idFromName(activeRunId));
      await runDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: activeRunId,
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 42,
          headSha: 'sha_draft',
          baseSha: 'base_sha',
          installationId: 123,
        }),
      });

      const payload = createWebhookPayload('converted_to_draft', { prNumber: 42 });
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'cancelled');
      assert.equal(data.action, 'converted_to_draft');
      assert.equal(data.runId, activeRunId);
      assert.equal(data.cancelled, true);

      const status = (await (await runDO.fetch('http://do/status')).json()) as any;
      assert.equal(status.phase, 'Cancelled');
      assert.equal(status.cancelRequested, true);
      assert.ok(evictedPrs.includes(42), 'RepoGateDO POST /evict must be called with prNumber 42 on converted_to_draft');
    });

    it('when PR closed with NO active run: returns cancelled status cleanly without invoking uninitialized DO', async () => {
      const { env, mockCtx, evictedPrs } = createWorkerTestEnv();
      const payload = createWebhookPayload('closed', { prNumber: 999 });
      const rawBody = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'cancelled');
      assert.equal(data.action, 'closed');
      assert.equal(data.runId, null);
      assert.equal(data.cancelled, false);
      assert.ok(evictedPrs.includes(999), 'RepoGateDO POST /evict must be called with prNumber 999 even with no active run');
    });

    it('Helper: evictQueuedRunsForPR sends POST /evict to RepoGateDO and returns count', async () => {
      const { env, evictedPrs } = createWorkerTestEnv();
      const res = await evictQueuedRunsForPR(env, 'review-yeti-ai/review-yeti-bot', 77);
      assert.equal(res.evicted, true);
      assert.equal(res.count, 1);
      assert.ok(evictedPrs.includes(77));
    });
  });

  describe('Debounce Queue Consumer', () => {
    it('processes batch messages and dispatches workflow for each debounced commit', async () => {
      const { env, dispatchedWorkflows } = createWorkerTestEnv();
      const acked: string[] = [];

      const batch: any = {
        queue: 'review-yeti-debounce',
        messages: [
          {
            id: 'msg_1',
            body: {
              runId: 'run_debounced_1',
              owner: 'review-yeti-ai',
              repo: 'review-yeti-bot',
              prNumber: 42,
              headSha: 'head_sha_1',
              baseSha: 'base_sha_1',
              installationId: 101,
              burstStartedAt: Date.now() - 60000,
              enqueuedAt: Date.now() - 60000,
            },
            ack: () => acked.push('msg_1'),
          },
          {
            id: 'msg_2',
            body: {
              runId: 'run_debounced_2',
              owner: 'review-yeti-ai',
              repo: 'review-yeti-bot',
              prNumber: 43,
              headSha: 'head_sha_2',
              baseSha: 'base_sha_2',
              installationId: 102,
              burstStartedAt: Date.now() - 60000,
              enqueuedAt: Date.now() - 60000,
            },
            ack: () => acked.push('msg_2'),
          },
        ],
      };

      await worker.queue(batch, env);

      assert.equal(dispatchedWorkflows.length, 2);
      assert.equal(dispatchedWorkflows[0].id, 'run_debounced_1');
      assert.equal(dispatchedWorkflows[1].id, 'run_debounced_2');
      assert.deepEqual(acked, ['msg_1', 'msg_2']);
    });
  });

  describe('Defensive Payload Validation & Ingress Resilience', () => {
    it('returns HTTP 400 when pull_request webhook payload is null', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const rawBody = 'null';
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Bad Request: Missing or invalid repository / pull_request payload');
    });

    it('returns HTTP 400 when pull_request webhook payload is an array', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const rawBody = '[]';
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Bad Request: Missing or invalid repository / pull_request payload');
    });

    it('returns HTTP 400 when pull_request payload has action but lacks repository and pull_request', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const rawBody = JSON.stringify({ action: 'opened' });
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Bad Request: Missing or invalid repository / pull_request payload');
    });

    it('returns HTTP 400 when repository is missing full_name or is whitespace', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const invalidRepoBodies = [
        JSON.stringify({ action: 'opened', repository: { name: 'repo' }, pull_request: { number: 42 } }),
        JSON.stringify({ action: 'opened', repository: { full_name: '   ' }, pull_request: { number: 42 } }),
        JSON.stringify({ action: 'opened', repository: null, pull_request: { number: 42 } }),
        JSON.stringify({ action: 'opened', repository: 'not-an-object', pull_request: { number: 42 } }),
      ];

      for (const rawBody of invalidRepoBodies) {
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: rawBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 400);
        assert.equal(await res.text(), 'Bad Request: Missing or invalid repository / pull_request payload');
      }
    });

    it('returns HTTP 400 when pull_request object is missing or lacks valid number', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const invalidPrBodies = [
        JSON.stringify({ action: 'opened', repository: { full_name: 'org/repo' } }),
        JSON.stringify({ action: 'opened', repository: { full_name: 'org/repo' }, pull_request: null }),
        JSON.stringify({ action: 'opened', repository: { full_name: 'org/repo' }, pull_request: {} }),
        JSON.stringify({ action: 'opened', repository: { full_name: 'org/repo' }, pull_request: { number: '42' } }),
        JSON.stringify({ action: 'opened', repository: { full_name: 'org/repo' }, pull_request: { number: NaN } }),
      ];

      for (const rawBody of invalidPrBodies) {
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: rawBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 400);
        assert.equal(await res.text(), 'Bad Request: Missing or invalid repository / pull_request payload');
      }
    });

    it('successfully processes pull_request with sparse metadata without throwing TypeErrors', async () => {
      const { env, mockCtx, dispatchedWorkflows } = createWorkerTestEnv({
        PILOT_REPOSITORIES: 'review-yeti-ai/review-yeti-bot',
      });
      // Payload with valid full_name and PR number, but missing owner, name, head, base
      const sparsePayload = {
        action: 'opened',
        repository: {
          full_name: 'review-yeti-ai/review-yeti-bot',
        },
        pull_request: {
          number: 99,
        },
      };
      const rawBody = JSON.stringify(sparsePayload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'dispatched_immediate');
      assert.equal(dispatchedWorkflows.length, 1);
      assert.equal(dispatchedWorkflows[0].params.owner, 'review-yeti-ai');
      assert.equal(dispatchedWorkflows[0].params.repo, 'review-yeti-bot');
      assert.equal(dispatchedWorkflows[0].params.prNumber, 99);
      assert.equal(dispatchedWorkflows[0].params.headSha, '');
      assert.equal(dispatchedWorkflows[0].params.baseSha, '');
    });

    it('returns HTTP 400 when non-PR event payload is not an object', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      const rawBody = '"just a string"';
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, rawBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'ping',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Bad Request: Invalid JSON payload object');
    });

    it('catches unexpected runtime exceptions in worker.fetch and returns HTTP 400 without throwing 500', async () => {
      const { env, mockCtx } = createWorkerTestEnv();
      // Pass a malformed Request whose text() throws
      const faultyReq = {
        url: 'https://operator.internal/api/webhooks/github',
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
        }),
        text: async () => {
          throw new Error('Simulated socket stream abruptly truncated');
        },
      } as any;

      const res = await worker.fetch(faultyReq, env, mockCtx as any);
      assert.equal(res.status, 400);
      assert.equal(await res.text(), 'Bad Request: Ingress webhook processing failure');
    });
  });
});
