import type { ReviewModelClient } from '../gateway/openRouterClient';
import type { GroundedVerifierRequestContextV1 } from '../gateway/openRouterClient';
import type { DisputedBlockerAdjudicator } from '../config/schema';

// A 4,096-token combined output ceiling leaves room for 2,048 reasoning tokens
// and a usable final verifier response. The engine still owns the 100-call / 12
// per-task counters, concurrency, stage deadline, cancellation, and response cap.
const ADJUDICATOR_MAX_OUTPUT_TOKENS = 4_096;
const ADJUDICATOR_REASONING_MAX_TOKENS = 2_048;

/**
 * Binds the existing Bifrost client to the prepared alternate model alias.
 * The grounded verifier still owns dispute matching, call accounting, deadlines,
 * and deciding whether this route is used. This wrapper prevents that call from
 * silently changing model or adding provider/model fallbacks, and applies the
 * bounded reasoning/output split only after the alternate route is selected.
 */
export function createDisputedBlockerAdjudicatorClient(
  primaryClient: ReviewModelClient,
  selection: DisputedBlockerAdjudicator,
): { model: string; reasoningEffort: DisputedBlockerAdjudicator['reasoning_effort']; client: ReviewModelClient } {
  const client: ReviewModelClient = {
    complete: async (request, context?: GroundedVerifierRequestContextV1) => {
      if (request.model !== selection.model) {
        throw new Error('request does not match the configured adjudicator model');
      }
      if ((request.models?.length ?? 0) > 0 || request.provider !== undefined) {
        throw new Error('adjudicator route cannot add model or provider fallbacks');
      }
      if (request.maxRetries !== undefined || request.initialRetryDelayMs !== undefined
        || request.maxRetryDelayMs !== undefined || request.sleep !== undefined || request.random !== undefined) {
        throw new Error('adjudicator route cannot override the existing retry policy');
      }
      return await primaryClient.complete({ ...request, model: selection.model,
        reasoningEffort: selection.reasoning_effort, maxTokens: ADJUDICATOR_MAX_OUTPUT_TOKENS,
        reasoning: { effort: selection.reasoning_effort, max_tokens: ADJUDICATOR_REASONING_MAX_TOKENS } }, context);
    },
  };
  return { model: selection.model, reasoningEffort: selection.reasoning_effort, client };
}
