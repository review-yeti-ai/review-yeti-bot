import { describe, expect, it, vi } from 'vitest';
import { parseReviewYetiEventV1 } from '../../src/events/reviewYetiEvent';
import {
  ReviewEventRejection,
  sanitizeProgressEvent,
  type SanitizedProgressEvent,
} from '../../src/events/reviewEventRedaction';
import {
  JetStreamProgressSink,
  JetStreamProgressSinkError,
  type ProgressPublisher,
} from '../../src/events/jetStreamProgressSink';
import type { ReviewEventIdentity } from '../../src/types/live';

const identity: ReviewEventIdentity = {
  repositoryId: 123,
  prNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  attemptId: 'review-attempt-42-1',
  runId: 'review-run-42-1',
  sequence: 3,
  correlationId: 'validation-42-1',
  traceId: '9f000000000000000000000000000000',
};

function liveEvent(data: Record<string, unknown> = {}) {
  return {
    jobId: 'legacy-job-42',
    timestamp: '2026-09-11T12:00:00.000Z',
    type: 'persona:complete' as const,
    persona: 'security',
    data,
  };
}

function sanitizedEvent(): SanitizedProgressEvent {
  const result = sanitizeProgressEvent(liveEvent({ provider: 'openrouter', findingsCount: 2 }), identity);
  expect(result).not.toBeInstanceOf(ReviewEventRejection);
  return result as SanitizedProgressEvent;
}

function publisher(): ProgressPublisher & { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

describe('JetStreamProgressSink', () => {
  it('publishes only sanitizer-originated envelopes with a bounded subject and event message ID', async () => {
    const target = publisher();
    const event = sanitizedEvent();
    const sink = new JetStreamProgressSink({ enabled: true, publisher: target });

    const result = await sink.publish(event);
    const [subject, payload, options] = target.publish.mock.calls[0];

    expect(result).toEqual({
      published: true,
      subject: 'ct.review.progress.v1.repo-123.pr-42',
      messageId: event.event_id,
    });
    expect(subject).toBe('ct.review.progress.v1.repo-123.pr-42');
    expect(subject.length).toBeLessThanOrEqual(64);
    expect(subject).not.toContain(identity.runId);
    expect(options).toEqual({ messageId: event.event_id });
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual(event);
  });

  it('publishes a transitively immutable clone after nested source and envelope mutation attempts', async () => {
    const poisonedProvider = 'tls://review:synthetic-secret@private.test:4222';
    const sourceProviders = ['openrouter'];
    const sanitized = sanitizeProgressEvent(liveEvent({ distinctProviders: sourceProviders }), identity);
    expect(sanitized).not.toBeInstanceOf(ReviewEventRejection);
    const event = sanitized as SanitizedProgressEvent;

    sourceProviders.push(poisonedProvider);
    expect(event.data.distinct_providers).toEqual(['openrouter']);
    expect(Object.isFrozen(event.data.distinct_providers)).toBe(true);
    expect(() => (event.data.distinct_providers as string[]).push(poisonedProvider)).toThrow(TypeError);

    const target = publisher();
    const sink = new JetStreamProgressSink({ enabled: true, publisher: target });
    await sink.publish(event);

    const payload = new TextDecoder().decode(target.publish.mock.calls[0][1]);
    expect(payload).not.toContain('synthetic-secret');
    expect(payload).not.toContain('private.test');
    expect(JSON.parse(payload).data.distinct_providers).toEqual(['openrouter']);
  });

  it('rejects a changing distinctProviders accessor before it can poison a branded publication', async () => {
    const poisonedProvider = 'nats://synthetic-secret@private.test:4222';
    let reads = 0;
    const distinctProviders: string[] = [];
    Object.defineProperty(distinctProviders, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? 'openrouter' : poisonedProvider;
      },
    });
    distinctProviders.length = 1;
    const target = publisher();
    const sink = new JetStreamProgressSink({ enabled: true, publisher: target });

    const result = sanitizeProgressEvent(liveEvent({ distinctProviders }), identity);
    if (!(result instanceof ReviewEventRejection)) await sink.publish(result);

    expect(result).toBeInstanceOf(ReviewEventRejection);
    expect((result as ReviewEventRejection).code).toBe('not_serializable');
    expect(reads).toBe(0);
    expect(target.publish).not.toHaveBeenCalled();
  });

  it('rejects generic parser output at runtime even when its shape is valid', async () => {
    const target = publisher();
    const event = sanitizedEvent();
    const parsed = parseReviewYetiEventV1({ ...event });
    const sink = new JetStreamProgressSink({ enabled: true, publisher: target });

    await expect(sink.publish(parsed as any)).rejects.toMatchObject({ code: 'invalid_envelope' });
    expect(target.publish).not.toHaveBeenCalled();
  });

  it('rejects permissive legacy live events instead of accepting their data map', async () => {
    const target = publisher();
    const sink = new JetStreamProgressSink({ enabled: true, publisher: target });

    await expect(sink.publish(liveEvent({ token: 'raw-secret' }) as any))
      .rejects.toMatchObject({ code: 'invalid_envelope' });
    expect(target.publish).not.toHaveBeenCalled();
  });

  it('returns disabled without invoking a publisher by default', async () => {
    const target = publisher();
    const sink = new JetStreamProgressSink({ publisher: target });

    await expect(sink.publish(sanitizedEvent())).resolves.toEqual({
      published: false,
      reason: 'disabled',
    });
    expect(target.publish).not.toHaveBeenCalled();
  });

  it('still rejects an untrusted envelope when disabled', async () => {
    const sink = new JetStreamProgressSink();

    await expect(sink.publish(parseReviewYetiEventV1({ ...sanitizedEvent() }) as any))
      .rejects.toMatchObject({ code: 'invalid_envelope' });
  });

  it('reports an enabled publisher failure without exposing the underlying error', async () => {
    const target = publisher();
    target.publish.mockRejectedValue(new Error('nats://review:super-secret@nats.internal:4222 refused connection'));
    const sink = new JetStreamProgressSink({ enabled: true, publisher: target });

    const rejection = await sink.publish(sanitizedEvent()).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(JetStreamProgressSinkError);
    expect((rejection as JetStreamProgressSinkError).code).toBe('publish_failed');
    expect((rejection as Error).message).not.toContain('super-secret');
    expect((rejection as Error).message).not.toContain('nats.internal');
  });

  it.each([
    ['undefined', undefined],
    ['cyclic', (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })()],
  ])('maps %s input to a typed non-secret envelope error', async (_label, value) => {
    const sink = new JetStreamProgressSink({ enabled: true, publisher: publisher() });

    const rejection = await sink.publish(value as any).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(JetStreamProgressSinkError);
    expect((rejection as JetStreamProgressSinkError).code).toBe('invalid_envelope');
    expect((rejection as Error).message).not.toContain('self');
  });

  it('keeps the TypeScript sink boundary narrower than ReviewYetiEventV1', () => {
    const sink = new JetStreamProgressSink({ enabled: true, publisher: publisher() });
    const parserOutput = parseReviewYetiEventV1({ ...sanitizedEvent() });

    if (false) {
      // @ts-expect-error Generic parser output lacks sanitizer provenance by design.
      sink.publish(parserOutput);
    }
  });
});
