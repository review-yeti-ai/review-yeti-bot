/**
 * Model Context Protocol (MCP) Review Yeti Tool Schemas
 *
 * Strict Zod input and output validation schemas and TypeScript type definitions
 * for all 8 core Review Yeti MCP tools.
 */

import { z } from 'zod';

// Commit SHA validation regex: 40-char SHA-1 or 64-char SHA-256
export const COMMIT_SHA_40_REGEX = /^[a-f0-9]{40}$/i;
export const COMMIT_SHA_FLEX_REGEX = /^[a-f0-9]{7,64}$/i;

// Maximum allowed preflight diff size: 512 KB
export const MAX_PREFLIGHT_DIFF_BYTES = 512 * 1024;

// =============================================================================
// 1. get_review_status
// =============================================================================

export const GetReviewStatusInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pull_number: z.number().int().positive('pull_number must be a positive integer').safe(),
  head_sha: z.string().trim().regex(COMMIT_SHA_FLEX_REGEX, 'head_sha must be a valid commit SHA of 7 to 64 hex characters').optional(),
}).strict();

export type GetReviewStatusInput = z.infer<typeof GetReviewStatusInputSchema>;

export interface ReviewCheckRun {
  id: number | null;
  url: string | null;
  conclusion: string | null;
}

export interface ReviewActiveWorker {
  pod_name: string;
  started_at: string;
  lease_expires_at: string;
}

export interface ReviewStatusOutput {
  found: boolean;
  verdict: 'SHIP' | 'NACK' | 'COMMENT' | 'FIX_FIRST' | 'PENDING' | 'RUNNING' | 'FAILED';
  attempt_id: string | null;
  head_sha: string | null;
  phase: 'queued' | 'evaluating_personas' | 'arbitration' | 'completed';
  check_run: ReviewCheckRun | null;
  active_worker: ReviewActiveWorker | null;
  message?: string;
}

// =============================================================================
// 2. get_review_findings
// =============================================================================

export const FindingSeveritySchema = z.enum(['P0', 'P1', 'P2']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingCategorySchema = z.enum(['Architecture', 'Security', 'Testing', 'Dependencies', 'Contract']);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const GetReviewFindingsInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pull_number: z.number().int().positive('pull_number must be a positive integer').safe(),
  severity: FindingSeveritySchema.optional(),
  unresolved_only: z.boolean().default(true).optional(),
}).strict();

export type GetReviewFindingsInput = z.infer<typeof GetReviewFindingsInputSchema>;

export interface ReviewFindingItem {
  finding_id: string;
  severity: FindingSeverity;
  category: FindingCategory | string;
  title: string;
  file_path: string;
  line_start: number;
  line_end: number;
  violated_adrs: string[];
  rationale: string;
  suggested_fix: string;
  unresolved?: boolean;
}

export interface ReviewFindingsOutput {
  findings: ReviewFindingItem[];
  total_count: number;
  unresolved_count: number;
}

// =============================================================================
// 3. get_model_matrix
// =============================================================================

export const BenchmarkTypeSchema = z.enum(['verified', 'lite']);
export type BenchmarkTypeInput = z.infer<typeof BenchmarkTypeSchema>;

export const ModelMatrixSortFieldSchema = z.enum(['swe-score', 'cost', 'efficiency', 'context', 'name']);
export type ModelMatrixSortFieldInput = z.infer<typeof ModelMatrixSortFieldSchema>;

export const GetModelMatrixInputSchema = z.object({
  benchmark_type: BenchmarkTypeSchema.default('verified'),
  sort_by: ModelMatrixSortFieldSchema.default('swe-score'),
  limit: z.number().int().min(1, 'limit must be >= 1').max(100, 'limit must be <= 100').default(20),
}).strict();

export type GetModelMatrixInput = z.infer<typeof GetModelMatrixInputSchema>;

export interface ModelMatrixEntryOutput {
  id: string;
  name: string;
  provider: string;
  description?: string;
  context_length: number;
  max_completion_tokens?: number;
  swe_score: number;
  swe_score_verified: number;
  swe_score_lite: number;
  prompt_cost_per_1m: number;
  completion_cost_per_1m: number;
  total_cost_per_1m: number;
  blended_cost_per_1m: number;
  cost_efficiency: number;
  eval_framework?: string;
  has_benchmark_data: boolean;
  is_fallback: boolean;
}

export interface ModelMatrixSummaryOutput {
  avg_score: number;
  avg_blended_cost_per_1m: number;
  avg_efficiency: number;
  models_with_benchmark_data_count: number;
  is_using_fallback_pricing: boolean;
  best_score_model: { id: string; name: string; score: number } | null;
  best_efficiency_model: { id: string; name: string; efficiency: number } | null;
  cheapest_model: { id: string; name: string; blended_cost: number } | null;
}

export interface ModelMatrixOutput {
  benchmark_type: string;
  total_models: number;
  returned_models: number;
  models: ModelMatrixEntryOutput[];
  summary: ModelMatrixSummaryOutput;
  timestamp: number;
}

// =============================================================================
// 4. trigger_review
// =============================================================================

export const ReviewPrioritySchema = z.enum(['normal', 'expedited']);
export type ReviewPriority = z.infer<typeof ReviewPrioritySchema>;

export const TriggerReviewInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pull_number: z.number().int().positive('pull_number must be a positive integer').safe(),
  head_sha: z.string().trim().regex(COMMIT_SHA_40_REGEX, 'head_sha must be a 40-character hexadecimal commit SHA'),
  force: z.boolean().default(false).optional(),
  priority: ReviewPrioritySchema.default('normal').optional(),
}).strict();

export type TriggerReviewInput = z.infer<typeof TriggerReviewInputSchema>;

export interface TriggerReviewOutput {
  dispatched: boolean;
  attempt_id: string;
  job_crd_created: boolean;
  message: string;
}

// =============================================================================
// 5. cancel_review
// =============================================================================

export const CancelReviewInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pull_number: z.number().int().positive('pull_number must be a positive integer').safe(),
  reason: z.string().trim().min(1, 'reason is required for audit trail'),
}).strict();

export type CancelReviewInput = z.infer<typeof CancelReviewInputSchema>;

export interface CancelReviewOutput {
  cancelled: boolean;
  attempt_id: string;
  reaped_pod?: string | boolean;
  message: string;
}

// =============================================================================
// 6. watch_review_progress
// =============================================================================

export const WatchReviewProgressInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pull_number: z.number().int().positive('pull_number must be a positive integer').safe(),
  head_sha: z.string().trim().regex(COMMIT_SHA_FLEX_REGEX, 'head_sha must be a valid commit SHA').optional(),
  timeout_seconds: z.number().int().min(1, 'timeout_seconds must be between 1 and 900 seconds').max(900, 'timeout_seconds must be between 1 and 900 seconds').default(300).optional(),
  cursor: z.string().trim().optional(),
}).strict();

export type WatchReviewProgressInput = z.infer<typeof WatchReviewProgressInputSchema>;

export interface PersonaProgressEvent {
  event: 'persona_progress';
  persona: string;
  turn_index: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  timestamp: string;
  findings_count?: number;
}

export interface ToolInvocationEvent {
  event: 'tool_invocation';
  persona: string;
  tool_name: string;
  target?: string;
  duration_ms: number;
  timestamp: string;
}

export interface VerdictDeclaredEvent {
  event: 'verdict_declared';
  verdict: 'SHIP' | 'FIX_FIRST' | 'NACK' | 'COMMENT';
  summary: string;
  timestamp: string;
}

export type ProgressEvent =
  | PersonaProgressEvent
  | ToolInvocationEvent
  | VerdictDeclaredEvent;

export interface WatchReviewProgressOutput {
  streaming: boolean;
  events: ProgressEvent[];
  last_cursor?: string;
  timed_out?: boolean;
}

// =============================================================================
// 7. preflight_diff_review
// =============================================================================

export const PreflightDiffReviewInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255).optional(),
  diff: z.string()
    .min(1, 'diff cannot be empty')
    .refine(
      (val) => Buffer.byteLength(val, 'utf8') <= MAX_PREFLIGHT_DIFF_BYTES,
      { message: `diff exceeds maximum allowed size of 512KB (${MAX_PREFLIGHT_DIFF_BYTES} bytes)` }
    ),
  repo: z.string().trim().min(1, 'repo identifier is required'),
  target_branch: z.string().default('main').optional(),
  model: z.string().optional(),
}).strict();

export type PreflightDiffReviewInput = z.infer<typeof PreflightDiffReviewInputSchema>;

export interface PreflightFinding {
  finding_id?: string;
  severity: 'P0' | 'P1' | 'P2';
  category: 'Architecture' | 'Security' | 'Testing' | 'Dependencies' | 'Contract' | string;
  title: string;
  file_path: string;
  line?: number;
  rationale: string;
  suggested_fix?: string;
}

export interface PreflightDiffReviewOutput {
  eligible_to_ship: boolean;
  findings: PreflightFinding[];
  blast_radius_summary: string;
}

// =============================================================================
// 8. explain_finding
// =============================================================================

export const ExplainFindingInputSchema = z.object({
  finding_id: z.string().trim().min(1, 'finding_id is required'),
  question: z.string().trim().min(1, 'question is required'),
  owner: z.string().trim().min(1, 'owner must not be empty').max(255).optional(),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255).optional(),
  pull_number: z.number().int().positive('pull_number must be a positive integer').safe().optional(),
}).strict();

export type ExplainFindingInput = z.infer<typeof ExplainFindingInputSchema>;

export interface ExplainFindingOutput {
  explanation: string;
  satisfies_requirement: boolean | null;
  citations: string[];
}
