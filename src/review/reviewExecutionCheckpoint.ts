import { z } from 'zod';
import { MAX_DISPUTE_RECHECKS_PER_REVIEW } from './disputedFindingRecheck';
import {
  MAX_CHANGED_FILES,
  MAX_PATH_CHARACTERS,
} from './reviewEvidenceLimits';
import {
  MAX_TASKS_HARD_CAP,
  MAX_TASK_TEXT_LENGTH,
  TASK_DIMENSIONS,
  TASK_ID_PATTERN,
  type ReviewTask,
} from '../reviewTaskContract';
import type { PanelFinding } from '../panel/types';
import type { WorkerReviewCompletion } from './workerReviewCompletion';
import { canonicalJson } from './reviewCore';

export const REVIEW_EXECUTION_CHECKPOINT_VERSION = 'ReviewExecutionCheckpoint.v1' as const;
export const MAX_REVIEW_CHECKPOINT_BYTES = 600_000;

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveInteger = z.number().int().positive().safe();
const path = z.string().min(1).max(MAX_PATH_CHARACTERS);

const taskSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  dimension: z.enum(TASK_DIMENSIONS),
  paths: z.array(path).min(1).max(MAX_CHANGED_FILES),
  question: z.string().min(1).max(MAX_TASK_TEXT_LENGTH),
  rationale: z.string().min(1).max(MAX_TASK_TEXT_LENGTH),
}).strict();
const findingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']),
  path,
  line: positiveInteger,
  startLine: positiveInteger.optional(),
  title: z.string().min(1).max(4_000),
  body: z.string().min(1).max(16_000),
  suggestion: z.string().max(16_000).nullable().optional(),
  replacementCode: z.string().max(10_000).nullable().optional(),
  confidence: z.number().finite().min(0).max(100).optional(),
  recommendation: z.string().max(16_000).optional(),
  fixOptions: z.array(z.object({
    rank: positiveInteger.optional(),
    title: z.string().max(2_000).optional(),
    explanation: z.string().max(16_000).optional(),
    suggestionCode: z.string().max(10_000).optional(),
  }).strict()).max(8).optional(),
  isArchitectural: z.boolean().optional(),
}).strict().refine((value) => value.startLine === undefined || value.startLine <= value.line,
  'finding startLine must not exceed line');

const completedTaskSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  findings: z.array(findingSchema).max(400),
}).strict();

const checkpointSchema = z.object({
  version: z.literal(REVIEW_EXECUTION_CHECKPOINT_VERSION),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  repositoryId: positiveInteger,
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  prNumber: positiveInteger,
  headSha: sha,
  baseSha: sha,
  policyDigest: digest,
  configDigest: digest,
  executionAttempt: positiveInteger,
  revision: positiveInteger,
  /** Append-only worker receipt ids for completed dispute-triggered task re-reviews. */
  satisfiedFindingRecheckIds: z.array(z.string().uuid()).max(MAX_DISPUTE_RECHECKS_PER_REVIEW).optional(),
  plan: z.array(taskSchema).min(1).max(MAX_TASKS_HARD_CAP),
  completedTasks: z.array(completedTaskSchema).max(MAX_TASKS_HARD_CAP),
}).strict().superRefine((value, context) => {
  const planIds = new Set(value.plan.map((task) => task.id));
  const completedIds = new Set<string>();
  const recheckIds = value.satisfiedFindingRecheckIds ?? [];
  if (new Set(recheckIds).size !== recheckIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['satisfiedFindingRecheckIds'],
      message: 'satisfied disputed finding receipt ids must be unique' });
  }
  for (const [index, task] of value.completedTasks.entries()) {
    if (!planIds.has(task.id)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['completedTasks', index, 'id'], message: 'completed task is absent from plan' });
    if (completedIds.has(task.id)) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ['completedTasks', index, 'id'], message: 'completed task ids must be unique' });
    completedIds.add(task.id);
  }
});

export type ReviewExecutionCheckpoint = Omit<z.output<typeof checkpointSchema>, 'plan' | 'completedTasks'> & {
  plan: ReviewTask[];
  completedTasks: Array<{ id: string; findings: PanelFinding[] }>;
};

export function parseReviewExecutionCheckpoint(input: unknown): ReviewExecutionCheckpoint {
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json, 'utf8') > MAX_REVIEW_CHECKPOINT_BYTES) {
    throw new Error('review execution checkpoint exceeds its byte bound');
  }
  return checkpointSchema.parse(input) as ReviewExecutionCheckpoint;
}

export const reviewCheckpointReadRequestSchema = z.object({
  version: z.literal('ReviewExecutionCheckpointRead.v1'),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  executionAttempt: positiveInteger,
}).strict();

/** Bind a durable task checkpoint to the exact immutable completion that it represents. */
export function reviewCheckpointMatchesCompletion(
  checkpoint: ReviewExecutionCheckpoint, completion: WorkerReviewCompletion,
): boolean {
  const fields = ['runId', 'repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha',
    'policyDigest', 'configDigest', 'executionAttempt'] as const;
  return fields.every((field) => checkpoint[field] === completion[field])
    && completion.result.taskPlan !== undefined
    && canonicalJson(checkpoint.plan) === canonicalJson(completion.result.taskPlan);
}
