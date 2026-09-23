/**
 * Prose documentation formats and static image/diagram assets.
 *
 * REL-1058: `.mdx` (Docusaurus/VitePress/Nextra pages) and `.mdoc` (Markdoc)
 * are Markdown documentation; `.asciidoc` is the long form of `.adoc`; `.webp`
 * and `.avif` are image assets. Missing them made a docs-only pull request
 * look like unmatched source and fail every review deterministically.
 *
 * Deliberately NOT listed: `.mdc` (Cursor rule files are agent operating
 * policy, not prose documentation) and anything that can execute or configure
 * a build.
 */
const DOCUMENTATION_OR_ASSET_EXTENSION =
  /\.(md|markdown|mdx|mdoc|txt|rst|adoc|asciidoc|png|jpg|jpeg|gif|svg|ico|webp|avif|pdf|drawio)$/i;

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
