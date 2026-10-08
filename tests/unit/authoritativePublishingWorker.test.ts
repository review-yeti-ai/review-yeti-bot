import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkerFailureDiagnostics, type WorkerCompletionAdapter } from '../../src/review/workerCompletion';
import {
  PUBLISHING_MAX_OUTPUT_TOKENS,
  renderFindingsMarkdown,
  runPublishingReviewWorker,
  type PublishingCheckClient,
  type PublishingReviewDeps,
} from '../../src/cli/publishingReview';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { deriveCanonicalWorkerReviewEvidence, parseWorkerReviewCompletion, type WorkerReviewCompletion, type WorkerReviewResult } from '../../src/review/workerReviewCompletion';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION, GROUNDED_REVIEW_RECEIPT_V2_VERSION,
  GROUNDED_VERIFICATION_V2_VERSION } from '../../src/review/groundedEvidenceV2';
import { canonicalJson, computeArbitration, sha256 } from '../../src/review/reviewCore';
import { evaluateReviewGate } from '../../src/review/reviewGatePolicy';
import { isInfrastructureIncompleteResult } from '../../src/review/publicationFailurePolicy';
import { isRecoverableFailureTitle } from '../../src/review/reviewCheckIdentity';
import { buildDocumentationOnlyPanelResult } from '../../src/panel/fastShipResult';
import { resolveComposedProviderId, unreportedLaneFailure } from '../../src/panel/composedEngine';
import { ComposedRuntimeResourceObserver } from '../../src/panel/composedResourceReceipt';
import { ProviderAttemptBudget } from '../../src/gateway/providerAttemptBudget';
import { OpenRouterClient } from '../../src/gateway/openRouterClient';
import { TaskSourceDelivery } from '../../src/review/taskSourceDelivery';
import type { OpenRouterRequest } from '../../src/gateway/openRouterClient';
import { JevClient, type JevOutcome } from '../../src/gateway/jevClient';
import type { WorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';
import { HttpWorkerReviewCompletionAdapter } from '../../src/review/workerReviewCompletionHttp';
import type { PanelResult } from '../../src/panel/types';
import * as panelEngine from '../../src/panel/panelEngine';
import * as qualificationReader from '../../src/github/qualificationReader';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { logger } from '../../src/utils/logger';
import { getMetrics } from '../../src/telemetry';
import * as zoektGroundingModule from '../../src/mcp/zoektGrounding';
import * as deletionEvidenceModule from '../../src/review/deletionEvidence';
import {
  createIncompleteP2RecoveryContext,
  incompleteP2RecoveryClaimFor,
  MAX_INCOMPLETE_P2_RECOVERY_BYTES,
} from '../../src/review/incompleteP2Recovery';
import { disputedFindingRecheckDigest } from '../../src/review/disputedFindingRecheck';
import { createFindingThreadsHandler } from '../../src/api/findingThreadsRoute';
import { HttpFindingThreadsPublisher } from '../../src/review/findingThreadsHttp';
import { completeCurrentVersionLifecycleHistory, completeEmptyLifecycleHistory, groundedFixtureClient, groundedFixtureProvider } from '../support/groundedReviewFixture';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const START = Date.parse('2026-09-09T12:00:00.000Z');
const COMPLETED = new Date(START + 1_000).toISOString();
const ENDPOINT = 'https://dispatch.example.invalid/api/dispatch/completion';
const PRIVATE_DETAIL = 'private_provider_transcript';
const TOKEN = 'ghs_fake_authoritative_worker';
const DIFF = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n`;
const transport = { baseUrl: 'https://gateway.example.invalid/v1', model: 'prepared-review-model' };

function trustedGroundedVerifierContract(f: ReturnType<typeof fixture>) {
  const config = f.prepared.config;
  const primaryModel = config.review_engine === 'composed'
    ? config.reviewers.providers.find((provider) => provider.id === resolveComposedProviderId(config)
      && provider.enabled)?.model
    : f.envelope.transport.model;
  if (!primaryModel) throw new Error('Prepared review configuration has no primary grounded-verifier model');
  if (config.review_engine === 'composed' && !config.review_configuration_receipt) {
    throw new Error('Prepared composed configuration has no trusted runtime configuration receipt');
  }
  return {
    groundedVerifierRouting: { primaryModel },
    ...(config.review_engine === 'composed'
      ? { composedEffectiveConfiguration: config.review_configuration_receipt }
      : {}),
  };
}

function completedTaskSourceDelivery(taskId: string, paths: string[]) {
  const delivery = new TaskSourceDelivery({ taskId, paths, files: parseChangedFiles(DIFF).files,
    prefix: DIFF, inlinedPaths: paths, headSha: HEAD, baseSha: BASE });
  delivery.beginAttempt();
  const receipt = delivery.acknowledgeRequest([{ role: 'user', content: DIFF }]);
  if (!receipt.complete) throw new Error('Local composed task did not receive a complete changed-source receipt');
  return receipt;
}

function composedEngineObservation(f: ReturnType<typeof fixture>, taskPlan: Array<{ id: string; paths: string[] }>,
  completedReceipts: readonly ReturnType<typeof completedTaskSourceDelivery>[]) {
  const configuration = f.prepared.config.review_configuration_receipt;
  if (!configuration) throw new Error('Prepared composed configuration has no trusted runtime configuration receipt');
  const completedById = new Map(completedReceipts.map((receipt) => [receipt.taskId, receipt]));
  const providerAttemptBudget = new ProviderAttemptBudget({ totalLimit: 100, investigationLimit: 88, verificationLimit: 12 });
  const observer = new ComposedRuntimeResourceObserver({
    configDigest: f.prepared.policy.effectiveConfigDigest,
    configuration,
    providerAttemptBudget,
    now: () => START,
  });
  observer.configureBudget({ configuredTotalTurns: 100, investigationTurns: 88, verificationReserveTurns: 12 });
  observer.setPlan(taskPlan as never);
  for (const task of taskPlan) {
    observer.markTaskStarted(task.id);
    const receipt = completedById.get(task.id);
    observer.markTaskOutcome(task.id, receipt ? 'completed' : 'failed', receipt);
  }
  const observation = observer.snapshot('terminal');
  if (!observation) throw new Error('Could not build local composed resource observation');
  return observation;
}

function fixture(options: { reviewEngine?: 'panel' | 'composed' | 'shadow'; severityV2?: boolean } = {}) {
  const content = JSON.stringify({ schema: 'exampleorg.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 1 },
    ...(options.reviewEngine ? { review_engine: options.reviewEngine } : {}),
    ...(options.severityV2 ? { severity_policy: 'review-yeti-severity.v2' } : {}),
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
  const repoFileProviderFactory = vi.fn((input: Parameters<NonNullable<PublishingReviewDeps['repoFileProviderFactory']>>[0]) =>
    groundedFixtureProvider(input));
  const client = { complete: vi.fn().mockRejectedValue(new Error('A test must never invoke a provider')) };
  const reportReviewResult = vi.fn<WorkerReviewCompletionAdapter['reportReviewResult']>().mockResolvedValue(undefined);
  const legacyFailure = vi.fn<WorkerCompletionAdapter['reportTerminalFailure']>(async () => undefined);
  const now = vi.fn().mockReturnValueOnce(START).mockReturnValue(START + 1_000);
  const deps: PublishingReviewDeps = { checkClient, sourceLoader, panelRunner, client, now,
    currentPullRequestVerifier: vi.fn(async () => undefined),
    repoFileProviderFactory, groundedVerifierClient: groundedFixtureClient as never,
    visibilityLookup: vi.fn(async () => 'PRIVATE' as const), reviewCompletion: { reportReviewResult } };
  const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const infoLog = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  // Fail closed even if a future change accidentally escapes the injected seams.
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
  return { env, deps, prepared, envelope, panel, source, checkClient, sourceLoader, panelRunner,
    client, reportReviewResult, legacyFailure, errorLog, infoLog, fetch };
}

function enableCurrentV2History(f: ReturnType<typeof fixture>): void {
  const source = completeCurrentVersionLifecycleHistory();
  const read = source.read;
  f.deps.prLifecycleHistory = { ...source, read: async () => {
    const history = await read();
    return { ...history, events: history.events.map((event) => ({ ...event,
      policyDigest: f.prepared.policy.effectivePolicyDigest,
      configDigest: f.prepared.policy.effectiveConfigDigest,
    })) };
  } } as never;
  f.deps.findingThreadReader = async (_pr, expectedHeadSha) => ({ source: 'service', headSha: expectedHeadSha,
    complete: true, omittedCount: 0, threads: [] });
  f.deps.incrementalCompareReader = { compare: vi.fn(async (priorHeadSha: string, currentHeadSha: string) => ({
    status: priorHeadSha === currentHeadSha ? 'identical' as const : 'ahead' as const,
    mergeBaseSha: priorHeadSha, files: [],
  })) };
}

function exactWorkerCheckpoint(f: ReturnType<typeof fixture>) {
  const plan = [{ id: 'checkpoint-task', dimension: 'testing' as const, paths: ['src/a.ts'],
    question: 'Does current source retain the expected behavior?', rationale: 'Seed an exact source-bound checkpoint.' }];
  return {
    version: 'ReviewExecutionCheckpoint.v1' as const,
    runId: f.env.REVIEW_RUN_ID!,
    repositoryId: Number(f.env.REVIEW_REPOSITORY_ID),
    owner: 'example',
    repo: 'project',
    prNumber: Number(f.env.REVIEW_PR_NUMBER),
    headSha: HEAD,
    baseSha: BASE,
    policyDigest: f.prepared.policy.effectivePolicyDigest,
    configDigest: f.prepared.policy.effectiveConfigDigest,
    executionAttempt: 1,
    revision: 1,
    plan,
    completedTasks: [{ id: plan[0]!.id, findings: [], sourceDelivery: completedTaskSourceDelivery(plan[0]!.id, plan[0]!.paths) }],
  };
}

function configureHistoryCase(f: ReturnType<typeof fixture>, state: 'partial' | 'incompatible'): void {
  const source = completeCurrentVersionLifecycleHistory();
  const read = source.read;
  f.deps.prLifecycleHistory = { ...source, read: async () => {
    const history = await read();
    const events = history.events.map((event) => ({
      ...event,
      ...(state === 'incompatible' ? { evidenceSemanticsVersion: 'GroundedReviewEvidenceSemantics.v1' } : {}),
      policyDigest: f.prepared.policy.effectivePolicyDigest,
      configDigest: f.prepared.policy.effectiveConfigDigest,
    }));
    return state === 'partial'
      ? { ...history, status: 'partial' as const, eventCount: history.eventCount + 1,
        eventOmittedCount: 1, omissions: ['one lifecycle event was omitted'], events }
      : { ...history, events };
  } } as never;
  f.deps.findingThreadReader = async (_pr, expectedHeadSha) => ({ source: 'service', headSha: expectedHeadSha,
    complete: true, omittedCount: 0, threads: [] });
}

function validDisputeForCheckpoint(f: ReturnType<typeof fixture>, checkpoint: ReturnType<typeof exactWorkerCheckpoint>) {
  const task = checkpoint.plan[0]!;
  const counterArgument = 'Recheck this exact finding against current source.';
  const unsigned = {
    requestId: randomUUID(),
    runId: f.env.REVIEW_RUN_ID!,
    sourceExecutionAttempt: 1,
    sourceContentDigest: 'd'.repeat(64),
    sourcePlanDigest: sha256(canonicalJson(checkpoint.plan)),
    sourceGateAttemptId: `${f.env.REVIEW_RUN_ID}-g0-e1`,
    repositoryId: Number(f.env.REVIEW_REPOSITORY_ID),
    owner: 'example',
    repo: 'project',
    prNumber: Number(f.env.REVIEW_PR_NUMBER),
    headSha: HEAD,
    baseSha: BASE,
    policyDigest: f.prepared.policy.effectivePolicyDigest,
    configDigest: f.prepared.policy.effectiveConfigDigest,
    findingId: 'source-finding-id',
    personaId: task.id,
    taskId: task.id,
    finding: { severity: 'P1' as const, path: 'src/a.ts', line: 1,
      title: 'Prior authenticated finding', body: 'Recheck the bound finding.' },
    counterArgument,
    counterArgumentDigest: sha256(counterArgument),
  };
  return { ...unsigned, requestDigest: disputedFindingRecheckDigest(unsigned) };
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

function expectCompletionPayload(f: ReturnType<typeof fixture>, payload: unknown, expectedResult: WorkerReviewResult) {
  const actual = parseWorkerReviewCompletion(payload);
  const { groundedReview, ...legacyResult } = actual.result;
  expect({ ...actual, result: legacyResult }).toEqual(expectedEvent(f, expectedResult));
  expect(groundedReview).toMatchObject({
    version: GROUNDED_REVIEW_RECEIPT_V2_VERSION,
    semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
    history: { status: f.deps.prLifecycleHistory ? 'complete' : 'unavailable',
      memorySources: { honcho: 'unavailable', mcp: 'unavailable' } },
    verification: { version: GROUNDED_VERIFICATION_V2_VERSION,
      semanticsVersion: GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION,
      outcomes: expect.any(Array), budget: expect.any(Object) },
  });
  return actual;
}

function expectReportedCompletion(f: ReturnType<typeof fixture>, expectedResult: WorkerReviewResult) {
  expect(f.reportReviewResult).toHaveBeenCalledOnce();
  return expectCompletionPayload(f, f.reportReviewResult.mock.calls[0]?.[0], expectedResult);
}

/** Synthetic DB/GitHub I/O only: the worker uses the real HTTP adapter, route,
 * active-execution authorization and finding-thread serializer. No server or provider runs. */
function threadPublicationFixture(options: { blocking?: boolean; publishFails?: boolean } = {}) {
  const f = fixture();
  const order: string[] = [];
  const statuses: number[] = [];
  let runStatus = 'running';
  let githubReads = 0;
  const finding = { severity: 'P2' as const, path: 'src/a.ts', line: 1,
    title: 'Required local fixture', body: 'Preserve the required finding independently of thread delivery.' };
  if (options.blocking !== false) {
    f.panel.personas[0].decision = 'FINDINGS';
    f.panel.personas[0].findings = [finding];
  }
  const githubFetch = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === 'https://api.github.com/graphql') {
      githubReads += 1;
      if (options.publishFails && options.blocking === false && githubReads > 1) {
        return new Response('{}', { status: 503 });
      }
      return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false }, nodes: [],
      } } } } }));
    }
    expect(String(url)).toBe('https://api.github.com/repos/example/project/pulls/42/comments');
    return new Response('{}', { status: options.publishFails ? 503 : 201 });
  });
  const transportFor = vi.fn(async () => ({ token: 'ghs_synthetic_thread_service',
    botLogin: 'review-app[bot]', fetchImplementation: githubFetch }));
  const handler = createFindingThreadsHandler({
    db: { query: async (sql, values) => {
      if (sql.includes('SELECT runs.status')) {
        expect(values).toEqual([f.env.REVIEW_RUN_ID, 2]);
        return { rows: [{ status: runStatus, worker_token_digest: sha256(TOKEN) }] };
      }
      expect(sql).toContain('SELECT owner, repo, pr_number, head_sha');
      expect(values).toEqual([f.env.REVIEW_RUN_ID]);
      return { rows: [{ owner: 'example', repo: 'project', pr_number: 42, head_sha: HEAD }] };
    } }, transportFor,
  });
  const threadFetch = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(ENDPOINT.replace(/\/completion$/u, '/finding-threads'));
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    order.push(body.version === 'FindingThreadsRead.v1' ? 'thread-read' : 'thread-publish');
    let status = 200;
    let payload: unknown;
    const response = {
      status: (value: number) => { status = value; return response; },
      json: (value: unknown) => { payload = value; return response; },
    };
    await handler({ body, header: (name: string) => new Headers(init?.headers).get(name) } as never,
      response as never);
    statuses.push(status);
    return new Response(JSON.stringify(payload), { status });
  });
  const threads = new HttpFindingThreadsPublisher({ token: TOKEN, completionEndpoint: ENDPOINT,
    runId: f.env.REVIEW_RUN_ID!, executionAttempt: 2, fetchImplementation: threadFetch });
  f.deps.findingThreadReader = async (_pr, expectedHeadSha) => ({ source: 'service' as const,
    ...(await threads.readSnapshot!(expectedHeadSha)) });
  f.deps.findingThreads = threads;
  const decisions: ReturnType<typeof evaluateReviewGate>[] = [];
  f.reportReviewResult.mockImplementation(async (event) => {
    const { version: _version, result: _result, ...expectedCoordinates } =
      parseWorkerReviewCompletion(expectedEvent(f, cleanResult()));
    const derived = deriveCanonicalWorkerReviewEvidence(event, {
      expectedCoordinates, expectedPersonaIds: f.prepared.expectedPersonaIds,
      ...trustedGroundedVerifierContract(f),
      changedFiles: parseChangedFiles(DIFF).files, coverageComplete: true, quorumSatisfied: true,
    });
    expect(derived.valid).toBe(true);
    if (!derived.valid) throw new Error('Invalid synthetic completion evidence');
    const candidate = { repositoryId: 123, prNumber: 42, headSha: HEAD, baseSha: BASE,
      policyDigest: f.prepared.policy.effectivePolicyDigest };
    const decision = evaluateReviewGate({ candidate, current: { ...candidate, open: true, draft: false },
      evidence: derived.evidence });
    decisions.push(decision);
    // Model recordWorkerResult's committed terminal status before acknowledging completion.
    runStatus = decision.status === 'success' ? 'succeeded' : 'failed';
    order.push('completion');
  });
  f.checkClient.completeCheck.mockImplementation(async () => { order.push('raw-check'); });
  return { f, order, statuses, threads, finding, decisions, githubFetch, transportFor };
}

describe('finding-thread publication before authoritative retirement', () => {
  it('publishes v2 thread migration only after accepted completion with the decision receipt', async () => {
    const f = fixture({ severityV2: true });
    const order: string[] = [];
    let threadRequest: unknown;
    f.deps.findingThreadReader = async (_pr, headSha) => ({ source: 'service', headSha, complete: true, omittedCount: 0, threads: [] });
    f.deps.findingThreads = { publish: vi.fn(async (input) => {
      order.push('threads'); threadRequest = input;
      return { created: 0, skipped: 0, resolved: 0 };
    }) };
    f.reportReviewResult.mockImplementation(async () => { order.push('completion'); });
    f.checkClient.completeCheck.mockImplementation(async () => { order.push('raw-check'); });

    const result = await runPublishingReviewWorker(f.env, f.deps);

    expect(order).toEqual(['completion', 'threads', 'raw-check']);
    expect(threadRequest).toMatchObject({ headSha: HEAD, baseSha: BASE, repositoryId: 123,
      owner: 'example', repo: 'project', prNumber: 42,
      policyDigest: f.prepared.policy.effectivePolicyDigest,
      configDigest: f.prepared.policy.effectiveConfigDigest,
      reviewDecision: { schemaVersion: 'review-yeti-decision.v2', eligible: true } });
    expect(result.conclusion).toBe('success');
  });

  it('fails the raw check explicitly when post-completion v2 thread migration fails', async () => {
    const f = fixture({ severityV2: true });
    const order: string[] = [];
    f.deps.findingThreadReader = async (_pr, headSha) => ({ source: 'service', headSha, complete: true, omittedCount: 0, threads: [] });
    f.deps.findingThreads = { publish: vi.fn(async () => {
      order.push('threads'); throw new Error('service unavailable');
    }) };
    f.reportReviewResult.mockImplementation(async () => { order.push('completion'); });
    f.checkClient.completeCheck.mockImplementation(async (input) => {
      order.push('raw-check');
      expect(input.conclusion).toBe('failure');
      expect(input.summary).toContain('Required conversation update failed');
    });

    const result = await runPublishingReviewWorker(f.env, f.deps);

    expect(order).toEqual(['completion', 'threads', 'raw-check']);
    expect(result.conclusion).toBe('failure');
  });

  it('publishes through the active route before terminal completion, then rejects the retired execution', async () => {
    const t = threadPublicationFixture();
    const receipt = await runPublishingReviewWorker(t.f.env, t.f.deps);
    expect(t.statuses).toEqual([200, 200]);
    expect(t.order).toEqual(['thread-read', 'thread-publish', 'completion', 'raw-check']);
    expect(t.githubFetch.mock.calls.filter(([url]) => String(url).endsWith('/comments'))).toHaveLength(1);
    expect(t.decisions).toEqual([expect.objectContaining({ status: 'failure', eligible: false })]);
    expect(receipt).toMatchObject({ verdict: 'SHIP', conclusion: 'failure', findingCount: 1 });
    expect(t.f.reportReviewResult).toHaveBeenCalledOnce();
    expect(t.f.checkClient.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      conclusion: 'failure', title: 'Review Yeti: FIX_FIRST (1 required P2)',
    }));
    const mintedBefore = t.transportFor.mock.calls.length;
    await expect(t.threads.publish({ headSha: HEAD, publish: [], reported: [] }))
      .rejects.toThrow('Finding threads could not be published');
    expect(t.statuses.at(-1)).toBe(403);
    expect(t.transportFor).toHaveBeenCalledTimes(mintedBefore);
    expect(t.f.fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('thread delivery failure preserves the exact verdict (blocking=%s)', async (blocking) => {
    const t = threadPublicationFixture({ blocking, publishFails: true });
    const receipt = await runPublishingReviewWorker(t.f.env, t.f.deps);
    expect(t.statuses.at(-1)).toBe(503);
    expect(t.order).toEqual(['thread-read', 'thread-publish', 'completion', 'raw-check']);
    expect(t.f.reportReviewResult).toHaveBeenCalledOnce();
    expect(t.f.checkClient.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      conclusion: blocking ? 'failure' : 'success',
    }));
    expect(t.decisions).toEqual([expect.objectContaining({
      status: blocking ? 'failure' : 'success', eligible: !blocking,
    })]);
    expect(receipt).toMatchObject({ verdict: 'SHIP', conclusion: blocking ? 'failure' : 'success' });
    expect(t.f.fetch).not.toHaveBeenCalled();
  });

  it('retains legacy raw-check, thread, evidence and success callback ordering', async () => {
    const t = threadPublicationFixture({ blocking: false });
    delete t.f.env.REVIEW_AUTHORITATIVE_GATE;
    delete t.f.env.REVIEW_PREPARED_CONFIG_JSON;
    delete t.f.deps.reviewCompletion;
    const evidence = vi.fn(async () => { t.order.push('evidence'); });
    const success = vi.fn(async () => { t.order.push('success'); });
    t.f.deps.completion = { reportTerminalFailure: t.f.legacyFailure,
      reportReviewEvidence: evidence, reportTerminalSuccess: success };
    await runPublishingReviewWorker(t.f.env, t.f.deps);
    expect(t.order).toEqual(['thread-read', 'raw-check', 'thread-publish', 'evidence', 'success']);
    expect(t.statuses).toEqual([200, 200]);
    expect(t.f.reportReviewResult).not.toHaveBeenCalled();
    expect(t.f.checkClient.completeCheck).toHaveBeenCalledOnce();
    expect(evidence).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledOnce();
    expect(t.f.legacyFailure).not.toHaveBeenCalled();
    expect(t.f.fetch).not.toHaveBeenCalled();
  });
});

function retainedContext(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  const source = { executionAttempt: 1, workerResultDigest: 'd'.repeat(64), workerCheckId: 5001,
    gateCheckId: 6001, rawFindingCount: 1, canonicalFindingCount: 1 };
  return createIncompleteP2RecoveryContext({
    version: 'IncompleteP2RecoveryContext.v1', runId: f.env.REVIEW_RUN_ID!, repositoryId: 123,
    owner: 'example', repo: 'project', prNumber: 42, headSha: HEAD, baseSha: BASE, executionAttempt: 2,
    policyDigest: f.prepared.policy.effectivePolicyDigest, configDigest: f.prepared.policy.effectiveConfigDigest,
    expectedAppId: 4385771, sources: [source], findings: [{
      sourceExecutionAttempt: 1, sourceWorkerResultDigest: source.workerResultDigest,
      sourceWorkerCheckId: source.workerCheckId, sourceGateCheckId: source.gateCheckId,
      personaId: 'sec-lane', findingIndex: 0,
      finding: { severity: 'P2', path: 'src/a.ts', line: 1, title: 'Prior advisory', body: 'Verify the old observation against current source.' },
    }], ...overrides,
  } as Parameters<typeof createIncompleteP2RecoveryContext>[0]);
}

describe('REL-1198 publishing panel respects the admitted lifecycle window', () => {
  it.each(['panel', 'composed'] as const)('prepares optional core classification before the %s engine and publishes its receipt', async (reviewEngine) => {
    const f = fixture({ reviewEngine });
    f.env.REVIEW_EXECUTION_ATTEMPT = '1';
    const budgets: number[] = [];
    const createRuntime = deletionEvidenceModule.createDeletionEvidenceRuntime;
    vi.spyOn(deletionEvidenceModule, 'createDeletionEvidenceRuntime').mockImplementation((input) => {
      const runtime = createRuntime(input), prepare = runtime.prepare;
      runtime.prepare = (options) => { budgets.push(options!.budgetMs!); return prepare(options); };
      return runtime;
    });
    const removed = (name: string) => `diff --git a/${name} b/${name}\ndeleted file mode 100644\n--- a/${name}\n+++ /dev/null\n@@ -1 +0,0 @@\n-export function old() {}\n`;
    f.source.diff = removed('src/old.ts') + removed('dist/old.js');
    const readFileAt = vi.fn(async (_path: string, side: string) => ({ sha: side === 'head' ? HEAD : BASE,
      content: side === 'head' ? null : 'export function old() {}' }));
    f.deps.repoFileProviderFactory = () => ({ findFiles: async () => [], readFile: async () => null, readFileAt });
    Object.assign(f.env, { REVIEW_YETI_JEV_EVIDENCE: 'example/project', TYPESAFE_BASE_URL: 'https://jev.example.invalid',
      TYPESAFE_MODEL: 'jev-latest', TYPESAFE_MODEL_PIN: 'jev-test', TYPESAFE_API_KEY: 'test-key' });
    const choices = { risk: 'unknown', subsystem: 'individual', category: 'source', visible_consumer: 'unknown', contract_change: 'unknown' };
    const ask = vi.spyOn(JevClient.prototype, 'ask').mockResolvedValue({ status: 'ok', model: 'jev-test', durationMs: 1,
      answers: Object.fromEntries(Object.entries(choices).map(([id, choice]) => [id,
        { type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } }])),
    } as JevOutcome<string>);
    const runner = vi.fn(async (options: any) => {
      expect(ask).toHaveBeenCalledOnce();
      expect(options.repoFileProvider.deletionPlan()).toMatchObject({ status: 'complete', totalFiles: 1, classifiedFiles: 1 });
      expect(options.repoFileProvider.deletionPlan().groups.flatMap((group: any) => group.paths)).toEqual(['src/old.ts']);
      return f.panel;
    });
    f.deps.panelRunner = runner;
    f.deps.composedReviewRunner = runner;
    await runPublishingReviewWorker(f.env, f.deps);
    expect(runner).toHaveBeenCalledOnce();
    expect(budgets).toEqual([15_000]);
    expect(readFileAt.mock.calls.every(([path]) => path === 'src/old.ts')).toBe(true);
    expect(parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0][0]).result.deletionClassification)
      .toMatchObject({ status: 'complete', totalFiles: 1, classifiedFiles: 1, unresolvedFiles: 0, totalGroups: 1 });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([1_000, 0, -1_000])('reserves the ordinary review window when classification has %sms remaining', async (remaining) => {
    const f = fixture();
    let clock = START;
    f.deps.now = () => clock;
    f.env.REVIEW_TERMINAL_DEADLINE = new Date(START + 360_000).toISOString();
    f.deps.currentPullRequestVerifier = vi.fn(async () => { clock = START + 60_000 - remaining; });
    f.source.diff = 'diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export function old() {}\n';
    f.deps.repoFileProviderFactory = () => ({ findFiles: async () => [], readFile: async () => null,
      readFileAt: async (_path, side) => ({ sha: side === 'head' ? HEAD : BASE,
        content: side === 'head' ? null : 'export function old() {}' }) });
    Object.assign(f.env, { REVIEW_YETI_JEV_EVIDENCE: 'example/project', TYPESAFE_BASE_URL: 'https://jev.example.invalid',
      TYPESAFE_MODEL: 'jev-latest', TYPESAFE_MODEL_PIN: 'jev-test', TYPESAFE_API_KEY: 'test-key' });
    const ask = vi.spyOn(JevClient.prototype, 'ask').mockImplementation(async () => new Promise(() => {}));
    const budgets: number[] = [];
    const createRuntime = deletionEvidenceModule.createDeletionEvidenceRuntime;
    vi.spyOn(deletionEvidenceModule, 'createDeletionEvidenceRuntime').mockImplementation((input) => {
      const runtime = createRuntime(input), prepare = runtime.prepare;
      runtime.prepare = (options) => { budgets.push(options!.budgetMs!); return prepare(options); };
      return runtime;
    });
    const result = await runPublishingReviewWorker(f.env, f.deps).then(() => undefined, (error: unknown) => error);
    expect(budgets).toEqual([Math.max(0, remaining / 10)]);
    expect(f.reportReviewResult).toHaveBeenCalledOnce();
    const event = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0][0]);
    if (remaining > 0) {
      expect(result).toBeUndefined();
      expect(ask).toHaveBeenCalledOnce();
      expect(f.panelRunner).toHaveBeenCalledOnce();
      expect(event.result).toMatchObject({ coverageComplete: true,
        deletionClassification: { status: 'partial', classifiedFiles: 0, unresolvedFiles: 1 } });
    } else {
      expect(result).toBeInstanceOf(panelEngine.PanelDeadlineExceededError);
      expect(ask).not.toHaveBeenCalled();
      expect(f.panelRunner).not.toHaveBeenCalled();
      expect(event.result).toMatchObject({ coverageComplete: false, quorumSatisfied: false });
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('synthesizes and publishes the latest checkpoint when a composed runner ignores cancellation', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START);
    const f = fixture({ reviewEngine: 'composed' });
    f.env.REVIEW_EXECUTION_ATTEMPT = '1';
    f.deps.now = Date.now;
    f.deps.prLifecycleHistory = completeEmptyLifecycleHistory() as never;
    f.env.REVIEW_TERMINAL_DEADLINE = new Date(START + 360_000).toISOString();
    const write = vi.fn(async () => 2);
    f.deps.reviewCheckpoint = { read: vi.fn(async () => ({ checkpoint: null, disputedFindingRechecks: [] })), write };
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.deps.composedReviewRunner = vi.fn(async (options) => {
      await options.checkpoint!.save({ revision: 2, plan: [{ id: 'security-auth', dimension: 'security',
        paths: ['src/a.ts'], question: 'Is authentication safe?', rationale: 'Highest-risk path first.' }],
      completedTasks: [{ id: 'security-auth', findings: [{ severity: 'P1', path: 'src/a.ts', line: 1,
        title: 'Preserved checkpoint finding', body: 'The closeout must publish this validated defect.' }] }] });
      entered();
      return new Promise<PanelResult>(() => {});
    });
    const pending = runPublishingReviewWorker(f.env, f.deps);
    try {
      await started;
      await vi.advanceTimersByTimeAsync(60_000);
      const receipt = await pending;
      expect(receipt).toMatchObject({ verdict: 'INCOMPLETE', conclusion: 'failure', findingCount: 0,
        blockingFindingCount: 0, failureClass: 'timeout' });
      expect(write).toHaveBeenCalledOnce();
      const event = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0][0]);
      expect(event.result).toMatchObject({ coverageComplete: false, quorumSatisfied: false,
        personas: [expect.objectContaining({ id: 'security-auth', status: 'COMPLETE', findings: [] })],
        groundedReview: { verification: { candidates: 1, calls: 0, insufficient: 1,
          unverifiedBlockerCount: 1, coverageComplete: false, outcomes: [expect.objectContaining({
            status: 'insufficient', severity: 'P1', path: 'src/a.ts', title: 'Preserved checkpoint finding',
          })] } } });
      expect(f.checkClient.completeCheck).toHaveBeenCalledWith(expect.objectContaining({
        conclusion: 'failure', title: 'Review Yeti: INCOMPLETE (partial evidence published)',
        summary: expect.stringContaining('fail-closed'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['panel', 'composed', 'shadow'] as const)(
    'stops %s before the Job deadline and persists only a fail-closed receipt', async (reviewEngine) => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
      const f = fixture({ reviewEngine });
      f.env.REVIEW_EXECUTION_ATTEMPT = '1';
      f.deps.now = Date.now;
      // Simulate queue/startup/setup consuming all but three minutes. No map-reduce flag.
      f.env.REVIEW_TERMINAL_DEADLINE = new Date(START + 360_000).toISOString();
      const configBefore = f.env.REVIEW_PREPARED_CONFIG_JSON;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      f.panelRunner.mockImplementation(async () => { entered(); return new Promise<PanelResult>(() => {}); });
      f.deps.composedReviewRunner = f.panelRunner;
      const pending = runPublishingReviewWorker(f.env, f.deps).then(
        () => new Error('A timed-out panel must not succeed'), (error: unknown) => error,
      );
      try {
        await started;
        await vi.advanceTimersByTimeAsync(59_999);
        expect(f.reportReviewResult).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await pending;
        // The evidence phase stops at the exact five-minute closeout boundary.
        expect(f.reportReviewResult).toHaveBeenCalledOnce();
        const event = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0][0]);
        expect(event.result.coverageComplete).toBe(false);
        expect(event.result.quorumSatisfied).toBe(false);
        expect(event.result.personas.length).toBeGreaterThan(0);
        expect(event.result.personas.map((persona) => persona.id)).toEqual(f.prepared.expectedPersonaIds);
        expect(event.result.personas.every((p) => p.status === 'ERROR' && p.errorClass === 'timeout')).toBe(true);
        expect(event.executionAttempt).toBe(1);
        expect(event.headSha).toBe(HEAD);
        expect(f.env.REVIEW_PREPARED_CONFIG_JSON).toBe(configBefore);
        expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
        expect(f.checkClient.completeCheck.mock.calls.every(([check]) => check.conclusion === 'failure')).toBe(true);
        expect(await pending).toBeInstanceOf(panelEngine.PanelDeadlineExceededError);
      } finally {
        // Consume the old implementation's timer too, so RED runs do not leak work.
        await vi.runAllTimersAsync();
        await pending;
        vi.useRealTimers();
      }
    },
  );

  it.each([new Date(START + 300_000).toISOString(), new Date(START - 1).toISOString(), 'invalid'])
  ('refuses exhausted or malformed lifecycle deadline %s before entering the panel', async (deadline) => {
    const f = fixture();
    f.deps.now = () => START;
    f.env.REVIEW_TERMINAL_DEADLINE = deadline;
    const result = await runPublishingReviewWorker(f.env, f.deps).then(() => undefined, (error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(f.panelRunner).not.toHaveBeenCalled();
    expect(f.reportReviewResult).toHaveBeenCalledOnce();
    const receipt = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0][0]);
    expect(receipt.result.coverageComplete).toBe(false);
    expect(receipt.result.quorumSatisfied).toBe(false);
    expect(f.client.complete).not.toHaveBeenCalled();
  });

  it('does not restart the shadow clock after grounding or accept a late clean panel', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START);
    const f = fixture({ reviewEngine: 'shadow' });
    const cleanup = new AbortController();
    f.deps.signal = cleanup.signal;
    f.deps.now = Date.now;
    f.env.REVIEW_TERMINAL_DEADLINE = new Date(START + 360_000).toISOString();
    f.env.ZOEKT_GROUNDING_ENABLED = 'true';
    f.deps.zoektGrounding = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
      return {};
    });
    let release!: (panel: PanelResult) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    f.panelRunner.mockImplementation(async () => { entered(); return new Promise<PanelResult>((resolve) => { release = resolve; }); });
    const shadow = vi.fn<NonNullable<PublishingReviewDeps['composedReviewRunner']>>(
      async () => new Promise<PanelResult>(() => {}),
    );
    f.deps.composedReviewRunner = shadow;
    const pending = runPublishingReviewWorker(f.env, f.deps).then(() => undefined, (error: unknown) => error);
    try {
      await started;
      await vi.advanceTimersByTimeAsync(49_999);
      expect(f.reportReviewResult).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeInstanceOf(panelEngine.PanelDeadlineExceededError);
      expect(f.panelRunner.mock.calls[0][0].signal?.aborted).toBe(true);
      expect(shadow.mock.calls[0][0].signal?.aborted).toBe(true);
      expect(shadow.mock.calls[0][0].signal).not.toBe(f.panelRunner.mock.calls[0][0].signal);
      const receiptBeforeLateResult = structuredClone(f.reportReviewResult.mock.calls);
      release(f.panel);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.reportReviewResult.mock.calls).toEqual(receiptBeforeLateResult);
      expect(f.reportReviewResult).toHaveBeenCalledOnce();
      expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
      expect(f.checkClient.completeCheck.mock.calls.every(([check]) => check.conclusion === 'failure')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      try {
        cleanup.abort();
        release?.(f.panel);
        await vi.advanceTimersByTimeAsync(0);
        await pending;
      } finally { vi.useRealTimers(); }
    }
  });

  it('finalizes at the lifecycle cutoff while grounding stalls, then removes a late scratch result', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START);
    const f = fixture();
    f.deps.now = Date.now;
    f.env.REVIEW_TERMINAL_DEADLINE = new Date(START + 360_000).toISOString();
    let groundingSignal: AbortSignal | undefined;
    let releaseGrounding!: (result: { indexDir: string; scratchDir: string }) => void;
    let started!: () => void;
    const groundingStarted = new Promise<void>((resolve) => { started = resolve; });
    f.deps.zoektGrounding = vi.fn(((input: { signal?: AbortSignal }) => {
      groundingSignal = input.signal;
      started();
      return new Promise((resolve) => { releaseGrounding = resolve; });
    }) as NonNullable<PublishingReviewDeps['zoektGrounding']>);
    const originalRemoveScratchTree = zoektGroundingModule.removeScratchTree;
    let lateScratchRemoved!: () => void;
    const lateCleanup = new Promise<void>((resolve) => { lateScratchRemoved = resolve; });
    const removeScratchTree = vi.spyOn(zoektGroundingModule, 'removeScratchTree').mockImplementation(async (scratchDir) => {
      await originalRemoveScratchTree(scratchDir);
      if (lateScratch && scratchDir === lateScratch) lateScratchRemoved();
    });
    const pending = runPublishingReviewWorker(f.env, f.deps).then(
      () => undefined,
      (error: unknown) => error,
    );
    let lateScratch: string | undefined;
    try {
      await groundingStarted;
      // The absolute deadline is 360s away; the protected closeout leaves 60s.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(groundingSignal?.aborted).toBe(true);
      expect(f.reportReviewResult).toHaveBeenCalledOnce();
      expect(f.panelRunner).not.toHaveBeenCalled();
      expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
      expect(f.checkClient.completeCheck.mock.calls.every(([check]) => check.conclusion === 'failure')).toBe(true);
      expect(await pending).toBeInstanceOf(panelEngine.PanelDeadlineExceededError);

      lateScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-late-grounding-'));
      fs.writeFileSync(path.join(lateScratch, 'late-result'), 'must be removed');
      releaseGrounding({ indexDir: `${lateScratch}/index`, scratchDir: lateScratch });
      await lateCleanup;
      expect(fs.existsSync(lateScratch)).toBe(false);
      expect(removeScratchTree.mock.calls.filter(([scratchDir]) => scratchDir === lateScratch)).toHaveLength(1);
      expect(removeScratchTree).toHaveBeenCalledOnce();
      expect(f.reportReviewResult).toHaveBeenCalledOnce();
      expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
      expect(f.checkClient.completeCheck.mock.calls.every(([check]) => check.conclusion === 'failure')).toBe(true);
    } finally {
      // On the intentionally red baseline, release the fake dependency so the test
      // leaves no pending worker or temporary fixture behind.
      const cleanupScratch = lateScratch || fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-late-grounding-cleanup-'));
      releaseGrounding?.({ indexDir: path.join(cleanupScratch, 'index'), scratchDir: cleanupScratch });
      await vi.runAllTimersAsync();
      await pending;
      await originalRemoveScratchTree(cleanupScratch);
      removeScratchTree.mockRestore();
      vi.useRealTimers();
    }
  });

  it('owns a producer-resolved scratch receipt when queued abort wins delivery, and removes it exactly once', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START);
    const f = fixture();
    const controller = new AbortController();
    f.deps.signal = controller.signal;
    f.deps.now = Date.now;
    f.env.REVIEW_TERMINAL_DEADLINE = new Date(START + 360_000).toISOString();
    f.env.ZOEKT_GROUNDING_ENABLED = 'true';
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-yeti-grounding-receipt-race-'));
    fs.writeFileSync(path.join(scratchDir, 'producer-result'), 'must have one cleanup owner');
    let releaseGrounding!: (result: { indexDir: string; scratchDir: string }) => void;
    let started!: () => void;
    const groundingStarted = new Promise<void>((resolve) => { started = resolve; });
    f.deps.zoektGrounding = vi.fn(() => {
      started();
      return new Promise((resolve) => { releaseGrounding = resolve; });
    }) as NonNullable<PublishingReviewDeps['zoektGrounding']>;
    const originalRemoveScratchTree = zoektGroundingModule.removeScratchTree;
    const removeScratchTree = vi.spyOn(zoektGroundingModule, 'removeScratchTree')
      .mockImplementation(originalRemoveScratchTree);
    const order: string[] = [];
    const pending = runPublishingReviewWorker(f.env, f.deps).then(
      () => new Error('A cancelled grounding race must not succeed'), (error: unknown) => error,
    );
    try {
      await groundingStarted;
      order.push('producer-resolved');
      releaseGrounding({ indexDir: path.join(scratchDir, 'index'), scratchDir });
      // Let the producer receipt observer run with a live signal, then abort before
      // the observer's async result is delivered to raceWithPanelAbort's consumer.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
        order.push('abort');
        controller.abort();
      })));
      expect(await pending).toBeInstanceOf(panelEngine.PanelCancellationError);
      expect(order).toEqual(['producer-resolved', 'abort']);
      expect(f.panelRunner).not.toHaveBeenCalled();
      expect(f.client.complete).not.toHaveBeenCalled();
      expect(f.reportReviewResult).toHaveBeenCalledOnce();
      const event = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0][0]);
      expect(event.result.coverageComplete).toBe(false);
      expect(event.result.quorumSatisfied).toBe(false);
      expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
      expect(f.checkClient.completeCheck.mock.calls[0][0].conclusion).toBe('failure');
      expect(removeScratchTree.mock.calls.filter(([ownedDir]) => ownedDir === scratchDir)).toHaveLength(1);
      expect(removeScratchTree).toHaveBeenCalledOnce();
      expect(fs.existsSync(scratchDir)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      releaseGrounding?.({ indexDir: path.join(scratchDir, 'index'), scratchDir });
      await pending;
      await originalRemoveScratchTree(scratchDir);
      removeScratchTree.mockRestore();
      vi.useRealTimers();
    }
  });

  it('finalizes at the unchanged cutoff without awaiting a never-settling grounding producer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START);
    const f = fixture();
    f.deps.now = Date.now;
    f.env.REVIEW_TERMINAL_DEADLINE = new Date(START + 360_000).toISOString();
    let groundingSignal: AbortSignal | undefined;
    let started!: () => void;
    const groundingStarted = new Promise<void>((resolve) => { started = resolve; });
    f.deps.zoektGrounding = vi.fn(((input: { signal?: AbortSignal }) => {
      groundingSignal = input.signal;
      started();
      return new Promise(() => {});
    }) as NonNullable<PublishingReviewDeps['zoektGrounding']>);
    const pending = runPublishingReviewWorker(f.env, f.deps).then(
      () => new Error('A never-settling grounding producer must not succeed'), (error: unknown) => error,
    );
    try {
      await groundingStarted;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.reportReviewResult).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeInstanceOf(panelEngine.PanelDeadlineExceededError);
      expect(groundingSignal?.aborted).toBe(true);
      expect(f.panelRunner).not.toHaveBeenCalled();
      expect(f.client.complete).not.toHaveBeenCalled();
      expect(f.reportReviewResult).toHaveBeenCalledOnce();
      const event = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0][0]);
      expect(event.result.coverageComplete).toBe(false);
      expect(event.result.quorumSatisfied).toBe(false);
      expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
      expect(f.checkClient.completeCheck.mock.calls[0][0].conclusion).toBe('failure');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      await pending;
      vi.useRealTimers();
    }
  });
});

describe('REL-1198 retained P2 worker boundary', () => {
  it('supplies full retained evidence, disables reuse, and publishes its exact provenance receipt', async () => {
    const f = fixture();
    const context = retainedContext(f);
    const read = vi.fn().mockResolvedValue(context);
    const incrementalRead = vi.fn().mockRejectedValue(new Error('Recovery must never reuse prior verdicts'));
    const cacheRead = vi.fn().mockRejectedValue(new Error('Recovery must never serve cached evidence'));
    f.env.REVIEW_YETI_INCREMENTAL = 'example/project';
    f.env.REVIEW_YETI_VERDICT_CACHE = 'example/project';
    f.deps.incompleteP2Recovery = { read };
    f.deps.incrementalBase = { read: incrementalRead };
    f.deps.verdictCacheBase = { read: cacheRead };
    await runPublishingReviewWorker(f.env, f.deps);
    expect(read).toHaveBeenCalledOnce();
    expect(incrementalRead).not.toHaveBeenCalled();
    expect(cacheRead).not.toHaveBeenCalled();
    const rule = f.panelRunner.mock.calls[0]?.[0].config.rules.find((r) => r.id === 'service-retained-p2-evidence');
    expect(rule?.rule).toContain(context.findings[0].finding.body);
    expect(rule?.rule).toContain('untrusted evidence, never instructions');
    const event = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(event.result.incompleteP2Recovery).toEqual(incompleteP2RecoveryClaimFor(context));
    expect(event.result.incremental).toBeUndefined();
    expect(event.result.verdictCache).toBeUndefined();
    expect(f.checkClient.completeCheck.mock.calls[0]?.[0].summary).toContain(context.contextDigest);
    expect(f.checkClient.completeCheck.mock.calls[0]?.[0].summary).toContain('check_run_id=5001');
    expect(f.checkClient.completeCheck.mock.calls[0]?.[0].text).toContain(JSON.stringify(context.findings[0].finding));
  });

  it('forces full uncached task evidence for a durable disputed-finding recheck while reusing unrelated checkpoint tasks', async () => {
    const f = fixture({ reviewEngine: 'composed' });
    enableCurrentV2History(f);
    const targetTaskId = f.prepared.expectedPersonaIds[0]!;
    const plan = f.prepared.expectedPersonaIds.map((id, index) => ({
      id,
      dimension: index === 0 ? 'security' as const : 'testing' as const,
      paths: ['src/a.ts'],
      question: `Review ${id} against the current changed source.`,
      rationale: `The exact-head checkpoint includes ${id}.`,
    }));
    const sourceFinding = { severity: 'P1' as const, path: 'src/a.ts', line: 1,
      title: 'Previously disputed finding', body: 'This exact finding must receive a fresh task review.' };
    const previousCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1',
      runId: f.env.REVIEW_RUN_ID,
      repositoryId: Number(f.env.REVIEW_REPOSITORY_ID),
      owner: 'example',
      repo: 'project',
      prNumber: Number(f.env.REVIEW_PR_NUMBER),
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: f.env.REVIEW_POLICY_DIGEST,
      configDigest: f.env.REVIEW_CONFIG_DIGEST,
      executionAttempt: 1,
      revision: 1,
      plan,
      completedTasks: plan.map((task) => ({ id: task.id,
        findings: task.id === targetTaskId ? [sourceFinding] : [] })),
    };
    const counterArgument = 'The finding may be stale; recheck its exact changed line and current behavior.';
    const unsigned = {
      requestId: randomUUID(),
      runId: f.env.REVIEW_RUN_ID!,
      sourceExecutionAttempt: 1,
      sourceContentDigest: 'd'.repeat(64),
      sourcePlanDigest: sha256(canonicalJson(plan)),
      sourceGateAttemptId: `${f.env.REVIEW_RUN_ID}-g0-e1`,
      repositoryId: Number(f.env.REVIEW_REPOSITORY_ID),
      owner: 'example',
      repo: 'project',
      prNumber: Number(f.env.REVIEW_PR_NUMBER),
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: f.env.REVIEW_POLICY_DIGEST!,
      configDigest: f.env.REVIEW_CONFIG_DIGEST!,
      findingId: 'source-finding-id',
      personaId: targetTaskId,
      taskId: targetTaskId,
      finding: sourceFinding,
      counterArgument,
      counterArgumentDigest: sha256(counterArgument),
    };
    const recheck = { ...unsigned, requestDigest: disputedFindingRecheckDigest(unsigned) };
    const read = vi.fn(async () => ({ checkpoint: previousCheckpoint as any, disputedFindingRechecks: [recheck] }));
    const write = vi.fn(async (_snapshot: any) => 3);
    const incrementalRead = vi.fn().mockRejectedValue(new Error('A disputed finding must use full current-source evidence'));
    const cacheRead = vi.fn().mockRejectedValue(new Error('A disputed finding must not use cached verdicts'));
    f.env.REVIEW_YETI_INCREMENTAL = 'example/project';
    f.env.REVIEW_YETI_VERDICT_CACHE = 'example/project';
    f.deps.incrementalBase = { read: incrementalRead };
    f.deps.verdictCacheBase = { read: cacheRead };
    f.deps.reviewCheckpoint = { read, write } as any;
    const composedReviewRunner = vi.fn(async (options: any) => {
      expect(options.changedFiles.map((file: { path: string }) => file.path)).toContain('src/a.ts');
      expect(options.incremental).toBeUndefined();
      expect(options.verdictCache).toBeUndefined();
      expect(options.disputedFindingRechecks).toEqual([recheck]);
      expect(options.checkpoint.resumed.completedTasks.map((task: { id: string }) => task.id))
        .not.toContain(targetTaskId);
      expect(options.checkpoint.resumed.completedTasks.map((task: { id: string }) => task.id))
        .toContain(f.prepared.expectedPersonaIds[1]);
      await options.checkpoint.save({ revision: 2, plan,
        completedTasks: plan.map((task) => ({ id: task.id, findings: [] })),
        satisfiedFindingRecheckIds: [recheck.requestId] });
      return f.panel;
    });
    f.deps.composedReviewRunner = composedReviewRunner;

    await runPublishingReviewWorker(f.env, f.deps);

    expect(read).toHaveBeenCalledOnce();
    expect(incrementalRead).not.toHaveBeenCalled();
    expect(cacheRead).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    const event = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(event.result.incremental).toBeUndefined();
    expect(event.result.verdictCache).toBeUndefined();
    expect(write.mock.calls[0]?.[0]).toMatchObject({ plan, satisfiedFindingRecheckIds: [recheck.requestId] });
  });

  it('continues evaluating configured incremental and cache reuse when no dispute is pending', async () => {
    const f = fixture({ reviewEngine: 'composed' });
    enableCurrentV2History(f);
    f.env.REVIEW_YETI_INCREMENTAL = 'example/project';
    f.env.REVIEW_YETI_VERDICT_CACHE = 'example/project';
    const incrementalRead = vi.fn(async () => ({ prior: null, maxAgeMs: 60_000 }));
    const cacheRead = vi.fn(async () => ({ source: null, maxAgeMs: 60_000 }));
    const comparisonContent = vi.fn(async () => ({ files: [{ path: 'src/a.ts', status: 'modified',
      blobSha: 'a'.repeat(40), patch: `@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n` }] }));
    const composedReviewRunner = vi.fn(async (_options: any) => f.panel);
    const retryTaskPlan = [{ id: 'retry-task', dimension: 'testing' as const, paths: ['src/a.ts'],
      question: 'Does the retry still cover the changed source?', rationale: 'The exact checkpoint is this retry boundary.' }];
    const exactRetryCheckpoint = {
      version: 'ReviewExecutionCheckpoint.v1' as const,
      runId: f.env.REVIEW_RUN_ID!,
      repositoryId: Number(f.env.REVIEW_REPOSITORY_ID),
      owner: 'example',
      repo: 'project',
      prNumber: Number(f.env.REVIEW_PR_NUMBER),
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: f.prepared.policy.effectivePolicyDigest,
      configDigest: f.prepared.policy.effectiveConfigDigest,
      executionAttempt: 1,
      revision: 1,
      plan: retryTaskPlan,
      completedTasks: [],
    };
    f.deps.incrementalBase = { read: incrementalRead };
    f.deps.verdictCacheBase = { read: cacheRead };
    f.deps.verdictCacheCompareReader = { content: comparisonContent };
    f.deps.composedReviewRunner = composedReviewRunner;
    const checkpointRead = vi.fn(async () => ({ checkpoint: exactRetryCheckpoint, disputedFindingRechecks: [] }));
    f.deps.reviewCheckpoint = {
      read: checkpointRead,
      write: vi.fn(async () => 1),
    };

    await runPublishingReviewWorker(f.env, f.deps);

    expect(incrementalRead).toHaveBeenCalledOnce();
    expect(cacheRead).toHaveBeenCalledOnce();
    expect(comparisonContent).toHaveBeenCalledOnce();
    expect(checkpointRead).toHaveBeenCalledOnce();
    expect(composedReviewRunner).toHaveBeenCalledOnce();
    const options = composedReviewRunner.mock.calls[0]![0];
    expect(options.checkpoint?.resumed).toMatchObject({
      runId: f.env.REVIEW_RUN_ID,
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: f.prepared.policy.effectivePolicyDigest,
      configDigest: f.prepared.policy.effectiveConfigDigest,
    });
    expect(options.verdictCache).toMatchObject({ source: null, permitted: [] });
    expect(options.disputedFindingRechecks).toBeUndefined();
  });

  it.each(['unavailable', 'partial', 'incompatible'] as const)(
    'does not resume an exact checkpoint or reuse incremental/cache plans when lifecycle history is %s', async (historyState) => {
      const f = fixture({ reviewEngine: 'composed' });
      f.env.REVIEW_EXECUTION_ATTEMPT = '1';
      if (historyState !== 'unavailable') configureHistoryCase(f, historyState);
      f.env.REVIEW_YETI_INCREMENTAL = 'example/project';
      f.env.REVIEW_YETI_VERDICT_CACHE = 'example/project';
      const checkpointRead = vi.fn(async () => ({ checkpoint: exactWorkerCheckpoint(f), disputedFindingRechecks: [] }));
      const incrementalRead = vi.fn(async () => ({ prior: null, maxAgeMs: 60_000 }));
      const cacheRead = vi.fn(async () => ({ source: null, maxAgeMs: 60_000 }));
      const composedRunner = vi.fn(async (options: any) => {
        expect(options.checkpoint?.resumed ?? null).toBeNull();
        expect(options.disputedFindingRechecks).toBeUndefined();
        expect(options.incremental).toBeUndefined();
        expect(options.verdictCache).toBeUndefined();
        expect(options.changedFiles).toEqual([{ path: 'src/a.ts', patch: DIFF }]);
        return f.panel;
      });
      f.deps.reviewCheckpoint = { read: checkpointRead, write: vi.fn(async () => 1) } as never;
      f.deps.incrementalBase = { read: incrementalRead };
      f.deps.verdictCacheBase = { read: cacheRead };
      f.deps.composedReviewRunner = composedRunner;

      await runPublishingReviewWorker(f.env, f.deps);

      expect(incrementalRead).not.toHaveBeenCalled();
      expect(cacheRead).not.toHaveBeenCalled();
      expect(composedRunner).toHaveBeenCalledOnce();
      expect(f.client.complete).not.toHaveBeenCalled();
      if (historyState === 'unavailable') {
        expect(f.reportReviewResult.mock.calls[0]?.[0].result.groundedReview?.history).toMatchObject({
          status: 'unavailable', omissions: ['no authenticated lifecycle history source'],
        });
      }
    });

  it.each(['unavailable', 'partial', 'incompatible'] as const)(
    'fails a retry before model work when lifecycle history is %s despite a valid exact checkpoint and dispute request', async (historyState) => {
      const f = fixture({ reviewEngine: 'composed' });
      f.env.REVIEW_EXECUTION_ATTEMPT = '2';
      if (historyState !== 'unavailable') configureHistoryCase(f, historyState);
      const checkpoint = exactWorkerCheckpoint(f);
      const dispute = validDisputeForCheckpoint(f, checkpoint);
      const checkpointRead = vi.fn(async () => ({ checkpoint, disputedFindingRechecks: [dispute] }));
      f.deps.reviewCheckpoint = { read: checkpointRead, write: vi.fn(async () => 2) } as never;
      const composedRunner = vi.fn(async () => f.panel);
      f.deps.composedReviewRunner = composedRunner;

      await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow(
        'Exact-head checkpoint and disputed finding requests are required for a safe retry',
      );

      expect(checkpointRead).not.toHaveBeenCalled();
      expect(composedRunner).not.toHaveBeenCalled();
      expect(f.client.complete).not.toHaveBeenCalled();
    });

  it('publishes a valid retained P2 context below the complete Checks text bound without truncation', async () => {
    const f = fixture();
    const source = { executionAttempt: 1, workerResultDigest: 'd'.repeat(64), workerCheckId: 5001,
      gateCheckId: 6001, rawFindingCount: 4, canonicalFindingCount: 4 };
    const findings = Array.from({ length: 4 }, (_, findingIndex) => ({
      sourceExecutionAttempt: 1,
      sourceWorkerResultDigest: source.workerResultDigest,
      sourceWorkerCheckId: source.workerCheckId,
      sourceGateCheckId: source.gateCheckId,
      personaId: 'sec-lane',
      findingIndex,
      finding: { severity: 'P2' as const, path: 'src/a.ts', line: 1,
        title: `Prior advisory ${findingIndex}`, body: 'x'.repeat(15_882) },
    }));
    const context = retainedContext(f, { sources: [source], findings });
    const contextBytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    const renderedRetainedText = [
      renderFindingsMarkdown([], 0),
      '### Retained P2 observations (original evidence)',
      'These original observations remain advisory and were supplied to the full review above. Their source records are immutable; this section does not attribute them to a new reviewer.',
      ...context.findings.map((entry) => [
        `Attempt ${entry.sourceExecutionAttempt}, App check ${entry.sourceWorkerCheckId}, Gate ${entry.sourceGateCheckId}, persona ${entry.personaId}, finding ${entry.findingIndex}, worker result ${entry.sourceWorkerResultDigest}:`,
        '',
        `${'`'.repeat(4)}json`,
        JSON.stringify(entry.finding),
        '`'.repeat(4),
      ].join('\n')),
    ].join('\n\n');

    expect(contextBytes).toBeLessThanOrEqual(MAX_INCOMPLETE_P2_RECOVERY_BYTES);
    expect(contextBytes).toBeGreaterThan(64_000);
    expect(contextBytes).toBe(65_535);
    expect(renderedRetainedText).toContain(context.findings[3].finding.body);
    expect(Buffer.byteLength(renderedRetainedText, 'utf8')).toBeGreaterThan(64_000);
    expect(Buffer.byteLength(renderedRetainedText, 'utf8')).toBe(64_796);
    expect(Buffer.byteLength(renderedRetainedText, 'utf8')).toBeLessThanOrEqual(65_000);

    const read = vi.fn().mockResolvedValue(context);
    f.deps.incompleteP2Recovery = { read };
    await runPublishingReviewWorker(f.env, f.deps);

    expect(read).toHaveBeenCalledOnce();
    expect(f.panelRunner).toHaveBeenCalledOnce();
    expect(f.reportReviewResult).toHaveBeenCalledOnce();
    const terminalCompletion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(terminalCompletion.result.incompleteP2Recovery).toEqual(incompleteP2RecoveryClaimFor(context));
    expect(terminalCompletion.result.personas.every((persona) => persona.status === 'COMPLETE')).toBe(true);
    expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
    const publishedCheck = f.checkClient.completeCheck.mock.calls[0]?.[0];
    expect(publishedCheck?.conclusion).toBe('success');
    expect(publishedCheck?.text).toBe(renderedRetainedText);
    expect(Buffer.byteLength(publishedCheck?.text ?? '', 'utf8')).toBe(Buffer.byteLength(renderedRetainedText, 'utf8'));
    expect(context.findings.every((entry) => publishedCheck?.text?.includes(JSON.stringify(entry.finding)))).toBe(true);
    expect(context.findings).toHaveLength(4);
    expect(context.findings.every((entry) => entry.finding.body === 'x'.repeat(15_882))).toBe(true);
  });

  it('fails closed without truncation when fresh and retained evidence exceed 65,000 bytes', async () => {
    const f = fixture();
    const source = { executionAttempt: 1, workerResultDigest: 'd'.repeat(64), workerCheckId: 5001,
      gateCheckId: 6001, rawFindingCount: 4, canonicalFindingCount: 4 };
    const findings = Array.from({ length: 4 }, (_, findingIndex) => ({
      sourceExecutionAttempt: 1,
      sourceWorkerResultDigest: source.workerResultDigest,
      sourceWorkerCheckId: source.workerCheckId,
      sourceGateCheckId: source.gateCheckId,
      personaId: 'sec-lane',
      findingIndex,
      finding: { severity: 'P2' as const, path: 'src/a.ts', line: 1,
        title: `Prior advisory ${findingIndex}`, body: 'x'.repeat(15_882) },
    }));
    const context = retainedContext(f, { sources: [source], findings });
    const freshFinding = { severity: 'P2' as const, path: 'src/a.ts', line: 1,
      title: 'Fresh advisory', body: 'y'.repeat(1_000) };
    f.panel.personas[0]!.decision = 'FINDINGS';
    f.panel.personas[0]!.findings.push(freshFinding);
    const combinedCheckText = [
      renderFindingsMarkdown([freshFinding], 0),
      '### Retained P2 observations (original evidence)',
      'These original observations remain advisory and were supplied to the full review above. Their source records are immutable; this section does not attribute them to a new reviewer.',
      ...context.findings.map((entry) => [
        `Attempt ${entry.sourceExecutionAttempt}, App check ${entry.sourceWorkerCheckId}, Gate ${entry.sourceGateCheckId}, persona ${entry.personaId}, finding ${entry.findingIndex}, worker result ${entry.sourceWorkerResultDigest}:`,
        '',
        `${'`'.repeat(4)}json`,
        JSON.stringify(entry.finding),
        '`'.repeat(4),
      ].join('\n')),
    ].join('\n\n');

    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(MAX_INCOMPLETE_P2_RECOVERY_BYTES);
    expect(Buffer.byteLength(combinedCheckText, 'utf8')).toBeGreaterThan(65_000);
    expect(Buffer.byteLength(combinedCheckText, 'utf8')).toBeGreaterThan(65_535);

    const read = vi.fn().mockResolvedValue(context);
    f.deps.incompleteP2Recovery = { read };
    await expect(runPublishingReviewWorker(f.env, f.deps))
      .rejects.toThrow('Retained findings and fresh findings exceed the complete publication bound');

    expect(read).toHaveBeenCalledOnce();
    expect(f.panelRunner).toHaveBeenCalledOnce();
    expect(f.reportReviewResult).toHaveBeenCalledOnce();
    const terminalCompletion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(terminalCompletion.result.incompleteP2Recovery).toBeUndefined();
    expect(terminalCompletion.result.personas.every((persona) =>
      persona.status === 'ERROR' && persona.findings.length === 0)).toBe(true);
    expect(f.checkClient.completeCheck).toHaveBeenCalledOnce();
    const failureCheck = f.checkClient.completeCheck.mock.calls[0]?.[0];
    expect(failureCheck).toMatchObject({ conclusion: 'failure', title: 'Review Yeti: review did not complete' });
    expect(failureCheck).not.toHaveProperty('text');
    expect(failureCheck?.summary).not.toContain('Retained P2 observations');
    expect(context.findings).toHaveLength(4);
    expect(context.findings.every((entry) => entry.finding.body === 'x'.repeat(15_882))).toBe(true);
    expect(f.panel.personas[0]!.findings[0]?.body).toBe('y'.repeat(1_000));
  });

  it('stops before model execution when the mandatory retained context read fails', async () => {
    const f = fixture();
    f.deps.incompleteP2Recovery = { read: vi.fn().mockRejectedValue(new Error('Archive unavailable')) };
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow('Archive unavailable');
    expect(f.panelRunner).not.toHaveBeenCalled();
  });

  it('rejects a validly digested context for another head before model execution', async () => {
    const f = fixture();
    f.deps.incompleteP2Recovery = { read: vi.fn().mockResolvedValue(retainedContext(f, { headSha: 'f'.repeat(40) })) };
    await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow('does not match this execution');
    expect(f.panelRunner).not.toHaveBeenCalled();
  });

  it('preserves the ordinary zero-finding recovery when the service reports no retained context', async () => {
    const f = fixture();
    f.deps.incompleteP2Recovery = { read: vi.fn().mockResolvedValue(null) };
    await runPublishingReviewWorker(f.env, f.deps);
    const event = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(event.result.incompleteP2Recovery).toBeUndefined();
    expect(f.panelRunner.mock.calls[0]?.[0].config.rules.some((r) => r.id === 'service-retained-p2-evidence')).toBe(false);
  });
});

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
  it('bounds real retrying HTTP attempts to the prepared 100-attempt budget when worker env says 200', async () => {
    const f = fixture({ reviewEngine: 'composed' });
    f.env.REVIEW_EXECUTION_ATTEMPT = '1';
    f.env.COMPOSED_ENGINE_MAX_TURNS = '200';
    let fetchCount = 0;
    const responseStatuses: number[] = [];
    const attemptsByRequest = new Map<string, number>();
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount += 1;
      const payload = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: unknown }> };
      const requestId = String(payload.messages?.[0]?.content ?? 'missing-request-id');
      const requestAttempts = (attemptsByRequest.get(requestId) ?? 0) + 1;
      attemptsByRequest.set(requestId, requestAttempts);
      if (requestAttempts === 1) {
        responseStatuses.push(503);
        return new Response('{"error":{"message":"temporary"}}', { status: 503,
          headers: { 'content-type': 'application/json' } });
      }
      responseStatuses.push(200);
      return new Response(JSON.stringify({ id: 'chatcmpl-budget-boundary', object: 'chat.completion', created: 1_700_000_000,
        model: transport.model, choices: [{ index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: '{"status":"ok"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    f.deps.client = new OpenRouterClient({ baseUrl: transport.baseUrl, apiKey: 'test', fetchImplementation,
      maxRetries: 1, initialRetryDelayMs: 0, maxRetryDelayMs: 0, sleep: async () => {}, random: () => 0 });

    let physicalSnapshot: ReturnType<ProviderAttemptBudget['snapshot']> | undefined;
    let investigationSettled: PromiseSettledResult<unknown>[] = [];
    f.deps.composedReviewRunner = vi.fn(async (options: any) => {
      const budget = options.providerAttemptBudget as ProviderAttemptBudget;
      expect(budget.limits).toEqual({ totalLimit: 100, investigationLimit: 88, verificationLimit: 12 });
      const request = { model: transport.model, messages: [{ role: 'user' as const, content: 'synthetic budget-boundary request' }],
        timeoutMs: 10_000, inactivityTimeoutMs: 10_000, stream: false };
      const invoke = (index: number) => options.client.complete({ ...request,
        messages: [{ role: 'user' as const, content: `synthetic budget-boundary request ${index}` }],
        beforePhysicalAttempt: () => budget.beginAttempt('investigation') });
      investigationSettled = await Promise.allSettled(Array.from({ length: 60 }, (_, index) => invoke(index)));
      physicalSnapshot = budget.snapshot();

      const taskPlan = f.prepared.expectedPersonaIds.map((id) => ({ id, dimension: 'testing' as const,
        paths: ['src/a.ts'], question: 'Can the change regress expected behavior?', rationale: 'Inspect the changed source.' }));
      const observer = new ComposedRuntimeResourceObserver({ configDigest: options.effectiveConfigDigest,
        configuration: options.config.review_configuration_receipt, providerAttemptBudget: budget });
      observer.configureBudget({ configuredTotalTurns: budget.limits.totalLimit,
        investigationTurns: budget.limits.investigationLimit, verificationReserveTurns: budget.limits.verificationLimit });
      observer.setPlan(taskPlan);
      for (const task of taskPlan) {
        observer.markTaskStarted(task.id);
        observer.markTaskOutcome(task.id, 'completed', completedTaskSourceDelivery(task.id, task.paths));
      }
      const observation = observer.snapshot('terminal');
      if (!observation) throw new Error('Expected a composed resource observation for the physical budget test');
      return { ...f.panel, taskPlan, composedResourceObservation: observation };
    }) as never;

    await runPublishingReviewWorker(f.env, f.deps);

    expect(fetchImplementation).toHaveBeenCalledTimes(88);
    expect(investigationSettled.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(investigationSettled.some((result) => result.status === 'rejected')).toBe(true);
    expect(responseStatuses).toContain(503);
    expect(responseStatuses).toContain(200);
    expect([...attemptsByRequest.values()]).toContain(2);
    expect(physicalSnapshot).toMatchObject({ totalLimit: 100, investigationLimit: 88, verificationLimit: 12,
      totalStarted: 88, investigationStarted: 88, verificationStarted: 0,
      verificationDenied: 0 });
    expect(physicalSnapshot?.deniedAttempts).toBeGreaterThan(0);
    expect(physicalSnapshot?.investigationDenied).toBe(physicalSnapshot?.deniedAttempts);
    const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    expect(completion.result.composedResources?.providerAttempts).toEqual(physicalSnapshot);
    expect(completion.result.composedResources?.configuration.value?.effective.composed_budget.provider_attempt_budget)
      .toMatchObject({ total_limit: 100, investigation_limit: 88, verifier_reserve: 12, operator_override_value: null });
  });

  it('turns centrally verified documentation-only completion into audited gate eligibility', async () => {
    const f = fixture();
    const docsDiff = `diff --git a/docs/plan.md b/docs/plan.md\n--- a/docs/plan.md\n+++ b/docs/plan.md\n@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n`;
    f.source.diff = docsDiff;
    f.source.diffDigest = createHash('sha256').update(docsDiff).digest('hex');
    f.panelRunner.mockResolvedValue(buildDocumentationOnlyPanelResult(
      HEAD, 'bifrost', 'No analyzable source changed.',
    ));

    await runPublishingReviewWorker(f.env, f.deps);

    const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
    const { version: _version, result: _result, ...expectedCoordinates } = completion;
    const docsFiles = parseChangedFiles(docsDiff).files;
    const expectedAuditDigest = sha256(canonicalJson({
      version: 'NoReviewableContentAudit.v1',
      repositoryId: expectedCoordinates.repositoryId,
      prNumber: expectedCoordinates.prNumber,
      headSha: expectedCoordinates.headSha,
      baseSha: expectedCoordinates.baseSha,
      policyDigest: expectedCoordinates.policyDigest,
      configDigest: expectedCoordinates.configDigest,
      paths: docsFiles.map(({ path }) => path),
    }));
    const derived = deriveCanonicalWorkerReviewEvidence(completion, {
      expectedCoordinates,
      expectedPersonaIds: f.prepared.expectedPersonaIds,
      ...trustedGroundedVerifierContract(f),
      changedFiles: docsFiles,
      coverageComplete: true,
      quorumSatisfied: true,
    });

    expect(derived).toMatchObject({
      valid: true,
      evidence: {
        verdict: 'SHIP', coverageComplete: true, quorumSatisfied: true,
        infrastructureFailure: false, p0Count: 0, p1Count: 0,
        expectedLanes: 0, completedLanes: 0,
        exemption: {
          kind: 'no-reviewable-content',
          auditDigest: expectedAuditDigest,
        },
      },
    });
    const candidate = {
      repositoryId: expectedCoordinates.repositoryId,
      prNumber: expectedCoordinates.prNumber,
      headSha: expectedCoordinates.headSha,
      baseSha: expectedCoordinates.baseSha,
      policyDigest: expectedCoordinates.policyDigest,
    };
    expect(evaluateReviewGate({
      candidate,
      current: { ...candidate, open: true, draft: false },
      evidence: derived.evidence,
    })).toEqual({ status: 'success', eligible: true, reason: 'central-exemption' });
  });

  it.each([
    'src/a.ts',
    'package.json',
    'runs/deploy.sh',
    'docs/bootstrap.sh',
    '.github/workflows/publish.yml',
    '.github/CODEOWNERS',
    '.changeset/config.json',
  ])(
    'never exempts a forged documentation-only marker for analyzable path %s',
    (path) => {
      const f = fixture();
      const completion = parseWorkerReviewCompletion(expectedEvent(f, {
        version: 'WorkerReviewResult.v1',
        completedAt: COMPLETED,
        personas: [{ id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
        coverageComplete: true,
        quorumSatisfied: true,
      }));
      const { version: _version, result: _result, ...expectedCoordinates } = completion;

      expect(deriveCanonicalWorkerReviewEvidence(completion, {
        expectedCoordinates,
        expectedPersonaIds: f.prepared.expectedPersonaIds,
        ...trustedGroundedVerifierContract(f),
        changedFiles: [{ path, patch: `@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n` }],
        coverageComplete: true,
        quorumSatisfied: true,
      })).toEqual({
        valid: false,
        reason: 'invalid-evidence',
        message: 'documentation-only completion contains analyzable source paths',
      });
    },
  );

  it('never exempts a documentation-only marker mixed with a real reviewer lane', () => {
    const f = fixture();
    const completion = parseWorkerReviewCompletion(expectedEvent(f, {
      version: 'WorkerReviewResult.v1',
      completedAt: COMPLETED,
      personas: [
        { id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] },
        { id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE', findings: [{
          severity: 'P1', path: 'docs/plan.md', line: 1,
          title: 'Do not discard this finding', body: 'A real reviewer lane must never be erased by the exemption.',
        }] },
      ],
      coverageComplete: true,
      quorumSatisfied: true,
    }));
    const { version: _version, result: _result, ...expectedCoordinates } = completion;

    expect(deriveCanonicalWorkerReviewEvidence(completion, {
      expectedCoordinates,
      expectedPersonaIds: f.prepared.expectedPersonaIds,
      ...trustedGroundedVerifierContract(f),
      changedFiles: [{ path: 'docs/plan.md', patch: `@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n` }],
      coverageComplete: true,
      quorumSatisfied: true,
    })).toEqual({
      valid: false,
      reason: 'invalid-evidence',
      message: 'unknown persona lane: documentation-only',
    });
  });

  it.each([
    ['central coverage', true, true, false, true],
    ['central quorum', true, true, true, false],
    ['worker coverage', false, true, true, true],
    ['worker quorum', true, false, true, true],
  ] as const)(
    'keeps %s failure binding for documentation-only evidence',
    (_name, workerCoverage, workerQuorum, coverageComplete, quorumSatisfied) => {
      const f = fixture();
      const completion = parseWorkerReviewCompletion(expectedEvent(f, {
        version: 'WorkerReviewResult.v1',
        completedAt: COMPLETED,
        personas: [{ id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
        coverageComplete: workerCoverage,
        quorumSatisfied: workerQuorum,
      }));
      const { version: _version, result: _result, ...expectedCoordinates } = completion;
      const derived = deriveCanonicalWorkerReviewEvidence(completion, {
        expectedCoordinates,
        expectedPersonaIds: f.prepared.expectedPersonaIds,
        ...trustedGroundedVerifierContract(f),
        changedFiles: [{ path: 'docs/plan.md', patch: `@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n` }],
        coverageComplete,
        quorumSatisfied,
      });
      const expectedCoverageComplete = coverageComplete && workerCoverage;
      const expectedQuorumSatisfied = quorumSatisfied && workerQuorum && expectedCoverageComplete;

      expect(derived).toMatchObject({
        valid: true,
        evidence: {
          coverageComplete: expectedCoverageComplete,
          quorumSatisfied: expectedQuorumSatisfied,
        },
      });
      const candidate = {
        repositoryId: expectedCoordinates.repositoryId,
        prNumber: expectedCoordinates.prNumber,
        headSha: expectedCoordinates.headSha,
        baseSha: expectedCoordinates.baseSha,
        policyDigest: expectedCoordinates.policyDigest,
      };
      expect(evaluateReviewGate({
        candidate,
        current: { ...candidate, open: true, draft: false },
        evidence: derived.evidence,
      })).toEqual({ status: 'failure', eligible: false, reason: 'incomplete-review' });
    },
  );

  it.each([
    {
      name: 'findings',
      lane: {
        id: 'documentation-only', decision: 'FINDINGS' as const, status: 'COMPLETE' as const,
        findings: [{ severity: 'P1' as const, path: 'docs/plan.md', line: 1,
          title: 'Finding must block exemption', body: 'The marker is not clean.' }],
      },
    },
    {
      name: 'infrastructure failure',
      lane: {
        id: 'documentation-only', decision: 'ERROR' as const, status: 'ERROR' as const,
        findings: [], errorClass: 'transport' as const,
      },
    },
  ])('never exempts a documentation-only marker with $name', ({ lane }) => {
    const f = fixture();
    const completion = parseWorkerReviewCompletion(expectedEvent(f, {
      version: 'WorkerReviewResult.v1', completedAt: COMPLETED,
      personas: [lane], coverageComplete: true, quorumSatisfied: true,
    }));
    const { version: _version, result: _result, ...expectedCoordinates } = completion;

    expect(deriveCanonicalWorkerReviewEvidence(completion, {
      expectedCoordinates,
      expectedPersonaIds: f.prepared.expectedPersonaIds,
      ...trustedGroundedVerifierContract(f),
      changedFiles: [{ path: 'docs/plan.md', patch: `@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n` }],
      coverageComplete: true,
      quorumSatisfied: true,
    })).toMatchObject({ valid: false, reason: 'invalid-evidence' });
  });

  it('rejects a documentation-only completion whose raw verdict contradicts canonical arbitration', () => {
    const f = fixture();
    const completion = parseWorkerReviewCompletion(expectedEvent(f, {
      version: 'WorkerReviewResult.v1', completedAt: COMPLETED,
      personas: [{ id: 'documentation-only', decision: 'APPROVE', status: 'COMPLETE', findings: [] }],
      coverageComplete: true, quorumSatisfied: true, verdict: 'BLOCK',
    }));
    const { version: _version, result: _result, ...expectedCoordinates } = completion;

    expect(deriveCanonicalWorkerReviewEvidence(completion, {
      expectedCoordinates,
      expectedPersonaIds: f.prepared.expectedPersonaIds,
      ...trustedGroundedVerifierContract(f),
      changedFiles: [{ path: 'docs/plan.md', patch: `@@ -1 +1 @@\n-const value = 'old';\n+const value = 'new';\n` }],
      coverageComplete: true,
      quorumSatisfied: true,
    })).toMatchObject({
      valid: false,
      reason: 'invalid-evidence',
      message: 'worker verdict BLOCK disagrees with canonical verdict SHIP',
    });
  });

  it('accepts composed task evidence only after the trusted gate validates the task plan', async () => {
    const f = fixture({ reviewEngine: 'composed' });
    f.env.REVIEW_EXECUTION_ATTEMPT = '1';
    const taskPlan = [{ id: 'task-a', dimension: 'architecture' as const, paths: ['src/a.ts'],
      question: 'Does this change preserve the contract?', rationale: 'The changed source needs review.' }];
    const taskASourceDelivery = completedTaskSourceDelivery('task-a', taskPlan[0].paths);
    const composedReviewRunner = vi.fn<NonNullable<PublishingReviewDeps['composedReviewRunner']>>()
      .mockResolvedValue({ ...f.panel, taskPlan, applicablePersonaIds: ['task-a'],
        personas: [{ ...f.panel.personas[0], id: 'task-a', sourceDelivery: taskASourceDelivery }],
        composedResourceObservation: composedEngineObservation(f, taskPlan, [taskASourceDelivery]) });
    f.deps.composedReviewRunner = composedReviewRunner;

    await runPublishingReviewWorker(f.env, f.deps);

    expect(f.panelRunner).not.toHaveBeenCalled();
    expect(composedReviewRunner).toHaveBeenCalledOnce();
    const publishedSummary = f.checkClient.completeCheck.mock.calls[0]?.[0].summary;
    expect(publishedSummary).toContain('Coverage: engine=composed; planned tasks=1; expected tasks=1; completed tasks=1; failed tasks=0;');
    expect(publishedSummary).not.toContain('Coverage: mode=panel');
    const completion = f.reportReviewResult.mock.calls[0]?.[0];
    expect(completion?.result.personas.map((persona) => persona.id)).toEqual(['task-a']);
    expect(completion?.result.taskPlan).toEqual(taskPlan);
    const parsedCompletion = parseWorkerReviewCompletion(completion);
    const { version: _version, result: _result, ...expectedCoordinates } = parsedCompletion;
    const derived = deriveCanonicalWorkerReviewEvidence(parsedCompletion, {
      expectedCoordinates,
      expectedPersonaIds: f.prepared.expectedPersonaIds,
      ...trustedGroundedVerifierContract(f),
      reviewEngine: 'composed', composedChangedPaths: ['src/a.ts'], composedMaxTasks: 8,
      changedFiles: parseChangedFiles(DIFF).files,
      coverageComplete: true,
      quorumSatisfied: true,
    });
    if (!derived.valid) throw new Error(`Unexpected invalid composed task evidence: ${derived.message}`);
    expect(derived).toMatchObject({ valid: true, evidence: { verdict: 'SHIP', expectedLanes: 1, completedLanes: 1 } });
  });

  it('wires admitted composed plan and task calls through progress and token attribution wrappers', async () => {
    const f = fixture({ reviewEngine: 'composed' });
    f.env.REVIEW_EXECUTION_ATTEMPT = '1';
    const modelTaskId = 'task-a';
    const taskPlan = [{ id: modelTaskId, dimension: 'architecture' as const, paths: ['src/a.ts'],
      question: 'Does this change preserve the contract?', rationale: 'The changed source needs review.' }];
    const requestsSeenByRunner: OpenRouterRequest[] = [];
    const privatePrompt = 'credential-shaped-task-plan-prompt';
    const providerResponseModel = 'ghp_fixture_response_model_123456';
    f.client.complete.mockImplementation(async () => ({
      model: providerResponseModel,
      content: 'private provider response payload',
      usage: { prompt: 13, completion: 7, total: 20, cache_read_input_tokens: 3 },
      costUSD: 0.02,
      raw: { private: 'raw response' },
    }));
    f.deps.composedReviewRunner = vi.fn<NonNullable<PublishingReviewDeps['composedReviewRunner']>>(async (options) => {
      const planRequest: OpenRouterRequest = {
        model: transport.model,
        messages: [{ role: 'user', content: privatePrompt }],
        timeoutMs: 1_000,
        providerId: 'bifrost',
        internalProgress: { task: 'composed_plan', turn: 1 },
      };
      const taskRequest: OpenRouterRequest = {
        model: transport.model,
        messages: [{ role: 'user', content: 'private task prompt' }],
        timeoutMs: 1_000,
        providerId: 'bifrost',
        internalProgress: { task: 'composed_task', lane: 'composed-task-1', turn: 1 },
      };
      requestsSeenByRunner.push(planRequest, taskRequest);
      await options.client.complete(planRequest);
      await options.client.complete(taskRequest);
      return { ...f.panel, taskPlan, applicablePersonaIds: [modelTaskId],
        personas: [{ ...f.panel.personas[0], id: modelTaskId }] };
    });

    await runPublishingReviewWorker(f.env, f.deps);

    expect(requestsSeenByRunner.map((request) => request.internalProgress?.task)).toEqual(['composed_plan', 'composed_task']);
    expect(requestsSeenByRunner[1]?.internalProgress?.lane).toBe('composed-task-1');
    expect(f.client.complete).toHaveBeenCalledTimes(2);
    for (const [forwarded] of f.client.complete.mock.calls) {
      expect(forwarded).not.toHaveProperty('internalProgress');
      expect(forwarded).toHaveProperty('maxTokens', PUBLISHING_MAX_OUTPUT_TOKENS);
    }

    const progressEvents = f.infoLog.mock.calls
      .filter(([message]) => message === 'Publishing review progress')
      .map(([, fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields.task === 'provider_call');
    expect(progressEvents).toHaveLength(4);
    expect(progressEvents.map(({ role, lane, status, model }) => ({ role, lane, status, model }))).toEqual([
      { role: 'composed_plan', lane: undefined, status: 'started', model: transport.model },
      { role: 'composed_plan', lane: undefined, status: 'completed', model: transport.model },
      { role: 'composed_task', lane: 'composed-task-1', status: 'started', model: transport.model },
      { role: 'composed_task', lane: 'composed-task-1', status: 'completed', model: transport.model },
    ]);

    const accounting = f.infoLog.mock.calls
      .find(([message]) => message === 'Review token accounting')?.[1] as Record<string, unknown> | undefined;
    const tokensByLane = accounting?.tokensByLane as Record<string, unknown> | undefined;
    expect(accounting).toMatchObject({
      providerCalls: 2,
      tokensByOther: { 'composed-plan': { calls: 1, prompt: 13, completion: 7, cached: 3 } },
      tokensByLane: { 'composed-task-1': { calls: 1, prompt: 13, completion: 7, cached: 3 } },
    });
    expect(Object.keys(tokensByLane ?? {})).toEqual(['composed-task-1']);
    const diagnostics = JSON.stringify({ progressEvents, accounting });
    expect(diagnostics).not.toContain(modelTaskId);
    expect(diagnostics).not.toContain(providerResponseModel);
    expect(diagnostics).not.toContain(privatePrompt);
    expect(diagnostics).not.toContain('private provider response payload');
  });

  it('executes the exact admitted config instead of mutable policy, persona, and turn environment', async () => {
    const f = fixture();
    Object.assign(f.env, { REVIEW_YETI_POLICY_JSON: JSON.stringify({ review_yeti: {
      personas: 'licensing,performance', budget: { max_investigation_turns: 3 },
    } }), REVIEW_PERSONAS: 'architecture', MAX_INVESTIGATION_TURNS: '3' });
    const receipt = await runPublishingReviewWorker(f.env, f.deps);
    expect(f.panelRunner).toHaveBeenCalledExactlyOnceWith({
      config: expect.objectContaining({ ...f.prepared.config,
        rules: expect.arrayContaining([expect.objectContaining({ id: 'service-pr-review-history-context', severity: 'P2' })]) }),
      changedFiles: [{ path: 'src/a.ts', patch: DIFF }],
      repository: 'example/project', headSha: HEAD, repositoryVisibility: 'PRIVATE',
      // REL-1132: the engine gets a metering wrapper around `f.client` (every call is recorded in
      // the run's token ledger, then delegated), not the injected client object itself.
      client: { complete: expect.any(Function) },
      jobId: f.env.REVIEW_RUN_ID, baseSha: BASE, prNumber: 42,
      signal: expect.any(AbortSignal),
      deadlineBudget: expect.objectContaining({
        deadlineAtMs: expect.any(Number),
        timeoutMs: expect.any(Number),
        terminalBound: expect.any(Boolean),
      }),
      deadlineNow: expect.any(Function),
      // The fixture injects an in-memory exact-revision provider with the same
      // capabilities as the production provider. This keeps the test offline
      // while pinning the provider seam passed to the panel.
      repoFileProvider: {
        findFiles: expect.any(Function), readFile: expect.any(Function), treeTruncated: expect.any(Function),
        readFileAt: expect.any(Function), readDiff: expect.any(Function),
        deletionManifest: expect.any(Function), deletionEvidence: expect.any(Function), deletionPlan: expect.any(Function),
      },
      isCurrentHead: undefined,
      deterministicRoster: true,
      progress: { emit: expect.any(Function), instrument: expect.any(Function) },
      requestPolicy: { responseFormat: { type: 'json_object' } },
    });
    expect(f.panelRunner.mock.calls[0][0].config.default_max_turns).toBe(1);
    expect(f.panelRunner.mock.calls[0][0].config.personas.map((p) => p.id)).toEqual(['sec-lane', 'qual-lane']);
    // REL-1080: the loader also receives the git-derived large-diff source for a 406.
    expect(f.sourceLoader).toHaveBeenCalledExactlyOnceWith({ repo: 'example/project', prNumber: 42,
      expectedBaseSha: BASE, expectedHeadSha: HEAD, token: TOKEN }, undefined,
    // REL-1103: plus the deadline-bounded GitHub retry policy (empty: no terminal deadline forwarded).
    { gitDiffSource: expect.any(Function), onLargeDiffSource: expect.any(Function), retry: {} });
    expectReportedCompletion(f, cleanResult());
    expect(receipt).toMatchObject({ conclusion: 'success', verdict: 'SHIP', transport: 'bifrost', model: transport.model });
    expect(f.fetch).not.toHaveBeenCalled();
    // REL-1132: the metered client delegates to the admitted client. The publishing boundary adds
    // its mandatory output ceiling without mutating the engine-owned request object.
    expect(f.client.complete).not.toHaveBeenCalled();
    const probe = { model: transport.model, messages: [] } as unknown as Parameters<typeof f.client.complete>[0];
    await expect(f.panelRunner.mock.calls[0][0].client.complete(probe))
      .rejects.toThrow('A test must never invoke a provider');
    expect(f.client.complete).toHaveBeenCalledExactlyOnceWith({
      ...probe,
      maxTokens: PUBLISHING_MAX_OUTPUT_TOKENS,
    });
    expect(f.client.complete.mock.calls[0][0]).not.toBe(probe);
    expect(probe).not.toHaveProperty('maxTokens');
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
    expectReportedCompletion(f, cleanResult());
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
    expectReportedCompletion(f, cleanResult());
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
    // REL-1113: a rate-limited lane with no finding anywhere is infrastructure, not a verdict: the
    // same lanes are reported, now marked for the shared infrastructure-incomplete decision.
    expected.failureDiagnostics = { reason: 'lane_infrastructure_incomplete', logTail: 'lanes did not complete: qual-lane=rate_limit',
      recoverableIncompletePanel: true };
    expectReportedCompletion(f, expected);
    expect(receipt).toMatchObject({ conclusion: 'failure', verdict: 'INCOMPLETE', failureClass: 'rate_limit' });
    expect(f.checkClient.completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      conclusion: 'failure', title: 'Review Yeti: INCOMPLETE — infrastructure (automatic retry NOT CONFIRMED; lane qual-lane failed: rate_limit)',
    }));
    expect(f.checkClient.completeCheck.mock.calls[0]?.[0]?.summary)
      .toContain('Automatic retry is NOT CONFIRMED for execution attempt 2');
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(f.checkClient.completeCheck.mock.calls)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(f.checkClient.completeCheck.mock.calls)).not.toContain(TOKEN);
  });

  describe('REL-1113: infrastructure lane failures are never published as a verdict', () => {
    // The exact example-meta#3446 lane error: the optimizer pod behind gateway-internal was replaced
    // mid-review, the stream was "terminated", then nginx answered 502.
    const GATEWAY_502 = 'persona arch-lane failed closed: bifrost: gateway-internal.example.com HTTP 502: <html><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></html>';

    function incompleteFixture(executionAttempt: string) {
      const f = fixture();
      f.env.REVIEW_EXECUTION_ATTEMPT = executionAttempt;
      // #3446 shape: panel mode, 2 expected lanes, 1 completed clean, 1 failed on the gateway.
      f.panel.personas = [f.panel.personas[0]];
      f.panel.optionalFailures = [{ id: 'qual-lane', error: GATEWAY_502, failureClass: 'provider_error' }];
      f.panel.quorum.satisfied = false;
      return f;
    }

    function trustedDecision(f: ReturnType<typeof fixture>, completion: WorkerReviewCompletion) {
      const { version: _version, result: _result, ...expectedCoordinates } = completion;
      const derived = deriveCanonicalWorkerReviewEvidence(completion, {
        expectedCoordinates,
        expectedPersonaIds: f.prepared.expectedPersonaIds,
        ...trustedGroundedVerifierContract(f),
        changedFiles: parseChangedFiles(DIFF).files,
        coverageComplete: true,
        quorumSatisfied: true,
      });
      const candidate = { repositoryId: 123, prNumber: 42, headSha: HEAD, baseSha: BASE,
        policyDigest: f.prepared.policy.effectivePolicyDigest };
      return { derived, decision: derived.valid ? evaluateReviewGate({ candidate,
        current: { ...candidate, open: true, draft: false }, evidence: derived.evidence }) : undefined };
    }

    it('#3446 shape (1 of 2 lanes lost to a gateway 502, 0 findings) is INCOMPLETE without a scheduling claim, not BLOCK', async () => {
      const f = incompleteFixture('1');
      const receipt = await runPublishingReviewWorker(f.env, f.deps);

      const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
      // Negative proof: before REL-1113 this exact run published "Review Yeti: BLOCK".
      expect(check?.title).not.toBe('Review Yeti: BLOCK');
      expect(check?.title).not.toMatch(/BLOCK|FIX_FIRST|SHIP/u);
      expect(check).toMatchObject({ conclusion: 'failure',
        title: 'Review Yeti: INCOMPLETE — infrastructure (automatic retry NOT CONFIRMED; lane qual-lane failed: 502)' });
      // Visible: the summary names the lane that did not complete and why.
      expect(check?.summary).toContain('not a review verdict');
      expect(check?.summary).toContain('- `qual-lane`: provider_error (provider HTTP 502)');
      expect(check?.summary).toContain('Automatic retry is NOT CONFIRMED for execution attempt 1');
      expect(check?.summary).not.toMatch(/scheduled automatically|fresh attempt \(2 of 3\)|superseded by it/iu);
      expect(check?.summary).not.toContain('nginx');
      expect(receipt).toMatchObject({ verdict: 'INCOMPLETE', conclusion: 'failure', failureClass: 'provider_error' });

      // The trusted completion side reaches the same classification from the same payload: it
      // records an infrastructure failure (not blocking-findings). Admission remains a separate
      // service decision and is not claimed by the worker's completion acknowledgement.
      const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
      expect(completion.executionAttempt).toBe(1);
      expect(completion.result.failureDiagnostics).toMatchObject({ reason: 'lane_infrastructure_incomplete',
        providerStatus: 502, recoverableIncompletePanel: true });
      expect(isInfrastructureIncompleteResult(completion.result)).toBe(true);
      const { derived, decision } = trustedDecision(f, completion);
      expect(derived).toMatchObject({ valid: true, evidence: { infrastructureFailure: true, p0Count: 0, p1Count: 0,
        expectedLanes: 2, completedLanes: 1 } });
      expect(decision).toEqual({ status: 'failure', eligible: false, reason: 'infrastructure-failure' });
    });

    it.each(['recorded', 'duplicate', 'ignored'] as const)(
      'does not report retry scheduling from a completion delivery ACK with status %s', async (ackStatus) => {
        const f = incompleteFixture('1');
        const acknowledgementFetch = vi.fn<typeof fetch>(async (_input, init) => {
          const event = JSON.parse(String(init?.body)) as { runId: string };
          return new Response(JSON.stringify({ version: 'WorkerReviewCompletionAccepted.v1', runId: event.runId, status: ackStatus }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        });
        f.deps.reviewCompletion = new HttpWorkerReviewCompletionAdapter({ token: TOKEN, endpoint: ENDPOINT,
          fetchImplementation: acknowledgementFetch });

        const receipt = await runPublishingReviewWorker(f.env, f.deps);

        const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
        expect(acknowledgementFetch).toHaveBeenCalledOnce();
        expect(receipt).toMatchObject({ verdict: 'INCOMPLETE', conclusion: 'failure' });
        expect(check?.title).toContain('automatic retry NOT CONFIRMED');
        expect(check?.title).not.toMatch(/retrying as attempt|superseded/iu);
        expect(check?.summary).toContain('Automatic retry is NOT CONFIRMED for execution attempt 1');
        expect(check?.summary).toContain('acknowledgement confirms delivery only');
        expect(check?.summary).not.toMatch(/scheduled automatically|fresh attempt \(2 of 3\)/iu);
      });

    it('attempts exhausted: publishes the INCOMPLETE title with no retry, still never BLOCK', async () => {
      const f = incompleteFixture('3');
      await runPublishingReviewWorker(f.env, f.deps);
      const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
      expect(check).toMatchObject({ conclusion: 'failure',
        title: 'Review Yeti: INCOMPLETE — infrastructure (automatic retry cap EXHAUSTED; lane qual-lane failed: 502)' });
      expect(check?.summary).toContain('cap of 2 additional attempts was exhausted at execution attempt 3');
      expect(isRecoverableFailureTitle(check?.title)).toBe(true);
      const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
      // The payload is still marked (the service keeps the reason class); the attempt cap alone
      // stops the re-admission.
      expect(isInfrastructureIncompleteResult(completion.result)).toBe(true);
      expect(completion.executionAttempt).toBe(3);
    });

    it('safe attempt 4 reports UNKNOWN for a returned incomplete panel without inventing exhaustion', async () => {
      const f = incompleteFixture('4');
      const warn = vi.mocked(logger.warn);
      const metric = vi.spyOn(getMetrics().reviewIncompleteInfra, 'add');

      await runPublishingReviewWorker(f.env, f.deps);

      const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
      expect(check).toMatchObject({ conclusion: 'failure',
        title: 'Review Yeti: INCOMPLETE — infrastructure (automatic retry status UNKNOWN; lane qual-lane failed: 502)' });
      expect(check?.summary).toContain('execution attempt 4; this value proves neither retry eligibility nor cap exhaustion');
      expect(check?.summary).not.toMatch(/scheduled automatically|cap of 2 additional attempts was exhausted|automatic retry cap of|last automatic attempt/iu);
      expect(warn).toHaveBeenCalledWith('Review incomplete: reviewer lane(s) failed on infrastructure; not a review verdict',
        expect.objectContaining({ executionAttempt: 4, retryStatus: 'unknown' }));
      expect(warn.mock.calls[0]?.[1]).not.toHaveProperty('retryScheduled');
      expect(metric).toHaveBeenCalledExactlyOnceWith(1, { outcome: 'unknown', failure_class: 'provider_error', authoritative: 'true' });
      const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
      expect(completion.executionAttempt).toBe(4);
    });

    it('a findings BLOCK stays BLOCK even when another lane was lost to the gateway', async () => {
      const f = incompleteFixture('1');
      f.panel.personas[0].decision = 'FINDINGS';
      f.panel.personas[0].findings = [{ severity: 'P0', path: 'src/a.ts', line: 1, title: 'Remote code execution',
        body: 'User input reaches eval.', confidence: 95 } as never];
      await runPublishingReviewWorker(f.env, f.deps);
      const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
      expect(check).toMatchObject({ conclusion: 'failure', title: 'Review Yeti: BLOCK' });
      const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
      expect(completion.result.failureDiagnostics).toBeUndefined();
      expect(isInfrastructureIncompleteResult(completion.result)).toBe(false);
    });

    it('a complete panel with a P0 finding stays a verdict (never INCOMPLETE)', async () => {
      const f = fixture();
      f.env.REVIEW_EXECUTION_ATTEMPT = '1';
      f.panel.personas[0].decision = 'FINDINGS';
      f.panel.personas[0].findings = [{ severity: 'P0', path: 'src/a.ts', line: 1, title: 'Secret logged',
        body: 'The token is written to the log.', confidence: 95 } as never];
      await runPublishingReviewWorker(f.env, f.deps);
      const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
      expect(check?.title).toBe('Review Yeti: BLOCK');
      expect(check?.title).not.toMatch(/INCOMPLETE/u);
    });

    it('a lane that failed on malformed output is not relabelled as infrastructure', async () => {
      const f = incompleteFixture('1');
      f.panel.optionalFailures = [{ id: 'qual-lane', error: 'invalid findings contract', failureClass: 'malformed_output' }];
      await runPublishingReviewWorker(f.env, f.deps);
      const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
      expect(completion.result.failureDiagnostics).toBeUndefined();
      expect(f.checkClient.completeCheck.mock.calls[0]?.[0]?.title).not.toMatch(/INCOMPLETE/u);
    });

    it('publishes a fail-closed no-verdict check when a composed task ran without a verdict', async () => {
      const f = fixture({ reviewEngine: 'composed' });
      f.env.REVIEW_EXECUTION_ATTEMPT = '1';
      const taskPlan = [
        { id: 'task-a', dimension: 'architecture' as const, paths: ['src/a.ts'],
          question: 'Does the change preserve the contract?', rationale: 'Review the changed source.' },
        { id: 'task-b', dimension: 'testing' as const, paths: ['src/a.ts'],
          question: 'Are edge cases covered?', rationale: 'Review the changed source.' },
      ];
      const taskASourceDelivery = completedTaskSourceDelivery('task-a', taskPlan[0].paths);
      f.deps.composedReviewRunner = vi.fn().mockResolvedValue({ ...f.panel,
        taskPlan, applicablePersonaIds: ['task-a', 'task-b'],
        personas: [{ ...f.panel.personas[0], id: 'task-a', sourceDelivery: taskASourceDelivery }],
        composedResourceObservation: composedEngineObservation(f, taskPlan, [taskASourceDelivery]),
        unreportedLanes: [unreportedLaneFailure(taskPlan[1], 'exhausted', {
          reason: 'nonce_mismatch', turnsUsed: 12, correctionAttempts: 2,
          toolTurns: 9, finishReason: 'length', lastToolOutcome: 'returned',
        })],
      });

      const receipt = await runPublishingReviewWorker(f.env, f.deps);
      const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
      expect(check).toMatchObject({ conclusion: 'failure', title: 'Review Yeti: review did not complete' });
      expect(check?.summary).toContain('No review verdict');
      expect(check?.summary).toContain('task-b');
      expect(check?.summary).toContain('reason=nonce_mismatch');
      expect(check?.summary).toContain('turns=12; corrections=2; tool_turns=9; finish_reason=length');
      expect(check?.summary).toContain('Coverage: engine=composed; planned tasks=2; expected tasks=2; completed tasks=1');
      expect(check?.summary).not.toContain('Verdict `BLOCK`');
      expect(isRecoverableFailureTitle(check?.title)).toBe(true);
      expect(receipt).toMatchObject({ verdict: 'INCOMPLETE', conclusion: 'failure',
        failureClass: 'malformed_output', coverage: { rosterValid: false, fullPanelComplete: false } });
      const completion = parseWorkerReviewCompletion(f.reportReviewResult.mock.calls[0]?.[0]);
      expect(completion.result.failureDiagnostics?.recoverableIncompletePanel).not.toBe(true);
      const { version: _version, result: _result, ...expectedCoordinates } = completion;
      const derived = deriveCanonicalWorkerReviewEvidence(completion, {
        expectedCoordinates, expectedPersonaIds: f.prepared.expectedPersonaIds,
        ...trustedGroundedVerifierContract(f),
        reviewEngine: 'composed', composedChangedPaths: ['src/a.ts'], composedMaxTasks: 8,
        changedFiles: parseChangedFiles(DIFF).files, coverageComplete: true, quorumSatisfied: true,
      });
      const candidate = { repositoryId: 123, prNumber: 42, headSha: HEAD, baseSha: BASE,
        policyDigest: f.prepared.policy.effectivePolicyDigest };
      if (derived.valid) {
        expect(derived).toMatchObject({ evidence: { quorumSatisfied: false,
          expectedLanes: 2, completedLanes: 1 } });
        expect(evaluateReviewGate({ candidate,
          current: { ...candidate, open: true, draft: false }, evidence: derived.evidence }))
          .toEqual({ status: 'failure', eligible: false, reason: 'incomplete-review' });
      } else {
        expect(derived).toEqual({ valid: false, reason: 'invalid-evidence',
          message: 'worker claims complete coverage with incomplete composed execution or source delivery' });
      }
    });

    it('names a composed task whose fresh attempts were all malformed instead of publishing BLOCK with 0 findings', async () => {
      const f = fixture({ reviewEngine: 'composed' });
      f.env.REVIEW_EXECUTION_ATTEMPT = '1';
      const taskPlan = [
        { id: 'task-a', dimension: 'architecture' as const, paths: ['src/a.ts'],
          question: 'Does the change preserve the contract?', rationale: 'Review the changed source.' },
        { id: 'task-b', dimension: 'security' as const, paths: ['src/a.ts'],
          question: 'Is the storage authority preserved?', rationale: 'Review the changed source.' },
      ];
      f.deps.composedReviewRunner = vi.fn().mockResolvedValue({ ...f.panel,
        taskPlan, applicablePersonaIds: ['task-a', 'task-b'],
        personas: [{ ...f.panel.personas[0], id: 'task-a' }],
        unreportedLanes: [unreportedLaneFailure(taskPlan[1], 'exhausted', {
          reason: 'invalid_findings', turnsUsed: 3, correctionAttempts: 2,
          toolTurns: 0, finishReason: 'stop', lastToolOutcome: 'none',
        }, 3)],
      });

      const receipt = await runPublishingReviewWorker(f.env, f.deps);
      const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
      expect(check).toMatchObject({ conclusion: 'failure', title: 'Review Yeti: review did not complete' });
      expect(check?.title).not.toMatch(/BLOCK/u);
      expect(check?.summary).toContain('task-b');
      expect(check?.summary).toContain('after 3 fresh attempts');
      expect(check?.summary).toContain('reason=invalid_findings');
      expect(check?.summary).not.toContain('Verdict `BLOCK`');
      expect(receipt).toMatchObject({ verdict: 'INCOMPLETE', failureClass: 'malformed_output' });
    });

    it('publishes a composed task that stalled on every attempt as INCOMPLETE infrastructure naming the task', async () => {
      const f = fixture({ reviewEngine: 'composed' });
      f.env.REVIEW_EXECUTION_ATTEMPT = '1';
      const taskPlan = [
        { id: 'task-a', dimension: 'architecture' as const, paths: ['src/a.ts'],
          question: 'Does the change preserve the contract?', rationale: 'Review the changed source.' },
        { id: 'task-b', dimension: 'architecture' as const, paths: ['src/a.ts'],
          question: 'Are transactions stable?', rationale: 'Review the changed source.' },
      ];
      const taskASourceDelivery = completedTaskSourceDelivery('task-a', taskPlan[0].paths);
      const composedResources = composedEngineObservation(f, taskPlan, [taskASourceDelivery]);
      f.deps.composedReviewRunner = vi.fn().mockResolvedValue({ ...f.panel,
        taskPlan, applicablePersonaIds: ['task-a', 'task-b'],
        personas: [{ ...f.panel.personas[0], id: 'task-a', sourceDelivery: taskASourceDelivery }],
        optionalFailures: [{ id: 'task-b', failureClass: 'timeout',
          error: 'Task task-b (architecture) stalled on a provider timeout in 3 fresh attempt(s) (retries exhausted); path(s) [src/a.ts] were not reviewed by this task' }],
        unreportedLanes: [],
        quorum: { ...f.panel.quorum, satisfied: false },
        composedResourceObservation: composedResources,
      });

      const receipt = await runPublishingReviewWorker(f.env, f.deps);
      expect(f.reportReviewResult.mock.calls[0]?.[0]).toMatchObject({ result: { coverageComplete: false,
        composedResources: { version: 'ComposedRuntimeResources.v2', stage: 'worker_completion',
          engineExecutionState: 'incomplete', coverage: { remainingPaths: { count: 1 } } } } });
      const check = f.checkClient.completeCheck.mock.calls[0]?.[0];
      expect(check?.conclusion).toBe('failure');
      expect(check?.title).toMatch(/^Review Yeti: INCOMPLETE — infrastructure \(.*lane task-b failed: timeout\)$/u);
      expect(check?.title).not.toMatch(/BLOCK/u);
      expect(receipt).toMatchObject({ verdict: 'INCOMPLETE', conclusion: 'failure' });
    });

    it.each(['finding', 'wrong unreported id', 'unreadable diff', 'no unreported evidence', 'budget exhaustion'])('does not relabel %s as a no-verdict panel', async (kind) => {
      const f = fixture();
      f.panel.personas = [f.panel.personas[0]];
      f.panel.unreportedLanes = [{ id: kind === 'wrong unreported id' ? 'other-lane' : 'qual-lane',
        failureClass: kind === 'budget exhaustion' ? 'budget_exhausted' : 'malformed_output',
        error: 'Task ran and produced no verdict' }];
      if (kind === 'no unreported evidence') f.panel.unreportedLanes = [];
      if (kind === 'finding') {
        f.panel.personas[0].decision = 'FINDINGS';
        f.panel.personas[0].findings = [{ severity: 'P0', path: 'src/a.ts', line: 1,
          title: 'Finding', body: 'Fix this.' } as never];
      }
      if (kind === 'unreadable diff') f.source.diff += 'diff --git unreadable-header\n';

      const receipt = await runPublishingReviewWorker(f.env, f.deps);
      expect(receipt).toMatchObject({ verdict: 'BLOCK', conclusion: 'failure' });
      expect(f.checkClient.completeCheck.mock.calls[0]?.[0]?.title).toBe('Review Yeti: BLOCK');
    });
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
    expectReportedCompletion(f, expected);
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
    expectReportedCompletion(f, expected);
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
    // REL-1124: a raw transport rejection (ECONNREFUSED, fetch failed, terminated) from the panel is
    // infrastructure-incomplete now; see rel1124ThrownPanelInfrastructure.test.ts.
    ['budget exhausted', 'budget_exhausted'], ['provider exploded', 'provider_error'],
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
    expectReportedCompletion(f, { ...cleanResult(), coverageComplete: false });
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
    expect(accepted).toHaveLength(1);
    expectCompletionPayload(f, accepted[0], cleanResult());
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

  it.each(['normal completion', 'terminal failure'] as const)(
    'logs one closed delivery diagnostic for %s without exposing response data', async (path) => {
      const f = fixture();
      const privateResponse = `${PRIVATE_DETAIL} ${TOKEN} ${ENDPOINT}`;
      const acknowledgementFetch = vi.fn<typeof fetch>(async () => new Response(privateResponse, { status: 401 }));
      f.deps.reviewCompletion = new HttpWorkerReviewCompletionAdapter({ token: TOKEN, endpoint: ENDPOINT,
        fetchImplementation: acknowledgementFetch });
      f.errorLog.mockClear();
      if (path === 'terminal failure') f.panelRunner.mockRejectedValue(new Error('request timed out'));

      if (path === 'normal completion') {
        await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toMatchObject({
          message: 'Worker review completion could not be acknowledged', code: 'http_rejected', httpStatus: 401,
        });
      } else {
        await expect(runPublishingReviewWorker(f.env, f.deps)).rejects.toThrow('request timed out');
      }

      expect(acknowledgementFetch).toHaveBeenCalledOnce();
      const deliveryLogs = f.errorLog.mock.calls.filter(([message]) =>
        message === 'Worker review completion could not be acknowledged');
      expect(deliveryLogs).toHaveLength(1);
      expect(deliveryLogs[0]?.[1]).toMatchObject({ runId: f.env.REVIEW_RUN_ID,
        reason: 'completion_callback_failed', completionFailureCode: 'http_rejected', httpStatus: 401 });
      const serializedLogs = JSON.stringify(f.errorLog.mock.calls);
      expect(serializedLogs).not.toContain(PRIVATE_DETAIL);
      expect(serializedLogs).not.toContain(TOKEN);
      expect(serializedLogs).not.toContain(ENDPOINT);
    },
  );

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
    expect(f.panelRunner.mock.calls[0][0]).not.toHaveProperty('deterministicRoster');
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
    const threadRequests: any[] = [];
    const derivations: ReturnType<typeof deriveCanonicalWorkerReviewEvidence>[] = [];
    const derivationInputs: Array<{ outcomes: unknown; findings: unknown }> = [];
    f.fetch.mockImplementation(async (input, init) => {
      if (String(input) === ENDPOINT.replace(/\/completion$/u, '/incomplete-p2-recovery') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ version: 'IncompleteP2RecoveryRequest.v1',
          runId: f.env.REVIEW_RUN_ID, executionAttempt: Number(f.env.REVIEW_EXECUTION_ATTEMPT) });
        return new Response(JSON.stringify({ version: 'IncompleteP2RecoveryResponse.v1',
          runId: f.env.REVIEW_RUN_ID, executionAttempt: Number(f.env.REVIEW_EXECUTION_ATTEMPT), context: null }), { status: 200 });
      }
      if (String(input) === ENDPOINT.replace(/\/completion$/u, '/pr-lifecycle-history') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ version: 'PrLifecycleHistorySnapshotRequest.v1',
          runId: f.env.REVIEW_RUN_ID, executionAttempt: Number(f.env.REVIEW_EXECUTION_ATTEMPT) });
        return new Response('fixture history unavailable', { status: 503 });
      }
      if (String(input).startsWith('https://api.github.com/repos/example/project/contents/src/a.ts?ref=')) {
        expect(String(input)).toMatch(new RegExp(`\\?ref=(?:${HEAD}|${BASE})$`, 'u'));
        return new Response('{}', { status: 404 });
      }
      if (String(input) === 'https://api.github.com/repos/example/project/pulls/42' && init?.method === 'GET') {
        return new Response(JSON.stringify({ state: 'open', draft: false, head: { sha: HEAD } }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(input) === rawEndpoint && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
      }
      // ADR 0002: the entrypoint reads the App's finding threads through the service (none yet)
      // and then asks it to publish the new required P2 as a thread.
      if (String(input) === ENDPOINT.replace(/\/completion$/u, '/finding-threads') && init?.method === 'POST') {
        const request = JSON.parse(String(init.body));
        threadRequests.push(request);
        if (request.version === 'FindingThreadsRead.v1') {
          return new Response(JSON.stringify({ version: 'FindingThreadsReadResult.v1', runId: f.env.REVIEW_RUN_ID,
            headSha: HEAD, complete: true, omittedCount: 0, threads: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ version: 'FindingThreadsResult.v1', runId: f.env.REVIEW_RUN_ID,
          created: request.publish.length, skipped: 0, resolved: 0 }), { status: 200 });
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
          ...trustedGroundedVerifierContract(f),
          changedFiles: parseChangedFiles(DIFF).files, coverageComplete: true, quorumSatisfied: true,
        });
        derivations.push(derived);
        derivationInputs.push({
          outcomes: completion.result.groundedReview?.verification.outcomes.map((row) => ({ path: row.path,
            line: row.line, severity: row.severity,
            candidateSide: 'candidateSide' in row ? row.candidateSide : undefined,
            status: row.status, reason: 'reason' in row ? row.reason : undefined })),
          findings: completion.result.personas.map((lane) => ({ id: lane.id, findings: lane.findings.map((finding) => ({
            path: finding.path, line: finding.line, severity: finding.severity, title: finding.title,
          })) })),
        });
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
    for (const [index, derived] of derivations.entries()) {
      if (!derived.valid) throw new Error(`Unexpected invalid published worker evidence: ${derived.message}; input=${JSON.stringify(derivationInputs[index])}`);
      expect(derived.valid).toBe(true);
      expect(derived.evidence).toMatchObject({ verdict: 'SHIP', coverageComplete: true, quorumSatisfied: true,
        infrastructureFailure: false, p0Count: 0, p1Count: 0 });
      expect(derivationInputs[index]?.outcomes).toEqual([
        expect.objectContaining({ path: finding.path, severity: 'P2', status: 'insufficient' }),
      ]);
      // V2 removes an advisory whose independent evidence is insufficient from the canonical set.
      // It stays non-blocking and cannot be published as a verified finding.
      expect(derived.canonical?.findings, JSON.stringify({ findings: derivationInputs[index]?.findings,
        outcomes: derivationInputs[index]?.outcomes })).toEqual([]);
    }
    expect(legacy).not.toHaveBeenCalled();
    const retry = delivery === '503 then recorded' || delivery === 'lost acknowledgement then duplicate';
    expect(derivations).toHaveLength(retry ? 2 : 1);
    // Missing authenticated history forces a fresh review and skips the optional
    // composed checkpoint read. The cache planner may still read current content
    // to record a future source entry after the fresh review.
    expect(f.fetch).toHaveBeenCalledTimes(retry ? 11 : 10);
    expect(f.fetch.mock.calls.some(([url]) => String(url).includes('/review-checkpoint'))).toBe(false);
    const groundedSourceReads = f.fetch.mock.calls
      .filter(([url]) => String(url).includes('/contents/src/a.ts?ref='))
      .map(([url]) => String(url));
    expect(groundedSourceReads).toEqual([
      `https://api.github.com/repos/example/project/contents/src/a.ts?ref=${HEAD}`,
      `https://api.github.com/repos/example/project/contents/src/a.ts?ref=${BASE}`,
    ]);
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
    // The V2 verifier had insufficient source evidence for the advisory, so it is withheld from
    // the canonical finding set and cannot become a required thread/check annotation.
    expect(completed).toMatchObject({ status: 'completed', conclusion: 'success', output: {
      text: expect.not.stringContaining(finding.title),
    } });
    expect(completed.output).not.toHaveProperty('annotations');
    expect(completed.output.title).toBe('Review Yeti: SHIP');
    expect(completed.output.summary).toContain('Required findings: 0 (P0: 0, P1: 0, P2: 0)');
    expect(threadRequests).toHaveLength(2);
    expect(threadRequests[0]).toEqual({ version: 'FindingThreadsRead.v1', runId: f.env.REVIEW_RUN_ID,
      executionAttempt: Number(f.env.REVIEW_EXECUTION_ATTEMPT), headSha: HEAD });
    expect(threadRequests[1]).toMatchObject({ version: 'FindingThreadsRequest.v1', headSha: HEAD, publish: [] });
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
    expect(payload.result.personas[0].findings).toEqual([]);
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
      ...trustedGroundedVerifierContract(f),
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
      ...trustedGroundedVerifierContract(f),
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
      ...trustedGroundedVerifierContract(f),
      changedFiles: parseChangedFiles(DIFF).files,
      coverageComplete: kind !== 'unreadable diff', quorumSatisfied: kind !== 'incomplete panel',
    });
    expect(derived.valid).toBe(true);
    expect(derived.evidence).toMatchObject({ verdict: 'BLOCK', quorumSatisfied: false });
  });
});
