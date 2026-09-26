import { afterEach, describe, expect, it, vi } from 'vitest';
import { FINISH_FLUSH_MS, JEV_TRIAGE_LOG, startJevTriageShadow, type StartJevTriageShadowInput } from '../../src/review/jevTriageShadow';
import type { JevAsker } from '../../src/gateway/jevClient';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { jevCostUsd, JEV_INPUT_TOKEN_USD_PER_MILLION } from '../../src/types/jevContract';
import { getMetrics } from '../../src/telemetry';
import { logger } from '../../src/utils/logger';
import type { ChangedFile } from '../../src/review/changedFiles';

/**
 * REL-1138 (calibration 2026-09-25 §6 #13): for the same window the Jev decision lines said
 * $0.247, the summary lines $0.196 and the `review_yeti_jev_cost_usd_total` metric $0.082, and
 * the metric counted 13 timeouts that had no decision line at all. Causes pinned here:
 *
 * - A call still in flight at the shadow's hard deadline (or an abort) was dropped: the client
 *   counted it (`outcome=timeout`, and its cost if it answered), the logs never saw it.
 * - The summary line was written only by `join`, which runs only on the worker's success path;
 *   an early throw or recoverable-failure return left decision lines with no summary.
 *
 * These tests drive the real `JevClient` (fetch stubbed) so the metric, the decision lines and
 * the summary line are all observed from one run, and require them to agree.
 */

const TYPESAFE_ENV = {
  TYPESAFE_BASE_URL: 'https://api.typesafe.example/v1/systemone',
  TYPESAFE_MODEL: 'jev-latest',
  TYPESAFE_API_KEY: 'ts-test-key',
  TYPESAFE_MODEL_PIN: 'jev-1.13.0',
};

function changed(path: string): ChangedFile {
  return { path, patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n` };
}

/** Tokens Jev bills per path; `hang` never answers but honors the abort signal like real fetch. */
function jevFetch(plan: Record<string, number | 'hang'>) {
  return vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const path = body.state.file.path as string;
    const tokens = plan[path];
    if (tokens === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(body.questions as Record<string, { type: string; criteria: string[] }>)) {
      answers[key] = question.type === 'choice'
        ? { type: 'choice', choice: 'source', confidence: 0.6, probabilities: { source: 0.6 } }
        : question.type === 'score'
          ? { type: 'score', score: 0.4, legend: Object.fromEntries(question.criteria.map((c, i) => [String(i), c])), confidence: 0.5, probabilities: { '0': 0.2, '1': 0.5, '2': 0.3 } }
          : { type: 'noul', noul: 0.3 };
    }
    return Promise.resolve(new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: tokens, output_tokens: 3 } }), { status: 200 }));
  });
}

function logsOf(spy: { mock: { calls: unknown[][] } }, event: string): Array<Record<string, any>> {
  return spy.mock.calls
    .map((call) => call[1] as Record<string, any> | undefined)
    .filter((meta): meta is Record<string, any> => Boolean(meta) && meta!.event === event);
}

function spies() {
  const info = vi.spyOn(logger, 'info');
  const metrics = getMetrics();
  const cost = vi.spyOn(metrics.jevCostUsd, 'add');
  const requests = vi.spyOn(metrics.jevRequests, 'add');
  return { info, cost, requests };
}

/** The three figures the calibration compared, plus the call counts behind them. */
function figures(s: ReturnType<typeof spies>) {
  const decisions = logsOf(s.info, JEV_TRIAGE_LOG.decision).filter((line) => line.outcome !== 'file_cap');
  const summaries = logsOf(s.info, JEV_TRIAGE_LOG.summary);
  return {
    decisionCost: decisions.reduce((sum, line) => sum + (line.cost_usd || 0), 0),
    summaryCost: summaries.reduce((sum, line) => sum + (line.cost_usd || 0), 0),
    metricCost: s.cost.mock.calls.reduce((sum, call) => sum + Number(call[0]), 0),
    decisionLines: decisions.length,
    metricRequests: s.requests.mock.calls.length,
    summaries,
    decisions,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('REL-1138: one Jev cost computation', () => {
  it('prices input tokens with the shared constant, and never returns NaN', () => {
    expect(jevCostUsd(1_000_000)).toBeCloseTo(JEV_INPUT_TOKEN_USD_PER_MILLION, 12);
    expect(jevCostUsd(700)).toBeCloseTo((700 * JEV_INPUT_TOKEN_USD_PER_MILLION) / 1_000_000, 15);
    expect(jevCostUsd(Number.NaN)).toBe(0);
    expect(jevCostUsd(-5)).toBe(0);
  });
});

describe('REL-1138: decision lines, the summary line and the cost metric agree', () => {
  it('a joined run with a hard-deadline timeout: one decision line per call, including the timeout', async () => {
    const s = spies();
    vi.stubGlobal('fetch', jevFetch({ 'src/a.ts': 700, 'src/b.ts': 900, 'src/slow.ts': 'hang' }));
    const input: StartJevTriageShadowInput = {
      env: { REVIEW_YETI_JEV_SHADOW: 'true', ...TYPESAFE_ENV },
      repository: 'review-yeti-ai/review-yeti-bot',
      runId: 'run_1138',
      prNumber: 1,
      headSha: 'a'.repeat(40),
      changedFiles: [changed('src/a.ts'), changed('src/slow.ts'), changed('src/b.ts')],
      personas: [{ id: 'sec-lane', charter: 'builtin:security' }],
      limits: { hardTimeoutMs: 150 },
    };
    const handle = startJevTriageShadow(input);
    await handle.join({ findings: [], personas: [], applicablePersonaIds: [], mode: 'panel', verdict: 'SHIP', conclusion: 'success' });

    const f = figures(s);
    // The timeout has its own decision line (it had none before REL-1138).
    expect(f.decisions.map((d) => [d.path, d.outcome, d.reason ?? null])).toEqual(expect.arrayContaining([
      ['src/a.ts', 'ok', null],
      ['src/b.ts', 'ok', null],
      ['src/slow.ts', 'unavailable', 'timeout'],
    ]));
    expect(f.decisionLines).toBe(3);
    // Every client request the metric counted has exactly one decision line.
    expect(f.decisionLines).toBe(f.metricRequests);
    // The three cost figures are one number.
    const expected = jevCostUsd(700) + jevCostUsd(900);
    expect(f.decisionCost).toBeCloseTo(expected, 15);
    expect(f.summaryCost).toBeCloseTo(expected, 15);
    expect(f.metricCost).toBeCloseTo(expected, 15);
    expect(f.summaries).toHaveLength(1);
    expect(f.summaries[0]).toMatchObject({ joined: true, asked: 3, ok: 2, outcomes: { ok: 2, unavailable: 1 }, input_tokens: 1600 });
  });

  it('a worker run that throws before the join still writes the in-flight decision line and a summary', async () => {
    const s = spies();
    vi.stubGlobal('fetch', jevFetch({ 'docs/guide.md': 400, 'src/auth/token.ts': 'hang' }));
    const diff = [
      'diff --git a/src/auth/token.ts b/src/auth/token.ts\n--- a/src/auth/token.ts\n+++ b/src/auth/token.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n',
      'diff --git a/docs/guide.md b/docs/guide.md\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-a\n+b\n',
    ].join('');
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      REVIEW_PUBLICATION_MODE: 'app-gate',
      REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: { personas: 'security,performance' } }),
      REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
      REVIEW_REPO: 'review-yeti-ai/review-yeti-bot',
      REVIEW_REPOSITORY_ID: '1339040553',
      REVIEW_POLICY_DIGEST: 'c'.repeat(64),
      REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
      REVIEW_EXECUTION_ATTEMPT: '1',
      REVIEW_PR_NUMBER: '2795',
      REVIEW_HEAD_SHA: 'a'.repeat(40),
      REVIEW_BASE_SHA: 'b'.repeat(40),
      REVIEW_MODEL: 'ollama/glm-5.3-flash',
      OPENAI_BASE_URL: 'https://gateway.example.invalid/v1',
      OPENAI_API_KEY: 'vk-test',
      GH_TOKEN: 'ghs_test',
      REVIEW_YETI_JEV_SHADOW: 'true',
      ...TYPESAFE_ENV,
    };
    const deps = {
      checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) },
      sourceLoader: vi.fn(async () => ({ diff, githubReads: 1 })),
      visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
      // Let the fast Jev call land before the panel fails.
      panelRunner: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error('panel exploded');
      }),
      completion: {
        reportTerminalFailure: vi.fn(async () => {}),
        reportTerminalSuccess: vi.fn(async () => {}),
        reportReviewEvidence: vi.fn(async () => {}),
      },
      repoFileProviderFactory: vi.fn(() => ({})),
      client: {},
      jevTriageShadow: { limits: { hardTimeoutMs: 60_000 } },
    };
    await expect(runPublishingReviewWorker(env, deps as never)).rejects.toThrow('panel exploded');

    const f = figures(s);
    expect(f.decisions.map((d) => [d.path, d.outcome, d.reason ?? null])).toEqual(expect.arrayContaining([
      ['docs/guide.md', 'ok', null],
      ['src/auth/token.ts', 'unavailable', 'timeout'],
    ]));
    expect(f.decisionLines).toBe(2);
    expect(f.decisionLines).toBe(f.metricRequests);
    // Before REL-1138 there was no summary line at all on this path.
    expect(f.summaries).toHaveLength(1);
    expect(f.summaries[0]).toMatchObject({ joined: false, status: 'aborted', asked: 2, ok: 1 });
    expect(f.decisionCost).toBeCloseTo(jevCostUsd(400), 15);
    expect(f.summaryCost).toBeCloseTo(f.decisionCost, 15);
    expect(f.metricCost).toBeCloseTo(f.decisionCost, 15);
  });

  const shadowInput = (asker?: JevAsker): StartJevTriageShadowInput => ({
    env: { REVIEW_YETI_JEV_SHADOW: 'true', ...TYPESAFE_ENV },
    repository: 'review-yeti-ai/review-yeti-bot',
    runId: 'run_1138b',
    prNumber: 1,
    headSha: 'a'.repeat(40),
    changedFiles: [changed('src/a.ts')],
    personas: [{ id: 'sec-lane', charter: 'builtin:security' }],
    limits: { hardTimeoutMs: 60_000 },
    ...(asker ? { asker } : {}),
  });
  const JOIN_INPUT = { findings: [], personas: [], applicablePersonaIds: [], mode: 'panel', verdict: 'SHIP', conclusion: 'success' };

  it('finish() is bounded by FINISH_FLUSH_MS when an asker ignores the abort signal, and still logs the call', async () => {
    const s = spies();
    const hanging: JevAsker = { ask: vi.fn(() => new Promise<never>(() => undefined)) as never };
    const handle = startJevTriageShadow(shadowInput(hanging));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await handle.finish();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(FINISH_FLUSH_MS - 50);
    expect(elapsed).toBeLessThan(FINISH_FLUSH_MS + 1_000);
    const decisions = logsOf(s.info, JEV_TRIAGE_LOG.decision);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ path: 'src/a.ts', outcome: 'unavailable', reason: 'aborted', late: true });
    const summaries = logsOf(s.info, JEV_TRIAGE_LOG.summary);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ joined: false, status: 'aborted', asked: 1, ok: 0 });
  });

  it('join() then finish() (the worker success path) writes exactly one summary; finish() then join() too', async () => {
    const s = spies();
    vi.stubGlobal('fetch', jevFetch({ 'src/a.ts': 300 }));
    const first = startJevTriageShadow(shadowInput());
    await first.join(JOIN_INPUT);
    await first.finish();
    expect(logsOf(s.info, JEV_TRIAGE_LOG.summary)).toHaveLength(1);
    expect(logsOf(s.info, JEV_TRIAGE_LOG.summary)[0]).toMatchObject({ joined: true, cost_usd: jevCostUsd(300) });

    s.info.mockClear();
    const second = startJevTriageShadow(shadowInput());
    await second.finish();
    await second.join(JOIN_INPUT);
    expect(logsOf(s.info, JEV_TRIAGE_LOG.summary)).toHaveLength(1);
    expect(logsOf(s.info, JEV_TRIAGE_LOG.join)).toHaveLength(0);
  });
});
