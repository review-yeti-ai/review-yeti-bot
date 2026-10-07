import { createDefaultV3Config, isTriggerActionAllowed, type TriggerActionOptions } from './configLoader';
import { disputedBlockerAdjudicatorSchema, type ComposedEngineConfig, type CtReviewConfigV3,
  type DisputedBlockerAdjudicator, type ProviderId, type ReviewEngineName } from './schema';
import { logger } from '../utils/logger';
import { loadCompiledIndex, type CompiledDomainIndex } from '../pipeline/domainIndex';
import { resolveMaxReviewedLockfilePatchChars } from '../pipeline/hunkFilter';
import { GROUNDED_VERIFICATION_VERSION } from '../review/groundedReviewEngine';
import { groundedVerificationCapabilityForRuntime } from '../review/groundedCandidateManifestCapability';
import {
  COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS,
  COMPOSED_ENGINE_DEFAULT_MAX_TASKS,
  COMPOSED_ENGINE_MAX_TOTAL_TURNS_HARD_CAP,
  COMPOSED_TASK_CONCURRENCY_CEILING,
  COMPOSED_PLAN_MAX_TURNS,
  COMPOSED_TASK_MAX_TURNS,
  COMPOSED_TASK_MAX_TURNS_HARD_CAP,
} from '../panel/composedEngineBudget';

export { isTriggerActionAllowed, type TriggerActionOptions };

// Native publishing must project the same bounded turn/idle policy as the
// panel. Idle time is separate from the overall deadline enforced at runtime.
// 15 turns matches the central policy's max_investigation_turns so a caller
// policy cannot be silently clamped below its requested budget. The turn count
// is only an upper bound: the wall-clock overall deadline below remains the
// binding outer constraint.
export const PUBLISHING_MAX_TURNS = 15;
export const PUBLISHING_IDLE_TIMEOUT_SECONDS = 180;
/** Evidence phase only. The admitted lifecycle reserves another five minutes for closeout. */
export const PUBLISHING_OVERALL_TIMEOUT_SECONDS = 1200;
const INACTIVE_CONFIDENCE_THRESHOLD_REASON = 'The publishing worker does not consume confidence_threshold; a self-reported score cannot reduce evidence requirements or change blocker eligibility.';

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
    '.gitmodules*',
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

/** DSH remains a requested policy mode whose supported effective engine is composed. */
function normalizeReviewEngine(value: unknown, fallback: unknown): ReviewEngineName {
  if (value === undefined) return 'panel';
  if (value === 'dsh' || value === 'deepseek-harness') {
    if (fallback !== 'composed') {
      throw new Error('DSH requires fallback_review_engine=composed until the worker supports DSH');
    }
    return 'composed';
  }
  if (typeof value === 'string' && VALID_REVIEW_ENGINES.has(value)) return value as ReviewEngineName;
  throw new Error('unsupported review_engine value');
}

function positiveInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Projects only composed policy fields consumed by the engine. Unknown or malformed keys fail closed. */
function normalizeComposedOverrides(value: unknown): ComposedEngineConfig {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('composed policy must be an object');
  const raw = value as Record<string, unknown>;
  const supported = new Set(['max_tasks', 'max_turns_total', 'max_turns_per_task', 'max_findings_total']);
  if (Object.keys(raw).some((key) => !supported.has(key))) throw new Error('unsupported composed policy key');
  const overrides: ComposedEngineConfig = {};
  for (const key of supported) {
    if (raw[key] === undefined) continue;
    const value = positiveInt(raw[key]);
    if (value === undefined) throw new Error(`invalid composed policy value: ${key}`);
    if (key === 'max_tasks' || key === 'max_turns_total' || key === 'max_turns_per_task' || key === 'max_findings_total') {
      overrides[key] = value;
    }
  }
  return overrides;
}

const SUPPORTED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function resolveBifrostEffort(policy: Record<string, any> | undefined): { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; requested?: string } {
  const transports: unknown = policy?.transports;
  if (transports === undefined) return { effort: 'medium' };
  if (!Array.isArray(transports)) throw new Error('central transports must be an array');
  const enabled = transports.filter((item) => item && typeof item === 'object' && item.name === 'bifrost' && item.enabled === true);
  if (enabled.length !== 1) throw new Error('central policy must enable exactly one Bifrost transport');
  const requested = enabled[0].reasoning_effort;
  if (typeof requested !== 'string' || !SUPPORTED_EFFORTS.has(requested)) {
    throw new Error('unsupported Bifrost reasoning_effort');
  }
  return { effort: requested as 'low' | 'medium' | 'high' | 'xhigh' | 'max', requested };
}

function resolveInactiveConfidenceThreshold(
  policy: Record<string, any> | undefined,
  fallback: number,
): { requested: number | null; effective: number } {
  const configured = [policy?.dials?.confidence_threshold, policy?.reviews?.confidence_threshold,
    policy?.confidence_threshold].find(value => value !== undefined);
  if (configured === undefined) return { requested: null, effective: fallback };
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0 || configured > 100) {
    throw new Error('unsupported confidence_threshold');
  }
  return { requested: configured, effective: configured };
}

function enabledMcpServerIds(policy: Record<string, any> | undefined): string[] {
  if (policy?.mcp_servers === undefined) return [];
  if (!Array.isArray(policy.mcp_servers)) throw new Error('central mcp_servers must be an array');
  return policy.mcp_servers.filter((server) => server && typeof server === 'object' && server.enabled === true
    && typeof server.id === 'string' && server.id.length > 0).map((server) => server.id);
}

export function resolveWorkerConfig(
  env: Readonly<Record<string, string | undefined>>,
  transport: { baseUrl: string; apiKey: string; model: string },
): CtReviewConfigV3 {
  const baseConfig = createDefaultV3Config();

  let maxInvestigationTurns = PUBLISHING_MAX_TURNS;
  let maxReviewedLockfilePatchChars: number | undefined;
  let personasList: string[] = [];
  let policy: Record<string, any> | undefined;
  let reviewEngine: ReviewEngineName = 'panel';
  let requestedReviewEngine: unknown = 'panel';
  let severityPolicy: 'review-yeti-severity.v2' | undefined;
  let requestedProfile: 'chill' | 'balanced' | 'assertive' = baseConfig.profile;
  let requestedBifrostEffort: string | undefined;
  let bifrostEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium';
  let requestedConfidenceThreshold: number | null = null;
  let effectiveConfidenceThreshold = baseConfig.confidence_threshold
    ?? baseConfig.reviews?.confidence_threshold ?? baseConfig.dials?.confidence_threshold ?? 70;
  let configuredMcpServers: string[] = [];
  let composed: ComposedEngineConfig = {};
  let disputedBlockerAdjudicator: DisputedBlockerAdjudicator | undefined;

  if (env.REVIEW_YETI_POLICY_JSON) {
    try {
      const raw = JSON.parse(env.REVIEW_YETI_POLICY_JSON);
      policy = raw.review_yeti || raw;
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('review_yeti policy must be an object');
      if (policy.budget?.max_investigation_turns) {
        maxInvestigationTurns = Number(policy.budget.max_investigation_turns);
      }
      const requestedLockfilePatchChars = policy.budget?.max_reviewed_lockfile_patch_chars;
      if (requestedLockfilePatchChars !== undefined) {
        maxReviewedLockfilePatchChars = resolveMaxReviewedLockfilePatchChars(requestedLockfilePatchChars);
      }
      if (typeof policy.personas === 'string') {
        personasList = policy.personas.split(',').map((p: string) => p.trim()).filter(Boolean);
      } else if (Array.isArray(policy.personas)) {
        personasList = policy.personas;
      }
      requestedReviewEngine = policy.review_engine === undefined ? 'panel' : policy.review_engine;
      reviewEngine = normalizeReviewEngine(policy.review_engine, policy.fallback_review_engine);
      composed = normalizeComposedOverrides(policy.composed);
      if (policy.profile !== undefined) {
        if (!['chill', 'balanced', 'assertive'].includes(policy.profile)) throw new Error('unsupported review profile');
        requestedProfile = policy.profile;
      }
      if (policy.severity_policy !== undefined) {
        if (policy.severity_policy !== 'review-yeti-severity.v2') throw new Error('unsupported severity_policy');
        severityPolicy = policy.severity_policy;
      }
      if (policy.disputed_blocker_adjudicator !== undefined) {
        disputedBlockerAdjudicator = disputedBlockerAdjudicatorSchema.parse(policy.disputed_blocker_adjudicator);
        if (disputedBlockerAdjudicator.model.toLowerCase() === transport.model.toLowerCase()) {
          throw new Error('disputed blocker adjudicator must use a model alias distinct from the primary review model');
        }
      }
      const confidenceThreshold = resolveInactiveConfidenceThreshold(policy, effectiveConfidenceThreshold);
      requestedConfidenceThreshold = confidenceThreshold.requested;
      effectiveConfidenceThreshold = confidenceThreshold.effective;
      const bifrost = resolveBifrostEffort(policy);
      bifrostEffort = bifrost.effort;
      requestedBifrostEffort = bifrost.requested;
      configuredMcpServers = enabledMcpServerIds(policy);
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
  const groundedVerificationCapability = groundedVerificationCapabilityForRuntime(GROUNDED_VERIFICATION_VERSION);

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
    'documentation': { id: 'documentation', required: false, charter: 'builtin:docs' },
    'docs': { id: 'documentation', required: false, charter: 'builtin:docs' },
    'documentation-lane': { id: 'documentation', required: false, charter: 'builtin:docs' },
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

  const reviewConfigurationReceipt = {
    schema: 'review-yeti-effective-config.v1' as const,
    requested: {
      profile: requestedProfile,
      review_engine: typeof requestedReviewEngine === 'string' ? requestedReviewEngine : String(requestedReviewEngine),
      ...(severityPolicy === undefined ? {} : { severity_policy: severityPolicy }),
      ...(disputedBlockerAdjudicator === undefined ? {} : { disputed_blocker_adjudicator: disputedBlockerAdjudicator }),
      personas: effectivePersonaNames,
      ...(requestedBifrostEffort === undefined ? {} : { bifrost_reasoning_effort: requestedBifrostEffort }),
      mcp_servers: configuredMcpServers,
      confidence_threshold: requestedConfidenceThreshold,
      max_investigation_turns: Number(policy?.budget?.max_investigation_turns ?? PUBLISHING_MAX_TURNS),
      max_reviewed_lockfile_patch_chars: maxReviewedLockfilePatchChars ?? null,
    },
    effective: {
      review_engine: reviewEngine,
      ...(severityPolicy === undefined ? {} : { severity_policy: severityPolicy }),
      ...(disputedBlockerAdjudicator === undefined ? {} : {
        disputed_blocker_adjudicator: reviewEngine === 'composed' && severityPolicy === 'review-yeti-severity.v2'
          ? { state: 'available' as const, model_alias: disputedBlockerAdjudicator.model,
            reasoning_effort: disputedBlockerAdjudicator.reasoning_effort, applied: false as const,
            reason: 'Configured for authenticated disputed P0/P1 rechecks only; runtime application is recorded per verifier outcome.' }
          : { state: 'inactive' as const, model_alias: disputedBlockerAdjudicator.model,
            reasoning_effort: disputedBlockerAdjudicator.reasoning_effort, applied: false as const,
            reason: 'Requires effective composed review with effective severity v2; the primary verifier route remains active.' },
      }),
      confidence_threshold: {
        value: effectiveConfidenceThreshold,
        applied: false as const,
        reason: INACTIVE_CONFIDENCE_THRESHOLD_REASON,
      },
      profile: {
        value: requestedProfile,
        applied: reviewEngine !== 'composed' || severityPolicy === 'review-yeti-severity.v2',
        reason: reviewEngine === 'composed'
          ? severityPolicy === 'review-yeti-severity.v2'
            ? 'The composed engine applies this profile to advisory breadth under severity v2; blocker evidence and coverage remain profile-independent.'
            : 'The composed advisory profile is inactive under legacy severity because P2 findings remain blocking.'
          : 'The selected panel engine applies profile during effort and token-budget resolution.',
      },
      ...(groundedVerificationCapability ? { grounded_verification: groundedVerificationCapability } : {}),
      provider: {
        id: 'bifrost' as const,
        model: transport.model,
        requested_effort: bifrostEffort,
        upstream_observed_model: 'unknown' as const,
        upstream_observed_effort: 'unknown' as const,
      },
      personas: personas.map((persona, index) => ({
        requested: effectivePersonaNames[index], id: persona.id, charter: persona.charter,
      })),
      memory: {
        state: reviewEngine === 'composed' ? 'not_loaded' as const : 'runtime_dependent' as const,
        configured_servers: configuredMcpServers,
        loaded_servers: [],
        reason: reviewEngine === 'composed'
          ? 'The composed publishing worker does not consume MCP_CONFIG_JSON or PRMemoryStore.'
          : 'MCP_CONFIG_JSON is not consumed during preparation; panel PRMemoryStore lookups depend on the runtime review context.',
      },
      composed_budget: {
        source: 'engine_defaults' as const,
        configured_overrides: composed,
        central_policy_total_turns: Math.min(composed.max_turns_total ?? COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS,
          COMPOSED_ENGINE_DEFAULT_MAX_TOTAL_TURNS),
        central_policy_max_tasks: Math.min(composed.max_tasks ?? COMPOSED_ENGINE_DEFAULT_MAX_TASKS,
          COMPOSED_ENGINE_DEFAULT_MAX_TASKS),
        plan_turns: COMPOSED_PLAN_MAX_TURNS,
        base_task_turns: Math.min(composed.max_turns_per_task ?? COMPOSED_TASK_MAX_TURNS, COMPOSED_TASK_MAX_TURNS),
        dynamic_task_turns_max: Math.min(composed.max_turns_per_task ?? COMPOSED_TASK_MAX_TURNS_HARD_CAP,
          COMPOSED_TASK_MAX_TURNS_HARD_CAP),
        max_concurrent_tasks: COMPOSED_TASK_CONCURRENCY_CEILING,
        total_turns_hard_cap: COMPOSED_ENGINE_MAX_TOTAL_TURNS_HARD_CAP,
        operator_total_turn_override: 'COMPOSED_ENGINE_MAX_TURNS' as const,
      },
      worker_limits: {
        effective_investigation_turns: Math.min(PUBLISHING_MAX_TURNS, Math.max(1, maxInvestigationTurns || PUBLISHING_MAX_TURNS)),
        effective_reviewed_lockfile_patch_chars: maxReviewedLockfilePatchChars ?? null,
      },
    },
  };

  return {
    ...baseConfig,
    profile: requestedProfile,
    personas,
    ...(maxReviewedLockfilePatchChars === undefined
      ? {} : { max_reviewed_lockfile_patch_chars: maxReviewedLockfilePatchChars }),
    review_engine: reviewEngine,
    ...(severityPolicy === undefined ? {} : { severity_policy: severityPolicy }),
    ...(disputedBlockerAdjudicator === undefined ? {} : { disputed_blocker_adjudicator: disputedBlockerAdjudicator }),
    review_configuration_receipt: reviewConfigurationReceipt,
    composed,
    default_max_turns: Math.min(PUBLISHING_MAX_TURNS, Math.max(1, maxInvestigationTurns || PUBLISHING_MAX_TURNS)),
    reviewer_effort: bifrostEffort,
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: PUBLISHING_OVERALL_TIMEOUT_SECONDS,
      providers: [
        {
          id: 'bifrost' as ProviderId,
          enabled: true,
          model: transport.model,
          effort: bifrostEffort,
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
