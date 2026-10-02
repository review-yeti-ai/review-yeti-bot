import { describe, it, expect } from 'vitest';
import {
  K8sJobRunner,
  type K8sJobSpec,
} from '../../src/infrastructure/k8sJobRunner';
import {
  createTaskObserverCheckpoint,
  ContractError,
} from '../../src/schemas/agentHarnessContracts';

describe('Empirical Adversarial Challenge Suite: Parameter Defaulting & Falsy Coercion (challenger_m1_r2_2)', () => {
  const baseSpec: K8sJobSpec = {
    persona: 'security',
    repoUrl: 'exampleorg/example-api',
    prNumber: 42,
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
  };

  // ==========================================================================
  // Section 1: Empty String ID Fields (buildWorkRequest & generateJobManifest)
  // ==========================================================================
  describe('Section 1: Empty String ID Fields', () => {
    const emptyIdFields: Array<{
      field: 'tenantId' | 'environmentId' | 'workspaceId' | 'missionId' | 'logicalChildId' | 'executionId' | 'idempotencyKey';
      label: string;
    }> = [
      { field: 'tenantId', label: 'tenantId: ""' },
      { field: 'environmentId', label: 'environmentId: ""' },
      { field: 'workspaceId', label: 'workspaceId: ""' },
      { field: 'missionId', label: 'missionId: ""' },
      { field: 'logicalChildId', label: 'logicalChildId: ""' },
      { field: 'executionId', label: 'executionId: ""' },
      { field: 'idempotencyKey', label: 'idempotencyKey: ""' },
    ];

    for (const { field, label } of emptyIdFields) {
      it(`buildWorkRequest throws INVALID_SHAPE when ${label} is passed`, () => {
        const runner = new K8sJobRunner({ forceSimulation: true });
        expect(() => {
          runner.buildWorkRequest({
            ...baseSpec,
            [field]: '',
          });
        }).toThrow(/INVALID_SHAPE/);
      });

      it(`generateJobManifest throws INVALID_SHAPE when ${label} is passed`, () => {
        const runner = new K8sJobRunner({ forceSimulation: true });
        expect(() => {
          runner.generateJobManifest({
            ...baseSpec,
            [field]: '',
          });
        }).toThrow(/INVALID_SHAPE/);
      });

      it(`buildWorkRequest throws INVALID_SHAPE when ${field} is whitespace-only`, () => {
        const runner = new K8sJobRunner({ forceSimulation: true });
        expect(() => {
          runner.buildWorkRequest({
            ...baseSpec,
            [field]: '   ',
          });
        }).toThrow(/INVALID_SHAPE/);
      });
    }
  });

  // ==========================================================================
  // Section 2: Boundary PR Number, Commit SHA, and Persona
  // ==========================================================================
  describe('Section 2: Boundary PR Number, Commit SHA, and Persona', () => {
    it('buildWorkRequest throws INVALID_SHAPE for prNumber = 0', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.buildWorkRequest({
          ...baseSpec,
          prNumber: 0,
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('generateJobManifest throws INVALID_SHAPE for prNumber = 0', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.generateJobManifest({
          ...baseSpec,
          prNumber: 0,
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('buildWorkRequest throws INVALID_SHAPE for prNumber = -1', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.buildWorkRequest({
          ...baseSpec,
          prNumber: -1,
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('generateJobManifest throws INVALID_SHAPE for prNumber = -1', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.generateJobManifest({
          ...baseSpec,
          prNumber: -1,
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('buildWorkRequest throws INVALID_SHAPE for commitSha = ""', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.buildWorkRequest({
          ...baseSpec,
          commitSha: '',
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('generateJobManifest throws INVALID_SHAPE for commitSha = ""', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.generateJobManifest({
          ...baseSpec,
          commitSha: '',
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('buildWorkRequest throws INVALID_SHAPE for persona = ""', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.buildWorkRequest({
          ...baseSpec,
          persona: '',
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('generateJobManifest throws INVALID_SHAPE for persona = ""', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.generateJobManifest({
          ...baseSpec,
          persona: '',
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('fails closed with INVALID_SHAPE on whitespace-only commitSha and persona', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => runner.buildWorkRequest({ ...baseSpec, commitSha: '   ' })).toThrow(/INVALID_SHAPE/);
      expect(() => runner.generateJobManifest({ ...baseSpec, commitSha: '   ' })).toThrow(/INVALID_SHAPE/);
      expect(() => runner.buildWorkRequest({ ...baseSpec, persona: '   ' })).toThrow(/INVALID_SHAPE/);
      expect(() => runner.generateJobManifest({ ...baseSpec, persona: '   ' })).toThrow(/INVALID_SHAPE/);
    });
  });

  // ==========================================================================
  // Section 3: Image, PVC Claim Name, and Job Name
  // ==========================================================================
  describe('Section 3: Image, PVC Claim Name, and Job Name', () => {
    it('generateJobManifest throws INVALID_SHAPE when spec.image is empty string', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.generateJobManifest({
          ...baseSpec,
          image: '',
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('K8sJobRunner constructor throws INVALID_SHAPE when defaultImage is empty string', () => {
      expect(() => {
        new K8sJobRunner({
          defaultImage: '',
          forceSimulation: true,
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('generateJobManifest throws INVALID_SHAPE when spec.pvcClaimName is empty string', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.generateJobManifest({
          ...baseSpec,
          pvcClaimName: '',
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('K8sJobRunner constructor allows defaultPvcName to be empty string or omitted', () => {
      const runner = new K8sJobRunner({
        defaultPvcName: '',
        forceSimulation: true,
      });
      const manifest = runner.generateJobManifest(baseSpec);
      const volume = manifest.spec.template.spec.volumes[0];
      expect(volume.emptyDir).toBeDefined();
      expect(volume.persistentVolumeClaim).toBeUndefined();
    });

    it('generateJobManifest throws INVALID_SHAPE when spec.jobName is empty string', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => {
        runner.generateJobManifest({
          ...baseSpec,
          jobName: '',
        });
      }).toThrow(/INVALID_SHAPE/);
    });

    it('fails closed on whitespace-only image and jobName', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => runner.generateJobManifest({ ...baseSpec, image: '   ' })).toThrow(/INVALID_SHAPE/);
      expect(() => runner.generateJobManifest({ ...baseSpec, jobName: '   ' })).toThrow(/INVALID_SHAPE/);
      expect(() => new K8sJobRunner({ defaultImage: '   ', forceSimulation: true })).toThrow(/INVALID_SHAPE/);
    });

    it('throws INVALID_SHAPE on whitespace-only pvcClaimName', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() => runner.generateJobManifest({ ...baseSpec, pvcClaimName: '   ' })).toThrow(/INVALID_SHAPE/);
    });
  });

  // ==========================================================================
  // Section 4: createTaskObserverCheckpoint Non-Boolean & Non-Array Types
  // ==========================================================================
  describe('Section 4: createTaskObserverCheckpoint Non-Boolean & Non-Array Types', () => {
    const validCheckpoint = {
      checkpoint_id: 'chk-checkpoint-1',
      observed_at: '2026-09-27T18:00:00.000Z',
      proposals: [],
      permission_denied: false,
    };

    const invalidPermissionDeniedValues = [
      { val: 'true' as any, label: 'string "true"' },
      { val: 'false' as any, label: 'string "false"' },
      { val: 1 as any, label: 'number 1' },
      { val: 0 as any, label: 'number 0' },
      { val: null as any, label: 'null' },
      { val: undefined as any, label: 'undefined' },
      { val: {} as any, label: 'empty object {}' },
      { val: [] as any, label: 'array []' },
    ];

    for (const { val, label } of invalidPermissionDeniedValues) {
      it(`throws ContractError(INVALID_SHAPE) when permission_denied is ${label}`, () => {
        try {
          createTaskObserverCheckpoint({
            ...validCheckpoint,
            permission_denied: val,
          });
          expect.fail(`Should have thrown for permission_denied = ${label}`);
        } catch (err: any) {
          expect(err).toBeInstanceOf(ContractError);
          expect(err.code).toBe('INVALID_SHAPE');
          expect(err.message).toBe('INVALID_SHAPE');
        }
      });
    }

    const invalidProposalsValues = [
      { val: null as any, label: 'null' },
      { val: undefined as any, label: 'undefined' },
      { val: 'proposals' as any, label: 'string "proposals"' },
      { val: 123 as any, label: 'number 123' },
      { val: {} as any, label: 'plain object {}' },
      { val: true as any, label: 'boolean true' },
    ];

    for (const { val, label } of invalidProposalsValues) {
      it(`throws ContractError(INVALID_SHAPE) when proposals is ${label}`, () => {
        try {
          createTaskObserverCheckpoint({
            ...validCheckpoint,
            proposals: val,
          });
          expect.fail(`Should have thrown for proposals = ${label}`);
        } catch (err: any) {
          expect(err).toBeInstanceOf(ContractError);
          expect(err.code).toBe('INVALID_SHAPE');
          expect(err.message).toBe('INVALID_SHAPE');
        }
      });
    }

    it('accepts strictly boolean permission_denied (true and false) with valid array', () => {
      const chkFalse = createTaskObserverCheckpoint({
        ...validCheckpoint,
        permission_denied: false,
      });
      expect(chkFalse.permission_denied).toBe(false);

      const chkTrue = createTaskObserverCheckpoint({
        ...validCheckpoint,
        permission_denied: true,
      });
      expect(chkTrue.permission_denied).toBe(true);
    });

    it('rejects non-object or null root options', () => {
      expect(() => createTaskObserverCheckpoint(null as any)).toThrow(ContractError);
      expect(() => createTaskObserverCheckpoint(undefined as any)).toThrow(ContractError);
      expect(() => createTaskObserverCheckpoint('invalid' as any)).toThrow(ContractError);
    });
  });

  // ==========================================================================
  // Section 5: Integration with dispatchJob
  // ==========================================================================
  describe('Section 5: Integration with dispatchJob', () => {
    it('dispatchJob rejects invalid spec parameters synchronously before simulation', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      await expect(runner.dispatchJob({ ...baseSpec, tenantId: '' })).rejects.toThrow(/INVALID_SHAPE/);
      await expect(runner.dispatchJob({ ...baseSpec, prNumber: 0 })).rejects.toThrow(/INVALID_SHAPE/);
      await expect(runner.dispatchJob({ ...baseSpec, commitSha: '' })).rejects.toThrow(/INVALID_SHAPE/);
      await expect(runner.dispatchJob({ ...baseSpec, persona: '' })).rejects.toThrow(/INVALID_SHAPE/);
      await expect(runner.dispatchJob({ ...baseSpec, image: '' })).rejects.toThrow(/INVALID_SHAPE/);
      await expect(runner.dispatchJob({ ...baseSpec, jobName: '' })).rejects.toThrow(/INVALID_SHAPE/);
      await expect(runner.dispatchJob({ ...baseSpec, pvcClaimName: '' })).rejects.toThrow(/INVALID_SHAPE/);
      await expect(runner.dispatchJob({ ...baseSpec, pvcClaimName: '   ' })).rejects.toThrow(/INVALID_SHAPE/);
      const res = await runner.dispatchJob(baseSpec);
      expect(res.manifest.spec.template.spec.volumes[0].emptyDir).toBeDefined();
      expect(res.manifest.spec.template.spec.volumes[0].persistentVolumeClaim).toBeUndefined();
    });
  });
});
