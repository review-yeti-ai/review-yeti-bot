import { z } from 'zod';

/** Durable run IDs produced by deriveReviewRunId; shared by gateway boundaries. */
export const reviewEventRunIdSchema = z.string().regex(/^run_[a-f0-9]{32}$/u);
