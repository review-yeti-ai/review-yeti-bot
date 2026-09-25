import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishingReviewWorker, type PublishingCheckClient, type PublishingReviewDeps } from '../../src/cli/publishingReview';
import {
  executePersonaPanel,
  extractMessageContentText,
  PanelCancellationError,
  PanelConfigurationError,
  PanelInfrastructureError,
} from '../../src/panel/panelEngine';
import { ctReviewConfigV3Schema, type CtReviewConfigV3 } from '../../src/config/schema';
import type { OmniRouteClient } from '../../src/gateway/omniRouteClient';
import { OpenRouterConnectionError, OpenRouterResponseError } from '../../src/gateway/openRouterClient';
import type { PanelResult } from '../../src/panel/types';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { isInfrastructureIncompleteResult } from '../../src/review/publicationFailurePolicy';
import {
  AUTHORITATIVE_INFRASTRUCTURE_FAILURE_ERROR_TEXT,
  requeueAuthoritativeInfrastructureIncomplete,
  requeueRecoverableIncompletePanelFailure,
} from '../../src/review/recoverablePanelRetry';
import { buildReviewRunIdentity, deriveReviewRunId } from '../../src/review/reviewAdmission';
import { isRecoverableFailureTitle } from '../../src/review/reviewCheckIdentity';
import { evaluateReviewGate } from '../../src/review/reviewGatePolicy';
import {
  attachPanelFailureEvidence,
  isInfrastructureFailureClass,
  markThrownByPanel,
  panelFailureEvidenceOf,
  thrownPanelInfrastructureFailure,
} from '../../src/review/thrownPanelInfrastructure';
import type { WorkerCompletionAdapter, WorkerTerminalFailure } from '../../src/review/workerCompletion';
import { deriveCanonicalWorkerReviewEvidence, parseWorkerReviewCompletion, type WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import type { WorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { PATCH_UNAVAILABLE_MARKER } from '../../src/review/patchAvailability';
import { logger } from '../../src/utils/logger';

/*
 * REL-1124 (REL-1113 follow-up): a panel that THROWS on the path to the model -- a required
 * sec-lane lost to `fetch failed`, the arbiter or moderator cut by a `terminated` stream or a
 * gateway 502, a raw connection error -- ended "Failed live ct-review-bot review dispatch" with no
 * re-attempt (21 such failures on 2026-09-24; the INCOMPLETE path fired 0 times in production).
 * These tests reproduce each thrown shape and prove it now reaches the SAME shared decision as a
 * returned panel: INCOMPLETE, re-attempted (a2/a3), never a verdict, with the worker and the
 * trusted completion side agreeing.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const START = Date.parse('2026-09-25T12:00:00.000Z');
const ENDPOINT = 'https://dispatch.example.invalid/api/dispatch/completion';
const PRIVATE_DETAIL = 'private_provider_transcript';
const TOKEN = 'ghs_fake_authoritative_worker';
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };
const VERDICT_WORDS = /BLOCK|FIX_FIRST|SHIP|did not complete/u;

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(executionAttempt = '1') {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 1 },
  } });
  const prepared = preparePublishingPolicy({ content, source: {
    repositoryId: 987, repository: 'example/policy', sha: 'e'.repeat(40), path: 'policy/review.json',
    contentDigest: createHash('sha256').update(content).digest('hex'),
  } }, transport);
  const envelope = { version: 'PreparedReviewExecution.v1', config: prepared.config, transport };
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test', REVIEW_PUBLICATION_MODE: 'app-gate', REVIEW_AUTHORITATIVE_GATE: 'true',
    REVIEW_RUN_ID: `run_${'c'.repeat(32)}`, REVIEW_REPOSITORY_ID: '123', REVIEW_REPO: 'example/project',
    REVIEW_PR_NUMBER: '42', REVIEW_HEAD_SHA: HEAD, REVIEW_BASE_SHA: BASE, REVIEW_EXECUTION_ATTEMPT: executionAttempt,
    REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest, REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
    REVIEW_PREPARED_CONFIG_JSON: JSON.stringify(envelope), REVIEW_COMPLETION_URL: ENDPOINT,
    REVIEW_MODEL: transport.model, OPENAI_BASE_URL: transport.baseUrl, OPENAI_API_KEY: 'vk_fake',
    GH_TOKEN: TOKEN, GITHUB_PUBLISH_TOKEN: TOKEN, REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
  };
  const source = { baseSha: BASE, headSha: HEAD, diff: DIFF,
    diffDigest: createHash('sha256').update(DIFF).digest('hex'), githubReads: 3 as const };
  const checkClient = {
    createCheck: vi.fn<PublishingCheckClient['createCheck']>(async () => 4242),
    completeCheck: vi.fn<PublishingCheckClient['completeCheck']>(async () => undefined),
    updateCheck: vi.fn(async () => undefined),
  };
  const sourceLoader = vi.fn<NonNullable<PublishingReviewDeps['sourceLoader']>>().mockResolvedValue(source);
  const panelRunner = vi.fn<NonNullable<PublishingReviewDeps['panelRunner']>>();
  const client = { complete: vi.fn().mockRejectedValue(new Error('A test must never invoke a provider')) };
  const reportReviewResult = vi.fn<WorkerReviewCompletionAdapter['reportReviewResult']>().mockResolvedValue(undefined);
  const now = vi.fn().mockReturnValueOnce(START).mockReturnValue(START + 1_000);
  const deps: PublishingReviewDeps = { checkClient, sourceLoader, panelRunner, client, now,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const), reviewCompletion: { reportReviewResult } };
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
  return { env, deps, prepared, source, checkClient, sourceLoader, panelRunner, reportReviewResult, warn };
}

// ---- The thrown shapes, exactly as `executePersonaPanel` now throws them (pinned below by the
// ---- real-panel tests). Each carries private provider text that must never be published.

function requiredSecLaneFetchFailed() {
  return attachPanelFailureEvidence(new PanelInfrastructureError(
    `required persona failure: persona sec-lane failed closed: bifrost: OpenRouter SDK connection failure for model pr-reviewer: fetch failed ${PRIVATE_DETAIL}`,
    { failureClass: 'transport' }), {
    stage: 'lanes', lanes: [{ id: 'sec-lane', failureClass: 'transport' }], findingsObserved: false,
  });
}

function arbiterTerminated() {
  return attachPanelFailureEvidence(new PanelInfrastructureError(
    `arbiter failed closed: bifrost: OpenRouter SDK connection failure for model pr-reviewer: terminated ${PRIVATE_DETAIL}`), {
    stage: 'arbiter', lanes: [{ id: 'arbiter', failureClass: 'transport' }], findingsObserved: false,
  });
}

function moderatorGateway502() {
  return attachPanelFailureEvidence(new OpenRouterResponseError(
    `bifrost: gateway-internal.calltelemetry.com HTTP 502: <html>nginx</html> ${PRIVATE_DETAIL}`, 502), {
    stage: 'moderator', lanes: [{ id: 'moderator', failureClass: 'provider_error', providerStatus: 502 }], findingsObserved: false,
  });
}

function rawConnectionError() {
  // #834's final call: a raw connection error with no lane evidence, escaping the panel.
  return new OpenRouterConnectionError(`OpenRouter SDK connection failure for model pr-reviewer: fetch failed ${PRIVATE_DETAIL}`);
}

const SHAPES = [
  ['a required sec-lane `fetch failed`', requiredSecLaneFetchFailed, 'transport', 'lane sec-lane failed: transport'],
  ['an arbiter `terminated` stream', arbiterTerminated, 'transport', 'lane arbiter failed: transport'],
  ['a moderator gateway 502', moderatorGateway502, 'provider_error', 'lane moderator failed: 502'],
  ['a raw connection error `fetch failed`', rawConnectionError, 'transport', 'lane panel failed: transport'],
  ['a raw `terminated` stream', () => new Error(`terminated ${PRIVATE_DETAIL}`), 'transport', 'lane panel failed: transport'],
] as const;

function trustedSide(f: ReturnType<typeof fixture>, completion: WorkerReviewCompletion) {
  const { version: _version, result: _result, ...expectedCoordinates } = completion;
  const derived = deriveCanonicalWorkerReviewEvidence(completion, {
    expectedCoordinates, expectedPersonaIds: f.prepared.expectedPersonaIds,
    changedFiles: parseChangedFiles(DIFF).files, coverageComplete: true, quorumSatisfied: true,
  });
  const candidate = { repositoryId: 123, prNumber: 42, headSha: HEAD, baseSha: BASE, policyDigest: f.prepared.policy.effectivePolicyDigest };
  const decision = derived.valid
    ? evaluateReviewGate({ candidate, current: { ...candidate, open: true, draft: false }, evidence: derived.evidence })
    : undefined;
  return { derived, decision };
}

async function serviceRequeue(completion: WorkerReviewCompletion) {
  const identity = buildReviewRunIdentity({ owner: 'example', repo: 'project', prNumber: 42, headSha: HEAD, baseSha: BASE });
  const admit = vi.fn(async () => ({}) as never);
  // The fixture's run id is a placeholder; the service derives the run id from the identity it
  // re-resolves, so the event carries that derived id here.
  const outcome = await requeueAuthoritativeInfrastructureIncomplete({
    event: { ...completion, runId: deriveReviewRunId(identity) }, now: START,
    repository: { admit, readRunRetryContext: vi.fn(async () => ({ publicationMode: 'app-gate' as const,
      authoritativeGateAppId: 777, repositoryId: 123, installationId: 55, identity,
      runStatus: 'failed', errorText: AUTHORITATIVE_INFRASTRUCTURE_FAILURE_ERROR_TEXT })) },
    authoritative: { expectedAppId: 777, repositoryIds: [123],
      resolver: { resolve: vi.fn(async () => ({ identity, prepared: { policy: { effectivePolicyDigest: 'd'.repeat(64) } } })) } as never },
    logger: { error: vi.fn(), info: vi.fn() },
  });
  return { outcome, admit };
}

describe('REL-1124: thrown panel infrastructure failures are INCOMPLETE and re-attempted (authoritative)', () => {
  it.each(SHAPES)('%s on attempt 1: INCOMPLETE, re-attempt 2 of 3, never a verdict', async (_label, make, failureClass, detail) => {
    const f = fixture('1');
    f.panelRunner.mockRejectedValue(make());

    // Negative proof: before REL-1124 this rejected, and the run ended "Failed live".
    const receipt = await runPublishingReviewWorker(f.env, f.deps);
    expect(receipt).toMatchObject({ verdict: 'INCOMPLETE', conclusion: 'failure', failureClass, findingCount: 0 });

    const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
    expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
    expect(check).toMatchObject({ conclusion: 'failure',
      title: `Review Yeti: INCOMPLETE — infrastructure (${detail}); retrying as attempt 2 of 3` });
    expect(check?.title).not.toMatch(VERDICT_WORDS);
    expect(isRecoverableFailureTitle(check?.title)).toBe(true);
    expect(check?.summary).toContain('not a review verdict');
    expect(check?.summary).toContain('A fresh attempt (2 of 3) is scheduled automatically');

    // The worker's body satisfies the shared decision ...
    const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(f.reportReviewResult).toHaveBeenCalledOnce();
    expect(completion.result).toMatchObject({ coverageComplete: true, quorumSatisfied: false,
      failureDiagnostics: { reason: 'lane_infrastructure_incomplete', recoverableIncompletePanel: true } });
    expect(completion.result.personas.map((p) => [p.id, p.decision, p.errorClass, p.findings.length]))
      .toEqual(f.prepared.expectedPersonaIds.map((id) => [id, 'ERROR', failureClass, 0]));
    expect(isInfrastructureIncompleteResult(completion.result)).toBe(true);
    // ... the trusted side records it as an infrastructure failure (never blocking-findings) ...
    const { derived, decision } = trustedSide(f, completion);
    expect(derived).toMatchObject({ valid: true, evidence: { infrastructureFailure: true, p0Count: 0, p1Count: 0 } });
    expect(decision).toEqual({ status: 'failure', eligible: false, reason: 'infrastructure-failure' });
    // ... and re-admits the exact head as attempt 2 from that same payload.
    const { outcome, admit } = await serviceRequeue(completion);
    expect(outcome).toBe('requeued');
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ retryRequested: true, retryAfterExecutionAttempt: 1,
      eventName: 'internal_infrastructure_incomplete_retry' }));

    // Countable reason class, and nothing private leaves the process.
    expect(f.warn).toHaveBeenCalledWith('Review incomplete: the review panel failed on infrastructure; not a review verdict',
      expect.objectContaining({ reasonClass: 'incomplete_infra', retryScheduled: true }));
    for (const published of [f.reportReviewResult.mock.calls, f.checkClient.completeCheck.mock.calls]) {
      expect(JSON.stringify(published)).not.toContain(PRIVATE_DETAIL);
      expect(JSON.stringify(published)).not.toContain(TOKEN);
    }
  });

  it.each(SHAPES)('%s on attempt 3 (cap): INCOMPLETE with no further re-attempt', async (_label, make, _failureClass, detail) => {
    const f = fixture('3');
    f.panelRunner.mockRejectedValue(make());
    await expect(runPublishingReviewWorker(f.env, f.deps)).resolves.toMatchObject({ verdict: 'INCOMPLETE' });
    const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
    expect(check?.title).toBe(`Review Yeti: INCOMPLETE — infrastructure (${detail})`);
    expect(check?.summary).toContain('was the last automatic attempt (3 of 3)');
    const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(isInfrastructureIncompleteResult(completion.result)).toBe(true);
    const { outcome, admit } = await serviceRequeue(completion);
    expect(outcome).toBe('attempts-exhausted');
    expect(admit).not.toHaveBeenCalled();
  });

  it('keeps the original failure (and exit) when the INCOMPLETE body could not be delivered', async () => {
    const f = fixture('1');
    const original = requiredSecLaneFetchFailed();
    f.panelRunner.mockRejectedValue(original);
    f.reportReviewResult.mockRejectedValue(new Error('completion endpoint unreachable'));
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(original);
  });
});

describe('REL-1124 negative proof: everything else keeps the pre-existing terminal failure', () => {
  async function expectUnchangedFailure(f: ReturnType<typeof fixture>, original: unknown) {
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(original);
    const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(completion.result.coverageComplete).toBe(false);
    expect(completion.result.failureDiagnostics?.reason).not.toBe('lane_infrastructure_incomplete');
    expect(isInfrastructureIncompleteResult(completion.result)).toBe(false);
    const title = f.checkClient.completeCheck.mock.calls[0]?.[0]?.title;
    expect(title).toBe('Review Yeti: review did not complete');
    expect(title).not.toMatch(/INCOMPLETE/u);
  }

  it('a completed lane reported a finding (a finding is never re-rolled as infrastructure)', async () => {
    const f = fixture('1');
    const original = attachPanelFailureEvidence(new PanelInfrastructureError('required persona failure: fetch failed'), {
      stage: 'lanes', lanes: [{ id: 'sec-lane', failureClass: 'transport' }], findingsObserved: true });
    f.panelRunner.mockRejectedValue(original);
    await expectUnchangedFailure(f, original);
  });

  it('the arbiter failed on transport after the moderator/lanes found something', async () => {
    const f = fixture('1');
    const original = attachPanelFailureEvidence(new PanelInfrastructureError('arbiter failed closed: terminated'), {
      stage: 'arbiter', lanes: [{ id: 'arbiter', failureClass: 'transport' }], findingsObserved: true });
    f.panelRunner.mockRejectedValue(original);
    await expectUnchangedFailure(f, original);
  });

  it.each([
    ['a required lane that returned malformed output', 'malformed_output'],
    ['a required lane that was refused its credential', 'auth'],
    ['a required lane that exhausted its budget', 'budget_exhausted'],
  ] as const)('%s', async (_label, failureClass) => {
    const f = fixture('1');
    const original = attachPanelFailureEvidence(new PanelConfigurationError('required persona failure: x', { failureClass }), {
      stage: 'lanes', lanes: [{ id: 'sec-lane', failureClass }], findingsObserved: false });
    f.panelRunner.mockRejectedValue(original);
    await expectUnchangedFailure(f, original);
  });

  it('one required lane on transport and another on malformed output', async () => {
    const f = fixture('1');
    const original = attachPanelFailureEvidence(new PanelConfigurationError('required persona failure: x'), {
      stage: 'lanes', lanes: [{ id: 'sec-lane', failureClass: 'transport' }, { id: 'qual-lane', failureClass: 'malformed_output' }],
      findingsObserved: false });
    f.panelRunner.mockRejectedValue(original);
    await expectUnchangedFailure(f, original);
  });

  it.each([
    ['an untyped provider message', new Error('provider exploded')],
    ['a bare timeout with no lane evidence', new Error('request timed out')],
    ['a configuration error', new PanelConfigurationError('no enabled moderator provider')],
    ['a gateway 413 (the same request fails the same way)', new OpenRouterResponseError('HTTP 413 fetch failed', 413)],
  ])('a raw panel rejection that is not unambiguously the gateway: %s', async (_label, original) => {
    const f = fixture('1');
    f.panelRunner.mockRejectedValue(original);
    await expectUnchangedFailure(f, original);
  });

  it('a GitHub source read that says `fetch failed` (before the panel ran) is not a reviewer lane', async () => {
    const f = fixture('1');
    const original = new Error('fetch failed');
    f.sourceLoader.mockRejectedValue(original);
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(original);
    expect(f.panelRunner).not.toHaveBeenCalled();
    const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(isInfrastructureIncompleteResult(completion.result)).toBe(false);
    expect(completion.result.coverageComplete).toBe(false);
  });

  it('a diff with an unreadable header (deterministic coverage gap) is never re-attempted', async () => {
    const f = fixture('1');
    f.source.diff = `${DIFF}diff --git unreadable-header\n`;
    const original = requiredSecLaneFetchFailed();
    f.panelRunner.mockRejectedValue(original);
    await expectUnchangedFailure(f, original);
  });

  it('a source file whose patch GitHub omitted (deterministic coverage gap) is never re-attempted', async () => {
    const f = fixture('1');
    f.source.diff = `${DIFF}diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n${PATCH_UNAVAILABLE_MARKER} (omitted by GitHub; 900 changed lines)\n`;
    expect(parseChangedFiles(f.source.diff).unreadable).toEqual([]);
    const original = requiredSecLaneFetchFailed();
    f.panelRunner.mockRejectedValue(original);
    await expectUnchangedFailure(f, original);
  });

  it('a cancelled panel is never infrastructure', async () => {
    const f = fixture('1');
    const original = new PanelCancellationError();
    f.panelRunner.mockRejectedValue(original);
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(original);
    expect(isInfrastructureIncompleteResult(parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]).result)).toBe(false);
  });
});

describe('REL-1124: legacy (non-authoritative) app-gate path reaches the same outcome', () => {
  function legacyFixture(executionAttempt = '1') {
    const f = fixture(executionAttempt);
    delete f.env.REVIEW_AUTHORITATIVE_GATE;
    delete f.env.REVIEW_PREPARED_CONFIG_JSON;
    delete f.deps.reviewCompletion;
    f.env.REVIEW_PERSONAS = 'security';
    const reportTerminalFailure = vi.fn<WorkerCompletionAdapter['reportTerminalFailure']>(async () => undefined);
    f.deps.completion = { reportTerminalFailure, reportTerminalSuccess: vi.fn(async () => undefined) };
    return { ...f, reportTerminalFailure };
  }

  it('marks the terminal failure recoverable, titles it INCOMPLETE, and the dispatcher re-admits it', async () => {
    const f = legacyFixture('1');
    f.panelRunner.mockRejectedValue(requiredSecLaneFetchFailed());
    await expect(runPublishingReviewWorker(f.env, f.deps)).resolves.toMatchObject({ verdict: 'INCOMPLETE' });
    const event = f.reportTerminalFailure.mock.calls[0]?.[0] as WorkerTerminalFailure;
    expect(event).toMatchObject({ failureClass: 'transport', executionAttempt: 1,
      diagnostics: { reason: 'lane_infrastructure_incomplete', recoverableIncompletePanel: true } });
    expect(f.checkClient.completeCheck.mock.calls[0]?.[0]?.title)
      .toBe('Review Yeti: INCOMPLETE — infrastructure (lane sec-lane failed: transport); retrying as attempt 2 of 3');
    const admit = vi.fn(async () => ({}) as never);
    await requeueRecoverableIncompletePanelFailure({ input: event, now: START, logger: { error: vi.fn() },
      repository: { admit, readRunRetryContext: vi.fn(async () => ({ publicationMode: 'app-gate' as const,
        authoritativeGateAppId: null, repositoryId: 123, installationId: 55,
        identity: buildReviewRunIdentity({ owner: 'example', repo: 'project', prNumber: 42, headSha: HEAD, baseSha: BASE }) })) } });
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ retryRequested: true, retryAfterExecutionAttempt: 1 }));
  });

  it('leaves the pre-existing legacy provider_5xx requeue (REL-620) unchanged: in_progress "requeuing", rethrown', async () => {
    const f = legacyFixture('1');
    const error = attachPanelFailureEvidence(new PanelInfrastructureError('required persona failure: HTTP 502 provider_5xx',
      { failureClass: 'provider_error', failureReason: 'provider_5xx' }), {
      stage: 'lanes', lanes: [{ id: 'sec-lane', failureClass: 'provider_error', providerStatus: 502 }], findingsObserved: false });
    f.panelRunner.mockRejectedValue(error);
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(error);
    expect(f.reportTerminalFailure.mock.calls[0]?.[0]?.diagnostics).toMatchObject({ reason: 'provider_5xx', recoverableIncompletePanel: true });
    expect(f.checkClient.updateCheck).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_progress',
      title: 'Review Yeti: gateway capacity unavailable (requeuing)' }));
    expect(f.checkClient.completeCheck).not.toHaveBeenCalled();
  });

  it('an AUTHORITATIVE thrown provider_5xx (no re-attempt before) is INCOMPLETE and re-admitted', async () => {
    const f = fixture('1');
    const error = attachPanelFailureEvidence(new PanelInfrastructureError('required persona failure: HTTP 502 provider_5xx',
      { failureClass: 'provider_error', failureReason: 'provider_5xx' }), {
      stage: 'lanes', lanes: [{ id: 'sec-lane', failureClass: 'provider_error', providerStatus: 502 }], findingsObserved: false });
    f.panelRunner.mockRejectedValue(error);
    await expect(runPublishingReviewWorker(f.env, f.deps)).resolves.toMatchObject({ verdict: 'INCOMPLETE' });
    const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(isInfrastructureIncompleteResult(completion.result)).toBe(true);
    expect(completion.result.failureDiagnostics).toMatchObject({ providerStatus: 502 });
    expect(f.checkClient.completeCheck.mock.calls[0]?.[0]?.title)
      .toBe('Review Yeti: INCOMPLETE — infrastructure (lane sec-lane failed: 502); retrying as attempt 2 of 3');
    await expect(serviceRequeue(completion)).resolves.toMatchObject({ outcome: 'requeued' });
  });

  it('negative proof: a non-infrastructure thrown panel is not marked recoverable', async () => {
    const f = legacyFixture('1');
    const original = new Error('provider exploded');
    f.panelRunner.mockRejectedValue(original);
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toBe(original);
    expect(f.reportTerminalFailure.mock.calls[0]?.[0]?.diagnostics?.recoverableIncompletePanel).toBeUndefined();
  });
});

describe('REL-1124: the decision itself', () => {
  it('reads nothing that the panel runner did not reject with', () => {
    expect(thrownPanelInfrastructureFailure(new Error('fetch failed'))).toBeUndefined();
    expect(thrownPanelInfrastructureFailure(markThrownByPanel(new Error('fetch failed')))).toMatchObject({ failureClass: 'transport' });
    expect(thrownPanelInfrastructureFailure(markThrownByPanel(new Error('fetch failed')), { aborted: true })).toBeUndefined();
    expect(thrownPanelInfrastructureFailure(markThrownByPanel('fetch failed'))).toBeUndefined();
  });

  it('publishes the class and provider status of the SAME lane, never a mix of two', () => {
    const error = markThrownByPanel(attachPanelFailureEvidence(new Error('required persona failure'), {
      stage: 'lanes', findingsObserved: false,
      lanes: [{ id: 'sec-lane', failureClass: 'transport' }, { id: 'qual-lane', failureClass: 'provider_error', providerStatus: 502 }] }));
    expect(thrownPanelInfrastructureFailure(error)).toEqual({ stage: 'lanes', failureClass: 'provider_error', providerStatus: 502,
      incompleteLanes: [{ id: 'sec-lane', failureClass: 'transport' }, { id: 'qual-lane', failureClass: 'provider_error', providerStatus: 502 }] });
    const noStatus = markThrownByPanel(attachPanelFailureEvidence(new Error('x'), {
      stage: 'lanes', findingsObserved: false, lanes: [{ id: 'sec-lane', failureClass: 'timeout' }, { id: 'qual-lane', failureClass: 'transport' }] }));
    expect(thrownPanelInfrastructureFailure(noStatus)).toMatchObject({ failureClass: 'timeout' });
    expect(thrownPanelInfrastructureFailure(noStatus)).not.toHaveProperty('providerStatus');
  });

  it('keeps evidence off the serialized error', () => {
    const error = requiredSecLaneFetchFailed();
    expect(Object.keys(error)).not.toContain('stage');
    expect(JSON.stringify(error)).not.toContain('findingsObserved');
    expect(panelFailureEvidenceOf(error)?.stage).toBe('lanes');
  });
});

// ---- The real panel: pin that `executePersonaPanel` throws each shape with the evidence above.

function panelConfig(): CtReviewConfigV3 {
  return ctReviewConfigV3Schema.parse({
    version: 3, profile: 'assertive', quorum: 1,
    personas: [
      { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['src/**'], providers: ['bifrost'] },
      { id: 'qual-lane', enabled: true, required: false, charter: 'builtin:correctness', paths: ['src/**'], providers: ['bifrost'] },
    ],
    reviewers: {
      execution: 'personas', fallback: 'none', overall_timeout_s: 120,
      providers: [{ id: 'bifrost', enabled: true, model: 'bifrost/pr-reviewer', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 }],
      arbiter: { order: ['bifrost'] },
    },
    path_instructions: [], rules: [], reviewer_effort: 'high', confidence_threshold: 70, mascot: true, display: { mascot: true },
  });
}

type Fail = { role: 'persona:sec-lane' | 'moderator' | 'arbiter'; error?: () => Error; content?: string };

async function runRealPanel(fail: Fail, options: { qualFinding?: boolean } = {}) {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const complete = vi.fn(async (opts: any) => {
    const prompt = extractMessageContentText(opts.messages[1]?.content || '');
    const system = extractMessageContentText(opts.messages[0]?.content || '');
    const nonce = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/)?.[1].trim() || 'test-nonce';
    const role = opts.metadata?.role || (prompt.includes('Role: ARBITER') ? 'arbiter' : prompt.includes('Role: MODERATOR') ? 'moderator' : 'persona');
    const persona = opts.metadata?.persona;
    const key = role === 'persona' ? `persona:${persona}` : role;
    if (key === fail.role) {
      if (fail.content !== undefined) return { model: opts.model, content: fail.content, usage: null, costUSD: null, raw: {} };
      throw fail.error!();
    }
    if (role === 'arbiter') return { model: opts.model, content: JSON.stringify({ nonce, verdict: 'SHIP', rationale: 'ok' }), usage: null, costUSD: null, raw: {} };
    if (role === 'moderator') return { model: opts.model, content: JSON.stringify({ nonce, decision: 'RECONCILED', findings: [] }), usage: null, costUSD: null, raw: {} };
    const findings = options.qualFinding && (persona === 'qual-lane' || /correctness/iu.test(system))
      ? [{ severity: 'P1', path: 'src/a.ts', line: 1, title: 'Off by one', body: 'The loop skips the last element.', confidence: 90 }]
      : [];
    return { model: opts.model, content: JSON.stringify({ nonce, decision: findings.length ? 'FINDINGS' : 'APPROVE', findings }), usage: null, costUSD: null, raw: {} };
  });
  let caught: unknown;
  try {
    await executePersonaPanel({
      config: panelConfig(), changedFiles: [{ path: 'src/a.ts', patch: '+ const x = 1;' }],
      repository: 'calltelemetry/repo', headSha: HEAD, client: { complete } as unknown as OmniRouteClient,
      requestPolicy: { responseFormat: { type: 'json_object' } },
    });
  } catch (error) {
    caught = error;
  }
  return caught;
}

describe('REL-1124: executePersonaPanel throws text-free infrastructure evidence', () => {
  it('a required sec-lane lost to `fetch failed` throws PanelInfrastructureError with lane evidence', async () => {
    const caught = await runRealPanel({ role: 'persona:sec-lane',
      error: () => new OpenRouterConnectionError('OpenRouter SDK connection failure for model bifrost/pr-reviewer: fetch failed') });
    expect(caught).toBeInstanceOf(PanelInfrastructureError);
    // Still a PanelConfigurationError for every existing fail-closed `instanceof` check.
    expect(caught).toBeInstanceOf(PanelConfigurationError);
    expect((caught as Error).name).toBe('PanelInfrastructureError');
    expect((caught as Error).message).toMatch(/^required persona failure/u);
    expect(panelFailureEvidenceOf(caught)).toEqual({ stage: 'lanes',
      lanes: [{ id: 'sec-lane', failureClass: 'transport' }], findingsObserved: false });
    expect(thrownPanelInfrastructureFailure(markThrownByPanel(caught))).toMatchObject({ stage: 'lanes', failureClass: 'transport' });
  }, 120_000);

  it('records that a completed lane found something, so the run is not re-rolled', async () => {
    const caught = await runRealPanel({ role: 'persona:sec-lane',
      error: () => new OpenRouterConnectionError('OpenRouter SDK connection failure: fetch failed') }, { qualFinding: true });
    expect(panelFailureEvidenceOf(caught)?.findingsObserved).toBe(true);
    expect(thrownPanelInfrastructureFailure(markThrownByPanel(caught))).toBeUndefined();
  }, 120_000);

  it('an arbiter lost to a `terminated` stream throws PanelInfrastructureError with arbiter evidence', async () => {
    const caught = await runRealPanel({ role: 'arbiter',
      error: () => new OpenRouterConnectionError('OpenRouter SDK connection failure for model bifrost/pr-reviewer: terminated') });
    expect(caught).toBeInstanceOf(PanelInfrastructureError);
    expect((caught as Error).message).toMatch(/^arbiter failed closed/u);
    expect(panelFailureEvidenceOf(caught)).toMatchObject({ stage: 'arbiter', findingsObserved: false });
    expect(panelFailureEvidenceOf(caught)?.lanes.every((lane) => lane.id === 'arbiter' && lane.failureClass === 'transport')).toBe(true);
  }, 120_000);

  it('a moderator gateway 502 escapes with moderator evidence and its provider status', async () => {
    const caught = await runRealPanel({ role: 'moderator',
      error: () => new OpenRouterResponseError('bifrost: gateway-internal.calltelemetry.com HTTP 502: nginx', 502) });
    expect(panelFailureEvidenceOf(caught)).toEqual({ stage: 'moderator',
      lanes: [{ id: 'moderator', failureClass: 'provider_error', providerStatus: 502 }], findingsObserved: false });
  }, 120_000);

  it('negative proof: a required lane that answered with malformed output stays a PanelConfigurationError with a non-infrastructure class', async () => {
    const caught = await runRealPanel({ role: 'persona:sec-lane', content: 'this is not the review contract' });
    expect((caught as Error).message).toMatch(/^required persona failure/u);
    expect(caught).toBeInstanceOf(PanelConfigurationError);
    expect(caught).not.toBeInstanceOf(PanelInfrastructureError);
    const evidence = panelFailureEvidenceOf(caught);
    expect(evidence?.stage).toBe('lanes');
    // The lane exhausts its correction turns on output that never meets the contract: a coded
    // non-infrastructure class (budget_exhausted / malformed_output), never transport.
    expect(evidence?.lanes.map((lane) => lane.id)).toEqual(['sec-lane']);
    expect(['budget_exhausted', 'malformed_output']).toContain(evidence?.lanes[0]?.failureClass);
    expect(isInfrastructureFailureClass(evidence?.lanes[0]?.failureClass)).toBe(false);
    expect(thrownPanelInfrastructureFailure(markThrownByPanel(caught))).toBeUndefined();
  }, 120_000);

  it('negative proof: an arbiter that answered with no verdict stays a PanelConfigurationError, not infrastructure', async () => {
    const caught = await runRealPanel({ role: 'arbiter', error: () => new PanelConfigurationError('arbiter returned an invalid or missing verdict; refusing to infer a successful result') });
    expect(caught).toBeInstanceOf(PanelConfigurationError);
    expect(caught).not.toBeInstanceOf(PanelInfrastructureError);
    expect(thrownPanelInfrastructureFailure(markThrownByPanel(caught))).toBeUndefined();
  }, 120_000);
});
