/**
 * edgeCheckPublisher.ts
 *
 * Authoritative GitHub Check Run publisher for Cloudflare Edge.
 * Manages the lifecycle of both "Review Yeti" (worker execution) and
 * "Review Yeti Gate" (merge eligibility gate) check runs.
 */

export const REVIEW_WORKER_CHECK_NAME = 'Review Yeti';
export const REVIEW_GATE_CHECK_NAME = 'Review Yeti Gate';

export const REVIEW_REFRESH_ACTION = Object.freeze({
  label: 'Refresh review',
  description: 'Retry failed review for this exact head.',
  identifier: 'review-yeti/refresh',
});

export interface CheckFinding {
  path: string;
  line: number;
  startLine?: number;
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'info' | 'critical' | 'major' | 'minor' | 'nit';
  title: string;
  description: string;
  suggestedFix?: string;
  ruleId?: string;
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
  raw_details?: string;
}

export interface PendingCheckOptions {
  owner: string;
  repo: string;
  headSha: string;
  runId: string;
  token: string;
  executionAttempt?: number;
  detailsUrl?: string;
  fetchFn?: typeof fetch;
}

export interface CompleteCheckOptions {
  owner: string;
  repo: string;
  headSha: string;
  runId: string;
  token: string;
  verdict: 'success' | 'action_required' | 'neutral' | 'failure' | 'cancelled' | 'timed_out';
  summaryMarkdown?: string;
  workerTitle?: string;
  gateTitle?: string;
  gateSummary?: string;
  findings?: CheckFinding[];
  workerCheckId?: number;
  gateCheckId?: number;
  executionAttempt?: number;
  detailsUrl?: string;
  fetchFn?: typeof fetch;
}

export interface CheckPublisherResult {
  workerCheckId?: number;
  gateCheckId?: number;
  errors?: string[];
}

/**
 * Derives external ID for Worker Check: {runId}:a{executionAttempt}
 */
export function deriveWorkerExternalId(runId: string, executionAttempt = 1): string {
  return `${runId}:a${executionAttempt}`;
}

/**
 * Derives deterministic external ID for Gate Check: review-yeti-gate:v1:{hash}
 */
export async function deriveGateExternalId(params: {
  owner: string;
  repo: string;
  headSha: string;
  runId: string;
  executionAttempt?: number;
}): Promise<string> {
  const canonical = JSON.stringify([
    params.owner,
    params.repo,
    params.headSha,
    params.runId,
    params.executionAttempt || 1,
  ]);
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `review-yeti-gate:v1:${hex}`;
}

/**
 * Converts findings to GitHub Check Run annotations (max 50 per GitHub API limit).
 */
export function formatCheckAnnotations(findings: CheckFinding[]): CheckAnnotation[] {
  return findings
    .filter((f) => Boolean(f.path && typeof f.line === 'number' && f.line > 0))
    .slice(0, 50)
    .map((f) => {
      const isBlocker =
        f.severity === 'P0' ||
        f.severity === 'P1' ||
        f.severity === 'critical' ||
        f.severity === 'major';

      const annotation: CheckAnnotation = {
        path: f.path,
        start_line: f.startLine && f.startLine > 0 && f.startLine <= f.line ? f.startLine : f.line,
        end_line: f.line,
        annotation_level: isBlocker ? 'failure' : 'warning',
        title: f.title ? `[${f.severity.toUpperCase()}] ${f.title}` : `[${f.severity.toUpperCase()}] Finding`,
        message: f.description?.trim() || 'Code review finding',
      };

      if (f.suggestedFix) {
        annotation.raw_details = `Suggested fix:\n${f.suggestedFix}`;
      }

      return annotation;
    });
}

/**
 * Creates initial "in_progress" check runs for both Review Yeti and Review Yeti Gate.
 */
export async function createPendingChecks(options: PendingCheckOptions): Promise<CheckPublisherResult> {
  const {
    owner,
    repo,
    headSha,
    runId,
    token,
    executionAttempt = 1,
    detailsUrl,
    fetchFn = fetch,
  } = options;

  const result: CheckPublisherResult = {};
  const errors: string[] = [];

  const workerExternalId = deriveWorkerExternalId(runId, executionAttempt);
  const gateExternalId = await deriveGateExternalId({ owner, repo, headSha, runId, executionAttempt });
  const startedAt = new Date().toISOString();

  // 1. Create Worker Check Run
  try {
    const workerRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: REVIEW_WORKER_CHECK_NAME,
        head_sha: headSha,
        status: 'in_progress',
        started_at: startedAt,
        external_id: workerExternalId,
        ...(detailsUrl ? { details_url: detailsUrl } : {}),
        output: {
          title: 'Review Yeti: evaluating',
          summary: 'Review Yeti is evaluating this attempt.',
        },
      }),
    });

    if (workerRes.ok) {
      const data = (await workerRes.json()) as any;
      result.workerCheckId = data?.id;
    } else {
      errors.push(`Worker check creation failed (${workerRes.status}): ${await workerRes.text()}`);
    }
  } catch (err: any) {
    errors.push(`Worker check creation error: ${err?.message || err}`);
  }

  // 2. Create Gate Check Run
  try {
    const gateRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/check-runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: REVIEW_GATE_CHECK_NAME,
        head_sha: headSha,
        status: 'in_progress',
        started_at: startedAt,
        external_id: gateExternalId,
        ...(detailsUrl ? { details_url: detailsUrl } : {}),
        output: {
          title: 'Review Yeti Gate: Running',
          summary: 'Review Yeti is evaluating this attempt.',
        },
      }),
    });

    if (gateRes.ok) {
      const data = (await gateRes.json()) as any;
      result.gateCheckId = data?.id;
    } else {
      errors.push(`Gate check creation failed (${gateRes.status}): ${await gateRes.text()}`);
    }
  } catch (err: any) {
    errors.push(`Gate check creation error: ${err?.message || err}`);
  }

  if (errors.length > 0) {
    result.errors = errors;
  }

  return result;
}

/**
 * Completes both Review Yeti and Review Yeti Gate check runs with terminal conclusions.
 */
export async function completeChecks(options: CompleteCheckOptions): Promise<CheckPublisherResult> {
  const {
    owner,
    repo,
    headSha,
    runId,
    token,
    verdict,
    summaryMarkdown,
    workerTitle: workerTitleOverride,
    gateTitle: gateTitleOverride,
    gateSummary: gateSummaryOverride,
    findings = [],
    workerCheckId,
    gateCheckId,
    executionAttempt = 1,
    detailsUrl,
    fetchFn = fetch,
  } = options;

  const result: CheckPublisherResult = {
    workerCheckId,
    gateCheckId,
  };
  const errors: string[] = [];

  const completedAt = new Date().toISOString();
  const isSuccess = verdict === 'success';
  const isNeutral = verdict === 'neutral';
  const isCancelled = verdict === 'cancelled';
  const isTimedOut = verdict === 'timed_out';

  // Map verdict to check run conclusions
  const workerConclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' =
    isSuccess
      ? 'success'
      : isNeutral
        ? 'neutral'
        : isCancelled
          ? 'cancelled'
          : isTimedOut
            ? 'timed_out'
            : 'failure';

  const workerTitle = workerTitleOverride || (
    isSuccess
      ? 'Review Yeti: SHIP'
      : isNeutral
        ? 'Review Yeti: NEUTRAL'
        : isCancelled
          ? 'Review Yeti: CANCELLED'
          : isTimedOut
            ? 'Review Yeti: review did not complete'
            : 'Review Yeti: BLOCK');

  const gateConclusion: 'success' | 'failure' = isSuccess ? 'success' : 'failure';
  const gateTitle = gateTitleOverride || (isSuccess ? 'Review Yeti Gate: Approved (SHIP)' : 'Review Yeti Gate: Failed');
  const gateSummary = gateSummaryOverride || (isSuccess
    ? 'Review Yeti completed this attempt and the policy eligibility gate passed.'
    : 'Review Yeti completed this attempt but the policy eligibility gate failed.');

  const defaultWorkerSummary = `### ${workerTitle}\n\nReview Yeti completed evaluation with verdict: **${verdict.toUpperCase()}**.`;
  const annotations = formatCheckAnnotations(findings);

  // 1. Complete Worker Check Run
  const workerPayload: any = {
    name: REVIEW_WORKER_CHECK_NAME,
    head_sha: headSha,
    status: 'completed',
    conclusion: workerConclusion,
    completed_at: completedAt,
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
    output: {
      title: workerTitle,
      summary: summaryMarkdown || defaultWorkerSummary,
      ...(annotations.length > 0 ? { annotations } : {}),
    },
  };

  if (isTimedOut) {
    workerPayload.actions = [REVIEW_REFRESH_ACTION];
  }

  try {
    let workerRes: Response;
    if (workerCheckId) {
      workerRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/check-runs/${workerCheckId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(workerPayload),
      });
    } else {
      workerPayload.external_id = deriveWorkerExternalId(runId, executionAttempt);
      workerRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/check-runs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(workerPayload),
      });
    }

    if (workerRes.ok) {
      const data = (await workerRes.json()) as any;
      result.workerCheckId = data?.id || workerCheckId;
    } else {
      errors.push(`Worker check completion failed (${workerRes.status}): ${await workerRes.text()}`);
    }
  } catch (err: any) {
    errors.push(`Worker check completion error: ${err?.message || err}`);
  }

  // 2. Complete Gate Check Run
  const gatePayload: any = {
    name: REVIEW_GATE_CHECK_NAME,
    head_sha: headSha,
    status: 'completed',
    conclusion: gateConclusion,
    completed_at: completedAt,
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
    output: {
      title: gateTitle,
      summary: gateSummary,
    },
  };

  try {
    let gateRes: Response;
    if (gateCheckId) {
      gateRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/check-runs/${gateCheckId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(gatePayload),
      });
    } else {
      gatePayload.external_id = await deriveGateExternalId({ owner, repo, headSha, runId, executionAttempt });
      gateRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/check-runs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(gatePayload),
      });
    }

    if (gateRes.ok) {
      const data = (await gateRes.json()) as any;
      result.gateCheckId = data?.id || gateCheckId;
    } else {
      errors.push(`Gate check completion failed (${gateRes.status}): ${await gateRes.text()}`);
    }
  } catch (err: any) {
    errors.push(`Gate check completion error: ${err?.message || err}`);
  }

  if (errors.length > 0) {
    result.errors = errors;
  }

  return result;
}
