import { z } from 'zod';
import { sha256 } from './reviewCore';

const runId = z.string().regex(/^run_[a-f0-9]{32}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveInteger = z.number().int().positive().safe();
export const MAX_WORKER_FAILURE_LOG_TAIL_BYTES = 2_048;

export const workerFailureClasses = [
  'contract',
  'timeout',
  'budget_exhausted',
  'auth',
  'rate_limit',
  'transport',
  'provider_error',
  'malformed_output',
  'internal_error',
] as const;

export type WorkerFailureClass = typeof workerFailureClasses[number];

export const workerFailureDiagnosticsSchema = z.object({
  /** Stable, non-secret category for operators and recovery automation. */
  reason: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/u),
  /** Provider HTTP status when one was observed; omitted for local failures. */
  providerStatus: z.number().int().min(100).max(599).optional(),
  /** Last bounded, redacted worker log line(s). */
  logTail: z.string().refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_WORKER_FAILURE_LOG_TAIL_BYTES,
    `logTail must be at most ${MAX_WORKER_FAILURE_LOG_TAIL_BYTES} UTF-8 bytes`,
  ),
}).strict();

export type WorkerFailureDiagnostics = z.infer<typeof workerFailureDiagnosticsSchema>;

export interface DurableWorkerFailureDiagnostics extends WorkerFailureDiagnostics {
  failureClass: WorkerFailureClass;
  executionAttempt?: number;
}

export const workerTerminalFailureSchema = z.object({
  version: z.literal('WorkerTerminalFailure.v1'),
  runId,
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  executionAttempt: positiveInteger,
  checkId: positiveInteger.optional(),
  failureClass: z.enum(workerFailureClasses),
  /** Optional for mixed-version workers; new workers always send it. */
  diagnostics: workerFailureDiagnosticsSchema.optional(),
}).strict();

export type WorkerTerminalFailure = z.infer<typeof workerTerminalFailureSchema>;

/** A legacy publishing worker may report success only after its exact GitHub
 * check has been completed successfully. Unlike the authoritative completion
 * contract, this records lifecycle state; it does not re-arbitrate the verdict. */
export const workerTerminalSuccessSchema = z.object({
  version: z.literal('WorkerTerminalSuccess.v1'),
  runId,
  repositoryId: positiveInteger,
  owner: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+$/u),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  executionAttempt: positiveInteger,
  checkId: positiveInteger,
}).strict();

export type WorkerTerminalSuccess = z.infer<typeof workerTerminalSuccessSchema>;

export function workerTerminalSuccessDigest(input: unknown): string {
  return sha256(workerTerminalSuccessSchema.parse(input));
}

/** The dispatch service derives this only from the bearer; it is never sent by the worker. */
export interface WorkerCompletionProof {
  workerTokenDigest: string;
}

export interface WorkerCompletionAdapter {
  reportTerminalFailure(event: WorkerTerminalFailure): Promise<void>;
  reportTerminalSuccess(event: WorkerTerminalSuccess): Promise<void>;
}

const SECRET_TOKEN_PATTERN = /(?:gh[pousr]_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/giu;
// Do not rely on a provider prefix for credentials that commonly appear in
// SDK error text. JWTs and AWS access-key IDs are recognizable even when they
// are emitted as opaque response fragments rather than named assignments.
const OPAQUE_CREDENTIAL_PATTERN = /(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})/gu;
// Redact complete PEM private-key blocks before whitespace normalization. The
// label backreference prevents a public-key or certificate block from being
// consumed accidentally, while the orphan-start pass below fails closed when
// a provider truncates the block before its matching END marker.
const PEM_PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN ((?:[A-Z0-9][A-Z0-9 -]{0,96} )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/giu;
const PEM_PRIVATE_KEY_ORPHAN_PATTERN = /-----BEGIN (?:[A-Z0-9][A-Z0-9 -]{0,96} )?PRIVATE KEY-----[\s\S]*$/giu;
const SENSITIVE_ASSIGNMENT_PATTERN = /((?:(?:api[_-]?key|access[_-]?(?:key|token)|aws[_-]?(?:access[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key)(?:[_-]?id)?|x-amz-security-token|token|secret|password|private[_-]?key|authorization|prompt|request(?:[_ -]?body)?|response(?:[_ -]?body)?|content)\s*[:=]\s*))(?:"[^"]*"|'[^']*'|[^,;\s]+)/giu;
// Provider SDKs often append a response/prompt/body excerpt without a key=value
// delimiter (for example, "private provider response ..."). Treat those
// context words as a disclosure boundary too; the stable class/reason/status
// fields carry the operator signal when the free-form excerpt is unsafe.
const SENSITIVE_CONTEXT_PATTERN = /\b(?:private|secret|sensitive|credential|prompt|request|response|content|transcript|body)(?:[_-][^\s,;]{1,160})?(?:\s+[^,;\n]{0,160})?/giu;

/**
 * Keep diagnostic context useful without allowing provider responses, prompts,
 * bearer tokens, or private-key material to cross the worker boundary. The
 * dispatch API repeats this normalization before persistence because a worker
 * is not an authority merely because it holds a short-lived token.
 */
export function redactWorkerFailureLogTail(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  const redacted = text
    .replace(PEM_PRIVATE_KEY_BLOCK_PATTERN, '[REDACTED]')
    .replace(PEM_PRIVATE_KEY_ORPHAN_PATTERN, '[REDACTED]')
    .replace(/\r?\n|\s+/gu, ' ')
    .replace(SECRET_TOKEN_PATTERN, '[REDACTED]')
    .replace(OPAQUE_CREDENTIAL_PATTERN, '[REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1[REDACTED]')
    .replace(SENSITIVE_CONTEXT_PATTERN, '[REDACTED]')
    .trim();
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= MAX_WORKER_FAILURE_LOG_TAIL_BYTES) return redacted;
  let start = bytes.byteLength - MAX_WORKER_FAILURE_LOG_TAIL_BYTES;
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
  let tail = bytes.subarray(start).toString('utf8');
  // The byte cut may begin in the middle of a UTF-8 code point. Drop complete
  // leading code points until the decoded tail itself is still within the cap.
  while (Buffer.byteLength(tail, 'utf8') > MAX_WORKER_FAILURE_LOG_TAIL_BYTES) {
    const first = [...tail][0];
    if (!first) return '';
    tail = tail.slice(first.length);
  }
  return tail;
}

export function workerFailureReason(failureClass: WorkerTerminalFailure['failureClass']): string {
  return {
    contract: 'worker_contract_invalid',
    timeout: 'worker_deadline_exceeded',
    budget_exhausted: 'worker_budget_exhausted',
    auth: 'provider_authentication_failed',
    rate_limit: 'provider_rate_limited',
    transport: 'provider_transport_failed',
    provider_error: 'provider_request_failed',
    malformed_output: 'provider_structured_output_invalid',
    internal_error: 'worker_internal_error',
  }[failureClass];
}

/** Normalize worker context at the persistence boundary, retaining only
 * bounded fields that operators and recovery automation can safely consume. */
export function buildDurableWorkerFailureDiagnostics(
  failureClass: WorkerFailureClass,
  diagnostics?: Partial<WorkerFailureDiagnostics>,
  executionAttempt?: number,
): DurableWorkerFailureDiagnostics {
  const providerStatus = diagnostics?.providerStatus;
  const safeProviderStatus = typeof providerStatus === 'number' && Number.isInteger(providerStatus)
    && providerStatus >= 100 && providerStatus <= 599 ? providerStatus : undefined;
  const reason = typeof diagnostics?.reason === 'string'
    && /^[a-z][a-z0-9_.:-]{0,127}$/u.test(diagnostics.reason)
    ? diagnostics.reason : workerFailureReason(failureClass);
  const logTail = redactWorkerFailureLogTail(diagnostics?.logTail) || workerFailureReason(failureClass);
  return {
    failureClass,
    reason,
    ...(safeProviderStatus === undefined ? {} : { providerStatus: safeProviderStatus }),
    logTail,
    ...(executionAttempt === undefined ? {} : { executionAttempt }),
  };
}

/** Build the redacted diagnostic emitted by the publishing worker. */
export function buildWorkerFailureDiagnostics(
  error: unknown,
  failureClass: WorkerTerminalFailure['failureClass'],
): WorkerFailureDiagnostics {
  const providerStatus = error && typeof error === 'object' && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : Number.NaN;
  const safeStatus = Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599
    ? providerStatus : undefined;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return {
    reason: workerFailureReason(failureClass),
    ...(safeStatus === undefined ? {} : { providerStatus: safeStatus }),
    logTail: redactWorkerFailureLogTail(message || workerFailureReason(failureClass)),
  };
}

export function validateWorkerCompletionEndpoint(endpoint: string): string {
  const normalizedEndpoint = endpoint.trim();
  if (!normalizedEndpoint) throw new Error('worker completion endpoint is required');
  let parsed: URL;
  try {
    parsed = new URL(normalizedEndpoint);
  } catch {
    throw new Error('worker completion endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || !parsed.host || parsed.username || parsed.password || parsed.hash) {
    throw new Error('worker completion endpoint must be an HTTPS URL without userinfo or fragments');
  }
  return normalizedEndpoint;
}

/**
 * Sends only the typed terminal-failure event. The provider error itself never
 * crosses the worker boundary: upstream responses can contain prompts, keys, or
 * other sensitive material. New workers add a bounded redacted diagnostic tail
 * and status/category fields; older workers remain valid during rollout.
 */
export class HttpWorkerCompletionAdapter implements WorkerCompletionAdapter {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: {
    token: string;
    endpoint: string;
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
  }) {
    if (!options.token.startsWith('ghs_')) throw new Error('worker completion requires a ghs_ installation token');
    const endpoint = validateWorkerCompletionEndpoint(options.endpoint);
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 30_000) {
      throw new Error('worker completion timeout must be between 250ms and 30000ms');
    }
    this.endpoint = endpoint;
    this.token = options.token;
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = options.fetchImplementation || globalThis.fetch;
  }

  async reportTerminalFailure(event: WorkerTerminalFailure): Promise<void> {
    await this.report(event);
  }

  async reportTerminalSuccess(event: WorkerTerminalSuccess): Promise<void> {
    await this.report(event);
  }

  private async report(event: WorkerTerminalFailure | WorkerTerminalSuccess): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`worker completion callback failed with HTTP ${response.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
