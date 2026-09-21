import { describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';

/**
 * Shadow mode (`review_engine: 'shadow'`, `src/cli/publishingReview.ts`'s `resolveReviewEngine`)
 * runs the fan-out persona panel (gating, publishing) and the composed engine (non-gating,
 * additive evidence) concurrently on the same head. The one invariant every test in this file
 * ultimately serves: a shadow lane must never reach `computeArbitration`, and a shadow failure
 * must never change the published verdict.
 *
 * Mutation target 1 (the important one): "let a shadow lane into `rawRoster.lanes`" -- the test
 * `'never lets shadow findings gate the published verdict, even when severe enough to flip it'`
 * below uses three P1 shadow findings, which is enough to cross the blocking threshold on its
 * own (`reviewCore.js`: `blockP1 = max(3, ceil(panelSize / 2))` -- three P1s always meets a
 * threshold whose floor is 3) if they were ever merged into the panel's own roster before
 * arbitration. If a future change starts spreading the shadow result into `panelResult` (or into
 * `rawPublicationRoster`'s input) before `computeArbitration` runs, that test goes red: SHIP
 * becomes BLOCK.
 *
 * Mutation target 2: "let a composed-engine throw propagate" -- the test
 * `'swallows a composed-engine throw and still publishes the panel's verdict'` below makes the
 * composed engine (shadow lane) reject, and asserts the panel's clean SHIP still publishes and
 * `runPublishingReviewWorker` never rejects.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

/** Base-policy JSON that selects shadow mode (see `resolveWorkerConfig` in
 * `src/config/publishingWorkerConfig.ts`). Only base policy may select the engine -- see
 * `resolveReviewEngine`'s doc comment in `src/cli/publishingReview.ts`. */
const SHADOW_POLICY_JSON = JSON.stringify({
  review_yeti: {
    personas: 'security',
    budget: { max_investigation_turns: 10 },
    review_engine: 'shadow',
  },
});

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_YETI_POLICY_JSON: SHADOW_POLICY_JSON,
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

function checkClient(overrides: Record<string, unknown> = {}) {
  return {
    createCheck: vi.fn(async () => 4242),
    completeCheck: vi.fn(async () => {}),
    ...overrides,
  };
}

function completionAdapter() {
  return {
    reportTerminalFailure: vi.fn(async (_event: unknown) => {}),
    reportTerminalSuccess: vi.fn(async (_event: unknown) => {}),
    reportReviewEvidence: vi.fn(async (_event: unknown) => {}),
  };
}

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function finding(overrides: Record<string, unknown> = {}) {
  return {
    severity: 'P2',
    path: 'src/a.ts',
    line: 1,
    title: 'finding',
    body: 'a finding',
    ...overrides,
  };
}

/** A clean panel: one lane, no findings, SHIP. */
function cleanPanelResult() {
  return {
    headSha: HEAD,
    applicablePersonaIds: ['sec-lane'],
    personas: [{ id: 'sec-lane', required: true, providerId: 'bifrost', model: 'test-model',
      decision: 'APPROVE', findings: [], usage: null, costUSD: null, durationMs: 5 }],
    optionalFailures: [],
    zeroLaneNonEvidence: false,
    panelWallClockMs: 10,
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
    arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'clean', usage: null, costUSD: null, durationMs: 0 },
  };
}

/** A composed (shadow) result carrying three distinct P1 findings across three distinct task
 * ids, spread across tasks so `clusterFindings` does not collapse them into one -- exactly the
 * shape `publishingReviewComposedEnginePanelSize.test.ts` uses to prove BLOCK when these count. */
function severeComposedResult() {
  const taskIds = ['t1', 't2', 't3'];
  const personas = taskIds.map((id) => ({
    id, required: true, providerId: 'bifrost', model: 'test-model', decision: 'FINDINGS',
    findings: [finding({ severity: 'P1', title: `shadow defect ${id}`, body: `a shadow-only defect ${id}` })],
    usage: null, costUSD: null, durationMs: 5,
  }));
  return {
    headSha: HEAD,
    applicablePersonaIds: taskIds,
    personas,
    optionalFailures: [],
    zeroLaneNonEvidence: false,
    panelWallClockMs: 20,
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
    arbiter: { providerId: 'bifrost', model: 'none', verdict: 'BLOCK', rationale: 'shadow-only block', usage: null, costUSD: null, durationMs: 0 },
  };
}

/** A composed (shadow) result that produces literally nothing: no personas, no failures. */
function emptyComposedResult() {
  return {
    headSha: HEAD,
    applicablePersonaIds: [],
    personas: [],
    optionalFailures: [],
    zeroLaneNonEvidence: true,
    panelWallClockMs: 1,
    quorum: { required: 0, distinctProviders: [], satisfied: true },
    moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
    arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'nothing', usage: null, costUSD: null, durationMs: 0 },
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    checkClient: checkClient(),
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async () => cleanPanelResult()) as never,
    composedReviewRunner: vi.fn(async () => severeComposedResult()) as never,
    completion: completionAdapter(),
    client: {} as never,
    ...over,
  };
}

describe('shadow mode (review_engine: shadow) -- non-gating composed evidence', () => {
  it("never lets shadow findings gate the published verdict, even when severe enough to flip it", async () => {
    const d = deps();
    const receipt = await runPublishingReviewWorker(env(), d as never);
    // The panel itself is clean: if the three severe shadow P1s ever leaked into
    // `rawRoster.lanes`/`computeArbitration`, this would read BLOCK/failure instead.
    expect(receipt.verdict).toBe('SHIP');
    expect(receipt.conclusion).toBe('success');
    expect(receipt.blockingFindingCount).toBe(0);
    expect(receipt.findingCount).toBe(0);
    expect(d.composedReviewRunner).toHaveBeenCalledTimes(1);
  });

  it("swallows a composed-engine throw and still publishes the panel's verdict", async () => {
    const composedReviewRunner = vi.fn(async () => { throw new Error('composed engine exploded'); });
    const d = deps({ composedReviewRunner: composedReviewRunner as never });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.verdict).toBe('SHIP');
    expect(receipt.conclusion).toBe('success');
    expect((d.checkClient as ReturnType<typeof checkClient>).completeCheck).toHaveBeenCalledTimes(1);
    expect((d.completion as ReturnType<typeof completionAdapter>).reportTerminalFailure).not.toHaveBeenCalled();
    // Recorded as evidence -- never added to the panel's own optionalFailures/failedLanes.
    const event = (d.completion as ReturnType<typeof completionAdapter>).reportReviewEvidence.mock.calls[0]?.[0] as
      { result?: { personas: Array<{ id: string; evidenceSource?: string; errorClass?: string }> } };
    const shadowEntry = event?.result?.personas.find((p) => p.evidenceSource === 'shadow');
    expect(shadowEntry).toMatchObject({ id: 'shadow_composed_engine', evidenceSource: 'shadow' });
    expect(shadowEntry?.errorClass).toBeDefined();
  });

  it('an abort/timeout on the composed engine is swallowed the same way a throw is', async () => {
    const composedReviewRunner = vi.fn(async () => {
      const err = new Error('shadow deadline exceeded');
      err.name = 'PanelDeadlineExceededError';
      throw err;
    });
    const d = deps({ composedReviewRunner: composedReviewRunner as never });
    await expect(runPublishingReviewWorker(env(), d as never)).resolves.toMatchObject({ conclusion: 'success' });
  });

  it('tags shadow evidence distinctly from panel evidence in the reported result', async () => {
    const d = deps();
    await runPublishingReviewWorker(env(), d as never);
    const event = (d.completion as ReturnType<typeof completionAdapter>).reportReviewEvidence.mock.calls[0]?.[0] as
      { result?: { personas: Array<{ id: string; evidenceSource?: string; decision: string }> } };
    const personas = event?.result?.personas ?? [];
    const panelLane = personas.find((p) => p.id === 'sec-lane');
    const shadowLanes = personas.filter((p) => p.evidenceSource === 'shadow');
    expect(panelLane?.evidenceSource).toBeUndefined();
    expect(shadowLanes).toHaveLength(3);
    expect(shadowLanes.map((p) => p.id).sort()).toEqual(['t1', 't2', 't3']);
    for (const lane of shadowLanes) expect(lane.decision).toBe('FINDINGS');
  });

  // NOT PINNED BY A TEST, deliberately and with the reason recorded rather than left implicit:
  // that the AUTHORITATIVE `WorkerReviewCompletion.v1` body excludes shadow lanes.
  //
  // It holds structurally. `reportReviewResult` calls `buildReviewResult()` with NO options, and
  // every shadow branch inside is guarded by `options.includeShadow &&`; only the non-authoritative
  // `reportReviewEvidence` call opts in. There is no path that reaches the authoritative body with
  // a shadow lane attached.
  //
  // A test was attempted and abandoned for a known cause, not a vague one: driving the
  // authoritative path needs a full worker contract fixture (policy/config digests and the rest),
  // and `REVIEW_AUTHORITATIVE_GATE=true` alone fails with "publishing review worker contract is
  // invalid". Building that fixture is worthwhile follow-up; asserting it half-way would be worse
  // than saying so here.
  //
  // Worth stating why it matters: `deriveCanonicalWorkerReviewEvidence` rejects any persona id
  // outside the trusted roster, so a leak would turn valid evidence into a published FAILURE --
  // loud, not silent. The dangerous direction is already covered: arbitration reads `panelResult`,
  // which is only ever assigned from `panelRunner`.

  it('is byte-identical to a plain panel run when the composed run produces nothing', async () => {
    const panelOnlyDeps = {
      checkClient: checkClient(),
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: vi.fn(async () => cleanPanelResult()) as never,
      completion: completionAdapter(),
      client: {} as never,
    };
    const plainEnv = env();
    delete (plainEnv as Record<string, unknown>).REVIEW_YETI_POLICY_JSON;
    await runPublishingReviewWorker(plainEnv, panelOnlyDeps as never);
    const plainEvent = (panelOnlyDeps.completion.reportReviewEvidence as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];

    const shadowDeps = deps({ composedReviewRunner: vi.fn(async () => emptyComposedResult()) as never });
    await runPublishingReviewWorker(env(), shadowDeps as never);
    const shadowEvent = (shadowDeps.completion as ReturnType<typeof completionAdapter>).reportReviewEvidence.mock.calls[0]?.[0] as
      { result?: { personas: unknown } };

    expect(JSON.stringify(shadowEvent?.result?.personas)).toBe(JSON.stringify((plainEvent as { result?: { personas: unknown } })?.result?.personas));
  });

  it('runs the composed engine concurrently and does not delay check publication', async () => {
    const order: string[] = [];
    let resolveShadow: (value: unknown) => void = () => {};
    const shadowGate = new Promise((resolve) => { resolveShadow = resolve; });
    // The composed (shadow) engine only resolves once `completeCheck` fires. If a future change
    // made shadow mode await the composed run before publishing, this would deadlock (the check
    // would never be published, so the gate would never open) and the test would time out.
    const composedReviewRunner = vi.fn(async () => { await shadowGate; order.push('shadow-settled'); return severeComposedResult(); });
    const cc = checkClient({
      completeCheck: vi.fn(async () => { order.push('check'); resolveShadow(undefined); }),
    });
    const d = deps({ checkClient: cc, composedReviewRunner: composedReviewRunner as never });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(order).toEqual(['check', 'shadow-settled']);
  });

  it("gives the shadow run its own deadline signal, distinct from the panel's", async () => {
    const panelSignals: Array<AbortSignal | undefined> = [];
    const shadowSignals: Array<AbortSignal | undefined> = [];
    const panelRunner = vi.fn(async (options: { signal?: AbortSignal }) => { panelSignals.push(options.signal); return cleanPanelResult(); });
    const composedReviewRunner = vi.fn(async (options: { signal?: AbortSignal }) => { shadowSignals.push(options.signal); return severeComposedResult(); });
    const d = deps({ panelRunner: panelRunner as never, composedReviewRunner: composedReviewRunner as never });
    await runPublishingReviewWorker(env(), d as never);
    expect(panelSignals[0]).toBeDefined();
    expect(shadowSignals[0]).toBeDefined();
    expect(panelSignals[0]).not.toBe(shadowSignals[0]);
  });

  it('never invokes the composed engine when base policy stays on the plain panel engine', async () => {
    const composedReviewRunner = vi.fn();
    const panelRunner = vi.fn(async () => cleanPanelResult());
    const plainEnv = env();
    delete (plainEnv as Record<string, unknown>).REVIEW_YETI_POLICY_JSON;
    const d = {
      checkClient: checkClient(),
      sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      panelRunner: panelRunner as never,
      composedReviewRunner: composedReviewRunner as never,
      completion: completionAdapter(),
      client: {} as never,
    };
    await runPublishingReviewWorker(plainEnv, d as never);
    expect(panelRunner).toHaveBeenCalledTimes(1);
    expect(composedReviewRunner).not.toHaveBeenCalled();
  });
});
