import { describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';

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
    BIFROST_BASE_URL: 'https://gateway.example.invalid/v1',
    BIFROST_PR_REVIEW_API_KEY: 'vk-test',
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
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: panelRunner as never,
    client: {} as never,
    ...over,
  };
}

describe('zoekt review-time grounding wiring (REL-677 / ADR 0329)', () => {
  it('injects the grounded indexDir into both pre_checks.zoekt and evidence.zoekt', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/fake-index', scratchDir: '/tmp/fake-scratch' }));
    await runPublishingReviewWorker(env(), deps(panelRunner, { zoektGrounding: zoektGrounding as never }));

    expect(zoektGrounding).toHaveBeenCalledTimes(1);
    const groundingArg = (zoektGrounding.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(groundingArg.repository).toBe('calltelemetry/ct-meta');
    expect(groundingArg.headSha).toBe(HEAD);
    expect(groundingArg.token).toBe('ghs_test');
    expect(groundingArg.enabled).toBe(true);

    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(panelArg.config.pre_checks.zoekt.indexDir).toBe('/tmp/fake-index');
    expect(panelArg.config.evidence.zoekt.indexDir).toBe('/tmp/fake-index');
  });

  it('leaves the panel config untouched when grounding resolves without an index', async () => {
    const panelRunner = vi.fn(async () => basePanel());
    const zoektGrounding = vi.fn(async () => ({ indexDir: undefined, reason: 'materialize_fetch_failed' }));
    await runPublishingReviewWorker(env(), deps(panelRunner, { zoektGrounding: zoektGrounding as never }));

    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(panelArg.config.pre_checks?.zoekt?.indexDir).toBeUndefined();
    expect(panelArg.config.evidence?.zoekt?.indexDir).toBeUndefined();
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
