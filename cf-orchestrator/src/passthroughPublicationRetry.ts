import type { OperatorPassthroughResult } from './operatorPassthroughTypes.js';

/**
 * The paused (passthrough) publication creates the Review Yeti and Review Yeti Gate checks in progress
 * and completes them in later mutations. A failure between those two points (for example a transient
 * GitHub or Durable Object error on the completing PATCH) returns an `unavailable` result and leaves the
 * pair `in_progress`. The publisher is built to resume on the same run id and complete the same check
 * ids without creating another pair, but the workflow ran the publication as a single step with no retry,
 * so nothing ever resumed it. This re-runs the same publication for transient failures only.
 */
export const PASSTHROUGH_PUBLICATION_MAX_ATTEMPTS = 3;

/** Availability failures that can clear on their own. Verdicts, cancellations and identity errors are not here. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'authoritative_read_unavailable',
  'durable_state_unavailable',
  'check_publication_unavailable',
  'check_readback_unavailable',
  'audit_unavailable',
  'deadline_exceeded',
  'prior_outcome_unavailable',
  'prior_do_unavailable',
  'prior_workflow_state_unavailable',
  'prior_queue_state_unavailable',
  'prior_review_state_unavailable',
  'prior_check_state_unavailable',
  'prior_check_metadata_unavailable',
]);

export function isRetryablePublicationFailure(result: OperatorPassthroughResult): boolean {
  const code = (result as { errorCode?: unknown }).errorCode;
  return result.status === 'unavailable' && typeof code === 'string' && RETRYABLE_CODES.has(code);
}

interface WorkflowStep {
  do(name: string, config: unknown, fn: () => Promise<unknown>): Promise<unknown>;
  sleep?: (name: string, duration: string) => Promise<unknown>;
}

export async function publishPassthroughWithRetry(
  step: WorkflowStep,
  stepName: string,
  stepConfig: unknown,
  publish: () => Promise<OperatorPassthroughResult>,
  context: { runId?: string; prNumber?: number; headSha?: string } = {},
): Promise<OperatorPassthroughResult> {
  let result!: OperatorPassthroughResult;
  for (let attempt = 1; attempt <= PASSTHROUGH_PUBLICATION_MAX_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? stepName : `${stepName}-retry-${attempt - 1}`;
    result = await step.do(name, stepConfig, publish) as OperatorPassthroughResult;
    if (result.status !== 'unavailable') return result;
    const retry = isRetryablePublicationFailure(result) && attempt < PASSTHROUGH_PUBLICATION_MAX_ATTEMPTS;
    // One line per failed attempt: the code is otherwise only visible in a stored receipt.
    console.warn(JSON.stringify({
      event: 'operator_passthrough_publication_failed',
      attempt,
      errorCode: (result as { errorCode?: string }).errorCode,
      willRetry: retry,
      runId: context.runId,
      prNumber: context.prNumber,
      headSha: context.headSha?.slice(0, 12),
    }));
    if (!retry) return result;
    if (typeof step.sleep === 'function') await step.sleep(`${stepName}-backoff-${attempt}`, `${attempt * 2} seconds`);
  }
  return result;
}
