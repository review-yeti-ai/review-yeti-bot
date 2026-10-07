import { createHash } from 'node:crypto';
import { MAX_PINNED_SOURCE_BYTES, MAX_SOURCE_CACHE_BYTES, MAX_SOURCE_CACHE_ENTRIES } from '../utils/sourceLimits';
import type { GitHubInstallationClient } from '../github/installationClient';
import { logger } from '../utils/logger';
import type { PinnedSourceReferenceSearchV1, RepoFileProvider } from './panelEngine';
import { createPathMatcher } from './pathMatch';

const MAX_REVERSE_REFERENCE_SCAN_FILES = 12;
const MAX_REVERSE_REFERENCE_SCAN_BYTES = 180_000;
const REFERENCE_SEARCH_EXTENSIONS = /\.(?:cjs|js|jsx|mjs|ts|tsx|mts|cts)$/iu;

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
  const treePromises = new Map<string, Promise<{ paths: string[]; truncated: boolean }>>();
  const loadTreeAt = (revisionSha: string) => {
    if (!treePromises.has(revisionSha)) {
      const pending = github.getFileTree(owner, repo, revisionSha).catch((error) => {
        // Do not cache a rejected lookup as a permanent empty result; the next call retries.
        treePromises.delete(revisionSha);
        throw error;
      });
      treePromises.set(revisionSha, pending);
    }
    return treePromises.get(revisionSha)!;
  };
  const loadTree = () => loadTreeAt(headSha);
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
  type PinnedRead = { content: string | null; presence: 'present' | 'absent' | 'unavailable'; contentSha256?: string };
  const sourceCache = new Map<string, { promise: Promise<PinnedRead>; bytes: number }>();
  let sourceBytes = 0;
  const provider: RepoFileProvider = {
    async readFileAt(path, side) {
      const sha = side === 'head' ? headSha : side === 'base'
        ? evidence?.baseSha ?? (() => { throw new Error('Old source identity unavailable'); })()
        : await mergeBase();
      const key = `${sha}:${path}`;
      let entry = sourceCache.get(key);
      if (!entry) {
        const lookup: Promise<PinnedRead> = typeof github.getFileContentEvidence === 'function'
          ? github.getFileContentEvidence(owner, repo, path, sha)
          : github.getFileContent(owner, repo, path, sha, { notFoundIsEmpty: true }).then<PinnedRead>((content) => ({
            content: typeof content === 'string' ? content : null,
            // Legacy clients cannot prove whether null means absent or unavailable.
            presence: typeof content === 'string' ? 'present' as const : 'unavailable' as const,
          }));
        entry = { bytes: 0, promise: lookup };
        sourceCache.set(key, entry);
        const current = entry;
        current.promise = current.promise.then<PinnedRead>((result) => {
          const contentBytes = Buffer.byteLength(result.content ?? '', 'utf8');
          if (sourceCache.get(key) === current) {
            current.bytes = contentBytes;
            sourceBytes += current.bytes;
            while (sourceBytes > MAX_SOURCE_CACHE_BYTES || sourceCache.size > MAX_SOURCE_CACHE_ENTRIES) {
              const oldest = sourceCache.keys().next().value;
              if (oldest === undefined) break;
              sourceBytes -= sourceCache.get(oldest)!.bytes;
              sourceCache.delete(oldest);
            }
          }
          if (result.presence !== 'present' || typeof result.content !== 'string'
            || contentBytes > MAX_PINNED_SOURCE_BYTES) {
            return { content: null, presence: result.presence === 'absent' ? 'absent' : 'unavailable' };
          }
          const contentSha256 = createHash('sha256').update(Buffer.from(result.content, 'utf8')).digest('hex');
          return { ...result, contentSha256 };
        }).catch((error) => { if (sourceCache.get(key) === current) sourceCache.delete(key); throw error; });
      }
      const result = await entry.promise;
      return { sha, ...result, source: { repository: `${owner}/${repo}`, path, side } };
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
    async findReferences(symbol, sourcePath, side): Promise<PinnedSourceReferenceSearchV1> {
      const repository = `${owner}/${repo}`;
      const revisionSha = side === 'head' ? headSha : evidence?.baseSha;
      const empty = (input: { searchComplete: boolean; reason: PinnedSourceReferenceSearchV1['reason'];
        scannedFileCount?: number; scannedBytes?: number }): PinnedSourceReferenceSearchV1 => ({
        version: 'PinnedSourceReferenceSearch.v1', repository, sourcePath, symbol, side,
        revisionSha: revisionSha ?? '', candidatePaths: [], searchComplete: input.searchComplete,
        scannedFileCount: input.scannedFileCount ?? 0, scannedBytes: input.scannedBytes ?? 0, reason: input.reason,
      });
      if (!revisionSha || !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(symbol) || !sourcePath) {
        return empty({ searchComplete: false, reason: 'unsupported_symbol' });
      }
      let tree: { paths: string[]; truncated: boolean };
      try {
        tree = await loadTreeAt(revisionSha);
      } catch {
        return empty({ searchComplete: false, reason: 'source_unavailable' });
      }
      const paths = tree.paths.filter((path) => path !== sourcePath && REFERENCE_SEARCH_EXTENSIONS.test(path))
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      let searchComplete = !tree.truncated;
      let reason: PinnedSourceReferenceSearchV1['reason'] = tree.truncated ? 'tree_truncated' : null;
      const candidatePaths: string[] = [];
      const symbolPattern = new RegExp(`(^|[^A-Za-z0-9_$])${symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([^A-Za-z0-9_$]|$)`, 'u');
      let scannedFileCount = 0;
      let scannedBytes = 0;
      for (const path of paths) {
        if (scannedFileCount >= MAX_REVERSE_REFERENCE_SCAN_FILES) {
          searchComplete = false;
          reason ??= 'scan_file_limit';
          break;
        }
        if (scannedBytes >= MAX_REVERSE_REFERENCE_SCAN_BYTES) {
          searchComplete = false;
          reason ??= 'scan_byte_limit';
          break;
        }
        scannedFileCount += 1;
        let source: Awaited<ReturnType<NonNullable<RepoFileProvider['readFileAt']>>>;
        try { source = await provider.readFileAt!(path, side); }
        catch {
          searchComplete = false;
          reason ??= 'source_unavailable';
          continue;
        }
        if (source.sha !== revisionSha || source.presence !== 'present' || typeof source.content !== 'string'
          || source.source?.repository !== repository || source.source.path !== path || source.source.side !== side) {
          searchComplete = false;
          reason ??= 'source_unavailable';
          continue;
        }
        const bytes = Buffer.byteLength(source.content, 'utf8');
        if (scannedBytes + bytes > MAX_REVERSE_REFERENCE_SCAN_BYTES) {
          searchComplete = false;
          reason ??= 'scan_byte_limit';
          break;
        }
        scannedBytes += bytes;
        if (symbolPattern.test(source.content)) candidatePaths.push(path);
      }
      if (paths.length > MAX_REVERSE_REFERENCE_SCAN_FILES && reason === null) {
        searchComplete = false;
        reason = 'scan_file_limit';
      }
      return { version: 'PinnedSourceReferenceSearch.v1', repository, sourcePath, symbol, side, revisionSha,
        candidatePaths: [...new Set(candidatePaths)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
        searchComplete, scannedFileCount, scannedBytes, reason };
    },
    readFile(path: string): Promise<string | null> {
      return github.getFileContent(owner, repo, path, headSha, { notFoundIsEmpty: true });
    },
    async treeTruncated(): Promise<boolean> {
      return (await loadTree()).truncated;
    },
  };
  return provider;
}
