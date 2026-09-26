import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import {
  EMPTY_MODERATION_SKIP_REASON,
  EMPTY_MODERATION_SKIPPED_MODEL,
  SKIP_EMPTY_MODERATION_FLAG,
} from '../../src/review/emptyModeration';

/**
 * REL-1139 (ct-meta ADR 0687): the publishing worker asks the panel to skip the moderator only
 * when `REVIEW_YETI_SKIP_EMPTY_MODERATION` covers the repository. A skipped run's check summary
 * says so, and its completion carries the `moderation` claim the trusted side re-decides.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
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
    ...extra,
  };
}

function lane(findings: unknown[] = []) {
  return {
    id: 'arch-lane', decision: findings.length ? 'FINDINGS' : 'APPROVE', findings, turnsCount: 1, toolCalls: [],
    promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 100,
  };
}

function result(options: { findings?: unknown[]; skipped?: boolean } = {}) {
  return {
    applicablePersonaIds: ['arch-lane'],
    personas: [lane(options.findings)],
    optionalFailures: [],
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: {
      providerId: 'bifrost', model: options.skipped ? EMPTY_MODERATION_SKIPPED_MODEL : 'm', decision: 'RECONCILED', findings: [], usage: null, costUSD: 0, durationMs: 0,
    },
    arbiter: { providerId: 'bifrost', model: 'm', verdict: 'SHIP', rationale: 'clean', usage: null, costUSD: 0, durationMs: 0 },
    ...(options.skipped ? { moderation: 'skipped-empty' } : {}),
  };
}

function deps(panelResult: Record<string, unknown>, diff = DIFF) {
  return {
    checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async (_options: Record<string, unknown>) => {}) },
    completion: {
      reportTerminalFailure: vi.fn(async (_event: unknown) => {}),
      reportTerminalSuccess: vi.fn(async (_event: unknown) => {}),
      reportReviewEvidence: vi.fn(async (_event: unknown) => {}),
    },
    sourceLoader: vi.fn(async () => ({ diff, githubReads: 1 })),
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async (_input: Record<string, unknown>) => panelResult),
    client: { complete: vi.fn(async () => { throw new Error('no provider call expected'); }) },
  };
}

const panelInput = (d: ReturnType<typeof deps>) => d.panelRunner.mock.calls[0]?.[0] as Record<string, unknown>;
const summaryOf = (d: ReturnType<typeof deps>) => String(d.checkClient.completeCheck.mock.calls[0]?.[0]?.summary ?? '');
const evidenceOf = (d: ReturnType<typeof deps>) => d.completion.reportReviewEvidence.mock.calls[0]?.[0] as Record<string, any>;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('publishing worker empty-moderation skip (REL-1139)', () => {
  it('does not ask the panel to skip when the flag is unset or off', async () => {
    for (const extra of [{}, { [SKIP_EMPTY_MODERATION_FLAG]: '' }, { [SKIP_EMPTY_MODERATION_FLAG]: 'off' }] as Array<Record<string, string>>) {
      const d = deps(result());
      await runPublishingReviewWorker(env(extra), d as never);
      expect(panelInput(d)).not.toHaveProperty('skipEmptyModeration');
      expect(panelInput(d)).not.toHaveProperty('unreadableDiffHeaders');
    }
  });

  it('forwards the unreadable-header count so the panel keeps the moderator on that run', async () => {
    const d = deps(result(), `${DIFF}diff --git garbage\n@@ -1 +1 @@\n-x\n+y\n`);
    await runPublishingReviewWorker(env({ [SKIP_EMPTY_MODERATION_FLAG]: 'all' }), d as never);
    expect(panelInput(d)).toMatchObject({ skipEmptyModeration: true, unreadableDiffHeaders: 1 });
  });

  it('does not ask the panel to skip when the list names other repositories', async () => {
    const d = deps(result());
    await runPublishingReviewWorker(env({ [SKIP_EMPTY_MODERATION_FLAG]: 'calltelemetry/ct-meta-other,acme/app' }), d as never);
    expect(panelInput(d)).not.toHaveProperty('skipEmptyModeration');
  });

  it.each(['calltelemetry/ct-meta', 'acme/app CallTelemetry/CT-META', 'all', 'on'])('asks the panel to skip when the flag is %s', async (value) => {
    const d = deps(result());
    await runPublishingReviewWorker(env({ [SKIP_EMPTY_MODERATION_FLAG]: value }), d as never);
    expect(panelInput(d)).toMatchObject({ skipEmptyModeration: true });
  });

  it('a skipped run publishes SHIP, says so in the check summary, and claims the skip in its evidence', async () => {
    const d = deps(result({ skipped: true }));
    const receipt = await runPublishingReviewWorker(env({ [SKIP_EMPTY_MODERATION_FLAG]: 'all' }), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(summaryOf(d)).toContain('Verdict `SHIP`');
    expect(summaryOf(d)).toContain(EMPTY_MODERATION_SKIP_REASON);
    expect(evidenceOf(d)?.result).toMatchObject({ moderation: 'skipped-empty' });
  });

  it('a run whose moderator was called neither mentions nor claims a skip', async () => {
    const d = deps(result());
    await runPublishingReviewWorker(env({ [SKIP_EMPTY_MODERATION_FLAG]: 'all' }), d as never);
    expect(summaryOf(d)).not.toContain('Moderator skipped');
    expect(evidenceOf(d)?.result).not.toHaveProperty('moderation');
  });
});
