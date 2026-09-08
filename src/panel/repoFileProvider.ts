import type { GitHubInstallationClient } from '../github/installationClient';
import { logger } from '../utils/logger';
import type { RepoFileProvider } from './panelEngine';

/**
 * Wires the panel engine's `RepoFileProvider` (see `src/panel/panelEngine.ts`) to the live GitHub
 * API for one review run. Fixes the defect where a persona's `find_files`/`read_file` tool could
 * only see the PR's changedFiles: a diff that imports a sibling file it does not itself modify
 * produced an honest "no files found" that the persona then reported to a human as "the file
 * could not be located to confirm it exists" -- a false P1 that survived unchanged across review
 * rounds because nothing about the diff-scoped miss ever changed.
 *
 * The full-repository tree is fetched at most once per run (memoized) and only if a persona tool
 * call actually misses in the diff, so a review with no such tool call pays no extra API cost.
 */
export function createRepoFileProvider(github: GitHubInstallationClient, owner: string, repo: string, headSha: string): RepoFileProvider {
  let treePromise: Promise<{ paths: string[]; truncated: boolean }> | undefined;
  const loadTree = () => {
    if (!treePromise) {
      treePromise = github.getFileTree(owner, repo, headSha).catch((error) => {
        // Do not cache a rejected lookup as a permanent empty result; the next call retries.
        treePromise = undefined;
        throw error;
      });
    }
    return treePromise;
  };
  return {
    async findFiles(query: string): Promise<string[]> {
      const { paths, truncated } = await loadTree();
      const needle = query.toLowerCase();
      const hits = paths.filter((path) => path.toLowerCase().includes(needle));
      if (truncated) {
        logger.warn('Repository tree truncated by GitHub API during persona find_files lookup; results may be incomplete', { owner, repo, headSha, query });
      }
      return hits;
    },
    readFile(path: string): Promise<string | null> {
      return github.getFileContent(owner, repo, path, headSha, { notFoundIsEmpty: true });
    },
    async treeTruncated(): Promise<boolean> {
      return (await loadTree()).truncated;
    },
  };
}
