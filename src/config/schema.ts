import { z } from 'zod';

const legacyConfigSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal('1'), z.literal('2'), z.literal('1.0')]).default('1.0'),
  profile: z.string().optional(),
  lenses: z.array(z.string()).optional(),
  quorum: z.union([z.number().int().positive(), z.record(z.unknown())]).optional(),
  reviewers: z.record(z.unknown()).optional(),
}).passthrough();

export const V3_PROVIDER_MODELS = {
  codex: 'codex/gpt-5.6-sol-high',
  grok: 'grok-cli/grok-4.5',
  'agy-opus': 'agy/claude-opus-4-6-thinking',
  claude: 'claude/claude-opus-4-8',
} as const;

export type ProviderId = keyof typeof V3_PROVIDER_MODELS;
export const ProviderIdEnum = z.enum(['codex', 'grok', 'agy-opus', 'claude']);
const BuiltinCharterEnum = z.enum([
  'builtin:correctness',
  'builtin:security',
  'builtin:contract',
  'builtin:consistency',
  'builtin:policy-compliance',
  'builtin:constitutional-goals',
]);

export const providerSchema = z.object({
  id: ProviderIdEnum,
  enabled: z.boolean(),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  review_timeout_s: z.number().int().positive(),
  arbiter_timeout_s: z.number().int().positive(),
}).superRefine((provider, ctx) => {
  const expected = V3_PROVIDER_MODELS[provider.id];
  if (provider.model !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['model'],
      message: `${provider.id} must use exact allowlisted model ${expected}`,
    });
  }
});

export const personaSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  enabled: z.boolean(),
  required: z.boolean(),
  charter: z.union([BuiltinCharterEnum, z.string().min(12)]),
  paths: z.array(z.string().min(1)).min(1),
  providers: z.array(ProviderIdEnum).min(1),
}).superRefine((persona, ctx) => {
  if (persona.charter.startsWith('builtin:') && !BuiltinCharterEnum.safeParse(persona.charter).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['charter'], message: `unknown built-in charter ${persona.charter}` });
  }
  if (new Set(persona.providers).size !== persona.providers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providers'], message: 'provider order contains duplicates' });
  }
});

export const ctReviewConfigV3Schema = z.object({
  version: z.union([z.literal(3), z.literal('3')]).transform(() => 3 as const),
  profile: z.enum(['chill', 'balanced', 'assertive']).default('balanced'),
  quorum: z.number().int().positive(),
  personas: z.array(personaSchema).min(1),
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
