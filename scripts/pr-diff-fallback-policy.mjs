#!/usr/bin/env node
// Pure decision logic for the "Fetch pull request diff" action.yml step.
//
// GitHub's diff media type (what `gh pr diff` requests under the hood) fails
// closed with HTTP 406 once a pull request exceeds 300 changed files or
// 20,000 changed lines: "Sorry, the diff exceeded the maximum number of
// files (300)" / "... maximum number of lines (20000)". Before this module
// existed, that 406 propagated straight through `set -euo pipefail` and
// failed the whole Review Yeti run with no verdict (review-yeti-bot#REL-513).
//
// This module only decides *whether* a fallback diff-acquisition path is
// needed and *which* pull requests should skip the doomed API call
// preemptively. It has no I/O so it can be unit tested without a network or
// a real git remote; scripts/fetch-pr-diff.sh does the actual fetching.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GITHUB_DIFF_FILE_LIMIT = 300;
export const GITHUB_DIFF_LINE_LIMIT = 20000;

// Matches both the exact GitHub API 406 body and a bare "HTTP 406" as
// reported by `gh`'s own error wrapping, so a stderr capture from either the
// REST client or the gh CLI is recognized the same way.
const DIFF_LIMIT_STDERR_PATTERN = /HTTP 406|exceeded the maximum number of (?:files|lines)/i;

/**
 * True when a pull request's own metadata already tells us the GitHub diff
 * media type will 406 -- no need to spend a request finding out.
 */
export function exceedsGithubDiffLimits({ changedFiles, additions, deletions } = {}) {
  const files = Number(changedFiles) || 0;
  const totalLines = (Number(additions) || 0) + (Number(deletions) || 0);
  return files > GITHUB_DIFF_FILE_LIMIT || totalLines > GITHUB_DIFF_LINE_LIMIT;
}

/**
 * True when captured stderr text names the GitHub diff-size 406, as opposed
 * to an unrelated failure (auth, rate limit, network) that should still fail
 * the run loudly instead of silently falling back.
 */
export function isDiffLimitFailure(stderrText) {
  return typeof stderrText === 'string' && DIFF_LIMIT_STDERR_PATTERN.test(stderrText);
}

/**
 * Central decision point. Given what we know about the pull request before
 * calling `gh pr diff`, and what happened if we already called it, decide
 * whether to use the local-diff fallback, and why.
 *
 * @param {object} input
 * @param {number} [input.changedFiles]
 * @param {number} [input.additions]
 * @param {number} [input.deletions]
 * @param {boolean} [input.ghPrDiffAttempted] - whether `gh pr diff` already ran
 * @param {number|null} [input.ghPrDiffExitCode]
 * @param {string} [input.ghPrDiffStderr]
 * @returns {{useFallback: boolean, attemptPrimary: boolean, reason: string, fatal?: boolean}}
 */
export function decideDiffAcquisition({
  changedFiles,
  additions,
  deletions,
  ghPrDiffAttempted = false,
  ghPrDiffExitCode = null,
  ghPrDiffStderr = '',
} = {}) {
  if (exceedsGithubDiffLimits({ changedFiles, additions, deletions })) {
    return {
      useFallback: true,
      // Calling gh pr diff first would just reproduce a 406 the PR metadata
      // already predicts; skip straight to the fallback.
      attemptPrimary: false,
      reason: 'preemptive-threshold',
    };
  }

  if (ghPrDiffAttempted && Number(ghPrDiffExitCode) !== 0) {
    if (isDiffLimitFailure(ghPrDiffStderr)) {
      return { useFallback: true, attemptPrimary: true, reason: 'gh-pr-diff-406' };
    }
    // A real failure unrelated to the size limit (auth, network, rate limit)
    // must still fail the run. Falling back here would silently mask an
    // outage as a successful-but-wrong review.
    return { useFallback: false, attemptPrimary: true, reason: 'gh-pr-diff-other-failure', fatal: true };
  }

  return { useFallback: false, attemptPrimary: true, reason: 'gh-pr-diff-ok' };
}

// A forward-merge PR (0.8.7 -> 0.8.8, etc.) carries the entire divergence
// between two long-lived release lines as its "diff" even though almost none
// of it is new review-worthy content -- it is the accumulated history of the
// source line. Reviewing the conflict-resolution delta (source second parent
// vs. the merge result) instead of the full three-dot diff keeps the review
// scoped to what a human resolved by hand.
const FORWARD_MERGE_TITLE_PATTERN = /^chore(\([^)]*\))?:\s*forward-merge\b/iu;

export function isForwardMergeTitle(title) {
  return typeof title === 'string' && FORWARD_MERGE_TITLE_PATTERN.test(title.trim());
}

function optionalNumber(env, name) {
  if (env[name] === undefined || env[name] === '') return undefined;
  return Number(env[name]);
}

async function main() {
  const env = process.env;
  const decision = decideDiffAcquisition({
    changedFiles: optionalNumber(env, 'PR_DIFF_CHANGED_FILES'),
    additions: optionalNumber(env, 'PR_DIFF_ADDITIONS'),
    deletions: optionalNumber(env, 'PR_DIFF_DELETIONS'),
    ghPrDiffAttempted: env.GH_PR_DIFF_ATTEMPTED === 'true',
    ghPrDiffExitCode: env.GH_PR_DIFF_EXIT_CODE === undefined ? null : Number(env.GH_PR_DIFF_EXIT_CODE),
    ghPrDiffStderr: env.GH_PR_DIFF_STDERR || '',
  });
  decision.forwardMerge = isForwardMergeTitle(env.PR_DIFF_TITLE || '');
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  if (decision.fatal) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
