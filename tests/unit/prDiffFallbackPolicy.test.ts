import { describe, expect, it } from 'vitest';
import path from 'path';

const modulePath = path.resolve(__dirname, '../../scripts/pr-diff-fallback-policy.mjs');

describe('pr-diff-fallback-policy', () => {
  it('flags a pull request over the 300-file GitHub diff limit preemptively', async () => {
    const { decideDiffAcquisition } = await import(modulePath);
    const decision = decideDiffAcquisition({ changedFiles: 3509, additions: 100, deletions: 100 });
    expect(decision).toEqual(expect.objectContaining({
      useFallback: true,
      attemptPrimary: false,
      reason: 'preemptive-threshold',
    }));
  });

  it('flags a pull request over the 20,000-line GitHub diff limit preemptively', async () => {
    const { decideDiffAcquisition } = await import(modulePath);
    const decision = decideDiffAcquisition({ changedFiles: 111, additions: 13727, deletions: 14369 });
    expect(decision.useFallback).toBe(true);
    expect(decision.attemptPrimary).toBe(false);
  });

  it('does not flag a pull request under both limits', async () => {
    const { decideDiffAcquisition } = await import(modulePath);
    const decision = decideDiffAcquisition({ changedFiles: 12, additions: 400, deletions: 120 });
    expect(decision).toEqual(expect.objectContaining({
      useFallback: false,
      attemptPrimary: true,
      reason: 'gh-pr-diff-ok',
    }));
  });

  it('treats exactly 300 files and exactly 20,000 lines as still within limits', async () => {
    const { exceedsGithubDiffLimits } = await import(modulePath);
    expect(exceedsGithubDiffLimits({ changedFiles: 300, additions: 10000, deletions: 10000 })).toBe(false);
    expect(exceedsGithubDiffLimits({ changedFiles: 301, additions: 0, deletions: 0 })).toBe(true);
    expect(exceedsGithubDiffLimits({ changedFiles: 1, additions: 10001, deletions: 10000 })).toBe(true);
  });

  it('falls back after gh pr diff 406s on the file-count message', async () => {
    const { decideDiffAcquisition } = await import(modulePath);
    const decision = decideDiffAcquisition({
      changedFiles: 12,
      additions: 400,
      deletions: 120,
      ghPrDiffAttempted: true,
      ghPrDiffExitCode: 1,
      ghPrDiffStderr: "HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.",
    });
    expect(decision).toEqual(expect.objectContaining({ useFallback: true, reason: 'gh-pr-diff-406' }));
  });

  it('falls back after gh pr diff 406s on the line-count message', async () => {
    const { decideDiffAcquisition } = await import(modulePath);
    const decision = decideDiffAcquisition({
      ghPrDiffAttempted: true,
      ghPrDiffExitCode: 1,
      ghPrDiffStderr: 'HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)',
    });
    expect(decision.useFallback).toBe(true);
  });

  it('does not mask an unrelated gh pr diff failure as a size-limit fallback', async () => {
    const { decideDiffAcquisition } = await import(modulePath);
    const decision = decideDiffAcquisition({
      ghPrDiffAttempted: true,
      ghPrDiffExitCode: 1,
      ghPrDiffStderr: 'HTTP 401: Bad credentials',
    });
    expect(decision).toEqual(expect.objectContaining({
      useFallback: false,
      reason: 'gh-pr-diff-other-failure',
      fatal: true,
    }));
  });

  it('does not fall back when gh pr diff succeeds', async () => {
    const { decideDiffAcquisition } = await import(modulePath);
    const decision = decideDiffAcquisition({ ghPrDiffAttempted: true, ghPrDiffExitCode: 0 });
    expect(decision.useFallback).toBe(false);
  });

  it('recognizes a forward-merge title', async () => {
    const { isForwardMergeTitle } = await import(modulePath);
    expect(isForwardMergeTitle('chore: forward-merge 0.8.7 into 0.8.8')).toBe(true);
    expect(isForwardMergeTitle('chore(release): forward-merge main')).toBe(true);
    expect(isForwardMergeTitle('fix: correct the CDR bucketing window')).toBe(false);
    expect(isForwardMergeTitle('')).toBe(false);
    expect(isForwardMergeTitle(undefined)).toBe(false);
  });
});
