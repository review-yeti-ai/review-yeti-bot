'use strict';

/**
 * The ONE definition of how risky a changed path is: the security-sensitive path predicate
 * (REL-1135, re-exported by `securitySensitivePaths.ts`), the toolchain-pin / dependency-manifest
 * predicate (`toolchainPinPaths.ts`), the documentation/asset and data/config predicates
 * (`reviewableContent.ts`) and the review budget's category and packing rank (`reviewBudget.ts`) --
 * the tables AND the classification order.
 *
 * Plain CommonJS with a sibling `.d.ts` (the same pattern as `laneInfrastructure.js` and
 * `reviewCore.js`) so BOTH review runtimes run this exact code: the TypeScript worker/panel
 * modules above re-export it, and the composite GitHub Action's legacy pipeline
 * (`.github/workflows/pipelines/incremental-review-scope.js`, partition admission under the
 * assignment cap) requires this file directly. Never fork a table or a predicate into either
 * runtime; edit it here.
 */

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
const CI_PATTERNS = [
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
const CONTAINER_PATTERNS = [
  /(^|\/)(docker|container)file[^/]*$/iu,
  /\.(docker|container)file$/iu,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/iu,
  /(^|\/)\.dockerignore$/iu,
  /(^|\/)procfile$/iu,
];

/** Infrastructure as code, Kubernetes, Helm, deploy manifests. */
const IAC_PATTERNS = [
  /\.(tf|tfvars|hcl|bicep|nix)$/iu,
  /(^|\/)(terraform|infra|infrastructure|k8s|kubernetes|helm|charts|clusters|deploy|deployment|deployments|manifests|kustomize|ansible|cloudformation|pulumi)\//iu,
  /(^|\/)kustomization\.ya?ml$/iu,
  /(^|\/)chart\.ya?ml$/iu,
];

/** Files that control how the repository itself is read, owned and fetched. */
const REPO_CONTROL_PATTERNS = [
  /(^|\/)\.gitattributes$/iu,
  /(^|\/)\.gitmodules$/iu,
  /(^|\/)codeowners$/iu,
];

/** Secret material and credential-bearing configuration. */
const SECRET_MATERIAL_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/iu,
  /(^|\/)\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc)$/iu,
  /\.(pem|key|crt|cer|p12|pfx|jks|keystore)$/iu,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/iu,
];

/** Build scripts and anything executed by tooling. */
const BUILD_SCRIPT_PATTERNS = [
  /(^|\/)(makefile|gnumakefile|justfile|rakefile|taskfile\.ya?ml|cmakelists\.txt)$/iu,
  /(^|\/)(scripts?|bin|hooks|\.husky)\//iu,
  /\.(sh|bash|zsh|ps1|bat|cmd)$/iu,
  /(^|\/)\.pnpmfile\.c?js$/iu,
];

/** Database migrations and schemas. */
const MIGRATION_PATTERNS = [
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
const LOCKFILE_PATTERNS = [
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

const DEPENDENCY_MANIFEST_PATTERNS = [
  /(^|\/)requirements[^/]*\.(txt|in)$/iu,
  /(^|\/)constraints[^/]*\.txt$/iu,
  /\.(csproj|fsproj|vbproj|gemspec|nuspec|cabal)$/iu,
  /(^|\/)directory\.packages\.props$/iu,
];

/** CI and infrastructure-as-code paths (W1 section 7.6) that the security list does not already name. */
const CI_IAC_PATTERNS = [
  /(^|\/)\.github\//iu,
  /(^|\/)\.gitlab-ci[^/]*$/iu,
  /(^|\/)jenkinsfile[^/]*$/iu,
  /(^|\/)\.(circleci|buildkite)\//iu,
  /\.(tf|tfvars|hcl)$/iu,
  /(^|\/)(helm|charts|k8s|kustomize|clusters|manifests|deploy|infra|terraform)\//iu,
  /(^|\/)chart\.ya?ml$/iu,
  /(^|\/)kustomization\.ya?ml$/iu,
  /(^|\/)dockerfile[^/]*$/iu,
  /(^|\/)docker-compose[^/]*\.ya?ml$/iu,
  // Versioned deployment records are packaging/compose provenance, not generic data config.
  // Anchor the exact repository-root layout and basename; nested/arbitrary config stays rank 2.
  /^ova\/versions\/[0-9]+(?:\.[0-9]+){2,}(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?\.(?:env|ya?ml|changelog\.json)$/iu,
  // Internal versioned release notes complete the same root-owned deployment record.
  /^release-notes\/internal\/[0-9]+(?:\.[0-9]+){2,}(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?\.md$/iu,
];

const TEST_PATTERNS = [
  /(^|\/)(tests?|__tests__|spec|specs|e2e|testdata|fixtures)\//iu,
  /[._](test|spec)\.[^/]+$/iu,
  /(^|\/)test_[^/]+\.py$/iu,
  /[a-z0-9]Tests?\.[^/]+$/u,
];

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

const DATA_OR_CONFIG_EXTENSION =
  /\.(json|jsonc|json5|jsonl|ndjson|ya?ml|toml|csv|tsv|xml|ini|cfg|conf|properties|env)$/i;
const DOTENV_CONFIG_FILE = /(?:^|\/)\.env(?:\.[^/]+)?$/i;

/**
 * Run artifacts: data and log formats under `runs/`, `evidence/` or `artifacts/` are recorded output,
 * not analyzable content (matched on the lower-cased, forward-slash path).
 */
const RUN_ARTIFACT_DIRECTORY = /(^|\/)runs\/|^(evidence|artifacts)\/|\/(evidence|artifacts)\//;
const RUN_ARTIFACT_EXTENSION = /\.(json|jsonl|ndjson|csv|tsv|log|xml|yaml|yml)$/i;

// ---------------------------------------------------------------------------
// Toolchain pins and dependency manifests without a data/config extension (REL-1136).
// They are never documentation: `isDocumentationOrAssetPath` checks this first.
// ---------------------------------------------------------------------------

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
function isToolchainPinOrDependencyManifestPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const basename = (filePath.replace(/\\/g, '/').split('/').pop() || '').toLowerCase();
  return TOOLCHAIN_PIN_OR_MANIFEST_BASENAMES.has(basename) || REQUIREMENTS_MANIFEST.test(basename);
}

// ---------------------------------------------------------------------------
// The security-sensitive path predicate (REL-1135).
// ---------------------------------------------------------------------------

function normalizePath(filePath) {
  return filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

function baseNameOf(normalized) {
  return (normalized.split('/').pop() || normalized).toLowerCase();
}

function isLockfilePath(filePath) {
  const normalized = normalizePath(String(filePath || ''));
  return LOCKFILE_NAMES.has(baseNameOf(normalized)) || LOCKFILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isToolchainPinPath(filePath) {
  return TOOLCHAIN_PIN_NAMES.has(baseNameOf(normalizePath(String(filePath || ''))));
}

function isDependencyManifestPath(filePath) {
  const normalized = normalizePath(String(filePath || ''));
  return DEPENDENCY_MANIFESTS.has(baseNameOf(normalized))
    || DEPENDENCY_MANIFEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

const CLASSED_PATTERNS = Object.freeze([
  ['ci', CI_PATTERNS],
  ['container', CONTAINER_PATTERNS],
  ['iac', IAC_PATTERNS],
  ['repo_control', REPO_CONTROL_PATTERNS],
  ['secret_material', SECRET_MATERIAL_PATTERNS],
  ['build_script', BUILD_SCRIPT_PATTERNS],
  ['migration', MIGRATION_PATTERNS],
]);

/**
 * Which arm of the predicate a path matches, or null when it is not sensitive.
 * First match wins, so the answer is stable; being sensitive at all does not
 * depend on the order.
 */
function securitySensitivePathClass(filePath) {
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
function isSecuritySensitivePath(filePath) {
  return securitySensitivePathClass(filePath) !== null;
}

// ---------------------------------------------------------------------------
// Documentation/asset and data/config predicates (REL-972).
// ---------------------------------------------------------------------------

/**
 * Returns true only for paths the review policy treats as non-analyzable content.
 *
 * Keep this classification service-safe: executable content under evidence and
 * artifact directories remains analyzable, as do manifests and dependency files.
 */
function isDocumentationOrAssetPath(filePath) {
  // REL-1136: a dependency manifest such as requirements.txt is never prose.
  if (isToolchainPinOrDependencyManifestPath(filePath)) return false;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return (RUN_ARTIFACT_DIRECTORY.test(normalized) && RUN_ARTIFACT_EXTENSION.test(normalized))
    || DOCUMENTATION_OR_ASSET_EXTENSION.test(normalized);
}

/** Structured data and configuration formats (see `reviewableContent.ts`). */
function isDataOrConfigPath(filePath) {
  return DATA_OR_CONFIG_EXTENSION.test(filePath) || DOTENV_CONFIG_FILE.test(filePath.replace(/\\/g, '/'));
}

// ---------------------------------------------------------------------------
// The review budget's category and packing rank (W5).
// ---------------------------------------------------------------------------

function classifyBudgetCategory(filePath) {
  if (isSecuritySensitivePath(filePath)) return 'security-sensitive';
  const path = filePath.replace(/\\/gu, '/');
  if (CI_IAC_PATTERNS.some((pattern) => pattern.test(path))) return 'ci-iac';
  if (TEST_PATTERNS.some((pattern) => pattern.test(path))) return 'test';
  if (isDocumentationOrAssetPath(path)) return 'docs';
  if (isDataOrConfigPath(path)) return 'config';
  return 'source';
}

/** Packing rank: 0 is always full depth; 1 and 2 may be summarized, 1 before 2. */
function budgetCategoryRank(category) {
  if (category === 'security-sensitive' || category === 'ci-iac') return 0;
  if (category === 'source') return 1;
  return 2;
}

/** `budgetCategoryRank(classifyBudgetCategory(path))`, for callers that only need the rank. */
function pathRiskRank(filePath) {
  return budgetCategoryRank(classifyBudgetCategory(filePath));
}

module.exports = {
  SENSITIVE_SEGMENT,
  SENSITIVE_STEM,
  SENSITIVE_CAMEL_STEM,
  CI_PATTERNS,
  CONTAINER_PATTERNS,
  IAC_PATTERNS,
  REPO_CONTROL_PATTERNS,
  SECRET_MATERIAL_PATTERNS,
  BUILD_SCRIPT_PATTERNS,
  MIGRATION_PATTERNS,
  LOCKFILE_NAMES,
  LOCKFILE_PATTERNS,
  TOOLCHAIN_PIN_NAMES,
  DEPENDENCY_MANIFESTS,
  DEPENDENCY_MANIFEST_PATTERNS,
  CI_IAC_PATTERNS,
  TEST_PATTERNS,
  DOCUMENTATION_OR_ASSET_EXTENSION,
  DATA_OR_CONFIG_EXTENSION,
  DOTENV_CONFIG_FILE,
  RUN_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_EXTENSION,
  isToolchainPinOrDependencyManifestPath,
  isLockfilePath,
  isToolchainPinPath,
  isDependencyManifestPath,
  securitySensitivePathClass,
  isSecuritySensitivePath,
  isDocumentationOrAssetPath,
  isDataOrConfigPath,
  classifyBudgetCategory,
  budgetCategoryRank,
  pathRiskRank,
};
