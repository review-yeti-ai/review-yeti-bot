import { redactTokens } from './r2WorkspaceCache.js';
import { type RunnerCostDetails, calculateRunnerCost } from './runnerCost.js';
export type { RunnerCostDetails };

export interface ContainerJobSpec {
  jobId: string;
  runId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  workerImage: string;
  env: Record<string, string>;
  cpu?: number;
  memoryMb?: number;
  timeoutSeconds?: number;
}

export interface ContainerJobResult {
  jobId: string;
  exitCode: number;
  durationMs: number;
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  outputLog?: string;
  receipt?: any;
  error?: string;
  runnerCost?: RunnerCostDetails;
}

export interface ContainerRunner {
  dispatchJob(spec: ContainerJobSpec): Promise<ContainerJobResult>;
  terminateJob(jobId: string, reason?: string): Promise<{ terminated: boolean }>;
}

export interface CloudflareContainerRunnerOptions {
  containersBinding?: any;
  allowStubFallback?: boolean;
  defaultTimeoutSeconds?: number;
  fallbackRunner?: ContainerRunner;
}

/**
 * Cloudflare Containers Runner
 * Dispatches to Cloudflare Containers via edge service binding / @cloudflare/computer
 */
export class CloudflareContainerRunner implements ContainerRunner {
  private containersBinding?: any;
  private allowStubFallback: boolean;
  private defaultTimeoutSeconds: number;
  private fallbackRunner?: ContainerRunner;
  private activeJobs = new Map<string, any>();

  constructor(bindingOrOptions?: any) {
    if (
      bindingOrOptions &&
      typeof bindingOrOptions === 'object' &&
      ('containersBinding' in bindingOrOptions ||
        'allowStubFallback' in bindingOrOptions ||
        'fallbackRunner' in bindingOrOptions)
    ) {
      this.containersBinding = bindingOrOptions.containersBinding;
      this.allowStubFallback = bindingOrOptions.allowStubFallback ?? false;
      this.defaultTimeoutSeconds = bindingOrOptions.defaultTimeoutSeconds ?? 1500;
      this.fallbackRunner = bindingOrOptions.fallbackRunner;
    } else {
      this.containersBinding = bindingOrOptions;
      this.allowStubFallback = false;
      this.defaultTimeoutSeconds = 1500;
    }
  }

  async dispatchJob(spec: ContainerJobSpec): Promise<ContainerJobResult> {
    const startedAt = Date.now();

    // Validate container binding
    if (!this.containersBinding || typeof this.containersBinding.create !== 'function') {
      if (this.fallbackRunner) {
        return this.fallbackRunner.dispatchJob(spec);
      }
      if (this.allowStubFallback) {
        const durationMs = Date.now() - startedAt;
        return {
          jobId: spec.jobId,
          exitCode: 0,
          durationMs,
          status: 'succeeded',
          runnerCost: calculateRunnerCost({
            durationMs,
            runnerType: 'cloudflare',
            vcpus: spec.cpu ?? 2,
            memoryMb: spec.memoryMb ?? 2048,
          }),
        };
      }
      const durationMs = Date.now() - startedAt;
      return {
        jobId: spec.jobId,
        exitCode: 1,
        durationMs,
        status: 'failed',
        error: 'Cloudflare Containers binding unavailable: create method not found on binding',
        runnerCost: calculateRunnerCost({
          durationMs,
          runnerType: 'cloudflare',
          vcpus: spec.cpu ?? 2,
          memoryMb: spec.memoryMb ?? 2048,
        }),
      };
    }

    try {
      const timeoutSec = spec.timeoutSeconds ?? this.defaultTimeoutSeconds;
      const instance = await this.containersBinding.create({
        image: spec.workerImage,
        cpu: spec.cpu ?? 2,
        memory: `${spec.memoryMb ?? 2048}MB`,
        env: spec.env,
        timeout: timeoutSec,
      });

      // Track active instance for termination signal propagation
      this.activeJobs.set(spec.jobId, instance);

      let outcome: any;
      try {
        outcome = await instance.wait();
      } finally {
        this.activeJobs.delete(spec.jobId);
      }

      const durationMs = Date.now() - startedAt;
      const exitCode = outcome?.exitCode ?? 0;

      // Extract output logs if available
      let outputLog = outcome?.outputLog ?? outcome?.logs;
      if (!outputLog && typeof instance?.logs === 'function') {
        try {
          outputLog = await instance.logs();
        } catch {
          // Log extraction is non-fatal
        }
      }

      // Parse stringified receipt if present
      let receipt = outcome?.receipt;
      if (typeof receipt === 'string') {
        try {
          receipt = JSON.parse(receipt);
        } catch {
          // Pass raw string if not JSON
        }
      }

      // Map outcome status with full coverage for timeouts, cancellations, and failures
      let status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
      if (outcome?.status === 'timed_out' || outcome?.timedOut === true || exitCode === 124) {
        status = 'timed_out';
      } else if (outcome?.status === 'cancelled' || outcome?.cancelled === true || exitCode === 137) {
        status = 'cancelled';
      } else if (outcome?.status === 'failed' || exitCode !== 0) {
        status = 'failed';
      } else {
        status = 'succeeded';
      }

      const runnerCost = calculateRunnerCost({
        durationMs,
        runnerType: 'cloudflare',
        vcpus: spec.cpu ?? 2,
        memoryMb: spec.memoryMb ?? 2048,
      });

      return {
        jobId: spec.jobId,
        exitCode,
        durationMs,
        status,
        outputLog: outputLog ? redactTokens(outputLog) : undefined,
        receipt,
        error: outcome?.error ? redactTokens(outcome.error) : undefined,
        runnerCost,
      };
    } catch (err: any) {
      this.activeJobs.delete(spec.jobId);
      const isTimeout = err?.name === 'TimeoutError' || /timed?\s*out/i.test(err?.message || '');
      const isCancelled = err?.name === 'AbortError' || /cancelled|aborted|terminated/i.test(err?.message || '');
      const durationMs = Date.now() - startedAt;

      const runnerCost = calculateRunnerCost({
        durationMs,
        runnerType: 'cloudflare',
        vcpus: spec.cpu ?? 2,
        memoryMb: spec.memoryMb ?? 2048,
      });

      return {
        jobId: spec.jobId,
        exitCode: isTimeout ? 124 : (isCancelled ? 137 : 1),
        durationMs,
        status: isTimeout ? 'timed_out' : (isCancelled ? 'cancelled' : 'failed'),
        error: redactTokens(err?.message || String(err)),
        runnerCost,
      };
    }
  }

  async terminateJob(jobId: string, reason?: string): Promise<{ terminated: boolean }> {
    if (!this.containersBinding || typeof this.containersBinding.create !== 'function') {
      if (this.fallbackRunner) {
        return this.fallbackRunner.terminateJob(jobId, reason);
      }
    }

    const cancelReason = reason || 'superseded_or_closed';
    let instanceTerminated = false;
    let bindingTerminated = false;

    // 1. Terminate tracked running instance handle if available
    const activeInstance = this.activeJobs.get(jobId);
    if (activeInstance && typeof activeInstance.terminate === 'function') {
      try {
        await activeInstance.terminate({ reason: cancelReason });
        instanceTerminated = true;
      } catch {
        // Fall back to binding termination
      }
    }

    // 2. Terminate via binding-level method if supported
    if (this.containersBinding && typeof this.containersBinding.terminate === 'function') {
      try {
        await this.containersBinding.terminate(jobId, { reason: cancelReason });
        bindingTerminated = true;
      } catch {
        // If instance termination already succeeded, ignore binding failure; otherwise return false
        if (!instanceTerminated) {
          return { terminated: false };
        }
      }
    }

    // 3. If either termination tier succeeded
    if (instanceTerminated || bindingTerminated) {
      return { terminated: true };
    }

    // 4. If neither method exists but no error was raised (graceful no-op when job is not active)
    if (!activeInstance && (!this.containersBinding || typeof this.containersBinding.terminate !== 'function')) {
      return { terminated: true };
    }

    return { terminated: false };
  }
}

/**
 * Mock Container Runner for testing & dry runs
 */
export class MockContainerRunner implements ContainerRunner {
  public dispatched: ContainerJobSpec[] = [];
  public terminated: string[] = [];
  public nextResult: Partial<ContainerJobResult> = {};

  async dispatchJob(spec: ContainerJobSpec): Promise<ContainerJobResult> {
    this.dispatched.push(spec);
    const durationMs = this.nextResult.durationMs ?? 150;
    return {
      jobId: spec.jobId,
      exitCode: this.nextResult.exitCode ?? 0,
      durationMs,
      status: this.nextResult.status ?? 'succeeded',
      outputLog: this.nextResult.outputLog,
      receipt: this.nextResult.receipt ?? {
        version: 'ReviewYetiReceiptOnly.v1',
        status: 'succeeded',
        runId: spec.runId,
        repo: `${spec.owner}/${spec.repo}`,
        prNumber: spec.prNumber,
        headSha: spec.headSha,
      },
      error: this.nextResult.error,
      runnerCost:
        this.nextResult.runnerCost ??
        calculateRunnerCost({
          durationMs,
          runnerType: 'cloudflare',
          vcpus: spec.cpu ?? 2,
          memoryMb: spec.memoryMb ?? 2048,
        }),
    };
  }

  async terminateJob(jobId: string): Promise<{ terminated: boolean }> {
    this.terminated.push(jobId);
    return { terminated: true };
  }
}
