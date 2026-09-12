import {
  ReviewEventRejection,
  sanitizeProgressEvent,
  type ReviewEventRejectionCode,
  type ReviewEventIdentityInput,
  type SanitizedProgressEvent,
} from './reviewEventRedaction';
import type { LiveStreamEvent } from '../types/live';

export interface ProgressEventSink {
  publish(event: SanitizedProgressEvent): Promise<unknown> | unknown;
}

export type ProgressEventIdentityProvider = (
  event: LiveStreamEvent,
) => ReviewEventIdentityInput | undefined;

export type ProgressEventForwardingFailureCode =
  | 'identity_resolution_failed'
  | 'sanitization_failed'
  | 'sanitization_rejected'
  | 'sink_overloaded'
  | 'sink_publish_failed';

export interface ProgressEventForwardingFailure {
  readonly code: ProgressEventForwardingFailureCode;
  readonly rejectionCode?: ReviewEventRejectionCode;
}

export type ProgressEventForwardingErrorHandler = (
  failure: ProgressEventForwardingFailure,
) => unknown;

export type ProgressEventSanitizer = typeof sanitizeProgressEvent;

export interface ProgressEventForwarderOptions {
  sink?: ProgressEventSink;
  identityProvider?: ProgressEventIdentityProvider;
  onFailure?: ProgressEventForwardingErrorHandler;
  sanitize?: ProgressEventSanitizer;
  maxInFlight?: number;
}

export const DEFAULT_PROGRESS_SINK_MAX_IN_FLIGHT = 32;
export const MAX_PROGRESS_SINK_MAX_IN_FLIGHT = 1_024;

/**
 * Bridges permissive in-process live events to an optional progress sink.
 * Sanitization remains the only path that can produce the sink's branded
 * envelope; failures are reduced to bounded codes for the owning bus to
 * contain and report.
 */
export class ProgressEventForwarder {
  private sink?: ProgressEventSink;
  private identityProvider?: ProgressEventIdentityProvider;
  private readonly onFailure?: ProgressEventForwardingErrorHandler;
  private readonly sanitize: ProgressEventSanitizer;
  private readonly maxInFlight: number;
  private inFlight = 0;

  constructor(options: ProgressEventForwarderOptions = {}) {
    const maxInFlight = options.maxInFlight ?? DEFAULT_PROGRESS_SINK_MAX_IN_FLIGHT;
    if (!Number.isSafeInteger(maxInFlight)
      || maxInFlight < 1
      || maxInFlight > MAX_PROGRESS_SINK_MAX_IN_FLIGHT) {
      throw new RangeError('Progress sink maxInFlight is outside its allowed bound');
    }
    this.onFailure = options.onFailure;
    this.sanitize = options.sanitize || sanitizeProgressEvent;
    this.maxInFlight = maxInFlight;
    this.setProgressSink(options.sink, options.identityProvider);
  }

  public setProgressSink(
    sink?: ProgressEventSink,
    identityProvider?: ProgressEventIdentityProvider,
  ): void {
    this.sink = sink;
    this.identityProvider = identityProvider;
  }

  public forward(event: LiveStreamEvent): void {
    const sink = this.sink;
    const identityProvider = this.identityProvider;
    if (!sink || !identityProvider) return;
    if (this.inFlight >= this.maxInFlight) {
      this.reportFailure('sink_overloaded');
      return;
    }

    let identity: ReviewEventIdentityInput | undefined;
    try {
      identity = identityProvider(event);
    } catch {
      this.reportFailure('identity_resolution_failed');
      return;
    }
    if (!identity) return;

    let sanitized: SanitizedProgressEvent | ReviewEventRejection;
    try {
      sanitized = this.sanitize(event, identity);
    } catch {
      this.reportFailure('sanitization_failed');
      return;
    }
    if (sanitized instanceof ReviewEventRejection) {
      this.reportFailure('sanitization_rejected', sanitized.code);
      return;
    }

    this.inFlight += 1;
    try {
      Promise.resolve(sink.publish(sanitized)).then(
        () => { this.inFlight -= 1; },
        () => {
          this.inFlight -= 1;
          this.reportFailure('sink_publish_failed');
        },
      );
    } catch {
      this.inFlight -= 1;
      this.reportFailure('sink_publish_failed');
    }
  }

  private reportFailure(
    code: ProgressEventForwardingFailureCode,
    rejectionCode?: ReviewEventRejectionCode,
  ): void {
    const handler = this.onFailure;
    if (!handler) return;

    const failure: ProgressEventForwardingFailure = Object.freeze({
      code,
      ...(rejectionCode ? { rejectionCode } : {}),
    });
    try {
      void Promise.resolve(handler(failure)).catch(() => undefined);
    } catch {
      // Failure reporting must not escape the forwarding boundary.
    }
  }
}
