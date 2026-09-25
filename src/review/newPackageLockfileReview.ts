import {
  classifyLockfileOrGeneratedPath,
  LOCKFILE_IGNORE_REASON,
  MAX_FILE_PATCH_CHARS,
  type HunkFilterResult,
} from '../pipeline/hunkFilter';
import { isRegularFileMode, NEW_PACKAGE_ENTRY_REFUSAL, verifyLockfileOnlyChange } from './lockfileChangeVerification';
import { omittedLockfilePatchReason } from './omittedLockfilePatch';
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
 *   new entry sits past a truncation cut.
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

/**
 * The effective files with every new-package lockfile the hunk filter hid put
 * back, in changed-file order, and the paths put back. A lockfile a
 * `path_filters` pattern excluded stays excluded: only the filter's own
 * lockfile rule is undone.
 */
export function withNewPackageLockfiles(
  changedFiles: ReadonlyArray<ReviewApplicabilityInputFile>,
  effectiveFiles: readonly EffectiveReviewFile[],
  hunkResult: Pick<HunkFilterResult, 'files'>,
): { files: EffectiveReviewFile[]; paths: string[] } {
  const hiddenLockfiles = new Set(hunkResult.files
    .filter((file) => file.status === 'ignored' && file.ignoreReason === LOCKFILE_IGNORE_REASON)
    .map((file) => file.path));
  if (hiddenLockfiles.size === 0) return { files: [...effectiveFiles], paths: [] };
  const effective = new Map(effectiveFiles.map((file) => [file.path, file]));
  const restored = new Map<string, EffectiveReviewFile>();
  for (const file of changedFiles) {
    if (!file || effective.has(file.path) || restored.has(file.path) || !hiddenLockfiles.has(file.path)) continue;
    if (!isNewPackageLockfileChange(file)) continue;
    // The changed file as given (every field it carries), plus its patch length.
    restored.set(file.path, { ...file, originalPatchLength: (file.patch ?? '').length });
  }
  if (restored.size === 0) return { files: [...effectiveFiles], paths: [] };
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
  return { files, paths: [...restored.keys()] };
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
