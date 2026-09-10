import { createHash } from 'node:crypto';
import { z } from 'zod';
import { reviewPolicySourceSchema, type CurrentReviewCandidate, type ImmutableReviewPolicyFile } from '../review/authoritativeReviewIdentity';
import { isGitHubInstallationToken } from './githubTransportPolicy';
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

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  try { return schema.parse(input); }
  catch { throw new Error('Review reader identity or response invalid'); }
}

export type ReviewRepositoryIdentity = z.infer<typeof repository>;
export interface ExactCurrentReviewDiff {
  current: CurrentReviewCandidate;
  /** Empty when the candidate changed/closed before or during the read. */
  diff: string;
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

  private async text(path: string, accept: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
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
      if (abort.signal.aborted || response.status !== 200 || !response.body) {
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
          if (bytes > maxBytes) throw new Error('Review reader response exceeds bound');
          chunks.push(next.value);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
        bodyReader = undefined;
      }
    };
    try {
      return await Promise.race([read(), expired]);
    } catch {
      // GitHub error bodies and transport errors can contain credential or
      // repository content. Neither belongs in admission logs or responses.
      abort.abort();
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

  /** Fetch the PR diff, not a two-dot commit comparison: it must match the
   * worker's PR diff semantics. Both metadata reads bind numeric repository,
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
    const diff = await this.text(`${path}/pulls/${prNumber}`, 'application/vnd.github.v3.diff', MAX_AUTHORITATIVE_DIFF_BYTES, signal);
    const after = await this.pullCandidate(target, signal);
    if (!matches(after.current)) return { current: after.current, diff: '' };
    return { current: after.current, diff,
      ...(before.expectedFileCount !== undefined && before.expectedFileCount === after.expectedFileCount
        ? { expectedFileCount: after.expectedFileCount } : {}) };
  }

  /** Resolve only a service-configured policy reference, then retain the exact
   * SHA. Never resolve candidate-provided references or use a mutable ref when
   * reading the actual policy file. */
  async resolvePolicyRevision(input: ReviewRepositoryIdentity, trustedRef: string): Promise<string> {
    const { target, path } = this.route(input);
    if (!trustedRef || trustedRef.length > 256 || /[\u0000-\u001f\u007f]/u.test(trustedRef)) {
      throw new Error('Review reader policy reference invalid');
    }
    this.assertRepository(parse(repositoryResponse, await this.json(path)), target);
    return parse(z.object({ sha }), await this.json(`${path}/commits/${encodeURIComponent(trustedRef)}`)).sha;
  }

  async immutablePolicyFile(input: ReviewRepositoryIdentity, revision: string, filePath: string): Promise<ImmutableReviewPolicyFile> {
    const { target, path } = this.route(input);
    parse(sha, revision); parse(sourcePath, filePath);
    this.assertRepository(parse(repositoryResponse, await this.json(path)), target);
    const file = parse(z.object({
      type: z.literal('file'), path: sourcePath, sha, encoding: z.literal('base64'),
      size: z.number().int().min(0).max(MAX_FILE_BYTES), content: z.string().max(MAX_RESPONSE_BYTES),
    }), await this.json(`${path}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${revision}`));
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
