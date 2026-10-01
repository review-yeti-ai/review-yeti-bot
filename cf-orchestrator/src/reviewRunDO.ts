import type { Env, ReviewRunSpec, ReviewRunState } from './types.js';

interface InternalReviewRunState extends ReviewRunState {
  jobId?: string;
}

export class ReviewRunDO {
  private state: DurableObjectState;
  private env: Env;
  private runState: InternalReviewRunState | null = null;
  private initialized: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.initialized = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<InternalReviewRunState>('runState');
      if (stored) {
        this.runState = stored;
      }
    });
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialized;
  }

  async initialize(spec: ReviewRunSpec): Promise<ReviewRunState> {
    await this.ensureInitialized();
    if (this.runState) {
      if (!this.runState.spec?.headSha && spec?.headSha) {
        this.runState.spec = spec;
        await this.state.storage.put('runState', this.runState);
      }
      return this.runState;
    }

    this.runState = {
      spec,
      phase: 'Pending',
      fencingEpoch: 1,
      cancelRequested: false,
      startedAt: Date.now(),
    };

    await this.state.storage.put('runState', this.runState);
    return this.runState;
  }

  async acquireWorkerLease(
    workerId: string,
    epoch: number,
    durationMs = 30_000,
    jobId?: string
  ): Promise<{ ok: boolean; reason?: string; leaseExpiresAt?: number; fencingEpoch?: number }> {
    await this.ensureInitialized();
    if (!this.runState) {
      return { ok: false, reason: 'uninitialized' };
    }

    if (this.runState.cancelRequested || this.runState.phase === 'Cancelled') {
      return { ok: false, reason: 'cancel_requested' };
    }

    if (epoch !== this.runState.fencingEpoch) {
      return { ok: false, reason: 'fencing_epoch_mismatch' };
    }

    // Challenger check: do not overwrite an active, unexpired lease held by another worker
    if (
      this.runState.workerId &&
      this.runState.workerId !== workerId &&
      this.runState.leaseExpiresAt &&
      Date.now() < this.runState.leaseExpiresAt
    ) {
      return { ok: false, reason: 'lease_already_held' };
    }

    this.runState.workerId = workerId;
    if (jobId) {
      this.runState.jobId = jobId;
    }
    this.runState.phase = 'Running';
    this.runState.leaseExpiresAt = Date.now() + durationMs;
    await this.state.storage.put('runState', this.runState);
    return {
      ok: true,
      leaseExpiresAt: this.runState.leaseExpiresAt,
      fencingEpoch: this.runState.fencingEpoch,
    };
  }

  async heartbeat(
    workerId: string,
    epoch: number,
    durationMs = 30_000
  ): Promise<{ ok: boolean; reason?: string; leaseExpiresAt?: number }> {
    await this.ensureInitialized();
    if (!this.runState) {
      return { ok: false, reason: 'uninitialized' };
    }

    if (this.runState.cancelRequested || this.runState.phase === 'Cancelled') {
      return { ok: false, reason: 'cancel_requested' };
    }

    if (epoch !== this.runState.fencingEpoch) {
      return { ok: false, reason: 'fencing_epoch_mismatch' };
    }

    if (this.runState.workerId !== workerId) {
      return { ok: false, reason: 'worker_id_mismatch' };
    }

    if (this.runState.leaseExpiresAt && Date.now() > this.runState.leaseExpiresAt) {
      return { ok: false, reason: 'lease_expired' };
    }

    this.runState.leaseExpiresAt = Date.now() + durationMs;
    await this.state.storage.put('runState', this.runState);
    return { ok: true, leaseExpiresAt: this.runState.leaseExpiresAt };
  }

  async requestCancellation(
    reason: string
  ): Promise<{ cancelled: boolean; previousPhase: string; fencingEpoch?: number; jobId?: string }> {
    await this.ensureInitialized();
    if (!this.runState) {
      const tombstone: ReviewRunState = {
        spec: {
          runId: '',
          owner: '',
          repo: '',
          prNumber: 0,
          headSha: '',
          baseSha: '',
          installationId: 0,
        },
        phase: 'Cancelled',
        fencingEpoch: 2,
        cancelRequested: true,
        cancelReason: reason,
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
      this.runState = tombstone;
      await this.state.storage.put('runState', this.runState);
      return {
        cancelled: false,
        previousPhase: 'Uninitialized',
        fencingEpoch: tombstone.fencingEpoch,
      };
    }

    if (this.runState.phase === 'Cancelled') {
      return {
        cancelled: true,
        previousPhase: 'Cancelled',
        fencingEpoch: this.runState.fencingEpoch,
        jobId: this.runState.jobId,
      };
    }

    if (this.runState.phase === 'Completed' || this.runState.phase === 'Failed') {
      return {
        cancelled: false,
        previousPhase: this.runState.phase,
      };
    }

    const previousPhase = this.runState.phase;
    this.runState.cancelRequested = true;
    this.runState.cancelReason = reason;
    this.runState.phase = 'Cancelled';
    // Bumping fencing epoch immediately invalidates any in-flight worker writes or heartbeats
    this.runState.fencingEpoch += 1;
    this.runState.completedAt = Date.now();

    await this.state.storage.put('runState', this.runState);
    return {
      cancelled: true,
      previousPhase,
      fencingEpoch: this.runState.fencingEpoch,
      jobId: this.runState.jobId,
    };
  }

  async submitReceipt(
    receipt: any,
    epoch?: number
  ): Promise<{ accepted: boolean; reason?: string }> {
    await this.ensureInitialized();
    if (!this.runState) {
      return { accepted: false, reason: 'uninitialized' };
    }

    if (this.runState.cancelRequested || this.runState.phase === 'Cancelled') {
      return { accepted: false, reason: 'run_cancelled' };
    }

    if (epoch !== undefined && epoch !== this.runState.fencingEpoch) {
      return { accepted: false, reason: 'fencing_epoch_mismatch' };
    }

    if (receipt?.fencingEpoch !== undefined && receipt.fencingEpoch !== this.runState.fencingEpoch) {
      return { accepted: false, reason: 'fencing_epoch_mismatch' };
    }

    if (this.runState.phase === 'Completed' || this.runState.phase === 'Failed') {
      return { accepted: false, reason: 'already_terminal' };
    }

    this.runState.terminalReceipt = receipt;
    const isSuccess =
      receipt?.status === 'succeeded' ||
      receipt?.verdict === 'success' ||
      receipt?.verdict === 'neutral' ||
      receipt?.verdict === 'action_required';

    this.runState.phase = isSuccess ? 'Completed' : 'Failed';
    this.runState.completedAt = Date.now();
    await this.state.storage.put('runState', this.runState);
    return { accepted: true };
  }

  async getStatus(): Promise<{
    isCurrentHead: boolean;
    phase: string;
    cancelRequested: boolean;
    cancelReason?: string;
    fencingEpoch: number;
    headSha?: string;
    workerId?: string;
    jobId?: string;
  }> {
    await this.ensureInitialized();
    if (!this.runState) {
      return { isCurrentHead: false, phase: 'Unknown', cancelRequested: true, fencingEpoch: 0 };
    }

    return {
      isCurrentHead: !this.runState.cancelRequested && this.runState.phase !== 'Cancelled',
      phase: this.runState.phase,
      cancelRequested: this.runState.cancelRequested,
      cancelReason: this.runState.cancelReason,
      fencingEpoch: this.runState.fencingEpoch,
      headSha: this.runState.spec.headSha,
      workerId: this.runState.workerId,
      jobId: this.runState.jobId,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/init') {
      const spec = (await request.json()) as ReviewRunSpec;
      const res = await this.initialize(spec);
      return Response.json({ ok: true, state: res, ...res });
    }

    if (request.method === 'POST' && path === '/lease/acquire') {
      const body = (await request.json()) as {
        workerId: string;
        epoch: number;
        durationMs?: number;
        jobId?: string;
      };
      const res = await this.acquireWorkerLease(body.workerId, body.epoch, body.durationMs, body.jobId);
      return Response.json(res);
    }

    if (request.method === 'POST' && path === '/lease/heartbeat') {
      const body = (await request.json()) as {
        workerId: string;
        epoch: number;
        durationMs?: number;
      };
      const res = await this.heartbeat(body.workerId, body.epoch, body.durationMs);
      return Response.json(res);
    }

    if (request.method === 'POST' && path === '/cancel') {
      const body = (await request.json()) as { reason: string };
      const res = await this.requestCancellation(body.reason);
      return Response.json(res);
    }

    if (request.method === 'POST' && path === '/receipt') {
      const body = (await request.json()) as any;
      const receipt = body?.receipt !== undefined ? body.receipt : body;
      const epoch = body?.epoch;
      const res = await this.submitReceipt(receipt, epoch);
      return Response.json(res);
    }

    if (request.method === 'GET' && (path === '/status' || path.endsWith('/status'))) {
      const res = await this.getStatus();
      return Response.json(res);
    }

    return new Response('Not Found', { status: 404 });
  }
}

