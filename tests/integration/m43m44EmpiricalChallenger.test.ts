import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { K8sJobRunner, K8sJobSpec } from '../../src/infrastructure/k8sJobRunner';

describe('Milestone 43 & 44 Empirical Challenger Suite', () => {
  describe('M43: K8s Sandbox Agent Job Runner & PVC Verification', () => {
    it('verifies default generated Job spec parameters (ttl, activeDeadline, limits, requests)', () => {
      const runner = new K8sJobRunner();
      const spec: K8sJobSpec = {
        persona: 'security-auditor',
        repoUrl: 'calltelemetry/cisco-cdr',
        prNumber: 42,
        commitSha: 'd3b07384d113edec49eaa6238ad5ff00',
      };

      const manifest = runner.generateJobManifest(spec);

      // Verify Job level spec parameters
      expect(manifest.apiVersion).toBe('batch/v1');
      expect(manifest.kind).toBe('Job');
      expect(manifest.spec.ttlSecondsAfterFinished).toBe(300);
      expect(manifest.spec.activeDeadlineSeconds).toBe(600);
      expect(manifest.spec.backoffLimit).toBe(1);

      // Verify Container limits and requests
      const container = manifest.spec.template.spec.containers[0];
      expect(container.name).toBe('reviewer-agent');
      expect(container.resources.limits.cpu).toBe('500m');
      expect(container.resources.limits.memory).toBe('1Gi');
      expect(container.resources.requests.cpu).toBe('250m');
      expect(container.resources.requests.memory).toBe('512Mi');
    });

    it('verifies PVC volume name and subPath mounting structure', () => {
      const runner = new K8sJobRunner();
      const spec: K8sJobSpec = {
        persona: 'performance-expert',
        repoUrl: 'calltelemetry/ct-review-bot',
        prNumber: 108,
        commitSha: '9f8e7d6c5b4a',
      };

      const manifest = runner.generateJobManifest(spec);

      // Verify PVC volume definition
      const volumes = manifest.spec.template.spec.volumes;
      expect(volumes).toHaveLength(1);
      expect(volumes[0].name).toBe('workspace-volume');
      expect(volumes[0].persistentVolumeClaim?.claimName).toBe('ct-review-bot-workspace-pvc');

      // Verify Container volumeMounts
      const container = manifest.spec.template.spec.containers[0];
      expect(container.volumeMounts).toHaveLength(1);
      expect(container.volumeMounts[0].name).toBe('workspace-volume');
      expect(container.volumeMounts[0].mountPath).toBe('/workspace');
      expect(container.volumeMounts[0].subPath).toBe('repos/calltelemetry_ct-review-bot_pr108');

      // Verify WORKSPACE_PATH env var matching subPath
      const envWorkspace = container.env.find((e) => e.name === 'WORKSPACE_PATH');
      expect(envWorkspace).toBeDefined();
      expect(envWorkspace?.value).toBe('/workspace/repos/calltelemetry_ct-review-bot_pr108');
    });

    it('verifies simulation mode dispatch execution when forceSimulation: true or NODE_ENV === "test"', async () => {
      // Case 1: forceSimulation = true
      const forcedRunner = new K8sJobRunner({ forceSimulation: true });
      const resForced = await forcedRunner.dispatchJob({
        persona: 'qa-tester',
        repoUrl: 'calltelemetry/test-repo',
        prNumber: 1,
        commitSha: 'abc123456789',
      });

      expect(resForced.success).toBe(true);
      expect(resForced.mode).toBe('simulation');
      expect(resForced.jobName).toContain('ct-agent-qa-tester-pr1');

      // Case 2: NODE_ENV = 'test'
      const testEnvRunner = new K8sJobRunner();
      const resTestEnv = await testEnvRunner.dispatchJob({
        persona: 'sec-tester',
        repoUrl: 'calltelemetry/sec-repo',
        prNumber: 999,
        commitSha: 'fed987654321',
      });

      expect(resTestEnv.success).toBe(true);
      expect(resTestEnv.mode).toBe('simulation');
      expect(resTestEnv.namespace).toBe('ct-review-system');
    });

    it('stress tests job generation and dispatch under concurrent load', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const dispatches = Array.from({ length: 50 }).map((_, i) =>
        runner.dispatchJob({
          persona: `stress-agent-${i}`,
          repoUrl: `calltelemetry/repo-${i}`,
          prNumber: i + 1,
          commitSha: `sha-${i}-${Date.now()}`,
        })
      );

      const results = await Promise.all(dispatches);
      expect(results).toHaveLength(50);
      results.forEach((res, i) => {
        expect(res.success).toBe(true);
        expect(res.mode).toBe('simulation');
        expect(res.manifest.spec.ttlSecondsAfterFinished).toBe(300);
        expect(res.manifest.spec.activeDeadlineSeconds).toBe(600);
        expect(res.manifest.spec.template.spec.containers[0].resources.limits.cpu).toBe('500m');
        expect(res.manifest.spec.template.spec.containers[0].resources.limits.memory).toBe('1Gi');
        expect(res.manifest.spec.template.spec.volumes[0].persistentVolumeClaim?.claimName).toBe('ct-review-bot-workspace-pvc');
        expect(res.manifest.spec.template.spec.containers[0].volumeMounts[0].subPath).toBe(`repos/calltelemetry_repo-${i}_pr${i + 1}`);
      });
    });
  });

  describe('M44: Release Configuration & Metadata Verification', () => {
    it('verifies package.json version string matches the current release', () => {
      const packageJsonPath = path.resolve(__dirname, '../../package.json');
      const rawData = fs.readFileSync(packageJsonPath, 'utf-8');
      const packageData = JSON.parse(rawData);

      expect(packageData.version).toBe('1.8.3');
      expect(packageData.name).toBe('ct-review-bot');
    });
  });
});
