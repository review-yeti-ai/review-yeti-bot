/**
 * Per-file verdict cache (REL-1085; plan
 * `docs/superpowers/specs/2026-09-23-review-content-shrinking-and-jev-triage.md`,
 * section 4 W8). Behind `REVIEW_YETI_VERDICT_CACHE`, default off.
 *
 * W7 (`incrementalReview`) carries forward files unchanged since the previous
 * reviewed head, and needs that head to be an ancestor. This cache is keyed by
 * content instead: a file whose exact content, exact view and lane keys match a
 * clean lane result stored with the pull request's latest review is not sent
 * again, even after a force-push, a rebase or a base move.
 *
 * Keys:
 *
 * - Content key, per file: repository id, path, previous path, status, the
 *   head blob SHA and the SHA-256 of the exact merge-base patch, all from
 *   GitHub's compare API at exact SHAs (`contentKeyOf`). Blob plus complete
 *   patch pins both the head and the merge-base content, so any content change
 *   is a different key. A file GitHub gives no complete patch for has no key and
 *   is never cached. The repository id scopes every key to one repository.
 * - View digest, per file: SHA-256 of the patch text the lanes received, after
 *   diff shrinking (W2). A different shrink outcome is a different view.
 * - Lane key, per persona: persona id, prompt digest (the effective charter and
 *   any dashboard override), configured models, policy digest, config digest,
 *   review engine, worker version and the view-changing flags
 *   (`verdictCacheLaneKeys`).
 * - Routing: the lanes the shared applicability decision routes the file to
 *   must all have reviewed it in the source, each under an equal lane key.
 *
 * Safety (plan section 3):
 *
 * - One decision. `decideVerdictCache` is the only function that decides which
 *   stored entries may be served. The worker calls it to plan; the trusted
 *   completion side calls it again from the service's own record and its own
 *   GitHub reads, then checks routing with the same `verdictCacheLanesPermit`
 *   the engines use (`verifyVerdictCacheClaim`). A completion that served a hit
 *   the decision does not permit is refused.
 * - Applicability first. Engines apply the scope strictly after the shared
 *   applicability decision, shrinking and the incremental scope, and replace
 *   only patch text (`resolveCachedReviewApplicability`).
 * - Only clean results are cached. An entry is recorded only when no lane
 *   reported any finding on the file, every routed lane completed, and no
 *   routed lane reported a cross-file finding (an architectural finding, or one
 *   on a path outside the diff). Findings themselves are never cached.
 * - Storage is the existing completion record (`review_worker_completions`);
 *   there is no new table. The source is always the service's own selection of
 *   the pull request's latest stored completion (`selectPriorReviewRows`, shared
 *   with W7), never a record the worker names on its own.
 * - Full-review fallbacks: flag off, a retry attempt, no or unusable source,
 *   same head, source not SHIP-complete, policy or config changed, source too
 *   old, a comparison that may be incomplete, and any error. Each is the review
 *   that runs today.
 * - Disclosure. The check summary lists every cached file and why nothing was
 *   cached when nothing was (`renderVerdictCacheSummary`).
 */
import { z } from 'zod';
import type {
  VerdictCacheDisclosure,
  VerdictCacheEntry,
  VerdictCacheScope,
  VerdictCacheSourceIdentity,
} from '../types/verdictCache';
import type { IncrementalReviewScope } from '../types/incrementalReview';
import type { DiffShrinkInput } from '../types/diffShrink';
import {
  incrementalMaxAgeMsFrom,
  incrementalPrecheck,
  INCREMENTAL_MAX_AGE_ENV,
  priorReviewRecordFromRows,
  priorReviewRecordSchema,
  resolveScopedReviewApplicability,
  type IncrementalCurrentIdentity,
  type IncrementalFallbackReason,
  type PriorReviewRecord,
  type PriorReviewRows,
} from './incrementalReview';
import { isRegularFileMode } from './lockfileChangeVerification';
import { isSubmoduleEntry, personaCoversFile, type EffectiveReviewFile, type ReviewApplicabilityInputFile } from './personaApplicability';
import { sha256 } from './reviewCore';
import {
  MAX_VERDICT_CACHE_ENTRIES,
  MAX_VERDICT_CACHE_PATH_CHARACTERS,
  VERDICT_CACHE_CLAIM_VERSION,
  verdictCacheClaimSchema,
  verdictCacheEntrySchema,
  type VerdictCacheClaim,
} from './verdictCacheClaim';

export type {
  VerdictCacheDisclosure,
  VerdictCacheEntry,
  VerdictCacheScope,
  VerdictCacheSourceIdentity,
} from '../types/verdictCache';

export const VERDICT_CACHE_FLAG = 'REVIEW_YETI_VERDICT_CACHE';
/** Service-side: the oldest stored review a cache hit may rest on. */
export const VERDICT_CACHE_MAX_AGE_ENV = 'REVIEW_YETI_VERDICT_CACHE_MAX_AGE_HOURS';
/** GitHub's compare API lists at most 300 files; a list that long may be cut. */
const MAX_COMPARISON_LISTED_FILES = 300;
const NOTE_PREFIX = '\\ Review Yeti:';

/**
 * `REVIEW_YETI_VERDICT_CACHE`: unset, empty, `0`, `false` or `off` is off (the
 * default); `1`, `true`, `on` or `all` is on for every repository; anything
 * else is a comma- or space-separated list of `owner/repo` names it is on for
 * (case-insensitive). Same grammar as `REVIEW_YETI_INCREMENTAL`.
 */
export function verdictCacheEnabledFor(env: Readonly<Record<string, string | undefined>>, repository: string): boolean {
  const raw = String(env[VERDICT_CACHE_FLAG] ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'all') return true;
  const target = String(repository || '').trim().toLowerCase();
  return target.length > 0 && raw.split(/[\s,]+/u).some((entry) => entry === target);
}

/** Whole hours, 1 to 720. Unset or invalid is the 72-hour default (same grammar as W7's age). */
export function verdictCacheMaxAgeMsFrom(env: Readonly<Record<string, string | undefined>>): number {
  return incrementalMaxAgeMsFrom({ [INCREMENTAL_MAX_AGE_ENV]: env[VERDICT_CACHE_MAX_AGE_ENV] });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** One file of a GitHub comparison (`AuthoritativeReviewReader.comparisonContent`). */
export interface ComparisonContentFile {
  path: string;
  previousPath?: string;
  status: string;
  blobSha: string;
  /** Present only when GitHub returned a complete, closed-hunk patch. */
  patch?: string;
}

/** `GET /repos/{owner}/{repo}/compare/{base}...{head}` with per-file content evidence, bound to exact SHAs. */
export interface ComparisonContentReader {
  content(baseSha: string, headSha: string, signal?: AbortSignal): Promise<{ files: ComparisonContentFile[] }>;
}

/**
 * The repository-scoped content key of one compared file, or null when GitHub
 * gave no complete patch. The head blob and the complete merge-base patch
 * together determine both sides of the change.
 */
export function contentKeyOf(repositoryId: number, file: ComparisonContentFile): string | null {
  if (typeof file.patch !== 'string' || file.patch.length === 0 || !/^[a-f0-9]{40}$/u.test(file.blobSha)) return null;
  return sha256({
    version: 'VerdictCacheContent.v1',
    repositoryId,
    path: file.path,
    previousPath: file.previousPath ?? null,
    status: file.status,
    blobSha: file.blobSha,
    patchSha256: sha256(file.patch),
  });
}

/** Content keys by path, or null when the comparison may be incomplete. */
export function contentIndexOf(repositoryId: number, files: readonly ComparisonContentFile[]): Map<string, string> | null {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || files.length >= MAX_COMPARISON_LISTED_FILES) return null;
  const index = new Map<string, string>();
  const seen = new Set<string>();
  for (const file of files) {
    // A path listed twice is ambiguous: neither copy is keyed.
    if (seen.has(file.path)) { index.delete(file.path); continue; }
    seen.add(file.path);
    const key = contentKeyOf(repositoryId, file);
    if (key) index.set(file.path, key);
  }
  return index;
}

/** The digest of the exact patch text the lanes receive for one file. */
export function viewDigestOf(patch: string): string {
  return sha256({ version: 'VerdictCacheView.v1', patch });
}

export interface VerdictCacheLaneKeyInput {
  personas: ReadonlyArray<{ id: string; enabled?: boolean; providers?: readonly string[] }>;
  providers: ReadonlyArray<{ id: string; model?: string }>;
  /** Everything that decides a lane's prompt: the effective charter and any override (`personaLaneViewIdentity`). */
  promptOf: (persona: { id: string }) => unknown;
  policyDigest: string;
  configDigest: string;
  engine: string;
  workerVersion: string;
  /** View-changing settings for this run, e.g. whether diff shrinking is on. */
  viewFlags: Readonly<Record<string, string | boolean>>;
}

/** One key per enabled persona. Any change to any input is a different key. */
export function verdictCacheLaneKeys(input: VerdictCacheLaneKeyInput): Record<string, string> {
  const models = new Map(input.providers.map((provider) => [provider.id, provider.model ?? null]));
  const keys: Record<string, string> = {};
  for (const persona of input.personas) {
    if (persona.enabled === false || !/^[a-z][a-z0-9_-]{0,127}$/u.test(persona.id)) continue;
    keys[persona.id] = sha256({
      version: 'VerdictCacheLane.v1',
      persona: persona.id,
      promptDigest: sha256({ prompt: input.promptOf(persona) ?? null }),
      models: (persona.providers ?? []).map((id) => ({ id, model: models.get(id) ?? null })),
      policyDigest: input.policyDigest,
      configDigest: input.configDigest,
      engine: input.engine,
      workerVersion: input.workerVersion,
      viewFlags: input.viewFlags,
    });
  }
  return keys;
}

/**
 * THE routing check, shared by the engines and the trusted verification: every
 * lane the current decision routes the file to reviewed it in the source, and
 * each such lane's key is unchanged. A file routed to no lane is never cached.
 */
export function verdictCacheLanesPermit(
  entryLanes: readonly string[],
  routedLanes: readonly string[],
  laneKeys: Readonly<Record<string, string>>,
  sourceLaneKeys: Readonly<Record<string, string>>,
): boolean {
  if (routedLanes.length === 0) return false;
  const reviewed = new Set(entryLanes);
  return routedLanes.every((lane) => reviewed.has(lane)
    && Object.prototype.hasOwnProperty.call(laneKeys, lane)
    && Object.prototype.hasOwnProperty.call(sourceLaneKeys, lane)
    && typeof laneKeys[lane] === 'string' && laneKeys[lane] === sourceLaneKeys[lane]);
}

// ---------------------------------------------------------------------------
// Source record
// ---------------------------------------------------------------------------

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * The service's view of the stored record a hit may rest on, derived only by
 * `verdictCacheSourceFromRows` from its own rows. The worker receives it as a
 * planning hint; the trusted completion side derives it again.
 */
export const verdictCacheSourceSchema = z.object({
  prior: priorReviewRecordSchema,
  laneKeys: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u), digest),
  entries: z.array(verdictCacheEntrySchema).max(MAX_VERDICT_CACHE_ENTRIES),
  /** Gating (non-shadow) lanes the source result lists without an error. */
  lanes: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u)).max(64),
}).strict();

export type VerdictCacheSource = z.infer<typeof verdictCacheSourceSchema>;

/**
 * The source for a run, from the same rows W7's `priorReviewRecordFromRows`
 * verifies (content digest recomputed, run binding checked). Null for anything
 * malformed, and for a record that carries no cache entries.
 */
export function verdictCacheSourceFromRows(rows: PriorReviewRows): VerdictCacheSource | null {
  const prior = priorReviewRecordFromRows(rows);
  if (!prior) return null;
  try {
    const raw = typeof rows.completion.payload === 'string' ? JSON.parse(rows.completion.payload) : rows.completion.payload;
    const result = (raw as { result?: { verdictCache?: unknown; personas?: unknown } } | null)?.result;
    if (!result || result.verdictCache === undefined) return null;
    // The payload already parsed as a whole in `priorReviewRecordFromRows`; parse this part again for its type.
    const claim = verdictCacheClaimSchema.parse(result.verdictCache);
    const personas = Array.isArray(result.personas) ? result.personas as Array<Record<string, unknown>> : [];
    const lanes = personas
      .filter((persona) => persona.evidenceSource !== 'shadow' && persona.decision !== 'ERROR'
        && persona.status !== 'ERROR' && persona.errorClass === undefined && typeof persona.id === 'string')
      .map((persona) => String(persona.id));
    return verdictCacheSourceSchema.parse({
      prior,
      laneKeys: claim.laneKeys,
      entries: claim.entries,
      lanes: [...new Set(lanes)].sort(),
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The one decision
// ---------------------------------------------------------------------------

export type VerdictCacheFallbackReason =
  | IncrementalFallbackReason
  | 'flag-off'
  | 'no-cache-entries'
  | 'nothing-cached';

export type VerdictCacheDecision =
  | { mode: 'full'; reason: VerdictCacheFallbackReason }
  | { mode: 'cache'; source: VerdictCacheSourceIdentity; permitted: VerdictCacheEntry[] };

function fullCache(reason: VerdictCacheFallbackReason): VerdictCacheDecision {
  return { mode: 'full', reason };
}

/** The checks that need no GitHub read (W7's precheck on the same record). Null means "compare next". */
export function verdictCachePrecheck(input: {
  source: VerdictCacheSource | null;
  maxAgeMs: number;
  current: IncrementalCurrentIdentity;
}): VerdictCacheDecision | null {
  const early = incrementalPrecheck({ prior: input.source?.prior ?? null, maxAgeMs: input.maxAgeMs, current: input.current });
  if (early) return fullCache(early.mode === 'full' ? early.reason : 'error');
  if (input.source!.entries.length === 0) return fullCache('no-cache-entries');
  return null;
}

/**
 * THE decision. Pure and deterministic over exact SHAs: the worker and the
 * trusted completion side reach the same answer from the same inputs.
 *
 * A stored entry may be served only when ALL hold:
 * - the source passes the precheck (same repository and pull request, first
 *   attempt, different head, SHIP-complete, same policy and config, not too old);
 * - the entry's content key equals the key GitHub gives for that path both at
 *   the source's exact SHAs and at the current exact SHAs;
 * - the source reported no finding on the path, from any lane;
 * - every lane the entry lists completed in the source and has a source lane key.
 *
 * Routing and lane keys are checked per file where the lanes are known, with
 * `verdictCacheLanesPermit`.
 */
export function decideVerdictCache(input: {
  source: VerdictCacheSource | null;
  maxAgeMs: number;
  current: IncrementalCurrentIdentity;
  currentContent: ReadonlyMap<string, string> | null;
  sourceContent: ReadonlyMap<string, string> | null;
}): VerdictCacheDecision {
  const early = verdictCachePrecheck(input);
  if (early) return early;
  const source = input.source!;
  if (!input.currentContent || !input.sourceContent) return fullCache('comparison-incomplete');
  const findings = new Set(source.prior.findingPaths);
  const lanes = new Set(source.lanes);
  const permitted = source.entries.filter((entry) => {
    const current = input.currentContent!.get(entry.path);
    const stored = input.sourceContent!.get(entry.path);
    return current !== undefined && stored !== undefined && current === entry.contentKey && stored === entry.contentKey
      && !findings.has(entry.path)
      && entry.lanes.every((lane) => lanes.has(lane) && Object.prototype.hasOwnProperty.call(source.laneKeys, lane));
  }).map((entry) => ({ ...entry, lanes: [...entry.lanes].sort() }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (permitted.length === 0) return fullCache('nothing-cached');
  return {
    mode: 'cache',
    source: sourceIdentityOf(source.prior),
    permitted,
  };
}

function sourceIdentityOf(prior: PriorReviewRecord): VerdictCacheSourceIdentity {
  return {
    runId: prior.runId,
    executionAttempt: prior.executionAttempt,
    headSha: prior.headSha,
    baseSha: prior.baseSha,
    completionDigest: prior.completionDigest,
  };
}

/**
 * The reads `decideVerdictCache` needs, in a fixed order: this run's exact
 * comparison, then the source's. Both sides call this same function, so they
 * read the same immutable comparisons. Read failures propagate.
 */
export async function gatherVerdictCacheContent(
  reader: ComparisonContentReader,
  repositoryId: number,
  source: { headSha: string; baseSha: string },
  current: { headSha: string; baseSha: string },
  signal?: AbortSignal,
): Promise<{ currentContent: Map<string, string> | null; sourceContent: Map<string, string> | null }> {
  const currentContent = contentIndexOf(repositoryId, (await reader.content(current.baseSha, current.headSha, signal)).files);
  if (!currentContent) return { currentContent, sourceContent: null };
  const sourceContent = contentIndexOf(repositoryId, (await reader.content(source.baseSha, source.headSha, signal)).files);
  return { currentContent, sourceContent };
}

// ---------------------------------------------------------------------------
// Engine side: apply the scope after the shared applicability decision
// ---------------------------------------------------------------------------

function estimateTokens(files: readonly EffectiveReviewFile[]): number {
  return Math.ceil(files.reduce((chars, file) => chars + (file.patch?.length ?? 0) + (file.content?.length ?? 0), 0) / 4);
}

function cachedPatch(patch: string, source: VerdictCacheSourceIdentity): string {
  const header: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) break;
    header.push(line);
  }
  const head = header.length > 0 && header[header.length - 1] === '' ? header.slice(0, -1) : header;
  return `${[...head, `${NOTE_PREFIX} identical content reviewed clean in run ${source.runId}; `
    + 'verdict served from the verdict cache, content not sent'].join('\n')}\n`;
}

/** Lanes the shared decision routes one file to, sorted. */
export function routedLanesOf(
  applicable: ReadonlyArray<Parameters<typeof personaCoversFile>[0] & { id: string }>,
  file: Parameters<typeof personaCoversFile>[1],
): string[] {
  return applicable.filter((persona) => personaCoversFile(persona, file)).map((persona) => persona.id).sort();
}

function cacheableShape(file: EffectiveReviewFile): file is EffectiveReviewFile & { patch: string } {
  return !isSubmoduleEntry(file) && isRegularFileMode(file.mode) && typeof file.patch === 'string' && file.patch.length > 0
    && file.content === undefined && file.path.length <= MAX_VERDICT_CACHE_PATH_CHARACTERS;
}

/**
 * Replace the patch of every permitted file with a one-line note, and report
 * every file the lanes still receive in full. A file is served from cache only
 * when its exact view and its routing match the entry. Files the incremental
 * scope already carried forward, truncated files, gitlinks, symlinks and mode
 * changes are never cached. If serving the cache would leave nothing to review
 * in full, nothing is served.
 */
export function applyVerdictCacheScope(
  files: readonly EffectiveReviewFile[],
  applicable: ReadonlyArray<Parameters<typeof personaCoversFile>[0] & { id: string }>,
  scope: VerdictCacheScope | undefined,
  options: { skipPaths?: ReadonlySet<string>; truncatedPaths?: ReadonlySet<string> } = {},
): { files: EffectiveReviewFile[]; disclosure: VerdictCacheDisclosure | null } {
  if (!scope || applicable.length === 0) return { files: [...files], disclosure: null };
  const permitted = new Map(scope.permitted.map((entry) => [entry.path, entry]));
  const skip = options.skipPaths ?? new Set<string>();
  const truncated = options.truncatedPaths ?? new Set<string>();
  const cached: Array<{ path: string; lanes: string[] }> = [];
  const views: VerdictCacheDisclosure['views'] = [];
  const reviewed: string[] = [];
  const plan = files.map((file) => {
    if (skip.has(file.path)) return { file, action: 'skip' as const };
    const lanes = routedLanesOf(applicable, file);
    const shaped = cacheableShape(file) && !truncated.has(file.path) && lanes.length > 0;
    const entry = shaped && scope.source ? permitted.get(file.path) : undefined;
    const viewDigest = shaped ? viewDigestOf(file.patch as string) : undefined;
    if (entry && viewDigest === entry.viewDigest
      && verdictCacheLanesPermit(entry.lanes, lanes, scope.laneKeys, scope.sourceLaneKeys)) {
      return { file, action: 'cache' as const, lanes };
    }
    return { file, action: 'review' as const, lanes, viewDigest };
  });
  // Nothing left to review in full: serve nothing, so a run never reviews only notes.
  const serve = plan.some((item) => item.action === 'review');
  const out = plan.map((item) => {
    if (item.action === 'cache' && serve) {
      cached.push({ path: item.file.path, lanes: item.lanes });
      return { ...item.file, patch: cachedPatch(item.file.patch as string, scope.source!) };
    }
    if (item.action !== 'skip') {
      reviewed.push(item.file.path);
      const viewDigest = item.action === 'review' ? item.viewDigest
        : cacheableShape(item.file) ? viewDigestOf(item.file.patch as string) : undefined;
      if (viewDigest) views.push({ path: item.file.path, viewDigest, lanes: item.lanes });
    }
    return item.file;
  });
  return {
    files: out,
    disclosure: {
      source: cached.length > 0 ? { ...scope.source! } : null,
      cached: cached.sort((left, right) => (left.path < right.path ? -1 : 1)),
      reviewedPaths: reviewed.sort(),
      views: views.sort((left, right) => (left.path < right.path ? -1 : 1)),
      estimatedTokensBefore: estimateTokens(files),
      estimatedTokensAfter: estimateTokens(out),
    },
  };
}

/**
 * The shared applicability decision, then diff shrinking, then the incremental
 * scope, then the verdict cache, for every engine. Applicability is decided on
 * the unshrunk, unscoped files by the same `resolveReviewApplicability` the
 * trusted completion side calls; every later step replaces only patch text.
 */
export function resolveCachedReviewApplicability<P extends Parameters<typeof resolveScopedReviewApplicability>[0][number]>(
  enabledPersonas: readonly P[],
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  options: { pathFilters?: readonly string[]; diffShrink?: DiffShrinkInput; incremental?: IncrementalReviewScope;
    verdictCache?: VerdictCacheScope } = {},
): ReturnType<typeof resolveScopedReviewApplicability<P>> & { verdictCache: VerdictCacheDisclosure | null } {
  const { verdictCache, ...scopedOptions } = options;
  const decision = resolveScopedReviewApplicability(enabledPersonas, changedFiles, scopedOptions);
  if (!verdictCache || decision.applicable.length === 0) return { ...decision, verdictCache: null };
  const { files, disclosure } = applyVerdictCacheScope(decision.effectiveFiles, decision.applicable, verdictCache, {
    skipPaths: new Set(decision.incremental?.carriedForwardPaths ?? []),
    truncatedPaths: new Set(decision.truncatedFiles.map((file) => file.path)),
  });
  return { ...decision, effectiveFiles: files, verdictCache: disclosure };
}

/** Attach the engine's own cache disclosure to its result. Unchanged when null. */
export function attachVerdictCacheDisclosure<T extends object>(
  result: T,
  disclosure: VerdictCacheDisclosure | null,
): T & { verdictCache?: VerdictCacheDisclosure } {
  return disclosure ? { ...result, verdictCache: disclosure } : result;
}

// ---------------------------------------------------------------------------
// Worker: the record this run stores
// ---------------------------------------------------------------------------

/** The panel's lane outcome, as `buildVerdictCacheRecord` reads it. */
export interface VerdictCacheLaneOutcome {
  id: string;
  decision?: string;
  notApplicable?: boolean;
  evidenceSource?: string;
  findings: ReadonlyArray<{ path?: unknown; isArchitectural?: unknown }>;
}

/**
 * The completion's `verdictCache` field: this run's clean per-file results for
 * later runs, and the hits it served. Undefined when there is nothing to say.
 *
 * A file is recorded only when no lane reported any finding on it, every lane
 * routed to it completed (not skipped by gating, not failed) and reported no
 * cross-file finding (architectural, or on a path outside the diff), and no
 * lane received it at reduced depth.
 */
export function buildVerdictCacheRecord(input: {
  disclosure: VerdictCacheDisclosure | null | undefined;
  scope: VerdictCacheScope | null | undefined;
  contentIndex: ReadonlyMap<string, string> | null | undefined;
  lanes: readonly VerdictCacheLaneOutcome[];
  failedLaneIds: readonly string[];
  changedPaths: readonly string[];
  /**
   * Paths some lane received at less than full depth after the cache step (W5's review budget:
   * truncated, signatures only, or not deeply reviewed). Such a file was not deeply reviewed, so
   * it is never recorded.
   */
  reducedDepthPaths?: readonly string[];
}): VerdictCacheClaim | undefined {
  const { disclosure, scope } = input;
  if (!disclosure || !scope) return undefined;
  const changed = new Set(input.changedPaths);
  const failed = new Set(input.failedLaneIds);
  const withFindings = new Set<string>();
  const clean = new Set<string>();
  for (const lane of input.lanes) {
    if (lane.evidenceSource === 'shadow') continue;
    for (const finding of lane.findings) if (typeof finding.path === 'string') withFindings.add(finding.path);
    const crossFile = lane.findings.some((finding) => finding.isArchitectural === true
      || typeof finding.path !== 'string' || !changed.has(finding.path));
    if (!lane.notApplicable && lane.decision !== 'ERROR' && !failed.has(lane.id) && !crossFile) clean.add(lane.id);
  }
  // A lane that appears twice (or also failed) is ambiguous: never clean.
  const counts = new Map<string, number>();
  for (const lane of input.lanes) if (lane.evidenceSource !== 'shadow') counts.set(lane.id, (counts.get(lane.id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) clean.delete(id);
  const reduced = new Set(input.reducedDepthPaths ?? []);
  const recordable = (path: string, lanes: readonly string[]) => lanes.length > 0 && !withFindings.has(path) && !reduced.has(path)
    && lanes.every((lane) => clean.has(lane)) && path.length <= MAX_VERDICT_CACHE_PATH_CHARACTERS;
  const entries: VerdictCacheEntry[] = [];
  const index = input.contentIndex;
  if (index) {
    for (const view of disclosure.views) {
      const contentKey = index.get(view.path);
      if (contentKey && recordable(view.path, view.lanes)) {
        entries.push({ path: view.path, contentKey, viewDigest: view.viewDigest, lanes: [...view.lanes] });
      }
    }
  }
  // A served hit is recorded again under the lanes routed to it now, so a later run can rest on it.
  const permitted = new Map(scope.permitted.map((entry) => [entry.path, entry]));
  for (const hit of disclosure.cached) {
    const entry = permitted.get(hit.path);
    if (entry && recordable(hit.path, hit.lanes)) {
      entries.push({ path: hit.path, contentKey: entry.contentKey, viewDigest: entry.viewDigest, lanes: [...hit.lanes] });
    }
  }
  const hits = disclosure.cached.length > 0 && disclosure.source ? {
    runId: disclosure.source.runId,
    executionAttempt: disclosure.source.executionAttempt,
    completionDigest: disclosure.source.completionDigest,
    paths: disclosure.cached.map((hit) => hit.path),
  } : undefined;
  if (!hits && entries.length === 0) return undefined;
  const laneKeys: Record<string, string> = {};
  const needed = new Set([...entries.flatMap((entry) => entry.lanes), ...disclosure.cached.flatMap((hit) => hit.lanes)]);
  for (const lane of [...needed].sort()) if (typeof scope.laneKeys[lane] === 'string') laneKeys[lane] = scope.laneKeys[lane];
  const record = {
    version: VERDICT_CACHE_CLAIM_VERSION,
    laneKeys,
    entries: entries.sort((left, right) => (left.path < right.path ? -1 : 1)).slice(0, MAX_VERDICT_CACHE_ENTRIES),
    ...(hits ? { hits } : {}),
  };
  const parsed = verdictCacheClaimSchema.safeParse(record);
  if (parsed.success) return parsed.data;
  // Never let the cache record fail a review: keep only what the claim needs.
  return hits ? verdictCacheClaimSchema.parse({ version: VERDICT_CACHE_CLAIM_VERSION, laneKeys, entries: [], hits }) : undefined;
}

// ---------------------------------------------------------------------------
// Trusted completion side
// ---------------------------------------------------------------------------

export interface VerdictCacheVerificationInput {
  claim: VerdictCacheClaim;
  /** The service's own source, from `selectVerdictCacheSource`; never the worker's copy. */
  source: VerdictCacheSource | null;
  maxAgeMs: number;
  /** The completing run's service-owned identity, beyond what the gate coordinates carry. */
  run: { runId: string; executionAttempt: number; configDigest: string };
}

/**
 * Re-run the one decision from the service's own source record and GitHub
 * reads, and accept the hits only when they name exactly that record and every
 * hit is an entry the decision permits whose lanes cover every lane the
 * service's own applicability decision routes that file to, under unchanged
 * lane keys. Serving fewer hits than permitted is allowed; serving more is not.
 * Read failures propagate so the caller can treat them as transient.
 */
export async function verifyVerdictCacheClaim(options: Omit<VerdictCacheVerificationInput, 'run'> & {
  current: IncrementalCurrentIdentity;
  /** Lanes the service's applicability decision routes each effective path to; undefined when the path is not reviewed. */
  routedLanes: (path: string) => string[] | undefined;
  reader: ComparisonContentReader;
  signal?: AbortSignal;
}): Promise<{ verified: boolean; reason: VerdictCacheFallbackReason | 'claim-mismatch' | 'verified' }> {
  const { claim, source } = options;
  const hits = claim.hits;
  if (!hits) return { verified: true, reason: 'verified' };
  if (!source) return { verified: false, reason: 'no-prior-review' };
  if (hits.runId !== source.prior.runId || hits.executionAttempt !== source.prior.executionAttempt
    || hits.completionDigest !== source.prior.completionDigest) return { verified: false, reason: 'claim-mismatch' };
  const early = verdictCachePrecheck({ source, maxAgeMs: options.maxAgeMs, current: options.current });
  if (early && early.mode === 'full') return { verified: false, reason: early.reason };
  const content = await gatherVerdictCacheContent(options.reader, options.current.repositoryId,
    source.prior, options.current, options.signal);
  const decision = decideVerdictCache({ source, maxAgeMs: options.maxAgeMs, current: options.current, ...content });
  if (decision.mode !== 'cache') return { verified: false, reason: decision.reason };
  const permitted = new Map(decision.permitted.map((entry) => [entry.path, entry]));
  for (const path of hits.paths) {
    const entry = permitted.get(path);
    const routed = options.routedLanes(path);
    if (!entry || !routed || !verdictCacheLanesPermit(entry.lanes, routed, claim.laneKeys, source.laneKeys)) {
      return { verified: false, reason: 'claim-mismatch' };
    }
  }
  return { verified: true, reason: 'verified' };
}

// ---------------------------------------------------------------------------
// Worker planning
// ---------------------------------------------------------------------------

/** Fetches the service's cache source for this run. */
export interface VerdictCacheBaseSource {
  read(signal?: AbortSignal): Promise<{ source: VerdictCacheSource | null; maxAgeMs: number }>;
}

export interface VerdictCachePlan {
  /** Handed to the engines; null means the cache neither serves nor records anything this run. */
  scope: VerdictCacheScope | null;
  decision: VerdictCacheDecision;
  /** This run's content keys, for the entries it records. */
  contentIndex: Map<string, string> | null;
}

const PLAN_TIMEOUT_MS = 15_000;

/**
 * Plan this run's cache use. Null when the flag is off for this repository.
 * Never throws: every failure is a full review (fail open to today's
 * behaviour). When this run's own comparison is readable, the scope is set
 * even without a usable source, so the run still records entries for later.
 */
export async function planVerdictCache(options: {
  env: Readonly<Record<string, string | undefined>>;
  repository: string;
  current: IncrementalCurrentIdentity;
  laneKeys: Record<string, string>;
  base?: VerdictCacheBaseSource;
  reader?: ComparisonContentReader;
  timeoutMs?: number;
}): Promise<VerdictCachePlan | null> {
  if (!verdictCacheEnabledFor(options.env, options.repository)) return null;
  const failed = (): VerdictCachePlan => ({ scope: null, decision: fullCache('error'), contentIndex: null });
  if (!options.reader) return failed();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const plan = async (): Promise<VerdictCachePlan> => {
    const { current } = options;
    const contentIndex = contentIndexOf(current.repositoryId,
      (await options.reader!.content(current.baseSha, current.headSha, abort.signal)).files);
    if (!contentIndex) return { scope: null, decision: fullCache('comparison-incomplete'), contentIndex: null };
    const recordOnly = (reason: VerdictCacheFallbackReason, sourceLaneKeys: Record<string, string> = {}): VerdictCachePlan => ({
      scope: { source: null, permitted: [], laneKeys: options.laneKeys, sourceLaneKeys }, decision: fullCache(reason), contentIndex,
    });
    let base: { source: VerdictCacheSource | null; maxAgeMs: number };
    try {
      if (!options.base) return recordOnly('error');
      base = await options.base.read(abort.signal);
    } catch {
      return recordOnly('error');
    }
    const early = verdictCachePrecheck({ source: base.source, maxAgeMs: base.maxAgeMs, current });
    if (early) return recordOnly(early.mode === 'full' ? early.reason : 'error');
    const source = base.source!;
    const sourceContent = contentIndexOf(current.repositoryId,
      (await options.reader!.content(source.prior.baseSha, source.prior.headSha, abort.signal)).files);
    const decision = decideVerdictCache({ source, maxAgeMs: base.maxAgeMs, current, currentContent: contentIndex, sourceContent });
    if (decision.mode !== 'cache') return recordOnly(decision.reason);
    return {
      scope: { source: decision.source, permitted: decision.permitted, laneKeys: options.laneKeys, sourceLaneKeys: source.laneKeys },
      decision,
      contentIndex,
    };
  };
  try {
    return await Promise.race([plan(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('verdict cache planning timed out')); }, options.timeoutMs ?? PLAN_TIMEOUT_MS);
    })]);
  } catch {
    return failed();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abort.abort();
  }
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

const MAX_LISTED = 15;

function code(value: string): string {
  return `\`${value.replace(/[`\r\n]/gu, ' ')}\``;
}

function listed(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).map(code).join(', ');
  const more = items.length - MAX_LISTED;
  return more > 0 ? `${shown}, +${more} more` : shown;
}

const FALLBACK_TEXT: Record<VerdictCacheFallbackReason, string> = {
  'flag-off': 'the verdict cache is off',
  'no-prior-review': 'no earlier completed review of this pull request',
  'retry-attempt': 'this is a retry attempt',
  'same-head': 'the previous review was of this same head',
  'prior-identity-mismatch': 'the previous review record did not match this pull request',
  'prior-not-ship-complete': 'the previous review was not a complete SHIP',
  'policy-or-config-changed': 'the review policy or persona configuration changed',
  'prior-too-old': 'the previous review is older than the configured age',
  'not-ancestor': 'the previously reviewed head is not an ancestor of this head',
  'comparison-incomplete': 'a comparison listed too many files to be complete',
  'base-rewritten': 'the merge base was rewritten',
  'base-moved-reviewed-files': 'the merge base moved and changed a reviewed file',
  'nothing-carried-forward': 'no file matched',
  'no-new-reviewable-change': 'no file changed since the previous review',
  'no-cache-entries': 'the previous review recorded no cacheable file',
  'nothing-cached': 'no file matched a cached result on content, view and lane keys',
  error: 'the cache source could not be read or verified',
};

/** Check-summary lines (plan section 3, invariant 5). Empty when the flag is off. */
export function renderVerdictCacheSummary(
  disclosure: VerdictCacheDisclosure | null | undefined,
  plan: VerdictCachePlan | null,
  recorded: VerdictCacheClaim | undefined,
): string[] {
  if (!plan) return [];
  const saved = recorded ? recorded.entries.length : 0;
  const tail = ` Recorded ${saved} file${saved === 1 ? '' : 's'} for later reuse.`;
  if (disclosure && disclosure.cached.length > 0 && disclosure.source) {
    return [
      `**Verdict cache** (\`${VERDICT_CACHE_FLAG}\`): served ${disclosure.cached.length} file${disclosure.cached.length === 1 ? '' : 's'} `
      + `from the clean lane results of run \`${disclosure.source.runId}\` (head \`${disclosure.source.headSha}\`); `
      + `~${disclosure.estimatedTokensBefore.toLocaleString('en-US')} -> ~${disclosure.estimatedTokensAfter.toLocaleString('en-US')} estimated diff tokens.${tail}`,
      `- Served from cache, identical content, view and lane keys, content not sent (${disclosure.cached.length}): `
      + listed(disclosure.cached.map((hit) => hit.path)),
      `- Reviewed in full (${disclosure.reviewedPaths.length}): ${listed(disclosure.reviewedPaths)}`,
    ];
  }
  const reason = plan.decision.mode === 'full' ? FALLBACK_TEXT[plan.decision.reason]
    : 'no permitted file matched this run\'s view and routing';
  return [`**Verdict cache** (\`${VERDICT_CACHE_FLAG}\`): no file served from cache, because ${reason}.${plan.scope ? tail : ''}`];
}
