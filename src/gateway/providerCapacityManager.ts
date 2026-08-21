import { logger } from '../utils/logger';

/**
 * Checks whether an HTTP status code, error instance, or error message represents
 * an explicit upstream capacity exhaustion or provider rejection (HTTP 429, 503, 529,
 * or error payloads indicating cancelled/rate-limited/overloaded capacity).
 *
 * This allows clean multi-transport failovers without guessing provider concurrency
 * limits or using artificial client-side cutoff timers.
 */
export function isExplicitUpstreamRejection(errorOrStatus: unknown): boolean {
  if (!errorOrStatus) return false;

  if (typeof errorOrStatus === 'number') {
    return errorOrStatus === 429 || errorOrStatus === 503 || errorOrStatus === 529;
  }

  const message = errorOrStatus instanceof Error
    ? errorOrStatus.message
    : typeof errorOrStatus === 'string'
      ? errorOrStatus
      : JSON.stringify(errorOrStatus);

  const lower = message.toLowerCase();
  return (
    lower.includes('429') ||
    lower.includes('503') ||
    lower.includes('529') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('quota') ||
    lower.includes('cancelled') ||
    lower.includes('canceled') ||
    lower.includes('overloaded') ||
    lower.includes('queue full') ||
    lower.includes('queue_full') ||
    lower.includes('capacity') ||
    lower.includes('resource_exhausted')
  );
}

export class UpstreamCapacityRejectionError extends Error {
  readonly providerId: string;
  readonly isRetryableFailover = true;

  constructor(providerId: string, message: string) {
    super(message || `Upstream provider '${providerId}' rejected request due to capacity or rate limits`);
    this.name = 'UpstreamCapacityRejectionError';
    this.providerId = providerId;
  }
}
