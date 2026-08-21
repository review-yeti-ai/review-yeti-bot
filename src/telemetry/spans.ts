import { ReadableSpan, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

export interface FormattedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: {
    code: string;
    message?: string;
  };
  attributes: Record<string, any>;
}

export class CircularSpanBufferExporter extends InMemorySpanExporter {
  private maxSpans: number;

  constructor(maxSpans = 500) {
    super();
    this.maxSpans = maxSpans;
  }

  export(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): void {
    super.export(spans, (result) => {
      const finished = (this as any)._finishedSpans;
      if (Array.isArray(finished) && finished.length > this.maxSpans) {
        finished.splice(0, finished.length - this.maxSpans);
      }
      resultCallback(result);
    });
  }
}

export const inMemorySpanExporter = new CircularSpanBufferExporter(500);

function hrTimeToISO(hrTime: [number, number]): string {
  const ms = hrTime[0] * 1000 + hrTime[1] / 1e6;
  return new Date(ms).toISOString();
}

function hrTimeToMs(hrTime: [number, number]): number {
  return Math.round((hrTime[0] * 1000 + hrTime[1] / 1e6) * 100) / 100;
}

const SPAN_KIND_NAMES: Record<number, string> = {
  0: 'INTERNAL',
  1: 'SERVER',
  2: 'CLIENT',
  3: 'PRODUCER',
  4: 'CONSUMER',
};

const SPAN_STATUS_NAMES: Record<number, string> = {
  0: 'UNSET',
  1: 'OK',
  2: 'ERROR',
};

export function formatSpan(span: ReadableSpan): FormattedSpan {
  const ctx = span.spanContext();
  const kindName = SPAN_KIND_NAMES[span.kind] || 'INTERNAL';
  const statusCode = SPAN_STATUS_NAMES[span.status.code] || 'OK';

  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: kindName,
    startTime: hrTimeToISO(span.startTime),
    endTime: hrTimeToISO(span.endTime),
    durationMs: hrTimeToMs(span.duration),
    status: {
      code: statusCode,
      message: span.status.message,
    },
    attributes: { ...span.attributes },
  };
}

export function getRecentSpans(query?: { limit?: number; traceId?: string; name?: string }): FormattedSpan[] {
  let spans = inMemorySpanExporter.getFinishedSpans();
  let formatted = spans.map(formatSpan);

  if (query?.traceId) {
    formatted = formatted.filter((s) => s.traceId === query.traceId);
  }
  if (query?.name) {
    formatted = formatted.filter((s) => s.name === query.name);
  }

  const limit = query?.limit && query.limit > 0 ? query.limit : 100;
  return formatted.slice(-limit);
}

export function clearSpans(): void {
  inMemorySpanExporter.reset();
}
