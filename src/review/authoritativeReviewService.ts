import { PUBLIC_REVIEW_APP_ID, isPublicReviewRepository, expectedReviewAppIdFor, type ReviewAuthorityRepository } from '../auth/repositoryReviewAuthority';
import type { AuthoritativeServiceConfig } from '../auth/authoritativeServiceConfig';
import { createWorkerCompletionVerifier, type AuthoritativeReviewAdmission,
  type AuthoritativeReviewCompletion } from './authoritativeServiceContracts';
import { AuthoritativeReviewReader, type ReviewRepositoryIdentity } from '../github/authoritativeReviewReader';
import { getBoundedRepositoryToken } from '../github/boundedAppToken';
import { trustedGitDiffSource } from '../github/largeDiffSourceWiring';
import { GitHubReviewGateClient } from '../github/reviewGateClient';
import { GitHubInstallationClient } from '../github/installationClient';
import { AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from './authoritativeCompletionContext';
import { ReviewGatePublisher, type ReviewGatePublisherOptions } from './reviewGatePublisher';
import type { ReviewAdmissionInput } from './reviewRun';
import { sha256 } from './reviewCore';
import { OperatorMaintenancePublisher } from './operatorMaintenancePublisher';
import type { OperatorMaintenanceIdentity, OperatorMaintenancePolicyResolution, OperatorMaintenanceRepository } from './operatorMaintenanceContracts';

export interface AuthoritativeReviewServiceOptions {
  config: AuthoritativeServiceConfig;
  /** Storage is composed by the entrypoint, not selected by the domain service. */
  repository: ReviewGatePublisherOptions['repository'] & AuthoritativeReviewCompletion['repository'] & {
    reapTerminalAttempts(now?: number, limit?: number): Promise<number>;
    advanceProjectedAttempts(now?: number, limit?: number): Promise<number>;
  };
  getStoredPrepared: AuthoritativeCompletionContextOptions['getStoredPrepared'];
  publicAppCredentials?: { appId: string; privateKey: string };
  appId: string;
  privateKey: string;
  baseUrl: string;
  workerId: string;
  /** Transport seam only. No candidate request can supply it. */
  fetchImplementation?: typeof fetch;
  /** ADR 0002: resolves the review App's bot login for finding-thread author verification. */
  findingThreadAuthor?: (repository: ReviewRepositoryIdentity) => Promise<string | undefined>;
  /** Trusted deployment-wide setting; callers never supply this value. */
  passthroughEnabled?: boolean;
  /** Durable storage for the separate no-review maintenance lane. */
  operatorMaintenanceRepository?: OperatorMaintenanceRepository;
  /** Fresh, App-authenticated queue reconstruction for durable group retries. */
  verifyMergeGroupCurrent?(identity: OperatorMaintenanceIdentity,
    policyResolution: OperatorMaintenancePolicyResolution): Promise<void>;
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
  const publicAuthority = config.publicRepository;
  const publicCredentials = options.publicAppCredentials;
  if (publicAuthority && (!isPublicReviewRepository(publicAuthority)
    || publicAuthority.expectedAppId !== PUBLIC_REVIEW_APP_ID
    || publicCredentials?.appId !== String(PUBLIC_REVIEW_APP_ID) || !publicCredentials.privateKey)) {
    throw new Error('Dedicated public review identity is invalid');
  }
  const repositoryIds = [...config.repositoryIds, ...(publicAuthority ? [publicAuthority.repositoryId] : [])];
  const baseAdmission = { expectedAppId: config.expectedAppId, repositoryIds };
  const expectedAppIdFor = (selected: ReviewAuthorityRepository): number =>
    expectedReviewAppIdFor(baseAdmission, selected);
  const authFor = (selected: ReviewRepositoryIdentity, policyRead = false) => {
    if (policyRead && (selected.repositoryId !== config.policyRepository.repositoryId
      || selected.owner !== config.policyRepository.owner || selected.repo !== config.policyRepository.repo)) {
      throw new Error('Policy repository identity differs from configuration');
    }
    const credentials = !policyRead && expectedAppIdFor(selected) === PUBLIC_REVIEW_APP_ID
      ? publicCredentials! : { appId: options.appId, privateKey: options.privateKey };
    return { ...credentials, baseUrl: options.baseUrl, owner: selected.owner, repo: selected.repo };
  };
  // REL-1080: the same git-derived large-diff source the worker uses for a 406.
  const gitDiffSource = trustedGitDiffSource(process.env, options.baseUrl);
  const makeReader = async (repository: ReviewRepositoryIdentity, signal: AbortSignal, policyRead = false) => {
    const minted = await getBoundedRepositoryToken(authFor(repository, policyRead), 'read', {
      signal, fetchImplementation: options.fetchImplementation,
    });
    return new AuthoritativeReviewReader({ token: minted.token, baseUrl: options.baseUrl,
      fetchImplementation: options.fetchImplementation, ...(gitDiffSource ? { gitDiffSource } : {}),
      ...(options.findingThreadAuthor ? { findingThreadAuthor: () => options.findingThreadAuthor!(repository) } : {}) });
  };
  const readerFactory = (repository: ReviewRepositoryIdentity, signal: AbortSignal) => makeReader(repository, signal);
  const policyReaderFactory = (repository: ReviewRepositoryIdentity, signal: AbortSignal) => makeReader(repository, signal, true);
  const resolver = new AuthoritativePublishingResolver({
    policyRepository: config.policyRepository, policyRef: config.policyRef, policyPath: config.policyPath,
    transport: config.transport, candidateReaderFactory: readerFactory, policyReaderFactory,
  });
  if (options.passthroughEnabled === true && !options.operatorMaintenanceRepository) {
    throw new Error('Operator maintenance mode requires durable maintenance storage');
  }
  const maintenance = options.passthroughEnabled === true && options.operatorMaintenanceRepository
    ? new OperatorMaintenancePublisher({
      enabled: true,
      expectedAppIdFor: (identity) => expectedAppIdFor(identity),
      repositoryIds,
      resolver,
      repository: options.operatorMaintenanceRepository,
      ...(options.verifyMergeGroupCurrent ? { verifyMergeGroupCurrent: options.verifyMergeGroupCurrent } : {}),
      clientFor: async (identity, expectedAppId) => {
        if (expectedAppId !== expectedAppIdFor(identity)) {
          throw new Error('Operator maintenance App identity does not match the enrolled repository');
        }
        const minted = await getBoundedRepositoryToken(authFor(identity), 'publish', {
          fetchImplementation: options.fetchImplementation,
        });
        return new GitHubInstallationClient({ token: minted.token, baseUrl: options.baseUrl,
          fetchImplementation: options.fetchImplementation });
      },
    })
    : undefined;
  const resolveCompletion = createAuthoritativeCompletionContext({
    getStoredPrepared: options.getStoredPrepared,
    readerFactory, publishingResolver: resolver,
  });
  const publisher = new ReviewGatePublisher({
    repository, workerId: options.workerId, clientFactoryTimeoutMs: 45_000,
    clientFor: async (gate) => {
      if (!repositoryIds.includes(gate.coordinates.repositoryId) || gate.expectedAppId !== expectedAppIdFor(gate.coordinates)) {
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
    let failure: unknown;
    try { await publisher.runOnce(); } catch (error) { failure = error; }
    // No pending maintenance receipt may depend on an ingress retry. Reconcile
    // its raw and Gate stages from the same bounded authoritative timer even
    // when the ordinary review publisher has an independent transient error.
    try { await maintenance?.runOnce(); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
  };
  return {
    resolver,
    admission: { expectedAppId: config.expectedAppId, acceptNewRequests: config.admissionEnabled,
      repositoryIds, ...(publicAuthority ? { expectedAppIdFor } : {}), resolver,
      ...(maintenance ? { maintenance } : {}) },
    completion: { verifier: createWorkerCompletionVerifier(), repository, resolve: resolveCompletion },
    validateAdmission: async (input) => {
      // The router's preparation can finish out of order across replicas. Only
      // this fresh read under the shared admission lock may authorize retirement
      // of another candidate. Neither request timestamps nor head ordering do.
      if (!repositoryIds.includes(input.repositoryId) || !config.admissionEnabled || input.publicationMode !== 'app-gate'
        || input.authoritativeGate?.expectedAppId !== expectedAppIdFor({ ...input.identity, repositoryId: input.repositoryId })
        || !repositoryIds.includes(input.repositoryId)) {
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
