import { describe, expect, it } from 'vitest';
import {
  completeComposedRuntimeResources,
  ComposedRuntimeResourceObserver,
  composedRuntimeResourcesSchema,
} from '../composedResourceReceipt';
import type { EffectiveReviewConfigReceipt } from '../../config/schema';
import type { ReviewTask } from '../../reviewTaskContract';
import { GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION } from '../../review/groundedEvidenceV2';
import { ProviderAttemptBudget } from '../../gateway/providerAttemptBudget';

const CONFIG_DIGEST = 'a'.repeat(64);
const SOURCE_DIGEST = 'b'.repeat(64);

const configuration: EffectiveReviewConfigReceipt = {
  schema: 'review-yeti-effective-config.v1',
  requested: {
    profile: 'balanced', review_engine: 'composed', personas: ['security'],
    mcp_servers: [], confidence_threshold: null, max_investigation_turns: 15,
    max_reviewed_lockfile_patch_chars: null,
  },
  effective: {
    review_engine: 'composed',
    confidence_threshold: { value: 70, applied: false, reason: 'The worker does not consume confidence_threshold.' },
    profile: { value: 'balanced', applied: true, reason: 'Applied to advisory breadth under severity v2.' },
    provider: { id: 'bifrost', model: 'review-alias', requested_effort: 'medium',
      upstream_observed_model: 'unknown', upstream_observed_effort: 'unknown' },
    personas: [{ requested: 'security', id: 'sec-lane', charter: 'builtin:security' }],
    memory: { state: 'not_loaded', configured_servers: [], loaded_servers: [], reason: 'Not consumed.' },
    composed_budget: { source: 'engine_defaults', configured_overrides: {}, central_policy_total_turns: 100,
      central_policy_max_tasks: 8, plan_turns: 4, base_task_turns: 12, dynamic_task_turns_max: 18,
      max_concurrent_tasks: 3, total_turns_hard_cap: 200, operator_total_turn_override: 'COMPOSED_ENGINE_MAX_TURNS' },
    worker_limits: { effective_investigation_turns: 15, effective_reviewed_lockfile_patch_chars: null },
  },
};

function task(id: string, paths: string[]): ReviewTask {
  return { id, dimension: 'security', paths, question: 'Check the changed auth path.', rationale: 'The patch changes access control.' };
}

function completeSource(taskId: string, path: string) {
  return { version: 'TaskSourceDelivery.v1', taskId, headSha: 'c'.repeat(40), baseSha: null,
    contextDigests: [SOURCE_DIGEST], files: [{ path, patchDigest: SOURCE_DIGEST, totalChars: 10,
      ranges: [[0, 10]], inline: false }], complete: true };
}

function observer(tasks: ReviewTask[], now: () => number = () => 1_100) {
  const value = new ComposedRuntimeResourceObserver({ configDigest: CONFIG_DIGEST, configuration, now });
  value.configureBudget({ configuredTotalTurns: 100, investigationTurns: 88, verificationReserveTurns: 12 });
  value.setPlan(tasks);
  return value;
}

describe('composed runtime resources', () => {
  it('keeps verifier use unknown at engine return and fills it only in the final worker bridge', () => {
    const record = observer([task('auth-a', ['src/auth.ts'])]);
    record.markTaskStarted('auth-a');
    record.markTaskOutcome('auth-a', 'completed', completeSource('auth-a', 'src/auth.ts'));
    record.recordTurn('planning', 'final');
    record.recordTurn('task', 'tool');
    record.recordTurn('task', 'final');
    record.reserveTaskFinalizationTurns(3);
    record.clientCallStarted();
    record.clientCallSettled(8.4, true);
    record.clientCallStarted();
    record.clientCallSettled(9.2, true);

    const engineReceipt = record.snapshot()!;
    expect(engineReceipt.stage).toBe('composed_engine');
    expect(engineReceipt.evidenceSemanticsVersion).toBe(GROUNDED_REVIEW_EVIDENCE_SEMANTICS_VERSION);
    expect(engineReceipt.usage.verifierCalls).toEqual({ value: null,
      unavailableReason: 'Grounded verification runs after the composed engine returns.' });
    expect(engineReceipt.usage).toMatchObject({ totalTurns: 3, planningTurns: 1, discoveryTurns: 1,
      taskFinalizationTurns: 1, taskFinalizationReservedTurns: 3, clientCallsStarted: 2,
      clientResponsesReceived: 2, settledClientCalls: 2, settledClientCallElapsedMs: 17 });

    const unbound = completeComposedRuntimeResources({ observation: engineReceipt, configDigest: 'd'.repeat(64), verifierCalls: 2 });
    expect(unbound?.stage).toBe('worker_completion');
    expect(unbound?.configDigest).toMatchObject({ value: null,
      unavailableReason: expect.stringContaining('did not match') });
    const missingBinding = completeComposedRuntimeResources({ observation: engineReceipt, verifierCalls: 2 });
    expect(missingBinding?.configDigest).toMatchObject({ value: null,
      unavailableReason: expect.stringContaining('did not receive a trusted prepared configuration digest') });
    const completed = completeComposedRuntimeResources({ observation: engineReceipt,
      configDigest: CONFIG_DIGEST, verifierCalls: 2 });
    expect(completed).toMatchObject({ stage: 'worker_completion', configDigest: { value: CONFIG_DIGEST },
      usage: { verifierCalls: { value: 2, unavailableReason: null } } });
  });

  it('binds physical attempts to a versioned receipt and refuses to invent them for legacy evidence', () => {
    const providerAttemptBudget = new ProviderAttemptBudget({ totalLimit: 100, investigationLimit: 88, verificationLimit: 12 });
    const record = new ComposedRuntimeResourceObserver({ configDigest: CONFIG_DIGEST, configuration,
      providerAttemptBudget, now: () => 1_100 });
    record.configureBudget({ configuredTotalTurns: 100, investigationTurns: 88, verificationReserveTurns: 12 });
    record.setPlan([task('auth-a', ['src/auth.ts'])]);
    record.markTaskStarted('auth-a');
    record.markTaskOutcome('auth-a', 'completed', completeSource('auth-a', 'src/auth.ts'));
    providerAttemptBudget.beginAttempt('investigation');

    const engineReceipt = record.snapshot('terminal')!;
    expect(engineReceipt).toMatchObject({ version: 'ComposedRuntimeResources.v2',
      providerAttempts: { totalLimit: 100, investigationLimit: 88, verificationLimit: 12,
        totalStarted: 1, investigationStarted: 1, verificationStarted: 0 } });

    providerAttemptBudget.beginAttempt('verification');
    const completed = completeComposedRuntimeResources({ observation: engineReceipt,
      configDigest: CONFIG_DIGEST, verifierCalls: 1, providerAttemptBudget: providerAttemptBudget.snapshot() });
    expect(completed).toMatchObject({ version: 'ComposedRuntimeResources.v2', stage: 'worker_completion',
      providerAttempts: { totalStarted: 2, investigationStarted: 1, verificationStarted: 1 } });

    const legacy = observer([task('auth-a', ['src/auth.ts'])]).snapshot('terminal')!;
    expect(legacy.version).toBe('ComposedRuntimeResources.v1');
    expect(completeComposedRuntimeResources({ observation: legacy, configDigest: CONFIG_DIGEST,
      verifierCalls: 1, providerAttemptBudget: providerAttemptBudget.snapshot() })).toBeUndefined();
  });

  it('counts a shared path as investigated only when every assigned task completes with delivered source', () => {
    const record = observer([
      task('auth-a', ['src/auth.ts']),
      task('auth-b', ['src/auth.ts']),
    ]);
    record.markTaskStarted('auth-a');
    record.markTaskOutcome('auth-a', 'completed', completeSource('auth-a', 'src/auth.ts'));
    record.markTaskStarted('auth-b');
    record.markTaskOutcome('auth-b', 'blocked');

    const receipt = record.snapshot()!;
    expect(receipt.tasks).toMatchObject({ planned: ['auth-a', 'auth-b'], started: ['auth-a', 'auth-b'],
      completed: ['auth-a'], blocked: ['auth-b'], failed: [], pending: [] });
    expect(receipt.coverage.assignedPaths.count).toBe(1);
    expect(receipt.coverage.investigatedPaths.count).toBe(0);
    expect(receipt.coverage.remainingPaths).toEqual(receipt.coverage.assignedPaths);
  });

  it('requires every started task to be planned and accounted before declaring completion', () => {
    const record = observer([task('auth-a', ['src/auth.ts'])]);
    record.markTaskStarted('auth-a');
    record.markTaskOutcome('auth-a', 'completed', completeSource('auth-a', 'src/auth.ts'));
    const receipt = record.snapshot('terminal')!;
    expect(receipt.engineExecutionState).toBe('complete');

    const forged = { ...receipt, tasks: { ...receipt.tasks, started: ['auth-a', 'unplanned-task'] } };
    expect(composedRuntimeResourcesSchema.safeParse(forged).success).toBe(false);
  });

  it('preserves an incomplete engine receipt with valid pending work', () => {
    const record = observer([
      task('auth-a', ['src/auth.ts']),
      task('auth-b', ['src/auth.ts']),
    ]);
    record.markTaskStarted('auth-a');
    record.markTaskOutcome('auth-a', 'completed', completeSource('auth-a', 'src/auth.ts'));

    const receipt = record.snapshot('terminal')!;
    expect(receipt).toMatchObject({ engineExecutionState: 'incomplete', tasks: {
      started: ['auth-a'], completed: ['auth-a'], pending: ['auth-b'],
    } });
    expect(composedRuntimeResourcesSchema.safeParse(receipt).success).toBe(true);
  });

  it('keeps engine completion separate from unavailable verifier completion', () => {
    const record = observer([task('auth-a', ['src/auth.ts'])]);
    record.markTaskStarted('auth-a');
    record.markTaskOutcome('auth-a', 'completed', completeSource('auth-a', 'src/auth.ts'));
    const observation = record.snapshot('terminal')!;

    const workerReceipt = completeComposedRuntimeResources({ observation, configDigest: CONFIG_DIGEST,
      verifierCalls: null, verifierCallsUnknownReason: 'the verifier call count was not observed' });
    expect(workerReceipt).toMatchObject({ stage: 'worker_completion', engineExecutionState: 'complete',
      tasks: { completed: ['auth-a'] }, usage: { verifierCalls: { value: null,
        unavailableReason: 'the verifier call count was not observed' } } });
    expect(composedRuntimeResourcesSchema.safeParse(workerReceipt).success).toBe(true);
  });

  it('leaves region coverage explicitly unavailable and keeps private prompt/path text out of the receipt', () => {
    const record = observer([task('auth-a', ['private/customer/repo/auth.ts'])]);
    record.markTaskStarted('auth-a');
    record.markTaskOutcome('auth-a', 'completed', completeSource('auth-a', 'private/customer/repo/auth.ts'));
    const receipt = record.snapshot()!;
    const serialized = JSON.stringify(receipt);

    expect(receipt.coverage.regions).toMatchObject({ state: 'unavailable', reason: expect.any(String) });
    expect(serialized).not.toContain('private/customer/repo/auth.ts');
    expect(serialized).not.toContain('Check the changed auth path');
    expect(serialized.toLowerCase()).not.toContain('apikey');
  });

  it('rejects unknown fields and inconsistent unknown-value reasons', () => {
    const record = observer([task('auth-a', ['src/auth.ts'])]);
    record.markTaskStarted('auth-a');
    record.markTaskOutcome('auth-a', 'completed', completeSource('auth-a', 'src/auth.ts'));
    const receipt = record.snapshot()!;

    expect(composedRuntimeResourcesSchema.safeParse({ ...receipt, apiKey: 'secret' }).success).toBe(false);
    expect(composedRuntimeResourcesSchema.safeParse({ ...receipt, usage: {
      ...receipt.usage, verifierCalls: { value: null, unavailableReason: null },
    } }).success).toBe(false);
  });
});
