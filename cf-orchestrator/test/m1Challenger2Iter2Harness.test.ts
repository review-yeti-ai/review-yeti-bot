import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { evictQueuedRunsForPR, isPilotRepository, verifyGitHubSignature } from '../src/worker.js';
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

interface HarnessContext {
  env: Env;
  repoGateState: MockDurableObjectState;
  repoGateInstance: RepoGateDO;
  reviewRunStates: Map<string, MockDurableObjectState>;
  reviewRunInstances: Map<string, ReviewRunDO>;
  dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
  queuedDebounceItems: Array<{ message: DebounceMessagePayload; delaySeconds?: number }>;
  waitUntilPromises: Array<Promise<any>>;
  mockCtx: { waitUntil: (p: Promise<any>) => void };
}

function createHarnessEnv(overrides: Partial<Record<string, any>> = {}): HarnessContext {
  const repoGateState = new MockDurableObjectState();
  const reviewRunStates = new Map<string, MockDurableObjectState>();
  const reviewRunInstances = new Map<string, ReviewRunDO>();
  const dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }> = [];
  const queuedDebounceItems: Array<{ message: DebounceMessagePayload; delaySeconds?: number }> = [];
  const waitUntilPromises: Array<Promise<any>> = [];

  const mockCtx = {
    waitUntil: (p: Promise<any>) => {
      waitUntilPromises.push(p);
    },
  };

  let repoGateInstance: RepoGateDO;

  const env: any = {
    REPO_GATE: {
      idFromName: (name: string) => name.toLowerCase(),
      get: (_id: string) => {
        return {
          fetch: async (url: string | Request, init?: any) => {
            const req = typeof url === 'string' ? new Request(url, init) : url;
            return repoGateInstance.fetch(req);
          },
        };
      },
    },

    REVIEW_RUN: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!reviewRunInstances.has(id)) {
          const state = new MockDurableObjectState();
          reviewRunStates.set(id, state);
          const runDO = new ReviewRunDO(state as any, env);
          reviewRunInstances.set(id, runDO);
        }
        const instance = reviewRunInstances.get(id)!;
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
    PILOT_REPOSITORIES: overrides.PILOT_REPOSITORIES ?? 'review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta',
    DOKS_FALLBACK_URL: overrides.DOKS_FALLBACK_URL ?? 'https://doks-internal.calltelemetry.com/api/webhooks/github',
    GITHUB_WEBHOOK_SECRET: overrides.GITHUB_WEBHOOK_SECRET ?? 'harness-secret-key-42',
    DEFAULT_WORKER_IMAGE: 'ghcr.io/review-yeti-ai/review-yeti-worker:latest',
  };

  repoGateInstance = new RepoGateDO(repoGateState as any, env);

  return {
    env,
    repoGateState,
    repoGateInstance,
    reviewRunStates,
    reviewRunInstances,
    dispatchedWorkflows,
    queuedDebounceItems,
    waitUntilPromises,
    mockCtx,
  };
}

describe('M1 Challenger Iteration 2 Adversarial Verification', () => {

  describe('Test 1: Malformed, Incomplete, and Non-Object Payloads to POST /api/webhooks/github', () => {
    const SECRET = 'harness-secret-key-42';

    // Generates a matrix of adversarial payloads
    const nonObjectPayloads = [
      { desc: 'primitive string', raw: '"plain string"' },
      { desc: 'primitive number', raw: '12345' },
      { desc: 'primitive boolean true', raw: 'true' },
      { desc: 'primitive boolean false', raw: 'false' },
      { desc: 'primitive null', raw: 'null' },
      { desc: 'empty array', raw: '[]' },
      { desc: 'array of numbers', raw: '[1, 2, 3]' },
      { desc: 'array of objects', raw: '[{"action": "opened"}]' },
      { desc: 'nested array', raw: '[[null]]' },
    ];

    for (const { desc, raw } of nonObjectPayloads) {
      it(`rejects non-object payload (${desc}) with HTTP 400 and NEVER throws HTTP 500 for pull_request`, async () => {
        const { env, mockCtx } = createHarnessEnv({ GITHUB_WEBHOOK_SECRET: SECRET });
        const sig = await signPayload(SECRET, raw);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: raw,
        });

        let res: Response;
        try {
          res = await worker.fetch(req, env, mockCtx as any);
        } catch (err) {
          assert.fail(`worker.fetch threw uncaught exception on ${desc}: ${err}`);
        }

        assert.equal(res.status, 400, `Expected HTTP 400 on ${desc}, got ${res.status}`);
        assert.notEqual(res.status, 500, `Worker must NEVER return HTTP 500 on ${desc}`);
        const text = await res.text();
        assert.match(text, /Bad Request/i);
      });

      it(`rejects non-object payload (${desc}) with HTTP 400 and NEVER throws HTTP 500 for push`, async () => {
        const { env, mockCtx } = createHarnessEnv({ GITHUB_WEBHOOK_SECRET: SECRET });
        const sig = await signPayload(SECRET, raw);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'push',
            'X-Hub-Signature-256': sig,
          },
          body: raw,
        });

        let res: Response;
        try {
          res = await worker.fetch(req, env, mockCtx as any);
        } catch (err) {
          assert.fail(`worker.fetch threw uncaught exception on push with ${desc}: ${err}`);
        }

        assert.equal(res.status, 400, `Expected HTTP 400 on ${desc}, got ${res.status}`);
        assert.notEqual(res.status, 500, `Worker must NEVER return HTTP 500 on ${desc}`);
      });
    }

    const incompletePRPayloads = [
      { desc: 'empty object {}', body: {} },
      { desc: 'only action, missing repo and pr', body: { action: 'opened' } },
      { desc: 'action with null repo and pr', body: { action: 'opened', repository: null, pull_request: null } },
      { desc: 'action with empty objects', body: { action: 'opened', repository: {}, pull_request: {} } },
      { desc: 'action with string repository', body: { action: 'opened', repository: 'review-yeti-ai/review-yeti-bot', pull_request: { number: 10 } } },
      { desc: 'action with array repository', body: { action: 'opened', repository: ['review-yeti-ai/review-yeti-bot'], pull_request: { number: 10 } } },
      { desc: 'empty full_name string', body: { action: 'opened', repository: { full_name: '' }, pull_request: { number: 10 } } },
      { desc: 'whitespace-only full_name', body: { action: 'opened', repository: { full_name: '    ' }, pull_request: { number: 10 } } },
      { desc: 'numeric full_name', body: { action: 'opened', repository: { full_name: 12345 }, pull_request: { number: 10 } } },
      { desc: 'missing pull_request', body: { action: 'opened', repository: { full_name: 'review-yeti-ai/review-yeti-bot' } } },
      { desc: 'numeric pull_request', body: { action: 'opened', repository: { full_name: 'review-yeti-ai/review-yeti-bot' }, pull_request: 42 } },
      { desc: 'array pull_request', body: { action: 'opened', repository: { full_name: 'review-yeti-ai/review-yeti-bot' }, pull_request: [{ number: 10 }] } },
      { desc: 'pull_request with string number', body: { action: 'opened', repository: { full_name: 'review-yeti-ai/review-yeti-bot' }, pull_request: { number: '10' } } },
      { desc: 'pull_request with null number', body: { action: 'opened', repository: { full_name: 'review-yeti-ai/review-yeti-bot' }, pull_request: { number: null } } },
      { desc: 'pull_request with boolean number', body: { action: 'opened', repository: { full_name: 'review-yeti-ai/review-yeti-bot' }, pull_request: { number: true } } },
      { desc: 'pull_request with object number', body: { action: 'opened', repository: { full_name: 'review-yeti-ai/review-yeti-bot' }, pull_request: { number: { val: 10 } } } },
      { desc: 'synchronize with incomplete repo', body: { action: 'synchronize', repository: {}, pull_request: { number: 10 } } },
      { desc: 'synchronize with missing pull_request', body: { action: 'synchronize', repository: { full_name: 'review-yeti-ai/review-yeti-bot' } } },
      { desc: 'closed with incomplete repo', body: { action: 'closed', repository: {}, pull_request: { number: 10 } } },
      { desc: 'closed with missing pull_request', body: { action: 'closed', repository: { full_name: 'review-yeti-ai/review-yeti-bot' } } },
      { desc: 'converted_to_draft with incomplete repo', body: { action: 'converted_to_draft', repository: {}, pull_request: { number: 10 } } },
      { desc: 'converted_to_draft with missing pull_request', body: { action: 'converted_to_draft', repository: { full_name: 'review-yeti-ai/review-yeti-bot' } } },
    ];

    for (const { desc, body } of incompletePRPayloads) {
      it(`rejects incomplete PR schema (${desc}) with HTTP 400 and NEVER throws HTTP 500`, async () => {
        const { env, mockCtx } = createHarnessEnv({ GITHUB_WEBHOOK_SECRET: SECRET });
        const raw = JSON.stringify(body);
        const sig = await signPayload(SECRET, raw);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: raw,
        });

        let res: Response;
        try {
          res = await worker.fetch(req, env, mockCtx as any);
        } catch (err) {
          assert.fail(`worker.fetch threw uncaught exception on ${desc}: ${err}`);
        }

        assert.equal(res.status, 400, `Expected HTTP 400 on ${desc}, got ${res.status}`);
        assert.notEqual(res.status, 500, `Worker must NEVER return HTTP 500 on ${desc}`);
        const text = await res.text();
        assert.match(text, /Missing or invalid repository \/ pull_request payload/i);
      });
    }

    const malformedSyntaxBodies = [
      { desc: 'empty string', raw: '' },
      { desc: 'whitespace only', raw: '   \n  \t  ' },
      { desc: 'truncated json', raw: '{"action": "opened", "pull_request": {"number":' },
      { desc: 'unquoted keys and values', raw: '{action: opened}' },
      { desc: 'xml text', raw: '<xml><head>invalid</head></xml>' },
      { desc: 'raw binary bytes', raw: '\x00\x01\x02\xFF\xFE' },
      { desc: 'trailing comma invalid json', raw: '{"action": "opened",}' },
    ];

    for (const { desc, raw } of malformedSyntaxBodies) {
      it(`rejects syntactically invalid JSON (${desc}) with HTTP 400 and NEVER throws HTTP 500`, async () => {
        const { env, mockCtx } = createHarnessEnv({ GITHUB_WEBHOOK_SECRET: SECRET });
        const sig = await signPayload(SECRET, raw);
        const req = new Request('https://operator.internal/api/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': sig,
          },
          body: raw,
        });

        let res: Response;
        try {
          res = await worker.fetch(req, env, mockCtx as any);
        } catch (err) {
          assert.fail(`worker.fetch threw uncaught exception on ${desc}: ${err}`);
        }

        assert.equal(res.status, 400, `Expected HTTP 400 on ${desc}, got ${res.status}`);
        assert.notEqual(res.status, 500, `Worker must NEVER return HTTP 500 on ${desc}`);
      });
    }

    it('catches stream abortion / I/O errors in request.text() and returns HTTP 400 without 500', async () => {
      const { env, mockCtx } = createHarnessEnv({ GITHUB_WEBHOOK_SECRET: '' });
      const badReq = {
        url: 'https://operator.internal/api/webhooks/github',
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
        }),
        async text() {
          throw new Error('Simulated network socket reset (ECONNRESET)');
        },
      } as unknown as Request;

      let res: Response;
      try {
        res = await worker.fetch(badReq, env, mockCtx as any);
      } catch (err) {
        assert.fail(`worker.fetch must catch I/O errors in top-level handler: ${err}`);
      }

      assert.equal(res.status, 400);
      assert.notEqual(res.status, 500);
      const text = await res.text();
      assert.match(text, /Ingress webhook processing failure/i);
    });
  });

  describe('Test 2: Stale Commit Repoll Test & Concurrency Seniority Preservation', () => {

    it('verifies stale commit repoll cannot resurrect or evict newer commit in queue (m1ChallengeStress line 910 check)', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Run 1 is active on PR 50
      const acq1 = await gate.acquireSlot('run_active', 'sha1', 50);
      assert.equal(acq1.granted, true, 'Run 1 should be active');

      // Run 2 arrives on PR 50 and gets queued
      const acq2 = await gate.acquireSlot('run_old_commit', 'sha2', 50);
      assert.equal(acq2.granted, false, 'Run 2 should be queued');

      // Run 3 arrives on PR 50 (new commit superseding Run 2)
      const acq3 = await gate.acquireSlot('run_new_commit', 'sha3', 50);
      assert.equal(acq3.granted, false, 'Run 3 should be queued');

      // Check that Run 2 was evicted by Run 3
      let queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue.length, 1, 'Queue should have exactly 1 item');
      assert.equal(queue[0].runId, 'run_new_commit', 'Run 3 should be in queue');

      // Now Run 2 (old commit workflow) wakes up from polling loop and repolls acquireSlot
      const repollRes = await gate.acquireSlot('run_old_commit', 'sha2', 50);
      assert.equal(repollRes.granted, false, 'Repoll from evicted run must be denied');

      queue = (await state.storage.get('queue')) as any[];
      // Line 910 verification: Run 3 must remain safely in the queue; old commit must not evict it
      assert.equal(queue[0].runId, 'run_new_commit', 'Run 3 must remain at head of queue; old commit must not evict it');
      assert.equal(queue.length, 1, 'Queue length must remain 1');
    });

    it('verifies HTTP POST /acquire on RepoGateDO enforces stale commit suppression', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      await gate.acquireSlot('run_active', 'sha1', 100);
      await gate.acquireSlot('run_v1', 'sha_v1', 100);
      await gate.acquireSlot('run_v2', 'sha_v2', 100);

      // HTTP repoll from run_v1
      const req = new Request('http://do/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'run_v1', headSha: 'sha_v1', prNumber: 100 }),
      });
      const res = await gate.fetch(req);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.granted, false);

      const status = await gate.getStatus();
      assert.equal(status.queueLength, 1);
      const queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue[0].runId, 'run_v2');
    });

    it('survives rapid storm of 5 superseding commits without queue corruption or stale resurrection', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Slot is busy with PR 77 run_active
      await gate.acquireSlot('run_active', 'sha0', 77);

      // 5 commits arrive in sequence for PR 77
      const runs = ['run_c1', 'run_c2', 'run_c3', 'run_c4', 'run_c5'];
      for (let i = 0; i < runs.length; i++) {
        await gate.acquireSlot(runs[i], `sha_${i + 1}`, 77);
      }

      // Only run_c5 should be in queue
      let queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue.length, 1);
      assert.equal(queue[0].runId, 'run_c5');

      // Now all stale runs (c1, c2, c3, c4) wake up and repoll simultaneously
      const repollResults = await Promise.all([
        gate.acquireSlot('run_c1', 'sha_1', 77),
        gate.acquireSlot('run_c2', 'sha_2', 77),
        gate.acquireSlot('run_c3', 'sha_3', 77),
        gate.acquireSlot('run_c4', 'sha_4', 77),
      ]);

      for (const res of repollResults) {
        assert.equal(res.granted, false);
      }

      queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue.length, 1);
      assert.equal(queue[0].runId, 'run_c5', 'Latest commit run_c5 must remain intact');

      // When run_active finishes, run_c5 must be promoted
      const rel = await gate.releaseSlot('run_active');
      assert.equal(rel.released, true);
      assert.equal(rel.nextRunId, 'run_c5');

      const status = await gate.getStatus();
      assert.deepEqual(status.activeJobs, ['run_c5']);
      assert.equal(status.queueLength, 0);
    });

    it('preserves FIFO seniority when legitimate queued run repolls while waiting', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      await gate.acquireSlot('run_active', 'sha0', 1);

      // PR 20 and PR 30 queue runs
      await gate.acquireSlot('run_pr20', 'sha20', 20);
      await gate.acquireSlot('run_pr30', 'sha30', 30);

      let queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue.length, 2);
      assert.equal(queue[0].runId, 'run_pr20');
      assert.equal(queue[1].runId, 'run_pr30');
      const origTimestamp = queue[0].enqueuedAt;

      // run_pr20 repolls while still waiting
      const repoll = await gate.acquireSlot('run_pr20', 'sha20_updated', 20);
      assert.equal(repoll.granted, false);
      assert.equal(repoll.queuePosition, 1, 'Seniority position 1 must be preserved');

      queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue.length, 2);
      assert.equal(queue[0].runId, 'run_pr20', 'run_pr20 must not be demoted to tail');
      assert.equal(queue[0].enqueuedAt, origTimestamp, 'Seniority timestamp must be preserved');
      assert.equal(queue[0].headSha, 'sha20_updated', 'headSha should update');
      assert.equal(queue[1].runId, 'run_pr30', 'run_pr30 must stay second');
    });

    it('enforces bounding on evictedRunIds up to 1000 items without memory leaks', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      await gate.acquireSlot('run_active', 'sha_act', 999);

      // Enqueue and supersede 1050 runs for PR 100
      for (let i = 0; i < 1050; i++) {
        await gate.acquireSlot(`run_zombie_${i}`, `sha_${i}`, 100);
      }

      const storedEvicted = (await state.storage.get('evictedRunIds')) as string[];
      assert.equal(storedEvicted.length, 1000, 'evictedRunIds must be strictly bounded at 1000');
      // Verify oldest zombies (0..48) were pruned and newer (1048) is present
      assert.ok(!storedEvicted.includes('run_zombie_0'), 'Oldest evicted run should be pruned');
      assert.ok(storedEvicted.includes('run_zombie_1048'), 'Newer evicted run should be tracked');
    });
  });

  describe('Test 3: POST /evict Cleans Up Queued Entries on PR closed / converted_to_draft', () => {

    it('POST /evict on RepoGateDO removes all queued entries for specified prNumber', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      // Fill slot
      await gate.acquireSlot('active_run', 'sha', 1);

      // Queue entries for PR 10 and PR 20
      await gate.acquireSlot('queued_10_a', 'sha1', 10);
      await gate.acquireSlot('queued_20', 'sha2', 20);

      let status = await gate.getStatus();
      assert.equal(status.queueLength, 2);

      // Direct POST /evict with prNumber: 10
      const req = new Request('http://do/evict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prNumber: 10 }),
      });
      const res = await gate.fetch(req);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.evicted, true);
      assert.equal(data.count, 1);

      status = await gate.getStatus();
      assert.equal(status.queueLength, 1);
      const queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue[0].runId, 'queued_20', 'PR 20 must remain untouched in queue');

      // Evicted run cannot re-poll
      const repoll = await gate.acquireSlot('queued_10_a', 'sha1', 10);
      assert.equal(repoll.granted, false);
      status = await gate.getStatus();
      assert.equal(status.queueLength, 1);
    });

    it('POST /evict by runId removes exact run and prevents repoll', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      await gate.acquireSlot('active_run', 'sha', 1);
      await gate.acquireSlot('queued_x', 'sha_x', 33);
      await gate.acquireSlot('queued_y', 'sha_y', 34);

      const req = new Request('http://do/evict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: 'queued_x' }),
      });
      const res = await gate.fetch(req);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.evicted, true);
      assert.equal(data.count, 1);

      const status = await gate.getStatus();
      assert.equal(status.queueLength, 1);
      const queue = (await state.storage.get('queue')) as any[];
      assert.equal(queue[0].runId, 'queued_y');
    });

    it('POST /evict with invalid body returns HTTP 400 Bad Request', async () => {
      const state = new MockDurableObjectState();
      const env: any = {};
      const gate = new RepoGateDO(state as any, env);

      const req = new Request('http://do/evict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-non-json',
      });
      const res = await gate.fetch(req);
      assert.equal(res.status, 400);
    });

    it('Webhook Ingress: PR closed evicts queued runs in RepoGateDO and cancels active run in ReviewRunDO', async () => {
      const { env, repoGateInstance, repoGateState, mockCtx } = createHarnessEnv();

      // Step A: PR 88 has an active run and a queued run
      // 1. Initialize active run in ReviewRunDO
      const activeRunDOId = env.REVIEW_RUN.idFromName('run_active_88');
      const activeRunDO = env.REVIEW_RUN.get(activeRunDOId);
      await activeRunDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: 'run_active_88',
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 88,
          headSha: 'head88_active',
          baseSha: 'base88',
          installationId: 100,
        }),
      });

      // 2. Setup RepoGateDO state: run_active_88 is active, run_queued_88 is queued for PR 88, run_queued_99 for PR 99
      await repoGateInstance.acquireSlot('run_active_88', 'head88_active', 88);
      await repoGateInstance.acquireSlot('run_queued_88', 'head88_newer', 88);
      await repoGateInstance.acquireSlot('run_queued_99', 'head99', 99);

      let gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.activeCount, 1);
      assert.equal(gateStatus.queueLength, 2);

      // Step B: Send PR closed webhook
      const closedPayload = {
        action: 'closed',
        pull_request: {
          number: 88,
          head: { sha: 'head88_newer' },
          base: { sha: 'base88' },
        },
        repository: {
          name: 'review-yeti-bot',
          full_name: 'review-yeti-ai/review-yeti-bot',
          owner: { login: 'review-yeti-ai' },
        },
        installation: { id: 100 },
      };

      const raw = JSON.stringify(closedPayload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, raw);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: raw,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const resJson = (await res.json()) as any;
      assert.equal(resJson.status, 'cancelled');
      assert.equal(resJson.action, 'closed');
      assert.equal(resJson.cancelled, true);

      // Step C: Verify ReviewRunDO was cancelled
      const activeStatusRes = await activeRunDO.fetch('http://do/status');
      const activeStatus = (await activeStatusRes.json()) as any;
      assert.equal(activeStatus.phase, 'Cancelled');
      assert.equal(activeStatus.isCurrentHead, false);
      assert.equal(activeStatus.cancelRequested, true);
      assert.equal(activeStatus.fencingEpoch, 2);

      // Step D: Verify RepoGateDO evicted queued run for PR 88
      gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.queueLength, 1, 'Only PR 99 should remain in queue');
      const remainingQueue = (await repoGateState.storage.get('queue')) as any[];
      assert.equal(remainingQueue[0].runId, 'run_queued_99');
      assert.equal(remainingQueue[0].prNumber, 99);

      // Step E: Verify evicted queued run 88 cannot re-acquire slot on repoll
      const repoll = await repoGateInstance.acquireSlot('run_queued_88', 'head88_newer', 88);
      assert.equal(repoll.granted, false);
      assert.equal((await repoGateInstance.getStatus()).queueLength, 1);
    });

    it('Webhook Ingress: PR converted_to_draft evicts queued runs in RepoGateDO', async () => {
      const { env, repoGateInstance, repoGateState, mockCtx } = createHarnessEnv();

      // PR 44 has an active run and a queued run
      const activeRunDOId = env.REVIEW_RUN.idFromName('run_active_44');
      const activeRunDO = env.REVIEW_RUN.get(activeRunDOId);
      await activeRunDO.fetch('http://do/init', {
        method: 'POST',
        body: JSON.stringify({
          runId: 'run_active_44',
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          prNumber: 44,
          headSha: 'head44_active',
          baseSha: 'base44',
          installationId: 100,
        }),
      });

      await repoGateInstance.acquireSlot('run_active_44', 'head44_active', 44);
      await repoGateInstance.acquireSlot('run_queued_44', 'head44_queued', 44);

      let gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.queueLength, 1);

      // Send converted_to_draft
      const draftPayload = {
        action: 'converted_to_draft',
        pull_request: {
          number: 44,
          head: { sha: 'head44_queued' },
          base: { sha: 'base44' },
        },
        repository: {
          name: 'review-yeti-bot',
          full_name: 'review-yeti-ai/review-yeti-bot',
          owner: { login: 'review-yeti-ai' },
        },
        installation: { id: 100 },
      };

      const raw = JSON.stringify(draftPayload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, raw);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: raw,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);
      const resJson = (await res.json()) as any;
      assert.equal(resJson.status, 'cancelled');
      assert.equal(resJson.action, 'converted_to_draft');

      gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.queueLength, 0, 'PR 44 queued run must be evicted');
    });

    it('Webhook Ingress: PR closed with NO active run still evicts queued runs in RepoGateDO', async () => {
      const { env, repoGateInstance, repoGateState, mockCtx } = createHarnessEnv();

      // Run for PR 15 is active (different PR)
      await repoGateInstance.acquireSlot('run_pr15', 'head15', 15);
      // PR 16 has only a queued run, no active run
      await repoGateInstance.acquireSlot('run_queued_16', 'head16', 16);

      let gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.queueLength, 1);

      const closedPayload = {
        action: 'closed',
        pull_request: {
          number: 16,
          head: { sha: 'head16' },
          base: { sha: 'base16' },
        },
        repository: {
          name: 'review-yeti-bot',
          full_name: 'review-yeti-ai/review-yeti-bot',
          owner: { login: 'review-yeti-ai' },
        },
        installation: { id: 100 },
      };

      const raw = JSON.stringify(closedPayload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET!, raw);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: raw,
      });

      const res = await worker.fetch(req, env, mockCtx as any);
      assert.equal(res.status, 200);

      gateStatus = await repoGateInstance.getStatus();
      assert.equal(gateStatus.queueLength, 0, 'PR 16 queued run must be evicted even without active run');
    });
  });
});
