import { describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';

// ct-meta#2884: the DOKS app-gate lane has no GitHub client to look visibility up
// with -- its identity is entirely env-driven -- so the dispatching workflow is the
// only source of the fact here. These tests prove REVIEW_REPOSITORY_VISIBILITY
// reaches both the panel runner (so the persona prompt carries it) and the
// published check-run summary (so a human reading the check can see what the
// reviewer was told), and that an absent/invalid value degrades to UNKNOWN rather
// than blocking the run or being silently treated as public or private.

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'calltelemetry/ct-meta',
    REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_PR_NUMBER: '2884',
    REVIEW_HEAD_SHA: HEAD,
    REVIEW_BASE_SHA: BASE,
    REVIEW_MODEL: 'ollama/glm-5.3-flash',
    BIFROST_BASE_URL: 'https://gateway.example.invalid/v1',
    BIFROST_PR_REVIEW_API_KEY: 'vk-test',
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

function deps(over: Record<string, unknown> = {}) {
  return {
    checkClient: checkClient(),
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })) as never,
    panelRunner: vi.fn(async () => ({
      personas: [{ findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    })) as never,
    client: {} as never,
    ...over,
  };
}

describe('publishingReview.ts — repository visibility threading', () => {
  it('passes repositoryVisibility=PRIVATE through to the panel runner', async () => {
    const panelRunner = vi.fn(async () => ({
      personas: [{ findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    await runPublishingReviewWorker(
      env({ REVIEW_REPOSITORY_VISIBILITY: 'private' }),
      deps({ panelRunner: panelRunner as never }) as never,
    );
    expect(panelRunner).toHaveBeenCalledTimes(1);
    const arg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.repositoryVisibility).toBe('PRIVATE');
  });

  it('publishes "Repository visibility: PRIVATE." in the check-run summary', async () => {
    const client = checkClient();
    await runPublishingReviewWorker(env({ REVIEW_REPOSITORY_VISIBILITY: 'private' }), deps({ checkClient: client }) as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(String(arg.summary)).toContain('Repository visibility: PRIVATE.');
  });

  it('degrades to UNKNOWN, and still ships, when the visibility env var is absent', async () => {
    const client = checkClient();
    const panelRunner = vi.fn(async () => ({
      personas: [{ findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    const receipt = await runPublishingReviewWorker(
      env(), // no REVIEW_REPOSITORY_VISIBILITY
      deps({ checkClient: client, panelRunner: panelRunner as never }) as never,
    );
    expect(receipt.verdict).toBe('SHIP');
    expect(receipt.conclusion).toBe('success');
    const panelArg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(panelArg.repositoryVisibility).toBe('UNKNOWN');
    const checkArg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(String(checkArg.summary)).toContain('Repository visibility: UNKNOWN.');
  });

  it('degrades to UNKNOWN on an unrecognised visibility value rather than guessing', async () => {
    const panelRunner = vi.fn(async () => ({
      personas: [{ findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    await runPublishingReviewWorker(
      env({ REVIEW_REPOSITORY_VISIBILITY: 'not-a-real-value' }),
      deps({ panelRunner: panelRunner as never }) as never,
    );
    const arg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.repositoryVisibility).toBe('UNKNOWN');
  });
});
