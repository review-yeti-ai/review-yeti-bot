import { describe, expect, it, vi } from 'vitest';
import {
  KubernetesReviewJobProjector,
  kubernetesStatusCode,
} from '../../src/k8s/kubernetesReviewJobProjector';
import type { PRReviewJobProjection } from '../../src/k8s/reviewJobProjection';

const projection: PRReviewJobProjection = {
  apiVersion: 'review-yeti.ai/v1alpha2',
  kind: 'PRReviewJob',
  metadata: {
    name: `ct-review-${'1'.repeat(32)}`,
    namespace: 'ct-review-system',
    labels: {
      'app.kubernetes.io/name': 'review-yeti-worker',
      'review-yeti.ai/publication-mode': 'disabled',
      'review-yeti.ai/run-id': `run_${'1'.repeat(32)}`,
    },
  },
  spec: {
    runId: `run_${'1'.repeat(32)}`,
    deliveryId: 'actions:98765:2:123:42:head',
    repositoryId: 123,
    repo: 'calltelemetry/cisco-cdr',
    prNumber: 42,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    receivedAt: '2026-08-30T20:00:00.000Z',
    terminalDeadline: '2026-08-30T20:15:00.000Z',
    policyDigest: 'c'.repeat(64),
    configDigest: 'd'.repeat(64),
    publicationMode: 'disabled',
    workerImage: `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'e'.repeat(64)}`,
    runSecretName: `ct-review-run-${'1'.repeat(32)}`,
  },
};

function notFound(): Error {
  return Object.assign(new Error('upstream response must not be surfaced'), { code: 404 });
}

function conflict(): Error {
  return Object.assign(new Error('upstream response must not be surfaced'), { code: 409 });
}

describe('KubernetesReviewJobProjector', () => {
  it('accepts an existing exact resource without creating a duplicate', async () => {
    const client = {
      getNamespacedCustomObject: vi.fn(async () => ({
        ...projection,
        metadata: {
          ...projection.metadata,
          resourceVersion: '17',
        },
        status: { phase: 'Pending' },
      })),
      createNamespacedCustomObject: vi.fn(),
    };
    const projector = new KubernetesReviewJobProjector(client);

    await expect(projector.ensure(projection)).resolves.toBeUndefined();
    expect(client.getNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'review-yeti.ai',
      version: 'v1alpha2',
      namespace: projection.metadata.namespace,
      plural: 'prreviewjobs',
      name: projection.metadata.name,
    });
    expect(client.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('creates a missing resource with strict field validation', async () => {
    const client = {
      getNamespacedCustomObject: vi.fn(async () => { throw notFound(); }),
      createNamespacedCustomObject: vi.fn(async () => projection),
    };
    const projector = new KubernetesReviewJobProjector(client);

    await expect(projector.ensure(projection)).resolves.toBeUndefined();
    expect(client.createNamespacedCustomObject).toHaveBeenCalledWith({
      group: 'review-yeti.ai',
      version: 'v1alpha2',
      namespace: projection.metadata.namespace,
      plural: 'prreviewjobs',
      body: projection,
      fieldManager: 'review-yeti-job-dispatcher',
      fieldValidation: 'Strict',
    });
  });

  it('treats a create race as success only after rereading an exact resource', async () => {
    const client = {
      getNamespacedCustomObject: vi.fn()
        .mockRejectedValueOnce(notFound())
        .mockResolvedValueOnce(projection),
      createNamespacedCustomObject: vi.fn(async () => { throw conflict(); }),
    };
    const projector = new KubernetesReviewJobProjector(client);

    await expect(projector.ensure(projection)).resolves.toBeUndefined();
    expect(client.getNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it.each([
    { spec: { ...projection.spec, headSha: 'f'.repeat(40) } },
    { metadata: { ...projection.metadata, name: 'ct-review-conflict' } },
    { metadata: { ...projection.metadata, labels: { ...projection.metadata.labels, extra: 'label' } } },
  ])('rejects an existing resource that does not match the exact projection', async (override) => {
    const client = {
      getNamespacedCustomObject: vi.fn(async () => ({ ...projection, ...override })),
      createNamespacedCustomObject: vi.fn(),
    };
    const projector = new KubernetesReviewJobProjector(client);

    await expect(projector.ensure(projection)).rejects.toThrow('existing PRReviewJob conflicts with the durable projection');
    expect(client.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('does not classify untrusted text as a Kubernetes status code', () => {
    expect(kubernetesStatusCode({ code: 404 })).toBe(404);
    expect(kubernetesStatusCode({ status: 404 })).toBe(404);
    expect(kubernetesStatusCode({ response: { statusCode: 409 } })).toBe(409);
    expect(kubernetesStatusCode({ body: { code: 422 } })).toBe(422);
    expect(kubernetesStatusCode(new Error('HTTP 404 secret-bearing response'))).toBeUndefined();
  });
});
