// This is a trusted worker-policy setting, not an ActionDispatch caller input.
// Omission preserves the worker's existing 20,000-character review threshold.
export function validateLockfileReviewBudget(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
    throw new Error('review_yeti.budget must be an object');
  }
  const value = budget.max_reviewed_lockfile_patch_chars;
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 20_000 || value > 65_536) {
    throw new Error('review_yeti.budget.max_reviewed_lockfile_patch_chars must be a numeric integer between 20000 and 65536');
  }
}
