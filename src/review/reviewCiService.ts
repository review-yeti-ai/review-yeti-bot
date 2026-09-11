import { sha256 } from './reviewCore';
import { findReviewCiEnrollment, reviewCiExecutionSchema, reviewCiRequestEvent, reviewCiRunName,
  type ReviewCiCaller, type ReviewCiClient, type ReviewCiDeliveryClaim, type ReviewCiExecution, type ReviewCiRepository, type ReviewCiValidationBinding,
  type ReviewCiServiceConfig, type StoredReviewCiRequest } from './reviewCi';

export type ReviewCiCurrent = { status: 'stale' | 'waiting' }
  | { status: 'ready'; binding: ReviewCiValidationBinding };
export interface ReviewCiServiceOptions {
  config: ReviewCiServiceConfig;
  repository: ReviewCiRepository;
  workerId: string;
  /** All GitHub and policy truth is service-owned, bounded, and re-read while
   * persistence holds the PR lock before admission/execution/terminal writes. */
  current(request: StoredReviewCiRequest): Promise<ReviewCiCurrent>;
  clientFor(request: StoredReviewCiRequest, purpose: 'repository-dispatch' | 'workflow-dispatch' | 'read'):
    Promise<ReviewCiClient>;
  now?: () => number;
}

/** Event hints and the existing service sweep converge here. There is no
 * runner-held wait, timer-driven Actions job, or candidate-controlled verdict. */
export class ReviewCiService {
  private active?: Promise<void>;
  private cursor?: string;
  private readonly now: () => number;
  constructor(private readonly options: ReviewCiServiceOptions) { this.now = options.now ?? Date.now; }

  private enrolled(request: StoredReviewCiRequest): void {
    if (!findReviewCiEnrollment(this.options.config,
      { expectedAppId: request.expectedAppId, repository: request.review })) {
      throw new Error('Review CI request is outside enrollment');
    }
  }
  private async validate(request: StoredReviewCiRequest, binding = request.binding): Promise<void> {
    this.enrolled(request);
    const current = await this.options.current(request);
    if (!binding || current.status !== 'ready' || sha256(binding) !== sha256(current.binding)) {
      throw new Error('Review CI request is no longer eligible');
    }
  }
  private execution(request: StoredReviewCiRequest, runId: number, runAttempt: number, epoch = request.workflowEpoch): ReviewCiExecution {
    if (!request.binding) throw new Error('Review CI execution has no admission');
    return reviewCiExecutionSchema.parse({ requestId: request.requestId, epoch,
      repositoryId: request.review.repositoryId, workflowId: request.binding.workflowId,
      workflowSha: request.binding.workflowSha, candidateSha: request.binding.candidateSha,
      runId, runAttempt, event: 'workflow_dispatch', runName: reviewCiRunName(request.requestId, epoch) });
  }
  async wake(requestId: string, caller: ReviewCiCaller): Promise<string> {
    if (caller.role !== 'relay') throw new Error('Review CI wake caller is not a relay');
    const request = await this.options.repository.get(requestId);
    if (!request || request.review.repositoryId !== caller.repository.repositoryId) return 'ignored';
    this.enrolled(request);
    return this.reconcile(request);
  }
  async claim(requestId: string, epoch: number, caller: ReviewCiCaller): Promise<{
    version: 'ReviewCiClaim.v1'; allowed: true; requestId: string; epoch: number;
    candidateSha: string; headSha: string; baseSha: string; lanes: string[]; lanePlanDigest: string;
  } | null> {
    if (caller.role !== 'validation') throw new Error('Review CI execution caller is not a validation workflow');
    const request = await this.options.repository.get(requestId);
    if (!request || !request.binding || request.review.repositoryId !== caller.repository.repositoryId
      || request.workflowEpoch !== epoch) return null;
    this.enrolled(request);
    const binding = request.binding;
    if (binding.workflowId !== caller.repository.validation.workflowId
      || binding.workflowSha !== caller.workflowSha) return null;
    const execution = this.execution(request, caller.runId, caller.runAttempt, epoch);
    // Signed OIDC alone does not prove the dispatched run's exact event/title.
    const client = await this.options.clientFor(request, 'read');
    await client.readRun({ requestId, epoch, runId: caller.runId, runAttempt: caller.runAttempt });
    const status = await this.options.repository.claimExecution(execution,
      (current) => this.validate(current), this.now());
    if (status !== 'recorded' && status !== 'duplicate') return null;
    return { version: 'ReviewCiClaim.v1', allowed: true, requestId, epoch,
      candidateSha: binding.candidateSha, headSha: request.review.headSha, baseSha: request.review.baseSha,
      lanes: [...binding.lanePlan.lanes], lanePlanDigest: binding.lanePlan.digest };
  }
  private async reconcile(request: StoredReviewCiRequest): Promise<string> {
    this.enrolled(request);
    if (!['pending', 'admitted', 'running'].includes(request.state)) return 'terminal';
    const current = await this.options.current(request);
    if (current.status === 'stale' || (current.status === 'waiting' && request.state !== 'pending')) {
      return this.options.repository.supersede(request.requestId, this.now());
    }
    if (current.status !== 'ready') return 'waiting';
    if (request.state === 'pending') {
      if (!this.options.config.admissionEnabled) return 'paused';
      return this.options.repository.admit(request.requestId, current.binding,
        (locked, binding) => this.validate(locked, binding), this.now());
    }
    if (sha256(request.binding) !== sha256(current.binding)) {
      return this.options.repository.supersede(request.requestId, this.now());
    }
    if (request.state === 'running' && request.execution) {
      const client = await this.options.clientFor(request, 'read');
      const observed = await client.readRun({ requestId: request.requestId, epoch: request.workflowEpoch,
        runId: request.execution.runId, runAttempt: request.execution.runAttempt });
      if (observed.status !== 'completed') return 'running';
      const receipt = await client.readTerminalReceipt(request.execution);
      return this.options.repository.recordTerminalReceipt(receipt, (locked) => this.validate(locked), this.now());
    }
    return 'admitted';
  }
  private async deliver(claim: ReviewCiDeliveryClaim): Promise<void> {
    const { repository } = this.options;
    const request = claim.request;
    this.enrolled(request);
    if (claim.kind === 'repository') {
      if (claim.mode === 'reconcile') {
        // Delivery ACK loss is recovered by service truth. Duplicate hints can
        // never allocate another validation identity or execution claim.
        await this.reconcile(request);
        await repository.acknowledgeRepositoryDispatch(claim, this.now());
        return;
      }
      const client = await this.options.clientFor(request, 'repository-dispatch');
      const result = await client.dispatchRepository(reviewCiRequestEvent(request));
      if (result.status === 'accepted') await repository.acknowledgeRepositoryDispatch(claim, this.now());
      else if (result.status === 'rejected') await repository.rejectDelivery(claim, this.now());
      else await repository.markDeliveryUncertain(claim, 'transport', this.now(), 5_000);
      return;
    }
    await this.validate(request);
    const correlation = { requestId: request.requestId, epoch: claim.epoch };
    let run: { runId: number; runAttempt: number } | null = null;
    const readClient = await this.options.clientFor(request, 'read');
    if (claim.mode === 'dispatch') {
      const writeClient = await this.options.clientFor(request, 'workflow-dispatch');
      const result = await writeClient.dispatchWorkflow(correlation);
      if (result.status === 'accepted' && result.runId) {
        const readback = await readClient.readRun({ ...correlation, runId: result.runId, runAttempt: 1 });
        run = { runId: readback.runId, runAttempt: readback.runAttempt };
      } else if (result.status === 'rejected') {
        await repository.rejectDelivery(claim, this.now());
        return;
      } else {
        await repository.markDeliveryUncertain(claim, 'transport', this.now(), 5_000);
        return;
      }
    } else {
      run = await readClient.correlateRun(correlation);
      if (!run) {
        // An empty listing is not proof GitHub did not accept the POST. The
        // repository fences the old epoch before permitting a bounded retry.
        await repository.retryUncertainDelivery(claim, { outcome: 'absent', ...correlation,
          kind: 'workflow', observedAt: this.now() }, this.now(), 5_000);
        return;
      }
    }
    if (run) await repository.acknowledgeWorkflowDispatch(claim, this.execution(request, run.runId, run.runAttempt), this.now(), 5_000);
  }
  runOnce(): Promise<void> {
    if (!this.active) this.active = this.tick().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async tick(): Promise<void> {
    const { repository, config } = this.options;
    const failures: unknown[] = [];
    const deliverOne = async (kind: 'repository' | 'workflow') => {
      const claim = await repository.claimDelivery(kind, this.options.workerId, this.now(), 120_000);
      if (!claim) return;
      try { await this.deliver(claim); }
      catch (error) {
        failures.push(error);
        await repository.markDeliveryUncertain(claim, 'transport', this.now(), 5_000).catch(() => undefined);
      }
    };
    // Commit and emit the completion notification before admission. Persistence
    // also requires this first-hop intent, including its uncertain-ACK state.
    if (config.repositoryDispatchEnabled) await deliverOne('repository');
    const pending = await repository.listPending(25, this.cursor);
    this.cursor = pending.length ? pending[pending.length - 1].requestId : undefined;
    // One unavailable repository does not prevent other enrolled work draining.
    for (const request of pending) {
      try { await this.reconcile(request); } catch (error) { failures.push(error); }
    }
    await deliverOne('workflow');
    if (failures.length) throw new Error('Review CI reconciliation is temporarily unavailable');
  }
}
