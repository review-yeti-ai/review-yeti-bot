/**
 * ADR 0002: the wire contract of `POST /api/dispatch/finding-threads`, shared by the worker client
 * (`findingThreadsHttp.ts`) and the service route (`src/api/findingThreadsRoute.ts`). Kept in
 * `src/review` so the worker side does not depend on the API layer.
 */
import { z } from 'zod';
import { reviewDecisionV2Schema } from './reviewDecision';

export const FINDING_THREADS_REQUEST_VERSION = 'FindingThreadsRequest.v1' as const;
export const FINDING_THREADS_REQUEST_V2_VERSION = 'FindingThreadsRequest.v2' as const;
export const MAX_FINDING_THREADS_REQUEST_BYTES = 256 * 1024;
export const MAX_FINDING_THREADS_PER_REQUEST = 30;
export const MAX_REPORTED_FINGERPRINTS = 400;

const fingerprint = z.string().regex(/^fp1_[a-f0-9]{24}$/u);
const publishableFindingSchema = z.object({
  fingerprint,
  severity: z.enum(['P0', 'P1', 'P2', 'P3', 'NIT']),
  path: z.string().min(1).max(4_000),
  line: z.number().int().positive().safe(),
  title: z.string().min(1).max(1_000),
  body: z.string().min(1).max(16_000),
}).strict();

const publishFields = {
  publish: z.array(publishableFindingSchema).max(MAX_FINDING_THREADS_PER_REQUEST),
  reported: z.array(fingerprint).max(MAX_REPORTED_FINGERPRINTS),
};

export const findingThreadsRequestV1Schema = z.object({
  version: z.literal(FINDING_THREADS_REQUEST_VERSION),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/u),
  ...publishFields,
}).strict();

/** V2 is accepted only after the service has recorded and verified the exact completion. */
export const findingThreadsRequestV2Schema = z.object({
  version: z.literal(FINDING_THREADS_REQUEST_V2_VERSION),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().positive().safe(),
  repositoryId: z.number().int().positive().safe(),
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u),
  prNumber: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/u),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/u),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewDecision: reviewDecisionV2Schema,
}).strict();

export const findingThreadsRequestSchema = z.discriminatedUnion('version', [
  findingThreadsRequestV1Schema, findingThreadsRequestV2Schema,
]);
export type FindingThreadsRequestV1 = z.infer<typeof findingThreadsRequestV1Schema>;
export type FindingThreadsRequestV2 = z.infer<typeof findingThreadsRequestV2Schema>;
export type FindingThreadsRequest = FindingThreadsRequestV1 | FindingThreadsRequestV2;
export type FindingThreadsPublishRequest = Omit<FindingThreadsRequestV1, 'version' | 'runId' | 'executionAttempt'>
  | Omit<FindingThreadsRequestV2, 'version' | 'runId' | 'executionAttempt'>;

/** Read the review App's own finding threads, identified and resolution-checked by the service. */
export const FINDING_THREADS_READ_VERSION = 'FindingThreadsRead.v1' as const;
export const findingThreadsReadRequestSchema = z.object({
  version: z.literal(FINDING_THREADS_READ_VERSION),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/u),
}).strict();
export type FindingThreadsReadRequest = z.infer<typeof findingThreadsReadRequestSchema>;

const priorThreadSchema = z.object({
  threadId: z.string().max(200).optional(),
  fingerprint,
  severity: z.enum(['P0', 'P1', 'P2', 'P3', 'NIT']),
  path: z.string().min(1).max(4_000),
  line: z.number().int().positive().safe().optional(),
  title: z.string().max(1_000),
  body: z.string().max(4_000).optional(),
  resolved: z.boolean(),
  outdated: z.boolean(),
  resolution: z.object({
    author: z.string().min(1).max(200),
    reason: z.string().min(1).max(1_000),
    at: z.string().max(64).optional(),
  }).strict().optional(),
}).strict();
export const findingThreadsReadResultSchema = z.object({
  version: z.literal('FindingThreadsReadResult.v1'),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  headSha: z.string().regex(/^[a-f0-9]{40}$/u),
  complete: z.boolean(),
  omittedCount: z.number().int().nonnegative().safe(),
  threads: z.array(priorThreadSchema).max(500),
}).strict().superRefine((result, context) => {
  if (result.complete && result.omittedCount !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['omittedCount'], message: 'complete thread history cannot omit entries' });
  }
  if (!result.complete && result.omittedCount === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['omittedCount'], message: 'partial thread history must disclose omitted entries' });
  }
});

export const findingThreadsResultSchema = z.object({
  version: z.enum(['FindingThreadsResult.v1', 'FindingThreadsResult.v2']),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  created: z.number().int().nonnegative().safe(),
  skipped: z.number().int().nonnegative().safe(),
  resolved: z.number().int().nonnegative().safe(),
}).strict();
