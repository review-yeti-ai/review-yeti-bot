/**
 * ADR 0002: the wire contract of `POST /api/dispatch/finding-threads`, shared by the worker client
 * (`findingThreadsHttp.ts`) and the service route (`src/api/findingThreadsRoute.ts`). Kept in
 * `src/review` so the worker side does not depend on the API layer.
 */
import { z } from 'zod';

export const FINDING_THREADS_REQUEST_VERSION = 'FindingThreadsRequest.v1' as const;
export const MAX_FINDING_THREADS_REQUEST_BYTES = 256 * 1024;
export const MAX_FINDING_THREADS_PER_REQUEST = 30;
export const MAX_REPORTED_FINGERPRINTS = 400;

const fingerprint = z.string().regex(/^fp1_[a-f0-9]{24}$/u);
export const findingThreadsRequestSchema = z.object({
  version: z.literal(FINDING_THREADS_REQUEST_VERSION),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/u),
  publish: z.array(z.object({
    fingerprint,
    severity: z.enum(['P0', 'P1', 'P2']),
    path: z.string().min(1).max(4_000),
    line: z.number().int().positive().safe(),
    title: z.string().min(1).max(1_000),
    body: z.string().min(1).max(16_000),
  }).strict()).max(MAX_FINDING_THREADS_PER_REQUEST),
  reported: z.array(fingerprint).max(MAX_REPORTED_FINGERPRINTS),
}).strict();
export type FindingThreadsRequest = z.infer<typeof findingThreadsRequestSchema>;

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
  severity: z.enum(['P0', 'P1', 'P2']),
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
  threads: z.array(priorThreadSchema).max(500),
}).strict();

export const findingThreadsResultSchema = z.object({
  version: z.literal('FindingThreadsResult.v1'),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  created: z.number().int().nonnegative().safe(),
  skipped: z.number().int().nonnegative().safe(),
  resolved: z.number().int().nonnegative().safe(),
}).strict();
