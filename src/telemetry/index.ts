import { initTracer, getTracer, runInSpan } from './tracer';
import { initMetrics, getMetrics, getPrometheusMetrics } from './metrics';
import { getRecentSpans, clearSpans, formatSpan } from './spans';
import { telemetryMiddleware } from './middleware';

export function initTelemetry(serviceName = 'ct-review-bot') {
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
  getRecentSpans,
  clearSpans,
  formatSpan,
  telemetryMiddleware,
};
