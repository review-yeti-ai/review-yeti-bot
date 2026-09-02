import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(),
  writeFile: vi.fn(async () => undefined),
}));
const executionMocks = vi.hoisted(() => ({
  executePersonaPanel: vi.fn(),
  getGitHubAppInstallationToken: vi.fn(),
}));

vi.mock('node:fs/promises', () => fsMocks);
vi.mock('../../src/panel/panelEngine', () => ({ executePersonaPanel: executionMocks.executePersonaPanel }));
vi.mock('../../src/github/appAuth', () => ({ getGitHubAppInstallationToken: executionMocks.getGitHubAppInstallationToken }));

import {
  buildReceiptOnlyWorkerReceipt,
  isReceiptOnlyWorker,
  runWorker,
  runReceiptOnlyWorker,
  runWorkerSelfTest,
  isProviderQualificationWorker,
  runProviderQualificationWorker,
  isPanelQualificationWorker,
  runPanelQualificationWorker,
  isFullPanelQualificationWorker,
  runFullPanelQualificationWorker,
  isSameHeadQualificationWorker,
  runSameHeadQualificationWorker,
} from '../../src/cli/runLiveReview';
import { compareQualificationReceipts } from '../../src/qualification/receiptComparison';

const receiptPathLiteral = '/workspace/.review-yeti/receipt.json';

const validEnvironment = {
  REVIEW_RECEIPT_ONLY: 'true',
  REVIEW_PUBLICATION_MODE: 'disabled',
  REVIEW_RECEIPT_PATH: receiptPathLiteral,
  REVIEW_RUN_ID: 'run_11111111111111111111111111111111',
  REVIEW_DELIVERY_ID: 'actions:98765:2:123:42:head',
  REVIEW_REPOSITORY_ID: '123',
  REVIEW_REPO: 'calltelemetry/cisco-cdr',
  REVIEW_PR_NUMBER: '42',
  REVIEW_HEAD_SHA: 'a'.repeat(40),
  REVIEW_BASE_SHA: 'b'.repeat(40),
  REVIEW_POLICY_DIGEST: 'c'.repeat(64),
  REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
} as NodeJS.ProcessEnv;

describe('receipt-only worker contract', () => {
  beforeEach(() => {
    fsMocks.mkdir.mockClear();
    fsMocks.readFile.mockReset();
    fsMocks.writeFile.mockClear();
    executionMocks.executePersonaPanel.mockClear();
    executionMocks.getGitHubAppInstallationToken.mockClear();
  });

  it('recognizes only the explicit receipt-only mode', () => {
    expect(isReceiptOnlyWorker(validEnvironment)).toBe(true);
    expect(isReceiptOnlyWorker({ ...validEnvironment, REVIEW_RECEIPT_ONLY: 'false' })).toBe(false);
    expect(isReceiptOnlyWorker({ ...validEnvironment, REVIEW_RECEIPT_ONLY: 'TRUE' })).toBe(false);
  });

  it('builds a non-secret receipt without requiring GitHub or provider credentials', () => {
    const receipt = buildReceiptOnlyWorkerReceipt(
      validEnvironment,
      '2026-08-31T13:00:00.000Z',
      '2026-08-31T13:00:00.250Z',
    );
    expect(receipt).toEqual({
      version: 'ReviewYetiReceiptOnly.v1',
      status: 'succeeded',
      runId: validEnvironment.REVIEW_RUN_ID,
      deliveryId: validEnvironment.REVIEW_DELIVERY_ID,
      repositoryId: 123,
      repo: validEnvironment.REVIEW_REPO,
      prNumber: 42,
      headSha: validEnvironment.REVIEW_HEAD_SHA,
      baseSha: validEnvironment.REVIEW_BASE_SHA,
      policyDigest: validEnvironment.REVIEW_POLICY_DIGEST,
      configDigest: validEnvironment.REVIEW_CONFIG_DIGEST,
      publicationMode: 'disabled',
      providerCalls: 0,
      githubWrites: 0,
      startedAt: '2026-08-31T13:00:00.000Z',
      completedAt: '2026-08-31T13:00:00.250Z',
    });
    const serialized = JSON.stringify(receipt).toLowerCase();
    for (const forbidden of ['secret', 'token', 'api_key', 'private_key', 'openrouter']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('persists the receipt at the exact workspace path', async () => {
    const receipt = await runReceiptOnlyWorker(validEnvironment);
    expect(fsMocks.mkdir).toHaveBeenCalledWith('/workspace/.review-yeti', { recursive: true });
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      receiptPathLiteral,
      `${JSON.stringify(receipt)}\n`,
      { encoding: 'utf8' },
    );
  });

  it('routes the worker entrypoint to receipt-only execution before provider or GitHub work', async () => {
    await runWorker(validEnvironment);
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      receiptPathLiteral,
      expect.any(String),
      { encoding: 'utf8' },
    );
    expect(executionMocks.executePersonaPanel).not.toHaveBeenCalled();
    expect(executionMocks.getGitHubAppInstallationToken).not.toHaveBeenCalled();
  });

  it('routes normal mode to live execution without writing a receipt', async () => {
    const liveRunner = vi.fn(async () => undefined);
    const environment = { ...validEnvironment, REVIEW_RECEIPT_ONLY: 'false' };

    await runWorker(environment, liveRunner);

    expect(liveRunner).toHaveBeenCalledOnce();
    expect(liveRunner).toHaveBeenCalledWith(environment);
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });

  it('self-tests the staged runtime manifest without network credentials', async () => {
    const manifest = Buffer.from(JSON.stringify({
      version: 'ReviewYetiWorkerRuntime.v1',
      entrypoint: 'dist/cli/runLiveReview.js',
      files: [],
    }));
    fsMocks.readFile.mockResolvedValue(manifest);

    const moduleLoader = vi.fn();
    const result = await runWorkerSelfTest(
      { REVIEW_RUNTIME_MANIFEST_PATH: '/tmp/runtime-manifest.json' },
      moduleLoader,
    );

    expect(fsMocks.readFile).toHaveBeenCalledWith('/tmp/runtime-manifest.json');
    expect(moduleLoader).toHaveBeenCalledTimes(7);
    expect(new Set(moduleLoader.mock.calls.flat())).toEqual(new Set([
      '../gateway/openRouterClient',
      '../panel/panelEngine',
      '../github/qualificationReader',
      '../github/publicationReceipt',
      '../k8s/reviewJobProjection',
      '../k8s/reviewJobDispatchEngine',
      'node:child_process',
    ]));
    expect(result.ok).toBe(true);
    expect(result.runtimeManifestDigest).toBe(createHash('sha256').update(manifest).digest('hex'));
    expect(result.loadedModuleIds).toContain('../gateway/openRouterClient');
  });

  it('fails closed when the runtime manifest is missing, malformed, or wrong-versioned', async () => {
    fsMocks.readFile.mockRejectedValue(new Error('ENOENT'));
    await expect(runWorkerSelfTest({ REVIEW_RUNTIME_MANIFEST_PATH: '/tmp/runtime-manifest.json' }))
      .rejects.toThrow('worker runtime manifest is missing');

    fsMocks.readFile.mockResolvedValueOnce(Buffer.from('{not-json'));
    await expect(runWorkerSelfTest({ REVIEW_RUNTIME_MANIFEST_PATH: '/tmp/runtime-manifest.json' }))
      .rejects.toThrow('worker runtime manifest is invalid');

    fsMocks.readFile.mockResolvedValueOnce(Buffer.from(JSON.stringify({
      version: 'ReviewYetiWorkerRuntime.v0',
      entrypoint: 'dist/cli/runLiveReview.js',
    })));
    await expect(runWorkerSelfTest({ REVIEW_RUNTIME_MANIFEST_PATH: '/tmp/runtime-manifest.json' }))
      .rejects.toThrow('worker runtime manifest is invalid');
  });

  it('propagates an admitted-module load failure from the self-test', async () => {
    fsMocks.readFile.mockResolvedValue(Buffer.from(JSON.stringify({
      version: 'ReviewYetiWorkerRuntime.v1',
      entrypoint: 'dist/cli/runLiveReview.js',
      files: [],
    })));
    const moduleLoader = vi.fn((moduleId: string) => {
      if (moduleId === '../panel/panelEngine') throw new Error('module unavailable');
      return undefined;
    });

    await expect(runWorkerSelfTest(
      { REVIEW_RUNTIME_MANIFEST_PATH: '/tmp/runtime-manifest.json' },
      moduleLoader,
    )).rejects.toThrow('module unavailable');
  });

  it.each([
    ['receipt-only mode is unset', { REVIEW_RECEIPT_ONLY: undefined }],
    ['receipt-only mode is missing', { REVIEW_RECEIPT_ONLY: 'false' }],
    ['publication is enabled', { REVIEW_PUBLICATION_MODE: 'enabled' }],
    ['receipt path is outside the workspace', { REVIEW_RECEIPT_PATH: '/tmp/receipt.json' }],
    ['run ID is malformed', { REVIEW_RUN_ID: 'not-a-run-id' }],
    ['delivery ID is empty', { REVIEW_DELIVERY_ID: '' }],
    ['delivery ID is too long', { REVIEW_DELIVERY_ID: 'x'.repeat(513) }],
    ['repository ID is zero', { REVIEW_REPOSITORY_ID: '0' }],
    ['repository ID is not an integer', { REVIEW_REPOSITORY_ID: '1.5' }],
    ['repository is malformed', { REVIEW_REPO: 'calltelemetry' }],
    ['pull request number is zero', { REVIEW_PR_NUMBER: '0' }],
    ['pull request number is not an integer', { REVIEW_PR_NUMBER: '1.5' }],
    ['head SHA is malformed', { REVIEW_HEAD_SHA: 'A'.repeat(40) }],
    ['base SHA is malformed', { REVIEW_BASE_SHA: 'B'.repeat(40) }],
    ['policy digest is malformed', { REVIEW_POLICY_DIGEST: 'C'.repeat(64) }],
    ['config digest is malformed', { REVIEW_CONFIG_DIGEST: 'D'.repeat(64) }],
    ['started timestamp is invalid', {}],
    ['completed timestamp is invalid', {}],
    ['timestamps are reversed', {}],
  ])('rejects %s', (_reason, override) => {
    const environment = { ...validEnvironment, ...override };
    const startedAt = '2026-08-31T13:00:00.000Z';
    const effectiveStartedAt = _reason === 'started timestamp is invalid' ? 'not-a-time' : startedAt;
    const completedAt = _reason === 'timestamps are reversed'
      ? '2026-08-31T12:59:59.999Z'
      : _reason === 'completed timestamp is invalid'
        ? 'not-a-time'
        : '2026-08-31T13:00:00.250Z';
    expect(() => buildReceiptOnlyWorkerReceipt(environment, effectiveStartedAt, completedAt)).toThrow(/receipt-only worker contract/i);
  });
});

describe('provider qualification worker contract', () => {
  const providerEnvironment = {
    REVIEW_PROVIDER_QUALIFICATION_ONLY: 'true',
    REVIEW_RECEIPT_ONLY: 'false',
    REVIEW_PUBLICATION_MODE: 'disabled',
    REVIEW_RECEIPT_PATH: receiptPathLiteral,
    REVIEW_RUN_ID: 'run_22222222222222222222222222222222',
    REVIEW_DELIVERY_ID: 'qualification:provider:1',
    REVIEW_REPOSITORY_ID: '123',
    REVIEW_REPO: 'calltelemetry/cisco-cdr',
    REVIEW_PR_NUMBER: '42',
    REVIEW_HEAD_SHA: 'a'.repeat(40),
    REVIEW_BASE_SHA: 'b'.repeat(40),
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_QUALIFICATION_MODEL: 'deepseek/deepseek-v4-flash-0731',
    REVIEW_QUALIFICATION_TIMEOUT_MS: '120000',
    OPENROUTER_API_KEY: 'test-openrouter-key',
  } as NodeJS.ProcessEnv;

  it('requires an explicit provider qualification mode and never treats receipt-only as provider mode', () => {
    expect(isProviderQualificationWorker(providerEnvironment)).toBe(true);
    expect(isProviderQualificationWorker({ ...providerEnvironment, REVIEW_PROVIDER_QUALIFICATION_ONLY: 'false' })).toBe(false);
    expect(isProviderQualificationWorker({ ...providerEnvironment, REVIEW_RECEIPT_ONLY: 'true' })).toBe(false);
    expect(isProviderQualificationWorker({ ...providerEnvironment, REVIEW_PUBLICATION_MODE: 'enabled' })).toBe(false);
  });

  it('calls the injected provider once and persists only bounded telemetry with publication disabled', async () => {
    const client = {
      complete: vi.fn(async () => ({
        model: 'deepseek/deepseek-v4-flash-0731',
        content: 'QUALIFICATION_OK',
        usage: { prompt: 31, completion: 7, total: 38 },
        costUSD: 0.000123,
        raw: { secret: 'must not be persisted' },
      })),
    };

    const receipt = await runProviderQualificationWorker(providerEnvironment, client);

    expect(client.complete).toHaveBeenCalledOnce();
    expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({
      model: providerEnvironment.REVIEW_QUALIFICATION_MODEL,
      stream: true,
      maxTokens: 256,
      timeoutMs: 120000,
    }));
    expect(receipt).toMatchObject({
      version: 'ReviewYetiProviderQualification.v1',
      status: 'succeeded',
      providerId: 'openrouter',
      requestedModel: providerEnvironment.REVIEW_QUALIFICATION_MODEL,
      resolvedModel: 'deepseek/deepseek-v4-flash-0731',
      publicationMode: 'disabled',
      providerCalls: 1,
      githubWrites: 0,
      usage: { prompt: 31, completion: 7, total: 38 },
      costUSD: 0.000123,
    });
    expect(receipt.responseDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain('must not be persisted');
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      receiptPathLiteral,
      `${JSON.stringify(receipt)}\n`,
      { encoding: 'utf8' },
    );
  });

  it('routes provider qualification before live execution and keeps receipt-only routing unchanged', async () => {
    const providerRunner = vi.fn(async () => undefined);
    const liveRunner = vi.fn(async () => undefined);

    await runWorker(providerEnvironment, liveRunner, providerRunner);

    expect(providerRunner).toHaveBeenCalledWith(providerEnvironment);
    expect(liveRunner).not.toHaveBeenCalled();
    expect(executionMocks.executePersonaPanel).not.toHaveBeenCalled();
    expect(executionMocks.getGitHubAppInstallationToken).not.toHaveBeenCalled();
  });

  it('fails closed instead of falling through to live execution for an invalid qualification mode', async () => {
    const liveRunner = vi.fn(async () => undefined);

    await expect(runWorker(
      { ...providerEnvironment, REVIEW_PUBLICATION_MODE: 'enabled' },
      liveRunner,
    )).rejects.toThrow(/provider qualification worker contract/i);
    expect(liveRunner).not.toHaveBeenCalled();
  });
});

describe('panel qualification worker contract', () => {
  const panelEnvironment = {
    REVIEW_PANEL_QUALIFICATION_ONLY: 'true',
    REVIEW_PROVIDER_QUALIFICATION_ONLY: 'false',
    REVIEW_RECEIPT_ONLY: 'false',
    REVIEW_PUBLICATION_MODE: 'disabled',
    REVIEW_RECEIPT_PATH: receiptPathLiteral,
    REVIEW_RUN_ID: 'run_77777777777777777777777777777777',
    REVIEW_DELIVERY_ID: 'qualification:panel:1',
    REVIEW_REPOSITORY_ID: '123',
    REVIEW_REPO: 'calltelemetry/cisco-cdr',
    REVIEW_PR_NUMBER: '42',
    REVIEW_HEAD_SHA: 'a'.repeat(40),
    REVIEW_BASE_SHA: 'b'.repeat(40),
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_QUALIFICATION_MODEL: 'deepseek/deepseek-v4-flash-0731',
    REVIEW_QUALIFICATION_TIMEOUT_MS: '120000',
    OPENROUTER_API_KEY: 'test-openrouter-key',
  } as NodeJS.ProcessEnv;

  it('requires an explicit panel mode and excludes the provider-only mode', () => {
    expect(isPanelQualificationWorker(panelEnvironment)).toBe(true);
    expect(isPanelQualificationWorker({ ...panelEnvironment, REVIEW_PANEL_QUALIFICATION_ONLY: 'false' })).toBe(false);
    expect(isPanelQualificationWorker({ ...panelEnvironment, REVIEW_PROVIDER_QUALIFICATION_ONLY: 'true' })).toBe(false);
    expect(isPanelQualificationWorker({ ...panelEnvironment, REVIEW_RECEIPT_ONLY: 'true' })).toBe(false);
    expect(isPanelQualificationWorker({ ...panelEnvironment, REVIEW_PUBLICATION_MODE: 'enabled' })).toBe(false);
  });

  it('runs the injected panel once and persists only aggregate non-publishing telemetry', async () => {
    const client = {
      complete: vi.fn(async () => ({
        model: panelEnvironment.REVIEW_QUALIFICATION_MODEL,
        content: 'qualification response',
        usage: null,
        costUSD: null,
        raw: {},
      })),
    };
    const panelRunner = vi.fn(async (options: any) => {
      expect(options.config.quorum).toBe(1);
      expect(options.config.reviewers.fallback).toBe('none');
      expect(options.config.reviewers.providers).toHaveLength(1);
      expect(options.config.reviewers.providers[0].model).toBe(panelEnvironment.REVIEW_QUALIFICATION_MODEL);
      expect(options.config.reviewers.arbiter.order).toEqual(['qualification']);
      expect(options.config.personas[0].maxTurns).toBe(2);
      expect(options.changedFiles).toEqual([
        expect.objectContaining({ path: 'qualification-fixture.ts' }),
      ]);
      for (let call = 0; call < 3; call += 1) {
        await options.client.complete({
          model: panelEnvironment.REVIEW_QUALIFICATION_MODEL,
          messages: [],
          timeoutMs: 1000,
          stream: true,
        });
      }
      return {
        headSha: panelEnvironment.REVIEW_HEAD_SHA,
        personas: [{
          id: 'qualification-lane', required: true, providerId: 'qualification',
          model: panelEnvironment.REVIEW_QUALIFICATION_MODEL, decision: 'APPROVE', findings: [],
          usage: { prompt: 100, completion: 20, total: 120 }, costUSD: 0.001, durationMs: 250,
        }],
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['qualification'], satisfied: true },
        moderator: {
          providerId: 'qualification', model: panelEnvironment.REVIEW_QUALIFICATION_MODEL,
          decision: 'RECONCILED', findings: [], usage: { prompt: 50, completion: 10, total: 60 },
          costUSD: 0.0005, durationMs: 150,
        },
        arbiter: {
          providerId: 'qualification', model: panelEnvironment.REVIEW_QUALIFICATION_MODEL,
          verdict: 'SHIP', rationale: 'fixture is safe', usage: { prompt: 40, completion: 8, total: 48 },
          costUSD: 0.0004, durationMs: 120,
        },
      };
    });

    const receipt = await runPanelQualificationWorker(panelEnvironment, panelRunner, client);

    expect(panelRunner).toHaveBeenCalledOnce();
    expect(client.complete).toHaveBeenCalledTimes(3);
    expect(receipt).toMatchObject({
      version: 'ReviewYetiPanelQualification.v1',
      status: 'succeeded',
      providerId: 'openrouter',
      requestedModel: panelEnvironment.REVIEW_QUALIFICATION_MODEL,
      resolvedModel: panelEnvironment.REVIEW_QUALIFICATION_MODEL,
      publicationMode: 'disabled',
      providerCalls: 3,
      githubWrites: 0,
      personaCount: 1,
      findingsCount: 0,
      verdict: 'SHIP',
      usage: { prompt: 190, completion: 38, total: 228 },
      costUSD: 0.0019,
    });
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
    expect(receipt.resultDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain('fixture is safe');
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      receiptPathLiteral,
      `${JSON.stringify(receipt)}\n`,
      { encoding: 'utf8' },
    );
  });

  it('routes panel qualification before provider or live execution', async () => {
    const panelRunner = vi.fn(async () => undefined);
    const providerRunner = vi.fn(async () => undefined);
    const liveRunner = vi.fn(async () => undefined);

    await runWorker(panelEnvironment, liveRunner, providerRunner, panelRunner);

    expect(panelRunner).toHaveBeenCalledWith(panelEnvironment);
    expect(providerRunner).not.toHaveBeenCalled();
    expect(liveRunner).not.toHaveBeenCalled();
  });
});

describe('full-panel qualification worker contract', () => {
  const fullPanelEnvironment = {
    REVIEW_FULL_PANEL_QUALIFICATION_ONLY: 'true',
    REVIEW_PANEL_QUALIFICATION_ONLY: 'false',
    REVIEW_PROVIDER_QUALIFICATION_ONLY: 'false',
    REVIEW_RECEIPT_ONLY: 'false',
    REVIEW_PUBLICATION_MODE: 'disabled',
    REVIEW_RECEIPT_PATH: receiptPathLiteral,
    REVIEW_RUN_ID: 'run_88888888888888888888888888888888',
    REVIEW_DELIVERY_ID: 'qualification:full-panel:1',
    REVIEW_REPOSITORY_ID: '123',
    REVIEW_REPO: 'calltelemetry/cisco-cdr',
    REVIEW_PR_NUMBER: '42',
    REVIEW_HEAD_SHA: 'a'.repeat(40),
    REVIEW_BASE_SHA: 'b'.repeat(40),
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_ENGINE_REVISION: 'e'.repeat(64),
    REVIEW_QUALIFICATION_MODEL: 'deepseek/deepseek-v4-flash-0731',
    REVIEW_QUALIFICATION_TIMEOUT_MS: '600000',
    OPENROUTER_API_KEY: 'test-openrouter-key',
  } as NodeJS.ProcessEnv;

  it('requires an explicit full-panel mode and excludes every other worker mode', () => {
    expect(isFullPanelQualificationWorker(fullPanelEnvironment)).toBe(true);
    expect(isFullPanelQualificationWorker({ ...fullPanelEnvironment, REVIEW_FULL_PANEL_QUALIFICATION_ONLY: 'false' })).toBe(false);
    expect(isFullPanelQualificationWorker({ ...fullPanelEnvironment, REVIEW_PANEL_QUALIFICATION_ONLY: 'true' })).toBe(false);
    expect(isFullPanelQualificationWorker({ ...fullPanelEnvironment, REVIEW_PROVIDER_QUALIFICATION_ONLY: 'true' })).toBe(false);
    expect(isFullPanelQualificationWorker({ ...fullPanelEnvironment, REVIEW_RECEIPT_ONLY: 'true' })).toBe(false);
    expect(isFullPanelQualificationWorker({ ...fullPanelEnvironment, REVIEW_PUBLICATION_MODE: 'enabled' })).toBe(false);
  });

  it('executes six scoped personas plus moderator and arbiter on a representative fixture', async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const client = {
      complete: vi.fn(async () => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeCalls -= 1;
        return {
          model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
          content: 'qualification response',
          usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001,
          raw: {},
        };
      }),
    };
    const panelRunner = vi.fn(async (options: any) => {
      expect(options.config.personas).toHaveLength(6);
      expect(options.config.personas.map((persona: any) => persona.id)).toEqual([
        'security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing',
      ]);
      expect(options.config.personas.map((persona: any) => persona.charter)).toEqual([
        'builtin:security', 'builtin:performance', 'builtin:constitutional-goals',
        'builtin:correctness', 'builtin:contract', 'builtin:docs',
      ]);
      expect(options.config.personas.every((persona: any) => persona.required)).toBe(true);
      expect(options.config.personas.every((persona: any) => persona.maxTurns === 3)).toBe(true);
      expect(options.config.reviewers.providers).toHaveLength(1);
      expect(options.config.reviewers.providers[0].id).toBe('openrouter');
      expect(options.config.reviewers.providers[0].model).toBe(fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL);
      expect(options.config.reviewers.providers[0].effort).toBe('low');
      expect(options.config.reviewers.arbiter.order).toEqual(['openrouter']);
      expect(options.requestPolicy).toEqual({
        stream: true,
        ttftTimeoutMs: 30_000,
        maxTokens: 24_576,
        models: ['z-ai/glm-5.3-flash'],
        responseFormat: { type: 'json_object' },
        provider: {
          allow_fallbacks: true,
          require_parameters: true,
          ignore: ['morph', 'fireworks'],
          sort: 'throughput',
          preferred_min_throughput: { p90: 40 },
          preferred_max_latency: { p99: 3 },
          data_collection: 'deny',
        },
        metadata: {
          qualificationMode: 'full-panel',
          runId: fullPanelEnvironment.REVIEW_RUN_ID,
          providerId: 'openrouter',
        },
      });
      expect(options.changedFiles.map((file: any) => file.path)).toEqual(expect.arrayContaining([
        'src/auth/session.ts', 'src/dispatcher/worker.ts', 'Dockerfile', 'k8s/review-job.yaml',
        'package.json', 'LICENSE',
      ]));
      await Promise.all([
        'security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing',
        'moderator', 'arbiter',
      ].map((persona) => options.client.complete({
        model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
        messages: [],
        stream: true,
        persona,
        providerId: 'openrouter',
      })));
      const personaResult = (id: string) => ({
        id, required: true, providerId: 'qualification', model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
        decision: 'APPROVE' as const, findings: [], usage: { prompt: 100, completion: 20, total: 120 },
        costUSD: 0.001, durationMs: 250,
      });
      return {
        headSha: fullPanelEnvironment.REVIEW_HEAD_SHA,
        personas: ['security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing'].map(personaResult),
        optionalFailures: [],
        quorum: { required: 1, distinctProviders: ['qualification'], satisfied: true },
        moderator: {
          providerId: 'qualification', model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
          decision: 'RECONCILED' as const, findings: [], usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001, durationMs: 150,
        },
        arbiter: {
          providerId: 'qualification', model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
          verdict: 'SHIP' as const, rationale: 'qualification completed', usage: { prompt: 100, completion: 20, total: 120 },
          costUSD: 0.001, durationMs: 120,
        },
      };
    });

    const receipt = await runFullPanelQualificationWorker(fullPanelEnvironment, panelRunner, client);

    expect(panelRunner).toHaveBeenCalledOnce();
    expect(client.complete).toHaveBeenCalledTimes(8);
    expect(maxActiveCalls).toBeLessThanOrEqual(3);
    expect(receipt).toMatchObject({
      version: 'ReviewYetiPanelQualification.v1',
      profile: 'full-panel',
      status: 'succeeded',
      engineRevision: 'e'.repeat(64),
      providerTopologyDigest: '583bc1bd38ba0e1d83f0193648c6cad68359d563e77b312d828fe98b20f84f1a',
      providerId: 'openrouter',
      requestedModel: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
      publicationMode: 'disabled',
      providerCalls: 8,
      githubWrites: 0,
      personaCount: 6,
      expectedPersonaCount: 6,
      optionalFailureCount: 0,
      findingsCount: 0,
      verdict: 'SHIP',
    });
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      receiptPathLiteral,
      `${JSON.stringify(receipt)}\n`,
      { encoding: 'utf8' },
    );
  });

  it('retains the GLM fallback for an alternate non-GLM primary model', async () => {
    const alternateEnvironment = {
      ...fullPanelEnvironment,
      REVIEW_QUALIFICATION_MODEL: '~deepseek/deepseek-v4-flash-latest',
    };
    const panelRunner = vi.fn(async (options: any) => {
      expect(options.requestPolicy.models).toEqual(['z-ai/glm-5.3-flash']);
      throw new Error('stop after request-policy assertion');
    });

    await expect(runFullPanelQualificationWorker(
      alternateEnvironment,
      panelRunner,
      { complete: vi.fn() } as any,
    )).rejects.toThrow('stop after request-policy assertion');
  });

  it('persists a sanitized partial receipt when the full panel fails closed', async () => {
    const client = {
      complete: vi.fn(async () => ({
        model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
        content: 'partial qualification response',
        usage: { prompt: 17, completion: 3, total: 20 },
        costUSD: 0.0001,
        raw: { secret: 'must never be persisted' },
      })),
    };
    const panelRunner = vi.fn(async (options: any) => {
      await options.client.complete({
        model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
        messages: [],
        timeoutMs: 1000,
        persona: 'licensing',
      });
      throw new Error('Bearer support-secret invalid JSON inside nonce fence');
    });

    await expect(runFullPanelQualificationWorker(fullPanelEnvironment, panelRunner, client))
      .rejects.toThrow('invalid JSON inside nonce fence');

    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
    const persisted = JSON.parse(String(fsMocks.writeFile.mock.calls[0][1]));
    expect(persisted).toMatchObject({
      version: 'ReviewYetiPanelQualification.v1',
      profile: 'full-panel',
      status: 'failed',
      providerId: 'openrouter',
      requestedModel: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
      publicationMode: 'disabled',
      providerCalls: 1,
      githubWrites: 0,
      failureClass: 'structured_output',
      expectedPersonaCount: 6,
    });
    expect(persisted.attempts).toEqual([expect.objectContaining({
      attempt: 1,
      persona: 'licensing',
      outcome: 'completed',
      requestedModel: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
      resolvedModel: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
      usage: { prompt: 17, completion: 3, total: 20 },
      costUSD: 0.0001,
    })]);
    expect(JSON.stringify(persisted)).not.toContain('support-secret');
    expect(JSON.stringify(persisted)).not.toContain('must never be persisted');
  });

  it('persists a failed receipt when a completed panel misses the acceptance gate', async () => {
    const panelRunner = vi.fn(async () => ({
      headSha: fullPanelEnvironment.REVIEW_HEAD_SHA,
      personas: [],
      optionalFailures: [{ id: 'licensing', error: 'private response detail' }],
      quorum: { required: 1, distinctProviders: [], satisfied: false },
      moderator: {
        providerId: 'qualification', model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
        decision: 'RECONCILED' as const, findings: [], usage: null, costUSD: null, durationMs: 0,
      },
      arbiter: {
        providerId: 'qualification', model: fullPanelEnvironment.REVIEW_QUALIFICATION_MODEL,
        verdict: 'BLOCK' as const, rationale: 'not persisted', usage: null, costUSD: null, durationMs: 0,
      },
    }));

    await expect(runFullPanelQualificationWorker(fullPanelEnvironment, panelRunner, {
      complete: vi.fn(),
    } as any)).rejects.toThrow(/full-panel qualification worker contract/i);

    expect(fsMocks.writeFile).toHaveBeenCalledOnce();
    const persisted = JSON.parse(String(fsMocks.writeFile.mock.calls[0][1]));
    expect(persisted).toMatchObject({ status: 'failed', failureClass: 'panel_failure', providerCalls: 0 });
    expect(JSON.stringify(persisted)).not.toContain('private response detail');
    expect(JSON.stringify(persisted)).not.toContain('not persisted');
  });

  it('routes full-panel qualification before the existing panel and live modes', async () => {
    const fullPanelRunner = vi.fn(async () => undefined);
    const panelRunner = vi.fn(async () => undefined);
    const providerRunner = vi.fn(async () => undefined);
    const liveRunner = vi.fn(async () => undefined);

    await runWorker(fullPanelEnvironment, liveRunner, providerRunner, panelRunner, fullPanelRunner);

    expect(fullPanelRunner).toHaveBeenCalledWith(fullPanelEnvironment);
    expect(panelRunner).not.toHaveBeenCalled();
    expect(providerRunner).not.toHaveBeenCalled();
    expect(liveRunner).not.toHaveBeenCalled();
  });
});

describe('same-head qualification worker contract', () => {
  const sameHeadEnvironment = {
    REVIEW_SAME_HEAD_QUALIFICATION_ONLY: 'true',
    REVIEW_FULL_PANEL_QUALIFICATION_ONLY: 'false',
    REVIEW_PANEL_QUALIFICATION_ONLY: 'false',
    REVIEW_PROVIDER_QUALIFICATION_ONLY: 'false',
    REVIEW_RECEIPT_ONLY: 'false',
    REVIEW_PUBLICATION_MODE: 'disabled',
    REVIEW_RECEIPT_PATH: receiptPathLiteral,
    REVIEW_RUN_ID: 'run_99999999999999999999999999999999',
    REVIEW_DELIVERY_ID: 'qualification:same-head:1',
    REVIEW_REPOSITORY_ID: '123',
    REVIEW_REPO: 'calltelemetry/ct-pr-operator-sandbox',
    REVIEW_PR_NUMBER: '42',
    REVIEW_HEAD_SHA: 'a'.repeat(40),
    REVIEW_BASE_SHA: 'b'.repeat(40),
    REVIEW_POLICY_DIGEST: 'c'.repeat(64),
    REVIEW_CONFIG_DIGEST: 'd'.repeat(64),
    REVIEW_ENGINE_REVISION: 'e'.repeat(64),
    REVIEW_QUALIFICATION_MODEL: 'deepseek/deepseek-v4-flash-0731',
    REVIEW_QUALIFICATION_TIMEOUT_MS: '600000',
    OPENROUTER_API_KEY: 'test-openrouter-key',
    GH_TOKEN: 'ghs_readOnlyQualificationToken',
  } as NodeJS.ProcessEnv;
  const rawDiff = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1 +1 @@',
    '-export const value = 0;',
    '+export const value = "raw-diff-secret-marker";',
    '',
  ].join('\n');
  const diffDigest = createHash('sha256').update(rawDiff).digest('hex');

  function completePanelResult() {
    const persona = (id: string) => ({
      id,
      required: true,
      providerId: 'qualification',
      model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
      decision: 'APPROVE' as const,
      findings: [],
      usage: { prompt: 100, completion: 20, total: 120 },
      costUSD: 0.001,
      durationMs: 50,
    });
    return {
      headSha: sameHeadEnvironment.REVIEW_HEAD_SHA,
      personas: ['security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing'].map(persona),
      optionalFailures: [],
      quorum: { required: 1, distinctProviders: ['qualification'], satisfied: true },
      moderator: {
        providerId: 'qualification', model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        decision: 'RECONCILED' as const, findings: [],
        usage: { prompt: 100, completion: 20, total: 120 }, costUSD: 0.001, durationMs: 30,
      },
      arbiter: {
        providerId: 'qualification', model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        verdict: 'SHIP' as const, rationale: 'private provider response',
        usage: { prompt: 100, completion: 20, total: 120 }, costUSD: 0.001, durationMs: 30,
      },
    };
  }

  it('is explicit, mutually exclusive, read-token-only, and non-publishing', async () => {
    expect(isSameHeadQualificationWorker(sameHeadEnvironment)).toBe(true);
    const invalidEnvironments = [
      { REVIEW_SAME_HEAD_QUALIFICATION_ONLY: 'false' },
      { REVIEW_FULL_PANEL_QUALIFICATION_ONLY: 'true' },
      { REVIEW_PANEL_QUALIFICATION_ONLY: 'true' },
      { REVIEW_PROVIDER_QUALIFICATION_ONLY: 'true' },
      { REVIEW_RECEIPT_ONLY: 'true' },
      { REVIEW_PUBLICATION_MODE: 'enabled' },
      { REVIEW_QUALIFICATION_PROVIDER_ID: 'synthetic' },
      { GH_TOKEN: undefined },
      { GH_TOKEN: 'github_pat_writeCapable' },
      { GITHUB_TOKEN: 'ambient-token-must-not-enter-worker' },
      { GITHUB_APP_PRIVATE_KEY: 'private-key-must-not-enter-worker' },
    ];
    for (const changes of invalidEnvironments) {
      const candidate = { ...sameHeadEnvironment, ...changes };
      expect(isSameHeadQualificationWorker(candidate)).toBe(false);
      const sourceLoader = vi.fn();
      await expect(runSameHeadQualificationWorker(
        candidate,
        vi.fn(),
        { complete: vi.fn() } as any,
        sourceLoader,
      )).rejects.toThrow(/same-head qualification worker contract/i);
      expect(sourceLoader).not.toHaveBeenCalled();
    }
  });

  it('reviews the verified diff and persists only sanitized same-head telemetry', async () => {
    const sourceLoader = vi.fn(async () => ({
      baseSha: sameHeadEnvironment.REVIEW_BASE_SHA,
      headSha: sameHeadEnvironment.REVIEW_HEAD_SHA,
      diff: rawDiff,
      diffDigest,
      githubReads: 3 as const,
    }));
    const client = {
      complete: vi.fn(async () => ({
        model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        content: 'private model response',
        usage: { prompt: 100, completion: 20, total: 120 },
        costUSD: 0.001,
        raw: { token: 'private-response-token' },
      })),
    };
    const panelRunner = vi.fn(async (options: any) => {
      expect(options.config.personas).toHaveLength(6);
      expect(options.config.personas.every((persona: any) => persona.required)).toBe(true);
      expect(options.config.personas.every((persona: any) => persona.paths.length === 1 && persona.paths[0] === '**')).toBe(true);
      expect(options.config.reviewers.providers[0].id).toBe('openrouter');
      expect(options.config.reviewers.providers[0].effort).toBe('high');
      expect(options.changedFiles).toEqual([{ path: 'src/auth.ts', patch: rawDiff.trimEnd() }]);
      expect(options.requestPolicy.metadata.qualificationMode).toBe('same-head');
      expect(options.requestPolicy.models).toEqual(['z-ai/glm-5.3-flash']);
      const lanes = ['security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing', 'moderator', 'arbiter'];
      await Promise.all(lanes.map((persona) => options.client.complete({
        model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        messages: [{ role: 'user', content: 'private prompt' }],
        stream: true,
        persona,
        providerId: 'openrouter',
      })));
      await options.client.complete({
        model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        messages: [{ role: 'user', content: 'private retry prompt' }],
        stream: true,
        persona: 'security',
        providerId: 'openrouter',
      });
      return completePanelResult();
    });

    const receipt = await runSameHeadQualificationWorker(
      sameHeadEnvironment,
      panelRunner,
      client,
      sourceLoader,
    );

    expect(sourceLoader).toHaveBeenCalledWith({
      token: sameHeadEnvironment.GH_TOKEN,
      repo: sameHeadEnvironment.REVIEW_REPO,
      prNumber: 42,
      expectedBaseSha: sameHeadEnvironment.REVIEW_BASE_SHA,
      expectedHeadSha: sameHeadEnvironment.REVIEW_HEAD_SHA,
    });
    expect(receipt).toMatchObject({
      version: 'ReviewYetiPanelQualification.v1',
      profile: 'same-head',
      source: 'github-pull-request',
      status: 'succeeded',
      engineRevision: 'e'.repeat(64),
      providerTopologyDigest: '583bc1bd38ba0e1d83f0193648c6cad68359d563e77b312d828fe98b20f84f1a',
      baseSha: sameHeadEnvironment.REVIEW_BASE_SHA,
      headSha: sameHeadEnvironment.REVIEW_HEAD_SHA,
      diffDigest,
      githubReads: 3,
      githubWrites: 0,
      providerCalls: 9,
      retryCount: 1,
      personaCount: 6,
      expectedPersonaCount: 6,
      optionalFailureCount: 0,
      verdict: 'SHIP',
      verdictSource: 'canonical-production-policy',
      severityCounts: { P0: 0, P1: 0, P2: 0 },
      findingFingerprintVersion: 'ReviewYetiFindingFingerprint.v1',
      findingFingerprints: [],
    });
    expect(receipt.laneAttribution).toEqual([
      {
        role: 'persona', lane: 'security', providerId: 'openrouter',
        requestedModel: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        resolvedModel: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        callCount: 2, retryCount: 1,
      },
      ...['performance', 'architecture', 'testing', 'dependencies', 'licensing'].map((lane) => ({
        role: 'persona', lane, providerId: 'openrouter',
        requestedModel: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        resolvedModel: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        callCount: 1, retryCount: 0,
      })),
      {
        role: 'moderator', lane: 'moderator', providerId: 'openrouter',
        requestedModel: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        resolvedModel: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        callCount: 1, retryCount: 0,
      },
      {
        role: 'arbiter', lane: 'arbiter', providerId: 'openrouter',
        requestedModel: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        resolvedModel: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        callCount: 1, retryCount: 0,
      },
    ]);
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [
      'raw-diff-secret-marker', sameHeadEnvironment.GH_TOKEN!, 'private prompt',
      'private model response', 'private-response-token', 'private provider response',
    ]) expect(serialized).not.toContain(forbidden);
    expect(fsMocks.writeFile).toHaveBeenCalledWith(
      receiptPathLiteral,
      `${JSON.stringify(receipt)}\n`,
      { encoding: 'utf8' },
    );
  });

  it('persists the production canonical verdict when a persona finds a blocking defect', async () => {
    const sourceLoader = vi.fn(async () => ({
      baseSha: sameHeadEnvironment.REVIEW_BASE_SHA,
      headSha: sameHeadEnvironment.REVIEW_HEAD_SHA,
      diff: rawDiff,
      diffDigest,
      githubReads: 3 as const,
    }));
    const client = {
      complete: vi.fn(async () => ({
        model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        content: 'private model response',
        usage: { prompt: 100, completion: 20, total: 120 },
        costUSD: 0.001,
        raw: {},
      })),
    };
    const panelRunner = vi.fn(async (options: any) => {
      await Promise.all([
        'security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing',
        'moderator', 'arbiter',
      ].map((persona) => options.client.complete({
        model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        messages: [{ role: 'user', content: 'private prompt' }],
        stream: true,
        persona,
        providerId: 'openrouter',
      })));
      const result = completePanelResult();
      result.personas[0].decision = 'FINDINGS';
      result.personas[0].findings = [{
        severity: 'P1',
        path: 'src/auth.ts',
        line: 1,
        title: 'private blocking finding',
        body: 'private blocking detail',
      }];
      result.arbiter.verdict = 'SHIP';
      result.arbiter.rationale = 'private unsafe approval rationale';
      return result;
    });

    const receipt = await runSameHeadQualificationWorker(
      sameHeadEnvironment,
      panelRunner,
      client,
      sourceLoader,
    );

    expect(receipt).toMatchObject({
      profile: 'same-head',
      status: 'succeeded',
      verdict: 'FIX_FIRST',
      verdictSource: 'canonical-production-policy',
      findingsCount: 1,
      severityCounts: { P0: 0, P1: 1, P2: 0 },
      findingFingerprintVersion: 'ReviewYetiFindingFingerprint.v1',
      findingFingerprints: [{
        severity: 'P1',
        anchorDigest: createHash('sha256').update(JSON.stringify({
          version: 'ReviewYetiFindingAnchor.v1',
          diffDigest,
          path: 'src/auth.ts',
          line: 1,
        })).digest('hex'),
        contentDigest: createHash('sha256').update(JSON.stringify({
          version: 'ReviewYetiFindingContent.v1',
          diffDigest,
          severity: 'P1',
          path: 'src/auth.ts',
          line: 1,
          title: 'private blocking finding',
          body: 'private blocking detail',
          suggestion: '',
        })).digest('hex'),
      }],
      providerCalls: 8,
      githubReads: 3,
      githubWrites: 0,
    });
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [
      'src/auth.ts', 'private blocking finding', 'private blocking detail', 'private unsafe approval rationale',
    ]) expect(serialized).not.toContain(forbidden);
    expect(compareQualificationReceipts(receipt, receipt)).toMatchObject({
      comparable: true,
      findingOverlap: {
        anchor: { matched: 1, leftOnly: 0, rightOnly: 0 },
        exact: { matched: 1, leftOnly: 0, rightOnly: 0 },
      },
    });
  });

  it('persists a classified failure when sanitized finding telemetry exceeds its bound', async () => {
    const sourceLoader = vi.fn(async () => ({
      baseSha: sameHeadEnvironment.REVIEW_BASE_SHA,
      headSha: sameHeadEnvironment.REVIEW_HEAD_SHA,
      diff: rawDiff,
      diffDigest,
      githubReads: 3 as const,
    }));
    const client = {
      complete: vi.fn(async () => ({
        model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        content: 'private model response',
        usage: { prompt: 100, completion: 20, total: 120 },
        costUSD: 0.001,
        raw: {},
      })),
    };
    const panelRunner = vi.fn(async (options: any) => {
      await Promise.all([
        'security', 'performance', 'architecture', 'testing', 'dependencies', 'licensing',
        'moderator', 'arbiter',
      ].map((persona) => options.client.complete({
        model: sameHeadEnvironment.REVIEW_QUALIFICATION_MODEL,
        messages: [{ role: 'user', content: 'private prompt' }],
        stream: true,
        persona,
        providerId: 'openrouter',
      })));
      const result = completePanelResult();
      result.personas[0].decision = 'FINDINGS';
      result.personas[0].findings = Array.from({ length: 257 }, (_, index) => ({
        severity: 'P2' as const,
        path: 'src/auth.ts',
        line: 1,
        title: `private finding ${index}`,
        body: `private detail ${index}`,
      }));
      return result;
    });

    await expect(runSameHeadQualificationWorker(
      sameHeadEnvironment,
      panelRunner,
      client,
      sourceLoader,
    )).rejects.toThrow('same-head qualification failed: qualification_contract');
    const persisted = JSON.parse(String(fsMocks.writeFile.mock.calls[0][1]));
    expect(persisted).toMatchObject({
      profile: 'same-head',
      status: 'failed',
      failureClass: 'qualification_contract',
      githubReads: 3,
      githubWrites: 0,
      providerCalls: 8,
    });
    expect(JSON.stringify(persisted)).not.toContain('private finding');
    expect(JSON.stringify(persisted)).not.toContain('private detail');
  });

  it('persists a classified source failure without leaking GitHub response text', async () => {
    const sourceLoader = vi.fn(async () => {
      throw new Error('GitHub qualification read failed HTTP 429 raw-secret-response');
    });
    await expect(runSameHeadQualificationWorker(
      sameHeadEnvironment,
      vi.fn(),
      { complete: vi.fn() } as any,
      sourceLoader,
    )).rejects.toThrow('same-head qualification failed: github_rate_limit');
    const persisted = JSON.parse(String(fsMocks.writeFile.mock.calls[0][1]));
    expect(persisted).toMatchObject({
      profile: 'same-head',
      status: 'failed',
      source: 'github-pull-request',
      failureClass: 'github_rate_limit',
      githubReads: 0,
      githubWrites: 0,
      providerCalls: 0,
    });
    expect(JSON.stringify(persisted)).not.toContain('raw-secret-response');
  });

  it('routes same-head qualification before every existing worker mode', async () => {
    const sameHeadRunner = vi.fn(async () => undefined);
    const fullPanelRunner = vi.fn(async () => undefined);
    const panelRunner = vi.fn(async () => undefined);
    const providerRunner = vi.fn(async () => undefined);
    const liveRunner = vi.fn(async () => undefined);

    await runWorker(
      sameHeadEnvironment,
      liveRunner,
      providerRunner,
      panelRunner,
      fullPanelRunner,
      sameHeadRunner,
    );

    expect(sameHeadRunner).toHaveBeenCalledWith(sameHeadEnvironment);
    expect(fullPanelRunner).not.toHaveBeenCalled();
    expect(panelRunner).not.toHaveBeenCalled();
    expect(providerRunner).not.toHaveBeenCalled();
    expect(liveRunner).not.toHaveBeenCalled();
  });
});
