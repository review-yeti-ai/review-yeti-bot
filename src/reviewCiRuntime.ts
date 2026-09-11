import type { Pool } from 'pg';
import { ReviewCiOidcVerifier } from './auth/reviewCiOidc';
import { AuthoritativeReviewReader } from './github/authoritativeReviewReader';
import { getBoundedCiRepositoryToken } from './github/ciAppToken';
import { GitHubReviewCiClient } from './github/reviewCiClient';
import { GitHubReviewGateClient } from './github/reviewGateClient';
import { createReviewCiCheckClient } from './github/reviewCiCheckClient';
import { PostgresReviewCiRepository } from './persistence/reviewCiRepository';
import { PostgresReviewCiCheckRepository } from './persistence/reviewCiCheckRepository';
import { ReviewCiCheckPublisher, type ReviewCiCheckGateFreshness } from './review/reviewCiCheckPublisher';
import type { AuthoritativePublishingResolver } from './review/authoritativePublishingResolver';
import { ReviewCiService, type ReviewCiCurrent } from './review/reviewCiService';
import { findReviewCiEnrollment, type ReviewCiServiceConfig, type StoredReviewCiRequest } from './review/reviewCi';

export interface ReviewCiRuntimeRoutes {
  verifier: Pick<ReviewCiOidcVerifier, 'verify'>;
  service: Pick<ReviewCiService, 'wake' | 'claim'>;
}

export function createReviewCiRuntime(options: {
  config: ReviewCiServiceConfig; pool: Pool; appId: string; privateKey: string;
  baseUrl: string; workerId: string;
  resolver: Pick<AuthoritativePublishingResolver, 'resolve'>;
  fetchImplementation?: typeof fetch;
}): { routes: ReviewCiRuntimeRoutes; service: ReviewCiService; runOnce(): Promise<void> } {
  const { config, pool } = options;
  if (String(config.expectedAppId) !== options.appId || !options.workerId.trim()) {
    throw new Error('Review CI runtime identity mismatch');
  }
  const enrolled = (request: StoredReviewCiRequest) => {
    const repository = findReviewCiEnrollment(config,
      { expectedAppId: request.expectedAppId, repository: request.review });
    if (!repository) throw new Error('Review CI runtime identity mismatch');
    return repository;
  };
  const readToken = (request: StoredReviewCiRequest, signal?: AbortSignal) => {
    const repository = enrolled(request);
    return getBoundedCiRepositoryToken({ appId: options.appId, privateKey: options.privateKey,
      repository: { repositoryId: repository.repositoryId, owner: repository.owner, repo: repository.repo },
      baseUrl: options.baseUrl }, 'read', { fetchImplementation: options.fetchImplementation, signal });
  };
  const readCurrent = async (request: StoredReviewCiRequest, signal?: AbortSignal): Promise<
    { status: 'stale' | 'waiting' } | { status: 'ready'; binding: NonNullable<StoredReviewCiRequest['binding']>; freshness: ReviewCiCheckGateFreshness }
  > => {
    const active = () => { if (signal?.aborted) throw new Error('Review CI freshness read was aborted'); };
    const fetcher: typeof fetch = async (input, init) => {
      active();
      return (options.fetchImplementation ?? globalThis.fetch)(input, { ...init,
        ...(signal ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : {}) });
    };
    active();
    const repository = enrolled(request);
    const { repositoryId, owner, repo, prNumber, headSha, baseSha, policyDigest, attemptId } = request.review;
    const token = (await readToken(request, signal)).token;
    active();
    const reader = new AuthoritativeReviewReader({ token, baseUrl: options.baseUrl, fetchImplementation: fetcher });
    const candidate = await reader.currentCandidate({ repositoryId, owner, repo, prNumber }, signal);
    active();
    if (!candidate.open || candidate.headSha !== headSha || candidate.baseSha !== baseSha) return { status: 'stale' };
    if (candidate.draft) return { status: 'waiting' };
    const policy = await options.resolver.resolve({ repositoryId, owner, repo, prNumber, headSha, baseSha }, signal);
    active();
    if (policy.prepared.policy.effectivePolicyDigest !== policyDigest) return { status: 'stale' };
    if (policy.current.draft) return { status: 'waiting' };
    const gate = (await pool.query(`SELECT check_id,expected_app_id,current_attempt,desired_state,creation_state,
      desired_version,published_version FROM review_gate_attempts WHERE attempt_id=$1`, [attemptId])).rows[0];
    active();
    if (!gate || !gate.current_attempt || gate.desired_state !== 'success'
      || Number(gate.expected_app_id) !== config.expectedAppId) return { status: 'stale' };
    // A publisher outage is retryable; it must not retire an admitted identity.
    if (gate.creation_state !== 'bound' || gate.check_id === null
      || Number(gate.published_version) !== Number(gate.desired_version)) {
      throw new Error('Review CI prerequisite publication is pending');
    }
    const { reviewGeneration: _generation, ...coordinates } = request.review;
    const check = await new GitHubReviewGateClient({ token, expectedAppId: config.expectedAppId,
      baseUrl: options.baseUrl, fetchImplementation: fetcher }).reconcile(coordinates);
    active();
    if (!check || check.id !== Number(gate.check_id) || check.status !== 'completed' || check.conclusion !== 'success') {
      throw new Error('Review CI prerequisite check does not match');
    }
    const ciReader = new GitHubReviewCiClient({ token, expectedAppId: config.expectedAppId,
      repository: { repositoryId, owner, repo }, baseUrl: options.baseUrl, fetchImplementation: fetcher });
    const merge = await ciReader.currentMergeCandidate({ prNumber, headSha, baseSha });
    active();
    return { status: 'ready', binding: { ...repository.validation, candidateSha: merge.candidateSha, lanePlan: repository.lanePlan },
      freshness: { open: true, draft: false, repositoryId, prNumber, baseSha, headSha, policyDigest,
        candidateSha: merge.candidateSha, reviewGate: { id: check.id, name: 'Review Yeti Gate', appId: config.expectedAppId,
          headSha, externalId: check.externalId, status: 'completed', conclusion: 'success' } } };
  };
  const current = async (request: StoredReviewCiRequest): Promise<ReviewCiCurrent> => readCurrent(request);
  const checks = new PostgresReviewCiCheckRepository(pool);
  const repository = new PostgresReviewCiRepository(pool, { lifecycleEvents: 'enabled', admissionTimeoutMs: 15_000,
    onTransition: async (client, request, transition, now) => { await checks.transitionInTransaction(client, request, transition, now); },
    assertPendingPublished: (client, request, now) => checks.assertPendingPublishedInTransaction(client, request, now),
  });
  const service = new ReviewCiService({ config, repository,
    workerId: options.workerId, current,
    clientFor: async (request, purpose) => {
      const repository = enrolled(request);
      const identity = { repositoryId: repository.repositoryId, owner: repository.owner, repo: repository.repo };
      const minted = await getBoundedCiRepositoryToken({ appId: options.appId, privateKey: options.privateKey,
        repository: identity, baseUrl: options.baseUrl }, purpose, { fetchImplementation: options.fetchImplementation });
      return new GitHubReviewCiClient({ token: minted.token, expectedAppId: config.expectedAppId,
        repository: identity, ...(request.binding ? { binding: request.binding } : {}),
        baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation });
    },
  });
  const publisher = new ReviewCiCheckPublisher({ repository: checks, workerId: options.workerId,
    currentSuccess: async (check, signal) => {
      const result = await readCurrent(check.request, signal);
      if (result.status !== 'ready') throw new Error('Review CI successful publication is no longer eligible');
      return result.freshness;
    },
    clientFor: async (check) => {
      const configured = enrolled(check.request);
      const minted = await getBoundedCiRepositoryToken({ appId: options.appId, privateKey: options.privateKey,
        repository: { repositoryId: configured.repositoryId, owner: configured.owner, repo: configured.repo },
        baseUrl: options.baseUrl }, 'check-publication', { fetchImplementation: options.fetchImplementation });
      return createReviewCiCheckClient({ token: minted.token, expectedAppId: config.expectedAppId,
        baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation });
    },
  });
  let active: Promise<void> | undefined;
  // Publishing runs before and after reconciliation. Expensive execution is
  // independently fenced by the committed, externally published pending check.
  const tick = async () => { await publisher.runOnce(); await service.runOnce(); await publisher.runOnce(); };
  return { service, routes: { verifier: new ReviewCiOidcVerifier({ repositories: config.repositories }), service },
    runOnce: () => active ?? (active = tick().finally(() => { active = undefined; })),
  };
}
