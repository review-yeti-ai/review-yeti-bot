/**
 * The one per-repository flag grammar shared by the review-content flags
 * (`REVIEW_YETI_DIFF_SHRINK`, `REVIEW_YETI_BUDGET`, `REVIEW_YETI_INCREMENTAL`,
 * `REVIEW_YETI_SKIP_EMPTY_MODERATION`):
 * - unset, empty, `0`, `false` or `off` is off (the default);
 * - `1`, `true`, `on` or `all` is on for every repository;
 * - anything else is a comma- or space-separated list of `owner/repo` names it
 *   is on for (case-insensitive), so a flag can be enabled per repository first.
 */
export function repositoryFlagEnabledFor(
  env: Readonly<Record<string, string | undefined>>,
  flag: string,
  repository: string,
): boolean {
  const raw = String(env[flag] ?? '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'false' || raw === 'off') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'all') return true;
  const target = String(repository || '').trim().toLowerCase();
  return target.length > 0 && raw.split(/[\s,]+/u).some((entry) => entry === target);
}
