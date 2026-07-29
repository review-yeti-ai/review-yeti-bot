import yaml from 'js-yaml';
import { ctReviewConfigSchema, ctReviewConfigV3Schema, CtReviewConfig, CtReviewConfigV3 } from './schema';

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
    reviews: {
      profile: 'balanced',
      reviewer_effort: 'low',
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
      { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['synthetic', 'codex'] },
      { id: 'arch-lane', enabled: true, required: false, charter: 'builtin:constitutional-goals', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'perf-lane', enabled: true, required: false, charter: 'builtin:performance', paths: ['**'], providers: ['synthetic', 'codex'] },
      { id: 'qual-lane', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['synthetic', 'claude'] },
      { id: 'db-lane', enabled: true, required: false, charter: 'builtin:database', paths: ['src/persistence/**', 'src/db/**', 'migrations/**', '**/*.sql'], providers: ['synthetic', 'codex'] },
      { id: 'api-lane', enabled: true, required: false, charter: 'builtin:contract', paths: ['src/api/**', 'src/routes/**', 'openapi/**', '**/*.yaml'], providers: ['synthetic', 'claude'] },
      { id: 'sre-lane', enabled: true, required: false, charter: 'builtin:policy-compliance', paths: ['**'], providers: ['synthetic', 'codex'] },
      { id: 'devops-lane', enabled: true, required: false, charter: 'builtin:devops', paths: ['Dockerfile*', 'k8s/**', '.github/**', 'helm/**', '**/*.yaml'], providers: ['synthetic', 'claude'] },
      { id: 'docs-lane', enabled: true, required: false, charter: 'builtin:consistency', paths: ['docs/**', 'README.md', '**/*.md', 'src/**'], providers: ['synthetic', 'codex'] },
      { id: 'finops-lane', enabled: true, required: false, charter: 'builtin:finops', paths: ['**'], providers: ['synthetic', 'claude'] },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 60,
      providers: [
        {
          id: 'synthetic',
          enabled: true,
          model: 'glm-5.2',
          effort: 'low',
          review_timeout_s: 30,
          arbiter_timeout_s: 30,
        },
        {
          id: 'codex',
          enabled: true,
          model: 'codex/gpt-5.6-sol-high',
          effort: 'low',
          review_timeout_s: 30,
          arbiter_timeout_s: 30,
        },
        {
          id: 'claude',
          enabled: true,
          model: 'claude-5-sonnet',
          effort: 'low',
          review_timeout_s: 30,
          arbiter_timeout_s: 30,
        },
      ],
      arbiter: {
        order: ['synthetic', 'codex', 'claude'],
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

export function translateCodeRabbitToV3(raw: any): any {
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

  const rawPathInst = reviews.path_instructions || rawObj.path_instructions;
  const path_instructions = Array.isArray(rawPathInst) ? rawPathInst : [];

  const mergedReviews = {
    ...defaultConfig.reviews,
    ...reviews,
    profile: reviews.profile || rawObj.profile || 'balanced',
    reviewer_effort,
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
      if ((parsed as any).version !== 3) {
        return translateLegacyConfigToV3(parsed);
      }
      return resolver.deepMergeConfigs(createDefaultV3Config(), null, parsed);
    }
  }

  if (repo !== '.github') {
    for (const fileName of fileNames) {
      const content = await client.getFileContent(owner, '.github', fileName);
      if (content !== null && content !== undefined) {
        const isCodeRabbit = fileName === '.coderabbit.yaml';
        const parsed = parseAndValidateConfig(content, isCodeRabbit);
        if ((parsed as any).version !== 3) {
          return translateLegacyConfigToV3(parsed);
        }
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
  if (String(raw.version ?? 1) === '3') {
    if ('lenses' in raw) throw new ConfigValidationError('version 3 personas cannot be mixed with legacy lenses');
    const result = ctReviewConfigV3Schema.safeParse(raw);
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
