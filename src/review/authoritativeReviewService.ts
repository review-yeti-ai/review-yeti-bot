import { PUBLIC_REVIEW_APP_ID, isPublicReviewRepository, expectedReviewAppIdFor, type ReviewAuthorityRepository } from '../auth/repositoryReviewAuthority';
import type { AuthoritativeServiceConfig } from '../auth/authoritativeServiceConfig';
import { createWorkerCompletionVerifier, type AuthoritativeReviewAdmission,
  type AuthoritativeReviewCompletion } from './authoritativeServiceContracts';
import { AuthoritativeReviewReader, type ReviewRepositoryIdentity } from '../github/authoritativeReviewReader';
import { getBoundedRepositoryToken } from '../github/boundedAppToken';
import { trustedGitDiffSource } from '../github/largeDiffSourceWiring';
import { AuthoritativeCandidateChangedError, AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from './authoritativeCompletionContext';
import { ReviewGatePublisher, type ReviewGatePublisherOptions } from './reviewGatePublisher';
import type { ReviewAdmissionInput } from './reviewRun';
import { sha256 } from './reviewCore';
import { canonicalJson } from './reviewCore';
import { GitHubReviewGateClient, REVIEW_GATE_CHECK_NAME, REVIEW_WORKER_CHECK_NAME } from '../github/reviewGateClient';
import { OperatorPassthroughPublisher } from './operatorPassthroughPublisher';
import type { OperatorPassthroughAdmissionRequest, OperatorPassthroughPublicationRepository,
  OperatorPassthroughReconcileAdmission } from './operatorPassthrough';
import { logger } from '../utils/logger';

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
  operatorPassthroughRepository?: OperatorPassthroughPublicationRepository;
  passthroughEnabled?: boolean;
  /** Authenticated durable app-gate admissions used for bounded post-rollout catch-up. */
  listPausedAdmissions?: (limit: number) => Promise<OperatorPassthroughReconcileAdmission[]>;
}

/** Additive control-plane wiring. Merely constructing this object does not
 * schedule anything, contact GitHub, or change repository protection. */
export function createAuthoritativeReviewService(options: AuthoritativeReviewServiceOptions): {
  admission: AuthoritativeReviewAdmission;
  completion: AuthoritativeReviewCompletion;
  operatorPassthroughRepository?: OperatorPassthroughPublicationRepository;
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
  const passthroughEnabled = options.passthroughEnabled === true;
  const operatorRepository = options.operatorPassthroughRepository;
  if (passthroughEnabled && !operatorRepository) {
    throw new Error('Operator passthrough requires its durable check publication repository');
  }
  const operatorPublisher = operatorRepository ? new OperatorPassthroughPublisher({
    repository: operatorRepository,
    workerId: `${options.workerId}:operator-passthrough`,
    candidateIsCurrent: async (claim) => {
      try {
        const current = await resolver.resolve({ repositoryId: claim.coordinates.repositoryId,
          owner: claim.coordinates.owner, repo: claim.coordinates.repo, prNumber: claim.coordinates.prNumber,
          headSha: claim.coordinates.headSha, baseSha: claim.coordinates.baseSha });
        return current.prepared.policy.effectivePolicyDigest === claim.coordinates.policyDigest
          && expectedAppIdFor(claim.coordinates) === claim.expectedAppId;
      } catch (error) {
        if (error instanceof AuthoritativeCandidateChangedError) return false;
        throw error;
      }
    },
    clientFor: async (claim) => {
      const selected = claim.coordinates;
      if (!repositoryIds.includes(selected.repositoryId) || expectedAppIdFor(selected) !== claim.expectedAppId) {
        throw new Error('Operator passthrough publication is outside the enrolled identity');
      }
      const minted = await getBoundedRepositoryToken(authFor(selected), 'publish', {
        fetchImplementation: options.fetchImplementation,
      });
      return new GitHubReviewGateClient({ token: minted.token, expectedAppId: claim.expectedAppId,
        checkName: claim.stage === 'review' ? REVIEW_WORKER_CHECK_NAME : REVIEW_GATE_CHECK_NAME,
        baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation });
    },
  }) : undefined;
  const recordOperatorPassthrough = operatorRepository && passthroughEnabled && operatorPublisher
    ? async (input: OperatorPassthroughAdmissionRequest) => {
      const requested = {
        repositoryId: input.requested.repositoryId,
        owner: input.requested.owner,
        repo: input.requested.repo,
        prNumber: input.requested.prNumber,
        headSha: input.requested.headSha,
        baseSha: input.requested.baseSha,
      };
      if (!repositoryIds.includes(requested.repositoryId)) {
        throw new Error('Operator passthrough candidate is outside authoritative admission');
      }
      const resolved = await resolver.resolve(requested);
      const expectedAppId = expectedAppIdFor(requested);
      const candidate = { ...requested, policyDigest: resolved.prepared.policy.effectivePolicyDigest };
      const recorded = await operatorRepository.record({ candidate, expectedAppId, event: input.event });
      // Event transports get immediate bounded publication. The deterministic
      // service reconciler records first and lets the ordinary durable outbox
      // cadence publish, so a large catch-up batch does not issue unbounded API
      // calls inside one tick.
      if (input.event.transport !== 'service-reconciler') {
        await operatorPublisher.runOnce(recorded.publicationId);
        await operatorPublisher.runOnce(recorded.publicationId);
      }
      const publication = await operatorRepository.getPublication(recorded.publicationId);
      if (!publication) throw new Error('Operator passthrough publication receipt is unavailable');
      const publicationState = publication.retirementRequestedAt !== null
        ? publication.retiredAt !== null ? 'retired' as const : 'retiring' as const
        : publication.readyForShip ? 'published' as const : 'pending' as const;
      return { status: recorded.status, verdict: 'SHIP' as const, expectedLanes: 0 as const, completedLanes: 0 as const,
        publicationId: publication.publicationId, auditDigest: publication.auditDigest, publicationState,
        reviewCheckId: publication.reviewCheckId, gateCheckId: publication.gateCheckId,
        mergeEligible: publication.readyForShip };
    } : undefined;
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
    if (operatorRepository && !passthroughEnabled) await operatorRepository.requestAllRetirements('pause-disabled');
    if (passthroughEnabled && operatorRepository && options.listPausedAdmissions && recordOperatorPassthrough) {
      try {
        const pending = await options.listPausedAdmissions(100);
        for (const admission of pending) {
          if (!repositoryIds.includes(admission.repositoryId)
            || !/^run_[a-f0-9]{32}$/u.test(admission.runId)
            || !/^[a-f0-9]{64}$/u.test(admission.admittedPolicyDigest)
            || expectedAppIdFor(admission) <= 0) continue;
          try {
            const current = await resolver.readCurrentCandidate({ repositoryId: admission.repositoryId,
              owner: admission.owner, repo: admission.repo, prNumber: admission.prNumber });
            if (!current.open || current.draft) continue;
            const requested = { repositoryId: current.repositoryId, owner: current.owner, repo: current.repo,
              prNumber: current.prNumber, headSha: current.headSha, baseSha: current.baseSha };
            const resolved = await resolver.resolve(requested);
            const digest = sha256(canonicalJson({ version: 'OperatorPassthroughExistingAdmission.v1',
              runId: admission.runId, admittedPolicyDigest: admission.admittedPolicyDigest,
              requested, currentPolicyDigest: resolved.prepared.policy.effectivePolicyDigest }));
            await recordOperatorPassthrough({
              requested,
              event: { transport: 'service-reconciler', eventName: 'existing-admission',
                deliveryId: `service-reconcile:${digest}`, deliveryDigest: digest },
            });
          } catch {
            // Exact-current resolver, authorization, and durable-record failures
            // remain unavailable; the bounded loop continues for other heads.
          }
        }
      } catch {
        logger.warn('Operator passthrough existing-admission reconciliation is unavailable');
      }
    }
    await operatorPublisher?.runOnce();
    // The operator check is the terminal branch-protection result while paused.
    // Do not let a pre-pause worker's pending Gate outbox publish a later
    // findings-based check over the service-owned SHIP exemption.
    if (!passthroughEnabled) await publisher.runOnce();
  };
  return {
    resolver,
    admission: { expectedAppId: config.expectedAppId,
      acceptNewRequests: config.admissionEnabled && !passthroughEnabled,
      repositoryIds, ...(publicAuthority ? { expectedAppIdFor } : {}), resolver,
      ...(recordOperatorPassthrough ? { recordOperatorPassthrough } : {}) },
    completion: { verifier: createWorkerCompletionVerifier(), repository, resolve: resolveCompletion },
    ...(operatorRepository ? { operatorPassthroughRepository: operatorRepository } : {}),
    validateAdmission: async (input) => {
      // The router's preparation can finish out of order across replicas. Only
      // this fresh read under the shared admission lock may authorize retirement
      // of another candidate. Neither request timestamps nor head ordering do.
      if (!repositoryIds.includes(input.repositoryId) || !config.admissionEnabled || passthroughEnabled
        || input.publicationMode !== 'app-gate'
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
