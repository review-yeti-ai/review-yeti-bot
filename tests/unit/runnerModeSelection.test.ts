import { describe, expect, it } from 'vitest';
import {
  buildReviewJobProjection,
  DEFAULT_GENERIC_RUNNER_IMAGE,
  TRUSTED_WORKER_IMAGE_REPOSITORY,
} from '../../src/k8s/reviewJobProjection';
import { reviewJobDispatcherConfigFromEnv } from '../../src/k8s/reviewJobDispatcherRuntime';

const validBaseSpec = {
  runId: `run_${'1'.repeat(32)}`,
  deliveryId: 'actions:98765:2:123:42:head',
  repositoryId: 123,
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  receivedAt: 1_700_000_000_000,
  terminalDeadline: 1_700_000_000_000 + 900_000,
  policyDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
  publicationMode: 'disabled' as const,
  namespace: 'ct-review-system',
};

describe('Runner mode selection and configuration', () => {
  describe('reviewJobDispatcherConfigFromEnv', () => {
    it('defaults to prebaked mode and requires a trusted digest-pinned image', () => {
      const validDigest = `${TRUSTED_WORKER_IMAGE_REPOSITORY}@sha256:${'e'.repeat(64)}`;
      const config = reviewJobDispatcherConfigFromEnv({
        REVIEW_JOB_DISPATCH_ENABLED: 'true',
        REVIEW_JOB_NAMESPACE: 'ct-review-system',
        REVIEW_JOB_WORKER_IMAGE: validDigest,
        HOSTNAME: 'dispatcher-pod-0',
      });
      expect(config.runnerMode).toBe('prebaked');
      expect(config.workerImage).toBe(validDigest);

      expect(() =>
        reviewJobDispatcherConfigFromEnv({
          REVIEW_JOB_DISPATCH_ENABLED: 'true',
          REVIEW_JOB_NAMESPACE: 'ct-review-system',
          REVIEW_JOB_WORKER_IMAGE: 'node:24-bookworm-slim',
          HOSTNAME: 'dispatcher-pod-0',
        }),
      ).toThrow(/must be a digest-pinned trusted worker image/);
    });

    it('supports generic mode and defaults worker image to node:24-bookworm-slim', () => {
      const config = reviewJobDispatcherConfigFromEnv({
        REVIEW_JOB_DISPATCH_ENABLED: 'true',
        REVIEW_JOB_NAMESPACE: 'ct-review-system',
        REVIEW_JOB_RUNNER_MODE: 'generic',
        HOSTNAME: 'dispatcher-pod-0',
      });
      expect(config.runnerMode).toBe('generic');
      expect(config.workerImage).toBe(DEFAULT_GENERIC_RUNNER_IMAGE);
    });

    it('supports generic mode with explicit node image', () => {
      const config = reviewJobDispatcherConfigFromEnv({
        REVIEW_JOB_DISPATCH_ENABLED: 'true',
        REVIEW_JOB_NAMESPACE: 'ct-review-system',
        RUNNER_MODE: 'generic',
        REVIEW_JOB_WORKER_IMAGE: 'node:24-bookworm',
        HOSTNAME: 'dispatcher-pod-0',
      });
      expect(config.runnerMode).toBe('generic');
      expect(config.workerImage).toBe('node:24-bookworm');
    });

    it('rejects invalid runner mode values', () => {
      expect(() =>
        reviewJobDispatcherConfigFromEnv({
          REVIEW_JOB_DISPATCH_ENABLED: 'true',
          REVIEW_JOB_NAMESPACE: 'ct-review-system',
          RUNNER_MODE: 'unknown-mode',
          HOSTNAME: 'dispatcher-pod-0',
        }),
      ).toThrow(/REVIEW_JOB_RUNNER_MODE must be prebaked or generic/);
    });
  });

  describe('buildReviewJobProjection with runner modes', () => {
    it('requires a digest-pinned trusted worker image when runnerMode is prebaked or omitted', () => {
      const validDigest = `${TRUSTED_WORKER_IMAGE_REPOSITORY}@sha256:${'e'.repeat(64)}`;
      const projection = buildReviewJobProjection({
        ...validBaseSpec,
        workerImage: validDigest,
      }, validBaseSpec.receivedAt + 60_000);

      expect(projection.spec.runnerMode).toBe('prebaked');
      expect(projection.spec.workerImage).toBe(validDigest);

      expect(() =>
        buildReviewJobProjection({
          ...validBaseSpec,
          workerImage: 'node:24-bookworm-slim',
        }, validBaseSpec.receivedAt + 60_000),
      ).toThrow(/a strict digest-pinned worker image is required/);
    });

    it('accepts generic runner image when runnerMode is generic', () => {
      const projection = buildReviewJobProjection({
        ...validBaseSpec,
        workerImage: 'node:24-bookworm-slim',
        runnerMode: 'generic',
      }, validBaseSpec.receivedAt + 60_000);

      expect(projection.spec.runnerMode).toBe('generic');
      expect(projection.spec.workerImage).toBe('node:24-bookworm-slim');
    });

    it('accepts trusted digest image even in generic mode', () => {
      const validDigest = `${TRUSTED_WORKER_IMAGE_REPOSITORY}@sha256:${'e'.repeat(64)}`;
      const projection = buildReviewJobProjection({
        ...validBaseSpec,
        workerImage: validDigest,
        runnerMode: 'generic',
      }, validBaseSpec.receivedAt + 60_000);

      expect(projection.spec.runnerMode).toBe('generic');
      expect(projection.spec.workerImage).toBe(validDigest);
    });
  });
});
