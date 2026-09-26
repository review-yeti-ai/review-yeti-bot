import { z } from 'zod';
import {
  MAX_AUTHORITATIVE_CHANGED_FILES_BYTES, MAX_AUTHORITATIVE_DIFF_BYTES,
  type AuthoritativeReviewReader, type ReviewRepositoryIdentity,
} from '../github/authoritativeReviewReader';
import type { StoredReviewGate, TrustedGateCompletionContext } from './reviewGateContracts';
import type { AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import { buildAuthoritativeReviewIdentity, reviewPolicySourceSchema, type CurrentReviewCandidate } from './authoritativeReviewIdentity';
import { parseChangedFiles } from './changedFiles';
import { verifyPreparedPublishingConfig, type PreparedPublishingPolicy } from './preparedPublishingPolicy';
import { resolveReviewApplicability } from './personaApplicability';
import { verifyIncrementalClaim, type IncrementalVerificationInput } from './incrementalReview';
import { routedLanesOf, verifyVerdictCacheClaim, type VerdictCacheVerificationInput } from './verdictCache';
import { canonicalJson } from './reviewCore';
import { MAX_CHANGED_FILES, MAX_CHANGED_FILE_PATCH_BYTES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';
import {
  TrustedCompletionResolutionError,
  isDeterministicCompletionFailure,
  trustedCompletionResolutionReasons,
  type TrustedCompletionResolutionReason,
  type TrustedCompletionResolutionSubstage,
} from './workerCompletionPersistenceError';

const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => value !== '.' && value !== '..');
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const requestedSchema = z.object({
  repositoryId: z.number().int().positive().safe(), owner: name, repo: name,
  prNumber: z.number().int().positive().safe(), headSha: reviewPolicySourceSchema.shape.sha,
  baseSha: reviewPolicySourceSchema.shape.sha,
}).strict();
const currentSchema = requestedSchema.extend({ open: z.boolean(), draft: z.boolean() });
const policySchema = z.object({ effectivePolicyDigest: digest, effectiveConfigDigest: digest,
  sources: z.array(reviewPolicySourceSchema).min(1).max(16) }).strict();
const personasSchema = z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u)).min(1).max(64);

export interface AuthoritativeCompletionContextOptions {
  /** Service-owned storage lookup, including its persisted-content integrity check. */
  getStoredPrepared: (policyDigest: string, signal: AbortSignal) => Promise<PreparedPublishingPolicy | null>;
  /** Mint only a repository-scoped read token. Neither credentials nor readers are cached. */
  readerFactory: (repository: ReviewRepositoryIdentity, signal: AbortSignal) =>
    Promise<Pick<AuthoritativeReviewReader, 'currentCandidate' | 'exactCurrentDiff'>
      & Partial<Pick<AuthoritativeReviewReader, 'commitComparison' | 'comparisonContent'>>>;
  /** Already configured with the service's trusted central policy/ref/transport. */
  publishingResolver: Pick<AuthoritativePublishingResolver, 'resolve'>;
  /** Whole operation, including storage, token mint, policy refresh and body reads. */
  timeoutMs?: number;
}

function unavailable(): Error { return new Error('Authoritative completion context unavailable'); }

/**
 * A classified failure. REL-1056: the reason is a fixed service-owned token, so
 * it is safe to log and to return to the worker, and it lets a deterministic
 * contract mismatch be reported as a contract failure rather than a retryable
 * 503. No upstream message, token, or payload crosses this boundary.
 */
/**
 * A classified failure. The reason is carried as a STRUCTURED field, never
 * encoded into the message and parsed back out: `split(': ')` is index-fragile,
 * and a message shape change would silently degrade a deterministic failure to
 * 'unknown' — a retryable class — restoring the REL-1056 bug by another route.
 */
class ClassifiedCompletionError extends Error {
  constructor(readonly reason: TrustedCompletionResolutionReason) {
    super('Authoritative completion context unavailable');
    this.name = 'ClassifiedCompletionError';
  }
}

function classified(reason: TrustedCompletionResolutionReason): Error {
  return new ClassifiedCompletionError(reason);
}

/** Read the class off a classified failure, defaulting to the transient class. */
function reasonOf(error: unknown): TrustedCompletionResolutionReason {
  return error instanceof ClassifiedCompletionError ? error.reason : 'unknown';
}

function checkedPrepared(input: PreparedPublishingPolicy | null): PreparedPublishingPolicy {
  if (!input || input.version !== 'PreparedPublishingPolicy.v1'
    || Buffer.byteLength(JSON.stringify(input), 'utf8') > 256 * 1024) throw unavailable();
  const policy = policySchema.parse(input.policy);
  const config = verifyPreparedPublishingConfig(input.config, policy.effectiveConfigDigest, input.transport);
  const expectedPersonaIds = personasSchema.parse(input.expectedPersonaIds);
  const required = config.personas.filter((persona) => persona.enabled).map((persona) => persona.id);
  if (new Set(expectedPersonaIds).size !== expectedPersonaIds.length
    || canonicalJson(required) !== canonicalJson(expectedPersonaIds)
    || canonicalJson(config) !== canonicalJson(input.config)) throw unavailable();
  return { version: input.version, policy, config, expectedPersonaIds,
    transport: { baseUrl: input.transport.baseUrl, model: input.transport.model } };
}

/** Service-owned read authority only. This factory neither accepts worker
 * evidence nor concludes a review. Canonical callback derivation must still
 * require every expected persona, validate findings, and determine the verdict. */
export function createAuthoritativeCompletionContext(options: AuthoritativeCompletionContextOptions):
  (gate: StoredReviewGate, incremental?: IncrementalVerificationInput,
    verdictCache?: VerdictCacheVerificationInput) => Promise<TrustedGateCompletionContext> {
  let timeoutMs: number;
  try {
    // Large exact-head diffs can require bounded pinned-file reconstruction
    // after the policy and candidate reads. Keep one cumulative deadline, with
    // room below the worker's 30-second completion transport budget.
    timeoutMs = z.number().int().min(250).max(20_000).parse(options.timeoutMs ?? 20_000);
    if (typeof options.getStoredPrepared !== 'function' || typeof options.readerFactory !== 'function'
      || typeof options.publishingResolver?.resolve !== 'function') throw unavailable();
  } catch { throw new Error('Authoritative completion context configuration invalid'); }
  const { getStoredPrepared, readerFactory } = options;
  const resolvePublishing = options.publishingResolver.resolve.bind(options.publishingResolver);

  return async (gate, incremental, verdictCache): Promise<TrustedGateCompletionContext> => {
    let substage: TrustedCompletionResolutionSubstage = 'stored-policy';
    const abort = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const checkDeadline = () => {
      if (abort.signal.aborted || performance.now() >= deadline) throw unavailable();
    };
    const step = async <T>(read: () => Promise<T>): Promise<T> => {
      checkDeadline();
      const value = await read();
      checkDeadline();
      return value;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(unavailable()); }, timeoutMs);
    });
    const resolve = async (): Promise<TrustedGateCompletionContext> => {
      const coordinates = gate.coordinates;
      const policyDigest = digest.parse(coordinates.policyDigest);
      const requested = requestedSchema.parse({ repositoryId: coordinates.repositoryId, owner: coordinates.owner,
        repo: coordinates.repo, prNumber: coordinates.prNumber, headSha: coordinates.headSha, baseSha: coordinates.baseSha });
      const repository = { repositoryId: requested.repositoryId, owner: requested.owner, repo: requested.repo };
      const target = { ...repository, prNumber: requested.prNumber };
      const stored = checkedPrepared(await step(() => getStoredPrepared(policyDigest, abort.signal)));
      if (stored.policy.effectivePolicyDigest !== policyDigest) throw unavailable();
      substage = 'token';
      const reader = await step(() => readerFactory({ ...repository }, abort.signal));
      const checkedCurrent = (input: CurrentReviewCandidate): CurrentReviewCandidate => {
        const current = currentSchema.parse(input);
        if (Object.entries(target).some(([key, value]) => current[key as keyof typeof target] !== value)) throw unavailable();
        return current;
      };
      const changed = (current: CurrentReviewCandidate) => !current.open
        || current.headSha !== requested.headSha || current.baseSha !== requested.baseSha;
      const cancellation = (current: CurrentReviewCandidate, currentPolicyDigest = policyDigest): TrustedGateCompletionContext => ({
        current: { ...current, policyDigest: currentPolicyDigest },
        coverage: { expectedPersonaIds: [...stored.expectedPersonaIds], changedFiles: [], coverageComplete: false, quorumSatisfied: false },
      });
      substage = 'current-candidate';
      const first = checkedCurrent(await step(() => reader.currentCandidate({ ...target }, abort.signal)));
      if (changed(first)) return cancellation(first);

      let refreshed;
      substage = 'policy-refresh';
      try { refreshed = await step(() => resolvePublishing({ ...requested })); }
      catch {
        // The admission resolver rejects a head/base/closed race. Re-read rather
        // than mistaking that race for policy truth or inventing cancellation.
        checkDeadline();
        substage = 'current-candidate';
        const current = checkedCurrent(await step(() => reader.currentCandidate({ ...target }, abort.signal)));
        if (changed(current)) return cancellation(current);
        substage = 'policy-refresh';
        throw unavailable();
      }
      const current = checkedCurrent(refreshed.current);
      if (changed(current)) return cancellation(current);
      const fresh = checkedPrepared(refreshed.prepared);
      const identity = buildAuthoritativeReviewIdentity({ requested, current, policy: fresh.policy });
      if (canonicalJson(identity) !== canonicalJson(refreshed.identity)) throw unavailable();
      if (fresh.policy.effectivePolicyDigest !== policyDigest) return cancellation(current, fresh.policy.effectivePolicyDigest);
      // An unchanged policy digest with different prepared content is corrupt,
      // not authority to reinterpret the admitted worker's configuration.
      if (canonicalJson(stored) !== canonicalJson(fresh)) throw unavailable();

      substage = 'exact-diff';
      const source = await step(() => reader.exactCurrentDiff({ ...requested }, abort.signal));
      const final = checkedCurrent(source.current);
      if (changed(final)) return cancellation(final);
      if (typeof source.diff !== 'string' || Buffer.byteLength(source.diff, 'utf8') > MAX_AUTHORITATIVE_DIFF_BYTES) throw classified('bounds');
      if (source.changedFiles !== undefined && (source.diff !== '' || !Array.isArray(source.changedFiles))) throw classified('identity-mismatch');
      const { files, unreadable } = source.changedFiles === undefined
        ? parseChangedFiles(source.diff) : { files: source.changedFiles, unreadable: [] };
      // Empty/unparseable same-head evidence is unavailable, not an exemption.
      // Empty changedFiles is reserved for cancellation, before derivation.
      // REL-1056: an entry with NO patch is a deterministic property of the diff
      // (empty added file, large generated file, binary), not a transient read
      // failure. It is reported as its own class so an operator can see which PRs
      // are blocked by which cause, and so it is not retried forever as a 503.
      // Whether such an entry should be accepted as "reviewable-without-hunks" is
      // a coverage-semantics decision deliberately left to the owner: a file
      // nobody can read is a file nobody reviewed, and counting it as covered
      // risks a false SHIP.
      //
      // ORDER: the specific causes are classified BEFORE the broader bounds
      // verdict, so a diagnosis names what actually blocks the PR rather than
      // whichever check happens to run first.
      if (files.some((file) => typeof file.patch !== 'string' || file.patch.length === 0)) throw classified('no-patch-file');
      if (files.length === 0 || files.length > MAX_CHANGED_FILES) throw classified('bounds');
      if (files.some((file) => !file
        || typeof file.path !== 'string' || file.path.length === 0 || file.path.length > MAX_PATH_CHARACTERS)
        || files.some((file) => Buffer.byteLength(file.patch, 'utf8') > MAX_CHANGED_FILE_PATCH_BYTES)
        || files.reduce((bytes, file) => bytes + Buffer.byteLength(file.patch, 'utf8'), 0)
          > (source.changedFiles === undefined ? MAX_AUTHORITATIVE_DIFF_BYTES : MAX_AUTHORITATIVE_CHANGED_FILES_BYTES)) throw classified('bounds');
      const coverageComplete = unreadable.length === 0
        && Number.isSafeInteger(source.expectedFileCount) && files.length === source.expectedFileCount
        && new Set(files.map((file) => file.path)).size === files.length;
      // The worker's own applicability decision (resolveReviewApplicability):
      // same enabled roster, same repository path_filters, same gitlink
      // metadata and routing. Deriving it separately here -- without the repo
      // options, and after dropping each file's gitlink mode -- is how the two
      // sides came to disagree about which lanes a diff requires (REL-1056).
      substage = 'applicability';
      const applicability = resolveReviewApplicability(
        stored.config.personas.filter((persona) => persona.enabled),
        files,
        { pathFilters: stored.config.path_filters },
      );
      const applicablePersonaIds = applicability.applicable.map((persona) => persona.id);
      // A zero-lane documentation-only panel is an explicit audited exemption.
      // Its canonical derivation still needs the admitted nonempty upper-bound
      // roster. Unmatched source is a policy/configuration failure, never SHIP.
      if (applicablePersonaIds.length === 0 && !applicability.noReviewableContent) throw classified('coverage-no-persona');
      const expectedPersonaIds = applicablePersonaIds.length > 0
        ? applicablePersonaIds : [...stored.expectedPersonaIds];
      // REL-1084: a carried-forward completion is re-decided here from the service's own
      // prior record and exact-SHA comparisons. A read failure is transient (retry); a
      // decision that does not permit the claim leaves it unverified, which the canonical
      // derivation refuses.
      let incrementalVerified: boolean | undefined;
      if (incremental) {
        substage = 'exact-diff';
        const compare = reader.commitComparison?.bind(reader);
        incrementalVerified = compare ? (await step(() => verifyIncrementalClaim({
          claim: incremental.claim, prior: incremental.prior, maxAgeMs: incremental.maxAgeMs,
          current: { runId: incremental.run.runId, repositoryId: requested.repositoryId, prNumber: requested.prNumber,
            headSha: requested.headSha, baseSha: requested.baseSha, policyDigest,
            configDigest: incremental.run.configDigest, executionAttempt: incremental.run.executionAttempt },
          currentPaths: files.map((file) => file.path),
          reader: { compare: (base, head, signal) => compare({ ...repository }, base, head, signal ?? abort.signal) },
          signal: abort.signal,
        }))).verified : false;
      }
      // REL-1085: a completion that served files from the verdict cache is re-decided here from
      // the service's own source record, exact-SHA comparisons and THIS applicability decision's
      // routing. A read failure is transient (retry); a decision that does not permit every served
      // file leaves it unverified, which the canonical derivation refuses.
      let verdictCacheVerified: boolean | undefined;
      if (verdictCache?.claim.hits) {
        substage = 'exact-diff';
        const content = reader.comparisonContent?.bind(reader);
        const effective = new Map(applicability.effectiveFiles.map((file) => [file.path, file]));
        verdictCacheVerified = content ? (await step(() => verifyVerdictCacheClaim({
          claim: verdictCache.claim, source: verdictCache.source, maxAgeMs: verdictCache.maxAgeMs,
          current: { runId: verdictCache.run.runId, repositoryId: requested.repositoryId, prNumber: requested.prNumber,
            headSha: requested.headSha, baseSha: requested.baseSha, policyDigest,
            configDigest: verdictCache.run.configDigest, executionAttempt: verdictCache.run.executionAttempt },
          routedLanes: (path) => {
            const file = effective.get(path);
            return file ? routedLanesOf(applicability.applicable, file) : undefined;
          },
          reader: { content: (base, head, signal) => content({ ...repository }, base, head, signal ?? abort.signal) },
          signal: abort.signal,
        }))).verified : false;
      }
      checkDeadline();
      return { current: { ...final, policyDigest }, coverage: {
        expectedPersonaIds, changedFiles: files,
        // REL-1092: the same decision the worker's coverage reads. An analyzable
        // file whose changed text no lane could see is never counted as reviewed.
        coverageComplete: coverageComplete && applicability.omittedSourcePaths.length === 0,
        // This establishes a nonempty required-lane contract, not completed
        // worker quorum. Derivation separately requires ALL these exact IDs.
        quorumSatisfied: expectedPersonaIds.length > 0,
        ...(incrementalVerified === undefined ? {} : { incrementalVerified }),
        ...(verdictCacheVerified === undefined ? {} : { verdictCacheVerified }),
        // REL-1139: the same decision's disclosures, as counts, so a completion that claims a
        // skipped moderator is re-decided on this exact head (deriveCanonicalWorkerReviewEvidence).
        emptyModeration: {
          truncatedFiles: applicability.truncatedFiles.length,
          unavailablePatches: applicability.unavailablePatches.length,
          omittedSourcePaths: applicability.omittedSourcePaths.length,
          routedFiles: applicability.routedFiles.length,
          uncoveredPaths: applicability.unmatchedPaths.length,
        },
      } };
    };
    try { return await Promise.race([resolve(), expired]); }
    catch (error) {
      throw new TrustedCompletionResolutionError(substage, reasonOf(error));
    }
    finally { if (timer !== undefined) clearTimeout(timer); abort.abort(); }
  };
}
