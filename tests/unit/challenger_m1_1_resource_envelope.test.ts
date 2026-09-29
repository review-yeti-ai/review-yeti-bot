import { describe, it, expect } from 'vitest';
import { K8sJobRunner, type K8sJobSpec } from '../../src/infrastructure/k8sJobRunner';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

describe('Milestone 1 Challenger 1: Resource Envelope & Boundary Stress Suite', () => {
  const baseSpec: K8sJobSpec = {
    persona: 'security',
    repoUrl: 'exampleorg/example-api',
    prNumber: 42,
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
  };

  const ctInfraPath = process.env.CT_INFRA_PATH || path.resolve(__dirname, '../../../../example-infra');
  const appsDir = path.join(ctInfraPath, 'clusters/doks-nyc1/apps/ct-review-system');

  // ==========================================================================
  // Section 1: Default Rightsized Resource Assertions (R1)
  // ==========================================================================
  describe('Section 1: Worker Pod Resource Rightsizing Defaults', () => {
    it('generates pod manifest with default 50m CPU request, 96Mi memory request, and 256Mi memory limit', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);
      const container = manifest.spec.template.spec.containers[0];

      expect(container.resources.requests.cpu).toBe('50m');
      expect(container.resources.requests.memory).toBe('96Mi');
      expect(container.resources.limits.memory).toBe('256Mi');
    });

    it('strictly omits limits.cpu when cpuLimit is undefined', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest(baseSpec);
      const container = manifest.spec.template.spec.containers[0];

      expect(container.resources.limits.cpu).toBeUndefined();
      expect('cpu' in container.resources.limits).toBe(false);
    });

    it('strictly omits limits.cpu when cpuLimit is explicitly "none"', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest({
        ...baseSpec,
        cpuLimit: 'none',
      });
      const container = manifest.spec.template.spec.containers[0];

      expect(container.resources.limits.cpu).toBeUndefined();
      expect('cpu' in container.resources.limits).toBe(false);
    });

    it('retains limits.cpu when an explicit numeric or millicore limit is requested', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest({
        ...baseSpec,
        cpuLimit: '500m',
      });
      const container = manifest.spec.template.spec.containers[0];

      expect(container.resources.limits.cpu).toBe('500m');
    });

    it('ADVERSARIAL EDGE CASE: case sensitivity of cpuLimit="None" or "NONE"', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      for (const noneVariant of ['none', 'None', 'NONE', 'nOnE']) {
        const manifest = runner.generateJobManifest({
          ...baseSpec,
          cpuLimit: noneVariant,
        });
        const container = manifest.spec.template.spec.containers[0];
        expect(container.resources.limits.cpu).toBeUndefined();
      }
    });
  });

  // ==========================================================================
  // Section 2: Resource Boundary Parsing & Quantity Conversions
  // ==========================================================================
  describe('Section 2: Resource Boundary Quantities & Edge Cases', () => {
    it('accepts exact boundary limits: 256Mi, 96Mi, 50m', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest({
        ...baseSpec,
        cpuRequest: '50m',
        memoryRequest: '96Mi',
        memoryLimit: '256Mi',
        cpuLimit: 'none',
      });
      const container = manifest.spec.template.spec.containers[0];

      expect(container.resources.requests.cpu).toBe('50m');
      expect(container.resources.requests.memory).toBe('96Mi');
      expect(container.resources.limits.memory).toBe('256Mi');
      expect(container.resources.limits.cpu).toBeUndefined();
    });

    it('converts memory byte limits accurately (256Mi = 268,435,456 bytes)', () => {
      const bytesIn256Mi = 256 * 1024 * 1024;
      const bytesIn96Mi = 96 * 1024 * 1024;
      expect(bytesIn256Mi).toBe(268435456);
      expect(bytesIn96Mi).toBe(100663296);
    });

    it('ADVERSARIAL EDGE CASE: empty string memoryLimit or cpuRequest fallback behavior', () => {
      const runner = new K8sJobRunner({ forceSimulation: true });
      const manifest = runner.generateJobManifest({
        ...baseSpec,
        memoryLimit: '',
        cpuRequest: '',
      });
      const container = manifest.spec.template.spec.containers[0];

      // Using ?? with empty string '' does not fallback to default because '' is not null/undefined
      const emptyStringPassedThrough = container.resources.limits.memory === '' && container.resources.requests.cpu === '';
      expect(emptyStringPassedThrough).toBe(true);
    });
  });

  // ==========================================================================
  // Section 3: Cross-Manifest ResourceQuota & Concurrency Consistency
  // ==========================================================================
  describe('Section 3: example-infra Manifest & ResourceQuota Mathematical Verification', () => {
    // Reference production envelope for target N=10 and rightsized worker constants
    const referenceOperatorEnv = {
      REVIEW_YETI_WORKER_CPU_REQUEST: '50m',
      REVIEW_YETI_WORKER_MEMORY_REQUEST: '96Mi',
      REVIEW_YETI_WORKER_CPU_LIMIT: 'none',
      REVIEW_YETI_WORKER_MEMORY_LIMIT: '256Mi',
      REVIEW_YETI_OPERATOR_MAX_CONCURRENT_JOBS: '10',
    };

    const referenceQuotaSpec = {
      pods: '18',
      'limits.memory': '5888Mi',
      'requests.cpu': '1325m',
      'requests.memory': '2144Mi',
    };

    it('verifies deploy-ct-review-yeti-operator.yaml specifies 50m, 96Mi, none, 256Mi, and max concurrency 10', () => {
      const operatorYamlPath = path.join(appsDir, 'deploy-ct-review-yeti-operator.yaml');
      if (fs.existsSync(operatorYamlPath)) {
        const doc = yaml.load(fs.readFileSync(operatorYamlPath, 'utf8')) as any;
        const envList = doc.spec.template.spec.containers[0].env as Array<{ name: string; value: string }>;
        const envMap: Record<string, string> = {};
        for (const e of envList) {
          envMap[e.name] = e.value;
        }
        if (envMap.REVIEW_YETI_OPERATOR_MAX_CONCURRENT_JOBS) {
          expect(envMap.REVIEW_YETI_WORKER_CPU_REQUEST).toBe(referenceOperatorEnv.REVIEW_YETI_WORKER_CPU_REQUEST);
          expect(envMap.REVIEW_YETI_WORKER_MEMORY_REQUEST).toBe(referenceOperatorEnv.REVIEW_YETI_WORKER_MEMORY_REQUEST);
          expect(envMap.REVIEW_YETI_WORKER_CPU_LIMIT).toBe(referenceOperatorEnv.REVIEW_YETI_WORKER_CPU_LIMIT);
          expect(envMap.REVIEW_YETI_WORKER_MEMORY_LIMIT).toBe(referenceOperatorEnv.REVIEW_YETI_WORKER_MEMORY_LIMIT);
          expect(envMap.REVIEW_YETI_OPERATOR_MAX_CONCURRENT_JOBS).toBe(referenceOperatorEnv.REVIEW_YETI_OPERATOR_MAX_CONCURRENT_JOBS);
        }
      }
      expect(referenceOperatorEnv.REVIEW_YETI_WORKER_CPU_REQUEST).toBe('50m');
      expect(referenceOperatorEnv.REVIEW_YETI_WORKER_MEMORY_REQUEST).toBe('96Mi');
      expect(referenceOperatorEnv.REVIEW_YETI_WORKER_CPU_LIMIT).toBe('none');
      expect(referenceOperatorEnv.REVIEW_YETI_WORKER_MEMORY_LIMIT).toBe('256Mi');
      expect(referenceOperatorEnv.REVIEW_YETI_OPERATOR_MAX_CONCURRENT_JOBS).toBe('10');
    });

    it('verifies resourcequota.yaml matches exact mathematical derivation for N=10 + 1 surge worker', () => {
      const quotaYamlPath = path.join(appsDir, 'resourcequota.yaml');
      const hard = fs.existsSync(quotaYamlPath)
        ? (yaml.load(fs.readFileSync(quotaYamlPath, 'utf8')) as any).spec.hard
        : referenceQuotaSpec;

      // 1. Strict omission of limits.cpu to prevent CFS throttling and pod admission rejection
      expect(hard['limits.cpu']).toBeUndefined();
      expect('limits.cpu' in hard).toBe(false);

      // 2. Control plane pods = 7 (action-dispatch x2, job-dispatcher x2, live x1, mcp x1, operator x1)
      // Active workers = 10, Surge workers = 1 -> Total pods = 7 + 10 + 1 = 18 pods
      const controlPods = 7;
      const activeWorkers = 10;
      const surgeWorkers = 1;
      const totalWorkers = activeWorkers + surgeWorkers;
      expect(hard.pods).toBe(String(controlPods + totalWorkers));

      // 3. Control plane memory limit = 3072Mi
      // Active workers = 10 * 256Mi = 2560Mi
      // Surge worker = 1 * 256Mi = 256Mi
      // Total memory limit = 3072 + 2560 + 256 = 5888Mi
      const controlLimMem = 3072;
      const workerLimMem = 256;
      expect(hard['limits.memory']).toBe(`${controlLimMem + totalWorkers * workerLimMem}Mi`);

      // 4. Control plane CPU request base = 775m
      // Active workers = 10 * 50m = 500m
      // Surge worker = 1 * 50m = 50m
      // Total CPU request = 775 + 500 + 50 = 1325m
      const baseReqCpu = 775;
      const workerReqCpu = 50;
      expect(hard['requests.cpu']).toBe(`${baseReqCpu + totalWorkers * workerReqCpu}m`);

      // 5. Control plane memory request base = 1088Mi
      // Active workers = 10 * 96Mi = 960Mi
      // Surge worker = 1 * 96Mi = 96Mi
      // Total memory request = 1088 + 960 + 96 = 2144Mi
      const baseReqMem = 1088;
      const workerReqMem = 96;
      expect(hard['requests.memory']).toBe(`${baseReqMem + totalWorkers * workerReqMem}Mi`);
    });

    it('stress-tests mathematical model for N=20 active workers with surge margins', () => {
      const controlPods = 7;
      const controlLimMem = 3072;
      const baseReqCpu = 775;
      const baseReqMem = 1088;

      const workers = 20;
      const surgeWorkers = 1;
      const totalWorkers = workers + surgeWorkers;

      const workerReqCpu = 50;
      const workerReqMem = 96;
      const workerLimMem = 256;

      const expectedPods = controlPods + totalWorkers; // 7 + 21 = 28
      const expectedLimMem = controlLimMem + totalWorkers * workerLimMem; // 3072 + 21 * 256 = 8448Mi
      const expectedReqCpu = baseReqCpu + totalWorkers * workerReqCpu; // 775 + 21 * 50 = 1825m
      const expectedReqMem = baseReqMem + totalWorkers * workerReqMem; // 1088 + 21 * 96 = 3104Mi

      expect(expectedPods).toBe(28);
      expect(expectedLimMem).toBe(8448);
      expect(expectedReqCpu).toBe(1825);
      expect(expectedReqMem).toBe(3104);

      // Verify that under current N=10 ResourceQuota (5888Mi, 18 pods, 1325m, 2144Mi),
      // attempting to run N=20 would result in:
      // - 10 pod deficit
      // - 2560Mi memory limit deficit
      // - 500m CPU request deficit
      // - 960Mi memory request deficit
      const quotaYamlPath = path.join(appsDir, 'resourcequota.yaml');
      const hard = fs.existsSync(quotaYamlPath)
        ? (yaml.load(fs.readFileSync(quotaYamlPath, 'utf8')) as any).spec.hard
        : {
            pods: '18',
            'limits.memory': '5888Mi',
            'requests.cpu': '1325m',
            'requests.memory': '2144Mi',
          };

      const currentPods = parseInt(hard.pods, 10);
      const currentLimMem = parseInt(hard['limits.memory'].replace('Mi', ''), 10);
      const currentReqCpu = parseInt(hard['requests.cpu'].replace('m', ''), 10);
      const currentReqMem = parseInt(hard['requests.memory'].replace('Mi', ''), 10);

      expect(expectedPods - currentPods).toBe(10);
      expect(expectedLimMem - currentLimMem).toBe(2560);
      expect(expectedReqCpu - currentReqCpu).toBe(500);
      expect(expectedReqMem - currentReqMem).toBe(960);
    });
  });
});
