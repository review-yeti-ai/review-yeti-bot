import type { ReviewCompletionRepository } from '../persistence/reviewCompletionRepository';
import {
  ReviewCIRequestPayload,
  SCHEMA_VERSION_CI_REQUEST,
  validateReviewCIRequestPayload,
} from '../github/reviewCIRequest';
import { logger } from '../utils/logger';

export interface CIRequestClient {
  emitCIRequest(owner: string, repo: string, payload: ReviewCIRequestPayload): Promise<void>;
}

export type CIRequestClientFactory = (owner: string, repo: string) => Promise<CIRequestClient>;

export interface ReviewCompletionDeliveryEngineOptions {
  repository: Pick<
    ReviewCompletionRepository,
    'claimNext' | 'markDispatched' | 'releaseForRetry' | 'markError'
  > & {
    markTerminal?: (completionId: string, workerId: string, now: number) => Promise<boolean>;
    markCompleted?: (completionId: string, workerId: string, now: number) => Promise<boolean>;
  };
  clientFactory: CIRequestClientFactory;
  workerId: string;
  now?: () => number;
  leaseMs?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxAttempts?: number;
}

export type ReviewCompletionDeliveryOutcome =
  | { status: 'idle' }
  | { status: 'dispatched'; completionId: string; validationRequestId: string }
  | { status: 'terminal'; completionId: string; reason?: string }
  | { status: 'retry'; completionId: string; attempt: number; delayMs: number; error: string }
  | { status: 'error'; completionId: string; reason: 'validation' | 'auth' | 'not_found' | 'max_retries' | 'client_error'; error: string }
  | { status: 'lease-lost'; completionId: string };

function extractStatusCode(error: unknown): number | undefined {
  if (!error) return undefined;
  if (typeof (error as any).status === 'number') return (error as any).status;
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/\bHTTP\s+(\d{3})\b/i) || msg.match(/\bstatus\s*[:=]?\s*(\d{3})\b/i);
  return match ? Number(match[1]) : undefined;
}

export class ReviewCompletionDeliveryEngine {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: ReviewCompletionDeliveryEngineOptions) {
    this.now = options.now || Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;

    if (!options.workerId.trim()) throw new Error('completion delivery worker id is required');
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) throw new Error('completion lease must be positive');
  }

  async runOnce(): Promise<ReviewCompletionDeliveryOutcome> {
    const now = this.now();
    const claim = await this.options.repository.claimNext(this.options.workerId, now, this.leaseMs);
    if (!claim) return { status: 'idle' };

    const verdict = claim.verdict ? claim.verdict.toUpperCase() : undefined;
    const conclusion = claim.conclusion ? claim.conclusion.toLowerCase() : undefined;

    const isNonShip = verdict === 'BLOCK' || verdict === 'FIX_FIRST' || conclusion === 'failure';
    const isApproved = (verdict === 'SHIP' || verdict === 'PASS' || conclusion === 'success') && !isNonShip;

    if (!isApproved) {
      logger.info(`Skipping CI request emission for non-SHIP completion (verdict=${claim.verdict}, conclusion=${claim.conclusion})`, {
        completionId: claim.completionId,
        repository: claim.repository,
      });
      let marked = false;
      if (typeof (this.options.repository as any).markTerminal === 'function') {
        marked = await (this.options.repository as any).markTerminal(claim.completionId, this.options.workerId, now);
      } else if (typeof (this.options.repository as any).markCompleted === 'function') {
        marked = await (this.options.repository as any).markCompleted(claim.completionId, this.options.workerId, now);
      } else if (typeof this.options.repository.markDispatched === 'function') {
        marked = await this.options.repository.markDispatched(claim.completionId, this.options.workerId, now);
      }
      return marked
        ? { status: 'terminal', completionId: claim.completionId, reason: 'non_ship_verdict' }
        : { status: 'lease-lost', completionId: claim.completionId };
    }

    const [owner, repoName] = claim.repository.split('/');
    if (!owner || !repoName) {
      const errorText = `Malformed repository coordinate: ${claim.repository}`;
      const marked = await this.options.repository.markError(claim.completionId, this.options.workerId, now, errorText);
      return marked
        ? { status: 'error', completionId: claim.completionId, reason: 'client_error', error: errorText }
        : { status: 'lease-lost', completionId: claim.completionId };
    }

    const rawPayload: ReviewCIRequestPayload = {
      schema_version: SCHEMA_VERSION_CI_REQUEST,
      repository_id: claim.repositoryId,
      repository: claim.repository,
      pr_number: claim.prNumber,
      base_sha: claim.baseSha,
      head_sha: claim.headSha,
      attempt_id: claim.attemptId,
      policy_digest: claim.policyDigest,
      validation_request_id: claim.validationRequestId,
    };

    const validation = validateReviewCIRequestPayload(rawPayload);
    if (!validation.valid) {
      const errorText = `Invalid payload: ${validation.error}`;
      const marked = await this.options.repository.markError(claim.completionId, this.options.workerId, now, errorText);
      return marked
        ? { status: 'error', completionId: claim.completionId, reason: 'validation', error: validation.error }
        : { status: 'lease-lost', completionId: claim.completionId };
    }

    try {
      const client = await this.options.clientFactory(owner, repoName);
      await client.emitCIRequest(owner, repoName, validation.value);

      const dispatched = await this.options.repository.markDispatched(
        claim.completionId,
        this.options.workerId,
        now,
      );
      return dispatched
        ? { status: 'dispatched', completionId: claim.completionId, validationRequestId: claim.validationRequestId }
        : { status: 'lease-lost', completionId: claim.completionId };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = extractStatusCode(err);

      // Permanent client errors - do not retry
      if (statusCode === 401 || statusCode === 403) {
        const errorText = `Authentication / authorization failure HTTP ${statusCode}: ${message}`;
        logger.error(errorText, { completionId: claim.completionId, repository: claim.repository });
        const marked = await this.options.repository.markError(claim.completionId, this.options.workerId, now, errorText);
        return marked
          ? { status: 'error', completionId: claim.completionId, reason: 'auth', error: message }
          : { status: 'lease-lost', completionId: claim.completionId };
      }

      if (statusCode === 404) {
        const errorText = `Repository or endpoint not found HTTP 404: ${message}`;
        logger.error(errorText, { completionId: claim.completionId, repository: claim.repository });
        const marked = await this.options.repository.markError(claim.completionId, this.options.workerId, now, errorText);
        return marked
          ? { status: 'error', completionId: claim.completionId, reason: 'not_found', error: message }
          : { status: 'lease-lost', completionId: claim.completionId };
      }

      // Transient failures (HTTP 5xx, network drops, timeouts)
      if (claim.attempt < this.maxAttempts) {
        const delayMs = Math.min(
          this.maxRetryDelayMs,
          this.baseRetryDelayMs * Math.pow(2, claim.attempt - 1),
        );
        const released = await this.options.repository.releaseForRetry(
          claim.completionId,
          this.options.workerId,
          now,
          delayMs,
          message,
        );
        return released
          ? { status: 'retry', completionId: claim.completionId, attempt: claim.attempt, delayMs, error: message }
          : { status: 'lease-lost', completionId: claim.completionId };
      } else {
        const errorText = `Max retry attempts (${this.maxAttempts}) exceeded: ${message}`;
        logger.error(errorText, { completionId: claim.completionId, repository: claim.repository });
        const marked = await this.options.repository.markError(claim.completionId, this.options.workerId, now, errorText);
        return marked
          ? { status: 'error', completionId: claim.completionId, reason: 'max_retries', error: message }
          : { status: 'lease-lost', completionId: claim.completionId };
      }
    }
  }
}
