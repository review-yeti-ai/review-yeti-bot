/**
 * REL-1133: how many of one run's lanes may call the model at the same time.
 */
/** Largest lane roster any live config runs today (review-yeti-bot: 7), rounded up. */
export const DEFAULT_MAX_CONCURRENT_LANES = 8;
export const MAX_CONCURRENT_LANES_CEILING = 16;
export const MAX_CONCURRENT_LANES_ENV = 'REVIEW_YETI_MAX_CONCURRENT_LANES';

/**
 * Per-process lane concurrency cap. Each worker pod runs one review, so this cap only decides
 * whether a run's own lanes run side by side or queue behind each other. It does not change
 * org-wide provider concurrency.
 *
 * The old cap of 4 made every 5+ lane run (review-yeti-bot, some ct-meta runs) wait a whole
 * extra lane duration. An operator override is honoured when it is a whole number from 1 to
 * `MAX_CONCURRENT_LANES_CEILING`. Anything else falls back to the default, never to an
 * unbounded value.
 */
export function resolveMaxConcurrentLanes(env: Record<string, string | undefined> = process.env): number {
  const raw = env[MAX_CONCURRENT_LANES_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_LANES;
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_MAX_CONCURRENT_LANES;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) return DEFAULT_MAX_CONCURRENT_LANES;
  return Math.min(value, MAX_CONCURRENT_LANES_CEILING);
}
