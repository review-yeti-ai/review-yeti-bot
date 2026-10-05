/**
 * `POST /api/dispatch/finding-threads` (ADR 0002): the worker asks the service to publish its new
 * required findings as review threads and to resolve the bot's own outdated threads whose finding
 * was not reported again. The worker holds no `pull_requests: write` token; the service mints one
 * per call, scoped to the run's repository, after authenticating the exact execution.
 *
 * The service never trusts the worker's fingerprint: each published finding's fingerprint must be
 * the one `findingFingerprint` derives from its own content, and the head must be the run's head.
 */
import type { Request, Response } from 'express';
import { canonicalJson, sha256 } from '../review/reviewCore';
import { findingFingerprint } from '../review/findingConvergence';
import { workerExecutionAuthorized, type Queryable } from '../persistence/incrementalPriorReview';
import { getPreparedPublishingPolicy } from '../persistence/preparedReviewRepository';
import { constantTimeDigestEqual } from '../utils/constantTimeDigest';
import { evaluateReviewDecisionV2, REVIEW_SEVERITY_POLICY_V2 } from '../review/reviewDecision';
import { findingThreadsReadRequestSchema, findingThreadsRequestSchema, type FindingThreadsRequestV2 } from '../review/findingThreadsContract';
import { reviewGateBlockingFindingsSchema } from '../review/reviewGatePolicy';
import {
  publishFindingThreads,
  readCurrentPullRequestHead,
  readFindingThreads,
  resolveFindingThread,
  type FindingThreadTransport,
} from '../github/findingThreads';
import { isGitHubInstallationToken } from '../github/githubTransportPolicy';
import { logger } from '../utils/logger';

export { MAX_FINDING_THREADS_REQUEST_BYTES } from '../review/findingThreadsContract';
const MAX_RESOLVED_PER_RUN = 30;
/** Resolution GraphQL calls in flight at once; each is a separate small mutation. */
const RESOLVE_CONCURRENCY = 4;

export interface FindingThreadsRouteOptions {
  db: Queryable;
  /**
   * Mints a `pull_requests: write` token for exactly this repository, with the review App's bot
   * login so only the App's own threads are trusted.
   */
  transportFor(owner: string, repo: string): Promise<FindingThreadTransport>;
}

function bearer(request: Request): string | null {
  const value = /^Bearer\s+(\S+)$/iu.exec(request.header('authorization') ?? '')?.[1] ?? null;
  return value && isGitHubInstallationToken(value) ? value : null;
}

export function createFindingThreadsHandler(options: FindingThreadsRouteOptions) {
  return async (request: Request, response: Response) => {
    const token = bearer(request);
    if (!token) return response.status(401).json({ error: 'Worker installation bearer token is required' });
    const read = findingThreadsReadRequestSchema.safeParse(request.body);
    const parsed = read.success ? undefined : findingThreadsRequestSchema.safeParse(request.body);
    if (!read.success && !parsed?.success) return response.status(400).json({ error: 'Invalid finding-threads request' });
    const input = read.success ? read.data : parsed!.data!;
    if (!read.success && input.version === 'FindingThreadsRequest.v2') {
      return publishV2FindingThreads(options, response, input, token);
    }
    if (!read.success && input.version === 'FindingThreadsRequest.v1'
      && input.publish.some((finding) => findingFingerprint(finding) !== finding.fingerprint)) {
      return response.status(400).json({ error: 'Finding fingerprint does not match its content' });
    }
    let run: { owner: string; repo: string; prNumber: number; headSha: string } | undefined;
    try {
      if (!await workerExecutionAuthorized(options.db, {
        runId: input.runId, executionAttempt: input.executionAttempt, workerTokenDigest: sha256(token),
      })) return response.status(403).json({ error: 'Worker is not authorized for this execution' });
      const row = (await options.db.query(
        'SELECT owner, repo, pr_number, head_sha FROM review_runs WHERE run_id = $1', [input.runId])).rows[0];
      if (row) run = { owner: String(row.owner), repo: String(row.repo), prNumber: Number(row.pr_number), headSha: String(row.head_sha) };
    } catch {
      return response.status(503).json({ error: 'Finding threads are temporarily unavailable' });
    }
    if (!run || !Number.isSafeInteger(run.prNumber)) return response.status(403).json({ error: 'Worker is not authorized for this execution' });
    if (run.headSha !== input.headSha) return response.status(409).json({ error: 'Run head does not match' });
    try {
      const transport = await options.transportFor(run.owner, run.repo);
      const pr = { owner: run.owner, repo: run.repo, prNumber: run.prNumber, headSha: run.headSha };
      const existing = await readFindingThreads(transport, pr);
      if (read.success) {
        return response.status(200).json({ version: 'FindingThreadsReadResult.v1', runId: input.runId,
          threads: existing.slice(0, 500) });
      }
      if (input.version !== 'FindingThreadsRequest.v1') return response.status(400).json({ error: 'Invalid finding-threads request' });
      const published = await publishFindingThreads(transport, pr, input.publish, existing);
      // Resolve only the bot's own threads GitHub already marks outdated whose finding this head did
      // not report: the anchored code changed and the defect is gone. A current-line thread stays
      // open even when a run did not report it, so model variance can never hide a real finding.
      const reported = new Set(input.reported);
      const stale = existing
        // Never resolve a thread whose author could not be verified as the review App.
        .filter((thread) => Boolean(transport.botLogin)
          && !thread.resolved && thread.outdated && !reported.has(thread.fingerprint) && thread.threadId)
        .slice(0, MAX_RESOLVED_PER_RUN);
      let resolved = 0;
      for (let offset = 0; offset < stale.length; offset += RESOLVE_CONCURRENCY) {
        await Promise.all(stale.slice(offset, offset + RESOLVE_CONCURRENCY)
          .map((thread) => resolveFindingThread(transport, thread.threadId!)));
        resolved += Math.min(RESOLVE_CONCURRENCY, stale.length - offset);
      }
      return response.status(200).json({
        version: 'FindingThreadsResult.v1', runId: input.runId,
        created: published.created, skipped: published.skipped, resolved,
      });
    } catch {
      // Never echo the GitHub error: it can carry request detail.
      logger.warn('Finding threads could not be published', { runId: input.runId });
      return response.status(503).json({ error: 'Finding threads are temporarily unavailable' });
    }
  };
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function publishV2FindingThreads(options: FindingThreadsRouteOptions, response: Response,
  input: FindingThreadsRequestV2, token: string): Promise<Response> {
  let row: Record<string, unknown> | undefined;
  try {
    const stored = await options.db.query(`SELECT runs.repository_id, runs.owner, runs.repo, runs.pr_number,
        runs.head_sha, runs.base_sha, runs.effective_policy_digest, runs.effective_config_digest,
        runs.status AS run_status, runs.result_digest, outbox.worker_token_digest,
        outbox.execution_attempt AS previous_execution_attempt, gate.coordinates AS gate_coordinates,
        gate.evidence AS gate_evidence, gate.decision AS gate_decision,
        gate.worker_result_digest AS gate_worker_result_digest,
        completion.execution_attempt AS completion_execution_attempt,
        completion.content_digest AS completion_content_digest
      FROM review_runs runs
      JOIN review_dispatch_outbox outbox USING (run_id)
      JOIN review_gate_attempts gate ON gate.run_id = runs.run_id AND gate.current_attempt
      JOIN review_worker_completions completion ON completion.run_id = runs.run_id
        AND completion.execution_attempt = $2
      WHERE runs.run_id = $1 AND gate.coordinates->>'executionAttempt' = $2::text`,
    [input.runId, input.executionAttempt]);
    row = stored.rows[0] as Record<string, unknown> | undefined;
  } catch {
    return response.status(503).json({ error: 'Finding threads are temporarily unavailable' });
  }
  if (!row || !constantTimeDigestEqual(row.worker_token_digest, sha256(token))) {
    return response.status(403).json({ error: 'Worker is not authorized for this execution' });
  }
  const coordinates = jsonObject(row.gate_coordinates);
  const evidence = jsonObject(row.gate_evidence);
  const gateDecision = jsonObject(row.gate_decision);
  const runMatches = Number(row.repository_id) === input.repositoryId
    && String(row.owner) === input.owner && String(row.repo) === input.repo
    && Number(row.pr_number) === input.prNumber && String(row.head_sha) === input.headSha
    && String(row.base_sha) === input.baseSha
    && String(row.effective_policy_digest) === input.policyDigest
    && String(row.effective_config_digest) === input.configDigest
    && Number(row.previous_execution_attempt) + 1 === input.executionAttempt
    && Number(row.completion_execution_attempt) === input.executionAttempt
    && ['succeeded', 'failed'].includes(String(row.run_status))
    && Boolean(row.result_digest) && row.result_digest === row.gate_worker_result_digest
    && row.result_digest === row.completion_content_digest;
  const coordinateMatches = coordinates !== null
    && ['runId', 'repositoryId', 'owner', 'repo', 'prNumber', 'headSha', 'baseSha', 'policyDigest', 'configDigest', 'executionAttempt']
      .every((key) => coordinates[key] === input[key as keyof FindingThreadsRequestV2]);
  if (!runMatches || !coordinateMatches || !gateDecision
    || !['success', 'failure'].includes(String(gateDecision.status))) {
    return response.status(409).json({ error: 'Finding-thread decision does not match the accepted review completion' });
  }

  let prepared;
  try { prepared = await getPreparedPublishingPolicy(options.db, input.policyDigest); }
  catch { return response.status(503).json({ error: 'Finding threads are temporarily unavailable' }); }
  if (!prepared || prepared.policy.effectiveConfigDigest !== input.configDigest
    || prepared.config.severity_policy !== REVIEW_SEVERITY_POLICY_V2) {
    return response.status(403).json({ error: 'Severity-v2 finding threads are not enabled for this run' });
  }

  const storedDecision = evidence?.reviewDecision;
  const evaluated = evaluateReviewDecisionV2(storedDecision);
  const blockers = evidence?.blockingFingerprints;
  const blockerFindings = reviewGateBlockingFindingsSchema.safeParse(evidence?.blockingFindings);
  const validBlockers = Array.isArray(blockers) && blockers.every((value) => typeof value === 'string'
    && /^fp1_[a-f0-9]{24}$/u.test(value)) && new Set(blockers).size === blockers.length;
  const trustedFindings = blockerFindings.success ? blockerFindings.data : [];
  const findingFingerprints = trustedFindings.map((finding) => finding.fingerprint).sort();
  const blockersSorted = validBlockers ? [...blockers as string[]].sort() : [];
  if (!evidence || !evaluated.valid || canonicalJson(evaluated.decision) !== canonicalJson(input.reviewDecision)
    || canonicalJson(storedDecision) !== canonicalJson(input.reviewDecision)
    || input.reviewDecision.policyDigest !== input.policyDigest
    || input.reviewDecision.policyVersion !== REVIEW_SEVERITY_POLICY_V2
    || !input.reviewDecision.coverageComplete || !input.reviewDecision.quorumSatisfied
    || input.reviewDecision.infrastructureFailure
    || input.reviewDecision.expectedLanes === 0
    || input.reviewDecision.completedLanes !== input.reviewDecision.expectedLanes
    || !validBlockers
    || !blockerFindings.success
    || canonicalJson(findingFingerprints) !== canonicalJson(blockersSorted)
    || trustedFindings.some((finding) => findingFingerprint(finding) !== finding.fingerprint)
    || (blockers as string[]).length !== input.reviewDecision.counts.p0Count + input.reviewDecision.counts.p1Count) {
    return response.status(409).json({ error: 'Finding-thread decision is not backed by complete current evidence' });
  }
  try {
    const transport = await options.transportFor(input.owner, input.repo);
    const pr = { owner: input.owner, repo: input.repo, prNumber: input.prNumber, headSha: input.headSha };
    // Completion may race a new GitHub head. Never publish or close a conversation from a stale run.
    const existing = await readFindingThreads(transport, pr);
    if (await readCurrentPullRequestHead(transport, pr) !== input.headSha) {
      return response.status(409).json({ error: 'Pull request head moved after review completion' });
    }
    const publishable = trustedFindings.map((finding) => {
      const proof = [
        `Verified trigger: ${finding.blockerEvidence.trigger}`,
        `Consequence: ${finding.blockerEvidence.impact}`,
        `Violated contract: ${finding.blockerEvidence.violatedContract}`,
      ].join('\n');
      const bodyLimit = Math.max(0, 15_900 - proof.length);
      return { ...finding, body: `${finding.body.slice(0, bodyLimit)}\n\n${proof}`.slice(0, 16_000) };
    });
    const published = await publishFindingThreads(transport, pr, publishable, existing, publishable.length,
      { replaceAdvisoryThreads: true });
    const mayRetireAdvisories = input.reviewDecision.coverageComplete && input.reviewDecision.quorumSatisfied
      && !input.reviewDecision.infrastructureFailure && input.reviewDecision.expectedLanes > 0
      && input.reviewDecision.completedLanes === input.reviewDecision.expectedLanes;
    const stale = existing.filter((thread) => {
      if (!transport.botLogin || thread.resolved || !thread.threadId) return false;
      const advisory = thread.severity === 'P2' || thread.severity === 'P3' || thread.severity === 'NIT';
      // Same-fingerprint v2 reclassification publishes the current blocker first. Retire only the
      // old App-owned advisory thread after that publication succeeds; if publication fails this
      // loop is never reached and the old conversation remains visible.
      return mayRetireAdvisories && advisory;
    });
    let resolved = 0;
    for (let offset = 0; offset < stale.length; offset += RESOLVE_CONCURRENCY) {
      await Promise.all(stale.slice(offset, offset + RESOLVE_CONCURRENCY)
        .map((thread) => resolveFindingThread(transport, thread.threadId!)));
      resolved += Math.min(RESOLVE_CONCURRENCY, stale.length - offset);
    }
    return response.status(200).json({ version: 'FindingThreadsResult.v2', runId: input.runId,
      created: published.created, skipped: published.skipped, resolved });
  } catch {
    logger.warn('Verified v2 finding threads could not be published or migrated', { runId: input.runId });
    return response.status(503).json({ error: 'Verified v2 finding threads could not be published or migrated' });
  }
}
