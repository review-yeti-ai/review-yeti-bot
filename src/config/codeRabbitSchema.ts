import { z } from 'zod';
import { mcpsSchema, onPRCloseSchema } from './schema';

export const codeRabbitRawSchema = z.object({
  reviews: z.record(z.unknown()).optional(),
  chat: z.record(z.unknown()).optional(),
  knowledge_base: z.record(z.unknown()).optional(),
  knowledgeBase: z.record(z.unknown()).optional(),
  path_filters: z.array(z.string()).optional(),
  pathFilters: z.array(z.string()).optional(),
  auto_review: z.record(z.unknown()).optional(),
  autoReview: z.record(z.unknown()).optional(),
  dials: z.record(z.unknown()).optional(),
  mcps: mcpsSchema.optional(),
  on_pr_close: onPRCloseSchema.optional(),
  onPrClose: onPRCloseSchema.optional(),
}).passthrough();

export type CodeRabbitRawConfig = z.infer<typeof codeRabbitRawSchema>;
