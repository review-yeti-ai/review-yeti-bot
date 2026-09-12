import { describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { AbandonedRunReaper } from '../../src/review/abandonedRunReaper';
import type {
  AbandonedCheckRecoveryOutcome,
  AbandonedPublishingRun,
} from '../../src/persistence/reviewDispatchRepository';

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
const externalId = `${run.runId}:a${run.executionAttempt}`;
const exactCheck = { ...check, external_id: externalId };

function fixture(checks: unknown[] = [exactCheck], reread: unknown = exactCheck) {
  const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'PATCH') return new Response('{}');
    if (init?.method === 'POST') return new Response(JSON.stringify({
      ...exactCheck, ...JSON.parse(String(init.body)), id: 77,
    }));
    return new Response(JSON.stringify(path.includes('/commits/') ? { check_runs: checks } : reread));
  });
  const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation, sleep: async () => undefined });
  return { client, fetchImplementation };
}
const signal = () => AbortSignal.timeout(20_000);
const persistedWindows = [900_000, 1_800_000, 2_700_000, 3_600_000];

describe('abandoned check exact App/attempt failure publication', () => {
  it('recognizes only an exact App/run/attempt completed success as authoritative', async () => {
    const succeeded = { ...exactCheck, status: 'completed', conclusion: 'success' };
    const { client, fetchImplementation } = fixture([succeeded], succeeded);
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('authoritative-success');
    expect(fetchImplementation.mock.calls.every(([, init]) => !['POST', 'PATCH'].includes(init?.method || ''))).toBe(true);
  });

  it('reconciles an exact completed failure without publishing another check', async () => {
    const failed = { ...exactCheck, status: 'completed', conclusion: 'failure' };
    const { client, fetchImplementation } = fixture([failed], failed);
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-existing');
    expect(fetchImplementation.mock.calls.every(([, init]) => !['POST', 'PATCH'].includes(init?.method || ''))).toBe(true);
  });

  it.each(['cancelled', 'neutral', 'skipped'])('normalizes an exact completed %s check to explicit failure', async (conclusion) => {
    const completed = { ...exactCheck, status: 'completed', conclusion };
    const { client, fetchImplementation } = fixture([completed], completed);
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-published');
    const writes = fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ status: 'completed', conclusion: 'failure' });
  });

  it.each(['queued', 'pending', 'waiting', 'requested'])(
    'patches an exact %s check to explicit failure without creating another check',
    async (status) => {
      const visible = { ...exactCheck, status, conclusion: null };
      const { client, fetchImplementation } = fixture([visible], visible);
      await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-published');
      expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
      expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    },
  );

  it('sends the live-shaped exact-attempt failure PATCH with a GitHub-compatible refresh action', async () => {
    const liveRun = {
      ...run,
      runId: 'run_29094e318827437672e3f2bff3c59004',
      owner: 'calltelemetry',
      repo: 'ct-review-actions',
      prNumber: 303,
      headSha: 'e33fffa1cb2973c2dc972de6b00bd99bb0521908',
      receivedAt: Date.parse('2026-09-11T23:05:46.000Z'),
      terminalDeadline: Date.parse('2026-09-11T23:20:46.000Z'),
      executionAttempt: 2,
    };
    const liveCheck = {
      id: 103450628829,
      name: 'Review Yeti',
      head_sha: liveRun.headSha,
      app: { id: 4385771, slug: 'ct-review-bot' },
      status: 'in_progress',
      conclusion: null,
      started_at: '2026-09-11T23:05:46Z',
      external_id: `${liveRun.runId}:a${liveRun.executionAttempt}`,
    };
    const { client, fetchImplementation } = fixture([liveCheck], liveCheck);

    await expect(client.failAbandonedCheck(liveRun, 4385771, signal())).resolves.toBe('failure-published');

    const patches = fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0][0]).toBe(
      'https://api.github.com/repos/calltelemetry/ct-review-actions/check-runs/103450628829',
    );
    expect(JSON.parse(String(patches[0][1]?.body))).toEqual({
      status: 'completed',
      conclusion: 'failure',
      completed_at: expect.any(String),
      actions: [{
        label: 'Refresh review',
        description: 'Retry failed review for this exact head.',
        identifier: 'review-yeti/refresh',
      }],
      output: {
        title: 'Review Yeti: review did not complete',
        summary: `No durable verdict was recorded for \`${liveRun.headSha}\` before its terminal deadline.\n\n`
          + 'The worker may have started; this is a failed review rather than an approval.\n\n'
          + 'Re-run the governed review workflow to request a fresh attempt.',
      },
    });
  });

  it.each(persistedWindows)('publishes a valid persisted %i ms window independently of the current admission default', async (window) => {
    const persistedRun = { ...run, terminalDeadline: run.receivedAt + window };
    const { client, fetchImplementation } = fixture();
    await expect(client.failAbandonedCheck(persistedRun, 4385771, signal())).resolves.toBe('failure-published');
    expect(fetchImplementation.mock.calls).toHaveLength(3);
    expect(fetchImplementation.mock.calls[2][0]).toBe('https://api.github.com/repos/calltelemetry/ct-release/check-runs/102570588126');
    expect(fetchImplementation.mock.calls[2][1]?.method).toBe('PATCH');
    expect(JSON.parse(String(fetchImplementation.mock.calls[2][1]?.body))).toMatchObject({
      status: 'completed', conclusion: 'failure',
    });
  });

  it.each([
    ['below minimum', run.receivedAt, run.receivedAt + 899_999],
    ['above maximum', run.receivedAt, run.receivedAt + 3_600_001],
    ['zero window', run.receivedAt, run.receivedAt],
    ['reversed window', run.receivedAt, run.receivedAt - 900_000],
    ['NaN receipt', Number.NaN, run.terminalDeadline],
    ['NaN deadline', run.receivedAt, Number.NaN],
    ['infinite receipt', Number.POSITIVE_INFINITY, run.terminalDeadline],
    ['negative infinite receipt', Number.NEGATIVE_INFINITY, run.terminalDeadline],
    ['infinite deadline', run.receivedAt, Number.POSITIVE_INFINITY],
    ['negative infinite deadline', run.receivedAt, Number.NEGATIVE_INFINITY],
  ])('refuses %s before any HTTP request', async (_label, receivedAt, terminalDeadline) => {
    const { client, fetchImplementation } = fixture();
    await expect(client.failAbandonedCheck({ ...run, receivedAt: receivedAt as number,
      terminalDeadline: terminalDeadline as number }, 4385771, signal())).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    { runId: 'unbound-run' },
    { headSha: 'unbound-head' },
    { executionAttempt: 0 },
    { executionAttempt: 1.5 },
    { executionAttempt: Number.NaN },
  ])('retains identity validation with a valid 60-minute window: %j', async (identity) => {
    const { client, fetchImplementation } = fixture();
    await expect(client.failAbandonedCheck({ ...run, terminalDeadline: run.receivedAt + 3_600_000,
      ...identity }, 4385771, signal())).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([0, Number.NaN, 4385771.5])('refuses invalid publisher App %s before any HTTP request', async (appId) => {
    const { client, fetchImplementation } = fixture();
    await expect(client.failAbandonedCheck({ ...run, terminalDeadline: run.receivedAt + 1_800_000 },
      appId, signal())).rejects.toThrow();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('fails the existing genuine App orphan, ignoring the preview App failure; never creates a replacement', async () => {
    const { client, fetchImplementation } = fixture([exactCheck, {
      ...check, id: 102575533973, app: { id: 4435435, slug: 'ct-pr-operator-local-5f8cc6' },
      status: 'completed', conclusion: 'failure', started_at: '2026-09-09T17:37:00Z',
    }]);
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-published');
    const writes = fetchImplementation.mock.calls.filter(([, init]) => ['PATCH', 'POST'].includes(init?.method || ''));
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe('https://api.github.com/repos/calltelemetry/ct-release/check-runs/102570588126');
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ status: 'completed', conclusion: 'failure',
      output: { title: 'Review Yeti: review did not complete' } });
    expect(String(writes[0][1]?.body)).not.toContain('No persona reviewed');
  });

  it.each([
    ['ambiguous exact checks', [exactCheck, { ...exactCheck, id: 2 }], 4385771],
    ['newer execution', [{ ...check, external_id: `${run.runId}:a2`, started_at: '2026-09-09T17:38:00Z' }], 4385771],
    ['same-head different bound run', [{ ...check, external_id: `run_${'a'.repeat(32)}:a1` }], 4385771],
    ['legacy check without exact attempt identity', [check], 4385771],
  ])('refuses %s without writing any check', async (_label, checks, appId) => {
    const { client, fetchImplementation } = fixture(checks as unknown[]);
    await expect(client.failAbandonedCheck(run, appId as number, signal())).rejects.toThrow();
    expect(fetchImplementation.mock.calls.every(([, init]) => !['POST', 'PATCH'].includes(init?.method || ''))).toBe(true);
  });

  it('allows an older previous-attempt check while creating failure for the current exact attempt', async () => {
    const retryRun = { ...run, executionAttempt: 2 };
    const previous = {
      ...exactCheck,
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-09-09T17:20:00Z',
    };
    const { client, fetchImplementation } = fixture([previous]);
    await expect(client.failAbandonedCheck(retryRun, 4385771, signal())).resolves.toBe('failure-published');
    const posts = fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({ external_id: `${run.runId}:a2` });
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  it('does not let a foreign App success suppress the exact publisher-owned failure', async () => {
    const foreign = { ...exactCheck, app: { id: 4435435 }, status: 'completed', conclusion: 'success' };
    const created = { ...exactCheck, id: 77, status: 'completed', conclusion: 'failure' };
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify(created));
      return new Response(JSON.stringify(String(url).includes('/commits/') ? { check_runs: [foreign] } : created));
    });
    const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation, sleep: async () => undefined });
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-published');
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    { head_sha: 'f'.repeat(40) },
    { app: { id: 4435435 } },
    { external_id: `${run.runId}:a2` },
  ])('refuses changed identity %j on the direct pre-write read', async (identity) => {
    const { client, fetchImplementation } = fixture([exactCheck], { ...exactCheck, ...identity });
    await expect(client.failAbandonedCheck(run, 4385771, signal())).rejects.toThrow();
    expect(fetchImplementation.mock.calls).toHaveLength(2);
  });

  it.each([
    ['an unrecognized non-terminal status', { status: 'stale', conclusion: null }],
    ['a completed status without a conclusion', { status: 'completed', conclusion: null }],
  ])('refuses %s on the direct pre-write read without PATCH or POST', async (_label, state) => {
    const { client, fetchImplementation } = fixture([exactCheck], { ...exactCheck, ...state });
    await expect(client.failAbandonedCheck(run, 4385771, signal())).rejects.toThrow();
    expect(fetchImplementation.mock.calls).toHaveLength(2);
    expect(fetchImplementation.mock.calls.every(([, init]) => !['POST', 'PATCH'].includes(init?.method || '')))
      .toBe(true);
  });

  it('does not treat an older same-App check as a conflicting newer attempt', async () => {
    const olderCheck = {
      ...check,
      external_id: `${run.runId}:a0`,
      started_at: '2026-09-09T17:21:30Z',
    };
    const { client, fetchImplementation } = fixture([olderCheck]);

    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-published');

    const writes = fetchImplementation.mock.calls.filter(([, init]) => ['PATCH', 'POST'].includes(init?.method || ''));
    expect(writes).toHaveLength(1);
    expect(writes[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({
      external_id: externalId,
      head_sha: run.headSha,
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('creates only a completed failure bound to the abandoned attempt when no check ever existed', async () => {
    const { client, fetchImplementation } = fixture([]);
    await client.failAbandonedCheck(run, 4385771, signal());
    const writes = fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ name: 'Review Yeti', head_sha: run.headSha,
      external_id: 'run_83c172a7d93c193fdb6dfa62bfa8bfde:a1', status: 'completed', conclusion: 'failure' });
  });

  it('observes an exact attempt that becomes visible during pre-create backoff without posting', async () => {
    let lookups = 0;
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('create must not run after eventual visibility');
      if (String(url).includes('/commits/')) {
        lookups += 1;
        return new Response(JSON.stringify({ check_runs: lookups === 1 ? [] : [exactCheck] }));
      }
      return new Response(JSON.stringify(exactCheck));
    });
    const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation,
      sleep: async () => undefined });

    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-published');
    expect(lookups).toBe(2);
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('keeps recovery lookup-only when the create response is not bound to the exact attempt', async () => {
    const malformed = {
      ...exactCheck,
      id: 77,
      external_id: `${run.runId}:a2`,
      status: 'completed',
      conclusion: 'failure',
    };
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify(malformed));
      return new Response(JSON.stringify({ check_runs: [] }));
    });
    const client = new GitHubInstallationClient({
      token: 'ghs_offline',
      fetchImplementation,
      sleep: async () => undefined,
    });

    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('creation-unconfirmed');
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  it.each([
    [401, JSON.stringify({ message: 'bad credentials' })],
    [403, JSON.stringify({ message: 'forbidden' })],
    [422, '<html>unprocessable</html>'],
    [500, ''],
  ] as const)(
    'keeps a definitive HTTP %i create rejection retryable after credentials or permissions recover',
    async (status, responseBody) => {
      let postCount = 0;
      const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          postCount += 1;
          if (postCount === 1) {
            return new Response(responseBody, { status });
          }
          return new Response(JSON.stringify({
            ...exactCheck,
            ...JSON.parse(String(init.body)),
            id: 77,
          }));
        }
        return new Response(JSON.stringify(String(url).includes('/commits/') ? { check_runs: [] } : exactCheck));
      });
      const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation,
        sleep: async () => undefined });

      await expect(client.failAbandonedCheck(run, 4385771, signal())).rejects.toThrow();
      await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-published');
      expect(postCount).toBe(2);
      expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
    },
  );

  it('transports a worker external_id on check creation', async () => {
    const { client, fetchImplementation } = fixture([]);
    await client.createCheck(run.owner, run.repo, run.headSha, 'run_83c172a7d93c193fdb6dfa62bfa8bfde:a2');
    expect(JSON.parse(String(fetchImplementation.mock.calls[0][1]?.body))).toMatchObject({
      external_id: 'run_83c172a7d93c193fdb6dfa62bfa8bfde:a2', status: 'in_progress', head_sha: run.headSha,
    });
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

  it('cancels promptly during visibility backoff without issuing another request', async () => {
    const abort = new AbortController();
    let enterBackoff = () => {};
    const backoffStarted = new Promise<void>((resolve) => { enterBackoff = resolve; });
    const sleep = vi.fn(async () => {
      enterBackoff();
      await new Promise<void>(() => undefined);
    });
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ check_runs: [] })));
    const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation, sleep });
    const publication = client.failAbandonedCheck(run, 4385771, abort.signal);
    await backoffStarted;
    const settled = new Promise<'resolved' | 'rejected' | 'timeout'>((resolve) => {
      const timeout = setTimeout(() => resolve('timeout'), 100);
      void publication.then(() => {
        clearTimeout(timeout);
        resolve('resolved');
      }, () => {
        clearTimeout(timeout);
        resolve('rejected');
      });
    });
    abort.abort(new Error('cancel during backoff'));
    await expect(settled).resolves.toBe('rejected');
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('finds the genuine check beyond the first page and carries the same cancellation signal through every request', async () => {
    const { client, fetchImplementation } = fixture();
    const bounded = signal();
    const older = Array.from({ length: 100 }, (_, index) => ({ ...check, id: index + 1, started_at: '2026-09-08T00:00:00Z' }));
    fetchImplementation.mockImplementation(async (url, init) => {
      expect(init?.signal).toBe(bounded);
      const page = new URL(String(url)).searchParams.get('page');
      if (page === '1') return new Response(JSON.stringify({ check_runs: older }));
      if (page === '2') return new Response(JSON.stringify({ check_runs: [exactCheck] }));
      return new Response(JSON.stringify(exactCheck));
    });
    await expect(client.failAbandonedCheck(run, 4385771, bounded)).resolves.toBe('failure-published');
    expect(fetchImplementation.mock.calls).toHaveLength(4);
    expect(fetchImplementation.mock.calls[3][1]?.method).toBe('PATCH');
  });

  it('fails closed if a bounded list cannot establish uniqueness', async () => {
    const { client, fetchImplementation } = fixture(Array.from({ length: 100 }, () => check));
    await expect(client.failAbandonedCheck(run, 4385771, signal())).rejects.toThrow();
    expect(fetchImplementation.mock.calls).toHaveLength(5);
    expect(fetchImplementation.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('recovers one lost create response after bounded eventual visibility without a duplicate POST', async () => {
    const created = { ...exactCheck, id: 77, status: 'completed', conclusion: 'failure' };
    let postCount = 0;
    let lookupsAfterPost = 0;
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount += 1;
        throw new TypeError('response lost after create');
      }
      if (String(url).includes('/commits/')) {
        if (postCount === 0) return new Response(JSON.stringify({ check_runs: [] }));
        lookupsAfterPost += 1;
        return new Response(JSON.stringify({ check_runs: lookupsAfterPost < 2 ? [] : [created] }));
      }
      return new Response(JSON.stringify(created));
    });
    const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation, sleep: async () => undefined });
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('failure-existing');
    expect(postCount).toBe(1);
  });

  it('persists lookup-only recovery when both the create response and recovery lookup are unavailable', async () => {
    let postAttempted = false;
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postAttempted = true;
        throw new TypeError('response lost after create');
      }
      if (postAttempted) throw new TypeError('visibility lookup unavailable');
      return new Response(JSON.stringify({ check_runs: [] }));
    });
    const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation, sleep: async () => undefined });
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('creation-unconfirmed');
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('reconciles a visible in-progress exact-attempt check during recovery-only lookup without creating', async () => {
    const { client, fetchImplementation } = fixture([exactCheck], exactCheck);
    await expect(client.failAbandonedCheck({ ...run, recoveryOnly: true }, 4385771, signal()))
      .resolves.toBe('failure-published');
    const patches = fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0][0]).toBe('https://api.github.com/repos/calltelemetry/ct-release/check-runs/102570588126');
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it.each([
    ['completed failure', 'failure', 'failure-existing'],
    ['completed success', 'success', 'authoritative-success'],
  ] as const)('returns %s recovery for a visible recovery-only exact attempt', async (_label, conclusion, outcome) => {
    const completed = { ...exactCheck, status: 'completed', conclusion };
    const { client, fetchImplementation } = fixture([completed], completed);
    await expect(client.failAbandonedCheck({ ...run, recoveryOnly: true }, 4385771, signal()))
      .resolves.toBe(outcome);
    expect(fetchImplementation.mock.calls.filter(([, init]) => ['PATCH', 'POST'].includes(init?.method || '')))
      .toHaveLength(0);
  });

  it('persists an unconfirmed create as recovery-only and never blindly creates it again', async () => {
    let postCount = 0;
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount += 1;
        throw new TypeError('response lost after create');
      }
      return new Response(JSON.stringify({ check_runs: [] }));
    });
    const client = new GitHubInstallationClient({ token: 'ghs_offline', fetchImplementation, sleep: async () => undefined });
    await expect(client.failAbandonedCheck(run, 4385771, signal())).resolves.toBe('creation-unconfirmed');
    await expect(client.failAbandonedCheck({ ...run, recoveryOnly: true }, 4385771, signal()))
      .resolves.toBe('creation-unconfirmed');
    expect(postCount).toBe(1);
  });
});

describe('abandoned reaper with the actual GitHub publication adapter', () => {
  it.each(persistedWindows.flatMap((window) =>
    (['existing', 'absent', 'completed'] as const).map((state) => ({ window, state })),
  ))('reconciles a persisted $window ms / $state check once before its terminal deadline', async ({ window, state }) => {
    const persistedRun = { ...run, terminalDeadline: run.receivedAt + window };
    const owned = { ...check, external_id: `${run.runId}:a1` };
    const { client, fetchImplementation } = fixture(state === 'absent' ? [] : [owned],
      state === 'completed' ? { ...owned, status: 'completed', conclusion: 'success' } : owned);
    // Only persistence is a seam here; the reaper callback must call the real
    // adapter and reach its injected HTTP boundary before acknowledgement.
    let pending = true;
    const repository = {
      claimAbandonedPublishingRuns: async () => pending ? [persistedRun] : [],
      reconcileAbandonedPublishingRun: async (
        claimed: AbandonedPublishingRun, _worker: string, _now: number,
        publish: () => Promise<AbandonedCheckRecoveryOutcome>,
      ) => {
        expect(claimed).toEqual(persistedRun);
        const outcome = await publish();
        pending = false;
        return { reconciled: true, outcome };
      },
    };
    const reaperNow = persistedRun.receivedAt + 2_000;
    expect(reaperNow).toBeLessThan(persistedRun.terminalDeadline);
    const reaper = new AbandonedRunReaper({ repository, checkClientFor: async () => client,
      publisherAppId: 4385771, workerId: 'offline-reaper', now: () => reaperNow });
    await expect(reaper.runOnce()).resolves.toEqual({ swept: 1, published: state === 'completed' ? 0 : 1, failed: 0 });
    expect(pending).toBe(false);
    const writes = fetchImplementation.mock.calls.filter(([, init]) => ['PATCH', 'POST'].includes(init?.method || ''));
    expect(writes).toHaveLength(state === 'completed' ? 0 : 1);
    if (state !== 'completed') {
      expect(writes[0][1]?.method).toBe(state === 'absent' ? 'POST' : 'PATCH');
      if (state === 'existing') {
        expect(writes[0][0]).toBe('https://api.github.com/repos/calltelemetry/ct-release/check-runs/102570588126');
      }
      expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ status: 'completed', conclusion: 'failure',
        ...(state === 'absent' ? { head_sha: run.headSha, external_id: `${run.runId}:a1` } : {}) });
    }
    const requests = fetchImplementation.mock.calls.length;
    expect(requests).toBe(state === 'existing' ? 3 : state === 'absent' ? 4 : 2);
    await expect(reaper.runOnce()).resolves.toEqual({ swept: 0, published: 0, failed: 0 });
    expect(fetchImplementation.mock.calls).toHaveLength(requests);
  });
});
