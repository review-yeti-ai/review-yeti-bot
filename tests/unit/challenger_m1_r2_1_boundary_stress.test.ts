import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  K8sJobRunner,
  type K8sJobSpec,
} from '../../src/infrastructure/k8sJobRunner';

describe('Empirical Adversarial Boundary Stress Suite: Namespace Enforcement (challenger_m1_r2_1)', () => {
  const baseSpec: K8sJobSpec = {
    persona: 'security-auditor',
    repoUrl: 'exampleorg/example-api',
    prNumber: 999,
    commitSha: '7f8e9d0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e',
  };

  const originalEnv = process.env.K8S_NAMESPACE;

  beforeEach(() => {
    delete process.env.K8S_NAMESPACE;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.K8S_NAMESPACE = originalEnv;
    } else {
      delete process.env.K8S_NAMESPACE;
    }
  });

  // ==========================================================================
  // Section 1: Empty string namespace
  // ==========================================================================
  describe('Empty string namespace', () => {
    it('constructor fails closed with INVALID_SHAPE when options: { namespace: "" }', () => {
      expect(() => new K8sJobRunner({ namespace: '', forceSimulation: true })).toThrow(/INVALID_SHAPE/);
    });

    it('generateJobManifest fails closed with INVALID_SHAPE when spec.namespace: ""', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() =>
        runner.generateJobManifest({
          ...baseSpec,
          namespace: '',
        })
      ).toThrow(/INVALID_SHAPE/);
    });

    it('dispatchJob fails closed with INVALID_SHAPE when spec.namespace: ""', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      await expect(
        runner.dispatchJob({
          ...baseSpec,
          namespace: '',
        })
      ).rejects.toThrow(/INVALID_SHAPE/);
    });
  });

  // ==========================================================================
  // Section 2: Null namespace
  // ==========================================================================
  describe('Null namespace', () => {
    it('constructor fails closed with INVALID_SHAPE when options: { namespace: null }', () => {
      expect(() => new K8sJobRunner({ namespace: null as any, forceSimulation: true })).toThrow(/INVALID_SHAPE/);
    });

    it('generateJobManifest fails closed with INVALID_SHAPE when spec.namespace: null', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      expect(() =>
        runner.generateJobManifest({
          ...baseSpec,
          namespace: null as any,
        })
      ).toThrow(/INVALID_SHAPE/);
    });

    it('dispatchJob fails closed with INVALID_SHAPE when spec.namespace: null', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      await expect(
        runner.dispatchJob({
          ...baseSpec,
          namespace: null as any,
        })
      ).rejects.toThrow(/INVALID_SHAPE/);
    });
  });

  // ==========================================================================
  // Section 3: System namespaces
  // ==========================================================================
  describe('System namespaces rejection', () => {
    const systemNamespaces = [
      'default',
      'kube-system',
      'kube-public',
      'kube-node-lease',
      'kube-foo',
      'kube-custom',
      'kube-',
      'kube-monitoring',
      'kube-internal',
    ];

    for (const sysNs of systemNamespaces) {
      it(`constructor fails closed with INVALID_SHAPE for system namespace '${sysNs}'`, () => {
        expect(() => new K8sJobRunner({ namespace: sysNs, forceSimulation: true })).toThrow(/INVALID_SHAPE/);
      });

      it(`generateJobManifest fails closed with INVALID_SHAPE for system namespace '${sysNs}'`, () => {
        const runner = new K8sJobRunner({ forceSimulation: true });
        expect(() =>
          runner.generateJobManifest({
            ...baseSpec,
            namespace: sysNs,
          })
        ).toThrow(/INVALID_SHAPE/);
      });

      it(`dispatchJob fails closed with INVALID_SHAPE for system namespace '${sysNs}'`, async () => {
        const runner = new K8sJobRunner({ forceSimulation: true });
        await expect(
          runner.dispatchJob({
            ...baseSpec,
            namespace: sysNs,
          })
        ).rejects.toThrow(/INVALID_SHAPE/);
      });
    }
  });

  // ==========================================================================
  // Section 4: Omitted namespace defaults safely to 'ct-review-system'
  // ==========================================================================
  describe('Omitted namespace safe defaulting', () => {
    it('constructor defaults safely to ct-review-system when options is omitted', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);
      expect(manifest.metadata.namespace).toBe('ct-review-system');
    });

    it('constructor defaults safely to ct-review-system when options is empty object', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);
      expect(manifest.metadata.namespace).toBe('ct-review-system');
    });

    it('constructor defaults safely to ct-review-system when options.namespace is undefined', () => {
      const runner = new K8sJobRunner({ namespace: undefined, forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);
      expect(manifest.metadata.namespace).toBe('ct-review-system');
    });

    it('generateJobManifest defaults safely to ct-review-system when spec.namespace is omitted', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const { namespace, ...specWithoutNs } = { ...baseSpec, namespace: undefined };
      const manifest = runner.generateJobManifest(specWithoutNs);
      expect(manifest.metadata.namespace).toBe('ct-review-system');
    });

    it('generateJobManifest defaults safely to ct-review-system when spec.namespace is explicitly undefined', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest({
        ...baseSpec,
        namespace: undefined,
      });
      expect(manifest.metadata.namespace).toBe('ct-review-system');
    });

    it('dispatchJob defaults safely to ct-review-system when spec.namespace is omitted', async () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const result = await runner.dispatchJob(baseSpec);
      expect(result.namespace).toBe('ct-review-system');
      expect(result.manifest.metadata.namespace).toBe('ct-review-system');
    });
  });

  // ==========================================================================
  // Section 5: Extended Adversarial Boundary Probing
  // ==========================================================================
  describe('Extended Adversarial Boundary Probing', () => {
    it('fails closed on non-string data types passed as namespace', () => {
      const badTypes = [
        { val: 12345, label: 'number' },
        { val: true, label: 'boolean true' },
        { val: false, label: 'boolean false' },
        { val: {}, label: 'plain object' },
        { val: [], label: 'array' },
        { val: Symbol('namespace'), label: 'symbol', isSymbol: true },
      ];

      for (const { val, label, isSymbol } of badTypes) {
        if (isSymbol) {
          expect(
            () => new K8sJobRunner({ namespace: val as any, forceSimulation: true }),
            `Expected constructor to fail closed on ${label}`
          ).toThrow();

          const runner = new K8sJobRunner({ forceSimulation: true });
          expect(
            () => runner.generateJobManifest({ ...baseSpec, namespace: val as any }),
            `Expected generateJobManifest to fail closed on ${label}`
          ).toThrow();
        } else {
          expect(
            () => new K8sJobRunner({ namespace: val as any, forceSimulation: true }),
            `Expected constructor to reject ${label} with INVALID_SHAPE`
          ).toThrow(/INVALID_SHAPE/);

          const runner = new K8sJobRunner({ forceSimulation: true });
          expect(
            () => runner.generateJobManifest({ ...baseSpec, namespace: val as any }),
            `Expected generateJobManifest to reject ${label} with INVALID_SHAPE`
          ).toThrow(/INVALID_SHAPE/);
        }
      }
    });

    it('fails closed on RFC 1123 subdomain pattern violations', () => {
      const rfcViolations = [
        '   ',                  // whitespace
        'DEFAULT',              // uppercase
        'Kube-System',          // uppercase system
        'Ct-Review-System',     // uppercase target
        '-leading-hyphen',      // starts with hyphen
        'trailing-hyphen-',     // ends with hyphen
        'invalid_underscore',   // underscore
        'invalid.dot',          // dot
        'invalid/slash',        // slash
        'invalid@char',         // symbol
        'a'.repeat(64),         // 64 chars exceeds max 63
      ];

      for (const invalidNs of rfcViolations) {
        expect(
          () => new K8sJobRunner({ namespace: invalidNs, forceSimulation: true }),
          `Expected constructor to reject RFC violation: ${invalidNs}`
        ).toThrow(/INVALID_SHAPE/);

        const runner = new K8sJobRunner({ forceSimulation: true });
        expect(
          () => runner.generateJobManifest({ ...baseSpec, namespace: invalidNs }),
          `Expected generateJobManifest to reject RFC violation: ${invalidNs}`
        ).toThrow(/INVALID_SHAPE/);
      }
    });

    it('accepts compliant non-system boundary namespaces', () => {
      const validNamespaces = [
        'ct-review-system',
        'ct-agents-isolated',
        'custom-boundary-01',
        'a'.repeat(63), // max allowed 63 characters
        'a0',           // 2 chars
        'z',            // 1 char
      ];

      for (const validNs of validNamespaces) {
        const runner = new K8sJobRunner({ namespace: validNs, forceSimulation: true });
        const manifest = runner.generateJobManifest(baseSpec);
        expect(manifest.metadata.namespace).toBe(validNs);

        const manifestOverride = runner.generateJobManifest({
          ...baseSpec,
          namespace: 'ct-review-override',
        });
        expect(manifestOverride.metadata.namespace).toBe('ct-review-override');
      }
    });

    it('evaluates K8S_NAMESPACE environment variable safely and fails closed if invalid', () => {
      process.env.K8S_NAMESPACE = 'kube-system';
      expect(() => new K8sJobRunner({ forceSimulation: true })).toThrow(/INVALID_SHAPE/);

      process.env.K8S_NAMESPACE = 'default';
      expect(() => new K8sJobRunner({ forceSimulation: true })).toThrow(/INVALID_SHAPE/);

      process.env.K8S_NAMESPACE = 'INVALID_UPPER';
      expect(() => new K8sJobRunner({ forceSimulation: true })).toThrow(/INVALID_SHAPE/);

      process.env.K8S_NAMESPACE = 'ct-staging-boundary';
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);
      expect(manifest.metadata.namespace).toBe('ct-staging-boundary');
    });
  });
});
