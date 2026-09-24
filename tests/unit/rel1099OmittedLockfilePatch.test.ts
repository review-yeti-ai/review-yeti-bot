import { describe, expect, it, vi } from 'vitest';
import { resolveWorkerConfig } from '../../src/config/publishingWorkerConfig';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel, personaCoverageError } from '../../src/panel/panelEngine';
import type { ReviewModelClient } from '../../src/gateway/openRouterClient';
import { GitDiffSourceError, type GitDiffSource } from '../../src/github/gitDiffSource';
import { loadSameHeadReviewSource } from '../../src/github/qualificationReader';
import { parseChangedFiles } from '../../src/review/changedFiles';
import { OMITTED_LOCKFILE_PATCH_REASON } from '../../src/review/omittedLockfilePatch';
import { resolveReviewApplicability } from '../../src/review/personaApplicability';
import { isNoReviewableContentFile } from '../../src/review/reviewableContent';

/**
 * REL-1099 (from #1019): a lockfile-only diff too large for GitHub's diff media
 * type. The worker computes it from git first (REL-1080), which keeps the
 * lockfile patch, so the REL-972 registry check still vouches for the bump and
 * the run passes as no-reviewable-content. When the git-derived diff is not
 * available the pull-files fallback has no patch for the lockfile: that stays
 * fail-closed, with a reason that says so instead of "only removes lockfile
 * content", and without advice to extend persona paths, which can never cover
 * a lockfile.
 */

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE_BASE = 'c'.repeat(40);
const transport = { baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'k', model: 'review-model' };
const roster = (personas = 'architecture,security') => resolveWorkerConfig({ REVIEW_PERSONAS: personas }, transport);
const enabled = (personas?: string) => roster(personas).personas.filter((persona) => persona.enabled);
const unreachableClient = new Proxy({}, {
  get() { throw new Error('the model client must not be consulted'); },
}) as unknown as ReviewModelClient;

/** A closed-hunk Dependabot-shaped npm bump, as git renders it. */
const NPM_BUMP_DIFF = [
  'diff --git a/package-lock.json b/package-lock.json',
  'index 1111111..2222222 100644',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1,5 +1,5 @@',
  '     "node_modules/lodash": {',
  '-      "version": "4.17.20",',
  '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
  '+      "version": "4.17.21",',
  '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
  '       "integrity": "sha512-x"',
  '     },',
  '',
].join('\n');

/** GitHub's pull-files entry for a lockfile whose patch it considers too large. */
const OMITTED_LOCKFILE = {
  filename: 'package-lock.json', status: 'modified', additions: 30_000, deletions: 20_000, changes: 50_000,
};

/** A 406 read: the diff media type refuses, then git (if wired) or pull-files serves it. */
async function largeDiffSource(options: { gitDiffSource?: GitDiffSource; files?: unknown[] } = {}) {
  const files = options.files ?? [OMITTED_LOCKFILE];
  const pull = { data: { head: { sha: HEAD }, base: { sha: BASE }, changed_files: files.length }, status: 200 };
  const request = vi.fn(async (route: string) => {
    if (route.includes('/compare/')) {
      return { data: { base_commit: { sha: BASE }, merge_base_commit: { sha: MERGE_BASE } }, status: 200 };
    }
    if (route.endsWith('/files')) return { data: files, status: 200 };
    return pull;
  });
  // The diff media type read is the second pull request call.
  let pullCalls = 0;
  const wrapped = vi.fn(async (route: string) => {
    if (!route.includes('/compare/') && !route.endsWith('/files') && ++pullCalls === 2) {
      throw Object.assign(new Error('diff too large'), { status: 406 });
    }
    return request(route);
  });
  const onLargeDiffSource = vi.fn();
  const source = await loadSameHeadReviewSource({
    token: 'ghs_test', repo: 'o/r', prNumber: 1, expectedBaseSha: BASE, expectedHeadSha: HEAD,
  }, wrapped as never, options.gitDiffSource ? { gitDiffSource: options.gitDiffSource, onLargeDiffSource } : {});
  return { source, onLargeDiffSource };
}

describe('REL-1099: a large lockfile-only diff', () => {
  it('passes as no-reviewable-content when the git-derived diff carries the lockfile patch', async () => {
    const gitDiffSource = vi.fn<GitDiffSource>(async () => NPM_BUMP_DIFF);
    const { source, onLargeDiffSource } = await largeDiffSource({ gitDiffSource });
    expect(gitDiffSource).toHaveBeenCalledWith(expect.objectContaining({ mergeBaseSha: MERGE_BASE, headSha: HEAD }));
    expect(onLargeDiffSource).toHaveBeenCalledWith({ source: 'git', files: 1 });

    const changedFiles = parseChangedFiles(source.diff).files;
    const decision = resolveReviewApplicability(enabled(), changedFiles);
    expect(decision.noReviewableContent).toBe(true);
    expect(decision.noReviewableContentKind).toBe('lockfile-only');
    const result = await executePersonaPanel({
      config: roster(), changedFiles, repository: 'r/r', headSha: HEAD, client: unreachableClient, deterministicRoster: true,
    });
    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.noReviewableContentKind).toBe('lockfile-only');
  });

  it('fails closed with the omitted-patch reason when git is unavailable and GitHub omits the patch', async () => {
    const gitDiffSource = vi.fn<GitDiffSource>(async () => { throw new GitDiffSourceError('bounds'); });
    const { source, onLargeDiffSource } = await largeDiffSource({ gitDiffSource });
    expect(onLargeDiffSource).toHaveBeenCalledWith({ source: 'pull-files', reason: 'bounds' });

    const changedFiles = parseChangedFiles(source.diff).files;
    expect(changedFiles.map((file) => file.path)).toEqual(['package-lock.json']);
    const decision = resolveReviewApplicability(enabled(), changedFiles);
    expect(decision.noReviewableContent).toBe(false);
    expect(decision.unmatchedPaths).toEqual(['package-lock.json']);
    // Before REL-1099 the empty marker chunk read as 'only removes lockfile content'.
    expect(decision.unverifiedLockfiles).toEqual([{ path: 'package-lock.json', reason: OMITTED_LOCKFILE_PATCH_REASON }]);
    // The service's per-file re-check agrees: never exempt without the patch.
    expect(changedFiles.every((file) => isNoReviewableContentFile(file))).toBe(false);
  });

  it('fails closed the same way with the git source disabled', async () => {
    const { source } = await largeDiffSource();
    const decision = resolveReviewApplicability(enabled(), parseChangedFiles(source.diff).files);
    expect(decision.noReviewableContent).toBe(false);
    expect(decision.unverifiedLockfiles).toEqual([{ path: 'package-lock.json', reason: OMITTED_LOCKFILE_PATCH_REASON }]);
  });

  it('both engines name the reason and do not advise extending persona paths', async () => {
    const { source } = await largeDiffSource();
    const changedFiles = parseChangedFiles(source.diff).files;
    const message = /no enabled persona applies.*package-lock\.json.*Lockfiles are excluded from every lane, so persona paths cannot cover them\..*GitHub omitted its patch as too large/su;
    const panel = executePersonaPanel({
      config: roster(), changedFiles, repository: 'r/r', headSha: HEAD, client: unreachableClient, deterministicRoster: true,
    });
    await expect(panel).rejects.toThrow(message);
    await expect(panel).rejects.not.toThrow(/Extend that persona's paths/u);
    const composed = executeComposedReview({
      config: roster(), changedFiles, repository: 'r/r', headSha: HEAD, client: unreachableClient,
    });
    await expect(composed).rejects.toThrow(message);
    await expect(composed).rejects.not.toThrow(/Extend that persona's paths/u);
  });

  it('keeps the extend-paths advice when an uncovered source path is also present', () => {
    const message = personaCoverageError('r/r', HEAD, ['package-lock.json', 'src/uncovered.rs'], [{ id: 'sec-lane' }],
      [{ path: 'package-lock.json', reason: OMITTED_LOCKFILE_PATCH_REASON }]).message;
    expect(message).toContain("Extend that persona's paths to cover these files, or enable a persona that does.");
    expect(message).not.toContain('persona paths cannot cover them');
  });

  it('keeps the extend-paths advice when nothing is an unverified lockfile', () => {
    const message = personaCoverageError('r/r', HEAD, ['src/uncovered.rs'], [{ id: 'sec-lane' }]).message;
    expect(message).toContain("Extend that persona's paths");
  });
});
