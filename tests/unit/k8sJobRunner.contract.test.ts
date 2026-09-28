import { describe, it, expect } from 'vitest';
import {
  K8sJobRunner,
  canonicalJson,
  computeRequestDigest,
  normalizeRepository,
  checkReceiptBinding,
  validateExecutionReceipt,
  generateSimulationReceipt,
  requestDigest,
  ContractError,
} from '../../src/infrastructure/k8sJobRunner';
import { validateWorkRequest } from '../../src/schemas/agentHarnessContracts';


describe('K8sJobRunner ct-agent-work-request.v1 & Fencing Lifecycle (Milestone 1)', () => {
  // Test 1: Constructs conforming ct-agent-work-request.v1 envelope with custom scope parameters
  it('constructs conforming ct-agent-work-request.v1 envelope with custom scope parameters', () => {
    const runner = new K8sJobRunner();

    const spec = {
      persona: 'security',
      repoUrl: 'https://github.com/exampleorg/example-api.git',
      prNumber: 3012,
      commitSha: 'e4d3c2b1a098',
      logicalChildId: 'security-audit-01',
      fencingEpoch: 7,
      missionId: 'mission-omega-9',
      generation: 3,
      executionId: 'exec-sec-3012-g3',
      tenantId: 'ct-prod',
      environmentId: 'staging-k8s',
      workspaceId: 'ws-main',
    };

    const workRequest = runner.buildWorkRequest(spec);

    expect(workRequest.schema).toBe('ct-agent-work-request.v1');
    expect(workRequest.scope).toEqual({
      tenant_id: 'ct-prod',
      environment_id: 'staging-k8s',
      workspace_id: 'ws-main',
      repository: 'exampleorg/example-api',
      mission_id: 'mission-omega-9',
      generation: 3,
      execution_id: 'exec-sec-3012-g3',
      logical_child_id: 'security-audit-01',
      fencing_epoch: 7,
    });

    expect(validateWorkRequest(workRequest)).toBeDefined();
    expect(workRequest.created_at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
    expect(workRequest.deadline).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
    expect(new Date(workRequest.created_at).getTime()).toBeLessThan(new Date(workRequest.deadline).getTime());
  });

  // Test 2: Provides safe default scope values when optional parameters are omitted
  it('provides safe default scope values when optional parameters are omitted', () => {
    const runner = new K8sJobRunner();

    const spec = {
      persona: 'performance',
      repoUrl: 'exampleorg/example-meta',
      prNumber: 104,
      commitSha: '112233445566',
    };

    const workRequest = runner.buildWorkRequest(spec);

    expect(workRequest.scope.tenant_id).toBe('ct');
    expect(workRequest.scope.environment_id).toBe('qualification');
    expect(workRequest.scope.workspace_id).toBe('factory');
    expect(workRequest.scope.repository).toBe('exampleorg/example-meta');
    expect(workRequest.scope.generation).toBe(1);
    expect(workRequest.scope.fencing_epoch).toBe(1);
    expect(workRequest.scope.logical_child_id).toBe('child-performance');
    expect(workRequest.scope.execution_id).toContain('exec-performance-pr104');
    expect(workRequest.scope.mission_id).toContain('mission-pr104');
    expect(validateWorkRequest(workRequest)).toBeDefined();
  });

  // Test 3: Fails closed when fencingEpoch is non-positive or non-integer
  it('fails closed when fencingEpoch is non-positive or non-integer', () => {
    const runner = new K8sJobRunner();

    expect(() =>
      runner.buildWorkRequest({
        persona: 'sec',
        repoUrl: 'org/repo',
        prNumber: 1,
        commitSha: 'abc',
        fencingEpoch: 0,
      })
    ).toThrow(/FENCING_MISMATCH/);

    expect(() =>
      runner.buildWorkRequest({
        persona: 'sec',
        repoUrl: 'org/repo',
        prNumber: 1,
        commitSha: 'abc',
        fencingEpoch: -5,
      })
    ).toThrow(/FENCING_MISMATCH/);

    expect(() =>
      runner.buildWorkRequest({
        persona: 'sec',
        repoUrl: 'org/repo',
        prNumber: 1,
        commitSha: 'abc',
        fencingEpoch: 2.5,
      })
    ).toThrow(/FENCING_MISMATCH/);
  });

  // Test 4: Enforces payload size check (<= 65,536 bytes) on work request generation
  it('enforces payload size check (<= 65,536 bytes) on work request generation', () => {
    const runner = new K8sJobRunner();
    const workRequest = runner.buildWorkRequest({
      persona: 'sec',
      repoUrl: 'org/repo',
      prNumber: 42,
      commitSha: 'abc1234',
    });

    const { canonicalPayload, byteLength, digest } = computeRequestDigest(workRequest);
    expect(byteLength).toBeLessThanOrEqual(65536);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Verify key ordering in canonical JSON
    const parsed = JSON.parse(canonicalPayload);
    const keys = Object.keys(parsed);
    const sortedKeys = [...keys].sort();
    expect(keys).toEqual(sortedKeys);
  });

  // Test 5: Guarantees exact .000Z timestamp formatting for created_at and deadline
  it('guarantees exact .000Z timestamp formatting for created_at and deadline', () => {
    const runner = new K8sJobRunner();
    const workRequest = runner.buildWorkRequest({
      persona: 'sec',
      repoUrl: 'org/repo',
      prNumber: 10,
      commitSha: 'abc1234',
      activeDeadlineSeconds: 300,
    });

    expect(workRequest.created_at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/);
    expect(workRequest.deadline).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/);
    expect(new Date(workRequest.deadline).getTime() - new Date(workRequest.created_at).getTime()).toBe(300000);
  });

  // Test 6: Injects CT_* harness variables and Downward API into Job manifest container
  it('injects CT_* harness variables and Downward API into Job manifest container', () => {
    const runner = new K8sJobRunner();

    const manifest = runner.generateJobManifest({
      persona: 'architecture',
      repoUrl: 'exampleorg/example-api',
      prNumber: 501,
      commitSha: 'a1b2c3d4e5f6',
      logicalChildId: 'arch-child-01',
      fencingEpoch: 4,
      envVars: { CUSTOM_SETTING: 'active' },
    });

    const container = manifest.spec.template.spec.containers[0];
    const envMap = new Map(container.env.map((entry) => [entry.name, entry.value || entry.valueFrom]));

    expect(envMap.get('CT_LOGICAL_CHILD_ID')).toBe('arch-child-01');
    expect(envMap.get('CT_FENCING_EPOCH')).toBe('4');
    expect(envMap.get('CT_REPOSITORY')).toBe('exampleorg/example-api');
    expect(envMap.get('CT_WORK_REQUEST_PATH')).toBe('/workspace/.ct-harness/arch-child-01/1/work-request.json');
    expect(envMap.get('CT_EXECUTION_RECEIPT_PATH')).toBe('/workspace/.ct-harness/arch-child-01/1/execution-receipt.json');
    expect(envMap.get('CT_POD_NAME')).toEqual({ fieldRef: { fieldPath: 'metadata.name' } });
    expect(envMap.get('CT_POD_NAMESPACE')).toEqual({ fieldRef: { fieldPath: 'metadata.namespace' } });
    expect(envMap.get('PERSONA')).toBe('architecture');
    expect(envMap.get('CUSTOM_SETTING')).toBe('active');
  });

  // Test 7: Stages work-request.json via an initContainer on the workspace volume
  it('stages work-request.json via an initContainer on the workspace volume', () => {
    const runner = new K8sJobRunner();

    const manifest = runner.generateJobManifest({
      persona: 'compliance',
      repoUrl: 'exampleorg/example-api',
      prNumber: 602,
      commitSha: 'deadbeef1234',
    });

    const initContainers = manifest.spec.template.spec.initContainers;
    expect(initContainers).toBeDefined();
    expect(initContainers?.length).toBe(1);

    const stageInit = initContainers![0];
    expect(stageInit.name).toBe('stage-work-request');
    expect(stageInit.volumeMounts[0].mountPath).toBe('/workspace');
    expect(stageInit.volumeMounts[0].name).toBe('workspace-volume');

    const payloadEnv = stageInit.env?.find((e) => e.name === 'CT_WORK_REQUEST_PAYLOAD');
    expect(payloadEnv).toBeDefined();
    expect(payloadEnv?.value).toContain('"schema":"ct-agent-work-request.v1"');
  });

  // Test 8: Strictly enforces the controlled boundary (ct-review-system namespace)
  it('strictly enforces the controlled boundary (ct-review-system namespace)', () => {
    const runner = new K8sJobRunner({ namespace: 'ct-review-system' });

    const manifest = runner.generateJobManifest({
      persona: 'sec',
      repoUrl: 'exampleorg/example-api',
      prNumber: 10,
      commitSha: '1234567890',
    });

    expect(manifest.metadata.namespace).toBe('ct-review-system');

    expect(() =>
      new K8sJobRunner({ namespace: 'default' })
    ).toThrow(/INVALID_SHAPE/);

    expect(() =>
      new K8sJobRunner({ namespace: 'kube-system' })
    ).toThrow(/INVALID_SHAPE/);

    expect(() =>
      new K8sJobRunner({ namespace: '' })
    ).toThrow(/INVALID_SHAPE/);

    expect(() =>
      runner.generateJobManifest({
        persona: 'sec',
        repoUrl: 'exampleorg/example-api',
        prNumber: 10,
        commitSha: '1234567890',
        namespace: 'kube-public',
      })
    ).toThrow(/INVALID_SHAPE/);

    expect(() =>
      runner.generateJobManifest({
        persona: 'sec',
        repoUrl: 'exampleorg/example-api',
        prNumber: 10,
        commitSha: '1234567890',
        namespace: '',
      })
    ).toThrow(/INVALID_SHAPE/);
  });

  // Test 9: Dispatches job in simulation mode and returns complete dispatch outcome
  it('dispatches job in simulation mode and returns complete dispatch outcome', async () => {
    const runner = new K8sJobRunner({ forceSimulation: true });

    const result = await runner.dispatchJob({
      persona: 'quality',
      repoUrl: 'exampleorg/example-api',
      prNumber: 88,
      commitSha: 'aabbccddeeff',
      logicalChildId: 'qa-child-88',
      fencingEpoch: 2,
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('simulation');
    expect(result.jobName).toContain('ct-agent-quality-pr88');
    expect(result.namespace).toBe('ct-review-system');
    expect(result.workRequest.scope.logical_child_id).toBe('qa-child-88');
    expect(result.workRequest.scope.fencing_epoch).toBe(2);
    expect(result.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.manifest.metadata.name).toBe(result.jobName);
  });

  // Test 10: Preserves backward compatibility for existing job specs and execution options
  it('preserves backward compatibility for existing job specs and execution options', () => {
    const runner = new K8sJobRunner({
      defaultPvcName: 'custom-workspace-pvc',
    });

    const manifest = runner.generateJobManifest({
      persona: 'qa',
      repoUrl: 'https://github.com/exampleorg/example-meta.git',
      prNumber: 777,
      commitSha: 'c0ffee123456',
      cpuRequest: '100m',
      cpuLimit: '800m',
      memoryRequest: '256Mi',
      memoryLimit: '2Gi',
      activeDeadlineSeconds: 900,
      ttlSecondsAfterFinished: 450,
      pvcClaimName: 'override-pvc',
    });

    expect(manifest.spec.activeDeadlineSeconds).toBe(900);
    expect(manifest.spec.ttlSecondsAfterFinished).toBe(450);

    const container = manifest.spec.template.spec.containers[0];
    expect(container.resources.requests.cpu).toBe('100m');
    expect(container.resources.requests.memory).toBe('256Mi');
    expect(container.resources.limits.cpu).toBe('800m');
    expect(container.resources.limits.memory).toBe('2Gi');

    const volume = manifest.spec.template.spec.volumes[0];
    expect(volume.persistentVolumeClaim?.claimName).toBe('override-pvc');
  });

  // Test 11: Fails closed on falsy or invalid parameters
  it('fails closed on empty string or invalid parameters across work request and manifest generation', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const validSpec = {
      persona: 'security',
      repoUrl: 'exampleorg/example-api',
      prNumber: 10,
      commitSha: '1234567890',
    };

    expect(() => new K8sJobRunner({ defaultImage: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => new K8sJobRunner({ defaultPvcName: '' })).toThrow(/INVALID_SHAPE/);

    expect(() => runner.buildWorkRequest({ ...validSpec, tenantId: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, environmentId: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, workspaceId: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, missionId: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, logicalChildId: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, executionId: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, idempotencyKey: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, persona: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, commitSha: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.buildWorkRequest({ ...validSpec, prNumber: 0 })).toThrow(/INVALID_SHAPE/);

    expect(() => runner.generateJobManifest({ ...validSpec, image: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.generateJobManifest({ ...validSpec, pvcClaimName: '' })).toThrow(/INVALID_SHAPE/);
    expect(() => runner.generateJobManifest({ ...validSpec, jobName: '' })).toThrow(/INVALID_SHAPE/);
  });

  // Test 12: Generates conforming simulation receipt with matching scope and canonical request digest (Milestone 2)
  it('generates conforming simulation receipt with matching scope and canonical request digest', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'security',
      repoUrl: 'exampleorg/example-api',
      prNumber: 99,
      commitSha: '998877665544',
      logicalChildId: 'sec-child-99',
      fencingEpoch: 5,
    });

    const receipt = runner.generateSimulationReceipt(workRequest);

    expect(receipt.schema).toBe('ct-agent-execution-receipt.v1');
    expect(receipt.request_digest).toBe(requestDigest(workRequest));
    expect(receipt.scope).toEqual(workRequest.scope);
    expect(receipt.outcome).toBe('succeeded');
    expect(receipt.evidence_refs.length).toBeGreaterThan(0);
    expect(receipt.effects.every((e) => e.state === 'SUCCEEDED')).toBe(true);
    expect(receipt.lease.fencing_token).toBe(5);
    expect(receipt.started_at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
    expect(receipt.observed_at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/);
  });

  // Test 13: checkReceiptBinding validates matching receipt and work request
  it('checkReceiptBinding validates matching receipt and work request without error', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
    });

    const receipt = generateSimulationReceipt(workRequest);

    expect(() => runner.checkReceiptBinding(receipt, workRequest)).not.toThrow();
    expect(() => checkReceiptBinding(workRequest, receipt)).not.toThrow();
  });

  // Test 14: checkReceiptBinding fails closed with REQUEST_DRIFT if request digest differs
  it('checkReceiptBinding fails closed with REQUEST_DRIFT if request digest differs', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
    });

    const receipt = generateSimulationReceipt(workRequest, { tamperDigest: true });

    expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
    try {
      checkReceiptBinding(receipt, workRequest);
    } catch (err: any) {
      expect(err.code).toBe('REQUEST_DRIFT');
    }
  });

  // Test 15: checkReceiptBinding fails closed with SCOPE_MISMATCH if any scope field differs
  it('checkReceiptBinding fails closed with SCOPE_MISMATCH if any scope field differs', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
    });

    const receipt = generateSimulationReceipt(workRequest, { tamperScope: true });

    expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
    try {
      checkReceiptBinding(receipt, workRequest);
    } catch (err: any) {
      expect(err.code).toBe('SCOPE_MISMATCH');
    }
  });

  // Test 16: checkReceiptBinding fails closed with SUCCESS_EVIDENCE_REQUIRED if succeeded with empty evidence_refs
  it('checkReceiptBinding fails closed with SUCCESS_EVIDENCE_REQUIRED if succeeded with empty evidence_refs', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
    });

    const receipt = generateSimulationReceipt(workRequest, { omitEvidence: true });

    expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
    try {
      checkReceiptBinding(receipt, workRequest);
    } catch (err: any) {
      expect(err.code).toBe('SUCCESS_EVIDENCE_REQUIRED');
    }
  });

  // Test 17: checkReceiptBinding fails closed with UNRESOLVED_EFFECT if succeeded with non-succeeded effects
  it('checkReceiptBinding fails closed with UNRESOLVED_EFFECT if succeeded with non-succeeded effects', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
    });

    const receipt = generateSimulationReceipt(workRequest, { unresolvedEffect: true });

    expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
    try {
      checkReceiptBinding(receipt, workRequest);
    } catch (err: any) {
      expect(err.code).toBe('UNRESOLVED_EFFECT');
    }
  });

  // Test 18: checkReceiptBinding fails closed with EFFECT_EVIDENCE_REQUIRED if terminal effect lacks evidence_ref
  it('checkReceiptBinding fails closed with EFFECT_EVIDENCE_REQUIRED if terminal effect lacks evidence_ref', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
    });

    const receipt = generateSimulationReceipt(workRequest);
    receipt.effects[0].evidence_ref = null;

    expect(() => checkReceiptBinding(receipt, workRequest)).toThrow(ContractError);
    try {
      checkReceiptBinding(receipt, workRequest);
    } catch (err: any) {
      expect(err.code).toBe('EFFECT_EVIDENCE_REQUIRED');
    }
  });

  // Test 19: validateExecutionReceipt fails closed with INVALID_RECEIPT_TIME if timestamps are reversed
  it('validateExecutionReceipt fails closed with INVALID_RECEIPT_TIME if timestamps are reversed', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
    });

    const receipt = generateSimulationReceipt(workRequest);
    receipt.started_at = '2026-09-27T18:05:00.000Z';
    receipt.observed_at = '2026-09-27T18:00:00.000Z';

    expect(() => runner.validateExecutionReceipt(receipt, workRequest)).toThrow(ContractError);
    try {
      runner.validateExecutionReceipt(receipt, workRequest);
    } catch (err: any) {
      expect(err.code).toBe('INVALID_RECEIPT_TIME');
    }
  });

  // Test 20: validateExecutionReceipt fails closed with AUTHORITY_EXPIRED if observed_at exceeds deadline
  it('validateExecutionReceipt fails closed with AUTHORITY_EXPIRED if observed_at exceeds deadline', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
      activeDeadlineSeconds: 300,
    });

    const receipt = generateSimulationReceipt(workRequest);
    const deadlineMs = new Date(workRequest.deadline).getTime();
    receipt.observed_at = new Date(deadlineMs + 10000).toISOString();

    expect(() => runner.validateExecutionReceipt(receipt, workRequest)).toThrow(ContractError);
    try {
      runner.validateExecutionReceipt(receipt, workRequest);
    } catch (err: any) {
      expect(err.code).toBe('AUTHORITY_EXPIRED');
    }
  });

  // Test 21: validateExecutionReceipt fails closed with BUDGET_EXCEEDED if metering exceeds budget
  it('validateExecutionReceipt fails closed with BUDGET_EXCEEDED if metering exceeds budget', () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const workRequest = runner.buildWorkRequest({
      persona: 'qa',
      repoUrl: 'exampleorg/example-api',
      prNumber: 123,
      commitSha: 'fedcba987654',
      budget: { maxCostMicrousd: 500, maxTokens: 1000 },
    });

    const receipt = generateSimulationReceipt(workRequest, { costMicrousd: 99999 });

    expect(() => runner.validateExecutionReceipt(receipt, workRequest)).toThrow(ContractError);
    try {
      runner.validateExecutionReceipt(receipt, workRequest);
    } catch (err: any) {
      expect(err.code).toBe('BUDGET_EXCEEDED');
    }
  });

  // Test 22: executeJob completes in simulation mode returning valid workRequest and receipt envelopes
  it('executeJob completes in simulation mode returning valid workRequest and receipt envelopes', async () => {
    const runner = new K8sJobRunner({ forceSimulation: true });
    const result = await runner.executeJob({
      persona: 'architecture',
      repoUrl: 'exampleorg/example-api',
      prNumber: 555,
      commitSha: '123456789abc',
      logicalChildId: 'arch-child-555',
      fencingEpoch: 4,
    });

    expect(result.success).toBe(true);
    expect(result.workRequest.schema).toBe('ct-agent-work-request.v1');
    expect(result.receipt?.schema).toBe('ct-agent-execution-receipt.v1');
    expect(result.receipt?.scope.logical_child_id).toBe('arch-child-555');
    expect(result.receipt?.scope.fencing_epoch).toBe(4);
    expect(result.requestDigest).toBe(requestDigest(result.workRequest));
    expect(result.receipt?.request_digest).toBe(result.requestDigest);
  });
});

