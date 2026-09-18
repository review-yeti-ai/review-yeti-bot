import { Counter, Histogram, UpDownCounter } from '@opentelemetry/api';
import {
  MeterProvider,
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  ExplicitBucketHistogramAggregation,
  View,
  InstrumentType,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { JEV_INPUT_TOKEN_USD_PER_MILLION } from '../types/jevContract';

let metricsInstance: MetricCounters | null = null;
let metricReader: PeriodicExportingMetricReader | null = null;
let otlpReader: PeriodicExportingMetricReader | null = null;
let meterProvider: MeterProvider | null = null;

/**
 * REL-904: resolve the OTLP push endpoint for ephemeral workers.
 *
 * Worker pods are short-lived Kubernetes Jobs and cannot be scraped; the only way
 * their lane/provider telemetry reaches VictoriaMetrics is a one-shot OTLP push to
 * the otel-collector before process exit. The endpoint is opt-in via env so local
 * and dispatcher processes stay push-free unless configured.
 */
export function resolveOtlpMetricsEndpoint(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = String(env.REVIEW_YETI_OTEL_METRICS_ENDPOINT || env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || '').trim();
  return value.length > 0 ? value : null;
}

/** Best-effort one-shot export of accumulated metrics before a worker pod exits. */
export async function flushMetrics(
  timeoutMs = 5000,
  readersOverride?: Array<{ forceFlush: () => Promise<void> }>,
): Promise<void> {
  // REL-904: the single OTLP gate lives in initMetrics -- readers only exist when
  // an endpoint is configured -- so flushing is safe to call unconditionally and
  // is a no-op with nothing to export. `readersOverride` lets tests inject spy
  // readers to exercise the with-readers branch without a collector.
  const readers: Array<{ forceFlush: () => Promise<void> }> = readersOverride ??
    [otlpReader, metricReader].filter((reader): reader is PeriodicExportingMetricReader => reader !== null);
  if (readers.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([
      Promise.all(readers.map((reader) => reader.forceFlush())),
      timeout,
    ]);
  } catch (_) {
    // Telemetry must never fail a review: swallow export errors after the timeout guard.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface MetricCounters {
  tokensPrompt: Counter;
  tokensCompletion: Counter;
  tokensTotal: Counter;
  modelCostUsd: Counter;
  reviewDuration: Histogram;
  personaDuration: Histogram;
  indexerAstDuration: Histogram;
  indexerFilesIndexed: Counter;
  indexerSymbolsExtracted: Counter;
  arbiterVerdicts: Counter;
  jobsQueued: Counter;
  jobsDispatched: Counter;
  reviewReaperDeliveryIdentityMismatches: Counter;
  reviewReaperSupersededAttempts: Counter;
  reviewReaperSwept: Counter;
  reviewReaperPublished: Counter;
  reviewReaperFailed: Counter;
  reviewReaperRetiredNonPublishable: Counter;
  /** REL-896: runs claimed via the operator's delegated-failure signal rather than terminal_deadline. */
  reviewReaperDelegated: Counter;
  /** REL-904: terminal lane outcomes for lane/provider attribution. */
  laneOutcomes: Counter;
  /** A lane's turn-accumulation telemetry failed `personaTelemetrySchema` validation and was
   * omitted from the published/reported result rather than failing the review. Non-zero here
   * means measurement is degraded for that lane, not that the review itself is unhealthy. */
  personaTelemetryDropped: Counter;
  activeJobs: UpDownCounter;
  queuedJobs: UpDownCounter;

  // Pre-checks instruments (Zoekt & Analyzers)
  zoektQueries: Counter;
  zoektDuration: Histogram;
  zoektSymbolsScanned: Counter;
  zoektSymbolsMatched: Counter;
  zoektTruncatedTotal: Counter;
  analyzersExecuted: Counter;
  analyzersDuration: Histogram;
  analyzerHypotheses: Counter;
  preCheckTotalDuration: Histogram;

  // Jev (TypeSafe AI System One) instruments.
  jevRequests: Counter;
  jevInputTokens: Counter;
  jevCostUsd: Counter;
  jevDuration: Histogram;
  /** A real "calibrated thresholds are stale" condition, not an outage -- see jevClient.ts. */
  jevModelPinMismatch: Counter;
  /**
   * REL-677 / ADR 0329: wall-clock time to materialize the read-only worktree and build the
   * throwaway Zoekt index for one review run (`src/mcp/zoektGrounding.js`), *not* the query
   * time against that index once built (`zoektDuration` above covers that). This is fixed setup
   * cost paid on every grounded review, distinct from persona lane time, and is the number the
   * REL-677 latency trade-off (setup cost vs. turns saved by grounded lookups) is judged against.
   */
  zoektIndexBuildDuration: Histogram;
}

export function initMetrics(env: NodeJS.ProcessEnv = process.env): MetricCounters {
  if (metricsInstance) {
    return metricsInstance;
  }

  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  metricReader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60000,
  });

  const readers: PeriodicExportingMetricReader[] = [metricReader];

  // REL-904: ephemeral workers push lane/provider metrics to the otel-collector so
  // VictoriaMetrics can attribute lane outcomes after the pod is reaped. The
  // collector is already scraped on :8889, so a successful push is sufficient --
  // no per-worker scrape target exists or is wanted.
  const otlpEndpoint = resolveOtlpMetricsEndpoint(env);
  if (otlpEndpoint) {
    otlpReader = new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: otlpEndpoint }),
      // Short-lived jobs: export shortly after the first measurement so the
      // end-of-run flush has durable data even if forceFlush is interrupted.
      exportIntervalMillis: 15000,
    });
    readers.push(otlpReader);
  }

  meterProvider = new MeterProvider({
    views: [
      new View({
        instrumentName: 'review_yeti_review_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120]),
      }),
      new View({
        instrumentName: 'review_yeti_persona_execution_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.1, 0.5, 1, 2.5, 5, 10, 30, 60]),
      }),
      new View({
        instrumentName: 'review_yeti_indexer_ast_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]),
      }),
      new View({
        instrumentName: 'review_yeti_zoekt_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]),
      }),
      new View({
        instrumentName: 'review_yeti_analyzers_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.1, 0.5, 1, 2.5, 5, 10, 30, 60]),
      }),
      new View({
        instrumentName: 'review_yeti_pre_checks_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.1, 0.5, 1, 2.5, 5, 10, 30, 60]),
      }),
      new View({
        instrumentName: 'review_yeti_jev_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]),
      }),
    ],
    readers,
  });

  const meter = meterProvider.getMeter('review-yeti-bot');

  metricsInstance = {
    tokensPrompt: meter.createCounter('review_yeti_tokens_prompt_total', {
      description: 'Total prompt tokens consumed.',
    }),
    tokensCompletion: meter.createCounter('review_yeti_tokens_completion_total', {
      description: 'Total completion tokens consumed.',
    }),
    tokensTotal: meter.createCounter('review_yeti_tokens_total', {
      description: 'Cumulative tokens consumed.',
    }),
    modelCostUsd: meter.createCounter('review_yeti_model_cost_usd_total', {
      description: 'Cumulative cost in USD.',
    }),
    reviewDuration: meter.createHistogram('review_yeti_review_duration_seconds', {
      description: 'Review pipeline execution duration in seconds.',
    }),
    personaDuration: meter.createHistogram('review_yeti_persona_execution_duration_seconds', {
      description: 'Individual persona lane latency.',
    }),
    indexerAstDuration: meter.createHistogram('review_yeti_indexer_ast_duration_seconds', {
      description: 'AST parsing latency.',
    }),
    indexerFilesIndexed: meter.createCounter('review_yeti_indexer_files_indexed_total', {
      description: 'Total files parsed.',
    }),
    indexerSymbolsExtracted: meter.createCounter('review_yeti_indexer_symbols_extracted_total', {
      description: 'Total symbols extracted.',
    }),
    arbiterVerdicts: meter.createCounter('review_yeti_arbiter_verdicts_total', {
      description: 'Arbiter final verdict count.',
    }),
    jobsQueued: meter.createCounter('review_yeti_queue_jobs_queued_total', {
      description: 'Total queue jobs queued.',
    }),
    jobsDispatched: meter.createCounter('review_yeti_queue_jobs_dispatched_total', {
      description: 'Total queue jobs dispatched.',
    }),
    reviewReaperDeliveryIdentityMismatches: meter.createCounter('review_yeti_review_reaper_delivery_identity_mismatch_total', {
      description: 'Abandoned review runs quarantined because run and outbox delivery identities differed.',
    }),
    reviewReaperSupersededAttempts: meter.createCounter('review_yeti_review_reaper_superseded_attempt_total', {
      description: 'Abandoned review attempts retired because a completed newer same-head App check already exists.',
    }),
    reviewReaperSwept: meter.createCounter('review_yeti_review_reaper_swept_total', {
      description: 'Abandoned publishing runs claimed by the reaper per cycle, before reconciliation.',
    }),
    reviewReaperPublished: meter.createCounter('review_yeti_review_reaper_published_total', {
      description: 'Abandoned publishing runs for which the reaper published a fail-closed check.',
    }),
    reviewReaperFailed: meter.createCounter('review_yeti_review_reaper_failed_total', {
      description: 'Abandoned publishing run reconciliations that could not be completed this cycle.',
    }),
    reviewReaperRetiredNonPublishable: meter.createCounter('review_yeti_review_reaper_retired_non_publishable_total', {
      description: 'Queued or running runs retired because their publication mode has no App check to fail closed.',
    }),
    reviewReaperDelegated: meter.createCounter('review_yeti_review_reaper_delegated_total', {
      description: 'Abandoned publishing runs claimed via the Kubernetes operator delegated-failure signal (REL-896) rather than terminal_deadline.',
    }),
    laneOutcomes: meter.createCounter('review_yeti_lane_outcome_total', {
      description: 'Persona lane terminal outcomes tagged by persona, outcome, failure class, and transport (REL-904 lane/provider attribution).',
    }),
    personaTelemetryDropped: meter.createCounter('review_yeti_persona_telemetry_dropped_total', {
      description: 'Per-persona turn-usage telemetry that failed schema validation and was omitted from the result rather than failing the review.',
    }),
    activeJobs: meter.createUpDownCounter('review_yeti_queue_active_jobs', {
      description: 'Current active review jobs.',
    }),
    queuedJobs: meter.createUpDownCounter('review_yeti_queue_queued_jobs', {
      description: 'Current queued review jobs.',
    }),

    // Pure review_yeti pre-check instruments (no ct_ prefix)
    zoektQueries: meter.createCounter('review_yeti_zoekt_queries_total', {
      description: 'Total Zoekt search queries dispatched.',
    }),
    zoektDuration: meter.createHistogram('review_yeti_zoekt_duration_seconds', {
      description: 'Zoekt query pool execution duration in seconds.',
    }),
    zoektSymbolsScanned: meter.createCounter('review_yeti_zoekt_symbols_scanned_total', {
      description: 'Candidate symbols extracted from diffs.',
    }),
    zoektSymbolsMatched: meter.createCounter('review_yeti_zoekt_symbols_matched_total', {
      description: 'Cross-file symbols discovered via Zoekt.',
    }),
    zoektTruncatedTotal: meter.createCounter('review_yeti_zoekt_truncated_total', {
      description: 'Zoekt pre-check executions clamped by max_symbols.',
    }),
    analyzersExecuted: meter.createCounter('review_yeti_analyzers_executed_total', {
      description: 'Total static analyzer invocations tagged by tool.',
    }),
    analyzersDuration: meter.createHistogram('review_yeti_analyzers_duration_seconds', {
      description: 'Sandbox analyzer runner latency in seconds.',
    }),
    analyzerHypotheses: meter.createCounter('review_yeti_analyzer_hypotheses_total', {
      description: 'Candidate hypotheses generated tagged by tool, category, and severity.',
    }),
    preCheckTotalDuration: meter.createHistogram('review_yeti_pre_checks_duration_seconds', {
      description: 'Combined pre-checks latency in seconds.',
    }),

    jevRequests: meter.createCounter('review_yeti_jev_requests_total', {
      description: 'Jev (TypeSafe AI System One) ask() calls tagged by seam and outcome (ok, or an unavailable reason).',
    }),
    jevInputTokens: meter.createCounter('review_yeti_jev_input_tokens_total', {
      description: 'Jev input tokens consumed on successful calls. Output tokens are unmetered/free.',
    }),
    jevCostUsd: meter.createCounter('review_yeti_jev_cost_usd_total', {
      description: `Cumulative Jev cost in USD (input_tokens x $${JEV_INPUT_TOKEN_USD_PER_MILLION} / 1e6).`,
    }),
    jevDuration: meter.createHistogram('review_yeti_jev_duration_seconds', {
      description: 'Jev ask() call duration in seconds, tagged by seam and outcome.',
    }),
    jevModelPinMismatch: meter.createCounter('review_yeti_jev_model_pin_mismatch_total', {
      description: 'Successful Jev responses whose versioned model differed from TYPESAFE_MODEL_PIN -- calibrated thresholds are stale, not an outage.',
    }),
    zoektIndexBuildDuration: meter.createHistogram('review_yeti_zoekt_index_build_duration_seconds', {
      description: 'REL-677: time to materialize the review worktree and build the throwaway Zoekt index for one run, excluding query time.',
    }),
  };

  return metricsInstance;
}

export function getMetrics(): MetricCounters {
  if (!metricsInstance) {
    return initMetrics();
  }
  return metricsInstance;
}

function formatAttributes(attrs: Record<string, any>): string {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return '';
  const pairs = keys.map((k) => `${k}="${String(attrs[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${pairs.join(',')}}`;
}

function formatAttributesWithExtra(attrs: Record<string, any>, extraKey: string, extraVal: string): string {
  const merged = { ...attrs, [extraKey]: extraVal };
  return formatAttributes(merged);
}

export async function getPrometheusMetrics(): Promise<string> {
  if (!metricReader) {
    initMetrics();
  }

  const { resourceMetrics } = await metricReader!.collect();
  const lines: string[] = [];

  // Track exported metric names
  const exportedNames = new Set<string>();

  for (const scopeMetric of resourceMetrics.scopeMetrics || []) {
    for (const metric of scopeMetric.metrics || []) {
      const { name, description } = metric.descriptor;
      exportedNames.add(name);
      const typeStr = metric.descriptor.type.toLowerCase();

      lines.push(`# HELP ${name} ${description || ''}`);
      if (metric.descriptor.type === 'HISTOGRAM') {
        lines.push(`# TYPE ${name} histogram`);
      } else if (metric.descriptor.type === 'UP_DOWN_COUNTER' || typeStr.includes('updown') || typeStr.includes('gauge')) {
        lines.push(`# TYPE ${name} gauge`);
      } else {
        lines.push(`# TYPE ${name} counter`);
      }

      const dataPoints = metric.dataPoints || [];
      if (dataPoints.length === 0) {
        if (metric.descriptor.type === 'HISTOGRAM') {
          lines.push(`${name}_bucket{le="+Inf"} 0`);
          lines.push(`${name}_sum 0`);
          lines.push(`${name}_count 0`);
        } else {
          lines.push(`${name} 0`);
        }
      } else {
        for (const dp of dataPoints) {
          const attrs = dp.attributes || {};

          if (metric.descriptor.type === 'HISTOGRAM' || typeof dp.value === 'object') {
            const valObj = dp.value as any;
            const boundaries: number[] = valObj.buckets?.boundaries || [];
            const counts: number[] = valObj.buckets?.counts || [];
            const totalCount = valObj.count ?? 0;
            const sum = valObj.sum ?? 0;

            let cumulative = 0;
            for (let i = 0; i < boundaries.length; i++) {
              cumulative += counts[i] || 0;
              const labelStr = formatAttributesWithExtra(attrs, 'le', String(boundaries[i]));
              lines.push(`${name}_bucket${labelStr} ${cumulative}`);
            }
            if (counts.length > boundaries.length) {
              cumulative += counts[boundaries.length] || 0;
            }
            const infLabelStr = formatAttributesWithExtra(attrs, 'le', '+Inf');
            lines.push(`${name}_bucket${infLabelStr} ${totalCount}`);

            const attrStr = formatAttributes(attrs);
            lines.push(`${name}_sum${attrStr} ${sum}`);
            lines.push(`${name}_count${attrStr} ${totalCount}`);
          } else {
            const attrStr = formatAttributes(attrs);
            lines.push(`${name}${attrStr} ${dp.value}`);
          }
        }
      }
    }
  }

  // Ensure all known instruments are present in output
  const knownInstruments = [
    // Pure review_yeti pre-check instruments
    { name: 'review_yeti_zoekt_queries_total', desc: 'Total Zoekt search queries dispatched.', type: 'counter' },
    { name: 'review_yeti_zoekt_duration_seconds', desc: 'Zoekt query pool execution duration in seconds.', type: 'histogram' },
    { name: 'review_yeti_zoekt_symbols_scanned_total', desc: 'Candidate symbols extracted from diffs.', type: 'counter' },
    { name: 'review_yeti_zoekt_symbols_matched_total', desc: 'Cross-file symbols discovered via Zoekt.', type: 'counter' },
    { name: 'review_yeti_zoekt_truncated_total', desc: 'Zoekt pre-check executions clamped by max_symbols.', type: 'counter' },
    { name: 'review_yeti_analyzers_executed_total', desc: 'Total static analyzer invocations tagged by tool.', type: 'counter' },
    { name: 'review_yeti_analyzers_duration_seconds', desc: 'Sandbox analyzer runner latency in seconds.', type: 'histogram' },
    { name: 'review_yeti_analyzer_hypotheses_total', desc: 'Candidate hypotheses generated tagged by tool, category, and severity.', type: 'counter' },
    { name: 'review_yeti_pre_checks_duration_seconds', desc: 'Combined pre-checks latency in seconds.', type: 'histogram' },

    // Pure review_yeti pipeline instruments
    { name: 'review_yeti_tokens_prompt_total', desc: 'Total prompt tokens consumed.', type: 'counter' },
    { name: 'review_yeti_tokens_completion_total', desc: 'Total completion tokens consumed.', type: 'counter' },
    { name: 'review_yeti_tokens_total', desc: 'Cumulative tokens consumed.', type: 'counter' },
    { name: 'review_yeti_model_cost_usd_total', desc: 'Cumulative cost in USD.', type: 'counter' },
    { name: 'review_yeti_review_duration_seconds', desc: 'Review pipeline execution duration in seconds.', type: 'histogram' },
    { name: 'review_yeti_persona_execution_duration_seconds', desc: 'Individual persona lane latency.', type: 'histogram' },
    { name: 'review_yeti_indexer_ast_duration_seconds', desc: 'AST parsing latency.', type: 'histogram' },
    { name: 'review_yeti_indexer_files_indexed_total', desc: 'Total files parsed.', type: 'counter' },
    { name: 'review_yeti_indexer_symbols_extracted_total', desc: 'Total symbols extracted.', type: 'counter' },
    { name: 'review_yeti_arbiter_verdicts_total', desc: 'Arbiter final verdict count.', type: 'counter' },
    { name: 'review_yeti_queue_jobs_queued_total', desc: 'Total queue jobs queued.', type: 'counter' },
    { name: 'review_yeti_queue_jobs_dispatched_total', desc: 'Total queue jobs dispatched.', type: 'counter' },
    { name: 'review_yeti_review_reaper_delivery_identity_mismatch_total', desc: 'Abandoned review runs quarantined because run and outbox delivery identities differed.', type: 'counter' },
    { name: 'review_yeti_review_reaper_superseded_attempt_total', desc: 'Abandoned review attempts retired because a completed newer same-head App check already exists.', type: 'counter' },
    { name: 'review_yeti_queue_active_jobs', desc: 'Current active review jobs.', type: 'gauge' },
    { name: 'review_yeti_queue_queued_jobs', desc: 'Current queued review jobs.', type: 'gauge' },
    { name: 'review_yeti_lane_outcome_total', desc: 'Persona lane terminal outcomes tagged by persona, outcome, failure class, and transport (REL-904).', type: 'counter' },
  ];

  for (const inst of knownInstruments) {
    if (!exportedNames.has(inst.name)) {
      lines.push(`# HELP ${inst.name} ${inst.desc}`);
      lines.push(`# TYPE ${inst.name} ${inst.type}`);
      if (inst.type === 'histogram') {
        lines.push(`${inst.name}_bucket{le="+Inf"} 0`);
        lines.push(`${inst.name}_sum 0`);
        lines.push(`${inst.name}_count 0`);
      } else {
        lines.push(`${inst.name} 0`);
      }
    }
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
