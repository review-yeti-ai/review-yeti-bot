import { describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';

const run = {
  runId: 'run_83c172a7d93c193fdb6dfa62bfa8bfde',
  deliveryId: 'actions:34382316702:1:1210979366:1555:be00d7cf67818fea67bdba4cedbfb6144824cc54',
  owner: 'calltelemetry', repo: 'ct-release', prNumber: 1555,
  headSha: 'be00d7cf67818fea67bdba4cedbfb6144824cc54',
  receivedAt: Date.parse('2026-09-09T17:21:31.807Z'),
  terminalDeadline: Date.parse('2026-09-09T17:36:31.807Z'), executionAttempt: 1,
};
const check = {
  id: 102570588126, name: 'Review Yeti', head_sha: run.headSha,
  app: { id: 4385771, slug: 'ct-review-bot' }, status: 'in_progress', conclusion: null,
  started_at: '2026-09-09T17:22:31Z', external_id: null,
};

function fixture(checks: unknown[] = [check], reread: unknown = check) {
  const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'PATCH') return new Response('{}');
    if (init?.method === 'POST') return new Response(JSON.stringify({ ...check, id: 77 }));
    return new Response(JSON.stringify(path.includes('/commits/') ? { check_runs: checks } : reread));
  });
  const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation });
  return { client, fetchImplementation };
}
const signal = () => AbortSignal.timeout(20_000);

describe('abandoned check exact App/attempt failure publication', () => {
  it('fails the existing genuine App orphan, ignoring the preview App failure; never creates a replacement', async () => {
    const { client, fetchImplementation } = fixture([check, {
      ...check, id: 102575533973, app: { id: 4435435, slug: 'ct-pr-operator-local-5f8cc6' },
      status: 'completed', conclusion: 'failure', started_at: '2026-09-09T17:37:00Z',
    }]);
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failed');
    const writes = fetchImplementation.mock.calls.filter(([, init]) => ['PATCH', 'POST'].includes(init?.method || ''));
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('https://api.github.com/repos/calltelemetry/ct-release/check-runs/102570588126');
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ status: 'completed', conclusion: 'failure',
      output: { title: 'Review Yeti: review did not complete' } });
    expect(String(writes[0][1]?.body)).not.toContain('No persona reviewed');
  });

  it.each([
    ['wrong publishing App', [check], 4435435],
    ['ambiguous legacy checks', [check, { ...check, id: 2 }], 4385771],
    ['newer execution', [{ ...check, external_id: `${run.runId}:a2`, started_at: '2026-09-09T17:38:00Z' }], 4385771],
    ['same-head different bound run', [{ ...check, external_id: `run_${'a'.repeat(32)}:a1` }], 4385771],
  ])('refuses %s without writing any check', async (_label, checks, appId) => {
    const { client, fetchImplementation } = fixture(checks as unknown[]);
    await expect(client.failAbandonedCheck(run, appId as number, signal())).rejects.toThrow();
    expect(fetchImplementation.mock.calls.every(([, init]) => !['POST', 'PATCH'].includes(init?.method || ''))).toBe(true);
  });

  it.each(['success', 'failure', 'cancelled'])('does not overwrite a completed %s check or mask it with a new one', async (conclusion) => {
    const { client, fetchImplementation } = fixture([check], { ...check, status: 'completed', conclusion });
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('already-completed');
    expect(fetchImplementation.mock.calls).toHaveLength(2);
    expect(fetchImplementation.mock.calls.every(([, init]) => !['POST', 'PATCH'].includes(init?.method || ''))).toBe(true);
  });

  it('refuses a changed head or App on the direct pre-write read', async () => {
    const { client, fetchImplementation } = fixture([check], { ...check, head_sha: 'f'.repeat(40) });
    await expect(client.failAbandonedCheck(run, 4385771, signal())).rejects.toThrow();
    expect(fetchImplementation.mock.calls).toHaveLength(2);
  });

  it('creates only a completed failure bound to the abandoned attempt when no check ever existed', async () => {
    const { client, fetchImplementation } = fixture([]);
    await client.failAbandonedCheck(run, 4385771, signal());
    const writes = fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ name: 'Review Yeti', head_sha: run.headSha,
      external_id: 'run_83c172a7d93c193fdb6dfa62bfa8bfde:a1', status: 'completed', conclusion: 'failure' });
  });

  it('transports a worker external_id on check creation', async () => {
    const { client, fetchImplementation } = fixture([]);
    await client.createCheck(run.owner, run.repo, run.headSha, 'run_83c172a7d93c193fdb6dfa62bfa8bfde:a2');
    expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toMatchObject({
      external_id: 'run_83c172a7d93c193fdb6dfa62bfa8bfde:a2', status: 'in_progress', head_sha: run.headSha,
    });
  });

  it('accepts an unambiguous legacy start rounded to the GitHub timestamp second', async () => {
    const rounded = { ...check, started_at: '2026-09-09T17:21:31Z' };
    const { client, fetchImplementation } = fixture([rounded], rounded);
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failed');
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });

  it('propagates a bounded cancellation signal through reads and write, without leaking upstream errors', async () => {
    const { client, fetchImplementation } = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(client.failAbandonedCheck(run, 4385771, abort.signal)).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
    fetchImplementation.mockRejectedValue(new Error('secret provider payload'));
    await expect(client.failAbandonedCheck(run, 4385771, signal())).rejects.not.toThrow('secret provider payload');
  });

  it('finds the genuine check beyond the first page and carries the same cancellation signal through every request', async () => {
    const { client, fetchImplementation } = fixture();
    const bounded = signal();
    const older = Array.from({ length: 100 }, (_, index) => ({ ...check, id: index + 1, started_at: '2026-09-08T00:00:00Z' }));
    fetchImplementation.mockImplementation(async (url, init) => {
      expect(init?.signal).toBe(bounded);
      const page = new URL(String(url)).searchParams.get('page');
      if (page === '1') return new Response(JSON.stringify({ check_runs: older }));
      if (page === '2') return new Response(JSON.stringify({ check_runs: [check] }));
      return new Response(JSON.stringify(check));
    });
    await expect(client.failAbandonedCheck(run, 4385771, bounded)).resolves.toBe('failed');
    expect(fetchImplementation.mock.calls).toHaveLength(4);
    expect(fetchImplementation.mock.calls[3][1]?.method).toBe('PATCH');
  });

  it('fails closed if a bounded list cannot establish uniqueness', async () => {
    const { client, fetchImplementation } = fixture(Array.from({ length: 100 }, () => check));
    await expect(client.failAbandonedCheck(run, 4385771, signal())).rejects.toThrow();
    expect(fetchImplementation.mock.calls).toHaveLength(5);
    expect(fetchImplementation.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
});
