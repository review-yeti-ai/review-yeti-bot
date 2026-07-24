import { z } from 'zod';

export const PersonaEnum = z.enum(['security', 'architecture', 'performance', 'quality']);
export type Persona = z.infer<typeof PersonaEnum>;

export const EffortLevelEnum = z.enum(['low', 'medium', 'high', 'reasoning']);
export type EffortLevel = z.infer<typeof EffortLevelEnum>;

export const TicketProviderEnum = z.enum(['linear', 'jira', 'github']);
export type TicketProvider = z.infer<typeof TicketProviderEnum>;

export const ctReviewConfigSchema = z.object({
  version: z.string().default('1.0'),
  quorum: z.object({
    minApprovals: z.number().int().min(1, 'minApprovals must be at least 1').default(2),
    personas: z.array(PersonaEnum).min(1, 'At least one persona is required').default([
      'security',
      'architecture',
      'performance',
      'quality',
    ]),
    effortLevel: EffortLevelEnum.default('medium'),
  }).default({}),
  ticketEnforcement: z.object({
    required: z.boolean().default(true),
    providers: z.array(TicketProviderEnum).min(1, 'At least one ticket provider must be specified when ticket enforcement is enabled').default(['linear', 'jira', 'github']),
    patterns: z.array(z.string()).default([]),
  }).default({}),
  constitution: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default('.github/constitution.md'),
  }).default({}),
});

export type CtReviewConfig = z.infer<typeof ctReviewConfigSchema>;

export const codeRabbitConfigSchema = z.object({
  language: z.string().optional(),
  early_access: z.boolean().optional(),
  reviews: z.object({
    profile: z.string().optional(),
    request_tools: z.array(z.string()).optional(),
    high_level_summary: z.boolean().optional(),
    auto_review: z.object({
      enabled: z.boolean().optional(),
      drafts: z.boolean().optional(),
    }).optional(),
  }).optional(),
  chat: z.object({
    auto_reply: z.boolean().optional(),
  }).optional(),
});

export type CodeRabbitConfig = z.infer<typeof codeRabbitConfigSchema>;
