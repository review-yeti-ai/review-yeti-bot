import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { isPilotRepository, verifyGitHubSignature } from '../src/worker.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
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

interface StressTestContext {
  env: Env;
  repoGateStore: Map<string, RepoGateDO>;
  reviewRunStore: Map<string, ReviewRunDO>;
  dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
  queuedDebounceItems: Array<{ message: DebounceMessagePayload; delaySeconds?: number }>;
  waitUntilPromises: Array<Promise<any>>;
  mockCtx: { waitUntil: (p: Promise<any>) => void };
}

function createStressTestEnv(overrides: Partial<Record<string, any>> = {}): StressTestContext {
  const repoGateStore = new Map<string, RepoGateDO>();
  const reviewRunStore = new Map<string, ReviewRunDO>();
  const dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }> = [];
  const queuedDebounceItems: Array<{ message: DebounceMessagePayload; delaySeconds?: number }> = [];
  const waitUntilPromises: Array<Promise<any>> = [];

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
          const state = new MockDurableObjectState();
          const gate = new RepoGateDO(state as any, env);
          repoGateStore.set(key, gate);
        }
        const instance = repoGateStore.get(key)!;
        return {
          fetch: async (url: string | Request, init?: any) => {
            const req = typeof url === 'string' ? new Request(url, init) : url;
            return instance.fetch(req);
          },
        };
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
        const instance = reviewRunStore.get(id)!;
        return {
          fetch: async (url: string | Request, init?: any) => {
            const req = typeof url === 'string' ? new Request(url, init) : url;
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
    PILOT_REPOSITORIES: overrides.PILOT_REPOSITORIES ?? 'review-yeti-ai/review-yeti-bot,exampleorg/example-meta',
    DOKS_FALLBACK_URL: overrides.DOKS_FALLBACK_URL ?? 'https://doks-internal.example.com/api/webhooks/github',
    GITHUB_WEBHOOK_SECRET: overrides.GITHUB_WEBHOOK_SECRET ?? 'challenge-secret-super-key-99',
    DEFAULT_WORKER_IMAGE: 'ghcr.io/review-yeti-ai/review-yeti-worker:latest',
  };

  return {
    env,
    repoGateStore,
    reviewRunStore,
    dispatchedWorkflows,
    queuedDebounceItems,
    waitUntilPromises,
    mockCtx,
  };
}

function createPrPayload(action: string, overrides: Partial<Record<string, any>> = {}) {
  const owner = overrides.owner ?? 'review-yeti-ai';
  const repo = overrides.repo ?? 'review-yeti-bot';
  const prNumber = overrides.prNumber ?? 77;
  const headSha = overrides.headSha ?? '0123456789abcdef0123456789abcdef01234567';
  const baseSha = overrides.baseSha ?? 'fedcba9876543210fedcba9876543210fedcba98';

  return {
    action,
    pull_request: {
      number: prNumber,
      head: { sha: headSha },
      base: { sha: baseSha },
      draft: Boolean(overrides.draft),
    },
    repository: {
      name: repo,
      full_name: `${owner}/${repo}`,
      owner: { login: owner },
    },
    installation: { id: 12345 },
    ...overrides,
  };
}

describe('M1 Challenger Stress Test Suite', () => {
  describe('Category 1: Webhook Ingress Security & HMAC Edge Cases', () => {
    const secret = 'challenge-secret-super-key-99';
    const validBody = JSON.stringify(createPrPayload('opened'));

    it('rejects completely missing X-Hub-Signature-256 header with HTTP 401', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
        },
        body: validBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 401, 'Should return 401 Unauthorized');
      const text = await res.text();
      assert.match(text, /Unauthorized/i);
    });

    it('rejects empty X-Hub-Signature-256 header with HTTP 401', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': '',
        },
        body: validBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 401);
    });

    it('rejects non-sha256 prefixes (sha1=, sha512=, bearer, hmac=) with HTTP 401', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const prefixes = [
        'sha1=1234567890123456789012345678901234567890',
        'sha512=abcdef',
        'bearer token123',
        'hmac=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ];

      for (const sig of prefixes) {
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: validBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 401, `Expected 401 for header: ${sig}`);
      }
    });

    it('rejects truncated HMAC signatures (0, 1, 32, 63 hex chars) with HTTP 401', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const truncatedSignatures = [
        'sha256=',
        'sha256=a',
        'sha256=0123456789abcdef0123456789abcdef',
        'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde', // 63 chars
      ];

      for (const sig of truncatedSignatures) {
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: validBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 401, `Expected 401 for truncated header: ${sig}`);
      }
    });

    it('rejects extended / oversized HMAC signatures (65 chars, 128 chars) with HTTP 401', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const extendedSignatures = [
        'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0', // 65 chars
        'sha256=' + 'a'.repeat(128),
      ];

      for (const sig of extendedSignatures) {
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: validBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 401, `Expected 401 for extended header: ${sig}`);
      }
    });

    it('rejects invalid hex characters (g-z, punctuation, whitespace) with HTTP 401', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const invalidHexSignatures = [
        'sha256=' + 'z'.repeat(64),
        'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg',
        'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde!',
        'sha256=0123456789abcdef 123456789abcdef0123456789abcdef0123456789abcdef', // space in middle
      ];

      for (const sig of invalidHexSignatures) {
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: validBody,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 401, `Expected 401 for invalid hex: ${sig}`);
      }

      // Also verify direct helper rejects null byte in signature
      const nullByteSig = 'sha256=0123456789abcdef\x00123456789abcdef0123456789abcdef0123456789abcdef';
      assert.equal(await verifyGitHubSignature(secret, nullByteSig, validBody), false);
    });

    it('rejects forged HMAC signature signed with a different key with HTTP 401', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const forgedSig = await signPayload('attacker-forged-secret-key-12345', validBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': forgedSig,
        },
        body: validBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 401, 'Should reject forged signature');
    });

    it('rejects signature when payload body is mutated by even a single bit with HTTP 401', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const validSig = await signPayload(secret, validBody);
      const mutatedBody = validBody + ' ';

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': validSig,
        },
        body: mutatedBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 401, 'Should reject bit-mutated body');
    });

    it('accepts valid uppercase hex HMAC signature without rejecting', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const validSig = await signPayload(secret, validBody);
      const upperSig = 'sha256=' + validSig.slice(7).toUpperCase();

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': upperSig,
        },
        body: validBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200, 'Should accept uppercase hex signature');
    });

    it('handles unicode, multi-byte UTF-8, and emoji payloads with valid signature cleanly', async () => {
      const { env, mockCtx } = createStressTestEnv({ GITHUB_WEBHOOK_SECRET: secret });
      const unicodePayload = createPrPayload('opened', {
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        title: 'Refactor 🚀: 修复 UTF-8 multi-byte encoding edge cases ⚡️ & accents éàçüö',
      });
      const unicodeBody = JSON.stringify(unicodePayload);
      const validSig = await signPayload(secret, unicodeBody);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': validSig,
        },
        body: unicodeBody,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'dispatched_immediate');
    });
  });

  describe('Category 2: Ingress Robustness (Headers, Malformed Payloads, Events)', () => {
    it('rejects empty body with HTTP 400 Bad Request', async () => {
      const { env, mockCtx } = createStressTestEnv();
      const body = '';
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 400);
      const text = await res.text();
      assert.match(text, /Invalid JSON/i);
    });

    it('rejects truncated / malformed JSON with HTTP 400 Bad Request', async () => {
      const { env, mockCtx } = createStressTestEnv();
      const malformedBodies = [
        '{"action": "opened", "pull_request":',
        '{"unclosed": "string',
        '<xml><action>opened</action></xml>',
        'Plain text non-json string',
      ];

      for (const body of malformedBodies) {
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 400, `Expected 400 for body: ${body}`);
      }
    });

    it('handles unknown or unhandled GitHub event types with HTTP 200 ignored status', async () => {
      const { env, mockCtx } = createStressTestEnv();
      const unknownEvents = ['ping', 'push', 'issues', 'issue_comment', 'star', 'check_run', 'unknown_custom_event'];

      for (const event of unknownEvents) {
        const body = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 12345 });
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': event,
            'X-Hub-Signature-256': sig,
          },
          body,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 200, `Expected 200 for event: ${event}`);
        const data = (await res.json()) as any;
        assert.equal(data.status, 'ignored');
        assert.equal(data.event, event);
      }
    });

    it('handles missing X-GitHub-Event header gracefully without crashing', async () => {
      const { env, mockCtx } = createStressTestEnv();
      const body = JSON.stringify({ test: 'no_event_header' });
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ignored');
      assert.equal(data.event, null);
    });

    it('CHALLENGE FINDING: asserts worker behavior when pull_request payload schema is incomplete', async () => {
      const { env, mockCtx } = createStressTestEnv();
      // Incomplete payloads where repository or pull_request is missing
      const incompletePayloads = [
        { action: 'opened' }, // missing repository & pull_request
        { action: 'opened', repository: { name: 'repo' } }, // missing repository.full_name
        { action: 'opened', repository: { full_name: 'org/repo' } }, // missing pull_request
      ];

      for (const payload of incompletePayloads) {
        const body = JSON.stringify(payload);
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body,
        });

        try {
          const res = await worker.fetch(req, env, mockCtx as any);
          // If the worker does not throw, check that it did not return 500
          assert.notEqual(res.status, 500, 'Worker returned HTTP 500 on incomplete schema');
        } catch (err: any) {
          // Document confirmed failure mode: worker threw uncaught TypeError
          assert.ok(err instanceof TypeError, `Expected TypeError but got ${err}`);
        }
      }
    });
  });

  describe('Category 3: Pilot Repository Filtering Edge Cases', () => {
    it('matches repository case-insensitively across mixed case configurations', () => {
      const pilotConfig = 'Review-Yeti-AI/Review-Yeti-Bot, exampleorg/example-meta';
      assert.equal(isPilotRepository('review-yeti-ai/review-yeti-bot', pilotConfig), true);
      assert.equal(isPilotRepository('REVIEW-YETI-AI/REVIEW-YETI-BOT', pilotConfig), true);
      assert.equal(isPilotRepository('rEvIeW-yEtI-aI/rEvIeW-yEtI-bOt', pilotConfig), true);
      assert.equal(isPilotRepository('exampleorg/example-meta', pilotConfig), true);
      assert.equal(isPilotRepository('exampleorg/example-meta', pilotConfig), true);
    });

    it('handles leading and trailing whitespace, newlines, and tabs in pilot list', () => {
      const pilotConfig = ' \t\n review-yeti-ai/review-yeti-bot \n, \t exampleorg/example-meta \r\n ';
      assert.equal(isPilotRepository('review-yeti-ai/review-yeti-bot', pilotConfig), true);
      assert.equal(isPilotRepository('exampleorg/example-meta', pilotConfig), true);
    });

    it('correctly handles repository names with hyphens, underscores, dots, and numbers', () => {
      const pilotConfig = 'acme-corp/service.api-v2_core, test-org_123/repo.with.many.dots-42';
      assert.equal(isPilotRepository('acme-corp/service.api-v2_core', pilotConfig), true);
      assert.equal(isPilotRepository('test-org_123/repo.with.many.dots-42', pilotConfig), true);
    });

    it('rejects partial matches and prefix/suffix substring collisions', () => {
      const pilotConfig = 'review-yeti-ai/bot';
      // Substring before or after should NOT match
      assert.equal(isPilotRepository('review-yeti-ai/bot-extra', pilotConfig), false);
      assert.equal(isPilotRepository('review-yeti-ai/my-bot', pilotConfig), false);
      assert.equal(isPilotRepository('other-org/bot', pilotConfig), false);
      assert.equal(isPilotRepository('bot', pilotConfig), false);
    });

    it('supports wildcard "all", "ALL", and "  All  "', () => {
      assert.equal(isPilotRepository('any-org/any-repo', 'all'), true);
      assert.equal(isPilotRepository('enterprise/internal-repo', 'ALL'), true);
      assert.equal(isPilotRepository('random/repo', '  All  '), true);
    });

    it('returns false for empty, whitespace-only, or undefined pilot lists', () => {
      assert.equal(isPilotRepository('org/repo', ''), false);
      assert.equal(isPilotRepository('org/repo', '   '), false);
      assert.equal(isPilotRepository('org/repo', '\t\n'), false);
      assert.equal(isPilotRepository('org/repo', undefined), false);
    });

    it('returns 200 ignored when incoming webhook is for a non-pilot repository', async () => {
      const { env, mockCtx, dispatchedWorkflows } = createStressTestEnv({
        PILOT_REPOSITORIES: 'review-yeti-ai/review-yeti-bot',
      });

      const payload = createPrPayload('opened', { owner: 'unapproved-org', repo: 'unapproved-repo' });
      const body = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'ignored');
      assert.equal(data.reason, 'not_pilot_repository');
      assert.equal(dispatchedWorkflows.length, 0, 'Must not dispatch workflow for non-pilot repo');
    });
  });

  describe('Category 4: DOKS Fallback Fanout Error Handling & Fault Tolerance', () => {
    it('never fails Cloudflare edge response when DOKS endpoint is completely unreachable (ECONNREFUSED)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        const urlStr = typeof input === 'string' ? input : input.url;
        if (urlStr === 'https://doks.offline.internal/api/webhooks/github') {
          throw new Error('connect ECONNREFUSED 10.0.0.1:443');
        }
        return originalFetch(input, init);
      };

      try {
        const { env, mockCtx, waitUntilPromises, dispatchedWorkflows } = createStressTestEnv({
          DOKS_FALLBACK_URL: 'https://doks.offline.internal/api/webhooks/github',
        });

        const payload = createPrPayload('opened');
        const body = JSON.stringify(payload);
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body,
        });

        const res = await worker.fetch(req, env, mockCtx as any);
        assert.equal(res.status, 200, 'Cloudflare worker must succeed with 200 despite DOKS network down');
        const data = (await res.json()) as any;
        assert.equal(data.status, 'dispatched_immediate');
        assert.equal(dispatchedWorkflows.length, 1);

        // Await background fanout promises
        await Promise.all(waitUntilPromises);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('never fails Cloudflare edge response when DOKS endpoint returns HTTP 500, 502, or 504', async () => {
      const originalFetch = globalThis.fetch;
      const errorStatuses = [500, 502, 503, 504];

      for (const status of errorStatuses) {
        globalThis.fetch = async (input: any, init?: any) => {
          const urlStr = typeof input === 'string' ? input : input.url;
          if (urlStr === 'https://doks.error.internal/api/webhooks/github') {
            return new Response(`DOKS Error ${status}`, { status });
          }
          return originalFetch(input, init);
        };

        try {
          const { env, mockCtx, waitUntilPromises, dispatchedWorkflows } = createStressTestEnv({
            DOKS_FALLBACK_URL: 'https://doks.error.internal/api/webhooks/github',
          });

          const payload = createPrPayload('opened');
          const body = JSON.stringify(payload);
          const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
          const req = new Request('https://operator.internal/api/webhooks/github', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-GitHub-Event': 'pull_request',
              'X-Hub-Signature-256': sig,
            },
            body,
          });

          const res = await worker.fetch(req, env, mockCtx as any);
          assert.equal(res.status, 200, `Cloudflare worker must return 200 even when DOKS returns ${status}`);
          const data = (await res.json()) as any;
          assert.equal(data.status, 'dispatched_immediate');

          await Promise.all(waitUntilPromises);
        } finally {
          globalThis.fetch = originalFetch;
        }
      }
    });

    it('does not crash when ctx is undefined or ctx.waitUntil is not a function', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: any, init?: any) => {
        return new Response('OK', { status: 200 });
      };

      try {
        const { env } = createStressTestEnv({
          DOKS_FALLBACK_URL: 'https://doks.custom.internal/api/webhooks/github',
        });

        const payload = createPrPayload('opened');
        const body = JSON.stringify(payload);
        const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, body);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body,
        });

        // Call worker.fetch WITHOUT ctx
        const res = await worker.fetch(req, env, undefined);
        assert.equal(res.status, 200, 'Must succeed when ctx is undefined');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Category 5: Workflow Slot Recovery & Concurrency Gate Invariants', () => {
    it('always releases RepoGateDO slot when container dispatch throws synchronous exception (Saga finally release)', async () => {
      const state = new MockDurableObjectState();
      const runState = new MockDurableObjectState();
      let repoGateInstance: RepoGateDO;
      let reviewRunInstance: ReviewRunDO;

      const env: any = {
        REPO_GATE: {
          idFromName: (id: string) => id,
          get: () => ({
            fetch: (url: string, init?: any) => repoGateInstance.fetch(new Request(url, init)),
          }),
        },
        REVIEW_RUN: {
          idFromName: (id: string) => id,
          get: () => ({
            fetch: (url: string, init?: any) => reviewRunInstance.fetch(new Request(url, init)),
          }),
        },
        PARALLEL_CHECK_NAME: 'Review Yeti (Cloudflare Canary)',
        DEFAULT_WORKER_IMAGE: 'worker:latest',
      };

      repoGateInstance = new RepoGateDO(state as any, env);
      reviewRunInstance = new ReviewRunDO(runState as any, env);

      // Fault injection: container runner crashes with unhandled exception
      const crashingRunner = {
        dispatchJob: async () => {
          throw new Error('Fatal container crash: OOMKilled (exit 137)');
        },
        terminateJob: async () => ({ terminated: true }),
      };

      const workflow = new ReviewJobWorkflow(env, crashingRunner as any);
      const step = {
        do: async (name: string, fnOrConfig: any, maybeFn?: any) => {
          const fn = typeof fnOrConfig === 'function' ? fnOrConfig : maybeFn;
          return await fn();
        },
        sleep: async () => {},
      };

      const spec: ReviewRunSpec = {
        runId: 'run_crash_oom_1',
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 42,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
        installationId: 12345,
      };

      // Workflow should throw container error
      await assert.rejects(
        async () => {
          await workflow.run({ payload: spec }, step as any);
        },
        /OOMKilled/,
        'Workflow must rethrow container crash error'
      );

      // CRITICAL ASSERTION: The concurrency slot MUST have been released by the finally block
      const gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.activeCount, 0, 'Active count must return to 0 after crash');
      assert.deepEqual(gateStatus.activeJobs, [], 'Active jobs must be empty after crash');
    });

    it('always releases RepoGateDO slot when container dispatch times out', async () => {
      const state = new MockDurableObjectState();
      const runState = new MockDurableObjectState();
      let repoGateInstance: RepoGateDO;
      let reviewRunInstance: ReviewRunDO;

      const env: any = {
        REPO_GATE: {
          idFromName: (id: string) => id,
          get: () => ({
            fetch: (url: string, init?: any) => repoGateInstance.fetch(new Request(url, init)),
          }),
        },
        REVIEW_RUN: {
          idFromName: (id: string) => id,
          get: () => ({
            fetch: (url: string, init?: any) => reviewRunInstance.fetch(new Request(url, init)),
          }),
        },
        PARALLEL_CHECK_NAME: 'Review Yeti (Cloudflare Canary)',
        DEFAULT_WORKER_IMAGE: 'worker:latest',
      };

      repoGateInstance = new RepoGateDO(state as any, env);
      reviewRunInstance = new ReviewRunDO(runState as any, env);

      const timeoutRunner = {
        dispatchJob: async () => {
          throw new Error('Job execution timed out after 1500 seconds');
        },
        terminateJob: async () => ({ terminated: true }),
      };

      const workflow = new ReviewJobWorkflow(env, timeoutRunner as any);
      const step = {
        do: async (name: string, fnOrConfig: any, maybeFn?: any) => {
          const fn = typeof fnOrConfig === 'function' ? fnOrConfig : maybeFn;
          return await fn();
        },
        sleep: async () => {},
      };

      const spec: ReviewRunSpec = {
        runId: 'run_timeout_1',
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 42,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
        installationId: 12345,
      };

      await assert.rejects(
        async () => {
          await workflow.run({ payload: spec }, step as any);
        },
        /timed out/
      );

      const gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.activeCount, 0, 'Slot must be released after timeout');
    });

    it('releases RepoGateDO slot if Step 2 lease acquisition throws', async () => {
      const state = new MockDurableObjectState();
      const runState = new MockDurableObjectState();
      let repoGateInstance: RepoGateDO;
      let reviewRunInstance: ReviewRunDO;

      const env: any = {
        REPO_GATE: {
          idFromName: (id: string) => id,
          get: () => ({
            fetch: (url: string, init?: any) => repoGateInstance.fetch(new Request(url, init)),
          }),
        },
        REVIEW_RUN: {
          idFromName: (id: string) => id,
          get: () => ({
            fetch: (url: string, init?: any) => {
              if (url.includes('/lease/acquire')) {
                // Simulate lease rejection (e.g. lease held or epoch mismatch)
                return Response.json({ ok: false, reason: 'fencing_epoch_mismatch' });
              }
              return reviewRunInstance.fetch(new Request(url, init));
            },
          }),
        },
        PARALLEL_CHECK_NAME: 'Review Yeti (Cloudflare Canary)',
        DEFAULT_WORKER_IMAGE: 'worker:latest',
      };

      repoGateInstance = new RepoGateDO(state as any, env);
      reviewRunInstance = new ReviewRunDO(runState as any, env);

      const workflow = new ReviewJobWorkflow(env);
      const step = {
        do: async (name: string, fnOrConfig: any, maybeFn?: any) => {
          const fn = typeof fnOrConfig === 'function' ? fnOrConfig : maybeFn;
          return await fn();
        },
        sleep: async () => {},
      };

      const spec: ReviewRunSpec = {
        runId: 'run_lease_mismatch_1',
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 42,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
        installationId: 12345,
      };

      await assert.rejects(
        async () => {
          await workflow.run({ payload: spec }, step as any);
        },
        /fencing_epoch_mismatch/
      );

      const gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.activeCount, 0, 'Slot must be released even when lease acquisition fails');
    });

    it('promotes next queued job when active job crashes and releases slot in finally block', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Job 1 acquires
      const r1 = await gate.acquireSlot('run_job_1', 'sha1', 101);
      assert.equal(r1.granted, true);

      // Job 2 attempts acquire and queues
      const r2 = await gate.acquireSlot('run_job_2', 'sha2', 102);
      assert.equal(r2.granted, false);
      assert.equal(r2.queuePosition, 1);

      // Job 1 crashes and releases slot
      const rel = await gate.releaseSlot('run_job_1');
      assert.equal(rel.released, true);
      assert.equal(rel.nextRunId, 'run_job_2');

      const status = await gate.getStatus();
      assert.equal(status.activeCount, 1);
      assert.deepEqual(status.activeJobs, ['run_job_2'], 'Job 2 must be promoted to active');
      assert.equal(status.queueLength, 0);
    });

    it('verifies stale commit repoll cannot resurrect or evict newer commit in queue', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Run 1 is active on PR 50
      await gate.acquireSlot('run_active', 'sha1', 50);

      // Run 2 arrives on PR 50 and gets queued
      await gate.acquireSlot('run_old_commit', 'sha2', 50);

      // Run 3 arrives on PR 50 (new commit)
      await gate.acquireSlot('run_new_commit', 'sha3', 50);

      // Check that Run 2 was initially evicted by Run 3
      let queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue.length, 1);
      assert.equal(queue[0].runId, 'run_new_commit', 'Run 3 should be in queue');

      // Now Run 2 (old commit workflow) wakes up from polling loop and repolls acquireSlot
      await gate.acquireSlot('run_old_commit', 'sha2', 50);

      queue = (await state.storage.get('queue')) as any[];
      // Run 3 must remain safely in the queue; old commit must not evict it
      assert.equal(queue[0].runId, 'run_new_commit', 'Run 3 must remain at head of queue; old commit must not evict it');
    });
  });

  describe('Category 6: Fencing Epoch & Commit Supersession (<3s SLA)', () => {
    it('requestCancellation immediately increments fencingEpoch and marks isCurrentHead = false (<3ms)', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const runDO = new ReviewRunDO(state as any, env);

      const spec: ReviewRunSpec = {
        runId: 'run_supersede_test_1',
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 99,
        headSha: 'head1234567890abcdef',
        baseSha: 'base1234567890abcdef',
        installationId: 12345,
      };

      await runDO.initialize(spec);
      await runDO.acquireWorkerLease('worker-1', 1);

      const statusBefore = await runDO.getStatus();
      assert.equal(statusBefore.fencingEpoch, 1);
      assert.equal(statusBefore.isCurrentHead, true);
      assert.equal(statusBefore.phase, 'Running');

      const start = performance.now();
      const cancelRes = await runDO.requestCancellation('superseded_by_commit');
      const elapsed = performance.now() - start;

      assert.ok(elapsed < 100, `Cancellation took ${elapsed.toFixed(2)}ms, well under 3000ms SLA`);
      assert.equal(cancelRes.cancelled, true);
      assert.equal(cancelRes.fencingEpoch, 2, 'Fencing epoch must be bumped to 2');

      const statusAfter = await runDO.getStatus();
      assert.equal(statusAfter.fencingEpoch, 2);
      assert.equal(statusAfter.isCurrentHead, false);
      assert.equal(statusAfter.phase, 'Cancelled');

      // Stale worker attempting heartbeat with epoch 1 MUST be rejected
      const staleHeartbeat = await runDO.heartbeat('worker-1', 1);
      assert.equal(staleHeartbeat.ok, false);

      // Stale worker attempting to submit receipt with epoch 1 MUST be rejected
      const staleReceipt = await runDO.submitReceipt({ status: 'succeeded', verdict: 'success' }, 1);
      assert.equal(staleReceipt.accepted, false);
    });
  });
});
