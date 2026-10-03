/**
 * REL-1136: toolchain pin files and dependency manifests whose names carry no
 * data/config extension.
 *
 * `.tool-versions` (exampleorg/example-api#4625), `.nvmrc`, `go.mod` and the
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
// The basenames and the predicate live in `./pathRiskPolicy.js`, shared with the GitHub Action
// pipeline's partition admission. Edit them there.
export { isToolchainPinOrDependencyManifestPath } from './pathRiskPolicy';
