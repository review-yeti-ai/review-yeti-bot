import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MAX_PERSONAS, MAX_TEXT_CHARACTERS } from '../../src/review/workerReviewCompletion';
import {
  classifyFailure,
  createOpenAIPublishingConfig,
  isGithubDiffNotRenderableError,
  isPublishingReviewWorker,
  openaiTransport,
  parseChangedFiles,
  publishingConclusion,
  publishingReviewIdentity,
  projectPublishingRosterBounds,
  resolveWorkerConfig,
  runPublishingReviewWorker,
} from '../../src/cli/publishingReview';
import { HttpWorkerCompletionAdapter } from '../../src/review/workerCompletion';
import { GitHubQualificationReadError } from '../../src/github/qualificationReader';
import {
  OpenRouterConnectionError,
  OpenRouterResponseError,
  OpenRouterTimeoutError,
} from '../../src/gateway/openRouterClient';
import { UpstreamCapacityRejectionError } from '../../src/gateway/providerCapacityManager';
import { logger } from '../../src/utils/logger';
import { initTelemetry, getRecentSpans, clearSpans, getPrometheusMetrics } from '../../src/telemetry';

const arbitrationObserver = vi.hoisted(() => ({ laneIds: [] as string[][] }));

vi.mock('../../src/review/reviewCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/reviewCore')>();
  return {
    ...actual,
    computeArbitration: (...args: Parameters<typeof actual.computeArbitration>) => {
      arbitrationObserver.laneIds.push(args[0].map((lane) => String(lane.id || '')));
      return actual.computeArbitration(...args);
    },
  };
});

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // This repo's ProcessEnv is augmented with a required NODE_ENV.
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
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const),
    panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    })) as never,
    client: {} as never,
    ...over,
  };
}

describe('qualification source arguments', () => {
  it('passes the full owner/repo, and no owner field, to the source loader', async () => {
    // The loader's input has no `owner` key and parses the slash out of `repo`
    // itself. Passing the bare repo name made every real app-gate run die with
    // "GitHub qualification repository is invalid" while this suite stayed green,
    // because the mock accepted any arguments. Assert the arguments, not just the
    // call.
    const loader = vi.fn(async () => ({ diff: DIFF, githubReads: 1 }));
    await runPublishingReviewWorker(env(), deps({ sourceLoader: loader as never }));

    expect(loader).toHaveBeenCalledTimes(1);
    const arg = (loader.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.repo).toBe('calltelemetry/ct-meta');
    expect(arg).not.toHaveProperty('owner');
    expect(arg.prNumber).toBe(2795);
  });

  it('runs production Bifrost reviews with the strict native JSON contract', async () => {
    const panelRunner = vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    const d = deps({ panelRunner: panelRunner as never });
    await runPublishingReviewWorker(env(), d);

    expect(panelRunner).toHaveBeenCalledTimes(1);
    const arg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, any>;
    expect(arg.requestPolicy).toEqual({ responseFormat: { type: 'json_object' } });
  });
});

describe('check run ownership', () => {
  it('reuses REVIEW_CHECK_ID from environment and does not call createCheck', async () => {
    const d = deps();
    await runPublishingReviewWorker(env({ REVIEW_CHECK_ID: '998877' }), d);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: 998877 }),
    );
  });

  it('calls createCheck when REVIEW_CHECK_ID is absent', async () => {
    const d = deps();
    await runPublishingReviewWorker(env(), d);
    expect(d.checkClient.createCheck).toHaveBeenCalledWith('calltelemetry', 'ct-meta', HEAD,
      `${env().REVIEW_RUN_ID}:a1`);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ checkId: 4242 }),
    );
  });
});

describe('callback rollout compatibility', () => {
  it.each(['0', '-1', '1.5', 'not-a-number', 'NaN', 'Infinity', '9007199254740992'])(
    'rejects explicit invalid execution attempt %s even with callbacks disabled', (attempt) => {
      // Every other identity field is valid; this must reach the attempt guard.
      expect(publishingReviewIdentity(env()).executionAttempt).toBe(1);
      for (const callbackEnabled of [false, true]) {
        expect(() => publishingReviewIdentity(env({ REVIEW_EXECUTION_ATTEMPT: attempt }), { callbackEnabled }))
          .toThrow(/contract is invalid/u);
      }
    },
  );

  it.each([1, 2, Number.MAX_SAFE_INTEGER])('accepts explicit safe execution attempt %s', (attempt) => {
    expect(publishingReviewIdentity(env({ REVIEW_EXECUTION_ATTEMPT: String(attempt) }), { callbackEnabled: true })
      .executionAttempt).toBe(attempt);
  });

  it.each([undefined, '', '   '])('requires an execution attempt for an injected adapter without a URL: %s', async (attempt) => {
    const workerEnv = env();
    workerEnv.REVIEW_EXECUTION_ATTEMPT = attempt;
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion });
    await expect(runPublishingReviewWorker(workerEnv, d)).rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
    expect(d.checkClient.completeCheck).not.toHaveBeenCalled();
    expect(d.sourceLoader).not.toHaveBeenCalled();
    expect(d.panelRunner).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('uses execution attempt 1 for a legacy worker with callback disabled', () => {
    expect(publishingReviewIdentity(env({ REVIEW_EXECUTION_ATTEMPT: '' })).executionAttempt).toBe(1);
  });

  it('requires an injected execution attempt when callback reporting is enabled', () => {
    expect(() => publishingReviewIdentity(env({
      REVIEW_EXECUTION_ATTEMPT: '',
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
    }))).toThrow(/contract is invalid/u);
  });

  it('fails closed for an explicit malformed callback URL', async () => {
    const d = deps();
    await expect(runPublishingReviewWorker(env({ REVIEW_COMPLETION_URL: 'http://dispatch.example.invalid/completion' }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
  });

  it.each([
    'not-a-url',
    'http://dispatch.example.invalid/completion',
    'https://user:password@dispatch.example.invalid/completion',
    'https://dispatch.example.invalid/completion#redirect',
  ])('validates an explicit callback URL before side effects with an injected adapter: %s', async (endpoint) => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion });
    await expect(runPublishingReviewWorker(env({ REVIEW_COMPLETION_URL: endpoint }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('does not silently ignore a valid callback URL without an adapter', async () => {
    const d = deps();
    await expect(runPublishingReviewWorker(env({
      REVIEW_COMPLETION_URL: 'https://dispatch.example.invalid/api/dispatch/completion',
    }), d as never)).rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
  });
});

describe('publishing review lane admission', () => {
  it('admits only an app-gate dispatch', () => {
    expect(isPublishingReviewWorker(env())).toBe(true);
    expect(isPublishingReviewWorker(env({ REVIEW_PUBLICATION_MODE: 'disabled' }))).toBe(false);
  });

  it.each([
    'REVIEW_RECEIPT_ONLY',
    'REVIEW_FULL_PANEL_QUALIFICATION_ONLY',
    'REVIEW_SAME_HEAD_QUALIFICATION_ONLY',
    'REVIEW_PANEL_QUALIFICATION_ONLY',
    'REVIEW_PROVIDER_QUALIFICATION_ONLY',
  ])('never admits a run that is also %s', (flag) => {
    // Each lane is excluded explicitly, so a future lane cannot fall into
    // publishing merely by not being named here.
    expect(isPublishingReviewWorker(env({ [flag]: 'true' }))).toBe(false);
  });
});

describe('OpenAI gateway is the admitted transport', () => {
  it('accepts the gateway', () => {
    expect(openaiTransport(env()).baseUrl).toBe('https://gateway.example.invalid/v1');
  });

  it('accepts standard OPENAI_BASE_URL and OPENAI_API_KEY', () => {
    const res = openaiTransport(env({
      OPENAI_BASE_URL: 'https://standard-gateway.example.invalid/v1',
      OPENAI_API_KEY: 'sk-standard-key',
    }));
    expect(res.baseUrl).toBe('https://standard-gateway.example.invalid/v1');
    expect(res.apiKey).toBe('sk-standard-key');
  });

  it.each(['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'REVIEW_MODEL'])(
    'refuses to run when %s is absent rather than defaulting',
    (name) => {
      // Defaulting here would silently review against the wrong provider.
      expect(() => openaiTransport(env({ [name]: '' }))).toThrow(/contract is invalid/u);
    },
  );

  it('refuses a non-https gateway', () => {
    expect(() => openaiTransport(env({ OPENAI_BASE_URL: 'http://gateway.example.invalid/v1' })))
      .toThrow(/contract is invalid/u);
  });

  it('builds a single-provider panel from the operator-injected model', () => {
    const config = createOpenAIPublishingConfig('ollama/glm-5.3-flash');

    expect(config.reviewers.fallback).toBe('none');
    expect(config.default_max_turns).toBe(15);
    expect(config.reviewers.overall_timeout_s).toBe(1800);
    expect(config.reviewers.providers).toEqual([expect.objectContaining({
      id: 'bifrost',
      enabled: true,
      model: 'ollama/glm-5.3-flash',
      review_timeout_s: 180,
      arbiter_timeout_s: 180,
    })]);
    expect(config.reviewers.arbiter.order).toEqual(['bifrost']);
    expect(config.personas.every((persona) => persona.providers.every((provider) => provider === 'bifrost'))).toBe(true);
  });
});

describe('fail-closed conclusion mapping', () => {
  it('passes only a clean SHIP', () => {
    expect(publishingConclusion('SHIP', 0)).toBe('success');
  });

  it.each([['BLOCK', 0], ['FIX_FIRST', 0], ['', 0], ['UNKNOWN_VERDICT', 0], ['SHIP', 1]] as const)(
    'fails verdict=%s blocking=%s',
    (verdict, blocking) => {
      expect(publishingConclusion(verdict, blocking)).toBe('failure');
    },
  );

  it('fails a SHIP that still carries a blocking finding', () => {
    // A verdict and its findings can disagree; the findings win.
    expect(publishingConclusion('SHIP', 2)).toBe('failure');
  });
});

describe('fail-closed conclusion coverage guard', () => {
  const coverage = {
    mode: 'panel',
    rosterValid: true,
    quorumSatisfied: true,
    fullPanelComplete: true,
  };

  it('keeps a SHIP whose own panel coverage it can verify', () => {
    expect(publishingConclusion('SHIP', 0, coverage)).toBe('success');
  });

  it.each<[string, Record<string, unknown>]>([
    ['invalid roster', { rosterValid: false }],
    ['incomplete panel', { fullPanelComplete: false }],
    ['denied quorum', { quorumSatisfied: false }],
  ])('fails a panel SHIP with %s', (_label, partial) => {
    // A SHIP verdict next to coverage that denies the panel completed is the
    // production shape that published an approvable check over a review that
    // never ran to completion. The run's own coverage line wins.
    expect(publishingConclusion('SHIP', 0, { ...coverage, ...partial })).toBe('failure');
  });

  it('fails a fast-ship SHIP without quorum but keeps an approved one', () => {
    expect(publishingConclusion('SHIP', 0, { ...coverage, mode: 'fast_ship', quorumSatisfied: false })).toBe('failure');
    expect(publishingConclusion('SHIP', 0, { ...coverage, mode: 'fast_ship' })).toBe('success');
    expect(publishingConclusion('SHIP', 0, { ...coverage, mode: 'documentation_only', quorumSatisfied: false }))
      .toBe('failure');
  });

  it('does not gate modes without a panel-style quorum contract', () => {
    // `not_applicable` concludes neutral before the conclusion runs and a
    // `zero_lane` SHIP cannot be constructed by arbitration; the guard must
    // not restate those invariants under its own mode list.
    expect(publishingConclusion('SHIP', 0, { ...coverage, mode: 'zero_lane', fullPanelComplete: false }))
      .toBe('success');
  });
});

describe('runPublishingReviewWorker', () => {
  it('publishes success for a clean panel', async () => {
    const d = deps();
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(receipt.transport).toBe('bifrost');
    expect(receipt.coverage).toEqual({
      mode: 'panel', expectedLaneCount: 1, completedLaneCount: 1, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: true, fullPanelComplete: true,
    });
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'success', checkId: 4242 }),
    );
  });

  it('carries per-lane turn/tool/correction counts and the panel wall clock onto the receipt (Stage 0 telemetry)', async () => {
    // A lane's `turnUsages`/`aggregateUsage`/`toolTurns`/`correctionTurns` and the panel's own
    // `panelWallClockMs` are new, additive `PanelResult` fields -- see `src/panel/panelEngine.ts`.
    // This proves they reach the published receipt rather than being silently dropped by the
    // `personaMetrics` mapping or the receipt's `metrics` block.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{
          id: 'sec-lane', findings: [], turnsCount: 3, toolTurns: 1, correctionTurns: 1,
          toolCalls: [{ tool: 'grep_search' }],
          promptTokens: 200, completionTokens: 30, totalTokens: 230, durationMs: 300,
          model: 'ollama/glm-5.3-flash',
          aggregateUsage: { promptTokens: 450, completionTokens: 75, totalTokens: 525, cachedTokens: 80, costUSD: 0.0042 },
        }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
        panelWallClockMs: 180,
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.conclusion).toBe('success');
    expect(receipt.personas?.[0]).toMatchObject({
      id: 'sec-lane', turnsCount: 3, toolTurns: 1, correctionTurns: 1,
      aggregateUsage: { promptTokens: 450, completionTokens: 75, totalTokens: 525, cachedTokens: 80, costUSD: 0.0042 },
    });
    // `metrics.totalDurationMs` remains the SUM of lane durations (unchanged behaviour); the wall
    // clock is a distinct, additional field, never a replacement for it.
    expect(receipt.metrics?.totalDurationMs).toBe(300);
    expect(receipt.metrics?.panelWallClockMs).toBe(180);

    const summary = String(((d.checkClient.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);
    expect(summary).toContain('Telemetry: 3 turns, 1 tool calls, 230 tokens across 1 lanes (300ms).');
    expect(summary).toContain('Panel wall clock: 180ms');
  });

  it('publishes failure when the panel blocks', async () => {
    // The finding must carry a path inside the diff. Arbitration drops findings
    // it cannot attribute to a changed file, and the blocking count is now taken
    // from that canonical set -- so a pathless finding is not blocking, it is
    // unusable. See the sibling test below.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Blocking', body: 'Must fix' }] }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.blockingFindingCount).toBe(1);
  });

  it('fails raw publication when an applicable optional lane exhausts its budget', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [{ id: 'arch-lane', error: 'turn budget exhausted' }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.failureClass).toBe('budget_exhausted');
    expect(receipt.coverage).toEqual({
      mode: 'panel', expectedLaneCount: 2, completedLaneCount: 1, failedLaneCount: 1,
      rosterValid: true, quorumSatisfied: false, fullPanelComplete: false,
    });
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'failure', title: 'Review Yeti: review did not complete' }),
    );
    const summary = String((d.checkClient.completeCheck.mock.calls[0] as unknown as unknown[])[0] &&
      ((d.checkClient.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);
    expect(summary).toContain('mode=panel');
    expect(summary).not.toContain('turn budget exhausted');
  });

  it('persists a recoverable no-findings panel failure with the exact attempt and check identity', async () => {
    const order: string[] = [];
    const completion = {
      reportTerminalFailure: vi.fn(async () => { order.push('callback'); }),
      reportTerminalSuccess: vi.fn(async () => {}),
    };
    const cc = checkClient();
    cc.completeCheck.mockImplementation(async () => { order.push('check'); });
    const d = deps({ checkClient: cc, completion, panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane', 'arch-lane', 'test-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [
        { id: 'arch-lane', error: 'provider HTTP 502 private response do-not-publish' },
        { id: 'test-lane', error: 'provider HTTP 502 token=do-not-publish' },
      ],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
      arbiter: { verdict: 'SHIP' },
    })) });

    const receipt = await runPublishingReviewWorker(env({ REVIEW_EXECUTION_ATTEMPT: '2' }), d as never);

    expect(receipt).toMatchObject({ verdict: 'BLOCK', conclusion: 'failure', failureClass: 'provider_error' });
    expect(order).toEqual(['check', 'callback']);
    expect(cc.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      checkId: 4242, conclusion: 'failure', title: 'Review Yeti: review did not complete',
      summary: expect.stringContaining('expected lanes=3; completed lanes=1; failed lanes=2'),
    }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      version: 'WorkerTerminalFailure.v1', runId: env().REVIEW_RUN_ID,
      headSha: HEAD, baseSha: BASE, executionAttempt: 2, checkId: 4242, failureClass: 'provider_error',
      // REL-620: the dispatcher's bounded automatic retry reads this exact bit
      // off the callback -- it must be present and true for a genuinely
      // recoverable-incomplete panel, and attempt 2 (== the retry cap) is
      // still eligible, so the summary must not yet say the lane is exhausted.
      diagnostics: expect.objectContaining({ recoverableIncompletePanel: true }),
    }));
    expect(completion.reportTerminalSuccess).not.toHaveBeenCalled();
    // Pin the publish call first so the negative assertion below cannot pass
    // vacuously against an absent summary.
    expect(cc.completeCheck).toHaveBeenCalledTimes(1);
    const publishedSummary = ((cc.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary;
    expect(typeof publishedSummary).toBe('string');
    expect(publishedSummary as string).not.toContain('no further automatic retry');
    expect(JSON.stringify([receipt, cc.completeCheck.mock.calls, completion.reportTerminalFailure.mock.calls]))
      .not.toContain('do-not-publish');
  });

  it('carries transport, telemetry, and per-lane identity/usage on a recoverable panel failure (REL-892)', async () => {
    // Counterfactual for this test: revert the `panelEvidence` block added to the
    // `recoverablePanelFailure` branch of `runPublishingReviewWorker` in
    // src/cli/publishingReview.ts (the object passed as the third argument to
    // `reportTerminalFailure`) and this test fails -- the summary reverts to only a failure
    // class, reason, and coverage line, which is exactly the "nothing actionable" gap REL-892
    // exists to close.
    //
    // The completed lane's `model` and the failed lane's `lastKnownModel` are deliberately
    // DISTINCT values here (REL-892 finding 1): `resolvedTransportModel` prefers a completed
    // lane's reported model over a failed lane's last-known one, and a fixture where both lanes
    // report the same string cannot tell that preference apart from the fallback. See the
    // sibling test below for the fallback itself (no completed lane reports a model at all).
    const cc = checkClient();
    const d = deps({
      checkClient: cc,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [{
          id: 'sec-lane', findings: [], turnsCount: 2, toolCalls: [{ tool: 'grep_search' }],
          promptTokens: 10, completionTokens: 5, totalTokens: 15, durationMs: 100,
          model: 'ollama/glm-5.3-flash-2026-08-01',
        }],
        optionalFailures: [{
          id: 'arch-lane',
          error: 'provider HTTP 502 do-not-publish raw payload',
          lastKnownUsage: { promptTokens: 48_000, completionTokens: 200, totalTokens: 48_200 },
          lastKnownModel: 'ollama/glm-5.3-flash-2026-07-15',
        }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
        arbiter: { verdict: 'SHIP' },
      })),
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.conclusion).toBe('failure');
    expect(cc.completeCheck).toHaveBeenCalledTimes(1);
    const summary = String(((cc.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);

    // Item 4: the requested (possibly aliased) model and the completed lane's resolved model both
    // appear -- and it is the COMPLETED lane's model that wins, not the failed lane's, even though
    // the failed lane also carried a (different) last-known model.
    expect(summary).toContain('Transport: bifrost `ollama/glm-5.3-flash` (resolved `ollama/glm-5.3-flash-2026-08-01`).');
    expect(summary).not.toContain('resolved `ollama/glm-5.3-flash-2026-07-15`');
    // Item 1: aggregate telemetry survives onto the failure path, not just the success path.
    expect(summary).toContain('Telemetry: 2 turns, 1 tool calls, 15 tokens across 1 lanes (100ms).');
    // Item 2 + 3: the failed lane is named, classified, and carries its own last-known token usage
    // and model -- independent of, and different from, the completed lane's resolved model above.
    expect(summary).toContain('Failed lane(s):');
    expect(summary).toContain('`arch-lane`: failure class `provider_error`');
    expect(summary).toContain('usage=48000+200=48200 tokens');
    expect(summary).toContain('model=`ollama/glm-5.3-flash-2026-07-15`');
    // The redaction this change must preserve: the lane's free-form error text never appears.
    expect(summary).not.toContain('do-not-publish raw payload');
    expect(JSON.stringify(cc.completeCheck.mock.calls)).not.toContain('do-not-publish raw payload');
  });

  it('falls back to a failed lane\'s last-known model when no completed lane reported one (REL-892)', async () => {
    // Proves the second half of `resolvedTransportModel`'s contract: when every completed lane's
    // `model` is absent (e.g. a fully-failed panel where the only lane to ever reach a provider is
    // the one that failed closed), the failed lane's `lastKnownModel` must still surface on the
    // published check instead of the transport line silently omitting the resolved model.
    const cc = checkClient();
    const d = deps({
      checkClient: cc,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        // Completed, but reports no `model` of its own -- nothing for the primary source to find.
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [{
          id: 'arch-lane',
          error: 'provider HTTP 502 do-not-publish raw payload',
          lastKnownModel: 'ollama/glm-5.3-flash-2026-07-15',
        }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
        arbiter: { verdict: 'SHIP' },
      })),
    });

    await runPublishingReviewWorker(env(), d as never);

    const summary = String(((cc.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);
    expect(summary).toContain('Transport: bifrost `ollama/glm-5.3-flash` (resolved `ollama/glm-5.3-flash-2026-07-15`).');
  });

  it('omits the resolved-model clause when the resolved model equals the requested one (REL-892)', async () => {
    // Counterfactual for this test: change `renderTransportSummary`'s guard from
    // `resolvedModel && resolvedModel !== requestedModel` to just `resolvedModel` and this test
    // fails -- the summary would then read `bifrost \`ollama/glm-5.3-flash\` (resolved
    // \`ollama/glm-5.3-flash\`)`, a redundant clause implying the alias and the served model
    // differ when they do not.
    const cc = checkClient();
    const d = deps({
      checkClient: cc,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        // Reports the exact same string configured as REVIEW_MODEL -- resolved is defined but
        // identical to requested, the branch the equal-model finding calls out as untested.
        personas: [{ id: 'sec-lane', findings: [], model: 'ollama/glm-5.3-flash' }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })),
    });

    await runPublishingReviewWorker(env(), d as never);

    const summary = String(((cc.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);
    expect(summary).toContain('Transport: bifrost `ollama/glm-5.3-flash`.');
    expect(summary).not.toContain('(resolved');
  });

  it('omits the resolved-model clause when no lane ever reported a resolved model (REL-892)', async () => {
    // The other way to reach the "omit" branch: `resolvedModel` is `undefined` rather than equal
    // to the requested model -- no completed lane reported one and no failed lane carried a
    // `lastKnownModel`. Distinct from the sibling test above, which covers the equal-but-defined
    // case; together they exercise both ways `resolvedModel && resolvedModel !== requestedModel`
    // can evaluate to false.
    const cc = checkClient();
    const d = deps({
      checkClient: cc,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })),
    });

    await runPublishingReviewWorker(env(), d as never);

    const summary = String(((cc.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);
    expect(summary).toContain('Transport: bifrost `ollama/glm-5.3-flash`.');
    expect(summary).not.toContain('(resolved');
  });

  it('reports a failed lane with no observed usage as unavailable rather than a fabricated number', async () => {
    const cc = checkClient();
    const d = deps({
      checkClient: cc,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        // No lastKnownUsage/lastKnownModel: this lane never reached the provider (e.g. a local
        // transport error before any response), so there is nothing to report.
        optionalFailures: [{ id: 'arch-lane', error: 'ENOTFOUND upstream-provider.example do-not-publish' }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
        arbiter: { verdict: 'SHIP' },
      })),
    });

    await runPublishingReviewWorker(env(), d as never);

    const summary = String(((cc.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);
    expect(summary).toContain('`arch-lane`: failure class `transport`');
    expect(summary).toContain('usage=unavailable');
    expect(summary).not.toContain('do-not-publish');
  });

  it('marks the automatic retry exhausted once the final permitted attempt still cannot complete', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}), reportTerminalSuccess: vi.fn(async () => {}) };
    const cc = checkClient();
    // Attempt 3 is one past RECOVERABLE_PANEL_AUTO_RETRY_CAP (2): the dispatcher
    // will not queue attempt 4, so this exact worker execution is the final word.
    const d = deps({ checkClient: cc, completion, panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane', 'arch-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [{ id: 'arch-lane', error: 'provider HTTP 502' }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
      arbiter: { verdict: 'SHIP' },
    })) });

    await runPublishingReviewWorker(env({ REVIEW_EXECUTION_ATTEMPT: '3' }), d as never);

    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      executionAttempt: 3, diagnostics: expect.objectContaining({ recoverableIncompletePanel: true }),
    }));
    const summary = String((cc.completeCheck.mock.calls[0] as unknown as unknown[])[0]
      && ((cc.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);
    expect(summary).toContain('failed 3 time(s)');
    expect(summary).toContain('no further automatic retry will occur');
  });

  it('keeps the returned panel failed when failure publication and callback acknowledgement both fail', async () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const cc = checkClient();
    cc.completeCheck.mockRejectedValue(new Error('private check response do-not-publish'));
    const completion = {
      reportTerminalFailure: vi.fn().mockRejectedValue(new Error('private callback do-not-publish')),
      reportTerminalSuccess: vi.fn(),
    };
    const d = deps({ checkClient: cc, completion, panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane', 'arch-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [{ id: 'arch-lane', error: 'provider HTTP 502 do-not-publish' }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
      arbiter: { verdict: 'SHIP' },
    })) });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt).toMatchObject({ conclusion: 'failure', verdict: 'BLOCK', failureClass: 'provider_error' });
    expect(cc.completeCheck).toHaveBeenCalledOnce();
    expect(completion.reportTerminalFailure).toHaveBeenCalledOnce();
    expect(completion.reportTerminalSuccess).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([
      ['Failed to publish the fail-closed conclusion', {
        runId: env().REVIEW_RUN_ID, failureClass: 'provider_error', reason: 'check_publication_failed',
      }],
      ['Failed to persist worker terminal failure', {
        runId: env().REVIEW_RUN_ID, failureClass: 'provider_error', reason: 'completion_callback_failed',
      }],
    ]);
    expect(JSON.stringify([log.mock.calls, receipt, cc.completeCheck.mock.calls, completion.reportTerminalFailure.mock.calls]))
      .not.toContain('do-not-publish');
    log.mockRestore();
  });

  it('does not classify an incomplete panel as recoverable when some diff headers were unreadable', async () => {
    const completion = { reportTerminalFailure: vi.fn(), reportTerminalSuccess: vi.fn() };
    const d = deps({ completion,
      sourceLoader: vi.fn(async () => ({ diff: `${DIFF}diff --git nonsense\n@@ -1 +1 @@\n-a\n+b\n`, githubReads: 1 })),
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [{ id: 'arch-lane', error: 'provider HTTP 502' }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
        arbiter: { verdict: 'SHIP' },
      })),
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt).toMatchObject({ conclusion: 'failure', failureClass: null, verdict: 'BLOCK' });
    expect(d.checkClient.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      title: 'Review Yeti: BLOCK', summary: expect.stringContaining('diff --git nonsense'),
    }));
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
    expect(completion.reportTerminalSuccess).not.toHaveBeenCalled();
  });

  it('does not relabel an incomplete panel with a failed lane outside its admitted roster', async () => {
    const completion = { reportTerminalFailure: vi.fn(), reportTerminalSuccess: vi.fn() };
    const d = deps({ completion, panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane', 'arch-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      optionalFailures: [{ id: 'outside-lane', error: 'provider HTTP 502' }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
      arbiter: { verdict: 'SHIP' },
    })) });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt).toMatchObject({ conclusion: 'failure', failureClass: null, coverage: { rosterValid: false } });
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ title: 'Review Yeti: BLOCK' }));
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('does not relabel a failed panel whose raw findings were discarded as unanchorable', async () => {
    const completion = { reportTerminalFailure: vi.fn(), reportTerminalSuccess: vi.fn() };
    const d = deps({ completion, panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane', 'arch-lane'],
      personas: [{ id: 'sec-lane', findings: [{ severity: 'P1', path: 'not-in-diff.ts', line: 1, title: 'Finding', body: 'Review this' }] }],
      optionalFailures: [{ id: 'arch-lane', error: 'provider HTTP 502' }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
      arbiter: { verdict: 'SHIP' },
    })) });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt).toMatchObject({ conclusion: 'failure', failureClass: null, findingCount: 0 });
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ title: 'Review Yeti: BLOCK' }));
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it.each(['P1', 'P2'])('does not turn a partial panel with %s findings into a retryable infrastructure failure', async (severity) => {
    const completion = { reportTerminalFailure: vi.fn(), reportTerminalSuccess: vi.fn() };
    const d = deps({ completion, panelRunner: vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane', 'arch-lane'],
      personas: [{ id: 'sec-lane', findings: [{ severity, path: 'src/a.ts', line: 1, title: 'Finding', body: 'Review this' }] }],
      optionalFailures: [{ id: 'arch-lane', error: 'provider HTTP 502' }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
      arbiter: { verdict: 'SHIP' },
    })) });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt).toMatchObject({ conclusion: 'failure', failureClass: null, findingCount: 1 });
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Review Yeti: BLOCK', text: expect.stringContaining('Finding'),
    }));
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('fails raw publication when returned lane identities duplicate the applicable roster', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [
          { id: 'sec-lane', findings: [] },
          { id: 'sec-lane', findings: [] },
        ],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toMatchObject({ expectedLaneCount: 2, completedLaneCount: 2, failedLaneCount: 0,
      rosterValid: false, quorumSatisfied: false, fullPanelComplete: false });
  });

  it('fails closed when the configured roster exceeds MAX_PERSONAS despite bounded returned lanes', async () => {
    const applicablePersonaIds = Array.from({ length: MAX_PERSONAS + 1 }, (_, index) => `lane-${index}`);
    const panelResult = {
      applicablePersonaIds,
      personas: applicablePersonaIds.slice(0, MAX_PERSONAS).map((id) => ({ id, findings: [] })),
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    };
    const d = deps({
      panelRunner: vi.fn(async () => panelResult) as never,
    });

    const bounds = projectPublishingRosterBounds(panelResult as never);
    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(bounds).toMatchObject({
      configuredRosterValid: false,
      returnedLaneCountValid: true,
    });
    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toMatchObject({
      expectedLaneCount: null,
      completedLaneCount: MAX_PERSONAS,
      failedLaneCount: 0,
      rosterValid: false,
      quorumSatisfied: false,
      fullPanelComplete: false,
    });
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'failure', title: 'Review Yeti: BLOCK' }),
    );
  });

  it('rejects returned-lane overflow and passes only MAX_PERSONAS lanes into arbitration', async () => {
    const applicablePersonaIds = Array.from({ length: MAX_PERSONAS }, (_, index) => `lane-${index}`);
    const returnedPersonaIds = [...applicablePersonaIds, 'overflow-lane'];
    const panelResult = {
      applicablePersonaIds,
      personas: returnedPersonaIds.map((id) => ({ id, findings: [] })),
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    };
    const d = deps({ panelRunner: vi.fn(async () => panelResult) as never });

    const bounds = projectPublishingRosterBounds(panelResult as never);
    arbitrationObserver.laneIds.length = 0;
    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(bounds).toMatchObject({
      configuredRosterValid: true,
      returnedLaneCountValid: false,
      completedLaneCount: MAX_PERSONAS,
    });
    expect(arbitrationObserver.laneIds).toEqual([applicablePersonaIds]);
    expect(bounds.lanes).toHaveLength(MAX_PERSONAS);
    expect(bounds.lanes.map((lane) => lane.id)).toEqual(applicablePersonaIds);
    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toMatchObject({
      expectedLaneCount: MAX_PERSONAS,
      completedLaneCount: MAX_PERSONAS,
      failedLaneCount: 0,
      rosterValid: false,
      quorumSatisfied: false,
      fullPanelComplete: false,
    });
  });

  it('fails closed when the panel omits the applicable roster', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toMatchObject({ expectedLaneCount: null, completedLaneCount: 1, failedLaneCount: 0,
      rosterValid: false, quorumSatisfied: false, fullPanelComplete: false });
  });

  it('fails closed when panel quorum evidence is absent', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [],
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toMatchObject({ expectedLaneCount: 1, completedLaneCount: 1, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: false, fullPanelComplete: false });
  });

  it('fails closed when an applicable lane is missing without an optional failure record', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toMatchObject({ expectedLaneCount: 2, completedLaneCount: 1, failedLaneCount: 0,
      rosterValid: false, quorumSatisfied: false, fullPanelComplete: false });
  });

  it('fails closed when a returned lane is outside the applicable roster', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [
          { id: 'sec-lane', findings: [] },
          { id: 'foreign-lane', findings: [] },
        ],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toMatchObject({ expectedLaneCount: 2, completedLaneCount: 2, failedLaneCount: 0,
      rosterValid: false, quorumSatisfied: false, fullPanelComplete: false });
  });

  it('keeps a zero-lane panel as non-evidence with a zero-lane projection', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: [],
        personas: [],
        optionalFailures: [],
        zeroLaneNonEvidence: true,
        quorum: { required: 0, distinctProviders: [], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toEqual({
      mode: 'zero_lane', expectedLaneCount: 0, completedLaneCount: 0, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: false, fullPanelComplete: false,
    });
  });

  it('publishes a skipped not-applicable check when every changed path is owner-ignored', async () => {
    // Owner-declared not-applicable: every changed path matches
    // auto_review.ignore_patterns. Materially different from a zero-lane
    // coverage gap (ADR 0333): the owner declared these paths need no review, so
    // publish a NEUTRAL check that claims no verdict -- never SHIP.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: [],
        personas: [],
        optionalFailures: [],
        zeroLaneNonEvidence: true,
        quorum: { required: 0, distinctProviders: [], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
      sourceLoader: vi.fn(async () => ({
        diff: 'diff --git a/docs/uat/runs/benchmarks/x.json b/docs/uat/runs/benchmarks/x.json\n@@ -1 +1 @@\n-a\n+b\n',
        githubReads: 1,
      })) as never,
    });
    const policy = JSON.stringify({ auto_review: { ignore_patterns: ['docs/uat/runs/**'] } });

    const receipt = await runPublishingReviewWorker(env({ REVIEW_YETI_POLICY_JSON: policy }), d as never);

    expect(receipt.conclusion).toBe('neutral');
    expect(receipt.coverage.mode).toBe('not_applicable');
    expect(receipt.verdict).not.toBe('SHIP');
  });

  it('keeps zero-lane non-evidence when the ignore list does not cover the whole diff', async () => {
    // Negative case (ADR 0641): a partially-ignored diff must NOT be laundered
    // into a skipped check.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: [],
        personas: [],
        optionalFailures: [],
        zeroLaneNonEvidence: true,
        quorum: { required: 0, distinctProviders: [], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
      sourceLoader: vi.fn(async () => ({
        diff: 'diff --git a/docs/uat/runs/benchmarks/x.json b/docs/uat/runs/benchmarks/x.json\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n',
        githubReads: 1,
      })) as never,
    });
    const policy = JSON.stringify({ auto_review: { ignore_patterns: ['docs/uat/runs/**'] } });

    const receipt = await runPublishingReviewWorker(env({ REVIEW_YETI_POLICY_JSON: policy }), d as never);

    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage.mode).toBe('zero_lane');
  });

  it('does not count a finding that arbitration discarded', async () => {
    // Regression: the blocking count came from raw persona output while the
    // verdict came from the canonical set, so a check could read `SHIP` and
    // `blocking P0/P1: 13` at once and publish nothing an author could act on.
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [{ severity: 'P1' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.blockingFindingCount).toBe(0);
    expect(receipt.conclusion).toBe('success');
  });

  it('publishes the findings into the check output', async () => {
    // A count with nothing attached is not reviewable. `text` and annotations
    // need only `checks: write`, which this worker already holds.
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Null deref', body: 'Crashes on empty input' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    await runPublishingReviewWorker(env(), d as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(String(arg.text)).toContain('Null deref');
    expect(String(arg.text)).toContain('src/a.ts');
    const annotations = arg.annotations as Array<Record<string, unknown>>;
    expect(annotations).toHaveLength(1);
    expect(annotations[0].path).toBe('src/a.ts');
    expect(annotations[0].annotation_level).toBe('failure');
  });

  it('fails the check when a diff header cannot be read, and names it', async () => {
    // The headline safety behaviour of this change: a header no path can be read
    // from means an UNREVIEWED file, so a verdict published over it describes
    // less than the diff. Deleting the `unreadable` branch must not stay green.
    const client = checkClient();
    const d = deps({
      checkClient: client,
      sourceLoader: vi.fn(async () => ({
        diff: `${DIFF}diff --git nonsense\n@@ -1 +1 @@\n-a\n+b\n`,
        githubReads: 1,
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);

    // The panel still saw the readable file, but canonical coverage must reject
    // the verdict because one changed-file header was never readable.
    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.blockingFindingCount).toBe(0);
    expect(receipt.coverage).toMatchObject({
      mode: 'panel', expectedLaneCount: 1, completedLaneCount: 1, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: false, fullPanelComplete: false,
    });
    // The check does not.
    expect(receipt.conclusion).toBe('failure');
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.conclusion).toBe('failure');
    expect(String(arg.summary)).toContain('diff --git nonsense');
    expect(String(arg.summary)).toContain('were NOT reviewed');
  });

  it('reports the findings arbitration discarded', async () => {
    // A discarded finding used to vanish with no trace. If the model locates a
    // real blocking finding on the wrong line, the count is the only signal that
    // anything was dropped.
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{
          id: 'sec-lane',
          findings: [
            { severity: 'P2', path: 'src/a.ts', line: 1, title: 'Kept', body: 'anchored' },
            { severity: 'P1', title: 'Dropped', body: 'no path, cannot be anchored' },
          ],
        }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    await runPublishingReviewWorker(env(), d as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(String(arg.summary)).toContain('1 raw finding(s) were discarded as unanchorable');
  });

  it('does not mention discards when nothing was discarded', async () => {
    const client = checkClient();
    const d = deps({ checkClient: client });
    await runPublishingReviewWorker(env(), d as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(String(arg.summary)).not.toContain('discarded as unanchorable');
  });

  it('keeps every annotation path inside the diff', async () => {
    // A guard, not a behaviour: sanitizeFinding already drops off-diff findings,
    // so nothing should ever reach the annotation set with a foreign path.
    // GitHub rejects such an annotation and fails the whole PATCH, which would
    // take the verdict with it.
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'InDiff', body: 'x' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    await runPublishingReviewWorker(env(), d as never);
    const arg = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    for (const a of (arg.annotations as Array<Record<string, unknown>>)) {
      expect(a.path).toBe('src/a.ts');
    }
  });

  it('keeps P2-only findings advisory even when the model arbiter says FIX_FIRST', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [{ severity: 'P2', path: 'docs/guide.md', line: 1, title: 'Advisory', body: 'Advisory' }] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'FIX_FIRST' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.verdict).toBe('SHIP');
    expect(receipt.conclusion).toBe('success');
    expect(receipt.blockingFindingCount).toBe(0);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'success', title: 'Review Yeti: SHIP' }),
    );
  });

  it('concludes failure — never neutral or success — when the provider fails', async () => {
    // The whole point of fail-closed: an outage must block, not silently stop
    // enforcing. completeCheck cannot express neutral, and success is never used.
    const d = deps({ panelRunner: vi.fn(async () => { throw new Error('429 rate limit'); }) as never });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/rate limit/u);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'failure' }),
    );
  });

  it('reports a typed terminal failure after fail-closed publication', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({
      completion,
      panelRunner: vi.fn(async () => { throw new Error('429 rate limit'); }) as never,
    });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/rate limit/u);
    expect(completion.reportTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      version: 'WorkerTerminalFailure.v1',
      runId: env().REVIEW_RUN_ID,
      checkId: 4242,
      failureClass: 'rate_limit',
    }));
  });

  it('reports a missing native nonce as malformed output in the terminal receipt', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({
      completion,
      panelRunner: vi.fn(async () => {
        throw new Error('required persona failure: persona sec-lane failed closed: bifrost: invalid or missing native JSON nonce');
      }) as never,
    });

    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/missing native JSON nonce/u);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({
      conclusion: 'failure',
    }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      checkId: 4242,
      failureClass: 'malformed_output',
    }));
    // REL-620: same failureClass ('malformed_output') as the recoverable-panel
    // case above, but this failure never went through `isRecoverableIncompletePanel`
    // -- it is a hard throw before any panel evidence exists -- so the marker
    // the dispatcher's automatic retry reads must be absent, not merely false.
    const event = (completion.reportTerminalFailure.mock.calls[0] as unknown as
      [{ diagnostics?: Record<string, unknown> }])[0];
    expect(event.diagnostics).not.toHaveProperty('recoverableIncompletePanel');
  });

  it('omits the recoverable marker when a panel failure reaches the terminal-failure path without satisfying isRecoverableIncompletePanel', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const cc = checkClient();
    // A raw P1 finding survives arbitration alongside the failed optional
    // lane, so `isRecoverableIncompletePanel` returns false
    // (canonicalFindingCount/rawFindingCount !== 0): this run takes the
    // normal `completeCheck` publish path, not the recoverable-retry branch
    // (mirrors "does not turn a partial panel with P1 findings..." above).
    // Force that publish itself to fail so the outer catch's
    // `reportTerminalFailure(error, checkId)` actually fires -- proving the
    // marker is genuinely absent from a real terminal-failure report, not
    // merely untested because the callback was never reached.
    cc.completeCheck.mockRejectedValueOnce(new Error('synthetic check-publish outage'));
    const d = deps({
      completion, checkClient: cc,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [{ id: 'sec-lane', findings: [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Finding', body: 'Review this' }] }],
        optionalFailures: [{ id: 'arch-lane', error: 'provider HTTP 502' }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: false },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/synthetic check-publish outage/u);

    expect(completion.reportTerminalFailure).toHaveBeenCalledOnce();
    const event = (completion.reportTerminalFailure.mock.calls[0] as unknown as
      [{ diagnostics?: Record<string, unknown> }])[0];
    expect(event.diagnostics).not.toHaveProperty('recoverableIncompletePanel');
  });

  it('reports the exact terminal success only after publishing the green check', async () => {
    const order: string[] = [];
    const completion = {
      reportTerminalFailure: vi.fn(async () => {}),
      reportTerminalSuccess: vi.fn(async () => { order.push('callback'); }),
    };
    const cc = checkClient();
    cc.completeCheck.mockImplementation(async () => { order.push('check'); });
    const d = deps({ completion, checkClient: cc });

    await runPublishingReviewWorker(env({ REVIEW_EXECUTION_ATTEMPT: '2' }), d as never);

    expect(order).toEqual(['check', 'callback']);
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
    expect(completion.reportTerminalSuccess).toHaveBeenCalledExactlyOnceWith({
      version: 'WorkerTerminalSuccess.v1',
      runId: env().REVIEW_RUN_ID,
      repositoryId: 1339040553,
      owner: 'calltelemetry',
      repo: 'ct-meta',
      prNumber: 2795,
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: 'c'.repeat(64),
      configDigest: 'd'.repeat(64),
      executionAttempt: 2,
      checkId: 4242,
    });
  });

  it('reports the findings behind a self-published check as evidence, before the terminal callback, for both conclusions', async () => {
    for (const [finding, conclusion] of [
      [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Blocking', body: 'Must fix' }, 'failure'],
      [{ severity: 'P2', path: 'src/a.ts', line: 1, title: 'Nit', body: 'Tidy' }, 'success'],
    ] as const) {
      const order: string[] = [];
      const completion = {
        reportTerminalFailure: vi.fn(async (_event: unknown) => { order.push('failure'); }),
        reportTerminalSuccess: vi.fn(async (_event: unknown) => { order.push('success'); }),
        reportReviewEvidence: vi.fn(async (_event: unknown) => { order.push('evidence'); }),
      };
      const cc = checkClient();
      cc.completeCheck.mockImplementation(async () => { order.push('check'); });
      const d = deps({
        completion, checkClient: cc,
        panelRunner: vi.fn(async () => ({
          applicablePersonaIds: ['sec-lane'],
          personas: [{ id: 'sec-lane', findings: [finding] }],
          optionalFailures: [],
          quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
          arbiter: { verdict: 'SHIP' },
        })) as never,
      });
      const receipt = await runPublishingReviewWorker(env({ REVIEW_EXECUTION_ATTEMPT: '2' }), d as never);
      expect(receipt.conclusion).toBe(conclusion);
      expect(order[0]).toBe('check');
      expect(order[1]).toBe('evidence');
      const event = completion.reportReviewEvidence.mock.calls[0]?.[0] as Record<string, any>;
      expect(event).toMatchObject({
        version: 'WorkerReviewEvidence.v1', runId: env().REVIEW_RUN_ID, executionAttempt: 2, checkId: 4242, conclusion,
        result: { version: 'WorkerReviewResult.v1', personas: [{ id: 'sec-lane', decision: 'FINDINGS',
          findings: [expect.objectContaining({ severity: finding.severity, path: 'src/a.ts' })] }] },
      });
      if (conclusion === 'success') {
        expect(completion.reportTerminalSuccess).toHaveBeenCalledOnce();
        expect(completion.reportTerminalSuccess.mock.calls[0][0]).not.toHaveProperty('result');
      } else {
        expect(completion.reportTerminalSuccess).not.toHaveBeenCalled();
      }
      expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
    }
  });

  it('still reports the terminal success when the evidence callback fails', async () => {
    const completion = {
      reportTerminalFailure: vi.fn(async (_event: unknown) => {}),
      reportTerminalSuccess: vi.fn(async (_event: unknown) => {}),
      reportReviewEvidence: vi.fn(async (_event: unknown) => { throw new Error('evidence endpoint down'); }),
    };
    const d = deps({ completion });
    const receipt = await runPublishingReviewWorker(env({ REVIEW_EXECUTION_ATTEMPT: '2' }), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(completion.reportReviewEvidence).toHaveBeenCalledOnce();
    expect(completion.reportTerminalSuccess).toHaveBeenCalledOnce();
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('sends no evidence when the panel failed recoverably (no verdict was published)', async () => {
    const completion = {
      reportTerminalFailure: vi.fn(async (_event: unknown) => {}),
      reportTerminalSuccess: vi.fn(async (_event: unknown) => {}),
      reportReviewEvidence: vi.fn(async (_event: unknown) => {}),
    };
    const d = deps({
      completion,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'arch-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        optionalFailures: [{ id: 'arch-lane', error: 'turn budget exhausted' }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    await runPublishingReviewWorker(env({ REVIEW_EXECUTION_ATTEMPT: '2' }), d as never);
    expect(completion.reportReviewEvidence).not.toHaveBeenCalled();
  });

  it('reads a lane decision from its findings only when the lane did not state one', async () => {
    const completion = {
      reportTerminalFailure: vi.fn(async (_event: unknown) => {}),
      reportTerminalSuccess: vi.fn(async (_event: unknown) => {}),
      reportReviewEvidence: vi.fn(async (_event: unknown) => {}),
    };
    const d = deps({
      completion,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['found', 'clean', 'stated'],
        personas: [
          { id: 'found', findings: [{ severity: 'P2', path: 'src/a.ts', line: 1, title: 'Nit', body: 'Tidy this' }] },
          { id: 'clean', findings: [] },
          { id: 'stated', decision: 'APPROVE', findings: [{ severity: 'P2', path: 'src/a.ts', line: 2, title: 'Nit', body: 'Also' }] },
        ],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    const event = completion.reportReviewEvidence.mock.calls[0]?.[0] as { result?: { personas: Array<{ id: string; decision: string }> } } | undefined;
    expect(event?.result?.personas.map((p) => [p.id, p.decision])).toEqual([
      ['found', 'FINDINGS'],   // no stated decision, findings present
      ['clean', 'APPROVE'],    // no stated decision, no findings
      ['stated', 'APPROVE'],   // a stated decision is preserved even with findings
    ]);
  });

  it('still reports the terminal success, and no evidence, when the result fails the contract', async () => {
    // The green check is already published by the time evidence is built. A
    // result the service would refuse (here: a finding body past the contract's
    // text bound) must be dropped, not allowed to abort the report.
    const completion = {
      reportTerminalFailure: vi.fn(async (_event: unknown) => {}),
      reportTerminalSuccess: vi.fn(async (_event: unknown) => {}),
      reportReviewEvidence: vi.fn(async (_event: unknown) => {}),
    };
    const d = deps({
      completion,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [{ severity: 'P2', path: 'src/a.ts', line: 1, title: 'Nit', body: 'x'.repeat(MAX_TEXT_CHARACTERS + 1) }] }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(completion.reportTerminalSuccess).toHaveBeenCalledOnce();
    const event = completion.reportTerminalSuccess.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.version).toBe('WorkerTerminalSuccess.v1');
    expect(event).not.toHaveProperty('result');
    expect(completion.reportReviewEvidence).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('does not publish contradictory failure evidence when the success acknowledgement is uncertain', async () => {
    const callbackError = new Error('success callback acknowledgement lost');
    const completion = {
      reportTerminalFailure: vi.fn(async () => {}),
      reportTerminalSuccess: vi.fn().mockRejectedValue(callbackError),
    };
    const cc = checkClient();

    await expect(runPublishingReviewWorker(env(), deps({ completion, checkClient: cc }) as never))
      .rejects.toBe(callbackError);

    expect(cc.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      checkId: 4242,
      conclusion: 'success',
    }));
    expect(completion.reportTerminalSuccess).toHaveBeenCalledOnce();
    expect(completion.reportTerminalFailure).not.toHaveBeenCalled();
  });

  it('refuses to ship an empty diff as a clean review', async () => {
    const d = deps({ sourceLoader: vi.fn(async () => ({ diff: '', githubReads: 1 })) as never });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/no reviewable diff/u);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: 'failure' }),
    );
  });

  it('still fails the job when the fail-closed publish itself cannot be written', async () => {
    const cc = { createCheck: vi.fn(async () => 1), completeCheck: vi.fn(async () => { throw new Error('GitHub down'); }) };
    const d = deps({ checkClient: cc, panelRunner: vi.fn(async () => { throw new Error('boom'); }) as never });
    // The original failure propagates so the Job fails and the admission deadline
    // can reap it, rather than being masked by the publish error.
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/boom/u);
  });

  it('reports a durable failure when check creation fails before a check id exists', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({
      checkClient: {
        createCheck: vi.fn(async () => { throw new Error('check provider response contains sensitive detail'); }),
        completeCheck: vi.fn(async () => {}),
      },
      completion,
    });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow(/sensitive detail/u);
    expect(d.checkClient.completeCheck).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).toHaveBeenCalledOnce();
    const event = (completion.reportTerminalFailure as any).mock.calls[0][0] as Record<string, unknown>;
    expect(event).not.toHaveProperty('checkId');
    expect(event).toMatchObject({
      runId: env().REVIEW_RUN_ID,
      repositoryId: 1339040553,
      executionAttempt: 1,
      failureClass: 'provider_error',
    });
  });

  it('reports a durable contract failure after check creation instead of skipping the callback', async () => {
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion });
    await expect(runPublishingReviewWorker(env({ OPENAI_BASE_URL: '' }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({
      checkId: 4242,
      conclusion: 'failure',
    }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      checkId: 4242,
      failureClass: 'contract',
    }));
  });

  it('rejects a malformed identity before creating a check', async () => {
    const d = deps();
    await expect(runPublishingReviewWorker(env({ REVIEW_HEAD_SHA: 'nope' }), d as never))
      .rejects.toThrow(/contract is invalid/u);
    expect(d.checkClient.createCheck).not.toHaveBeenCalled();
  });

  it('preserves the check-creation error when the completion callback also fails', async () => {
    const original = new Error('check creation rejected');
    const callbackError = new Error('private callback response ghs_do_not_log');
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const completion = { reportTerminalFailure: vi.fn().mockRejectedValue(callbackError) };
    const cc = checkClient();
    cc.createCheck.mockRejectedValue(original);
    const d = deps({ checkClient: cc, completion });

    await expect(runPublishingReviewWorker(env(), d)).rejects.toBe(original);
    expect(cc.completeCheck).not.toHaveBeenCalled();
    expect(d.sourceLoader).not.toHaveBeenCalled();
    expect(d.panelRunner).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).toHaveBeenCalledOnce();
    expect(completion.reportTerminalFailure.mock.calls[0][0]).not.toHaveProperty('checkId');
    expect(log).toHaveBeenCalledExactlyOnceWith('Failed to persist worker terminal failure', {
      runId: env().REVIEW_RUN_ID, failureClass: 'internal_error', reason: 'completion_callback_failed',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(callbackError.message);
  });

  it('still reports the exact run failure when failure publication and the callback both fail', async () => {
    const original = new Error('429 private provider response');
    const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const cc = checkClient();
    cc.completeCheck.mockRejectedValue(new Error('private check response ghs_do_not_log'));
    const completion = { reportTerminalFailure: vi.fn().mockRejectedValue(new Error('private callback response')) };
    const d = deps({ checkClient: cc, completion, panelRunner: vi.fn().mockRejectedValue(original) });

    await expect(runPublishingReviewWorker(env({ REVIEW_EXECUTION_ATTEMPT: '2' }), d)).rejects.toBe(original);
    expect(cc.completeCheck).toHaveBeenCalledOnce();
    expect(cc.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ checkId: 4242, conclusion: 'failure' }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith({
      version: 'WorkerTerminalFailure.v1', runId: env().REVIEW_RUN_ID,
      repositoryId: 1339040553, owner: 'calltelemetry', repo: 'ct-meta', prNumber: 2795,
      headSha: HEAD, baseSha: BASE, policyDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
      executionAttempt: 2, checkId: 4242, failureClass: 'rate_limit',
      diagnostics: { reason: 'provider_rate_limited', logTail: '429 [REDACTED]' },
    });
    expect(log.mock.calls).toEqual([
      ['Failed to publish the fail-closed conclusion', {
        runId: env().REVIEW_RUN_ID, failureClass: 'rate_limit', reason: 'check_publication_failed',
      }],
      ['Failed to persist worker terminal failure', {
        runId: env().REVIEW_RUN_ID, failureClass: 'rate_limit', reason: 'completion_callback_failed',
      }],
    ]);
    expect(JSON.stringify([log.mock.calls, completion.reportTerminalFailure.mock.calls, cc.completeCheck.mock.calls]))
      .not.toContain('private');
  });

  it('reports a source-load failure without invoking the panel', async () => {
    const original = new Error('fetch failed');
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion, sourceLoader: vi.fn().mockRejectedValue(original) });
    await expect(runPublishingReviewWorker(env(), d)).rejects.toBe(original);
    expect(d.panelRunner).not.toHaveBeenCalled();
    expect(d.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({ conclusion: 'failure' }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      checkId: 4242, failureClass: 'transport',
    }));
  });

  it('classifies a real GitHubQualificationReadError HTTP 406 from the source loader as contract with the diff-not-renderable reason', async () => {
    // End-to-end: the source loader throws the real error type qualificationReader.ts
    // produces, and reportTerminalFailure -- worker-side, holding the Error object --
    // must decide the github_diff_not_renderable diagnostic from its structured
    // httpStatus field, not by parsing the message anywhere downstream.
    const original = new GitHubQualificationReadError('GitHub qualification read failed HTTP 406', 2, 406);
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    const d = deps({ completion, sourceLoader: vi.fn().mockRejectedValue(original) });
    await expect(runPublishingReviewWorker(env(), d)).rejects.toBe(original);
    expect(d.panelRunner).not.toHaveBeenCalled();
    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      checkId: 4242,
      failureClass: 'contract',
      diagnostics: expect.objectContaining({
        reason: 'github_diff_not_renderable',
        providerStatus: 406,
      }),
    }));
  });

  it('reports a terminal failure when publishing a successful review fails', async () => {
    const original = new Error('check publication timeout');
    const cc = checkClient();
    cc.completeCheck.mockRejectedValueOnce(original);
    const completion = { reportTerminalFailure: vi.fn(async () => {}) };
    await expect(runPublishingReviewWorker(env(), deps({ checkClient: cc, completion }))).rejects.toBe(original);
    expect(cc.completeCheck).toHaveBeenNthCalledWith(1, expect.objectContaining({ conclusion: 'success', checkId: 4242 }));
    expect(cc.completeCheck).toHaveBeenNthCalledWith(2, expect.objectContaining({ conclusion: 'failure', checkId: 4242 }));
    expect(completion.reportTerminalFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      checkId: 4242, failureClass: 'timeout',
    }));
  });
});

describe('identity and failure classification', () => {
  it('parses owner and repo', () => {
    const id = publishingReviewIdentity(env());
    expect(id.owner).toBe('calltelemetry');
    expect(id.repoName).toBe('ct-meta');
  });

  it.each([
    ['virtual key not found', 'auth'],
    ['429 rate limit', 'rate_limit'],
    ['request timed out', 'timeout'],
    ['persona dep-lane failed closed: bifrost: OpenRouter compatibility response exceeded total deadline of 300000ms', 'timeout'],
    ['fetch failed', 'transport'],
    ['invalid native JSON response object', 'malformed_output'],
    ['invalid or missing native JSON nonce', 'malformed_output'],
    ['native JSON response must be an object', 'malformed_output'],
    ['invalid findings contract at index 0', 'malformed_output'],
    ['APPROVE cannot contain findings', 'malformed_output'],
    ['FINDINGS requires at least one finding', 'malformed_output'],
    ['nonce-fenced structured output rejected', 'malformed_output'],
    ['persona sec-lane reported INCOMPLETE without a completed review', 'malformed_output'],
    ['required persona failure: bifrost: persona sec-lane reported INCOMPLETE without a completed review', 'malformed_output'],
    ['An optional reviewer did not complete.', 'malformed_output'],
    ['gateway returned an unexpected payload', 'provider_error'],
  ])('classifies %s as %s', (message, expected) => {
    expect(classifyFailure(new Error(message))).toBe(expected);
  });

  it('does not label an unknown worker exception as a provider outage', () => {
    expect(classifyFailure(new Error('unexpected invariant violation'))).toBe('internal_error');
  });

  it('classifies a GitHub HTTP 406 qualification-read failure as contract, never internal_error', () => {
    const failureClass = classifyFailure(new GitHubQualificationReadError('GitHub qualification read failed HTTP 406', 2, 406));
    expect(failureClass).toBe('contract');
    expect(failureClass).not.toBe('internal_error');
  });

  it('classifies GitHubQualificationReadError from the structured httpStatus field, not the message', () => {
    // A plain Error carrying the same wording must not be classified as
    // contract: the 406 branch reads `error.httpStatus`, not a regex over
    // `error.message`, so wording alone can never trigger it.
    const failureClass = classifyFailure(new Error('GitHub qualification read failed HTTP 406'));
    expect(failureClass).not.toBe('contract');
  });

  it.each([
    [429, 'rate_limit'],
    [500, 'internal_error'],
    [502, 'internal_error'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'internal_error'],
  ])('leaves the existing classification for GitHubQualificationReadError HTTP %s unchanged (%s)', (status, expected) => {
    const message = `GitHub qualification read failed HTTP ${status}`;
    expect(classifyFailure(new GitHubQualificationReadError(message, 1, status))).toBe(expected);
  });

  it.each([
    [new OpenRouterTimeoutError('deadline'), 'timeout'],
    [new OpenRouterConnectionError('socket closed'), 'transport'],
    [new OpenRouterResponseError('unauthorized', 401), 'auth'],
    [new OpenRouterResponseError('forbidden', 403), 'auth'],
    [new OpenRouterResponseError('busy', 429), 'rate_limit'],
    [new OpenRouterResponseError('upstream failed', 503), 'provider_error'],
    [new UpstreamCapacityRejectionError('bifrost', 'queue full'), 'rate_limit'],
  ])('classifies typed gateway error %s as %s', (error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
  });
});

describe('worker terminal failure adapter', () => {
  it('sends only the typed failure event with the scoped worker token', async () => {
    const fetchImplementation = vi.fn(async () => new Response('', { status: 202 }));
    const adapter = new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://dispatch.example.test/completion',
      fetchImplementation,
    });
    const event = {
      version: 'WorkerTerminalFailure.v1' as const,
      runId: `run_${'c'.repeat(32)}`,
      repositoryId: 1339040553,
      owner: 'calltelemetry',
      repo: 'ct-meta',
      prNumber: 2795,
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: 'c'.repeat(64),
      configDigest: 'd'.repeat(64),
      executionAttempt: 1,
      checkId: 4242,
      failureClass: 'provider_error' as const,
    };

    await adapter.reportTerminalFailure(event);

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://dispatch.example.test/completion',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ghs_test' }),
        body: JSON.stringify(event),
        redirect: 'error',
      }),
    );
  });

  it('rejects a non-HTTPS completion endpoint', () => {
    expect(() => new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'http://dispatch.example.test/completion',
    })).toThrow(/HTTPS/u);
  });

  it('rejects completion endpoint userinfo', () => {
    expect(() => new HttpWorkerCompletionAdapter({
      token: 'ghs_test',
      endpoint: 'https://user:password@dispatch.example.test/completion',
    })).toThrow(/userinfo/u);
  });
});

describe('worker dispatch ordering (safety critical)', () => {
  it('routes an app-gate dispatch to the publishing lane, never the legacy runner', async () => {
    // runLiveReviewMain resolves repo/PR from argv with a hardcoded fallback and
    // defaults its base URL to openrouter.ai. If app-gate ever fell through to it,
    // a DOKS dispatch would review the wrong repository against the wrong provider.
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const live = vi.fn(async () => {});
    const publishing = vi.fn(async () => {});
    const noop = vi.fn(async () => {});

    await runWorker(env(), live, noop, noop, noop, noop, publishing);

    expect(publishing).toHaveBeenCalledTimes(1);
    expect(live).not.toHaveBeenCalled();
  });

  it('still routes a disabled dispatch to receipt-only, not publishing or legacy', async () => {
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const live = vi.fn(async () => {});
    const publishing = vi.fn(async () => {});
    const noop = vi.fn(async () => {});

    // runReceiptOnlyWorker is called directly rather than through an injected
    // runner, so reaching it is observable as its own contract error on this
    // deliberately minimal env. That it throws *that* error -- rather than
    // invoking either spy -- is the proof the dispatch landed in receipt-only.
    await expect(runWorker(
      env({ REVIEW_PUBLICATION_MODE: 'disabled', REVIEW_RECEIPT_ONLY: 'true' }),
      live, noop, noop, noop, noop, publishing,
    )).rejects.toThrow(/receipt-only worker contract is invalid/u);

    expect(publishing).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
  });
});

describe('the worker never holds the App private key', () => {
  it('refuses to publish without a ghs_ scoped token', async () => {
    // The operator asserts the same boundary. This pod parses untrusted diffs and
    // executes model output; an App private key here would let a compromised
    // worker mint tokens for every installation.
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const noop = vi.fn(async () => {});
    await expect(runWorker(
      env({ GITHUB_PUBLISH_TOKEN: '' }),
      noop, noop, noop, noop, noop,
    )).rejects.toThrow(/requires a ghs_ installation token/u);
  });

  it('refuses a token that is not an installation token', async () => {
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const noop = vi.fn(async () => {});
    // A PAT or App JWT would carry far broader scope than one repository.
    await expect(runWorker(
      env({ GITHUB_PUBLISH_TOKEN: 'ghp_personal_access_token' }),
      noop, noop, noop, noop, noop,
    )).rejects.toThrow(/requires a ghs_ installation token/u);
  });
});

describe('resolveWorkerConfig policy projection & telemetry persistence', () => {
  const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'vk-test', model: 'ollama/glm-5.3-flash' };

  it('defaults to 6 central personas and max 15 turns under default env', () => {
    const config = resolveWorkerConfig(env(), transport);
    expect(config.personas).toHaveLength(6);
    expect(config.personas.map((p) => p.id)).toEqual([
      'sec-lane',
      'perf-lane',
      'arch-lane',
      'qual-lane',
      'dep-lane',
      'policy-lane',
    ]);
    expect(config.personas.find((p) => p.id === 'sec-lane')?.required).toBe(true);
    expect(config.personas.find((p) => p.id === 'perf-lane')?.required).toBe(false);
    expect(config.personas.every((p) => p.providers.length === 1 && p.providers[0] === 'bifrost')).toBe(true);
    expect(config.default_max_turns).toBe(15);
    expect(config.reviewers.arbiter.order).toEqual(['bifrost']);
    expect(config.reviewers.providers[0].id).toBe('bifrost');
    expect(config.reviewers.providers[0].model).toBe('ollama/glm-5.3-flash');
  });

  it('projects central policy from REVIEW_YETI_POLICY_JSON', () => {
    const policyJson = JSON.stringify({
      schema: 'calltelemetry.review-policy.v1',
      review_yeti: {
        personas: 'security,architecture,testing',
        budget: {
          max_investigation_turns: '3',
          lane_call_budget: '24',
        },
      },
    });
    const config = resolveWorkerConfig(env({ REVIEW_YETI_POLICY_JSON: policyJson }), transport);
    expect(config.personas.map((p) => p.id)).toEqual(['sec-lane', 'arch-lane', 'qual-lane']);
    expect(config.default_max_turns).toBe(3);
  });

  it('caps default_max_turns at 15 even if policy declares higher turns', () => {
    const policyJson = JSON.stringify({
      review_yeti: {
        personas: 'security',
        budget: { max_investigation_turns: '20' },
      },
    });
    const config = resolveWorkerConfig(env({ REVIEW_YETI_POLICY_JSON: policyJson }), transport);
    expect(config.default_max_turns).toBe(15);
  });

  it('persists per-lane metrics and totals in receipt', async () => {
    const d = deps({
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane', 'perf-lane'],
        personas: [
          {
            id: 'sec-lane',
            decision: 'APPROVE',
            findings: [],
            turnsCount: 2,
            toolCalls: [{ tool: 'read_file' }],
            promptTokens: 1200,
            completionTokens: 300,
            totalTokens: 1500,
            durationMs: 4000,
          },
          {
            id: 'perf-lane',
            decision: 'APPROVE',
            findings: [],
            turnsCount: 1,
            toolCalls: [],
            promptTokens: 800,
            completionTokens: 200,
            totalTokens: 1000,
            durationMs: 2500,
          },
        ],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(receipt.coverage).toEqual({
      mode: 'panel', expectedLaneCount: 2, completedLaneCount: 2, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: true, fullPanelComplete: true,
    });
    expect(receipt.personas).toHaveLength(2);
    expect(receipt.personas?.[0].id).toBe('sec-lane');
    expect(receipt.personas?.[0].turnsCount).toBe(2);
    expect(receipt.personas?.[0].toolCallsCount).toBe(1);
    expect(receipt.metrics).toEqual({
      totalPromptTokens: 2000,
      totalCompletionTokens: 500,
      totalTokens: 2500,
      totalTurns: 3,
      totalToolCalls: 1,
      totalDurationMs: 6500,
    });
  });
});

describe('parseChangedFiles', () => {
  it('reads a path containing spaces', () => {
    // Regression: the header matcher used `(\S+)`, which stopped at the first
    // space. `a/sip message.txt` produced no path, the file silently dropped out
    // of the reviewed set, and any finding on it was discarded -- a review that
    // reported success over a file it never saw. cisco-cdr has eight such paths.
    const { files, unreadable } = parseChangedFiles(
      'diff --git a/test/sip message.txt b/test/sip message.txt\n' +
      'index 111..222 100644\n--- a/test/sip message.txt\n+++ b/test/sip message.txt\n' +
      '@@ -1 +1 @@\n-old\n+new\n',
    );
    expect(unreadable).toEqual([]);
    expect(files.map((f) => f.path)).toEqual(['test/sip message.txt']);
  });

  it('reads a rename, and reports the destination', () => {
    const { files } = parseChangedFiles(
      'diff --git a/old name.ts b/new name.ts\nsimilarity index 100%\n' +
      'rename from old name.ts\nrename to new name.ts\n',
    );
    expect(files.map((f) => f.path)).toEqual(['new name.ts']);
  });

  it('reads a quoted non-ASCII path', () => {
    const { files } = parseChangedFiles(
      'diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"\n' +
      '--- "a/docs/caf\\303\\251.md"\n+++ "b/docs/caf\\303\\251.md"\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(files.map((f) => f.path)).toEqual(['docs/café.md']);
  });

  it('decodes the simple escapes, not just octal ones', () => {
    // `unquoteGitPath` has two decode paths: three-digit octal and a small table
    // of `\\n \\t \\r \\" \\\\`. Only the octal path was covered, so removing an entry
    // from the table stayed green while a real path stopped matching changedPaths.
    const { files } = parseChangedFiles(
      'diff --git "a/x\\\\y \\"q\\".md" "b/x\\\\y \\"q\\".md"\n' +
      '--- "a/x\\\\y \\"q\\".md"\n+++ "b/x\\\\y \\"q\\".md"\n@@ -1 +1 @@\n-a\n+b\n',
    );
    expect(files.map((f) => f.path)).toEqual(['x\\y "q".md']);
  });

  it('reads a deletion from the pre-image', () => {
    const { files } = parseChangedFiles(
      'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n' +
      '--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n',
    );
    expect(files.map((f) => f.path)).toEqual(['gone.ts']);
  });

  it('reads a binary file with no hunk lines', () => {
    const { files } = parseChangedFiles(
      'diff --git a/logo.png b/logo.png\nindex 111..222 100644\n' +
      'Binary files a/logo.png and b/logo.png differ\n',
    );
    expect(files.map((f) => f.path)).toEqual(['logo.png']);
  });

  it('does not split on a diff header that appears inside a patch body', () => {
    const { files } = parseChangedFiles(
      'diff --git a/doc.md b/doc.md\n--- a/doc.md\n+++ b/doc.md\n' +
      '@@ -1 +1,2 @@\n a\n+diff --git a/fake.ts b/fake.ts\n',
    );
    expect(files.map((f) => f.path)).toEqual(['doc.md']);
  });

  it('reports an unreadable header instead of dropping the file', () => {
    const { files, unreadable } = parseChangedFiles('diff --git nonsense\n@@ -1 +1 @@\n-a\n+b\n');
    expect(files).toEqual([]);
    expect(unreadable).toEqual(['diff --git nonsense']);
  });
});

describe('hosted lane — repository visibility resolution', () => {
  const summaryOf = (client: ReturnType<typeof checkClient>) =>
    String(((client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary);

  it('trusts a definite value from the dispatching workflow and does not look up', async () => {
    const client = checkClient();
    const visibilityLookup = vi.fn(async () => 'PUBLIC' as const);
    await runPublishingReviewWorker(env({ REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE' }), deps({ checkClient: client, visibilityLookup }) as never);
    expect(visibilityLookup).not.toHaveBeenCalled();
    expect(summaryOf(client)).toContain('Repository visibility: PRIVATE.');
  });

  it("asks GitHub with the run's own token when the workflow did not say", async () => {
    // The first live run after visibility was introduced published UNKNOWN for a
    // private repository because nothing in production sets the env var. The lane
    // already holds a repository-scoped read token for the diff; it can ask.
    const client = checkClient();
    const visibilityLookup = vi.fn(async () => 'PRIVATE' as const);
    await runPublishingReviewWorker(env(), deps({ checkClient: client, visibilityLookup }) as never);
    expect(visibilityLookup).toHaveBeenCalledWith({ owner: 'calltelemetry', repo: 'ct-meta', token: 'ghs_test' });
    expect(summaryOf(client)).toContain('Repository visibility: PRIVATE.');
  });

  it('settles to UNKNOWN and still completes the review when the lookup fails', async () => {
    const client = checkClient();
    const visibilityLookup = vi.fn(async () => { throw new Error('repos 502'); });
    const receipt = await runPublishingReviewWorker(env(), deps({ checkClient: client, visibilityLookup }) as never);
    expect(receipt.conclusion).toBe('success');
    expect(summaryOf(client)).toContain('Repository visibility: UNKNOWN.');
  });

  it('publishes Review Yeti: SHIP (fast-ship) and fast-ship summary for fastShip panel result', async () => {
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        isFastShip: true,
        classifierRationale: 'Docs only modification',
        tokensSaved: 12500,
        personas: [{ id: 'fast-ship', findings: [] }],
        quorum: { required: 0, distinctProviders: [], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(receipt.coverage).toEqual({
      mode: 'fast_ship', expectedLaneCount: null, completedLaneCount: 0, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: true, fullPanelComplete: false,
    });
    expect(client.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Review Yeti: SHIP (fast-ship)',
        summary: expect.stringContaining('### Review Yeti: SHIP (fast-ship)'),
      }),
    );
    expect(summaryOf(client)).toContain('Docs only modification');
    expect(summaryOf(client)).toContain('12,500 tokens saved');
    expect(summaryOf(client)).toContain('mode=fast_ship');
  });

  it('does not present rejected fast-ship coverage as a SHIP check', async () => {
    const client = checkClient();
    const d = deps({
      checkClient: client,
      sourceLoader: vi.fn(async () => ({
        diff: `${DIFF}diff --git nonsense\n@@ -1 +1 @@\n-a\n+b\n`,
        githubReads: 1,
      })) as never,
      panelRunner: vi.fn(async () => ({
        isFastShip: true,
        classifierRationale: 'Docs only modification',
        tokensSaved: 12500,
        personas: [{ id: 'fast-ship', findings: [] }],
        quorum: { required: 0, distinctProviders: [], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });

    const receipt = await runPublishingReviewWorker(env(), d as never);

    expect(receipt.verdict).toBe('BLOCK');
    expect(receipt.conclusion).toBe('failure');
    expect(receipt.coverage).toMatchObject({
      mode: 'fast_ship', expectedLaneCount: null, completedLaneCount: 0, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: false, fullPanelComplete: false,
    });
    const published = (client.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(published.title).toBe('Review Yeti: BLOCK');
    expect(String(published.summary)).not.toContain('SHIP (fast-ship)');
  });

  it('publishes normal Review Yeti: SHIP with Telemetry line for standard panel result', async () => {
    const client = checkClient();
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(receipt.coverage).toEqual({
      mode: 'panel', expectedLaneCount: 1, completedLaneCount: 1, failedLaneCount: 0,
      rosterValid: true, quorumSatisfied: true, fullPanelComplete: true,
    });
    expect(client.completeCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Review Yeti: SHIP',
        summary: expect.stringContaining('Telemetry:'),
      }),
    );
  });

  it('publishes only the Review Yeti check on clean SHIP review completion', async () => {
    const publishGateCheck = vi.fn(async () => 7777);
    const client = {
      ...checkClient(),
      publishGateCheck,
    };
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => ({
        applicablePersonaIds: ['sec-lane'],
        personas: [{ id: 'sec-lane', findings: [] }],
        quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
        arbiter: { verdict: 'SHIP' },
      })) as never,
    });
    const receipt = await runPublishingReviewWorker(env(), d as never);
    expect(receipt.conclusion).toBe('success');
    expect(publishGateCheck).not.toHaveBeenCalled();
  });

  it('does not create a second gate check when Review Yeti fails closed', async () => {
    const publishGateCheck = vi.fn(async () => 8888);
    const client = {
      ...checkClient(),
      publishGateCheck,
    };
    const d = deps({
      checkClient: client,
      panelRunner: vi.fn(async () => {
        throw new Error('LLM Provider Outage');
      }) as never,
    });
    await expect(runPublishingReviewWorker(env(), d as never)).rejects.toThrow('LLM Provider Outage');
    expect(publishGateCheck).not.toHaveBeenCalled();
  });
});

describe('full-repository grounding (repoFileProvider)', () => {
  it("wires a repoFileProvider into panelRunner built from the run's own GH_TOKEN, owner, repo, and headSha", async () => {
    const stubProvider = { findFiles: vi.fn(), readFile: vi.fn() };
    const repoFileProviderFactory = vi.fn(() => stubProvider);
    const panelRunner = vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    await runPublishingReviewWorker(env(), deps({ repoFileProviderFactory, panelRunner: panelRunner as never }) as never);

    expect(repoFileProviderFactory).toHaveBeenCalledTimes(1);
    expect(repoFileProviderFactory).toHaveBeenCalledWith({
      token: 'ghs_test', owner: 'calltelemetry', repo: 'ct-meta', headSha: HEAD,
    });
    const arg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.repoFileProvider).toBe(stubProvider);
  });

  it('does not wire a repoFileProvider and logs explicitly when GH_TOKEN is absent', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const repoFileProviderFactory = vi.fn();
    const panelRunner = vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    const receipt = await runPublishingReviewWorker(
      env({ GH_TOKEN: '' }),
      deps({ repoFileProviderFactory, panelRunner: panelRunner as never }) as never,
    );

    expect(receipt.conclusion).toBe('success');
    expect(repoFileProviderFactory).not.toHaveBeenCalled();
    const arg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.repoFileProvider).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No GH_TOKEN available'),
      expect.objectContaining({ repository: 'calltelemetry/ct-meta' }),
    );
    warnSpy.mockRestore();
  });

  it('fails soft: a throwing repoFileProviderFactory does not fail the review and leaves repoFileProvider undefined', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const repoFileProviderFactory = vi.fn(() => { throw new Error('installation client blew up'); });
    const panelRunner = vi.fn(async () => ({
      applicablePersonaIds: ['sec-lane'],
      personas: [{ id: 'sec-lane', findings: [] }],
      quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
      arbiter: { verdict: 'SHIP' },
    }));
    const receipt = await runPublishingReviewWorker(
      env(),
      deps({ repoFileProviderFactory, panelRunner: panelRunner as never }) as never,
    );

    expect(receipt.conclusion).toBe('success');
    const arg = (panelRunner.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>;
    expect(arg.repoFileProvider).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to construct full-repository file provider'),
      expect.objectContaining({ error: expect.stringContaining('installation client blew up') }),
    );
    warnSpy.mockRestore();
  });
});

// Positive counterpart to the "no disabled-status sample" negative assertion below: reads the
// actual recorded sample count for one status label off the Prometheus export, not just whether
// the metric *type* is registered (initMetrics registers the type unconditionally, independent of
// whether `.record(...)` was ever called -- see the histogram-type test further down). Returns 0
// when no sample with this status has landed yet so callers can assert an exact before/after delta
// without depending on what earlier tests in this file recorded.
function histogramCountForStatus(text: string, status: string): number {
  const match = text.match(new RegExp(`review_yeti_zoekt_index_build_duration_seconds_count\\{[^}]*status="${status}"[^}]*\\}\\s+(\\d+(?:\\.\\d+)?)`, 'u'));
  return match ? Number(match[1]) : 0;
}

describe('REL-677 zoekt index-build telemetry', () => {
  beforeEach(() => {
    initTelemetry('review-yeti-bot');
    clearSpans();
  });

  it('records a review_yeti_zoekt_index_build span, separate from lane time, when grounding is enabled', async () => {
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/fake-zoekt-index' }));
    // Deterministic duration: `now()` is called for startedAt, buildStart, the build-end
    // measurement, then completedAt (in that order) on this success path.
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(2_000).mockReturnValueOnce(2_042).mockReturnValue(3_000);
    const before = histogramCountForStatus(await getPrometheusMetrics(), 'ok');
    await runPublishingReviewWorker(
      env({ ZOEKT_GROUNDING_ENABLED: 'true' }),
      deps({ zoektGrounding: zoektGrounding as never, now }) as never,
    );

    expect(zoektGrounding).toHaveBeenCalledTimes(1);
    const spans = getRecentSpans();
    const buildSpan = spans.find((s) => s.name === 'review_yeti_zoekt_index_build');
    expect(buildSpan).toBeDefined();
    expect(buildSpan?.attributes['review_yeti.zoekt_index_build.enabled']).toBe(true);
    expect(buildSpan?.attributes['review_yeti.zoekt_index_build.status']).toBe('ok');
    expect(buildSpan?.attributes['review_yeti.zoekt_index_build.duration_ms']).toBe(42);
    // Positive assertion the prior round was missing: the histogram must actually have
    // recorded a sample for this run, not merely have its type registered (that happens
    // unconditionally in initMetrics, independent of this code path ever executing).
    const after = histogramCountForStatus(await getPrometheusMetrics(), 'ok');
    expect(after).toBe(before + 1);
  });

  it('reports a non-ok status on the span when the index build fails, without failing the review', async () => {
    const zoektGrounding = vi.fn(async () => ({ reason: 'build_failed' }));
    const before = histogramCountForStatus(await getPrometheusMetrics(), 'build_failed');
    const receipt = await runPublishingReviewWorker(
      env({ ZOEKT_GROUNDING_ENABLED: 'true' }),
      deps({ zoektGrounding: zoektGrounding as never }) as never,
    );

    expect(receipt.conclusion).toBe('success');
    const spans = getRecentSpans();
    const buildSpan = spans.find((s) => s.name === 'review_yeti_zoekt_index_build');
    expect(buildSpan?.attributes['review_yeti.zoekt_index_build.status']).toBe('build_failed');
    // Same positive assertion for the failure-status path: a failed build still records its
    // cost (it still consumed materialize/build wall time), tagged by its own status label.
    const after = histogramCountForStatus(await getPrometheusMetrics(), 'build_failed');
    expect(after).toBe(before + 1);
  });

  it('marks the span disabled and records no index-build cost when grounding is off', async () => {
    const zoektGrounding = vi.fn(async () => ({ indexDir: '/tmp/should-not-be-used' }));
    await runPublishingReviewWorker(env(), deps({ zoektGrounding: zoektGrounding as never }) as never);

    const spans = getRecentSpans();
    const buildSpan = spans.find((s) => s.name === 'review_yeti_zoekt_index_build');
    expect(buildSpan?.attributes['review_yeti.zoekt_index_build.enabled']).toBe(false);
    expect(buildSpan?.attributes['review_yeti.zoekt_index_build.status']).toBe('disabled');
    // A disabled run performs no materialize/build work, so it has no build cost to
    // report -- assert the absence of a measurement, not just a status label, so a
    // future regression that records a bogus duration on a disabled run is caught here.
    expect(buildSpan?.attributes['review_yeti.zoekt_index_build.duration_ms']).toBeUndefined();
    const text = await getPrometheusMetrics();
    expect(text).not.toMatch(/review_yeti_zoekt_index_build_duration_seconds_(?:bucket|sum|count)\{[^}]*status="disabled"[^}]*\}/u);
  });

  it('publishes the index-build duration in the check-run telemetry summary only when grounding is enabled', async () => {
    const enabledClient = checkClient();
    await runPublishingReviewWorker(
      env({ ZOEKT_GROUNDING_ENABLED: 'true' }),
      deps({
        checkClient: enabledClient,
        zoektGrounding: vi.fn(async () => ({ indexDir: '/tmp/fake-zoekt-index' })) as never,
      }) as never,
    );
    const enabledSummary = String(
      ((enabledClient.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary,
    );
    expect(enabledSummary).toContain('Zoekt index build:');

    const disabledClient = checkClient();
    await runPublishingReviewWorker(env(), deps({ checkClient: disabledClient }) as never);
    const disabledSummary = String(
      ((disabledClient.completeCheck.mock.calls[0] as unknown as unknown[])[0] as Record<string, unknown>).summary,
    );
    expect(disabledSummary).not.toContain('Zoekt index build:');
  });

  it('registers the review_yeti_zoekt_index_build_duration_seconds histogram distinct from the pre-check zoektDuration metric', async () => {
    const text = await getPrometheusMetrics();
    expect(text).toContain('# TYPE review_yeti_zoekt_index_build_duration_seconds histogram');
    // The pre-existing pre-check query-duration metric must remain a separate series.
    expect(text).toContain('# TYPE review_yeti_zoekt_duration_seconds histogram');
  });
});

describe('REL-810 follow-up: delivered failure clarity', () => {
  it('names the failure point and remediation for budget_exhausted', async () => {
    const { renderFailureSummary } = await import('../../src/cli/publishingReview');
    const summary = renderFailureSummary('budget_exhausted', 'a'.repeat(40), {
      reason: 'worker_budget_exhausted',
      logTail: 'persona security turn budget exhausted without verdict (INCOMPLETE)',
    });
    expect(summary).toContain('failure class `budget_exhausted`');
    expect(summary).toContain('What failed');
    expect(summary).toContain('persona investigation turns or lane call budget');
    expect(summary).toContain('not an approval');
    expect(summary).toContain('persona security turn budget exhausted without verdict');
  });

  it('names provider status and transport guidance for transport failures', async () => {
    const { renderFailureSummary } = await import('../../src/cli/publishingReview');
    const summary = renderFailureSummary('transport', 'b'.repeat(40), { providerStatus: 502 });
    expect(summary).toContain('could not reach the gateway');
    expect(summary).toContain('provider_status=502');
    expect(summary).toContain('not an approval');
  });

  it('names the HTTP 406 status and the too-large meaning instead of a generic contract message', async () => {
    const { renderFailureSummary } = await import('../../src/cli/publishingReview');
    const summary = renderFailureSummary('contract', 'c'.repeat(40), {
      reason: 'github_diff_not_renderable',
      providerStatus: 406,
      logTail: 'GitHub returned HTTP 406: this diff is too large to render as configured '
        + '(roughly over 20,000 changed lines or 300 files). This is a permanent property of this head, '
        + 'not an infrastructure outage. GitHub qualification read failed HTTP 406',
    });
    expect(summary).toContain('failure class `contract`');
    expect(summary).toContain('406');
    expect(summary).toContain('too large');
    expect(summary).toContain('not an infrastructure outage');
    expect(summary).toContain('provider_status=406');
    expect(summary).toContain('reason=`github_diff_not_renderable`');
    expect(summary).not.toContain('the review contract/configuration was invalid');
  });

  it('keeps the generic contract guidance for a non-diff-size contract failure', async () => {
    const { renderFailureSummary } = await import('../../src/cli/publishingReview');
    const summary = renderFailureSummary('contract', 'd'.repeat(40), {
      reason: 'worker_contract_invalid',
      logTail: 'same-head qualification worker contract is invalid',
    });
    expect(summary).toContain('the review contract/configuration was invalid');
    expect(summary).not.toContain('too large');
  });
});

describe('REL-810 follow-up: turn budget exhaustion detail', () => {
  it('classifies an explicit turn-budget exhaustion as budget_exhausted', async () => {
    const { classifyFailure } = await import('../../src/cli/publishingReview');
    expect(classifyFailure(new Error('persona security turn budget exhausted without verdict (INCOMPLETE): used 3/3 investigation turns')))
      .toBe('budget_exhausted');
  });

  it('does not classify a generic incomplete message as budget_exhausted', async () => {
    const { classifyFailure } = await import('../../src/cli/publishingReview');
    expect(classifyFailure(new Error('repository tree lookup incomplete'))).not.toBe('budget_exhausted');
  });
});

describe('isGithubDiffNotRenderableError', () => {
  it('is true only for a GitHubQualificationReadError carrying HTTP 406', () => {
    expect(isGithubDiffNotRenderableError(new GitHubQualificationReadError('GitHub qualification read failed HTTP 406', 1, 406))).toBe(true);
    expect(isGithubDiffNotRenderableError(new GitHubQualificationReadError('GitHub qualification read failed HTTP 404', 1, 404))).toBe(false);
    expect(isGithubDiffNotRenderableError(new GitHubQualificationReadError('GitHub qualification read failed HTTP 406', 1))).toBe(false);
    expect(isGithubDiffNotRenderableError(new Error('GitHub qualification read failed HTTP 406'))).toBe(false);
    expect(isGithubDiffNotRenderableError(undefined)).toBe(false);
  });

  it('is the single predicate behind both the contract class and the diagnostics reason', () => {
    const error = new GitHubQualificationReadError('GitHub qualification read failed HTTP 406', 1, 406);
    expect(classifyFailure(error)).toBe('contract');
    expect(isGithubDiffNotRenderableError(error)).toBe(true);
  });
});
