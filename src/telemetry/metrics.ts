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

let meterProvider: MeterProvider | null = null;
let metricReader: PeriodicExportingMetricReader | null = null;

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
  runSecretOwnerReferenceAttachFailures: Counter;
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
}

let metricsInstance: MetricCounters | null = null;

export function initMetrics(): MetricCounters {
  if (metricsInstance) {
    return metricsInstance;
  }

  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  metricReader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60000,
  });

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
    ],
    readers: [metricReader],
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
    runSecretOwnerReferenceAttachFailures: meter.createCounter('review_yeti_run_secret_owner_reference_attach_failure_total', {
      description: 'Run Secret ownerReference attach attempts (REL-896) that failed and were tolerated; cleanup remains bounded by the existing reapers.',
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
