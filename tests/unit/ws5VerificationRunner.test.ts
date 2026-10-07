import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ws5 from '../../scripts/ws5-acceptance.mjs';
import * as benchmark from '../../scripts/competitive-review-benchmark.mjs';
import { createWs5PublicTestFixture } from './ws5PublicTestFixtures';

let runner: any = null;
let ws5Fixture: ReturnType<typeof createWs5PublicTestFixture>;
beforeAll(async () => {
  ws5Fixture = createWs5PublicTestFixture(process.cwd());
  vi.doMock('../../scripts/ws5-acceptance.mjs', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return { ...actual, loadPinnedAcceptancePlan: () => ws5Fixture.bundle };
  });
  runner = await import('../../scripts/ws5-verification-runner.mjs').catch(() => null);
});

afterAll(() => {
  vi.doUnmock('../../scripts/ws5-acceptance.mjs');
  ws5Fixture?.cleanup();
});

describe('WS5 fixed verification-reference runner', () => {
  it('selects only the frozen ten Diff-Level references in their pinned order', () => {
    expect(runner).not.toBeNull();
    expect(typeof runner.createVerificationCellPlan).toBe('function');
    const bundle = ws5Fixture.bundle;
    const cells = runner.createVerificationCellPlan(bundle);
    expect(cells).toHaveLength(10);
    expect(cells.map((cell: any) => cell.caseId)).toEqual(bundle.plan.verificationPanel.diffLevelCaseIds);
    expect(cells.every((cell: any) => cell.context === 'Diff Level' && cell.qualityScore === null)).toBe(true);
    expect(new Set(cells.map((cell: any) => cell.caseId)).size).toBe(10);
    expect(bundle.plan.verificationPanel.labelCounts).toEqual({ positive: 7, negative: 3, total: 10 });
  });

  it('rejects a verification result with stale runtime or altered case selection', () => {
    expect(runner).not.toBeNull();
    expect(typeof runner.assertVerificationRunIdentity).toBe('function');
    const bundle = ws5Fixture.bundle;
    const cell = runner.createVerificationCellPlan(bundle)[0];
    const run = {
      task: 'comment-verification',
      datasetSha256: bundle.plan.publicPanel.datasetSha256,
      heldoutManifestSha256: bundle.plan.publicPanel.manifestSha256,
      preparedInputSha256: bundle.plan.verificationPanel.preparedInputSha256,
      panelCaseIds: bundle.preparedVerification.cases.map((entry: any) => entry.caseId),
      selectedCaseIds: [cell.caseId],
      selectedCaseCount: 1,
      panelSize: bundle.preparedVerification.cases.length,
      runtime: { commit: 'b'.repeat(40), tree: 'c'.repeat(40), worktreeClean: true },
      cases: [{ caseId: cell.caseId, context: 'Diff Level', status: 'completed' }],
    };
    expect(() => runner.assertVerificationRunIdentity(bundle, cell, run, {
      expectedRuntimeSha: 'a'.repeat(40), expectedRuntimeTreeOid: 'c'.repeat(40),
    })).toThrow('ws5_verification_runtime_pin_mismatch');
    run.runtime.commit = 'a'.repeat(40);
    run.selectedCaseIds = ['not-in-fixed-panel'];
    expect(() => runner.assertVerificationRunIdentity(bundle, cell, run, {
      expectedRuntimeSha: 'a'.repeat(40), expectedRuntimeTreeOid: 'c'.repeat(40),
    })).toThrow('ws5_verification_selected_case_mismatch');
  });

  it('binds verification receipts to the independently measured host Node and TypeScript runtime', () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const bundle = ws5Fixture.bundle;
    const cell = runner.createVerificationCellPlan(bundle)[0];
    const hostExecution = benchmark.runtimeGitIdentity(repoRoot).hostExecution;
    const run = {
      task: 'comment-verification',
      datasetSha256: bundle.plan.publicPanel.datasetSha256,
      heldoutManifestSha256: bundle.plan.publicPanel.manifestSha256,
      preparedInputSha256: bundle.plan.verificationPanel.preparedInputSha256,
      panelCaseIds: bundle.preparedVerification.cases.map((entry: any) => entry.caseId),
      selectedCaseIds: [cell.caseId],
      selectedCaseCount: 1,
      panelSize: bundle.preparedVerification.cases.length,
      runtime: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), worktreeClean: true, hostExecution },
      requestedConfiguration: { transport: { name: 'openrouter', requestedModel: 'pr-reviewer' } },
      cases: [{ caseId: cell.caseId, context: 'Diff Level', status: 'completed',
        verdict: 'CONFIRM', sourceOmissions: [] }],
    };
    expect(runner.assertVerificationRunIdentity(bundle, cell, run, {
      expectedRuntimeSha: 'a'.repeat(40), expectedRuntimeTreeOid: 'b'.repeat(40), expectedHostExecution: hostExecution,
      expectedTransportName: 'openrouter',
    })).toMatchObject({ caseId: cell.caseId, verdict: 'CONFIRM' });
    const changedHost = { ...hostExecution, typescriptEntrySha256: 'c'.repeat(64) };
    expect(() => runner.assertVerificationRunIdentity(bundle, cell, {
      ...run, runtime: { ...run.runtime, hostExecution: changedHost },
    }, { expectedRuntimeSha: 'a'.repeat(40), expectedRuntimeTreeOid: 'b'.repeat(40),
      expectedHostExecution: hostExecution, expectedTransportName: 'openrouter' })).toThrow('ws5_verification_host_execution_identity_mismatch');
  });

  it('derives a finite independent call and wall bound for all ten verification rows', () => {
    expect(runner).not.toBeNull();
    expect(runner.WS5_VERIFICATION_BOUNDS).toMatchObject({
      expectedCells: 10,
      maxConcurrentCells: 1,
      maxForwardedModelRequestsPerCell: 1,
      maxCellWallMs: 1_200_000,
      maxPreflightWallMs: 1_200_000,
      maxFinalizationWallMs: 300_000,
      maxPanelWallMs: 13_500_000,
      maxForwardedModelRequests: 10,
      automaticRetries: 0,
      maxOutputTokens: 4096,
    });
  });

  it('does not read the parent key before exact root authorization', async () => {
    expect(runner).not.toBeNull();
    let credentialReads = 0;
    await expect(runner.runWs5VerificationPanel({
      authorizeModelDispatch: false,
      parentBroker: { readApiKeyInMemory: () => { credentialReads += 1; return 'sentinel'; } },
    })).rejects.toThrow('ws5_verification_dispatch_not_authorized_by_root');
    expect(credentialReads).toBe(0);
  });

  it('writes ten incomplete no-dispatch terminals when final pins are not ready', async () => {
    expect(runner).not.toBeNull();
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-verification-pins-pending-'));
    let credentialReads = 0;
    try {
      const result = await runner.runWs5VerificationPanel({
        authorizeModelDispatch: true,
        repoRoot,
        dataRoot: path.join(os.tmpdir(), 'ws5-unit-private-data-root'),
        planPath: 'eval-baselines/competitive-review-benchmark/ws5-acceptance-v1.json',
        externalDataContractPath: path.join(os.tmpdir(), 'ws5-unit-external-data-contract.json'),
        externalDataContractSha256: 'a'.repeat(64),
        alibabaBuildBindingPath: path.join(os.tmpdir(), 'ws5-unit-alibaba-build-binding.json'),
        alibabaBuildBindingSha256: 'b'.repeat(64),
        outputDirectory,
        sourceCacheRoot: os.tmpdir(),
        alibabaBinaryPath: process.execPath,
        pins: null,
        parentBroker: {
          bifrostBaseUrl: 'https://bifrost.invalid',
          preflightAlias: async () => { throw new Error('must_not_run'); },
          readApiKeyInMemory: () => { credentialReads += 1; return 'unused'; },
          attestRequests: async () => { throw new Error('must_not_run'); },
        },
      });
      expect(credentialReads).toBe(0);
      expect(result.cells).toHaveLength(10);
      expect(result.manifest).toMatchObject({
        status: 'incomplete', expectedCells: 10, modelRunCells: 0, incompleteCells: 10,
        providerCalls: 0, qualityScore: null,
      });
      expect(result.cells.every((cell: any) => cell.noModelDispatch === true
        && cell.outcome.failureCode === 'ws5_verification_final_pins_required')).toBe(true);
      for (const cell of result.cells) {
        const bytes = fs.readFileSync(path.join(outputDirectory, cell.receiptFile));
        expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(cell.receiptSha256);
        expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({
          status: 'incomplete', noModelDispatch: true,
          outcome: { failureCode: 'ws5_verification_final_pins_required' },
          httpAttempts: [], qualityScore: null,
        });
        expect(fs.statSync(path.join(outputDirectory, cell.receiptFile)).mode & 0o777).toBe(0o600);
      }
      expect(fs.readdirSync(outputDirectory)).toHaveLength(12);
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('persists a cancellation terminal for every fixed row before performing pin or provider work', async () => {
    expect(runner).not.toBeNull();
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-verification-pre-cancelled-'));
    const controller = new AbortController();
    controller.abort();
    let credentialReads = 0;
    try {
      const result = await runner.runWs5VerificationPanel({
        authorizeModelDispatch: true,
        repoRoot,
        dataRoot: path.join(os.tmpdir(), 'ws5-unit-private-data-root'),
        planPath: 'eval-baselines/competitive-review-benchmark/ws5-acceptance-v1.json',
        externalDataContractPath: path.join(os.tmpdir(), 'ws5-unit-external-data-contract.json'),
        externalDataContractSha256: 'a'.repeat(64),
        alibabaBuildBindingPath: path.join(os.tmpdir(), 'ws5-unit-alibaba-build-binding.json'),
        alibabaBuildBindingSha256: 'b'.repeat(64),
        outputDirectory,
        sourceCacheRoot: os.tmpdir(),
        alibabaBinaryPath: process.execPath,
        pins: null,
        signal: controller.signal,
        parentBroker: {
          bifrostBaseUrl: 'https://bifrost.invalid',
          preflightAlias: async () => { throw new Error('must_not_run'); },
          readApiKeyInMemory: () => { credentialReads += 1; return 'unused'; },
          attestRequests: async () => { throw new Error('must_not_run'); },
        },
      });
      expect(credentialReads).toBe(0);
      expect(result.cells).toHaveLength(10);
      expect(result.cells.every((cell: any) => cell.noModelDispatch === true
        && cell.outcome.failureCode === 'ws5_parent_cancelled')).toBe(true);
      for (const cell of result.cells) {
        const bytes = fs.readFileSync(path.join(outputDirectory, cell.receiptFile));
        expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(cell.receiptSha256);
        expect(fs.statSync(path.join(outputDirectory, cell.receiptFile)).mode & 0o777).toBe(0o600);
        const receipt = JSON.parse(bytes.toString('utf8'));
        expect(receipt).toMatchObject({
          noModelDispatch: true, outcome: { failureCode: 'ws5_parent_cancelled' },
          httpAttempts: [], qualityScore: null,
        });
      }
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('writes a durable explicit no-dispatch terminal for every cancelled planned cell', () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    const bundle = ws5Fixture.bundle;
    const cell = runner.createVerificationCellPlan(bundle)[3];
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ws5-verification-cancelled-cell-'));
    try {
      const row = runner.writeUndispatchedVerificationCell(
        outputDirectory, cell, 'ws5_parent_cancelled', 25,
      );
      expect(row).toMatchObject({
        ordinal: cell.ordinal, caseId: cell.caseId, status: 'incomplete', noModelDispatch: true,
        outcome: { failureCode: 'ws5_parent_cancelled' }, qualityScore: null,
        callAccounting: { localHttpRequestAttempts: 0, proxyIngressAttemptCount: 0,
          proxyForwardedCompletionAttemptCount: 0 },
      });
      const bytes = fs.readFileSync(path.join(outputDirectory, row.receiptFile));
      expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(row.receiptSha256);
      expect(JSON.parse(bytes.toString('utf8')).qualityScore).toBeNull();
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
