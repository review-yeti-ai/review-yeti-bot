import { createDefaultV3Config, isTriggerActionAllowed, type TriggerActionOptions } from './configLoader';
import type { ComposedEngineConfig, CtReviewConfigV3, ProviderId, ReviewEngineName } from './schema';
import { logger } from '../utils/logger';
import { loadCompiledIndex, type CompiledDomainIndex } from '../pipeline/domainIndex';

export { isTriggerActionAllowed, type TriggerActionOptions };

// Native publishing must project the same bounded turn/idle policy as the
// panel. Idle time is separate from the overall deadline enforced at runtime.
// 15 turns matches the central policy's max_investigation_turns so a caller
// policy cannot be silently clamped below its requested budget. The turn count
// is only an upper bound: the wall-clock overall deadline below remains the
// binding outer constraint.
export const PUBLISHING_MAX_TURNS = 15;
export const PUBLISHING_IDLE_TIMEOUT_SECONDS = 180;
export const PUBLISHING_OVERALL_TIMEOUT_SECONDS = 1800;

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

const VALID_REVIEW_ENGINES: ReadonlySet<string> = new Set(['panel', 'composed', 'shadow']);

/** The cutover default is the composed engine. Only the exact literals `panel` and `shadow`
 * select something else. An absent key, a typo, or the wrong type stays on composed, so a
 * malformed policy cannot quietly restore the fan-out. */
function normalizeReviewEngine(value: unknown): ReviewEngineName {
  if (value === 'panel' || value === 'shadow' || value === 'composed') return value;
  return 'composed';
}

function positiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Projects the optional `composed` policy block. Every field is independently validated and
 * omitted (not defaulted) when absent or malformed -- `composedEngine.ts` owns its own defaults
 * and hard caps and clamps any value projected here against them. */
function normalizeComposedOverrides(value: unknown): ComposedEngineConfig {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const overrides: ComposedEngineConfig = {};
  const maxTasks = positiveInt(raw.max_tasks);
  if (maxTasks !== undefined) overrides.max_tasks = maxTasks;
  const maxTurnsTotal = positiveInt(raw.max_turns_total);
  if (maxTurnsTotal !== undefined) overrides.max_turns_total = maxTurnsTotal;
  const maxTurnsPerTask = positiveInt(raw.max_turns_per_task);
  if (maxTurnsPerTask !== undefined) overrides.max_turns_per_task = maxTurnsPerTask;
  if (Array.isArray(raw.task_dimensions) && raw.task_dimensions.length > 0
    && raw.task_dimensions.every((d) => typeof d === 'string' && d.length > 0)) {
    overrides.task_dimensions = raw.task_dimensions as string[];
  }
  return overrides;
}

export function resolveWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
  transport: { baseUrl: string; apiKey: string; model: string },
): CtReviewConfigV3 {
  const baseConfig = createDefaultV3Config();

  let maxInvestigationTurns = PUBLISHING_MAX_TURNS;
  let personasList: string[] = [];
  let reviewEngine: ReviewEngineName = 'composed';
  let composed: ComposedEngineConfig = {};

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
      reviewEngine = normalizeReviewEngine(policy.review_engine);
      composed = normalizeComposedOverrides(policy.composed);
    } catch (e) {
      // A policy WAS supplied (this branch only runs when REVIEW_YETI_POLICY_JSON is present) but
      // could not be parsed. Falling through here would leave `reviewEngine` at its `'panel'`
      // initializer and `personasList` empty -- i.e. the default6 fan-out roster below -- which is
      // exactly the trap this guards against: a corrupted or tampered policy that asked for the
      // composed engine (or a narrowed persona roster) would silently come back as a full six-lane
      // fan-out panel instead of the engine and roster the policy actually specified. This is the
      // authoritative projection path (see `preparePublishingPolicy` in
      // `src/review/preparedPublishingPolicy.ts`); a caller that cannot verify what the policy
      // said must refuse to guess at a default, not fail open to one.
      logger.error('Failed to parse REVIEW_YETI_POLICY_JSON; refusing to substitute a default review engine or persona roster', {
        error: e instanceof Error ? e.message : String(e),
      });
      throw new Error('review policy could not be parsed; refusing to fail open to a default review engine or persona roster');
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
    'architecture': { id: 'arch-lane', required: false, charter: 'builtin:architecture' },
    'arch-lane': { id: 'arch-lane', required: false, charter: 'builtin:architecture' },
    'testing': { id: 'qual-lane', required: false, charter: 'builtin:consistency' },
    'qual-lane': { id: 'qual-lane', required: false, charter: 'builtin:consistency' },
    'dependencies': { id: 'dep-lane', required: false, charter: 'builtin:dependency-health' },
    'dep-lane': { id: 'dep-lane', required: false, charter: 'builtin:dependency-health' },
    'contract': { id: 'contract-lane', required: false, charter: 'builtin:contract' },
    'contract-lane': { id: 'contract-lane', required: false, charter: 'builtin:contract' },
    'licensing': { id: 'policy-lane', required: false, charter: 'builtin:policy-compliance' },
    'policy-lane': { id: 'policy-lane', required: false, charter: 'builtin:policy-compliance' },
  };

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
      providers: ['bifrost'] as ProviderId[],
    };
  });

  return {
    ...baseConfig,
    personas,
    review_engine: reviewEngine,
    composed,
    default_max_turns: Math.min(PUBLISHING_MAX_TURNS, Math.max(1, maxInvestigationTurns || PUBLISHING_MAX_TURNS)),
    reviewer_effort: 'medium',
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: PUBLISHING_OVERALL_TIMEOUT_SECONDS,
      providers: [
        {
          id: 'bifrost' as ProviderId,
          enabled: true,
          model: transport.model,
          effort: 'medium',
          review_timeout_s: PUBLISHING_IDLE_TIMEOUT_SECONDS,
          arbiter_timeout_s: PUBLISHING_IDLE_TIMEOUT_SECONDS,
        },
      ],
      arbiter: {
        order: ['bifrost' as ProviderId],
      },
    },
    evidence: {
      zoekt: {
        enabled: true,
      },
    },
  };
}
