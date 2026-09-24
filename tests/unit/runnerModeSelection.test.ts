import { describe, expect, it } from 'vitest';
import {
  buildReviewJobProjection,
  DEFAULT_GENERIC_RUNNER_IMAGE,
  TRUSTED_WORKER_IMAGE_REPOSITORY,
} from '../../src/k8s/reviewJobProjection';
import { reviewJobDispatcherConfigFromEnv } from '../../src/k8s/reviewJobDispatcherRuntime';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

const validBaseSpec = {
  runId: `run_${'1'.repeat(32)}`,
  deliveryId: 'actions:98765:2:123:42:head',
  repositoryId: 123,
  repo: 'calltelemetry/cisco-cdr',
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  receivedAt: 1_700_000_000_000,
  terminalDeadline: 1_700_000_000_000 + TERMINAL_DEADLINE_MS,
  policyDigest: 'c'.repeat(64),
  configDigest: 'd'.repeat(64),
  publicationMode: 'disabled' as const,
  namespace: 'ct-review-system',
};

describe('Runner mode selection and configuration', () => {
  describe('reviewJobDispatcherConfigFromEnv', () => {
    it('defaults to prebaked mode and requires a digest-pinned image', () => {
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
      ).toThrow(/must be a digest-pinned worker image/);
    });

    it('accepts a digest-pinned image from a non-vendor registry (self-host)', () => {
      // The headline contract: pinning is required, but the REGISTRY is not
      // restricted. A vendor-only allowlist here would reject a self-hoster's
      // image even after the CRD and the Go operator accepted it — the same
      // layer mismatch that made self-hosting impossible in REL-1025.
      const digest = `sha256:${'a'.repeat(64)}`;
      for (const image of [
        `registry.partner.example/rev/worker@${digest}`,
        `alpine@${digest}`,
        `node:20-alpine@${digest}`,
      ]) {
        const config = reviewJobDispatcherConfigFromEnv({
          REVIEW_JOB_DISPATCH_ENABLED: 'true',
          REVIEW_JOB_NAMESPACE: 'ct-review-system',
          REVIEW_JOB_WORKER_IMAGE: image,
          HOSTNAME: 'dispatcher-pod-0',
        });
        expect(config.workerImage).toBe(image);
      }
    });

    it('generic mode accepts a digest-pinned non-vendor image (the branch this PR changed)', () => {
      // The diff switched this branch from a trusted-registry pattern to the shared
      // contract, so generic mode newly accepts ANY registry when digest-pinned. A
      // self-hoster running generic mode depends on it; a regression to a stale or
      // registry-scoped pattern would otherwise pass every test in the suite.
      const digest = `sha256:${'a'.repeat(64)}`;
      const partner = `registry.partner.example/rev/worker@${digest}`;
      const config = reviewJobDispatcherConfigFromEnv({
        REVIEW_JOB_DISPATCH_ENABLED: 'true',
        REVIEW_JOB_NAMESPACE: 'ct-review-system',
        REVIEW_JOB_RUNNER_MODE: 'generic',
        REVIEW_JOB_WORKER_IMAGE: partner,
        HOSTNAME: 'dispatcher-pod-0',
      });
      expect(config.runnerMode).toBe('generic');
      expect(config.workerImage).toBe(partner);
    });

    it('generic mode still rejects an unpinned image from any registry', () => {
      // The control that remains after the switch: mutability.
      for (const image of ['registry.partner.example/rev/worker:latest', 'evil.example/backdoor:latest']) {
        expect(() =>
          reviewJobDispatcherConfigFromEnv({
            REVIEW_JOB_DISPATCH_ENABLED: 'true',
            REVIEW_JOB_NAMESPACE: 'ct-review-system',
            REVIEW_JOB_RUNNER_MODE: 'generic',
            REVIEW_JOB_WORKER_IMAGE: image,
            HOSTNAME: 'dispatcher-pod-0',
          }),
        ).toThrow(/generic runner image|digest-pinned/u);
      }
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
