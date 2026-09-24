/**
 * REL-1092: changed files whose line-level patch is not available to any
 * reviewer. Plan section 3.5 (docs/superpowers/specs/2026-09-23-review-content-
 * shrinking-and-jev-triage.md): nothing is dropped silently.
 *
 * Two shapes reach the shared applicability decision:
 *
 * - `binary`: git's own `Binary files ... differ` / `GIT binary patch` chunk
 *   (GitHub's diff and the git-derived 406 diff), or a pull-files entry with no
 *   patch and no changed lines. There is no text for a lane to read; the file
 *   is disclosed but is not a coverage gap -- the same shape reaches the worker
 *   and the trusted completion side, as it always has.
 * - `omitted`: a pull-files entry (the worker's 406 fallback) with changed lines
 *   but no patch, because GitHub leaves out patches it considers too large. The
 *   file's text changed and no lane saw it. On an analyzable (non-documentation,
 *   non-asset) path it must not be counted as reviewed: the review is marked
 *   coverage-incomplete, which blocks it on the worker and, because the service
 *   ANDs the worker's coverage into its own, in the canonical derivation too.
 *
 * The worker's pull-files fallback writes a header-only chunk carrying
 * `PATCH_UNAVAILABLE_MARKER`, so the file keeps its place in the changed-file
 * list. Dropping it (the pre-REL-1092 behaviour) made the worker derive lanes
 * from fewer paths than the trusted side and could split their lane rosters.
 */
import { isDocumentationOrAssetPath } from './reviewableContent';

export type UnavailablePatchKind = 'binary' | 'omitted';

/** Prefix of the note line the worker writes in place of a missing patch. */
export const PATCH_UNAVAILABLE_MARKER = '\\ Review Yeti: patch unavailable';

/** A changed file no reviewer could read line by line. */
export interface UnavailablePatchFile {
  path: string;
  kind: UnavailablePatchKind;
}

/** The note line for a missing patch, as the worker's pull-files fallback writes it. */
export function patchUnavailableNote(kind: UnavailablePatchKind, changedLines?: number): string {
  if (kind === 'binary') return `${PATCH_UNAVAILABLE_MARKER} (binary)`;
  const lines = typeof changedLines === 'number' && Number.isSafeInteger(changedLines) && changedLines > 0
    ? `; ${changedLines} changed lines` : '';
  return `${PATCH_UNAVAILABLE_MARKER} (omitted by GitHub${lines})`;
}

/**
 * Why a file's patch gives a reviewer nothing to read, or null when it does (or
 * when there is no patch text at all, which callers already handle).
 */
export function classifyUnavailablePatch(patch: unknown): UnavailablePatchKind | null {
  if (typeof patch !== 'string' || patch.length === 0) return null;
  const lines = patch.split('\n');
  const marker = lines.find((line) => line.startsWith(PATCH_UNAVAILABLE_MARKER));
  if (marker !== undefined) return marker.startsWith(`${PATCH_UNAVAILABLE_MARKER} (binary)`) ? 'binary' : 'omitted';
  if (lines.some((line) => line.startsWith('@@ '))) return null;
  if (lines.some((line) => /^Binary files .* differ\r?$/u.test(line) || /^GIT binary patch\r?$/u.test(line))) return 'binary';
  return null;
}

/** Every file whose patch is unavailable, in input order. */
export function unavailablePatchFilesOf(
  files: ReadonlyArray<{ path: string; patch?: unknown }>,
): UnavailablePatchFile[] {
  return files.flatMap((file) => {
    const kind = classifyUnavailablePatch(file.patch);
    return kind ? [{ path: file.path, kind }] : [];
  });
}

/**
 * Analyzable files whose changed text no lane saw. These are never counted as
 * reviewed: a non-empty list makes the review coverage-incomplete.
 */
export function omittedSourcePathsOf(unavailable: ReadonlyArray<UnavailablePatchFile>): string[] {
  return unavailable
    .filter((file) => file.kind === 'omitted' && !isDocumentationOrAssetPath(file.path))
    .map((file) => file.path);
}
