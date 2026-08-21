import type { ReviewWorkflowAssignment } from '../review/reviewWorkflowAssignments';

export const REVIEW_WORKFLOW_PACKAGE: '@quintinshaw/pi-dynamic-workflows';
export const REVIEW_WORKFLOW_PACKAGE_VERSION: '3.7.0';

export interface PiWorkflowRuntime {
  runWorkflow: (source: string, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  WorkflowAgent: new (...args: unknown[]) => unknown;
}

export interface DynamicReviewWorkflowResult {
  readonly results: readonly unknown[];
  readonly concurrency: number;
  readonly workflowSchemaVersion: 'review-yeti-pi-workflow.v1';
  readonly workflowScriptDigest: string;
  readonly [key: string]: unknown;
}

export function loadPiWorkflowRuntime(options?: {
  packageRoot?: string;
  provenance?: Record<string, unknown>;
  provenancePath?: string;
  requireNested?: boolean;
}): Promise<PiWorkflowRuntime>;

export function runDynamicReviewWorkflow(options: {
  immutableIdentity: { policyDigest: string; manifestDigest: string; [key: string]: unknown };
  assignments: readonly ReviewWorkflowAssignment[];
  runId: string;
  resumeFromRunId?: string | null;
  concurrency?: number;
  deadlineMs: number;
  agent: { run(prompt: string, options?: Record<string, unknown>): Promise<unknown> };
  signal?: AbortSignal;
  resumeJournal?: Map<string, unknown>;
  onAgentJournal?: (entry: unknown) => void;
  onAgentStart?: (entry: unknown) => void;
  onAgentEnd?: (entry: unknown) => void;
  onPhase?: (phase: string) => void;
  onRuntimeEvent?: (event: unknown) => void;
  persistLogs?: boolean;
}): Promise<DynamicReviewWorkflowResult>;
