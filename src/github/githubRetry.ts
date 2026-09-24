import { logger } from '../utils/logger';

/**
 * REL-1103: one bounded retry policy for transient GitHub responses, shared by
 * every GitHub transport in this service and the review worker.
 *
 * A PRReviewJob failed on `GitHub API 503 .../check-runs` ("No server is
 * currently available to service your request") and, since nothing retried,
 * the review stayed failed until a human re-triggered it. This module decides
 * which responses are worth another attempt, how long to wait, and whether the
 * operation is safe to repeat at all:
 *
 * - 502/503/504 are transient server failures.
 * - 429, and 403 that carries `retry-after` or `x-ratelimit-remaining: 0`, are
 *   (secondary) rate limits. GitHub rejects those before processing, so the
 *   request had no effect. A bare 403 is a permission failure and is final.
 * - Everything else, including 4xx such as 404/422, is final.
 *
 * Idempotent methods (GET/HEAD/PUT/PATCH/DELETE/OPTIONS) retry every transient
 * outcome. A POST can succeed server-side behind a 5xx, so it retries a 5xx
 * only through `reconcile`: an exact-identity read that returns the object the
 * lost attempt created (then no second write is sent) or `undefined` when it
 * proves nothing landed. A POST without `reconcile` is never retried on 5xx.
 *
 * Waits use full jitter (`random * min(cap, base * 2^n)`), are raised to any
 * `Retry-After`/`x-ratelimit-reset` GitHub sent, and are never allowed to run
 * past the caller's deadline: when the next wait would not leave room for one
 * more attempt, the last outcome is returned (or thrown) unchanged.
 *
 * Retries are logged with operation, status, attempt and delay only. Response
 * bodies can carry private repository content and are never logged.
 */

export interface GitHubRetryOptions {
  /** Total attempts including the first. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Longest server-directed wait (Retry-After / reset) worth honoring. */
  maxServerWaitMs?: number;
  /** Absolute epoch-ms deadline; no wait may extend past it. */
  deadlineAtMs?: number;
  /** Time reserved after a wait for the retried attempt itself. */
  attemptReserveMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
}

export const DEFAULT_GITHUB_RETRY = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxServerWaitMs: 60_000,
  attemptReserveMs: 5_000,
} as const;

type HeaderSource = Headers | Record<string, unknown> | undefined | null;

export type GitHubTransientKind = 'server_error' | 'rate_limit';

export interface GitHubTransientStatus {
  kind: GitHubTransientKind;
  status: number;
  /** Server-directed minimum wait, when GitHub sent one. */
  serverWaitMs?: number;
}

function header(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(name);
    return value === null ? undefined : value;
  }
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return value === undefined || value === null ? undefined : String(value);
}

function serverWaitMs(headers: HeaderSource, now: number): number | undefined {
  const retryAfter = header(headers, 'retry-after')?.trim();
  if (retryAfter) {
    if (/^\d+$/u.test(retryAfter)) return Number(retryAfter) * 1_000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  if (header(headers, 'x-ratelimit-remaining')?.trim() === '0') {
    const reset = header(headers, 'x-ratelimit-reset')?.trim();
    if (reset && /^\d+$/u.test(reset)) return Math.max(0, Number(reset) * 1_000 - now);
  }
  return undefined;
}

/** Classifies one GitHub HTTP outcome; `undefined` means final (not transient). */
export function classifyGitHubTransient(
  status: number,
  headers: HeaderSource,
  now: number = Date.now(),
): GitHubTransientStatus | undefined {
  if (status === 502 || status === 503 || status === 504) {
    const wait = serverWaitMs(headers, now);
    return { kind: 'server_error', status, ...(wait === undefined ? {} : { serverWaitMs: wait }) };
  }
  if (status === 429 || (status === 403 && (header(headers, 'retry-after') !== undefined
    || header(headers, 'x-ratelimit-remaining')?.trim() === '0'))) {
    const wait = serverWaitMs(headers, now);
    return { kind: 'rate_limit', status, ...(wait === undefined ? {} : { serverWaitMs: wait }) };
  }
  return undefined;
}

export function isIdempotentGitHubMethod(method: string | undefined): boolean {
  return ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
}

/** Full-jitter backoff for retry number `retry` (1-based), raised to any server-directed wait. */
export function computeGitHubRetryDelay(
  retry: number,
  options: { baseDelayMs: number; maxDelayMs: number; random: () => number },
  serverWait?: number,
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** Math.max(0, retry - 1));
  const jittered = Math.floor(Math.min(Math.max(options.random(), 0), 1) * ceiling);
  return serverWait === undefined ? jittered : Math.max(serverWait, jittered);
}

/** Epoch-ms deadline of a review worker, from the operator's REVIEW_TERMINAL_DEADLINE (RFC 3339). */
export function githubRetryDeadlineFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = String(env.REVIEW_TERMINAL_DEADLINE ?? '').trim();
  if (!raw) return undefined;
  const at = Date.parse(raw);
  // The operator deletes the worker Job 60 s before the terminal deadline.
  return Number.isFinite(at) ? at - 60_000 : undefined;
}

/** An HTTP outcome an attempt produced: a returned Response or a thrown error carrying a status. */
interface AttemptOutcome {
  status: number;
  headers: HeaderSource;
}

function outcomeOfResponse(value: unknown): AttemptOutcome | undefined {
  if (value && typeof value === 'object' && typeof (value as Response).status === 'number'
    && typeof (value as Response).headers === 'object') {
    return { status: (value as Response).status, headers: (value as Response).headers };
  }
  return undefined;
}

function outcomeOfError(error: unknown): AttemptOutcome | undefined {
  const candidate = error as { status?: unknown; response?: { headers?: HeaderSource }; headers?: HeaderSource } | null;
  const status = Number(candidate?.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  return { status, headers: candidate?.response?.headers ?? candidate?.headers };
}

function discard(value: unknown): void {
  const body = (value as Response | undefined)?.body;
  try { void body?.cancel().catch(() => undefined); } catch { /* best effort */ }
}

function operationLabel(operation: string): string {
  // Operation labels are "METHOD /path"; drop query strings (they can carry refs).
  return operation.replace(/\?.*$/u, '');
}

export interface GitHubRetryCall<T> {
  /** "METHOD /path" for logs. Never include request or response bodies. */
  operation: string;
  method?: string;
  /** Runs one attempt. Return a Response (or any value) or throw an error that may carry `status`. */
  attempt: (attemptNumber: number) => Promise<T>;
  /**
   * Required before a non-idempotent method retries a 5xx. Resolves to the
   * value the lost attempt created (returned instead of writing again), or
   * `undefined` when an exact-identity read proves nothing landed.
   */
  reconcile?: () => Promise<T | undefined>;
  /** Also retry errors that carry no HTTP status (network failures). Idempotent methods only. */
  retryNetworkErrors?: boolean;
}

export async function withGitHubRetry<T>(call: GitHubRetryCall<T>, options: GitHubRetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_GITHUB_RETRY.maxAttempts));
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_GITHUB_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_GITHUB_RETRY.maxDelayMs;
  const maxServerWaitMs = options.maxServerWaitMs ?? DEFAULT_GITHUB_RETRY.maxServerWaitMs;
  const attemptReserveMs = options.attemptReserveMs ?? DEFAULT_GITHUB_RETRY.attemptReserveMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const idempotent = isIdempotentGitHubMethod(call.method);
  const operation = operationLabel(call.operation);

  for (let attempt = 1; ; attempt += 1) {
    let value: T | undefined;
    let error: unknown;
    let threw = false;
    try {
      value = await call.attempt(attempt);
    } catch (caught) {
      error = caught;
      threw = true;
    }
    const outcome = threw ? outcomeOfError(error) : outcomeOfResponse(value);
    const finish = (): T => {
      if (threw) throw error;
      return value as T;
    };

    let transient: GitHubTransientStatus | undefined;
    let networkError = false;
    if (outcome) {
      transient = classifyGitHubTransient(outcome.status, outcome.headers, now());
    } else if (threw && call.retryNetworkErrors && idempotent) {
      networkError = true;
    }
    if (!transient && !networkError) return finish();
    if (options.signal?.aborted) return finish();
    if (attempt >= maxAttempts) return finish();
    // A POST behind a 5xx may have landed. Without an exact-identity reconcile
    // read there is no safe way to repeat it.
    if (transient?.kind === 'server_error' && !idempotent && !call.reconcile) return finish();
    if (transient?.serverWaitMs !== undefined && transient.serverWaitMs > maxServerWaitMs) return finish();

    const delayMs = computeGitHubRetryDelay(attempt, { baseDelayMs, maxDelayMs, random }, transient?.serverWaitMs);
    if (options.deadlineAtMs !== undefined && now() + delayMs + attemptReserveMs > options.deadlineAtMs) {
      logger.warn('GitHub transient response not retried: deadline too close', {
        operation, status: transient?.status, attempt, delayMs,
      });
      return finish();
    }

    logger.warn('GitHub transient response; retrying', {
      operation,
      status: transient?.status ?? 'network_error',
      reason: transient?.kind ?? 'network_error',
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
    });
    if (!threw) discard(value);
    await sleep(delayMs);
    if (options.signal?.aborted) {
      if (threw) throw error;
      throw options.signal.reason ?? new Error('GitHub retry aborted');
    }

    if (transient?.kind === 'server_error' && !idempotent && call.reconcile) {
      const landed = await call.reconcile();
      if (landed !== undefined) {
        logger.info('GitHub write reconciled after transient response; not re-sent', { operation, attempt });
        return landed;
      }
    }
  }
}
