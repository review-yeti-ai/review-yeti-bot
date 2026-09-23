import { initTracer, getTracer, runInSpan } from './tracer';
import {
  initMetrics,
  getMetrics,
  getPrometheusMetrics,
  flushMetrics,
  resolveOtlpMetricsEndpoint,
  metricsResourceFor,
  type MetricsProcessIdentity,
} from './metrics';
import { getRecentSpans, clearSpans, formatSpan } from './spans';
import { telemetryMiddleware } from './middleware';

/**
 * `serviceInstanceId` is for long-lived replicas only (REL-1053): it labels
 * this process's pushed metrics so several replicas do not overwrite one
 * another. Leave it unset for ephemeral workers.
 */
export function initTelemetry(serviceName = 'review-yeti-bot', options: { serviceInstanceId?: string } = {}) {
  initTracer(serviceName);
  initMetrics(process.env, options.serviceInstanceId
    ? { serviceName, serviceInstanceId: options.serviceInstanceId }
    : undefined);
}

export {
  initTracer,
  getTracer,
  runInSpan,
  initMetrics,
  getMetrics,
  getPrometheusMetrics,
  flushMetrics,
  resolveOtlpMetricsEndpoint,
  metricsResourceFor,
  getRecentSpans,
  clearSpans,
  formatSpan,
  telemetryMiddleware,
};
export type { MetricsProcessIdentity };
