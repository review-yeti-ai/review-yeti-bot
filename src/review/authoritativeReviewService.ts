import type { AuthoritativeServiceConfig } from '../auth/authoritativeServiceConfig';
import { createWorkerCompletionVerifier, type AuthoritativeReviewAdmission,
  type AuthoritativeReviewCompletion } from './authoritativeServiceContracts';
import { AuthoritativeReviewReader, type ReviewRepositoryIdentity } from '../github/authoritativeReviewReader';
import { getBoundedRepositoryToken } from '../github/boundedAppToken';
import { GitHubReviewGateClient } from '../github/reviewGateClient';
import { AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from './authoritativeCompletionContext';
import { ReviewGatePublisher, type ReviewGatePublisherOptions } from './reviewGatePublisher';
import type { ReviewAdmissionInput } from './reviewRun';
import { sha256 } from './reviewCore';

export interface AuthoritativeReviewServiceOptions {
  config: AuthoritativeServiceConfig;
  /** Storage is composed by the entrypoint, not selected by the domain service. */
  repository: ReviewGatePublisherOptions['repository'] & AuthoritativeReviewCompletion['repository'] & {
    reapTerminalAttempts(now?: number, limit?: number): Promise<number>;
    advanceProjectedAttempts(now?: number, limit?: number): Promise<number>;
  };
  getStoredPrepared: AuthoritativeCompletionContextOptions['getStoredPrepared'];
  appId: string;
  privateKey: string;
  baseUrl: string;
  workerId: string;
  /** Transport seam only. No candidate request can supply it. */
  fetchImplementation?: typeof fetch;
}

/** Additive control-plane wiring. Merely constructing this object does not
 * schedule anything, contact GitHub, or change repository protection. */
export function createAuthoritativeReviewService(options: AuthoritativeReviewServiceOptions): {
  admission: AuthoritativeReviewAdmission;
  completion: AuthoritativeReviewCompletion;
  /** Called by persistence while holding its PR admission lock, before writes. */
  validateAdmission(input: ReviewAdmissionInput): Promise<void>;
  runOnce(): Promise<void>;
  resolver: AuthoritativePublishingResolver;
} {
  const { config, repository } = options;
  if (Number(options.appId) !== config.expectedAppId || !options.workerId.trim()) {
    throw new Error('Authoritative service identity does not match its configuration');
  }
  const authFor = (repository: Pick<ReviewRepositoryIdentity, 'owner' | 'repo'>) => ({
    appId: options.appId, privateKey: options.privateKey, baseUrl: options.baseUrl,
    owner: repository.owner, repo: repository.repo,
  });
  const readerFactory = async (repository: ReviewRepositoryIdentity, signal: AbortSignal) => {
    const minted = await getBoundedRepositoryToken(authFor(repository), 'read', {
      signal, fetchImplementation: options.fetchImplementation,
    });
    return new AuthoritativeReviewReader({ token: minted.token, baseUrl: options.baseUrl,
      fetchImplementation: options.fetchImplementation });
  };
  const resolver = new AuthoritativePublishingResolver({
    policyRepository: config.policyRepository, policyRef: config.policyRef, policyPath: config.policyPath,
    transport: config.transport, candidateReaderFactory: readerFactory, policyReaderFactory: readerFactory,
  });
  const resolveCompletion = createAuthoritativeCompletionContext({
    getStoredPrepared: options.getStoredPrepared,
    readerFactory, publishingResolver: resolver,
  });
  const publisher = new ReviewGatePublisher({
    repository, workerId: options.workerId, clientFactoryTimeoutMs: 45_000,
    clientFor: async (gate) => {
      if (gate.expectedAppId !== config.expectedAppId || !config.repositoryIds.includes(gate.coordinates.repositoryId)) {
        throw new Error('Gate publication is outside the enrolled identity');
      }
      // An accepted terminal result can wait durably while GitHub is unavailable.
      // Re-read current head/base/policy before publishing success after recovery.
      // Failures/cancellations may still retire their own persisted old check ID.
      if (gate.desiredState === 'success') {
        const { repositoryId, owner, repo, prNumber, headSha, baseSha, policyDigest } = gate.coordinates;
        const current = await resolver.resolve({ repositoryId, owner, repo, prNumber, headSha, baseSha });
        if (current.prepared.policy.effectivePolicyDigest !== policyDigest) {
          throw new Error('Successful gate no longer matches current policy');
        }
      }
      const minted = await getBoundedRepositoryToken(authFor(gate.coordinates), 'publish', {
        fetchImplementation: options.fetchImplementation,
      });
      return new GitHubReviewGateClient({ token: minted.token, expectedAppId: gate.expectedAppId,
        baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation });
    },
  });
  let active: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    await repository.reapTerminalAttempts();
    await repository.advanceProjectedAttempts();
    await publisher.runOnce();
  };
  return {
    resolver,
    admission: { expectedAppId: config.expectedAppId, acceptNewRequests: config.admissionEnabled,
      repositoryIds: [...config.repositoryIds], resolver },
    completion: { verifier: createWorkerCompletionVerifier(), repository, resolve: resolveCompletion },
    validateAdmission: async (input) => {
      // The router's preparation can finish out of order across replicas. Only
      // this fresh read under the shared admission lock may authorize retirement
      // of another candidate. Neither request timestamps nor head ordering do.
      if (!config.admissionEnabled || input.publicationMode !== 'app-gate'
        || input.authoritativeGate?.expectedAppId !== config.expectedAppId
        || !config.repositoryIds.includes(input.repositoryId)) {
        throw new Error('Authoritative admission is outside the active identity');
      }
      const { owner, repo, prNumber, headSha, baseSha } = input.identity;
      const current = await resolver.resolve({ repositoryId: input.repositoryId,
        owner, repo, prNumber, headSha, baseSha });
      if (sha256(current.identity) !== sha256(input.identity)
        || sha256(current.prepared) !== sha256(input.authoritativeGate.prepared)
        || current.prepared.policy.effectivePolicyDigest !== input.effectivePolicyDigest) {
        throw new Error('Authoritative admission no longer matches current policy');
      }
    },
    // Two intervals in one process cannot start overlapping sweeps. Multiple
    // replicas coordinate through the persisted generation/lease/PR locks.
    runOnce: () => {
      if (!active) active = tick().finally(() => { active = undefined; });
      return active;
    },
  };
}
