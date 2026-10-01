/**
 * Challenger 2 Empirical Adversarial Test Suite:
 * Ephemeral Storage Isolation, Zero PVC Verification, and Shallow Git Checkout Benchmarks
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  K8sJobRunner,
  type K8sJobSpec,
} from '../../src/infrastructure/k8sJobRunner';
import { buildReviewJobProjection } from '../../src/k8s/reviewJobProjection';
import { DEFAULT_TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';

const execFileAsync = promisify(execFile);

describe('Challenger 2: Ephemeral Storage Isolation & Universal emptyDir Suite', () => {
  const baseSpec: K8sJobSpec = {
    persona: 'security',
    repoUrl: 'exampleorg/example-api',
    prNumber: 42,
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
  };

  // ==========================================================================
  // Section 1: K8sJobRunner Universal emptyDir & Zero PVC Verification
  // ==========================================================================
  describe('Section 1: K8sJobRunner Universal emptyDir & Zero PVC Verification', () => {
    it('generates emptyDir: {} and zero PVCs when pvcClaimName is omitted', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);

      expect(manifest.spec.template.spec.volumes).toHaveLength(1);
      const vol = manifest.spec.template.spec.volumes[0];
      expect(vol.name).toBe('workspace-volume');
      expect(vol.emptyDir).toBeDefined();
      expect(vol.emptyDir).toEqual({});
      expect(vol.persistentVolumeClaim).toBeUndefined();
    });

    it('fails closed with INVALID_SHAPE across blank/whitespace pvcClaimName inputs', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const blankInputs = ['', '   ', '\t', '\n  \n'];

      for (const input of blankInputs) {
        expect(() =>
          runner.generateJobManifest({
            ...baseSpec,
            pvcClaimName: input,
          })
        ).toThrow(/INVALID_SHAPE/);
      }
    });

    it('ensures /workspace is mounted from workspace-volume in both initContainers and containers', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);

      const initMount = manifest.spec.template.spec.initContainers?.[0].volumeMounts[0];
      expect(initMount?.name).toBe('workspace-volume');
      expect(initMount?.mountPath).toBe('/workspace');

      const containerMount = manifest.spec.template.spec.containers[0].volumeMounts[0];
      expect(containerMount?.name).toBe('workspace-volume');
      expect(containerMount?.mountPath).toBe('/workspace');
    });

    it('retains universal emptyDir when runnerMode is injected into spec', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      for (const mode of ['generic', 'prebaked', '', 'isolated-mode']) {
        const manifest = runner.generateJobManifest({
          ...baseSpec,
          ...({ runnerMode: mode } as any),
        });

        const vol = manifest.spec.template.spec.volumes[0];
        expect(vol.emptyDir).toBeDefined();
        expect(vol.emptyDir).toEqual({});
        expect(vol.persistentVolumeClaim).toBeUndefined();
      }
    });
  });

  // ==========================================================================
  // Section 2: Container Isolation & Multi-Review Sandboxing
  // ==========================================================================
  describe('Section 2: Container Isolation & Multi-Review Sandboxing', () => {
    it('generates isolated volumes and subpaths for concurrent reviews', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });

      const manifestA = runner.generateJobManifest({
        ...baseSpec,
        prNumber: 101,
        repoUrl: 'exampleorg/repo-alpha',
      });

      const manifestB = runner.generateJobManifest({
        ...baseSpec,
        prNumber: 102,
        repoUrl: 'exampleorg/repo-beta',
      });

      // Distinct job names
      expect(manifestA.metadata.name).not.toBe(manifestB.metadata.name);

      // Distinct volume instances
      expect(manifestA.spec.template.spec.volumes[0]).not.toBe(manifestB.spec.template.spec.volumes[0]);

      // Isolated subpaths
      const subPathA = manifestA.spec.template.spec.containers[0].volumeMounts[0].subPath;
      const subPathB = manifestB.spec.template.spec.containers[0].volumeMounts[0].subPath;
      expect(subPathA).toBe('repos/exampleorg_repo-alpha_pr101');
      expect(subPathB).toBe('repos/exampleorg_repo-beta_pr102');
      expect(subPathA).not.toBe(subPathB);
    });

    it('proves two concurrent dispatches execute in isolated simulation sandboxes', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });

      const [resA, resB] = await Promise.all([
        runner.dispatchJob({ ...baseSpec, prNumber: 201 }),
        runner.dispatchJob({ ...baseSpec, prNumber: 202 }),
      ]);

      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
      expect(resA.jobName).not.toBe(resB.jobName);

      expect(resA.manifest.spec.template.spec.volumes[0].emptyDir).toBeDefined();
      expect(resB.manifest.spec.template.spec.volumes[0].emptyDir).toBeDefined();
      expect(resA.manifest.spec.template.spec.volumes[0].persistentVolumeClaim).toBeUndefined();
      expect(resB.manifest.spec.template.spec.volumes[0].persistentVolumeClaim).toBeUndefined();
    });
  });

  // ==========================================================================
  // Section 3: reviewJobProjection Zero-PVC Schema Conformance
  // ==========================================================================
  describe('Section 3: reviewJobProjection Zero-PVC Schema Conformance', () => {
    it('creates PRReviewJob CRD projections with zero PVC fields across runner modes', () => {
      const now = Date.now();
      const baseInput = {
        runId: 'run_1234567890abcdef1234567890abcdef',
        deliveryId: 'deliv-101',
        repositoryId: 999,
        repo: 'exampleorg/example-api',
        prNumber: 42,
        headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        baseSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        receivedAt: now,
        terminalDeadline: now + DEFAULT_TERMINAL_DEADLINE_MS,
        policyDigest: 'c'.repeat(64),
        configDigest: 'd'.repeat(64),
        publicationMode: 'disabled' as const,
        workerImage: 'registry.digitalocean.com/exampleorg/review-yeti-worker@sha256:' + 'e'.repeat(64),
        namespace: 'ct-review-system',
      };

      for (const mode of ['prebaked' as const, 'generic' as const]) {
        const projection = buildReviewJobProjection({
          ...baseInput,
          runnerMode: mode,
          workerImage: mode === 'generic' ? 'node:24-bookworm-slim' : baseInput.workerImage,
        }, now);

        expect(projection.apiVersion).toBe('review-yeti.ai/v1alpha2');
        expect(projection.kind).toBe('PRReviewJob');
        expect(projection.spec.runnerMode).toBe(mode);

        // Assert no PVC specification exists in the CRD spec
        expect((projection.spec as any).pvcName).toBeUndefined();
        expect((projection.spec as any).persistentVolumeClaim).toBeUndefined();
        expect((projection.spec as any).volumeClaimTemplate).toBeUndefined();
      }
    });
  });

  // ==========================================================================
  // Section 4: Shallow Git Checkout Latency Empirical Benchmark
  // ==========================================================================
  describe('Section 4: Shallow Git Checkout Latency Empirical Benchmark', () => {
    it('empirically benchmarks shallow git fetch pipeline in local scratch directory (<1500ms budget)', async () => {
      const iterations = 5;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const scratchDir = await mkdtemp(join(tmpdir(), 'git-shallow-benchmark-'));
        try {
          const gitDir = join(scratchDir, 'repository.git');
          const startTime = performance.now();

          // 1. git init --bare
          await execFileAsync('git', ['init', '--quiet', '--bare', gitDir]);

          // 2. git remote add origin
          await execFileAsync('git', ['--git-dir', gitDir, 'remote', 'add', 'origin', process.cwd()]);

          // 3. git fetch --depth=1 --filter=blob:none
          await execFileAsync('git', [
            '--git-dir',
            gitDir,
            'fetch',
            '--quiet',
            '--no-tags',
            '--no-write-fetch-head',
            '--no-recurse-submodules',
            '--depth=1',
            '--filter=blob:none',
            'origin',
            'HEAD',
          ]);

          const elapsedMs = performance.now() - startTime;
          latencies.push(elapsedMs);
        } finally {
          await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const max = latencies[latencies.length - 1];

      // Console summary for verification logging
      console.log(`[Challenger 2 Benchmark] Shallow Git Fetch: p50 = ${p50.toFixed(1)}ms, max = ${max.toFixed(1)}ms across ${iterations} runs`);

      // Acceptance criteria: startup latency < 1500ms (and typical cluster target < 800ms)
      expect(p50).toBeLessThan(800);
      expect(max).toBeLessThan(1500);
    }, 20000);
  });
});
