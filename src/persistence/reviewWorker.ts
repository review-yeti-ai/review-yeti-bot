import { sha256 } from '../review/reviewCore';
import { PI_STAGE_CONTRACTS, PI_STAGES, ExecutablePiStage } from '../review/piWorkflow';
import type { JsonValue, ReviewRun, ReviewStageContext } from '../review/reviewRun';
import type { ReviewArtifactStore } from './reviewArtifactStore';
import type { ReviewRunRepository } from './reviewRunRepository';

export type ReviewStageExecutor = (stage: ExecutablePiStage, context: ReviewStageContext) => Promise<JsonValue>;

export interface ReviewWorkerOptions {
  repository: ReviewRunRepository;
  artifacts: ReviewArtifactStore;
  executeStage: ReviewStageExecutor;
  now?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  maxAttempts?: number;
}

export class ReviewWorker {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: ReviewWorkerOptions) {
    this.now = options.now || (() => Date.now());
    this.leaseMs = options.leaseMs || 30_000;
    this.heartbeatMs = options.heartbeatMs || Math.max(1_000, Math.floor(this.leaseMs / 3));
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async claimAndRun(runId: string, workerId: string): Promise<ReviewRun | null> {
    const existing = await this.options.repository.get(runId);
    if (existing?.status === 'failed') {
      const contract = PI_STAGE_CONTRACTS[existing.stage as ExecutablePiStage];
      if (!contract?.retryable || existing.attempt >= this.maxAttempts) return null;
    }
    let run = await this.options.repository.claim(runId, workerId, this.now(), this.leaseMs, this.maxAttempts);
    if (!run) return null;
    let heartbeatFailure: Error | null = null;
    const heartbeat = async (): Promise<void> => {
      try {
        if (!await this.options.repository.heartbeat(runId, workerId, this.now(), this.leaseMs)) {
          heartbeatFailure = new Error(`review run ${runId} lease is no longer active`);
        }
      } catch (error) {
        heartbeatFailure = error instanceof Error ? error : new Error(String(error));
      }
    };
    const requireActiveLease = async (): Promise<void> => {
      if (heartbeatFailure) throw heartbeatFailure;
      await heartbeat();
      if (heartbeatFailure) throw heartbeatFailure;
    };
    const timer = setInterval(() => {
      void heartbeat();
    }, this.heartbeatMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    let retryableStageFailure = false;
    try {
      const payloads: Partial<Record<ExecutablePiStage, JsonValue>> = {};
      for (const priorStage of PI_STAGES) {
        if (priorStage === run.stage || priorStage === 'complete') break;
        const payload = await this.options.artifacts.get(run.runId, priorStage);
        this.verifyArtifactPointer(run, priorStage, payload, true);
        payloads[priorStage] = payload;
      }

      while (run.stage !== 'complete') {
        const stage = run.stage as ExecutablePiStage;
        const contract = PI_STAGE_CONTRACTS[stage];
        retryableStageFailure = contract.retryable;
        if (stage === 'publish') {
          const publicationClaim = await this.options.repository.claimPublication(run.runId, workerId, this.now());
          if (!publicationClaim) return this.options.repository.get(run.runId);
          run = publicationClaim;
        }
        const persisted = await this.options.artifacts.get(run.runId, stage);
        this.verifyArtifactPointer(run, stage, persisted, false);
        if (!contract.validateInput({ ...payloads })) throw new Error(`Pi ${stage} stage received invalid input artifacts`);
        let digest: string;

        if (persisted === null) {
          await requireActiveLease();
          let output: JsonValue;
          try {
            output = await this.options.executeStage(stage, {
              run,
              artifacts: payloads,
              publicationFence: run.publicationFence,
            });
          } catch (error) {
            retryableStageFailure = contract.retryable;
            throw error;
          }
          await requireActiveLease();
          if (!contract.validateOutput(output)) throw new Error(`Pi ${stage} stage returned an invalid artifact`);
          digest = await this.options.artifacts.put(run.runId, stage, output);
          payloads[stage] = output;
        } else {
          digest = sha256(persisted);
          payloads[stage] = persisted;
        }

        await requireActiveLease();
        run = await this.options.repository.recordArtifact(run.runId, stage, digest, workerId, this.now());
        if (stage === 'publish') return this.options.repository.succeed(run.runId, workerId, this.now(), digest);
        const nextStage = PI_STAGES[PI_STAGES.indexOf(stage) + 1];
        run = await this.options.repository.transition(run.runId, nextStage, workerId, this.now());
      }
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (retryableStageFailure && run.attempt < this.maxAttempts) {
          return await this.options.repository.requeue(runId, workerId, this.now(), message);
        }
        return await this.options.repository.fail(runId, workerId, this.now(), message);
      } catch {
        return this.options.repository.get(runId);
      }
    } finally {
      clearInterval(timer);
    }
  }

  private verifyArtifactPointer(
    run: ReviewRun,
    stage: ExecutablePiStage,
    payload: JsonValue | null,
    pointerRequired: boolean,
  ): void {
    const expected = run.artifacts[stage];
    if (payload === null) {
      if (expected || pointerRequired) throw new Error(`Pi ${stage} artifact pointer does not resolve to a persisted payload`);
      return;
    }
    const actual = sha256(payload);
    if ((pointerRequired && !expected) || (expected && expected !== actual)) {
      throw new Error(`Pi ${stage} artifact pointer does not match its persisted payload`);
    }
  }
}
