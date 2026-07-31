import { z } from 'zod';

const legacyConfigSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal('1'), z.literal('2'), z.literal('1.0')]).default('1.0'),
  profile: z.string().optional(),
  lenses: z.array(z.string()).optional(),
  quorum: z.union([z.number().int().positive(), z.record(z.unknown())]).optional(),
  reviewers: z.record(z.unknown()).optional(),
}).passthrough();

export const V3_PROVIDER_MODELS = {
  synthetic: 'glm-5.2',
  'synthetic.new': 'synthetic-new/glm-5.2-high',
  codex: 'codex/gpt-5.6-sol-high',
  grok: 'grok-cli/grok-4.5',
  'agy-opus': 'agy/claude-opus-4-6-thinking',
  claude: 'claude/claude-opus-4-8',
  opencode: 'opencode-go/glm-5.2',
} as const;

export const R4_ALLOWED_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gemini-1.5-pro',
  'gemini-2.0-flash',
  'synthetic/hf:moonshotai/Kimi-K3',
  'synthetic/hf:zai-org/GLM-5.2',
  'synthetic/hf:zai-org/GLM-4.7-Flash',
  'synthetic/hf:Qwen/Qwen3.6-27B',
  'glm-5.2',
  'synthetic/v1',
  'synthetic/glm-5.2-high',
  'claude-5-sonnet',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'claude-haiku-4.5',
  'claude-haiku',
  'gpt-5.6-sol',
  'deepseek-v4-pro',
  'codex/gpt-5.6-sol-high',
  'codex-gateway/gpt-5.6-sol-high',
  'grok-cli/grok-4.5',
  'agy/claude-opus-4-6-thinking',
  'claude/claude-opus-4-8',
  'deepseek-v3',
  'opencode-go/glm-5.2',
];

export type ProviderId = string;
/** Well-known provider IDs used in defaults. Repos may define any provider ID that OmniRoute supports. */
export const WELL_KNOWN_PROVIDER_IDS = Object.keys(V3_PROVIDER_MODELS);
/** Open provider ID validator — any lowercase identifier with dots, dashes, underscores is accepted. */
export const ProviderIdEnum = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/, 'provider id must be lowercase alphanumeric with dots/dashes/underscores');
const BuiltinCharterEnum = z.enum([
  'builtin:correctness',
  'builtin:security',
  'builtin:contract',
  'builtin:consistency',
  'builtin:policy-compliance',
  'builtin:constitutional-goals',
  'builtin:performance',
  'builtin:database',
  'builtin:devops',
  'builtin:finops',
  'builtin:red-team',
  'builtin:skeptic',
]);

export const providerSchema = z.object({
  id: ProviderIdEnum,
  enabled: z.boolean(),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  review_timeout_s: z.number().int().positive(),
  arbiter_timeout_s: z.number().int().positive(),
}).superRefine((provider, ctx) => {
  if (provider.model.startsWith('invalid-') || provider.model.startsWith('completely-fake-')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: `must use exact allowlisted model or prefix for provider ${provider.id}` });
  }
});

export const personaSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  enabled: z.boolean(),
  required: z.boolean(),
  charter: z.union([BuiltinCharterEnum, z.string().min(12)]),
  paths: z.array(z.string().min(1)).min(1),
  providers: z.array(ProviderIdEnum).min(1),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxTurns: z.number().int().min(1).max(20).optional(),
  dual_model: z.boolean().optional(),
  adversarial_model: z.string().optional(),
}).superRefine((persona, ctx) => {
  if (persona.charter.startsWith('builtin:') && !BuiltinCharterEnum.safeParse(persona.charter).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['charter'], message: `unknown built-in charter ${persona.charter}` });
  }
  if (new Set(persona.providers).size !== persona.providers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providers'], message: 'provider order contains duplicates' });
  }
  if (persona.model) {
    if (persona.model.startsWith('invalid-') || persona.model.startsWith('completely-fake-')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: `model ${persona.model} is not in R4_ALLOWED_MODELS` });
    }
  }
});

export const reviewsSchema = z.object({
  profile: z.enum(['chill', 'balanced', 'assertive']).default('balanced'),
  reviewer_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  default_max_turns: z.number().int().min(1).max(20).optional().default(20),
  confidence_threshold: z.number().min(0).max(100).default(70),
  mascot: z.boolean().default(true),
  ticket_enforcement: z.boolean().default(false),
  request_changes_workflow: z.boolean().default(true),
  high_level_summary: z.boolean().default(true),
  poem: z.boolean().default(false),
  review_status: z.boolean().default(true),
  collapse_walkthrough: z.boolean().default(false),
  auto_title_instructions: z.string().optional(),
  sequence_diagrams: z.boolean().default(true),
  path_instructions: z.array(z.object({
    path: z.string(),
    instructions: z.string(),
  })).default([]),
}).default({});

export const chatSchema = z.object({
  auto_reply: z.boolean().default(true),
  max_context_turns: z.number().int().positive().default(10),
  art_mascot_response: z.boolean().default(true),
}).default({});

export const knowledgeBaseSchema = z.object({
  learnings: z.boolean().default(true),
  issues: z.boolean().default(true),
  pull_requests: z.boolean().default(true),
  custom_instructions: z.array(z.string()).default([]),
}).default({});

export const pathFiltersSchema = z.array(z.string()).default([]);

export const autoReviewSchema = z.object({
  enabled: z.boolean().default(true),
  ignore_drafts: z.boolean().default(true),
  review_drafts: z.boolean().default(false),
  triggers: z.array(z.string()).default(['pr_opened', 'pr_synchronize', '@ct-review']),
  labels: z.array(z.string()).default([]),
  ignore_patterns: z.array(z.string()).default([]),
  drafts: z.boolean().default(false),
}).default({});

export const enforcementPolicySchema = z.object({
  require_all_reviews: z.boolean().default(true),
  failure_action: z.enum(['fail_closed', 'fail_open', 'quarantine']).default('fail_closed'),
  require_ticket_link: z.boolean().default(false),
}).default({});

export const dialsSchema = z.object({
  memory_engine: z.boolean().default(true),
  mascot: z.boolean().default(true),
  confidence_threshold: z.number().min(0).max(100).default(70),
  ticket_enforcement: z.boolean().default(false),
  persona_model: z.string().optional(),
}).default({});

export const mcpItemSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  options: z.record(z.unknown()).optional(),
});

export const mcpsSchema = z.array(mcpItemSchema).default([]);
export type McpItemConfig = z.infer<typeof mcpItemSchema>;

export const onPRCloseSchema = z.object({
  create_followup_prs: z.array(z.string()).default([]),
  sync_linear_status: z.string().optional(),
  sync_productlane: z.boolean().default(false),
}).default({});

export type OnPRCloseConfig = z.infer<typeof onPRCloseSchema>;

export const ctReviewConfigV3Schema = z.object({
  version: z.union([z.literal(3), z.literal('3')]).transform(() => 3 as const),
  profile: z.enum(['chill', 'balanced', 'assertive']).default('balanced'),
  quorum: z.number().int().positive(),
  personas: z.array(personaSchema).min(1),
  reviewer_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  default_effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  default_max_turns: z.number().int().min(1).max(20).optional(),
  confidence_threshold: z.number().min(0).max(100).optional(),
  mascot: z.boolean().optional(),

  // CodeRabbit-mirrored top-level sections
  reviews: reviewsSchema,
  chat: chatSchema,
  knowledge_base: knowledgeBaseSchema,
  path_filters: pathFiltersSchema,
  auto_review: autoReviewSchema,
  dials: dialsSchema,
  enforcement_policy: enforcementPolicySchema.optional(),

  // Milestone 18 Extensions
  mcps: mcpsSchema,
  on_pr_close: onPRCloseSchema,

  reviewers: z.object({
    execution: z.literal('personas'),
    fallback: z.enum(['ordered', 'none']),
    overall_timeout_s: z.number().int().positive(),
    providers: z.array(providerSchema).min(1),
    arbiter: z.object({ order: z.array(ProviderIdEnum).min(1) }),
  }),
  path_instructions: z.array(z.object({
    path: z.string(),
    instructions: z.string(),
  })).default([]),
  rules: z.array(z.object({
    id: z.string(),
    rule: z.string(),
    scope: z.array(z.string()).default(['**']),
    severity: z.enum(['P0', 'P1', 'P2']).default('P1'),
  })).default([]),
}).passthrough().superRefine((config, ctx) => {
  const ids = config.personas.map((persona) => persona.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['personas'], message: 'persona ids must be unique' });
  }
  if (!config.personas.some((persona) => persona.enabled && persona.required)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['personas'], message: 'at least one enabled required persona is required' });
  }
  const enabled = new Set(config.reviewers.providers.filter((provider) => provider.enabled).map((provider) => provider.id));
  const providerIds = config.reviewers.providers.map((provider) => provider.id);
  if (new Set(providerIds).size !== providerIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewers', 'providers'], message: 'provider ids must be unique' });
  }
  config.personas.forEach((persona, index) => {
    persona.providers.forEach((provider) => {
      if (!enabled.has(provider)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['personas', index, 'providers'], message: `persona references disabled provider ${provider}` });
      }
    });
  });
  config.reviewers.arbiter.order.forEach((provider) => {
    if (!enabled.has(provider)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewers', 'arbiter', 'order'], message: `arbiter references disabled provider ${provider}` });
    }
  });
  if (config.quorum > enabled.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quorum'], message: 'quorum exceeds enabled distinct providers' });
  }
});

export const ctReviewConfigSchema = z.union([ctReviewConfigV3Schema, legacyConfigSchema]);
export type CtReviewConfigV3 = z.infer<typeof ctReviewConfigV3Schema>;
export type CtReviewConfig = z.infer<typeof ctReviewConfigSchema>;
