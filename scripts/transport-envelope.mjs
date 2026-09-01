export const TRANSPORT_ENVELOPE_LIMITS = Object.freeze({
  dispatch_weight: 25,
  max_in_flight: 100,
  capacity_wait_timeout_ms: 180000,
});

export const TRANSPORT_SCOPES = Object.freeze(['provider', 'model']);
export const TRANSPORT_RATE_LIMIT_KEYS = Object.freeze([
  'scope',
  'max_retries',
  'max_retry_after_ms',
]);

export function validateTransportEnvelope(transport, path = `transport ${transport?.name || '<unnamed>'}`) {
  for (const [key, maximum] of Object.entries(TRANSPORT_ENVELOPE_LIMITS)) {
    if (!Number.isSafeInteger(transport?.[key]) || transport[key] < 1 || transport[key] > maximum) {
      throw new Error(`${path}.${key} must be an integer from 1 through ${maximum}`);
    }
  }
  if (!TRANSPORT_SCOPES.includes(transport.concurrency_scope)) {
    throw new Error(`${path}.concurrency_scope must be provider or model`);
  }
  if (!transport.rate_limit || typeof transport.rate_limit !== 'object' || Array.isArray(transport.rate_limit)) {
    throw new Error(`${path}.rate_limit must be an object`);
  }
  if (!TRANSPORT_SCOPES.includes(transport.rate_limit.scope)) {
    throw new Error(`${path}.rate_limit.scope must be provider or model`);
  }
  if (!Number.isSafeInteger(transport.rate_limit.max_retries)
    || transport.rate_limit.max_retries < 0 || transport.rate_limit.max_retries > 1) {
    throw new Error(`${path}.rate_limit.max_retries must be 0 or 1`);
  }
  if (!Number.isSafeInteger(transport.rate_limit.max_retry_after_ms)
    || transport.rate_limit.max_retry_after_ms < 0 || transport.rate_limit.max_retry_after_ms > 30000) {
    throw new Error(`${path}.rate_limit.max_retry_after_ms must be an integer from 0 through 30000`);
  }
  return transport;
}
