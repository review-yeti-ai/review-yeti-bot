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
}

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

  constructor(options: ProgressEventForwarderOptions = {}) {
    this.onFailure = options.onFailure;
    this.sanitize = options.sanitize || sanitizeProgressEvent;
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

    try {
      Promise.resolve(sink.publish(sanitized)).catch(() => {
        this.reportFailure('sink_publish_failed');
      });
    } catch {
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
