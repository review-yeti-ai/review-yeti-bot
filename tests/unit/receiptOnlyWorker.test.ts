import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
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

  it.each([
    ['receipt-only mode is missing', { REVIEW_RECEIPT_ONLY: 'false' }],
    ['publication is enabled', { REVIEW_PUBLICATION_MODE: 'enabled' }],
    ['receipt path is outside the workspace', { REVIEW_RECEIPT_PATH: '/tmp/receipt.json' }],
    ['run ID is malformed', { REVIEW_RUN_ID: 'not-a-run-id' }],
    ['repository is malformed', { REVIEW_REPO: 'calltelemetry' }],
    ['head SHA is malformed', { REVIEW_HEAD_SHA: 'A'.repeat(40) }],
    ['timestamps are reversed', {}],
  ])('rejects %s', (_reason, override) => {
    const environment = { ...validEnvironment, ...override };
    const startedAt = '2026-08-31T13:00:00.000Z';
    const completedAt = _reason === 'timestamps are reversed'
      ? '2026-08-31T12:59:59.999Z'
      : '2026-08-31T13:00:00.250Z';
    expect(() => buildReceiptOnlyWorkerReceipt(environment, startedAt, completedAt)).toThrow(/receipt-only worker contract/i);
  });
});
