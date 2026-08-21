import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { K8sJobRunner } from '../../src/infrastructure/k8sJobRunner';
import { createGitHubAppApiRouter } from '../../src/api/githubAppApi';

describe('K8s Sandbox Job Runner & GitHub App Policy Suite (Release v1.5.0)', () => {
  it('generates valid Kubernetes batch/v1 Job manifests with default PVC workspace mounts', () => {
    const runner = new K8sJobRunner();

    const manifest = runner.generateJobManifest({
      jobName: 'ct-agent-sec-pr1450',
      persona: 'security',
      repoUrl: 'calltelemetry/ct-meta',
      prNumber: 1450,
      commitSha: '655a11188990',
    });

    expect(manifest.apiVersion).toBe('batch/v1');
    expect(manifest.kind).toBe('Job');
    expect(manifest.metadata.name).toBe('ct-agent-sec-pr1450');
    expect(manifest.metadata.namespace).toBe('ct-review-system');

    expect(manifest.spec.ttlSecondsAfterFinished).toBe(300);
    expect(manifest.spec.activeDeadlineSeconds).toBe(600);
    expect(manifest.spec.backoffLimit).toBe(1);

    const container = manifest.spec.template.spec.containers[0];
    expect(container.name).toBe('reviewer-agent');
    expect(container.resources.requests.cpu).toBe('250m');
    expect(container.resources.requests.memory).toBe('512Mi');
    expect(container.resources.limits.cpu).toBe('500m');
    expect(container.resources.limits.memory).toBe('1Gi');

    const volumeMount = container.volumeMounts[0];
    expect(volumeMount.mountPath).toBe('/workspace');
    expect(volumeMount.subPath).toContain('calltelemetry_ct-meta_pr1450');

    const volume = manifest.spec.template.spec.volumes[0];
    expect(volume.persistentVolumeClaim?.claimName).toBe('ct-review-bot-workspace-pvc');
  });

  it('dispatches job in simulation mode when outside active K8s cluster', async () => {
    const runner = new K8sJobRunner({ forceSimulation: true });

    const result = await runner.dispatchJob({
      persona: 'performance',
      repoUrl: 'calltelemetry/cisco-cdr',
      prNumber: 204,
      commitSha: 'a1b2c3d4e5f6',
      envVars: { CUSTOM_RULE: 'strict' },
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('simulation');
    expect(result.namespace).toBe('ct-review-system');
    expect(result.jobName).toContain('ct-agent-performance-pr204');
    expect(result.manifest.spec.template.spec.containers[0].env).toEqual(
      expect.arrayContaining([{ name: 'CUSTOM_RULE', value: 'strict' }])
    );
  });

  it('supports custom resource limits, activeDeadlineSeconds, and PVC override', () => {
    const runner = new K8sJobRunner({
      namespace: 'custom-ns',
      defaultPvcName: 'custom-pvc',
    });

    const manifest = runner.generateJobManifest({
      persona: 'architecture',
      repoUrl: 'org/repo',
      prNumber: 99,
      commitSha: '123456789',
      cpuLimit: '1000m',
      memoryLimit: '2Gi',
      activeDeadlineSeconds: 1200,
      ttlSecondsAfterFinished: 600,
    });

    expect(manifest.metadata.namespace).toBe('custom-ns');
    expect(manifest.spec.activeDeadlineSeconds).toBe(1200);
    expect(manifest.spec.ttlSecondsAfterFinished).toBe(600);
    expect(manifest.spec.template.spec.containers[0].resources.limits.cpu).toBe('1000m');
    expect(manifest.spec.template.spec.containers[0].resources.limits.memory).toBe('2Gi');
    expect(manifest.spec.template.spec.volumes[0].persistentVolumeClaim?.claimName).toBe('custom-pvc');
  });

  it('GET /api/github/app-config returns active GitHub App onboarding status', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/github', createGitHubAppApiRouter());

    await request(app)
      .put('/api/github/app-config')
      .send({ appId: '123456', webhookSecret: 'secret' });

    const res = await request(app).get('/api/github/app-config');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.appConfig.status).toBe('configured');
  });

  it('PUT /api/github/enforcement-policy updates failureAction and requireAllReviews', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/github', createGitHubAppApiRouter());

    const updateRes = await request(app)
      .put('/api/github/enforcement-policy')
      .send({
        failureAction: 'quarantine',
        requireAllReviews: true,
        requireTicketLink: true,
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.policy.failureAction).toBe('quarantine');
    expect(updateRes.body.policy.requireTicketLink).toBe(true);
  });
});

