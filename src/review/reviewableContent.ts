import { isRegularFileMode, verifyLockfileOnlyChange } from './lockfileChangeVerification';
import { isDataOrConfigPath, isDocumentationOrAssetPath } from './pathRiskPolicy';

// The documentation/asset and data/config predicates (and their format tables) live in
// `./pathRiskPolicy.js`, shared with the GitHub Action pipeline; edit them there.
/**
 * Returns true only for paths the review policy treats as non-analyzable content.
 *
 * Keep this classification service-safe: executable content under evidence and
 * artifact directories remains analyzable, as do manifests and dependency files.
 */
export { isDocumentationOrAssetPath };

/**
 * Structured data and configuration formats (REL-972): JSON, YAML, TOML, CSV,
 * XML, INI-style files and similar.
 *
 * These are deliberately NOT documentation. Data and configuration change
 * behaviour -- an inventory file drives automation, a YAML file configures a
 * deploy, a JSON file seeds a build -- so a data/config file no enabled
 * persona covers is routed to a lane (see `isFallbackRoutedFile`), never
 * exempted. Run artifacts under `runs/`, `evidence/` and `artifacts/` stay the
 * documentation exemption they already were (`isDocumentationOrAssetPath` is
 * checked first by every caller).
 */
export { isDataOrConfigPath };

/**
 * A changed file the service accepts inside a no-reviewable-content completion:
 * documentation, an asset, a run artifact (JSON/CSV/log data under `runs/`,
 * `evidence/` or `artifacts/` only -- other data/config files are never
 * accepted here, see `isDataOrConfigPath`), or (REL-972) a dependency
 * lockfile whose added lines verifiably stay on the default public registries.
 *
 * This is the per-file rule of the exemption itself: the shared
 * `resolveReviewApplicability` decision exempts a zero-lane diff only when
 * every RAW changed file passes it, and the service re-checks the admitted
 * files with it. Judging the raw files, not the post-filter projection, is
 * what keeps a generated file or a `path_filters` exclusion from riding along
 * unreviewed under a documentation-only pass -- and what keeps the worker and
 * the trusted completion side from disagreeing about such a diff (REL-972 /
 * REL-1056).
 */
export function isNoReviewableContentFile(
  file: { path: string; patch?: unknown; mode?: string; isSubmodule?: boolean; submoduleCandidate?: boolean },
): boolean {
  if (isDocumentationOrAssetPath(file.path)) return true;
  // A gitlink is a dependency change even at a lockfile-looking path, and a
  // symlink's patch is its target, not lockfile content.
  if (file.isSubmodule === true || file.submoduleCandidate === true || !isRegularFileMode(file.mode)) return false;
  return verifyLockfileOnlyChange(file.path, file.patch).ok;
}
