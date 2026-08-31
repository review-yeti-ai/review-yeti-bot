import { describe, expect, it } from 'vitest';
import { buildReviewJobProjection } from '../../src/k8s/reviewJobProjection';

const receivedAt = Date.parse('2026-08-30T20:00:00.000Z');
const input = {
  runId: `run_${'1'.repeat(32)}`,
  deliveryId: 'actions:98765:2:123:42:head',
  repositoryId: 123,
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  receivedAt,
  terminalDeadline: receivedAt + 900_000,
  policyDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
  publicationMode: 'disabled' as const,
  workerImage: `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'e'.repeat(64)}`,
  namespace: 'ct-review-qualification',
};

describe('buildReviewJobProjection', () => {
  it('builds the exact deterministic nonpublishing PRReviewJob contract', () => {
    expect(buildReviewJobProjection(input, receivedAt + 60_000)).toEqual({
      apiVersion: 'review-yeti.ai/v1alpha2',
      kind: 'PRReviewJob',
      metadata: {
        name: `ct-review-${'1'.repeat(32)}`,
        namespace: 'ct-review-qualification',
        labels: {
          'app.kubernetes.io/name': 'review-yeti-worker',
          'review-yeti.ai/publication-mode': 'disabled',
          'review-yeti.ai/run-id': `run_${'1'.repeat(32)}`,
        },
      },
      spec: {
        runId: `run_${'1'.repeat(32)}`,
        deliveryId: input.deliveryId,
        repositoryId: 123,
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        receivedAt: '2026-08-30T20:00:00.000Z',
        terminalDeadline: '2026-08-30T20:15:00.000Z',
        policyDigest: 'c'.repeat(64),
        configDigest: 'd'.repeat(64),
        publicationMode: 'disabled',
        workerImage: input.workerImage,
        runSecretName: `ct-review-run-${'1'.repeat(32)}`,
      },
    });
  });

  it('rejects publication and deadline expansion before producing a projection', () => {
    expect(() => buildReviewJobProjection({ ...input, publicationMode: 'app-gate' }, receivedAt + 60_000))
      .toThrow(/publication mode/i);
    expect(() => buildReviewJobProjection({ ...input, terminalDeadline: receivedAt + 900_001 }, receivedAt + 60_000))
      .toThrow(/15 minutes/i);
    expect(() => buildReviewJobProjection(input, input.terminalDeadline - 119_999))
      .toThrow(/120 seconds/i);
    expect(buildReviewJobProjection(input, input.terminalDeadline - 120_000).metadata.name)
      .toBe(`ct-review-${'1'.repeat(32)}`);
  });

  it.each([
    `run_${'1'.repeat(31)}`,
    `run_${'A'.repeat(32)}`,
    `job_${'1'.repeat(32)}`,
  ])('rejects malformed run identity %s', (runId) => {
    expect(() => buildReviewJobProjection({ ...input, runId }, receivedAt + 60_000)).toThrow(/run id/i);
  });

  it.each(['', 'x'.repeat(513)])('rejects invalid delivery identity', (deliveryId) => {
    expect(() => buildReviewJobProjection({ ...input, deliveryId }, receivedAt + 60_000)).toThrow(/delivery id/i);
  });

  it.each([
    'registry.digitalocean.com/calltelemetry/review-yeti-worker:latest',
    `registry.digitalocean.com/calltelemetry/review-yeti-worker:v1@sha256:${'e'.repeat(64)}`,
    `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'E'.repeat(64)}`,
    `review-yeti-worker@sha256:${'e'.repeat(63)}`,
  ])('rejects a worker image that is not a strict digest-only reference: %s', (workerImage) => {
    expect(() => buildReviewJobProjection({ ...input, workerImage }, receivedAt + 60_000))
      .toThrow(/digest-pinned worker image/i);
  });

  it('rejects a digest-pinned image from an untrusted repository', () => {
    const workerImage = `attacker.example/review-yeti-worker@sha256:${'e'.repeat(64)}`;
    expect(() => buildReviewJobProjection({ ...input, workerImage }, receivedAt + 60_000))
      .toThrow(/trusted worker image repository/i);
  });

  it('rejects malformed immutable review identity', () => {
    expect(() => buildReviewJobProjection({ ...input, headSha: 'main' }, receivedAt + 60_000)).toThrow(/head sha/i);
    expect(() => buildReviewJobProjection({ ...input, baseSha: 'main' }, receivedAt + 60_000)).toThrow(/base sha/i);
    expect(() => buildReviewJobProjection({ ...input, policyDigest: 'c'.repeat(63) }, receivedAt + 60_000)).toThrow(/policy digest/i);
    expect(() => buildReviewJobProjection({ ...input, configDigest: 'd'.repeat(63) }, receivedAt + 60_000)).toThrow(/config digest/i);
    expect(() => buildReviewJobProjection({ ...input, repo: '../other' }, receivedAt + 60_000)).toThrow(/repository/i);
    expect(() => buildReviewJobProjection({ ...input, namespace: 'INVALID_NS' }, receivedAt + 60_000)).toThrow(/namespace/i);
  });

  it('rejects projection before the authenticated admission receipt time', () => {
    expect(() => buildReviewJobProjection(input, receivedAt - 1)).toThrow(/cannot precede admission receipt/i);
  });

  it('rejects non-finite projection timestamps', () => {
    expect(() => buildReviewJobProjection({ ...input, receivedAt: Number.POSITIVE_INFINITY }, receivedAt + 60_000))
      .toThrow(/timestamps must be finite/i);
    expect(() => buildReviewJobProjection({ ...input, terminalDeadline: Number.NaN }, receivedAt + 60_000))
      .toThrow(/timestamps must be finite/i);
    expect(() => buildReviewJobProjection(input, Number.POSITIVE_INFINITY)).toThrow(/timestamps must be finite/i);
  });

  it.each([
    ['repository id', { repositoryId: 0 }],
    ['repository id', { repositoryId: 1.5 }],
    ['pull request number', { prNumber: 0 }],
    ['pull request number', { prNumber: 1.5 }],
  ])('rejects invalid numeric %s', (field, override) => {
    expect(() => buildReviewJobProjection({ ...input, ...override }, receivedAt + 60_000))
      .toThrow(new RegExp(field, 'i'));
  });

  it('does not project caller-supplied secret material', () => {
    const projection = buildReviewJobProjection({
      ...input,
      githubAppPrivateKey: 'private-key-must-not-cross',
      providerApiKey: 'provider-key-must-not-cross',
      installationToken: 'installation-token-must-not-cross',
      callbackToken: 'callback-token-must-not-cross',
    } as any, receivedAt + 60_000);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('must-not-cross');
    expect(serialized).not.toMatch(/privateKey|providerApiKey|installationToken|callbackToken/u);
  });
});
