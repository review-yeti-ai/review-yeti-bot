import { describe, it, expect } from 'vitest';
import {
  K8sJobRunner,
  computeRequestDigest,
  normalizeRepository,
  type K8sJobSpec,
} from '../../src/infrastructure/k8sJobRunner';
import { validateWorkRequest, MAX_CONTRACT_BYTES } from '../../src/schemas/agentHarnessContracts';

describe('Empirical Adversarial Stress Suite: K8sJobRunner (challenger_m1_2)', () => {
  const baseSpec: K8sJobSpec = {
    persona: 'security',
    repoUrl: 'exampleorg/example-api',
    prNumber: 42,
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
  };

  // ==========================================================================
  // Area 1: Boundary Fencing Epochs
  // ==========================================================================
  describe('Area 1: Boundary Fencing Epochs', () => {
    const invalidEpochs = [
      { val: 0, label: '0 (zero)' },
      { val: -1, label: '-1 (negative)' },
      { val: -100, label: '-100 (large negative)' },
      { val: 1.5, label: '1.5 (float)' },
      { val: 0.1, label: '0.1 (fractional)' },
      { val: NaN, label: 'NaN (Not a Number)' },
      { val: Infinity, label: 'Infinity' },
      { val: -Infinity, label: '-Infinity' },
      { val: -0, label: '-0 (negative zero)' },
      { val: '1' as any, label: "'1' (string number)" },
      { val: true as any, label: 'true (boolean)' },
    ];

    for (const { val, label } of invalidEpochs) {
      it(`fails closed with FENCING_MISMATCH for fencingEpoch = ${label}`, () => {
        const runner = new K8sJobRunner({ forceSimulation: true });
        expect(() => {
          runner.buildWorkRequest({
            ...baseSpec,
            fencingEpoch: val,
          });
        }).toThrow(/FENCING_MISMATCH/);
      });
    }

    it('accepts valid positive integer fencing epochs', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      for (const validEpoch of [1, 2, 10, 100, 999999]) {
        const req = runner.buildWorkRequest({
          ...baseSpec,
          fencingEpoch: validEpoch,
        });
        expect(req.scope.fencing_epoch).toBe(validEpoch);
      }
    });

    it('injects default fencingEpoch = 1 when undefined', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const req = runner.buildWorkRequest({ ...baseSpec });
      expect(req.scope.fencing_epoch).toBe(1);
    });

    it('adversarially probes MAX_SAFE_INTEGER overflow', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      // Number.MAX_SAFE_INTEGER + 1 exceeds PositiveCounterSchema max
      expect(() => {
        runner.buildWorkRequest({
          ...baseSpec,
          fencingEpoch: Number.MAX_SAFE_INTEGER + 1,
        });
      }).toThrow();
    });
  });

  // ==========================================================================
  // Area 2: Boundary Namespaces
  // ==========================================================================
  describe('Area 2: Boundary Namespaces', () => {
    it('fails closed when attempting to target default namespace in constructor', () => {
      expect(() => new K8sJobRunner({ namespace: 'default' })).toThrow(/INVALID_SHAPE/);
    });

    it('fails closed when attempting to target kube-system namespace in constructor', () => {
      expect(() => new K8sJobRunner({ namespace: 'kube-system' })).toThrow(/INVALID_SHAPE/);
    });

    it('fails closed when attempting to target kube-public or kube-node-lease', () => {
      expect(() => new K8sJobRunner({ namespace: 'kube-public' })).toThrow(/INVALID_SHAPE/);
      expect(() => new K8sJobRunner({ namespace: 'kube-node-lease' })).toThrow(/INVALID_SHAPE/);
    });

    it('fails closed when attempting to target default in generateJobManifest', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() =>
        runner.generateJobManifest({
          ...baseSpec,
          namespace: 'default',
        })
      ).toThrow(/INVALID_SHAPE/);
    });

    it('fails closed when attempting to target kube-system in generateJobManifest', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() =>
        runner.generateJobManifest({
          ...baseSpec,
          namespace: 'kube-system',
        })
      ).toThrow(/INVALID_SHAPE/);
    });

    it('fails closed on malformed namespaces (RFC 1123 violations)', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const malformed = ['-leading-dash', 'trailing-dash-', 'UPPERCASE', 'has space', 'has_underscore', 'a'.repeat(64)];
      for (const ns of malformed) {
        expect(() => runner.generateJobManifest({ ...baseSpec, namespace: ns })).toThrow(/INVALID_SHAPE/);
      }
    });

    it('fails closed when attempting to target empty string namespace in constructor', () => {
      expect(() => new K8sJobRunner({ namespace: '', forceSimulation: true })).toThrow(/INVALID_SHAPE/);
    });

    it('fails closed when attempting to target empty string namespace in generateJobManifest', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() =>
        runner.generateJobManifest({
          ...baseSpec,
          namespace: '',
        })
      ).toThrow(/INVALID_SHAPE/);
    });
  });

  // ==========================================================================
  // Area 3: Missing Required Parameters & Deterministic Defaults
  // ==========================================================================
  describe('Area 3: Missing Required Parameters & Deterministic Defaults', () => {
    it('injects deterministic defaults when all optional parameters are omitted', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const req = runner.buildWorkRequest(baseSpec);

      expect(req.schema).toBe('ct-agent-work-request.v1');
      expect(req.scope.fencing_epoch).toBe(1);
      expect(req.scope.generation).toBe(1);
      expect(req.scope.tenant_id).toBe('ct');
      expect(req.scope.environment_id).toBe('qualification');
      expect(req.scope.workspace_id).toBe('factory');
      expect(req.scope.repository).toBe('exampleorg/example-api');
      expect(req.scope.logical_child_id).toBe('child-security');
      expect(req.scope.execution_id).toBe('exec-security-pr42-abcdef1-g1');
      expect(req.scope.mission_id).toBe('mission-pr42-abcdef1');
      expect(req.work_kind).toBe('review');
      expect(req.capabilities).toEqual(['artifact.read', 'review.execute']);
      expect(req.budget).toEqual({
        max_cost_microusd: 1000000,
        max_tokens: 250000,
        max_duration_ms: 600000,
        concurrency_class: 'qualification',
      });
      expect(req.created_at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/);
      expect(req.deadline).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$/);

      // Contract validation must pass cleanly
      const validated = validateWorkRequest(req);
      expect(validated).toBeDefined();

      // Request digest must be valid
      const { digest, byteLength } = computeRequestDigest(req);
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(byteLength).toBeLessThanOrEqual(MAX_CONTRACT_BYTES);
    });

    it('fails closed when required repository URL is invalid or missing', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => runner.buildWorkRequest({ ...baseSpec, repoUrl: '' })).toThrow(/INVALID_SHAPE/);
      expect(() => runner.buildWorkRequest({ ...baseSpec, repoUrl: 'noncompliant-repo' })).toThrow(/INVALID_SHAPE/);
      expect(() => runner.buildWorkRequest({ ...baseSpec, repoUrl: undefined as any })).toThrow();
    });

    it('fails closed when required persona is missing or invalid', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => runner.buildWorkRequest({ ...baseSpec, persona: undefined as any })).toThrow();
    });

    it('fails closed when commitSha is missing or invalid', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => runner.buildWorkRequest({ ...baseSpec, commitSha: undefined as any })).toThrow();
    });

    it('sanitizes persona to valid DNS/ID pattern', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const req = runner.buildWorkRequest({
        ...baseSpec,
        persona: 'Security & Red-Team Expert!',
      });
      expect(req.scope.logical_child_id).toBe('child-security---red-team-expert-');
    });

    it('normalizes repository formats properly', () => {
      expect(normalizeRepository('https://github.com/exampleorg/example-api.git')).toBe('exampleorg/example-api');
      expect(normalizeRepository('git@github.com:exampleorg/example-api.git')).toBe('exampleorg/example-api');
      expect(normalizeRepository('exampleorg/example-api')).toBe('exampleorg/example-api');
    });
  });

  // ==========================================================================
  // Area 4: Volume Mounts & InitContainer Generation
  // ==========================================================================
  describe('Area 4: Volume Mounts & InitContainer Generation', () => {
    it('generates valid Kubernetes Job manifest with stage-work-request initContainer and no mount collisions', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);

      expect(manifest.apiVersion).toBe('batch/v1');
      expect(manifest.kind).toBe('Job');
      expect(manifest.metadata.name).toBe('ct-agent-security-pr42-abcdef1');
      expect(manifest.metadata.namespace).toBe('ct-review-system');

      const podSpec = manifest.spec.template.spec;
      expect(podSpec.restartPolicy).toBe('Never');

      // Volumes verification
      expect(podSpec.volumes).toHaveLength(1);
      const volumeNames = podSpec.volumes.map((v) => v.name);
      expect(new Set(volumeNames).size).toBe(volumeNames.length); // No duplicate volumes
      expect(volumeNames[0]).toBe('workspace-volume');
      expect(podSpec.volumes[0].emptyDir).toBeDefined();

      // InitContainers verification
      expect(podSpec.initContainers).toBeDefined();
      expect(podSpec.initContainers).toHaveLength(1);
      const initContainer = podSpec.initContainers![0];
      expect(initContainer.name).toBe('stage-work-request');

      // InitContainer VolumeMounts verification
      expect(initContainer.volumeMounts).toHaveLength(1);
      const initMountPaths = initContainer.volumeMounts.map((m) => m.mountPath);
      expect(new Set(initMountPaths).size).toBe(initMountPaths.length); // No mount collisions
      expect(initContainer.volumeMounts[0].name).toBe('workspace-volume');
      expect(initContainer.volumeMounts[0].mountPath).toBe('/workspace');
      expect(initContainer.volumeMounts[0].subPath).toBe('repos/exampleorg_example-api_pr42');

      // InitContainer environment & script verification
      const payloadEnv = initContainer.env?.find((e) => e.name === 'CT_WORK_REQUEST_PAYLOAD');
      expect(payloadEnv).toBeDefined();
      expect(payloadEnv?.value).toContain('"schema":"ct-agent-work-request.v1"');
      expect(initContainer.command[0]).toBe('node');
      expect(initContainer.command[1]).toBe('-e');

      // Containers verification
      expect(podSpec.containers).toHaveLength(1);
      const mainContainer = podSpec.containers[0];
      expect(mainContainer.name).toBe('reviewer-agent');

      // Main Container VolumeMounts verification
      expect(mainContainer.volumeMounts).toHaveLength(1);
      const mainMountPaths = mainContainer.volumeMounts.map((m) => m.mountPath);
      expect(new Set(mainMountPaths).size).toBe(mainMountPaths.length); // No mount collisions
      expect(mainContainer.volumeMounts[0].name).toBe('workspace-volume');
      expect(mainContainer.volumeMounts[0].mountPath).toBe('/workspace');
      expect(mainContainer.volumeMounts[0].subPath).toBe('repos/exampleorg_example-api_pr42');

      // Manifest JSON serializability check
      const jsonString = JSON.stringify(manifest);
      expect(jsonString).toBeDefined();
      const parsed = JSON.parse(jsonString);
      expect(parsed.kind).toBe('Job');
    });

    it('verifies custom pvcClaimName propagates to volume definition', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest({
        ...baseSpec,
        pvcClaimName: 'custom-pvc-claim-99',
      });
      expect(manifest.spec.template.spec.volumes[0].persistentVolumeClaim?.claimName).toBe('custom-pvc-claim-99');
    });
  });

  // ==========================================================================
  // Area 5: Downward API Environment Variables
  // ==========================================================================
  describe('Area 5: Downward API Environment Variables', () => {
    it('injects valid syntax for fieldRef.fieldPath into reviewer-agent container', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);
      const container = manifest.spec.template.spec.containers[0];

      const podNameEnv = container.env.find((e) => e.name === 'CT_POD_NAME');
      expect(podNameEnv).toBeDefined();
      expect(podNameEnv?.value).toBeUndefined(); // value and valueFrom are mutually exclusive in K8s
      expect(podNameEnv?.valueFrom).toEqual({
        fieldRef: { fieldPath: 'metadata.name' },
      });

      const podNsEnv = container.env.find((e) => e.name === 'CT_POD_NAMESPACE');
      expect(podNsEnv).toBeDefined();
      expect(podNsEnv?.value).toBeUndefined();
      expect(podNsEnv?.valueFrom).toEqual({
        fieldRef: { fieldPath: 'metadata.namespace' },
      });

      // Verify valid Kubernetes Downward API fieldPaths
      const allowedDownwardPaths = new Set([
        'metadata.name',
        'metadata.namespace',
        'metadata.uid',
        'spec.nodeName',
        'spec.serviceAccountName',
        'status.hostIP',
        'status.podIP',
      ]);
      expect(allowedDownwardPaths.has(podNameEnv!.valueFrom!.fieldRef!.fieldPath)).toBe(true);
      expect(allowedDownwardPaths.has(podNsEnv!.valueFrom!.fieldRef!.fieldPath)).toBe(true);
    });

    it('prevents caller envVars from overriding CT_* harness variables', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest({
        ...baseSpec,
        envVars: {
          CT_POD_NAME: 'forged-pod-name',
          CT_FENCING_EPOCH: '9999',
          USER_CUSTOM_VAR: 'safe-value',
        },
      });

      const container = manifest.spec.template.spec.containers[0];
      const podNameEnv = container.env.filter((e) => e.name === 'CT_POD_NAME');
      expect(podNameEnv).toHaveLength(1);
      expect(podNameEnv[0].valueFrom).toEqual({
        fieldRef: { fieldPath: 'metadata.name' },
      });

      const fencingEpochEnv = container.env.find((e) => e.name === 'CT_FENCING_EPOCH');
      expect(fencingEpochEnv?.value).toBe('1'); // Base default, not '9999'

      const customEnv = container.env.find((e) => e.name === 'USER_CUSTOM_VAR');
      expect(customEnv?.value).toBe('safe-value');
    });
  });
});
