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
import { sha256 } from '../review/reviewCore';
import { findingFingerprint } from '../review/findingConvergence';
import { workerExecutionAuthorized, type Queryable } from '../persistence/incrementalPriorReview';
import { findingThreadsReadRequestSchema, findingThreadsRequestSchema } from '../review/findingThreadsContract';
import {
  publishFindingThreads,
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
    const input = read.success ? { ...read.data, publish: [], reported: [] } : parsed!.data!;
    if (input.publish.some((finding) => findingFingerprint(finding) !== finding.fingerprint)) {
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
