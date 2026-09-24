import type { CtReviewConfigV3 } from '../config/schema';
import { matchOne } from '../pipeline/domainIndex';
import { classifyLockfileOrGeneratedPath, filterDiffHunks, type HunkFilterResult } from '../pipeline/hunkFilter';
import { isDataOrConfigPath, isDocumentationOrAssetPath, isNoReviewableContentFile } from './reviewableContent';
import { isRegularFileMode, verifyLockfileOnlyChange } from './lockfileChangeVerification';
import { isSubmodulePatch } from './submodulePatch';

type ReviewPersona = CtReviewConfigV3['personas'][number];

export function isSubmoduleEntry(file: unknown): boolean {
  if (!file || typeof file !== 'object') return false;
  const f = file as {
    isSubmodule?: boolean;
    submoduleCandidate?: boolean;
    mode?: string;
    oldMode?: string;
    newMode?: string;
    old_mode?: string;
    new_mode?: string;
    patch?: string;
  };
  return Boolean(
    f.isSubmodule === true ||
    f.submoduleCandidate === true ||
    f.mode === '160000' ||
    f.oldMode === '160000' ||
    f.newMode === '160000' ||
    f.old_mode === '160000' ||
    f.new_mode === '160000' ||
    isSubmodulePatch(f.patch)
  );
}

export function isArchitecturePersona(persona: unknown): boolean {
  if (!persona || typeof persona !== 'object') return false;
  const p = persona as { id?: string; charter?: string; coversSubmodules?: boolean };
  return Boolean(
    p.coversSubmodules === true ||
    p.id === 'architecture' ||
    p.id === 'arch-lane' ||
    p.charter === 'builtin:architecture'
  );
}

/**
 * Test whether a review persona covers a given file, either by matching one of
 * its configured glob patterns or because the file is a git submodule entry and
 * the persona is an architecture lane.
 */
export function personaCoversFile(
  persona: { paths: readonly string[]; id?: string; charter?: string; coversSubmodules?: boolean; routedPaths?: readonly string[] },
  file: { path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean; patch?: string } | null | undefined,
): boolean {
  if (!file) return false;
  // Exact per-diff routing assigned by routeOrphanedReviewFiles.
  if (persona.routedPaths?.includes(file.path)) return true;
  if (isArchitecturePersona(persona) && isSubmoduleEntry(file)) {
    return true;
  }
  return persona.paths.some((pattern) => pattern === '**' || matchOne(pattern, file.path));
}

/**
 * Filter a set of changed files to only those covered by the given persona.
 */
export function scopeFilesForPersona<T extends { path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean; patch?: string }>(
  persona: Parameters<typeof personaCoversFile>[0],
  files: readonly T[],
): T[] {
  return files.filter((file) => personaCoversFile(persona, file));
}

/**
 * Files that must be reviewed by some lane even when no persona's paths cover
 * them, instead of failing the run as unmatched source (REL-1058):
 *
 * - Submodule gitlinks. A pointer bump changes no file content here, only the
 *   pinned commit of another repository, but it is still a dependency change.
 *   The architecture persona covers gitlinks natively (it reviews the pinned
 *   old -> new commit carried in the gitlink patch).
 * - `.mdx` / `.mdoc` pages. They are documentation, but compile to component
 *   modules (imports, exports, expressions run in the docs build), so they are
 *   never exempted as inert prose. A documentation persona covers them.
 * - Data and configuration files (REL-972): JSON, YAML, TOML, CSV, XML and the
 *   like. A one-line inventory JSON change no persona's paths name used to fail
 *   every review with "no enabled persona applies"; it is not source, but it
 *   can change behaviour, so it is reviewed rather than exempted. Run artifacts
 *   (`runs/`, `evidence/`, `artifacts/`) keep their documentation exemption.
 *
 * Uncovered SOURCE is not in this list: it still fails closed as a persona
 * coverage gap.
 */
export function isFallbackRoutedFile(file: { path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean; patch?: string }): boolean {
  return isSubmoduleEntry(file)
    || /\.(mdx|mdoc)$/iu.test(file.path)
    || (isDataOrConfigPath(file.path) && !isDocumentationOrAssetPath(file.path));
}

/**
 * Deterministic owner for fallback-routed files no enabled persona covers: the
 * roster's required personas (security by default -- a pointer bump is a
 * supply-chain change, MDX is executable, data and config drive behaviour), or
 * the first enabled persona when none is required. Personas are returned unchanged when nothing is orphaned,
 * so a roster that already covers these files is never widened.
 *
 * Routing is expressed as exact per-diff `routedPaths`, so applicability,
 * per-lane file scoping and unmatched-path reporting all follow it. Worker and
 * service both reach it through `resolveReviewApplicability`, so they cannot
 * disagree.
 */
export function routeOrphanedReviewFiles<P extends { id: string; required?: boolean; paths: readonly string[]; charter?: string; coversSubmodules?: boolean; routedPaths?: readonly string[] }>(
  personas: readonly P[],
  files: ReadonlyArray<{ path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean; patch?: string }>,
): P[] {
  if (personas.length === 0) return [...personas];
  const orphans = files
    .filter((file) => isFallbackRoutedFile(file) && !personas.some((persona) => personaCoversFile(persona, file)))
    .map((file) => file.path);
  if (orphans.length === 0) return [...personas];
  const required = personas.filter((persona) => persona.required === true);
  const owners = new Set((required.length > 0 ? required : [personas[0]]).map((persona) => persona.id));
  return personas.map((persona) => (owners.has(persona.id)
    ? { ...persona, routedPaths: [...(persona.routedPaths ?? []), ...orphans] }
    : persona));
}

/**
 * Derive the exact immutable-config persona roster for a set of reviewable
 * paths. Ordering follows the prepared policy so worker and service evidence
 * share one canonical lane order.
 */
export function deriveApplicablePersonas(
  personas: readonly ReviewPersona[],
  files: ReadonlyArray<{ path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean; patch?: string }>,
): ReviewPersona[] {
  return personas.filter((persona) => files.some((file) => personaCoversFile(persona, file)));
}

export function deriveApplicablePersonaIds(
  personas: readonly ReviewPersona[],
  files: ReadonlyArray<{ path: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean; patch?: string }>,
): string[] {
  return deriveApplicablePersonas(personas, files).map((persona) => persona.id);
}

/**
 * Computes non-code or uncovered paths that matched no applicable persona in the active roster.
 * A file is considered unmatched only when no applicable persona covers it via personaCoversFile.
 */
export function computeUnmatchedPaths(
  files: ReadonlyArray<{ path?: string; filePath?: string; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean; patch?: string }>,
  applicablePersonas: ReadonlyArray<Parameters<typeof personaCoversFile>[0]>,
): string[] {
  return files
    .filter((f) => {
      const fileObj = {
        path: f.path || f.filePath || '',
        mode: f.mode,
        isSubmodule: f.isSubmodule,
        submoduleCandidate: f.submoduleCandidate,
        patch: f.patch,
      };
      return !applicablePersonas.some((persona) => personaCoversFile(persona, fileObj));
    })
    .map((f) => f.path || f.filePath || '')
    .filter((p) => p.length > 0)
    .filter((p) => !isDocumentationOrAssetPath(p));
}

export interface ReviewApplicabilityInputFile {
  path: string;
  patch?: string;
  content?: string;
  mode?: string;
  isSubmodule?: boolean;
  submoduleCandidate?: boolean;
  size?: number;
  byteSize?: number;
}

export interface EffectiveReviewFile {
  path: string;
  patch?: string;
  content?: string;
  mode?: string;
  isSubmodule?: boolean;
  submoduleCandidate?: boolean;
  size?: number;
  byteSize?: number;
  originalPatchLength: number;
}

/**
 * The single reviewable-file projection shared by every engine and by the
 * service's completion path: the repository's `path_filters` plus the shared
 * lockfile/generated-file hunk filter, with the gitlink metadata (mode,
 * submodule flags) carried through. Dropping that metadata on one side and not
 * the other is exactly how the worker and the service came to disagree about
 * which personas apply (REL-1056 / REL-1058).
 */
export function buildEffectiveReviewFiles(
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  options: { pathFilters?: readonly string[] } = {},
): { files: EffectiveReviewFile[]; hunkResult: HunkFilterResult } {
  // Only a validated string list narrows the review. Anything else (absent, or
  // an unvalidated config shape) filters nothing -- it can never widen what is
  // excluded from review.
  const pathFilters = Array.isArray(options.pathFilters)
    ? options.pathFilters.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0)
    : [];
  const hunkResult = filterDiffHunks(
    changedFiles.map((file) => ({ path: file.path, patch: file.patch, content: file.content })),
    { path_filters: pathFilters },
  );
  const origMap = new Map(changedFiles.map((file) => [file.path, file]));
  const files = hunkResult.files
    .filter((file) => file.status !== 'ignored')
    .map((file) => {
      const orig = origMap.get(file.path);
      return {
        path: file.path,
        patch: file.patch,
        content: file.content,
        mode: orig?.mode,
        isSubmodule: orig?.isSubmodule,
        submoduleCandidate: orig?.submoduleCandidate,
        size: orig?.size,
        byteSize: orig?.byteSize,
        originalPatchLength: file.originalPatchLength,
      };
    });
  return { files, hunkResult };
}

export type NoReviewableContentKind = 'documentation' | 'lockfile-only';

export interface ReviewApplicability<P> {
  effectiveFiles: EffectiveReviewFile[];
  hunkResult: HunkFilterResult;
  /** Applicable personas in roster order, carrying any gitlink routing capability. */
  applicable: P[];
  /**
   * Zero lanes apply and there is nothing to analyze: the audited
   * no-reviewable-content exemption. Either every reviewable path is
   * documentation, an asset, a run artifact or data, or (REL-972) every changed
   * file is a dependency lockfile; either way every lockfile in the diff must
   * pass the registry content check.
   */
  noReviewableContent: boolean;
  /** Which exemption applied; null unless `noReviewableContent`. */
  noReviewableContentKind: NoReviewableContentKind | null;
  /** One-line published rationale for the exemption; null unless `noReviewableContent`. */
  noReviewableContentRationale: string | null;
  /** Analyzable paths no enabled persona covers (empty unless zero lanes apply). */
  unmatchedPaths: string[];
  /**
   * Lockfiles that kept an otherwise exempt diff from the exemption because
   * their change could not be verified (also listed in `unmatchedPaths`).
   */
  unverifiedLockfiles: ReadonlyArray<{ path: string; reason: string }>;
  /**
   * Changed files the review filter dropped (generated output or a
   * `path_filters` exclusion) that kept a zero-lane diff from the exemption:
   * no lane reads them, and they are neither documentation nor a verified
   * lockfile (also listed in `unmatchedPaths`).
   */
  excludedPaths: string[];
}

export const DOCUMENTATION_ONLY_RATIONALE =
  'No analyzable source changed: every path is documentation, an asset, a run artifact or data.';

const MAX_LISTED_EXCLUDED_FILES = 8;

function isLockfilePath(path: unknown): boolean {
  return typeof path === 'string' && classifyLockfileOrGeneratedPath(path) === 'lockfile';
}

/**
 * REL-972: lockfiles in the diff whose change cannot be verified to stay on
 * the default public registries (see lockfileChangeVerification). The shared
 * filter hides every lockfile from every lane, so an exemption may only stand
 * on lockfile changes the content check vouches for.
 */
function unverifiedLockfileChanges(
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
): Array<{ path: string; reason: string }> {
  return changedFiles
    .filter((file) => isLockfilePath(file?.path))
    .flatMap((file) => {
      if (isSubmoduleEntry(file)) return [{ path: file.path, reason: 'is a submodule gitlink' }];
      if (!isRegularFileMode(file.mode)) return [{ path: file.path, reason: 'is not a regular file' }];
      const verified = verifyLockfileOnlyChange(file.path, file.patch);
      return verified.ok ? [] : [{ path: file.path, reason: verified.reason }];
    });
}

function lockfileOnlyRationale(changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>): string {
  const listed = changedFiles.slice(0, MAX_LISTED_EXCLUDED_FILES).map((file) => file.path);
  const overflow = changedFiles.length - listed.length;
  return 'No reviewable content: every changed file is a dependency lockfile, which the review filter '
    + 'excludes from every lane, and every added source resolves to a default public registry. '
    + `Excluded: ${listed.join(', ')}${overflow > 0 ? `, +${overflow} more` : ''}. `
    + 'A manifest or source change in the same diff would be reviewed.';
}

/**
 * The one persona-applicability decision. The worker panel and the service's
 * trusted completion context both call this with the same enabled roster and
 * the same repository options, so the lanes a worker runs and the lanes the
 * service requires are derived by the same code from the same inputs.
 */
export function resolveReviewApplicability<P extends ReviewPersona>(
  enabledPersonas: readonly P[],
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  options: { pathFilters?: readonly string[] } = {},
): ReviewApplicability<P> {
  const { files: effectiveFiles, hunkResult } = buildEffectiveReviewFiles(changedFiles, options);
  const roster = routeOrphanedReviewFiles(enabledPersonas, effectiveFiles);
  const applicable = deriveApplicablePersonas(roster, effectiveFiles) as P[];
  const reviewed = {
    noReviewableContent: false,
    noReviewableContentKind: null,
    noReviewableContentRationale: null,
    unverifiedLockfiles: [],
  } as const;
  if (applicable.length > 0) {
    // Routing may only add a lane for the routed files themselves. When no
    // configured persona applied before routing, any other uncovered analyzable
    // path is still the coverage failure it always was -- routing an .mdx, a
    // gitlink or a data file must not turn that failure into a silently
    // under-scoped review.
    const routedOnly = deriveApplicablePersonas(enabledPersonas, effectiveFiles).length === 0;
    const uncovered = routedOnly ? computeUnmatchedPaths(effectiveFiles, roster) : [];
    if (uncovered.length > 0) {
      return { effectiveFiles, hunkResult, applicable: [], ...reviewed, excludedPaths: [], unmatchedPaths: uncovered };
    }
    return { effectiveFiles, hunkResult, applicable, ...reviewed, excludedPaths: [], unmatchedPaths: [] };
  }
  // Zero lanes apply. The exemption is judged over the RAW changed files, not
  // the post-filter projection: every changed file must itself be
  // documentation/an asset/a run artifact, or a dependency lockfile. A file the
  // review filter dropped for any other reason -- generated output, a
  // `path_filters` exclusion -- is not reviewed by anyone, so it cannot ride
  // along under a documentation-only pass (REL-972). Judging the post-filter
  // files here while the service re-checked the raw files is how a docs +
  // generated diff passed on the worker and was refused at completion
  // (REL-1056). A diff made only of such excluded files already failed closed;
  // adding a README to it no longer changes that.
  const exemptCandidate = changedFiles.length > 0
    && changedFiles.every((file) => isDocumentationOrAssetPath(file.path) || isLockfilePath(file?.path));
  if (exemptCandidate) {
    const unverifiedLockfiles = unverifiedLockfileChanges(changedFiles);
    if (unverifiedLockfiles.length > 0) {
      return {
        effectiveFiles,
        hunkResult,
        applicable,
        ...reviewed,
        unverifiedLockfiles,
        excludedPaths: [],
        unmatchedPaths: unverifiedLockfiles.map((file) => file.path),
      };
    }
    // Identical, by construction, to the per-file rule the service applies to
    // the admitted files before it accepts a no-reviewable-content completion.
    if (changedFiles.every((file) => isNoReviewableContentFile(file))) {
      const lockfileOnly = changedFiles.every((file) => isLockfilePath(file.path));
      return {
        effectiveFiles,
        hunkResult,
        applicable,
        ...reviewed,
        noReviewableContent: true,
        noReviewableContentKind: lockfileOnly ? 'lockfile-only' : 'documentation',
        noReviewableContentRationale: lockfileOnly ? lockfileOnlyRationale(changedFiles) : DOCUMENTATION_ONLY_RATIONALE,
        excludedPaths: [],
        unmatchedPaths: [],
      };
    }
  }
  const effectivePaths = new Set(effectiveFiles.map((file) => file.path));
  const excludedPaths = changedFiles
    .filter((file) => typeof file?.path === 'string' && file.path.length > 0 && !effectivePaths.has(file.path))
    .filter((file) => !isNoReviewableContentFile(file))
    .map((file) => file.path);
  const unmatched = computeUnmatchedPaths(effectiveFiles, roster);
  return {
    effectiveFiles,
    hunkResult,
    applicable,
    ...reviewed,
    excludedPaths,
    unmatchedPaths: [...unmatched, ...excludedPaths.filter((path) => !unmatched.includes(path))],
  };
}
