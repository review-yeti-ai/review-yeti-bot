import { z } from 'zod';
import {
  MAX_AUTHORITATIVE_CHANGED_FILES_BYTES, MAX_AUTHORITATIVE_DIFF_BYTES,
  MAX_GROUNDED_IMPORT_SOURCE_PROBES, type AuthoritativeReviewReader, type ReviewRepositoryIdentity,
} from '../github/authoritativeReviewReader';
import { InternalGitHubDependencyUnavailableError, TransientAuthoritativeReadError }
  from '../github/authoritativeReadFailure';
import type { StoredReviewGate, TrustedGateCompletionContext } from './reviewGateContracts';
import type { AuthoritativePublishingResolver } from './authoritativePublishingResolver';
import { buildAuthoritativeReviewIdentity, reviewPolicySourceSchema, type CurrentReviewCandidate } from './authoritativeReviewIdentity';
import { bindChangedFileSourcePresence, parseChangedFiles } from './changedFiles';
import { verifyPreparedPublishingConfig, type PreparedPublishingPolicy } from './preparedPublishingPolicy';
import { resolveReviewApplicability } from './personaApplicability';
import { verifyIncrementalClaim, type IncrementalVerificationInput, type PriorReviewRecord,
  type ReviewHeadAncestryReceipt } from './incrementalReview';
import type { IncrementalDeltaFile } from '../types/incrementalReview';
import { routedLanesOf, verifyVerdictCacheClaim, type VerdictCacheVerificationInput } from './verdictCache';
import { canonicalJson, sha256 } from './reviewCore';
import { MAX_CHANGED_FILES, MAX_CHANGED_FILE_PATCH_BYTES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';
import { resolveComposedMaxTasks } from '../reviewTaskContract';
import { resolveComposedProviderId } from '../panel/composedEngine';
import { REVIEW_SEVERITY_POLICY_V2 } from './reviewDecision';
import { groundedRelativeImportCandidates, parseGroundedRelativeImports } from './groundedContractResolver';
import type { GroundedImportResolutionSourceV1 } from './groundedEvidenceV2';
import type { TrustedGroundedImportResolutionSourceV1 } from './workerReviewCompletion';
import { groundedOriginAncestryFromComparison, MAX_GROUNDED_ORIGIN_ANCESTRY_COMPARISONS,
  type GroundedContinuityOriginRef, type GroundedOriginAncestryV1 } from './findingContinuity';
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
const currentSchema = requestedSchema.extend({ open: z.boolean(), draft: z.boolean(), private: z.boolean().optional() });
const policySchema = z.object({ effectivePolicyDigest: digest, effectiveConfigDigest: digest,
  sources: z.array(reviewPolicySourceSchema).min(1).max(16) }).strict();
const personasSchema = z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u)).min(1).max(64);

export interface AuthoritativeCompletionContextOptions {
  /** Service-owned storage lookup, including its persisted-content integrity check. */
  getStoredPrepared: (policyDigest: string, signal: AbortSignal) => Promise<PreparedPublishingPolicy | null>;
  /** Mint only a repository-scoped read token. Neither credentials nor readers are cached. */
  readerFactory: (repository: ReviewRepositoryIdentity, signal: AbortSignal) =>
    Promise<Pick<AuthoritativeReviewReader, 'currentCandidate' | 'exactCurrentDiff'>
      & Partial<Pick<AuthoritativeReviewReader, 'commitComparison' | 'commitComparisonDetailed' | 'comparisonContent'
        | 'findingThreads' | 'trustedConventionAdjudications' | 'readPinnedSourceFiles'>>>;
  /** Already configured with the service's trusted central policy/ref/transport. */
  publishingResolver: Pick<AuthoritativePublishingResolver, 'resolve'>;
  /** Whole operation, including storage, token mint, policy refresh and body reads. */
  timeoutMs?: number;
}

export interface TrustedHistoryAncestryInput {
  prior?: PriorReviewRecord;
  /** Worker hint is comparison input only; service re-reads and verifies the exact comparison. */
  hint?: ReviewHeadAncestryReceipt;
  /** Source IDs/heads rederived from the authenticated captured history before any provider comparison. */
  originRequestsByFingerprint?: Readonly<Record<string, readonly GroundedContinuityOriginRef[]>>;
  /** Untrusted names only; importer bytes and candidate states are re-read at exact pins. */
  sourceResolutionProbeManifest?: readonly GroundedImportResolutionSourceV1[];
}

const originRequestSchema = z.object({ sourceEventId: z.string().uuid(), sourceKind: z.enum(['cause', 'repair']),
  priorRunId: z.string().regex(/^run_[a-f0-9]{32}$/u), priorHeadSha: reviewPolicySourceSchema.shape.sha,
  currentHeadSha: reviewPolicySourceSchema.shape.sha }).strict();

async function compareTrustedOriginAncestry(input: {
  reader: Partial<Pick<AuthoritativeReviewReader, 'commitComparison'>>;
  repository: ReviewRepositoryIdentity;
  currentHeadSha: string;
  requests: Readonly<Record<string, readonly GroundedContinuityOriginRef[]>> | undefined;
  signal: AbortSignal;
  deadline: number;
}): Promise<GroundedOriginAncestryV1[]> {
  if (!input.requests || !input.reader.commitComparison) return [];
  const bySourceId = new Map<string, GroundedContinuityOriginRef>();
  const conflictingSourceIds = new Set<string>();
  for (const [fingerprint, refs] of Object.entries(input.requests)) {
    if (!/^fp1_[a-f0-9]{24}$/u.test(fingerprint) || !Array.isArray(refs) || refs.length > 2) continue;
    for (const raw of refs) {
      const parsed = originRequestSchema.safeParse(raw);
      if (!parsed.success || parsed.data.currentHeadSha !== input.currentHeadSha) continue;
      const existing = bySourceId.get(parsed.data.sourceEventId);
      if (existing && canonicalJson(existing) !== canonicalJson(parsed.data)) conflictingSourceIds.add(parsed.data.sourceEventId);
      else bySourceId.set(parsed.data.sourceEventId, parsed.data);
    }
  }
  for (const sourceEventId of conflictingSourceIds) bySourceId.delete(sourceEventId);
  const requests = [...bySourceId.values()].sort((left, right) => left.sourceKind < right.sourceKind ? -1
    : left.sourceKind > right.sourceKind ? 1 : left.sourceEventId.localeCompare(right.sourceEventId));
  const comparisonKeys = [...new Set(requests.map((row) => `${row.priorRunId}\u0000${row.priorHeadSha}`))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const selectedComparisonKeys = new Set(comparisonKeys.slice(0, MAX_GROUNDED_ORIGIN_ANCESTRY_COMPARISONS));
  const comparisons = new Map<string, Awaited<ReturnType<NonNullable<AuthoritativeReviewReader['commitComparison']>>> | null>();
  const originBudgetMs = Math.min(2_000, Math.max(0, input.deadline - performance.now() - 500));
  const originAbort = new AbortController();
  const relayAbort = () => originAbort.abort();
  if (input.signal.aborted) originAbort.abort();
  else input.signal.addEventListener('abort', relayAbort, { once: true });
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let stopResolve: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { stopResolve = resolve; });
  if (originBudgetMs > 0) stopTimer = setTimeout(() => { originAbort.abort(); stopResolve?.(); }, originBudgetMs);
  try {
    const selectedKeys = [...selectedComparisonKeys];
    for (let offset = 0; offset < selectedKeys.length && !originAbort.signal.aborted; offset += 18) {
      const batch = selectedKeys.slice(offset, offset + 18);
      const reads = Promise.all(batch.map(async (key) => {
        const [, priorHeadSha] = key.split('\u0000');
        try {
          const comparison = await input.reader.commitComparison!({ ...input.repository }, priorHeadSha!,
            input.currentHeadSha, originAbort.signal);
          return [key, comparison] as const;
        } catch { return [key, null] as const; }
      }));
      const result = await Promise.race([reads, stopped.then(() => null)]);
      if (!result) break;
      for (const [key, comparison] of result) comparisons.set(key, comparison);
    }
  } finally {
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    input.signal.removeEventListener('abort', relayAbort);
    originAbort.abort();
  }
  return requests.map((request) => {
    const key = `${request.priorRunId}\u0000${request.priorHeadSha}`;
    const comparison = comparisons.get(key) ?? null;
    const reason = !selectedComparisonKeys.has(key) ? 'origin-comparison-budget-exceeded'
      : originBudgetMs <= 0 || !comparisons.has(key) ? 'origin-comparison-unavailable' : undefined;
    return groundedOriginAncestryFromComparison(request, comparison, reason);
  });
}

function sourceProbeKey(repository: string, revisionSha: string, path: string): string {
  return `${repository}\u0000${revisionSha}\u0000${path}`;
}

/**
 * Rebuilds the worker's bounded import-resolution observations from the exact pinned importer
 * source. Manifest state/digests are never used as authority: they only identify claimed refs,
 * which this function parses, resolves and reads through the authenticated repository reader.
 */
async function readTrustedImportResolutionSources(input: {
  reader: Pick<AuthoritativeReviewReader, 'readPinnedSourceFiles'>;
  repository: ReviewRepositoryIdentity;
  baseSha: string;
  headSha: string;
  manifest: readonly GroundedImportResolutionSourceV1[];
  signal: AbortSignal;
}): Promise<TrustedGroundedImportResolutionSourceV1[]> {
  if (input.manifest.length === 0) return [];
  const repository = `${input.repository.owner}/${input.repository.repo}`;
  const baseByHead = { base: input.baseSha, head: input.headSha } as const;
  const lexical = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const referenceByKey = new Map<string, GroundedImportResolutionSourceV1['resolutionRefs'][number]>();
  const importerQueries = new Map<string, { revisionSha: string; path: string }>();
  for (const source of input.manifest) {
    if (source.repository !== repository || source.revisionSha !== input.baseSha && source.revisionSha !== input.headSha) return [];
    for (const reference of source.resolutionRefs) {
      const candidates = groundedRelativeImportCandidates(reference.importerPath, reference.importSpecifier);
      if (baseByHead[reference.importerSide] !== source.revisionSha || !candidates.includes(source.path)) return [];
      const key = JSON.stringify(reference);
      referenceByKey.set(key, reference);
      const importerKey = sourceProbeKey(repository, source.revisionSha, reference.importerPath);
      importerQueries.set(importerKey, { revisionSha: source.revisionSha, path: reference.importerPath });
    }
  }
  if (referenceByKey.size === 0 || importerQueries.size > MAX_GROUNDED_IMPORT_SOURCE_PROBES) return [];
  let importers;
  try {
    importers = await input.reader.readPinnedSourceFiles({ ...input.repository, baseSha: input.baseSha,
      headSha: input.headSha, probes: [...importerQueries.values()] }, input.signal);
  } catch { return []; }
  const importerByKey = new Map(importers.map((row) => [sourceProbeKey(row.repository, row.revisionSha, row.path), row] as const));
  const validReferences = new Map<string, { reference: GroundedImportResolutionSourceV1['resolutionRefs'][number];
    revisionSha: string }>();
  let everyReferenceValidated = true;
  for (const [key, reference] of referenceByKey) {
    const revisionSha = baseByHead[reference.importerSide];
    const importer = importerByKey.get(sourceProbeKey(repository, revisionSha, reference.importerPath));
    if (!importer || importer.presence !== 'present' || typeof importer.content !== 'string'
      || importer.sourceDigest !== reference.importerFullContentSha256
      || sha256(importer.content) !== reference.importerFullContentSha256) {
      everyReferenceValidated = false;
      continue;
    }
    const parsed = parseGroundedRelativeImports(importer.content, reference.importerPath);
    if (!parsed.complete || !parsed.declarations.some((declaration) => declaration.specifier === reference.importSpecifier
      && declaration.startLine === reference.importerStatementStartLine
      && declaration.endLine === reference.importerStatementEndLine
      && declaration.statementDigest === reference.importStatementDigest)) {
      everyReferenceValidated = false;
      continue;
    }
    if (groundedRelativeImportCandidates(reference.importerPath, reference.importSpecifier).length === 0) {
      everyReferenceValidated = false;
      continue;
    }
    validReferences.set(key, { reference, revisionSha });
  }
  if (!everyReferenceValidated || validReferences.size === 0) return [];
  const candidateQueries = new Map<string, { revisionSha: string; path: string }>();
  for (const { reference, revisionSha } of validReferences.values()) {
    for (const path of groundedRelativeImportCandidates(reference.importerPath, reference.importSpecifier)) {
      const key = sourceProbeKey(repository, revisionSha, path);
      candidateQueries.set(key, { revisionSha, path });
    }
  }
  if (importerQueries.size + candidateQueries.size > MAX_GROUNDED_IMPORT_SOURCE_PROBES) return [];
  let candidates;
  try {
    candidates = await input.reader.readPinnedSourceFiles({ ...input.repository, baseSha: input.baseSha,
      headSha: input.headSha, probes: [...candidateQueries.values()] }, input.signal);
  } catch { return []; }
  return candidates.map(({ repository: sourceRepository, revisionSha, path, presence, sourceDigest }) => ({
    repository: sourceRepository, revisionSha, path, presence, sourceDigest,
  })).sort((left, right) => lexical(left.repository, right.repository)
    || lexical(left.revisionSha, right.revisionSha) || lexical(left.path, right.path));
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

/** Preserve only fixed, service-owned failure classes at the redaction boundary. */
function reasonOf(error: unknown): TrustedCompletionResolutionReason {
  if (error instanceof ClassifiedCompletionError) return error.reason;
  if (error instanceof TransientAuthoritativeReadError) {
    switch (error.kind) {
      case 'network': return 'reader-network-unavailable';
      case 'deadline': return 'deadline';
      case 'retryable_server': return 'reader-server-unavailable';
      case 'rate_limit': return 'reader-rate-limited';
    }
  }
  if (error instanceof InternalGitHubDependencyUnavailableError) return 'reader-app-unavailable';
  return 'unknown';
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
    verdictCache?: VerdictCacheVerificationInput, historyAncestry?: TrustedHistoryAncestryInput) => Promise<TrustedGateCompletionContext> {
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

  return async (gate, incremental, verdictCache, historyAncestry): Promise<TrustedGateCompletionContext> => {
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
      const changedIdentity = { repository: `${requested.owner}/${requested.repo}`,
        baseSha: requested.baseSha, headSha: requested.headSha };
      const { files, unreadable } = source.changedFiles === undefined
        ? parseChangedFiles(source.diff, changedIdentity)
        : { files: bindChangedFileSourcePresence(source.changedFiles, changedIdentity), unreadable: [] };
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
        {
          pathFilters: stored.config.path_filters,
          maxReviewedLockfilePatchChars: stored.config.max_reviewed_lockfile_patch_chars,
        },
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
      let incrementalDeltaFiles: IncrementalDeltaFile[] | undefined;
      if (incremental) {
        substage = 'exact-diff';
        const compare = reader.commitComparison?.bind(reader);
        const detailed = reader.commitComparisonDetailed?.bind(reader);
        const verification = compare ? (await step(() => verifyIncrementalClaim({
          claim: incremental.claim, prior: incremental.prior, maxAgeMs: incremental.maxAgeMs,
          ...(incremental.maxChain !== undefined ? { maxChain: incremental.maxChain } : {}),
          current: { runId: incremental.run.runId, repositoryId: requested.repositoryId, prNumber: requested.prNumber,
            headSha: requested.headSha, baseSha: requested.baseSha, policyDigest,
            configDigest: incremental.run.configDigest, executionAttempt: incremental.run.executionAttempt },
          currentPaths: files.map((file) => file.path),
          reader: {
            compare: (base, head, signal) => compare({ ...repository }, base, head, signal ?? abort.signal),
            // A delta claim needs the service's own patches; without the detailed read it cannot verify.
            ...(detailed ? { compareDetailed: (base: string, head: string, signal?: AbortSignal) =>
              detailed({ ...repository }, base, head, signal ?? abort.signal) } : {}),
          },
          signal: abort.signal,
        }))) : undefined;
        incrementalVerified = verification ? verification.verified : false;
        if (verification?.verified && verification.deltaFiles?.length) incrementalDeltaFiles = verification.deltaFiles;
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
      // ADR 0002: the bot's finding threads, so the Gate applies the same required-finding
      // convergence as the raw check. A failed read is not an outage: it leaves no P2 resolved,
      // which can only make the Gate stricter.
      let findingThreads: Awaited<ReturnType<NonNullable<typeof reader.findingThreads>>> | undefined;
      if (reader.findingThreads) {
        try { findingThreads = await step(() => reader.findingThreads!({ ...target }, abort.signal)); }
        catch { checkDeadline(); findingThreads = undefined; }
      }
      let historyAncestryVerified = false;
      let trustedHistoryAncestry: ReviewHeadAncestryReceipt | undefined;
      const compare = reader.commitComparison?.bind(reader);
      const priorLineage = historyAncestry?.prior;
      if (compare && priorLineage && priorLineage.runId !== gate.coordinates.runId
        && priorLineage.repositoryId === requested.repositoryId && priorLineage.prNumber === requested.prNumber
        && /^[a-f0-9]{40}$/u.test(priorLineage.headSha)) {
        try {
          substage = 'exact-diff';
          const comparison = await step(() => compare({ ...repository }, priorLineage.headSha, requested.headSha, abort.signal));
          const comparisonDigest = sha256(canonicalJson({ priorHeadSha: priorLineage.headSha,
            currentHeadSha: requested.headSha, comparison }));
          const ancestryResult = comparison.files.length < 300
            ? comparison.status === 'ahead' || comparison.status === 'identical' ? 'ancestor' as const : 'not-ancestor' as const
            : 'unavailable' as const;
          trustedHistoryAncestry = { version: 'ReviewHeadAncestry.v1', result: ancestryResult,
            priorRunId: priorLineage.runId, priorHeadSha: priorLineage.headSha,
            currentHeadSha: requested.headSha, comparisonDigest };
          const hint = historyAncestry.hint;
          historyAncestryVerified = ancestryResult === 'ancestor'
            && (!hint || (hint.version === 'ReviewHeadAncestry.v1' && hint.result === 'ancestor'
              && hint.priorRunId === priorLineage.runId && hint.priorHeadSha === priorLineage.headSha
              && hint.currentHeadSha === requested.headSha && hint.comparisonDigest === comparisonDigest));
        } catch {
          checkDeadline();
          historyAncestryVerified = false;
        }
      }
      const resolutionManifest = historyAncestry?.sourceResolutionProbeManifest;
      const expectedImportResolutionSources = resolutionManifest === undefined ? undefined
        : reader.readPinnedSourceFiles ? await step(() => readTrustedImportResolutionSources({
          reader: { readPinnedSourceFiles: reader.readPinnedSourceFiles!.bind(reader) }, repository,
          baseSha: requested.baseSha, headSha: requested.headSha, manifest: resolutionManifest, signal: abort.signal,
        })) : [];
      checkDeadline();
      // `severity_policy` is projected and digest-bound by the prepared-config path. Read it only
      // after `checkedPrepared` verified that source; a worker payload or environment field cannot
      // opt itself into the new convergence semantics.
      const reviewDecisionPolicy = (stored.config as unknown as { severity_policy?: unknown }).severity_policy
        === REVIEW_SEVERITY_POLICY_V2 ? REVIEW_SEVERITY_POLICY_V2 : undefined;
      const primaryGroundedVerifierModel = stored.config.review_engine === 'composed'
        ? stored.config.reviewers.providers.find((provider) => provider.id === resolveComposedProviderId(stored.config)
          && provider.enabled)?.model
        : stored.transport.model;
      if (!primaryGroundedVerifierModel) throw unavailable();
      const originAncestry = await compareTrustedOriginAncestry({ reader, repository,
        currentHeadSha: requested.headSha, requests: historyAncestry?.originRequestsByFingerprint,
        signal: abort.signal, deadline });
      return { current: { ...final, policyDigest }, historyAncestryVerified,
        ...(trustedHistoryAncestry ? { historyAncestry: trustedHistoryAncestry } : {}),
        ...(originAncestry.length > 0 ? { originAncestry } : {}), coverage: {
        expectedPersonaIds, changedFiles: files,
        ...(reviewDecisionPolicy ? { reviewDecisionPolicy } : {}),
        groundedVerifierRouting: { primaryModel: primaryGroundedVerifierModel },
        ...(findingThreads ? { findingThreads } : {}),
        ...(expectedImportResolutionSources === undefined ? {} : { expectedImportResolutionSources }),
        ...(stored.config.review_engine === 'composed' ? {
          reviewEngine: 'composed' as const,
          composedChangedPaths: applicability.effectiveFiles.map((file) => file.path),
          composedMaxTasks: resolveComposedMaxTasks(stored.config.composed?.max_tasks),
        } : {}),
        // REL-1092: the same decision the worker's coverage reads. An analyzable
        // file whose changed text no lane could see is never counted as reviewed.
        coverageComplete: coverageComplete && applicability.omittedSourcePaths.length === 0,
        // This establishes a nonempty required-lane contract, not completed
        // worker quorum. Derivation separately requires ALL these exact IDs.
        quorumSatisfied: expectedPersonaIds.length > 0,
        ...(incrementalVerified === undefined ? {} : { incrementalVerified }),
        ...(incrementalDeltaFiles ? { incrementalDeltaFiles } : {}),
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
      },
      ...(reader.trustedConventionAdjudications ? { readTrustedConventionAdjudications: (input) =>
        reader.trustedConventionAdjudications!({ repositoryId: requested.repositoryId,
          owner: requested.owner, repo: requested.repo, prNumber: requested.prNumber,
          headSha: requested.headSha, ...input }) } : {}) };
    };
    try { return await Promise.race([resolve(), expired]); }
    catch (error) {
      throw new TrustedCompletionResolutionError(substage, reasonOf(error));
    }
    finally { if (timer !== undefined) clearTimeout(timer); abort.abort(); }
  };
}
