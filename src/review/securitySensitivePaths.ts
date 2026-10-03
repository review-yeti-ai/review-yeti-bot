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

import {
  BUILD_SCRIPT_PATTERNS,
  CI_PATTERNS,
  CONTAINER_PATTERNS,
  DEPENDENCY_MANIFEST_PATTERNS,
  DEPENDENCY_MANIFESTS,
  IAC_PATTERNS,
  LOCKFILE_NAMES,
  LOCKFILE_PATTERNS,
  MIGRATION_PATTERNS,
  REPO_CONTROL_PATTERNS,
  SECRET_MATERIAL_PATTERNS,
  SENSITIVE_CAMEL_STEM,
  SENSITIVE_SEGMENT,
  SENSITIVE_STEM,
  TOOLCHAIN_PIN_NAMES,
} from './pathRiskTables';

/** Which arm of the predicate matched, for logs and disclosure. */
export type SecuritySensitivePathClass =
  | 'malformed'
  | 'ci'
  | 'container'
  | 'iac'
  | 'repo_control'
  | 'secret_material'
  | 'build_script'
  | 'migration'
  | 'lockfile'
  | 'toolchain_pin'
  | 'dependency_manifest'
  | 'auth_crypto_secrets';

// The tables themselves live in `./pathRiskTables.js`, shared with the GitHub Action pipeline.
// Edit them there; this module owns the predicate and its classification order.
function normalizePath(filePath: string): string {
  return filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function baseNameOf(normalized: string): string {
  return (normalized.split('/').pop() || normalized).toLowerCase();
}

export function isLockfilePath(filePath: string): boolean {
  const normalized = normalizePath(String(filePath || ''));
  return LOCKFILE_NAMES.has(baseNameOf(normalized)) || LOCKFILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isToolchainPinPath(filePath: string): boolean {
  return TOOLCHAIN_PIN_NAMES.has(baseNameOf(normalizePath(String(filePath || ''))));
}

export function isDependencyManifestPath(filePath: string): boolean {
  const normalized = normalizePath(String(filePath || ''));
  return DEPENDENCY_MANIFESTS.has(baseNameOf(normalized))
    || DEPENDENCY_MANIFEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

const CLASSED_PATTERNS: ReadonlyArray<readonly [SecuritySensitivePathClass, readonly RegExp[]]> = [
  ['ci', CI_PATTERNS],
  ['container', CONTAINER_PATTERNS],
  ['iac', IAC_PATTERNS],
  ['repo_control', REPO_CONTROL_PATTERNS],
  ['secret_material', SECRET_MATERIAL_PATTERNS],
  ['build_script', BUILD_SCRIPT_PATTERNS],
  ['migration', MIGRATION_PATTERNS],
];

/**
 * Which arm of the predicate a path matches, or null when it is not sensitive.
 * First match wins, so the answer is stable; being sensitive at all does not
 * depend on the order.
 */
export function securitySensitivePathClass(filePath: unknown): SecuritySensitivePathClass | null {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return 'malformed';
  const normalized = normalizePath(filePath);
  for (const [pathClass, patterns] of CLASSED_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(normalized))) return pathClass;
  }
  if (isLockfilePath(normalized)) return 'lockfile';
  if (isToolchainPinPath(normalized)) return 'toolchain_pin';
  if (isDependencyManifestPath(normalized)) return 'dependency_manifest';
  if (SENSITIVE_SEGMENT.test(normalized) || SENSITIVE_STEM.test(normalized) || SENSITIVE_CAMEL_STEM.test(normalized)) {
    return 'auth_crypto_secrets';
  }
  return null;
}

/**
 * True when a path must always be reviewed at full depth. Case-insensitive,
 * separator-normalized, and conservative: an empty or non-string path is
 * treated as sensitive so that malformed input never unlocks a reduction.
 */
export function isSecuritySensitivePath(filePath: unknown): boolean {
  return securitySensitivePathClass(filePath) !== null;
}

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
