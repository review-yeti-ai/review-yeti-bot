import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const scriptPath = path.resolve(__dirname, '../../scripts/fetch-pr-diff.sh');
const fakeGhSource = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "api" ]]; then
  if [[ "\$*" == *"/files"* ]]; then
    echo "\${FAKE_GH_FILES_JSON:-[]}"
    exit 0
  fi
  echo "\${FAKE_GH_PR_JSON:-null}"
  exit 0
elif [[ "\${1:-}" == "pr" && "\${2:-}" == "diff" ]]; then
  if [[ -n "\${FAKE_GH_PR_DIFF_CALLED_MARKER:-}" ]]; then : > "\$FAKE_GH_PR_DIFF_CALLED_MARKER"; fi
  if [[ -n "\${FAKE_GH_PR_DIFF_STDOUT:-}" ]]; then printf '%s' "\$FAKE_GH_PR_DIFF_STDOUT"; fi
  if [[ -n "\${FAKE_GH_PR_DIFF_STDERR:-}" ]]; then printf '%s' "\$FAKE_GH_PR_DIFF_STDERR" >&2; fi
  exit "\${FAKE_GH_PR_DIFF_EXIT:-0}"
else
  echo "unhandled fake gh invocation: \$*" >&2
  exit 1
fi
`;

let workDirs: string[] = [];

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  workDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
  workDirs = [];
});

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeFakeGh(dir: string) {
  const ghPath = path.join(dir, 'gh');
  fs.writeFileSync(ghPath, fakeGhSource, { mode: 0o755 });
  return ghPath;
}

/** A plain base -> head commit pair on one branch, pushed to a local bare "remote". */
function buildLinearFixture() {
  const workDir = tempDir('fetch-pr-diff-linear-');
  const remoteDir = path.join(workDir, 'remote.git');
  git(['init', '-q', '--bare', remoteDir], workDir);
  git(['config', 'uploadpack.allowanysha1inwant', 'true'], remoteDir);
  git(['config', 'uploadpack.allowfilter', 'true'], remoteDir);

  const repoDir = path.join(workDir, 'work');
  fs.mkdirSync(repoDir);
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 't@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);

  fs.writeFileSync(path.join(repoDir, 'shared.ts'), 'base\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', 'base'], repoDir);
  const baseSha = git(['rev-parse', 'HEAD'], repoDir).trim();

  fs.writeFileSync(path.join(repoDir, 'shared.ts'), 'head\n');
  fs.writeFileSync(path.join(repoDir, 'package-lock.json'), '{}\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', 'head'], repoDir);
  const headSha = git(['rev-parse', 'HEAD'], repoDir).trim();

  git(['push', '-q', remoteDir, `${baseSha}:refs/heads/base`, `${headSha}:refs/heads/head`], repoDir);

  return { workDir, remoteDir, baseSha, headSha };
}

/**
 * A 2-parent merge commit built with commit-tree, so no real `git merge` /
 * conflict resolution is needed. parent1 (targetTip) and parent2
 * (sourceTip) are deliberately unrelated commits: the merge commit's tree
 * carries the resolved content directly.
 */
function buildForwardMergeFixture() {
  const workDir = tempDir('fetch-pr-diff-fmerge-');
  const remoteDir = path.join(workDir, 'remote.git');
  git(['init', '-q', '--bare', remoteDir], workDir);
  git(['config', 'uploadpack.allowanysha1inwant', 'true'], remoteDir);
  git(['config', 'uploadpack.allowfilter', 'true'], remoteDir);

  const repoDir = path.join(workDir, 'work');
  fs.mkdirSync(repoDir);
  git(['init', '-q'], repoDir);
  git(['config', 'user.email', 't@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);

  // target tip (parent1 / PR base): shared.ts = A
  fs.writeFileSync(path.join(repoDir, 'shared.ts'), 'A\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', 'target tip'], repoDir);
  const targetTip = git(['rev-parse', 'HEAD'], repoDir).trim();

  // source tip (parent2): shared.ts = B, sourceonly.ts = X (unrelated root commit)
  git(['checkout', '-q', '--orphan', 'sourceline'], repoDir);
  git(['rm', '-rf', '-q', '.'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'shared.ts'), 'B\n');
  fs.writeFileSync(path.join(repoDir, 'sourceonly.ts'), 'X\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-q', '-m', 'source tip'], repoDir);
  const sourceTip = git(['rev-parse', 'HEAD'], repoDir).trim();

  // merge result: shared.ts resolved to C, sourceonly.ts carried through unchanged
  git(['checkout', '-q', targetTip], repoDir);
  fs.writeFileSync(path.join(repoDir, 'shared.ts'), 'C\n');
  fs.writeFileSync(path.join(repoDir, 'sourceonly.ts'), 'X\n');
  git(['add', '-A'], repoDir);
  const treeSha = git(['write-tree'], repoDir).trim();
  const headSha = git(
    ['commit-tree', treeSha, '-p', targetTip, '-p', sourceTip, '-m', 'chore: forward-merge source into target'],
    repoDir,
  ).trim();

  git(
    ['push', '-q', remoteDir, `${targetTip}:refs/heads/target`, `${sourceTip}:refs/heads/source`, `${headSha}:refs/heads/merged`],
    repoDir,
  );

  return { workDir, remoteDir, targetTip, sourceTip, headSha };
}

function runScript(env: Record<string, string>) {
  const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-pr-diff-out-')), 'out.diff');
  const githubOutputPath = path.join(path.dirname(outputPath), 'github_output.txt');
  fs.writeFileSync(githubOutputPath, '');
  workDirs.push(path.dirname(outputPath));

  execFileSync('bash', [scriptPath], {
    env: {
      PATH: process.env.PATH,
      GH_TOKEN: 'fake-token',
      DIFF_OUTPUT_PATH: outputPath,
      GITHUB_OUTPUT: githubOutputPath,
      ...env,
    },
    encoding: 'utf8',
  });

  const diffText = fs.readFileSync(outputPath, 'utf8');
  const outputLines = fs.readFileSync(githubOutputPath, 'utf8').trim().split('\n').filter(Boolean);
  const outputs: Record<string, string> = {};
  for (const line of outputLines) {
    const idx = line.indexOf('=');
    if (idx > 0) outputs[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return { diffText, outputs };
}

describe('fetch-pr-diff.sh', () => {
  it('falls back to a local clone diff when the pull request is over the GitHub diff size limit', () => {
    const fixture = buildLinearFixture();
    const ghDir = tempDir('fake-gh-bin-');
    const ghPath = makeFakeGh(ghDir);
    const marker = path.join(ghDir, 'pr-diff-called');

    const { diffText, outputs } = runScript({
      GH_BIN: ghPath,
      REPO: 'calltelemetry/fake-repo',
      PR_NUMBER: '1',
      PR_HEAD_SHA: fixture.headSha,
      PR_BASE_SHA: fixture.baseSha,
      PR_DIFF_REMOTE_URL: `file://${fixture.remoteDir}`,
      FAKE_GH_PR_JSON: JSON.stringify({ changed_files: 500, additions: 10, deletions: 10 }),
      FAKE_GH_PR_DIFF_CALLED_MARKER: marker,
    });

    expect(fs.existsSync(marker)).toBe(false); // gh pr diff was never invoked
    expect(outputs['used-fallback']).toBe('true');
    expect(outputs['fallback-mode']).toBe('git-clone');
    expect(outputs['fallback-reason']).toBe('preemptive-threshold');
    expect(diffText).toContain('shared.ts');
    expect(diffText).toContain('-base');
    expect(diffText).toContain('+head');
  });

  it('falls back after gh pr diff reports the GitHub 406 diff-size error', () => {
    const fixture = buildLinearFixture();
    const ghDir = tempDir('fake-gh-bin-');
    const ghPath = makeFakeGh(ghDir);

    const { diffText, outputs } = runScript({
      GH_BIN: ghPath,
      REPO: 'calltelemetry/fake-repo',
      PR_NUMBER: '2',
      PR_HEAD_SHA: fixture.headSha,
      PR_BASE_SHA: fixture.baseSha,
      PR_DIFF_REMOTE_URL: `file://${fixture.remoteDir}`,
      FAKE_GH_PR_JSON: JSON.stringify({ changed_files: 12, additions: 40, deletions: 12 }),
      FAKE_GH_PR_DIFF_EXIT: '1',
      FAKE_GH_PR_DIFF_STDERR: "HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.",
    });

    expect(outputs['used-fallback']).toBe('true');
    expect(outputs['fallback-mode']).toBe('git-clone');
    expect(outputs['fallback-reason']).toBe('gh-pr-diff-406');
    expect(diffText).toContain('shared.ts');
  });

  it('does not fall back and passes the primary diff through when gh pr diff succeeds', () => {
    const fixture = buildLinearFixture();
    const ghDir = tempDir('fake-gh-bin-');
    const ghPath = makeFakeGh(ghDir);
    const primaryDiff = [
      'diff --git a/shared.ts b/shared.ts',
      '--- a/shared.ts',
      '+++ b/shared.ts',
      '@@ -1 +1 @@',
      '-base',
      '+head',
      '',
    ].join('\n');

    const { diffText, outputs } = runScript({
      GH_BIN: ghPath,
      REPO: 'calltelemetry/fake-repo',
      PR_NUMBER: '3',
      PR_HEAD_SHA: fixture.headSha,
      PR_BASE_SHA: fixture.baseSha,
      PR_DIFF_REMOTE_URL: `file://${fixture.remoteDir}`,
      FAKE_GH_PR_JSON: JSON.stringify({ changed_files: 1, additions: 1, deletions: 1 }),
      FAKE_GH_PR_DIFF_EXIT: '0',
      FAKE_GH_PR_DIFF_STDOUT: primaryDiff,
    });

    expect(outputs['used-fallback']).toBe('false');
    expect(outputs['fallback-mode']).toBe('none');
    expect(diffText).toContain('shared.ts');
  });

  it('fails loudly instead of silently falling back on a non-size-limit gh pr diff error', () => {
    const fixture = buildLinearFixture();
    const ghDir = tempDir('fake-gh-bin-');
    const ghPath = makeFakeGh(ghDir);

    expect(() =>
      runScript({
        GH_BIN: ghPath,
        REPO: 'calltelemetry/fake-repo',
        PR_NUMBER: '4',
        PR_HEAD_SHA: fixture.headSha,
        PR_BASE_SHA: fixture.baseSha,
        PR_DIFF_REMOTE_URL: `file://${fixture.remoteDir}`,
        FAKE_GH_PR_JSON: JSON.stringify({ changed_files: 1, additions: 1, deletions: 1 }),
        FAKE_GH_PR_DIFF_EXIT: '1',
        FAKE_GH_PR_DIFF_STDERR: 'HTTP 401: Bad credentials',
      }),
    ).toThrow();
  });

  it('reviews the conflict-resolution delta (second parent vs. head) for a forward-merge PR, not the full base diff', () => {
    const fixture = buildForwardMergeFixture();
    const ghDir = tempDir('fake-gh-bin-');
    const ghPath = makeFakeGh(ghDir);

    const { diffText, outputs } = runScript({
      GH_BIN: ghPath,
      REPO: 'calltelemetry/fake-repo',
      PR_NUMBER: '5',
      PR_HEAD_SHA: fixture.headSha,
      PR_BASE_SHA: fixture.targetTip,
      PR_TITLE: 'chore: forward-merge source into target',
      PR_DIFF_REMOTE_URL: `file://${fixture.remoteDir}`,
      FAKE_GH_PR_JSON: JSON.stringify({ changed_files: 3000, additions: 100000, deletions: 90000 }),
    });

    expect(outputs['used-fallback']).toBe('true');
    expect(outputs['fallback-mode']).toBe('forward-merge-conflict-delta');
    // shared.ts really was resolved by hand (B -> C against the source tip): must appear.
    expect(diffText).toContain('shared.ts');
    expect(diffText).toContain('-B');
    expect(diffText).toContain('+C');
    // sourceonly.ts was carried through unchanged from the source tip and must NOT
    // show up as a new file -- that would mean the script diffed against the
    // target tip (base) instead of the source tip (second parent).
    expect(diffText).not.toContain('sourceonly.ts');
  });

  it('falls back to the pull request files API when the local clone cannot reach the remote', () => {
    const fixture = buildLinearFixture();
    const ghDir = tempDir('fake-gh-bin-');
    const ghPath = makeFakeGh(ghDir);
    const unreachable = path.join(fixture.workDir, 'does-not-exist.git');

    const { diffText, outputs } = runScript({
      GH_BIN: ghPath,
      REPO: 'calltelemetry/fake-repo',
      PR_NUMBER: '6',
      PR_HEAD_SHA: fixture.headSha,
      PR_BASE_SHA: fixture.baseSha,
      PR_DIFF_REMOTE_URL: `file://${unreachable}`,
      FAKE_GH_PR_JSON: JSON.stringify({ changed_files: 500, additions: 10, deletions: 10 }),
      FAKE_GH_FILES_JSON: JSON.stringify([
        { filename: 'shared.ts', status: 'modified', patch: '@@ -1 +1 @@\n-base\n+head' },
      ]),
    });

    expect(outputs['used-fallback']).toBe('true');
    expect(outputs['fallback-mode']).toBe('gh-files-api');
    expect(diffText).toContain('diff --git a/shared.ts b/shared.ts');
    expect(diffText).toContain('-base');
    expect(diffText).toContain('+head');
  });
});
