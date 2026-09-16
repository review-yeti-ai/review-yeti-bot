import { describe, expect, it, vi } from 'vitest';
import {
  requeueRecoverableIncompletePanelFailure,
  type RecoverablePanelRetryRepository,
  type RunRetryContext,
} from '../../src/review/recoverablePanelRetry';
import { RECOVERABLE_PANEL_AUTO_RETRY_CAP, RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS } from '../../src/review/publicationFailurePolicy';
import type { WorkerTerminalFailure } from '../../src/review/workerCompletion';

const RUN_ID = `run_${'a'.repeat(32)}`;

function failure(overrides: Partial<WorkerTerminalFailure> = {}): WorkerTerminalFailure {
  return {
    version: 'WorkerTerminalFailure.v1',
    runId: RUN_ID,
    repositoryId: 123,
    owner: 'calltelemetry',
    repo: 'cisco-cdr',
    prNumber: 42,
    headSha: 'b'.repeat(40),
    baseSha: 'c'.repeat(40),
    policyDigest: 'd'.repeat(64),
    configDigest: 'e'.repeat(64),
    executionAttempt: 1,
    failureClass: 'malformed_output',
    diagnostics: { reason: 'provider_structured_output_invalid', logTail: 'optional reviewer did not complete',
      recoverableIncompletePanel: true },
    ...overrides,
  } as WorkerTerminalFailure;
}

const IDENTITY = {
  owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
  headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40),
  snapshotDigest: 'f'.repeat(64), configDigest: 'e'.repeat(64),
};

function appGateContext(overrides: Partial<RunRetryContext> = {}): RunRetryContext {
  return {
    publicationMode: 'app-gate', authoritativeGateAppId: null,
    repositoryId: 123, installationId: 456, identity: IDENTITY,
    ...overrides,
  };
}

function fakeRepository(context: RunRetryContext | null) {
  return {
    admit: vi.fn(async () => ({}) as never),
    readRunRetryContext: vi.fn(async () => context),
  } satisfies RecoverablePanelRetryRepository;
}

function fakeLogger() {
  return { error: vi.fn() };
}

describe('requeueRecoverableIncompletePanelFailure', () => {
  it('does not admit when the recoverable marker is absent', async () => {
    const repository = fakeRepository(appGateContext());
    const logger = fakeLogger();

    await requeueRecoverableIncompletePanelFailure({
      input: failure({ diagnostics: { reason: 'provider_structured_output_invalid', logTail: 'x' } }),
      now: 1_000, repository, logger,
    });

    expect(repository.readRunRetryContext).not.toHaveBeenCalled();
    expect(repository.admit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does not admit once the execution attempt is past the retry cap', async () => {
    const repository = fakeRepository(appGateContext());
    const logger = fakeLogger();

    await requeueRecoverableIncompletePanelFailure({
      input: failure({ executionAttempt: RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1 }),
      now: 1_000, repository, logger,
    });

    expect(repository.readRunRetryContext).not.toHaveBeenCalled();
    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('does not admit when the run no longer exists', async () => {
    const repository = fakeRepository(null);
    const logger = fakeLogger();

    await requeueRecoverableIncompletePanelFailure({ input: failure(), now: 1_000, repository, logger });

    expect(repository.readRunRetryContext).toHaveBeenCalledExactlyOnceWith(RUN_ID);
    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('does not admit a non-app-gate run', async () => {
    const repository = fakeRepository(appGateContext({ publicationMode: 'disabled' }));
    const logger = fakeLogger();

    await requeueRecoverableIncompletePanelFailure({ input: failure(), now: 1_000, repository, logger });

    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('does not admit an authoritative-gate run', async () => {
    const repository = fakeRepository(appGateContext({ authoritativeGateAppId: 4385771 }));
    const logger = fakeLogger();

    await requeueRecoverableIncompletePanelFailure({ input: failure(), now: 1_000, repository, logger });

    expect(repository.admit).not.toHaveBeenCalled();
  });

  it('admits a fresh execution attempt for an eligible app-gate run with the exact retry payload', async () => {
    const context = appGateContext();
    const repository = fakeRepository(context);
    const logger = fakeLogger();
    const input = failure({ executionAttempt: 2 });

    await requeueRecoverableIncompletePanelFailure({ input, now: 5_000, repository, logger });

    expect(repository.readRunRetryContext).toHaveBeenCalledExactlyOnceWith(RUN_ID);
    expect(repository.admit).toHaveBeenCalledExactlyOnceWith({
      deliveryId: `internal-recoverable-panel-retry:${RUN_ID}:a2`,
      eventName: 'internal_recoverable_panel_retry',
      repositoryId: context.repositoryId,
      installationId: context.installationId,
      receivedAt: 5_000,
      terminalDeadline: expect.any(Number),
      payloadDigest: expect.any(String),
      publicationMode: 'app-gate',
      centralActionDispatch: false,
      retryRequested: true,
      retryAfterExecutionAttempt: 2,
      availableAt: 5_000 + RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS,
      identity: context.identity,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('resolves without throwing and logs when admit rejects', async () => {
    const repository = fakeRepository(appGateContext());
    repository.admit.mockRejectedValueOnce(new Error('delivery identity conflict: delivery id was already used'));
    const logger = fakeLogger();

    await expect(requeueRecoverableIncompletePanelFailure({
      input: failure(), now: 1_000, repository, logger,
    })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledExactlyOnceWith('Automatic recoverable-panel retry admission failed', {
      runId: RUN_ID,
      executionAttempt: 1,
      reason: expect.stringContaining('delivery identity conflict'),
    });
  });
});
