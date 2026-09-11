import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewCiServiceConfig } from '../../src/auth/reviewCiConfig';
import type { ReviewCiRepositoryOptions } from '../../src/persistence/reviewCiRepository';
import type { StoredReviewCiCheck } from '../../src/persistence/reviewCiCheckRepository';
import type { ReviewCiCheckPublisherOptions } from '../../src/review/reviewCiCheckPublisher';
import type { ReviewCiServiceOptions } from '../../src/review/reviewCiService';
import { createReviewCiLanePlan, reviewCiIdentityDigest, type StoredReviewCiRequest } from '../../src/review/reviewCi';
import { deriveReviewGateExternalId } from '../../src/github/reviewGateClient';
import { createReviewCiRuntime } from '../../src/reviewCiRuntime';

const mocks = vi.hoisted(() => ({
  coreConstructor: vi.fn(), checkRepositoryConstructor: vi.fn(), serviceConstructor: vi.fn(),
  publisherConstructor: vi.fn(), verifierConstructor: vi.fn(), readerConstructor: vi.fn(),
  gateClientConstructor: vi.fn(), ciClientConstructor: vi.fn(), checkClientFactory: vi.fn(),
  mint: vi.fn(), candidate: vi.fn(), resolve: vi.fn(), reconcile: vi.fn(), merge: vi.fn(),
  transition: vi.fn(), pendingPublished: vi.fn(), serviceTick: vi.fn(), publisherTick: vi.fn(),
  query: vi.fn(), connect: vi.fn(), globalFetch: vi.fn(), transport: vi.fn(), verify: vi.fn(),
}));
vi.mock('../../src/persistence/reviewCiRepository', () => ({
  PostgresReviewCiRepository: vi.fn(function (pool, options) {
    mocks.coreConstructor(pool, options); return { tag: 'core-repository' };
  }),
}));
vi.mock('../../src/persistence/reviewCiCheckRepository', () => ({
  PostgresReviewCiCheckRepository: vi.fn(function (pool) {
    mocks.checkRepositoryConstructor(pool);
    return { transitionInTransaction: mocks.transition, assertPendingPublishedInTransaction: mocks.pendingPublished };
  }),
}));
vi.mock('../../src/review/reviewCiService', () => ({
  ReviewCiService: vi.fn(function (options) {
    mocks.serviceConstructor(options); return { runOnce: mocks.serviceTick };
  }),
}));
vi.mock('../../src/review/reviewCiCheckPublisher', () => ({
  ReviewCiCheckPublisher: vi.fn(function (options) {
    mocks.publisherConstructor(options); return { runOnce: mocks.publisherTick };
  }),
}));
vi.mock('../../src/auth/reviewCiOidc', () => ({
  ReviewCiOidcVerifier: vi.fn(function (options) {
    mocks.verifierConstructor(options); return { verify: mocks.verify };
  }),
}));
vi.mock('../../src/github/authoritativeReviewReader', () => ({
  AuthoritativeReviewReader: vi.fn(function (options) {
    mocks.readerConstructor(options); return { currentCandidate: mocks.candidate };
  }),
}));
vi.mock('../../src/github/ciAppToken', () => ({ getBoundedCiRepositoryToken: mocks.mint }));
vi.mock('../../src/github/reviewGateClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/github/reviewGateClient')>(),
  GitHubReviewGateClient: vi.fn(function (options) {
    mocks.gateClientConstructor(options); return { reconcile: mocks.reconcile };
  }),
}));
vi.mock('../../src/github/reviewCiClient', () => ({
  GitHubReviewCiClient: vi.fn(function (options) {
    mocks.ciClientConstructor(options); return { tag: 'ci-client', currentMergeCandidate: mocks.merge };
  }),
}));
vi.mock('../../src/github/reviewCiCheckClient', () => ({ createReviewCiCheckClient: mocks.checkClientFactory }));

const APP = 4385771;
const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const id = '00000000-0000-4000-8000-000000000001';

function fixture() {
  const selected = { repositoryId: 1232078607, ownerId: 99, owner: 'calltelemetry', repo: 'ct-meta',
    relay: { workflowId: 3211, workflowPath: '.github/workflows/relay.yml', workflowRef: 'refs/heads/main', workflowSha: 'f'.repeat(40) },
    validation: { workflowId: 3212, workflowPath: '.github/workflows/candidate.yml', workflowRef: 'refs/tags/ci-v1', workflowSha: 'e'.repeat(40) },
    lanePlan: createReviewCiLanePlan(['core', 'tools'], ['validate']) };
  const config: ReviewCiServiceConfig = { expectedAppId: APP, admissionEnabled: true, repositoryDispatchEnabled: true,
    repositories: [selected], tickMs: 5000 };
  const runId = `run_${'1'.repeat(32)}`;
  const review: StoredReviewCiRequest['review'] = { repositoryId: selected.repositoryId, owner: selected.owner, repo: selected.repo,
    prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64),
    runId, reviewGeneration: 2, executionAttempt: 1, attemptId: `${runId}-g2-e1` };
  const binding = { ...selected.validation, candidateSha: 'd'.repeat(40), lanePlan: selected.lanePlan };
  const request: StoredReviewCiRequest = { requestId: id, review, expectedAppId: APP, state: 'admitted', binding,
    identityDigest: reviewCiIdentityDigest({ requestId: id, review, expectedAppId: APP, binding }),
    workflowEpoch: 1, execution: null, terminalReceipt: null };
  const current = { repositoryId: review.repositoryId, owner: review.owner, repo: review.repo, prNumber: review.prNumber,
    headSha: review.headSha, baseSha: review.baseSha, open: true, draft: false };
  const policy = { current, prepared: { policy: { effectivePolicyDigest: review.policyDigest } } };
  const { reviewGeneration: _generation, ...coordinates } = review;
  const gateRow = { check_id: 12001, expected_app_id: APP, current_attempt: true, desired_state: 'success',
    creation_state: 'bound', desired_version: 2, published_version: 2 };
  const gateCheck = { id: 12001, name: 'Review Yeti Gate', appId: APP, headSha: review.headSha,
    externalId: deriveReviewGateExternalId(coordinates), status: 'completed', conclusion: 'success' };
  mocks.candidate.mockImplementation(async () => structuredClone(current));
  mocks.resolve.mockImplementation(async () => structuredClone(policy));
  mocks.query.mockImplementation(async () => ({ rows: [structuredClone(gateRow)] }));
  mocks.reconcile.mockImplementation(async () => structuredClone(gateCheck));
  mocks.merge.mockResolvedValue({ repositoryId: review.repositoryId, owner: review.owner, repo: review.repo,
    prNumber: review.prNumber, headSha: review.headSha, baseSha: review.baseSha, candidateSha: binding.candidateSha });
  const options = { config, pool: { query: mocks.query, connect: mocks.connect } as unknown as Pool,
    appId: String(APP), privateKey: 'synthetic-app-private-key', baseUrl: 'https://github.example.invalid/api/v3',
    workerId: 'ci-runtime-unit', resolver: { resolve: mocks.resolve }, fetchImplementation: mocks.transport };
  return { options, config, selected, request, binding, current, policy, gateRow, gateCheck, coordinates };
}
function check(request: StoredReviewCiRequest): StoredReviewCiCheck {
  const review = request.review;
  return { request, expectedAppId: APP, immutableBindingDigest: request.identityDigest!,
    externalId: `review-yeti-ci:v1:${'1'.repeat(64)}`, currentEpoch: request.workflowEpoch,
    claimedExecution: null, desiredState: 'success', desiredVersion: 2, publishedVersion: 1,
    checkId: 15001, creationState: 'bound', terminalReceipt: null,
    coordinates: { owner: review.owner, repo: review.repo, repositoryId: review.repositoryId, prNumber: review.prNumber,
      headSha: review.headSha, baseSha: review.baseSha, policyDigest: review.policyDigest,
      requestId: request.requestId, immutableBindingDigest: request.identityDigest!, epoch: request.workflowEpoch } };
}
function serviceOptions(): ReviewCiServiceOptions { return mocks.serviceConstructor.mock.calls[0][0]; }
function publisherOptions(): ReviewCiCheckPublisherOptions { return mocks.publisherConstructor.mock.calls[0][0]; }
function repositoryOptions(): ReviewCiRepositoryOptions { return mocks.coreConstructor.mock.calls[0][1]; }
function selectedIdentity(f: ReturnType<typeof fixture>) {
  return { repositoryId: f.selected.repositoryId, owner: f.selected.owner, repo: f.selected.repo };
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.mint.mockResolvedValue({ token: 'ghs_unit_scoped', expiresAt: '2026-09-09T13:00:00.000Z' });
  mocks.serviceTick.mockResolvedValue(undefined); mocks.publisherTick.mockResolvedValue({ status: 'idle' });
  mocks.transition.mockResolvedValue(undefined); mocks.pendingPublished.mockResolvedValue(undefined);
  mocks.checkClientFactory.mockReturnValue({ tag: 'check-client' });
  mocks.query.mockRejectedValue(new Error('Unexpected SQL')); mocks.connect.mockRejectedValue(new Error('Unexpected SQL connection'));
  mocks.transport.mockRejectedValue(new Error('Unexpected injected HTTP request'));
  mocks.globalFetch.mockRejectedValue(new Error('Unexpected global HTTP request'));
  vi.stubGlobal('fetch', mocks.globalFetch);
});
afterEach(() => {
  expect(mocks.globalFetch).not.toHaveBeenCalled();
  expect(mocks.connect).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('createReviewCiRuntime actual composition', () => {
  it('constructs without HTTP, SQL, token minting, resolver calls, or scheduling', () => {
    const f = fixture(); const runtime = createReviewCiRuntime(f.options);
    expect(Object.keys(runtime).sort()).toEqual(['routes', 'runOnce', 'service']);
    expect(runtime.routes.service).toBe(runtime.service);
    expect(runtime.routes.verifier).toEqual({ verify: mocks.verify });
    expect(mocks.verifierConstructor).toHaveBeenCalledExactlyOnceWith({ repositories: f.config.repositories });
    expect(mocks.coreConstructor).toHaveBeenCalledExactlyOnceWith(f.options.pool, {
      admissionTimeoutMs: 15_000, onTransition: expect.any(Function), assertPendingPublished: expect.any(Function),
    });
    expect(mocks.checkRepositoryConstructor).toHaveBeenCalledExactlyOnceWith(f.options.pool);
    expect(serviceOptions()).toMatchObject({ config: f.config, workerId: f.options.workerId, repository: { tag: 'core-repository' } });
    expect(publisherOptions()).toMatchObject({ workerId: f.options.workerId,
      repository: { transitionInTransaction: mocks.transition, assertPendingPublishedInTransaction: mocks.pendingPublished } });
    for (const operation of [mocks.query, mocks.mint, mocks.resolve, mocks.candidate, mocks.reconcile, mocks.merge,
      mocks.serviceTick, mocks.publisherTick, mocks.readerConstructor, mocks.ciClientConstructor, mocks.checkClientFactory,
      mocks.transport]) {
      expect(operation).not.toHaveBeenCalled();
    }
  });
  it.each([{ appId: '123' }, { appId: '04385771' }, { workerId: '' }, { workerId: ' \t\n' }])('rejects invalid runtime identity before composition: %j', (change) => {
    const f = fixture();
    expect(() => createReviewCiRuntime({ ...f.options, ...change })).toThrow('identity mismatch');
    expect(mocks.coreConstructor).not.toHaveBeenCalled(); expect(mocks.publisherConstructor).not.toHaveBeenCalled();
    expect(mocks.verifierConstructor).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.mint).not.toHaveBeenCalled();
  });
  it.each(['admitted', 'running', 'completed', 'superseded', 'delivery_error'] as const)('wires %s to the check repository with the exact parent transaction client', async (transition) => {
    const f = fixture(); createReviewCiRuntime(f.options);
    const client = { query: vi.fn() };
    await repositoryOptions().onTransition!(client, f.request, transition, NOW);
    expect(mocks.transition).toHaveBeenCalledExactlyOnceWith(client, f.request, transition, NOW);
    const failure = new Error('transaction must roll back'); mocks.transition.mockRejectedValueOnce(failure);
    await expect(repositoryOptions().onTransition!(client, f.request, transition, NOW)).rejects.toBe(failure);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.publisherTick).not.toHaveBeenCalled();
  });
  it('wires pending-publication proof to the same transaction and propagates a failed prerequisite', async () => {
    const f = fixture(); createReviewCiRuntime(f.options); const client = { query: vi.fn() };
    await repositoryOptions().assertPendingPublished!(client, f.request, NOW);
    expect(mocks.pendingPublished).toHaveBeenCalledExactlyOnceWith(client, f.request, NOW);
    const failure = new Error('pending publication unavailable'); mocks.pendingPublished.mockRejectedValueOnce(failure);
    await expect(repositoryOptions().assertPendingPublished!(client, f.request, NOW)).rejects.toBe(failure);
    expect(mocks.mint).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('publishes before and after service reconciliation, including paused-admission drain mode', async () => {
    const f = fixture(); f.config.admissionEnabled = false; f.config.repositoryDispatchEnabled = false;
    const order: string[] = [];
    mocks.publisherTick.mockImplementation(async () => { order.push('publish'); });
    mocks.serviceTick.mockImplementation(async () => { order.push('service'); });
    const runtime = createReviewCiRuntime(f.options);
    await runtime.runOnce();
    expect(order).toEqual(['publish', 'service', 'publish']);
    expect(serviceOptions().config.admissionEnabled).toBe(false);
    expect(serviceOptions().config.repositoryDispatchEnabled).toBe(false);
  });
  it.each(['first publisher', 'service', 'second publisher'])('coalesces the complete tick while %s is pending', async (stage) => {
    const f = fixture(); const pending = deferred(); const entered = deferred();
    let publications = 0;
    mocks.publisherTick.mockImplementation(async () => {
      publications++;
      if ((stage === 'first publisher' && publications === 1) || (stage === 'second publisher' && publications === 2)) {
        entered.resolve(); await pending.promise;
      }
    });
    mocks.serviceTick.mockImplementation(async () => { if (stage === 'service') { entered.resolve(); await pending.promise; } });
    const runtime = createReviewCiRuntime(f.options);
    const first = runtime.runOnce(); await entered.promise;
    expect(runtime.runOnce()).toBe(first); expect(runtime.runOnce()).toBe(first);
    pending.resolve(); await first;
    expect(mocks.publisherTick).toHaveBeenCalledTimes(2); expect(mocks.serviceTick).toHaveBeenCalledTimes(1);
    await runtime.runOnce();
    expect(mocks.publisherTick).toHaveBeenCalledTimes(4); expect(mocks.serviceTick).toHaveBeenCalledTimes(2);
  });
  it.each(['first publisher', 'service', 'second publisher'])('releases the coalescing guard after %s fails', async (stage) => {
    const f = fixture(); const failure = new Error('synthetic transient failure');
    if (stage === 'first publisher') mocks.publisherTick.mockRejectedValueOnce(failure);
    if (stage === 'service') mocks.serviceTick.mockRejectedValueOnce(failure);
    if (stage === 'second publisher') mocks.publisherTick.mockResolvedValueOnce({ status: 'idle' }).mockRejectedValueOnce(failure);
    const runtime = createReviewCiRuntime(f.options);
    await expect(runtime.runOnce()).rejects.toBe(failure);
    const initialPublishes = mocks.publisherTick.mock.calls.length;
    const initialServices = mocks.serviceTick.mock.calls.length;
    await expect(runtime.runOnce()).resolves.toBeUndefined();
    expect(mocks.publisherTick).toHaveBeenCalledTimes(initialPublishes + 2);
    expect(mocks.serviceTick).toHaveBeenCalledTimes(initialServices + 1);
  });
  it.each(['repository-dispatch', 'workflow-dispatch', 'read'] as const)('uses the exact enrolled repository and %s minting purpose', async (purpose) => {
    const f = fixture(); createReviewCiRuntime(f.options);
    await serviceOptions().clientFor(f.request, purpose);
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith({ appId: String(APP), privateKey: f.options.privateKey,
      repository: selectedIdentity(f), baseUrl: f.options.baseUrl }, purpose, { fetchImplementation: mocks.transport });
    expect(mocks.ciClientConstructor).toHaveBeenCalledExactlyOnceWith({ token: 'ghs_unit_scoped', expectedAppId: APP,
      repository: selectedIdentity(f), binding: f.binding, baseUrl: f.options.baseUrl, fetchImplementation: mocks.transport });
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('does not invent a candidate/workflow binding for a still-pending completion request', async () => {
    const f = fixture(); createReviewCiRuntime(f.options);
    await serviceOptions().clientFor({ ...f.request, state: 'pending', binding: null, identityDigest: null, workflowEpoch: 0 }, 'repository-dispatch');
    expect(mocks.ciClientConstructor.mock.calls[0][0]).not.toHaveProperty('binding');
  });
  it('uses only the dedicated check-publication minter and typed CI client facade for publishing', async () => {
    const f = fixture(); createReviewCiRuntime(f.options);
    await expect(publisherOptions().clientFor(check(f.request))).resolves.toEqual({ tag: 'check-client' });
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith({ appId: String(APP), privateKey: f.options.privateKey,
      repository: selectedIdentity(f), baseUrl: f.options.baseUrl }, 'check-publication', { fetchImplementation: mocks.transport });
    expect(mocks.checkClientFactory).toHaveBeenCalledExactlyOnceWith({ token: 'ghs_unit_scoped', expectedAppId: APP,
      baseUrl: f.options.baseUrl, fetchImplementation: mocks.transport });
    expect(mocks.ciClientConstructor).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(['repositoryId', 'owner', 'repo', 'expectedAppId'] as const)('rejects unenrolled %s across all runtime capabilities before mint/read', async (field) => {
    const f = fixture(); createReviewCiRuntime(f.options); const request = structuredClone(f.request);
    if (field === 'expectedAppId') request.expectedAppId++;
    else if (field === 'repositoryId') request.review.repositoryId++;
    else request.review[field] = 'not-enrolled';
    await expect(serviceOptions().current(request)).rejects.toThrow('identity mismatch');
    for (const purpose of ['repository-dispatch', 'workflow-dispatch', 'read'] as const) {
      await expect(serviceOptions().clientFor(request, purpose)).rejects.toThrow('identity mismatch');
    }
    await expect(publisherOptions().clientFor(check(request))).rejects.toThrow('identity mismatch');
    await expect(publisherOptions().currentSuccess(check(request), new AbortController().signal)).rejects.toThrow('identity mismatch');
    expect(mocks.mint).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.candidate).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('selects the matching finite enrollment instead of the first configured repository', async () => {
    const f = fixture(); f.config.repositories.unshift({ ...f.selected, repositoryId: 555, repo: 'another',
      validation: { ...f.selected.validation, workflowId: 888 } });
    createReviewCiRuntime(f.options); await serviceOptions().clientFor(f.request, 'read');
    expect(mocks.mint.mock.calls[0][0].repository).toEqual(selectedIdentity(f));
  });
});

describe('runtime fresh candidate/Gate composition', () => {
  it('reads exact PR/B/H/policy, persisted gate version/ID, App check readback, then immutable merge C', async () => {
    const f = fixture(); createReviewCiRuntime(f.options);
    const result = await serviceOptions().current(f.request);
    expect(result).toMatchObject({ status: 'ready', binding: f.binding });
    expect(mocks.candidate).toHaveBeenCalledTimes(1);
    expect(mocks.candidate.mock.calls[0][0]).toEqual({ ...selectedIdentity(f), prNumber: 42 });
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.resolve.mock.calls[0][0]).toEqual({ ...selectedIdentity(f), prNumber: 42,
      headSha: f.request.review.headSha, baseSha: f.request.review.baseSha });
    expect(mocks.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('FROM review_gate_attempts WHERE attempt_id=$1'), [f.request.review.attemptId]);
    expect(mocks.gateClientConstructor).toHaveBeenCalledExactlyOnceWith({ token: 'ghs_unit_scoped', expectedAppId: APP,
      baseUrl: f.options.baseUrl, fetchImplementation: expect.any(Function) });
    expect(mocks.gateClientConstructor.mock.calls[0][0].fetchImplementation)
      .toBe(mocks.readerConstructor.mock.calls[0][0].fetchImplementation);
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith(f.coordinates);
    expect(mocks.reconcile.mock.calls[0][0]).not.toHaveProperty('reviewGeneration');
    expect(mocks.merge).toHaveBeenCalledExactlyOnceWith({ prNumber: 42, headSha: f.request.review.headSha, baseSha: f.request.review.baseSha });
    expect(mocks.candidate.mock.invocationCallOrder[0]).toBeLessThan(mocks.resolve.mock.invocationCallOrder[0]);
    expect(mocks.resolve.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(mocks.reconcile.mock.invocationCallOrder[0]);
    expect(mocks.reconcile.mock.invocationCallOrder[0]).toBeLessThan(mocks.merge.mock.invocationCallOrder[0]);
  });
  it.each([{ open: false }, { headSha: 'f'.repeat(40) }, { baseSha: 'f'.repeat(40) }])('stops stale candidate %j before policy/SQL/check reads', async (change) => {
    const f = fixture(); Object.assign(f.current, change); createReviewCiRuntime(f.options);
    await expect(serviceOptions().current(f.request)).resolves.toEqual({ status: 'stale' });
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it('keeps a draft waiting without policy/SQL/check reads', async () => {
    const f = fixture(); f.current.draft = true; createReviewCiRuntime(f.options);
    await expect(serviceOptions().current(f.request)).resolves.toEqual({ status: 'waiting' });
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('rejects a fresh policy digest change before reading gate persistence', async () => {
    const f = fixture(); f.policy.prepared.policy.effectivePolicyDigest = 'f'.repeat(64); createReviewCiRuntime(f.options);
    await expect(serviceOptions().current(f.request)).resolves.toEqual({ status: 'stale' });
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.reconcile).not.toHaveBeenCalled();
  });
  it('honors a draft observed by the resolver after the initial PR read', async () => {
    const f = fixture(); f.policy.current = { ...f.current, draft: true }; createReviewCiRuntime(f.options);
    await expect(serviceOptions().current(f.request)).resolves.toEqual({ status: 'waiting' });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(['missing', 'superseded', 'non-success', 'foreign-app'])('stops %s persisted gate as stale', async (kind) => {
    const f = fixture(); createReviewCiRuntime(f.options);
    if (kind === 'missing') mocks.query.mockResolvedValue({ rows: [] });
    if (kind === 'superseded') f.gateRow.current_attempt = false;
    if (kind === 'non-success') f.gateRow.desired_state = 'failure';
    if (kind === 'foreign-app') f.gateRow.expected_app_id++;
    await expect(serviceOptions().current(f.request)).resolves.toEqual({ status: 'stale' });
    expect(mocks.reconcile).not.toHaveBeenCalled(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it.each(['reserved', 'creating', 'null-id', 'behind', 'ahead'])('treats %s publication as retryable, not stale admission', async (kind) => {
    const f = fixture(); createReviewCiRuntime(f.options);
    if (kind === 'reserved' || kind === 'creating') f.gateRow.creation_state = kind;
    if (kind === 'null-id') Object.assign(f.gateRow, { check_id: null });
    if (kind === 'behind') f.gateRow.published_version--;
    if (kind === 'ahead') f.gateRow.published_version++;
    await expect(serviceOptions().current(f.request)).rejects.toThrow('publication is pending');
    expect(mocks.reconcile).not.toHaveBeenCalled(); expect(mocks.merge).not.toHaveBeenCalled();
  });
  it.each(['missing', 'wrong-id', 'queued', 'in-progress', 'failed', 'skipped'])('rejects %s external Gate readback before resolving C', async (kind) => {
    const f = fixture(); createReviewCiRuntime(f.options);
    if (kind === 'missing') mocks.reconcile.mockResolvedValue(null);
    if (kind === 'wrong-id') f.gateCheck.id++;
    if (kind === 'queued') f.gateCheck.status = 'queued';
    if (kind === 'in-progress') f.gateCheck.status = 'in_progress';
    if (kind === 'failed') f.gateCheck.conclusion = 'failure';
    if (kind === 'skipped') f.gateCheck.conclusion = 'skipped';
    await expect(serviceOptions().current(f.request)).rejects.toThrow('check does not match');
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('uses configured W/lane plan and newly resolved C rather than mutable fields on a stored request', async () => {
    const f = fixture(); createReviewCiRuntime(f.options);
    f.request.binding = { ...f.binding, candidateSha: '0'.repeat(40), workflowSha: '1'.repeat(40),
      lanePlan: createReviewCiLanePlan(['untrusted'], ['untrusted']) };
    await expect(serviceOptions().current(f.request)).resolves.toMatchObject({ status: 'ready', binding: f.binding });
  });
  it('provides the publisher fresh C and exact Gate provenance for its own immutable-binding comparison', async () => {
    const f = fixture(); createReviewCiRuntime(f.options);
    mocks.merge.mockResolvedValue({ candidateSha: '0'.repeat(40) });
    const freshness = await publisherOptions().currentSuccess(check(f.request), new AbortController().signal);
    expect(freshness).toEqual({ open: true, draft: false, repositoryId: f.request.review.repositoryId, prNumber: 42,
      baseSha: f.request.review.baseSha, headSha: f.request.review.headSha, policyDigest: f.request.review.policyDigest,
      candidateSha: '0'.repeat(40), reviewGate: f.gateCheck });
    expect(freshness.candidateSha).not.toBe(f.request.binding!.candidateSha);
    expect(mocks.mint.mock.calls.map(([, purpose]) => purpose)).toEqual(['read']);
    expect(mocks.checkClientFactory).not.toHaveBeenCalled();
  });
  it.each(['stale', 'draft'])('rejects successful publication when the fresh request is %s', async (state) => {
    const f = fixture(); if (state === 'stale') f.current.headSha = '0'.repeat(40); else f.current.draft = true;
    createReviewCiRuntime(f.options);
    await expect(publisherOptions().currentSuccess(check(f.request), new AbortController().signal)).rejects.toThrow('no longer eligible');
    expect(mocks.checkClientFactory).not.toHaveBeenCalled();
  });
  it.each(['mint', 'candidate', 'resolve', 'query', 'reconcile', 'merge'] as const)('does not convert a %s read failure into eligible evidence', async (operation) => {
    const f = fixture(); createReviewCiRuntime(f.options); const failure = new Error('synthetic dependency unavailable');
    mocks[operation].mockRejectedValueOnce(failure);
    await expect(serviceOptions().current(f.request)).rejects.toBe(failure);
    expect(mocks.checkClientFactory).not.toHaveBeenCalled();
  });
  it('rejects an already-aborted publisher freshness request before any I/O', async () => {
    const f = fixture(); createReviewCiRuntime(f.options); const controller = new AbortController(); controller.abort();
    await expect(publisherOptions().currentSuccess(check(f.request), controller.signal)).rejects.toThrow();
    expect(mocks.mint).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(['mint', 'candidate', 'resolve', 'query', 'reconcile', 'merge'] as const)(
    'rejects a late %s result after publisher cancellation without starting any subsequent I/O', async (operation) => {
    const f = fixture(); createReviewCiRuntime(f.options); const controller = new AbortController();
    const pending = deferred<unknown>(); const entered = deferred();
    const reads = [mocks.mint, mocks.candidate, mocks.resolve, mocks.query, mocks.reconcile, mocks.merge];
    const position = reads.indexOf(mocks[operation]);
    const lateResults = [{ token: 'ghs_late_token' }, f.current, f.policy, { rows: [f.gateRow] },
      f.gateCheck, { candidateSha: f.binding.candidateSha }];
    mocks[operation].mockImplementationOnce(() => { entered.resolve(); return pending.promise; });
    const result = publisherOptions().currentSuccess(check(f.request), controller.signal);
    const rejected = expect(result).rejects.toThrow();
    await entered.promise;
    controller.abort(); pending.resolve(lateResults[position]);
    await rejected;
    expect(mocks.mint.mock.calls[0][2].signal).toBe(controller.signal);
    if (position >= 1) expect(mocks.candidate.mock.calls[0][1]).toBe(controller.signal);
    if (position >= 2) expect(mocks.resolve.mock.calls[0][1]).toBe(controller.signal);
    for (const read of reads.slice(position + 1)) expect(read).not.toHaveBeenCalled();
    expect(mocks.checkClientFactory).not.toHaveBeenCalled(); expect(mocks.transport).not.toHaveBeenCalled();
  });
  it('passes the live publisher signal through the resolver and shares an abort-aware fetcher across every read client', async () => {
    const f = fixture(); createReviewCiRuntime(f.options); const controller = new AbortController();
    await publisherOptions().currentSuccess(check(f.request), controller.signal);
    expect(mocks.mint.mock.calls[0][2].signal).toBe(controller.signal);
    expect(mocks.candidate.mock.calls[0][1]).toBe(controller.signal);
    expect(mocks.resolve.mock.calls[0][1]).toBe(controller.signal);
    const fetcher = mocks.readerConstructor.mock.calls[0][0].fetchImplementation as typeof fetch;
    expect(mocks.gateClientConstructor.mock.calls[0][0].fetchImplementation).toBe(fetcher);
    expect(mocks.ciClientConstructor.mock.calls[0][0].fetchImplementation).toBe(fetcher);
    controller.abort();
    await expect(fetcher('https://github.example.invalid/late')).rejects.toThrow();
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it.each(['publisher', 'client', 'publisher without client signal'])(
    'preserves request options and honors %s cancellation in the injected fetch boundary', async (abortSource) => {
    const f = fixture(); createReviewCiRuntime(f.options);
    const publisher = new AbortController(); const client = new AbortController();
    await publisherOptions().currentSuccess(check(f.request), publisher.signal);
    const fetcher = mocks.readerConstructor.mock.calls[0][0].fetchImplementation as typeof fetch;
    const response = new Response('{}'); mocks.transport.mockResolvedValueOnce(response);
    const init: RequestInit = { method: 'GET', redirect: 'error', headers: { accept: 'application/json' },
      ...(abortSource === 'publisher without client signal' ? {} : { signal: client.signal }) };
    await expect(fetcher('https://github.example.invalid/read', init)).resolves.toBe(response);
    expect(mocks.transport).toHaveBeenCalledExactlyOnceWith('https://github.example.invalid/read', {
      ...init, signal: expect.any(AbortSignal),
    });
    const forwarded = mocks.transport.mock.calls[0][1].signal as AbortSignal;
    expect(forwarded.aborted).toBe(false);
    if (abortSource === 'client') client.abort(); else publisher.abort();
    expect(forwarded.aborted).toBe(true);
  });
});
