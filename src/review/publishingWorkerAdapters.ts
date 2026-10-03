import { HttpWorkerCompletionAdapter } from './workerCompletion';
import { HttpWorkerReviewCompletionAdapter } from './workerReviewCompletionHttp';
import { HttpIncrementalBaseSource } from './incrementalBaseHttp';
import { incrementalReviewEnabledFor } from './incrementalReview';
import { HttpVerdictCacheBaseSource } from './verdictCacheBaseHttp';
import { verdictCacheEnabledFor } from './verdictCache';
import { HttpIncompleteP2RecoverySource } from './incompleteP2RecoveryHttp';
import { HttpReviewExecutionCheckpointAdapter } from './reviewExecutionCheckpointHttp';
import { HttpFindingThreadsPublisher } from './findingThreadsHttp';

/** ADR 0002: the finding-thread publisher. Fail-soft: a publisher that cannot be built leaves the
 * run without new threads; the check's required-finding decision does not depend on it. */
function findingThreadsFor(env: Readonly<Record<string, string | undefined>>, token: string, endpoint: string):
  { findingThreads?: HttpFindingThreadsPublisher } {
  try {
    return { findingThreads: new HttpFindingThreadsPublisher({
      token, completionEndpoint: endpoint, runId: String(env.REVIEW_RUN_ID || '').trim(),
      executionAttempt: Number(String(env.REVIEW_EXECUTION_ATTEMPT || '1').trim()),
    }) };
  } catch {
    return {};
  }
}

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

/** REL-1085: the verdict-cache source read, only when the flag is on for this repository.
 * Fail-soft: a source that cannot be built leaves the run without cache hits. */
function verdictCacheBaseFor(env: Readonly<Record<string, string | undefined>>, token: string, endpoint: string):
  { verdictCacheBase?: HttpVerdictCacheBaseSource } {
  if (!verdictCacheEnabledFor(env, String(env.REVIEW_REPO || ''))) return {};
  try {
    return { verdictCacheBase: new HttpVerdictCacheBaseSource({
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
  verdictCacheBase?: HttpVerdictCacheBaseSource;
  incompleteP2Recovery?: HttpIncompleteP2RecoverySource;
  reviewCheckpoint?: HttpReviewExecutionCheckpointAdapter;
  findingThreads?: HttpFindingThreadsPublisher;
} {
  const endpoint = String(env.REVIEW_COMPLETION_URL || '').trim();
  const flag = String(env.REVIEW_AUTHORITATIVE_GATE || '').trim();
  if (flag && flag !== 'true' && flag !== 'false') throw new Error('Invalid authoritative worker flag');
  if (!endpoint) {
    if (flag === 'true') throw new Error('Authoritative review worker requires its completion endpoint');
    return {};
  }
  return flag === 'true'
    ? { reviewCompletion: new HttpWorkerReviewCompletionAdapter({ token, endpoint }), ...incrementalBaseFor(env, token, endpoint),
      reviewCheckpoint: new HttpReviewExecutionCheckpointAdapter({ token, completionEndpoint: endpoint,
        runId: String(env.REVIEW_RUN_ID ?? ''), executionAttempt: Number(env.REVIEW_EXECUTION_ATTEMPT ?? '1') }),
      ...(Number(env.REVIEW_EXECUTION_ATTEMPT ?? '1') > 1 ? {
        incompleteP2Recovery: new HttpIncompleteP2RecoverySource({ token, completionEndpoint: endpoint,
          runId: String(env.REVIEW_RUN_ID ?? ''), executionAttempt: Number(env.REVIEW_EXECUTION_ATTEMPT) }),
      } : {}),
      ...verdictCacheBaseFor(env, token, endpoint), ...findingThreadsFor(env, token, endpoint) }
    : { completion: new HttpWorkerCompletionAdapter({ token, endpoint }), ...incrementalBaseFor(env, token, endpoint),
      ...verdictCacheBaseFor(env, token, endpoint), ...findingThreadsFor(env, token, endpoint) };
}
