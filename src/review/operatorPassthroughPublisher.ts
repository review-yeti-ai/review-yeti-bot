import type { GitHubReviewGateClient } from '../github/reviewGateClient';
import {
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
  type ReviewGateCheck,
} from './reviewCheckIdentity';
import {
  operatorPassthroughCheckMetadata,
  type OperatorPassthroughPublicationClaim,
  type OperatorPassthroughPublicationNotStarted,
  type OperatorPassthroughPublicationRepository,
  type OperatorPassthroughReconcilePending,
} from './operatorPassthrough';

type Client = Pick<GitHubReviewGateClient, 'createOperatorPending' | 'reconcileOperator' | 'updateOperatorExisting'>;

export interface OperatorPassthroughPublisherOptions {
  repository: OperatorPassthroughPublicationRepository;
  clientFor(claim: OperatorPassthroughPublicationClaim): Promise<Client>;
  candidateIsCurrent?(claim: OperatorPassthroughPublicationClaim): Promise<boolean>;
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

  async runOnce(publicationId?: string): Promise<{ status: 'idle' | 'published' | 'stale-claim' | 'retry'; publicationId?: string }> {
    const claim = await this.options.repository.claimPublication(this.options.workerId, this.now(), 60_000, publicationId);
    if (!claim) return { status: 'idle' };
    try {
      const result = await this.options.repository.publishLocked(claim, async (current) => {
        if (!current.retiring && this.options.candidateIsCurrent
          && !await this.options.candidateIsCurrent(current)) {
          return { kind: 'retire-required', reason: 'candidate-changed', retryDelayMs: this.retryDelayMs };
        }
        let client: Client;
        try { client = await this.options.clientFor(current); }
        catch {
          return current.mayCreate
            ? { kind: 'not-started', retryDelayMs: this.retryDelayMs } satisfies OperatorPassthroughPublicationNotStarted
            : { kind: 'reconcile-pending', retryDelayMs: this.retryDelayMs } satisfies OperatorPassthroughReconcilePending;
        }

        const coordinates = current.coordinates;
        const knownCheckId = current.stage === 'review' ? current.reviewCheckId : current.gateCheckId;
        let check: ReviewGateCheck | { id: number } | null;
        if (knownCheckId !== null) check = { id: knownCheckId };
        else if (current.mayCreate) {
          // Even a committed first-create reservation does a bounded preflight
          // lookup. Repeated or uncertain attempts are reconcile-only.
          try { check = await client.reconcileOperator(coordinates); }
          catch {
            // This read happened before any create request, so resetting the
            // reservation is safe. Once createOperatorPending is invoked, a
            // failure is ambiguous and must stay on the reconcile-only path.
            return { kind: 'not-started', retryDelayMs: this.retryDelayMs } satisfies OperatorPassthroughPublicationNotStarted;
          }
          if (!check) check = await client.createOperatorPending(coordinates, { status: 'in_progress' });
        } else {
          check = await client.reconcileOperator(coordinates);
        }
        if (!check) return { kind: 'reconcile-pending', retryDelayMs: this.retryDelayMs };

        const metadata = current.retiring ? retirementMetadata(current) : operatorPassthroughCheckMetadata(current, current.stage);
        return client.updateOperatorExisting({
          coordinates,
          checkId: check.id,
          update: {
            conclusion: current.retiring ? 'failure' : 'success',
            ...metadata,
          },
        });
      }, this.now);
      if (result === 'stale-claim') await this.options.repository.retryPublication(claim, this.now(), this.retryDelayMs);
      return { status: result, publicationId: claim.publicationId };
    } catch {
      // Errors from GitHub may contain bearer tokens or response bodies.
      await this.options.repository.retryPublication(claim, this.now(), this.retryDelayMs).catch(() => false);
      return { status: 'retry', publicationId: claim.publicationId };
    }
  }
}
