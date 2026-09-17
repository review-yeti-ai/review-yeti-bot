/**
 * Bounded, redacted worker/persona failure log-tail utility.
 *
 * This is the single neutral home for `redactWorkerFailureLogTail` and the byte cap it
 * enforces -- shared by the panel domain (`../panel/panelEngine`), the worker-completion/HTTP
 * boundary (`../review/workerCompletion`, whose `buildWorkerFailureDiagnostics` and
 * `buildDurableWorkerFailureDiagnostics` back the cli/publisher path in
 * `../cli/publishingReview`), and both gateway transport clients (`../gateway/omniRouteClient`,
 * `../gateway/openRouterClient`). It previously lived in `../review/workerCompletion`, a boundary
 * module with its own documented "no dependency on GitHub/gateway transport types" contract --
 * reasonable while it had two consumers inside the review/panel domain, but not once the gateway
 * clients needed the same redaction for their own raw network-failure log lines: a gateway module
 * importing a review-domain module for a logging utility is a layering violation (REL-892).
 * Moving the redactor and its patterns here, with no runtime dependency on anything they guard,
 * lets every layer import it without any of them depending on another.
 *
 * Deliberately dependency-free: this module must never import from `../panel/*`, `../review/*`,
 * `../gateway/*`, or `../cli/*`. `../review/workerCompletion` re-exports both names from here for
 * external callers that already import them from that path.
 */
export const MAX_WORKER_FAILURE_LOG_TAIL_BYTES = 2_048;

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
