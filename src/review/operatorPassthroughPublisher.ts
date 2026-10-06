import type { GitHubReviewGateClient } from '../github/reviewGateClient';
import {
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
  type ReviewGateCheck,
} from './reviewCheckIdentity';
import {
  assertOperatorPassthroughOperationActive,
  awaitOperatorPassthroughOperation,
  operatorPassthroughOperationExpired,
  OperatorPassthroughOperationDeadlineExceededError,
  OperatorPassthroughPreflightDeadlineExceededError,
  OperatorPassthroughPreflightResetUnconfirmedError,
  withOperatorPassthroughPreflightBudget,
  operatorPassthroughCheckMetadata,
  type OperatorPassthroughPublicationClaim,
  type OperatorPassthroughPublicationNotStarted,
  type OperatorPassthroughPublicationRepository,
  type OperatorPassthroughRetireRequired,
  type OperatorPassthroughReconcilePending,
  type OperatorPassthroughOperationScope,
} from './operatorPassthrough';

type Client = Pick<GitHubReviewGateClient, 'createOperatorPending' | 'reconcileOperator' | 'updateOperatorExisting'>;

export interface OperatorPassthroughPublisherOptions {
  repository: OperatorPassthroughPublicationRepository;
  clientFor(claim: OperatorPassthroughPublicationClaim, preparationScope?: OperatorPassthroughOperationScope,
    requestScope?: OperatorPassthroughOperationScope): Promise<Client>;
  candidateIsCurrent?(claim: OperatorPassthroughPublicationClaim,
    scope?: OperatorPassthroughOperationScope): Promise<boolean>;
  workerId: string;
  now?: () => number;
  retryDelayMs?: number;
}

function stageName(claim: OperatorPassthroughPublicationClaim): typeof REVIEW_WORKER_CHECK_NAME | typeof REVIEW_GATE_CHECK_NAME {
  return claim.stage === 'review' ? REVIEW_WORKER_CHECK_NAME : REVIEW_GATE_CHECK_NAME;
}

function retirementMetadata(claim: OperatorPassthroughPublicationClaim): { title: string; summary: string } {
  const check = stageName(claim);
  return {
    title: claim.stage === 'review'
      ? 'Review Yeti: NO VERDICT (operator passthrough retired)'
      : 'Review Yeti Gate: Failed (operator passthrough retired)',
    summary: [
      `${check} operator-passthrough exemption was retired because the pause ended or a normal review was admitted.`,
      'A normal review is required. This terminal failure is not a panel verdict and ran zero review lanes.',
      '',
      `Exact candidate: ${claim.coordinates.owner}/${claim.coordinates.repo}#${claim.coordinates.prNumber}`
        + ` at ${claim.coordinates.headSha} (base ${claim.coordinates.baseSha}; policy ${claim.coordinates.policyDigest}).`,
      `Retired exemption digest: ${claim.auditDigest}.`,
    ].join(' '),
  };
}

/** Service-owned terminal publisher for the explicit zero-lane exemption. */
export class OperatorPassthroughPublisher {
  private readonly now: () => number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: OperatorPassthroughPublisherOptions) {
    if (!/^[A-Za-z0-9_.:-]{1,100}$/u.test(options.workerId)) throw new Error('Invalid operator passthrough publisher identity');
    this.now = options.now || Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 1_000 || this.retryDelayMs > 300_000) {
      throw new Error('Invalid operator passthrough retry interval');
    }
  }

  async runOnce(publicationId?: string, scope?: OperatorPassthroughOperationScope): Promise<{
    status: 'idle' | 'published' | 'stale-claim' | 'retry'; publicationId?: string;
    preflightResetUnconfirmed?: true;
  }> {
    let claim: OperatorPassthroughPublicationClaim | null = null;
    try {
      claim = await awaitOperatorPassthroughOperation(
        () => scope
          ? this.options.repository.claimPublication(this.options.workerId, this.now(), 60_000, publicationId, scope)
          : this.options.repository.claimPublication(this.options.workerId, this.now(), 60_000, publicationId), scope);
      if (!claim) return { status: 'idle' };
      const publish = async (current: OperatorPassthroughPublicationClaim): Promise<ReviewGateCheck
        | OperatorPassthroughPublicationNotStarted | OperatorPassthroughReconcilePending | OperatorPassthroughRetireRequired> => {
          const preflight = <T>(operation: (child?: OperatorPassthroughOperationScope) => Promise<T>): Promise<T> =>
            scope ? withOperatorPassthroughPreflightBudget((child) => operation(child), scope) : operation(undefined);
          const timeoutResult = (): OperatorPassthroughPublicationNotStarted | OperatorPassthroughReconcilePending =>
            current.mayCreate
              ? { kind: 'not-started', retryDelayMs: this.retryDelayMs }
              : { kind: 'reconcile-pending', retryDelayMs: this.retryDelayMs };
          const isParentDeadline = (error: unknown): boolean => error instanceof OperatorPassthroughOperationDeadlineExceededError
            || operatorPassthroughOperationExpired(scope);
          const isPreflightDeadline = (error: unknown): boolean => error instanceof OperatorPassthroughPreflightDeadlineExceededError;
          assertOperatorPassthroughOperationActive(scope);
          if (!current.retiring && this.options.candidateIsCurrent) {
            let candidateIsCurrent: boolean;
            try {
              candidateIsCurrent = await preflight((child) => this.options.candidateIsCurrent!(current, child));
            } catch (error) {
              if (isParentDeadline(error)) throw new OperatorPassthroughOperationDeadlineExceededError();
              return timeoutResult();
            }
            if (!candidateIsCurrent) {
              return { kind: 'retire-required', reason: 'candidate-changed', retryDelayMs: this.retryDelayMs };
            }
          }
          assertOperatorPassthroughOperationActive(scope);
          let client: Client;
          try { client = await preflight((child) => this.options.clientFor(current, child, scope)); }
          catch (error) {
            if (isParentDeadline(error)) throw new OperatorPassthroughOperationDeadlineExceededError();
            return timeoutResult();
          }

          const coordinates = current.coordinates;
          const knownCheckId = current.stage === 'review' ? current.reviewCheckId : current.gateCheckId;
          let check: ReviewGateCheck | { id: number } | null;
          if (knownCheckId !== null) check = { id: knownCheckId };
          else if (current.mayCreate) {
            // Before a POST, every delayed lookup is fenced by the same budget.
            try { check = await preflight((child) => client.reconcileOperator(coordinates, child?.signal)); }
            catch (error) {
              if (isParentDeadline(error)) throw new OperatorPassthroughOperationDeadlineExceededError();
              return timeoutResult();
            }
            if (!check) {
              // Once invoked, a timed-out create is ambiguous. The committed
              // `creating` claim remains and the next pass may only reconcile.
              assertOperatorPassthroughOperationActive(scope);
              check = await awaitOperatorPassthroughOperation(
                () => client.createOperatorPending(coordinates, { status: 'in_progress' }), scope);
            }
          } else {
            try { check = await preflight((child) => client.reconcileOperator(coordinates, child?.signal)); }
            catch (error) {
              if (isParentDeadline(error)) throw new OperatorPassthroughOperationDeadlineExceededError();
              if (isPreflightDeadline(error)) return timeoutResult();
              return timeoutResult();
            }
          }
          assertOperatorPassthroughOperationActive(scope);
          if (!check) return { kind: 'reconcile-pending', retryDelayMs: this.retryDelayMs };

          const metadata = current.retiring ? retirementMetadata(current) : operatorPassthroughCheckMetadata(current, current.stage);
          return await awaitOperatorPassthroughOperation(() => client.updateOperatorExisting({
            coordinates,
            checkId: check!.id,
            update: {
              conclusion: current.retiring ? 'failure' : 'success',
              ...metadata,
            },
          }), scope);
        };
      const publishOperation = () => scope
        ? this.options.repository.publishLocked(claim!, publish, this.now, scope)
        : this.options.repository.publishLocked(claim!, publish, this.now);
      const result = await awaitOperatorPassthroughOperation(publishOperation, scope);
      if (result === 'stale-claim') {
        await awaitOperatorPassthroughOperation(
          () => scope
            ? this.options.repository.retryPublication(claim!, this.now(), this.retryDelayMs, scope)
            : this.options.repository.retryPublication(claim!, this.now(), this.retryDelayMs), scope);
      }
      return { status: result, publicationId: claim.publicationId };
    } catch (error) {
      if (error instanceof OperatorPassthroughPreflightResetUnconfirmedError) {
        // Do not run retryPublication: the durable stage may still be creating
        // and must remain reserved for reconciliation only until confirmed.
        return { status: 'retry', ...(claim ? { publicationId: claim.publicationId } : {}),
          preflightResetUnconfirmed: true };
      }
      if (error instanceof OperatorPassthroughOperationDeadlineExceededError
        || operatorPassthroughOperationExpired(scope)) {
        return { status: 'retry', ...(claim ? { publicationId: claim.publicationId } : {}) };
      }
      // Errors from GitHub may contain bearer tokens or response bodies.
      if (claim) {
        await awaitOperatorPassthroughOperation(
          () => scope
            ? this.options.repository.retryPublication(claim!, this.now(), this.retryDelayMs, scope)
            : this.options.repository.retryPublication(claim!, this.now(), this.retryDelayMs), scope).catch(() => false);
      }
      return { status: 'retry', ...(claim ? { publicationId: claim.publicationId } : {}) };
    }
  }
}
