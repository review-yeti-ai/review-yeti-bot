import { z } from 'zod';
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
const currentSchema = requestedSchema.extend({ open: z.boolean(), draft: z.boolean() }).strict();

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
  if (!current.open || Object.entries(requested).some(([key, value]) => current[key as keyof RequestedReviewCandidate] !== value)) {
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

  async resolve(requested: RequestedReviewCandidate): Promise<AuthoritativePublishingResolution> {
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
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(unavailable()); }, this.timeoutMs);
    });
    const resolve = async (): Promise<AuthoritativePublishingResolution> => {
      // Snapshot and validate before any factory/token mint. Extra request keys,
      // including policy/ref/transport overrides, are rejected, not forwarded.
      const target = requestedSchema.parse(requested);
      const repository = { repositoryId: target.repositoryId, owner: target.owner, repo: target.repo };
      const candidateReader = await step(() => this.candidateReaderFactory({ ...repository }, abort.signal));
      const first = matchingCandidate(target, await step(() => candidateReader.currentCandidate({ ...repository, prNumber: target.prNumber })));
      const policyReader = await step(() => this.policyReaderFactory({ ...this.policyRepository }, abort.signal));
      const revision = reviewPolicySourceSchema.shape.sha.parse(await step(() =>
        policyReader.resolvePolicyRevision({ ...this.policyRepository }, this.policyRef)));
      const file = await step(() => policyReader.immutablePolicyFile({ ...this.policyRepository }, revision, this.policyPath));
      const source = reviewPolicySourceSchema.parse(file.source);
      if (source.repositoryId !== this.policyRepository.repositoryId
        || source.repository !== `${this.policyRepository.owner}/${this.policyRepository.repo}`
        || source.sha !== revision || source.path !== this.policyPath) throw unavailable();
      const prepared = preparePublishingPolicy(file, this.transport);
      const identity = buildAuthoritativeReviewIdentity({ requested: target, current: first, policy: prepared.policy });
      const current = matchingCandidate(target, await step(() => candidateReader.currentCandidate({ ...repository, prNumber: target.prNumber })));
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
      abort.abort();
    }
  }
}
