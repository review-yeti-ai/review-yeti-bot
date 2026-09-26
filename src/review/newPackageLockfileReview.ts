import {
  classifyLockfileOrGeneratedPath,
  LOCKFILE_IGNORE_REASON,
  MAX_FILE_PATCH_CHARS,
  type HunkFilterResult,
} from '../pipeline/hunkFilter';
import {
  isRegularFileMode, NEW_PACKAGE_ENTRY_REFUSAL, ONLY_REMOVES_REFUSAL, verifyLockfileOnlyChange,
} from './lockfileChangeVerification';
import { summarizeLockfileChange } from './lockfileChangeSummary';
import { omittedLockfilePatchReason } from './omittedLockfilePatch';
import { classifyUnavailablePatch } from './patchAvailability';
import { isSubmodulePatch } from './submodulePatch';
import type { EffectiveReviewFile, ReviewApplicabilityInputFile } from './reviewFileShapes';

/**
 * REL-1136: a dependency lockfile that adds a NEW package is reviewed by a
 * lane, never exempted and no longer a hard "no enabled persona applies".
 *
 * The shared hunk filter hides every lockfile from every lane. A lockfile-only
 * bump that the registry check (REL-972 / REL-1118) verifies takes the
 * lockfile-only exemption; one it refuses used to fail closed. That left a
 * Dependabot bump whose new version pulls in one new transitive entry
 * (calltelemetry/ct-quasar#847: qs 6.15.2 -> 6.15.3 adds
 * `side-channel@npm:^1.1.1`) permanently unreviewable.
 *
 * A new package is a supply-chain change, so it must be REVIEWED. A lockfile
 * qualifies here only when the new entry is its ONLY problem:
 *
 * - it is a regular file with a readable patch (not a gitlink, a symlink, or a
 *   patch GitHub omitted);
 * - the strict check refuses it for adding a new package entry, and the same
 *   check with new entries allowed passes -- so every added source still
 *   resolves on the default public registry, with no escape sequence and no
 *   foreign line;
 * - the whole patch fits what one lane reads (`MAX_FILE_PATCH_CHARS`), so no
 *   new entry sits past a truncation cut. (REL-1141: a larger one is put back
 *   as its complete package-change summary instead, see
 *   `oversizedLockfileSummary`.)
 *
 * Such a lockfile is put back into the effective files (the lanes receive its
 * patch) and routed to the dependency lane when one is enabled, plus every
 * required lane (security by default): lockfiles are security-sensitive and
 * are never skipped. Any other refusal keeps the fail-closed outcome, which
 * asks for a human review.
 */

export function isNewPackageLockfileChange(file: ReviewApplicabilityInputFile): boolean {
  if (!file || typeof file.path !== 'string') return false;
  if (classifyLockfileOrGeneratedPath(file.path) !== 'lockfile') return false;
  if (file.isSubmodule === true || file.submoduleCandidate === true || !isRegularFileMode(file.mode)) return false;
  const patch = file.patch;
  if (typeof patch !== 'string' || patch.length === 0 || patch.length > MAX_FILE_PATCH_CHARS) return false;
  if (isSubmodulePatch(patch) || omittedLockfilePatchReason(patch)) return false;
  const strict = verifyLockfileOnlyChange(file.path, patch);
  if (strict.ok || strict.reason !== NEW_PACKAGE_ENTRY_REFUSAL) return false;
  return verifyLockfileOnlyChange(file.path, patch, { allowNewEntries: true }).ok;
}

/** REL-1141: a lockfile the lanes receive as a deterministic summary instead of its oversized patch. */
export interface SummarizedLockfile {
  path: string;
  /** Characters of the patch that was too large for a lane. */
  originalChars: number;
  /** Characters of the summary the lanes received. */
  summaryChars: number;
  /** Packages added, removed or re-versioned. */
  packageChanges: number;
}

/** REL-1141: a changed lockfile no lane could read in full or as a summary. Coverage is incomplete. */
export interface UnreviewableLockfile {
  path: string;
  reason: string;
}

/**
 * REL-1141: the summary the lanes receive for a lockfile whose patch is over
 * `MAX_FILE_PATCH_CHARS`, or why none can be built (the caller fails closed).
 *
 * The summary names packages, not sources, so it stands only on a patch the
 * registry check vouches for over its WHOLE length: every added source still
 * resolves on the default public registry, with no escape sequence and no
 * foreign line (new entries allowed; a pure removal adds no source). The
 * summary itself must fit one lane whole.
 */
export function oversizedLockfileSummary(
  file: ReviewApplicabilityInputFile,
): { ok: true; summary: string; packageChanges: number } | { ok: false; reason: string } {
  if (file.isSubmodule === true || file.submoduleCandidate === true || !isRegularFileMode(file.mode)) {
    return { ok: false, reason: 'is not a regular file' };
  }
  const patch = file.patch;
  if (typeof patch !== 'string' || patch.length === 0) return { ok: false, reason: 'no patch to summarize' };
  const unavailable = classifyUnavailablePatch(patch);
  if (unavailable === 'omitted') return { ok: false, reason: 'GitHub omitted its patch as too large' };
  if (unavailable === 'binary' || isSubmodulePatch(patch)) return { ok: false, reason: 'has no readable text patch' };
  const verified = verifyLockfileOnlyChange(file.path, patch, { allowNewEntries: true });
  if (!verified.ok && verified.reason !== ONLY_REMOVES_REFUSAL) {
    return { ok: false, reason: `cannot be summarized: it ${verified.reason}` };
  }
  const summary = summarizeLockfileChange(file.path, patch, patch.length);
  if (!summary.ok) return { ok: false, reason: `cannot be summarized: it ${summary.reason}` };
  if (summary.text.length > MAX_FILE_PATCH_CHARS) {
    return { ok: false, reason: 'its package-change summary is itself larger than one lane reads' };
  }
  return { ok: true, summary: summary.text, packageChanges: summary.packageChanges };
}

function summarizedFile(
  file: ReviewApplicabilityInputFile,
  summary: { summary: string; packageChanges: number },
): { file: EffectiveReviewFile; record: SummarizedLockfile } {
  const originalChars = (file.patch ?? '').length;
  return {
    file: { ...file, patch: summary.summary, originalPatchLength: originalChars },
    record: { path: file.path, originalChars, summaryChars: summary.summary.length, packageChanges: summary.packageChanges },
  };
}

function hiddenLockfilePaths(hunkResult: Pick<HunkFilterResult, 'files'>): Set<string> {
  return new Set(hunkResult.files
    .filter((file) => file.status === 'ignored' && file.ignoreReason === LOCKFILE_IGNORE_REASON)
    .map((file) => file.path));
}

/** `effectiveFiles` plus `restored`, in changed-file order. */
function mergeInChangedOrder(
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  effectiveFiles: readonly EffectiveReviewFile[],
  restored: ReadonlyMap<string, EffectiveReviewFile>,
): EffectiveReviewFile[] {
  const effective = new Map(effectiveFiles.map((file) => [file.path, file]));
  const files: EffectiveReviewFile[] = [];
  const emitted = new Set<string>();
  for (const file of changedFiles) {
    const next = effective.get(file?.path) ?? restored.get(file?.path);
    if (next && !emitted.has(next.path)) {
      files.push(next);
      emitted.add(next.path);
    }
  }
  // Effective files never come from outside changedFiles, but keep any that do.
  for (const file of effectiveFiles) if (!emitted.has(file.path)) files.push(file);
  return files;
}

/**
 * The effective files with every new-package lockfile the hunk filter hid put
 * back, in changed-file order, and the paths put back. A lockfile a
 * `path_filters` pattern excluded stays excluded: only the filter's own
 * lockfile rule is undone.
 *
 * REL-1141: a new-package lockfile whose patch is over `MAX_FILE_PATCH_CHARS`
 * is put back as its package-change summary (`summarized`) when one can be
 * built over the whole patch; otherwise it stays hidden and keeps failing
 * closed as before.
 */
export function withNewPackageLockfiles(
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  effectiveFiles: readonly EffectiveReviewFile[],
  hunkResult: Pick<HunkFilterResult, 'files'>,
): { files: EffectiveReviewFile[]; paths: string[]; summarized: SummarizedLockfile[] } {
  const hiddenLockfiles = hiddenLockfilePaths(hunkResult);
  if (hiddenLockfiles.size === 0) return { files: [...effectiveFiles], paths: [], summarized: [] };
  const effective = new Set(effectiveFiles.map((file) => file.path));
  const restored = new Map<string, EffectiveReviewFile>();
  const summarized: SummarizedLockfile[] = [];
  for (const file of changedFiles) {
    if (!file || effective.has(file.path) || restored.has(file.path) || !hiddenLockfiles.has(file.path)) continue;
    if (isNewPackageLockfileChange(file)) {
      // The changed file as given (every field it carries), plus its patch length.
      restored.set(file.path, { ...file, originalPatchLength: (file.patch ?? '').length });
      continue;
    }
    if (!isOversizedNewPackageLockfileChange(file)) continue;
    const summary = oversizedLockfileSummary(file);
    if (!summary.ok) continue;
    const { file: next, record } = summarizedFile(file, summary);
    restored.set(file.path, next);
    summarized.push(record);
  }
  if (restored.size === 0) return { files: [...effectiveFiles], paths: [], summarized: [] };
  return { files: mergeInChangedOrder(changedFiles, effectiveFiles, restored), paths: [...restored.keys()], summarized };
}

/** A lockfile over the per-file cap whose only unverified change, over the whole patch, is a new registry package. */
function isOversizedNewPackageLockfileChange(file: ReviewApplicabilityInputFile): boolean {
  if (typeof file.patch !== 'string' || file.patch.length <= MAX_FILE_PATCH_CHARS) return false;
  if (classifyLockfileOrGeneratedPath(file.path) !== 'lockfile') return false;
  const strict = verifyLockfileOnlyChange(file.path, file.patch);
  return !strict.ok && strict.reason === NEW_PACKAGE_ENTRY_REFUSAL;
}

/**
 * REL-1141: once any lane reviews the diff, no changed lockfile may ride along
 * unread. The shared filter hides every lockfile from every lane; before this,
 * a lockfile beside a reviewed manifest (calltelemetry/openclaw-linear-plugin#30:
 * package.json + a 41,140-character package-lock.json adding four packages)
 * was dropped silently and the run could SHIP.
 *
 * Every lockfile the filter hid that is not already back is now:
 *
 * - sent in full when its patch fits `MAX_FILE_PATCH_CHARS` (`full`);
 * - sent as its deterministic package-change summary when it does not
 *   (`summarized`, see `oversizedLockfileSummary`);
 * - otherwise listed as `unreviewable` -- an omitted or binary patch, an
 *   unsummarizable format (pnpm, go.sum, ...), or a source the registry check
 *   refuses in a patch too large to send -- which makes coverage incomplete.
 *
 * A lockfile with no patch text at all (a pure rename or mode change) changes
 * no package entry and stays hidden. `path_filters` exclusions are untouched.
 */
export function withChangedLockfilesReviewed(
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  effectiveFiles: readonly EffectiveReviewFile[],
  hunkResult: Pick<HunkFilterResult, 'files'>,
): {
  files: EffectiveReviewFile[];
  fullPaths: string[];
  summarized: SummarizedLockfile[];
  unreviewable: UnreviewableLockfile[];
} {
  const hiddenLockfiles = hiddenLockfilePaths(hunkResult);
  const effective = new Set(effectiveFiles.map((file) => file.path));
  const restored = new Map<string, EffectiveReviewFile>();
  const fullPaths: string[] = [];
  const summarized: SummarizedLockfile[] = [];
  const unreviewable: UnreviewableLockfile[] = [];
  const seen = new Set<string>();
  for (const file of changedFiles) {
    if (!file || typeof file.path !== 'string' || seen.has(file.path)) continue;
    seen.add(file.path);
    if (effective.has(file.path) || !hiddenLockfiles.has(file.path)) continue;
    const patch = file.patch;
    if (typeof patch !== 'string' || patch.length === 0) continue;
    if (classifyUnavailablePatch(patch) !== null) {
      unreviewable.push({ path: file.path, reason: classifyUnavailablePatch(patch) === 'omitted'
        ? 'GitHub omitted its patch as too large' : 'has no readable text patch' });
      continue;
    }
    if (patch.length <= MAX_FILE_PATCH_CHARS) {
      restored.set(file.path, { ...file, originalPatchLength: patch.length });
      fullPaths.push(file.path);
      continue;
    }
    const summary = oversizedLockfileSummary(file);
    if (!summary.ok) {
      unreviewable.push({ path: file.path, reason: summary.reason });
      continue;
    }
    const { file: next, record } = summarizedFile(file, summary);
    restored.set(file.path, next);
    summarized.push(record);
  }
  if (restored.size === 0) return { files: [...effectiveFiles], fullPaths, summarized, unreviewable };
  return { files: mergeInChangedOrder(changedFiles, effectiveFiles, restored), fullPaths, summarized, unreviewable };
}

export function isDependencyPersona(persona: { id?: string; charter?: string }): boolean {
  return persona.id === 'dep-lane' || persona.charter === 'builtin:dependency-health';
}

/**
 * Route new-package lockfiles to the dependency lane(s) and every required
 * lane, or the first enabled persona when the roster has neither. Routing only
 * adds readers; a persona whose own paths already cover the lockfile keeps it.
 */
export function routeNewPackageLockfiles<P extends { id: string; required?: boolean; charter?: string; routedPaths?: readonly string[] }>(
  personas: readonly P[],
  paths: readonly string[],
): P[] {
  if (personas.length === 0 || paths.length === 0) return [...personas];
  const owners = new Set(personas.filter((persona) => persona.required === true || isDependencyPersona(persona)).map((persona) => persona.id));
  if (owners.size === 0) owners.add(personas[0].id);
  return personas.map((persona) => {
    if (!owners.has(persona.id)) return persona;
    const already = new Set(persona.routedPaths ?? []);
    return { ...persona, routedPaths: [...already, ...paths.filter((path) => !already.has(path))] };
  });
}
