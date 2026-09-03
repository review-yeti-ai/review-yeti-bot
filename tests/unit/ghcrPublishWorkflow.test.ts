import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const workflow = fs.readFileSync(
  path.join(process.cwd(), '.github/workflows/ci-cd.yaml'),
  'utf8',
);

describe('GHCR publish contract', () => {
  it('publishes digest-pinned images to ghcr.io/review-yeti-ai without Docker Hub or DOKS', () => {
    expect(workflow).toContain('publish-ghcr:');
    expect(workflow).toContain('GHCR_REGISTRY: ghcr.io/review-yeti-ai');
    expect(workflow).toContain('registry: ghcr.io');
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9');
    expect(workflow).toContain('review-yeti-bot:${{ github.sha }}');
    expect(workflow).toContain('review-yeti-worker:${{ github.sha }}');
    expect(workflow).toContain('review-yeti-operator:${{ github.sha }}');
    expect(workflow).toContain('review-yeti-legacy-runtime:${{ github.sha }}');
    expect(workflow).toMatch(/publish-ghcr:[\s\S]*needs:\s*\[test, legacy-runtime\]/u);

    const publishJob = workflow.split('publish-ghcr:')[1].split('build-and-deploy:')[0];
    expect(publishJob).not.toContain('digitalocean/action-doctl');
    expect(publishJob).not.toMatch(/\b(?:doctl|kubectl|DIGITALOCEAN_ACCESS_TOKEN|CLUSTER_NAME)\b/u);
    expect(publishJob).not.toContain('docker.io');
    expect(publishJob).not.toContain('registry.digitalocean.com');
  });
});
