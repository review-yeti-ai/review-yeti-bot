import {
  isSanitizedProgressEvent,
  type SanitizedProgressEvent,
} from './reviewEventRedaction';
import {
  isReviewEventSubject,
  MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH,
  PROGRESS_SUBJECT_PREFIX,
} from './reviewEventSubjects';

export {
  PROGRESS_SUBJECT_PREFIX,
  PROGRESS_SUBJECT_PREFIX as REVIEW_PROGRESS_SUBJECT_PREFIX,
} from './reviewEventSubjects';
/** @deprecated Retained for consumers; subject validation uses the shared predicate. */
export const REVIEW_PROGRESS_SUBJECT_MAX_LENGTH = MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH;

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
  return `${PROGRESS_SUBJECT_PREFIX}.repo-${event.repository_id}.pr-${event.pr_number}`;
}

/**
 * SanitizedProgressEvent is an immutable snapshot produced only after the
 * sanitizer's 16 KiB check. The JetStream client repeats that bound at its
 * transport seam, so this sink intentionally keeps serialization failure
 * handling without duplicating a payload-size branch.
 */
function encode(event: SanitizedProgressEvent): Uint8Array {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(event);
  } catch {
    throw new JetStreamProgressSinkError('not_serializable');
  }
  if (serialized === undefined) throw new JetStreamProgressSinkError('not_serializable');

  return Buffer.from(serialized, 'utf8');
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
    if (!isReviewEventSubject(subject)) {
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
