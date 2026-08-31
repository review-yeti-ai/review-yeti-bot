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
} from '../../src/cli/runLiveReview';

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
    expect(moduleLoader).toHaveBeenCalledTimes(6);
    expect(new Set(moduleLoader.mock.calls.flat())).toEqual(new Set([
      '../gateway/openRouterClient',
      '../panel/panelEngine',
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
