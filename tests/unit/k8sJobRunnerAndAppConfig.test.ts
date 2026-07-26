import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { K8sJobRunner } from '../../src/infrastructure/k8sJobRunner';
import { createGitHubAppApiRouter } from '../../src/api/githubAppApi';

describe('K8s Sandbox Job Runner & GitHub App Policy Suite (Release v1.5.0)', () => {
  it('generates valid Kubernetes batch/v1 Job manifests with shared PVC workspace mounts', () => {
    const runner = new K8sJobRunner({
      namespace: 'ct-review-bot',
      defaultPvcName: 'ct-workspace-shared-pvc',
    });

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
    expect(manifest.metadata.namespace).toBe('ct-review-bot');

    const container = manifest.spec.template.spec.containers[0];
    expect(container.name).toBe('reviewer-agent');
    expect(container.resources.limits.memory).toBe('1Gi');

    const volumeMount = container.volumeMounts[0];
    expect(volumeMount.mountPath).toBe('/workspace');
    expect(volumeMount.subPath).toContain('calltelemetry_ct-meta_pr1450');

    const volume = manifest.spec.template.spec.volumes[0];
    expect(volume.persistentVolumeClaim?.claimName).toBe('ct-workspace-shared-pvc');
  });

  it('GET /api/github/app-config returns active GitHub App onboarding status', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/github', createGitHubAppApiRouter());

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
