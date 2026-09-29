/** Shared deterministic path-domain rules used by the reviewer and trusted gate. */

export type DomainLane =
  | 'security_auth'
  | 'data_persistence'
  | 'api_contracts'
  | 'system_runtime'
  | 'ui_frontend'
  | 'docs_assets';

export const DOMAIN_LANES: readonly DomainLane[] = [
  'security_auth',
  'data_persistence',
  'api_contracts',
  'system_runtime',
  'ui_frontend',
  'docs_assets',
] as const;

/**
 * Safe extensions that cannot execute arbitrary code and are purely documentation, markup, or static imagery.
 * Note: .txt is excluded from blanket safe extensions.
 * Note: .adoc and .rst are inspected for build-time directives.
 */
export const SAFE_DOC_OR_ASSET_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdown', '.mkdn',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.bmp',
]);

/**
 * Safe standalone configuration or legal files that carry no executable code, CI logic, or secrets.
 */
export const SAFE_STANDALONE_FILENAMES = new Set([
  'license', 'license.md', 'license.txt',
  'notice', 'notice.md', 'notice.txt',
  '.gitignore', '.gitattributes', '.prettierignore', '.eslintignore', '.editorconfig',
]);

/**
 * Harmless .txt basenames explicitly allowed for fast-ship.
 */
export const SAFE_TXT_BASENAMES = new Set([
  'robots.txt',
  'humans.txt',
  'license.txt',
  'notice.txt',
  'security.txt',
]);

/**
 * Classify a changed file path into a primary domain lane using deterministic heuristics.
 * Zero-token, instant, fail-closed classification.
 */
export function classifyPathByHeuristic(filePath: string): DomainLane {
  const p = (filePath || '').toLowerCase().replace(/\\/g, '/').trim();
  if (!p) return 'system_runtime';

  const baseName = p.split('/').pop() || p;
  const dotIdx = baseName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? baseName.slice(dotIdx) : '';

  // 1. Explicit secrets, keys, credentials, and environment files
  if (
    p.includes('.env') ||
    baseName === '.npmrc' ||
    baseName === '.pypirc' ||
    p.includes('id_rsa') ||
    p.includes('id_ed25519') ||
    ext === '.crt' ||
    ext === '.pem' ||
    ext === '.key' ||
    /(^|\/|\.|_|-)(secret|credential|password|keychain)($|\/|\.|_|-)/i.test(p)
  ) {
    return 'security_auth';
  }

  // Prose is not an auth surface. A path token such as "session" in
  // session-skill-retro/SKILL.md must not force the security floor. Real
  // policy manifests stay on the token rule below because they are not
  // markdown or images.
  if (SAFE_DOC_OR_ASSET_EXTENSIONS.has(ext)) {
    return 'docs_assets';
  }

  // Pure docs and assets: if under docs/ or an asset/markdown extension, non-executable files belong in docs_assets
  const isDocOrAsset =
    (p.startsWith('docs/') || p.startsWith('documentation/') || p.startsWith('assets/')) &&
    !/\.(sh|bash|py|rb|js|ts|pl)$/i.test(baseName);
  if (isDocOrAsset && (SAFE_DOC_OR_ASSET_EXTENSIONS.has(ext) || ext === '')) {
    return 'docs_assets';
  }

  // 2. Security & Auth logic (tokens, keys, auth controllers, crypto, policies, netpols, Elixir plugs/routers/sessions)
  if (
    /(^|\/|\.|_|-)(auth|oauth|crypto|rbac|permission|firewall|netpol|security|session|login|jwt|cookie|csrf|cors|sanitize|middleware|webhook|hmac|sso|sudo|guard|policy|policies)($|\/|\.|_|-)/i.test(p) ||
    baseName === 'router.ex' ||
    p.endsWith('/router.ex') ||
    p.includes('/plug/') ||
    p.includes('/plugs/') ||
    baseName.includes('plug') ||
    /(^|\/|\.|_|-)(token|tokens|cert|certs|certificate|certificates)($|\/|\.|_|-)/i.test(p)
  ) {
    return 'security_auth';
  }

  // 2. Database & Data Persistence (SQL, migrations, Ecto schemas, Prisma, models)
  if (
    p.includes('/repo/') ||
    p.includes('/schema/') ||
    p.includes('/schemas/') ||
    p.includes('/migration/') ||
    p.includes('/migrations/') ||
    p.includes('/db/') ||
    p.includes('/database/') ||
    p.includes('/sql/') ||
    p.includes('/entity/') ||
    p.includes('/entities/') ||
    p.includes('/models/') ||
    p.includes('/model/') ||
    p.includes('/timescale/') ||
    p.includes('/cagg/') ||
    p.includes('priv/repo/') ||
    ext === '.sql' ||
    ext === '.prisma' ||
    ext === '.cql'
  ) {
    return 'data_persistence';
  }

  // 3. API & Contracts (REST, GraphQL, Protobuf, OpenAPI, router)
  if (
    p.includes('/api/') ||
    p.includes('/routes/') ||
    p.includes('/router/') ||
    p.includes('/controllers/') ||
    p.includes('/controller/') ||
    p.includes('/endpoints/') ||
    p.includes('/proto/') ||
    p.includes('/contracts/') ||
    ext === '.proto' ||
    ext === '.graphql' ||
    baseName.includes('openapi') ||
    baseName.includes('swagger')
  ) {
    return 'api_contracts';
  }

  // 4. UI & Frontend (Components, styling, templates, views, Phoenix LiveView/HEEx)
  if (
    p.includes('/assets/') ||
    p.includes('/static/') ||
    p.includes('/web/') ||
    p.includes('/ui/') ||
    p.includes('/components/') ||
    p.includes('/pages/') ||
    p.includes('/views/') ||
    p.includes('/styles/') ||
    p.includes('/css/') ||
    p.includes('/live/') ||
    ext === '.tsx' ||
    ext === '.jsx' ||
    ext === '.vue' ||
    ext === '.svelte' ||
    ext === '.heex' ||
    ext === '.leex' ||
    ext === '.eex' ||
    ext === '.css' ||
    ext === '.scss' ||
    ext === '.sass' ||
    ext === '.less' ||
    ext === '.html'
  ) {
    return 'ui_frontend';
  }

  // 5. Docs and static non-executable assets
  if (
    SAFE_DOC_OR_ASSET_EXTENSIONS.has(ext) ||
    SAFE_STANDALONE_FILENAMES.has(baseName) ||
    SAFE_TXT_BASENAMES.has(baseName) ||
    p.startsWith('docs/') ||
    p.includes('/docs/') ||
    ext === '.svg' ||
    ext === '.pdf' ||
    ext === '.eps'
  ) {
    return 'docs_assets';
  }

  // 6. System & Runtime (Default fallback)
  return 'system_runtime';
}

/**
 * Classify a batch of changed files into domain lanes.
 */
export function classifyDomainLanesByHeuristic(
  files: Array<{ path?: string; filePath?: string }>
): Record<string, DomainLane> {
  const result: Record<string, DomainLane> = {};
  for (const f of files) {
    const rawPath = f.path || f.filePath || '';
    if (!rawPath) continue;
    result[rawPath] = classifyPathByHeuristic(rawPath);
  }
  return result;
}
