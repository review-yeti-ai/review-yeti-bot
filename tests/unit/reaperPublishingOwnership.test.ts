import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  credentials: undefined as Record<string, unknown> | undefined,
  reaperOptions: undefined as Record<string, any> | undefined,
  events: [] as string[],
  identity: vi.fn(async () => ({ id: 4385771 })),
  mint: vi.fn(async () => ({ token: 'ghs_offline' })),
  close: vi.fn(async () => {}),
}));
vi.mock('@kubernetes/client-node', () => ({ CustomObjectsApi: class {}, CoreV1Api: class {}, KubeConfig: class {
  loadFromCluster() {} makeApiClient() { return {}; }
} }));
vi.mock('../../src/github/appAuth', () => ({ getGitHubAppIdentity: state.identity, getGitHubAppRepositoryPublishToken: state.mint }));
vi.mock('../../src/persistence/postgresStore', () => ({ PostgresStore: class {
  async initialize() {} getPool() { return {}; } close = state.close;
} }));
vi.mock('../../src/k8s/kubernetesRunSecretProvisioner', () => ({ KubernetesRunSecretProvisioner: class {
  constructor(options: Record<string, unknown>) { state.credentials = options; }
} }));
vi.mock('../../src/k8s/reviewJobDispatchEngine', () => ({ ReviewJobDispatchEngine: class {
  async runOnce() { state.events.push('dispatch'); return { status: 'idle' }; }
} }));
vi.mock('../../src/review/abandonedRunReaper', () => ({ AbandonedRunReaper: class {
  constructor(options: Record<string, any>) { state.reaperOptions = options; }
  async runOnce(signal: AbortSignal) {
    state.events.push('reconcile');
    await state.reaperOptions!.checkClientFor({ owner: 'calltelemetry', repo: 'ct-release' }, signal);
  }
} }));
vi.mock('../../src/k8s/reviewJobDispatcherRuntime', async (original) => ({
  ...await original<typeof import('../../src/k8s/reviewJobDispatcherRuntime')>(),
  runReviewJobDispatcherLoop: async (engine: { runOnce(): Promise<unknown> }) => { await engine.runOnce(); },
}));

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; });

describe('dispatcher publishing ownership composition', () => {
  it('uses the same authenticated App for worker secrets and reaping, and awaits reaping before dispatch/DB close', async () => {
    vi.stubEnv('REVIEW_JOB_DISPATCH_ENABLED', 'true');
    vi.stubEnv('REVIEW_JOB_NAMESPACE', 'ct-review-system');
    vi.stubEnv('REVIEW_JOB_WORKER_IMAGE', `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'a'.repeat(64)}`);
    vi.stubEnv('HOSTNAME', 'offline-dispatcher');
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'offline-key');
    // Do not install real process signal handlers from a service entrypoint.
    vi.spyOn(process, 'once').mockReturnValue(process);
    state.close.mockImplementation(async () => { state.events.push('close'); });
    await import('../../src/reviewJobDispatcherIndex');
    await vi.waitFor(() => expect(state.close).toHaveBeenCalled());
    expect(state.identity).toHaveBeenCalledWith({ appId: '4385771', privateKey: 'offline-key' });
    expect(state.credentials).toMatchObject({ appId: '4385771', privateKey: 'offline-key' });
    expect(state.reaperOptions).toMatchObject({ publisherAppId: 4385771, limit: 1 });
    expect(state.mint).toHaveBeenCalledWith({ appId: '4385771', privateKey: 'offline-key',
      owner: 'calltelemetry', repo: 'ct-release', signal: expect.any(AbortSignal) });
    expect(state.events).toEqual(['reconcile', 'dispatch', 'close']);
  });
});
