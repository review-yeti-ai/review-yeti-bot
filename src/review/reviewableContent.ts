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
const DATA_OR_CONFIG_EXTENSION =
  /\.(json|jsonc|json5|jsonl|ndjson|ya?ml|toml|csv|tsv|xml|ini|cfg|conf|properties)$/i;

export function isDataOrConfigPath(filePath: string): boolean {
  return DATA_OR_CONFIG_EXTENSION.test(filePath);
}

/**
 * A changed file the service accepts inside a no-reviewable-content completion:
 * documentation, an asset, a run artifact or data, or (REL-972) a dependency
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
