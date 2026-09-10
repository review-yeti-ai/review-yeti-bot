#!/usr/bin/env node

/**
 * OpenTelemetry OTLP/HTTP Metrics Emitter for Review Yeti.
 *
 * Provides zero-dependency, pure Node.js ESM metrics emission implementing:
 * 1. OpenTelemetry OTLP/HTTP JSON v1 (ExportMetricsServiceRequest)
 * 2. VictoriaMetrics / Prometheus exposition text import format
 * 3. VictoriaMetrics JSON lines format
 *
 * Operational Principle: FAIL OPEN.
 * Telemetry must never crash, stall, or fail review pipelines or CI runs.
 */

import { isEntrypoint } from './entrypoint-guard.mjs';

export const DEFAULT_SERVICE_NAME = 'review-yeti';
export const DEFAULT_SERVICE_VERSION = '1.0.0';
export const DEFAULT_TIMEOUT_MS = 5000;

export const LATENCY_BOUNDS_SECONDS = [
  0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0, 900.0,
];

export const TTFT_BOUNDS_SECONDS = [
  0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 15.0, 30.0,
];

/**
 * Converts attributes object { key: value } to OTLP KeyValue array.
 */
export function toOtlpAttributes(attrs = {}) {
  return Object.entries(attrs)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([key, value]) => {
      if (typeof value === 'boolean') {
        return { key, value: { boolValue: value } };
      }
      if (typeof value === 'number') {
        return Number.isInteger(value)
          ? { key, value: { intValue: String(value) } }
          : { key, value: { doubleValue: value } };
      }
      return { key, value: { stringValue: String(value) } };
    });
}

/**
 * Sanitizes metric name for Prometheus compatibility (dots and dashes to underscores).
 */
export function sanitizeMetricName(name) {
  return name.replace(/[^a-zA-Z0-9_:]/g, '_');
}

/**
 * Builds a counter metric definition.
 */
export function createCounterMetric({
  name,
  description = '',
  unit = '1',
  value = 1,
  attributes = {},
  timestampNano = String(BigInt(Date.now()) * 1_000_000n),
}) {
  return {
    name,
    description,
    unit,
    type: 'counter',
    value,
    attributes,
    timestampNano,
    otlp: {
      name,
      description,
      unit,
      sum: {
        aggregationTemporality: 1, // AGGREGATION_TEMPORALITY_DELTA
        isMonotonic: true,
        dataPoints: [
          {
            attributes: toOtlpAttributes(attributes),
            timeUnixNano: String(timestampNano),
            asInt: Number.isInteger(value) ? String(value) : undefined,
            asDouble: Number.isInteger(value) ? undefined : Number(value),
          },
        ],
      },
    },
  };
}

/**
 * Builds a gauge metric definition.
 */
export function createGaugeMetric({
  name,
  description = '',
  unit = '1',
  value = 0,
  attributes = {},
  timestampNano = String(BigInt(Date.now()) * 1_000_000n),
}) {
  return {
    name,
    description,
    unit,
    type: 'gauge',
    value,
    attributes,
    timestampNano,
    otlp: {
      name,
      description,
      unit,
      gauge: {
        dataPoints: [
          {
            attributes: toOtlpAttributes(attributes),
            timeUnixNano: String(timestampNano),
            asInt: Number.isInteger(value) ? String(value) : undefined,
            asDouble: Number.isInteger(value) ? undefined : Number(value),
          },
        ],
      },
    },
  };
}

/**
 * Computes histogram bucket counts for explicit bounds.
 */
export function computeBucketCounts(value, bounds) {
  const counts = new Array(bounds.length + 1).fill(0);
  let placed = false;
  for (let i = 0; i < bounds.length; i++) {
    if (value <= bounds[i]) {
      counts[i] = 1;
      placed = true;
      break;
    }
  }
  if (!placed) {
    counts[bounds.length] = 1;
  }
  return counts;
}

/**
 * Builds a histogram metric definition.
 */
export function createHistogramMetric({
  name,
  description = '',
  unit = 's',
  value = 0,
  bounds = LATENCY_BOUNDS_SECONDS,
  attributes = {},
  timestampNano = String(BigInt(Date.now()) * 1_000_000n),
}) {
  const numValue = Number(value);
  const bucketCounts = computeBucketCounts(numValue, bounds);

  return {
    name,
    description,
    unit,
    type: 'histogram',
    value: numValue,
    bounds,
    attributes,
    timestampNano,
    otlp: {
      name,
      description,
      unit,
      histogram: {
        aggregationTemporality: 1, // AGGREGATION_TEMPORALITY_DELTA
        dataPoints: [
          {
            attributes: toOtlpAttributes(attributes),
            timeUnixNano: String(timestampNano),
            count: '1',
            sum: numValue,
            bucketCounts: bucketCounts.map(String),
            explicitBounds: bounds,
          },
        ],
      },
    },
  };
}

/**
 * Packages metrics into an OpenTelemetry ExportMetricsServiceRequest payload.
 */
export function buildOtlpMetricsPayload({
  serviceName = DEFAULT_SERVICE_NAME,
  serviceVersion = DEFAULT_SERVICE_VERSION,
  extraResourceAttributes = {},
  metrics = [],
} = {}) {
  const resourceAttrs = {
    'service.name': serviceName,
    'service.version': serviceVersion,
    ...extraResourceAttributes,
  };

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: toOtlpAttributes(resourceAttrs),
        },
        scopeMetrics: [
          {
            scope: {
              name: 'exampleorg.review-yeti.otel',
              version: serviceVersion,
            },
            metrics: metrics.map((m) => m.otlp || m),
          },
        ],
      },
    ],
  };
}

/**
 * Encodes metrics into Prometheus text format for /api/v1/import/prometheus.
 */
export function encodePrometheusText(metrics = [], defaultLabels = {}) {
  const lines = [];

  for (const metric of metrics) {
    const safeName = sanitizeMetricName(metric.name);
    const combinedLabels = { ...defaultLabels, ...metric.attributes };
    const labelString = Object.entries(combinedLabels)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${sanitizeMetricName(k)}="${String(v).replace(/"/g, '\\"')}"`)
      .join(',');
    const labelSuffix = labelString ? `{${labelString}}` : '';

    if (metric.type === 'counter') {
      lines.push(`# TYPE ${safeName} counter`);
      lines.push(`${safeName}${labelSuffix} ${metric.value}`);
    } else if (metric.type === 'gauge') {
      lines.push(`# TYPE ${safeName} gauge`);
      lines.push(`${safeName}${labelSuffix} ${metric.value}`);
    } else if (metric.type === 'histogram') {
      lines.push(`# TYPE ${safeName} histogram`);
      const bounds = metric.bounds || LATENCY_BOUNDS_SECONDS;
      const numValue = metric.value;
      let cumCount = 0;
      for (const bound of bounds) {
        if (numValue <= bound) {
          cumCount = 1;
        }
        const bLabels = Object.entries(combinedLabels)
          .map(([k, v]) => `${sanitizeMetricName(k)}="${String(v).replace(/"/g, '\\"')}"`);
        bLabels.push(`le="${bound}"`);
        lines.push(`${safeName}_bucket{${bLabels.join(',')}} ${cumCount}`);
      }
      const infLabels = Object.entries(combinedLabels)
        .map(([k, v]) => `${sanitizeMetricName(k)}="${String(v).replace(/"/g, '\\"')}"`);
      infLabels.push('le="+Inf"');
      lines.push(`${safeName}_bucket{${infLabels.join(',')}} 1`);
      lines.push(`${safeName}_sum${labelSuffix} ${numValue}`);
      lines.push(`${safeName}_count${labelSuffix} 1`);
    } else {
      lines.push(`${safeName}${labelSuffix} ${metric.value ?? 1}`);
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Encodes metrics into VictoriaMetrics JSON lines format for /api/v1/import.
 */
export function encodeVictoriaMetricsJson(metrics = [], defaultLabels = {}, timestampMs = Date.now()) {
  const lines = [];

  for (const metric of metrics) {
    const safeName = sanitizeMetricName(metric.name);
    const combinedLabels = {
      __name__: safeName,
      ...defaultLabels,
      ...metric.attributes,
    };
    // For histogram, export sum and count
    if (metric.type === 'histogram') {
      lines.push(JSON.stringify({
        metric: { ...combinedLabels, __name__: `${safeName}_sum` },
        values: [metric.value],
        timestamps: [timestampMs],
      }));
      lines.push(JSON.stringify({
        metric: { ...combinedLabels, __name__: `${safeName}_count` },
        values: [1],
        timestamps: [timestampMs],
      }));
    } else {
      lines.push(JSON.stringify({
        metric: combinedLabels,
        values: [metric.value],
        timestamps: [timestampMs],
      }));
    }
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * Determines export format from endpoint URL or explicit override.
 */
export function detectFormat(endpoint, explicitFormat) {
  if (explicitFormat) return explicitFormat.toLowerCase();
  if (!endpoint) return 'otlp_json';
  if (endpoint.includes('/api/v1/import/prometheus')) return 'prometheus';
  if (endpoint.includes('/api/v1/import')) return 'vm_json';
  return 'otlp_json';
}

/**
 * Sends metrics to configured endpoint, failing open on any error.
 */
export async function sendMetrics(metrics, {
  endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  headers = {},
  timeoutMs = Number(process.env.OTEL_EXPORTER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  fetchImpl = globalThis.fetch,
  serviceName = process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
  serviceVersion = DEFAULT_SERVICE_VERSION,
  format = process.env.OTEL_EXPORTER_FORMAT,
  enabled = process.env.OTEL_METRICS_ENABLED !== 'false' && process.env.OTEL_METRICS_ENABLED !== '0',
  log = console.debug,
} = {}) {
  if (!enabled || !endpoint || !metrics || metrics.length === 0) {
    return { ok: true, skipped: true, reason: !endpoint ? 'no_endpoint' : 'disabled_or_empty' };
  }

  const effectiveFormat = detectFormat(endpoint, format);
  let body;
  let contentType;

  if (effectiveFormat === 'prometheus') {
    body = encodePrometheusText(metrics, { service: serviceName });
    contentType = 'text/plain; version=0.0.4';
  } else if (effectiveFormat === 'vm_json') {
    body = encodeVictoriaMetricsJson(metrics, { service: serviceName });
    contentType = 'application/json';
  } else {
    // OTLP JSON
    body = JSON.stringify(buildOtlpMetricsPayload({
      serviceName,
      serviceVersion,
      metrics,
    }));
    contentType = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        ...headers,
      },
      body,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      log(`[otel-metrics] non-2xx response from ${endpoint}: status=${res.status}`);
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }

    return { ok: true, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    // Fail open: log for debugging but do not rethrow
    log(`[otel-metrics] telemetry export failed: ${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Domain-specific helper: Emit consumer dispatch duration metric.
 */
export async function emitDispatchMetric({
  repository,
  prNumber,
  durationMs,
  status = 'success',
  backend = 'kubernetes',
  ...options
} = {}) {
  const durationSeconds = Number(durationMs) / 1000.0;
  const metrics = [
    createHistogramMetric({
      name: 'review_yeti.dispatch.duration_seconds',
      description: 'Duration of the consumer review dispatch shim in seconds',
      unit: 's',
      value: durationSeconds,
      bounds: [0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0],
      attributes: { repository, pr_number: prNumber, status, backend },
    }),
    createCounterMetric({
      name: 'review_yeti.dispatch.requests_total',
      description: 'Total number of review dispatch requests initiated',
      unit: '1',
      value: 1,
      attributes: { repository, status, backend },
    }),
  ];

  return sendMetrics(metrics, options);
}

/**
 * Domain-specific helper: Emit review verdict and finding metrics.
 */
export async function emitVerdictMetric({
  repository,
  prNumber,
  verdict = 'SHIP',
  p0Count = 0,
  p1Count = 0,
  p2Count = 0,
  durationMs,
  backend = 'kubernetes',
  ...options
} = {}) {
  const metrics = [
    createCounterMetric({
      name: 'review_yeti.verdicts_total',
      description: 'Total terminal review verdicts by outcome',
      unit: '1',
      value: 1,
      attributes: { repository, verdict, backend },
    }),
  ];

  if (p0Count > 0 || p1Count > 0 || p2Count > 0) {
    if (p0Count > 0) {
      metrics.push(createCounterMetric({
        name: 'review_yeti.findings_total',
        description: 'Defect findings identified during review',
        unit: '1',
        value: Number(p0Count),
        attributes: { repository, severity: 'P0' },
      }));
    }
    if (p1Count > 0) {
      metrics.push(createCounterMetric({
        name: 'review_yeti.findings_total',
        description: 'Defect findings identified during review',
        unit: '1',
        value: Number(p1Count),
        attributes: { repository, severity: 'P1' },
      }));
    }
    if (p2Count > 0) {
      metrics.push(createCounterMetric({
        name: 'review_yeti.findings_total',
        description: 'Defect findings identified during review',
        unit: '1',
        value: Number(p2Count),
        attributes: { repository, severity: 'P2' },
      }));
    }
  }

  if (durationMs !== undefined && durationMs !== null) {
    metrics.push(createHistogramMetric({
      name: 'review_yeti.review.duration_seconds',
      description: 'Total duration of review from execution start to terminal verdict',
      unit: 's',
      value: Number(durationMs) / 1000.0,
      attributes: { repository, verdict, backend },
    }));
  }

  return sendMetrics(metrics, options);
}

/**
 * Domain-specific helper: Emit provider / model inference telemetry.
 */
export async function emitProviderMetric({
  provider,
  model,
  ttftMs,
  totalMs,
  promptTokens = 0,
  completionTokens = 0,
  reasoningTokens = 0,
  errorType = null,
  status = errorType ? 'error' : 'success',
  ...options
} = {}) {
  const metrics = [
    createCounterMetric({
      name: 'review_yeti.provider.requests_total',
      description: 'Total API requests made to LLM providers',
      unit: '1',
      value: 1,
      attributes: { provider, model, status },
    }),
  ];

  if (ttftMs != null) {
    metrics.push(createHistogramMetric({
      name: 'review_yeti.provider.ttft_seconds',
      description: 'Time to first token in seconds for streamed model inferences',
      unit: 's',
      value: Number(ttftMs) / 1000.0,
      bounds: TTFT_BOUNDS_SECONDS,
      attributes: { provider, model },
    }));
  }

  if (totalMs != null) {
    metrics.push(createHistogramMetric({
      name: 'review_yeti.provider.duration_seconds',
      description: 'Total duration of model inference in seconds',
      unit: 's',
      value: Number(totalMs) / 1000.0,
      bounds: [0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 30.0, 60.0, 120.0],
      attributes: { provider, model, status },
    }));
  }

  if (promptTokens > 0) {
    metrics.push(createCounterMetric({
      name: 'review_yeti.provider.tokens_total',
      description: 'Cumulative tokens processed by model providers',
      unit: '1',
      value: Number(promptTokens),
      attributes: { provider, model, token_type: 'prompt' },
    }));
  }

  if (completionTokens > 0) {
    metrics.push(createCounterMetric({
      name: 'review_yeti.provider.tokens_total',
      description: 'Cumulative tokens processed by model providers',
      unit: '1',
      value: Number(completionTokens),
      attributes: { provider, model, token_type: 'completion' },
    }));
  }

  if (reasoningTokens > 0) {
    metrics.push(createCounterMetric({
      name: 'review_yeti.provider.tokens_total',
      description: 'Cumulative tokens processed by model providers',
      unit: '1',
      value: Number(reasoningTokens),
      attributes: { provider, model, token_type: 'reasoning' },
    }));
  }

  if (errorType) {
    metrics.push(createCounterMetric({
      name: 'review_yeti.provider.errors_total',
      description: 'Failures and errors encountered when invoking model providers',
      unit: '1',
      value: 1,
      attributes: { provider, model, error_type: errorType },
    }));
  }

  return sendMetrics(metrics, options);
}

/**
 * Domain-specific helper: Emit merge queue attestation metric.
 */
export async function emitMergeGroupMetric({
  repository,
  result = 'approved',
  durationMs,
  ...options
} = {}) {
  const metrics = [
    createCounterMetric({
      name: 'review_yeti.merge_group.evaluations_total',
      description: 'Total merge group reviews attested for merge queue',
      unit: '1',
      value: 1,
      attributes: { repository, result },
    }),
  ];

  if (durationMs != null) {
    metrics.push(createHistogramMetric({
      name: 'review_yeti.merge_group.duration_seconds',
      description: 'Time taken to verify merge group eligibility and publish gate',
      unit: 's',
      value: Number(durationMs) / 1000.0,
      bounds: [0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0],
      attributes: { repository, result },
    }));
  }

  return sendMetrics(metrics, options);
}

// CLI entrypoint
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  function getArg(flag, defaultValue = null) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
    return defaultValue;
  }

  try {
    if (command === 'emit-dispatch') {
      const res = await emitDispatchMetric({
        repository: getArg('--repo', process.env.GITHUB_REPOSITORY || 'unknown'),
        prNumber: getArg('--pr', process.env.PR_NUMBER || '0'),
        durationMs: Number(getArg('--duration-ms', 0)),
        status: getArg('--status', 'success'),
        backend: getArg('--backend', 'kubernetes'),
      });
      console.log(JSON.stringify(res));
    } else if (command === 'emit-verdict') {
      const res = await emitVerdictMetric({
        repository: getArg('--repo', process.env.GITHUB_REPOSITORY || 'unknown'),
        prNumber: getArg('--pr', process.env.PR_NUMBER || '0'),
        verdict: getArg('--verdict', 'SHIP'),
        p0Count: Number(getArg('--p0', 0)),
        p1Count: Number(getArg('--p1', 0)),
        p2Count: Number(getArg('--p2', 0)),
        durationMs: getArg('--duration-ms') ? Number(getArg('--duration-ms')) : null,
      });
      console.log(JSON.stringify(res));
    } else if (command === 'emit-merge-group') {
      const res = await emitMergeGroupMetric({
        repository: getArg('--repo', process.env.GITHUB_REPOSITORY || 'unknown'),
        result: getArg('--result', 'approved'),
        durationMs: getArg('--duration-ms') ? Number(getArg('--duration-ms')) : null,
      });
      console.log(JSON.stringify(res));
    } else if (command === 'emit-provider') {
      const res = await emitProviderMetric({
        provider: getArg('--provider', 'unknown'),
        model: getArg('--model', 'unknown'),
        ttftMs: getArg('--ttft-ms') ? Number(getArg('--ttft-ms')) : null,
        totalMs: getArg('--total-ms') ? Number(getArg('--total-ms')) : null,
        promptTokens: Number(getArg('--prompt-tokens', 0)),
        completionTokens: Number(getArg('--completion-tokens', 0)),
        errorType: getArg('--error-type', null),
      });
      console.log(JSON.stringify(res));
    } else if (command === '--help' || command === '-h' || !command) {
      console.log(`Review Yeti OpenTelemetry Metrics Emitter
Commands:
  emit-dispatch    Emit consumer dispatch duration and request count
  emit-verdict     Emit review verdict and findings count
  emit-provider    Emit LLM provider request, latency, and token metrics
  emit-merge-group Emit merge group gate verification telemetry
`);
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    // Fail open in CLI
    console.error(`[otel-metrics] error: ${err.message}`);
    process.exit(0);
  }
}

if (isEntrypoint(import.meta.url)) {
  main();
}
