import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

describe('versioning without release automation', () => {
  it('keeps package-lock version aligned with package.json', () => {
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');

    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[''].version).toBe(packageJson.version);
  });

  it('does not ship release-please or DOKS deploy workflows', () => {
    const workflowsDir = path.join(root, '.github/workflows');
    const names = fs.readdirSync(workflowsDir);

    expect(names).not.toContain('release-semver.yaml');
    expect(names).not.toContain('deploy-review-yeti.yaml');
    expect(fs.existsSync(path.join(root, 'release-please-config.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.release-please-manifest.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'scripts/deploy-doks.sh'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'scripts/deploy-review-yeti.sh'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'scripts/verify-doks.sh'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'k8s'))).toBe(false);
  });

  it('checks pull request titles before conventional commits reach main', () => {
    const workflowPath = path.join(root, '.github/workflows/conventional-pr-title.yaml');
    const workflowSource = fs.readFileSync(workflowPath, 'utf8');
    const workflow: any = yaml.load(workflowSource);

    expect(workflow.on.pull_request.types).toEqual(
      expect.arrayContaining(['opened', 'edited', 'synchronize', 'reopened'])
    );
    expect(workflowSource).toContain('feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert');
    expect(workflowSource).toContain('Pull request titles must follow Conventional Commits.');
  });

  it('runs CI as test-only on GitHub-hosted runners', () => {
    const workflowPath = path.join(root, '.github/workflows/ci-cd.yaml');
    const workflowSource = fs.readFileSync(workflowPath, 'utf8');

    expect(workflowSource).not.toMatch(/doctl|kubectl|DIGITALOCEAN|deploy-doks|build-and-deploy/i);
    expect(workflowSource).not.toMatch(/blacksmith|useblacksmith/i);
    expect(workflowSource).toContain('ubuntu-latest');
    expect(workflowSource).toMatch(/npm (test|run lint)/);
  });
});
