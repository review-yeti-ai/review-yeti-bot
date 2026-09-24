import { classifyUnavailablePatch } from './patchAvailability';

/**
 * REL-1099: a lockfile-only diff too large for GitHub's diff media type (406).
 *
 * The worker first computes the diff from git (REL-1080), which carries every
 * lockfile patch, so the registry check (REL-972) can still vouch for the bump.
 * Only when that git-derived diff is unavailable (disabled, or it failed its
 * bounds, timeout or identity checks) does the worker fall back to the
 * pull-files API, and GitHub leaves out a patch it considers too large there.
 *
 * Without the patch the lockfile cannot be verified, so the diff stays out of
 * the no-reviewable-content exemption and fails closed, as before. What
 * changes is the reason: the empty marker chunk used to read as "only removes
 * lockfile content", and the failure advised extending persona paths, which
 * can never cover a lockfile.
 */
export const OMITTED_LOCKFILE_PATCH_REASON =
  'GitHub omitted its patch as too large and no git-derived diff was available, so its sources cannot be verified';

/** The unverified reason for a lockfile whose patch GitHub omitted, or null. */
export function omittedLockfilePatchReason(patch: unknown): string | null {
  return classifyUnavailablePatch(patch) === 'omitted' ? OMITTED_LOCKFILE_PATCH_REASON : null;
}

/**
 * True when every uncovered path is a lockfile that failed verification: no
 * persona can be extended to read a lockfile (the shared filter excludes them
 * from every lane), so the only remedies are a verifiable change or a human.
 */
export function uncoveredOnlyByUnverifiedLockfiles(
  unmatched: readonly string[],
  unverifiedLockfiles: ReadonlyArray<{ path: string }>,
): boolean {
  if (unmatched.length === 0) return false;
  const lockfiles = new Set(unverifiedLockfiles.map((file) => file.path));
  return unmatched.every((path) => lockfiles.has(path));
}
