import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const canonicalPath = path.join(root, '.github/workflows/release.yml');
const duplicatePath = path.join(root, '.github/workflows/release-semver.yaml');
const rollingPath = path.join(root, '.github/workflows/update-major-tag.yml');

describe('release workflow contract', () => {
  it('has one numeric-semver tag publisher and does not run on rolling v1', () => {
    const workflow = fs.readFileSync(canonicalPath, 'utf8');
    expect(fs.existsSync(duplicatePath)).toBe(false);
    expect(workflow).toContain("- 'v*.*.*'");
    expect(workflow).not.toContain("- 'v*'");
    expect(workflow).toContain('validate-release-version.mjs');
    expect(workflow).toContain(
      "ref: ${{ github.event_name == 'workflow_dispatch' && inputs.version || github.ref }}",
    );
  });

  it('validates identity before quality gates and contains no runtime deployment job', () => {
    const workflow = fs.readFileSync(canonicalPath, 'utf8');
    const validation = workflow.indexOf('validate-release-version.mjs');
    const build = workflow.indexOf('npm run build');
    expect(validation).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(validation);
    expect(workflow).toContain('Execute Fast Quality Test Suite');
    expect(workflow).toContain('Run Benchmark Evaluation & Automated Quality Gate');
    expect(workflow).not.toMatch(/^\s*deploy:/mu);
    expect(workflow).not.toContain('docker/build-push-action');
    expect(workflow).not.toContain('validate and deploy');
    expect(workflow).not.toMatch(/\bdeploy(?:ment)?\b/iu);
    expect(workflow).not.toMatch(/packages:\s*write/u);
    expect(workflow).not.toContain('digitalocean/action-doctl');
    expect(workflow).not.toMatch(/\b(?:DOKS|DigitalOcean|doctl|kubectl)\b/u);
  });

  it('promotes rolling v1 only downstream of the canonical validated release job', () => {
    const workflow = fs.readFileSync(canonicalPath, 'utf8');
    const rollingWorkflow = fs.readFileSync(rollingPath, 'utf8');
    expect(workflow).toMatch(/promote-rolling-v1:[\s\S]*needs:\s*validate-and-release/u);
    expect(workflow).toContain('git push origin v1 --force');
    expect(workflow).toContain('token: ${{ secrets.RELEASE_PLEASE_TOKEN }}');
    expect(rollingWorkflow).toContain('unreleased_recovery');
    expect(rollingWorkflow).toContain('token: ${{ secrets.RELEASE_PLEASE_TOKEN }}');
  });
});
