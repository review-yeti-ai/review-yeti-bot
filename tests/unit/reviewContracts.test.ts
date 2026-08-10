import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'src/review/reviewContracts.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const contracts = require(path.join(root, 'src/review/reviewContracts.js'));

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);

describe('review intelligence contracts', () => {
  it('creates a versioned identity with stable trusted-config and effective-policy digests', () => {
    const identity = contracts.createReviewIdentity({
      repository: 'Review-Yeti-AI/Review-Yeti-Bot',
      prNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      trustedConfig: 'version: 1\nenabled: true\n',
      effectivePolicy: { enabled: true, limits: { maxDiffChars: 4000 } },
    });

    expect(identity).toMatchObject({
      schemaVersion: 'review-identity-v1',
      repository: 'review-yeti-ai/review-yeti-bot',
      prNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      configDigest: 'daab6f2558e47d3609f1e69b573de86b0e3e604575bf0990d3a947d3deb8b02f',
      policyDigest: 'e1ad06bb2b3452a018287104074f3f4c3fd4440bb86522d16af28b4661e32ad4',
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('rejects incomplete or non-immutable review identity coordinates', () => {
    expect(() => contracts.createReviewIdentity({
      repository: 'review-yeti-ai/review-yeti-bot', prNumber: 42, baseSha: 'main', headSha: HEAD_SHA,
    })).toThrow(/baseSha must be a 40-64 character commit SHA/);
    expect(() => contracts.createReviewIdentity({
      repository: 'review-yeti-ai/review-yeti-bot', prNumber: 0, baseSha: BASE_SHA, headSha: HEAD_SHA,
    })).toThrow(/prNumber must be a positive integer/);
  });

  it('provides inert event and telemetry sinks for callers that do not opt into exporters', async () => {
    const eventSink = contracts.createNoopReviewEventSink();
    const telemetrySink = contracts.createNoopReviewTelemetrySink();

    await expect(eventSink.emit({ eventType: 'review_started' })).resolves.toEqual(undefined);
    await expect(telemetrySink.emit({ name: 'review.started' })).resolves.toEqual(undefined);
    expect(eventSink.schemaVersion).toBe('review-event-sink-v1');
    expect(telemetrySink.schemaVersion).toBe('review-telemetry-sink-v1');
  });
});
