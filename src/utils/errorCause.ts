/**
 * Sanitized `error.cause` chain for transport-failure logs (REL-1138).
 *
 * Node's fetch (undici) reports a transport failure as a bare `TypeError: fetch failed` or
 * `TypeError: terminated`. The useful part -- `UND_ERR_CONNECT_TIMEOUT`, `ECONNRESET`,
 * `UND_ERR_SOCKET` "other side closed", the address it tried -- lives on `error.cause`, and
 * sometimes on an `AggregateError`'s `errors` (one per address tried). Logging only the top
 * message made ct-infrastructure#834 undiagnosable.
 *
 * This module keeps only the fields that identify the failure: `name`, `code`, `errno`,
 * `syscall`, `address`, `port`, and a short message passed through the worker-failure
 * redactor. It never copies the cause object itself, so request bodies, headers or response
 * payloads an SDK error may carry cannot reach a log line through it.
 *
 * Dependency-free apart from the neutral redactor, so the gateway clients and the panel can
 * both import it (same layering rule as `./workerFailureLogRedaction`).
 */
import { redactWorkerFailureLogTail } from './workerFailureLogRedaction';

export interface SanitizedErrorCause {
  /** 0 is the error passed in; each step down `.cause` or into `.errors[]` adds one. */
  depth: number;
  name?: string;
  code?: string;
  errno?: number | string;
  syscall?: string;
  address?: string;
  port?: number;
  message?: string;
}

/** Entries kept per chain. A real undici chain is 2-4 deep; this only bounds a hostile one. */
export const MAX_ERROR_CAUSE_ENTRIES = 6;
/** Children read from one `AggregateError` (Happy Eyeballs tries one per address). */
export const MAX_AGGREGATE_CHILDREN = 3;
/** Characters of redacted message kept per entry. */
export const MAX_ERROR_CAUSE_MESSAGE_CHARS = 200;

const TOKEN_FIELD = /^[A-Za-z0-9_.:-]{1,64}$/u;
const ADDRESS_FIELD = /^[A-Za-z0-9_.:%[\]-]{1,128}$/u;

/**
 * URLs in a cause message keep scheme, host and path only: userinfo (`user:pass@`), the query
 * string and the fragment -- where signed URLs and API keys travel -- are dropped before the
 * generic redactor runs.
 */
const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@?#]*@)?([^\s/?#]*)([^\s?#]*)(?:\?[^\s#]*)?(?:#\S*)?/giu;

function sanitizeCauseMessage(message: string): string {
  const withoutUrlSecrets = message.replace(URL_IN_TEXT, (_match, scheme: string, host: string, path: string) => `${scheme}${host}${path}`);
  return redactWorkerFailureLogTail(withoutUrlSecrets).slice(0, MAX_ERROR_CAUSE_MESSAGE_CHARS);
}

function tokenField(value: unknown): string | undefined {
  return typeof value === 'string' && TOKEN_FIELD.test(value) ? value : undefined;
}

function describeOne(value: unknown, depth: number): SanitizedErrorCause {
  const entry: SanitizedErrorCause = { depth };
  if (value === null || typeof value !== 'object') {
    // A thrown primitive: keep a redacted rendering only.
    const message = sanitizeCauseMessage(String(value));
    if (message) entry.message = message;
    return entry;
  }
  const source = value as Record<string, unknown>;
  const name = tokenField(source.name);
  if (name) entry.name = name;
  const code = tokenField(source.code);
  if (code) entry.code = code;
  if (typeof source.errno === 'number' && Number.isFinite(source.errno)) entry.errno = source.errno;
  else {
    const errno = tokenField(source.errno);
    if (errno) entry.errno = errno;
  }
  const syscall = tokenField(source.syscall);
  if (syscall) entry.syscall = syscall;
  if (typeof source.address === 'string' && ADDRESS_FIELD.test(source.address)) entry.address = source.address;
  if (typeof source.port === 'number' && Number.isInteger(source.port) && source.port >= 0 && source.port <= 65_535) {
    entry.port = source.port;
  }
  if (typeof source.message === 'string') {
    const message = sanitizeCauseMessage(source.message);
    if (message) entry.message = message;
  }
  return entry;
}

/**
 * The error and everything beneath it, breadth-first, bounded and cycle-safe.
 * Returns an empty array for `undefined`/`null`.
 */
export function describeErrorChain(error: unknown): SanitizedErrorCause[] {
  if (error === undefined || error === null) return [];
  const out: SanitizedErrorCause[] = [];
  const seen = new Set<unknown>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  while (queue.length > 0 && out.length < MAX_ERROR_CAUSE_ENTRIES) {
    const { value, depth } = queue.shift()!;
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) continue;
      seen.add(value);
    }
    out.push(describeOne(value, depth));
    if (typeof value !== 'object' || value === null) continue;
    const source = value as { cause?: unknown; errors?: unknown };
    if (source.cause !== undefined && source.cause !== null) queue.push({ value: source.cause, depth: depth + 1 });
    if (Array.isArray(source.errors)) {
      for (const child of source.errors.slice(0, MAX_AGGREGATE_CHILDREN)) queue.push({ value: child, depth: depth + 1 });
    }
  }
  return out;
}

/** The chain beneath `error` (its `.cause` and aggregate children), without `error` itself. */
export function describeErrorCause(error: unknown): SanitizedErrorCause[] {
  if (error === null || typeof error !== 'object') return [];
  const source = error as { cause?: unknown; errors?: unknown };
  const roots: unknown[] = [];
  if (source.cause !== undefined && source.cause !== null) roots.push(source.cause);
  if (Array.isArray(source.errors)) roots.push(...source.errors.slice(0, MAX_AGGREGATE_CHILDREN));
  const out: SanitizedErrorCause[] = [];
  for (const root of roots) {
    for (const entry of describeErrorChain(root)) {
      if (out.length >= MAX_ERROR_CAUSE_ENTRIES) return out;
      out.push({ ...entry, depth: entry.depth + 1 });
    }
  }
  return out;
}

/** Deepest `code` in a chain: the most specific one (`UND_ERR_CONNECT_TIMEOUT` under `fetch failed`). */
export function rootErrorCauseCode(chain: readonly SanitizedErrorCause[]): string | undefined {
  let best: SanitizedErrorCause | undefined;
  for (const entry of chain) {
    if (entry.code && (!best || entry.depth >= best.depth)) best = entry;
  }
  return best?.code;
}

/**
 * Log fields for a transport failure. An error that carries a precomputed, already-sanitized
 * `causeChain` (see `OpenRouterConnectionError`) uses it; otherwise its `.cause` is described.
 * Returns `{}` when there is nothing beneath the error, so callers can spread it unconditionally.
 */
export function errorCauseLogFields(error: unknown): { errorCause?: SanitizedErrorCause[]; errorCauseCode?: string } {
  const carried = (error as { causeChain?: unknown } | null | undefined)?.causeChain;
  const chain = Array.isArray(carried) ? (carried as SanitizedErrorCause[]) : describeErrorCause(error);
  if (chain.length === 0) return {};
  const code = rootErrorCauseCode(chain);
  return { errorCause: chain, ...(code ? { errorCauseCode: code } : {}) };
}
