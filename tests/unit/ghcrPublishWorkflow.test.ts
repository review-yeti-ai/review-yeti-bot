import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const workflow = fs.readFileSync(
  path.join(process.cwd(), '.github/workflows/ci-cd.yaml'),
  'utf8',
);

function workflowJob(name: string): string {
  const match = workflow.match(
    new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:|$)`),
  );
  if (!match) throw new Error(`missing job ${name}`);
  return match[1];
}

describe('GHCR publish contract', () => {
  it('publishes digest-pinned images to ghcr.io/review-yeti-ai without Docker Hub or DOKS', () => {
    expect(workflow).toContain('publish-ghcr:');
    expect(workflow).toContain('GHCR_REGISTRY: ghcr.io/review-yeti-ai');
    expect(workflow).toContain('registry: ghcr.io');
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9');
    expect(workflow).toContain('review-yeti-bot:${{ github.sha }}');
    expect(workflow).toContain('review-yeti-worker:${{ github.sha }}');
    expect(workflow).toContain('review-yeti-worker:latest');
    expect(workflow).toContain('review-yeti-operator:${{ github.sha }}');
    expect(workflow).toContain('review-yeti-legacy-runtime:${{ github.sha }}');
    expect(workflow).toContain('npm run build');
    expect(workflow).toContain('test -f dist/index.js');
    expect(workflow).toContain('org.opencontainers.image.source=');
    expect(workflow).toContain('visibility=public');
    const archJob = workflowJob('publish-ghcr-arch')
      .split('\n')
      .filter((line) => !/^\s*#/u.test(line))
      .join('\n');
    expect(archJob).toMatch(/needs:\s*\[test, legacy-runtime, typecheck\]/u);
    expect(archJob).toMatch(/if:[\s\S]*?\balways\(\)/u);
    expect(archJob).toContain("needs.test.result == 'success' || needs.test.result == 'skipped'");
    expect(archJob).toContain(
      "needs.legacy-runtime.result == 'success' || needs.legacy-runtime.result == 'skipped'",
    );
    expect(archJob).toContain("needs.typecheck.result == 'success'");

    const mergeJob = workflowJob('publish-ghcr');
    expect(mergeJob).toMatch(/needs:\s*\[publish-ghcr-arch\]/u);
    expect(mergeJob).toMatch(/if:[\s\S]*?\balways\(\)/u);
    expect(mergeJob).toContain("needs.publish-ghcr-arch.result == 'success'");

    const attestJob = workflowJob('attest-published-indexes');
    expect(attestJob).toMatch(/needs:\s*publish-ghcr(?!-)/u);
    expect(attestJob).toMatch(/if:[\s\S]*?\balways\(\)/u);
    expect(attestJob).toContain("needs.publish-ghcr.result == 'success'");

    const publishJobs = `${workflowJob('publish-ghcr-arch')}\n${workflowJob('publish-ghcr')}`;
    expect(publishJobs).not.toContain('digitalocean/action-doctl');
    expect(publishJobs).not.toMatch(/\b(?:doctl|kubectl|DIGITALOCEAN_ACCESS_TOKEN|CLUSTER_NAME)\b/u);
    expect(publishJobs).not.toContain('docker.io');
    expect(publishJobs).not.toContain('registry.digitalocean.com');
  });

  it('builds native per-arch GHCR images on Blacksmith 2vCPU then merges without qemu', () => {
    const arch = workflowJob('publish-ghcr-arch');
    const merge = workflowJob('publish-ghcr');

    expect(arch).toContain('runner: ubuntu-latest');
    expect(arch).toContain('runner: blacksmith-2vcpu-ubuntu-2404-arm');
    expect(arch).toContain('runs-on: ${{ matrix.runner }}');
    expect(arch).toContain('arch: amd64');
    expect(arch).toContain('arch: arm64');
    expect(arch).toContain('platforms: linux/${{ matrix.arch }}');
    expect(arch).not.toContain('linux/amd64,linux/arm64');
    expect(arch).not.toContain('setup-qemu');
    expect(arch).toContain('uses: useblacksmith/setup-docker-builder@v2');
    expect(arch).toContain('cache-key: review-yeti-node-images-arm64');
    expect(arch).toContain('${{ github.sha }}-${{ matrix.arch }}');
    expect(arch).not.toContain('--platform linux/amd64');

    expect(merge).toMatch(/runs-on:\s*ubuntu-24\.04-arm/);
    expect(merge).toContain('docker buildx imagetools create');
    expect(merge).toContain('imagetools inspect --raw');
    expect(merge).toContain('visibility=public');
    expect(merge.indexOf('visibility=public')).toBeLessThan(
      merge.indexOf('verify-worker-image-size.mjs'),
    );
    expect(merge).not.toContain('setup-qemu');
    expect(merge).not.toContain('linux/amd64,linux/arm64');
  });
});
