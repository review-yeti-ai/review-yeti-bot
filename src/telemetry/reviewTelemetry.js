'use strict';

const { canonicalJson, sha256 } = require('../review/reviewCore');
const { createReviewIdentity } = require('../review/reviewContracts');

const REVIEW_TELEMETRY_VERSION = 'review-telemetry-v1';
const MAX_ID_LENGTH = 96;
const MAX_LATENCY_MS = 86_400_000;
const PHASES = new Set(['review', 'model', 'arbitration', 'publication', 'telemetry']);
const OUTCOMES = new Set(['started', 'completed', 'failed', 'cancelled', 'skipped', 'unavailable']);
const FAILURE_CLASSES = new Set([
  'provider_unavailable',
  'provider_timeout',
  'provider_invalid_response',
  'publication_unavailable',
  'export_unavailable',
  'cancelled',
  'unknown',
]);
const PERSONA_SLOTS = new Map([
  ['security', 'p01'], ['performance', 'p02'], ['architecture', 'p03'], ['testing', 'p04'],
  ['dependencies', 'p05'], ['style', 'p06'], ['documentation', 'p07'], ['accessibility', 'p08'],
  ['database', 'p09'], ['devops', 'p10'], ['i18n', 'p11'], ['licensing', 'p12'],
]);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function safeRouteId(value, kind) {
  const normalized = String(value || '').trim().toLowerCase();
  const expression = kind === 'provider'
    ? /^[a-z0-9][a-z0-9._-]{0,63}$/u
    : /^[a-z0-9][a-z0-9._/-]{0,95}$/u;
  if (!expression.test(normalized)) return undefined;
  if (/(?:^|[._/-])(sk|pk|api[_-]?key|token|secret|bearer|authorization|password)(?:[._/-]|$)/u.test(normalized)) return undefined;
  const allowed = kind === 'provider'
    ? new Set(['openrouter', 'openai', 'anthropic', 'google', 'deepseek', 'mistral', 'cohere'])
    : new Set(['openrouter/auto-beta', 'deepseek/deepseek-v4-flash-0731']);
  return allowed.has(normalized) ? normalized : 'other';
}

function safePositiveNumber(value, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.min(Math.floor(number), maximum);
}

function safeCost(value) {
  // Cost is a provider receipt field, not a best-effort conversion. In particular, null and an
  // empty string must not become a misleading $0 observation through Number(...).
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function canonicalIdentity(input = {}) {
  const source = plainObject(input) || {};
  return createReviewIdentity({
    repository: source.repository,
    prNumber: source.prNumber,
    baseSha: source.baseSha,
    headSha: source.headSha,
    // Validate all required immutable review coordinates with the shared contract. The passed
    // digest is a safe, deterministic policy coordinate rather than a telemetry payload.
    trustedConfig: source.configDigest || '',
    effectivePolicy: source.policyDigest || '',
  });
}

function boundedUnitId(value) {
  const unit = String(value || '').trim().toLowerCase();
  if (['pipeline', 'verdict', 'review', 'exporter'].includes(unit)) return unit;
  const model = /^model-(\d+)-attempt-(\d+)$/u.exec(unit);
  if (model) return `model-${Math.min(Number(model[1]), 4)}-attempt-${Math.min(Number(model[2]), 3)}`;
  return 'other';
}

function pseudonymousPersonaId(personaId) {
  return PERSONA_SLOTS.get(String(personaId || '').trim().toLowerCase()) || 'p_custom';
}

function normalizeUsage(value) {
  const usage = plainObject(value);
  // Provider receipt IDs are intentionally only a gate: they are not persisted to avoid creating
  // another durable cross-system correlation identifier in telemetry.
  if (!usage || typeof usage.receiptId !== 'string' || !usage.receiptId.trim()) return undefined;
  const promptTokens = safePositiveNumber(usage.promptTokens, 10_000_000);
  const completionTokens = safePositiveNumber(usage.completionTokens, 10_000_000);
  const costUSD = safeCost(usage.costUSD);
  if (promptTokens === undefined && completionTokens === undefined && costUSD === undefined) return undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    totalTokens: (promptTokens || 0) + (completionTokens || 0),
    ...(costUSD === undefined ? {} : { costUSD }),
  };
}

function normalizeEvent(identity, input = {}, clock = Date.now) {
  const source = plainObject(input) || {};
  const phase = PHASES.has(source.phase) ? source.phase : 'review';
  const outcome = OUTCOMES.has(source.outcome) ? source.outcome : 'completed';
  const unitId = boundedUnitId(source.unitId);
  const personaId = source.personaId === undefined || source.personaId === null || source.personaId === ''
    ? undefined
    : pseudonymousPersonaId(source.personaId);
  const failureClass = FAILURE_CLASSES.has(source.failureClass) ? source.failureClass : undefined;
  const providerId = safeRouteId(source.providerId, 'provider');
  const modelId = safeRouteId(source.modelId, 'model');
  // `unitId` is the deterministic pass/attempt coordinate. Include the bounded event semantics
  // too: a completed and failed attempt must not collapse into one backend span.
  const stableIdentity = {
    ...identity,
    phase,
    unitId,
    personaId: personaId || null,
    outcome,
    providerId: providerId || null,
    modelId: modelId || null,
    failureClass: failureClass || null,
    usage: normalizeUsage(source.usage) || null,
  };
  const event = {
    schemaVersion: REVIEW_TELEMETRY_VERSION,
    eventId: sha256(canonicalJson(stableIdentity)),
    occurredAt: new Date(Number(clock())).toISOString(),
    phase,
    unitId,
    outcome,
    ...(personaId ? { personaId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(failureClass ? { failureClass } : {}),
    ...(safePositiveNumber(source.latencyMs, MAX_LATENCY_MS) === undefined ? {} : { latencyMs: safePositiveNumber(source.latencyMs, MAX_LATENCY_MS) }),
    ...(normalizeUsage(source.usage) ? { usage: normalizeUsage(source.usage) } : {}),
  };
  return Object.freeze(event);
}

function createNoopReviewTelemetrySink() {
  return Object.freeze({
    schemaVersion: 'review-telemetry-sink-v1',
    async emit() {},
  });
}

function validateExporter(exporter) {
  const source = plainObject(exporter);
  if (!source || typeof source.endpoint !== 'string' || typeof source.fetchImplementation !== 'function') return null;
  let endpoint;
  try { endpoint = new URL(source.endpoint); } catch (_) { return null; }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
  const timeoutMs = safePositiveNumber(source.timeoutMs, 10_000) || 2_000;
  return {
    endpoint: endpoint.toString(),
    credential: typeof source.credential === 'string' ? source.credential : '',
    fetchImplementation: source.fetchImplementation,
    timeoutMs,
    signal: source.signal && typeof source.signal === 'object' ? source.signal : null,
  };
}

function otelPayload(event) {
  const attributes = Object.entries(event)
    .filter(([key]) => !['schemaVersion', 'eventId', 'occurredAt'].includes(key))
    .map(([key, value]) => ({ key: `review_yeti.${key}`, value: { stringValue: typeof value === 'string' ? value : canonicalJson(value) } }));
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'review-yeti' } }] },
      scopeSpans: [{ scope: { name: 'review-yeti', version: REVIEW_TELEMETRY_VERSION }, spans: [{
        traceId: sha256(`trace:${event.eventId}`).slice(0, 32),
        spanId: sha256(`span:${event.eventId}`).slice(0, 16),
        name: `review-yeti.${event.phase}`,
        startTimeUnixNano: String(Date.parse(event.occurredAt) * 1_000_000),
        endTimeUnixNano: String(Date.parse(event.occurredAt) * 1_000_000),
        attributes,
      }] }],
    }],
  };
}

/**
 * Records bounded, prose-free review telemetry. Export is deliberately advisory: no exporter
 * error can throw from record or flush, alter a verdict, or change publication behavior.
 */
function createReviewTelemetry({ identity, sink, exporter, clock = Date.now } = {}) {
  const stableIdentity = canonicalIdentity(identity);
  const destination = sink && typeof sink.emit === 'function' ? sink : createNoopReviewTelemetrySink();
  const configuredExporter = validateExporter(exporter);
  const pending = new Set();
  const exportControllers = new Set();
  let exporterUnavailable = false;
  let exportsCancelled = false;
  let eventCount = 0;

  const abortExports = () => {
    exportsCancelled = true;
    for (const controller of exportControllers) controller.abort();
  };

  const emit = (event) => {
    const task = Promise.resolve().then(() => destination.emit(event)).catch(() => undefined);
    pending.add(task);
    task.finally(() => pending.delete(task));
    return task;
  };

  const exportEvent = (event) => {
    if (!configuredExporter || event.failureClass === 'export_unavailable' || exportsCancelled || configuredExporter.signal?.aborted) return;
    const controller = new AbortController();
    exportControllers.add(controller);
    let requestCancelled = false;
    const cancelExport = () => {
      requestCancelled = true;
      exportsCancelled = true;
      controller.abort();
    };
    if (configuredExporter.signal?.aborted) cancelExport();
    else configuredExporter.signal?.addEventListener?.('abort', cancelExport, { once: true });
    if (exportsCancelled || requestCancelled) {
      exportControllers.delete(controller);
      configuredExporter.signal?.removeEventListener?.('abort', cancelExport);
      return;
    }
    let timer;
    let request;
    try {
      request = Promise.resolve(configuredExporter.fetchImplementation(configuredExporter.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(configuredExporter.credential ? { authorization: `Bearer ${configuredExporter.credential}` } : {}),
        },
        body: JSON.stringify(otelPayload(event)),
        signal: controller.signal,
      }));
    } catch (error) {
      request = Promise.reject(error);
    }
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('OTel exporter timed out'));
      }, configuredExporter.timeoutMs);
    });
    const task = Promise.race([request, timeout]).then((response) => {
      if (!response || response.ok === false) throw new Error('OTel exporter rejected telemetry');
    }).catch(() => {
      if (exportsCancelled || requestCancelled || configuredExporter.signal?.aborted) return;
      exporterUnavailable = true;
      eventCount += 1;
      emit(normalizeEvent(stableIdentity, { phase: 'telemetry', unitId: 'exporter', outcome: 'unavailable', failureClass: 'export_unavailable' }, clock));
    }).finally(() => {
      clearTimeout(timer);
      exportControllers.delete(controller);
      configuredExporter.signal?.removeEventListener?.('abort', cancelExport);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };

  return Object.freeze({
    record(input = {}) {
      const event = normalizeEvent(stableIdentity, input, clock);
      eventCount += 1;
      emit(event);
      exportEvent(event);
      return event;
    },
    async flush({ signal } = {}) {
      if (signal?.aborted) {
        abortExports();
        return { status: 'cancelled', pending: pending.size, events: eventCount };
      }
      while (pending.size > 0) {
        const settled = Promise.allSettled([...pending]).then(() => 'settled');
        if (!signal) {
          await settled;
          continue;
        }
        const cancelled = new Promise((resolve) => signal.addEventListener('abort', () => resolve('cancelled'), { once: true }));
        const status = await Promise.race([settled, cancelled]);
        if (status === 'cancelled' || signal.aborted) {
          abortExports();
          return { status: 'cancelled', pending: pending.size, events: eventCount };
        }
      }
      return exporterUnavailable ? { status: 'unavailable', pending: 0, events: eventCount } : { status: configuredExporter ? 'exported' : 'noop', pending: 0, events: eventCount };
    },
  });
}

module.exports = {
  REVIEW_TELEMETRY_VERSION,
  createNoopReviewTelemetrySink,
  createReviewTelemetry,
  normalizeEvent,
  pseudonymousPersonaId,
};
