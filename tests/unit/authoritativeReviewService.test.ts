import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoritativeServiceConfig } from '../../src/auth/authoritativeServiceConfig';
import type { StoredReviewGate } from '../../src/review/reviewGateContracts';
import type { AuthoritativeCompletionContextOptions } from '../../src/review/authoritativeCompletionContext';
import type { AuthoritativePublishingResolverOptions } from '../../src/review/authoritativePublishingResolver';
import type { ReviewGatePublisherOptions } from '../../src/review/reviewGatePublisher';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { createAuthoritativeReviewService, type AuthoritativeReviewServiceOptions } from '../../src/review/authoritativeReviewService';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import type { ReviewAdmissionInput } from '../../src/review/reviewRun';

const mocks = vi.hoisted(() => ({
  publisherConstructor: vi.fn(), resolverConstructor: vi.fn(),
  completionFactory: vi.fn(), readerConstructor: vi.fn(), clientConstructor: vi.fn(),
  reap: vi.fn(), advance: vi.fn(), publish: vi.fn(), mint: vi.fn(), getPrepared: vi.fn(),
  currentCandidate: vi.fn(), resolvePolicyRevision: vi.fn(), immutablePolicyFile: vi.fn(),
  resolveCompletion: vi.fn(), verify: vi.fn(),
}));

vi.mock('../../src/review/reviewGatePublisher', () => ({
  ReviewGatePublisher: vi.fn(function (options) {
    mocks.publisherConstructor(options);
    return { runOnce: mocks.publish };
  }),
}));
// Keep the real resolver's current head/base and immutable-policy validation.
// Only its GitHub reader and token boundary are replaced below.
vi.mock('../../src/review/authoritativePublishingResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/review/authoritativePublishingResolver')>();
  return { ...actual, AuthoritativePublishingResolver: vi.fn(function (options) {
    mocks.resolverConstructor(options);
    return new actual.AuthoritativePublishingResolver(options);
  }) };
});
vi.mock('../../src/review/authoritativeCompletionContext', () => ({
  createAuthoritativeCompletionContext: vi.fn((options) => {
    mocks.completionFactory(options);
    return mocks.resolveCompletion;
  }),
}));
vi.mock('../../src/review/authoritativeServiceContracts', () => ({
  createWorkerCompletionVerifier: () => ({ verify: mocks.verify }),
}));
vi.mock('../../src/github/authoritativeReviewReader', () => ({
  AuthoritativeReviewReader: vi.fn(function (options) {
    mocks.readerConstructor(options);
    return { currentCandidate: mocks.currentCandidate, resolvePolicyRevision: mocks.resolvePolicyRevision,
      immutablePolicyFile: mocks.immutablePolicyFile };
  }),
}));
vi.mock('../../src/github/boundedAppToken', () => ({ getBoundedRepositoryToken: mocks.mint }));
vi.mock('../../src/github/reviewGateClient', () => ({
  GitHubReviewGateClient: vi.fn(function (options) {
    mocks.clientConstructor(options);
    return { client: 'gate' };
  }),
}));

const APP_ID = 4385771;
const candidate = { repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), open: true, draft: false };
const policyContent = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
  personas: 'security,testing', budget: { max_investigation_turns: 1 },
} });
const policyFile = { content: policyContent, source: {
  repositoryId: 987, repository: 'central/policies', sha: 'e'.repeat(40), path: 'policy/review.json',
  contentDigest: createHash('sha256').update(policyContent).digest('hex'),
} };

function fixture() {
  const config: AuthoritativeServiceConfig = {
    expectedAppId: APP_ID, admissionEnabled: true, repositoryIds: [123, 456],
    policyRepository: { repositoryId: 987, owner: 'central', repo: 'policies' },
    policyRef: 'refs/heads/approved', policyPath: 'policy/review.json',
    transport: { baseUrl: 'https://gateway.example.invalid/v1', model: 'service-selected-model' }, tickMs: 5_000,
  };
  const prepared = preparePublishingPolicy(policyFile, config.transport);
  const repository: AuthoritativeReviewServiceOptions['repository'] = {
    reapTerminalAttempts: mocks.reap, advanceProjectedAttempts: mocks.advance,
    claimPublication: vi.fn(), publishLocked: vi.fn(), retryPublication: vi.fn(), recordWorkerResult: vi.fn(),
  };
  const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(new Error('No live requests in unit tests'));
  const options = { config, repository, getStoredPrepared: mocks.getPrepared,
    appId: String(APP_ID), privateKey: 'fake-app-private-key',
    baseUrl: 'https://github.example.invalid/api/v3', workerId: 'authoritative-review-test', fetchImplementation };
  const gate: StoredReviewGate = {
    coordinates: { repositoryId: candidate.repositoryId, owner: candidate.owner, repo: candidate.repo,
      prNumber: candidate.prNumber, headSha: candidate.headSha, baseSha: candidate.baseSha,
      policyDigest: prepared.policy.effectivePolicyDigest, runId: `run_${'1'.repeat(32)}`,
      attemptId: '2'.repeat(64), executionAttempt: 2 },
    reviewGeneration: 3, expectedAppId: APP_ID, externalId: 'review-gate-test', checkId: 4242,
    creationState: 'bound', desiredState: 'success', desiredVersion: 3, publishedVersion: 2, current: true,
  };
  mocks.currentCandidate.mockResolvedValue(candidate);
  mocks.resolvePolicyRevision.mockResolvedValue(policyFile.source.sha);
  mocks.immutablePolicyFile.mockResolvedValue(policyFile);
  mocks.getPrepared.mockResolvedValue(prepared);
  return { options, config, prepared, gate };
}

function resolverOptions(): AuthoritativePublishingResolverOptions { return mocks.resolverConstructor.mock.calls[0][0]; }
function completionOptions(): AuthoritativeCompletionContextOptions { return mocks.completionFactory.mock.calls[0][0]; }
function publisherOptions(): ReviewGatePublisherOptions { return mocks.publisherConstructor.mock.calls[0][0]; }
function publishMints() { return mocks.mint.mock.calls.filter(([, purpose]) => purpose === 'publish'); }

function admissionInput(f: ReturnType<typeof fixture>): ReviewAdmissionInput {
  const { open: _open, draft: _draft, ...requested } = candidate;
  return {
    deliveryId: 'admission-test', eventName: 'pull_request', repositoryId: candidate.repositoryId,
    installationId: 456, receivedAt: 1_000, terminalDeadline: 901_000,
    payloadDigest: '1'.repeat(64), publicationMode: 'app-gate',
    identity: buildAuthoritativeReviewIdentity({ requested, current: candidate, policy: f.prepared.policy }),
    effectivePolicyDigest: f.prepared.policy.effectivePolicyDigest,
    authoritativeGate: { expectedAppId: APP_ID, prepared: f.prepared },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.reap.mockReset().mockResolvedValue(1);
  mocks.advance.mockReset().mockResolvedValue(2);
  mocks.publish.mockReset().mockResolvedValue({ status: 'idle' });
  mocks.mint.mockReset().mockResolvedValue({ token: 'ghs_fake_scoped_token' });
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('createAuthoritativeReviewService wiring', () => {
  it('keeps concrete database imports out of the service boundary', () => {
    const source = readFileSync(new URL('../../src/review/authoritativeReviewService.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"](?:pg|\.\.\/persistence\/[^'"]+)['"]/u);
    expect(source).not.toContain('PostgresReviewGateRepository');
    expect(source).not.toContain('getPreparedPublishingPolicy');
  });

  it('freshly validates the whole prepared identity for the locked admission adapter', async () => {
    const f = fixture();
    const service = createAuthoritativeReviewService(f.options);
    await expect(service.validateAdmission(admissionInput(f))).resolves.toBeUndefined();
    expect(mocks.currentCandidate).toHaveBeenCalledTimes(2);
    expect(mocks.immutablePolicyFile).toHaveBeenCalledExactlyOnceWith(f.config.policyRepository,
      policyFile.source.sha, f.config.policyPath, expect.any(AbortSignal));
    expect(publishMints()).toHaveLength(0);
  });

  it.each([{ headSha: 'd'.repeat(40) }, { baseSha: 'd'.repeat(40) }, { open: false }])(
    'rejects a preparation delayed until after candidate movement %j', async (change) => {
      const f = fixture();
      const input = admissionInput(f);
      const service = createAuthoritativeReviewService(f.options);
      mocks.currentCandidate.mockResolvedValue({ ...candidate, ...change });
      await expect(service.validateAdmission(input)).rejects.toThrow('Authoritative publishing resolution unavailable');
      expect(publishMints()).toHaveLength(0);
    });

  it('rejects changed policy revision even when the current head and content are unchanged', async () => {
    const f = fixture();
    const service = createAuthoritativeReviewService(f.options);
    mocks.resolvePolicyRevision.mockResolvedValue('f'.repeat(40));
    mocks.immutablePolicyFile.mockResolvedValue({ ...policyFile,
      source: { ...policyFile.source, sha: 'f'.repeat(40) } });
    await expect(service.validateAdmission(admissionInput(f)))
      .rejects.toThrow('Authoritative admission no longer matches current policy');
  });

  it('compares the prepared configuration, not just the claimed policy digest', async () => {
    const f = fixture();
    const input = admissionInput(f);
    input.authoritativeGate!.prepared = { ...f.prepared, expectedPersonaIds: ['different-lane'] };
    const service = createAuthoritativeReviewService(f.options);
    await expect(service.validateAdmission(input))
      .rejects.toThrow('Authoritative admission no longer matches current policy');
  });

  it.each(['paused', 'wrong-app', 'outside-pilot', 'disabled', 'missing-gate'])(
    'rejects %s under the lock before reads', async (variant) => {
      const f = fixture();
      const input = admissionInput(f);
      if (variant === 'paused') f.config.admissionEnabled = false;
      if (variant === 'wrong-app') input.authoritativeGate!.expectedAppId += 1;
      if (variant === 'outside-pilot') input.repositoryId = 999;
      if (variant === 'disabled') input.publicationMode = 'disabled';
      if (variant === 'missing-gate') input.authoritativeGate = undefined;
      const service = createAuthoritativeReviewService(f.options);
      await expect(service.validateAdmission(input))
        .rejects.toThrow('Authoritative admission is outside the active identity');
      expect(mocks.mint).not.toHaveBeenCalled();
      expect(mocks.currentCandidate).not.toHaveBeenCalled();
    });

  it('constructs separate admission and completion capabilities without I/O or scheduling', () => {
    const f = fixture();
    const service = createAuthoritativeReviewService(f.options);
    expect(Object.keys(service).sort()).toEqual(['admission', 'completion', 'resolver', 'runOnce', 'validateAdmission']);
    expect(service.resolver).toBe(service.admission.resolver);
    expect(service.resolver).toBe(completionOptions().publishingResolver);
    expect(service.admission).toEqual({ expectedAppId: APP_ID, acceptNewRequests: true, repositoryIds: [123, 456],
      resolver: completionOptions().publishingResolver });
    expect(service.admission.repositoryIds).not.toBe(f.config.repositoryIds);
    expect(service.completion).toEqual({ verifier: { verify: mocks.verify },
      repository: publisherOptions().repository, resolve: mocks.resolveCompletion });
    expect(service.completion.repository).toBe(f.options.repository);
    expect(publisherOptions().repository).toBe(f.options.repository);
    expect(mocks.publisherConstructor).toHaveBeenCalledExactlyOnceWith({
      repository: service.completion.repository, workerId: f.options.workerId,
      clientFactoryTimeoutMs: 45_000, clientFor: expect.any(Function),
    });
    for (const call of [mocks.mint, mocks.getPrepared, mocks.readerConstructor, mocks.clientConstructor,
      mocks.currentCandidate, mocks.publish, mocks.resolveCompletion, mocks.verify,
      ...Object.values(f.options.repository)]) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(f.options.fetchImplementation).not.toHaveBeenCalled();
  });

  it('keeps completion and publication active while new admissions are paused for draining', async () => {
    const f = fixture();
    f.config.admissionEnabled = false;
    const service = createAuthoritativeReviewService(f.options);
    expect(service.admission).toEqual({ expectedAppId: APP_ID, acceptNewRequests: false,
      repositoryIds: [123, 456], resolver: completionOptions().publishingResolver });
    expect(service.completion).toEqual({ verifier: { verify: mocks.verify },
      repository: publisherOptions().repository, resolve: mocks.resolveCompletion });
    await service.runOnce();
    expect(mocks.reap).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.advance).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith();
    await expect(publisherOptions().clientFor(f.gate)).resolves.toEqual({ client: 'gate' });
    expect(publishMints()).toHaveLength(1);
  });

  it.each([
    ['wrong App', { appId: '4385772' }], ['non-numeric App', { appId: 'not-an-app' }],
    ['empty worker', { workerId: '' }], ['blank worker', { workerId: ' \t ' }],
  ])('rejects %s before creating dependencies', (_label, overrides) => {
    const f = fixture();
    expect(() => createAuthoritativeReviewService({ ...f.options, ...overrides }))
      .toThrow('Authoritative service identity does not match its configuration');
    expect(mocks.resolverConstructor).not.toHaveBeenCalled();
    for (const operation of Object.values(f.options.repository)) expect(operation).not.toHaveBeenCalled();
    expect(mocks.publisherConstructor).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it('uses only configured policy/transport and shares the resolver, not admission options, with completion', async () => {
    vi.stubEnv('BIFROST_BASE_URL', 'https://mutable.example.invalid/v1');
    vi.stubEnv('REVIEW_MODEL', 'mutable-model');
    vi.stubEnv('REVIEW_PERSONAS', 'licensing');
    const before = { ...process.env };
    const f = fixture();
    const service = createAuthoritativeReviewService(f.options);
    expect(resolverOptions()).toEqual({ policyRepository: f.config.policyRepository,
      policyRef: f.config.policyRef, policyPath: f.config.policyPath, transport: f.config.transport,
      candidateReaderFactory: expect.any(Function), policyReaderFactory: expect.any(Function) });
    expect(completionOptions()).toEqual({ getStoredPrepared: f.options.getStoredPrepared,
      readerFactory: resolverOptions().candidateReaderFactory, publishingResolver: service.admission.resolver });
    const signal = new AbortController().signal;
    await expect(completionOptions().getStoredPrepared(f.gate.coordinates.policyDigest, signal))
      .resolves.toBe(f.prepared);
    expect(mocks.getPrepared).toHaveBeenCalledExactlyOnceWith(f.gate.coordinates.policyDigest, signal);
    expect(process.env).toEqual(before);
  });

  it.each(['candidate', 'policy', 'completion'] as const)('mints the %s reader token for precisely its selected repository', async (kind) => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    const selected = kind === 'policy' ? f.config.policyRepository : {
      repositoryId: candidate.repositoryId, owner: candidate.owner, repo: candidate.repo,
    };
    const factory = kind === 'policy' ? resolverOptions().policyReaderFactory
      : kind === 'candidate' ? resolverOptions().candidateReaderFactory : completionOptions().readerFactory;
    const signal = new AbortController().signal;
    await factory(selected, signal);
    expect(mocks.mint).toHaveBeenCalledExactlyOnceWith({ appId: f.options.appId,
      privateKey: f.options.privateKey, baseUrl: f.options.baseUrl, owner: selected.owner, repo: selected.repo },
    'read', { signal, fetchImplementation: f.options.fetchImplementation });
    expect(mocks.readerConstructor).toHaveBeenCalledExactlyOnceWith({ token: 'ghs_fake_scoped_token',
      baseUrl: f.options.baseUrl, fetchImplementation: f.options.fetchImplementation });
    expect(mocks.currentCandidate).not.toHaveBeenCalled();
  });

  it('does not create a reader when the bounded mint rejects', async () => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    mocks.mint.mockRejectedValue(new Error('mint unavailable'));
    await expect(resolverOptions().candidateReaderFactory(f.config.policyRepository, new AbortController().signal))
      .rejects.toThrow('mint unavailable');
    expect(mocks.readerConstructor).not.toHaveBeenCalled();
  });
});

describe('authoritative reconciliation tick', () => {
  it('awaits reaping, advancement and publication in order and shares one pending tick at every stage', async () => {
    const service = createAuthoritativeReviewService(fixture().options);
    const reaped = Promise.withResolvers<number>();
    const advanced = Promise.withResolvers<number>();
    const published = Promise.withResolvers<{ status: 'idle' }>();
    mocks.reap.mockReturnValueOnce(reaped.promise);
    mocks.advance.mockReturnValueOnce(advanced.promise);
    mocks.publish.mockReturnValueOnce(published.promise);
    const first = service.runOnce();
    expect(service.runOnce()).toBe(first);
    expect(mocks.reap).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.advance).not.toHaveBeenCalled();
    reaped.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.runOnce()).toBe(first);
    expect(mocks.advance).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.publish).not.toHaveBeenCalled();
    advanced.resolve(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.runOnce()).toBe(first);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith();
    published.resolve({ status: 'idle' });
    await expect(first).resolves.toBeUndefined();
    const next = service.runOnce();
    expect(next).not.toBe(first);
    await next;
    for (const call of [mocks.reap, mocks.advance, mocks.publish]) expect(call).toHaveBeenCalledTimes(2);
  });

  it.each(['reap', 'advance', 'publish'] as const)('releases the active guard after a rejected %s step', async (step) => {
    const service = createAuthoritativeReviewService(fixture().options);
    const failed = Promise.withResolvers<never>();
    mocks[step].mockReturnValueOnce(failed.promise);
    const first = service.runOnce();
    expect(service.runOnce()).toBe(first);
    const rejection = expect(first).rejects.toThrow('tick failed');
    failed.reject(new Error('tick failed'));
    await rejection;
    if (step === 'reap') expect(mocks.advance).not.toHaveBeenCalled();
    if (step !== 'publish') expect(mocks.publish).not.toHaveBeenCalled();
    const next = service.runOnce();
    expect(next).not.toBe(first);
    await expect(next).resolves.toBeUndefined();
    expect(mocks.reap).toHaveBeenCalledTimes(2);
    expect(mocks[step]).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalled();
  });
});

describe('gate publication identity and fresh success', () => {
  it.each([
    ['different App', { expectedAppId: APP_ID + 1 }],
    ['string App', { expectedAppId: String(APP_ID) }],
    ['unenrolled repository', { repositoryId: 789 }],
    ['string repository', { repositoryId: '123' }],
    ['non-finite repository', { repositoryId: Number.NaN }],
  ])('rejects %s before a read or token mint', async (_label, invalid) => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    if ('repositoryId' in invalid) f.gate.coordinates.repositoryId = invalid.repositoryId as number;
    else f.gate.expectedAppId = invalid.expectedAppId as number;
    await expect(publisherOptions().clientFor(f.gate)).rejects.toThrow('outside the enrolled identity');
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.currentCandidate).not.toHaveBeenCalled();
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });

  it('refreshes the exact current candidate and policy before minting a success publisher for that repository', async () => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    await expect(publisherOptions().clientFor(f.gate)).resolves.toEqual({ client: 'gate' });
    expect(mocks.currentCandidate).toHaveBeenCalledTimes(2);
    for (const args of mocks.currentCandidate.mock.calls) expect(args).toEqual([
      { repositoryId: 123, owner: 'example', repo: 'candidate', prNumber: 42 }, expect.any(AbortSignal),
    ]);
    const signal = mocks.currentCandidate.mock.calls[0][1];
    expect(mocks.currentCandidate.mock.calls[1][1]).toBe(signal);
    expect(mocks.resolvePolicyRevision).toHaveBeenCalledExactlyOnceWith(f.config.policyRepository, f.config.policyRef, signal);
    expect(mocks.immutablePolicyFile).toHaveBeenCalledExactlyOnceWith(f.config.policyRepository,
      policyFile.source.sha, f.config.policyPath, signal);
    expect(mocks.mint.mock.calls.map(([auth, purpose]) => [auth.owner, auth.repo, purpose])).toEqual([
      ['example', 'candidate', 'read'], ['central', 'policies', 'read'], ['example', 'candidate', 'publish'],
    ]);
    expect(publishMints()).toEqual([[{ appId: String(APP_ID), privateKey: f.options.privateKey,
      baseUrl: f.options.baseUrl, owner: 'example', repo: 'candidate' }, 'publish',
    { fetchImplementation: f.options.fetchImplementation }]]);
    expect(mocks.currentCandidate.mock.invocationCallOrder[1]).toBeLessThan(mocks.mint.mock.invocationCallOrder[2]);
    expect(mocks.clientConstructor).toHaveBeenCalledExactlyOnceWith({ token: 'ghs_fake_scoped_token',
      expectedAppId: APP_ID, baseUrl: f.options.baseUrl, fetchImplementation: f.options.fetchImplementation });
  });

  it.each([
    ['head', { headSha: 'c'.repeat(40) }], ['base', { baseSha: 'd'.repeat(40) }],
    ['closed PR', { open: false }], ['repository identity', { repositoryId: 456 }],
  ])('stops success when %s changes during its current-truth refresh', async (_label, changed) => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    mocks.currentCandidate.mockResolvedValueOnce(candidate).mockResolvedValueOnce({ ...candidate, ...changed });
    await expect(publisherOptions().clientFor(f.gate)).rejects.toThrow('Authoritative publishing resolution unavailable');
    expect(mocks.currentCandidate).toHaveBeenCalledTimes(2);
    expect(publishMints()).toEqual([]);
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });

  it('stops success when the immutable policy revision has changed even with the same head/base/config', async () => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    const changedFile = { ...policyFile, source: { ...policyFile.source, sha: 'f'.repeat(40) } };
    const changed = preparePublishingPolicy(changedFile, f.config.transport);
    expect(changed.policy.effectiveConfigDigest).toBe(f.prepared.policy.effectiveConfigDigest);
    expect(changed.policy.effectivePolicyDigest).not.toBe(f.prepared.policy.effectivePolicyDigest);
    mocks.resolvePolicyRevision.mockResolvedValue(changedFile.source.sha);
    mocks.immutablePolicyFile.mockResolvedValue(changedFile);
    await expect(publisherOptions().clientFor(f.gate)).rejects.toThrow('Successful gate no longer matches current policy');
    expect(publishMints()).toEqual([]);
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });

  it('does not mint a publisher when the current-truth read is unavailable', async () => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    mocks.currentCandidate.mockRejectedValue(new Error('private server body'));
    await expect(publisherOptions().clientFor(f.gate)).rejects.toThrow('Authoritative publishing resolution unavailable');
    expect(publishMints()).toEqual([]);
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });

  it.each(['queued', 'in_progress', 'failure', 'cancelled', 'timed_out'] as const)(
    '%s does not require a success refresh, including retirement of superseded terminal checks', async (desiredState) => {
      const f = fixture();
      createAuthoritativeReviewService(f.options);
      Object.assign(f.gate, { desiredState, current: desiredState === 'queued' || desiredState === 'in_progress' });
      mocks.currentCandidate.mockRejectedValue(new Error('old head no longer current'));
      await expect(publisherOptions().clientFor(f.gate)).resolves.toEqual({ client: 'gate' });
      expect(mocks.currentCandidate).not.toHaveBeenCalled();
      expect(mocks.resolvePolicyRevision).not.toHaveBeenCalled();
      expect(mocks.mint).toHaveBeenCalledTimes(1);
      expect(publishMints()).toHaveLength(1);
    });

  it('allows another explicitly enrolled repository and mints a fresh token for its exact name', async () => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    f.gate.desiredState = 'failure';
    await publisherOptions().clientFor(f.gate);
    Object.assign(f.gate.coordinates, { repositoryId: 456, owner: 'other', repo: 'enrolled' });
    await publisherOptions().clientFor(f.gate);
    expect(publishMints().map(([auth]) => [auth.owner, auth.repo])).toEqual([
      ['example', 'candidate'], ['other', 'enrolled'],
    ]);
    expect(mocks.clientConstructor).toHaveBeenCalledTimes(2);
  });

  it('does not construct a publication client when its token mint fails', async () => {
    const f = fixture();
    createAuthoritativeReviewService(f.options);
    f.gate.desiredState = 'failure';
    mocks.mint.mockRejectedValue(new Error('publication token unavailable'));
    await expect(publisherOptions().clientFor(f.gate)).rejects.toThrow('publication token unavailable');
    expect(mocks.clientConstructor).not.toHaveBeenCalled();
  });
});

// Static startup contracts deliberately do not import the executable entrypoint:
// that would listen, schedule background sweeps and initialize a real database.
describe('dispatchIndex authoritative startup source contract', () => {
  const source = readFileSync(new URL('../../src/dispatchIndex.ts', import.meta.url), 'utf8');
  it('validates opt-in configuration before database initialization and conditionally wires separate routes', () => {
    expect(source.indexOf('authoritativeServiceConfigFromEnv(environment, policy)'))
      .toBeLessThan(source.indexOf('new PostgresStore()'));
    expect(source).toMatch(/authoritativeConfig\s*\?\s*createAuthoritativeReviewService\(\{/u);
    expect(source).toMatch(/config:\s*authoritativeConfig,\s*appId,\s*privateKey,\s*baseUrl/u);
    expect(source).toMatch(/authoritative\s*\?\s*\{\s*authoritativePublishing:\s*authoritative\.admission,\s*authoritativeWorkerCompletion:\s*authoritative\.completion\s*\}\s*:\s*\{\}/u);
    expect(source).toMatch(/workerCompletion:\s*\{\s*verifier:\s*createWorkerCompletionVerifier\(\),\s*repository,/u);
  });

  it('schedules only the opt-in service tick and clears its unrefed timer on shutdown with redacted failures', () => {
    expect(source).toMatch(/authoritativeTimer\s*=\s*authoritative\s*&&\s*authoritativeConfig\s*\?\s*setInterval/u);
    expect(source).toMatch(/authoritative\.runOnce\(\)\.catch\(\(\)\s*=>\s*logger\.error\('Authoritative review reconciliation unavailable'\)\)/u);
    expect(source).toMatch(/authoritativeConfig\.tickMs\)\s*:\s*undefined/u);
    expect(source).toContain('authoritativeTimer?.unref()');
    expect(source).toMatch(/if\s*\(authoritativeTimer\)\s*clearInterval\(authoritativeTimer\)/u);
    expect(source).toContain("process.once('SIGTERM'");
    expect(source).toContain("process.once('SIGINT'");
  });
});
