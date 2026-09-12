import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildWorkerFailureDiagnostics } from '../../src/review/workerCompletion';
import { runPublishingReviewWorker, type PublishingReviewDeps } from '../../src/cli/publishingReview';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { parseWorkerReviewCompletion, type WorkerReviewCompletion, type WorkerReviewResult } from '../../src/review/workerReviewCompletion';
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

function fixture() {
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
    REVIEW_PR_NUMBER: '42', REVIEW_HEAD_SHA: HEAD, REVIEW_BASE_SHA: BASE, REVIEW_EXECUTION_ATTEMPT: '2',
    REVIEW_POLICY_DIGEST: prepared.policy.effectivePolicyDigest, REVIEW_CONFIG_DIGEST: prepared.policy.effectiveConfigDigest,
    REVIEW_PREPARED_CONFIG_JSON: JSON.stringify(envelope), REVIEW_COMPLETION_URL: ENDPOINT,
    REVIEW_MODEL: transport.model, BIFROST_BASE_URL: transport.baseUrl, BIFROST_PR_REVIEW_API_KEY: 'vk_fake',
    GH_TOKEN: TOKEN, GITHUB_PUBLISH_TOKEN: TOKEN, REVIEW_REPOSITORY_VISIBILITY: 'PRIVATE',
  };
  const usage = { prompt: 10, completion: 5, total: 15 };
  const panel: PanelResult = {
    headSha: HEAD,
    personas: prepared.expectedPersonaIds.map((id) => ({ id, required: id === 'sec-lane',
      providerId: 'bifrost', model: transport.model, decision: 'APPROVE', findings: [],
      usage, costUSD: null, durationMs: 25 })),
    optionalFailures: [], quorum: { required: 1, distinctProviders: ['bifrost'], satisfied: true },
    moderator: { providerId: 'bifrost', model: transport.model, decision: 'RECONCILED', findings: [], usage, costUSD: null, durationMs: 10 },
    arbiter: { providerId: 'bifrost', model: transport.model, verdict: 'SHIP', rationale: 'Clean', usage, costUSD: null, durationMs: 10 },
  };
  const source = { baseSha: BASE, headSha: HEAD, diff: DIFF,
    diffDigest: createHash('sha256').update(DIFF).digest('hex'), githubReads: 3 as const };
  const checkClient = { createCheck: vi.fn(async () => 4242), completeCheck: vi.fn(async () => undefined) };
  const sourceLoader = vi.fn<NonNullable<PublishingReviewDeps['sourceLoader']>>().mockResolvedValue(source);
  const panelRunner = vi.fn<NonNullable<PublishingReviewDeps['panelRunner']>>().mockResolvedValue(panel);
  const client = { complete: vi.fn().mockRejectedValue(new Error('A test must never invoke a provider')) };
  const reportReviewResult = vi.fn<WorkerReviewCompletionAdapter['reportReviewResult']>().mockResolvedValue(undefined);
  const legacyFailure = vi.fn(async () => undefined);
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
    personas: ['sec-lane', 'qual-lane'].map((id) => ({ id, decision: 'APPROVE', status: 'COMPLETE', findings: [] })),
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

  it('emits optional persona failure evidence without provider transcripts or credentials', async () => {
    const f = fixture();
    f.panel.personas = [f.panel.personas[0]];
    f.panel.optionalFailures = [{ id: 'qual-lane', error: `429 ${PRIVATE_DETAIL} ${TOKEN}` }];
    await runPublishingReviewWorker(f.env, f.deps);
    const expected = cleanResult();
    expected.personas[1] = { id: 'qual-lane', decision: 'ERROR', status: 'ERROR', findings: [], errorClass: 'rate_limit' };
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, expected));
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(TOKEN);
  });

  it('forwards findings through the strict typed boundary while omitting operational metadata', async () => {
    const f = fixture();
    const finding = { severity: 'P2' as const, path: 'src/a.ts', line: 1, title: 'Validate input', body: 'Validate before use.',
      confidence: 80, fixOptions: [{ rank: 1, title: 'Guard', suggestionCode: 'validate();' }] };
    f.panel.personas[0].decision = 'FINDINGS';
    f.panel.personas[0].findings = [{ ...finding, reporters: 2, providerTranscript: PRIVATE_DETAIL } as typeof finding];
    f.panel.personas[0].toolCalls = [{ tool: 'read', args: { token: TOKEN } }];
    await runPublishingReviewWorker(f.env, f.deps);
    const expected = cleanResult();
    expected.personas[0] = { id: 'sec-lane', decision: 'FINDINGS', status: 'COMPLETE', findings: [finding] };
    expect(f.reportReviewResult).toHaveBeenCalledExactlyOnceWith(expectedEvent(f, expected));
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(PRIVATE_DETAIL);
    expect(JSON.stringify(f.reportReviewResult.mock.calls)).not.toContain(TOKEN);
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
      if (variant === 'wrong URL') f.env.BIFROST_BASE_URL = 'https://other.example.invalid/v1';
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

  it.each(['BIFROST_BASE_URL', 'BIFROST_PR_REVIEW_API_KEY', 'REVIEW_MODEL'])('reports a missing %s as a fail-closed pre-execution contract failure', async (name) => {
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

  it('wires the entrypoint to one raw check with visible findings and an evidence-only typed callback', async () => {
    const f = fixture();
    const finding = { severity: 'P2' as const, path: 'src/a.ts', line: 1,
      title: 'Preserve raw finding', body: 'This finding remains visible independently of gate eligibility.' };
    f.panel.personas[0].decision = 'FINDINGS';
    f.panel.personas[0].findings = [finding];
    vi.spyOn(qualificationReader, 'loadSameHeadReviewSource').mockResolvedValue(f.source);
    vi.spyOn(panelEngine, 'executePersonaPanel').mockResolvedValue(f.panel);
    const createCheck = vi.spyOn(GitHubInstallationClient.prototype, 'createCheck');
    const completeCheck = vi.spyOn(GitHubInstallationClient.prototype, 'completeCheck');
    const rawEndpoint = 'https://api.github.com/repos/example/project/check-runs';
    f.fetch.mockImplementation(async (input, init) => {
      if (String(input) === rawEndpoint && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
      }
      if (String(input) === `${rawEndpoint}/4242` && init?.method === 'PATCH') {
        return new Response('{}', { status: 200 });
      }
      if (String(input) === ENDPOINT && init?.method === 'POST') {
        return new Response(JSON.stringify({ version: 'WorkerReviewCompletionAccepted.v1',
          runId: f.env.REVIEW_RUN_ID, status: 'recorded' }), { status: 200 });
      }
      throw new Error('Unexpected request in the mocked worker entrypoint');
    });
    const { runWorker } = await import('../../src/cli/runLiveReview');
    const legacy = vi.fn();
    expect(f.env).not.toHaveProperty('REVIEW_CHECK_ID');
    await runWorker(f.env, legacy);
    expect(legacy).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(3);
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
    expect(createCheck).toHaveBeenCalledExactlyOnceWith('example', 'project', HEAD,
      `${f.env.REVIEW_RUN_ID}:a${f.env.REVIEW_EXECUTION_ATTEMPT}`);
    expect(completeCheck).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      owner: 'example', repo: 'project', checkId: 4242,
    }));
    const callbacks = f.fetch.mock.calls.filter(([url]) => String(url) === ENDPOINT);
    expect(callbacks).toHaveLength(1);
    const [endpoint, init] = callbacks[0];
    expect(endpoint).toBe(ENDPOINT);
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    const payload = JSON.parse(String(init?.body));
    expectEvidenceOnlyCallback(payload);
    expect(payload).toMatchObject({ version: 'WorkerReviewCompletion.v1', configDigest: f.prepared.policy.effectiveConfigDigest });
    expect(payload.result.personas[0].findings).toEqual([finding]);
  });
});
