import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyGitHubTransient,
  computeGitHubRetryDelay,
  githubRetryDeadlineFromEnv,
  withGitHubRetry,
  type GitHubRetryOptions,
} from '../../src/github/githubRetry';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { CommentPublisher } from '../../src/github/commentPublisher';
import { loadSameHeadReviewSource } from '../../src/github/qualificationReader';
import { logger } from '../../src/utils/logger';
import { githubRetryOptionsFromEnv } from '../../src/cli/publishingReview';

// REL-1103: PRReviewJob ct-review-c3924d5e (ct-infrastructure#778) failed on a
// single `GitHub API 503 .../check-runs` ("No server is currently available to
// service your request") and nothing retried it.

const token = 'ghs_test_installation_token_12345';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const EXTERNAL_ID = `run_${'c'.repeat(32)}:a1`;
const SECRET_BODY = 'PRIVATE-REPO-CONTENT-must-never-be-logged';
const NOW = 1_800_000_000_000;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const unavailable = (status = 503, headers: Record<string, string> = {}) => new Response(
  JSON.stringify({ message: `No server is currently available to service your request. ${SECRET_BODY}` }),
  { status, headers: { 'content-type': 'application/json', ...headers } },
);

function client(fetchImplementation: any, retry: GitHubRetryOptions = {}) {
  const sleep = vi.fn(async (_ms: number) => undefined);
  const instance = new GitHubInstallationClient({
    token, fetchImplementation, now: () => NOW, sleep, random: () => 0.5, retry,
  });
  return { instance, sleep };
}

afterEach(() => vi.restoreAllMocks());

describe('classifyGitHubTransient', () => {
  it.each([502, 503, 504])('treats %s as a transient server error', (status) => {
    expect(classifyGitHubTransient(status, new Headers(), NOW)?.kind).toBe('server_error');
  });

  it('treats 429 and a 403 carrying retry-after or remaining=0 as rate limits and honors their wait', () => {
    expect(classifyGitHubTransient(429, new Headers({ 'retry-after': '3' }), NOW))
      .toEqual({ kind: 'rate_limit', status: 429, serverWaitMs: 3_000 });
    expect(classifyGitHubTransient(403, new Headers({ 'retry-after': '2' }), NOW)?.serverWaitMs).toBe(2_000);
    expect(classifyGitHubTransient(403, new Headers({
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1_000 + 7),
    }), NOW)?.serverWaitMs).toBe(7_000);
  });

  it.each([400, 401, 404, 409, 422, 500])('never retries %s', (status) => {
    expect(classifyGitHubTransient(status, new Headers(), NOW)).toBeUndefined();
  });

  it('never retries a bare 403 (a permission failure), even with the ubiquitous reset header', () => {
    expect(classifyGitHubTransient(403, new Headers({
      'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(NOW / 1_000 + 7),
    }), NOW)).toBeUndefined();
  });
});

describe('computeGitHubRetryDelay (full jitter)', () => {
  const policy = { baseDelayMs: 500, maxDelayMs: 8_000 };
  it('stays within [0, min(cap, base * 2^n)) and uses the whole range', () => {
    expect(computeGitHubRetryDelay(1, { ...policy, random: () => 0 })).toBe(0);
    expect(computeGitHubRetryDelay(1, { ...policy, random: () => 0.999 })).toBeLessThan(500);
    expect(computeGitHubRetryDelay(3, { ...policy, random: () => 0.999 })).toBeLessThan(2_000);
    expect(computeGitHubRetryDelay(10, { ...policy, random: () => 0.999 })).toBeLessThan(8_000);
  });

  it('never waits less than the server-directed Retry-After', () => {
    expect(computeGitHubRetryDelay(1, { ...policy, random: () => 0 }, 4_000)).toBe(4_000);
  });
});

describe('githubRetryDeadlineFromEnv', () => {
  it('reads the terminal deadline minus the 60 s Job reserve, and nothing when absent', () => {
    expect(githubRetryDeadlineFromEnv({ REVIEW_TERMINAL_DEADLINE: '2026-09-24T17:00:00Z' }))
      .toBe(Date.parse('2026-09-24T17:00:00Z') - 60_000);
    expect(githubRetryDeadlineFromEnv({})).toBeUndefined();
    expect(githubRetryDeadlineFromEnv({ REVIEW_TERMINAL_DEADLINE: 'nope' })).toBeUndefined();
  });
});

describe('githubRetryOptionsFromEnv (worker wiring)', () => {
  it('forwards the operator deadline into the client retry policy as deadlineAtMs', () => {
    expect(githubRetryOptionsFromEnv({ REVIEW_TERMINAL_DEADLINE: '2026-09-24T17:00:00Z' }))
      .toEqual({ deadlineAtMs: Date.parse('2026-09-24T17:00:00Z') - 60_000 });
    expect(githubRetryOptionsFromEnv({})).toEqual({});
  });

  it('a worker client built from that env refuses a retry the deadline cannot fit', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(unavailable(503))
      .mockResolvedValueOnce(json({ id: 7 }));
    // Job-kill point (deadline - 60 s) is 2 s after NOW: less than the attempt reserve.
    const retry = githubRetryOptionsFromEnv({ REVIEW_TERMINAL_DEADLINE: new Date(NOW + 62_000).toISOString() });
    const { instance, sleep } = client(fetchImplementation, retry);
    await expect(instance.updateCheck({ owner: 'o', repo: 'r', checkId: 7 })).rejects.toThrow(/^GitHub API 503 /u);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

describe('network errors (no HTTP status)', () => {
  const networkError = () => Object.assign(new TypeError('fetch failed'), { cause: 'ECONNRESET' });

  it('retries an idempotent read when enabled', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(json({ ok: true }));
    const result = await withGitHubRetry<Response>({
      operation: 'GET /x', method: 'GET', attempt, retryNetworkErrors: true,
    }, { sleep: async () => undefined });
    expect(result.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('never retries a POST that failed at the connection level (it may have landed)', async () => {
    const attempt = vi.fn().mockRejectedValue(networkError());
    await expect(withGitHubRetry({
      operation: 'POST /x', method: 'POST', attempt, retryNetworkErrors: true,
    }, { sleep: async () => undefined })).rejects.toThrow('fetch failed');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not retry network errors unless the caller opts in', async () => {
    const attempt = vi.fn().mockRejectedValue(networkError());
    await expect(withGitHubRetry({ operation: 'GET /x', method: 'GET', attempt }, { sleep: async () => undefined }))
      .rejects.toThrow('fetch failed');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('CommentPublisher does not re-send a review POST after a connection failure', async () => {
    let posts = 0;
    const fetchImplementation = vi.fn(async (_input: any, init: RequestInit = {}) => {
      if (init.method === 'POST') { posts += 1; throw networkError(); }
      return json([]);
    });
    const result = await new CommentPublisher({
      githubToken: token, fetchImplementation, sleep: async () => undefined, random: () => 0,
    }).publishReview({ owner: 'o', repo: 'r', prNumber: 9, commitSha: HEAD, event: 'COMMENT', body: 'b' });
    expect(result.success).toBe(false);
    expect(posts).toBe(1);
  });
});

describe('server-directed wait cap (maxServerWaitMs) without a deadline', () => {
  const rateLimited = (retryAfter: string) => json({ message: 'rate' }, 429, { 'retry-after': retryAfter });

  it('returns a 429 whose Retry-After exceeds the cap immediately instead of sleeping', async () => {
    const attempt = vi.fn().mockResolvedValue(rateLimited('120'));
    const sleep = vi.fn(async () => undefined);
    const result = await withGitHubRetry<Response>({ operation: 'GET /x', method: 'GET', attempt }, { sleep });
    expect(result.status).toBe(429);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honors a Retry-After just under the cap in full', async () => {
    const attempt = vi.fn().mockResolvedValueOnce(rateLimited('59')).mockResolvedValueOnce(json({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const result = await withGitHubRetry<Response>({ operation: 'GET /x', method: 'GET', attempt },
      { sleep, random: () => 0 });
    expect(result.status).toBe(200);
    expect(sleep).toHaveBeenCalledWith(59_000);
  });

  it('parses an HTTP-date Retry-After relative to now', () => {
    expect(classifyGitHubTransient(503, new Headers({ 'retry-after': new Date(NOW + 9_000).toUTCString() }), NOW)
      ?.serverWaitMs).toBe(9_000);
  });
});

describe('abort signal', () => {
  it('an already-aborted signal returns the transient outcome without waiting', async () => {
    const controller = new AbortController();
    controller.abort(new Error('worker shutting down'));
    const attempt = vi.fn().mockResolvedValue(unavailable(503));
    const sleep = vi.fn(async () => undefined);
    const result = await withGitHubRetry<Response>({ operation: 'GET /x', method: 'GET', attempt },
      { sleep, signal: controller.signal });
    expect(result.status).toBe(503);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('an abort during the backoff stops before the next attempt with the abort reason', async () => {
    const controller = new AbortController();
    const attempt = vi.fn().mockResolvedValue(unavailable(503));
    const sleep = vi.fn(async () => { controller.abort(new Error('worker shutting down')); });
    await expect(withGitHubRetry<Response>({ operation: 'GET /x', method: 'GET', attempt },
      { sleep, signal: controller.signal })).rejects.toThrow('worker shutting down');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('the installation client forwards the request signal into the retry policy', async () => {
    const controller = new AbortController();
    const fetchImplementation = vi.fn(async () => unavailable(503));
    const sleep = vi.fn(async () => { controller.abort(new Error('cancelled')); });
    const instance = new GitHubInstallationClient({ token, fetchImplementation, sleep, random: () => 0 });
    const recovery = instance.failAbandonedCheck({
      runId: `run_${'d'.repeat(32)}`, owner: 'o', repo: 'r', prNumber: 1, headSha: HEAD, executionAttempt: 1,
      receivedAt: NOW, terminalDeadline: NOW + 30 * 60_000,
    } as any, 1, controller.signal);
    await expect(recovery).rejects.toThrow();
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

describe('GitHubInstallationClient transient retry', () => {
  it('a 503-then-200 check-run update succeeds, and the retry log carries no response body', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(unavailable(503))
      .mockResolvedValueOnce(json({ id: 7 }));
    const { instance, sleep } = client(fetchImplementation);

    await instance.updateCheck({ owner: 'calltelemetry', repo: 'ct-infrastructure', checkId: 7, title: 'Running' });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('GitHub transient response; retrying', expect.objectContaining({
      operation: 'PATCH /repos/calltelemetry/ct-infrastructure/check-runs/7', status: 503, attempt: 1,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET_BODY);
  });

  it('negative proof: without the retry the same 503 would have failed the run', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(unavailable(503))
      .mockResolvedValueOnce(json({ id: 7 }));
    const { instance } = client(fetchImplementation, { maxAttempts: 1 });
    await expect(instance.updateCheck({ owner: 'o', repo: 'r', checkId: 7 }))
      .rejects.toThrow(/^GitHub API 503 /u);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 422', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(json({ message: 'Validation Failed' }, 422));
    const { instance, sleep } = client(fetchImplementation);
    await expect(instance.completeCheck({
      owner: 'o', repo: 'r', checkId: 7, conclusion: 'success', title: 'ok', summary: 's',
    })).rejects.toThrow(/^GitHub API 422 /u);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a bare 403', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(json({ message: 'Resource not accessible by integration' }, 403));
    const { instance } = client(fetchImplementation);
    await expect(instance.getPullRequest('o', 'r', 1)).rejects.toThrow(/^GitHub API 403 /u);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After on a secondary rate limit, even for a POST (GitHub rejected it unprocessed)', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(json({ message: 'secondary rate limit' }, 403, { 'retry-after': '5' }))
      .mockResolvedValueOnce(json({ id: 55 }, 201));
    const { instance, sleep } = client(fetchImplementation);
    await expect(instance.publishGateCheck('o', 'r', HEAD, { conclusion: 'success', title: 't', summary: 's' }))
      .resolves.toBe(55);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('stops after the bounded attempt count and surfaces the last status', async () => {
    const fetchImplementation = vi.fn().mockImplementation(async () => unavailable(502));
    const { instance, sleep } = client(fetchImplementation);
    await expect(instance.getPullRequest('o', 'r', 1)).rejects.toThrow(/^GitHub API 502 /u);
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('respects the deadline: no wait may run past it, so the 503 surfaces immediately', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(unavailable(503))
      .mockResolvedValueOnce(json({ id: 7 }));
    const { instance, sleep } = client(fetchImplementation, { deadlineAtMs: NOW + 1_000 });
    await expect(instance.updateCheck({ owner: 'o', repo: 'r', checkId: 7 })).rejects.toThrow(/^GitHub API 503 /u);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('respects the deadline for a Retry-After longer than the time left', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(json({ message: 'rate' }, 429, { 'retry-after': '30' }))
      .mockResolvedValueOnce(json({ id: 7 }));
    const { instance, sleep } = client(fetchImplementation, { deadlineAtMs: NOW + 20_000 });
    await expect(instance.getPullRequest('o', 'r', 1)).rejects.toThrow(/^GitHub API 429 /u);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries within a deadline that leaves room', async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(unavailable(504))
      .mockResolvedValueOnce(json({ head: { sha: HEAD }, base: { sha: BASE } }));
    const { instance } = client(fetchImplementation, { deadlineAtMs: NOW + 60_000 });
    await expect(instance.getPullRequest('o', 'r', 1)).resolves.toMatchObject({ headSha: HEAD });
  });
});

/**
 * A GitHub check-runs endpoint that can "lose" a successful create: the check
 * is stored, yet the caller sees a 503. The only correct retry is one that
 * finds the stored check by its attempt-bound external id.
 */
function checkRunsServer(options: { loseFirstCreate: boolean; failFirstCreateBeforeStoring?: boolean }) {
  const checks: any[] = [];
  let posts = 0;
  const fetchImplementation = vi.fn(async (input: any, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'POST' && url.pathname === '/repos/o/r/check-runs') {
      posts += 1;
      const body = JSON.parse(String(init.body));
      if (posts === 1 && options.failFirstCreateBeforeStoring) return unavailable(503);
      const check = { id: 1000 + checks.length, name: body.name, head_sha: body.head_sha, external_id: body.external_id ?? '', status: body.status };
      checks.push(check);
      if (posts === 1 && options.loseFirstCreate) return unavailable(503);
      return json(check, 201);
    }
    if (method === 'GET' && url.pathname === `/repos/o/r/commits/${HEAD}/check-runs`) {
      const named = checks.filter((check) => check.name === url.searchParams.get('check_name'));
      return json({ total_count: named.length, check_runs: named });
    }
    return json({ message: 'Not Found' }, 404);
  });
  return { checks, fetchImplementation, posts: () => posts };
}

describe('createCheck is made safe to retry (no duplicate check runs)', () => {
  it('a create whose response was lost behind a 503 is reconciled, not re-sent', async () => {
    const server = checkRunsServer({ loseFirstCreate: true });
    const { instance } = client(server.fetchImplementation);

    await expect(instance.createCheck('o', 'r', HEAD, EXTERNAL_ID)).resolves.toBe(1000);

    expect(server.posts()).toBe(1);
    expect(server.checks).toHaveLength(1);
  });

  it('a create that truly failed is re-sent once the lookup proves nothing landed', async () => {
    const server = checkRunsServer({ loseFirstCreate: false, failFirstCreateBeforeStoring: true });
    const { instance } = client(server.fetchImplementation);

    await expect(instance.createCheck('o', 'r', HEAD, EXTERNAL_ID)).resolves.toBe(1000);

    expect(server.posts()).toBe(2);
    expect(server.checks).toHaveLength(1);
    expect(server.checks[0].external_id).toBe(EXTERNAL_ID);
  });

  it('negative proof: a blind retry would have duplicated the check run', async () => {
    const server = checkRunsServer({ loseFirstCreate: true });
    const blind = await withGitHubRetry({
      operation: 'POST /repos/o/r/check-runs',
      method: 'PUT', // pretend the POST were idempotent: the unsafe behaviour this change refuses
      attempt: () => server.fetchImplementation('https://api.github.com/repos/o/r/check-runs', {
        method: 'POST', body: JSON.stringify({ name: 'Review Yeti', head_sha: HEAD, external_id: EXTERNAL_ID }),
      }),
    }, { sleep: async () => undefined });
    expect(blind.status).toBe(201);
    expect(server.checks).toHaveLength(2);
  });

  it('refuses to guess when the external id is ambiguous', async () => {
    const server = checkRunsServer({ loseFirstCreate: true });
    server.checks.push({ id: 5, name: 'Review Yeti', head_sha: HEAD, external_id: EXTERNAL_ID, status: 'in_progress' });
    const { instance } = client(server.fetchImplementation);
    await expect(instance.createCheck('o', 'r', HEAD, EXTERNAL_ID)).rejects.toThrow(/ambiguous/u);
    expect(server.posts()).toBe(1);
  });

  it('a POST with no exact identity (no external id) is not retried on 5xx', async () => {
    const server = checkRunsServer({ loseFirstCreate: true });
    const { instance } = client(server.fetchImplementation);
    await expect(instance.createCheck('o', 'r', HEAD)).rejects.toThrow(/^GitHub API 503 /u);
    expect(server.posts()).toBe(1);
  });
});

describe('CommentPublisher honors the shared retry options', () => {
  it('uses retry.maxAttempts the same way GitHubInstallationClient does', async () => {
    const fetchImplementation = vi.fn(async () => unavailable(503));
    const shared = { maxAttempts: 2, sleep: async () => undefined };
    const publisher = new CommentPublisher({ githubToken: token, fetchImplementation, retry: shared, sleep: async () => undefined });
    await publisher.publishReview({ owner: 'o', repo: 'r', prNumber: 9, commitSha: HEAD, event: 'COMMENT', body: 'b', idempotencyKey: 'k' });
    // One marker lookup GET, retried once: exactly maxAttempts calls, then the 503 surfaces.
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    const installationFetch = vi.fn(async () => unavailable(503));
    const { instance } = client(installationFetch, shared);
    await expect(instance.getPullRequest('o', 'r', 1)).rejects.toThrow(/^GitHub API 503 /u);
    expect(installationFetch).toHaveBeenCalledTimes(2);
  });
});

describe('CommentPublisher transient retry', () => {
  const publisher = (fetchImplementation: any) => new CommentPublisher({
    githubToken: token, fetchImplementation, now: () => NOW, sleep: async () => undefined, random: () => 0,
  });
  const request = { owner: 'o', repo: 'r', prNumber: 9, commitSha: HEAD, event: 'COMMENT' as const, body: 'review body' };

  it('reconciles a 502 review POST by its idempotency marker instead of posting twice', async () => {
    const reviews: any[] = [];
    let posts = 0;
    const fetchImplementation = vi.fn(async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (init.method === 'POST' && url.pathname === '/repos/o/r/pulls/9/reviews') {
        posts += 1;
        reviews.push({ id: 42, body: JSON.parse(String(init.body)).body });
        return unavailable(502);
      }
      if (url.pathname === '/repos/o/r/pulls/9/reviews') return json(reviews);
      if (url.pathname === '/repos/o/r/issues/9/comments') return json([]);
      return json({ message: 'Not Found' }, 404);
    });

    const result = await publisher(fetchImplementation).publishReview({ ...request, idempotencyKey: 'attempt-1' });

    expect(result).toMatchObject({ success: true, reviewId: 42 });
    expect(posts).toBe(1);
  });

  it('reconciles the self-approval issue-comment fallback by the same marker (the lookup spans issue comments)', async () => {
    const issueComments: any[] = [];
    let issuePosts = 0;
    const fetchImplementation = vi.fn(async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (init.method === 'POST' && url.pathname === '/repos/o/r/pulls/9/reviews') {
        return json({ message: 'Unprocessable Entity: Can not approve your own pull request' }, 422);
      }
      if (init.method === 'POST' && url.pathname === '/repos/o/r/issues/9/comments') {
        issuePosts += 1;
        issueComments.push({ id: 77, body: JSON.parse(String(init.body)).body });
        return unavailable(503);
      }
      if (url.pathname === '/repos/o/r/pulls/9/reviews') return json([]);
      if (url.pathname === '/repos/o/r/issues/9/comments') return json(issueComments);
      return json({ message: 'Not Found' }, 404);
    });

    const result = await publisher(fetchImplementation).publishReview({
      ...request, event: 'APPROVE', idempotencyKey: 'attempt-1',
    });

    expect(result).toMatchObject({ success: true, reviewId: 77 });
    expect(issuePosts).toBe(1);
    expect(issueComments).toHaveLength(1);
  });

  it('reconciles a 503 sticky-overview POST by its marker instead of creating a second overview', async () => {
    const login = 'ct-review-bot[bot]';
    const comments: any[] = [];
    let posts = 0;
    const fetchImplementation = vi.fn(async (input: any, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (init.method === 'POST' && url.pathname === '/repos/o/r/issues/9/comments') {
        posts += 1;
        comments.push({ id: 91, user: { type: 'Bot', login }, body: JSON.parse(String(init.body)).body });
        return unavailable(503);
      }
      if (url.pathname === '/repos/o/r/issues/9/comments') return json(comments);
      if (url.pathname === '/repos/o/r/issues/comments/91') return json(comments[0]);
      return json({ message: 'Not Found' }, 404);
    });

    const result = await new CommentPublisher({
      githubToken: token, publisherLogin: login, fetchImplementation, sleep: async () => undefined, random: () => 0,
    }).publishReview({ ...request, stickyOverview: true });

    expect(result).toMatchObject({ success: true, summaryCommentId: 91 });
    expect(posts).toBe(1);
    expect(comments).toHaveLength(1);
  });

  it('does not retry a 5xx review POST that has no idempotency marker', async () => {
    let posts = 0;
    const fetchImplementation = vi.fn(async (_input: any, init: RequestInit = {}) => {
      if (init.method === 'POST') posts += 1;
      return unavailable(503);
    });
    const result = await publisher(fetchImplementation).publishReview(request);
    expect(result.success).toBe(false);
    expect(posts).toBe(1);
  });
});

describe('qualification / diff reads retry transient responses', () => {
  const input = { token, repo: 'o/r', prNumber: 9, expectedBaseSha: BASE, expectedHeadSha: HEAD };
  const pr = { data: { base: { sha: BASE }, head: { sha: HEAD }, changed_files: 1 }, status: 200 };

  it('a 503-then-200 read sequence succeeds', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503, response: { headers: {} } }))
      .mockResolvedValueOnce(pr)
      .mockResolvedValueOnce({ data: 'diff --git a/x b/x\n', status: 200 })
      .mockResolvedValueOnce(pr);
    const sleep = vi.fn(async () => undefined);

    const source = await loadSameHeadReviewSource(input, request as any, { retry: { sleep } });

    expect(source.headSha).toBe(HEAD);
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 406 (diff too large is not transient)', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(pr)
      .mockRejectedValueOnce(Object.assign(new Error('too large'), { status: 406 }));
    const sleep = vi.fn(async () => undefined);
    await loadSameHeadReviewSource(input, request as any, { retry: { sleep } }).catch(() => undefined);
    expect(sleep).not.toHaveBeenCalled();
  });
});
