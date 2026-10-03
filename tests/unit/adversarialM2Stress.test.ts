import { describe, expect, it, vi } from 'vitest';
import {
  runPublishingReviewWorker,
  publishingConclusion,
} from '../../src/cli/publishingReview';
import {
  CHECK_CONTEXT_GATE,
  CHECK_CONTEXT_RAW_REVIEW,
  CHECK_CONTEXT_CI,
  GitHubInstallationClient,
} from '../../src/github/installationClient';
import { CommunityPersonaLoader } from '../../src/personas/communityPersonaLoader';
import { Context7Adapter } from '../../src/mcp/context7Adapter';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { SQLiteMemoryAdapter } from '../../src/memory/adapters/sqliteAdapter';

// This suite keeps the default process policy intact: P2 can leave the raw
// arbiter at SHIP while the publisher's independent strict conclusion fails.

const HEAD = '1'.repeat(40);
const BASE = '2'.repeat(40);

function testEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_RUN_ID: `run_${'3'.repeat(32)}`,
    REVIEW_REPO: 'exampleorg/example-meta',
    REVIEW_REPOSITORY_ID: '1339040553',
    REVIEW_PR_NUMBER: '2795',
    REVIEW_HEAD_SHA: HEAD,
    REVIEW_BASE_SHA: BASE,
    REVIEW_MODEL: 'ollama/glm-5.3-flash',
    OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
    OPENAI_API_KEY: 'vk-test',
    GH_TOKEN: 'ghs_validtoken12345',
    ...overrides,
  };
}

const VALID_DIFF = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+// safe comment
 export const foo = 1;
`;

const DIFF_WITH_UNREADABLE = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+// safe comment
 export const foo = 1;
diff --git a/path with unquoted space/a.ts b/path with unquoted space/b.ts
`;

function mockDeps(overrides: Record<string, unknown> = {}) {
  const publishGateCheck = vi.fn(async () => 9999);
  const createCheck = vi.fn(async () => 1111);
  const completeCheck = vi.fn(async () => {});

  return {
    publishGateCheck,
    createCheck,
    completeCheck,
    deps: {
      checkClient: {
        createCheck,
        completeCheck,
        publishGateCheck,
      },
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      currentPullRequestVerifier: vi.fn(async () => undefined),
      sourceLoader: vi.fn(async () => ({ diff: VALID_DIFF, githubReads: 1 })),
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['arch'],
        personas: [{ id: 'arch', findings: [] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })),
      client: {} as any,
      ...overrides,
    },
  };
}

describe('Adversarial Stress Test: App Gate Fail-Closed Behavior', () => {
  it('Scenario 1: Clean SHIP review completes the single check with conclusion: success', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps();
    const result = await runPublishingReviewWorker(testEnv(), deps as any);

    expect(result.conclusion).toBe('success');
    expect(result.verdict).toBe('SHIP');
    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'success',
        title: 'Review Yeti: SHIP',
      }),
    );
  });

  it('Scenario 2: Review panel throws unhandled exception -> single check fails closed', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps({
      panelRunner: vi.fn(async () => {
        throw new Error('Adversarial Panic: Internal LLM Crash');
      }),
    });

    await expect(runPublishingReviewWorker(testEnv(), deps as any)).rejects.toThrow(
      'Adversarial Panic: Internal LLM Crash',
    );

    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'failure',
        title: 'Review Yeti: review did not complete',
      }),
    );
  });

  it('Scenario 3: Source loader network failure -> single check fails closed', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps({
      currentPullRequestVerifier: vi.fn(async () => undefined),
      sourceLoader: vi.fn(async () => {
        throw new Error('GitHub API 503 Service Unavailable fetching diff');
      }),
    });

    await expect(runPublishingReviewWorker(testEnv(), deps as any)).rejects.toThrow(
      'GitHub API 503 Service Unavailable fetching diff',
    );

    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'failure',
        title: 'Review Yeti: review did not complete',
      }),
    );
  });

  it('Scenario 4: Empty diff produces no reviewable files -> single check fails closed', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps({
      currentPullRequestVerifier: vi.fn(async () => undefined),
      sourceLoader: vi.fn(async () => ({ diff: '', githubReads: 1 })),
    });

    await expect(runPublishingReviewWorker(testEnv(), deps as any)).rejects.toThrow(
      'admitted head produced no reviewable diff',
    );

    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'failure',
        title: 'Review Yeti: review did not complete',
      }),
    );
  });

  it('Scenario 5: Blocking findings (P0) fail the single check', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec'],
        personas: [
          {
            id: 'sec',
            decision: 'BLOCK',
            findings: [
              {
                severity: 'P0',
                path: 'src/index.ts',
                line: 1,
                title: 'Critical SQL injection flaw',
                body: 'Unsanitized input reaches database query.',
              },
            ],
          },
        ],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'BLOCK' },
      })),
    });

    const result = await runPublishingReviewWorker(testEnv(), deps as any);

    expect(result.conclusion).toBe('failure');
    expect(result.blockingFindingCount).toBe(1);
    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'failure',
        title: 'Review Yeti: BLOCK',
      }),
    );
  });

  it('Scenario 6: Blocking findings (P1) present with model claiming SHIP -> single check fails closed', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['perf'],
        personas: [
          {
            id: 'perf',
            decision: 'SHIP',
            findings: [
              {
                severity: 'P1',
                path: 'src/index.ts',
                line: 1,
                title: 'High memory leak in loop',
                body: 'Leaking memory inside tight loop.',
              },
            ],
          },
        ],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })),
    });

    const result = await runPublishingReviewWorker(testEnv(), deps as any);

    expect(result.conclusion).toBe('failure');
    expect(result.blockingFindingCount).toBe(1);
    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'failure',
        title: 'Review Yeti: FIX_FIRST',
      }),
    );
  });

  it('Scenario 7: Only P2 (advisory) findings present -> conclusion remains success', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['style'],
        personas: [
          {
            id: 'style',
            decision: 'SHIP',
            findings: [
              {
                severity: 'P2',
                path: 'src/index.ts',
                line: 1,
                title: 'Minor style nitpick',
                body: 'Consider renaming variable.',
              },
            ],
          },
        ],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })),
    });

    const result = await runPublishingReviewWorker(testEnv(), deps as any);

    expect(result.verdict).toBe('SHIP');
    expect(result.conclusion).toBe('success');
    expect(result.blockingFindingCount).toBe(0);
    expect(result.findingCount).toBe(1);
    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'success',
        title: 'Review Yeti: SHIP',
      }),
    );
  });

  // The check conclusion, annotation level and summary count must all agree: only P0/P1 block.
  describe('P2 is advisory; only P0/P1 block (REL-1282)', () => {
    const finding = (severity: 'P0' | 'P1' | 'P2', line: number) => ({
      severity, path: 'src/index.ts', line, title: `${severity} finding ${line}`, body: `Body ${line}.`,
    });
    const THREE_LINE_DIFF = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,1 +1,4 @@
+// one
+// two
+// three
 export const foo = 1;
`;
    const run = async (findings: ReturnType<typeof finding>[], verdict: 'SHIP' | 'FIX_FIRST' = 'SHIP') => {
      const { deps, completeCheck } = mockDeps({
        sourceLoader: vi.fn(async () => ({ diff: THREE_LINE_DIFF, githubReads: 1 })),
        panelRunner: vi.fn(async () => ({
          applicablePersonaIds: ['style'],
          personas: [{ id: 'style', decision: verdict, findings }],
          quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
          arbiter: { verdict },
        })),
      });
      const result = await runPublishingReviewWorker(testEnv(), deps as any);
      const completed = (completeCheck.mock.calls as unknown as Array<[Record<string, any>]>).at(-1)![0];
      return { result, completed };
    };

    it('a P2-only SHIP review concludes success and reports zero blocking findings', async () => {
      const { result, completed } = await run([finding('P2', 1)]);
      expect(result.conclusion).toBe('success');
      expect(result.blockingFindingCount).toBe(0);
      expect(completed.conclusion).toBe('success');
      expect(completed.summary ?? completed.output?.summary).toContain('blocking P0/P1: 0');
    });

    it('a P1 review concludes failure and reports exactly one blocking finding', async () => {
      const { result, completed } = await run([finding('P1', 1)], 'FIX_FIRST');
      expect(result.conclusion).toBe('failure');
      expect(result.blockingFindingCount).toBe(1);
      expect(completed.conclusion).toBe('failure');
      expect(completed.summary ?? completed.output?.summary).toContain('blocking P0/P1: 1');
    });

    it('a mixed review counts only the real P0/P1 findings as blocking', async () => {
      const { result, completed } = await run([finding('P1', 1), finding('P2', 2), finding('P2', 3)], 'FIX_FIRST');
      expect(result.conclusion).toBe('failure');
      // Nearby findings may cluster, but at least one advisory P2 must remain beside the one blocker.
      expect(result.findingCount).toBeGreaterThan(1);
      expect(result.blockingFindingCount).toBe(1);
      expect(completed.summary ?? completed.output?.summary).toContain('blocking P0/P1: 1');
    });

    it('the opt-in advisory-required environment switch no longer changes the conclusion', async () => {
      const previous = process.env.REVIEW_YETI_REQUIRE_ADVISORY;
      process.env.REVIEW_YETI_REQUIRE_ADVISORY = 'true';
      try {
        const { result } = await run([finding('P2', 1)]);
        expect(result.conclusion).toBe('success');
        expect(result.blockingFindingCount).toBe(0);
      } finally {
        if (previous === undefined) delete process.env.REVIEW_YETI_REQUIRE_ADVISORY;
        else process.env.REVIEW_YETI_REQUIRE_ADVISORY = previous;
      }
    });
  });

  it('Scenario 8: Quorum unsatisfied forces BLOCK verdict and fails closed', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['block-lane'],
        personas: [{ id: 'block-lane', findings: [] }],
        quorum: { required: 2, distinctProviders: ['bifrost'], satisfied: false },
        arbiter: { verdict: 'BLOCK' },
      })),
    });

    const result = await runPublishingReviewWorker(testEnv(), deps as any);

    expect(result.conclusion).toBe('failure');
    expect(result.verdict).toBe('BLOCK');
    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'failure',
        title: 'Review Yeti: BLOCK',
      }),
    );
  });

  it('Scenario 9: Unreadable diff headers fail closed with failure conclusion', async () => {
    const { deps, publishGateCheck, completeCheck } = mockDeps({
      currentPullRequestVerifier: vi.fn(async () => undefined),
      sourceLoader: vi.fn(async () => ({ diff: DIFF_WITH_UNREADABLE, githubReads: 1 })),
    });

    const result = await runPublishingReviewWorker(testEnv(), deps as any);

    expect(result.conclusion).toBe('failure');
    expect(publishGateCheck).not.toHaveBeenCalled();
    expect(completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: 'failure',
        title: 'Review Yeti: BLOCK',
      }),
    );
  });

  it('Scenario 10: an unused legacy gate publisher cannot replace the original error', async () => {
    const { deps, publishGateCheck } = mockDeps({
      panelRunner: vi.fn(async () => {
        throw new Error('Initial Panel Error');
      }),
    });
    publishGateCheck.mockImplementation(async () => {
      throw new Error('GitHub Check API Outage');
    });

    await expect(runPublishingReviewWorker(testEnv(), deps as any)).rejects.toThrow(
      'Initial Panel Error',
    );
    expect(publishGateCheck).not.toHaveBeenCalled();
  });
});

describe('Adversarial Stress Test: Check Context and Contract Constraints', () => {
  it('strictly defines CHECK_CONTEXT_GATE as Review Yeti Gate', () => {
    expect(CHECK_CONTEXT_GATE).toBe('Review Yeti Gate');
    expect(CHECK_CONTEXT_RAW_REVIEW).toBe('Review Yeti');
    expect(CHECK_CONTEXT_CI).toBe('Review Yeti CI');
  });

  it('publishGateCheck sends POST with name: Review Yeti Gate and status: completed', async () => {
    let capturedBody: any = null;
    let capturedPath: string = '';

    const mockFetch = vi.fn(async (url: string, init: any) => {
      capturedPath = url;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 777123 }),
        json: async () => ({ id: 777123 }),
      };
    });

    const client = new GitHubInstallationClient({
      token: 'ghs_fake1234567890',
      fetchImplementation: mockFetch as any,
    });

    const checkId = await client.publishGateCheck('exampleorg', 'example-meta', HEAD, {
      conclusion: 'success',
      title: 'Review Yeti Gate: Approved (SHIP)',
      summary: '### Review Yeti Gate: Eligible',
    });

    expect(checkId).toBe(777123);
    expect(capturedPath).toContain('/repos/exampleorg/example-meta/check-runs');
    expect(capturedBody.name).toBe('Review Yeti Gate');
    expect(capturedBody.head_sha).toBe(HEAD);
    expect(capturedBody.status).toBe('completed');
    expect(capturedBody.conclusion).toBe('success');
    expect(capturedBody.output.title).toBe('Review Yeti Gate: Approved (SHIP)');
  });
});

describe('Adversarial Stress Test: Sandboxing & Directory Redirection', () => {
  it('CommunityPersonaLoader resolves cacheDir strictly within CT_REVIEW_DATA_DIR', () => {
    const prevEnv = process.env.CT_REVIEW_DATA_DIR;
    try {
      process.env.CT_REVIEW_DATA_DIR = '/tmp/.ct-memory';
      const loader = new CommunityPersonaLoader({} as any);
      expect((loader as any).cacheDir).toBe('/tmp/.ct-memory/cache/personas');
    } finally {
      process.env.CT_REVIEW_DATA_DIR = prevEnv;
    }
  });

  it('Context7Adapter resolves cacheDir strictly within CT_REVIEW_DATA_DIR', () => {
    const prevEnv = process.env.CT_REVIEW_DATA_DIR;
    try {
      process.env.CT_REVIEW_DATA_DIR = '/tmp/.ct-memory';
      const adapter = new Context7Adapter();
      expect((adapter as any).cacheDir).toBe('/tmp/.ct-memory/cache/context7');
    } finally {
      process.env.CT_REVIEW_DATA_DIR = prevEnv;
    }
  });

  it('PRMemoryStore resolves team memory DB path within CT_REVIEW_DATA_DIR in production/runtime mode', () => {
    const prevEnv = process.env.CT_REVIEW_DATA_DIR;
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.CT_REVIEW_DATA_DIR = '/tmp/.ct-memory';
      (process.env as any).NODE_ENV = 'production';
      const store = new PRMemoryStore();
      expect((store as any).dbPath).toBe('/tmp/.ct-memory/team_memory.db');
    } finally {
      process.env.CT_REVIEW_DATA_DIR = prevEnv;
      (process.env as any).NODE_ENV = prevNodeEnv;
    }
  });

  it('SQLiteMemoryAdapter resolves team memory DB path within CT_REVIEW_DATA_DIR in production/runtime mode', () => {
    const prevEnv = process.env.CT_REVIEW_DATA_DIR;
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.CT_REVIEW_DATA_DIR = '/tmp/.ct-memory';
      (process.env as any).NODE_ENV = 'production';
      const adapter = new SQLiteMemoryAdapter();
      expect((adapter as any).dbPath).toBe('/tmp/.ct-memory/team_memory.db');
    } finally {
      process.env.CT_REVIEW_DATA_DIR = prevEnv;
      (process.env as any).NODE_ENV = prevNodeEnv;
    }
  });
});
