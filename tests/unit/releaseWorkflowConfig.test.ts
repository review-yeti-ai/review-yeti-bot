import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workflowPath = path.join(root, '.github/workflows/release-please.yml');
const configPath = path.join(root, 'release-please-config.json');
const manifestPath = path.join(root, '.release-please-manifest.json');
const packagePath = path.join(root, 'package.json');

describe('Release Please configuration', () => {
  it('runs on main pushes with write permissions needed for a reviewed release PR', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toMatch(/on:\s*\n\s+push:\s*\n\s+branches:\s*\n\s+- main/u);
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN');
    expect(workflow).toMatch(/googleapis\/release-please-action@[0-9a-f]{40}/u);
    expect(workflow).toContain('target-branch: main');
  });

  it('merges the release PR itself, so a reviewed main merge becomes a tagged release unattended', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    // The release chain is: main merge -> release-please opens/updates the release PR -> this job
    // merges it -> release-please tags and publishes on the next main push -> release.yml's
    // promote-rolling-v1 moves the rolling v1 consumer channel. This job is the only link that
    // used to be a human step.
    expect(workflow).toContain('merge-release-pr:');
    expect(workflow).toMatch(/merge-release-pr:[\s\S]*needs:\s*release-please/u);
    expect(workflow).toContain('gh pr merge "$pr" --squash');

    // Never arm GitHub auto-merge: it fires unattended on whatever the required contexts report,
    // including on a re-run long after the head was reviewed. Check executable lines only -- the
    // workflow's own comments say the words "gh pr merge --auto" to explain the choice.
    const executable = workflow
      .split('\n')
      .filter((line) => !/^\s*#/u.test(line))
      .join('\n');
    expect(executable).not.toContain('--auto');
    expect(executable).not.toContain('enable-pull-request-automerge');

    // The wait must be bound to one exact head, must refuse a failing conclusion, and must be
    // bounded in time rather than looping until the job is killed.
    expect(workflow).toContain('headRefOid');
    expect(workflow).toMatch(/refusing to merge/u);
    expect(workflow).toMatch(/"FAILURE"/u);
    expect(workflow).toMatch(/"TIMED_OUT"/u);
    expect(workflow).toMatch(/deadline=\$\(\( SECONDS \+ 45 \* 60 \)\)/u);
    expect(workflow).toMatch(/timeout-minutes:\s*60/u);
  });

  it('gives the required test job room for a cold cache instead of killing it as a stall', () => {
    // A release-please PR bumps package.json/package-lock.json, which misses the npm and vitest
    // cache keys; at timeout-minutes: 15 those runs were killed mid-build and reported
    // `cancelled`, which blocks the merge above forever.
    const ciWorkflow = fs.readFileSync(path.join(root, '.github/workflows/ci-cd.yaml'), 'utf8');
    const testJob = ciWorkflow.slice(ciWorkflow.indexOf('\n  test:'), ciWorkflow.indexOf('\n  legacy-runtime:'));
    const timeout = /timeout-minutes:\s*(\d+)/u.exec(testJob);
    expect(timeout).not.toBeNull();
    expect(Number(timeout![1])).toBeGreaterThanOrEqual(25);
    // Still bounded: an unbounded or absurd cap would defeat the stall detector entirely.
    expect(Number(timeout![1])).toBeLessThanOrEqual(45);
  });

  it('uses the Node strategy and records the last released semver baseline', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    expect(config.packages['.']).toMatchObject({
      'release-type': 'node',
      'package-name': 'ct-review-bot',
    });
    expect(manifest).toEqual({ '.': packageJson.version });
  });
});
