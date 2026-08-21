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
  });

  it('validates identity before quality gates and preserves deployment gates', () => {
    const workflow = fs.readFileSync(canonicalPath, 'utf8');
    const validation = workflow.indexOf('validate-release-version.mjs');
    const build = workflow.indexOf('npm run build');
    expect(validation).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(validation);
    expect(workflow).toContain('docker/build-push-action');
    expect(workflow).toContain('kubectl rollout status');
    expect(workflow).toMatch(/deploy:[\s\S]*runs-on: ubuntu-latest/u);
    expect(workflow).toContain('Promotion remains downstream of this deploy job.');
  });

  it('promotes rolling v1 only downstream of the canonical release and deployment jobs', () => {
    const workflow = fs.readFileSync(canonicalPath, 'utf8');
    expect(workflow).toMatch(/promote-rolling-v1:[\s\S]*needs:\s*deploy/u);
    expect(workflow).toContain('git push origin v1 --force');
    expect(fs.readFileSync(rollingPath, 'utf8')).toContain('unreleased_recovery');
  });
});
