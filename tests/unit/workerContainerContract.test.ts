import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(__dirname, '../..');
const dockerfilePath = resolve(repositoryRoot, 'Dockerfile.worker');
const baseImageEnvPath = resolve(repositoryRoot, '.github/worker-image.env');
const stagingScriptPath = resolve(repositoryRoot, 'scripts/stage-worker-runtime.mjs');
const liveReviewPath = resolve(repositoryRoot, 'src/cli/runLiveReview.ts');
const selfTestModulesPath = resolve(repositoryRoot, 'src/cli/workerSelfTestModules.json');
const ciWorkflowPath = resolve(repositoryRoot, '.github/workflows/ci-cd.yaml');
const sizeGatePath = resolve(repositoryRoot, 'scripts/verify-worker-image-size.mjs');

function readRequired(path: string): string {
  expect(existsSync(path), `expected ${path} to exist`).toBe(true);
  return readFileSync(path, 'utf8');
}

function commandsPresent(image: string, commands: string[]): boolean[] {
  return commands.map((command) => {
    try {
      execFileSync('docker', ['run', '--rm', '--entrypoint', '/bin/sh', image, '-c', `command -v ${command}`], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  });
}

function pathsPresent(image: string, paths: string[]): boolean[] {
  return paths.map((path) => {
    try {
      execFileSync('docker', ['run', '--rm', '--entrypoint', '/bin/sh', image, '-c', `test -e ${path}`], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  });
}

describe('worker container contract', () => {
  it('pins the Node 24 base image to an immutable digest', () => {
    const env = readRequired(baseImageEnvPath);
    const baseImage = env.match(/^NODE_BASE_IMAGE=(.+)$/mu)?.[1]?.trim() || '';
    expect(baseImage).toMatch(/^node:24-bookworm-slim@sha256:[a-f0-9]{64}$/u);
  });

  it('defines a worker-only hardened multi-stage image', () => {
    const dockerfile = readRequired(dockerfilePath);
    expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:1\.7$/mu);
    expect(dockerfile).toMatch(/^ARG NODE_BASE_IMAGE$/mu);
    expect(dockerfile).toMatch(/^FROM \$\{NODE_BASE_IMAGE\} AS build$/mu);
    expect(dockerfile).toMatch(/^FROM \$\{NODE_BASE_IMAGE\} AS worker$/mu);
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/dist/cli/runLiveReview.js"]');
    // Kubernetes runAsNonRoot admission must be able to prove the image user
    // is non-root. A symbolic `USER node` is not verifiable by kubelet.
    expect(dockerfile).toContain('USER 1000:1000');
    expect(dockerfile).not.toMatch(/^USER node$/mu);
    expect(dockerfile).toContain('ENV NODE_ENV=production');
    expect(dockerfile).toContain('snapshot.debian.org/archive/debian/20260824T000000Z');
    expect(dockerfile).toContain('snapshot.debian.org/archive/debian-security/20260824T000000Z');
    expect(dockerfile).toContain('ca-certificates=20250419~deb12u1');
    expect(dockerfile).toContain('git=1:2.39.5-0+deb12u3');
    expect(dockerfile).toContain('ripgrep=13.0.0-4+b2');
    expect(dockerfile).toContain('rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx');
    expect(dockerfile).not.toMatch(/HEALTHCHECK/u);
    expect(dockerfile).not.toMatch(/CMD \["node", "dist\/index\.js"\]/u);
    expect(dockerfile).not.toMatch(/curl\s+[^\n|]*\|\s*(?:sh|bash)/u);
    expect(dockerfile).not.toMatch(/\b(?:ENV|ARG)\s+[^\n]*(?:TOKEN|SECRET|PRIVATE_KEY|API_KEY)/iu);
    expect(dockerfile).not.toMatch(/\bnpm\s+install\b/u);
    expect(dockerfile).not.toMatch(/\b(?:node|base|worker):latest\b/u);
  });

  it('stages a traced, secret-free runtime closure and required dynamic packages', () => {
    const script = readRequired(stagingScriptPath);
    expect(script).toContain("import { nodeFileTrace } from '@vercel/nft';");
    for (const packageName of [
      '@earendil-works/pi-ai',
      '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-tui',
      '@quintinshaw/pi-dynamic-workflows',
      'typebox',
    ]) {
      expect(script).toContain(`'${packageName}'`);
    }
    expect(script).toContain('runtime-manifest.json');
    expect(script).toContain('createHash');
    expect(script).toContain('workerSelfTestModules.json');
    expect(script).toMatch(/(?:tests|coverage|\.git)/u);
    expect(script).toContain('path.relative');
  });

  it('exposes an offline self-test entrypoint and keeps image publication manual', () => {
    const liveReview = readRequired(liveReviewPath);
    const selfTestModules = JSON.parse(readRequired(selfTestModulesPath));
    const workflow = readRequired(ciWorkflowPath);
    expect(liveReview).toContain("process.argv.includes('--self-test')");
    expect(liveReview).toContain('runWorkerSelfTest');
    expect(selfTestModules).toHaveLength(7);
    expect(selfTestModules.map((module: { id: string }) => module.id)).toContain('../github/qualificationReader');
    expect(selfTestModules.map((module: { id: string }) => module.id)).toContain('../k8s/reviewJobDispatchEngine');
    expect(workflow).toContain('file: Dockerfile.worker');
    expect(workflow).toContain('NODE_BASE_IMAGE=');
    expect(workflow).toContain('--self-test');
    expect(workflow).toContain('verify-worker-image-size.mjs');
    expect(workflow).toContain('inputs.deploy');
  });

  it('enforces compressed size and service-relative size gates from OCI manifests', () => {
    const script = readRequired(sizeGatePath);
    expect(script).toContain("['buildx', 'imagetools', 'inspect', '--raw', image]");
    expect(script).toContain('300 * 1024 * 1024');
    expect(script).toContain('workerBytes * 2 > serviceBytes');
    expect(script).not.toMatch(/exec\([^)]*image/iu);
  });

  it('keeps optional runtime inspection helpers shell-safe', () => {
    expect(commandsPresent).toBeTypeOf('function');
    expect(pathsPresent).toBeTypeOf('function');
    expect(commandsPresent.toString()).not.toMatch(/exec\([^)]*image/iu);
    expect(pathsPresent.toString()).not.toMatch(/exec\([^)]*image/iu);
  });

  it('supports an explicit integration inspection when requested', () => {
    if (process.env.RUN_WORKER_IMAGE_INTEGRATION !== '1') return;
    const image = process.env.WORKER_IMAGE_UNDER_TEST?.trim();
    expect(image).toMatch(/^[a-z0-9./:@_-]+$/u);
    expect(commandsPresent(image!, ['node', 'git', 'rg'])).toEqual([true, true, true]);
    expect(commandsPresent(image!, ['gh', 'npm', 'tsc', 'next'])).toEqual([false, false, false, false]);
    expect(pathsPresent(image!, ['/app/tests', '/app/.git', '/app/public'])).toEqual([false, false, false]);
  });
});
