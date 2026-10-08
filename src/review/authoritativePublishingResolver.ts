import { z } from 'zod';
import { isPublicReviewRepository } from '../auth/repositoryReviewAuthority';
import type { AuthoritativeReviewReader, ReviewRepositoryIdentity } from '../github/authoritativeReviewReader';
import { InternalGitHubDependencyUnavailableError, TransientAuthoritativeReadError } from '../github/authoritativeReadFailure';
import { buildAuthoritativeReviewIdentity, reviewPolicySourceSchema,
  type AuthoritativeReviewRunIdentity, type CurrentReviewCandidate } from './authoritativeReviewIdentity';
import { preparePublishingPolicy, type PreparedPublishingPolicy } from './preparedPublishingPolicy';
import { QUALIFICATION_RUNTIME_IMAGE_DIGEST_PATTERN } from '../config/qualificationRuntimeImage';

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
  /** Service-owned runtime override; never populated from a review request or repository content. */
  composedEngineMaxTurns?: string;
  /** Service-owned pinned worker identity for the isolated qualification instance only. */
  qualificationRuntimeImageDigest?: string;
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

/** A complete GitHub read proved this exact candidate is no longer current. */
export class AuthoritativeCandidateChangedError extends Error {
  constructor() { super('Authoritative publishing candidate changed'); this.name = 'AuthoritativeCandidateChangedError'; }
}

function matchingCandidate(requested: RequestedReviewCandidate, observed: CurrentReviewCandidate): CurrentReviewCandidate {
  const current = currentSchema.parse(observed);
  if (!current.open || current.draft
    || Object.entries(requested).some(([key, value]) => current[key as keyof RequestedReviewCandidate] !== value)
    || (isPublicReviewRepository(requested) && current.private !== false)) {
    throw new AuthoritativeCandidateChangedError();
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
  private readonly composedEngineMaxTurns?: string;
  private readonly qualificationRuntimeImageDigest?: string;
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
      this.composedEngineMaxTurns = typeof options.composedEngineMaxTurns === 'string'
        && options.composedEngineMaxTurns.length <= 64
        && !/[\x00-\x1f\x7f]/u.test(options.composedEngineMaxTurns)
        ? options.composedEngineMaxTurns : undefined;
      if (options.qualificationRuntimeImageDigest !== undefined) {
        if (!QUALIFICATION_RUNTIME_IMAGE_DIGEST_PATTERN.test(options.qualificationRuntimeImageDigest)) throw unavailable();
        this.qualificationRuntimeImageDigest = options.qualificationRuntimeImageDigest;
      }
      this.timeoutMs = z.number().int().min(250).max(30_000).parse(options.timeoutMs ?? 30_000);
      if (typeof options.candidateReaderFactory !== 'function' || typeof options.policyReaderFactory !== 'function') throw unavailable();
      this.candidateReaderFactory = options.candidateReaderFactory;
      this.policyReaderFactory = options.policyReaderFactory;
    } catch { throw new Error('Authoritative publishing resolver configuration invalid'); }
  }

  async resolve(requested: RequestedReviewCandidate, signal?: AbortSignal): Promise<AuthoritativePublishingResolution> {
    const abort = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    let termination: 'caller-cancelled' | 'deadline' | undefined;
    const checkDeadline = () => {
      // Caller cancellation always wins if it is already observable, even if
      // the timer callback and AbortSignal fire in the same event-loop turn.
      if (signal?.aborted || termination === 'caller-cancelled'
        || (abort.signal.aborted && termination !== 'deadline')) throw unavailable();
      if (termination === 'deadline' || performance.now() >= deadline) {
        throw new TransientAuthoritativeReadError('deadline');
      }
    };
    const step = async <T>(read: () => Promise<T>): Promise<T> => {
      checkDeadline();
      const result = await read();
      checkDeadline();
      return result;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let onDeadline: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => {
        if (termination !== undefined) return;
        termination = 'caller-cancelled';
        abort.abort();
        reject(unavailable());
      };
      onDeadline = () => {
        if (termination !== undefined) return;
        termination = 'deadline';
        abort.abort();
        reject(new TransientAuthoritativeReadError('deadline'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onDeadline, this.timeoutMs);
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
      const prepared = preparePublishingPolicy(file, this.transport, { owner: first.owner, repo: first.repo }, {
        ...(this.composedEngineMaxTurns === undefined ? {} : { composedEngineMaxTurns: this.composedEngineMaxTurns }),
        ...(this.qualificationRuntimeImageDigest === undefined ? {} : {
          qualificationRuntimeImageDigest: this.qualificationRuntimeImageDigest,
        }),
      });
      const identity = buildAuthoritativeReviewIdentity({ requested: target, current: first, policy: prepared.policy });
      const current = matchingCandidate(target, await step(() => candidateReader.currentCandidate({ ...repository, prNumber: target.prNumber }, abort.signal)));
      checkDeadline();
      return { current, identity, prepared };
    };
    try {
      return await Promise.race([resolve(), expired]);
    } catch (error) {
      // Never attach a cause or echo reader/factory errors, tokens, request
      // values, policy contents or transport response bodies.
      if (signal?.aborted) throw unavailable();
      if (error instanceof AuthoritativeCandidateChangedError) throw error;
      if (error instanceof TransientAuthoritativeReadError || error instanceof InternalGitHubDependencyUnavailableError) throw error;
      throw unavailable();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (onDeadline) clearTimeout(timer);
      abort.abort();
    }
  }

  /** Read current GitHub coordinates for a bounded service reconciliation seed.
   * The returned tuple must still pass `resolve` before it can authorize SHIP. */
  async readCurrentCandidate(seed: Pick<RequestedReviewCandidate, 'repositoryId' | 'owner' | 'repo' | 'prNumber'>,
    signal?: AbortSignal): Promise<CurrentReviewCandidate> {
    const target = repositorySchema.extend({ prNumber: z.number().int().positive().safe() }).parse(seed);
    const abort = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    let termination: 'caller-cancelled' | 'deadline' | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let onDeadline: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => {
        if (termination !== undefined) return;
        termination = 'caller-cancelled';
        abort.abort();
        reject(unavailable());
      };
      onDeadline = () => {
        if (termination !== undefined) return;
        termination = 'deadline';
        abort.abort();
        reject(new TransientAuthoritativeReadError('deadline'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onDeadline, this.timeoutMs);
      if (signal?.aborted) onAbort();
    });
    const checkReadState = () => {
      if (signal?.aborted || termination === 'caller-cancelled'
        || (abort.signal.aborted && termination !== 'deadline')) throw unavailable();
      if (termination === 'deadline' || performance.now() >= deadline) {
        throw new TransientAuthoritativeReadError('deadline');
      }
    };
    const read = async (): Promise<CurrentReviewCandidate> => {
      checkReadState();
      const reader = await this.candidateReaderFactory({ repositoryId: target.repositoryId,
        owner: target.owner, repo: target.repo }, abort.signal);
      checkReadState();
      const current = currentSchema.parse(await reader.currentCandidate({ ...target }, abort.signal));
      checkReadState();
      if (current.repositoryId !== target.repositoryId || current.owner !== target.owner
        || current.repo !== target.repo || current.prNumber !== target.prNumber) {
        throw unavailable();
      }
      return current;
    };
    try { return await Promise.race([read(), expired]); }
    catch (error) {
      if (signal?.aborted) throw unavailable();
      if (error instanceof TransientAuthoritativeReadError || error instanceof InternalGitHubDependencyUnavailableError) throw error;
      throw unavailable();
    }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (onDeadline) clearTimeout(timer);
      abort.abort();
    }
  }
}
