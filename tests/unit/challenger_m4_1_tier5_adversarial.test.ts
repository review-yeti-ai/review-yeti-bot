/**
 * Tier 5 White-Box Adversarial Challenge Test Suite
 * challenger_m4_1
 *
 * Exhaustively probes:
 * 1. WorkRequest envelope construction (RFC 8785 canonical hashing, exact 9-field scope, 65,536-byte limit, .000Z timestamps)
 * 2. Container log receipt extraction (malformed JSON, corrupted schema, oversized buffer >65k, duplicate keys, delimiter tampering)
 * 3. Receipt binding verification (precedence order of semantic domain invariants over wire schema, tripartite fencing, clock invariants)
 * 4. Symmetrical owner state normalization & transition constraints (ct-effect-intent.v1 <-> CandidateEffectPhase)
 * 5. Task observer lifecycle, proposal budget capping (<= 5), zero-retention enforcement, and classifier permission denial hard stop
 */

import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';
import {
  K8sJobRunner,
  checkReceiptBinding,
  validateExecutionReceipt,
  generateSimulationReceipt,
  computeRequestDigest,
  normalizeRepository,
  createTaskObserverCheckpoint,
  sanitizeCheckpointProposal,
  TaskObserverLifecycleManager,
  mapCandidatePhaseToOwnerState,
  RECEIPT_LOG_MARKER_START,
  RECEIPT_LOG_MARKER_END,
} from '../../src/infrastructure/k8sJobRunner';
import {
  AgentWorkRequest,
  AgentExecutionReceipt,
  AdmissionSnapshot,
  ContractError,
  MAX_CONTRACT_BYTES,
  MAX_CHECKPOINT_PROPOSALS,
  canonicalJson,
  canonicalJsonBuffer,
  loadWireJson,
  loadPacket,
  validateWorkRequest,
  validateExecutionReceipt as validateReceiptSchema,
  requestDigest,
  checkReceiptBinding as checkContractReceiptBinding,
  checkOwnedReceiptBinding,
  ownerIntentDigest,
  checkEffectTransition,
  projectEffectState,
  TimestampSchema,
  DigestSchema,
  ScopeSchema,
  CandidateEffectPhase,
  AuthoritativeOwnerState,
} from '../../src/schemas/agentHarnessContracts';

describe('Tier 5 White-Box Adversarial Challenge: TypeScript Runner & Contracts', () => {
  const DUMMY_DIGEST = 'sha256:' + 'a'.repeat(64);
  const DUMMY_DIGEST_B = 'sha256:' + 'b'.repeat(64);
  const DUMMY_DIGEST_C = 'sha256:' + 'c'.repeat(64);

  const baselineSpec = {
    persona: 'security',
    repoUrl: 'exampleorg/example-api',
    prNumber: 42,
    commitSha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    logicalChildId: 'child-sec-42',
    fencingEpoch: 3,
    missionId: 'mission-pr42-e3b0c44',
    generation: 2,
    executionId: 'exec-sec-pr42-e3b0c44-g2',
    tenantId: 'ct-prod',
    environmentId: 'doks-qualification',
    workspaceId: 'factory-1',
  };

  const runner = new K8sJobRunner({ forceSimulation: true });

  // ==========================================================================
  // AREA 1: WorkRequest Envelope Construction, RFC 8785 Hashing & Boundaries
  // ==========================================================================
  describe('Area 1: WorkRequest Envelope Construction, RFC 8785 & Boundaries', () => {
    it('constructs an exact RFC 8785 compliant canonical JSON with sorted UTF-16 code unit keys', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const canonicalStr = canonicalJson(workRequest);

      // Verify that every object in the JSON has keys sorted strictly by UTF-16 code units
      const parsed = JSON.parse(canonicalStr);
      const topKeys = Object.keys(parsed);
      const sortedKeys = [...topKeys].sort();
      expect(topKeys).toEqual(sortedKeys);

      const scopeKeys = Object.keys(parsed.scope);
      expect(scopeKeys).toEqual([...scopeKeys].sort());

      // Exactly 18 closed properties on root WorkRequest
      expect(topKeys.length).toBe(18);
    });

    it('enforces exact 9 mandatory fields on ScopeSchema with strict rejection of extraneous keys', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const validScope = workRequest.scope;

      // 9 fields exactly
      expect(Object.keys(validScope).length).toBe(9);
      expect(ScopeSchema.safeParse(validScope).success).toBe(true);

      // Extraneous field injection
      const corruptedScope: any = { ...validScope, unauthorized_cluster_role: 'admin' };
      const result = ScopeSchema.safeParse(corruptedScope);
      expect(result.success).toBe(false);

      // Missing mandatory field (e.g. logical_child_id)
      const missingFieldScope: any = { ...validScope };
      delete missingFieldScope.logical_child_id;
      expect(ScopeSchema.safeParse(missingFieldScope).success).toBe(false);
    });

    it('enforces strict 65,536 bytes boundary on canonical JSON serialization', () => {
      // Create minimal valid object
      const baseObj = { key: 'val' };
      const serialized = canonicalJson(baseObj);
      expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(MAX_CONTRACT_BYTES);

      // Exact 65,536 bytes string
      const exactPadding = 'x'.repeat(MAX_CONTRACT_BYTES - Buffer.byteLength('{"p":""}', 'utf8'));
      const boundaryObj = { p: exactPadding };
      const boundarySerialized = canonicalJson(boundaryObj);
      expect(Buffer.byteLength(boundarySerialized, 'utf8')).toBe(MAX_CONTRACT_BYTES);

      // Boundary + 1 byte (65,537 bytes)
      const oversizedPadding = 'x'.repeat(MAX_CONTRACT_BYTES - Buffer.byteLength('{"p":""}', 'utf8') + 1);
      const oversizedObj = { p: oversizedPadding };
      expect(() => canonicalJson(oversizedObj)).toThrow(ContractError);
      try {
        canonicalJson(oversizedObj);
      } catch (err: any) {
        expect(err.code).toBe('PAYLOAD_TOO_LARGE');
      }
    });

    it('serializes negative zero (-0) to "0" without hyphen per RFC 8785 Section 3.2.2', () => {
      const objWithNegativeZero = { zero: -0 };
      expect(canonicalJson(objWithNegativeZero)).toBe('{"zero":0}');
    });

    it('rejects non-integer floating point numbers and exponential representations in wire parser', () => {
      const floatJson = '{"count": 1.23}';
      expect(() => loadWireJson(floatJson)).toThrow(ContractError);
      try {
        loadWireJson(floatJson);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_JSON');
      }

      const expJson = '{"tokens": 1e5}';
      expect(() => loadWireJson(expJson)).toThrow(ContractError);

      const leadingZeroJson = '{"epoch": 007}';
      expect(() => loadWireJson(leadingZeroJson)).toThrow(ContractError);
    });

    it('validates millisecond timestamp formatting strictly requiring .000Z and rejecting calendar anomalies', () => {
      // Valid exact 24-character timestamp
      expect(TimestampSchema.safeParse('2026-09-28T01:00:00.000Z').success).toBe(true);

      // Rejects missing millisecond precision
      expect(TimestampSchema.safeParse('2026-09-28T01:00:00Z').success).toBe(false);

      // Rejects 2-digit milliseconds
      expect(TimestampSchema.safeParse('2026-09-28T01:00:00.00Z').success).toBe(false);

      // Rejects 4-digit milliseconds
      expect(TimestampSchema.safeParse('2026-09-28T01:00:00.0000Z').success).toBe(false);

      // Rejects timezone offset other than Z
      expect(TimestampSchema.safeParse('2026-09-28T01:00:00.000+00:00').success).toBe(false);

      // Rejects impossible calendar dates (e.g. Feb 29 on non-leap year 2026)
      expect(TimestampSchema.safeParse('2026-02-29T12:00:00.000Z').success).toBe(false);

      // Rejects impossible month (13)
      expect(TimestampSchema.safeParse('2026-13-01T12:00:00.000Z').success).toBe(false);

      // Rejects impossible hour (25)
      expect(TimestampSchema.safeParse('2026-09-28T25:00:00.000Z').success).toBe(false);
    });

    it('enforces temporal ordering created_at < deadline and rejects invalid deadlines', () => {
      const req = runner.buildWorkRequest(baselineSpec);

      // Rejects created_at == deadline
      const reqEqualTimes = { ...req, deadline: req.created_at };
      expect(() => validateWorkRequest(reqEqualTimes)).toThrow(ContractError);
      try {
        validateWorkRequest(reqEqualTimes);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_DEADLINE');
      }

      // Rejects created_at > deadline
      const reqInvertedTimes = {
        ...req,
        created_at: '2026-09-28T02:00:00.000Z',
        deadline: '2026-09-28T01:00:00.000Z',
      };
      expect(() => validateWorkRequest(reqInvertedTimes)).toThrow(ContractError);
      try {
        validateWorkRequest(reqInvertedTimes);
      } catch (err: any) {
        expect(err.code).toBe('INVALID_DEADLINE');
      }
    });

    it('enforces self-parent guard (parent_execution_id !== scope.execution_id)', () => {
      const req = runner.buildWorkRequest(baselineSpec);
      const reqSelfParent = { ...req, parent_execution_id: req.scope.execution_id };
      expect(() => validateWorkRequest(reqSelfParent)).toThrow(ContractError);
      try {
        validateWorkRequest(reqSelfParent);
      } catch (err: any) {
        expect(err.code).toBe('SELF_PARENT');
      }
    });

    it('enforces unique constraints on capabilities, provider_eligibility_refs, and input_refs', () => {
      const req = runner.buildWorkRequest(baselineSpec);

      // Duplicate capability
      const reqDupCap = { ...req, capabilities: ['artifact.read', 'artifact.read'] };
      expect(() => validateWorkRequest(reqDupCap)).toThrow(ContractError);

      // Duplicate provider eligibility ref
      const reqDupProv = { ...req, provider_eligibility_refs: [DUMMY_DIGEST, DUMMY_DIGEST] };
      expect(() => validateWorkRequest(reqDupProv)).toThrow(ContractError);

      // Duplicate input_ref artifact_id
      const reqDupArtifactId = {
        ...req,
        input_refs: [
          { artifact_id: 'art-1', digest: DUMMY_DIGEST, classification: 'synthetic' as const },
          { artifact_id: 'art-1', digest: DUMMY_DIGEST_B, classification: 'synthetic' as const },
        ],
      };
      expect(() => validateWorkRequest(reqDupArtifactId)).toThrow(ContractError);
      try {
        validateWorkRequest(reqDupArtifactId);
      } catch (err: any) {
        expect(err.code).toBe('DUPLICATE_ID');
      }
    });

    it('reproduces computeRequestDigest determinism across repeated invocations', () => {
      const req = runner.buildWorkRequest(baselineSpec);
      const digest1 = computeRequestDigest(req);
      const digest2 = computeRequestDigest(req);
      expect(digest1.digest).toBe(digest2.digest);
      expect(digest1.byteLength).toBe(digest2.byteLength);
      expect(digest1.digest).toBe(requestDigest(req));
    });
  });

  // ==========================================================================
  // AREA 2: Container Log Receipt Extraction Adversarial Stress
  // ==========================================================================
  describe('Area 2: Container Log Receipt Extraction Adversarial Stress', () => {
    function createRunnerWithLogs(logBody: string): K8sJobRunner {
      const mockCoreApi: any = {
        readNamespacedPodLog: vi.fn().mockResolvedValue(logBody),
      };
      return new K8sJobRunner({
        forceSimulation: false,
        coreV1Api: mockCoreApi,
      });
    }

    it('extracts valid receipt demarcated by delimiters within arbitrary surrounding noisy logs', async () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const validReceipt = generateSimulationReceipt(workRequest);
      const logBody = [
        '[debug] container startup initialized',
        '[info] executing reviewer agent pipeline',
        RECEIPT_LOG_MARKER_START,
        canonicalJson(validReceipt),
        RECEIPT_LOG_MARKER_END,
        '[info] container shutting down with code 0',
      ].join('\n');

      const mockRunner = createRunnerWithLogs(logBody);
      const retrieved = await mockRunner.retrieveExecutionReceipt('test-job', workRequest, {
        podName: 'test-pod',
      });

      expect(retrieved.schema).toBe('ct-agent-execution-receipt.v1');
      expect(retrieved.request_digest).toBe(validReceipt.request_digest);
      expect(retrieved.outcome).toBe('succeeded');
    });

    it('throws PAYLOAD_TOO_LARGE directly (never swallowed into RECEIPT_MISSING) when buffer exceeds 65,536 B', async () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const oversizedRaw = 'z'.repeat(65537);
      const logBody = `${RECEIPT_LOG_MARKER_START}\n${oversizedRaw}\n${RECEIPT_LOG_MARKER_END}`;

      const mockRunner = createRunnerWithLogs(logBody);
      await expect(
        mockRunner.retrieveExecutionReceipt('test-job', workRequest, { podName: 'test-pod' })
      ).rejects.toThrow(ContractError);

      try {
        await mockRunner.retrieveExecutionReceipt('test-job', workRequest, { podName: 'test-pod' });
      } catch (err: any) {
        expect(err.code).toBe('PAYLOAD_TOO_LARGE');
      }
    });

    it('safely degrades malformed JSON in markers to RECEIPT_MISSING without crashing', async () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const malformedLog = `${RECEIPT_LOG_MARKER_START}\n{"unclosed": "bracket", \n${RECEIPT_LOG_MARKER_END}`;

      const mockRunner = createRunnerWithLogs(malformedLog);
      await expect(
        mockRunner.retrieveExecutionReceipt('test-job', workRequest, { podName: 'test-pod' })
      ).rejects.toThrow(ContractError);

      try {
        await mockRunner.retrieveExecutionReceipt('test-job', workRequest, { podName: 'test-pod' });
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });

    it('safely degrades duplicate JSON keys in markers to RECEIPT_MISSING without crashing', async () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const validReceipt = generateSimulationReceipt(workRequest);
      const json = canonicalJson(validReceipt);
      const duplicateKeyJson = '{"schema":"ct-agent-execution-receipt.v1",' + json.slice(1);
      const logBody = `${RECEIPT_LOG_MARKER_START}\n${duplicateKeyJson}\n${RECEIPT_LOG_MARKER_END}`;

      const mockRunner = createRunnerWithLogs(logBody);
      try {
        await mockRunner.retrieveExecutionReceipt('test-job', workRequest, { podName: 'test-pod' });
        expect.unreachable('Should have thrown RECEIPT_MISSING');
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });

    it('safely degrades unsupported schema in markers to RECEIPT_MISSING without crashing', async () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const foreignSchemaJson = JSON.stringify({
        schema: 'foreign-unknown-receipt.v1',
        outcome: 'succeeded',
      });
      const logBody = `${RECEIPT_LOG_MARKER_START}\n${foreignSchemaJson}\n${RECEIPT_LOG_MARKER_END}`;

      const mockRunner = createRunnerWithLogs(logBody);
      try {
        await mockRunner.retrieveExecutionReceipt('test-job', workRequest, { podName: 'test-pod' });
        expect.unreachable('Should have thrown RECEIPT_MISSING');
      } catch (err: any) {
        expect(err.code).toBe('RECEIPT_MISSING');
      }
    });

    it('throws RECEIPT_MISSING when markers are inverted or empty', async () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);

      // Inverted markers
      const invertedLog = `${RECEIPT_LOG_MARKER_END}\n{}\n${RECEIPT_LOG_MARKER_START}`;
      const mockRunnerInverted = createRunnerWithLogs(invertedLog);
      await expect(
        mockRunnerInverted.retrieveExecutionReceipt('test-job', workRequest, { podName: 'test-pod' })
      ).rejects.toThrow(ContractError);

      // Empty markers
      const emptyLog = `${RECEIPT_LOG_MARKER_START}\n\n${RECEIPT_LOG_MARKER_END}`;
      const mockRunnerEmpty = createRunnerWithLogs(emptyLog);
      await expect(
        mockRunnerEmpty.retrieveExecutionReceipt('test-job', workRequest, { podName: 'test-pod' })
      ).rejects.toThrow(ContractError);
    });
  });

  // ==========================================================================
  // AREA 3: Receipt Binding Verification Precedence & Tripartite Fencing
  // ==========================================================================
  describe('Area 3: Receipt Binding Verification Precedence & Tripartite Fencing', () => {
    it('verifies precedence: FENCING_MISMATCH takes precedence over REQUEST_DRIFT and SCOPE_MISMATCH', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest);

      // Corrupt fencing token AND request digest AND scope
      (receipt.lease as any).fencing_token = -5; // invalid fencing token
      receipt.request_digest = 'sha256:' + '9'.repeat(64); // drifted digest
      receipt.scope.generation = 999; // mismatched scope

      try {
        checkReceiptBinding(receipt, workRequest);
        expect.unreachable('Should have thrown FENCING_MISMATCH');
      } catch (err: any) {
        expect(err.code).toBe('FENCING_MISMATCH');
      }
    });

    it('verifies precedence: REQUEST_DRIFT takes precedence over SCOPE_MISMATCH and SUCCESS_EVIDENCE_REQUIRED', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest);

      // Valid fencing, but corrupted digest AND scope AND empty evidence
      receipt.request_digest = 'sha256:' + '0'.repeat(64);
      receipt.scope.generation = 999;
      receipt.evidence_refs = [];

      try {
        checkReceiptBinding(receipt, workRequest);
        expect.unreachable('Should have thrown REQUEST_DRIFT');
      } catch (err: any) {
        expect(err.code).toBe('REQUEST_DRIFT');
      }
    });

    it('verifies precedence: SCOPE_MISMATCH takes precedence over SUCCESS_EVIDENCE_REQUIRED', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest);

      // Valid digest, but corrupted scope AND empty evidence
      receipt.scope.logical_child_id = 'different-child-id';
      receipt.evidence_refs = [];

      try {
        checkReceiptBinding(receipt, workRequest);
        expect.unreachable('Should have thrown SCOPE_MISMATCH');
      } catch (err: any) {
        expect(err.code).toBe('SCOPE_MISMATCH');
      }
    });

    it('verifies precedence: SUCCESS_EVIDENCE_REQUIRED takes precedence over UNRESOLVED_EFFECT', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest);

      // Empty evidence AND unresolved effect
      receipt.evidence_refs = [];
      receipt.effects = [
        {
          effect_id: 'eff-1',
          intent_digest: DUMMY_DIGEST,
          state: 'UNKNOWN' as any,
          evidence_ref: null,
        },
      ];

      try {
        checkReceiptBinding(receipt, workRequest);
        expect.unreachable('Should have thrown SUCCESS_EVIDENCE_REQUIRED');
      } catch (err: any) {
        expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
      }
    });

    it('verifies precedence: EFFECT_EVIDENCE_REQUIRED takes precedence over wire schema validation', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest);

      receipt.effects = [
        {
          effect_id: 'eff-1',
          intent_digest: DUMMY_DIGEST,
          state: 'SUCCEEDED',
          evidence_ref: 'not-a-valid-sha256-string',
        },
      ];

      try {
        checkReceiptBinding(receipt, workRequest);
        expect.unreachable('Should have thrown EFFECT_EVIDENCE_REQUIRED');
      } catch (err: any) {
        expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
      }
    });

    it('maintains argument symmetry: checkReceiptBinding(req, rec) === checkReceiptBinding(rec, req)', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest);

      // Both orientations succeed for valid pair
      expect(() => checkReceiptBinding(workRequest, receipt)).not.toThrow();
      expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();

      // Both orientations fail identically for invalid pair
      receipt.request_digest = 'sha256:' + 'e'.repeat(64);
      expect(() => checkReceiptBinding(workRequest, receipt)).toThrow(ContractError);
      expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
    });

    it('validates execution receipt clock boundaries and budget ceilings', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest);

      // Valid receipt validates cleanly
      expect(() => validateExecutionReceipt(receipt, workRequest)).not.toThrow();

      // Started after observed -> INVALID_RECEIPT_TIME
      const badTimeReceipt = {
        ...receipt,
        started_at: '2026-09-28T02:00:00.000Z',
        observed_at: '2026-09-28T01:00:00.000Z',
      };
      expect(() => validateExecutionReceipt(badTimeReceipt, workRequest)).toThrow(ContractError);

      // Observed after deadline -> AUTHORITY_EXPIRED
      const expiredReceipt = {
        ...receipt,
        observed_at: '2026-09-29T12:00:00.000Z',
      };
      expect(() => validateExecutionReceipt(expiredReceipt, workRequest)).toThrow(ContractError);

      // Cost budget exceeded -> BUDGET_EXCEEDED
      const overCostReceipt = {
        ...receipt,
        metering: { ...receipt.metering, cost_microusd: workRequest.budget.max_cost_microusd + 1 },
      };
      expect(() => validateExecutionReceipt(overCostReceipt, workRequest)).toThrow(ContractError);

      // Token budget exceeded -> BUDGET_EXCEEDED
      const overTokenReceipt = {
        ...receipt,
        metering: { ...receipt.metering, tokens: workRequest.budget.max_tokens + 1 },
      };
      expect(() => validateExecutionReceipt(overTokenReceipt, workRequest)).toThrow(ContractError);
    });
  });

  // ==========================================================================
  // AREA 4: Symmetrical Owner State Normalization & Transition Qualification
  // ==========================================================================
  describe('Area 4: Symmetrical Owner State Normalization & Transitions', () => {
    it('normalizes IN_FLIGHT -> EXECUTING and INTENDED -> INTENT during checkReceiptBinding', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest, { outcome: 'failed' });

      receipt.effects = [
        {
          effect_id: 'eff-inflight',
          intent_digest: DUMMY_DIGEST,
          state: 'IN_FLIGHT' as any,
          evidence_ref: null,
        },
        {
          effect_id: 'eff-intended',
          intent_digest: DUMMY_DIGEST_B,
          state: 'INTENDED' as any,
          evidence_ref: null,
        },
      ];

      expect(() => checkReceiptBinding(receipt, workRequest)).not.toThrow();
      expect(receipt.effects[0].state).toBe('EXECUTING');
      expect(receipt.effects[1].state).toBe('INTENT');
    });

    it('maps CandidateEffectPhase to AuthoritativeOwnerState symmetrically via projectEffectState', () => {
      expect(projectEffectState('INTENT')).toBe('INTENDED');
      expect(projectEffectState('EXECUTING')).toBe('IN_FLIGHT');
      expect(projectEffectState('SUCCEEDED')).toBe('SUCCEEDED');
      expect(projectEffectState('FAILED')).toBe('FAILED');
      expect(projectEffectState('UNKNOWN')).toBe('UNKNOWN');
      expect(projectEffectState('RECONCILING')).toBe('UNKNOWN');
      expect(projectEffectState('MANUAL')).toBe('UNKNOWN');

      expect(() => projectEffectState('INVALID_PHASE' as any)).toThrow(ContractError);
    });

    it('enforces rigorous state machine edges via checkEffectTransition', () => {
      // Allowed transitions
      expect(() => checkEffectTransition('INTENT', 'EXECUTING')).not.toThrow();
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', DUMMY_DIGEST)).not.toThrow();
      expect(() => checkEffectTransition('EXECUTING', 'FAILED', DUMMY_DIGEST)).not.toThrow();
      expect(() => checkEffectTransition('EXECUTING', 'UNKNOWN')).not.toThrow();
      expect(() => checkEffectTransition('UNKNOWN', 'RECONCILING')).not.toThrow();
      expect(() => checkEffectTransition('RECONCILING', 'SUCCEEDED', DUMMY_DIGEST)).not.toThrow();
      expect(() => checkEffectTransition('RECONCILING', 'FAILED', DUMMY_DIGEST)).not.toThrow();
      expect(() => checkEffectTransition('RECONCILING', 'MANUAL')).not.toThrow();

      // Forbidden transitions
      expect(() => checkEffectTransition('UNKNOWN', 'EXECUTING')).toThrow(ContractError);
      expect(() => checkEffectTransition('SUCCEEDED', 'EXECUTING')).toThrow(ContractError);
      expect(() => checkEffectTransition('FAILED', 'EXECUTING')).toThrow(ContractError);
      expect(() => checkEffectTransition('MANUAL', 'EXECUTING')).toThrow(ContractError);
      expect(() => checkEffectTransition('INTENT', 'SUCCEEDED', DUMMY_DIGEST)).toThrow(ContractError);

      // Terminal transition without evidence ref fails
      expect(() => checkEffectTransition('EXECUTING', 'SUCCEEDED', null)).toThrow(ContractError);
      expect(() => checkEffectTransition('EXECUTING', 'FAILED', undefined)).toThrow(ContractError);
    });

    it('validates checkOwnedReceiptBinding with matching snapshot and intents', () => {
      const workRequest = runner.buildWorkRequest(baselineSpec);
      const receipt = generateSimulationReceipt(workRequest);
      const observedMs = Date.parse(receipt.observed_at);
      const deadlineMs = Date.parse(workRequest.deadline);
      const nowMs = Math.floor((observedMs + 1000) / 1000) * 1000;
      const now = new Date(nowMs).toISOString();

      const snapshot: AdmissionSnapshot = {
        scope: workRequest.scope,
        request_digest: receipt.request_digest,
        provider_binding_ref: receipt.provider_binding_ref,
        lease: receipt.lease,
        admitted: true,
        revoked: false,
        lease_expires_at: workRequest.deadline,
        authority_expires_at: workRequest.deadline,
      };

      const childExec = {
        schema: 'ct-child-execution.v1',
        mission_id: workRequest.scope.mission_id,
        generation: workRequest.scope.generation,
        logical_child_id: workRequest.scope.logical_child_id,
        execution_id: workRequest.scope.execution_id,
        attempt: 1,
        state: 'RUNNING' as const,
      };

      const effect = receipt.effects[0];
      const effectIntent = {
        schema: 'ct-effect-intent.v1',
        effect_intent_id: effect.effect_id,
        mission_id: workRequest.scope.mission_id,
        generation: workRequest.scope.generation,
        logical_child_id: workRequest.scope.logical_child_id,
        execution_id: workRequest.scope.execution_id,
        fencing_epoch: workRequest.scope.fencing_epoch,
        effect_type: 'review_finding',
        authority_envelope_digest: DUMMY_DIGEST_C,
        state: projectEffectState(effect.state),
        receipt_ref: effect.evidence_ref || undefined,
      };

      // Set the intent_digest to match the computed owner intent digest
      effect.intent_digest = ownerIntentDigest(effectIntent);

      const ownerSnapshot = {
        child_execution: childExec,
        effect_intents: [effectIntent],
        fencing_epoch: workRequest.scope.fencing_epoch,
      };

      expect(() =>
        checkOwnedReceiptBinding(workRequest, receipt, snapshot, now, ownerSnapshot)
      ).not.toThrow();

      // Fails when child state is not RUNNING
      const nonRunningOwner = {
        ...ownerSnapshot,
        child_execution: { ...childExec, state: 'FAILED' },
      };
      expect(() =>
        checkOwnedReceiptBinding(workRequest, receipt, snapshot, now, nonRunningOwner)
      ).toThrow(ContractError);

      // Fails when owner fencing epoch mismatches scope
      const epochMismatchOwner = {
        ...ownerSnapshot,
        fencing_epoch: workRequest.scope.fencing_epoch + 1,
      };
      expect(() =>
        checkOwnedReceiptBinding(workRequest, receipt, snapshot, now, epochMismatchOwner)
      ).toThrow(ContractError);
    });
  });

  // ==========================================================================
  // AREA 5: Task Observer Lifecycle (API-3333) & Zero-Retention
  // ==========================================================================
  describe('Area 5: Task Observer Lifecycle (API-3333) & Zero-Retention', () => {
    it('caps proposals at <= 5 and calculates accurate overflow_count', () => {
      const proposals = Array.from({ length: 8 }, (_, i) => ({
        candidate_id: `cand-${i + 1}`,
        impact: (i % 3 === 0 ? 'high' : i % 2 === 0 ? 'medium' : 'low') as any,
        recurrence: i * 2,
        phase: 'INTENT' as const,
      }));

      const checkpoint = createTaskObserverCheckpoint({
        checkpoint_id: 'chk-cap-test',
        observed_at: '2026-09-28T01:00:00.000Z',
        proposals,
        permission_denied: false,
      });

      expect(checkpoint.proposals.length).toBe(MAX_CHECKPOINT_PROPOSALS);
      expect(checkpoint.proposals.length).toBe(5);
      expect(checkpoint.overflow_count).toBe(3);
    });

    it('sorts proposals by impact (high > medium > low), then recurrence (descending)', () => {
      const checkpoint = createTaskObserverCheckpoint({
        checkpoint_id: 'chk-sort-test',
        observed_at: '2026-09-28T01:00:00.000Z',
        proposals: [
          { candidate_id: 'c-low-10', impact: 'low', recurrence: 10, phase: 'INTENT' },
          { candidate_id: 'c-high-1', impact: 'high', recurrence: 1, phase: 'INTENT' },
          { candidate_id: 'c-med-5', impact: 'medium', recurrence: 5, phase: 'INTENT' },
          { candidate_id: 'c-high-5', impact: 'high', recurrence: 5, phase: 'INTENT' },
        ],
        permission_denied: false,
      });

      // Expected order: c-high-5, c-high-1, c-med-5, c-low-10
      expect(checkpoint.proposals[0].candidate_id).toBe('c-high-5');
      expect(checkpoint.proposals[1].candidate_id).toBe('c-high-1');
      expect(checkpoint.proposals[2].candidate_id).toBe('c-med-5');
      expect(checkpoint.proposals[3].candidate_id).toBe('c-low-10');
    });

    it('enforces zero-retention rejecting raw diffs, patches, transcripts, or code memory', () => {
      const forbiddenPayloads = [
        { candidate_id: 'c1', impact: 'high', recurrence: 1, phase: 'INTENT', diff: '--- a/file\n+++ b/file' },
        { candidate_id: 'c2', impact: 'high', recurrence: 1, phase: 'INTENT', patch: 'patch content' },
        { candidate_id: 'c3', impact: 'high', recurrence: 1, phase: 'INTENT', hunk: '@@ -1,4 +1,5 @@' },
        { candidate_id: 'c4', impact: 'high', recurrence: 1, phase: 'INTENT', transcript: 'user: hello\nagent: hi' },
        { candidate_id: 'c5', impact: 'high', recurrence: 1, phase: 'INTENT', messages: ['hello', 'world'] },
        { candidate_id: 'c6', impact: 'high', recurrence: 1, phase: 'INTENT', prompt: 'evaluate diff' },
        { candidate_id: 'c7', impact: 'high', recurrence: 1, phase: 'INTENT', code: 'function exploit() {}' },
        { candidate_id: 'c8', impact: 'high', recurrence: 1, phase: 'INTENT', content: 'raw code content' },
      ];

      for (const forbidden of forbiddenPayloads) {
        expect(() => sanitizeCheckpointProposal(forbidden as any)).toThrow(ContractError);
        try {
          sanitizeCheckpointProposal(forbidden as any);
        } catch (err: any) {
          expect(err.code).toBe('INVALID_SHAPE');
        }
      }
    });

    it('treats classifier permission denial as an immutable hard stop signal', () => {
      const manager = new TaskObserverLifecycleManager();
      const executionId = 'exec-denial-test';

      // Submit checkpoint with permission_denied: true
      const result = manager.submitCheckpoint(
        {
          checkpoint_id: 'chk-denied-1',
          observed_at: '2026-09-28T01:00:00.000Z',
          proposals: [
            { candidate_id: 'c-denied', impact: 'high', recurrence: 1, phase: 'INTENT' },
          ],
          permission_denied: true,
        },
        executionId
      );

      expect(result.halted).toBe(true);
      expect(manager.isHalted(executionId)).toBe(true);

      // Subsequent checkpoint submission must fail closed with AUTHORITY_DENIED
      expect(() =>
        manager.submitCheckpoint(
          {
            checkpoint_id: 'chk-after-denied',
            observed_at: '2026-09-28T01:05:00.000Z',
            proposals: [
              { candidate_id: 'c-next', impact: 'low', recurrence: 1, phase: 'INTENT' },
            ],
            permission_denied: false,
          },
          executionId
        )
      ).toThrow(ContractError);

      try {
        manager.submitCheckpoint(
          {
            checkpoint_id: 'chk-after-denied',
            observed_at: '2026-09-28T01:05:00.000Z',
            proposals: [],
            permission_denied: false,
          },
          executionId
        );
      } catch (err: any) {
        expect(err.code).toBe('AUTHORITY_DENIED');
      }
    });
  });
});
