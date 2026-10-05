import { MAX_PINNED_SOURCE_BYTES, MAX_SOURCE_CACHE_BYTES, MAX_SOURCE_CACHE_ENTRIES } from '../utils/sourceLimits';
import type { GitHubInstallationClient } from '../github/installationClient';
import { logger } from '../utils/logger';
import type { RepoFileProvider } from './panelEngine';
import { createPathMatcher } from './pathMatch';

/**
 * Wires the panel engine's `RepoFileProvider` (see `src/panel/panelEngine.ts`) to the live GitHub
 * API for one review run. Fixes the defect where a persona's `find_files`/`read_file` tool could
 * only see the PR's changedFiles: a diff that imports a sibling file it does not itself modify
 * produced an honest "no files found" that the persona then reported to a human as "the file
 * could not be located to confirm it exists" -- a false P1 that survived unchanged across review
 * rounds because nothing about the diff-scoped miss ever changed.
 *
 * The full-repository tree is fetched at most once per run (memoized) and only when a persona
 * calls find_files, or read_file on a path the contents API does not return. A review with no such
 * tool call pays no extra API cost. The tree lists every blob (code, JSON, YAML, fixtures); there is
 * no file-type filter.
 */
export function createRepoFileProvider(github: GitHubInstallationClient, owner: string, repo: string, headSha: string, evidence?: { baseSha: string; changedFiles: Array<{ path: string; patch?: string; originalPatchLength?: number }> }): RepoFileProvider {
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
  let mergeBasePromise: Promise<string> | undefined;
  const mergeBase = () => {
    if (!evidence?.baseSha) throw new Error('Old source identity unavailable');
    if (!mergeBasePromise) mergeBasePromise = github.getMergeBase(owner, repo, evidence.baseSha, headSha)
      .catch((error) => { mergeBasePromise = undefined; throw error; });
    return mergeBasePromise;
  };
  const originals = new Map(evidence?.changedFiles.map((file) => [file.path, file]) ?? []);
  // Cache only bounded page sources. The exact commit is part of every key;
  // eviction costs another read, never a different revision or missing evidence.
  const sourceCache = new Map<string, { promise: Promise<string | null>; bytes: number }>();
  let sourceBytes = 0;
  return {
    async readFileAt(path, side) {
      const sha = side === 'head' ? headSha : side === 'base'
        ? evidence?.baseSha ?? (() => { throw new Error('Old source identity unavailable'); })()
        : await mergeBase();
      const key = `${sha}:${path}`;
      let entry = sourceCache.get(key);
      if (!entry) {
        entry = { bytes: 0, promise: github.getFileContent(owner, repo, path, sha, { notFoundIsEmpty: true }) };
        sourceCache.set(key, entry);
        const current = entry;
        current.promise = current.promise.then((content) => {
          if (sourceCache.get(key) === current) {
            current.bytes = Buffer.byteLength(content ?? '', 'utf8');
            sourceBytes += current.bytes;
            while (sourceBytes > MAX_SOURCE_CACHE_BYTES || sourceCache.size > MAX_SOURCE_CACHE_ENTRIES) {
              const oldest = sourceCache.keys().next().value;
              if (oldest === undefined) break;
              sourceBytes -= sourceCache.get(oldest)!.bytes;
              sourceCache.delete(oldest);
            }
          }
          return Buffer.byteLength(content ?? '', 'utf8') <= MAX_PINNED_SOURCE_BYTES ? content : null;
        }).catch((error) => { if (sourceCache.get(key) === current) sourceCache.delete(key); throw error; });
      }
      return { sha, content: await entry.promise };
    },
    readDiff(path) {
      const file = originals.get(path);
      return typeof file?.patch === 'string' ? { patch: file.patch, originalPatchLength: file.originalPatchLength,
        identity: { repository: `${owner}/${repo}`, baseSha: evidence!.baseSha, headSha } } : null;
    },
    async findFiles(query: string): Promise<string[]> {
      const { paths, truncated } = await loadTree();
      const matches = createPathMatcher(query);
      const hits = paths.filter((path) => matches(path));
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
