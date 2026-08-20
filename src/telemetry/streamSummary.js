'use strict';

// AttemptTrace + STREAM_SUMMARY (ct-meta docs/plans/2026-08-20-review-yeti-telemetry.md, commit
// 5657f3df, PR #2096). Six lies in one session cost hours before this design existed:
// `stream=disabled` while streaming was on, `TIMEOUT` on a response that had completed, a
// telemetry block reporting a different stage's counts, `PARTIAL_REVIEW` masking a config crash,
// a `SHIP` verdict failed by an illegible gate, and `conclusion: success` on a `BLOCK` panel. The
// review LOGIC was not the weak point; the REPORTING was. This module is the structural
// countermeasure for the streaming-transport slice of that problem (design §4.2):
//
//   1. Single writer. The AttemptTrace is built and mutated only inside `callOpenRouterChat`
//      (.github/workflows/pipelines/review-pipeline.js) and frozen before it leaves. This module
//      never synthesizes trace fields -- it only validates and renders what the transport layer
//      already decided.
//   2. Closed-schema render validation, in the exact style of `validateReviewDispatchRunReceipt`
//      (review-pipeline.js). Unknown fields, missing fields, or a non-numeric value in a numeric
//      slot make the renderer refuse -- and say so -- rather than print a plausible lie.
//   3. Contradiction tripwires, fail-loud. `stream_end_reason=done_marker` (the stream actually
//      completed) can never carry a `budget_exceeded` reason: both the schema validator and the
//      dedicated `shouldRenderTimeout` predicate enforce this, so a TIMEOUT label can no longer
//      be attached to a response that finished streaming (the class of defect this design traces
//      to a socket-reset-after-[DONE] false `response_timeout`, review-pipeline.js's own doc
//      comment at the `[DONE]` handling site).
//
// Every field here is numeric, a closed enum, or a bounded route/persona identifier -- there is
// no free-text slot for a prompt, a diff, reasoning/content prose, a header value, or a
// credential to leak into (design §9). Char *counts* are carried; char *content* never is.

const { canonicalJson } = require('../review/reviewCore');

const STREAM_SUMMARY_SCHEMA_VERSION = 'stream-summary-v1';

const MAX_MS = 86_400_000; // 24h -- the same bound `reviewTelemetry.js` uses for latencyMs.
const MAX_CHARS = 10_000_000;
const MAX_CHUNKS = 1_000_000;
const MAX_TOKENS = 10_000_000;

// `stall` and `stream_unreadable` are corrections to the design brief, made during
// implementation against review-yeti-bot@28e1339 (main advanced past the design's verified
// 357258c snapshot in the interim): a 2026-08-20 fix replaced the fixed-total-duration abort with
// a resettable stall/gap timer as the primary streaming-phase timeout (`stallController`,
// review-pipeline.js), so `budget_exceeded` must be able to say `stall` distinctly from `total`.
// `stream_unreadable` covers the response-body-not-readable branch, which is neither a completed
// stream nor a budget expiry and must not be forced into either bucket.
const FIRST_CHUNK_KINDS = new Set(['reasoning', 'content', 'other', 'none']);
const STREAM_END_REASONS = new Set([
  'done_marker',
  'reader_done',
  'mid_stream_error',
  'abort',
  'http_error',
  'stream_unreadable',
  'not_started',
]);
const BUDGET_EXCEEDED = new Set(['none', 'ttft', 'stall', 'total', 'lane_deadline']);

// The AttemptTrace is owned exclusively by `callOpenRouterChat`'s stream reader and the abort
// classifier inside it (design §4.1). This module only renders/validates what that single writer
// already decided.
const ATTEMPT_TRACE_FIELDS = new Set([
  't_headers_ms',
  't_first_chunk_ms',
  'first_chunk_kind',
  't_first_content_ms',
  't_done_ms',
  'reasoning_ms',
  'reasoning_chars',
  'content_chars',
  'chunk_count',
  'max_inter_chunk_gap_ms',
  'max_gap_at_ms',
  'stream_end_reason',
  'budget_exceeded',
  'ttft_budget_ms',
  'total_budget_ms',
  'stall_budget_ms',
  'provider_ttft_ms',
]);

// Context fields are supplied by the caller (the attempt loop / route resolver, design §4.1) --
// never by the transport layer -- and are bounded ids/counts only, same secret-safety rule as the
// trace itself.
const CONTEXT_FIELDS = new Set([
  'persona',
  'model_index',
  'attempt',
  'transport',
  'provider',
  'model',
  'generation_id',
  'http_status',
  'queue_wait_ms',
  'queued_ahead_at_start',
  'prompt_chars',
  'lane_deadline_ms',
  'prompt_tokens',
  'completion_tokens',
]);

function isNullableInt(value, { min = 0, max = MAX_MS } = {}) {
  if (value === null) return true;
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function isInt(value, { min = 0, max = MAX_MS } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function isEnum(value, set) {
  return typeof value === 'string' && set.has(value);
}

// A bounded route/persona/session identifier -- deliberately the same shape as the existing
// `safeRouteId`/`boundedUnitId` normalizers (reviewTelemetry.js): short, closed charset, no
// spaces, no URL/credential shape. This is a schema-validation gate (refuse), not a redaction
// (never silently rewrite a value the caller supplied).
const BOUNDED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]*$/u;
// Same credential-shape rejection `safeRouteId` already applies (reviewTelemetry.js) -- a bounded
// id slot must not become a smuggling vector just because its charset happens to be permissive
// enough to hold an opaque-looking token.
const CREDENTIAL_LIKE_PATTERN = /(?:^|[._/:-])(sk|pk|api[_-]?key|token|secret|bearer|authorization|password)(?:[._/:-]|$)/iu;
function isBoundedId(value, maxLength = 100) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && BOUNDED_ID_PATTERN.test(value) && !CREDENTIAL_LIKE_PATTERN.test(value);
}
function isNullableBoundedId(value, maxLength = 100) {
  return value === null || isBoundedId(value, maxLength);
}

function closedSchemaKeyErrors(candidate, fields, label) {
  const errors = [];
  const unknown = Object.keys(candidate).filter((key) => !fields.has(key));
  const missing = [...fields].filter((key) => !Object.hasOwn(candidate, key));
  if (unknown.length) errors.push(`unknown ${label} fields: ${unknown.join(', ')}`);
  if (missing.length) errors.push(`missing ${label} fields: ${missing.join(', ')}`);
  return errors;
}

/**
 * Validates a frozen AttemptTrace against its closed schema. This is the render-validation half
 * of design §4.2 rule 2: unknown fields, missing fields, and mistyped numeric/enum slots are all
 * refused with a specific reason, never silently coerced or dropped.
 */
function validateAttemptTrace(trace) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return { valid: false, errors: ['attempt trace must be an object'] };
  const errors = closedSchemaKeyErrors(trace, ATTEMPT_TRACE_FIELDS, 'attempt trace');
  if (!isNullableInt(trace.t_headers_ms)) errors.push('t_headers_ms must be a bounded non-negative integer or null');
  if (!isNullableInt(trace.t_first_chunk_ms)) errors.push('t_first_chunk_ms must be a bounded non-negative integer or null');
  if (!isEnum(trace.first_chunk_kind, FIRST_CHUNK_KINDS)) errors.push('first_chunk_kind must be one of reasoning|content|other|none');
  if (!isNullableInt(trace.t_first_content_ms)) errors.push('t_first_content_ms must be a bounded non-negative integer or null');
  if (!isNullableInt(trace.t_done_ms)) errors.push('t_done_ms must be a bounded non-negative integer or null');
  if (!isNullableInt(trace.reasoning_ms)) errors.push('reasoning_ms must be a bounded non-negative integer or null');
  if (!isInt(trace.reasoning_chars, { max: MAX_CHARS })) errors.push('reasoning_chars must be a bounded non-negative integer');
  if (!isInt(trace.content_chars, { max: MAX_CHARS })) errors.push('content_chars must be a bounded non-negative integer');
  if (!isInt(trace.chunk_count, { max: MAX_CHUNKS })) errors.push('chunk_count must be a bounded non-negative integer');
  if (!isNullableInt(trace.max_inter_chunk_gap_ms)) errors.push('max_inter_chunk_gap_ms must be a bounded non-negative integer or null');
  if (!isNullableInt(trace.max_gap_at_ms)) errors.push('max_gap_at_ms must be a bounded non-negative integer or null');
  if (!isEnum(trace.stream_end_reason, STREAM_END_REASONS)) errors.push('stream_end_reason must be a closed enum value');
  if (!isEnum(trace.budget_exceeded, BUDGET_EXCEEDED)) errors.push('budget_exceeded must be one of none|ttft|stall|total|lane_deadline');
  if (!isInt(trace.ttft_budget_ms, { min: 1 })) errors.push('ttft_budget_ms must be a positive bounded integer');
  if (!isInt(trace.total_budget_ms, { min: 1 })) errors.push('total_budget_ms must be a positive bounded integer');
  if (!isInt(trace.stall_budget_ms, { min: 1 })) errors.push('stall_budget_ms must be a positive bounded integer');
  if (!isNullableInt(trace.provider_ttft_ms)) errors.push('provider_ttft_ms must be a bounded non-negative integer or null');

  // Contradiction tripwires (design §4.2 point 3): a field must be emitted by the path that
  // decided it, and a completed stream can never retroactively become a timeout.
  if (trace.stream_end_reason === 'done_marker' && trace.budget_exceeded !== 'none') {
    errors.push('a completed stream (stream_end_reason=done_marker) cannot report a non-none budget_exceeded reason');
  }
  if (trace.t_first_content_ms !== null && trace.t_first_chunk_ms === null) {
    errors.push('t_first_content_ms cannot be set while t_first_chunk_ms is null');
  }
  if (trace.max_gap_at_ms !== null && trace.max_inter_chunk_gap_ms === null) {
    errors.push('max_gap_at_ms cannot be set while max_inter_chunk_gap_ms is null');
  }
  if (trace.reasoning_ms !== null && (trace.t_first_chunk_ms === null || trace.t_first_content_ms === null)) {
    errors.push('reasoning_ms cannot be set unless both t_first_chunk_ms and t_first_content_ms are set');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates the caller-supplied context merged alongside the AttemptTrace to form a
 * STREAM_SUMMARY line: the attempt-loop coordinate (persona/model/attempt/...), never a
 * transport-layer field.
 */
function validateStreamSummaryContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return { valid: false, errors: ['stream summary context must be an object'] };
  const errors = closedSchemaKeyErrors(context, CONTEXT_FIELDS, 'stream summary context');
  if (!isBoundedId(context.persona, 100)) errors.push('persona must be a bounded identifier');
  if (!isInt(context.model_index, { max: 1000 })) errors.push('model_index must be a bounded non-negative integer');
  if (!isInt(context.attempt, { min: 1, max: 1000 })) errors.push('attempt must be a positive bounded integer');
  if (!isBoundedId(context.transport, 100)) errors.push('transport must be a bounded identifier');
  if (!isBoundedId(context.provider, 100)) errors.push('provider must be a bounded identifier');
  if (!isBoundedId(context.model, 300)) errors.push('model must be a bounded identifier');
  if (!isNullableBoundedId(context.generation_id, 200)) errors.push('generation_id must be a bounded identifier or null');
  if (!(context.http_status === null || isInt(context.http_status, { max: 599 }))) errors.push('http_status must be a bounded non-negative integer or null');
  if (!isNullableInt(context.queue_wait_ms)) errors.push('queue_wait_ms must be a bounded non-negative integer or null');
  if (!isNullableInt(context.queued_ahead_at_start, { max: 100_000 })) errors.push('queued_ahead_at_start must be a bounded non-negative integer or null');
  if (!isInt(context.prompt_chars, { max: MAX_CHARS })) errors.push('prompt_chars must be a bounded non-negative integer');
  if (!(context.lane_deadline_ms === null || isInt(context.lane_deadline_ms, { min: 1 }))) errors.push('lane_deadline_ms must be a positive bounded integer or null');
  if (!isNullableInt(context.prompt_tokens, { max: MAX_TOKENS })) errors.push('prompt_tokens must be a bounded non-negative integer or null');
  if (!isNullableInt(context.completion_tokens, { max: MAX_TOKENS })) errors.push('completion_tokens must be a bounded non-negative integer or null');
  return { valid: errors.length === 0, errors };
}

/**
 * Pure contradiction-tripwire predicate (design §4.2 point 3, unit-test spec verbatim): a
 * synthetic trace with `budget_exceeded=none` + `stream_end_reason=done_marker` must produce zero
 * TIMEOUT lines; the inverse must produce exactly one. This is deliberately independent of the
 * closed-schema validation above so a caller can gate a human-readable TIMEOUT log line with a
 * single cheap boolean check without re-validating the whole trace on every call.
 */
function shouldRenderTimeout(trace) {
  if (!trace || typeof trace !== 'object') return false;
  if (trace.stream_end_reason === 'done_marker') return false;
  return trace.budget_exceeded !== 'none';
}

function escapeReason(reason) {
  return String(reason).replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

/**
 * Renders the always-on, one-line-per-attempt STREAM_SUMMARY log line (design §4.1). On a valid
 * trace + context this is a single deterministic JSON line. On an invalid one -- the render
 * refusing rather than printing a plausible lie (§4.2 rule 2) -- it renders a distinct
 * `STREAM_SUMMARY_INVALID telemetry_invalid` marker carrying the validation reasons, never a
 * best-effort/partial summary.
 */
function renderStreamSummaryLine({ trace, context } = {}) {
  const traceValidation = validateAttemptTrace(trace);
  const contextValidation = validateStreamSummaryContext(context);
  if (!traceValidation.valid || !contextValidation.valid) {
    const persona = context && typeof context.persona === 'string' && isBoundedId(context.persona, 100) ? context.persona : 'unknown';
    const reasons = [...traceValidation.errors, ...contextValidation.errors].join('; ');
    return `STREAM_SUMMARY_INVALID telemetry_invalid persona=${persona} reason="${escapeReason(reasons)}"`;
  }
  const summary = { schemaVersion: STREAM_SUMMARY_SCHEMA_VERSION, ...context, ...trace };
  return `STREAM_SUMMARY ${canonicalJson(summary)}`;
}

/**
 * Renders the trace-carrying suffix appended to the existing human-readable `TIMEOUT phase=...`
 * warn line (design §4.1: "the existing TIMEOUT line gains the same trace object -- a timeout
 * autopsy"). Refuses the same way `renderStreamSummaryLine` does on an invalid trace, so a caller
 * can never print a fabricated autopsy.
 */
function renderTimeoutTraceSuffix(trace) {
  const validation = validateAttemptTrace(trace);
  if (!validation.valid) return `trace=INVALID reason="${escapeReason(validation.errors.join('; '))}"`;
  return `trace=${canonicalJson(trace)}`;
}

module.exports = {
  STREAM_SUMMARY_SCHEMA_VERSION,
  ATTEMPT_TRACE_FIELDS,
  CONTEXT_FIELDS,
  validateAttemptTrace,
  validateStreamSummaryContext,
  shouldRenderTimeout,
  renderStreamSummaryLine,
  renderTimeoutTraceSuffix,
};
