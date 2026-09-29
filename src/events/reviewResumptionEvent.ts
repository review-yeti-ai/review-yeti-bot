import { z } from 'zod';

export const RESUME_TRIGGER_SCHEMA = 'review-yeti-resume.v1' as const;

export const reviewResumptionStatusSchema = z.enum(['completed', 'failed']);
export type ReviewResumptionStatus = z.infer<typeof reviewResumptionStatusSchema>;

export const reviewResumptionEventSchema = z.object({
  schema: z.literal(RESUME_TRIGGER_SCHEMA).optional().default(RESUME_TRIGGER_SCHEMA),
  runId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/u),
  headSha: z.string().regex(/^[a-fA-F0-9]{40}$/u),
  status: reviewResumptionStatusSchema,
  completedAt: z.string().datetime({ offset: true }),
  artifactsDigest: z.string().regex(/^[a-fA-F0-9]{64}$/u),
  findingsCount: z.number().int().min(0).default(0),
  error: z.string().optional(),
});

export type ReviewResumptionEvent = z.infer<typeof reviewResumptionEventSchema>;

export interface CreateResumptionPayloadInput {
  runId: string;
  headSha: string;
  status: ReviewResumptionStatus;
  completedAt?: string;
  artifactsDigest?: string;
  findingsCount?: number;
  error?: string;
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function createResumptionPayload(input: CreateResumptionPayloadInput): ReviewResumptionEvent {
  const payload = {
    schema: RESUME_TRIGGER_SCHEMA,
    runId: input.runId,
    headSha: input.headSha,
    status: input.status,
    completedAt: input.completedAt ?? new Date().toISOString(),
    artifactsDigest: input.artifactsDigest ?? EMPTY_SHA256,
    findingsCount: input.findingsCount ?? 0,
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
  return reviewResumptionEventSchema.parse(payload);
}

export function validateResumptionPayload(payload: unknown): ReviewResumptionEvent {
  return reviewResumptionEventSchema.parse(payload);
}

export function isReviewResumptionEvent(payload: unknown): payload is ReviewResumptionEvent {
  return reviewResumptionEventSchema.safeParse(payload).success;
}
