import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  ExplicitBucketHistogramAggregation,
  View,
  InstrumentType,
} from '@opentelemetry/sdk-metrics';

let meterProvider: MeterProvider | null = null;
let metricReader: PeriodicExportingMetricReader | null = null;

export interface MetricCounters {
  tokensPrompt: ReturnType<any>;
  tokensCompletion: ReturnType<any>;
  tokensTotal: ReturnType<any>;
  modelCostUsd: ReturnType<any>;
  reviewDuration: ReturnType<any>;
  personaDuration: ReturnType<any>;
  indexerAstDuration: ReturnType<any>;
  indexerFilesIndexed: ReturnType<any>;
  indexerSymbolsExtracted: ReturnType<any>;
  arbiterVerdicts: ReturnType<any>;
}

let metricsInstance: MetricCounters | null = null;

export function initMetrics(): MetricCounters {
  if (metricsInstance) {
    return metricsInstance;
  }

  const exporter = new InMemoryMetricExporter(0);
  metricReader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60000,
  });

  meterProvider = new MeterProvider({
    views: [
      new View({
        instrumentName: 'ct_review_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120]),
      }),
      new View({
        instrumentName: 'ct_persona_execution_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.1, 0.5, 1, 2.5, 5, 10, 30, 60]),
      }),
      new View({
        instrumentName: 'ct_indexer_ast_duration_seconds',
        instrumentType: InstrumentType.HISTOGRAM,
        aggregation: new ExplicitBucketHistogramAggregation([0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]),
      }),
    ],
    readers: [metricReader],
  });

  const meter = meterProvider.getMeter('ct-review-bot');

  metricsInstance = {
    tokensPrompt: meter.createCounter('ct_review_tokens_prompt_total', {
      description: 'Total prompt tokens consumed.',
    }),
    tokensCompletion: meter.createCounter('ct_review_tokens_completion_total', {
      description: 'Total completion tokens consumed.',
    }),
    tokensTotal: meter.createCounter('ct_review_tokens_total', {
      description: 'Cumulative tokens consumed.',
    }),
    modelCostUsd: meter.createCounter('ct_review_model_cost_usd_total', {
      description: 'Cumulative cost in USD.',
    }),
    reviewDuration: meter.createHistogram('ct_review_duration_seconds', {
      description: 'Review pipeline execution duration in seconds.',
    }),
    personaDuration: meter.createHistogram('ct_persona_execution_duration_seconds', {
      description: 'Individual persona lane latency.',
    }),
    indexerAstDuration: meter.createHistogram('ct_indexer_ast_duration_seconds', {
      description: 'AST parsing latency.',
    }),
    indexerFilesIndexed: meter.createCounter('ct_indexer_files_indexed_total', {
      description: 'Total files parsed.',
    }),
    indexerSymbolsExtracted: meter.createCounter('ct_indexer_symbols_extracted_total', {
      description: 'Total symbols extracted.',
    }),
    arbiterVerdicts: meter.createCounter('ct_arbiter_verdicts_total', {
      description: 'Arbiter final verdict count.',
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
    { name: 'ct_review_tokens_prompt_total', desc: 'Total prompt tokens consumed.', type: 'counter' },
    { name: 'ct_review_tokens_completion_total', desc: 'Total completion tokens consumed.', type: 'counter' },
    { name: 'ct_review_tokens_total', desc: 'Cumulative tokens consumed.', type: 'counter' },
    { name: 'ct_review_model_cost_usd_total', desc: 'Cumulative cost in USD.', type: 'counter' },
    { name: 'ct_review_duration_seconds', desc: 'Review pipeline execution duration in seconds.', type: 'histogram' },
    { name: 'ct_persona_execution_duration_seconds', desc: 'Individual persona lane latency.', type: 'histogram' },
    { name: 'ct_indexer_ast_duration_seconds', desc: 'AST parsing latency.', type: 'histogram' },
    { name: 'ct_indexer_files_indexed_total', desc: 'Total files parsed.', type: 'counter' },
    { name: 'ct_indexer_symbols_extracted_total', desc: 'Total symbols extracted.', type: 'counter' },
    { name: 'ct_arbiter_verdicts_total', desc: 'Arbiter final verdict count.', type: 'counter' },
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
