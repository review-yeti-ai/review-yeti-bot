/**
 * THE security-sensitive path predicate (REL-1135). Every consumer that decides
 * review depth, fast-ship eligibility or security routing imports it from here:
 * diff shrink (W2), budget packing (W5, and map-reduce through it), the
 * fast-ship guard and security-lane gate in the panel, the preflight MCP tool,
 * and the Jev triage shadow's `security_sensitive` fact. There is no second
 * list; before REL-1135 there were three, and the one that decided depth had no
 * lockfiles and no toolchain pins (ct-meta ADRs 0685 and 0688).
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

/** Directory or file-name segments that name security-relevant code. */
const SENSITIVE_SEGMENT =
  /(^|[/._-])(auth|authn|authz|oauth2?|oidc|saml|sso|login|logout|session|sessions|passw(or)?d|passwd|credentials?|secrets?|tokens?|jwt|jwks|crypto|cryptography|cipher|encrypt|encryption|decrypt|signing|signature|signer|certs?|certificates?|tls|ssl|x509|keys?|keystore|keychain|permissions?|rbac|acl|policy|policies|sandbox|csrf|cors|security|sanitize|sanitizer|webhook|webhooks)([/._-]|$)/iu;

/**
 * Stems that name security code as a prefix of a longer word: `authentication`,
 * `authorize`, `passwords`, `encryption`, `credentialStore`. Matched at the
 * start of a path segment or name part, with any continuation (`author` is the
 * one common non-security word excluded).
 */
const SENSITIVE_STEM =
  /(^|[/._-])(auth(?!or(?:s|ed|ing|ship)?(?![a-z]))|oauth|passw|credential|secret|crypt|encrypt|decrypt|cipher|certif|permission|privilege|session|login|logout|signin|signon|sso|saml|oidc|jwt|token|csrf|xsrf|sanitiz|security|secure|policy|policies|rbac|acl|keystore|keychain|sandbox)/iu;

/** The same stems at a camelCase boundary: `userAuthService.ts`, `loadSecrets.go`. */
const SENSITIVE_CAMEL_STEM =
  /[a-z0-9](Auth(?!or(?:s|ed|ing|ship)?(?![a-z]))|OAuth|Passw|Credential|Secret|Crypt|Encrypt|Decrypt|Cipher|Certif|Permission|Privilege|Session|Login|Logout|SignIn|Signin|Token|Csrf|Sanitiz|Security|Secure|Policy|Policies|Rbac|Acl|Keystore|Keychain|Sandbox)/u;

/** CI/CD pipelines and reusable actions. */
const CI_PATTERNS: readonly RegExp[] = [
  /^\.github\//iu,
  /(^|\/)\.github\/(workflows|actions)\//iu,
  /(^|\/)\.gitlab-ci[^/]*$/iu,
  /(^|\/)\.gitlab\//iu,
  /(^|\/)\.circleci\//iu,
  /(^|\/)\.buildkite\//iu,
  /(^|\/)jenkinsfile[^/]*$/iu,
  /(^|\/)azure-pipelines[^/]*$/iu,
  /(^|\/)bitbucket-pipelines\.ya?ml$/iu,
  /(^|\/)\.drone\.ya?ml$/iu,
  /(^|\/)cloudbuild[^/]*\.(ya?ml|json)$/iu,
  // A composite or JavaScript action anywhere in the tree (not only under .github/).
  /(^|\/)action\.ya?ml$/iu,
];

/** Container definitions. */
const CONTAINER_PATTERNS: readonly RegExp[] = [
  /(^|\/)(docker|container)file[^/]*$/iu,
  /\.(docker|container)file$/iu,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/iu,
  /(^|\/)\.dockerignore$/iu,
  /(^|\/)procfile$/iu,
];

/** Infrastructure as code, Kubernetes, Helm, deploy manifests. */
const IAC_PATTERNS: readonly RegExp[] = [
  /\.(tf|tfvars|hcl|bicep|nix)$/iu,
  /(^|\/)(terraform|infra|infrastructure|k8s|kubernetes|helm|charts|clusters|deploy|deployment|deployments|manifests|kustomize|ansible|cloudformation|pulumi)\//iu,
  /(^|\/)kustomization\.ya?ml$/iu,
  /(^|\/)chart\.ya?ml$/iu,
];

/** Files that control how the repository itself is read, owned and fetched. */
const REPO_CONTROL_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.gitattributes$/iu,
  /(^|\/)\.gitmodules$/iu,
  /(^|\/)codeowners$/iu,
];

/** Secret material and credential-bearing configuration. */
const SECRET_MATERIAL_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/iu,
  /(^|\/)\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc)$/iu,
  /\.(pem|key|crt|cer|p12|pfx|jks|keystore)$/iu,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/iu,
];

/** Build scripts and anything executed by tooling. */
const BUILD_SCRIPT_PATTERNS: readonly RegExp[] = [
  /(^|\/)(makefile|gnumakefile|justfile|rakefile|taskfile\.ya?ml|cmakelists\.txt)$/iu,
  /(^|\/)(scripts?|bin|hooks|\.husky)\//iu,
  /\.(sh|bash|zsh|ps1|bat|cmd)$/iu,
  /(^|\/)\.pnpmfile\.c?js$/iu,
];

/** Database migrations and schemas. */
const MIGRATION_PATTERNS: readonly RegExp[] = [
  /\.sql$/iu,
  /(^|\/)migrations?\//iu,
  /\.prisma$/iu,
  /(^|\/)db\/schema\.rb$/iu,
];

/**
 * Lockfiles: the exact third-party code a build installs. A lockfile change can
 * swap a registry, a tarball URL or an integrity hash without touching a
 * manifest, so it is never shrunk, summarized or collapsed (ADR 0685).
 */
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'go.sum',
  'go.work.sum',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'pdm.lock',
  'uv.lock',
  'gemfile.lock',
  'mix.lock',
  'composer.lock',
  'podfile.lock',
  'pubspec.lock',
  'package.resolved',
  'packages.lock.json',
  'gradle.lockfile',
  'flake.lock',
  'conan.lock',
  'vcpkg-lock.json',
]);

/** Any other `*.lock`, `*-lock.json`, `*-lock.yaml` or `*.sum` (the ADR 0685/0688 union arm). */
const LOCKFILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)[^/]*(\.lock|\.lockb|-lock\.json|-lock\.ya?ml|\.sum|\.lockfile)$/iu,
];

/**
 * Toolchain pins: which compiler, runtime or package manager builds the code.
 * Changing one changes what executes as surely as a dependency bump does.
 */
const TOOLCHAIN_PIN_NAMES = new Set([
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
  'mise.toml',
  '.mise.toml',
  'global.json',
  'go.work',
]);

/** Dependency manifests: the file that decides what third-party code runs. */
const DEPENDENCY_MANIFESTS = new Set([
  'package.json',
  'requirements.txt',
  'requirements-dev.txt',
  'constraints.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'pipfile',
  'go.mod',
  'cargo.toml',
  'gemfile',
  'mix.exs',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'package.swift',
  'podfile',
  'pubspec.yaml',
  'deno.json',
  'bunfig.toml',
  'vcpkg.json',
  'conanfile.txt',
  'conanfile.py',
  'packages.config',
]);

const DEPENDENCY_MANIFEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)requirements[^/]*\.(txt|in)$/iu,
  /(^|\/)constraints[^/]*\.txt$/iu,
  /\.(csproj|fsproj|vbproj|gemspec|nuspec|cabal)$/iu,
  /(^|\/)directory\.packages\.props$/iu,
];

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
 * above, and every fast-ship check also applies that predicate, so the screen
 * is always a superset of it.
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

/** The fast-ship screen: the canonical predicate OR any coarse substring token. */
export function blocksFastShipByPath(filePath: string): boolean {
  if (isSecuritySensitivePath(filePath)) return true;
  const lower = String(filePath).toLowerCase();
  return FAST_SHIP_BLOCKED_PATH_SUBSTRINGS.some((token) => lower.includes(token));
}
