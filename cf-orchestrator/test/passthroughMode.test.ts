import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPassthroughMode,
  OPERATOR_PASSTHROUGH_REVIEW_TITLE,
  OPERATOR_PASSTHROUGH_GATE_TITLE,
  OPERATOR_PASSTHROUGH_MODE_MARKER,
  OPERATOR_PASSTHROUGH_ZERO_LANES_MARKER,
} from '../src/auth/passthrough.js';
import { completeChecks } from '../src/github/edgeCheckPublisher.js';
import { formatStickyCommentMarkdown, publishStickyComment } from '../src/github/stickyCommentPublisher.js';
import { buildGitHubReviewPayload } from '../src/reviewPublisher.js';
import { handleMergeGroupAttestation, verifyConstituentChecks } from '../src/mergeGroupAttestation.js';
import { attestPrGateTool } from '../src/mcp/tools/attestPrGate.js';
import { triggerReviewTool } from '../src/mcp/tools/triggerReview.js';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
import { MockContainerRunner } from '../src/runners/containerRunner.js';
import { createMockEnv } from './mockDurableObject.js';
import { handleActionDispatch } from '../src/api/actionDispatchRoute.js';
import worker from '../src/worker.js';
// @ts-ignore
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';

describe('Review Yeti Cloudflare Orchestrator - Operator Passthrough Mode ("Full Pass Open Pass Ship It")', () => {
  it('isPassthroughMode recognizes all supported operator passthrough environment flags', () => {
    assert.strictEqual(isPassthroughMode({ OPERATOR_GLOBAL_PASSTHROUGH: 'true' }), true);
    assert.strictEqual(isPassthroughMode({ REVIEW_YETI_PASSTHROUGH: 'true' }), true);
    assert.strictEqual(isPassthroughMode({ PASSTHROUGH_MODE: 'true' }), true);
    assert.strictEqual(isPassthroughMode({ OPERATOR_GLOBAL_PASSTHROUGH: 'false' }), false);
    assert.strictEqual(isPassthroughMode({}), false);
    assert.strictEqual(isPassthroughMode(undefined), false);
  });

  describe('Check Run & Gate Publication in Passthrough Mode', () => {
    it('completeChecks publishes Review Yeti: SHIP and Review Yeti Gate: SHIP with success conclusions', async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body });
        return new Response(JSON.stringify({ id: calls.length === 1 ? 101 : 102 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as any;

      const result = await completeChecks({
        owner: 'exampleorg',
        repo: 'sample-repo',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        runId: 'run_passthrough_001',
        token: 'ghs_mock_token_123',
        verdict: 'action_required', // Even if incoming verdict is action_required, passthroughMode overrides to success!
        passthroughMode: true,
        fetchFn: mockFetch,
      });

      assert.strictEqual(result.workerCheckId, 101);
      assert.strictEqual(result.gateCheckId, 102);

      assert.strictEqual(calls.length, 2);
      const [workerCall, gateCall] = calls;

      // Worker Check Run
      assert.strictEqual(workerCall.body.name, 'Review Yeti');
      assert.strictEqual(workerCall.body.conclusion, 'success');
      assert.strictEqual(workerCall.body.output.title, OPERATOR_PASSTHROUGH_REVIEW_TITLE);
      assert.ok(workerCall.body.output.summary.includes(OPERATOR_PASSTHROUGH_MODE_MARKER));
      assert.ok(workerCall.body.output.summary.includes(OPERATOR_PASSTHROUGH_ZERO_LANES_MARKER));

      // Gate Check Run
      assert.strictEqual(gateCall.body.name, 'Review Yeti Gate');
      assert.strictEqual(gateCall.body.conclusion, 'success');
      assert.strictEqual(gateCall.body.output.title, OPERATOR_PASSTHROUGH_GATE_TITLE);
      assert.ok(gateCall.body.output.summary.includes(OPERATOR_PASSTHROUGH_MODE_MARKER));
      assert.ok(gateCall.body.output.summary.includes(OPERATOR_PASSTHROUGH_ZERO_LANES_MARKER));
    });
  });

  describe('Sticky Comment in Passthrough Mode', () => {
    it('formatStickyCommentMarkdown generates SHIP (Passthrough Mode) without BLOCK', () => {
      const markdown = formatStickyCommentMarkdown({
        owner: 'exampleorg',
        repo: 'sample-repo',
        prNumber: 42,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        verdict: 'action_required', // Overridden by passthroughMode
        passthroughMode: true,
      });

      assert.ok(markdown.includes('### 🚦 Review Yeti Verdict: **SHIP** (Passthrough Mode)'));
      assert.ok(markdown.includes(OPERATOR_PASSTHROUGH_ZERO_LANES_MARKER));
      assert.ok(markdown.includes(OPERATOR_PASSTHROUGH_MODE_MARKER));
      assert.ok(markdown.includes('Pull request is approved for merge.'));
      assert.strictEqual(markdown.includes('BLOCK'), false);
      assert.strictEqual(markdown.includes('Changes Requested'), false);
    });
  });

  describe('Pull Request Review in Passthrough Mode', () => {
    it('buildGitHubReviewPayload emits APPROVE event in passthrough mode', () => {
      const payload = buildGitHubReviewPayload({
        commitId: '0123456789abcdef0123456789abcdef01234567',
        verdict: 'action_required',
        summaryMarkdown: 'Passthrough SHIP',
        findings: [
          {
            path: 'src/main.ts',
            line: 10,
            severity: 'P0',
            title: 'Critical Issue',
            description: 'Must fix',
          },
        ],
        passthroughMode: true,
      });

      assert.strictEqual(payload.event, 'APPROVE');
      assert.ok(payload.body.includes('Passthrough SHIP'));
    });
  });

  describe('Action Dispatch Route in Passthrough Mode', () => {
    let privateKey: KeyLike;
    let publicKey: KeyLike;
    let mockKeySet: () => KeyLike;

    it('fails closed when the OIDC target has no service-owned repository enrollment', async () => {
      const pair = await generateKeyPair('RS256');
      privateKey = pair.privateKey;
      publicKey = pair.publicKey;
      mockKeySet = () => publicKey;

      const token = await new SignJWT({
        repository: 'exampleorg/sample-repo',
        repository_id: '123456',
        repository_owner_id: '78910',
        run_id: '987654321',
        run_attempt: '1',
        event_name: 'pull_request',
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer('https://token.actions.githubusercontent.com')
        .setAudience('review-yeti-doks-dispatch')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

      const calls: Array<{ url: string; method: string; body: any }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/check-runs')) {
          calls.push({ url, method: init?.method || 'POST', body: init?.body ? JSON.parse(String(init.body)) : {} });
          return new Response(JSON.stringify({ id: calls.length === 1 ? 201 : 202 }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(input, init);
      }) as any;

      try {
        const env = {
          ...createMockEnv(),
          ENVIRONMENT: 'test',
          PARALLEL_MODE: 'false',
          PARALLEL_CHECK_NAME: 'Review Yeti',
          PILOT_REPOSITORIES: 'all',
          DEFAULT_WORKER_IMAGE: 'test-image',
          OPERATOR_GLOBAL_PASSTHROUGH: 'true',
          GITHUB_TOKEN: 'ghs_test_token_123',
        };

        const dispatchReq = {
          version: 'ActionDispatch.v1' as const,
          deliveryId: 'actions:987654321:1:123456:42:1111111111111111111111111111111111111111',
          repositoryId: 123456,
          owner: 'exampleorg',
          repo: 'sample-repo',
          prNumber: 42,
          headSha: '1111111111111111111111111111111111111111',
          baseSha: '0000000000000000000000000000000000000000',
          actionSha: '2222222222222222222222222222222222222222',
          publishMode: 'app-gate' as const,
          requestedAt: new Date().toISOString(),
          caller: {
            runId: '987654321',
            runAttempt: 1,
            eventName: 'pull_request' as const,
          },
        };

        const req = new Request('http://worker/api/dispatch/action', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(dispatchReq),
        });

        const res = await handleActionDispatch(req, env, undefined, { keySet: mockKeySet });
        assert.strictEqual(res.status, 503);

        const receipt = (await res.json()) as any;
        assert.strictEqual(receipt.version, 'ActionDispatchPassthrough.v1');
        assert.strictEqual(receipt.status, 'passthrough');
        assert.strictEqual(receipt.publicationState, 'unavailable');
        assert.strictEqual(receipt.publicationReceiptAvailable, false);
        assert.strictEqual(receipt.mergeEligible, false);
        assert.strictEqual(receipt.errorCode, 'service_configuration_unavailable');
        assert.equal(calls.length, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('MCP Trigger in Passthrough Mode', () => {
    it('uses the shared publisher and does not acquire a provider slot when enrollment is missing', async () => {
      const env = { ...createMockEnv(), OPERATOR_GLOBAL_PASSTHROUGH: 'true' };
      const result = await triggerReviewTool.execute({ owner: 'exampleorg', repo: 'sample-repo', prNumber: 42 }, { env } as any);
      assert.equal(result.isError, true);
      const jsonContent = result.content?.find((item: any) => item.text?.startsWith('{'));
      assert.ok(jsonContent);
      const receipt = JSON.parse((jsonContent as any).text);
      assert.equal(receipt.status, 'unavailable');
      assert.equal(receipt.mergeEligible, false);
      assert.equal(receipt.errorCode, 'service_configuration_unavailable');
      const status = await env.REPO_GATE.get(env.REPO_GATE.idFromName('exampleorg/sample-repo')).fetch('http://do/status');
      assert.equal((await status.json() as any).activeCount, 0);
    });
  });

  describe('Merge Group Attestation in Passthrough Mode', () => {
    it('does not skip constituent and hazard checks during operator pause', async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      const mockFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method || 'POST', body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify({ id: 301 }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as any;

      const env = {
        ...createMockEnv(),
        GITHUB_TOKEN: 'ghs_mg_token',
        OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      };

      const outcome = await handleMergeGroupAttestation(
        {
          action: 'checks_requested',
          merge_group: {
            head_sha: '0123456789abcdef0123456789abcdef01234567',
            head_ref: 'refs/heads/gh-readonly-queue/main/pr-42-0123456',
            base_ref: 'refs/heads/main',
            base_sha: 'fedcba9876543210fedcba9876543210fedcba98',
          },
          repository: {
            name: 'sample-repo',
            full_name: 'exampleorg/sample-repo',
            owner: { login: 'exampleorg' },
          },
        },
        env,
        mockFetch
      );

      assert.strictEqual(outcome.status, 'blocked');
      assert.strictEqual(outcome.conclusion, 'failure');
      assert.strictEqual(outcome.title, 'Review Yeti (Merge Group Attestation)');
      assert.ok(outcome.summary.toLowerCase().includes('blocked'));
      assert.notStrictEqual(outcome.bypassedHazardScan, true);
    });

    it('verifyConstituentChecks requires the current worker check identity format', () => {
      const checks = [
        {
          id: 501,
          name: 'Review Yeti',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-10-09T12:00:00Z',
          external_id: 'run_0123456789abcdef0123456789abcdef:a1',
          app: { id: 4385771 },
        },
      ];

      const res = verifyConstituentChecks(checks, 42, '0123456789abcdef0123456789abcdef01234567');
      assert.strictEqual(res.passed, true);
      checks[0]!.external_id = 'run_0123456789abcdef0123456789abcdef:a1:review-mode=passthrough:op2';
      assert.strictEqual(verifyConstituentChecks(checks, 42, '0123456789abcdef0123456789abcdef01234567').passed, true);
      checks[0]!.external_id = 'review-yeti:operator-passthrough:0123456789abcdef:worker';
      assert.strictEqual(verifyConstituentChecks(checks, 42, '0123456789abcdef0123456789abcdef01234567').passed, false);
    });
  });

  describe('MCP Gate Attestation Tool in Passthrough Mode', () => {
    it('attestPrGateTool blocks without a current durable publication receipt', async () => {
      const result = await attestPrGateTool.execute(
        {
          owner: 'exampleorg',
          repo: 'sample-repo',
          pr_number: 42,
          head_sha: '0123456789abcdef0123456789abcdef01234567',
        },
        {
          env: {
            OPERATOR_GLOBAL_PASSTHROUGH: 'true',
            REVIEW_YETI_ATTESTATION_SECRET: 'test-secret-key-12345',
          },
        } as any
      );

      assert.strictEqual(result.isError, undefined);
      const jsonContent = result.content?.find((c: any) => c.text?.startsWith('{'));
      assert.ok(jsonContent);
      const parsed = JSON.parse((jsonContent as any).text);

      assert.strictEqual(parsed.attested, false);
      assert.strictEqual(parsed.gate_status, 'BLOCKED');
      assert.ok(parsed.blockers.length > 0);
      assert.equal(parsed.attestation_token, '');
    });
  });

  describe('ReviewJobWorkflow in Passthrough Mode', () => {
    it('does not publish through the workflow when required service-owned enrollment is unavailable', async () => {
      const originalFetch = globalThis.fetch;
      const checks = new Map<number, any>();
      let nextId = 701;
      const expectedAppId = 12345;
      const headSha = '0123456789abcdef0123456789abcdef01234567';

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method || 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : {};

        if (url.pathname === '/repos/exampleorg/sample-repo/pulls/42' && method === 'GET') {
          return Response.json({
            state: 'open',
            draft: false,
            head: { sha: headSha },
            base: { sha: 'fedcba9876543210fedcba9876543210fedcba98', ref: 'main' },
          });
        }

        if (url.pathname === `/repos/exampleorg/sample-repo/commits/${headSha}/check-runs` && method === 'GET') {
          return Response.json({ total_count: 0, check_runs: [] });
        }

        if (url.pathname === '/repos/exampleorg/sample-repo/pulls/42/reviews' && method === 'GET') {
          return Response.json([]);
        }

        if (url.pathname === '/repos/exampleorg/sample-repo/check-runs' && method === 'POST') {
          const id = nextId++;
          const check = { ...body, id, app: { id: expectedAppId } };
          checks.set(id, check);
          return Response.json(check);
        }

        const checkMatch = url.pathname.match(/\/check-runs\/(\d+)$/u);
        if (checkMatch) {
          const id = Number(checkMatch[1]);
          const current = checks.get(id);
          if (method === 'PATCH') {
            const updated = { ...current, ...body };
            checks.set(id, updated);
            return Response.json(updated);
          }
          return current ? Response.json(current) : new Response('Not Found', { status: 404 });
        }

        return originalFetch(input, init);
      }) as any;

      try {
        const env = {
          ...createMockEnv(),
          OPERATOR_GLOBAL_PASSTHROUGH: 'true',
          PILOT_REPOSITORIES: 'all',
          GITHUB_APP_ID: '12345',
          GITHUB_TOKEN: 'fixture-token-val',
        };
        const runner = new MockContainerRunner();
        const workflow = new ReviewJobWorkflow(env, runner);

        const executedSteps: string[] = [];
        const mockStep = {
          async do(name: string, arg2: any, arg3?: any) {
            executedSteps.push(name);
            const fn = typeof arg2 === 'function' ? arg2 : arg3;
            return fn();
          },
          async sleep(name: string) {
            executedSteps.push(name);
          },
        };

        const result = await workflow.run(
          {
            payload: {
              runId: 'run_wf_passthrough_01',
              owner: 'exampleorg',
              repo: 'sample-repo',
              prNumber: 42,
              headSha,
              baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
              installationId: 1001,
            },
          },
          mockStep as any
        );

        assert.equal(result.status, 'unavailable');
        assert.equal(result.verdict, 'unavailable');
        assert.equal(result.mergeEligible, false);
        assert.equal(result.publicationState, 'unavailable');
        assert.equal(result.errorCode, 'service_configuration_unavailable');
        assert.equal(checks.size, 0);

        // Verify zero container dispatch occurred!
        assert.strictEqual(runner.dispatched.length, 0);

        // Verify executed step
        assert.deepStrictEqual(executedSteps, ['operator-passthrough-publication']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
