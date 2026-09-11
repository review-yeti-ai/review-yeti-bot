export const REQUIRED_REVIEW_CONTEXT = 'Review Yeti';
export const REQUIRED_REVIEW_APP_ID = 4385771;
export const REQUIRED_REVIEW_VERDICT = REQUIRED_REVIEW_CONTEXT;
export const REQUIRED_REVIEW_SLUG = 'ct-review-bot';
// Queue entry shapes remain owned by each caller, but the set of states that
// can be examined is one shared policy. Keeping it here prevents readiness and
// the merge-group action from drifting on the allowed-state decision.
export const QUALIFYING_MERGE_QUEUE_STATES = Object.freeze([
  'QUEUED',
  'AWAITING_CHECKS',
  'SPECULATIVE',
  'BUILT',
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKER_REVIEW_EXTERNAL_ID_PATTERN = /^run_[a-f0-9]{32}:a[1-9][0-9]*$/u;

function validCheckRunId(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string'
      && /^[1-9][0-9]*$/u.test(value)
      && Number.isSafeInteger(Number(value)));
}

function latestRun(runs) {
  return [...runs].sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0)).at(-1);
}

function inspect(runs, expectedHeadSha, publisher, publisherLabel, options = {}) {
  const failures = [];
  if (runs.length === 0) {
    failures.push(`${publisherLabel} has no check-run evidence`);
    return { failures, latest: null };
  }
  // GitHub check identity includes the publishing App, not just its label.
  // A similarly named local/operator check must neither approve the PR nor
  // replace the latest verdict from the official publisher.
  runs = runs.filter((run) => publisher(run) === true);
  if (runs.length === 0) {
    failures.push(`${publisherLabel} has no evidence from the required publisher`);
    return { failures, latest: null };
  }
  if (options.requireWorkerExternalId === true) {
    runs = runs.filter((run) => WORKER_REVIEW_EXTERNAL_ID_PATTERN.test(String(run?.external_id || '')));
    if (runs.length === 0) {
      failures.push(`${publisherLabel} has no worker review evidence`);
      return { failures, latest: null };
    }
  }
  if (runs.some((run) => !validCheckRunId(run?.id))) {
    failures.push(`${publisherLabel} has a check run with no valid immutable id`);
  }
  if (runs.some((run) => !SHA_PATTERN.test(String(run?.head_sha || '')))) {
    failures.push(`${publisherLabel} has a check run with no exact head SHA`);
  }
  if (expectedHeadSha && runs.some((run) => run.head_sha !== expectedHeadSha)) {
    failures.push(`${publisherLabel} contains a stale head SHA`);
  }
  const latest = latestRun(runs);
  const allowedConclusions = options.successOnly === true ? ['success'] : ['success', 'skipped'];
  if (latest?.status !== 'completed' || !allowedConclusions.includes(latest?.conclusion)) {
    failures.push(`${publisherLabel} latest exact-head run is not ${options.successOnly === true ? 'successful' : 'successful or skipped'}`);
  }
  return { failures, latest };
}

export function evaluateExactCheckRuns(checkRuns, expectedHeadSha) {
  if (!Array.isArray(checkRuns)) return { failures: ['head check-run evidence is malformed or unavailable'] };
  const native = inspect(
    checkRuns.filter((run) => run?.name === REQUIRED_REVIEW_CONTEXT),
    expectedHeadSha,
    (run) => Number(run?.app?.id) === REQUIRED_REVIEW_APP_ID
      && run?.app?.slug === REQUIRED_REVIEW_SLUG,
    REQUIRED_REVIEW_CONTEXT,
  );
  const count = checkRuns.filter((run) => run?.name === REQUIRED_REVIEW_CONTEXT).length;
  return {
    failures: native.failures,
    context: native.latest,
    verdict: native.latest,
    context_count: count,
    verdict_count: count,
  };
}

// A merge-group constituent must have real worker output. App-owned
// passthrough and synthetic merge-group attestations deliberately share the
// protected context name, so publisher identity alone is insufficient here.
export function evaluateExactWorkerReviewCheckRuns(checkRuns, expectedHeadSha) {
  if (!Array.isArray(checkRuns)) return { failures: ['head check-run evidence is malformed or unavailable'] };
  const worker = inspect(
    checkRuns.filter((run) => run?.name === REQUIRED_REVIEW_CONTEXT),
    expectedHeadSha,
    (run) => Number(run?.app?.id) === REQUIRED_REVIEW_APP_ID
      && run?.app?.slug === REQUIRED_REVIEW_SLUG,
    REQUIRED_REVIEW_CONTEXT,
    { requireWorkerExternalId: true, successOnly: true },
  );
  const count = checkRuns.filter((run) => run?.name === REQUIRED_REVIEW_CONTEXT).length;
  return {
    failures: worker.failures,
    context: worker.latest,
    verdict: worker.latest,
    context_count: count,
    verdict_count: count,
  };
}
