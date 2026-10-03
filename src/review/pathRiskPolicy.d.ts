/** The one definition of path risk (tables, predicates and classification order); see `pathRiskPolicy.js`.
 * Declares exactly the module's exports; tests/unit/incrementalReviewScope.test.ts enforces that. */
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
