export interface ReviewWorkflowPassDescriptor {
  readonly passId: string;
  readonly reviewUnitIds: readonly string[];
  readonly prompt: string;
  readonly promptDigest: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchemaDigest: string;
}

export interface ReviewWorkflowAssignment {
  readonly schema: 'review-yeti-assignment.v1';
  readonly assignmentId: string;
  readonly personaId: string;
  readonly passes: readonly ReviewWorkflowPassDescriptor[];
  readonly assignmentPrompt: string;
  readonly assignmentPromptDigest: string;
  readonly personaResultSchema: Readonly<Record<string, unknown>>;
  readonly personaResultSchemaDigest: string;
}

export interface ReviewWorkflowPersonaInput {
  personaId: string;
  enabled?: boolean;
  assignmentPrompt: string;
  personaResultSchema: Record<string, unknown>;
  passes: Array<{
    passId: string;
    reviewUnitIds: string[];
    prompt: string;
    outputSchema: Record<string, unknown>;
  }>;
}

export const REVIEW_WORKFLOW_ASSIGNMENT_SCHEMA: 'review-yeti-assignment.v1';
export function createReviewWorkflowAssignments(input: {
  policyDigest: string;
  manifestDigest: string;
  personas: ReviewWorkflowPersonaInput[];
}): readonly ReviewWorkflowAssignment[];
export function validateReviewWorkflowAssignments(
  assignments: readonly ReviewWorkflowAssignment[],
  identity: { policyDigest: string; manifestDigest: string },
): readonly ReviewWorkflowAssignment[];
export function digestReviewWorkflowAssignments(assignments: readonly ReviewWorkflowAssignment[]): string;
