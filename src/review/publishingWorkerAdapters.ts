import { HttpWorkerCompletionAdapter } from './workerCompletion';
import { HttpWorkerReviewCompletionAdapter } from './workerReviewCompletionHttp';
import { HttpIncrementalBaseSource } from './incrementalBaseHttp';
import { incrementalReviewEnabledFor } from './incrementalReview';

/** REL-1084: the prior-review read for incremental planning, only when the flag is on for this
 * repository. Fail-soft: a source that cannot be built leaves the run on a full review. */
function incrementalBaseFor(env: Readonly<Record<string, string | undefined>>, token: string, endpoint: string):
  { incrementalBase?: HttpIncrementalBaseSource } {
  if (!incrementalReviewEnabledFor(env, String(env.REVIEW_REPO || ''))) return {};
  try {
    return { incrementalBase: new HttpIncrementalBaseSource({
      token, completionEndpoint: endpoint, runId: String(env.REVIEW_RUN_ID || '').trim(),
      executionAttempt: Number(String(env.REVIEW_EXECUTION_ATTEMPT || '1').trim()),
    }) };
  } catch {
    return {};
  }
}

/** The CLI and tests use one selection boundary. An enrolled worker never
 * falls back to the legacy failure-only callback when its endpoint is absent. */
export function publishingWorkerAdapters(env: Readonly<Record<string, string | undefined>>, token: string): {
  completion?: HttpWorkerCompletionAdapter;
  reviewCompletion?: HttpWorkerReviewCompletionAdapter;
  incrementalBase?: HttpIncrementalBaseSource;
} {
  const endpoint = String(env.REVIEW_COMPLETION_URL || '').trim();
  const flag = String(env.REVIEW_AUTHORITATIVE_GATE || '').trim();
  if (flag && flag !== 'true' && flag !== 'false') throw new Error('Invalid authoritative worker flag');
  if (!endpoint) {
    if (flag === 'true') throw new Error('Authoritative review worker requires its completion endpoint');
    return {};
  }
  return flag === 'true'
    ? { reviewCompletion: new HttpWorkerReviewCompletionAdapter({ token, endpoint }), ...incrementalBaseFor(env, token, endpoint) }
    : { completion: new HttpWorkerCompletionAdapter({ token, endpoint }), ...incrementalBaseFor(env, token, endpoint) };
}
