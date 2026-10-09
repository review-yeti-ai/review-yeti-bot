import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  signGitHubAppJwt,
  getInstallationToken,
  clearCachedToken,
  importRsaPrivateKey,
  REVIEW_WORKER_CHECK_NAME,
  REVIEW_GATE_CHECK_NAME,
  REVIEW_REFRESH_ACTION,
  deriveWorkerExternalId,
  deriveGateExternalId,
  formatCheckAnnotations,
  createPendingChecks,
  completeChecks,
  STICKY_OVERVIEW_MARKER,
  ALT_STICKY_OVERVIEW_MARKER,
  formatStickyCommentMarkdown,
  findExistingStickyComment,
  publishStickyComment,
} from '../src/github/index.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { MockDurableObjectState } from './mockDurableObject.js';

// Generate test RSA keypair (2048-bit)
const { privateKey: pkcs8KeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const { privateKey: pkcs1KeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

describe('Phase 2: Authoritative Edge App Publisher', () => {
  describe('Module 2A: GitHub App Authentication & Token Caching (githubAppAuth)', () => {
    it('successfully imports and signs JWT using PKCS#8 private key', async () => {
      const jwt = await signGitHubAppJwt('12345', pkcs8KeyPem);
      assert.ok(jwt);
      const parts = jwt.split('.');
      assert.equal(parts.length, 3);

      const header = JSON.parse(atob(parts[0]));
      assert.equal(header.alg, 'RS256');
      assert.equal(header.typ, 'JWT');

      const payload = JSON.parse(atob(parts[1]));
      assert.equal(payload.iss, '12345');
      assert.ok(payload.exp > payload.iat);
    });

    it('successfully imports and signs JWT using PKCS#1 private key', async () => {
      assert.ok(pkcs1KeyPem.includes('BEGIN RSA PRIVATE KEY'));
      const jwt = await signGitHubAppJwt('67890', pkcs1KeyPem);
      assert.ok(jwt);
      const parts = jwt.split('.');
      assert.equal(parts.length, 3);

      const payload = JSON.parse(atob(parts[1]));
      assert.equal(payload.iss, '67890');
    });

    it('returns env.GITHUB_TOKEN directly if provided', async () => {
      const env = { GITHUB_TOKEN: 'ghp_static_token_override' };
      const token = await getInstallationToken(env, 'exampleorg', 'sample-repo');
      assert.equal(token, 'ghp_static_token_override');
    });

    it('returns null if GitHub App credentials are missing', async () => {
      const env = {};
      const token = await getInstallationToken(env, 'exampleorg', 'sample-repo');
      assert.equal(token, null);
    });

    it('retrieves cached installation token from AUTH_CACHE KV without hitting GitHub API', async () => {
      const cache = new Map<string, string>();
      cache.set('gh_token_exampleorg_sample-repo', 'ghs_cached_token_123');

      let fetchCalled = false;
      const mockFetch = async () => {
        fetchCalled = true;
        return new Response('{}');
      };

      const env = {
        GITHUB_APP_ID: '12345',
        GITHUB_APP_PRIVATE_KEY: pkcs8KeyPem,
        AUTH_CACHE: {
          get: async (key: string) => cache.get(key) || null,
          put: async (key: string, val: string) => { cache.set(key, val); },
        },
      };

      const token = await getInstallationToken(env, 'exampleorg', 'sample-repo', undefined, mockFetch as any);
      assert.equal(token, 'ghs_cached_token_123');
      assert.equal(fetchCalled, false);
    });

    it('mints new installation token, caches it in KV with TTL, and resolves installation ID', async () => {
      const cache = new Map<string, { value: string; ttl?: number }>();
      const calls: string[] = [];

      const mockFetch = async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method || 'GET'} ${url}`);
        if (url.includes('/access_tokens')) {
          return Response.json({ token: 'ghs_fresh_minted_token_456', expires_at: new Date(Date.now() + 3600000).toISOString() });
        }
        if (url.endsWith('/installation')) {
          return Response.json({ id: 998877 });
        }
        return new Response('Not Found', { status: 404 });
      };

      const env = {
        GITHUB_APP_ID: '12345',
        GITHUB_APP_PRIVATE_KEY: pkcs8KeyPem,
        AUTH_CACHE: {
          get: async (key: string) => cache.get(key)?.value || null,
          put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
            cache.set(key, { value, ttl: opts?.expirationTtl });
          },
        },
      };

      const token = await getInstallationToken(env, 'exampleorg', 'sample-repo', undefined, mockFetch as any);
      assert.equal(token, 'ghs_fresh_minted_token_456');
      assert.equal(calls.length, 2);
      assert.ok(calls[0].includes('/repos/exampleorg/sample-repo/installation'));
      assert.ok(calls[1].includes('/app/installations/998877/access_tokens'));

      // Verify cached in KV
      const cachedEntry = cache.get('gh_token_exampleorg_sample-repo');
      assert.ok(cachedEntry);
      assert.equal(cachedEntry.value, 'ghs_fresh_minted_token_456');
      assert.equal(cachedEntry.ttl, 3000);
    });

    it('clears cached installation token from AUTH_CACHE KV', async () => {
      const cache = new Map<string, string>();
      cache.set('gh_token_exampleorg_sample-repo', 'ghs_old');

      const env = {
        AUTH_CACHE: {
          get: async (k: string) => cache.get(k) || null,
          put: async (k: string, v: string) => { cache.set(k, v); },
          delete: async (k: string) => { cache.delete(k); },
        },
      };

      await clearCachedToken(env, 'exampleorg', 'sample-repo');
      assert.equal(cache.has('gh_token_exampleorg_sample-repo'), false);
    });
  });

  describe('Module 2B: Edge Check Run Publisher (edgeCheckPublisher)', () => {
    it('creates deterministic external IDs for worker and gate checks', async () => {
      const workerId = deriveWorkerExternalId('run_12345678abcdef', 2);
      assert.equal(workerId, 'run_12345678abcdef:a2');

      const gateId1 = await deriveGateExternalId({
        owner: 'exampleorg',
        repo: 'sample-repo',
        headSha: 'a'.repeat(40),
        runId: 'run_12345678abcdef',
      });
      const gateId2 = await deriveGateExternalId({
        owner: 'exampleorg',
        repo: 'sample-repo',
        headSha: 'a'.repeat(40),
        runId: 'run_12345678abcdef',
      });
      assert.ok(gateId1.startsWith('review-yeti-gate:v1:'));
      assert.equal(gateId1, gateId2);
    });

    it('formats check run annotations adhering to GitHub 50-item limit and severity mapping', () => {
      const findings = Array.from({ length: 60 }, (_, i) => ({
        path: `src/file_${i}.ts`,
        line: 10 + i,
        startLine: 8 + i,
        severity: (i === 0 ? 'P0' : i === 1 ? 'critical' : 'P2') as any,
        title: `Finding #${i}`,
        description: `Description for ${i}`,
        suggestedFix: i % 2 === 0 ? `cleanFix(${i})` : undefined,
      }));

      const annotations = formatCheckAnnotations(findings);
      assert.equal(annotations.length, 50); // Capped at 50

      assert.equal(annotations[0].annotation_level, 'failure'); // P0
      assert.equal(annotations[0].start_line, 8);
      assert.equal(annotations[0].end_line, 10);
      assert.ok(annotations[0].raw_details?.includes('cleanFix(0)'));

      assert.equal(annotations[1].annotation_level, 'failure'); // critical
      assert.equal(annotations[2].annotation_level, 'warning'); // P2
    });

    it('creates pending check runs for both Review Yeti and Review Yeti Gate', async () => {
      const createdRequests: any[] = [];
      const mockFetch = async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        createdRequests.push({ url, body });
        return Response.json({ id: body.name === REVIEW_WORKER_CHECK_NAME ? 101 : 202 });
      };

      const result = await createPendingChecks({
        owner: 'exampleorg',
        repo: 'sample-repo',
        headSha: 'c0ffee'.repeat(6) + '1234',
        runId: 'run_test_pending_1',
        token: 'ghs_test_token',
        fetchFn: mockFetch as any,
      });

      assert.equal(result.workerCheckId, 101);
      assert.equal(result.gateCheckId, 202);
      assert.equal(createdRequests.length, 2);

      const workerReq = createdRequests.find((r) => r.body.name === REVIEW_WORKER_CHECK_NAME);
      assert.ok(workerReq);
      assert.equal(workerReq.body.status, 'in_progress');
      assert.equal(workerReq.body.output.title, 'Review Yeti: evaluating');

      const gateReq = createdRequests.find((r) => r.body.name === REVIEW_GATE_CHECK_NAME);
      assert.ok(gateReq);
      assert.equal(gateReq.body.status, 'in_progress');
      assert.equal(gateReq.body.output.title, 'Review Yeti Gate: Running');
    });

    it('completes checks on success with SHIP verdict and Approved gate title', async () => {
      const patchRequests: any[] = [];
      const mockFetch = async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        patchRequests.push({ url, method: init?.method, body });
        return Response.json({ id: url.includes('101') ? 101 : 202 });
      };

      const result = await completeChecks({
        owner: 'exampleorg',
        repo: 'sample-repo',
        headSha: 'c0ffee'.repeat(6) + '1234',
        runId: 'run_test_complete_success',
        token: 'ghs_test_token',
        verdict: 'success',
        workerCheckId: 101,
        gateCheckId: 202,
        findings: [],
        fetchFn: mockFetch as any,
      });

      assert.equal(result.workerCheckId, 101);
      assert.equal(result.gateCheckId, 202);

      const workerPatch = patchRequests.find((r) => r.url.includes('/101'));
      assert.ok(workerPatch);
      assert.equal(workerPatch.method, 'PATCH');
      assert.equal(workerPatch.body.status, 'completed');
      assert.equal(workerPatch.body.conclusion, 'success');
      assert.equal(workerPatch.body.output.title, 'Review Yeti: SHIP');

      const gatePatch = patchRequests.find((r) => r.url.includes('/202'));
      assert.ok(gatePatch);
      assert.equal(gatePatch.body.status, 'completed');
      assert.equal(gatePatch.body.conclusion, 'success');
      assert.equal(gatePatch.body.output.title, 'Review Yeti Gate: Approved (SHIP)');
      assert.ok(gatePatch.body.output.summary.includes('policy eligibility gate passed'));
    });

    it('completes checks on failure with BLOCK verdict and Failed gate title', async () => {
      const patchRequests: any[] = [];
      const mockFetch = async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}'));
        patchRequests.push({ url, body });
        return Response.json({ id: 101 });
      };

      await completeChecks({
        owner: 'exampleorg',
        repo: 'sample-repo',
        headSha: 'c0ffee'.repeat(6) + '1234',
        runId: 'run_test_complete_block',
        token: 'ghs_test_token',
        verdict: 'action_required',
        workerCheckId: 101,
        gateCheckId: 202,
        findings: [
          { path: 'src/vuln.ts', line: 42, severity: 'P0', title: 'Hardcoded secret', description: 'Leaked credential' },
        ],
        fetchFn: mockFetch as any,
      });

      const workerPatch = patchRequests.find((r) => r.url.includes('/101'));
      assert.equal(workerPatch.body.conclusion, 'failure');
      assert.equal(workerPatch.body.output.title, 'Review Yeti: BLOCK');
      assert.equal(workerPatch.body.output.annotations.length, 1);
      assert.equal(workerPatch.body.output.annotations[0].annotation_level, 'failure');

      const gatePatch = patchRequests.find((r) => r.url.includes('/202'));
      assert.equal(gatePatch.body.conclusion, 'failure');
      assert.equal(gatePatch.body.output.title, 'Review Yeti Gate: Failed');
    });

    it('completes timed_out checks with refresh action admitted', async () => {
      const patchRequests: any[] = [];
      const mockFetch = async (url: string, init?: RequestInit) => {
        patchRequests.push(JSON.parse(String(init?.body || '{}')));
        return Response.json({ id: 101 });
      };

      await completeChecks({
        owner: 'exampleorg',
        repo: 'sample-repo',
        headSha: 'c0ffee'.repeat(6) + '1234',
        runId: 'run_test_timeout',
        token: 'ghs_test_token',
        verdict: 'timed_out',
        workerCheckId: 101,
        gateCheckId: 202,
        fetchFn: mockFetch as any,
      });

      const workerReq = patchRequests.find((r) => r.output.title === 'Review Yeti: review did not complete');
      assert.ok(workerReq);
      assert.equal(workerReq.conclusion, 'timed_out');
      assert.deepEqual(workerReq.actions, [REVIEW_REFRESH_ACTION]);
    });
  });

  describe('Module 2C: Sticky PR Overview Comment Publisher (stickyCommentPublisher)', () => {
    it('formats rich markdown overview with verdict, findings table, and dashboard footer', () => {
      const md = formatStickyCommentMarkdown({
        owner: 'exampleorg',
        repo: 'sample-repo',
        prNumber: 42,
        headSha: '1234567890abcdef1234567890abcdef12345678',
        verdict: 'success',
        findings: [
          {
            path: 'src/main.ts',
            line: 15,
            severity: 'P2',
            title: 'Unused import',
            description: 'Clean up unused import',
            suggestedFix: 'import { clean } from "./clean";',
          },
        ],
        metrics: {
          compactionRatio: 3.4,
          rawDiffTokens: 3400,
          compactedTokens: 1000,
          totalTokens: 12500,
          durationMs: 4200,
        },
        dashboardOrigin: 'https://review-bot.example.com',
      });

      assert.ok(md.includes('### 🚦 Review Yeti Verdict: **SHIP** (Passed)'));
      assert.ok(md.includes('| **P2** | `src/main.ts:15` | Unused import |'));
      assert.ok(md.includes('3.4x reduction'));
      assert.ok(md.includes('12,500'));
      assert.ok(md.includes('https://review-bot.example.com/dashboard/live?jobId='));
      assert.ok(md.includes('https://review-bot.example.com/dashboard/organization'));
    });

    it('discovers existing sticky comment containing STICKY_OVERVIEW_MARKER', async () => {
      const mockFetch = async () => {
        return Response.json([
          { id: 1, user: { login: 'some-user' }, body: 'Normal developer comment' },
          { id: 999, user: { login: 'ct-review-bot[bot]' }, body: `${STICKY_OVERVIEW_MARKER}\n\nPrior Review Yeti report` },
        ]);
      };

      const foundId = await findExistingStickyComment('exampleorg', 'sample-repo', 42, 'ghs_token', mockFetch as any);
      assert.equal(foundId, 999);
    });

    it('creates new comment when no existing sticky comment is found', async () => {
      let createdPayload: any = null;
      const mockFetch = async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          createdPayload = JSON.parse(String(init.body));
          return Response.json({ id: 505 });
        }
        return Response.json([]); // No existing comments
      };

      const res = await publishStickyComment({
        owner: 'exampleorg',
        repo: 'sample-repo',
        prNumber: 42,
        headSha: 'c0ffee'.repeat(6) + '1234',
        token: 'ghs_token',
        verdict: 'success',
        fetchFn: mockFetch as any,
      });

      assert.equal(res.success, true);
      assert.equal(res.action, 'created');
      assert.equal(res.commentId, 505);
      assert.ok(createdPayload.body.startsWith(STICKY_OVERVIEW_MARKER));
    });

    it('updates existing comment when sticky marker is found (no comment spam)', async () => {
      let patchedId: string | null = null;
      let patchedPayload: any = null;

      const mockFetch = async (url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          patchedId = url.split('/').pop()!;
          patchedPayload = JSON.parse(String(init.body));
          return Response.json({ id: 808 });
        }
        // Return existing comment on GET
        return Response.json([
          { id: 808, body: `${STICKY_OVERVIEW_MARKER}\n\nOld review` },
        ]);
      };

      const res = await publishStickyComment({
        owner: 'exampleorg',
        repo: 'sample-repo',
        prNumber: 42,
        headSha: 'c0ffee'.repeat(6) + '1234',
        token: 'ghs_token',
        verdict: 'action_required',
        fetchFn: mockFetch as any,
      });

      assert.equal(res.success, true);
      assert.equal(res.action, 'updated');
      assert.equal(res.commentId, 808);
      assert.equal(patchedId, '808');
      assert.ok(patchedPayload.body.includes('### 🛑 Review Yeti Verdict: **BLOCK**'));
    });
  });

  describe('Module 2D: ReviewRunDO Edge Artifacts Publication', () => {
    it('ReviewRunDO POST /publish triggers authoritative checks and sticky comment', async () => {
      const state = new MockDurableObjectState();
      const calls: string[] = [];

      // Intercept global fetch for GitHub API check
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push(`${init?.method || 'GET'} ${u}`);
        if (u.includes('/check-runs')) {
          return Response.json({ id: 777 });
        }
        if (init?.method === 'POST' && u.includes('/issues/42/comments')) {
          return Response.json({ id: 888 });
        }
        if (u.includes('/issues/comments')) {
          return Response.json({ id: 888 });
        }
        if (u.includes('/issues/42/comments')) {
          return Response.json([]);
        }
        return new Response('{}');
      }) as any;

      try {
        const env: any = {
          GITHUB_TOKEN: 'ghs_active_token',
        };

        const doInstance = new ReviewRunDO(state as any, env);
        await doInstance.initialize({
          runId: 'run_durable_test_publish',
          owner: 'exampleorg',
          repo: 'sample-repo',
          prNumber: 42,
          headSha: 'c0ffee'.repeat(6) + '1234',
          baseSha: 'b0ffee'.repeat(6) + '1234',
          installationId: 1234,
        });

        const req = new Request('http://do/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            verdict: 'success',
            summaryMarkdown: 'Review Yeti consensus: SHIP.',
          }),
        });

        const res = await doInstance.fetch(req);
        assert.equal(res.status, 200);
        const data = (await res.json()) as any;

        assert.equal(data.published, true);
        assert.equal(data.workerCheckId, 777);
        assert.equal(data.gateCheckId, 777);
        assert.equal(data.commentId, 888);

        // Verify check-runs and issue comments were published
        assert.ok(calls.some((c) => c.includes('POST') && c.includes('/check-runs')));
        assert.ok(calls.some((c) => c.includes('POST') && c.includes('/comments')));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('ReviewRunDO POST /publish safely handles missing or unauthenticated tokens', async () => {
      const state = new MockDurableObjectState();
      const env: any = {}; // No credentials

      const doInstance = new ReviewRunDO(state as any, env);
      await doInstance.initialize({
        runId: 'run_no_token',
        owner: 'exampleorg',
        repo: 'sample-repo',
        prNumber: 42,
        headSha: 'c0ffee'.repeat(6) + '1234',
        baseSha: 'b0ffee'.repeat(6) + '1234',
        installationId: 1234,
      });

      const req = new Request('http://do/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'success' }),
      });

      const res = await doInstance.fetch(req);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.published, false);
      assert.equal(data.error, 'no_valid_token');
    });
  });
});
