/**
 * Paths that always get full review depth, whatever any shrinking rule, budget
 * or classifier would otherwise decide (plan 2026-09-23, section 3, invariant 2).
 *
 * The list is deliberately broad: a false positive only costs tokens (the file
 * is reviewed in full, as it is today), while a false negative could let a
 * content-reducing rule hide an authentication, CI, container, infrastructure
 * or dependency change from the panel.
 *
 * Deterministic and path-only. File content is untrusted input and never
 * consulted here.
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

/** CI, container, infrastructure-as-code and repository-control paths. */
const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /^\.github\//iu,
  /(^|\/)\.gitlab-ci[^/]*$/iu,
  /(^|\/)\.circleci\//iu,
  /(^|\/)\.buildkite\//iu,
  /(^|\/)jenkinsfile[^/]*$/iu,
  /(^|\/)azure-pipelines[^/]*$/iu,
  /(^|\/)bitbucket-pipelines\.ya?ml$/iu,
  /(^|\/)\.drone\.ya?ml$/iu,
  /(^|\/)(docker|container)file[^/]*$/iu,
  /\.(docker|container)file$/iu,
  /(^|\/)(docker-)?compose[^/]*\.ya?ml$/iu,
  /(^|\/)\.dockerignore$/iu,
  /\.(tf|tfvars|hcl|bicep|nix)$/iu,
  /(^|\/)(terraform|infra|infrastructure|k8s|kubernetes|helm|charts|deploy|deployment|deployments|manifests|kustomize|ansible|cloudformation|pulumi)\//iu,
  /(^|\/)kustomization\.ya?ml$/iu,
  /(^|\/)\.gitattributes$/iu,
  /(^|\/)\.gitmodules$/iu,
  /(^|\/)codeowners$/iu,
  /(^|\/)\.env(\.[^/]*)?$/iu,
  /(^|\/)\.(npmrc|yarnrc|yarnrc\.yml|pypirc|netrc)$/iu,
  /\.(pem|key|crt|cer|p12|pfx|jks|keystore)$/iu,
  /(^|\/)(makefile|gnumakefile|justfile|rakefile|taskfile\.ya?ml)$/iu,
  /(^|\/)(scripts?|bin|hooks|\.husky)\//iu,
  /\.(sh|bash|zsh|ps1|bat|cmd)$/iu,
  /\.sql$/iu,
  /(^|\/)migrations?\//iu,
];

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
  'go.work',
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
]);

const DEPENDENCY_MANIFEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)requirements[^/]*\.(txt|in)$/iu,
  /\.(csproj|fsproj|vbproj|gemspec|nuspec|cabal)$/iu,
  /(^|\/)directory\.packages\.props$/iu,
];

export function isDependencyManifestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/gu, '/');
  const base = (normalized.split('/').pop() || normalized).toLowerCase();
  return DEPENDENCY_MANIFESTS.has(base) || DEPENDENCY_MANIFEST_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * True when a path must always be reviewed at full depth. Case-insensitive,
 * separator-normalized, and conservative: an empty or non-string path is
 * treated as sensitive so that malformed input never unlocks a reduction.
 */
export function isSecuritySensitivePath(filePath: unknown): boolean {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return true;
  const normalized = filePath.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (isDependencyManifestPath(normalized)) return true;
  return SENSITIVE_SEGMENT.test(normalized) || SENSITIVE_STEM.test(normalized) || SENSITIVE_CAMEL_STEM.test(normalized);
}
