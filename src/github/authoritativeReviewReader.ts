import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CurrentReviewCandidate, TrustedResolvedReviewPolicy } from '../review/authoritativeReviewIdentity';

const positive = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== '.' && value !== '..');
const repository = z.object({ repositoryId: positive, owner: name, repo: name }).strict();
const repositoryResponse = z.object({ id: positive, full_name: z.string() });
const pullResponse = z.object({
  number: positive, state: z.enum(['open', 'closed']), draft: z.boolean(), merged: z.boolean(),
  head: z.object({ sha }), base: z.object({ sha, repo: repositoryResponse }),
});
const sourcePath = z.string().min(1).max(512).refine((value) => !value.startsWith('/')
  && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  && !/[\\\u0000-\u001f\u007f]/u.test(value));
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  try { return schema.parse(input); }
  catch { throw new Error('Review reader identity or response invalid'); }
}

export type ReviewRepositoryIdentity = z.infer<typeof repository>;
export interface ImmutableReviewPolicyFile {
  source: TrustedResolvedReviewPolicy['sources'][number];
  content: string;
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
    if (!/^ghs_[A-Za-z0-9_]+$/u.test(options.token)) throw new Error('Review reader requires an installation credential');
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

  private async json(path: string): Promise<unknown> {
    const abort = new AbortController();
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        void bodyReader?.cancel().catch(() => undefined);
        reject(new Error('Review reader request unavailable'));
      }, this.timeoutMs);
    });
    const read = async (): Promise<unknown> => {
      const response = await this.fetcher(`${this.api}${path}`, {
        method: 'GET', redirect: 'error', signal: abort.signal,
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.options.token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'review-yeti-authoritative-reader',
        },
      });
      if (abort.signal.aborted || !response.ok || !response.body) {
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
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new Error('Review reader response exceeds bound');
          chunks.push(next.value);
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
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
    } finally { if (timer !== undefined) clearTimeout(timer); }
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

  async currentCandidate(input: ReviewRepositoryIdentity & { prNumber: number }): Promise<CurrentReviewCandidate> {
    const { prNumber, ...identity } = input;
    parse(positive, prNumber);
    const { target, path } = this.route(identity);
    const current = parse(pullResponse, await this.json(`${path}/pulls/${prNumber}`));
    this.assertRepository(current.base.repo, target);
    if (current.number !== prNumber || (current.merged && current.state !== 'closed')) {
      throw new Error('Review reader pull request identity/state mismatch');
    }
    return {
      ...target, prNumber, headSha: current.head.sha, baseSha: current.base.sha,
      open: current.state === 'open' && !current.merged, draft: current.draft,
    };
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
