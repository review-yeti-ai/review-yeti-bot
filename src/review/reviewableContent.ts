import { isRegularFileMode, verifyLockfileOnlyChange } from './lockfileChangeVerification';

/**
 * Prose documentation formats and static image/diagram assets.
 *
 * REL-1058: `.asciidoc` is the long form of `.adoc`; `.webp` and `.avif` are
 * image assets.
 *
 * Deliberately NOT listed: `.mdx` and `.mdoc` (they compile to executable
 * component modules; an uncovered `.mdx` is routed to a lane instead, see
 * `isFallbackRoutedFile`), `.mdc` (Cursor rule files are agent operating
 * policy, not prose documentation), and anything that can execute or configure
 * a build.
 */
const DOCUMENTATION_OR_ASSET_EXTENSION =
  /\.(md|markdown|txt|rst|adoc|asciidoc|png|jpg|jpeg|gif|svg|ico|webp|avif|pdf|drawio)$/i;

/**
 * Returns true only for paths the review policy treats as non-analyzable content.
 *
 * Keep this classification service-safe: executable content under evidence and
 * artifact directories remains analyzable, as do manifests and dependency files.
 */
export function isDocumentationOrAssetPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    (
      (normalized.startsWith('runs/') ||
        normalized.includes('/runs/') ||
        /^(evidence|artifacts)\//.test(normalized) ||
        /\/(evidence|artifacts)\//.test(normalized)) &&
      /\.(json|jsonl|ndjson|csv|tsv|log|xml|yaml|yml)$/i.test(normalized)
    ) ||
    DOCUMENTATION_OR_ASSET_EXTENSION.test(normalized)
  );
}

/**
 * A changed file the service accepts inside a no-reviewable-content completion:
 * documentation, an asset, a run artifact or data, or (REL-972) a dependency
 * lockfile whose added lines verifiably stay on the default public registries.
 *
 * This is a per-file admission check over the raw changed files, applied after
 * the shared `resolveReviewApplicability` decision has already reported the
 * exemption. It is not the same rule: that decision judges the post-filter
 * files, so it can also exempt a diff whose other files the filter dropped
 * (generated output, `path_filters` exclusions), which this check then refuses.
 * That pre-existing gap fails closed and is outside REL-972.
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
