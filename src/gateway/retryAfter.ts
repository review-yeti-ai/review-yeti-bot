/** Only sanitized metadata is retained; raw headers never become error/log fields. */
export type RetryAfter = Readonly<
  { notBeforeMs: number; format: 'delta_seconds' | 'http_date' } | { exceedsBound: true }
>;
const MAX_COOLDOWN_MS = 86_400_000;
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfter(value: string | null | undefined, observedAtMs: number): RetryAfter | undefined {
  if (typeof value !== 'string' || !Number.isSafeInteger(observedAtMs)) return undefined;
  // Excessive numeric cooldowns refuse retries rather than being truncated into an early retry.
  if (value.length > 128) return /^\d+$/.test(value.slice(0, 128)) ? Object.freeze({ exceedsBound: true }) : undefined;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const delayMs = Number(normalized) * 1000;
    if (!Number.isSafeInteger(delayMs) || delayMs > MAX_COOLDOWN_MS) return Object.freeze({ exceedsBound: true });
    const notBeforeMs = observedAtMs + delayMs;
    if (!Number.isSafeInteger(notBeforeMs)) return Object.freeze({ exceedsBound: true });
    return Object.freeze({ notBeforeMs, format: 'delta_seconds' });
  }
  if (!HTTP_DATE.test(normalized)) return undefined;
  const timestamp = Date.parse(normalized);
  // Require canonical IMF-fixdate, rejecting rollover dates and ambiguous date formats.
  if (!Number.isSafeInteger(timestamp) || new Date(timestamp).toUTCString() !== normalized) return undefined;
  if (timestamp - observedAtMs > MAX_COOLDOWN_MS) return Object.freeze({ exceedsBound: true });
  return Object.freeze({ notBeforeMs: Math.max(observedAtMs, timestamp), format: 'http_date' });
}

export function retryAfterRemainingMs(metadata: RetryAfter | undefined, nowMs: number): number {
  if (!metadata) return 0;
  if ('exceedsBound' in metadata) return Infinity;
  return Math.max(0, metadata.notBeforeMs - nowMs);
}
