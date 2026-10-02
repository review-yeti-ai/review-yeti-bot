import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runPublishingReviewWorker, zoektGroundingEnabledFor } from '../../src/cli/publishingReview';
import { mergeZoektToolConfig } from '../../src/panel/panelEngine';
import * as zoektGroundingModule from '../../src/mcp/zoektGrounding';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
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
    ZOEKT_GROUNDING_ENABLED: 'true',
    ...overrides,
  };
}

function basePanel() {
  return {
    applicablePersonaIds: ['sec-lane'],
    personas: [{ id: 'sec-lane', findings: [] }],
    optionalFailures: [],
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    arbiter: { verdict: 'SHIP' },
  };
}

function deps(panelRunner: ReturnType<typeof vi.fn>, over: Record<string, unknown> = {}) {
  return {
    checkClient: {
      createCheck: vi.fn(async () => 4242),
      completeCheck: vi.fn(async () => {}),
    },
    currentPullRequestVerifier: vi.fn(async () => undefined),
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: panelRunner as never,
    client: {} as never,
    ...over,
  };
}

describe('zoektGroundingEnabledFor — the three-conjunct gate (REL-677)', () => {
  const baseEnv = { NODE_ENV: 'test', ZOEKT_GROUNDING_ENABLED: 'true' } as NodeJS.ProcessEnv;
  const enabledConfig = { pre_checks: { zoekt: { enabled: true } } };
  const disabledConfig = { pre_checks: { zoekt: { enabled: false } } };

  it('requires the deployment opt-in', () => {
    expect(zoektGroundingEnabledFor({ NODE_ENV: 'test' } as NodeJS.ProcessEnv, enabledConfig)).toBe(false);
    expect(zoektGroundingEnabledFor({ NODE_ENV: 'test', ZOEKT_GROUNDING_ENABLED: 'true' } as NodeJS.ProcessEnv, enabledConfig)).toBe(true);
  });

  it('honors the no-redeploy kill switch', () => {
    expect(zoektGroundingEnabledFor(
      { NODE_ENV: 'test', ZOEKT_GROUNDING_ENABLED: 'true', ZOEKT_GROUNDING_DISABLED: 'true' } as NodeJS.ProcessEnv, enabledConfig,
    )).toBe(false);
  });

  it('honors the config-level opt-out (pre_checks.zoekt.enabled === false)', () => {
    expect(zoektGroundingEnabledFor(baseEnv, disabledConfig)).toBe(false);
    expect(zoektGroundingEnabledFor(baseEnv, {})).toBe(true);
    expect(zoektGroundingEnabledFor(baseEnv, { pre_checks: { zoekt: { enabled: true } } })).toBe(true);
  });
});

describe('zoektGroundingEnabledFor — per-repository canary (REL-1282)', () => {
  const cfg = { pre_checks: { zoekt: { enabled: true } } };
  const withFlag = (v: string) => ({ NODE_ENV: 'test', ZOEKT_GROUNDING_ENABLED: v }) as NodeJS.ProcessEnv;

  it('enables only the listed repositories for an owner/repo allow-list, case-insensitively', () => {
    const env = withFlag('Example-Org/Canary, example-org/other');
    expect(zoektGroundingEnabledFor(env, cfg, 'example-org/canary')).toBe(true);
    expect(zoektGroundingEnabledFor(env, cfg, 'EXAMPLE-ORG/OTHER')).toBe(true);
    expect(zoektGroundingEnabledFor(env, cfg, 'example-org/big-repo')).toBe(false);
  });

  it('keeps `true` as every repository', () => {
    expect(zoektGroundingEnabledFor(withFlag('true'), cfg, 'example-org/anything')).toBe(true);
    expect(zoektGroundingEnabledFor(withFlag('true'), cfg)).toBe(true);
  });

  it.each(['', 'false', 'FALSE', 'maybe-not-a-repo'])('is off for %j', (flag) => {
    expect(zoektGroundingEnabledFor(withFlag(flag), cfg, 'example-org/canary')).toBe(false);
  });

  it('an allow-list never matches without a repository', () => {
    expect(zoektGroundingEnabledFor(withFlag('example-org/canary'), cfg)).toBe(false);
  });

  it('the kill switch and config opt-out still override an allow-list match', () => {
    const env = { ...withFlag('example-org/canary'), ZOEKT_GROUNDING_DISABLED: 'true' } as NodeJS.ProcessEnv;
    expect(zoektGroundingEnabledFor(env, cfg, 'example-org/canary')).toBe(false);
    expect(zoektGroundingEnabledFor(withFlag('example-org/canary'), { pre_checks: { zoekt: { enabled: false } } }, 'example-org/canary')).toBe(false);
  });
});

describe('mergeZoektToolConfig — the panel-owned lookup policy (REL-677)', () => {
  it('an evidence indexDir takes precedence and is re-pinned, with knobs merged', () => {
    const merged = mergeZoektToolConfig(
      { enabled: true, maxCalls: 12, indexDir: '/stale-pin' },
      { indexDir: '/fresh-grounding', zoektBinaryPath: '/opt/zoekt/zoekt' },
    );
    expect(merged.indexDir).toBe('/fresh-grounding');
    expect(merged.enabled).toBe(true);
    expect(merged.maxCalls).toBe(12);
    expect(merged.zoektBinaryPath).toBe('/opt/zoekt/zoekt');
  });

  it('without an evidence indexDir it falls back to preChecks, then evidence, then undefined', () => {
    const preChecks = { enabled: true, indexDir: '/pinned' };
    expect(mergeZoektToolConfig(preChecks, { maxCalls: 5 }).indexDir).toBe('/pinned');
    expect(mergeZoektToolConfig(undefined, { enabled: true }).enabled).toBe(true);
    expect(mergeZoektToolConfig(undefined, undefined)).toBeUndefined();
  });
});

describe('zoekt review-time grounding wiring (REL-677 / ADR 0329)', () => {
  it('injects the grounded indexDir into both pre_checks.zoekt and evidence.zoekt', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const indexScope = { complete: false, excludedDirectories: ['build'], fileLimitBytes: 2097152,
      repository: 'calltelemetry/ct-meta', headSha: HEAD };
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/fake-index', scratchDir: '/tmp/fake-scratch', indexScope }));
    const signal = new AbortController().signal;
    await runPublishingReviewWorker(
      env({ ZOEKT_INDEX_BIN: '/opt/zoekt/zoekt-index' }),
      deps(panelRunner, { zoektGrounding: zoektGrounding as never, signal }),
    );

    expect(zoektGrounding).toHaveBeenCalledTimes(1);
    const groundingArg = (zoektGrounding.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(groundingArg.repository).toBe('calltelemetry/ct-meta');
    expect(groundingArg.headSha).toBe(HEAD);
    expect(groundingArg.token).toBe('ghs_test');
    expect(groundingArg.enabled).toBe(true);
    // Grounding receives the panel's linked deadline signal, not the raw parent
    // signal; absent an admitted terminal deadline this remains a full-budget,
    // non-aborted signal and preserves the existing successful path.
    expect(groundingArg.signal).toBeInstanceOf(AbortSignal);
    expect(groundingArg.signal).not.toBe(signal);
    expect((groundingArg.signal as AbortSignal).aborted).toBe(false);
    expect(groundingArg.zoektIndexBinaryPath).toBe('/opt/zoekt/zoekt-index');

    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    // Single-surface contract: evidence.zoekt carries the grounding; the panel owns propagation.
    expect(panelArg.config.evidence.zoekt.indexDir).toBe('/tmp/fake-index');
    expect(panelArg.config.evidence.zoekt.indexScope).toEqual(indexScope);
    const session = panelArg.config.evidence.zoekt.searchSession;
    expect(session.call).toBeTypeOf('function');
    // Invalid queries still consume the shared per-run call budget, without
    // spawning a process or needing a real index. Engine config owns one handle.
    let last;
    for (let i = 0; i < 64; i++) last = await session.call('code_search_zoekt', { query: '' });
    expect(last).toMatchObject({ reason: 'call_budget_exhausted', indexScope,
      identity: { repository: 'calltelemetry/ct-meta', headSha: HEAD } });
  });

  it('leaves the panel config untouched when grounding resolves without an index', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => ({ indexDir: undefined, reason: 'materialize_fetch_failed' }));
    await runPublishingReviewWorker(env(), deps(panelRunner, { zoektGrounding: zoektGrounding as never }));

    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(panelArg.config.evidence?.zoekt?.indexDir).toBeUndefined();
  });

  it('groundedConfig is additive: non-zoekt config fields survive the injection', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/fake-index', scratchDir: '/tmp/fake-scratch' }));
    await runPublishingReviewWorker(env(), deps(panelRunner, { zoektGrounding: zoektGrounding as never }));
    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    // The spread must be additive: reviewers/personas (from resolveWorkerConfig) survive
    // alongside the injected evidence/pre_checks zoekt blocks.
    expect(panelArg.config.reviewers.overall_timeout_s).toBeGreaterThan(0);
    expect(Array.isArray(panelArg.config.personas)).toBe(true);
    expect(panelArg.config.evidence.zoekt.indexDir).toBe('/tmp/fake-index');
  });

  it('removes the scratch tree even when the panel throws (finally path)', async () => {
    const panelRunner = vi.fn(async () => { throw new Error('panel exploded'); });
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/fake-index', scratchDir: '/tmp/fake-scratch' }));
    const removeSpy = vi.spyOn(zoektGroundingModule, 'removeScratchTree').mockResolvedValue(undefined);
    try {
      await expect(runPublishingReviewWorker(env(), deps(panelRunner, { zoektGrounding: zoektGrounding as never })))
        .rejects.toThrow('panel exploded');
      expect(removeSpy).toHaveBeenCalledWith('/tmp/fake-scratch');
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('removes the grounding scratch tree in the worker finally (shared deletion contract)', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/fake-index', scratchDir: '/tmp/fake-scratch' }));
    const removeSpy = vi.spyOn(zoektGroundingModule, 'removeScratchTree').mockResolvedValue(undefined);
    try {
      await runPublishingReviewWorker(env(), deps(panelRunner, { zoektGrounding: zoektGrounding as never }));
      expect(removeSpy).toHaveBeenCalledWith('/tmp/fake-scratch');
    } finally {
      removeSpy.mockRestore();
    }
  });

  it('fails soft when the grounding dep throws — the review still completes', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => { throw new Error('zoekt-index binary missing'); });
    const d = deps(panelRunner, { zoektGrounding: zoektGrounding as never });
    await runPublishingReviewWorker(env(), d);

    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'success' }),
    );
    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(panelArg.config.evidence?.zoekt?.indexDir).toBeUndefined();
    // Fail-soft also means fail-quiet: the thrown grounding error is internal
    // diagnostics and must never leak into the published check output.
    for (const call of (d.checkClient.completeCheck.mock.calls as unknown as unknown[][])) {
      const body = JSON.stringify(call[0]);
      expect(body).not.toContain('zoekt-index binary missing');
    }
  });

  it('does not ground by default — the deployment must opt in via ZOEKT_GROUNDING_ENABLED', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/unused' }));
    await runPublishingReviewWorker(
      env({ ZOEKT_GROUNDING_ENABLED: '' }),
      deps(panelRunner, { zoektGrounding: zoektGrounding as never }),
    );
    const groundingArg = (zoektGrounding.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(groundingArg.enabled).toBe(false);
    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(panelArg.config.evidence?.zoekt?.indexDir).toBeUndefined();
  });

  it('injects ZOEKT_BIN into both config paths when grounding succeeds', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/fake-index', scratchDir: '/tmp/fake-scratch' }));
    await runPublishingReviewWorker(
      env({ ZOEKT_BIN: '/opt/zoekt/zoekt' }),
      deps(panelRunner, { zoektGrounding: zoektGrounding as never }),
    );
    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(panelArg.config.evidence.zoekt.zoektBinaryPath).toBe('/opt/zoekt/zoekt');
    // A grounded run without ZOEKT_BIN leaves the binary path unset (PATH lookup).
    const panelRunner2 = vi.fn(async () => basePanel());
    const zoektGrounding2 = vi.fn(async () => ({ indexDir: '/tmp/fake-index' }));
    await runPublishingReviewWorker(env(), deps(panelRunner2, { zoektGrounding: zoektGrounding2 as never }));
    const panelArg2 = (panelRunner2.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(panelArg2.config.evidence.zoekt.zoektBinaryPath).toBeUndefined();
  });

  it('skips grounding entirely under the ZOEKT_GROUNDING_DISABLED kill switch', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/unused' }));
    await runPublishingReviewWorker(
      env({ ZOEKT_GROUNDING_DISABLED: 'true' }),
      deps(panelRunner, { zoektGrounding: zoektGrounding as never }),
    );
    expect(zoektGrounding).toHaveBeenCalledTimes(1);
    const groundingArg = (zoektGrounding.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(groundingArg.enabled).toBe(false);
    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(panelArg.config.evidence?.zoekt?.indexDir).toBeUndefined();
  });
});
