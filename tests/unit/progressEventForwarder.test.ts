import { describe, expect, it, vi } from 'vitest';
import {
  isSanitizedProgressEvent,
  type SanitizedProgressEvent,
} from '../../src/events/reviewEventRedaction';
import {
  DEFAULT_PROGRESS_SINK_MAX_IN_FLIGHT,
  MAX_PROGRESS_SINK_MAX_IN_FLIGHT,
  ProgressEventForwarder,
  type ProgressEventForwardingFailure,
  type ProgressEventSink,
} from '../../src/events/progressEventForwarder';
import type { LiveStreamEvent, ReviewEventIdentity } from '../../src/types/live';

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

function liveEvent(data: Record<string, unknown> = {}): LiveStreamEvent {
  return {
    jobId: 'legacy-job-42',
    timestamp: '2026-09-11T12:00:00.000Z',
    type: 'persona:complete',
    persona: 'security',
    data,
  };
}

function sink(): ProgressEventSink & { publish: ReturnType<typeof vi.fn> } {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

describe('ProgressEventForwarder', () => {
  it('does nothing when no sink and identity provider are configured', () => {
    const onFailure = vi.fn();
    const forwarder = new ProgressEventForwarder({ onFailure });

    expect(() => forwarder.forward(liveEvent())).not.toThrow();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('resolves identity before forwarding a closed, sanitizer-originated envelope', async () => {
    const target = sink();
    const identityProvider = vi.fn().mockReturnValue(identity);
    const forwarder = new ProgressEventForwarder({
      sink: target,
      identityProvider,
    });

    forwarder.forward(liveEvent({ distinctProviders: ['openrouter'] }));

    await vi.waitFor(() => expect(target.publish).toHaveBeenCalledTimes(1));
    const [event] = target.publish.mock.calls[0] as [SanitizedProgressEvent];
    expect(identityProvider).toHaveBeenCalledTimes(1);
    expect(isSanitizedProgressEvent(event)).toBe(true);
    expect(event).toMatchObject({
      event_kind: 'review.progress.persona_completed',
      data: { distinct_providers: ['openrouter'], message: 'Persona review completed' },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.distinct_providers)).toBe(true);
  });

  it('reports identity and sanitizer rejection failures without forwarding', () => {
    const target = sink();
    const failures: ProgressEventForwardingFailure[] = [];
    const forwarder = new ProgressEventForwarder({
      sink: target,
      identityProvider: () => { throw new Error('identity-secret'); },
      onFailure: (failure) => failures.push(failure),
    });

    forwarder.forward(liveEvent());
    expect(failures).toEqual([{ code: 'identity_resolution_failed' }]);
    expect(target.publish).not.toHaveBeenCalled();

    forwarder.setProgressSink(target, () => identity);
    forwarder.forward(liveEvent({ unknownField: 'attacker-controlled' }));
    expect(failures).toEqual([
      { code: 'identity_resolution_failed' },
      { code: 'sanitization_rejected', rejectionCode: 'unknown_field' },
    ]);
    expect(target.publish).not.toHaveBeenCalled();
  });

  it('contains an unexpected sanitizer failure without forwarding', () => {
    const target = sink();
    const failures: ProgressEventForwardingFailure[] = [];
    const forwarder = new ProgressEventForwarder({
      sink: target,
      identityProvider: () => identity,
      sanitize: () => { throw new Error('sanitizer-internal-detail'); },
      onFailure: (failure) => failures.push(failure),
    });

    expect(() => forwarder.forward(liveEvent())).not.toThrow();
    expect(failures).toEqual([{ code: 'sanitization_failed' }]);
    expect(target.publish).not.toHaveBeenCalled();
  });

  it('maps a synchronously thrown sink to a bounded forwarding failure', () => {
    const target = sink();
    target.publish.mockImplementation(() => {
      throw new Error('nats://review:synchronous-secret@private.test:4222 refused');
    });
    const failures: ProgressEventForwardingFailure[] = [];
    const forwarder = new ProgressEventForwarder({
      sink: target,
      identityProvider: () => identity,
      onFailure: (failure) => failures.push(failure),
      maxInFlight: 1,
    });

    expect(() => forwarder.forward(liveEvent())).not.toThrow();
    expect(failures).toEqual([{ code: 'sink_publish_failed' }]);
    expect(target.publish).toHaveBeenCalledTimes(1);

    forwarder.forward(liveEvent());
    expect(target.publish).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([
      { code: 'sink_publish_failed' },
      { code: 'sink_publish_failed' },
    ]);
  });

  it('maps an asynchronously rejected sink to a bounded forwarding failure', async () => {
    const target = sink();
    target.publish.mockRejectedValue(new Error('nats://review:sink-secret@private.test:4222 refused'));
    const failures: ProgressEventForwardingFailure[] = [];
    const forwarder = new ProgressEventForwarder({
      sink: target,
      identityProvider: () => identity,
      onFailure: (failure) => failures.push(failure),
      maxInFlight: 1,
    });

    forwarder.forward(liveEvent());

    await vi.waitFor(() => expect(failures).toEqual([{ code: 'sink_publish_failed' }]));

    target.publish.mockResolvedValueOnce(undefined);
    forwarder.forward(liveEvent());
    await vi.waitFor(() => expect(target.publish).toHaveBeenCalledTimes(2));
  });

  it('bounds stalled publications and drops new progress events with a bounded overload code', async () => {
    const releases: Array<() => void> = [];
    const target = sink();
    target.publish.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
    const failures: ProgressEventForwardingFailure[] = [];
    const forwarder = new ProgressEventForwarder({
      sink: target,
      identityProvider: () => identity,
      onFailure: (failure) => failures.push(failure),
      maxInFlight: 2,
    });

    for (let index = 0; index < 10; index += 1) forwarder.forward(liveEvent());

    expect(target.publish).toHaveBeenCalledTimes(2);
    expect(failures).toEqual(Array.from({ length: 8 }, () => ({ code: 'sink_overloaded' })));

    releases.shift()?.();
    await Promise.resolve();
    forwarder.forward(liveEvent());
    expect(target.publish).toHaveBeenCalledTimes(3);

    for (const release of releases) release();
    await Promise.resolve();
  });

  it('enforces the default in-flight bound under a stalled sink burst', async () => {
    const releases: Array<() => void> = [];
    const target = sink();
    target.publish.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
    const failures: ProgressEventForwardingFailure[] = [];
    const forwarder = new ProgressEventForwarder({
      sink: target,
      identityProvider: () => identity,
      onFailure: (failure) => failures.push(failure),
    });

    for (let index = 0; index < DEFAULT_PROGRESS_SINK_MAX_IN_FLIGHT + 5; index += 1) {
      forwarder.forward(liveEvent());
    }

    expect(target.publish).toHaveBeenCalledTimes(DEFAULT_PROGRESS_SINK_MAX_IN_FLIGHT);
    expect(failures).toEqual(Array.from({ length: 5 }, () => ({ code: 'sink_overloaded' })));

    for (const release of releases) release();
    await Promise.resolve();
  });

  it.each([0, 1.5, MAX_PROGRESS_SINK_MAX_IN_FLIGHT + 1])(
    'rejects an invalid max-in-flight bound of %s',
    (maxInFlight) => {
      expect(() => new ProgressEventForwarder({ maxInFlight })).toThrow(RangeError);
    },
  );

  it('uses a finite default progress sink concurrency bound', () => {
    expect(DEFAULT_PROGRESS_SINK_MAX_IN_FLIGHT).toBeGreaterThan(0);
    expect(DEFAULT_PROGRESS_SINK_MAX_IN_FLIGHT).toBeLessThanOrEqual(
      MAX_PROGRESS_SINK_MAX_IN_FLIGHT,
    );
  });
});
