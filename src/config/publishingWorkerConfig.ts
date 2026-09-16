import { createDefaultV3Config } from './configLoader';
import type { CtReviewConfigV3, ProviderId } from './schema';
import { logger } from '../utils/logger';
import { loadCompiledIndex, type CompiledDomainIndex } from '../pipeline/domainIndex';

// Native publishing must project the same bounded turn/idle policy as the
// panel. Idle time is separate from the overall deadline enforced at runtime.
// 15 turns matches the central policy's max_investigation_turns so a caller
// policy cannot be silently clamped below its requested budget. The turn count
// is only an upper bound: the wall-clock overall deadline below remains the
// binding outer constraint.
export const PUBLISHING_MAX_TURNS = 15;
export const PUBLISHING_IDLE_TIMEOUT_SECONDS = 180;
export const PUBLISHING_OVERALL_TIMEOUT_SECONDS = 1800;

// REL-886: resolveWorkerConfig used to hardcode a single `bifrost` provider
// entry regardless of what the operator's REVIEW_YETI_REVIEW_MODEL projected,
// so `providersToTry` in panelEngine.ts could never contain more than one id
// and the panel's own retry-then-failover loop had nothing to fail over to.
// A required lane (sec-lane) that drew a transient HTTP-200-empty-completion
// response from the sole provider hard-aborted the run instead of advancing.
//
// The fix keeps the wire contract as one string -- REVIEW_MODEL / transport.model
// -- but lets it carry an ordered, comma-delimited fallback list. A bare single
// value (no comma) is the only shape ever deployed and produces the exact same
// one-provider config as before; this is intentionally the same env var so the
// k8s-operator and Zod-validated worker contract need no shape change.
export const PRIMARY_PROVIDER_ID = 'bifrost';

/**
 * Parse transport.model into an ordered, deduplicated list of model identifiers.
 * Entries are comma-delimited, trimmed, and empty segments (a stray leading,
 * trailing, or doubled comma) are dropped so they can never mint a hollow
 * provider. A single value with no comma parses to a one-element list.
 */
export function parseFallbackModelList(rawModel: string): string[] {
  const trimmedInput = String(rawModel || '').trim();
  const entries = trimmedInput
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // An empty/unset value is a caller contract violation (bifrostTransport
  // already refuses it before this runs), not this function's concern to
  // invent a provider for. Preserve the pre-fallback behaviour of always
  // returning exactly one entry -- even an empty string -- so this stays a
  // safe drop-in for the single-value call sites.
  if (entries.length === 0) return [trimmedInput];
  // Preserve the caller's fallback order; only collapse an accidental repeat
  // of the same model string so it cannot be retried against itself under a
  // different provider id.
  return Array.from(new Set(entries));
}

/** The primary provider keeps the stable `bifrost` id; each fallback gets an
 * ordinal suffix so panelEngine's provider lookups stay unambiguous. */
export function fallbackProviderId(index: number): ProviderId {
  return index === 0 ? PRIMARY_PROVIDER_ID : `${PRIMARY_PROVIDER_ID}-fallback-${index}`;
}

let cachedCompiledIndex: CompiledDomainIndex | null = null;

export function getCompiledDomainIndex(): CompiledDomainIndex | null {
  if (cachedCompiledIndex) return cachedCompiledIndex;
  try {
    cachedCompiledIndex = loadCompiledIndex();
    return cachedCompiledIndex;
  } catch (err) {
    logger.warn('Failed to load compiled domain index; falling back to open paths', { error: err });
    return null;
  }
}

export const STATIC_FALLBACK_ECOSYSTEM_PATHS: Record<string, string[]> = {
  dependencies: [
    '**/package.json',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/bun.lockb',
    '**/mix.exs',
    '**/mix.lock',
    '**/go.mod',
    '**/go.sum',
    '**/Cargo.toml',
    '**/Cargo.lock',
    '**/requirements*.txt',
    '**/pyproject.toml',
    '**/Pipfile*',
    '**/poetry.lock',
    '**/pom.xml',
    '**/build.gradle*',
    '**/*.gemspec',
    '**/Gemfile*',
    '**/*.lock',
    '**/*.csproj',
    '**/*.fsproj',
    '**/*.vbproj',
    '**/*.podspec',
  ],
  licensing: [
    '**/LICENSE*',
    '**/LICENCE*',
    '**/COPYING*',
    '**/NOTICE*',
    '**/package.json',
    '**/mix.exs',
    '**/pyproject.toml',
    '**/Cargo.toml',
    '**/go.mod',
    '**/*.md',
    '**/*.mdx',
    '**/*.rst',
    '**/*.adoc',
  ],
  testing: [
    '**/test/**',
    '**/tests/**',
    '**/spec/**',
    '**/specs/**',
    '**/*test*/**',
    '**/*spec*/**',
    '**/*.test.*',
    '**/*.spec.*',
    '**/*_test.*',
    '**/*_spec.*',
  ],
  performance: [
    '**/*.go',
    '**/*.ex',
    '**/*.exs',
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '**/*.py',
    '**/*.rs',
    '**/*.java',
    '**/*.sql',
    '**/*.c',
    '**/*.cpp',
  ],
  security: [
    '**/*.go',
    '**/*.ex',
    '**/*.exs',
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '**/*.py',
    '**/*.rs',
    '**/*.java',
    '**/*.sh',
    '**/*.bash',
    '**/*.zsh',
    '**/.github/workflows/**',
    '**/k8s/**',
    '**/helm/**',
    '**/Dockerfile*',
    '**/docker-compose*.yml',
  ],
  architecture: [
    '**/*.go',
    '**/*.ex',
    '**/*.exs',
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '**/*.py',
    '**/*.rs',
    '**/*.java',
    '**/docs/adr/**',
    '**/architecture/**',
  ],
  database: [
    '**/*.sql',
    '**/migrations/**',
    '**/priv/repo/migrations/**',
    '**/prisma/**',
    '**/schema.prisma',
  ],
  devops: [
    '**/.github/**',
    '**/k8s/**',
    '**/helm/**',
    '**/Dockerfile*',
    '**/docker-compose*.yml',
    '**/*.tf',
    '**/*.sh',
    '**/*.bash',
  ],
  style: [
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '**/*.go',
    '**/*.py',
    '**/*.rs',
    '**/*.ex',
    '**/*.exs',
    '**/*.css',
    '**/*.scss',
  ],
  documentation: [
    '**/*.md',
    '**/*.mdx',
    '**/*.rst',
    '**/*.adoc',
    '**/docs/**',
  ],
  accessibility: [
    '**/*.html',
    '**/*.htm',
    '**/*.css',
    '**/*.scss',
    '**/*.sass',
    '**/*.less',
    '**/*.tsx',
    '**/*.jsx',
    '**/*.vue',
    '**/*.svelte',
  ],
  i18n: [
    '**/*.po',
    '**/*.pot',
    '**/i18n/**',
    '**/locales/**',
    '**/locale/**',
    '**/*.properties',
    '**/strings.xml',
    '**/messages.json',
  ],
};

export function getPersonaEcosystemPaths(personaName: string, index?: CompiledDomainIndex | null): string[] {
  const canonicalMap: Record<string, string> = {
    'security': 'security',
    'sec-lane': 'security',
    'performance': 'performance',
    'perf-lane': 'performance',
    'architecture': 'architecture',
    'arch-lane': 'architecture',
    'testing': 'testing',
    'qual-lane': 'testing',
    'dependencies': 'dependencies',
    'dep-lane': 'dependencies',
    'licensing': 'licensing',
    'policy-lane': 'licensing',
    'devops': 'devops',
    'devops-lane': 'devops',
    'database': 'database',
    'db-lane': 'database',
    'style': 'style',
    'documentation': 'documentation',
    'accessibility': 'accessibility',
    'i18n': 'i18n',
  };
  const target = canonicalMap[personaName.toLowerCase().trim()] || personaName.toLowerCase().trim();

  const loadedIndex = index !== undefined ? index : getCompiledDomainIndex();
  if (!loadedIndex) {
    return STATIC_FALLBACK_ECOSYSTEM_PATHS[target] || ['**'];
  }

  const classes = new Set<string>();
  for (const [cls, personas] of Object.entries(loadedIndex.classes)) {
    if (personas.includes(target)) {
      classes.add(cls);
    }
  }

  if (classes.size === 0) {
    return STATIC_FALLBACK_ECOSYSTEM_PATHS[target] || ['**'];
  }

  const globs = new Set<string>();
  for (const eco of Object.values(loadedIndex.ecosystems)) {
    for (const cls of classes) {
      if (eco.classes[cls]) {
        for (const g of eco.classes[cls]) {
          globs.add(g);
        }
      }
    }
  }

  const result = Array.from(globs).sort();
  return result.length > 0 ? result : (STATIC_FALLBACK_ECOSYSTEM_PATHS[target] || ['**']);
}

export function resolveWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
  transport: { baseUrl: string; apiKey: string; model: string },
): CtReviewConfigV3 {
  const baseConfig = createDefaultV3Config();

  let maxInvestigationTurns = PUBLISHING_MAX_TURNS;
  let personasList: string[] = [];

  if (env.REVIEW_YETI_POLICY_JSON) {
    try {
      const raw = JSON.parse(env.REVIEW_YETI_POLICY_JSON);
      const policy = raw.review_yeti || raw;
      if (policy.budget?.max_investigation_turns) {
        maxInvestigationTurns = Number(policy.budget.max_investigation_turns);
      }
      if (typeof policy.personas === 'string') {
        personasList = policy.personas.split(',').map((p: string) => p.trim()).filter(Boolean);
      } else if (Array.isArray(policy.personas)) {
        personasList = policy.personas;
      }
    } catch (e) {
      logger.warn('Failed to parse REVIEW_YETI_POLICY_JSON', { error: e });
    }
  }

  if (personasList.length === 0 && env.REVIEW_PERSONAS) {
    personasList = env.REVIEW_PERSONAS.split(',').map((p) => p.trim()).filter(Boolean);
  }

  if (env.MAX_INVESTIGATION_TURNS) {
    const turns = Number(env.MAX_INVESTIGATION_TURNS);
    if (Number.isSafeInteger(turns) && turns > 0) {
      maxInvestigationTurns = turns;
    }
  }

  const default6 = ['security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing'];
  const effectivePersonaNames = personasList.length > 0 ? personasList : default6;

  const personaMap: Record<string, { id: string; required: boolean; charter: string }> = {
    'security': { id: 'sec-lane', required: true, charter: 'builtin:security' },
    'sec-lane': { id: 'sec-lane', required: true, charter: 'builtin:security' },
    'performance': { id: 'perf-lane', required: false, charter: 'builtin:performance' },
    'perf-lane': { id: 'perf-lane', required: false, charter: 'builtin:performance' },
    'architecture': { id: 'arch-lane', required: false, charter: 'builtin:constitutional-goals' },
    'arch-lane': { id: 'arch-lane', required: false, charter: 'builtin:constitutional-goals' },
    'testing': { id: 'qual-lane', required: false, charter: 'builtin:consistency' },
    'qual-lane': { id: 'qual-lane', required: false, charter: 'builtin:consistency' },
    'dependencies': { id: 'dep-lane', required: false, charter: 'builtin:dependency-health' },
    'dep-lane': { id: 'dep-lane', required: false, charter: 'builtin:dependency-health' },
    'contract': { id: 'contract-lane', required: false, charter: 'builtin:contract' },
    'contract-lane': { id: 'contract-lane', required: false, charter: 'builtin:contract' },
    'licensing': { id: 'policy-lane', required: false, charter: 'builtin:policy-compliance' },
    'policy-lane': { id: 'policy-lane', required: false, charter: 'builtin:policy-compliance' },
  };

  // Ordered fallback chain: index 0 is always the primary `bifrost` id so a
  // single-value REVIEW_MODEL (today's only deployed shape) resolves to the
  // exact same one-provider config this function has always produced.
  const modelList = parseFallbackModelList(transport.model);
  const providerIds: ProviderId[] = modelList.map((_, index) => fallbackProviderId(index));

  const personas = effectivePersonaNames.map((name) => {
    const key = name.toLowerCase().trim();
    const matched = personaMap[key] || {
      id: name,
      required: false,
      charter: 'builtin:correctness',
    };
    return {
      id: matched.id,
      enabled: true,
      required: matched.required,
      charter: matched.charter,
      paths: getPersonaEcosystemPaths(key),
      providers: providerIds,
    };
  });

  return {
    ...baseConfig,
    personas,
    default_max_turns: Math.min(PUBLISHING_MAX_TURNS, Math.max(1, maxInvestigationTurns || PUBLISHING_MAX_TURNS)),
    reviewer_effort: 'medium',
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: PUBLISHING_OVERALL_TIMEOUT_SECONDS,
      providers: providerIds.map((id, index) => ({
        id,
        enabled: true,
        model: modelList[index],
        effort: 'medium' as const,
        review_timeout_s: PUBLISHING_IDLE_TIMEOUT_SECONDS,
        arbiter_timeout_s: PUBLISHING_IDLE_TIMEOUT_SECONDS,
      })),
      arbiter: {
        order: providerIds,
      },
    },
    evidence: {
      zoekt: {
        enabled: true,
      },
    },
  };
}
