import { initTracer, getTracer, runInSpan } from './tracer';
import { initMetrics, getMetrics, getPrometheusMetrics, flushMetrics, resolveOtlpMetricsEndpoint } from './metrics';
import { getRecentSpans, clearSpans, formatSpan } from './spans';
import { telemetryMiddleware } from './middleware';

export function initTelemetry(serviceName = 'review-yeti-bot') {
  initTracer(serviceName);
  initMetrics();
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
  getRecentSpans,
  clearSpans,
  formatSpan,
  telemetryMiddleware,
};
