import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import {
  K8sJobRunner,
  checkReceiptBinding,
  validateExecutionReceipt,
  generateSimulationReceipt,
  ContractError,
  canonicalJson,
  requestDigest,
  RECEIPT_LOG_MARKER_START,
  RECEIPT_LOG_MARKER_END,
} from '../../src/infrastructure/k8sJobRunner';

describe('K8sJobRunner Execution Lifecycle & Receipt Retrieval (Milestone 2)', () => {
  const baseSpec = {
    persona: 'security',
    repoUrl: 'calltelemetry/cisco-cdr',
    prNumber: 42,
    commitSha: 'a1b2c3d4e5f6',
    logicalChildId: 'sec-child-42',
    fencingEpoch: 3,
  };

  describe('1. executeJob orchestration', () => {
    it('executes full simulation lifecycle successfully: dispatch -> wait -> retrieve -> validate', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });

      const result = await runner.executeJob(baseSpec);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('simulation');
      expect(result.jobName).toContain('ct-agent-security-pr42');
      expect(result.completion).toBeDefined();
      expect(result.completion?.succeeded).toBe(true);
      expect(result.completion?.phase).toBe('SUCCEEDED');
      expect(result.receipt).toBeDefined();
      expect(result.receipt?.schema).toBe('ct-agent-execution-receipt.v1');
      expect(result.receipt?.outcome).toBe('succeeded');
      expect(result.receipt?.request_digest).toBe(result.requestDigest);
      expect(result.receipt?.scope.logical_child_id).toBe('sec-child-42');
      expect(result.receipt?.scope.fencing_epoch).toBe(3);
    });

    it('returns structured failure when dispatch fails due to invalid parameters', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });

      // prNumber: 0 is invalid
      await expect(
        runner.executeJob({ ...baseSpec, prNumber: 0 })
      ).rejects.toThrow();
    });

    it('returns structured failure when job completion fails', async () => {
      const mockBatchApi: any = {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({
          body: {
            status: {
              failed: 1,
              conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job container failed' }],
            },
          },
        }),
      };
      const mockCoreApi: any = {
        listNamespacedPod: vi.fn().mockResolvedValue({
          body: {
            items: [
              {
                metadata: { name: 'failed-pod-1' },
                status: {
                  containerStatuses: [{ state: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }],
                },
              },
            ],
          },
        }),
      };

      const runner = new K8sJobRunner({
        forceSimulation: false,
        batchV1Api: mockBatchApi,
        coreV1Api: mockCoreApi,
      });

      const result = await runner.executeJob(baseSpec);

      expect(result.success).toBe(false);
      expect(result.completion?.phase).toBe('FAILED');
      expect(result.completion?.exitCode).toBe(137);
      expect(result.completion?.terminalReason).toBe('BackoffLimitExceeded');
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics?.[0].code).toBe('POD_FAILED');
    });

    it('returns structured failure with RECEIPT_MISSING when receipt cannot be retrieved', async () => {
      const mockBatchApi: any = {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({
          body: {
            status: {
              succeeded: 1,
              conditions: [{ type: 'Complete', status: 'True' }],
            },
          },
        }),
      };
      const mockCoreApi: any = {
        listNamespacedPod: vi.fn().mockResolvedValue({
          body: {
            items: [{ metadata: { name: 'empty-pod' }, status: {} }],
          },
        }),
        readNamespacedPodLog: vi.fn().mockResolvedValue('No demarcated receipt in logs here.'),
      };

      const runner = new K8sJobRunner({
        forceSimulation: false,
        batchV1Api: mockBatchApi,
        coreV1Api: mockCoreApi,
        workspaceMountPath: '/non-existent-volume-path',
      });

      const result = await runner.executeJob(baseSpec);

      expect(result.success).toBe(false);
      expect(result.error).toContain('RECEIPT_MISSING');
      expect(result.diagnostics?.[0].code).toBe('RECEIPT_MISSING');
    });

    it('returns structured failure when retrieved receipt fails binding validation (tampered digest)', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);
      const tamperedReceipt = runner.generateSimulationReceipt(workRequest, { tamperDigest: true });

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-test-'));
      try {
        const harnessDir = path.join(tempDir, '.ct-harness');
        fs.mkdirSync(harnessDir, { recursive: true });
        fs.writeFileSync(path.join(harnessDir, 'execution-receipt.json'), canonicalJson(tamperedReceipt));

        const result = await runner.executeJob(baseSpec, { workspaceMountPath: tempDir });

        expect(result.success).toBe(false);
        expect(result.error).toContain('REQUEST_DRIFT');
        expect(result.diagnostics?.[0].code).toBe('REQUEST_DRIFT');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('2. waitForJobCompletion', () => {
    it('returns simulated completion immediately when in simulation mode', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });

      const completion = await runner.waitForJobCompletion('test-job');

      expect(completion.succeeded).toBe(true);
      expect(completion.phase).toBe('SUCCEEDED');
      expect(completion.podName).toBe('simulated-pod-test-job');
      expect(completion.exitCode).toBe(0);
    });

    it('polls Kubernetes API and detects successful completion via Complete condition', async () => {
      const mockBatchApi: any = {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({
          body: {
            status: {
              conditions: [{ type: 'Complete', status: 'True' }],
            },
          },
        }),
      };
      const mockCoreApi: any = {
        listNamespacedPod: vi.fn().mockResolvedValue({
          body: {
            items: [
              {
                metadata: { name: 'pod-job-1' },
                spec: { nodeName: 'node-worker-alpha' },
                status: {
                  containerStatuses: [{ state: { terminated: { exitCode: 0 } } }],
                },
              },
            ],
          },
        }),
      };

      const runner = new K8sJobRunner({
        forceSimulation: false,
        batchV1Api: mockBatchApi,
        coreV1Api: mockCoreApi,
      });

      const completion = await runner.waitForJobCompletion('test-job-ok', { pollIntervalMs: 10 });

      expect(completion.succeeded).toBe(true);
      expect(completion.phase).toBe('SUCCEEDED');
      expect(completion.podName).toBe('pod-job-1');
      expect(completion.nodeName).toBe('node-worker-alpha');
      expect(completion.exitCode).toBe(0);
    });

    it('detects job timeout and returns TIMEOUT phase with JOB_TIMEOUT diagnostic', async () => {
      const mockBatchApi: any = {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({
          body: {
            status: { active: 1 },
          },
        }),
      };

      const runner = new K8sJobRunner({
        forceSimulation: false,
        batchV1Api: mockBatchApi,
      });

      const completion = await runner.waitForJobCompletion('job-timeout', {
        timeoutSeconds: 0.05,
        pollIntervalMs: 10,
      });

      expect(completion.succeeded).toBe(false);
      expect(completion.phase).toBe('TIMEOUT');
      expect(completion.terminalReason).toBe('DeadlineExceeded');
      expect(completion.diagnostics?.[0].code).toBe('JOB_TIMEOUT');
    });

    it('fails closed with AUTHORITY_DENIED when AbortSignal is triggered', async () => {
      const mockBatchApi: any = {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({
          body: { status: { active: 1 } },
        }),
      };

      const runner = new K8sJobRunner({
        forceSimulation: false,
        batchV1Api: mockBatchApi,
      });

      const controller = new AbortController();
      controller.abort();

      await expect(
        runner.waitForJobCompletion('job-aborted', { signal: controller.signal })
      ).rejects.toThrow(ContractError);
    });
  });

  describe('3. retrieveExecutionReceipt', () => {
    it('retrieves and parses receipt from shared volume mount path', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);
      const receipt = runner.generateSimulationReceipt(workRequest);

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-vol-'));
      try {
        const harnessDir = path.join(tempDir, '.ct-harness');
        fs.mkdirSync(harnessDir, { recursive: true });
        fs.writeFileSync(path.join(harnessDir, 'execution-receipt.json'), canonicalJson(receipt));

        const retrieved = await runner.retrieveExecutionReceipt('test-job', workRequest, {
          workspaceMountPath: tempDir,
        });

        expect(retrieved.schema).toBe('ct-agent-execution-receipt.v1');
        expect(retrieved.request_digest).toBe(receipt.request_digest);
        expect(retrieved.outcome).toBe('succeeded');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('extracts receipt from pod logs demarcated by canonical tags', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);
      const receipt = runner.generateSimulationReceipt(workRequest);

      const logOutput = [
        '2026-09-27T18:00:00Z Initializing worker container...',
        '2026-09-27T18:00:01Z Running code review analysis...',
        RECEIPT_LOG_MARKER_START,
        canonicalJson(receipt),
        RECEIPT_LOG_MARKER_END,
        '2026-09-27T18:00:02Z Worker shutdown complete.',
      ].join('\n');

      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
      };

      const runnerWithLog = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });

      const retrieved = await runnerWithLog.retrieveExecutionReceipt('test-job', workRequest, {
        podName: 'reviewer-pod-1',
      });

      expect(retrieved.schema).toBe('ct-agent-execution-receipt.v1');
      expect(retrieved.request_digest).toBe(receipt.request_digest);
    });

    it('enforces MAX_CONTRACT_BYTES (65,536 bytes) on retrieved receipt payload from volume', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-large-'));
      try {
        const harnessDir = path.join(tempDir, '.ct-harness');
        fs.mkdirSync(harnessDir, { recursive: true });
        // Write 70,000 bytes
        fs.writeFileSync(path.join(harnessDir, 'execution-receipt.json'), 'x'.repeat(70000));

        await expect(
          runner.retrieveExecutionReceipt('test-job', workRequest, { workspaceMountPath: tempDir })
        ).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('fails closed with RECEIPT_MISSING when neither volume file nor pod logs contain receipt', async () => {
      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue('Nothing here to see'),
      };
      const runner = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
        workspaceMountPath: '/non-existent-dir',
      });
      const workRequest = runner.buildWorkRequest(baseSpec);

      await expect(
        runner.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-no-receipt' })
      ).rejects.toThrow(/RECEIPT_MISSING/);
    });
  });

  describe('4. generateSimulationReceipt and checkReceiptBinding', () => {
    it('generates fully compliant simulation receipt that passes checkReceiptBinding cleanly', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);

      const receipt = generateSimulationReceipt(workRequest);

      expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();
      expect(() => validateExecutionReceipt(receipt, workRequest)).not.toThrow();
    });

    it('fails closed with REQUEST_DRIFT when request_digest is tampered', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);

      const tampered = generateSimulationReceipt(workRequest, { tamperDigest: true });

      expect(() => checkReceiptBinding(tampered, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(tampered, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('REQUEST_DRIFT');
      }
    });

    it('fails closed with SCOPE_MISMATCH when any of 9 scope fields differ', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);

      const tampered = generateSimulationReceipt(workRequest, { tamperScope: true });

      expect(() => checkReceiptBinding(tampered, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(tampered, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SCOPE_MISMATCH');
      }
    });

    it('fails closed with SUCCESS_EVIDENCE_REQUIRED when outcome is succeeded but evidence_refs is empty', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);

      const tampered = generateSimulationReceipt(workRequest, { omitEvidence: true });

      expect(() => checkReceiptBinding(tampered, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(tampered, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('fails closed with UNRESOLVED_EFFECT when outcome is succeeded but an effect is UNKNOWN', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);

      const tampered = generateSimulationReceipt(workRequest, { unresolvedEffect: true });

      expect(() => checkReceiptBinding(tampered, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(tampered, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('UNRESOLVED_EFFECT');
      }
    });

    it('fails closed with EFFECT_EVIDENCE_REQUIRED when terminal effect lacks evidence_ref', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);

      const receipt = generateSimulationReceipt(workRequest);
      receipt.effects[0].evidence_ref = null;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('fails closed with FENCING_MISMATCH when fencing_token or attempt is non-positive or non-integer', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const workRequest = runner.buildWorkRequest(baseSpec);

      const receipt = generateSimulationReceipt(workRequest);
      (receipt.lease as any).fencing_token = 0;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('FENCING_MISMATCH');
      }
    });

    it.each(['failed', 'unknown'] as const)('executeJob returns success: false when receipt outcome is %s across a clock boundary', async (outcome) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const beforeDispatch = new Date('2026-10-01T00:00:00.000Z');
      vi.setSystemTime(beforeDispatch);
      const runner = new K8sJobRunner({ forceSimulation: true });
      try {
        // A separately built sample is deliberately from the previous second;
        // the fixture must bind the receipt to the ACTUAL dispatched request.
        const preDispatchSample = runner.buildWorkRequest(baseSpec);
        vi.setSystemTime(new Date(beforeDispatch.getTime() + 1000));

        const dispatch = vi.spyOn(runner, 'dispatchJob');
        const completion = vi.spyOn(runner, 'waitForJobCompletion');
        const validation = vi.spyOn(runner, 'validateExecutionReceipt');
        const retrieval = vi.spyOn(runner, 'retrieveExecutionReceipt').mockImplementationOnce(
          async (_jobName, actualRequest) => {
            if (!('schema' in actualRequest) || actualRequest.schema !== 'ct-agent-work-request.v1') {
              throw new Error('Fixture expected the actual dispatched work request');
            }
            return generateSimulationReceipt(actualRequest, { outcome });
          },
        );
        const result = await runner.executeJob(baseSpec);

        expect(result.success).toBe(false);
        expect(result.receipt?.outcome).toBe(outcome);
        expect(result.error).toContain(`Execution receipt outcome was '${outcome}'`);
        expect(result.diagnostics?.[0].code).toBe('EXECUTION_FAILED');
        expect(result.requestDigest).not.toBe(requestDigest(preDispatchSample));
        expect(result.receipt?.request_digest).toBe(result.requestDigest);
        expect(retrieval).toHaveBeenCalledTimes(1);
        expect(retrieval.mock.calls[0][1]).toBe(result.workRequest);
        expect(validation).toHaveBeenCalledTimes(1);
        expect(validation).toHaveBeenCalledWith(result.receipt, result.workRequest,
          { now: expect.any(String) });
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(completion).toHaveBeenCalledTimes(1);
        const callOrder = [dispatch, completion, retrieval, validation]
          .map((spy) => spy.mock.invocationCallOrder[0]);
        for (let index = 1; index < callOrder.length; index++) {
          expect(callOrder[index - 1]).toBeLessThan(callOrder[index]);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['failed', 'unknown'] as const)('rejects a %s receipt from a separately rebuilt request before interpreting its outcome', async (outcome) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const beforeDispatch = new Date('2026-10-01T00:00:00.000Z');
      vi.setSystemTime(beforeDispatch);
      const runner = new K8sJobRunner({ forceSimulation: true });
      try {
        const previousRequest = runner.buildWorkRequest(baseSpec);
        const previousReceipt = generateSimulationReceipt(previousRequest, { outcome });
        vi.setSystemTime(new Date(beforeDispatch.getTime() + 1000));
        const validation = vi.spyOn(runner, 'validateExecutionReceipt');
        vi.spyOn(runner, 'retrieveExecutionReceipt').mockResolvedValueOnce(previousReceipt);

        const result = await runner.executeJob(baseSpec);

        // Same nine-field scope and a structurally valid non-success receipt;
        // only the new request's canonical timestamps/digest differ.
        expect(result.workRequest.scope).toEqual(previousRequest.scope);
        expect(result.workRequest.created_at).not.toBe(previousRequest.created_at);
        expect(previousReceipt.request_digest).not.toBe(result.requestDigest);
        expect(result.success).toBe(false);
        expect(result.receipt?.outcome).toBe(outcome);
        expect(result.error).toBe('Receipt validation failed: REQUEST_DRIFT');
        expect(result.diagnostics?.[0].code).toBe('REQUEST_DRIFT');
        expect(validation).toHaveBeenCalledTimes(1);
        expect(validation).toHaveBeenCalledWith(previousReceipt, result.workRequest,
          { now: expect.any(String) });
      } finally {
        vi.useRealTimers();
      }
    });

    it('retrieveExecutionReceipt retrieves from isolated child and attempt directory', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-iso-'));
      const workRequest = runner.buildWorkRequest(baseSpec);

      try {
        const isoDir = path.join(tempDir, '.ct-harness', workRequest.scope.logical_child_id, '1');
        fs.mkdirSync(isoDir, { recursive: true });
        const receipt = generateSimulationReceipt(workRequest);
        fs.writeFileSync(path.join(isoDir, 'execution-receipt.json'), JSON.stringify(receipt));

        const retrieved = await runner.retrieveExecutionReceipt('test-job', workRequest, {
          workspaceMountPath: tempDir,
        });
        expect(retrieved.request_digest).toBe(receipt.request_digest);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('submitCheckpoint halts execution atomically on permission_denied even if transition throws', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const execId = 'exec-atomic-deny-test';

      expect(runner.isExecutionHalted(execId)).toBe(false);

      // Proposal with an invalid phase transition from SUCCEEDED -> INTENT
      try {
        runner.submitTaskObserverCheckpoint(
          {
            checkpoint_id: 'cp-denial-test',
            observed_at: '2026-09-27T18:00:00.000Z',
            permission_denied: true,
            proposals: [
              { candidate_id: 'cand-1', impact: 'high', recurrence: 1, phase: 'SUCCEEDED', evidence_ref: 'sha256:' + 'a'.repeat(64) },
            ],
          },
          execId
        );
      } catch {
        // May succeed or fail, but now submit second with invalid transition
      }

      try {
        runner.submitTaskObserverCheckpoint(
          {
            checkpoint_id: 'cp-invalid-transition',
            observed_at: '2026-09-27T18:01:00.000Z',
            permission_denied: true,
            proposals: [
              { candidate_id: 'cand-1', impact: 'high', recurrence: 1, phase: 'INTENT' }, // Invalid transition from SUCCEEDED -> INTENT
            ],
          },
          execId
        );
      } catch (err: any) {
        // Throws error due to invalid transition or already halted
      }

      // Must reliably be halted
      expect(runner.isExecutionHalted(execId)).toBe(true);
    });
  });
});
