import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkerFailureDiagnostics, type WorkerCompletionAdapter } from '../../src/review/workerCompletion';
import { runPublishingReviewWorker, type PublishingCheckClient, type PublishingReviewDeps } from '../../src/cli/publishingReview';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { deriveCanonicalWorkerReviewEvidence, parseWorkerReviewCompletion, type WorkerReviewCompletion, type WorkerReviewResult } from '../../src/review/workerReviewCompletion';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { computeArbitration } from '../../src/review/reviewCore';
import type { WorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';
import type { PanelResult } from '../../src/panel/types';
import * as panelEngine from '../../src/panel/panelEngine';
import * as qualificationReader from '../../src/github/qualificationReader';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { logger } from '../../src/utils/logger';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const START = Date.parse('2026-09-09T12:00:00.000Z');
const COMPLETED = new Date(START + 1_000).toISOString();
const ENDPOINT = 'https://dispatch.example.invalid/api/dispatch/completion';
const PRIVATE_DETAIL = 'private_provider_transcript';
const TOKEN = 'ghs_fake_authoritative_worker';
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };

function fixture(options: { reviewEngine?: 'panel' | 'composed' | 'shadow' } = {}) {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 1 },
    ...(options.reviewEngine ? { review_engine: options.reviewEngine } : {}),
  } });
  const prepared = preparePublishingPolicy({ content, source: {
    repositoryId: 987, repository: 'example/policy', sha: 'e'.repeat(40), path: 'policy/review.json',
    contentDigest: createHash('sha256').update(content).digest('hex'),
  } }, transport);
  const envelope = { version: 'PreparedReviewExecution.v1', config: prepared.config, transport };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', REVIEW_PUBLICATION_MODE: 'app-gate', REVIEW_AUTHORITATIVE_GATE: 'true',
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`, REVIEW_REPOSITORY_ID: '123', REVIEW_REPO: 'example/project',
    REVIEW_PR_NUMBER: '42', REVIEW_HEAD_SHA: HEAD, REVIEW_BASE_SHA: BASE, REVIEW_EXECUTION_ATTEMPT: '2',
    REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest, REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
    REVIEW_PREPARED_CONFIG_JSON: JSON.stringify(envelope), REVIEW_COMPLETION_URL: ENDPOINT,
    REVIEW_MODEL: transport.model, OPENAI_BASE_URL: transport.baseUrl, OPENAI_API_KEY: 'vk_fake',
    GH_TOKEN: TOKEN, GITHUB_PUBLISH_TOKEN: TOKEN, REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
  };
  const usage = { prompt: 10, completion: 5, total: 15 };
  const panel: PanelResult = {
    headSha: HEAD,
    applicablePersonaIds: prepared.expectedPersonaIds,
    personas: prepared.expectedPersonaIds.map((id) => ({ id, required: id === 'sec-lane',
      providerId: 'bifrost', model: transport.model, decision: 'APPROVE', findings: [],
      usage, costUSD: null, durationMs: 25 })),
    optionalFailures: [], quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: transport.model, decision: 'RECONCILED', findings: [], usage, costUSD: null, durationMs: 10 },
    arbiter: { providerId: 'bifrost', model: transport.model, verdict: 'SHIP', rationale: 'Clean', usage, costUSD: null, durationMs: 10 },
  };
  const source = { baseSha: BASE, headSha: HEAD, diff: DIFF,
    diffDigest: createHash('sha256').update(DIFF).digest('hex'), githubReads: 3 as const };
  const checkClient = {
  createCheck: vi.fn<PublishingCheckClient['createCheck']>(async () => 4242),
  completeCheck: vi.fn<PublishingCheckClient['completeCheck']>(async () => undefined),
};
  const sourceLoader = vi.fn<NonNullable<PublishingReviewDeps['sourceLoader']>>().mockResolvedValue(source);
  const panelRunner = vi.fn<NonNullable<PublishingReviewDeps['panelRunner']>>().mockResolvedValue(panel);
  const client = { complete: vi.fn().mockRejectedValue(new Error('A test must never invoke a provider')) };
  const reportReviewResult = vi.fn<WorkerReviewCompletionAdapter['reportReviewResult']>().mockResolvedValue(undefined);
  const legacyFailure = vi.fn<WorkerCompletionAdapter['reportTerminalFailure']>(async () => undefined);
  const now = vi.fn().mockReturnValueOnce(START).mockReturnValue(START + 1_000);
  const deps: PublishingReviewDeps = { checkClient, sourceLoader, panelRunner, client, now,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const), reviewCompletion: { reportReviewResult } };
  const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  // Fail closed even if a future change accidentally escapes the injected seams.
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
  return { env, deps, prepared, envelope, panel, source, checkClient, sourceLoader, panelRunner,
    client, reportReviewResult, legacyFailure, errorLog, fetch };
}

function expectedEvent(f: ReturnType<typeof fixture>, result: WorkerReviewResult) {
  return { version: 'WorkerReviewCompletion.v1', runId: f.env.REVIEW_RUN_ID, repositoryId: 123,
    owner: 'example', repo: 'project', prNumber: 42, headSha: HEAD, baseSha: BASE,
    policyDigest: f.prepared.policy.effectivePolicyDigest, configDigest: f.prepared.policy.effectiveConfigDigest,
    executionAttempt: 2, result };
}

function cleanResult(): WorkerReviewResult {
  return { version: 'WorkerReviewResult.v1', completedAt: COMPLETED,
    // `fixture()`'s panel personas always carry `model`/`durationMs` (both required on
    // `PersonaLaneResult`), so `buildReviewResult` in `publishingReview.ts` always attaches a
    // `telemetry` object carrying at least those two fields -- "include per-lane model" per the
    // Stage 0 telemetry brief. A test that overrides `personas[n]` wholesale instead of spreading
    // this base value needs to add the same `telemetry` clause back in.
    personas: ['sec-lane', 'qual-lane'].map((id) => ({ id, decision: 'APPROVE', status: 'COMPLETE', findings: [],
      telemetry: { model: transport.model, durationMs: 25 } })),
    coverageComplete: true, quorumSatisfied: true };
}

function expectNoReview(f: ReturnType<typeof fixture>) {
  expect(f.sourceLoader).not.toHaveBeenCalled();
  expect(f.panelRunner).not.toHaveBeenCalled();
  expect(f.client.complete).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
}

function expectEvidenceOnlyCallback(payload: WorkerReviewCompletion) {
  expect(parseWorkerReviewCompletion(payload)).toEqual(payload);
  for (const container of [payload, payload.result]) {
    for (const authority of ['checkId', 'check_id', 'gateCheckId', 'target', 'targetUrl', 'resultUrl',
      'conclusion', 'externalId', 'appId', 'gateName']) {
      expect(container).not.toHaveProperty(authority);
    }
  }
}

describe('authoritative prepared publishing worker', () => {
  it('keeps composed policy on the deterministic admitted persona roster', async () => {
    const f = fixture({ reviewEngine: 'composed' });
    const composedReviewRunner = vi.fn<NonNullable<PublishingReviewDeps['composedReviewRunner']>>()
      .mockRejectedValue(new Error('authoritative execution must not use dynamic composed task ids'));
    f.deps.composedReviewRunner = composedReviewRunner;

    await runPublishingReviewWorker(f.env, f.deps);

    expect(f.panelRunner).toHaveBeenCalledOnce();
    expect(composedReviewRunner).not.toHaveBeenCalled();
    const completion = f.reportReviewResult.mock.calls[0]?.[0];
    expect(completion?.result.personas.map((persona) => persona.id)).toEqual(f.prepared.expectedPersonaIds);
    const parsedCompletion = parseWorkerReviewCompletion(completion);
    const { version: _version, result: _result, ...expectedCoordinates } = parsedCompletion;
    expect(deriveCanonicalWorkerReviewEvidence(parsedCompletion, {
      expectedCoordinates,
      expectedPersonaIds: f.prepared.expectedPersonaIds,
      changedFiles: parseChangedFiles(DIFF).files,
      coverageComplete: true,
      quorumSatisfied: true,
    })).toMatchObject({ valid: true, evidence: { verdict: 'SHIP', expectedLanes: 2, completedLanes: 2 } });
  });

  it('executes the exact admitted config instead of mutable policy, persona, and turn environment', async () => {
    const f = fixture();
    Object.assign(f.env, { REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'licensing,performance', budget: { max_investigation_turns: 3 },
    } }), REVIEW_PERSONAS: 'architecture', MAX_INVESTIGATION_TURNS: '3' });
    const receipt = await runPublishingReviewWorker(f.env, f.deps);
    expect(f.panelRunner).toHaveBeenCalledExactlyOnceWith({
      config: f.prepared.config, changedFiles: [{ path: 'src/a.ts', patch: DIFF }],
      repository: 'example/project', headSha: HEAD, repositoryVisibility: 'PRIVATE', client: f.client,
      jobId: f.env.REVIEW_RUN_ID, baseSha: BASE, prNumber: 42,
      signal: expect.any(AbortSignal),
      // This fixture's GH_TOKEN is a real `ghs_`-shaped read token and no
      // repoFileProviderFactory is injected, so the worker wires the default
      // full-repository grounding provider (REL- full-repo grounding): a
      // find_files/read_file/treeTruncated seam built from that token, never a
      // reason the exact-call assertion below should drift on its own.
      repoFileProvider: {
        findFiles: expect.any(Function), readFile: expect.any(Function), treeTruncated: expect.any(Function),
      },
      requestPolicy: { responseFormat: { type: 'json_object' } },
    });
    expect(f.panelRunner.mock.calls[0][0].config.default_max_turns).toBe(1);
    expect(f.panelRunner.mock.calls[0][0].config.personas.map((p) => p.id)).toEqual(['sec-lane', 'qual-lane']);
    expect(f.sourceLoader).toHaveBeenCalledExactlyOnceWith({ repo: 'example/project', prNumber: 42,
      expectedBaseSha: BASE, expectedHeadSha: HEAD, token: TOKEN });
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, cleanResult()));
    expect(parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0][0])).toEqual(expectedEvent(f, cleanResult()));
    expect(receipt).toMatchObject({ conclusion: 'success', verdict: 'SHIP', transport: 'bifrost', model: transport.model });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('creates and completes exactly one raw Review Yeti check, never the service-owned gate', async () => {
    const f = fixture();
    const baseUrl = 'https://github.example.invalid';
    const checkFetch = vi.fn<typeof fetch>().mockImplementation(async (_input, init) =>
      new Response(JSON.stringify(init?.method === 'POST' ? { id: 4242 } : {}), { status: 200 }));
    // ADR 0564 retains this raw producer. Exercise the real client serializer so
    // the test observes the check name instead of assuming it from a method spy.
    f.deps.checkClient = new GitHubInstallationClient({ token: TOKEN, baseUrl, fetchImplementation: checkFetch });
    expect(f.env).not.toHaveProperty('REVIEW_CHECK_ID');
    await runPublishingReviewWorker(f.env, f.deps);
    expect(checkFetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${baseUrl}/repos/example/project/check-runs`, 'POST'],
      [`${baseUrl}/repos/example/project/check-runs/4242`, 'PATCH'],
    ]);
    const created = JSON.parse(String(checkFetch.mock.calls[0][1]?.body));
    const completed = JSON.parse(String(checkFetch.mock.calls[1][1]?.body));
    expect(created).toMatchObject({ name: 'Review Yeti', head_sha: HEAD, status: 'in_progress' });
    expect(created.name).not.toBe('Review Yeti Gate');
    expect(completed).toMatchObject({ status: 'completed', conclusion: 'success', output: { title: 'Review Yeti: SHIP' } });
    expect(completed).not.toHaveProperty('name');
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, cleanResult()));
    expectEvidenceOnlyCallback(f.reportReviewResult.mock.calls[0][0]);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('durably records the authoritative completion before publishing the raw check conclusion', async () => {
    // Publication-order invariant: the service's gate publisher replays the
    // durably recorded terminal desired state onto the `Review Yeti Gate`
    // check. If the raw check reached GitHub first, a one-shot gate reader
    // would see raw success next to a still-pending gate -- the exact-head
    // window where the gate raced the durable verdict.
    const f = fixture();
    const order: string[] = [];
    f.reportReviewResult.mockImplementation(async () => { order.push('completion'); });
    f.deps.checkClient = {
      ...f.deps.checkClient,
      completeCheck: vi.fn(async () => { order.push('raw-check'); }),
    };
    await runPublishingReviewWorker(f.env, f.deps);
    expect(order).toEqual(['completion', 'raw-check']);
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, cleanResult()));
  });

  it('preserves failure when a configured lane never returned (silently missing)', async () => {
    // The silently-missing shape is the newest recoverable evidence: the
    // configured roster lists a lane that returned nothing at all -- no error,
    // no finding, no lane record. The wiring under test is the derivation
    // chain a hand-built-input test cannot pin: the panel's configured/returned
    // sets must produce missingConfiguredLaneCount > 0 with zero failed and
    // zero malformed lanes, or the unrepeatable terminal BLOCK comes back.
    const f = fixture();
    delete f.env.REVIEW_AUTHORITATIVE_GATE;
    delete f.env.REVIEW_PREPARED_CONFIG_JSON;
    delete f.deps.reviewCompletion;
    f.deps.completion = {
      reportTerminalFailure: f.legacyFailure,
      reportTerminalSuccess: vi.fn(async () => undefined),
    };
    f.env.REVIEW_PERSONAS = 'licensing';
    // Quorum cannot be satisfied while a configured lane is absent, and the
    // returned set is missing exactly one configured lane with zero failures.
    f.panel.quorum = { ...f.panel.quorum, satisfied: false };
    f.panel.personas = f.panel.personas.slice(1);

    await runPublishingReviewWorker(f.env, f.deps);

    // Fail closed: the raw check is a terminal failure, never green.
    expect(f.checkClient.completeCheck).toHaveBeenCalledTimes(1);
    const rawCall = f.checkClient.completeCheck.mock.calls[0] as unknown as [
      { conclusion: string; title: string; summary: string },
    ];
    const raw = rawCall[0];
    expect(raw.conclusion).toBe('failure');
    expect(raw.title).toBe('Review Yeti: review did not complete');
    expect(raw.summary).toContain('A configured reviewer lane did not return a result.');
    // The durable terminal event classifies the silent dropout as transport.
    expect(f.legacyFailure).toHaveBeenCalledTimes(1);
    const eventCall = f.legacyFailure.mock.calls[0] as unknown as [
      { failureClass: string; diagnostics: { recoverableIncompletePanel?: boolean } },
    ];
    const event = eventCall[0];
    expect(event.failureClass).toBe('transport');
    expect(event.diagnostics.recoverableIncompletePanel).toBe(true);
    expect(f.reportReviewResult).not.toHaveBeenCalled();
  });

  it('fails closed when a SHIP verdict stands on coverage that denies quorum', async () => {
    // The coverage guard is only reachable through runPublishingReviewWorker:
    // production is the sole caller, so a worker-level pin is what catches the
    // optional-argument regression (dropping the third argument at line 1351
    // compiles cleanly and would silently re-enable a SHIP published over a
    // quorum its own coverage line denies).
    const f = fixture();
    f.panel.quorum = { ...f.panel.quorum, satisfied: false };
    const rawCheck = vi.fn<PublishingCheckClient['completeCheck']>(async () => undefined);
    f.deps.checkClient = {
      ...f.deps.checkClient,
      completeCheck: rawCheck,
    };
    await runPublishingReviewWorker(f.env, f.deps);
    const conclusions = rawCheck.mock.calls
      .map((call: unknown[]) => ((call[0] as { conclusion: string }).conclusion));
    expect(conclusions).toEqual(['failure']);
    expect(f.reportReviewResult).toHaveBeenCalledTimes(1);
  });

  it('never publishes a green raw check when the completion acknowledgement fails', async () => {
    const f = fixture();
    const order2: string[] = [];
    f.reportReviewResult.mockRejectedValue(new Error('completion endpoint unreachable'));
    const rawCheckMock = vi.fn<PublishingCheckClient['completeCheck']>(async () => { order2.push('raw-check'); });
    f.deps.checkClient = {
      ...f.deps.checkClient,
      completeCheck: rawCheckMock,
    };
    // The worker rethrows after its fail-closed catch; the invariant under
    // test is that the raw check never carried a success conclusion.
    await expect(runPublishingReviewWorker(f.env, f.deps))
      .rejects.toThrow('completion endpoint unreachable');
    expect(f.reportReviewResult).toHaveBeenCalledTimes(1);
    const conclusions = rawCheckMock.mock.calls
      .map((call: unknown[]) => (call[0] as { conclusion: string }).conclusion);
    expect(conclusions).toEqual(['failure']);
  });

  it('emits optional persona failure evidence without provider transcripts or credentials', async () => {
    const f = fixture();
    f.panel.personas = [f.panel.personas[0]];
    f.panel.optionalFailures = [{ id: 'qual-lane', error: `429 ${PRIVATE_DETAIL} ${TOKEN}` }];
    f.panel.quorum.satisfied = false;
    const receipt = await runPublishingReviewWorker(f.env, f.deps);
    const expected = cleanResult();
    expected.quorumSatisfied = false;
    expected.personas[1] = { id: 'qual-lane', decision: 'ERROR', status: 'ERROR', findings: [], errorClass: 'rate_limit' };
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, expected));
    expect(receipt).toMatchObject({ conclusion: 'failure', verdict: 'BLOCK', failureClass: null });
    expect(f.checkClient.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      conclusion: 'failure', title: 'Review Yeti: BLOCK',
    }));
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(TOKEN);
  });

  it('forwards findings through the strict typed boundary while omitting operational metadata', async () => {
    const f = fixture();
    const finding = { severity: 'P2' as const, path: 'src/a.ts', line: 1, title: 'Validate input', body: 'Validate before use.',
      confidence: 80, recommendation: 'Validate before calling the dependency.', isArchitectural: true,
      fixOptions: [{ rank: 1, title: 'Guard', suggestionCode: 'validate();' }] };
    f.panel.personas[0].decision = 'FINDINGS';
    f.panel.personas[0].findings = [{ ...finding, suggestion: undefined, reporters: 2, providerTranscript: PRIVATE_DETAIL } as typeof finding];
    f.panel.personas[0].toolCalls = [{ tool: 'read', args: { token: TOKEN } }];
    await runPublishingReviewWorker(f.env, f.deps);
    const expected = cleanResult();
    // `toolCalls: 1` is the COUNT crossing the boundary -- never the array itself, so the
    // `{ tool: 'read', args: { token: TOKEN } }` record above must still be fully absent below.
    expected.personas[0] = { id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE', findings: [finding],
      telemetry: { model: transport.model, durationMs: 25, toolCalls: 1 } };
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, expected));
    expect(f.reportReviewResult.mock.calls[0][0].result.personas[0].findings[0]).not.toHaveProperty('suggestion');
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(TOKEN);
  });

  it('carries per-turn telemetry onto the authoritative WorkerReviewResult, additive and optional', async () => {
    // Stage 0 telemetry work: `PersonaLaneResult.turnUsages`/`aggregateUsage`/`toolTurns`/
    // `correctionTurns` are new fields on the panel's own output. `buildReviewResult` in
    // `publishingReview.ts` must carry them into the authoritative callback as an OPTIONAL
    // `telemetry` object on the persona -- optional so `WorkerReviewCompletion.v1` needs no version
    // bump -- and must NOT invent one for a lane that never reported them (the sibling
    // `qual-lane` below, which the fixture leaves untouched).
    const f = fixture();
    f.panel.personas[0] = {
      ...f.panel.personas[0],
      model: transport.model,
      turnsCount: 3,
      toolTurns: 1,
      correctionTurns: 1,
      aggregateUsage: { promptTokens: 450, completionTokens: 75, totalTokens: 525, cachedTokens: 80, costUSD: 0.0042 },
      turnUsages: [
        { turn: 1, kind: 'tool', promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 30, costUSD: 0.001, model: transport.model, durationMs: 40 },
        { turn: 2, kind: 'correction', promptTokens: 150, completionTokens: 25, totalTokens: 175, cachedTokens: 0, costUSD: 0.0012, model: transport.model, durationMs: 40 },
        { turn: 3, kind: 'final', promptTokens: 200, completionTokens: 30, totalTokens: 230, cachedTokens: 50, costUSD: 0.002, model: transport.model, durationMs: 40 },
      ],
    };

    await runPublishingReviewWorker(f.env, f.deps);

    const expected = cleanResult();
    expected.personas[0] = {
      ...expected.personas[0],
      telemetry: {
        model: transport.model,
        durationMs: 25,
        turnsCount: 3,
        toolTurns: 1,
        correctionTurns: 1,
        promptTokens: 450,
        completionTokens: 75,
        totalTokens: 525,
        cachedTokens: 80,
        costUSD: 0.0042,
        turnUsages: f.panel.personas[0].turnUsages,
      },
    } as typeof expected.personas[0];
    // `qual-lane` was never given `turnUsages`/`aggregateUsage`/`toolTurns`/`correctionTurns` on the
    // panel fixture -- only the base `model`/`durationMs` every completed lane always carries.
    // `cleanResult()`'s default telemetry already reflects exactly that, unmodified.
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, expected));
    expect(f.reportReviewResult.mock.calls[0][0].result.personas[1].telemetry).toEqual({
      model: transport.model, durationMs: 25,
    });
  });

  it.each(['TRUE', 'True', 'false', '1', 'yes', 'tru'])('rejects the authoritative flag typo %s before side effects', async (flag) => {
    const f = fixture();
    f.env.REVIEW_AUTHORITATIVE_GATE = flag;
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow('publishing review worker contract is invalid');
    expectNoReview(f);
    expect(f.checkClient.createCheck).not.toHaveBeenCalled();
    expect(f.reportReviewResult).not.toHaveBeenCalled();
  });

  it.each(['missing flag', 'missing URL', 'missing adapter', 'legacy adapter', 'check ID'])('rejects %s without silently taking the legacy lane', async (variant) => {
    const f = fixture();
    if (variant === 'missing flag') delete f.env.REVIEW_AUTHORITATIVE_GATE;
    if (variant === 'missing URL') delete f.env.REVIEW_COMPLETION_URL;
    if (variant === 'missing adapter') delete f.deps.reviewCompletion;
    if (variant === 'legacy adapter') f.deps.completion = {
      reportTerminalFailure: f.legacyFailure,
      reportTerminalSuccess: vi.fn(async () => undefined),
    };
    if (variant === 'check ID') f.env.REVIEW_CHECK_ID = '4242';
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow('publishing review worker contract is invalid');
    expectNoReview(f);
    expect(f.checkClient.createCheck).not.toHaveBeenCalled();
    expect(f.checkClient.completeCheck).not.toHaveBeenCalled();
    expect(f.reportReviewResult).not.toHaveBeenCalled();
    expect(f.legacyFailure).not.toHaveBeenCalled();
  });

  it.each(['missing JSON', 'malformed JSON', 'extra envelope field', 'tampered config', 'wrong config digest', 'wrong model', 'wrong URL'])
    ('rejects %s before source or provider execution', async (variant) => {
      const f = fixture();
      if (variant === 'missing JSON') delete f.env.REVIEW_PREPARED_CONFIG_JSON;
      if (variant === 'malformed JSON') f.env.REVIEW_PREPARED_CONFIG_JSON = `{${PRIVATE_DETAIL}`;
      if (variant === 'extra envelope field') f.env.REVIEW_PREPARED_CONFIG_JSON = JSON.stringify({ ...f.envelope, override: { verdict: 'SHIP' } });
      if (variant === 'tampered config') f.env.REVIEW_PREPARED_CONFIG_JSON = JSON.stringify({ ...f.envelope,
        config: { ...f.prepared.config, default_max_turns: 3 } });
      if (variant === 'wrong config digest') f.env.REVIEW_CONFIG_DIGEST = 'f'.repeat(64);
      if (variant === 'wrong model') f.env.REVIEW_MODEL = 'different-model';
      if (variant === 'wrong URL') f.env.OPENAI_BASE_URL = 'https://other.example.invalid/v1';
      await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow('Prepared review execution does not match its admitted identity');
      expectNoReview(f);
      expect(f.reportReviewResult).toHaveBeenCalledTimes(1);
      expect(f.reportReviewResult.mock.calls[0][0].result).toEqual({ version: 'WorkerReviewResult.v1',
        completedAt: COMPLETED, personas: [], coverageComplete: false, quorumSatisfied: false,
        failureDiagnostics: buildWorkerFailureDiagnostics(new Error('Prepared review execution does not match its admitted identity'), 'internal_error') });
    });

  it.each([
    ['request timed out', 'timeout'], ['429 rate limit', 'rate_limit'], ['403 unauthorized', 'auth'],
    ['ECONNREFUSED', 'transport'], ['budget exhausted', 'budget_exhausted'], ['provider exploded', 'provider_error'],
  ] as const)('reports typed fail-closed evidence for provider failure %s', async (message, errorClass) => {
    const f = fixture();
    const original = new Error(`${message} ${PRIVATE_DETAIL} ${TOKEN}`);
    f.panelRunner.mockRejectedValue(original);
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(original);
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, {
      version: 'WorkerReviewResult.v1', completedAt: COMPLETED,
      personas: ['sec-lane', 'qual-lane'].map((id) => ({ id, decision: 'ERROR', status: 'ERROR', findings: [], errorClass })),
      coverageComplete: false, quorumSatisfied: false,
      failureDiagnostics: buildWorkerFailureDiagnostics(original, errorClass),
    }));
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(f.errorLog.mock.calls)).not.toContain(TOKEN);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('reports source-read failure as typed evidence before the panel is invoked', async () => {
    const f = fixture();
    const original = new Error(`fetch failed ${PRIVATE_DETAIL}`);
    f.sourceLoader.mockRejectedValue(original);
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(original);
    expect(f.panelRunner).not.toHaveBeenCalled();
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, {
      version: 'WorkerReviewResult.v1', completedAt: COMPLETED,
      personas: ['sec-lane', 'qual-lane'].map((id) => ({ id, decision: 'ERROR', status: 'ERROR', findings: [], errorClass: 'transport' })),
      coverageComplete: false, quorumSatisfied: false,
      failureDiagnostics: buildWorkerFailureDiagnostics(original, 'transport'),
    }));
  });

  it.each(['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'REVIEW_MODEL'])('reports a missing %s as a fail-closed pre-execution contract failure', async (name) => {
    const f = fixture();
    delete f.env[name];
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow('publishing review worker contract is invalid');
    expectNoReview(f);
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, {
      version: 'WorkerReviewResult.v1', completedAt: COMPLETED, personas: [],
      coverageComplete: false, quorumSatisfied: false,
      failureDiagnostics: buildWorkerFailureDiagnostics(new Error('publishing review worker contract is invalid'), 'contract'),
    }));
  });

  it('marks partial diff coverage false even when the reviewed file has a clean panel', async () => {
    const f = fixture();
    f.source.diff += 'diff --git unreadable-header\n';
    const receipt = await runPublishingReviewWorker(f.env, f.deps);
    expect(receipt.conclusion).toBe('failure');
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, {
      ...cleanResult(), coverageComplete: false,
    }));
  });

  it('cannot turn an empty diff into clean completion evidence', async () => {
    const f = fixture();
    f.source.diff = '';
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow('no reviewable diff');
    expect(f.panelRunner).not.toHaveBeenCalled();
    expect(f.reportReviewResult).toHaveBeenCalledTimes(1);
    expect(f.reportReviewResult.mock.calls[0][0].result).toMatchObject({ coverageComplete: false, quorumSatisfied: false });
    expect(f.reportReviewResult.mock.calls[0][0].result.personas.every((p) => p.decision === 'ERROR')).toBe(true);
  });

  it('does not replace an externally accepted result when its acknowledgement is lost', async () => {
    const f = fixture();
    const accepted: unknown[] = [];
    const lostAck = new Error(`ACK lost ${PRIVATE_DETAIL}`);
    f.reportReviewResult.mockImplementation(async (payload) => {
      accepted.push(structuredClone(payload));
      throw lostAck;
    });
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(lostAck);
    expect(accepted).toEqual([expectedEvent(f, cleanResult())]);
    expect(f.reportReviewResult).toHaveBeenCalledTimes(1);
    expect(f.panelRunner).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.errorLog.mock.calls)).not.toContain(PRIVATE_DETAIL);
  });

  it('does not retry a failing error callback or replace the original provider failure', async () => {
    const f = fixture();
    const original = new Error('request timed out');
    f.panelRunner.mockRejectedValue(original);
    f.reportReviewResult.mockRejectedValue(new Error(`${PRIVATE_DETAIL} callback lost`));
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(original);
    expect(f.reportReviewResult).toHaveBeenCalledTimes(1);
    expect(f.reportReviewResult.mock.calls[0][0].result.personas.map((p) => p.errorClass)).toEqual(['timeout', 'timeout']);
    expect(JSON.stringify(f.errorLog.mock.calls)).not.toContain(PRIVATE_DETAIL);
  });

  it('preserves legacy check publishing and mutable configuration when authoritative mode is absent', async () => {
    const f = fixture();
    delete f.env.REVIEW_AUTHORITATIVE_GATE;
    delete f.env.REVIEW_PREPARED_CONFIG_JSON;
    delete f.deps.reviewCompletion;
    f.deps.completion = {
      reportTerminalFailure: f.legacyFailure,
      reportTerminalSuccess: vi.fn(async () => undefined),
    };
    f.env.REVIEW_PERSONAS = 'licensing';
    f.env.MAX_INVESTIGATION_TURNS = '3';
    await runPublishingReviewWorker(f.env, f.deps);
    expect(f.panelRunner.mock.calls[0][0].config.personas.map((p) => p.id)).toEqual(['policy-lane']);
    expect(f.panelRunner.mock.calls[0][0].config.default_max_turns).toBe(3);
    expect(f.checkClient.createCheck).toHaveBeenCalledExactlyOnceWith('example', 'project', HEAD,
      `${f.env.REVIEW_RUN_ID}:a${f.env.REVIEW_EXECUTION_ATTEMPT}`);
    expect(f.checkClient.completeCheck).toHaveBeenCalledTimes(1);
    expect(f.legacyFailure).not.toHaveBeenCalled();
    expect(f.reportReviewResult).not.toHaveBeenCalled();
  });

  it.each(['recorded', '503 then recorded', 'lost acknowledgement then duplicate', 'off-diff raw finding'])('wires the entrypoint to one raw check and evidence-only callback: %s', async (delivery) => {
    const f = fixture();
    const finding = { severity: 'P2' as const, path: 'src/a.ts', line: 1,
      title: 'Preserve raw finding', body: 'This finding remains visible independently of gate eligibility.' };
    f.panel.personas[0].decision = 'FINDINGS';
    f.panel.personas[0].findings = [finding];
    if (delivery === 'off-diff raw finding') f.panel.personas[0].findings.push({
      severity: 'P1', path: 'src/not-in-diff.ts', line: 99,
      title: 'Discard unanchorable raw finding', body: 'This raw finding is not part of the reviewed diff.',
    });
    vi.spyOn(qualificationReader, 'loadSameHeadReviewSource').mockResolvedValue(f.source);
    vi.spyOn(panelEngine, 'executePersonaPanel').mockResolvedValue(f.panel);
    const createCheck = vi.spyOn(GitHubInstallationClient.prototype, 'createCheck');
    const completeCheck = vi.spyOn(GitHubInstallationClient.prototype, 'completeCheck');
    const rawEndpoint = 'https://api.github.com/repos/example/project/check-runs';
    let callbackAttempts = 0;
    const derivations: ReturnType<typeof deriveCanonicalWorkerReviewEvidence>[] = [];
    f.fetch.mockImplementation(async (input, init) => {
      if (String(input) === rawEndpoint && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
      }
      if (String(input) === `${rawEndpoint}/4242` && init?.method === 'PATCH') {
        return new Response('{}', { status: 200 });
      }
      if (String(input) === ENDPOINT && init?.method === 'POST') {
        // The service can acknowledge persistence even for invalid evidence.
        // Inspect its actual derivation separately from delivery acknowledgement.
        const completion = parseWorkerReviewCompletion(JSON.parse(String(init.body)));
        const { result: _result, version: _version, ...expectedCoordinates } = parseWorkerReviewCompletion(expectedEvent(f, cleanResult()));
        const derived = deriveCanonicalWorkerReviewEvidence(completion, {
          expectedCoordinates, expectedPersonaIds: f.prepared.expectedPersonaIds,
          changedFiles: parseChangedFiles(DIFF).files, coverageComplete: true, quorumSatisfied: true,
        });
        derivations.push(derived);
        callbackAttempts += 1;
        if (callbackAttempts === 1 && delivery === '503 then recorded') {
          return new Response(PRIVATE_DETAIL, { status: 503 });
        }
        if (callbackAttempts === 1 && delivery === 'lost acknowledgement then duplicate') {
          throw new TypeError(PRIVATE_DETAIL);
        }
        return new Response(JSON.stringify({ version: 'WorkerReviewCompletionAccepted.v1',
          runId: f.env.REVIEW_RUN_ID, status: delivery === 'lost acknowledgement then duplicate' ? 'duplicate' : 'recorded' }), { status: 200 });
      }
      throw new Error('Unexpected request in the mocked worker entrypoint');
    });
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const legacy = vi.fn();
    expect(f.env).not.toHaveProperty('REVIEW_CHECK_ID');
    await runWorker(f.env, legacy);
    for (const derived of derivations) {
      expect(derived.valid).toBe(true);
      expect(derived.evidence).toMatchObject({ verdict: 'SHIP', p0Count: 0, p1Count: 0 });
      expect(derived.canonical?.findings).toEqual([{ ...finding, reporters: 1 }]);
    }
    expect(legacy).not.toHaveBeenCalled();
    const retry = delivery === '503 then recorded' || delivery === 'lost acknowledgement then duplicate';
    expect(derivations).toHaveLength(retry ? 2 : 1);
    expect(f.fetch).toHaveBeenCalledTimes(retry ? 4 : 3);
    const rawCalls = f.fetch.mock.calls.filter(([url]) => String(url).startsWith(rawEndpoint));
    expect(rawCalls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [rawEndpoint, 'POST'], [`${rawEndpoint}/4242`, 'PATCH'],
    ]);
    const created = JSON.parse(String(rawCalls[0][1]?.body));
    const completed = JSON.parse(String(rawCalls[1][1]?.body));
    expect(created).toMatchObject({ name: 'Review Yeti', head_sha: HEAD, status: 'in_progress',
      external_id: `${f.env.REVIEW_RUN_ID}:a${f.env.REVIEW_EXECUTION_ATTEMPT}` });
    expect(created.name).not.toBe('Review Yeti Gate');
    expect(completed).not.toHaveProperty('name');
    expect(completed).toMatchObject({ status: 'completed', output: {
      text: expect.stringContaining(finding.title),
      annotations: [{ path: finding.path, start_line: 1, end_line: 1,
        annotation_level: 'warning', title: `P2: ${finding.title}`, message: finding.body }],
    } });
    expect(completed.output.text).toContain(finding.body);
    expect(completed.conclusion).toBe('success');
    if (delivery === 'off-diff raw finding') {
      expect(completed.output.summary).toContain('1 raw finding(s) were discarded as unanchorable');
      expect(completed.output.text).not.toContain('Discard unanchorable raw finding');
    }
    expect(createCheck).toHaveBeenCalledExactlyOnceWith('example', 'project', HEAD,
      `${f.env.REVIEW_RUN_ID}:a${f.env.REVIEW_EXECUTION_ATTEMPT}`);
    expect(completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      owner: 'example', repo: 'project', checkId: 4242,
    }));
    const callbacks = f.fetch.mock.calls.filter(([url]) => String(url) === ENDPOINT);
    expect(callbacks).toHaveLength(retry ? 2 : 1);
    expect(new Set(callbacks.map(([, init]) => init?.body)).size).toBe(1);
    expect(panelEngine.executePersonaPanel).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.errorLog.mock.calls)).not.toContain(PRIVATE_DETAIL);
    const [endpoint, init] = callbacks[0];
    expect(endpoint).toBe(ENDPOINT);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    const payload = JSON.parse(String(init?.body));
    expectEvidenceOnlyCallback(payload);
    expect(payload).toMatchObject({ version: 'WorkerReviewCompletion.v1', configDigest: f.prepared.policy.effectiveConfigDigest });
    expect(payload.result.personas[0].findings).toEqual([finding]);
  });

  it('keeps sanitized findings in their original lanes and re-derives the published clustered set', async () => {
    const f = fixture();
    const shared = { severity: 'P2' as const, path: 'src/a.ts', line: 1,
      title: 'Clarify returned value', body: 'Document the returned value for callers.' };
    const unique = { severity: 'P2' as const, path: 'src/a.ts', line: 1,
      title: 'Rename misleading timestamp', body: 'The variable name should identify UTC timestamps.' };
    f.panel.personas[0].decision = 'FINDINGS';
    f.panel.personas[0].findings = [shared, { ...unique, path: 'src/off-diff.ts' }];
    f.panel.personas[1].decision = 'FINDINGS';
    f.panel.personas[1].findings = [unique, shared, { ...unique, line: 99 }];
    const original = structuredClone(f.panel.personas);
    await runPublishingReviewWorker(f.env, f.deps);
    const completion = f.reportReviewResult.mock.calls[0][0];
    expect(completion.result.personas.map((persona) => ({ id: persona.id, decision: persona.decision, findings: persona.findings })))
      .toEqual([
        { id: 'sec-lane', decision: 'FINDINGS', findings: [shared] },
        { id: 'qual-lane', decision: 'FINDINGS', findings: [unique, shared] },
      ]);
    expect(completion.result.personas.map((persona) => persona.telemetry)).toEqual(cleanResult().personas.map((persona) => persona.telemetry));
    expect(f.panel.personas).toEqual(original);
    const { result: _result, version: _version, ...expectedCoordinates } = parseWorkerReviewCompletion(expectedEvent(f, cleanResult()));
    const changedFiles = parseChangedFiles(DIFF).files;
    const derived = deriveCanonicalWorkerReviewEvidence(completion, {
      expectedCoordinates, expectedPersonaIds: f.prepared.expectedPersonaIds,
      changedFiles, coverageComplete: true, quorumSatisfied: true,
    });
    expect(derived.valid).toBe(true);
    const published = computeArbitration(original, 2, { changedFiles, coverageComplete: true });
    expect(published.findings).toHaveLength(2);
    expect(derived.canonical?.findings).toEqual(published.findings);
    expect(derived.evidence).toMatchObject({ verdict: 'SHIP', coverageComplete: true, quorumSatisfied: true });

    // Worker normalization is not permission for an arbitrary sender to submit
    // an off-diff finding. The service's strict validator must still reject it.
    const forged = structuredClone(completion);
    forged.result.personas[0].findings.push({ ...shared, path: 'src/off-diff.ts' });
    expect(deriveCanonicalWorkerReviewEvidence(forged, {
      expectedCoordinates, expectedPersonaIds: f.prepared.expectedPersonaIds,
      changedFiles, coverageComplete: true, quorumSatisfied: true,
    })).toMatchObject({ valid: false, reason: 'invalid-evidence' });
  });

  it.each(['incomplete panel', 'unreadable diff'])('discarded raw findings cannot turn an %s into approval', async (kind) => {
    const f = fixture();
    f.panel.personas[0].decision = 'FINDINGS';
    f.panel.personas[0].findings = [{ severity: 'P1', path: 'src/off-diff.ts', line: 1,
      title: 'Not anchored', body: 'Not part of the published canonical set.' }];
    if (kind === 'incomplete panel') {
      f.panel.personas.pop();
      f.panel.optionalFailures = [{ id: 'qual-lane', error: 'request timed out' }];
      f.panel.quorum.satisfied = false;
    } else f.source.diff += 'diff --git unreadable-header\n';
    const published = await runPublishingReviewWorker(f.env, f.deps);
    expect(published).toMatchObject({ conclusion: 'failure', verdict: 'BLOCK' });
    const completion = f.reportReviewResult.mock.calls[0][0];
    expect(completion.result.personas[0]).toMatchObject({ id: 'sec-lane', decision: 'FINDINGS', findings: [] });
    const { result: _result, version: _version, ...expectedCoordinates } = parseWorkerReviewCompletion(expectedEvent(f, cleanResult()));
    const derived = deriveCanonicalWorkerReviewEvidence(completion, {
      expectedCoordinates, expectedPersonaIds: f.prepared.expectedPersonaIds,
      changedFiles: parseChangedFiles(DIFF).files,
      coverageComplete: kind !== 'unreadable diff', quorumSatisfied: kind !== 'incomplete panel',
    });
    expect(derived.valid).toBe(true);
    expect(derived.evidence).toMatchObject({ verdict: 'BLOCK', quorumSatisfied: false });
  });
});
