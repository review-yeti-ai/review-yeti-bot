'use strict';

/**
 * The ONE definition of the path tables that decide how risky a changed path is: the
 * security-sensitive path policy (REL-1135, consumed through `securitySensitivePaths.ts`), the
 * review budget's CI/IaC and test ranks (`reviewBudget.ts`) and the documentation/asset and
 * data/config formats (`reviewableContent.ts`).
 *
 * Plain CommonJS with a sibling `.d.ts` (the same pattern as `laneInfrastructure.js` and
 * `reviewCore.js`) so BOTH review runtimes read these exact tables: the TypeScript worker/panel
 * modules above import them, and the composite GitHub Action's legacy pipeline
 * (`.github/workflows/pipelines/incremental-review-scope.js`, partition admission under the
 * assignment cap) requires this file directly. Never fork a table into either runtime; edit it here.
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
};
