import { createHash } from 'node:crypto';
import { formatPatch, OMIT_HEADERS, structuredPatch } from 'diff';
import { z } from 'zod';
import { reviewPolicySourceSchema, type CurrentReviewCandidate, type ImmutableReviewPolicyFile } from '../review/authoritativeReviewIdentity';
import { isGitHubInstallationToken } from './githubTransportPolicy';
import type { ChangedFile } from '../review/changedFiles';
import { MAX_CHANGED_FILE_PATCH_BYTES } from '../review/reviewEvidenceLimits';
import {
  MAX_COMPARISON_FILES, parseComparisonFiles,
  comparisonFilePathSchema, type ComparisonFileEvidence,
} from './comparisonFiles';
export type { ImmutableReviewPolicyFile } from '../review/authoritativeReviewIdentity';

const positive = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== '.' && value !== '..');
const repository = z.object({ repositoryId: positive, owner: name, repo: name }).strict();
const repositoryResponse = z.object({ id: positive, full_name: z.string() });
const pullResponse = z.object({
  number: positive, state: z.enum(['open', 'closed']), draft: z.boolean(), merged: z.boolean(),
  head: z.object({ sha }), base: z.object({ sha, repo: repositoryResponse }),
  changed_files: z.number().int().nonnegative().safe().optional(),
});
const sourcePath = reviewPolicySourceSchema.shape.path;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_AUTHORITATIVE_DIFF_BYTES = 2_000_000;
export const MAX_AUTHORITATIVE_CHANGED_FILES_BYTES = 4_000_000;
const MAX_COMPARISON_RESPONSE_BYTES = 8_000_000;
const MAX_RECONSTRUCTED_FILE_BYTES = 512_000;
const MAX_RECONSTRUCTED_CONTENT_BYTES = 4_000_000;
const MAX_PINNED_CONTENT_RESPONSE_BYTES = 800_000;
// Bound diff search deterministically. At the 64-file reconstruction cap, the
// synchronous wall-clock budget is at most 640 ms; files that exceed their
// slice fall back to the already byte-bounded full-replacement patch.
const MAX_RECONSTRUCTION_EDIT_LENGTH = 500;
const MAX_RECONSTRUCTION_DIFF_MS = 10;
// Live #5136 needed 40 reconstructed files. Sixty-four preserves 60% headroom
// while capping work at 128 pinned reads in 16 four-way batches
// under the authoritative completion path's 10-second whole-operation deadline.
const MAX_RECONSTRUCTED_FILES = 64;
const RECONSTRUCTION_CONCURRENCY = 4;
class OversizedPullDiff extends Error {
  constructor() { super('Review reader whole diff exceeds GitHub limit'); }
}
class MissingPinnedObject extends Error {
  constructor() { super('Review reader pinned object missing'); }
}
const pinnedFileResponse = z.object({
  type: z.literal('file'), path: comparisonFilePathSchema, sha,
  size: z.number().int().min(0).max(MAX_RECONSTRUCTED_FILE_BYTES),
  encoding: z.literal('base64'), content: z.string().max(700_000),
});
const comparisonResponse = z.object({
  url: z.string().url().max(2048), base_commit: z.object({ sha }), merge_base_commit: z.object({ sha }),
  status: z.enum(['ahead', 'behind', 'diverged', 'identical']),
  ahead_by: z.number().int().nonnegative().safe(), behind_by: z.number().int().nonnegative().safe(),
  total_commits: z.number().int().nonnegative().safe(), files: z.unknown(),
});

function fullReplacementPatch(before: string, after: string): string {
  const split = (content: string) => {
    if (content === '') return { lines: [] as string[], endsWithNewline: true };
    const lines = content.split('\n'); const endsWithNewline = content.endsWith('\n');
    if (endsWithNewline) lines.pop();
    return { lines, endsWithNewline };
  };
  const old = split(before); const next = split(after);
  const body: string[] = [`@@ -${old.lines.length === 0 ? 0 : 1},${old.lines.length} +${next.lines.length === 0 ? 0 : 1},${next.lines.length} @@`];
  for (const [index, line] of old.lines.entries()) {
    body.push(`-${line}`);
    if (index === old.lines.length - 1 && !old.endsWithNewline) body.push('\\ No newline at end of file');
  }
  for (const [index, line] of next.lines.entries()) {
    body.push(`+${line}`);
    if (index === next.lines.length - 1 && !next.endsWithNewline) body.push('\\ No newline at end of file');
  }
  return `${body.join('\n')}\n`;
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  try { return schema.parse(input); }
  catch { throw new Error('Review reader identity or response invalid'); }
}

export type ReviewRepositoryIdentity = z.infer<typeof repository>;
export interface ExactCurrentReviewDiff {
  current: CurrentReviewCandidate;
  /** Empty for per-file evidence, or when the candidate changed/closed. */
  diff: string;
  /** Complete, validated per-file patches from the immutable compare API. When present,
   * diff is empty: these are not a reconstructed whole-PR unified diff. */
  changedFiles?: ChangedFile[];
  /** Present only when GitHub reports the same file count on both PR reads. */
  expectedFileCount?: number;
}

/** Read-only, bounded GitHub truth for authoritative admission. Event payloads
 * are hints; no request-supplied policy, URL, file contents or check is trusted.
 * Separate repository-scoped instances may be used for candidate and policy. */
export class AuthoritativeReviewReader {
  private readonly api: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: {
    token: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
  }) {
    if (!isGitHubInstallationToken(options.token)) throw new Error('Review reader requires an installation credential');
    let url: URL;
    try { url = new URL(options.baseUrl || 'https://api.github.com'); }
    catch { throw new Error('Review reader requires a credential-free HTTPS API base'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Review reader requires a credential-free HTTPS API base');
    }
    this.api = url.toString().replace(/\/+$/u, '');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 30_000) {
      throw new Error('Review reader timeout is outside its bound');
    }
    this.fetcher = options.fetchImplementation || globalThis.fetch;
  }

  private async text(path: string, accept: string, maxBytes: number, signal?: AbortSignal,
    detectOversizedDiff = false, allowNotFound = false): Promise<string> {
    const abort = new AbortController();
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => {
        abort.abort();
        void bodyReader?.cancel().catch(() => undefined);
        reject(new Error('Review reader request unavailable'));
      };
      timer = setTimeout(onAbort, this.timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    const read = async (): Promise<string> => {
      if (abort.signal.aborted) throw new Error('Review reader request unavailable');
      const response = await this.fetcher(`${this.api}${path}`, {
        method: 'GET', redirect: 'error', signal: abort.signal,
        headers: {
          Accept: accept, Authorization: `Bearer ${this.options.token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'review-yeti-authoritative-reader',
        },
      });
      const oversizedCandidate = detectOversizedDiff && response.status === 406;
      const oversizedSuccessfulDiff = detectOversizedDiff && response.status === 200;
      if (allowNotFound && response.status === 404) {
        void response.body?.cancel().catch(() => undefined);
        throw new MissingPinnedObject();
      }
      if (abort.signal.aborted || (response.status !== 200 && !oversizedCandidate) || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error('Review reader request unavailable');
      }
      const reader = response.body.getReader();
      bodyReader = reader;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (abort.signal.aborted) throw new Error('Review reader request unavailable');
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > (oversizedCandidate ? 16_384 : maxBytes)) {
            if (oversizedSuccessfulDiff) throw new OversizedPullDiff();
            throw new Error('Review reader response exceeds bound');
          }
          chunks.push(next.value);
        }
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (oversizedCandidate) {
          const error = z.object({ errors: z.array(z.object({ resource: z.literal('PullRequest'),
            field: z.literal('diff'), code: z.literal('too_large') })).length(1) }).safeParse(JSON.parse(body));
          if (error.success) throw new OversizedPullDiff();
          throw new Error('Review reader request unavailable');
        }
        return body;
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
        bodyReader = undefined;
      }
    };
    try {
      return await Promise.race([read(), expired]);
    } catch (error) {
      // GitHub error bodies and transport errors can contain credential or
      // repository content. Neither belongs in admission logs or responses.
      abort.abort();
      if (error instanceof OversizedPullDiff || error instanceof MissingPinnedObject) throw error;
      throw new Error('Review reader request unavailable');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async json(path: string, signal?: AbortSignal): Promise<unknown> {
    try { return JSON.parse(await this.text(path, 'application/vnd.github+json', MAX_RESPONSE_BYTES, signal)); }
    catch { throw new Error('Review reader request unavailable'); }
  }

  private route(input: ReviewRepositoryIdentity): { target: ReviewRepositoryIdentity; path: string } {
    const target = parse(repository, input);
    return { target, path: `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}` };
  }

  private assertRepository(actual: z.infer<typeof repositoryResponse>, target: ReviewRepositoryIdentity): void {
    if (actual.id !== target.repositoryId || actual.full_name.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()) {
      throw new Error('Review reader repository identity mismatch');
    }
  }

  private async pullCandidate(input: ReviewRepositoryIdentity & { prNumber: number }, signal?: AbortSignal):
    Promise<{ current: CurrentReviewCandidate; expectedFileCount?: number }> {
    const { prNumber, ...identity } = input;
    parse(positive, prNumber);
    const { target, path } = this.route(identity);
    const current = parse(pullResponse, await this.json(`${path}/pulls/${prNumber}`, signal));
    this.assertRepository(current.base.repo, target);
    if (current.number !== prNumber || (current.merged && current.state !== 'closed')) {
      throw new Error('Review reader pull request identity/state mismatch');
    }
    return { current: {
      ...target, prNumber, headSha: current.head.sha, baseSha: current.base.sha,
      open: current.state === 'open' && !current.merged, draft: current.draft,
    }, ...(current.changed_files === undefined ? {} : { expectedFileCount: current.changed_files }) };
  }

  async currentCandidate(input: ReviewRepositoryIdentity & { prNumber: number }, signal?: AbortSignal): Promise<CurrentReviewCandidate> {
    return (await this.pullCandidate(input, signal)).current;
  }

  private async pinnedFile(repositoryPath: string, filePath: string, revision: string,
    signal?: AbortSignal): Promise<{ content: string; sha: string; bytes: number } | null> {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    let raw: string;
    try {
      raw = await this.text(`${repositoryPath}/contents/${encoded}?ref=${encodeURIComponent(revision)}`,
        'application/vnd.github+json', MAX_PINNED_CONTENT_RESPONSE_BYTES, signal, false, true);
    } catch (error) {
      if (error instanceof MissingPinnedObject) return null;
      throw error;
    }
    let file: z.infer<typeof pinnedFileResponse>;
    try { file = pinnedFileResponse.parse(JSON.parse(raw)); }
    catch { throw new Error('Review reader pinned object invalid'); }
    const base64 = file.content.replace(/[\r\n]/gu, '');
    const bytes = Buffer.from(base64, 'base64');
    if (file.path !== filePath || bytes.length !== file.size || bytes.length > MAX_RECONSTRUCTED_FILE_BYTES
      || bytes.toString('base64') !== base64
      || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.sha) {
      throw new Error('Review reader pinned object invalid');
    }
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('Review reader pinned object is not text'); }
    if (content.includes('\0')) throw new Error('Review reader pinned object is not text');
    return { content, sha: file.sha, bytes: bytes.length };
  }

  private async reconstructFile(repositoryPath: string, file: ComparisonFileEvidence,
    baseSha: string, headSha: string, signal?: AbortSignal): Promise<{ file: ChangedFile; contentBytes: number }> {
    const oldPath = file.previousPath ?? file.path;
    const [base, head] = await Promise.all([
      this.pinnedFile(repositoryPath, oldPath, baseSha, signal),
      this.pinnedFile(repositoryPath, file.path, headSha, signal),
    ]);
    const validObjects = file.status === 'added' ? base === null && head?.sha === file.blobSha
      : file.status === 'removed' ? base?.sha === file.blobSha && head === null
        : base !== null && head?.sha === file.blobSha;
    if (!validObjects) throw new Error('Review reader pinned object status mismatch');
    const before = base?.content ?? ''; const after = head?.content ?? '';
    // These changes require typed file-level metadata evidence; a string patch
    // cannot admit them without falsely claiming reviewable line coverage.
    if (before === after) throw new Error('Review reader reconstructed diff unavailable');
    const patch = structuredPatch(oldPath, file.path, before, after, '', '', {
      context: 3, timeout: MAX_RECONSTRUCTION_DIFF_MS, maxEditLength: MAX_RECONSTRUCTION_EDIT_LENGTH,
    });
    const formatted = patch && patch.hunks.length > 0 ? formatPatch(patch, OMIT_HEADERS) : fullReplacementPatch(before, after);
    if (!formatted.startsWith('@@ ') || Buffer.byteLength(formatted, 'utf8') > MAX_CHANGED_FILE_PATCH_BYTES) {
      throw new Error('Review reader reconstructed diff unavailable');
    }
    return { file: { path: file.path, patch: formatted }, contentBytes: (base?.bytes ?? 0) + (head?.bytes ?? 0) };
  }

  private async comparisonFiles(repositoryPath: string, expected: number | undefined,
    baseSha: string, headSha: string, signal?: AbortSignal): Promise<ChangedFile[]> {
    if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1 || expected > MAX_COMPARISON_FILES) {
      throw new Error('Review reader file count unavailable');
    }
    const comparisonPath = `${repositoryPath}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`;
    let comparison: z.infer<typeof comparisonResponse>; let files: ComparisonFileEvidence[];
    try {
      comparison = comparisonResponse.parse(JSON.parse(await this.text(`${comparisonPath}?per_page=1&page=1`,
        'application/vnd.github+json', MAX_COMPARISON_RESPONSE_BYTES, signal)));
      files = parseComparisonFiles(comparison.files);
    } catch { throw new Error('Review reader comparison evidence unavailable'); }
    if (comparison.url !== `${this.api}${comparisonPath}` || comparison.base_commit.sha !== baseSha) {
      throw new Error('Review reader comparison identity mismatch');
    }
    if (files.length !== expected) throw new Error('Review reader file count mismatch');
    const paths = new Set<string>(); let patchBytes = 0;
    for (const file of files) {
      patchBytes += Buffer.byteLength(file.patch ?? '', 'utf8');
      if (paths.has(file.path) || patchBytes > MAX_AUTHORITATIVE_CHANGED_FILES_BYTES) {
        throw new Error('Review reader file evidence unavailable');
      }
      paths.add(file.path);
    }
    const missing = files.map((file, index) => ({ file, index })).filter(({ file }) => file.patch === undefined);
    if (missing.length > MAX_RECONSTRUCTED_FILES) {
      throw new Error('Review reader reconstructed file count exceeds bound');
    }
    const reconstructed = new Map<number, ChangedFile>();
    let contentBytes = 0;
    const reconstructionBaseSha = comparison.merge_base_commit.sha;
    for (let offset = 0; offset < missing.length; offset += RECONSTRUCTION_CONCURRENCY) {
      const batch = await Promise.all(missing.slice(offset, offset + RECONSTRUCTION_CONCURRENCY).map(async ({ file, index }) => ({ index,
        result: await this.reconstructFile(repositoryPath, file, reconstructionBaseSha, headSha, signal) })));
      for (const { index, result } of batch) {
        contentBytes += result.contentBytes;
        patchBytes += Buffer.byteLength(result.file.patch, 'utf8');
        if (contentBytes > MAX_RECONSTRUCTED_CONTENT_BYTES || patchBytes > MAX_AUTHORITATIVE_CHANGED_FILES_BYTES) {
          throw new Error('Review reader reconstructed evidence exceeds bound');
        }
        reconstructed.set(index, result.file);
      }
    }
    return files.map((file, index) => file.patch === undefined
      ? reconstructed.get(index)! : { path: file.path, patch: file.patch });
  }

  /** Fetch the PR diff (or its immutable three-dot compare evidence for GitHub's 406
   * too_large response). Both reads bind numeric repository,
   * PR, head and base; a raced/closed candidate carries no review evidence. */
  async exactCurrentDiff(input: ReviewRepositoryIdentity & { prNumber: number; headSha: string; baseSha: string },
    signal?: AbortSignal): Promise<ExactCurrentReviewDiff> {
    const { headSha, baseSha, ...target } = input;
    parse(sha, headSha); parse(sha, baseSha);
    const matches = (current: CurrentReviewCandidate) => current.open && current.headSha === headSha && current.baseSha === baseSha;
    const before = await this.pullCandidate(target, signal);
    if (!matches(before.current)) return { current: before.current, diff: '' };
    const { prNumber, ...identity } = target;
    const { path } = this.route(identity);
    let diff = ''; let changedFiles: ChangedFile[] | undefined;
    try {
      diff = await this.text(`${path}/pulls/${prNumber}`, 'application/vnd.github.v3.diff', MAX_AUTHORITATIVE_DIFF_BYTES, signal, true);
    } catch (error) {
      if (!(error instanceof OversizedPullDiff)) throw error;
      changedFiles = await this.comparisonFiles(path, before.expectedFileCount, baseSha, headSha, signal);
    }
    const after = await this.pullCandidate(target, signal);
    if (!matches(after.current)) return { current: after.current, diff: '' };
    if (changedFiles) {
      if (after.expectedFileCount !== before.expectedFileCount || after.expectedFileCount !== changedFiles.length) {
        throw new Error('Review reader file count changed');
      }
      return { current: after.current, diff: '', changedFiles, expectedFileCount: after.expectedFileCount };
    }
    return { current: after.current, diff,
      ...(before.expectedFileCount !== undefined && before.expectedFileCount === after.expectedFileCount
        ? { expectedFileCount: after.expectedFileCount } : {}) };
  }

  /** Resolve only a service-configured policy reference, then retain the exact
   * SHA. Never resolve candidate-provided references or use a mutable ref when
   * reading the actual policy file. */
  async resolvePolicyRevision(input: ReviewRepositoryIdentity, trustedRef: string, signal?: AbortSignal): Promise<string> {
    const { target, path } = this.route(input);
    if (!trustedRef || trustedRef.length > 256 || /[\u0000-\u001f\u007f]/u.test(trustedRef)) {
      throw new Error('Review reader policy reference invalid');
    }
    this.assertRepository(parse(repositoryResponse, await this.json(path, signal)), target);
    return parse(z.object({ sha }), await this.json(`${path}/commits/${encodeURIComponent(trustedRef)}`, signal)).sha;
  }

  async immutablePolicyFile(input: ReviewRepositoryIdentity, revision: string, filePath: string, signal?: AbortSignal): Promise<ImmutableReviewPolicyFile> {
    const { target, path } = this.route(input);
    parse(sha, revision); parse(sourcePath, filePath);
    this.assertRepository(parse(repositoryResponse, await this.json(path, signal)), target);
    const file = parse(z.object({
      type: z.literal('file'), path: sourcePath, sha, encoding: z.literal('base64'),
      size: z.number().int().min(0).max(MAX_FILE_BYTES), content: z.string().max(MAX_RESPONSE_BYTES),
    }), await this.json(`${path}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`, signal));
    const encoded = file.content.replace(/[\r\n]/gu, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (file.path !== filePath || bytes.length !== file.size || bytes.length > MAX_FILE_BYTES
      || bytes.toString('base64') !== encoded
      || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.sha) {
      throw new Error('Review reader immutable file identity mismatch');
    }
    return {
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      source: {
        repositoryId: target.repositoryId, repository: `${target.owner}/${target.repo}`,
        sha: revision, path: filePath, contentDigest: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  }
}
