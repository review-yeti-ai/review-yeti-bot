import { describe, it, expect } from 'vitest';
import {
  K8sJobRunner,
  checkReceiptBinding,
  validateExecutionReceipt,
  generateSimulationReceipt,
  ContractError,
} from '../../src/infrastructure/k8sJobRunner';
import { AgentExecutionReceipt, AgentWorkRequest } from '../../src/schemas/agentHarnessContracts';

describe('Empirical Challenger M2 R2.2: checkReceiptBinding Semantic Invariant Stress Test', () => {
  const baseSpec = {
    persona: 'security',
    repoUrl: 'calltelemetry/cisco-cdr',
    prNumber: 101,
    commitSha: 'd3adb33f1234567890abcdef',
    logicalChildId: 'sec-adversarial-101',
    fencingEpoch: 7,
    missionId: 'mission-pr101-d3adb33f',
    generation: 3,
    executionId: 'exec-sec-pr101-d3adb33f-g3',
    tenantId: 'ct-prod',
    environmentId: 'staging-k8s',
    workspaceId: 'ws-security',
  };

  const runner = new K8sJobRunner({ forceSimulation: true });
  const workRequest: AgentWorkRequest = runner.buildWorkRequest(baseSpec);

  // Helper to create a deep clone of the simulation receipt
  function createBaseReceipt(overrides?: Partial<AgentExecutionReceipt>): AgentExecutionReceipt {
    const raw = generateSimulationReceipt(workRequest, overrides);
    return JSON.parse(JSON.stringify(raw));
  }

  // ==========================================================================
  // Invariant 1 & 2: Succeeded outcome with unresolved Authoritative Owner State
  // ==========================================================================
  describe('Invariant 1 & 2: Succeeded outcome with Authoritative Owner State -> UNRESOLVED_EFFECT', () => {
    it('throws UNRESOLVED_EFFECT when outcome is succeeded with effect in Authoritative Owner State IN_FLIGHT', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-inflight-1',
          intent_digest: 'sha256:' + 'a'.repeat(64),
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

    it('throws UNRESOLVED_EFFECT when outcome is succeeded with effect in Authoritative Owner State INTENDED', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-intended-1',
          intent_digest: 'sha256:' + 'b'.repeat(64),
          state: 'INTENDED' as any,
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

    it('throws UNRESOLVED_EFFECT when succeeded outcome has mixed effects (SUCCEEDED + IN_FLIGHT)', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-succeeded-1',
          intent_digest: 'sha256:' + '1'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: 'sha256:' + 'e'.repeat(64),
        },
        {
          effect_id: 'eff-inflight-2',
          intent_digest: 'sha256:' + '2'.repeat(64),
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

    it('throws UNRESOLVED_EFFECT when succeeded outcome has mixed effects (SUCCEEDED + INTENDED)', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-succeeded-1',
          intent_digest: 'sha256:' + '1'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: 'sha256:' + 'e'.repeat(64),
        },
        {
          effect_id: 'eff-intended-2',
          intent_digest: 'sha256:' + '2'.repeat(64),
          state: 'INTENDED' as any,
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

    it('throws UNRESOLVED_EFFECT when arguments are inverted checkReceiptBinding(workRequest, receipt)', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-inflight-inv',
          intent_digest: 'sha256:' + '3'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      expect(() => checkReceiptBinding(workRequest, receipt)).toThrow(ContractError);
      try {
        checkReceiptBinding(workRequest, receipt);
      } catch (err: any) {
        expect(err.code).toBe('UNRESOLVED_EFFECT');
      }
    });

    it('throws UNRESOLVED_EFFECT via validateExecutionReceipt when outcome is succeeded with IN_FLIGHT effect', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-inflight-val',
          intent_digest: 'sha256:' + '4'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      expect(() => validateExecutionReceipt(receipt, workRequest)).toThrow(ContractError);
      try {
        validateExecutionReceipt(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('UNRESOLVED_EFFECT');
      }
    });

    it('throws UNRESOLVED_EFFECT via validateExecutionReceipt when outcome is succeeded with INTENDED effect', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-intended-val',
          intent_digest: 'sha256:' + '5'.repeat(64),
          state: 'INTENDED' as any,
          evidence_ref: null,
        },
      ];

      expect(() => validateExecutionReceipt(receipt, workRequest)).toThrow(ContractError);
      try {
        validateExecutionReceipt(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('UNRESOLVED_EFFECT');
      }
    });
  });

  // ==========================================================================
  // Invariant 3, 4 & 5: Succeeded outcome with invalid evidence_refs
  // ==========================================================================
  describe('Invariant 3, 4 & 5: Succeeded outcome evidence requirements -> SUCCESS_EVIDENCE_REQUIRED', () => {
    it('throws SUCCESS_EVIDENCE_REQUIRED when outcome is succeeded with evidence_refs: null', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      (receipt as any).evidence_refs = null;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('throws SUCCESS_EVIDENCE_REQUIRED when outcome is succeeded with evidence_refs: []', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.evidence_refs = [];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('throws SUCCESS_EVIDENCE_REQUIRED when outcome is succeeded with non-array evidence_refs: "sha256:..."', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      (receipt as any).evidence_refs = 'sha256:' + 'f'.repeat(64);

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('throws SUCCESS_EVIDENCE_REQUIRED when outcome is succeeded with non-array evidence_refs: object', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      (receipt as any).evidence_refs = { ref: 'sha256:' + 'a'.repeat(64) };

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('throws SUCCESS_EVIDENCE_REQUIRED when outcome is succeeded with non-array evidence_refs: number', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      (receipt as any).evidence_refs = 12345;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('throws SUCCESS_EVIDENCE_REQUIRED when outcome is succeeded with non-array evidence_refs: undefined', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      delete (receipt as any).evidence_refs;

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('throws SUCCESS_EVIDENCE_REQUIRED with inverted arguments checkReceiptBinding(workRequest, receipt)', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.evidence_refs = [];

      expect(() => checkReceiptBinding(workRequest, receipt)).toThrow(ContractError);
      try {
        checkReceiptBinding(workRequest, receipt);
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });
  });

  // ==========================================================================
  // Invariant 6 & 7: Terminal effect evidence validation
  // ==========================================================================
  describe('Invariant 6 & 7: Terminal effect evidence validation -> EFFECT_EVIDENCE_REQUIRED', () => {
    it('throws EFFECT_EVIDENCE_REQUIRED when SUCCEEDED effect has non-SHA256 string evidence_ref: "invalid"', () => {
      const receipt = createBaseReceipt();
      receipt.effects = [
        {
          effect_id: 'eff-terminal-invalid',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: 'invalid' as any,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('throws EFFECT_EVIDENCE_REQUIRED when SUCCEEDED effect has evidence_ref: null', () => {
      const receipt = createBaseReceipt();
      receipt.effects = [
        {
          effect_id: 'eff-terminal-null',
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

    it('throws EFFECT_EVIDENCE_REQUIRED when FAILED effect has non-SHA256 string evidence_ref: "invalid"', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-failed-invalid',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'FAILED',
          evidence_ref: 'invalid' as any,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('throws EFFECT_EVIDENCE_REQUIRED when FAILED effect has evidence_ref: null', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-failed-null',
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

    it('throws EFFECT_EVIDENCE_REQUIRED when terminal effect has empty string evidence_ref: ""', () => {
      const receipt = createBaseReceipt();
      receipt.effects = [
        {
          effect_id: 'eff-empty-ev',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: '' as any,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('throws EFFECT_EVIDENCE_REQUIRED when terminal effect has truncated SHA256 evidence_ref: "sha256:1234"', () => {
      const receipt = createBaseReceipt();
      receipt.effects = [
        {
          effect_id: 'eff-short-sha',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: 'sha256:1234' as any,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('throws EFFECT_EVIDENCE_REQUIRED when terminal effect has non-sha256 algorithm evidence_ref: "md5:..."', () => {
      const receipt = createBaseReceipt();
      receipt.effects = [
        {
          effect_id: 'eff-md5',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: 'md5:' + 'a'.repeat(32) as any,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
      try {
        checkReceiptBinding(receipt, workRequest);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('throws EFFECT_EVIDENCE_REQUIRED with inverted arguments checkReceiptBinding(workRequest, receipt)', () => {
      const receipt = createBaseReceipt();
      receipt.effects = [
        {
          effect_id: 'eff-inv-terminal',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: 'invalid' as any,
        },
      ];

      expect(() => checkReceiptBinding(workRequest, receipt)).toThrow(ContractError);
      try {
        checkReceiptBinding(workRequest, receipt);
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });
  });

  // ==========================================================================
  // Invariant 8: Failed outcome with effect in IN_FLIGHT normalizes and passes
  // ==========================================================================
  describe('Invariant 8: Failed outcome with IN_FLIGHT effect normalization', () => {
    it('normalizes IN_FLIGHT to EXECUTING and passes wire validation without error when outcome is failed', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-failed-inflight',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();
      expect(receipt.effects[0].state).toBe('EXECUTING');
    });

    it('normalizes INTENDED to INTENT and passes wire validation without error when outcome is failed', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-failed-intended',
          intent_digest: 'sha256:' + 'b'.repeat(64),
          state: 'INTENDED' as any,
          evidence_ref: null,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();
      expect(receipt.effects[0].state).toBe('INTENT');
    });

    it('normalizes multiple mixed Authoritative Owner States simultaneously when outcome is failed', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-m-inflight',
          intent_digest: 'sha256:' + '1'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
        {
          effect_id: 'eff-m-intended',
          intent_digest: 'sha256:' + '2'.repeat(64),
          state: 'INTENDED' as any,
          evidence_ref: null,
        },
        {
          effect_id: 'eff-m-failed',
          intent_digest: 'sha256:' + '3'.repeat(64),
          state: 'FAILED',
          evidence_ref: 'sha256:' + 'f'.repeat(64),
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();
      expect(receipt.effects[0].state).toBe('EXECUTING');
      expect(receipt.effects[1].state).toBe('INTENT');
      expect(receipt.effects[2].state).toBe('FAILED');
    });

    it('normalizes and passes wire validation with inverted arguments checkReceiptBinding(workRequest, receipt)', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-inv-failed-inflight',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      expect(() => checkReceiptBinding(workRequest, receipt)).not.toThrow();
      expect(receipt.effects[0].state).toBe('EXECUTING');
    });

    it('is idempotent when checkReceiptBinding is called sequentially on normalized receipt', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-idempotent',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      // First call normalizes IN_FLIGHT -> EXECUTING
      expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();
      expect(receipt.effects[0].state).toBe('EXECUTING');

      // Second call executes on EXECUTING and succeeds without change
      expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();
      expect(receipt.effects[0].state).toBe('EXECUTING');
    });

    it('validates via validateExecutionReceipt when outcome is failed with IN_FLIGHT effect', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-val-failed-inflight',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      const validated = validateExecutionReceipt(receipt, workRequest);
      expect(validated.effects[0].state).toBe('EXECUTING');
      expect(validated.outcome).toBe('failed');
    });

    it('validates via runner.checkReceiptBinding instance method with identical normalization semantics', () => {
      const receipt = createBaseReceipt({ outcome: 'failed' });
      receipt.outcome = 'failed';
      receipt.effects = [
        {
          effect_id: 'eff-runner-method',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      expect(() => runner.checkReceiptBinding(receipt, workRequest)).not.toThrow();
      expect(receipt.effects[0].state).toBe('EXECUTING');
    });
  });

  // ==========================================================================
  // Edge Case: Other non-succeeded outcomes (cancelled, expired, unknown) with IN_FLIGHT
  // ==========================================================================
  describe('Non-succeeded outcomes with IN_FLIGHT effect normalization', () => {
    const nonSucceededOutcomes = ['cancelled', 'expired', 'unknown'] as const;

    nonSucceededOutcomes.forEach((outcome) => {
      it(`normalizes IN_FLIGHT to EXECUTING when outcome is ${outcome}`, () => {
        const receipt = createBaseReceipt({ outcome });
        receipt.outcome = outcome;
        receipt.effects = [
          {
            effect_id: `eff-${outcome}-inflight`,
            intent_digest: 'sha256:' + 'a'.repeat(64),
            state: 'IN_FLIGHT' as any,
            evidence_ref: null,
          },
        ];

        expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();
        expect(receipt.effects[0].state).toBe('EXECUTING');
      });
    });
  });

  // ==========================================================================
  // Semantic Precedence: Semantic errors precede wire schema validation
  // ==========================================================================
  describe('Semantic Precedence: Domain errors precede schema validation', () => {
    it('throws SUCCESS_EVIDENCE_REQUIRED rather than INVALID_SHAPE when receipt has missing evidence', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.evidence_refs = [];

      try {
        checkReceiptBinding(receipt, workRequest);
        expect.unreachable('Should have thrown ContractError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ContractError);
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('throws UNRESOLVED_EFFECT rather than INVALID_SHAPE when effect is IN_FLIGHT on succeeded outcome', () => {
      const receipt = createBaseReceipt();
      receipt.outcome = 'succeeded';
      receipt.effects = [
        {
          effect_id: 'eff-precedence-inflight',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
      ];

      try {
        checkReceiptBinding(receipt, workRequest);
        expect.unreachable('Should have thrown ContractError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ContractError);
        expect(err.code).toBe('UNRESOLVED_EFFECT');
      }
    });

    it('throws EFFECT_EVIDENCE_REQUIRED rather than INVALID_SHAPE when terminal effect has invalid digest', () => {
      const receipt = createBaseReceipt();
      receipt.effects = [
        {
          effect_id: 'eff-precedence-terminal',
          intent_digest: 'sha256:' + 'a'.repeat(64),
          state: 'SUCCEEDED',
          evidence_ref: 'not-a-valid-sha256',
        },
      ];

      try {
        checkReceiptBinding(receipt, workRequest);
        expect.unreachable('Should have thrown ContractError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ContractError);
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });
  });
});
