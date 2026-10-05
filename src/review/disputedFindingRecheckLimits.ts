/** Shared bounds for dispute requests and durable checkpoint receipts. */
/** Bounded requests delivered to one exact execution attempt, not a PR/run lifetime quota. */
export const MAX_DISPUTE_RECHECKS_PER_BATCH = 8;
/** @deprecated Use the per-execution batch bound. Kept for wire/test compatibility. */
export const MAX_DISPUTE_RECHECKS_PER_REVIEW = MAX_DISPUTE_RECHECKS_PER_BATCH;
export const MAX_DISPUTE_RECHECK_ARGUMENT_CHARACTERS = 10_000;
export const MAX_DISPUTE_RECHECK_RESPONSE_BYTES = 600_000;
