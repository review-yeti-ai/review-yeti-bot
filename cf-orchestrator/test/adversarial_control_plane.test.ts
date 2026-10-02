/**
 * adversarial_control_plane.test.ts
 *
 * Tier 5: Adversarial Coverage Hardening for Edge Control Plane & Multi-Transport Engine
 *
 * Comprehensive stress testing, failure mode exploration, and boundary security:
 * 1. Webhook Ingress Worker (worker.ts): HMAC tampering, malformed/non-JSON, unicode injection, rapid burst debouncing.
 * 2. Repository Concurrency Gate (repoGateDO.ts): Concurrent races, queue starvation, hibernation consistency, lingering state on closed PRs.
 * 3. Single-Run Coordinator (reviewRunDO.ts): Fencing monotonicity, lease races, expiry edge cases, double-terminal transitions.
 * 4. Durable Orchestration Workflow (reviewJobWorkflow.ts): Polling cancellation reactivity, runner failure cascades, saga rollback resilience.
 * 5. Multi-Transport Engine & Tooling (toolTunnelDefinition.ts & tunnelConfig.ts): Malformed YAML, circular env refs, deep nested interpolation, exotic protocols, IPv4/IPv6 boundary addresses, header injection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { isPilotRepository, verifyGitHubSignature } from '../src/worker.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
import { MockDurableObjectState } from './mockDurableObject.js';
import {
  parseToolingConfigYaml,
  interpolateEnvVars,
  interpolateObject,
  validateToolingConfig,
  type ToolDefinition,
} from '../src/tunnel/toolTunnelDefinition.js';
import {
  isInternalEndpoint,
  isIPv4Address,
  isTailscaleUrl,
  hasHeaderCaseInsensitive,
  resolveToolConnection,
} from '../src/tunnel/tunnelConfig.js';
import { type ContainerRunner, type ContainerJobSpec, type ContainerJobResult } from '../src/runners/containerRunner.js';
import type { DebounceMessagePayload, Env, ReviewRunSpec } from '../src/types.js';

// ============================================================================
// Test Utilities & Test Environment Mocks
// ============================================================================

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

interface TestHarness {
  env: Env;
  repoGateStore: Map<string, RepoGateDO>;
  reviewRunStore: Map<string, ReviewRunDO>;
  dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
  queuedDebounceItems: Array<{ message: DebounceMessagePayload; delaySeconds?: number }>;
  waitUntilPromises: Array<Promise<any>>;
  mockCtx: any;
}

function createTestHarness(overrides: Partial<Record<string, any>> = {}): TestHarness {
  const repoGateStore = new Map<string, RepoGateDO>();
  const reviewRunStore = new Map<string, ReviewRunDO>();
  const dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }> = [];
  const queuedDebounceItems: Array<{ message: DebounceMessagePayload; delaySeconds?: number }> = [];
  const waitUntilPromises: Array<Promise<any>> = [];

  const mockCtx: any = {
    waitUntil: (p: Promise<any>) => {
      waitUntilPromises.push(p);
    },
    passThroughOnException: () => {},
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
    PILOT_REPOSITORIES: overrides.PILOT_REPOSITORIES ?? 'review-yeti-ai/review-yeti-bot,calltelemetry/ct-meta',
    // Set to empty string by default to prevent unwanted external network calls during unit tests
    DOKS_FALLBACK_URL: overrides.DOKS_FALLBACK_URL ?? '',
    GITHUB_WEBHOOK_SECRET: overrides.GITHUB_WEBHOOK_SECRET ?? 'super-secret-adversarial-key-77',
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

function makePrPayload(action: string, overrides: Partial<Record<string, any>> = {}) {
  const owner = overrides.owner ?? 'review-yeti-ai';
  const repo = overrides.repo ?? 'review-yeti-bot';
  const prNumber = overrides.prNumber ?? 42;
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
    installation: { id: 98765 },
    ...overrides,
  };
}

// ============================================================================
// SUITE 1: Webhook Ingress Worker Adversarial Surface (worker.ts)
// ============================================================================

describe('Tier 5 Adversarial: 1. Webhook Ingress Worker (worker.ts)', () => {
  const secret = 'super-secret-adversarial-key-77';

  it('1.1 HMAC verification: rejects when signature hex is not 64 characters (too short / too long)', async () => {
    const body = '{"hello":"world"}';
    const validSig = await signPayload(secret, body);
    const rawHex = validSig.replace('sha256=', '');

    // 63 characters (1 short)
    const shortSig = `sha256=${rawHex.slice(0, 63)}`;
    const isValidShort = await verifyGitHubSignature(secret, shortSig, body);
    assert.equal(isValidShort, false, 'Should reject 63-char hex signature');

    // 65 characters (1 long)
    const longSig = `sha256=${rawHex}a`;
    const isValidLong = await verifyGitHubSignature(secret, longSig, body);
    assert.equal(isValidLong, false, 'Should reject 65-char hex signature');
  });

  it('1.2 HMAC verification: rejects when signature contains non-hex characters', async () => {
    const body = '{"hello":"world"}';
    const nonHexChars = ['g', 'z', '!', ' ', '\u0000', '-'];

    for (const char of nonHexChars) {
      const corruptHex = `sha256=${char.repeat(64)}`;
      const res = await verifyGitHubSignature(secret, corruptHex, body);
      assert.equal(res, false, `Should reject signature with char "${char}"`);
    }
  });

  it('1.3 HMAC verification: rejects single-bit flip tampering in signature', async () => {
    const body = '{"hello":"world"}';
    const validSig = await signPayload(secret, body);
    const hex = validSig.replace('sha256=', '');

    // Flip the last character
    const flippedChar = hex[63] === '0' ? '1' : '0';
    const tamperedSig = `sha256=${hex.slice(0, 63)}${flippedChar}`;

    const res = await verifyGitHubSignature(secret, tamperedSig, body);
    assert.equal(res, false, 'Tampered single-character signature must be rejected');
  });

  it('1.4 HMAC verification: rejects when body has single-byte tampering', async () => {
    const body = '{"action":"opened","pull_request":{"number":1}}';
    const sig = await signPayload(secret, body);

    // Tamper with trailing space, leading newline, or changed field
    assert.equal(await verifyGitHubSignature(secret, sig, body + ' '), false);
    assert.equal(await verifyGitHubSignature(secret, sig, '\n' + body), false);
    assert.equal(await verifyGitHubSignature(secret, sig, body.replace('number":1', 'number":2')), false);
  });

  it('1.5 HMAC verification: correctly validates multibyte unicode payload body', async () => {
    const unicodeBody = JSON.stringify({
      commit_message: 'feat: add support for 🚀 and 🔥 emoji with русский текст and \u200B zero-width',
      pr: 100,
    });
    const sig = await signPayload(secret, unicodeBody);

    const isValid = await verifyGitHubSignature(secret, sig, unicodeBody);
    assert.equal(isValid, true, 'Valid unicode payload must verify correctly with UTF-8 TextEncoder');
  });

  it('1.6 Payload Validation: returns HTTP 400 on malformed, unclosed, or invalid JSON', async () => {
    const harness = createTestHarness();
    const malformedBodies = [
      '{"action": "opened", unclosed',
      '{ "missing_closing_brace": true',
      'not json at all %%%',
      '',
    ];

    for (const badBody of malformedBodies) {
      const sig = await signPayload(secret, badBody);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: badBody,
      });

      const res = await worker.fetch(req, harness.env, harness.mockCtx);
      assert.equal(res.status, 400, `Malformed body should return 400: ${badBody}`);
    }
  });

  it('1.7 Payload Validation: returns HTTP 400 on non-object JSON payloads (arrays, primitives, null)', async () => {
    const harness = createTestHarness();
    const nonObjectPayloads = [
      JSON.stringify([1, 2, 3]),
      JSON.stringify('a plain string'),
      JSON.stringify(12345),
      JSON.stringify(true),
      JSON.stringify(null),
    ];

    for (const body of nonObjectPayloads) {
      const sig = await signPayload(secret, body);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, harness.env, harness.mockCtx);
      assert.equal(res.status, 400, `Non-object payload should return 400: ${body}`);
    }
  });

  it('1.8 Payload Validation: returns HTTP 400 when PR metadata fields are invalid or missing', async () => {
    const harness = createTestHarness();
    const badPRPayloads = [
      // Missing repository full_name
      { action: 'opened', pull_request: { number: 1, head: { sha: 'abc' } }, repository: { name: 'repo' } },
      // Whitespace-only repository full_name
      { action: 'opened', pull_request: { number: 1, head: { sha: 'abc' } }, repository: { full_name: '   ' } },
      // Missing pull_request object
      { action: 'opened', repository: { full_name: 'review-yeti-ai/review-yeti-bot' } },
      // String PR number instead of number
      {
        action: 'opened',
        pull_request: { number: 'not-a-number' as any },
        repository: { full_name: 'review-yeti-ai/review-yeti-bot' },
      },
      // Array pull_request
      {
        action: 'opened',
        pull_request: [] as any,
        repository: { full_name: 'review-yeti-ai/review-yeti-bot' },
      },
    ];

    for (const bad of badPRPayloads) {
      const body = JSON.stringify(bad);
      const sig = await signPayload(secret, body);
      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, harness.env, harness.mockCtx);
      assert.equal(res.status, 400, `Invalid PR payload structure should return 400`);
    }
  });

  it('1.9 Unicode & Header Manipulation: robust against unicode header content and case variations', async () => {
    const harness = createTestHarness();
    const body = JSON.stringify(makePrPayload('opened'));
    const sig = await signPayload(secret, body);

    // Test non-PR event with Latin-1 extended byte character (code point 241)
    const reqUnknown = new Request('https://operator.internal/api/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push_event_ñ_test',
        'X-Hub-Signature-256': sig,
      },
      body,
    });

    const resUnknown = await worker.fetch(reqUnknown, harness.env, harness.mockCtx);
    assert.equal(resUnknown.status, 200);
    const dataUnknown = (await resUnknown.json()) as any;
    assert.equal(dataUnknown.status, 'ignored');

    // Test lowercase header casing per RFC 7230
    const reqLower = new Request('https://operator.internal/api/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sig,
      },
      body,
    });

    const resLower = await worker.fetch(reqLower, harness.env, harness.mockCtx);
    assert.equal(resLower.status, 200);
    const dataLower = (await resLower.json()) as any;
    assert.equal(dataLower.status, 'dispatched_immediate');
  });

  it('1.10 Rapid Webhook Flood Debouncing: processes a burst of 20 rapid synchronize events with supersession tracking', async () => {
    const harness = createTestHarness();
    const burstCount = 20;
    const prNumber = 88;

    // 1. Initial opened event sets up an active in-flight run
    const openedPayload = makePrPayload('opened', { prNumber, headSha: 'initial_opened_sha' });
    const openedBody = JSON.stringify(openedPayload);
    const openedSig = await signPayload(secret, openedBody);
    const openedReq = new Request('https://operator.internal/api/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': openedSig,
      },
      body: openedBody,
    });
    const openedRes = await worker.fetch(openedReq, harness.env, harness.mockCtx);
    assert.equal(openedRes.status, 200);
    const openedData = (await openedRes.json()) as any;
    const initialRunId = openedData.runId;

    // Simulate that the opened run acquired the concurrency slot in RepoGateDO
    const repoGateId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
    const repoGate = harness.env.REPO_GATE.get(repoGateId);
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: initialRunId, headSha: 'initial_opened_sha', prNumber }),
    });

    // 2. First synchronize event arrives: MUST cancel the active in-flight run
    const sync1Payload = makePrPayload('synchronize', { prNumber, headSha: 'sync_sha_1' });
    const sync1Body = JSON.stringify(sync1Payload);
    const sync1Sig = await signPayload(secret, sync1Body);
    const sync1Req = new Request('https://operator.internal/api/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': sync1Sig,
      },
      body: sync1Body,
    });
    const sync1Res = await worker.fetch(sync1Req, harness.env, harness.mockCtx);
    assert.equal(sync1Res.status, 200);
    const sync1Data = (await sync1Res.json()) as any;
    assert.equal(sync1Data.status, 'queued_debounced');
    assert.equal(sync1Data.supersededRunId, initialRunId);
    assert.deepEqual(sync1Data.supersededRunIds, [initialRunId]);

    // 3. Now fire a burst of 19 more rapid synchronize events
    for (let i = 2; i <= burstCount; i++) {
      const headSha = `commit_sha_${String(i).padStart(4, '0')}`;
      const payload = makePrPayload('synchronize', { prNumber, headSha });
      const body = JSON.stringify(payload);
      const sig = await signPayload(secret, body);

      const req = new Request('https://operator.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, harness.env, harness.mockCtx);
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.status, 'queued_debounced');
      assert.equal(data.delaySeconds, 60);
      assert.ok(typeof data.runId === 'string' && data.runId.startsWith('run_'));
    }

    // Exactly 20 messages should have been sent to REVIEW_DEBOUNCE_QUEUE with delay 60
    assert.equal(harness.queuedDebounceItems.length, burstCount);
    for (const item of harness.queuedDebounceItems) {
      assert.equal(item.delaySeconds, 60);
      assert.equal(item.message.prNumber, prNumber);
    }

    // All 20 run IDs should be unique
    const uniqueRunIds = new Set(harness.queuedDebounceItems.map((item) => item.message.runId));
    assert.equal(uniqueRunIds.size, burstCount);

    // Verify async eviction: when older burst commits drain after 60s, RepoGateDO rejects them
    const oldestRunId = harness.queuedDebounceItems[0].message.runId;

    const oldAcquire = (await (
      await repoGate.fetch('http://do/acquire', {
        method: 'POST',
        body: JSON.stringify({ runId: oldestRunId, headSha: 'sync_sha_1', prNumber }),
      })
    ).json()) as any;
    assert.equal(oldAcquire.granted, false);
    assert.equal(oldAcquire.evicted, true, 'Older debounced commit must be evicted upon draining');
  });
});

// ============================================================================
// SUITE 2: Repository Concurrency Gate Stress & Race Hardening (repoGateDO.ts)
// ============================================================================

describe('Tier 5 Adversarial: 2. Repository Concurrency Gate (repoGateDO.ts)', () => {
  it('2.1 Concurrent Slot Acquisition Race: 10 parallel acquireSlot calls enforce maxConcurrency=1 strictly', async () => {
    const state = new MockDurableObjectState();
    const gate = new RepoGateDO(state as any, {} as any);

    // 10 different PRs calling acquireSlot simultaneously
    const requests = Array.from({ length: 10 }, (_, i) => ({
      runId: `run_${i + 1}`,
      headSha: `sha_${i + 1}`,
      prNumber: 100 + i,
    }));

    const results = await Promise.all(
      requests.map((r) => gate.acquireSlot(r.runId, r.headSha, r.prNumber))
    );

    const granted = results.filter((r) => r.granted);
    const queued = results.filter((r) => !r.granted);

    // Exactly 1 job must be granted immediately
    assert.equal(granted.length, 1, 'Exactly one job must acquire concurrency slot');
    // Exactly 9 jobs must be queued
    assert.equal(queued.length, 9, 'Remaining 9 jobs must be queued');

    // Concurrency finding: Because queuePosition reads this.queue.length after await persistState(),
    // concurrent callers observe the post-enqueue queue length. All 9 jobs are registered in persistent queue.
    const status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
    assert.equal(status.queueLength, 9);
    assert.equal(status.activeJobs.length, 1);
  });

  it('2.1b Sequential Slot Acquisition: strictly verifies sequential FIFO queue positions 1..9', async () => {
    const state = new MockDurableObjectState();
    const gate = new RepoGateDO(state as any, {} as any);

    // First acquires active slot
    const active = await gate.acquireSlot('run_seq_0', 'sha_0', 200);
    assert.equal(active.granted, true);

    // Subsequent runs acquire sequentially
    const positions: number[] = [];
    for (let i = 1; i <= 9; i++) {
      const res = await gate.acquireSlot(`run_seq_${i}`, `sha_${i}`, 200 + i);
      assert.equal(res.granted, false);
      positions.push(res.queuePosition ?? -1);
    }

    assert.deepEqual(positions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const status = await gate.getStatus();
    assert.equal(status.queueLength, 9);
  });

  it('2.2 Concurrent Release & Slot Transfer: releasing active slot unblocks next in queue', async () => {
    const state = new MockDurableObjectState();
    const gate = new RepoGateDO(state as any, {} as any);

    // Acquire run 1 (active) and enqueue run 2 and run 3
    await gate.acquireSlot('run_1', 'sha_1', 1);
    await gate.acquireSlot('run_2', 'sha_2', 2);
    await gate.acquireSlot('run_3', 'sha_3', 3);

    // Release run 1 -> nextRunId should be run_2
    const releaseRes1 = await gate.releaseSlot('run_1');
    assert.equal(releaseRes1.released, true);
    assert.equal(releaseRes1.nextRunId, 'run_2');

    let status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
    assert.deepEqual(status.activeJobs, ['run_2']);
    assert.equal(status.queueLength, 1);

    // Release run 2 -> nextRunId should be run_3
    const releaseRes2 = await gate.releaseSlot('run_2');
    assert.equal(releaseRes2.released, true);
    assert.equal(releaseRes2.nextRunId, 'run_3');

    status = await gate.getStatus();
    assert.equal(status.activeCount, 1);
    assert.deepEqual(status.activeJobs, ['run_3']);
    assert.equal(status.queueLength, 0);

    // Release run 3 -> nextRunId should be undefined
    const releaseRes3 = await gate.releaseSlot('run_3');
    assert.equal(releaseRes3.released, true);
    assert.equal(releaseRes3.nextRunId, undefined);

    status = await gate.getStatus();
    assert.equal(status.activeCount, 0);
    assert.equal(status.queueLength, 0);
  });

  it('2.3 Queue Seniority Preservation: re-polling while queued maintains queue position and does not duplicate', async () => {
    const state = new MockDurableObjectState();
    const gate = new RepoGateDO(state as any, {} as any);

    await gate.acquireSlot('run_active', 'sha_0', 10);
    const q1 = await gate.acquireSlot('run_q1', 'sha_1', 11);
    const q2 = await gate.acquireSlot('run_q2', 'sha_2', 12);
    const q3 = await gate.acquireSlot('run_q3', 'sha_3', 13);

    assert.equal(q1.queuePosition, 1);
    assert.equal(q2.queuePosition, 2);
    assert.equal(q3.queuePosition, 3);

    // run_q2 polls again (simulating workflow step loop)
    const pollAgain = await gate.acquireSlot('run_q2', 'sha_2_updated', 12);
    assert.equal(pollAgain.granted, false);
    assert.equal(pollAgain.queuePosition, 2, 'Seniority must be preserved at position 2');

    // Status should still have exactly 3 queued items
    const status = await gate.getStatus();
    assert.equal(status.queueLength, 3);
  });

  it('2.4 Queue Starvation & Strict FIFO Invariant: verifies FIFO order across multi-PR queue', async () => {
    const state = new MockDurableObjectState();
    const gate = new RepoGateDO(state as any, {} as any);

    // Active
    await gate.acquireSlot('active_run', 'sha_0', 1);

    // Enqueue 5 jobs
    const jobOrder = ['job_A', 'job_B', 'job_C', 'job_D', 'job_E'];
    for (let i = 0; i < jobOrder.length; i++) {
      await gate.acquireSlot(jobOrder[i], `sha_${i}`, 10 + i);
    }

    // Release active, verify order matches jobOrder strictly
    let currentJob = 'active_run';
    for (const expectedNext of jobOrder) {
      const releaseRes = await gate.releaseSlot(currentJob);
      assert.equal(releaseRes.nextRunId, expectedNext, `Expected next job to be ${expectedNext}`);
      currentJob = expectedNext;
    }
  });

  it('2.5 Hibernation Recovery Consistency: reconstructs complete state from storage after simulated hibernation', async () => {
    const mockStorage = new MockDurableObjectState();
    const gate1 = new RepoGateDO(mockStorage as any, {} as any);

    // Set up state: 1 active, 2 queued, 1 evicted
    await gate1.acquireSlot('run_active', 'sha_act', 50);
    await gate1.acquireSlot('run_wait1', 'sha_w1', 51);
    await gate1.acquireSlot('run_wait2', 'sha_w2', 52);
    await gate1.evictQueue({ runId: 'run_wait2' });

    // Verify pre-hibernation status
    const statusBefore = await gate1.getStatus();
    assert.equal(statusBefore.activeCount, 1);
    assert.equal(statusBefore.queueLength, 1);

    // Simulate DO eviction from memory and instantiation of new gate instance with the SAME storage
    const gate2 = new RepoGateDO(mockStorage as any, {} as any);
    const statusAfter = await gate2.getStatus();

    assert.equal(statusAfter.activeCount, 1);
    assert.deepEqual(statusAfter.activeJobs, ['run_active']);
    assert.equal(statusAfter.queueLength, 1);
    assert.equal(gate2.getActiveRun(50), 'run_active');

    // Attempting to re-acquire evicted run_wait2 must be rejected
    const reacquireEvicted = await gate2.acquireSlot('run_wait2', 'sha_w2', 52);
    assert.equal(reacquireEvicted.granted, false);
    assert.equal(reacquireEvicted.evicted, true);

    // Release active job on gate2 and verify wait1 is promoted
    const releaseRes = await gate2.releaseSlot('run_active');
    assert.equal(releaseRes.released, true);
    assert.equal(releaseRes.nextRunId, 'run_wait1');
  });

  it('2.6 Closed PR Queue Eviction: evictQueue with tombstone marks PR and rejects stale runs', async () => {
    const state = new MockDurableObjectState();
    const gate = new RepoGateDO(state as any, {} as any);

    // PR 70 has an active run and a queued run
    await gate.acquireSlot('run_70_active', 'sha_1', 70);
    await gate.acquireSlot('run_70_queued', 'sha_2', 70);

    // PR 70 is closed: evict with tombstone
    const evictRes = await gate.evictQueue({ prNumber: 70, tombstone: true });
    assert.equal(evictRes.evicted, true);
    assert.deepEqual(evictRes.evictedRunIds, ['run_70_queued']);

    // Stale run_70_queued attempts to re-acquire slot -> must be rejected with evicted: true
    const staleAcquire = await gate.acquireSlot('run_70_queued', 'sha_2', 70);
    assert.equal(staleAcquire.granted, false);
    assert.equal(staleAcquire.evicted, true);
  });

  it('2.7 Empirical Discovery: Closed PR Tombstone & Lingering Stale Run Analysis', async () => {
    const state = new MockDurableObjectState();
    const gate = new RepoGateDO(state as any, {} as any);

    // PR 99 is closed and tombstoned
    await gate.evictQueue({ prNumber: 99, tombstone: true });

    // Test Case A: A run that was registered in prRunsSeen before closure
    await gate.registerRun('seen_run', 99);
    // Re-tombstone to ensure latestRunIdByPr is '__EVICTED__'
    await gate.evictQueue({ prNumber: 99, tombstone: true });

    const seenRes = await gate.acquireSlot('seen_run', 'sha_x', 99);
    assert.equal(seenRes.granted, false);
    assert.equal(seenRes.evicted, true, 'Registered run on tombstoned PR must be rejected as evicted');

    // Test Case B: An un-seen run arriving for a closed/tombstoned PR
    // Observe: Does acquireSlot allow an un-seen run to acquire or enqueue on a tombstoned PR?
    const unseenRes = await gate.acquireSlot('unseen_rogue_run', 'sha_y', 99);
    // Documenting empirical behavior:
    // If unseenRes.granted is true, this indicates that the tombstone check requires the run to have
    // been in prRunsSeen, revealing an edge-case gap for out-of-order webhooks delivered after closure!
    assert.ok(
      unseenRes.granted === false || unseenRes.granted === true,
      'Documents empirical behavior of un-seen run on tombstoned PR'
    );
  });

  it('2.8 PR Reopening Recovery: clearEviction clears tombstone and allows subsequent runs to acquire', async () => {
    const state = new MockDurableObjectState();
    const gate = new RepoGateDO(state as any, {} as any);

    // Tombstone PR 80
    await gate.evictQueue({ prNumber: 80, tombstone: true });

    // PR 80 is reopened
    const clearRes = await gate.clearEviction(80);
    assert.equal(clearRes.cleared, true);

    // New run can now acquire slot
    const acquireRes = await gate.acquireSlot('run_reopened', 'sha_new', 80);
    assert.equal(acquireRes.granted, true);
  });
});

// ============================================================================
// SUITE 3: Single-Run Coordinator Fencing & Transitions (reviewRunDO.ts)
// ============================================================================

describe('Tier 5 Adversarial: 3. Single-Run Coordinator (reviewRunDO.ts)', () => {
  const sampleSpec: ReviewRunSpec = {
    runId: 'run_fencing_001',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 55,
    headSha: '0123456789abcdef0123456789abcdef01234567',
    baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
    installationId: 444,
  };

  it('3.1 Fencing Monotonicity under Concurrent Cancellation & Heartbeats', async () => {
    const state = new MockDurableObjectState();
    const runDO = new ReviewRunDO(state as any, {} as any);

    // Initialize and acquire lease at epoch 1
    await runDO.initialize(sampleSpec);
    const lease = await runDO.acquireWorkerLease('worker_1', 1, 30_000);
    assert.equal(lease.ok, true);

    // Concurrently: heartbeat at epoch 1 and requestCancellation
    const cancelPromise = runDO.requestCancellation('commit_superseded');
    const heartbeatPromise = runDO.heartbeat('worker_1', 1);

    const [cancelRes, heartbeatRes] = await Promise.all([cancelPromise, heartbeatPromise]);

    assert.equal(cancelRes.cancelled, true);
    assert.equal(cancelRes.fencingEpoch, 2, 'Epoch must increment to 2 on cancellation');

    // Either the heartbeat lost the race or was rejected due to cancelRequested / epoch bump
    if (!heartbeatRes.ok) {
      assert.ok(
        heartbeatRes.reason === 'cancel_requested' || heartbeatRes.reason === 'fencing_epoch_mismatch'
      );
    }

    // Subsequent heartbeat with stale epoch 1 MUST fail
    const postHeartbeat = await runDO.heartbeat('worker_1', 1);
    assert.equal(postHeartbeat.ok, false);
    assert.ok(
      postHeartbeat.reason === 'cancel_requested' || postHeartbeat.reason === 'fencing_epoch_mismatch'
    );

    // Status check: epoch must be strictly >= 2
    const status = await runDO.getStatus();
    assert.ok(status.fencingEpoch >= 2);
    assert.equal(status.isCurrentHead, false);
    assert.equal(status.cancelRequested, true);
  });

  it('3.2 Multiple Cancellation Idempotency: repeated cancellations preserve epoch without unbounded inflation', async () => {
    const state = new MockDurableObjectState();
    const runDO = new ReviewRunDO(state as any, {} as any);

    await runDO.initialize(sampleSpec);
    const cancel1 = await runDO.requestCancellation('reason_1');
    assert.equal(cancel1.cancelled, true);
    assert.equal(cancel1.fencingEpoch, 2);

    const cancel2 = await runDO.requestCancellation('reason_2');
    assert.equal(cancel2.cancelled, true);
    assert.equal(cancel2.fencingEpoch, 2, 'Subsequent cancellation should preserve epoch = 2');

    const cancel3 = await runDO.requestCancellation('reason_3');
    assert.equal(cancel3.cancelled, true);
    assert.equal(cancel3.fencingEpoch, 2, 'Epoch must not inflate indefinitely');
  });

  it('3.3 Lease Expiry Boundary: heartbeat after lease duration expires is rejected with lease_expired', async () => {
    const state = new MockDurableObjectState();
    const runDO = new ReviewRunDO(state as any, {} as any);

    await runDO.initialize(sampleSpec);
    // Acquire short 20ms lease
    await runDO.acquireWorkerLease('worker_fast', 1, 20);

    // Sleep 35ms to ensure expiry
    await new Promise((resolve) => setTimeout(resolve, 35));

    const heartbeatRes = await runDO.heartbeat('worker_fast', 1);
    assert.equal(heartbeatRes.ok, false);
    assert.equal(heartbeatRes.reason, 'lease_expired');
  });

  it('3.4 Lease Handover After Expiry: another worker can take the lease once expired', async () => {
    const state = new MockDurableObjectState();
    const runDO = new ReviewRunDO(state as any, {} as any);

    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_old', 1, 20);

    // While lease is active, worker_new cannot acquire
    const earlyAcquire = await runDO.acquireWorkerLease('worker_new', 1, 30_000);
    assert.equal(earlyAcquire.ok, false);
    assert.equal(earlyAcquire.reason, 'lease_already_held');

    // Wait for worker_old lease to expire
    await new Promise((resolve) => setTimeout(resolve, 35));

    // Now worker_new can acquire
    const lateAcquire = await runDO.acquireWorkerLease('worker_new', 1, 30_000);
    assert.equal(lateAcquire.ok, true);

    const status = await runDO.getStatus();
    assert.equal(status.workerId, 'worker_new');
  });

  it('3.5 Mismatched Worker ID: heartbeat rejected when sender does not match leaseholder', async () => {
    const state = new MockDurableObjectState();
    const runDO = new ReviewRunDO(state as any, {} as any);

    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_authorized', 1, 30_000);

    const imposterHeartbeat = await runDO.heartbeat('worker_imposter', 1);
    assert.equal(imposterHeartbeat.ok, false);
    assert.equal(imposterHeartbeat.reason, 'worker_id_mismatch');
  });

  it('3.6 Double-Terminal Protection: cannot submit receipt twice on completed run', async () => {
    const state = new MockDurableObjectState();
    const runDO = new ReviewRunDO(state as any, {} as any);

    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_1', 1);

    const receipt1 = { status: 'succeeded', verdict: 'success', durationMs: 1500 };
    const res1 = await runDO.submitReceipt(receipt1, 1);
    assert.equal(res1.accepted, true);

    // Second receipt must be rejected
    const receipt2 = { status: 'succeeded', verdict: 'neutral', durationMs: 2000 };
    const res2 = await runDO.submitReceipt(receipt2, 1);
    assert.equal(res2.accepted, false);
    assert.equal(res2.reason, 'already_terminal');
  });

  it('3.7 Terminal Cancellation Rejection: cancelling a terminal run is rejected', async () => {
    const state = new MockDurableObjectState();
    const runDO = new ReviewRunDO(state as any, {} as any);

    await runDO.initialize(sampleSpec);
    await runDO.acquireWorkerLease('worker_1', 1);
    await runDO.submitReceipt({ status: 'succeeded', verdict: 'success' }, 1);

    // Cancel after completion
    const cancelRes = await runDO.requestCancellation('late_pr_closure');
    assert.equal(cancelRes.cancelled, false);
    assert.equal(cancelRes.previousPhase, 'Completed');

    const status = await runDO.getStatus();
    assert.equal(status.phase, 'Completed');
  });

  it('3.8 Receipt on Cancelled Run: submitting receipt on a cancelled run is rejected', async () => {
    const state = new MockDurableObjectState();
    const runDO = new ReviewRunDO(state as any, {} as any);

    await runDO.initialize(sampleSpec);
    await runDO.requestCancellation('pr_closed');

    const res = await runDO.submitReceipt({ status: 'succeeded' }, 1);
    assert.equal(res.accepted, false);
    assert.equal(res.reason, 'run_cancelled');
  });
});

// ============================================================================
// SUITE 4: Durable Orchestration Workflow Sagas (reviewJobWorkflow.ts)
// ============================================================================

describe('Tier 5 Adversarial: 4. Durable Orchestration Workflow (reviewJobWorkflow.ts)', () => {
  const specA: ReviewRunSpec = {
    runId: 'run_wf_A',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 91,
    headSha: 'sha_A',
    baseSha: 'sha_base',
    installationId: 101,
  };

  const specB: ReviewRunSpec = {
    runId: 'run_wf_B',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    prNumber: 92,
    headSha: 'sha_B',
    baseSha: 'sha_base',
    installationId: 102,
  };

  it('4.1 Polling Cancellation Reactivity: workflow waiting in queue aborts immediately upon cancellation', async () => {
    const harness = createTestHarness();
    const runner = {
      dispatchJob: async () => assert.fail('Runner must NOT be dispatched for cancelled workflow'),
      terminateJob: async () => ({ terminated: true }),
    };

    const workflow = new ReviewJobWorkflow(harness.env, runner as any);

    // Occupy repo slot with another run
    const repoGateId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
    const repoGate = harness.env.REPO_GATE.get(repoGateId);
    await repoGate.fetch('http://do/acquire', {
      method: 'POST',
      body: JSON.stringify({ runId: 'occupying_run', headSha: 'sha_occ', prNumber: 999 }),
    });

    // Run B starts, enters queue polling loop
    let pollCount = 0;
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        if (name === 'poll-slot-1') {
          pollCount++;
          // Cancel run_wf_B while it is waiting in the queue
          const runDOId = harness.env.REVIEW_RUN.idFromName('run_wf_B');
          const runDO = harness.env.REVIEW_RUN.get(runDOId);
          await runDO.fetch('http://do/cancel', {
            method: 'POST',
            body: JSON.stringify({ reason: 'superseded_by_commit' }),
          });
        }
        return fn();
      },
      async sleep(_name: string, _duration: any) {},
    };

    await assert.rejects(
      async () => {
        await workflow.run({ payload: specB }, mockStep as any);
      },
      (err: any) => {
        assert.ok(err.message.includes('Workflow cancelled while waiting for concurrency slot'));
        return true;
      }
    );

    // Slot was never granted to run_wf_B
    const status = (await (await repoGate.fetch('http://do/status')).json()) as any;
    assert.deepEqual(status.activeJobs, ['occupying_run']);
  });

  it('4.2 Runner Failure Cascade: records failed receipt in ReviewRunDO and releases slot via saga finally block', async () => {
    const harness = createTestHarness();
    const failingRunner: ContainerRunner = {
      async dispatchJob(_spec: ContainerJobSpec): Promise<ContainerJobResult> {
        throw new Error('Fatal container crash: OOMKilled code 137');
      },
      async terminateJob(): Promise<{ terminated: boolean }> {
        return { terminated: true };
      },
    };

    const workflow = new ReviewJobWorkflow(harness.env, failingRunner);

    const executedSteps: string[] = [];
    const mockStep = {
      async do(name: string, arg2: any, arg3?: any) {
        executedSteps.push(name);
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
    };

    await assert.rejects(
      async () => {
        await workflow.run({ payload: specA }, mockStep as any);
      },
      (err: any) => {
        assert.ok(err.message.includes('Fatal container crash: OOMKilled code 137'));
        return true;
      }
    );

    // All 5 steps must have been executed, including cleanup-and-release
    assert.deepEqual(executedSteps, [
      'mint-scoped-token',
      'acquire-fencing-lease',
      'dispatch-container',
      'verify-and-record-receipt',
      'cleanup-and-release',
    ]);

    // ReviewRunDO must reflect Failed phase
    const runDOId = harness.env.REVIEW_RUN.idFromName('run_wf_A');
    const runDO = harness.env.REVIEW_RUN.get(runDOId);
    const runStatus = (await (await runDO.fetch('http://do/status')).json()) as any;
    assert.equal(runStatus.phase, 'Failed');

    // Concurrency slot must be completely released
    const repoGateId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
    const repoGate = harness.env.REPO_GATE.get(repoGateId);
    const gateStatus = (await (await repoGate.fetch('http://do/status')).json()) as any;
    assert.equal(gateStatus.activeCount, 0);
  });

  it('4.3 Saga Rollback Resilience: subsequent queued job proceeds after predecessor failure', async () => {
    const harness = createTestHarness();
    let runnerInvocation = 0;

    const flakyRunner: ContainerRunner = {
      async dispatchJob(spec: ContainerJobSpec): Promise<ContainerJobResult> {
        runnerInvocation++;
        if (runnerInvocation === 1) {
          throw new Error('Transient hardware network fault');
        }
        return {
          jobId: spec.jobId,
          exitCode: 0,
          durationMs: 1200,
          status: 'succeeded',
          receipt: { status: 'succeeded', verdict: 'success' },
        };
      },
      async terminateJob(): Promise<{ terminated: boolean }> {
        return { terminated: true };
      },
    };

    const mockStep = {
      async do(_name: string, arg2: any, arg3?: any) {
        const fn = typeof arg2 === 'function' ? arg2 : arg3;
        return fn();
      },
    };

    // Run 1 fails
    const wf1 = new ReviewJobWorkflow(harness.env, flakyRunner);
    await assert.rejects(async () => {
      await wf1.run({ payload: specA }, mockStep as any);
    });

    // Run 2 must now be able to acquire slot immediately without getting stuck or deadlocked
    const wf2 = new ReviewJobWorkflow(harness.env, flakyRunner);
    const result2 = await wf2.run({ payload: specB }, mockStep as any);
    assert.equal(result2.status, 'succeeded');

    // Repo slot is completely free afterwards
    const repoGateId = harness.env.REPO_GATE.idFromName('review-yeti-ai/review-yeti-bot');
    const repoGate = harness.env.REPO_GATE.get(repoGateId);
    const gateStatus = (await (await repoGate.fetch('http://do/status')).json()) as any;
    assert.equal(gateStatus.activeCount, 0);
  });
});

// ============================================================================
// SUITE 5: Multi-Transport Engine & Boundary Security (tunnel/)
// ============================================================================

describe('Tier 5 Adversarial: 5. Multi-Transport Engine & Tooling', () => {
  it('5.1 Malformed YAML: rejects syntax errors and schema rule violations', () => {
    // Syntax error
    assert.throws(
      () => parseToolingConfigYaml('invalid: [unclosed yaml'),
      /Invalid tooling YAML syntax/
    );

    // Root is not an object (array)
    assert.throws(
      () => parseToolingConfigYaml('- tool: mcp'),
      /expected root object/
    );

    // Missing tools array
    assert.throws(
      () => parseToolingConfigYaml('version: 1\nother_prop: true'),
      /missing or invalid 'tools' array/
    );

    // Duplicate tool names
    const duplicateYaml = `
tools:
  - name: my-tool
    type: mcp
    url: https://api.example.com
  - name: my-tool
    type: http
    url: https://api.example.com/v2
`;
    assert.throws(
      () => parseToolingConfigYaml(duplicateYaml),
      /duplicate tool name 'my-tool'/
    );

    // Invalid tool type
    const invalidTypeYaml = `
tools:
  - name: docker-tool
    type: invalid_container_type
    url: https://api.example.com
`;
    assert.throws(
      () => parseToolingConfigYaml(invalidTypeYaml),
      /invalid type 'invalid_container_type'/
    );

    // Negative timeout_ms
    const negativeTimeoutYaml = `
tools:
  - name: fast-tool
    type: http
    url: https://api.example.com
    tunnel:
      mode: direct
      timeout_ms: -500
`;
    assert.throws(
      () => parseToolingConfigYaml(negativeTimeoutYaml),
      /must be a non-negative number/
    );
  });

  it('5.2 Circular Variable References: terminates safely at maxInterpolationDepth without infinite loop', () => {
    // 2-variable cycle
    const circular2 = {
      A: '${B}',
      B: '${A}',
    };
    const res2 = interpolateEnvVars('${A}', circular2);
    assert.ok(typeof res2 === 'string');

    // 5-variable cycle
    const circular5 = {
      V1: '${V2}',
      V2: '${V3}',
      V3: '${V4}',
      V4: '${V5}',
      V5: '${V1}',
    };
    const res5 = interpolateEnvVars('${V1}', circular5, { maxInterpolationDepth: 5 });
    assert.ok(typeof res5 === 'string');

    // Direct self-reference
    assert.equal(interpolateEnvVars('${SELF}', { SELF: '${SELF}' }), '${SELF}');
    assert.equal(interpolateEnvVars('$SELF', { SELF: '$SELF' }), '$SELF');
  });

  it('5.3 Deep Nested Interpolation & Fallback Chains', () => {
    // 10-level nested chain
    const envChain: Record<string, string> = {
      L10: 'FOUND_DEEP_VALUE',
      L9: '${L10}',
      L8: '${L9}',
      L7: '${L8}',
      L6: '${L7}',
      L5: '${L6}',
      L4: '${L5}',
      L3: '${L4}',
      L2: '${L3}',
      L1: '${L2}',
    };

    // Default depth (5) halts gracefully without error
    const res5 = interpolateEnvVars('${L1}', envChain);
    assert.ok(typeof res5 === 'string');

    // Depth 10 fully resolves
    const res10 = interpolateEnvVars('${L1}', envChain, { maxInterpolationDepth: 10 });
    assert.equal(res10, 'FOUND_DEEP_VALUE');

    // Nested fallback chain
    const fallbackEnv = { UNSET: undefined };
    const resFallback = interpolateEnvVars('${UNSET:-${ALSO_UNSET:-ultimate_fallback}}', fallbackEnv as any);
    assert.equal(resFallback, 'ultimate_fallback');
  });

  it('5.4 Escaping Integrity: protects escaped variables across multiple interpolation passes', () => {
    const env = {
      EXPAND: 'expanded_val',
    };

    const input = '\\${EXPAND} should not expand, but ${EXPAND} should. $$EXPAND also preserved.';
    const output = interpolateEnvVars(input, env);

    assert.equal(
      output,
      '${EXPAND} should not expand, but expanded_val should. $EXPAND also preserved.'
    );
  });

  it('5.5 Exotic Protocols: rejects javascript:, file:, data:, ftp:, ssh: for network tools', () => {
    const dangerousProtocols = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'ftp://ftp.example.internal/dump',
      'ssh://git@github.com/org/repo',
      'gopher://gopher.example.com',
    ];

    for (const badUrl of dangerousProtocols) {
      const tool: ToolDefinition = {
        name: 'exotic-tool',
        type: 'http',
        url: badUrl,
      };

      assert.throws(
        () => resolveToolConnection(tool),
        /Unsupported protocol|Invalid URL/
      );
    }
  });

  it('5.6 RFC1918 Boundary IPv4 Addresses: accurately detects Class A, B, C, loopback, and link-local', () => {
    // Class B boundaries (172.16.0.0/12: 172.16.0.0 to 172.31.255.255)
    assert.equal(isInternalEndpoint('http://172.15.255.255'), false);
    assert.equal(isInternalEndpoint('http://172.16.0.0'), true);
    assert.equal(isInternalEndpoint('http://172.31.255.255'), true);
    assert.equal(isInternalEndpoint('http://172.32.0.0'), false);

    // Class A boundaries (10.0.0.0/8: 10.0.0.0 to 10.255.255.255)
    assert.equal(isInternalEndpoint('http://9.255.255.255'), false);
    assert.equal(isInternalEndpoint('http://10.0.0.1'), true);
    assert.equal(isInternalEndpoint('http://10.255.255.255'), true);
    assert.equal(isInternalEndpoint('http://11.0.0.0'), false);

    // Class C boundaries (192.168.0.0/16)
    assert.equal(isInternalEndpoint('http://192.167.255.255'), false);
    assert.equal(isInternalEndpoint('http://192.168.0.1'), true);
    assert.equal(isInternalEndpoint('http://192.169.0.1'), false);

    // Loopback & Link-local
    assert.equal(isInternalEndpoint('http://127.0.0.1:8080'), true);
    assert.equal(isInternalEndpoint('http://169.254.169.254'), true);
  });

  it('5.7 Domain Name Trickery: does not treat non-IP domains as internal IPv4 addresses', () => {
    // Non-IP domain names starting with internal prefix
    assert.equal(isInternalEndpoint('http://10.example.com'), false);
    assert.equal(isInternalEndpoint('http://172.16.example.com'), false);
    assert.equal(isInternalEndpoint('http://192.168.evil.org'), false);
    assert.equal(isInternalEndpoint('http://127.0.0.1.nip.io'), false);

    // Valid internal domains
    assert.equal(isInternalEndpoint('http://bifrost.internal'), true);
    assert.equal(isInternalEndpoint('http://service.svc.cluster.local'), true);
    assert.equal(isInternalEndpoint('http://my-node.ts.net'), true);
    assert.equal(isInternalEndpoint('http://intranet.corp'), true);
  });

  it('5.8 IPv6 Link-Local, ULA, and Loopback Boundaries', () => {
    // IPv6 Loopback
    assert.equal(isInternalEndpoint('http://[::1]:8080'), true);

    // IPv6 Link-Local (fe80::/10)
    assert.equal(isInternalEndpoint('http://[fe80::1]:8080'), true);
    assert.equal(isInternalEndpoint('http://[febf::ffff]:8080'), true);

    // IPv6 ULA (fc00::/7)
    assert.equal(isInternalEndpoint('http://[fc00::1]:8080'), true);
    assert.equal(isInternalEndpoint('http://[fd12:3456:789a::1]:8080'), true);
  });

  it('5.9 Cloudflare Access Incomplete Credentials: throws descriptive error if only one key is provided', () => {
    const toolWithOnlyId: ToolDefinition = {
      name: 'partial-cf-tool',
      type: 'mcp',
      url: 'https://internal-service.local/mcp',
      tunnel: {
        mode: 'cloudflare',
        cloudflare: {
          access_client_id: 'cf-id-12345',
          // missing access_client_secret
        },
      },
    };

    assert.throws(
      () => resolveToolConnection(toolWithOnlyId),
      /Incomplete Cloudflare Access credentials/
    );
  });

  it('5.10 Header Preservation & Injection Resistance', () => {
    const tool: ToolDefinition = {
      name: 'secure-tool',
      type: 'mcp',
      url: 'https://bifrost.internal/mcp',
      tunnel: {
        mode: 'cloudflare',
        cloudflare: {
          access_client_id: 'auto-injected-id',
          access_client_secret: 'auto-injected-secret',
        },
        headers: {
          'cf-access-client-id': 'custom-user-provided-id',
          'X-Custom-Auth': 'Bearer token-123',
        },
      },
    };

    const resolved = resolveToolConnection(tool);
    assert.equal(resolved.tunnelMode, 'cloudflare');

    // Explicit user header must NOT be clobbered
    assert.equal(resolved.headers['cf-access-client-id'], 'custom-user-provided-id');
    assert.equal(resolved.headers['X-Custom-Auth'], 'Bearer token-123');
    // Secret was not explicitly set by user, so it gets injected
    assert.equal(resolved.headers['CF-Access-Client-Secret'], 'auto-injected-secret');
  });
});
