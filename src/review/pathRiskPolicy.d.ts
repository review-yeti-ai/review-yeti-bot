/** The one definition of path risk (tables, predicates and order); see `pathRiskPolicy.js`. */
export const SENSITIVE_SEGMENT: RegExp;
export const SENSITIVE_STEM: RegExp;
export const SENSITIVE_CAMEL_STEM: RegExp;
export const CI_PATTERNS: readonly RegExp[];
export const CONTAINER_PATTERNS: readonly RegExp[];
export const IAC_PATTERNS: readonly RegExp[];
export const REPO_CONTROL_PATTERNS: readonly RegExp[];
export const SECRET_MATERIAL_PATTERNS: readonly RegExp[];
export const BUILD_SCRIPT_PATTERNS: readonly RegExp[];
export const MIGRATION_PATTERNS: readonly RegExp[];
export const LOCKFILE_NAMES: ReadonlySet<string>;
export const LOCKFILE_PATTERNS: readonly RegExp[];
export const TOOLCHAIN_PIN_NAMES: ReadonlySet<string>;
export const DEPENDENCY_MANIFESTS: ReadonlySet<string>;
export const DEPENDENCY_MANIFEST_PATTERNS: readonly RegExp[];
export const CI_IAC_PATTERNS: readonly RegExp[];
export const TEST_PATTERNS: readonly RegExp[];
export const DOCUMENTATION_OR_ASSET_EXTENSION: RegExp;
export const DATA_OR_CONFIG_EXTENSION: RegExp;
export const DOTENV_CONFIG_FILE: RegExp;
export const RUN_ARTIFACT_DIRECTORY: RegExp;
export const RUN_ARTIFACT_EXTENSION: RegExp;

export type SecuritySensitivePathClass =
  | 'malformed' | 'ci' | 'container' | 'iac' | 'repo_control' | 'secret_material' | 'build_script'
  | 'migration' | 'lockfile' | 'toolchain_pin' | 'dependency_manifest' | 'auth_crypto_secrets';
export type PathBudgetCategory = 'security-sensitive' | 'ci-iac' | 'source' | 'test' | 'config' | 'docs';

export function isToolchainPinOrDependencyManifestPath(filePath: string): boolean;
export function isLockfilePath(filePath: string): boolean;
export function isToolchainPinPath(filePath: string): boolean;
export function isDependencyManifestPath(filePath: string): boolean;
export function securitySensitivePathClass(filePath: unknown): SecuritySensitivePathClass | null;
export function isSecuritySensitivePath(filePath: unknown): boolean;
export function isDocumentationOrAssetPath(filePath: string): boolean;
export function isDataOrConfigPath(filePath: string): boolean;
export function classifyBudgetCategory(filePath: string): PathBudgetCategory;
export function budgetCategoryRank(category: PathBudgetCategory): 0 | 1 | 2;
export function pathRiskRank(filePath: string): 0 | 1 | 2;
