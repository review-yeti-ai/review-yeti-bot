import { z } from 'zod';
import { isPublicReviewRepository } from '../auth/repositoryReviewAuthority';
import type { AuthoritativeReviewReader, ReviewRepositoryIdentity } from '../github/authoritativeReviewReader';
import { buildAuthoritativeReviewIdentity, reviewPolicySourceSchema,
  type AuthoritativeReviewRunIdentity, type CurrentReviewCandidate } from './authoritativeReviewIdentity';
import { preparePublishingPolicy, type PreparedPublishingPolicy } from './preparedPublishingPolicy';

const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== '.' && value !== '..');
const repositorySchema = z.object({
  repositoryId: reviewPolicySourceSchema.shape.repositoryId, owner: name, repo: name,
}).strict();
const requestedSchema = repositorySchema.extend({
  prNumber: z.number().int().positive().safe(),
  headSha: reviewPolicySourceSchema.shape.sha, baseSha: reviewPolicySourceSchema.shape.sha,
}).strict();
const currentSchema = requestedSchema.extend({ open: z.boolean(), draft: z.boolean(), private: z.boolean().optional() }).strict();

export type RequestedReviewCandidate = z.infer<typeof requestedSchema>;
export interface AuthoritativePublishingResolution {
  current: CurrentReviewCandidate;
  identity: AuthoritativeReviewRunIdentity;
  prepared: PreparedPublishingPolicy;
}

export interface AuthoritativePublishingResolverOptions {
  policyRepository: ReviewRepositoryIdentity;
  policyRef: string;
  policyPath: string;
  transport: PreparedPublishingPolicy['transport'];
  /** Mint repository-scoped credentials in these factories, not in request data.
   * Honor signal when possible; even an uncooperative factory is deadline-bound. */
  candidateReaderFactory: (repository: ReviewRepositoryIdentity, signal: AbortSignal) =>
    Promise<Pick<AuthoritativeReviewReader, 'currentCandidate'>>;
  policyReaderFactory: (repository: ReviewRepositoryIdentity, signal: AbortSignal) =>
    Promise<Pick<AuthoritativeReviewReader, 'resolvePolicyRevision' | 'immutablePolicyFile'>>;
  /** Whole resolution budget, including factories; defaults to 30 seconds. */
  timeoutMs?: number;
}

function unavailable(): Error { return new Error('Authoritative publishing resolution unavailable'); }

function matchingCandidate(requested: RequestedReviewCandidate, observed: CurrentReviewCandidate): CurrentReviewCandidate {
  const current = currentSchema.parse(observed);
  if (!current.open || Object.entries(requested).some(([key, value]) => current[key as keyof RequestedReviewCandidate] !== value)
    || (isPublicReviewRepository(requested) && current.private !== false)) {
    throw unavailable();
  }
  return current;
}

/** Service-owned, read-only admission preparation. Policy selection never comes
 * from a candidate. Reader instances/credentials and raw policy content are not
 * cached or returned. This is a current-truth read, not a durable gate reservation. */
export class AuthoritativePublishingResolver {
  private readonly policyRepository: ReviewRepositoryIdentity;
  private readonly policyRef: string;
  private readonly policyPath: string;
  private readonly transport: PreparedPublishingPolicy['transport'];
  private readonly candidateReaderFactory: AuthoritativePublishingResolverOptions['candidateReaderFactory'];
  private readonly policyReaderFactory: AuthoritativePublishingResolverOptions['policyReaderFactory'];
  private readonly timeoutMs: number;

  constructor(options: AuthoritativePublishingResolverOptions) {
    try {
      this.policyRepository = Object.freeze(repositorySchema.parse(options.policyRepository));
      this.policyRef = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u).parse(options.policyRef);
      this.policyPath = reviewPolicySourceSchema.shape.path.parse(options.policyPath);
      // Retain only credential-free transport coordinates. Effective config and
      // provider selection remain owned by preparePublishingPolicy.
      const transport = z.object({
        baseUrl: z.string().max(2_000).url(),
        model: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u),
      }).strict().parse(options.transport);
      const url = new URL(transport.baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw unavailable();
      this.transport = Object.freeze(transport);
      this.timeoutMs = z.number().int().min(250).max(30_000).parse(options.timeoutMs ?? 30_000);
      if (typeof options.candidateReaderFactory !== 'function' || typeof options.policyReaderFactory !== 'function') throw unavailable();
      this.candidateReaderFactory = options.candidateReaderFactory;
      this.policyReaderFactory = options.policyReaderFactory;
    } catch { throw new Error('Authoritative publishing resolver configuration invalid'); }
  }

  async resolve(requested: RequestedReviewCandidate, signal?: AbortSignal): Promise<AuthoritativePublishingResolution> {
    const abort = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    const checkDeadline = () => {
      if (abort.signal.aborted || performance.now() >= deadline) throw unavailable();
    };
    const step = async <T>(read: () => Promise<T>): Promise<T> => {
      checkDeadline();
      const result = await read();
      checkDeadline();
      return result;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => { abort.abort(); reject(unavailable()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onAbort, this.timeoutMs);
      if (signal?.aborted) onAbort();
    });
    const resolve = async (): Promise<AuthoritativePublishingResolution> => {
      // Snapshot and validate before any factory/token mint. Extra request keys,
      // including policy/ref/transport overrides, are rejected, not forwarded.
      const target = requestedSchema.parse(requested);
      const repository = { repositoryId: target.repositoryId, owner: target.owner, repo: target.repo };
      const candidateReader = await step(() => this.candidateReaderFactory({ ...repository }, abort.signal));
      const first = matchingCandidate(target, await step(() => candidateReader.currentCandidate({ ...repository, prNumber: target.prNumber }, abort.signal)));
      const policyReader = await step(() => this.policyReaderFactory({ ...this.policyRepository }, abort.signal));
      const revision = reviewPolicySourceSchema.shape.sha.parse(await step(() =>
        policyReader.resolvePolicyRevision({ ...this.policyRepository }, this.policyRef, abort.signal)));
      const file = await step(() => policyReader.immutablePolicyFile({ ...this.policyRepository }, revision, this.policyPath, abort.signal));
      const source = reviewPolicySourceSchema.parse(file.source);
      if (source.repositoryId !== this.policyRepository.repositoryId
        || source.repository !== `${this.policyRepository.owner}/${this.policyRepository.repo}`
        || source.sha !== revision || source.path !== this.policyPath) throw unavailable();
      // Repository-scoped policy overrides use only the identity the service just read from
      // GitHub and matched to the admitted target. PR text, caller policy JSON and mutable labels
      // are never inputs to this selection.
      const prepared = preparePublishingPolicy(file, this.transport, { owner: first.owner, repo: first.repo });
      const identity = buildAuthoritativeReviewIdentity({ requested: target, current: first, policy: prepared.policy });
      const current = matchingCandidate(target, await step(() => candidateReader.currentCandidate({ ...repository, prNumber: target.prNumber }, abort.signal)));
      checkDeadline();
      return { current, identity, prepared };
    };
    try {
      return await Promise.race([resolve(), expired]);
    } catch {
      // Never attach a cause or echo reader/factory errors, tokens, request
      // values, policy contents or transport response bodies.
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      abort.abort();
    }
  }

  /** Resolve a trusted service caller that has an enrolled repository/PR but
   * whose authenticated event did not carry head/base coordinates (for
   * example, GitHub's signed issue_comment event). The live coordinates are
   * read through the same scoped reader and immediately rebound by `resolve`;
   * callers cannot supply a policy or substitute a candidate between reads. */
  async resolveCurrent(requested: Omit<RequestedReviewCandidate, 'headSha' | 'baseSha'>,
    signal?: AbortSignal): Promise<AuthoritativePublishingResolution> {
    const target = repositorySchema.extend({ prNumber: z.number().int().positive().safe() }).strict().parse(requested);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      if (signal?.aborted) throw unavailable();
      const repository = { repositoryId: target.repositoryId, owner: target.owner, repo: target.repo };
      const reader = await this.candidateReaderFactory(repository, abort.signal);
      const current = currentSchema.parse(await reader.currentCandidate({
        ...repository, prNumber: target.prNumber,
      }, abort.signal));
      if (!current.open || current.draft
        || current.repositoryId !== target.repositoryId || current.owner !== target.owner
        || current.repo !== target.repo || current.prNumber !== target.prNumber) throw unavailable();
      if (abort.signal.aborted) throw unavailable();
      return await this.resolve({ ...target, headSha: current.headSha, baseSha: current.baseSha }, abort.signal);
    } catch {
      throw unavailable();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      abort.abort();
    }
  }
}
