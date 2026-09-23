import { z } from 'zod';
import {
  MAX_AUTHORITATIVE_CHANGED_FILES_BYTES, MAX_AUTHORITATIVE_DIFF_BYTES,
  type AuthoritativeReviewReader, type ReviewRepositoryIdentity,
} from '../github/authoritativeReviewReader';
import type { StoredReviewGate, TrustedGateCompletionContext } from './reviewGateContracts';
import type { AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import { buildAuthoritativeReviewIdentity, reviewPolicySourceSchema, type CurrentReviewCandidate } from './authoritativeReviewIdentity';
import { parseChangedFiles } from './changedFiles';
import { filterDiffHunks } from '../pipeline/hunkFilter';
import { verifyPreparedPublishingConfig, type PreparedPublishingPolicy } from './preparedPublishingPolicy';
import { deriveApplicablePersonaIds } from './personaApplicability';
import { canonicalJson } from './reviewCore';
import { isDocumentationOrAssetPath } from './reviewableContent';
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
    Promise<Pick<AuthoritativeReviewReader, 'currentCandidate' | 'exactCurrentDiff'>>;
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
function classified(reason: TrustedCompletionResolutionReason): Error {
  return new Error(`Authoritative completion context unavailable: ${reason}`);
}

/** Read the class back off a classified failure. */
function reasonOf(error: unknown): TrustedCompletionResolutionReason {
  const message = error instanceof Error ? error.message : '';
  const found = message.split(': ')[1] as TrustedCompletionResolutionReason | undefined;
  return found && trustedCompletionResolutionReasons.includes(found) ? found : 'unknown';
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
  (gate: StoredReviewGate) => Promise<TrustedGateCompletionContext> {
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

  return async (gate): Promise<TrustedGateCompletionContext> => {
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
      const reviewableFiles = filterDiffHunks(files).files.filter((file) => file.status !== 'ignored');
      const applicablePersonaIds = deriveApplicablePersonaIds(
        stored.config.personas.filter((persona) => persona.enabled),
        reviewableFiles,
      );
      const allNonCode = reviewableFiles.length > 0
        && reviewableFiles.every((file) => isDocumentationOrAssetPath(file.path));
      // A zero-lane documentation-only panel is an explicit audited exemption.
      // Its canonical derivation still needs the admitted nonempty upper-bound
      // roster. Unmatched source is a policy/configuration failure, never SHIP.
      if (applicablePersonaIds.length === 0 && !allNonCode) throw classified('coverage-no-persona');
      const expectedPersonaIds = applicablePersonaIds.length > 0
        ? applicablePersonaIds : [...stored.expectedPersonaIds];
      checkDeadline();
      return { current: { ...final, policyDigest }, coverage: {
        expectedPersonaIds, changedFiles: files, coverageComplete,
        // This establishes a nonempty required-lane contract, not completed
        // worker quorum. Derivation separately requires ALL these exact IDs.
        quorumSatisfied: expectedPersonaIds.length > 0,
      } };
    };
    try { return await Promise.race([resolve(), expired]); }
    catch (error) {
      throw new TrustedCompletionResolutionError(substage, reasonOf(error));
    }
    finally { if (timer !== undefined) clearTimeout(timer); abort.abort(); }
  };
}
