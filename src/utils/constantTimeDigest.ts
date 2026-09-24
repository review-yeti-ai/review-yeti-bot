import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of two SHA-256 hex digests, for worker bearer
 * authorization. One shared copy for every endpoint that authorizes a worker by
 * its token digest (the completion status read and the REL-1084 incremental-base
 * read), so hardening one hardens all. Anything that is not a 64-character
 * lowercase hex digest on either side is unequal.
 */
export function constantTimeDigestEqual(expected: unknown, actual: string): boolean {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected) || !/^[a-f0-9]{64}$/u.test(actual)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}
