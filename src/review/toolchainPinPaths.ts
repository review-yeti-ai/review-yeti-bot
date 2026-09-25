/**
 * REL-1136: toolchain pin files and dependency manifests whose names carry no
 * data/config extension.
 *
 * `.tool-versions` (calltelemetry/cisco-cdr#4625), `.nvmrc`, `go.mod` and the
 * like pick the compiler, runtime or dependency set a build uses. They are not
 * source, not documentation and not data/config by extension, so a diff that
 * changed only one of them matched no persona and failed "no enabled persona
 * applies". They change what runs, so they are routed to the roster's required
 * lane (see `isFallbackRoutedFile`) -- reviewed, never exempted.
 *
 * `requirements*.txt` / `constraints*.txt` carry a `.txt` extension, which the
 * documentation rule would otherwise exempt as prose. A dependency manifest is
 * never documentation (`isDocumentationOrAssetPath` checks this first).
 *
 * Lockfiles are not listed: the hunk filter owns them (`classifyLockfileOrGeneratedPath`),
 * and a lockfile that adds a package is routed by `newPackageLockfileReview`.
 */
const TOOLCHAIN_PIN_OR_MANIFEST_BASENAMES = new Set([
  // Toolchain / runtime version pins.
  '.tool-versions',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.ruby-version',
  '.java-version',
  '.go-version',
  '.bun-version',
  '.terraform-version',
  '.sdkmanrc',
  'rust-toolchain',
  'rust-toolchain.toml',
  // Dependency manifests and pins without a data/config extension.
  'go.mod',
  'go.work',
  'gemfile',
  'pipfile',
  '.terraform.lock.hcl',
]);

const REQUIREMENTS_MANIFEST = /^(?:requirements|constraints)(?:[._-][\w.-]*)?\.(?:txt|in)$/u;

/** The file pins a toolchain version or declares dependencies (REL-1136). */
export function isToolchainPinOrDependencyManifestPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const basename = (filePath.replace(/\\/g, '/').split('/').pop() || '').toLowerCase();
  return TOOLCHAIN_PIN_OR_MANIFEST_BASENAMES.has(basename) || REQUIREMENTS_MANIFEST.test(basename);
}
