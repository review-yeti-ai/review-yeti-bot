import { describe, it, expect } from 'vitest';
import { K8sJobDispatcher } from '../../src/k8s/k8sJobDispatcher';

describe('K8sJobDispatcher Unit Tests', () => {
  it('generates clean K8s compliant names for jobs and PVCs', () => {
    const dispatcher = new K8sJobDispatcher('ct-review-system');
    const names = dispatcher.getNames('calltelemetry', 'cisco-cdr', 3058, 'a8f192b3c4d5e6f7');

    expect(names.jobName).toBe('job-ct-review-calltelemetry-cisco-cdr-pr3058-a8f192b');
    expect(names.pvcName).toBe('pvc-ct-review-calltelemetry-cisco-cdr-pr3058-a8f192b');
  });

  it('builds PVC manifest with 1Gi storage request', () => {
    const dispatcher = new K8sJobDispatcher('ct-review-system');
    const pvc = dispatcher.buildPvcManifest('pvc-test-pr101');

    expect(pvc.apiVersion).toBe('v1');
    expect(pvc.kind).toBe('PersistentVolumeClaim');
    expect(pvc.metadata?.name).toBe('pvc-test-pr101');
    expect(pvc.spec?.accessModes).toContain('ReadWriteOnce');
    expect(pvc.spec?.resources?.requests?.storage).toBe('1Gi');
  });

  it('builds Job manifest with 1800s (30m) TTL and 1Gi memory limits', () => {
    const dispatcher = new K8sJobDispatcher('ct-review-system');
    const job = dispatcher.buildJobManifest('job-test-pr101', 'pvc-test-pr101', {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      prNumber: 3058,
      headSha: 'a8f192b3c4d5e6f7',
      jobId: 'job_test_123',
    });

    expect(job.apiVersion).toBe('batch/v1');
    expect(job.kind).toBe('Job');
    expect(job.metadata?.name).toBe('job-test-pr101');
    expect(job.spec?.ttlSecondsAfterFinished).toBe(1800); // 30-minute expiration

    const container = job.spec?.template?.spec?.containers?.[0];
    expect(container).toBeDefined();
    expect(container?.resources?.limits?.memory).toBe('1Gi');
    expect(container?.resources?.limits?.cpu).toBe('500m');
    expect(container?.volumeMounts?.[0]?.mountPath).toBe('/app/data/pr-workspace');
    expect(container?.env?.find((entry) => entry.name === 'OPENROUTER_API_KEY')).toMatchObject({
      valueFrom: { secretKeyRef: { name: 'ct-review-bot-runtime', key: 'OPENROUTER_API_KEY' } },
    });

    const volume = job.spec?.template?.spec?.volumes?.[0];
    expect(volume?.persistentVolumeClaim?.claimName).toBe('pvc-test-pr101');
  });
});
