/**
 * The rate-limit retry ladder shared by the fan-out engine (`runPersona` in `../panel/panelEngine`)
 * and the composed engine (`callTurn` in `../panel/composedEngine`), so both ride out an upstream
 * "slow down" the same way.
 *
 * A provider 429 (for example "Concurrent limit reached ... 15/15 slots in use") is not an outage:
 * the upstream is healthy and is telling this caller to wait for a slot. The five-attempt transport
 * ladder (5s..60s, 180s window) was built for gateway outages and gave up about a minute after the
 * first rejection, failing whole reviews while several other reviews held the slots. This ladder is
 * bounded by the remaining deadline/budget the caller passes in, not by a small attempt count:
 *
 * - exponential backoff with FULL jitter (base 2s, factor 2, at most 30s per sleep) so lanes from
 *   many workers do not re-ask in one synchronized burst;
 * - floored at the sanitized `Retry-After` of the rejection (`retryAfterFloorMs`), even above the
 *   per-sleep cap -- a server-declared cooldown is never cut short;
 * - a sleep is taken only when it ends before the caller's budget does; otherwise the caller fails
 *   now with the accurate `rate_limit` class instead of turning it into a generic timeout;
 * - `RATE_LIMIT_RETRY_WINDOW_MS` and `RATE_LIMIT_MAX_RETRIES` are safety bounds for callers that
 *   have no deadline at all, not the normal stopping rule.
 */

export const RATE_LIMIT_RETRY_BASE_DELAY_MS = 2_000;
export const RATE_LIMIT_RETRY_FACTOR = 2;
/** Ceiling of the jittered part of any single rate-limit sleep. */
export const RATE_LIMIT_RETRY_MAX_DELAY_MS = 30_000;
/** Total wall-clock a single call may spend riding out rate limiting, from its first 429. */
export const RATE_LIMIT_RETRY_WINDOW_MS = 900_000;
/** Safety bound on retries of one call; the budget normally stops the ladder first. */
export const RATE_LIMIT_MAX_RETRIES = 60;

/** Full-jitter delay for rate-limit retry `retry` (1-based), floored at `retryAfterFloorMs`. */
export function rateLimitRetryDelayMs(retry: number, retryAfterFloorMs = 0, random: () => number = Math.random): number {
  const ceiling = Math.min(
    RATE_LIMIT_RETRY_BASE_DELAY_MS * Math.pow(RATE_LIMIT_RETRY_FACTOR, Math.max(0, retry - 1)),
    RATE_LIMIT_RETRY_MAX_DELAY_MS,
  );
  const unit = Math.min(Math.max(random(), 0), 1);
  const jittered = Math.floor(unit * ceiling);
  const floor = Number.isFinite(retryAfterFloorMs) ? Math.max(0, Math.ceil(retryAfterFloorMs)) : Infinity;
  return Math.max(jittered, floor);
}

export type RateLimitRetryPlan =
  | { retry: true; delayMs: number; retryNumber: number }
  | { retry: false; reason: 'budget' | 'window' | 'max_retries' | 'cooldown_exceeds_bound' };

/**
 * Whether to retry a rate-limited call, and after how long.
 *
 * @param retriesSoFar rate-limit retries this call already took
 * @param firstFailureAtMs when this call first saw a rate limit
 * @param retryAfterFloorMs the rejection's remaining sanitized Retry-After (Infinity when it
 *   declared a cooldown beyond the accepted bound)
 * @param budgetLeftMs the caller's remaining budget (deadline, persona/panel/terminal bounds)
 */
export function planRateLimitRetry(input: {
  retriesSoFar: number;
  firstFailureAtMs: number;
  nowMs: number;
  retryAfterFloorMs: number;
  budgetLeftMs: number;
  random?: () => number;
}): RateLimitRetryPlan {
  if (!Number.isFinite(input.retryAfterFloorMs)) return { retry: false, reason: 'cooldown_exceeds_bound' };
  if (input.retriesSoFar >= RATE_LIMIT_MAX_RETRIES) return { retry: false, reason: 'max_retries' };
  const retryNumber = input.retriesSoFar + 1;
  const delayMs = rateLimitRetryDelayMs(retryNumber, input.retryAfterFloorMs, input.random);
  const windowLeftMs = RATE_LIMIT_RETRY_WINDOW_MS - (input.nowMs - input.firstFailureAtMs);
  if (!(delayMs < windowLeftMs)) return { retry: false, reason: 'window' };
  if (!(delayMs < input.budgetLeftMs)) return { retry: false, reason: 'budget' };
  return { retry: true, delayMs, retryNumber };
}
