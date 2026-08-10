export const REVIEW_TELEMETRY_VERSION: 'review-telemetry-v1';

export type ReviewTelemetryPhase = 'review' | 'model' | 'arbitration' | 'publication' | 'telemetry';
export type ReviewTelemetryOutcome = 'started' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'unavailable';
export type ReviewTelemetryFailureClass = 'provider_unavailable' | 'provider_timeout' | 'provider_invalid_response' | 'publication_unavailable' | 'export_unavailable' | 'cancelled' | 'unknown';

export interface ReviewTelemetryEvent {
  schemaVersion: 'review-telemetry-v1';
  eventId: string;
  occurredAt: string;
  phase: ReviewTelemetryPhase;
  unitId: string;
  outcome: ReviewTelemetryOutcome;
  personaId?: string;
  providerId?: string;
  modelId?: string;
  failureClass?: ReviewTelemetryFailureClass;
  latencyMs?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens: number; costUSD?: number };
}

export interface ReviewTelemetrySink { emit(event: ReviewTelemetryEvent): Promise<void> | void; }
export interface ReviewTelemetry {
  record(event: Omit<ReviewTelemetryEvent, 'schemaVersion' | 'eventId' | 'occurredAt' | 'personaId'> & { personaId?: string; usage?: { receiptId?: string; promptTokens?: number; completionTokens?: number; costUSD?: number } }): ReviewTelemetryEvent;
  flush(options?: { signal?: AbortSignal }): Promise<{ status: 'noop' | 'exported' | 'unavailable' | 'cancelled'; pending: number; events: number }>;
}

export function createNoopReviewTelemetrySink(): ReviewTelemetrySink;
export function createReviewTelemetry(options?: { identity?: object; sink?: ReviewTelemetrySink; exporter?: { endpoint: string; credential?: string; timeoutMs?: number; signal?: AbortSignal; fetchImplementation: typeof fetch }; clock?: () => number }): ReviewTelemetry;
