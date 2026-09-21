import { describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';

/**
 * Mutation target 1 (composed-engine PR): "Remove `panelSize: 1` -> a threshold-invariance test
 * must go red." This test constructs a composed-engine run with a 7-task roster carrying exactly
 * 3 P1 findings. `reviewCore.js`'s blocking threshold is `max(3, ceil(panelSize / 2))`:
 *   - panelSize = 1 (one composed context is one reviewer, wired at the computeArbitration call
 *     site in `src/cli/publishingReview.ts`) -> blockP1 = 3 -> 3 P1s meets the threshold -> BLOCK.
 *   - panelSize defaulted to the lane count (7, the task count) -> blockP1 = 4 -> 3 P1s is below
 *     threshold -> FIX_FIRST, not BLOCK.
 * A longer task plan must never let the composed reviewer silently raise its own blocking bar.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

/** Base-policy JSON that selects the composed engine (see `resolveWorkerConfig` in
 * `src/config/publishingWorkerConfig.ts`). `review_engine` is only readable from here -- an env
 * var alone must never select the engine (see `resolveReviewEngine` in
 * `src/cli/publishingReview.ts`). */
const COMPOSED_POLICY_JSON = JSON.stringify({
  review_yeti: {
    personas: 'security',
    budget: { max_investigation_turns: 10 },
    review_engine: 'composed',
  },
});

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_YETI_POLICY_JSON: COMPOSED_POLICY_JSON,
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'calltelemetry/ct-meta',
    REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_EXECUTION_ATTEMPT: '1',
    REVIEW_PR_NUMBER: '2795',
    REVIEW_HEAD_SHA: HEAD,
    REVIEW_BASE_SHA: BASE,
    REVIEW_MODEL: 'ollama/glm-5.3-flash',
    OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
    OPENAI_API_KEY: 'vk-test',
    GH_TOKEN: 'ghs_test',
    ...overrides,
  };
}

function checkClient() {
  return {
    createCheck: vi.fn(async () => 4242),
    completeCheck: vi.fn(async () => {}),
  };
}

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function makeFinding(path: string, line: number, id: string) {
  return {
    severity: 'P1',
    path,
    line,
    title: `defect ${id}`,
    body: `a real defect ${id}`,
  };
}

/** A 7-task composed roster with exactly 3 P1 findings, spread across 3 distinct tasks so
 * `clusterFindings` does not collapse them into one. */
function sevenTaskComposedResult() {
  const taskIds = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
  const personas = taskIds.map((id, idx) => ({
    id,
    required: true,
    providerId: 'bifrost',
    model: 'test-model',
    decision: idx < 3 ? 'FINDINGS' : 'APPROVE',
    findings: idx < 3 ? [makeFinding('src/a.ts', 1, id)] : [],
  }));
  return {
    headSha: HEAD,
    applicablePersonaIds: taskIds,
    personas,
    optionalFailures: [],
    zeroLaneNonEvidence: false,
    panelWallClockMs: 10,
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
    arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'stub', usage: null, costUSD: null, durationMs: 0 },
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    checkClient: checkClient(),
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    composedReviewRunner: vi.fn(async () => sevenTaskComposedResult()) as never,
    client: {} as never,
    ...over,
  };
}

describe('composed engine panelSize wiring (threshold invariance)', () => {
  it('blocks a 7-task roster with 3 P1 findings under the single-reviewer threshold', async () => {
    const receipt = await runPublishingReviewWorker(env(), deps());
    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.blockingFindingCount).toBe(3);
  });

  it('never calls the fan-out panelRunner when base policy selects the composed engine', async () => {
    const panelRunner = vi.fn();
    const d = deps({ panelRunner: panelRunner as never });
    await runPublishingReviewWorker(env(), d);
    expect(panelRunner).not.toHaveBeenCalled();
    expect(d.composedReviewRunner).toHaveBeenCalledTimes(1);
  });

  it('uses the composed engine when policy omits review_engine', async () => {
    const panelRunner = vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    const composedReviewRunner = vi.fn(async () => sevenTaskComposedResult());
    const localEnv = env();
    delete (localEnv as Record<string, unknown>).REVIEW_YETI_POLICY_JSON;
    const d = {
      checkClient: checkClient(),
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      composedReviewRunner: composedReviewRunner as never,
      client: {} as never,
    };
    await runPublishingReviewWorker(localEnv, d);
    expect(composedReviewRunner).toHaveBeenCalledTimes(1);
    expect(panelRunner).not.toHaveBeenCalled();
  });

  it('never lets a raw REVIEW_ENGINE env var select the engine -- only base policy can', async () => {
    // A PR/dispatch context setting REVIEW_ENGINE=composed directly (with no matching
    // review_engine in base policy) must not switch the review's own engine. Only
    // `workerConfig.review_engine`, projected from base policy, may do that (see
    // `resolveReviewEngine` in `src/cli/publishingReview.ts`).
    const panelRunner = vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    const composedReviewRunner = vi.fn();
    const localEnv = env();
    (localEnv as Record<string, unknown>).REVIEW_YETI_POLICY_JSON = JSON.stringify({
      review_yeti: { personas: 'security', budget: { max_investigation_turns: 10 }, review_engine: 'panel' },
    });
    (localEnv as Record<string, unknown>).REVIEW_ENGINE = 'composed';
    const d = {
      checkClient: checkClient(),
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      composedReviewRunner: composedReviewRunner as never,
      client: {} as never,
    };
    await runPublishingReviewWorker(localEnv, d);
    expect(panelRunner).toHaveBeenCalledTimes(1);
    expect(composedReviewRunner).not.toHaveBeenCalled();
  });
});
