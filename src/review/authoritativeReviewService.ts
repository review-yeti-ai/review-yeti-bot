import { PUBLIC_REVIEW_APP_ID, isPublicReviewRepository, expectedReviewAppIdFor,
  matchesConfiguredReviewRepositoryIdentity, type ReviewAuthorityRepository } from '../auth/repositoryReviewAuthority';
import type { AuthoritativeServiceConfig } from '../auth/authoritativeServiceConfig';
import { createWorkerCompletionVerifier, type AuthoritativeReviewAdmission,
  type AuthoritativeReviewCompletion } from './authoritativeServiceContracts';
import { AuthoritativeReviewReader, type ReviewRepositoryIdentity } from '../github/authoritativeReviewReader';
import { getBoundedRepositoryToken } from '../github/boundedAppToken';
import { trustedGitDiffSource } from '../github/largeDiffSourceWiring';
import { AuthoritativeCandidateChangedError, AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import { isPausedAuthorityReadUnavailable } from '../github/authoritativeReadFailure';
import { createAuthoritativeCompletionContext, type AuthoritativeCompletionContextOptions } from './authoritativeCompletionContext';
import { ReviewGatePublisher, type ReviewGatePublisherOptions } from './reviewGatePublisher';
import type { ReviewAdmissionInput } from './reviewRun';
import { sha256 } from './reviewCore';
import { canonicalJson } from './reviewCore';
import { GitHubReviewGateClient, REVIEW_GATE_CHECK_NAME, REVIEW_WORKER_CHECK_NAME } from '../github/reviewGateClient';
import { OperatorPassthroughPublisher } from './operatorPassthroughPublisher';
import { operatorPassthroughIdentity, OperatorPassthroughDeliveryIdentityConflictError,
  OperatorPassthroughOperationDeadlineExceededError, OperatorPassthroughPersistenceUnavailableError,
  awaitOperatorPassthroughOperation, validateOperatorPassthroughEvent, withOperatorPassthroughReceiptBudget,
  type OperatorPassthroughAdmissionReceipt, type OperatorPassthroughAdmissionRequest,
  type OperatorPassthroughUnavailableRequest,
  type OperatorPassthroughPublicationRepository, type OperatorPassthroughPublicationSnapshot,
  type OperatorPassthroughOperationScope,
  type OperatorPassthroughRecordResult, type OperatorPassthroughReconcileAdmission,
  type OperatorPassthroughReconcileCursor } from './operatorPassthrough';
import { logger } from '../utils/logger';

const OPERATOR_PASSTHROUGH_CATCH_UP_BATCH_SIZE = 10;

function unavailableOperatorPassthroughReceipt(publicationId: string | null, auditDigest: string | null,
  publicationReceiptAvailable: boolean | null,
  status: OperatorPassthroughAdmissionReceipt['status'] = 'accepted',
  candidateState: OperatorPassthroughAdmissionReceipt['candidateState'] = 'current'): OperatorPassthroughAdmissionReceipt {
  return {
    status, candidateState, verdict: 'SHIP', expectedLanes: 0, completedLanes: 0,
    publicationId, auditDigest, publicationState: 'unavailable', publicationReceiptAvailable,
    reviewCheckId: null, gateCheckId: null, mergeEligible: false,
    message: publicationReceiptAvailable === true
      ? `Operator pause authorizes SHIP with zero review lanes; the durable receipt is available for check-publication retry, but publication status is unavailable. Protected merge eligibility is false.`
      : `Operator pause authorizes SHIP with zero review lanes; official check publication is unavailable and durable publication retry could not be confirmed. Protected merge eligibility is false.`,
  };
}

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
  listPausedAdmissions?: (limit: number, after?: OperatorPassthroughReconcileCursor) => Promise<OperatorPassthroughReconcileAdmission[]>;
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
    || !publicCredentials || publicCredentials.appId !== String(PUBLIC_REVIEW_APP_ID)
    || (!publicCredentials.privateKey && options.passthroughEnabled !== true))) {
    throw new Error('Dedicated public review identity is invalid');
  }
  const repositoryIds = [...config.repositoryIds, ...(publicAuthority ? [publicAuthority.repositoryId] : [])];
  const baseAdmission = { expectedAppId: config.expectedAppId, repositoryIds,
    ...(config.repositoryIdentities ? { repositoryIdentities: config.repositoryIdentities } : {}) };
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
    candidateIsCurrent: async (claim, scope?: OperatorPassthroughOperationScope) => {
      try {
        const current = await resolver.resolve({ repositoryId: claim.coordinates.repositoryId,
          owner: claim.coordinates.owner, repo: claim.coordinates.repo, prNumber: claim.coordinates.prNumber,
          headSha: claim.coordinates.headSha, baseSha: claim.coordinates.baseSha }, scope?.signal);
        return current.prepared.policy.effectivePolicyDigest === claim.coordinates.policyDigest
          && expectedAppIdFor(claim.coordinates) === claim.expectedAppId;
      } catch (error) {
        if (error instanceof AuthoritativeCandidateChangedError) return false;
        throw error;
      }
    },
    clientFor: async (claim, preparationScope?: OperatorPassthroughOperationScope,
      requestScope?: OperatorPassthroughOperationScope) => {
      const selected = claim.coordinates;
      if (!repositoryIds.includes(selected.repositoryId) || expectedAppIdFor(selected) !== claim.expectedAppId) {
        throw new Error('Operator passthrough publication is outside the enrolled identity');
      }
      const minted = await getBoundedRepositoryToken(authFor(selected), 'publish', {
        ...(preparationScope ? { signal: preparationScope.signal } : {}),
        fetchImplementation: options.fetchImplementation,
      });
      return new GitHubReviewGateClient({ token: minted.token, expectedAppId: claim.expectedAppId,
        checkName: claim.stage === 'review' ? REVIEW_WORKER_CHECK_NAME : REVIEW_GATE_CHECK_NAME,
        baseUrl: options.baseUrl, fetchImplementation: options.fetchImplementation,
        ...(requestScope ? { signal: requestScope.signal } : {}) });
    },
  }) : undefined;
  const reportOperatorPassthroughUnavailable = operatorRepository && passthroughEnabled
    ? async (input: OperatorPassthroughUnavailableRequest): Promise<OperatorPassthroughAdmissionReceipt> => {
      const identity = { repositoryId: input.repositoryId, owner: input.owner, repo: input.repo };
      if (!repositoryIds.includes(input.repositoryId) || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0
        || !/^[A-Za-z0-9_.-]{1,100}$/u.test(input.owner) || !/^[A-Za-z0-9_.-]{1,100}$/u.test(input.repo)
        || !matchesConfiguredReviewRepositoryIdentity(baseAdmission, identity)) {
        throw new Error('Operator passthrough source identity is outside authoritative admission');
      }
      expectedAppIdFor(identity);
      validateOperatorPassthroughEvent(input.event);
      try {
        await withOperatorPassthroughReceiptBudget((scope) =>
          operatorRepository.assertDeliveryIdentity(input.event, scope));
      }
      catch (error) {
        if (error instanceof OperatorPassthroughDeliveryIdentityConflictError) throw error;
        if (!(error instanceof OperatorPassthroughPersistenceUnavailableError
          || error instanceof OperatorPassthroughOperationDeadlineExceededError)) throw error;
      }
      return unavailableOperatorPassthroughReceipt(null, null, null, 'unavailable', 'unavailable');
    } : undefined;
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
      if (!matchesConfiguredReviewRepositoryIdentity(baseAdmission, requested)) {
        throw new Error('Operator passthrough candidate is outside authoritative admission');
      }
      validateOperatorPassthroughEvent(input.event);
      const expectedAppId = expectedAppIdFor(requested);
      let resolved;
      try { resolved = await resolver.resolve(requested); }
      catch (error) {
        if (error instanceof AuthoritativeCandidateChangedError) throw error;
        if (!isPausedAuthorityReadUnavailable(error)) throw error;
        try {
          await withOperatorPassthroughReceiptBudget((scope) =>
            operatorRepository.assertDeliveryIdentity(input.event, scope));
        }
        catch (identityError) {
          if (identityError instanceof OperatorPassthroughDeliveryIdentityConflictError) throw identityError;
          if (!(identityError instanceof OperatorPassthroughPersistenceUnavailableError
            || identityError instanceof OperatorPassthroughOperationDeadlineExceededError)) throw identityError;
        }
        return unavailableOperatorPassthroughReceipt(null, null, null, 'unavailable', 'unavailable');
      }
      const candidate = { ...requested, policyDigest: resolved.prepared.policy.effectivePolicyDigest };
      const recordInput = { candidate, expectedAppId, event: input.event };
      // Keep caller/event and exact candidate validation outside the persistence
      // fallback. Only a storage failure after these checks is eligible for a
      // bounded same-delivery retry or an unavailable logical-SHIP response.
      operatorPassthroughIdentity(recordInput);
      let recorded: OperatorPassthroughRecordResult | undefined;
      try {
        return await withOperatorPassthroughReceiptBudget(async (scope) => {
          try {
            recorded = await awaitOperatorPassthroughOperation(
              () => operatorRepository.record(recordInput, undefined, scope), scope);
          } catch (error) {
            if (error instanceof OperatorPassthroughDeliveryIdentityConflictError
              || error instanceof OperatorPassthroughOperationDeadlineExceededError) throw error;
            let current;
            try {
              current = await awaitOperatorPassthroughOperation(
                () => resolver.resolve(requested, scope.signal), scope);
            } catch (resolveError) {
              if (resolveError instanceof AuthoritativeCandidateChangedError
                || resolveError instanceof OperatorPassthroughOperationDeadlineExceededError) throw resolveError;
              // The initial exact-current resolution already authorized this
              // logical pause response. A later read failure cannot make a
              // timed-out admission eligible for a same-delivery retry.
              return unavailableOperatorPassthroughReceipt(null, null, null);
            }
            if (current.prepared.policy.effectivePolicyDigest !== candidate.policyDigest) {
              throw new AuthoritativeCandidateChangedError();
            }
            try {
              // Reuse the exact delivery identity only while the original
              // receipt budget remains active. An ambiguous late COMMIT is
              // reconciled by the durable outbox, never by a second call here.
              recorded = await awaitOperatorPassthroughOperation(
                () => operatorRepository.record(recordInput, undefined, scope), scope);
            } catch (retryError) {
              if (retryError instanceof OperatorPassthroughDeliveryIdentityConflictError
                || retryError instanceof OperatorPassthroughOperationDeadlineExceededError) throw retryError;
              return unavailableOperatorPassthroughReceipt(null, null, null);
            }
          }
          // Event transports get immediate bounded publication. The same
          // deadline fences late completion before a second pass or receipt read.
          if (input.event.transport !== 'service-reconciler') {
            const firstPublication = await awaitOperatorPassthroughOperation(
              () => operatorPublisher.runOnce(recorded!.publicationId, scope), scope);
            if (firstPublication.preflightResetUnconfirmed) {
              return unavailableOperatorPassthroughReceipt(recorded!.publicationId,
                recorded!.auditDigest, true, recorded!.status);
            }
            const secondPublication = await awaitOperatorPassthroughOperation(
              () => operatorPublisher.runOnce(recorded!.publicationId, scope), scope);
            if (secondPublication.preflightResetUnconfirmed) {
              return unavailableOperatorPassthroughReceipt(recorded!.publicationId,
                recorded!.auditDigest, true, recorded!.status);
            }
          }
          let publication: OperatorPassthroughPublicationSnapshot | null;
          try {
            publication = await awaitOperatorPassthroughOperation(
              () => operatorRepository.getPublication(recorded!.publicationId, scope), scope);
          } catch (error) {
            if (error instanceof OperatorPassthroughOperationDeadlineExceededError) throw error;
            return unavailableOperatorPassthroughReceipt(recorded!.publicationId,
              recorded!.auditDigest, true, recorded!.status);
          }
          if (!publication) return unavailableOperatorPassthroughReceipt(recorded!.publicationId,
            recorded!.auditDigest, true, recorded!.status);
          if (publication.retirementReason === 'candidate-changed') throw new AuthoritativeCandidateChangedError();
          const publicationState = publication.retirementRequestedAt !== null
            ? publication.retiredAt !== null ? 'retired' as const : 'retiring' as const
            : publication.readyForShip ? 'published' as const : 'pending' as const;
          return { status: recorded!.status, verdict: 'SHIP' as const, expectedLanes: 0 as const, completedLanes: 0 as const,
            candidateState: 'current' as const,
            publicationId: publication.publicationId, auditDigest: publication.auditDigest, publicationState,
            publicationReceiptAvailable: true,
            reviewCheckId: publication.reviewCheckId, gateCheckId: publication.gateCheckId,
            mergeEligible: publication.readyForShip,
            message: publication.readyForShip
              ? 'Operator pause authorizes SHIP with zero review lanes; both official checks are durably published.'
              : 'Operator pause authorizes SHIP with zero review lanes; official check publication is pending and protected merge is not eligible.' };
        });
      } catch (error) {
        if (!(error instanceof OperatorPassthroughOperationDeadlineExceededError)) throw error;
        return recorded
          ? unavailableOperatorPassthroughReceipt(recorded.publicationId, recorded.auditDigest, true, recorded.status)
          : unavailableOperatorPassthroughReceipt(null, null, null);
      }
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
  let pausedAdmissionCursor: OperatorPassthroughReconcileCursor | undefined;
  const tick = async (): Promise<void> => {
    await repository.reapTerminalAttempts();
    await repository.advanceProjectedAttempts();
    if (operatorRepository && !passthroughEnabled) await operatorRepository.requestAllRetirements('pause-disabled');
    if (passthroughEnabled && operatorRepository && options.listPausedAdmissions && recordOperatorPassthrough) {
      try {
        const pending = await options.listPausedAdmissions(OPERATOR_PASSTHROUGH_CATCH_UP_BATCH_SIZE, pausedAdmissionCursor);
        if (pending.length > 0) {
          const last = pending[pending.length - 1];
          pausedAdmissionCursor = { repositoryId: last.repositoryId, prNumber: last.prNumber };
        } else {
          // Wrap on the following tick. A malformed, closed, draft, or transiently
          // unavailable early row cannot permanently starve later PRs in the keyset.
          pausedAdmissionCursor = undefined;
        }
        for (const admission of pending) {
          if (!repositoryIds.includes(admission.repositoryId)
            || !/^run_[a-f0-9]{32}$/u.test(admission.runId)
            || !/^[a-f0-9]{64}$/u.test(admission.admittedPolicyDigest)
            || expectedAppIdFor(admission) <= 0) continue;
          try {
            // Refresh the admitted row to the current open, non-draft PR head
            // before resolving policy; the stored run head is only a catch-up
            // locator and may be stale.
            const current = await resolver.readCurrentCandidate({ repositoryId: admission.repositoryId,
              owner: admission.owner, repo: admission.repo, prNumber: admission.prNumber });
            if (!current.open || current.draft) continue;
            const requested = { repositoryId: current.repositoryId, owner: current.owner, repo: current.repo,
              prNumber: current.prNumber, headSha: current.headSha, baseSha: current.baseSha };
            const resolved = await resolver.resolve(requested);
            const digest = sha256(canonicalJson({ version: 'OperatorPassthroughExistingAdmission.v1',
              runId: admission.runId, admittedPolicyDigest: admission.admittedPolicyDigest,
              requested, currentPolicyDigest: resolved.prepared.policy.effectivePolicyDigest }));
            // recordOperatorPassthrough repeats exact-current resolution at
            // the durable admission boundary; the check here is not persisted
            // as evidence and cannot authorize publication by itself.
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
      repositoryIds, ...(config.repositoryIdentities ? { repositoryIdentities: config.repositoryIdentities } : {}),
      ...(publicAuthority ? { expectedAppIdFor } : {}), resolver,
      ...(reportOperatorPassthroughUnavailable ? { reportOperatorPassthroughUnavailable } : {}),
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
