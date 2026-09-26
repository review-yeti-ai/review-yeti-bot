import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';
import { JEV_TRIAGE_LOG, laneQuestionKey } from '../../src/review/jevTriageShadow';
import type { JevAskRequest, JevAsker, JevOutcome } from '../../src/gateway/jevClient';
import { createFailingJevStub } from '../support/jevStub';
import { logger } from '../../src/utils/logger';

/**
 * REL-1081 (plan W4, section 3): Jev triage in shadow mode must change NOTHING about the review.
 *
 * The core test runs the same worker twice -- REVIEW_YETI_JEV_SHADOW off, then on with a fully
 * configured TYPESAFE_* and a Jev double that answers every question as persuasively as it can
 * ("generated", risk 1, no persona should look) -- and requires every observable output to be
 * byte-identical: the panel request, the published check, every completion callback, and the
 * receipt. The only permitted difference is the shadow log lines.
 *
 * Negative proof (ADR 0641), run by hand while writing this file and recorded in the PR: planting
 * `changedFiles.reverse()` in `startJevTriageShadow`, or passing the triage's risk into the panel
 * options, turns the byte-identity tests red; removing the hard-deadline race from
 * `startJevTriageShadow` makes the hanging-Jev test time out; removing `jevShadow.finish()` from
 * the worker's `finally` makes the abort-on-throw test fail.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FIXED_NOW = 1_790_000_000_000;

const POLICY_JSON = JSON.stringify({
  review_yeti: { personas: 'security,performance', budget: { max_investigation_turns: 10 } },
});

const TYPESAFE_ENV = {
  TYPESAFE_BASE_URL: 'https://api.typesafe.example/v1/systemone',
  TYPESAFE_MODEL: 'jev-latest',
  TYPESAFE_API_KEY: 'ts-test-key',
  TYPESAFE_MODEL_PIN: 'jev-1.13.0',
};

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    REVIEW_PUBLICATION_MODE: 'app-gate',
    REVIEW_YETI_POLICY_JSON: POLICY_JSON,
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`,
    REVIEW_REPO: 'review-yeti-ai/review-yeti-bot',
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

const SHADOW_ON = { REVIEW_YETI_JEV_SHADOW: 'true', ...TYPESAFE_ENV };

const DIFF = [
  'diff --git a/src/auth/token.ts b/src/auth/token.ts\n--- a/src/auth/token.ts\n+++ b/src/auth/token.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n',
  'diff --git a/docs/guide.md b/docs/guide.md\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-a\n+b\n',
].join('');

function finding(overrides: Record<string, unknown> = {}) {
  return { severity: 'P2', path: 'src/auth/token.ts', line: 1, title: 'finding', body: 'a finding', ...overrides };
}

function panelResult(kind: 'clean' | 'advisory' | 'blocking') {
  const secFindings = kind === 'clean' ? [] : kind === 'advisory'
    ? [finding()]
    : [finding({ severity: 'P1', title: 'p1 a', line: 1 }), finding({ severity: 'P1', title: 'p1 b', line: 2, body: 'another' }),
      finding({ severity: 'P0', title: 'p0', line: 1, body: 'critical' })];
  return {
    headSha: HEAD,
    applicablePersonaIds: ['sec-lane', 'perf-lane'],
    personas: [
      { id: 'sec-lane', required: true, providerId: 'bifrost', model: 'test-model',
        decision: secFindings.length ? 'FINDINGS' : 'APPROVE', findings: secFindings, usage: null, costUSD: null, durationMs: 5 },
      { id: 'perf-lane', required: false, providerId: 'bifrost', model: 'test-model',
        decision: 'APPROVE', findings: [], usage: null, costUSD: null, durationMs: 5 },
    ],
    optionalFailures: [],
    zeroLaneNonEvidence: false,
    panelWallClockMs: 10,
    quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: 'none', decision: 'RECONCILED', findings: [], usage: null, costUSD: null, durationMs: 0 },
    arbiter: { providerId: 'bifrost', model: 'none', verdict: 'SHIP', rationale: 'x', usage: null, costUSD: null, durationMs: 0 },
  };
}

/** A Jev double that tries as hard as it can to talk the review out of looking at anything. */
function persuasiveAsker() {
  const ask = vi.fn(async (request: JevAskRequest<string>): Promise<JevOutcome<string>> => {
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      if (question.type === 'choice') answers[key] = { type: 'choice', choice: 'generated', confidence: 0.99, probabilities: { generated: 0.99 } };
      else if (question.type === 'score') {
        answers[key] = {
          type: 'score', score: 0.01, confidence: 0.99,
          legend: Object.fromEntries(question.criteria.map((c, i) => [String(i), c])),
          probabilities: { '0': 0.99 },
        };
      } else answers[key] = { type: 'noul', noul: 0.01 };
    }
    return { status: 'ok', answers: answers as never, model: 'jev-1.13.0', usage: { input_tokens: 500, output_tokens: 5 }, durationMs: 3 };
  });
  return { asker: { ask: ask as unknown as JevAsker['ask'] }, ask };
}

function harness(kind: 'clean' | 'advisory' | 'blocking', extra: Record<string, unknown> = {}) {
  return {
    checkClient: { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => {}) },
    sourceLoader: vi.fn(async () => ({ diff: DIFF, githubReads: 1 })),
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async () => panelResult(kind)),
    completion: {
      reportTerminalFailure: vi.fn(async (_event: unknown) => {}),
      reportTerminalSuccess: vi.fn(async (_event: unknown) => {}),
      reportReviewEvidence: vi.fn(async (_event: unknown) => {}),
    },
    repoFileProviderFactory: vi.fn(() => ({ marker: 'repo-files' })),
    client: { marker: 'model-client' },
    now: () => FIXED_NOW,
    ...extra,
  };
}

/** Everything the review produced that anyone outside the worker can observe. */
function observable(h: ReturnType<typeof harness>, receipt: unknown): string {
  const replacer = (_key: string, v: unknown) => {
    if (v instanceof AbortSignal) return { abortSignal: true, aborted: v.aborted };
    if (typeof v === 'function') return '[function]';
    return v;
  };
  return JSON.stringify({
    panelRequests: h.panelRunner.mock.calls,
    createCheck: h.checkClient.createCheck.mock.calls,
    completeCheck: h.checkClient.completeCheck.mock.calls,
    terminalFailure: h.completion.reportTerminalFailure.mock.calls,
    terminalSuccess: h.completion.reportTerminalSuccess.mock.calls,
    evidence: h.completion.reportReviewEvidence.mock.calls,
    receipt,
  }, replacer);
}

async function run(envOverrides: Record<string, string>, kind: 'clean' | 'advisory' | 'blocking', extra: Record<string, unknown> = {}) {
  const h = harness(kind, extra);
  const receipt = await runPublishingReviewWorker(env(envOverrides), h as never);
  return { h, receipt, observed: observable(h, receipt) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('REL-1081: Jev triage shadow never changes the review', () => {
  it.each(['clean', 'advisory', 'blocking'] as const)(
    'shadow on vs off: byte-identical panel request, check, callbacks, and receipt (%s panel)', async (kind) => {
      const off = await run({}, kind);
      const persuasive = persuasiveAsker();
      const on = await run(SHADOW_ON, kind, { jevTriageShadow: { asker: persuasive.asker } });

      // Not vacuous: the triage really ran, once per changed file, with every persona asked.
      expect(persuasive.ask).toHaveBeenCalledTimes(2);
      const questions = (persuasive.ask.mock.calls[0][0] as JevAskRequest<string>).questions;
      expect(Object.keys(questions)).toEqual(expect.arrayContaining([laneQuestionKey('sec-lane'), laneQuestionKey('perf-lane')]));

      expect(on.observed).toBe(off.observed);
      expect(on.h.panelRunner).toHaveBeenCalledTimes(1);
      const request = (on.h.panelRunner.mock.calls as unknown[][])[0][0] as { changedFiles: Array<{ path: string }> };
      expect(request.changedFiles.map((f) => f.path)).toEqual(['src/auth/token.ts', 'docs/guide.md']);
    },
  );

  it('the blocking case still blocks with shadow on (Jev said risk 1 and "no" for every lane)', async () => {
    const persuasive = persuasiveAsker();
    const on = await run(SHADOW_ON, 'blocking', { jevTriageShadow: { asker: persuasive.asker } });
    expect(on.receipt.conclusion).toBe('failure');
    expect(on.receipt.blockingFindingCount).toBeGreaterThan(0);
  });

  it.each([
    ['unconfigured TYPESAFE_*', { REVIEW_YETI_JEV_SHADOW: 'true' }, undefined],
    ['partial TYPESAFE_* (jevTransport throws)', { REVIEW_YETI_JEV_SHADOW: 'true', TYPESAFE_BASE_URL: 'https://x.example' }, undefined],
    ['Jev unavailable (http_529)', SHADOW_ON, createFailingJevStub('http_529')],
    ['Jev timeout', SHADOW_ON, createFailingJevStub('timeout')],
    ['Jev malformed', SHADOW_ON, createFailingJevStub('malformed')],
    ['ask() throws', SHADOW_ON, { ask: async () => { throw new Error('boom'); } } as JevAsker],
  ])('fails open: %s leaves the review byte-identical', async (_label, envOverrides, asker) => {
    const off = await run({}, 'advisory');
    const on = await run(envOverrides as Record<string, string>, 'advisory', asker ? { jevTriageShadow: { asker } } : {});
    expect(on.observed).toBe(off.observed);
  });

  it('a hanging Jev (ignores abort, never settles) cannot hold the worker past the hard deadline', async () => {
    const hanging: JevAsker = { ask: vi.fn(() => new Promise<never>(() => undefined)) as never };
    const started = Date.now();
    const off = await run({}, 'advisory');
    const on = await run(SHADOW_ON, 'advisory', { jevTriageShadow: { asker: hanging, limits: { hardTimeoutMs: 50 } } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(hanging.ask).toHaveBeenCalled();
    expect(on.observed).toBe(off.observed);
  });

  it('publishes the check before waiting on a slow Jev (the join is the last await)', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: JevAsker = {
      ask: vi.fn(async (request: JevAskRequest<string>) => {
        await gate;
        order.push('jev');
        return persuasiveAsker().asker.ask(request);
      }) as never,
    };
    const h = harness('advisory', {
      jevTriageShadow: { asker: slow },
      checkClient: {
        createCheck: vi.fn(async () => 4242),
        completeCheck: vi.fn(async () => { order.push('check'); }),
      },
    });
    h.completion.reportTerminalSuccess.mockImplementation(async () => { order.push('terminal-success'); release(); });
    const receipt = await runPublishingReviewWorker(env(SHADOW_ON), h as never);
    expect(receipt.conclusion).toBe('success');
    expect(order.slice(0, 2)).toEqual(['check', 'terminal-success']);
    expect(order).toContain('jev');
  });

  it('aborts in-flight Jev calls when the review throws, and the failure is reported unchanged', async () => {
    let seen: AbortSignal | undefined;
    const hanging: JevAsker = {
      ask: vi.fn((request: JevAskRequest<string>) => { seen = request.signal; return new Promise<never>(() => undefined); }) as never,
    };
    const panelBoom = vi.fn(async () => { throw new Error('panel exploded'); });
    const offH = harness('advisory', { panelRunner: panelBoom });
    const offError = await runPublishingReviewWorker(env(), offH as never).catch((error: Error) => error.message);
    const onH = harness('advisory', { panelRunner: vi.fn(async () => { throw new Error('panel exploded'); }), jevTriageShadow: { asker: hanging, limits: { hardTimeoutMs: 60_000 } } });
    const onError = await runPublishingReviewWorker(env(SHADOW_ON), onH as never).catch((error: Error) => error.message);
    expect(onError).toBe(offError);
    expect(seen?.aborted).toBe(true);
    expect(JSON.stringify(onH.completion.reportTerminalFailure.mock.calls)).toBe(JSON.stringify(offH.completion.reportTerminalFailure.mock.calls));
    expect(JSON.stringify(onH.checkClient.completeCheck.mock.calls)).toBe(JSON.stringify(offH.checkClient.completeCheck.mock.calls));
  });

  it('logs one join line per file with the panel\'s actual findings on it', async () => {
    const info = vi.spyOn(logger, 'info');
    await run(SHADOW_ON, 'advisory', { jevTriageShadow: { asker: persuasiveAsker().asker } });
    const joins = info.mock.calls
      .map((call) => call[1] as Record<string, any> | undefined)
      .filter((meta): meta is Record<string, any> => meta?.event === JEV_TRIAGE_LOG.join);
    expect(joins.map((j) => j.path)).toEqual(['src/auth/token.ts', 'docs/guide.md']);
    expect(joins[0]).toMatchObject({
      repository: 'review-yeti-ai/review-yeti-bot', prNumber: 2795, headSha: HEAD,
      category: 'generated', risk_level: 1, security_sensitive: true,
      findings_total: 1, findings_p2: 1, finding_class: 'advisory', panel_mode: 'panel', verdict: 'SHIP',
      lanes: { 'sec-lane': { said_yes: false, ran: true, findings: 1 }, 'perf-lane': { said_yes: false, findings: 0 } },
    });
    expect(joins[1]).toMatchObject({ findings_total: 0, finding_class: 'none' });
  });

  it('REL-1135: a failed optional lane reaches the join as `failed`, never as an empty approval', async () => {
    const info = vi.spyOn(logger, 'info');
    const failing = () => {
      const result = panelResult('clean');
      result.personas = result.personas.filter((lane) => lane.id !== 'perf-lane');
      (result.optionalFailures as unknown[]) = [{ id: 'perf-lane', error: 'gateway 502' }];
      return result;
    };
    await run(SHADOW_ON, 'clean', { jevTriageShadow: { asker: persuasiveAsker().asker }, panelRunner: vi.fn(async () => failing()) });
    const joins = info.mock.calls
      .map((call) => call[1] as Record<string, any> | undefined)
      .filter((meta): meta is Record<string, any> => meta?.event === JEV_TRIAGE_LOG.join);
    expect(joins.length).toBeGreaterThan(0);
    for (const join of joins) {
      expect(join.lanes['perf-lane']).toMatchObject({ outcome: 'failed', completed: false, findings: 0 });
      expect(join.lanes['sec-lane']).toMatchObject({ outcome: 'completed-approve', completed: true });
    }
    expect(joins[0]).toMatchObject({ path: 'src/auth/token.ts', sensitive_any: true, path_class: 'sensitive' });
  });

  it('REL-1135: a lane reported only in unreportedLanes reaches the join as `failed`', async () => {
    const info = vi.spyOn(logger, 'info');
    const unreported = () => {
      const result = panelResult('clean') as ReturnType<typeof panelResult> & { unreportedLanes?: unknown[] };
      result.personas = result.personas.filter((lane) => lane.id !== 'perf-lane');
      result.unreportedLanes = [{ id: 'perf-lane', error: 'no verdict', failureClass: 'contract' }];
      return result;
    };
    try {
      await run(SHADOW_ON, 'clean', { jevTriageShadow: { asker: persuasiveAsker().asker }, panelRunner: vi.fn(async () => unreported()) });
    } catch {
      // An unreported lane may fail the run; the join line is what this test pins.
    }
    const joins = info.mock.calls
      .map((call) => call[1] as Record<string, any> | undefined)
      .filter((meta): meta is Record<string, any> => meta?.event === JEV_TRIAGE_LOG.join);
    expect(joins.length).toBeGreaterThan(0);
    for (const join of joins) {
      expect(join.lanes['perf-lane']).toMatchObject({ outcome: 'failed', completed: false });
    }
  });

  it('flag off: the Jev asker is never called even when TYPESAFE_* is fully configured', async () => {
    const persuasive = persuasiveAsker();
    await run(TYPESAFE_ENV, 'advisory', { jevTriageShadow: { asker: persuasive.asker } });
    expect(persuasive.ask).not.toHaveBeenCalled();
  });
});
