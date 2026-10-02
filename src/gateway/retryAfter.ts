/** Only sanitized metadata is retained; raw headers never become error/log fields. */
export type RetryAfter = Readonly<
  { notBeforeMs: number; format: 'delta_seconds' | 'http_date' } | { exceedsBound: true }
>;
const MAX_COOLDOWN_MS = 86_400_000;
const HTTP_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

const RFC850_DATE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/;
const ASCTIME_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}:\d{2}:\d{2}) (\d{4})$/;

function canonicalTimestamp(value: string): number | undefined {
  if (!HTTP_DATE.test(value)) return undefined;
  // HTTP permits second 60. Interpret it conservatively as the next second of the UTC clock.
  const leapSecond = value.slice(23, 25) === '60';
  const parseValue = leapSecond ? value.slice(0, 23) + '59' + value.slice(25) : value;
  const parsed = Date.parse(parseValue);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toUTCString() !== parseValue) return undefined;
  return parsed + (leapSecond ? 1000 : 0);
}

function httpTimestamp(value: string, observedAtMs: number): number | undefined {
  if (HTTP_DATE.test(value)) return canonicalTimestamp(value);
  const asctime = ASCTIME_DATE.exec(value);
  if (asctime) {
    return canonicalTimestamp(`${asctime[1]}, ${asctime[3].trim().padStart(2, '0')} ${asctime[2]} ${asctime[5]} ${asctime[4]} GMT`);
  }
  const rfc850 = RFC850_DATE.exec(value);
  if (!rfc850) return undefined;
  const fiftyYearsLater = new Date(observedAtMs);
  fiftyYearsLater.setUTCFullYear(fiftyYearsLater.getUTCFullYear() + 50);
  let year = Math.floor(fiftyYearsLater.getUTCFullYear() / 100) * 100 + Number(rfc850[4]);
  const dateValue = (yearValue: number) => `${rfc850[1].slice(0, 3)}, ${rfc850[2]} ${rfc850[3]} ${String(yearValue).padStart(4, '0')} ${rfc850[5]} GMT`;
  // RFC9110: a two-digit year more than 50 years ahead denotes the most recent past century.
  if (Date.parse(dateValue(year)) > fiftyYearsLater.getTime()) year -= 100;
  return canonicalTimestamp(dateValue(year));
}

export function parseRetryAfter(value: string | null | undefined, observedAtMs: number): RetryAfter | undefined {
  if (typeof value !== 'string' || !Number.isSafeInteger(observedAtMs)) return undefined;
  // Excessive numeric cooldowns refuse retries rather than being truncated into an early retry.
  if (value.length > 128) return Object.freeze({ exceedsBound: true });
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const delayMs = Number(normalized) * 1000;
    if (!Number.isSafeInteger(delayMs) || delayMs > MAX_COOLDOWN_MS) return Object.freeze({ exceedsBound: true });
    const notBeforeMs = observedAtMs + delayMs;
    if (!Number.isSafeInteger(notBeforeMs)) return Object.freeze({ exceedsBound: true });
    return Object.freeze({ notBeforeMs, format: 'delta_seconds' });
  }
  // Accept all three HTTP-date formats, but not arbitrary Date.parse coercions/rollovers.
  const timestamp = httpTimestamp(normalized, observedAtMs);
  if (timestamp === undefined) return undefined;
  if (timestamp - observedAtMs > MAX_COOLDOWN_MS) return Object.freeze({ exceedsBound: true });
  return Object.freeze({ notBeforeMs: Math.max(observedAtMs, timestamp), format: 'http_date' });
}

export function retryAfterRemainingMs(metadata: RetryAfter | undefined, nowMs: number): number {
  if (!metadata) return 0;
  if ('exceedsBound' in metadata) return Infinity;
  return Math.max(0, metadata.notBeforeMs - nowMs);
}
