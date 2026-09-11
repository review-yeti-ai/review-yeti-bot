import { describe, expect, it, vi } from 'vitest';
import { ReviewCiService } from '../../src/review/reviewCiService';
import { createReviewCiLanePlan, reviewCiRunName, type ReviewCiRepository, type StoredReviewCiRequest } from '../../src/review/reviewCi';
import type { ReviewCiCaller } from '../../src/auth/reviewCiOidc';
import type { ReviewCiRepositoryConfig } from '../../src/auth/reviewCiConfig';

const id = '00000000-0000-4000-8000-000000000001';
const configured: ReviewCiRepositoryConfig = { repositoryId: 123, ownerId: 99, owner: 'example', repo: 'pilot',
  relay: { workflowId: 11, workflowPath: '.github/workflows/relay.yml', workflowRef: 'refs/heads/main', workflowSha: 'a'.repeat(40) },
  validation: { workflowId: 12, workflowPath: '.github/workflows/validation.yml', workflowRef: 'refs/heads/main', workflowSha: 'b'.repeat(40) },
  lanePlan: createReviewCiLanePlan(['unit'], ['Trusted preflight', 'Unit tests']) };
function fixture(state: StoredReviewCiRequest['state'] = 'pending') {
  const binding = { ...configured.validation, candidateSha: 'c'.repeat(40), lanePlan: configured.lanePlan };
  const request: StoredReviewCiRequest = { requestId: id, expectedAppId: 4385771, state,
    review: { repositoryId: 123, owner: 'example', repo: 'pilot', prNumber: 42, headSha: 'd'.repeat(40), baseSha: 'e'.repeat(40),
      policyDigest: 'f'.repeat(64), runId: `run_${'1'.repeat(32)}`, reviewGeneration: 0, executionAttempt: 1,
      attemptId: `run_${'1'.repeat(32)}-g0-e1` },
    binding: state === 'pending' ? null : binding, identityDigest: null, workflowEpoch: state === 'pending' ? 0 : 1,
    execution: null, terminalReceipt: null };
  const execution = { requestId: id, epoch: 1, repositoryId: 123, workflowId: 12, workflowSha: binding.workflowSha,
    candidateSha: binding.candidateSha, runId: 100, runAttempt: 1, event: 'workflow_dispatch' as const, runName: reviewCiRunName(id, 1) };
  if (state === 'running') request.execution = execution;
  const caller: ReviewCiCaller = { role: 'validation', repository: configured, runId: 100, runAttempt: 1,
    claims: { repository: 'example/pilot', repository_id: '123', repository_owner_id: '99', run_id: '100', run_attempt: '1',
      workflow_sha: binding.workflowSha, event_name: 'workflow_dispatch' } };
  const repository = {
    get: vi.fn(async () => structuredClone(request)), listPending: vi.fn().mockResolvedValue([]),
    admit: vi.fn(async (_id, nextBinding, validate) => { await validate(request, nextBinding); return 'recorded' as const; }),
    supersede: vi.fn().mockResolvedValue('recorded'), claimDelivery: vi.fn().mockResolvedValue(null),
    acknowledgeRepositoryDispatch: vi.fn(), acknowledgeWorkflowDispatch: vi.fn(), markDeliveryUncertain: vi.fn(), retryUncertainDelivery: vi.fn(),
    claimExecution: vi.fn(async (_execution, validate) => { await validate(request); return 'recorded' as const; }),
    recordTerminalReceipt: vi.fn(async (_receipt, validate) => { await validate(request); return 'recorded' as const; }),
  } satisfies ReviewCiRepository;
  const client = { dispatchRepository: vi.fn().mockResolvedValue({ status: 'accepted' }),
    dispatchWorkflow: vi.fn().mockResolvedValue({ status: 'accepted', runId: 100 }), correlateRun: vi.fn().mockResolvedValue(null),
    readRun: vi.fn().mockResolvedValue({ status: 'in_progress', runId: 100, runAttempt: 1 }), readTerminalReceipt: vi.fn() };
  const current = vi.fn().mockResolvedValue({ status: 'ready', binding });
  const config = { expectedAppId: 4385771, admissionEnabled: true, repositoryDispatchEnabled: true, repositories: [configured], tickMs: 5000 };
  const service = new ReviewCiService({ config, repository, current, workerId: 'unit-test', clientFor: async () => client, now: () => 1000 });
  const delivery = (kind: 'repository' | 'workflow', mode: 'dispatch' | 'reconcile' = 'dispatch') => ({
    request: structuredClone(request), kind, mode, epoch: kind === 'repository' ? 0 : 1, leaseOwner: 'unit-test', leaseToken: id });
  return { service, repository, client, current, request, binding, caller, config, execution, delivery };
}

describe('event-driven CI service coordination', () => {
  it('treats relay hints as coordinates and revalidates the stored identity inside admission', async () => {
    const f = fixture();
    expect(await f.service.wake(id, { ...f.caller, role: 'relay' })).toBe('recorded');
    expect(f.current).toHaveBeenCalledTimes(2);
    expect(f.repository.admit).toHaveBeenCalledWith(id, f.binding, expect.any(Function), 1000);
  });
  it('never wakes another repository or admits through the validation caller', async () => {
    const f = fixture();
    expect(await f.service.wake(id, { ...f.caller, role: 'relay', repository: { ...configured, repositoryId: 999 } })).toBe('ignored');
    await expect(f.service.wake(id, f.caller)).rejects.toThrow('not a relay');
    expect(f.repository.admit).not.toHaveBeenCalled();
  });
  it('keeps drafts pending, fences stale work, and pauses new admission', async () => {
    const f = fixture();
    f.current.mockResolvedValueOnce({ status: 'waiting' });
    expect(await f.service.wake(id, { ...f.caller, role: 'relay' })).toBe('waiting');
    expect(f.repository.supersede).not.toHaveBeenCalled();
    f.current.mockResolvedValueOnce({ status: 'stale' });
    expect(await f.service.wake(id, { ...f.caller, role: 'relay' })).toBe('recorded');
    expect(f.repository.supersede).toHaveBeenCalledWith(id, 1000);
    f.config.admissionEnabled = false;
    expect(await f.service.wake(id, { ...f.caller, role: 'relay' })).toBe('paused');
    expect(f.repository.admit).not.toHaveBeenCalled();
  });
  it('fences an admitted request returned to draft without changing PR readiness', async () => {
    const f = fixture('admitted'); f.current.mockResolvedValue({ status: 'waiting' });
    expect(await f.service.wake(id, { ...f.caller, role: 'relay' })).toBe('recorded');
    expect(f.repository.supersede).toHaveBeenCalledOnce();
  });
  it('binds signed caller execution only after GitHub readback and locked freshness validation', async () => {
    const f = fixture('admitted'); f.config.admissionEnabled = false;
    expect(await f.service.claim(id, 1, f.caller)).toEqual({ version: 'ReviewCiClaim.v1', allowed: true, requestId: id, epoch: 1,
      candidateSha: f.binding.candidateSha, headSha: f.request.review.headSha, baseSha: f.request.review.baseSha,
      lanes: ['unit'], lanePlanDigest: configured.lanePlan.digest });
    expect(f.client.readRun).toHaveBeenCalledWith({ requestId: id, epoch: 1, runId: 100, runAttempt: 1 });
    expect(f.repository.claimExecution).toHaveBeenCalledWith(f.execution, expect.any(Function), 1000);
  });
  it('rejects wrong epochs, workflow revision, and already-consumed different execution', async () => {
    const f = fixture('admitted');
    expect(await f.service.claim(id, 2, f.caller)).toBeNull();
    expect(await f.service.claim(id, 1, { ...f.caller, claims: { ...f.caller.claims, workflow_sha: '9'.repeat(40) } })).toBeNull();
    f.repository.claimExecution.mockResolvedValueOnce('conflict' as never);
    expect(await f.service.claim(id, 1, f.caller)).toBeNull();
    expect(f.client.dispatchWorkflow).not.toHaveBeenCalled();
  });
  it('rejects a freshness race inside the execution transaction', async () => {
    const f = fixture('admitted'); f.current.mockResolvedValue({ status: 'stale' });
    await expect(f.service.claim(id, 1, f.caller)).rejects.toThrow('no longer eligible');
  });
  it('sends repository notification before pending admission, then dispatches only its durable workflow claim', async () => {
    const f = fixture();
    f.repository.claimDelivery.mockResolvedValueOnce(f.delivery('repository')).mockResolvedValueOnce(null);
    f.repository.listPending.mockResolvedValueOnce([f.request]);
    await f.service.runOnce();
    expect(f.client.dispatchRepository.mock.invocationCallOrder[0]).toBeLessThan(f.repository.admit.mock.invocationCallOrder[0]);
    expect(f.repository.acknowledgeRepositoryDispatch).toHaveBeenCalledOnce();
    expect(f.client.dispatchWorkflow).not.toHaveBeenCalled();
  });
  it('does not retry uncertain workflow POST until the old epoch is fenced after negative readback', async () => {
    const f = fixture('admitted');
    f.repository.claimDelivery.mockResolvedValueOnce(null).mockResolvedValueOnce(f.delivery('workflow', 'reconcile'));
    await f.service.runOnce();
    expect(f.client.dispatchWorkflow).not.toHaveBeenCalled();
    expect(f.repository.retryUncertainDelivery).toHaveBeenCalledWith(expect.any(Object), {
      outcome: 'absent', requestId: id, epoch: 1, kind: 'workflow', observedAt: 1000 }, 1000, 5000);
  });
  it('correlates late ACK to the exact run without another POST', async () => {
    const f = fixture('admitted'); f.client.correlateRun.mockResolvedValue({ runId: 100, runAttempt: 1 });
    f.repository.claimDelivery.mockResolvedValueOnce(null).mockResolvedValueOnce(f.delivery('workflow', 'reconcile'));
    await f.service.runOnce();
    expect(f.repository.acknowledgeWorkflowDispatch).toHaveBeenCalledWith(expect.any(Object), f.execution, 1000, 5000);
    expect(f.client.dispatchWorkflow).not.toHaveBeenCalled();
  });
  it('re-reads terminal jobs through GitHub, never a receiver verdict', async () => {
    const f = fixture('running'); f.client.readRun.mockResolvedValue({ status: 'completed' });
    f.client.readTerminalReceipt.mockResolvedValue({ execution: f.execution, conclusion: 'failure' });
    expect(await f.service.wake(id, { ...f.caller, role: 'relay' })).toBe('recorded');
    expect(f.repository.recordTerminalReceipt).toHaveBeenCalledWith({ execution: f.execution, conclusion: 'failure' }, expect.any(Function), 1000);
    expect(f.current).toHaveBeenCalledTimes(2);
  });
  it('advances a bounded cursor past idle work and wraps without overlapping sweeps', async () => {
    const f = fixture(); f.current.mockResolvedValue({ status: 'waiting' });
    f.repository.listPending.mockResolvedValueOnce([f.request]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const first = f.service.runOnce(); expect(f.service.runOnce()).toBe(first); await first;
    await f.service.runOnce(); await f.service.runOnce();
    expect(f.repository.listPending.mock.calls).toEqual([[25, undefined], [25, id], [25, undefined]]);
  });
});
