import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubReviewCiClient, MAX_CI_PAGES } from '../../src/github/reviewCiClient';
import { MAX_CI_RESPONSE_BYTES } from '../../src/github/boundedCiTransport';
import { createReviewCiLanePlan, reviewCiRunName, type ReviewCiRequestEvent } from '../../src/review/reviewCi';

const token = 'ghs_ci_test';
const repository = { repositoryId: 123, owner: 'calltelemetry', repo: 'ct-meta' };
const binding = { candidateSha: 'c'.repeat(40), workflowId: 88, workflowPath: '.github/workflows/ci.yml',
  workflowRef: 'refs/heads/main', workflowSha: 'd'.repeat(40), lanePlan: createReviewCiLanePlan(['unit'], ['required tests']) };
const correlation = { requestId: '07b3c7a1-12a4-4e42-bc18-71df2e0cae1d', epoch: 2 };
const coordinates = { prNumber: 42, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), candidateSha: binding.candidateSha };
const event: ReviewCiRequestEvent = { schema_version: 'review-yeti-ci-request.v1', repository_id: repository.repositoryId,
  repository: 'calltelemetry/ct-meta', pr_number: 42, base_sha: coordinates.baseSha, head_sha: coordinates.headSha,
  attempt_id: `run_${'a'.repeat(32)}-g0-e1`, policy_digest: 'f'.repeat(64), validation_request_id: correlation.requestId };
const run = (overrides: Record<string, unknown> = {}) => ({ id: 99, run_attempt: 1, workflow_id: binding.workflowId,
  head_sha: binding.workflowSha, head_branch: 'main', event: 'workflow_dispatch', path: binding.workflowPath,
  display_title: reviewCiRunName(correlation.requestId, correlation.epoch), repository: { id: 123, full_name: event.repository },
  status: 'completed', conclusion: 'success', ...overrides });
const job = (overrides: Record<string, unknown> = {}) => ({ id: 100, run_id: 99, head_sha: binding.workflowSha,
  name: 'required tests', status: 'completed', conclusion: 'success', started_at: '2026-09-09T00:00:00Z',
  completed_at: '2026-09-09T00:01:00Z', ...overrides });
const execution = { ...correlation, runId: 99, runAttempt: 1, repositoryId: 123, workflowId: 88,
  workflowSha: binding.workflowSha, candidateSha: binding.candidateSha, event: 'workflow_dispatch' as const,
  runName: reviewCiRunName(correlation.requestId, correlation.epoch) };
const pull = (overrides: Record<string, unknown> = {}) => ({ number: 42, state: 'open', draft: false, merged: false,
  mergeable: true, merge_commit_sha: coordinates.candidateSha, head: { sha: coordinates.headSha },
  base: { ref: 'main', sha: coordinates.baseSha, repo: { id: 123, full_name: event.repository } }, ...overrides });
const branchTip = (sha = coordinates.baseSha, name = 'main') => ({ name, commit: { sha } });
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function client(fetcher: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new GitHubReviewCiClient({ token, expectedAppId: 4385771, repository, binding,
    baseUrl: 'https://api.example.invalid/api/v3', timeoutMs: 250, fetchImplementation: fetcher, ...overrides });
}
function reads(jobs = [job()]) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(json(run())).mockResolvedValueOnce(json({ total_count: jobs.length, jobs }))
    .mockResolvedValueOnce(json(run()));
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('GitHubReviewCiClient dispatch contracts', () => {
  it('constructs without I/O and sends canonical coordinate-only repository dispatch once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const ci = client(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(ci.dispatchRepository(event)).resolves.toEqual({ status: 'accepted' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.example.invalid/api/v3/repos/calltelemetry/ct-meta/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({ event_type: 'review-yeti-ci-request', client_payload: event });
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2022-11-28');
    expect(url).not.toContain(token);
  });

  it.each(['url', 'ref', 'conclusion', 'checkId', 'provider', 'epoch'])('rejects extra repository payload %s before I/O', async (key) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).dispatchRepository({ ...event, [key]: 'untrusted' } as ReviewCiRequestEvent)).rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ policy_digest: `sha256:${event.policy_digest}` }, { attempt_id: 'review-attempt-1' },
    { validation_request_id: 'not-uuid' }, { repository_id: 456 }, { repository: 'calltelemetry/other' }])
  ('rejects malformed or wrong shared coordinates %j', async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).dispatchRepository({ ...event, ...change })).rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['refs/heads/main', 'refs/tags/ci-v1'])('dispatches only configured named ref %s with UUID/epoch and requests run details', async (workflowRef) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ workflow_run_id: 99, run_url: 'https://evil.invalid', html_url: 'ignored' }));
    await expect(client(fetcher, { binding: { ...binding, workflowRef } }).dispatchWorkflow(correlation))
      .resolves.toEqual({ status: 'accepted', runId: 99 });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ ref: workflowRef.replace(/^refs\/(heads|tags)\//u, ''),
      inputs: { requestId: correlation.requestId, epoch: '2' }, return_run_details: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([binding.workflowSha, `refs/heads/${binding.workflowSha}`, 'refs/pull/42/merge', 'refs/heads/a/../main'])
  ('rejects unsafe/non-named workflow ref %s', (workflowRef) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => client(fetcher, { binding: { ...binding, workflowRef } })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([{ ref: 'candidate' }, { url: 'https://evil.invalid' }, { conclusion: 'success' }, { epoch: 0 }, { requestId: 'old-id' }])
  ('rejects workflow override or malformed input %j before I/O', async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).dispatchWorkflow({ ...correlation, ...change })).rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([204, 500, 302])('keeps workflow HTTP %s uncertain without retries or response details', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    await expect(client(fetcher).dispatchWorkflow(correlation)).resolves.toEqual({ status: 'uncertain' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([{}, { workflow_run_id: '99' }, { workflow_run_id: -1 }, { workflow_run_id: 0 }])('does not invent a run ID from malformed 200 %j', async (body) => {
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(json(body))).dispatchWorkflow(correlation)).resolves.toEqual({ status: 'uncertain' });
  });
});

describe('trusted run and job readback', () => {
  it('uses canonical run name to correlate, not URL fields or candidate SHA as workflow SHA', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ total_count: 2, workflow_runs: [run({ id: 98, display_title: 'other' }), run()] }));
    await expect(client(fetcher).correlateRun(correlation)).resolves.toEqual({ runId: 99, runAttempt: 1 });
    expect(String(fetcher.mock.calls[0][0])).toContain(`head_sha=${binding.workflowSha}`);
  });
  it('returns null for complete bounded absence without performing another dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ total_count: 0, workflow_runs: [] }));
    await expect(client(fetcher).correlateRun(correlation)).resolves.toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it.each([{ workflow_id: 999 }, { event: 'push' }, { head_sha: coordinates.candidateSha }, { head_branch: 'feature' },
    { repository: { id: 456, full_name: event.repository } }, { repository: { id: 123, full_name: 'calltelemetry/other' } },
    { path: '.github/workflows/untrusted.yml' }])('rejects an exact-name run with wrong provenance %j', async (change) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ total_count: 1, workflow_runs: [run(change)] }));
    await expect(client(fetcher).correlateRun(correlation)).rejects.toThrow('GitHub CI operation unavailable');
  });
  it('walks multiple pages and rejects duplicate exact correlations', async () => {
    const page = Array.from({ length: 100 }, (_, id) => run({ id: id + 1, display_title: 'unrelated' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ total_count: 101, workflow_runs: page }))
      .mockResolvedValueOnce(json({ total_count: 101, workflow_runs: [run({ id: 101 })] }));
    await expect(client(fetcher).correlateRun(correlation)).resolves.toEqual({ runId: 101, runAttempt: 1 });
    expect(String(fetcher.mock.calls[1][0])).toContain('page=2');
    const duplicate = vi.fn<typeof fetch>().mockResolvedValue(json({ total_count: 2, workflow_runs: [run(), run({ id: 100 })] }));
    await expect(client(duplicate).correlateRun(correlation)).rejects.toThrow('GitHub CI operation unavailable');
  });
  it.each([{ total_count: 1, workflow_runs: [] }, { total_count: MAX_CI_PAGES * 100 + 1, workflow_runs: [] },
    { total_count: 2, workflow_runs: [run(), run()] }, { total_count: 1, workflow_runs: [run()], truncated: true }])
  ('fails closed on incomplete, duplicate or oversized pages %j', async (body) => {
    await expect(client(vi.fn<typeof fetch>().mockResolvedValue(json(body))).correlateRun(correlation)).rejects.toThrow('GitHub CI operation unavailable');
  });
  it('reads exact run-attempt jobs and returns the shared terminal receipt only for real required-job success', async () => {
    const fetcher = reads();
    const result = await client(fetcher).readTerminalReceipt(execution);
    expect(result).toEqual({ version: 'ReviewCiTerminalReceipt.v1', execution, conclusion: 'success',
      jobs: [{ id: 100, runId: 99, runAttempt: 1, name: 'required tests', status: 'completed', conclusion: 'success' }] });
    expect(String(fetcher.mock.calls[1][0])).toContain('/actions/runs/99/attempts/1/jobs?');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('reads all bounded job pages before accepting a required job on the second page', async () => {
    const jobs = Array.from({ length: 100 }, (_, index) => job({ id: index + 200, name: `optional ${index}` }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(run()))
      .mockResolvedValueOnce(json({ total_count: 101, jobs }))
      .mockResolvedValueOnce(json({ total_count: 101, jobs: [job()] }))
      .mockResolvedValueOnce(json(run()));
    await expect(client(fetcher).readTerminalReceipt(execution)).resolves.toMatchObject({ conclusion: 'success',
      jobs: [{ id: 100, name: 'required tests', runId: 99, runAttempt: 1 }] });
    expect(String(fetcher.mock.calls[2][0])).toContain('/attempts/1/jobs?per_page=100&page=2');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([{ conclusion: 'skipped' }, { status: 'in_progress', conclusion: null }, { started_at: null },
    { completed_at: null }, { completed_at: '2026-09-08T00:00:00Z' }, { conclusion: 'failure' }])
  ('rejects run-level success without non-skipped, complete required-job proof %j', async (change) => {
    await expect(client(reads([job(change)])).readTerminalReceipt(execution)).rejects.toThrow('GitHub CI operation unavailable');
  });
  it.each([[], [job(), job({ id: 101 })], [job({ name: 'optional only' })], [job({ run_id: 999 })], [job({ head_sha: coordinates.headSha })]]
    .map((jobs) => ({ jobs })))
  ('rejects missing, duplicate or wrong-bound required jobs', async ({ jobs }) => {
    await expect(client(reads(jobs)).readRun({ ...correlation, runId: 99, runAttempt: 1 })).rejects.toThrow('GitHub CI operation unavailable');
  });
  it('rejects a rerun that begins while reading jobs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(run())).mockResolvedValueOnce(json({ total_count: 1, jobs: [job()] }))
      .mockResolvedValueOnce(json(run({ run_attempt: 2 })));
    await expect(client(fetcher).readTerminalReceipt(execution)).rejects.toThrow('GitHub CI operation unavailable');
  });
  it.each([{ candidateSha: 'f'.repeat(40) }, { workflowSha: 'f'.repeat(40) }, { repositoryId: 999 }, { runName: 'forged' }])
  ('rejects mismatched durable execution %j before readback', async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).readTerminalReceipt({ ...execution, ...change })).rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('current merge candidate', () => {
  const commit = () => ({ sha: coordinates.candidateSha, parents: [{ sha: coordinates.baseSha }, { sha: coordinates.headSha }] });
  it('resolves C before a validation binding exists, using the same immutable parent/current-PR checks', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()))
      .mockResolvedValueOnce(json(commit())).mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()));
    const ci = client(fetcher, { binding: undefined });
    const { candidateSha: _candidate, ...request } = coordinates;
    await expect(ci.currentMergeCandidate(request)).resolves.toEqual({ ...repository, ...coordinates });
    await expect(ci.dispatchWorkflow(correlation)).rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(String(fetcher.mock.calls[1][0])).toContain('/branches/main');
  });
  it('rejects caller-supplied C in the current-candidate request before I/O', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher, { binding: undefined }).currentMergeCandidate(coordinates))
      .rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not admit a fresh C if the PR changes during the immutable parent read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()))
      .mockResolvedValueOnce(json(commit()))
      .mockResolvedValueOnce(json(pull({ merge_commit_sha: 'e'.repeat(40) })));
    const { candidateSha: _candidate, ...request } = coordinates;
    await expect(client(fetcher, { binding: undefined }).currentMergeCandidate(request))
      .rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('rejects a PR payload whose base SHA is stale against the exact live base ref tip', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip('e'.repeat(40))));
    const { candidateSha: _candidate, ...request } = coordinates;
    await expect(client(fetcher, { binding: undefined }).currentMergeCandidate(request))
      .rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain('/branches/main');
  });
  it('rejects a branch-tip response for a different ref', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip(coordinates.baseSha, 'release')));
    const { candidateSha: _candidate, ...request } = coordinates;
    await expect(client(fetcher, { binding: undefined }).currentMergeCandidate(request))
      .rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects when the exact base ref moves between the before and after candidate reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()))
      .mockResolvedValueOnce(json(commit())).mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip('e'.repeat(40))));
    const { candidateSha: _candidate, ...request } = coordinates;
    await expect(client(fetcher, { binding: undefined }).currentMergeCandidate(request))
      .rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it('rejects a changed base ref before following a different branch path', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()))
      .mockResolvedValueOnce(json(commit())).mockResolvedValueOnce(json(pull({ base: {
        ref: 'release', sha: coordinates.baseSha, repo: { id: 123, full_name: event.repository },
      } })));
    const { candidateSha: _candidate, ...request } = coordinates;
    await expect(client(fetcher, { binding: undefined }).currentMergeCandidate(request))
      .rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('shares one whole deadline across PR and commit reads without a late PR continuation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(json(pull())), 150)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(json(branchTip())), 150)));
    const { candidateSha: _candidate, ...request } = coordinates;
    const pending = expect(client(fetcher, { binding: undefined }).currentMergeCandidate(request))
      .rejects.toThrow('GitHub CI operation unavailable');
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('verifies immutable C has exactly ordered parents B,H between current PR reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()))
      .mockResolvedValueOnce(json(commit())).mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()));
    await expect(client(fetcher).verifyMergeCandidate(coordinates)).resolves.toEqual({ ...repository, ...coordinates });
    expect(String(fetcher.mock.calls[2][0])).toContain(`/git/commits/${coordinates.candidateSha}`);
  });
  it.each([{ draft: true }, { state: 'closed' }, { mergeable: null }, { merge_commit_sha: 'e'.repeat(40) },
    { head: { sha: 'e'.repeat(40) } }, { base: { sha: 'e'.repeat(40), repo: { id: 123, full_name: event.repository } } }])
  ('rejects stale/unready PR %j', async (change) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(pull(change)));
    await expect(client(fetcher).verifyMergeCandidate(coordinates)).rejects.toThrow('GitHub CI operation unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([[coordinates.headSha, coordinates.baseSha], [coordinates.baseSha], [coordinates.baseSha, coordinates.headSha, binding.workflowSha]]
    .map((parents) => ({ parents })))
  ('rejects invalid merge parents %j', async ({ parents }) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()))
      .mockResolvedValueOnce(json({ ...commit(), parents: parents.map((sha) => ({ sha })) }));
    await expect(client(fetcher).verifyMergeCandidate(coordinates)).rejects.toThrow('GitHub CI operation unavailable');
  });
  it('rejects PR movement during the commit read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(pull())).mockResolvedValueOnce(json(branchTip()))
      .mockResolvedValueOnce(json(commit()))
      .mockResolvedValueOnce(json(pull({ merge_commit_sha: 'e'.repeat(40) })));
    await expect(client(fetcher).verifyMergeCandidate(coordinates)).rejects.toThrow('GitHub CI operation unavailable');
  });
});

describe('whole CI HTTP boundary', () => {
  it.each(['fetch', 'body'])('hard-stops non-cooperative %s; dispatch remains uncertain and no late continuation can dispatch', async (stage) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const releaseLock = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => stage === 'fetch' ? new Promise(() => undefined)
      : Promise.resolve({ status: 200, body: { getReader: () => ({ read: () => new Promise(() => undefined), cancel, releaseLock }) } } as unknown as Response));
    const pending = client(fetcher).dispatchWorkflow(correlation);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toEqual({ status: 'uncertain' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    if (stage === 'body') { expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce(); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a late fetch response without consuming it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const deferred = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(deferred.promise);
    const pending = client(fetcher).dispatchWorkflow(correlation);
    await vi.advanceTimersByTimeAsync(250); await pending;
    const cancel = vi.fn(); const pull = vi.fn();
    deferred.resolve(new Response(new ReadableStream({ cancel, pull }, { highWaterMark: 0 })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce(); expect(pull).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['oversized', 'invalid-json', 'invalid-utf8', 'redirect'])('rejects %s without raw diagnostic text', async (kind) => {
    const marker = 'PRIVATE_DIAGNOSTIC';
    const reply = kind === 'redirect' ? { status: 200, redirected: true, body: null } as Response
      : new Response(kind === 'oversized' ? 'é'.repeat(MAX_CI_RESPONSE_BYTES / 2 + 1)
        : kind === 'invalid-utf8' ? Buffer.from([0xc3, 0x28]) : marker);
    const pending = client(vi.fn<typeof fetch>().mockResolvedValue(reply)).correlateRun(correlation);
    await expect(pending).rejects.toThrow(/^GitHub CI operation unavailable$/u);
  });
  it.each([{ token: 'pat_x' }, { expectedAppId: 1 }, { baseUrl: 'http://api.example.invalid' },
    { baseUrl: 'https://user:password@api.example.invalid' }, { timeoutMs: 30_001 }])('rejects unsafe configuration %j without I/O', (change) => {
    const fetcher = vi.fn<typeof fetch>(); expect(() => client(fetcher, change)).toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});
