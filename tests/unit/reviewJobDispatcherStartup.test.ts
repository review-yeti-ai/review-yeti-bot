import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewJobDispatchEngineOptions } from '../../src/k8s/reviewJobDispatchEngine';
import type { ReviewDispatchClaim } from '../../src/review/reviewRun';
import { preparePublishingPolicy, parsePreparedReviewExecution } from '../../src/review/preparedPublishingPolicy';
import { sha256 } from '../../src/review/reviewCore';

const mocks = vi.hoisted(() => ({
  pool: { query: vi.fn() }, initialize: vi.fn(), close: vi.fn(), engine: vi.fn(),
  dispatchRepository: vi.fn(function () { return {}; }),
  completionRepository: vi.fn(function () { return {}; }),
  loop: vi.fn(), error: vi.fn(), loadFromCluster: vi.fn(),
  initTelemetry: vi.fn(), metricsConfig: vi.fn(() => ({ host: '0.0.0.0', port: 9090 })),
  metricsServer: {}, createMetricsServer: vi.fn(), listenMetricsServer: vi.fn(), closeMetricsServer: vi.fn(),
}));
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: class { loadFromCluster = mocks.loadFromCluster; makeApiClient = () => ({}); },
  CustomObjectsApi: class {}, CoreV1Api: class {},
}));
vi.mock('../../src/persistence/postgresStore', () => ({ PostgresStore: class {
  initialize = mocks.initialize; close = mocks.close; getPool = () => mocks.pool;
} }));
vi.mock('../../src/persistence/reviewDispatchRepository', () => ({
  PostgresReviewDispatchRepository: mocks.dispatchRepository,
}));
vi.mock('../../src/persistence/reviewCompletionRepository', () => ({
  PostgresReviewCompletionRepository: mocks.completionRepository,
}));
vi.mock('../../src/k8s/kubernetesReviewJobProjector', () => ({ KubernetesReviewJobProjector: class {} }));
vi.mock('../../src/k8s/reviewJobDispatchEngine', () => ({
  ReviewJobDispatchEngine: vi.fn(function (options) { mocks.engine(options); }),
}));
vi.mock('../../src/k8s/reviewJobDispatcherRuntime', () => ({
  reviewJobDispatcherConfigFromEnv: () => ({ workerId: 'dispatcher-test', namespace: 'ct-review-system',
    workerImage: `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'a'.repeat(64)}`, runnerMode: 'prebaked',
    idleDelayMs: 1_000, activeDelayMs: 50, errorDelayMs: 5_000 }),
  runReviewJobDispatcherLoop: mocks.loop,
}));
vi.mock('../../src/utils/logger', () => ({ logger: { error: mocks.error, info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/telemetry', () => ({ initTelemetry: mocks.initTelemetry }));
vi.mock('../../src/dispatcherMetricsServer', () => ({
  dispatcherMetricsConfigFromEnv: mocks.metricsConfig,
  createDispatcherMetricsServer: mocks.createMetricsServer,
  listenDispatcherMetricsServer: mocks.listenMetricsServer,
  closeDispatcherMetricsServer: mocks.closeMetricsServer,
}));

function fixture() {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1', review_yeti: {
    personas: 'security,testing', budget: { max_investigation_turns: 1 },
  } });
  const prepared = preparePublishingPolicy({ content, source: { repositoryId: 987,
    repository: 'central/policy', sha: 'e'.repeat(40), path: 'policy/review.json',
    contentDigest: createHash('sha256').update(content).digest('hex') } },
  { baseUrl: 'https://gateway.example.invalid/v1', model: 'service-model' });
  const row = {
    effective_policy_digest: prepared.policy.effectivePolicyDigest,
    effective_config_digest: prepared.policy.effectiveConfigDigest,
    version: prepared.version, config: prepared.config, transport: prepared.transport,
    sources: prepared.policy.sources, expected_persona_ids: prepared.expectedPersonaIds,
    prepared_content_digest: sha256({ version: 'PreparedReviewContent.v1', prepared }),
  };
  const claim = { policyDigest: prepared.policy.effectivePolicyDigest,
    configDigest: prepared.policy.effectiveConfigDigest } as ReviewDispatchClaim;
  return { prepared, row, claim };
}

describe('dispatcher preparedReviewFor entrypoint wiring', () => {
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
    vi.resetModules();
    vi.clearAllMocks();
    mocks.initialize.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.createMetricsServer.mockReturnValue(mocks.metricsServer);
    mocks.listenMetricsServer.mockResolvedValue(undefined);
    mocks.closeMetricsServer.mockResolvedValue(undefined);
    mocks.loop.mockResolvedValue(undefined);
    mocks.pool.query.mockReset();
    vi.spyOn(process, 'once').mockReturnValue(process);
    vi.stubEnv('GITHUB_APP_ID', undefined);
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', undefined);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live network'); }));
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    process.exitCode = exitCode;
  });

  async function callback() {
    await import('../../src/reviewJobDispatcherIndex');
    await vi.dynamicImportSettled();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.initTelemetry).toHaveBeenCalledExactlyOnceWith('ct-review-job-dispatcher');
    expect(mocks.metricsConfig).toHaveBeenCalledOnce();
    expect(mocks.createMetricsServer).toHaveBeenCalledOnce();
    expect(mocks.listenMetricsServer).toHaveBeenCalledExactlyOnceWith(
      mocks.metricsServer, { host: '0.0.0.0', port: 9090 },
    );
    expect(mocks.closeMetricsServer).toHaveBeenCalledExactlyOnceWith(mocks.metricsServer);
    expect(mocks.engine).toHaveBeenCalledOnce();
    expect(mocks.dispatchRepository).toHaveBeenCalledExactlyOnceWith(
      mocks.pool, undefined, { lifecycleEvents: 'enabled' },
    );
    expect(mocks.completionRepository).toHaveBeenCalledExactlyOnceWith(
      mocks.pool, { lifecycleEvents: 'enabled' },
    );
    expect(mocks.close).toHaveBeenCalledOnce();
    const options = mocks.engine.mock.calls[0][0] as ReviewJobDispatchEngineOptions;
    expect(options.preparedReviewFor).toEqual(expect.any(Function));
    return options.preparedReviewFor!;
  }

  it('reads by policy digest and returns the exact config/transport envelope verified against config digest', async () => {
    const f = fixture();
    const lookup = await callback();
    expect(f.claim.policyDigest).not.toBe(f.claim.configDigest);
    mocks.pool.query.mockResolvedValue({ rows: [f.row] });
    const json = await lookup(f.claim);
    expect(mocks.pool.query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('FROM prepared_review_policies'),
      [f.claim.policyDigest]);
    expect(JSON.parse(json)).toEqual({ version: 'PreparedReviewExecution.v1',
      config: f.prepared.config, transport: f.prepared.transport });
    expect(parsePreparedReviewExecution(json, f.claim.configDigest)).toEqual(JSON.parse(json));
  });

  it('rejects a missing stored policy', async () => {
    const lookup = await callback();
    mocks.pool.query.mockResolvedValue({ rows: [] });
    await expect(lookup(fixture().claim)).rejects.toThrow('Admitted prepared review policy is unavailable');
  });

  it('rejects a claim whose config digest differs from the valid stored policy', async () => {
    const f = fixture(); const lookup = await callback();
    mocks.pool.query.mockResolvedValue({ rows: [f.row] });
    await expect(lookup({ ...f.claim, configDigest: 'f'.repeat(64) }))
      .rejects.toThrow('Admitted prepared review policy is unavailable');
  });

  it('propagates a redacted storage failure without serializing an envelope', async () => {
    const lookup = await callback();
    mocks.pool.query.mockRejectedValue(new Error('synthetic-sensitive-storage-marker'));
    await expect(lookup(fixture().claim)).rejects.toThrow('Prepared review policy is invalid or unavailable');
  });

  it('rejects a corrupt stored config before projecting it', async () => {
    const f = fixture(); const lookup = await callback();
    f.row.config = { ...f.row.config, reviewers: { ...f.row.config.reviewers, providers: [] } };
    mocks.pool.query.mockResolvedValue({ rows: [f.row] });
    await expect(lookup(f.claim)).rejects.toThrow('Prepared review policy is invalid or unavailable');
  });

  it('closes storage when the metrics listener cannot bind', async () => {
    mocks.listenMetricsServer.mockRejectedValueOnce(new Error('synthetic-sensitive-bind-error'));
    await import('../../src/reviewJobDispatcherIndex');
    await vi.dynamicImportSettled();
    expect(mocks.loop).not.toHaveBeenCalled();
    expect(mocks.closeMetricsServer).toHaveBeenCalledExactlyOnceWith(mocks.metricsServer);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.error).toHaveBeenCalledWith('Review Yeti review job dispatcher failed to start');
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('synthetic-sensitive-bind-error');
  });
});
