/**
 * THE security-sensitive path predicate (REL-1135). Every consumer that decides
 * review depth, fast-ship eligibility or security routing imports it from here:
 * diff shrink (W2), budget packing (W5, and map-reduce through it), the
 * fast-ship guard and security-lane gate in the panel, the preflight MCP tool,
 * and the Jev triage shadow's `security_sensitive` fact. There is no second
 * list; before REL-1135 there were three, and the one that decided depth had no
 * lockfiles and no toolchain pins (example-meta ADRs 0685 and 0688).
 *
 * Paths that always get full review depth, whatever any shrinking rule, budget
 * or classifier would otherwise decide (plan 2026-09-23, section 3, invariant 2).
 *
 * The list is deliberately broad: a false positive only costs tokens (the file
 * is reviewed in full, as it is today), while a false negative could let a
 * content-reducing rule hide an authentication, CI, container, infrastructure,
 * dependency or toolchain change from the panel.
 *
 * Deterministic and path-only. File content is untrusted input and never
 * consulted here.
 */


// The predicate itself -- tables, classification order and the arm that matched -- lives in
// `./pathRiskPolicy.js`, which the GitHub Action pipeline also requires, so both review runtimes
// run one implementation. Edit it there.
export {
  isDependencyManifestPath,
  isLockfilePath,
  isSecuritySensitivePath,
  isToolchainPinPath,
  securitySensitivePathClass,
  type SecuritySensitivePathClass,
} from './pathRiskPolicy';

/**
 * The fast-ship screen's substring tokens (moved here from `classifierEngine`
 * so every path-sensitivity rule lives in this one module). Deliberately
 * coarser than `isSecuritySensitivePath`: it only decides whether a change may
 * skip the panel entirely, so an over-match (`monkey.ts` contains `key`) costs a
 * review, never coverage. It is NOT a depth rule; depth uses the predicate
 * above.
 *
 * How fast-ship composes (both surfaces, the panel's
 * `containsExecutableOrSensitiveCode` and the preflight MCP tool, follow it):
 * only a prose/asset file (safe extension) or a safe standalone file can be
 * fast-ship eligible at all, and such a file is then refused only by this
 * substring screen (`blocksFastShipByPath`). Every other file -- which covers
 * every non-prose path the predicate flags: lockfiles, pins, manifests, CI,
 * IaC, source -- is never eligible. The one deliberate exception to "the
 * predicate blocks fast-ship" is prose on a sensitive-sounding path
 * (`docs/login.md`): it is not an executable surface.
 */
export const FAST_SHIP_BLOCKED_PATH_SUBSTRINGS: readonly string[] = [
  // CI/CD pipelines and automation
  '.github', '.gitlab', '.circleci', 'jenkinsfile', 'cloudbuild', 'buildkite',
  'workflow', 'pipeline',
  // Credentials, secrets, environment variables
  '.env', 'secret', 'credential', 'token', 'password', 'key', 'cert', 'pem',
  'id_rsa', 'id_ed25519', '.npmrc', '.pypirc',
  // Authentication, security, migrations, database schemas
  'auth', 'security', 'migration', 'schema',
  // Containers and infrastructure orchestration
  'dockerfile', 'docker-compose', 'k8s', 'kubernetes', 'helm',
  // Scripts and build systems
  'bin/', 'scripts/', 'script/', 'tools/',
  'makefile', 'rakefile', 'procfile',
];

/** The fast-ship substring screen for otherwise-eligible (prose/asset/safe standalone) files. */
export function blocksFastShipByPath(filePath: string): boolean {
  const lower = String(filePath).toLowerCase();
  return FAST_SHIP_BLOCKED_PATH_SUBSTRINGS.some((token) => lower.includes(token));
}
