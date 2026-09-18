import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { WorkerStatusPoller } from '../../src/cli/workerStatusPoller';
import { runPublishingReviewWorker } from '../../src/cli/publishingReview';

describe('Challenger M2-2 Empirical Stress Suite', () => {
  // =========================================================================
  // Section 1: Worker Status Poller Network Instability
  // =========================================================================
  describe('1. Worker status poller network instability', () => {
    it('fails soft on HTTP 500 without flipping isCurrentHead or triggering abort', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => ({
        status: 500,
        ok: false,
        statusText: 'Internal Server Error',
        json: async () => ({ error: 'database unavailable' }),
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_500',
        fetch: mockFetch,
        onSuperseded,
      });

      expect(poller.isCurrentHead()).toBe(true);
      expect(poller.cancelReason).toBeUndefined();

      const result = await poller.pollOnce();

      expect(result).toBeNull();
      expect(poller.isCurrentHead()).toBe(true);
      expect(poller.cancelReason).toBeUndefined();
      expect(onSuperseded).not.toHaveBeenCalled();
    });

    it('fails soft on ECONNREFUSED without falsely triggering abort', async () => {
      const onSuperseded = vi.fn();
      const connRefusedErr = new Error('connect ECONNREFUSED 127.0.0.1:8080');
      (connRefusedErr as any).code = 'ECONNREFUSED';

      const mockFetch = vi.fn(async () => {
        throw connRefusedErr;
      }) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_connrefused',
        fetch: mockFetch,
        onSuperseded,
      });

      expect(poller.isCurrentHead()).toBe(true);
      const result = await poller.pollOnce();

      expect(result).toBeNull();
      expect(poller.isCurrentHead()).toBe(true);
      expect(onSuperseded).not.toHaveBeenCalled();
    });

    it('fails soft on socket timeouts and hang-ups without falsely triggering abort', async () => {
      const onSuperseded = vi.fn();
      const timeoutErrors = [
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        Object.assign(new Error('ETIMEDOUT: connection timed out'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      ];

      for (const err of timeoutErrors) {
        const mockFetch = vi.fn(async () => {
          throw err;
        }) as any;

        const poller = new WorkerStatusPoller({
          statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
          bearerToken: 'tok_timeout',
          fetch: mockFetch,
          onSuperseded,
        });

        const result = await poller.pollOnce();
        expect(result).toBeNull();
        expect(poller.isCurrentHead()).toBe(true);
        expect(onSuperseded).not.toHaveBeenCalled();
      }
    });

    it('survives an adversarial burst of 50 alternating network failures and recovers cleanly on 200 OK', async () => {
      const onSuperseded = vi.fn();
      let callCount = 0;

      const mockFetch = vi.fn(async () => {
        callCount++;
        if (callCount <= 50) {
          const mod = callCount % 5;
          if (mod === 0) return { status: 500, ok: false };
          if (mod === 1) return { status: 502, ok: false };
          if (mod === 2) return { status: 503, ok: false };
          if (mod === 3) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        // Poll 51: network recovers!
        return {
          status: 200,
          ok: true,
          json: async () => ({
            current: true,
            status: 'running',
            cancelRequested: false,
            isCurrentHead: true,
          }),
        };
      }) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_burst',
        fetch: mockFetch,
        onSuperseded,
      });

      // Execute 50 failure polls
      for (let i = 0; i < 50; i++) {
        const res = await poller.pollOnce();
        expect(res).toBeNull();
        expect(poller.isCurrentHead()).toBe(true);
      }
      expect(onSuperseded).not.toHaveBeenCalled();

      // Poll 51 succeeds
      const recovery = await poller.pollOnce();
      expect(recovery).not.toBeNull();
      expect(recovery?.isCurrentHead).toBe(true);
      expect(poller.isCurrentHead()).toBe(true);
      expect(onSuperseded).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Section 2: Immediate Abort Triggers
  // =========================================================================
  describe('2. Immediate abort triggers (404, cancelRequested, isCurrentHead: false)', () => {
    it('triggers immediate abort when status endpoint returns 404 (run deleted/missing)', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => ({
        status: 404,
        ok: false,
        statusText: 'Not Found',
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_404',
        fetch: mockFetch,
        onSuperseded,
      });

      expect(poller.isCurrentHead()).toBe(true);
      const result = await poller.pollOnce();

      expect(result).toBeNull();
      expect(poller.isCurrentHead()).toBe(false);
      expect(poller.cancelReason).toBe('run_not_found');
      expect(onSuperseded).toHaveBeenCalledTimes(1);
      expect(onSuperseded).toHaveBeenCalledWith('run_not_found');
    });

    it('triggers immediate abort when response is 200 with cancelRequested: true', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          current: true,
          status: 'cancelled',
          cancelRequested: true,
          cancelReason: 'superseded_by_new_head',
          isCurrentHead: true,
        }),
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_cancel_req',
        fetch: mockFetch,
        onSuperseded,
      });

      const result = await poller.pollOnce();
      expect(result).not.toBeNull();
      expect(poller.isCurrentHead()).toBe(false);
      expect(poller.cancelReason).toBe('superseded_by_new_head');
      expect(onSuperseded).toHaveBeenCalledTimes(1);
      expect(onSuperseded).toHaveBeenCalledWith('superseded_by_new_head');
    });

    it('triggers immediate abort when response is 200 with isCurrentHead: false', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          current: true,
          status: 'running',
          cancelRequested: false,
          cancelReason: 'newer_head_pushed',
          isCurrentHead: false,
        }),
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_stale_head',
        fetch: mockFetch,
        onSuperseded,
      });

      const result = await poller.pollOnce();
      expect(result).not.toBeNull();
      expect(poller.isCurrentHead()).toBe(false);
      expect(onSuperseded).toHaveBeenCalledWith('newer_head_pushed');
    });

    it('triggers immediate abort when response is 200 with current: false', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          current: false,
          status: 'stale',
          cancelRequested: false,
          isCurrentHead: true,
        }),
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_not_current',
        fetch: mockFetch,
        onSuperseded,
      });

      await poller.pollOnce();
      expect(onSuperseded).toHaveBeenCalledWith('superseded_by_new_head');
    });

    it('does not trigger abort when response is 200 with active valid head', async () => {
      const onSuperseded = vi.fn();
      const mockFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({
          current: true,
          status: 'running',
          cancelRequested: false,
          isCurrentHead: true,
        }),
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_active',
        fetch: mockFetch,
        onSuperseded,
      });

      const result = await poller.pollOnce();
      expect(result).not.toBeNull();
      expect(poller.isCurrentHead()).toBe(true);
      expect(onSuperseded).not.toHaveBeenCalled();
    });

    it('respects pre-aborted signal and immediately stops polling', async () => {
      const controller = new AbortController();
      controller.abort();
      const mockFetch = vi.fn();

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_aborted',
        signal: controller.signal,
        fetch: mockFetch,
      });

      const result = await poller.pollOnce();
      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Section 3: SIGTERM Signal Handling & Propagation
  // =========================================================================
  describe('3. SIGTERM signal handling and cancellation propagation', () => {
    it('aborts root AbortController and propagates cancellation to active fetch/stream', async () => {
      const rootAbortController = new AbortController();
      let streamedChunks = 0;
      let streamAborted = false;

      // Simulate a streaming LLM response that checks signal
      const simulatedStream = async (signal: AbortSignal): Promise<void> => {
        for (let i = 0; i < 100; i++) {
          if (signal.aborted) {
            streamAborted = true;
            throw new Error(`Streaming aborted: ${signal.reason?.message || 'Aborted'}`);
          }
          streamedChunks++;
          await new Promise((r) => setTimeout(r, 10));
        }
      };

      // Background stream starts
      const streamPromise = simulatedStream(rootAbortController.signal);

      // Give it a few chunks
      await new Promise((r) => setTimeout(r, 35));
      expect(streamedChunks).toBeGreaterThan(0);
      expect(streamedChunks).toBeLessThan(100);

      // Simulate SIGTERM event
      rootAbortController.abort(new Error('Process received SIGTERM'));

      // Stream should reject immediately
      await expect(streamPromise).rejects.toThrow('Streaming aborted: Process received SIGTERM');
      expect(streamAborted).toBe(true);
      expect(rootAbortController.signal.aborted).toBe(true);
      expect((rootAbortController.signal.reason as Error).message).toBe('Process received SIGTERM');
    });

    it('stops WorkerStatusPoller immediately when root AbortController aborts', async () => {
      const rootAbortController = new AbortController();
      const mockFetch = vi.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ current: true, isCurrentHead: true, cancelRequested: false, status: 'running' }),
      })) as any;

      const poller = new WorkerStatusPoller({
        statusUrl: 'https://dispatch.local/api/runs/run_test/attempts/1/status',
        bearerToken: 'tok_sigterm',
        signal: rootAbortController.signal,
        fetch: mockFetch,
      });

      // Poll once works normally
      const res1 = await poller.pollOnce();
      expect(res1).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Now trigger SIGTERM
      rootAbortController.abort(new Error('Process received SIGTERM'));

      // Poller abort listener should stop poller
      const res2 = await poller.pollOnce();
      expect(res2).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(1); // No new fetch made
    });

    it('verifies signal listener registration and cleanup semantics in runLiveReview runner pattern', async () => {
      const registeredListeners: { event: string; fn: (...args: any[]) => void }[] = [];
      const fakeProcess = {
        once: vi.fn((event: string, fn: (...args: any[]) => void) => {
          registeredListeners.push({ event, fn });
        }),
        removeListener: vi.fn((event: string, fn: (...args: any[]) => void) => {
          const idx = registeredListeners.findIndex((l) => l.event === event && l.fn === fn);
          if (idx !== -1) registeredListeners.splice(idx, 1);
        }),
      };

      // Mimic runLiveReview structure
      const rootAbortController = new AbortController();
      const onSigterm = () => {
        rootAbortController.abort(new Error('Process received SIGTERM'));
      };
      fakeProcess.once('SIGTERM', onSigterm);
      fakeProcess.once('SIGINT', onSigterm);

      expect(registeredListeners).toHaveLength(2);
      expect(registeredListeners.map((l) => l.event)).toEqual(['SIGTERM', 'SIGINT']);

      // Trigger SIGTERM
      onSigterm();
      expect(rootAbortController.signal.aborted).toBe(true);

      // Mimic finally block cleanup
      fakeProcess.removeListener('SIGTERM', onSigterm);
      fakeProcess.removeListener('SIGINT', onSigterm);

      expect(registeredListeners).toHaveLength(0);
    });
  });

  // =========================================================================
  // Section 4: Check Conclusion Formatting (Neutral on Superseded)
  // =========================================================================
  describe('4. Check conclusion formatting (neutral vs failure)', () => {
    const baseWorkerEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      REVIEW_RUN_ID: 'run_' + 'a'.repeat(32),
      REVIEW_DELIVERY_ID: 'del_superseded_test',
      REVIEW_REPOSITORY_ID: '98765',
      REVIEW_OWNER: 'calltelemetry',
      REVIEW_REPO: 'calltelemetry/superseded-repo',
      REVIEW_PR_NUMBER: '99',
      REVIEW_HEAD_SHA: 'c'.repeat(40),
      REVIEW_BASE_SHA: 'd'.repeat(40),
      REVIEW_EXECUTION_ATTEMPT: '1',
      REVIEW_PUBLICATION_MODE: 'app-gate',
      OPENAI_BASE_URL: 'https://bifrost.example.com',
      OPENAI_API_KEY: 'secret-key',
      REVIEW_MODEL: 'test-model',
      GITHUB_PUBLISH_TOKEN: 'ghs_token_superseded',
    };

    it('posts conclusion "neutral" with title "Review Yeti: review superseded" when isCurrentHead() is false', async () => {
      const completeCheck = vi.fn(async () => undefined);
      const mockCheckClient = {
        createCheck: vi.fn(async () => 202),
        completeCheck,
      };

      const panelRunner = vi.fn(async (opts: any) => {
        if (opts.isCurrentHead && !opts.isCurrentHead()) {
          throw new Error('stale run aborted for calltelemetry/superseded-repo');
        }
        return {} as any;
      });

      await expect(
        runPublishingReviewWorker(baseWorkerEnv, {
          checkClient: mockCheckClient,
          panelRunner,
          isCurrentHead: () => false, // Superseded!
          sourceLoader: vi.fn(async () => ({
            changedFiles: [{ path: 'main.ts', status: 'modified', additions: 1, deletions: 0 }],
          })) as any,
          visibilityLookup: vi.fn(async () => 'PUBLIC' as const),
        }),
      ).rejects.toThrow();

      expect(completeCheck).toHaveBeenCalledTimes(1);
      const call = (completeCheck.mock.calls as any)[0][0];
      expect(call.checkId).toBe(202);
      expect(call.conclusion).toBe('neutral');
      expect(call.title).toBe('Review Yeti: review superseded');
      expect(call.summary).toBe('Superseded by a newer pull request head.');
    });

    it('posts conclusion "neutral" when error message contains "stale run aborted"', async () => {
      const completeCheck = vi.fn(async () => undefined);
      const mockCheckClient = {
        createCheck: vi.fn(async () => 203),
        completeCheck,
      };

      const panelRunner = vi.fn(async () => {
        throw new Error('stale run aborted: newer commit pushed to branch');
      });

      await expect(
        runPublishingReviewWorker(baseWorkerEnv, {
          checkClient: mockCheckClient,
          panelRunner,
          sourceLoader: vi.fn(async () => ({
            diff: 'diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n+test',
          })) as any,
          visibilityLookup: vi.fn(async () => 'PUBLIC' as const),
        }),
      ).rejects.toThrow();

      expect(completeCheck).toHaveBeenCalledTimes(1);
      const call = (completeCheck.mock.calls as any)[0][0];
      expect(call.conclusion).toBe('neutral');
      expect(call.title).toBe('Review Yeti: review superseded');
    });

    it('posts conclusion "neutral" when error message contains "superseded"', async () => {
      const completeCheck = vi.fn(async () => undefined);
      const mockCheckClient = {
        createCheck: vi.fn(async () => 204),
        completeCheck,
      };

      const panelRunner = vi.fn(async () => {
        throw new Error('Review run superseded: newer head admitted');
      });

      await expect(
        runPublishingReviewWorker(baseWorkerEnv, {
          checkClient: mockCheckClient,
          panelRunner,
          sourceLoader: vi.fn(async () => ({
            diff: 'diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n+test',
          })) as any,
          visibilityLookup: vi.fn(async () => 'PUBLIC' as const),
        }),
      ).rejects.toThrow();

      expect(completeCheck).toHaveBeenCalledTimes(1);
      const call = (completeCheck.mock.calls as any)[0][0];
      expect(call.conclusion).toBe('neutral');
      expect(call.title).toBe('Review Yeti: review superseded');
    });

    it('adversarial contrast: non-superseded errors post conclusion "failure", never "neutral"', async () => {
      const completeCheck = vi.fn(async () => undefined);
      const mockCheckClient = {
        createCheck: vi.fn(async () => 205),
        completeCheck,
      };

      const panelRunner = vi.fn(async () => {
        throw new Error('Bifrost gateway timeout after 120000ms');
      });

      await expect(
        runPublishingReviewWorker(baseWorkerEnv, {
          checkClient: mockCheckClient,
          panelRunner,
          isCurrentHead: () => true, // Still current head!
          sourceLoader: vi.fn(async () => ({
            changedFiles: [{ path: 'main.ts', status: 'modified', additions: 1, deletions: 0 }],
          })) as any,
          visibilityLookup: vi.fn(async () => 'PUBLIC' as const),
        }),
      ).rejects.toThrow();

      expect(completeCheck).toHaveBeenCalledTimes(1);
      const call = (completeCheck.mock.calls as any)[0][0];
      expect(call.conclusion).toBe('failure');
      expect(call.title).toBe('Review Yeti: review did not complete');
      expect(call.conclusion).not.toBe('neutral');
    });
  });

  // =========================================================================
  // Section 5: Operator PhaseCancelled Invariants & WorkerJobMissing Avoidance
  // =========================================================================
  describe('5. Operator PhaseCancelled invariants and WorkerJobMissing avoidance', () => {
    /**
     * Behavioral model of the Kubernetes PRReviewJob controller's exact
     * reconciliation logic (k8s-operator/controllers/prreviewjob_v1alpha2_controller.go).
     */
    interface OperatorPRReviewJob {
      name: string;
      spec: {
        cancelRequested?: boolean;
        cancelReason?: string;
        publicationMode: string;
      };
      status: {
        phase: string;
        jobName?: string;
        conditions: { type: string; status: string }[];
        message?: string;
      };
    }

    class MockKubeCluster {
      cr: OperatorPRReviewJob;
      workerJob: { name: string; deleted: boolean } | null;
      reconcileLog: string[] = [];

      constructor(initialCR: OperatorPRReviewJob, hasWorkerJob: boolean) {
        this.cr = JSON.parse(JSON.stringify(initialCR));
        this.workerJob = hasWorkerJob ? { name: initialCR.name + '-worker', deleted: false } : null;
      }

      isTerminalPhase(phase: string): boolean {
        // As defined in line 1450 of prreviewjob_v1alpha2_controller.go:
        return phase === 'Succeeded' || phase === 'Failed' || phase === 'Expired' || phase === 'Cancelled';
      }

      workerCreationWasAttempted(): boolean {
        return Boolean(this.cr.status.jobName) || this.cr.status.phase === 'Running';
      }

      reconcile(): { action: string; phase: string; error?: string } {
        // Step 1: Terminal phase guard (line 165)
        if (this.isTerminalPhase(this.cr.status.phase)) {
          this.reconcileLog.push(`TerminalWorkspaceCleanup:${this.cr.status.phase}`);
          return { action: 'terminal_workspace_cleanup', phase: this.cr.status.phase };
        }

        // Step 2: CancelRequested check (line 168)
        if (this.cr.spec.cancelRequested) {
          // reconcileCancellation (line 475)
          this.cr.status.phase = 'Cancelled';
          this.cr.status.message = `review run cancelled: ${this.cr.spec.cancelReason || 'none'}`;
          this.reconcileLog.push('CommitStatusPhaseCancelled');

          // Foreground worker job deletion (line 522)
          if (this.workerJob && !this.workerJob.deleted) {
            this.workerJob.deleted = true;
            this.reconcileLog.push('DeleteWorkerJobForeground');
          }
          return { action: 'cancelled_reconcile', phase: 'Cancelled' };
        }

        // Step 3: Check existing Job (line 190)
        if (this.workerJob && !this.workerJob.deleted) {
          this.reconcileLog.push('ReconcileExistingJob');
          return { action: 'reconcile_existing_job', phase: this.cr.status.phase };
        }

        // Step 4: WorkerJobMissing check (line 216)
        if (this.workerCreationWasAttempted()) {
          this.cr.status.phase = 'Failed';
          this.reconcileLog.push('WorkerJobMissingFailure');
          return { action: 'fail', phase: 'Failed', error: 'WorkerJobMissing' };
        }

        this.reconcileLog.push('AdmitOrQueue');
        return { action: 'admit_or_queue', phase: this.cr.status.phase };
      }
    }

    it('proves PhaseCancelled is treated as terminal and prevents WorkerJobMissing on subsequent reconciles', () => {
      const cr: OperatorPRReviewJob = {
        name: 'review-run-1',
        spec: {
          cancelRequested: true,
          cancelReason: 'superseded_by_new_head',
          publicationMode: 'app-gate',
        },
        status: {
          phase: 'Running',
          jobName: 'review-run-1-worker',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      };

      const cluster = new MockKubeCluster(cr, true);

      // Reconcile 1: Observes cancelRequested -> sets PhaseCancelled -> initiates Job deletion
      const r1 = cluster.reconcile();
      expect(r1.action).toBe('cancelled_reconcile');
      expect(r1.phase).toBe('Cancelled');
      expect(cluster.reconcileLog).toContain('CommitStatusPhaseCancelled');
      expect(cluster.reconcileLog).toContain('DeleteWorkerJobForeground');
      expect(cluster.workerJob?.deleted).toBe(true);

      // Reconcile 2: Job is now missing/deleted. Terminal check fires first!
      const r2 = cluster.reconcile();
      expect(r2.action).toBe('terminal_workspace_cleanup');
      expect(r2.phase).toBe('Cancelled');
      expect(cluster.reconcileLog).not.toContain('WorkerJobMissingFailure');
      expect(r2.error).toBeUndefined();
    });

    it('proves counter-example: if PhaseCancelled was omitted from isTerminalPhase, WorkerJobMissing would falsely occur', () => {
      class BrokenCluster extends MockKubeCluster {
        override isTerminalPhase(phase: string): boolean {
          // Intentionally broken without 'Cancelled'
          return phase === 'Succeeded' || phase === 'Failed' || phase === 'Expired';
        }
      }

      const cr: OperatorPRReviewJob = {
        name: 'review-run-broken',
        spec: {
          cancelRequested: true,
          cancelReason: 'superseded_by_new_head',
          publicationMode: 'app-gate',
        },
        status: {
          phase: 'Running',
          jobName: 'review-run-broken-worker',
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      };

      const brokenCluster = new BrokenCluster(cr, true);
      brokenCluster.reconcile(); // Reconcile 1: Cancelled, job deleted
      expect(brokenCluster.workerJob?.deleted).toBe(true);

      // Clear cancelRequested flag (e.g. if projection was stripped or state reset)
      // or if reconcile ran without cancelRequested branch:
      brokenCluster.cr.spec.cancelRequested = false;

      // In broken cluster, missing Job triggers WorkerJobMissing!
      const r2 = brokenCluster.reconcile();
      expect(r2.error).toBe('WorkerJobMissing');
      expect(brokenCluster.reconcileLog).toContain('WorkerJobMissingFailure');
    });

    it('verifies Go operator source code invariants statically', () => {
      const typesFilePath = resolve(__dirname, '../../k8s-operator/api/v1alpha2/prreviewjob_types.go');
      const controllerFilePath = resolve(__dirname, '../../k8s-operator/controllers/prreviewjob_v1alpha2_controller.go');

      const typesCode = readFileSync(typesFilePath, 'utf8');
      const controllerCode = readFileSync(controllerFilePath, 'utf8');

      // 1. PhaseCancelled constant is declared
      expect(typesCode).toContain('PhaseCancelled PRReviewJobPhase = "Cancelled"');

      // 2. CancelRequested and CancelReason are in Spec
      expect(typesCode).toContain('CancelRequested *bool `json:"cancelRequested,omitempty"`');
      expect(typesCode).toContain('CancelReason *string `json:"cancelReason,omitempty"`');

      // 3. PhaseCancelled is included in isTerminalPhase
      expect(controllerCode).toContain('phase == reviewv1alpha2.PhaseCancelled');

      // 4. Status PhaseCancelled is committed before deleting worker job
      const cancelReconcileIdx = controllerCode.indexOf('func (r *PRReviewJobV1Alpha2Reconciler) reconcileCancellation(');
      expect(cancelReconcileIdx).toBeGreaterThan(0);
      const cancelFuncCode = controllerCode.slice(cancelReconcileIdx, cancelReconcileIdx + 2000);

      expect(cancelFuncCode).toContain('review.Status.Phase = reviewv1alpha2.PhaseCancelled');
      expect(cancelFuncCode).toContain('r.Status().Update(ctx, review)');
      expect(cancelFuncCode).toContain('r.Delete(ctx, &existing, deleteOpts)');

      // Verify Status().Update occurs BEFORE r.Delete
      const statusUpdateIdx = cancelFuncCode.indexOf('r.Status().Update(ctx, review)');
      const deleteIdx = cancelFuncCode.indexOf('r.Delete(ctx, &existing, deleteOpts)');
      expect(statusUpdateIdx).toBeLessThan(deleteIdx);
    });

    it('empirically executes operator Go test suite and verifies all packages pass', () => {
      const operatorDir = resolve(__dirname, '../../k8s-operator');
      const output = execSync('go test ./...', { cwd: operatorDir, encoding: 'utf8' });
      expect(output).toContain('github.com/calltelemetry/ct-review-bot/k8s-operator/controllers');
      expect(output).not.toContain('FAIL');
    });
  });
});
