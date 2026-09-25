import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { logger } from '../../src/utils/logger';

/**
 * REL-1132: the publishing worker's token figures (receipt metrics, check-summary telemetry and the
 * structured completion log) come from a metered client that sees every provider call of the run:
 * every turn and attempt of every lane -- including a lane that failed closed -- plus the moderator,
 * the arbiter and the classifier. They used to be the sum of each lane's terminal turn only.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function env(): NodeJS.ProcessEnv {
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
  };
}

type Call = { role?: string; persona: string; prompt: number; completion: number; fail?: boolean };

/** The model client the engines receive. `fail` makes that call throw with no response. */
function scriptedClient(calls: Call[]) {
  let index = 0;
  return {
    complete: vi.fn(async () => {
      const call = calls[index++];
      if (call.fail) throw new Error('fetch failed');
      return {
        model: 'ollama/glm-5.3-flash', content: '{}',
        usage: { prompt: call.prompt, completion: call.completion, total: call.prompt + call.completion },
        costUSD: 0.001, raw: {},
      };
    }),
  };
}

/** A panel runner that drives every scripted call through the client it is handed, then returns
 * `result` (or throws `throwAfter`). */
function runner(calls: Call[], result: Record<string, unknown> | { throwAfter: Error }) {
  return vi.fn(async (input: { client: { complete: (request: unknown) => Promise<unknown> } }) => {
    for (const call of calls) {
      try {
        await input.client.complete({
          model: 'ollama/glm-5.3-flash', messages: [], timeoutMs: 1, persona: call.persona,
          ...(call.role ? { metadata: { role: call.role } } : {}),
        });
      } catch {
        // A lane attempt that failed; the engine would retry or fail the lane closed.
      }
    }
    if ('throwAfter' in result) throw result.throwAfter;
    return result;
  });
}

function deps(calls: Call[], result: Record<string, unknown> | { throwAfter: Error }) {
  return {
    checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) },
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })),
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: runner(calls, result),
    client: scriptedClient(calls),
  };
}

function summaryOf(d: ReturnType<typeof deps>): string {
  return String((d.checkClient.completeCheck.mock.calls[0] as unknown as Array<Record<string, unknown>>)[0].summary);
}

// arch-lane: 3 turns (120 + 175 + 230 = 525) where the terminal turn is 230.
// sec-lane: failed closed after one answered turn (1000) and one transport failure (no usage).
const CALLS: Call[] = [
  { role: undefined, persona: 'classifier', prompt: 9, completion: 1 },
  { role: 'persona', persona: 'arch-lane', prompt: 100, completion: 20 },
  { role: 'persona', persona: 'arch-lane', prompt: 150, completion: 25 },
  { role: 'persona', persona: 'arch-lane', prompt: 200, completion: 30 },
  { role: 'persona', persona: 'sec-lane', prompt: 900, completion: 100 },
  { role: 'persona', persona: 'sec-lane', prompt: 0, completion: 0, fail: true },
  { role: 'moderator', persona: 'moderator', prompt: 40, completion: 10 },
  { role: 'arbiter', persona: 'arbiter', prompt: 30, completion: 5 },
];

const RESULT = {
  applicablePersonaIds: ['arch-lane'],
  personas: [{
    id: 'arch-lane', decision: 'APPROVE', findings: [], turnsCount: 3, toolCalls: [],
    promptTokens: 200, completionTokens: 30, totalTokens: 230, durationMs: 100,
  }],
  optionalFailures: [],
  quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
  arbiter: { verdict: 'SHIP' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('publishing worker token accounting (REL-1132)', () => {
  it('reports every provider call on the receipt, split by role and lane', async () => {
    const d = deps(CALLS, RESULT);
    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.conclusion).toBe('success');
    // 10 + 525 + 1000 + 50 + 35. The terminal-turn figure for the lanes was 230.
    expect(receipt.metrics).toMatchObject({ totalTokens: 1620, totalPromptTokens: 1429, totalCompletionTokens: 191 });
    const accounting = receipt.metrics!.tokenAccounting!;
    expect(accounting.total.calls).toBe(7);
    expect(accounting.byRole.lanes.totalTokens).toBe(1525);
    expect(accounting.byRole.moderator.totalTokens).toBe(50);
    expect(accounting.byRole.arbiter.totalTokens).toBe(35);
    expect(accounting.byRole.other.totalTokens).toBe(10);
    expect(accounting.byLane['arch-lane']).toMatchObject({ calls: 3, totalTokens: 525 });
    // A lane that never completed is still billed for the calls it made.
    expect(accounting.byLane['sec-lane']).toMatchObject({ calls: 1, totalTokens: 1000 });
    expect(accounting.byOther.classifier).toMatchObject({ calls: 1, totalTokens: 10 });
    // The per-lane terminal-turn fields are unchanged and still documented as such.
    expect(receipt.personas?.[0]).toMatchObject({ id: 'arch-lane', totalTokens: 230 });
  });

  it('publishes the all-calls figure and its breakdown in the check-summary telemetry', async () => {
    const d = deps(CALLS, RESULT);
    await runPublishingReviewWorker(env(), d as never);
    const summary = summaryOf(d);

    expect(summary).toContain('Telemetry: 3 turns, 0 tool calls, 1525 tokens across 1 lanes (100ms).');
    expect(summary).not.toContain(' 230 tokens');
    expect(summary).toContain('Tokens (every provider call): 1620 total over 7 calls (prompt 1429, completion 191, cached 0; $0.0070).');
    expect(summary).toContain('By role: lanes 1525, moderator 50, arbiter 35, other 10.');
    expect(summary).toContain('Per lane: `arch-lane` 525 (3 calls), `sec-lane` 1000 (1 calls).');
  });

  it('emits one structured token-accounting log line per run', async () => {
    const info = vi.spyOn(logger, 'info');
    const d = deps(CALLS, RESULT);
    await runPublishingReviewWorker(env(), d as never);

    const lines = info.mock.calls.filter(([message]) => message === 'Review token accounting');
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({
      runId: `run_${'c'.repeat(32)}`,
      repository: 'calltelemetry/ct-meta',
      prNumber: 2795,
      headSha: HEAD,
      tokenBasis: 'every_provider_call',
      tokensTotal: 1620,
      providerCalls: 7,
      tokensByRole: { lanes: { total: 1525 }, moderator: { total: 50 }, arbiter: { total: 35 }, other: { total: 10 } },
      tokensByLane: { 'arch-lane': { calls: 3, total: 525 }, 'sec-lane': { calls: 1, total: 1000 } },
    });
  });

  it('still logs and publishes what a panel spent when the panel throws', async () => {
    const info = vi.spyOn(logger, 'info');
    const calls = CALLS.slice(0, 5);
    const d = deps(calls, { throwAfter: new Error('required persona failure: arbiter failed closed') });

    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow('required persona failure');

    const lines = info.mock.calls.filter(([message]) => message === 'Review token accounting');
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({ tokensTotal: 1535, providerCalls: 5 });
    expect(summaryOf(d)).toContain('Tokens (every provider call): 1535 total over 5 calls');
  });

  it('logs nothing when no provider call was made', async () => {
    const info = vi.spyOn(logger, 'info');
    const d = deps([], RESULT);
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.metrics?.totalTokens).toBe(0);
    expect(info.mock.calls.some(([message]) => message === 'Review token accounting')).toBe(false);
    expect(summaryOf(d)).not.toContain('Tokens (every provider call)');
  });
});
