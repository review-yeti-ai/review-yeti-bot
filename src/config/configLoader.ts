import yaml from 'js-yaml';
import { ctReviewConfigSchema, ctReviewConfigV3Schema, ctReviewConfigV4Schema, CtReviewConfig, CtReviewConfigV3, CtReviewConfigV4, V3_PROVIDER_MODELS, R4_ALLOWED_MODELS } from './schema';
import { logger } from '../utils/logger';
import { OMNIROUTE_GENERATED_PROVIDERS, OMNIROUTE_GENERATED_MODEL_LIST } from '../types/providers.generated';

export class ConfigValidationError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export function createDefaultV3Config(): CtReviewConfigV3 {
  return {
    version: 3,
    profile: 'balanced',
    quorum: 1,
    mascot: true,
    default_max_turns: 20,
    default_effort: 'low',
    reviews: {
      profile: 'balanced',
      reviewer_effort: 'low',
      default_max_turns: 20,
      confidence_threshold: 70,
      mascot: true,
      ticket_enforcement: false,
      request_changes_workflow: true,
      high_level_summary: true,
      poem: false,
      review_status: true,
      collapse_walkthrough: false,
      sequence_diagrams: true,
      path_instructions: [],
    },
    chat: {
      auto_reply: true,
      max_context_turns: 10,
      art_mascot_response: true,
    },
    knowledge_base: {
      learnings: true,
      issues: true,
      pull_requests: true,
      custom_instructions: [],
    },
    path_filters: [],
    auto_review: {
      enabled: true,
      ignore_drafts: true,
      labels: [],
      drafts: false,
    },
    dials: {
      memory_engine: true,
      mascot: true,
      confidence_threshold: 70,
      ticket_enforcement: false,
    },
    personas: [
      { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'arch-lane', enabled: true, required: false, charter: 'builtin:constitutional-goals', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'qual-lane', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'devops-lane', enabled: true, required: false, charter: 'builtin:devops', paths: ['Dockerfile*', 'k8s/**', '.github/**', 'helm/**', '**/*.yaml'], providers: ['synthetic', 'claude'] },
      { id: 'correctness-lane', enabled: true, required: false, charter: 'builtin:correctness', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'contract-lane', enabled: true, required: false, charter: 'builtin:contract', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'policy-lane', enabled: true, required: false, charter: 'builtin:policy-compliance', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'perf-lane', enabled: true, required: false, charter: 'builtin:performance', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'db-lane', enabled: true, required: false, charter: 'builtin:database', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'finops-lane', enabled: true, required: false, charter: 'builtin:finops', paths: ['**'], providers: ['synthetic', 'claude'] },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 900,
      providers: [
        {
          id: 'synthetic',
          enabled: true,
          model: V3_PROVIDER_MODELS.synthetic,
          effort: 'low',
          review_timeout_s: 120,
          arbiter_timeout_s: 120,
        },
        {
          id: 'claude',
          enabled: true,
          model: 'claude-opus-4-8',
          effort: 'low',
          review_timeout_s: 300,
          arbiter_timeout_s: 300,
        },
        {
          id: 'codex',
          enabled: false,
          model: 'codex-gateway/gpt-5.6-sol-high',
          effort: 'low',
          review_timeout_s: 300,
          arbiter_timeout_s: 300,
        },
      ],
      arbiter: {
        order: ['synthetic', 'claude'],
      },
    },
    path_instructions: [],
    rules: [],
    mcps: [],
    on_pr_close: {
      create_followup_prs: [],
      sync_productlane: false,
    },
  } as any;
}

export function createDefaultV4Config(): CtReviewConfigV4 {
  return ctReviewConfigV4Schema.parse({
    ...createDefaultV3Config(),
    version: 4,
    submodules: {},
    limits: {},
  });
}

export function normalizeConfigToV4(config: CtReviewConfigV3 | CtReviewConfigV4): CtReviewConfigV4 {
  return ctReviewConfigV4Schema.parse({
    ...config,
    version: 4,
    submodules: (config as any).submodules || {},
    limits: (config as any).limits || {},
  });
}

const V4_SAFETY_CAPS = {
  max_files: 5000,
  max_diff_bytes: 2_000_000,
  max_prompt_tokens: 200_000,
  max_completion_tokens: 32_000,
  max_cost_usd: 100,
  max_turns: 20,
  max_concurrency: 32,
  max_depth: 5,
};

export function applyTrustedOverrides(
  config: CtReviewConfigV4,
  overrides: { limits?: Partial<CtReviewConfigV4['limits']>; submodules?: Partial<CtReviewConfigV4['submodules']> },
): CtReviewConfigV4 {
  const limits = { ...config.limits, ...(overrides.limits || {}) } as Record<string, number>;
  for (const [key, cap] of Object.entries(V4_SAFETY_CAPS)) {
    if (key in limits && typeof limits[key] === 'number') limits[key] = Math.min(limits[key], cap);
  }
  const submodules = { ...config.submodules, ...(overrides.submodules || {}) };
  if (typeof submodules.max_depth === 'number') submodules.max_depth = Math.min(submodules.max_depth, V4_SAFETY_CAPS.max_depth);
  return normalizeConfigToV4({ ...config, limits, submodules } as CtReviewConfigV4);
}

export function translateCodeRabbitToV3(raw: any): CtReviewConfigV3 {
  const rawObj = (raw || {}) as Record<string, any>;
  const reviews = rawObj.reviews || {};
  const chat = rawObj.chat || {};
  const kb = rawObj.knowledge_base || rawObj.knowledgeBase || {};
  const pathFilters = rawObj.path_filters || rawObj.pathFilters || [];
  const autoReview = rawObj.auto_review || rawObj.autoReview || {};
  const dials = rawObj.dials || {};
  const mcps = Array.isArray(rawObj.mcps) ? rawObj.mcps : [];
  const onPrCloseRaw = rawObj.on_pr_close || rawObj.onPrClose || {};
  const on_pr_close = {
    create_followup_prs: Array.isArray(onPrCloseRaw.create_followup_prs)
      ? onPrCloseRaw.create_followup_prs
      : Array.isArray(onPrCloseRaw.createFollowupPrs)
      ? onPrCloseRaw.createFollowupPrs
      : [],
    sync_linear_status: typeof onPrCloseRaw.sync_linear_status === 'string'
      ? onPrCloseRaw.sync_linear_status
      : typeof onPrCloseRaw.syncLinearStatus === 'string'
      ? onPrCloseRaw.syncLinearStatus
      : undefined,
    sync_productlane: Boolean(onPrCloseRaw.sync_productlane ?? onPrCloseRaw.syncProductlane ?? false),
  };

  const defaultConfig = createDefaultV3Config() as any;

  // Resolve toggles with proper fallback cascading
  const mascot = dials.mascot ?? reviews.mascot ?? chat.art_mascot_response ?? rawObj.display?.mascot ?? rawObj.mascot ?? true;
  const memory_engine = dials.memory_engine ?? kb.learnings ?? true;
  let confidence_threshold = dials.confidence_threshold ?? reviews.confidence_threshold ?? rawObj.confidence_threshold ?? 70;
  if (typeof confidence_threshold === 'number') {
    confidence_threshold = Math.max(0, Math.min(100, confidence_threshold));
  } else {
    confidence_threshold = 70;
  }
  const ticket_enforcement = dials.ticket_enforcement ?? reviews.ticket_enforcement ?? false;
  
  let reviewer_effort = reviews.reviewer_effort ?? rawObj.reviewer_effort ?? 'low';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(reviewer_effort)) {
    reviewer_effort = 'low';
  }

  let default_max_turns = reviews.default_max_turns ?? rawObj.default_max_turns ?? 20;
  if (typeof default_max_turns !== 'number' || default_max_turns < 1 || default_max_turns > 20) {
    default_max_turns = 20;
  }

  const rawPathInst = reviews.path_instructions || rawObj.path_instructions;
  const path_instructions = Array.isArray(rawPathInst) ? rawPathInst : [];

  const mergedReviews = {
    ...defaultConfig.reviews,
    ...reviews,
    profile: reviews.profile || rawObj.profile || 'balanced',
    reviewer_effort,
    default_max_turns,
    confidence_threshold,
    mascot,
    ticket_enforcement,
    path_instructions,
  };

  const mergedChat = {
    ...defaultConfig.chat,
    ...chat,
    art_mascot_response: mascot,
  };

  const mergedKb = {
    ...defaultConfig.knowledge_base,
    ...kb,
    learnings: memory_engine,
  };

  const mergedAutoReview = {
    ...defaultConfig.auto_review,
    ...autoReview,
  };

  const mergedDials = {
    memory_engine,
    mascot,
    confidence_threshold,
    ticket_enforcement,
    ...(dials.persona_model ? { persona_model: dials.persona_model } : {}),
  };

  defaultConfig.reviewers.providers[0].effort = reviewer_effort;

  return {
    ...defaultConfig,
    version: 3,
    profile: mergedReviews.profile,
    reviewer_effort,
    default_max_turns,
    default_effort: reviewer_effort,
    confidence_threshold,
    mascot,
    reviews: mergedReviews,
    chat: mergedChat,
    knowledge_base: mergedKb,
    path_filters: Array.isArray(pathFilters) ? pathFilters : [],
    auto_review: mergedAutoReview,
    dials: mergedDials,
    path_instructions,
    mcps,
    on_pr_close,
  };
}

export function translateLegacyConfigToV3(raw: any): CtReviewConfigV3 {
  const defaultConfig = createDefaultV3Config();
  return {
    ...defaultConfig,
    version: 3,
    profile: raw.profile || 'balanced',
    reviewer_effort: raw.reviewer_effort || 'low',
    confidence_threshold: raw.confidence_threshold,
    mascot: raw.mascot ?? true,
    path_instructions: raw.path_instructions || [],
    mcps: raw.mcps || [],
    on_pr_close: raw.on_pr_close || raw.onPrClose || { create_followup_prs: [], sync_productlane: false },
  } as any;
}

import { ConfigResolver } from './configResolver';

export async function loadConfig(
  owner: string,
  repo: string,
  ref: string,
  client: { getFileContent: (owner: string, repo: string, path: string, ref?: string) => Promise<string | null> }
): Promise<any> {
  const resolver = new ConfigResolver();
  const fileNames = ConfigResolver.CONFIG_FILES;

  for (const fileName of fileNames) {
    const content = await client.getFileContent(owner, repo, fileName, ref);
    if (content !== null && content !== undefined) {
      const isCodeRabbit = fileName === '.coderabbit.yaml';
      const parsed = parseAndValidateConfig(content, isCodeRabbit);
      if ((parsed as any).version !== 3 && (parsed as any).version !== 4) {
        return translateLegacyConfigToV3(parsed);
      }
      if ((parsed as any).version === 4) return parsed;
      return resolver.deepMergeConfigs(createDefaultV3Config(), null, parsed);
    }
  }

  if (repo !== '.github') {
    for (const fileName of fileNames) {
      const content = await client.getFileContent(owner, '.github', fileName);
      if (content !== null && content !== undefined) {
        const isCodeRabbit = fileName === '.coderabbit.yaml';
        const parsed = parseAndValidateConfig(content, isCodeRabbit);
        if ((parsed as any).version !== 3 && (parsed as any).version !== 4) {
          return translateLegacyConfigToV3(parsed);
        }
        if ((parsed as any).version === 4) return parsed;
        return resolver.deepMergeConfigs(createDefaultV3Config(), parsed, null);
      }
    }
  }

  return createDefaultV3Config();
}

export function parseAndValidateConfig(rawYaml: string, isCodeRabbitFormat = false): CtReviewConfig {
  let parsed: unknown;
  try {
    parsed = yaml.load(rawYaml);
  } catch (error: any) {
    throw new ConfigValidationError(`YAML syntax error: ${error.message}`, error);
  }
  if (Array.isArray(parsed)) {
    throw new ConfigValidationError('Configuration YAML must be a mapping, not an array');
  }
  if (parsed === null || parsed === undefined || parsed === '') parsed = {};
  if (typeof parsed !== 'object') throw new ConfigValidationError('Configuration YAML must be a mapping');

  if (isCodeRabbitFormat) {
    const rawObj = (parsed || {}) as Record<string, any>;
    if (rawObj.reviews && typeof rawObj.reviews === 'object' && Object.keys(rawObj.reviews).length === 0 && Object.keys(rawObj).length === 1) {
      throw new ConfigValidationError('CodeRabbit configuration is not a ct-review policy');
    }
    return translateCodeRabbitToV3(parsed);
  }

  const raw = parsed as Record<string, unknown>;
  if (String(raw.version ?? 1) === '4') {
    if ('lenses' in raw) throw new ConfigValidationError('version 4 personas cannot be mixed with legacy lenses');
    const sanitized = sanitizeV3Config(raw);
    const result = ctReviewConfigV4Schema.safeParse(sanitized);
    if (!result.success) {
      throw new ConfigValidationError(
        `Config validation failed: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        result.error.format(),
      );
    }
    return result.data;
  }
  if (String(raw.version ?? 1) === '3') {
    if ('lenses' in raw) throw new ConfigValidationError('version 3 personas cannot be mixed with legacy lenses');
    const sanitized = sanitizeV3Config(raw);
    const result = ctReviewConfigV3Schema.safeParse(sanitized);
    if (!result.success) {
      throw new ConfigValidationError(
        `Config validation failed: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        result.error.format(),
      );
    }
    return result.data;
  }
  const result = ctReviewConfigSchema.safeParse({ version: raw.version ?? 1, ...raw });
  if (!result.success) {
    throw new ConfigValidationError(
      `Config validation failed: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      result.error.format(),
    );
  }
  return result.data;
}

/**
 * Sanitizes a raw V3 config object before Zod validation.
 * Provider IDs are open — any valid identifier is accepted. The review runtime normalizes
 * legacy provider labels at the OpenRouter boundary.
 * This sanitizer only enforces structural validity:
 * - Strips provider entries missing required fields (id, model)
 * - Ensures provider IDs match the [a-z][a-z0-9._-]* pattern
 * - Ensures persona provider lists reference providers defined in reviewers.providers
 * - Ensures arbiter order references defined providers
 */
export function sanitizeV3Config(raw: Record<string, unknown>): Record<string, unknown> {
  const reviewers = raw.reviewers as Record<string, unknown> | undefined;
  if (!reviewers || typeof reviewers !== 'object') return raw;

  const providerIdPattern = /^[a-z][a-z0-9._-]{0,63}$/;
  const providers = (reviewers as any).providers;
  const definedProviderIds = new Set<string>();

  if (Array.isArray(providers)) {
    const sanitizedProviders: any[] = [];
    for (const p of providers) {
      if (!p || typeof p !== 'object') continue;
      if (!p.id || typeof p.id !== 'string') {
        logger.warn('Stripping provider entry with missing or invalid id');
        continue;
      }
      if (!providerIdPattern.test(p.id)) {
        logger.warn(`Stripping provider '${p.id}' — id must match pattern [a-z][a-z0-9._-]*`);
        continue;
      }
      if (!p.model || typeof p.model !== 'string') {
        logger.warn(`Stripping provider '${p.id}' — missing model`);
        continue;
      }
      if (OMNIROUTE_GENERATED_PROVIDERS[p.id as keyof typeof OMNIROUTE_GENERATED_PROVIDERS]) {
        const meta = OMNIROUTE_GENERATED_PROVIDERS[p.id as keyof typeof OMNIROUTE_GENERATED_PROVIDERS];
        const CORE_R4_MODELS = ['claude-5-sonnet', 'gpt-5.6-sol', 'deepseek-v4-pro', 'glm-5.2'];
        const isSupported = meta.supportedModels.includes(p.model) ||
          meta.defaultModel === p.model ||
          CORE_R4_MODELS.includes(p.model) ||
          meta.supportsCustomModels ||
          p.model.startsWith(p.id) ||
          p.model.startsWith(`${p.id}-`) ||
          p.model.startsWith(`${p.id}/`) ||
          p.model.startsWith('synthetic/');
        if (!isSupported) {
          throw new ConfigValidationError(`Provider '${p.id}' model '${p.model}' is not an exact allowlisted model for provider '${p.id}'`);
        }
      }
      definedProviderIds.add(p.id);
      sanitizedProviders.push(p);
    }
    (reviewers as any).providers = sanitizedProviders;
  }

  // Validate persona model overrides and provider references
  const personas = raw.personas;
  if (Array.isArray(personas)) {
    for (const persona of personas) {
      if (!persona || typeof persona !== 'object') continue;
      if (persona.model && typeof persona.model === 'string') {
        const isSupportedModel = R4_ALLOWED_MODELS.includes(persona.model) ||
          OMNIROUTE_GENERATED_MODEL_LIST.includes(persona.model) ||
          persona.model.includes('/') ||
          persona.model.startsWith('synthetic') ||
          persona.model.startsWith('custom') ||
          persona.model.startsWith('claude') ||
          persona.model.startsWith('gpt') ||
          persona.model.startsWith('grok') ||
          persona.model.startsWith('glm') ||
          persona.model.startsWith('codex') ||
          persona.model.startsWith('opencode') ||
          persona.model.startsWith('agy');
        if (!isSupportedModel) {
          throw new ConfigValidationError(`Persona '${persona.id}' model '${persona.model}' is not an exact allowlisted model`);
        }
      }
      if (Array.isArray(persona.providers)) {
        const unknown = persona.providers.filter((pid: string) => !definedProviderIds.has(pid));
        if (unknown.length > 0) {
          logger.warn(`Persona '${persona.id}' references providers not in reviewers.providers: ${unknown.join(', ')}`);
        }
      }
    }
  }

  // Validate arbiter order references defined providers
  const arbiter = (reviewers as any).arbiter;
  if (arbiter && Array.isArray(arbiter.order)) {
    const unknown = arbiter.order.filter((pid: string) => !definedProviderIds.has(pid));
    if (unknown.length > 0) {
      logger.warn(`Arbiter order references providers not in reviewers.providers: ${unknown.join(', ')}`);
    }
  }

  return raw;
}
