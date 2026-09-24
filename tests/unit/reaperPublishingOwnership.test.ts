import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { runReviewJobDispatcherLoop } from '../../src/k8s/reviewJobDispatcherRuntime';

const state = vi.hoisted(() => ({
  credentials: undefined as Record<string, unknown> | undefined,
  reaperOptions: undefined as Record<string, any> | undefined,
  events: [] as string[],
  poolQuery: vi.fn(async () => ({ rows: [] })),
  poolConnect: vi.fn(async () => ({ query: vi.fn(), release: vi.fn() })),
  identity: vi.fn(async () => ({ id: 4385771 })),
  mint: vi.fn(async () => ({ token: 'ghs_offline' })),
  close: vi.fn(async () => {}),
  reap: vi.fn<(signal: AbortSignal) => Promise<void>>(),
  loop: vi.fn<typeof runReviewJobDispatcherLoop>(),
  k8sList: vi.fn(async () => ({ items: [] as unknown[] })),
}));
vi.mock('@kubernetes/client-node', () => ({ CustomObjectsApi: class {}, CoreV1Api: class {}, KubeConfig: class {
  loadFromCluster() {} makeApiClient() { return { listNamespacedCustomObject: state.k8sList }; }
} }));
vi.mock('../../src/github/appAuth', () => ({ getGitHubAppIdentity: state.identity, getGitHubAppRepositoryPublishToken: state.mint }));
vi.mock('../../src/persistence/postgresStore', () => ({ PostgresStore: class {
  async initialize() {} getPool() { return { query: state.poolQuery, connect: state.poolConnect }; } close = state.close;
} }));
vi.mock('../../src/k8s/kubernetesRunSecretProvisioner', () => ({ KubernetesRunSecretProvisioner: class {
  constructor(options: Record<string, unknown>) { state.credentials = options; }
} }));
vi.mock('../../src/k8s/reviewJobDispatchEngine', () => ({ ReviewJobDispatchEngine: class {
  async runOnce() { state.events.push('dispatch'); return { status: 'idle' }; }
} }));
vi.mock('../../src/review/abandonedRunReaper', () => ({ AbandonedRunReaper: class {
  constructor(options: Record<string, any>) { state.reaperOptions = options; }
  runOnce = state.reap;
} }));
vi.mock('../../src/k8s/reviewJobDispatcherRuntime', async (original) => ({
  ...await original<typeof import('../../src/k8s/reviewJobDispatcherRuntime')>(),
  runReviewJobDispatcherLoop: state.loop,
}));

beforeEach(() => {
  vi.resetModules();
  state.events.length = 0;
  state.credentials = undefined;
  state.reaperOptions = undefined;
  state.poolQuery.mockReset().mockResolvedValue({ rows: [] });
  state.poolConnect.mockReset().mockImplementation(async () => ({ query: state.poolQuery, release: vi.fn() }));
  state.loop.mockReset().mockImplementation(async (engine) => { await engine.runOnce(); });
  state.reap.mockReset().mockImplementation(async (signal) => {
    state.events.push('reconcile');
    await state.reaperOptions!.checkClientFor({ owner: 'calltelemetry', repo: 'ct-release' }, signal);
  });
  state.close.mockReset().mockImplementation(async () => { state.events.push('close'); });
  state.k8sList.mockReset().mockResolvedValue({ items: [] });
  vi.stubEnv('REVIEW_JOB_DISPATCH_ENABLED', 'true');
  vi.stubEnv('REVIEW_JOB_NAMESPACE', 'ct-review-system');
  vi.stubEnv('REVIEW_JOB_WORKER_IMAGE', `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'a'.repeat(64)}`);
  vi.stubEnv('HOSTNAME', 'offline-dispatcher');
  vi.stubEnv('GITHUB_APP_ID', '4385771');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'offline-key');
  // This suite asserts the TRANSACTIONAL completion path (pool.connect() +
  // BEGIN/COMMIT). That path is selected only when the lifecycle outbox is
  // enabled, so the mode is pinned here rather than inherited from whatever the
  // entrypoint happened to hardcode.
  vi.stubEnv('CT_REVIEW_EVENTS_ENABLED', 'true');
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; });

/**
 * The completion repository takes one of two paths depending on whether the
 * lifecycle outbox is being written:
 *
 *   disabled (default) -> `pool.query` directly, no transaction
 *   enabled            -> `pool.connect()` + BEGIN/COMMIT around the claim
 *
 * This helper used to assume the enabled path implicitly, because the
 * dispatcher hardcoded `lifecycleEvents: 'enabled'`. The dispatcher now resolves
 * that from `CT_REVIEW_EVENTS_ENABLED` (default disabled, matching the
 * suspended transport it feeds), so the expectation must name the mode it means
 * rather than inherit one.
 *
 * "Idle" = the disabled path: one direct probe query, no pooled connection.
 */
function expectIdleCompletionPool(): void {
  expect(state.poolQuery).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('FROM review_completion_outbox AS outbox'),
    [expect.any(Number)],
  );
  expect(state.poolConnect).not.toHaveBeenCalled();
}

/** "Enabled" = the transactional path: a pooled client is acquired. */
function expectTransactionalCompletionPool(): void {
  expect(state.poolConnect).toHaveBeenCalled();
}

describe('dispatcher publishing ownership composition', () => {
  it('wires the real delegated-failure reader into the reaper with the configured namespace and poll interval (REL-896)', async () => {
    // Every unit of REL-896 is tested in isolation with injected fakes; this is
    // the only place the feature is assembled. Without this, deleting the
    // `delegatedFailureReader` line from the entrypoint would silently revert
    // production to deadline-only reaping with a fully green suite.
    vi.spyOn(process, 'once').mockReturnValue(process);
    vi.stubEnv('REVIEW_DELEGATED_FAILURE_POLL_MS', '20000');
    await import('../../src/reviewJobDispatcherIndex');
    await vi.waitFor(() => expect(state.close).toHaveBeenCalled());
    const reader = state.reaperOptions!.delegatedFailureReader;
    expect(reader, 'the reaper must receive a delegated-failure reader').toBeDefined();
    expect(reader.pollIntervalMs).toBe(20_000);
    await expect(reader.listCandidates()).resolves.toEqual([]);
    expect(state.k8sList).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      group: 'review-yeti.ai', version: 'v1alpha2', namespace: 'ct-review-system', plural: 'prreviewjobs',
    }));
  });

  it('uses the same authenticated App for worker secrets and reaping, and awaits reaping before dispatch/DB close', async () => {
    // Do not install real process signal handlers from a service entrypoint.
    vi.spyOn(process, 'once').mockReturnValue(process);
    await import('../../src/reviewJobDispatcherIndex');
    await vi.waitFor(() => expect(state.close).toHaveBeenCalled());
    expect(state.identity).toHaveBeenCalledWith({ appId: '4385771', privateKey: 'offline-key' });
    expect(state.credentials).toMatchObject({ appId: '4385771', privateKey: 'offline-key' });
    expect(state.reaperOptions).toMatchObject({ publisherAppId: 4385771, limit: 1 });
    expect(state.mint).toHaveBeenCalledWith({ appId: '4385771', privateKey: 'offline-key',
      owner: 'calltelemetry', repo: 'ct-release', signal: expect.any(AbortSignal) });
    expect(state.events).toEqual(['reconcile', 'dispatch', 'close']);
    expectIdleCompletionPool();
  });

  it('routes only the exact public target through its dedicated worker and reaper App', async () => {
    vi.spyOn(process, 'once').mockReturnValue(process);
    vi.stubEnv('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES', 'review-yeti-ai/review-yeti-bot');
    vi.stubEnv('REVIEW_YETI_PUBLIC_TARGET_APP_ID', '7654321');
    vi.stubEnv('REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY', 'public-key');

    await import('../../src/reviewJobDispatcherIndex');
    await vi.waitFor(() => expect(state.close).toHaveBeenCalled());

    const credentialsForRepository = state.credentials!.credentialsForRepository as
      (owner: string, repo: string) => { appId: string; privateKey: string };
    expect(credentialsForRepository('review-yeti-ai', 'review-yeti-bot')).toEqual({
      appId: '7654321', privateKey: 'public-key',
    });
    expect(credentialsForRepository('calltelemetry', 'ct-meta')).toEqual({
      appId: '4385771', privateKey: 'offline-key',
    });

    const publicRun = { owner: 'review-yeti-ai', repo: 'review-yeti-bot' };
    expect(state.reaperOptions!.publisherAppIdFor(publicRun)).toBe(7_654_321);
    await state.reaperOptions!.checkClientFor(publicRun, AbortSignal.timeout(1_000));
    expect(state.mint).toHaveBeenLastCalledWith({
      appId: '7654321', privateKey: 'public-key', owner: 'review-yeti-ai', repo: 'review-yeti-bot',
      signal: expect.any(AbortSignal),
    });
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('passes loop options and drains reaping before close after captured %s', async (shutdown) => {
    const handlers = new Map<string | symbol, () => void>();
    vi.spyOn(process, 'once').mockImplementation((event, listener) => {
      handlers.set(event, listener);
      return process;
    });
    const reaping = Promise.withResolvers<void>();
    const signals: Array<{ signal: AbortSignal; aborted: boolean }> = [];
    state.reap.mockImplementation(async (signal) => {
      signals.push({ signal, aborted: signal.aborted });
      state.events.push(signal.aborted ? 'reconcile-aborted-start' : 'reconcile-live');
      if (signal.aborted) {
        await reaping.promise;
        state.events.push('reconcile-aborted-finish');
      }
    });
    state.loop.mockImplementation(async (wrapper) => {
      await wrapper.runOnce();
      // Invoke only the captured callback; never emit a process/OS signal.
      handlers.get(shutdown)!();
      await wrapper.runOnce();
    });

    try {
      await import('../../src/reviewJobDispatcherIndex');
      await vi.waitFor(() => expect(state.reap).toHaveBeenCalledTimes(2));
      expect([...handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);
      expect(state.loop).toHaveBeenCalledOnce();
      const options = state.loop.mock.calls[0][1];
      expect(options).toMatchObject({
        signal: expect.any(AbortSignal), idleDelayMs: 1_000, activeDelayMs: 50, errorDelayMs: 5_000,
        onOutcome: expect.any(Function), onCycleError: expect.any(Function),
      });
      expect(signals.map(({ aborted }) => aborted)).toEqual([false, true]);
      for (const { signal } of signals) expect(signal).toBe(options.signal);
      expect(options.signal.aborted).toBe(true);
      expect(state.events).toEqual(['reconcile-live', 'dispatch', 'reconcile-aborted-start']);
      expect(state.close).not.toHaveBeenCalled();
    } finally {
      reaping.resolve();
      await vi.waitFor(() => expect(state.close).toHaveBeenCalledOnce());
    }
    expect(state.events).toEqual([
      'reconcile-live', 'dispatch', 'reconcile-aborted-start', 'reconcile-aborted-finish', 'close',
    ]);
    expectIdleCompletionPool();
    expect(process.exitCode || 0).toBe(0);
  });
});
