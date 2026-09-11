import { z } from 'zod';
import { AUTHORITATIVE_REVIEW_APP_ID, type AuthoritativeServiceConfig } from './authoritativeServiceConfig';
import { reviewCiLanePlanSchema, reviewCiValidationBindingSchema, type StoredReviewCiRequest } from '../review/reviewCi';

const positive = z.number().int().positive().safe();
const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((v) => v !== '.' && v !== '..');
const binding = reviewCiValidationBindingSchema.shape;
export const reviewCiWorkflowConfigSchema = z.object({
  workflowId: positive, workflowPath: binding.workflowPath,
  workflowRef: binding.workflowRef, workflowSha: binding.workflowSha,
}).strict();
export const reviewCiRepositoryConfigSchema = z.object({
  repositoryId: positive, ownerId: positive, owner: name, repo: name,
  relay: reviewCiWorkflowConfigSchema,
  validation: reviewCiWorkflowConfigSchema,
  lanePlan: reviewCiLanePlanSchema,
}).strict().refine((v) => v.relay.workflowId !== v.validation.workflowId
  && v.relay.workflowPath !== v.validation.workflowPath);
export type ReviewCiRepositoryConfig = z.infer<typeof reviewCiRepositoryConfigSchema>;
export interface ReviewCiServiceConfig {
  expectedAppId: number;
  admissionEnabled: boolean;
  repositoryDispatchEnabled: boolean;
  repositories: ReviewCiRepositoryConfig[];
  tickMs: number;
}

/** Resolve one exact service-owned enrollment. Callers retain their own
 * boundary-specific error classification, but not independent policy copies. */
export function findReviewCiEnrollment(config: ReviewCiServiceConfig,
  request: StoredReviewCiRequest): ReviewCiRepositoryConfig | undefined {
  const repository = config.repositories.find((candidate) => candidate.repositoryId === request.review.repositoryId);
  return repository
    && repository.owner === request.review.owner
    && repository.repo === request.review.repo
    && config.expectedAppId === request.expectedAppId
    ? repository
    : undefined;
}

/** Disabled by default. Pausing admission does not disable reconciliation of
 * already admitted work. No request supplies workflow refs, lanes or App IDs. */
export function reviewCiConfigFromEnv(env: Readonly<Record<string, string | undefined>>,
  review: AuthoritativeServiceConfig | undefined): ReviewCiServiceConfig | undefined {
  try {
    if (env.REVIEW_CI_ENABLED === undefined || env.REVIEW_CI_ENABLED === 'false') return undefined;
    if (env.REVIEW_CI_ENABLED !== 'true' || !review || review.expectedAppId !== AUTHORITATIVE_REVIEW_APP_ID) throw new Error();
    const flag = (value: string | undefined) => {
      if (value === undefined || value === 'false') return false;
      if (value === 'true') return true;
      throw new Error();
    };
    const raw = env.REVIEW_CI_REPOSITORIES;
    if (!raw || Buffer.byteLength(raw) > 131_072) throw new Error();
    const repositories = z.array(reviewCiRepositoryConfigSchema).min(1).max(100).parse(JSON.parse(raw));
    if (new Set(repositories.map((r) => r.repositoryId)).size !== repositories.length
      || new Set(repositories.map((r) => `${r.owner}/${r.repo}`.toLowerCase())).size !== repositories.length
      || repositories.some((r) => !review.repositoryIds.includes(r.repositoryId))) throw new Error();
    const value = env.REVIEW_CI_TICK_MS ?? '5000';
    if (!/^[1-9][0-9]*$/u.test(value)) throw new Error();
    const tickMs = Number(value);
    if (!Number.isSafeInteger(tickMs) || tickMs < 1000 || tickMs > 60_000) throw new Error();
    const admissionEnabled = flag(env.REVIEW_CI_ADMISSION_ENABLED);
    const repositoryDispatchEnabled = flag(env.REVIEW_CI_REPOSITORY_DISPATCH_ENABLED);
    if (admissionEnabled && !repositoryDispatchEnabled) throw new Error();
    return { expectedAppId: AUTHORITATIVE_REVIEW_APP_ID,
      admissionEnabled, repositoryDispatchEnabled, repositories, tickMs };
  } catch { throw new Error('Review CI service configuration is invalid'); }
}
