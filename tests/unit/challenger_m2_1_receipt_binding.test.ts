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
import { AgentExecutionReceipt, AgentWorkRequest } from '../../src/schemas/agentHarnessContracts';

describe('Empirical Challenger M2.1: Receipt Extraction & Binding Stress Test', () => {
  const baseSpec = {
    persona: 'security',
    repoUrl: 'exampleorg/example-api',
    prNumber: 99,
    commitSha: 'c0ffee1234567890abcdef',
    logicalChildId: 'sec-adversarial-99',
    fencingEpoch: 5,
    missionId: 'mission-pr99-c0ffee1',
    generation: 2,
    executionId: 'exec-sec-pr99-c0ffee1-g2',
    tenantId: 'ct-prod',
    environmentId: 'staging-k8s',
    workspaceId: 'ws-security',
  };

  const runner = new K8sJobRunner({ forceSimulation: true });
  const workRequest: AgentWorkRequest = runner.buildWorkRequest(baseSpec);

  // --------------------------------------------------------------------------
  // 1. Request Digest Tampering
  // --------------------------------------------------------------------------
  describe('1. Request digest tampering -> REQUEST_DRIFT', () => {
    it('throws REQUEST_DRIFT when receipt.request_digest is altered by single hex char', () => {
      const receipt = generateSimulationReceipt(workRequest);
      const originalDigest = receipt.request_digest;
      const lastChar = originalDigest.slice(-1);
      const flippedChar = lastChar === 'a' ? 'b' : 'a';
      receipt.request_digest = originalDigest.slice(0, -1) + flippedChar;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('REQUEST_DRIFT');
      }
    });

    it('throws REQUEST_DRIFT when receipt.request_digest is replaced by another sha256', () => {
      const receipt = generateSimulationReceipt(workRequest, { tamperDigest: true });

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('REQUEST_DRIFT');
      }
    });

    it('throws REQUEST_DRIFT when receipt.request_digest is empty or bogus string', () => {
      const receipt = generateSimulationReceipt(workRequest);
      receipt.request_digest = 'sha256:' + '0'.repeat(64);

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('REQUEST_DRIFT');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Scope Mismatch across all 9 scope fields
  // --------------------------------------------------------------------------
  describe('2. Scope mismatch across all 9 scope fields -> SCOPE_MISMATCH', () => {
    const scopeFields: Array<keyof AgentWorkRequest['scope']> = [
      'tenant_id',
      'environment_id',
      'workspace_id',
      'repository',
      'mission_id',
      'generation',
      'execution_id',
      'logical_child_id',
      'fencing_epoch',
    ];

    scopeFields.forEach((field) => {
      it(`throws SCOPE_MISMATCH when scope field '${field}' is altered`, () => {
        const receipt = generateSimulationReceipt(workRequest);

        if (typeof receipt.scope[field] === 'number') {
          (receipt.scope as any)[field] = (receipt.scope[field] as number) + 1;
        } else {
          (receipt.scope as any)[field] = `${receipt.scope[field]}-tampered`;
        }

        expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
        try {
          checkReceiptBinding(receipt, workRequest);
        } catch (err: any) {
          expect(err.code).toBe('SCOPE_MISMATCH');
        }
      });
    });

    it('throws SCOPE_MISMATCH when receipt scope field is omitted', () => {
      const receipt = generateSimulationReceipt(workRequest);
      delete (receipt.scope as any).logical_child_id;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SCOPE_MISMATCH');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Lease token tampering
  // --------------------------------------------------------------------------
  describe('3. Lease token tampering -> FENCING_MISMATCH', () => {
    const invalidFencingTokens = [0, -1, -999, 1.5, 0.1, NaN, Infinity, -Infinity];

    invalidFencingTokens.forEach((tokenVal) => {
      it(`throws FENCING_MISMATCH when fencing_token is ${tokenVal}`, () => {
        const receipt = generateSimulationReceipt(workRequest);
        (receipt.lease as any).fencing_token = tokenVal;

        expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
        try {
          checkReceiptBinding(receipt, workRequest);
        } catch (err: any) {
          expect(err.code).toBe('FENCING_MISMATCH');
        }
      });
    });

    const invalidAttempts = [0, -1, -50, 2.7, NaN, Infinity];

    invalidAttempts.forEach((attemptVal) => {
      it(`throws FENCING_MISMATCH when lease.attempt is ${attemptVal}`, () => {
        const receipt = generateSimulationReceipt(workRequest);
        (receipt.lease as any).attempt = attemptVal;

        expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
        try {
          checkReceiptBinding(receipt, workRequest);
        } catch (err: any) {
          expect(err.code).toBe('FENCING_MISMATCH');
        }
      });
    });

    it('throws FENCING_MISMATCH when receipt.lease is missing or null', () => {
      const receipt = generateSimulationReceipt(workRequest);
      (receipt as any).lease = null;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('FENCING_MISMATCH');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4. Missing evidence when outcome is succeeded
  // --------------------------------------------------------------------------
  describe('4. Missing evidence when outcome is succeeded -> SUCCESS_EVIDENCE_REQUIRED', () => {
    it('throws SUCCESS_EVIDENCE_REQUIRED when outcome is succeeded and evidence_refs is empty array []', () => {
      const receipt = generateSimulationReceipt(workRequest, { omitEvidence: true });
      expect(receipt.outcome).toBe('succeeded');
      expect(receipt.evidence_refs).toEqual([]);

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('throws SUCCESS_EVIDENCE_REQUIRED when evidence_refs is null on succeeded outcome', () => {
      const receipt = generateSimulationReceipt(workRequest);
      (receipt as any).evidence_refs = null;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Terminal effect without evidence digest
  // --------------------------------------------------------------------------
  describe('5. Terminal effect without evidence digest -> EFFECT_EVIDENCE_REQUIRED', () => {
    it('throws EFFECT_EVIDENCE_REQUIRED when SUCCEEDED effect has null evidence_ref', () => {
      const receipt = generateSimulationReceipt(workRequest);
      receipt.effects = [
        {
          effect_id: 'eff-1',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: null,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('throws EFFECT_EVIDENCE_REQUIRED when FAILED effect has null evidence_ref', () => {
      const receipt = generateSimulationReceipt(workRequest, { outcome: 'failed' });
      receipt.effects = [
        {
          effect_id: 'eff-1',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'FAILED',
          evidence_ref: null,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('throws EFFECT_EVIDENCE_REQUIRED when terminal effect evidence_ref is non-sha256 string', () => {
      const receipt = generateSimulationReceipt(workRequest);
      receipt.effects = [
        {
          effect_id: 'eff-1',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: 'not-a-valid-sha256-digest',
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 6. Unresolved effect when outcome is succeeded
  // --------------------------------------------------------------------------
  describe('6. Unresolved effect when outcome is succeeded -> UNRESOLVED_EFFECT', () => {
    // Valid CandidateEffectPhase values representing in-flight / non-succeeded execution states
    const candidateUnresolvedPhases = ['EXECUTING', 'INTENT', 'UNKNOWN', 'RECONCILING', 'MANUAL'] as const;

    candidateUnresolvedPhases.forEach((phase) => {
      it(`throws UNRESOLVED_EFFECT when outcome is succeeded but candidate effect phase is ${phase}`, () => {
        const receipt = generateSimulationReceipt(workRequest);
        receipt.outcome = 'succeeded';
        receipt.effects = [
          {
            effect_id: 'eff-unresolved',
            intent_digest: 'sha256:' + 'b'.repeat(64),
            state: phase,
            evidence_ref: null,
          },
        ];

        expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
        try {
          checkReceiptBinding(receipt, workRequest);
        } catch (err: any) {
          expect(err.code).toBe('UNRESOLVED_EFFECT');
        }
      });
    });

    it('throws UNRESOLVED_EFFECT when outcome is succeeded but effect state is FAILED', () => {
      const receipt = generateSimulationReceipt(workRequest);
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-failed',
          intent_digest: 'sha256:' + 'b'.repeat(64),
          state: 'FAILED',
          evidence_ref: 'sha256:' + 'c'.repeat(64),
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('UNRESOLVED_EFFECT');
      }
    });

    it('throws UNRESOLVED_EFFECT when outcome is succeeded but effect state is AuthoritativeOwnerState IN_FLIGHT', () => {
      const receipt = generateSimulationReceipt(workRequest);
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-inflight',
          intent_digest: 'sha256:' + 'b'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('UNRESOLVED_EFFECT');
      }
    });
  });

  // --------------------------------------------------------------------------
  // 7. Expired deadline (observed_at > deadline)
  // --------------------------------------------------------------------------
  describe('7. Expired deadline -> AUTHORITY_EXPIRED', () => {
    it('throws AUTHORITY_EXPIRED when observed_at is 1ms past workRequest deadline', () => {
      const receipt = generateSimulationReceipt(workRequest);
      const deadlineDate = new Date(workRequest.deadline);
      receipt.observed_at = new Date(deadlineDate.getTime() + 1).toISOString();

      expect(() => validateExecutionReceipt(receipt, workRequest)).toThrow(ContractError);
      try {
        validateExecutionReceipt(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('AUTHORITY_EXPIRED');
      }
    });

    it('accepts receipt when observed_at is exactly equal to deadline', () => {
      const receipt = generateSimulationReceipt(workRequest);
      receipt.observed_at = workRequest.deadline;

      expect(() => validateExecutionReceipt(receipt, workRequest)).not.toThrow();
    });

    it('executeJob records failure with AUTHORITY_EXPIRED diagnostic when observed_at exceeds deadline', async () => {
      const expiredReceipt = generateSimulationReceipt(workRequest);
      const deadlineDate = new Date(workRequest.deadline);
      expiredReceipt.observed_at = new Date(deadlineDate.getTime() + 5000).toISOString();

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expired-receipt-'));
      try {
        const harnessDir = path.join(tempDir, '.ct-harness');
        fs.mkdirSync(harnessDir, { recursive: true });
        fs.writeFileSync(path.join(harnessDir, 'execution-receipt.json'), canonicalJson(expiredReceipt));

        const jobResult = await runner.executeJob(
          { ...baseSpec, workRequest },
          { workspaceMountPath: tempDir }
        );

        expect(jobResult.success).toBe(false);
        expect(jobResult.error).toContain('AUTHORITY_EXPIRED');
        expect(jobResult.diagnostics?.[0].code).toBe('AUTHORITY_EXPIRED');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // --------------------------------------------------------------------------
  // 8. Receipt payload exceeding 65,536 bytes
  // --------------------------------------------------------------------------
  describe('8. Receipt payload exceeding 65,536 bytes -> PAYLOAD_TOO_LARGE', () => {
    it('rejects receipt file on volume mount when byteLength is 65,537 bytes', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-boundary-'));
      try {
        const harnessDir = path.join(tempDir, '.ct-harness');
        fs.mkdirSync(harnessDir, { recursive: true });
        const receiptFile = path.join(harnessDir, 'execution-receipt.json');

        // Exactly 65,537 bytes
        fs.writeFileSync(receiptFile, 'A'.repeat(65537));

        await expect(
          runner.retrieveExecutionReceipt('test-job', workRequest, { workspaceMountPath: tempDir })
        ).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects receipt in pod logs when payload between markers exceeds 65,536 bytes', async () => {
      const oversizedPayload = 'B'.repeat(70000);
      const logOutput = [
        'Log header line',
        RECEIPT_LOG_MARKER_START,
        oversizedPayload,
        RECEIPT_LOG_MARKER_END,
        'Log footer line',
      ].join('\n');

      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
      };

      const runnerWithMock = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });

      await expect(
        runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-oversized' })
      ).rejects.toThrow(/PAYLOAD_TOO_LARGE/);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Corrupted receipt payload in container log markers
  // --------------------------------------------------------------------------
  describe('9. Corrupted receipt in container log markers', () => {
    it('throws RECEIPT_MISSING when container log contains start marker but lacks end marker', async () => {
      const logOutput = [
        'Container started',
        RECEIPT_LOG_MARKER_START,
        '{"schema":"ct-agent-execution-receipt.v1", "incomplete": true',
        'Pod terminated abruptly',
      ].join('\n');

      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
      };

      const runnerWithMock = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });

      await expect(
        runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-truncated' })
      ).rejects.toThrow(ContractError);

      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-truncated' });
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });

    it('throws RECEIPT_MISSING when markers are in reversed order', async () => {
      const logOutput = [
        RECEIPT_LOG_MARKER_END,
        '{"schema":"ct-agent-execution-receipt.v1"}',
        RECEIPT_LOG_MARKER_START,
      ].join('\n');

      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
      };

      const runnerWithMock = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });

      await expect(
        runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-reversed' })
      ).rejects.toThrow(ContractError);

      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-reversed' });
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });

    it('throws RECEIPT_MISSING when start marker is misspelled/corrupted', async () => {
      const logOutput = [
        '-----BEGIN CT-AGENT-EXECUTION-RECEIP-----', // typo: missing 'T'
        canonicalJson(generateSimulationReceipt(workRequest)),
        RECEIPT_LOG_MARKER_END,
      ].join('\n');

      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
      };

      const runnerWithMock = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });

      await expect(
        runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-typo' })
      ).rejects.toThrow(ContractError);

      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-typo' });
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });

    it('throws RECEIPT_MISSING when markers enclose malformed JSON', async () => {
      const logOutput = [
        'Starting worker',
        RECEIPT_LOG_MARKER_START,
        '{ "schema": "ct-agent-execution-receipt.v1", "corrupted": [unclosed array',
        RECEIPT_LOG_MARKER_END,
        'Done',
      ].join('\n');

      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
      };

      const runnerWithMock = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });

      await expect(
        runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-bad-json' })
      ).rejects.toThrow(ContractError);

      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-bad-json' });
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });

    it('throws RECEIPT_MISSING when markers enclose structurally invalid receipt', async () => {
      const logOutput = [
        RECEIPT_LOG_MARKER_START,
        JSON.stringify({ schema: 'ct-agent-execution-receipt.v1', invalid_extra: 123 }),
        RECEIPT_LOG_MARKER_END,
      ].join('\n');

      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
      };

      const runnerWithMock = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });

      await expect(
        runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-bad-shape' })
      ).rejects.toThrow(ContractError);

      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-bad-shape' });
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });

    it('throws RECEIPT_MISSING when markers enclose unsupported schema', async () => {
      const logOutput = [
        RECEIPT_LOG_MARKER_START,
        JSON.stringify({ schema: 'unknown-agent-schema.v1', foo: 'bar' }),
        RECEIPT_LOG_MARKER_END,
      ].join('\n');

      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logOutput),
      };

      const runnerWithMock = new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });

      await expect(
        runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-bad-schema' })
      ).rejects.toThrow(ContractError);

      try {
        await runnerWithMock.retrieveExecutionReceipt('test-job', workRequest, { podName: 'pod-bad-schema' });
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });
  });
});
