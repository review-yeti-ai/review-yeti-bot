import { z } from 'zod';

/** Durable run IDs produced by deriveReviewRunId; shared by gateway boundaries. */
export const reviewEventRunIdSchema = z.string().regex(/^run_[a-f0-9]{31}$/u);

/** Preserve existing hexadecimal case; exact identity comparison does not normalize it. */
export const reviewEventGitShaSchema = z.string().regex(/^[a-f0-9]{40}$/iu);
export const reviewEventDigestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);

// Service configuration is a canonical representation of sha256TokenDigest(),
// not a stored review-artifact digest. Preserve its stricter lowercase contract
// without rejecting historical uppercase artifact digests in snapshots.
export const reviewEventTokenDigestSchema = reviewEventDigestSchema.refine(value => value === value.toLowerCase());
