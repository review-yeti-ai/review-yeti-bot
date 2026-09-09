export const REQUIRED_REVIEW_CONTEXT = 'Review Yeti / Review Yeti';
export const REQUIRED_REVIEW_APP_ID = 15368;
export const REQUIRED_REVIEW_VERDICT = 'Review Yeti';
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

function validCheckRunId(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string'
      && /^[1-9][0-9]*$/u.test(value)
      && Number.isSafeInteger(Number(value)));
}

function latestRun(runs) {
  return [...runs].sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0)).at(-1);
}

function inspect(runs, expectedHeadSha, publisher, publisherLabel) {
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
  if (latest?.status !== 'completed' || latest?.conclusion !== 'success') {
    failures.push(`${publisherLabel} latest exact-head run is not successful`);
  }
  return { failures, latest };
}

export function evaluateExactCheckRuns(checkRuns, expectedHeadSha) {
  if (!Array.isArray(checkRuns)) return { failures: ['head check-run evidence is malformed or unavailable'] };
  const context = inspect(
    checkRuns.filter((run) => run?.name === REQUIRED_REVIEW_CONTEXT),
    expectedHeadSha,
    (run) => Number(run?.app?.id) === REQUIRED_REVIEW_APP_ID,
    REQUIRED_REVIEW_CONTEXT,
  );
  const verdict = inspect(
    checkRuns.filter((run) => run?.name === REQUIRED_REVIEW_VERDICT),
    expectedHeadSha,
    (run) => run?.app?.slug === REQUIRED_REVIEW_SLUG,
    REQUIRED_REVIEW_VERDICT,
  );
  return {
    failures: [...context.failures, ...verdict.failures],
    context: context.latest,
    verdict: verdict.latest,
    context_count: checkRuns.filter((run) => run?.name === REQUIRED_REVIEW_CONTEXT).length,
    verdict_count: checkRuns.filter((run) => run?.name === REQUIRED_REVIEW_VERDICT).length,
  };
}
