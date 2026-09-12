import {
  isSanitizedProgressEvent,
  type SanitizedProgressEvent,
} from './reviewEventRedaction';
import { REVIEW_EVENT_MAX_BYTES } from './reviewYetiEvent';

export const REVIEW_PROGRESS_SUBJECT_PREFIX = 'ct.review.progress.v1';
export const REVIEW_PROGRESS_SUBJECT_MAX_LENGTH = 64;

/**
 * Minimal transport seam for this lane. The NATS client adapter is injected by
 * the DOKS wiring task, so the sanitizer/sink contract stays independently
 * compilable and testable without a transport dependency.
 */
export interface ProgressPublisher {
  publish(subject: string, payload: Uint8Array, options: { messageId: string }): Promise<void>;
}

export type JetStreamProgressSinkErrorCode =
  | 'not_configured'
  | 'invalid_envelope'
  | 'not_serializable'
  | 'payload_too_large'
  | 'publish_failed';

export class JetStreamProgressSinkError extends Error {
  public readonly name = 'JetStreamProgressSinkError';

  constructor(public readonly code: JetStreamProgressSinkErrorCode) {
    super(`Review progress publication failed: ${code}`);
  }
}

export interface JetStreamProgressSinkOptions {
  enabled?: boolean;
  publisher?: ProgressPublisher;
}

export type JetStreamProgressPublishResult =
  | { published: true; subject: string; messageId: string }
  | { published: false; reason: 'disabled' };

export function progressSubjectFor(event: SanitizedProgressEvent): string {
  return `${REVIEW_PROGRESS_SUBJECT_PREFIX}.repo-${event.repository_id}.pr-${event.pr_number}`;
}

function encode(event: SanitizedProgressEvent): Uint8Array {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(event);
  } catch {
    throw new JetStreamProgressSinkError('not_serializable');
  }
  if (serialized === undefined) throw new JetStreamProgressSinkError('not_serializable');

  const payload = Buffer.from(serialized, 'utf8');
  if (payload.byteLength > REVIEW_EVENT_MAX_BYTES) {
    throw new JetStreamProgressSinkError('payload_too_large');
  }
  return payload;
}

export class JetStreamProgressSink {
  private readonly enabled: boolean;
  private readonly publisher?: ProgressPublisher;

  constructor(options: JetStreamProgressSinkOptions = {}) {
    this.enabled = options.enabled === true;
    this.publisher = options.publisher;
  }

  public async publish(event: SanitizedProgressEvent): Promise<JetStreamProgressPublishResult> {
    if (!isSanitizedProgressEvent(event)) {
      throw new JetStreamProgressSinkError('invalid_envelope');
    }
    if (!this.enabled) return { published: false, reason: 'disabled' };
    if (!this.publisher) throw new JetStreamProgressSinkError('not_configured');

    const subject = progressSubjectFor(event);
    if (subject.length > REVIEW_PROGRESS_SUBJECT_MAX_LENGTH) {
      throw new JetStreamProgressSinkError('invalid_envelope');
    }
    const payload = encode(event);

    try {
      await this.publisher.publish(subject, payload, { messageId: event.event_id });
    } catch {
      throw new JetStreamProgressSinkError('publish_failed');
    }

    return { published: true, subject, messageId: event.event_id };
  }
}
