import { z } from 'zod';
import { MAX_INCOMPLETE_P2_RECOVERY_PRIOR_ATTEMPTS } from './incompleteP2RecoveryLimits';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

/** Worker receipt that it fetched the service-owned prior P2 context. The
 * schema lives separately so WorkerReviewCompletion can import it without a
 * cycle through the persistence/context loader. */
export const incompleteP2RecoveryClaimSchema = z.object({
  version: z.literal('IncompleteP2RecoveryClaim.v1'),
  contextDigest: digest,
  sources: z.array(z.object({
    executionAttempt: z.number().int().positive().safe(),
    workerResultDigest: digest,
    workerCheckId: z.number().int().positive().safe(),
    gateCheckId: z.number().int().positive().safe(),
  }).strict()).min(1).max(MAX_INCOMPLETE_P2_RECOVERY_PRIOR_ATTEMPTS),
}).strict();

export type IncompleteP2RecoveryClaim = z.infer<typeof incompleteP2RecoveryClaimSchema>;
