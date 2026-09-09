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

function attemptProjection(attempt: number): PRReviewJobProjection {
  const suffix = attempt === 1 ? '' : `-a${attempt}`;
  return {
    ...projection,
    metadata: { ...projection.metadata, name: `ct-review-${'1'.repeat(32)}${suffix}` },
    spec: {
      ...projection.spec,
      executionAttempt: attempt,
      runSecretName: `ct-review-run-${'1'.repeat(32)}${suffix}`,
    },
  };
}

function legacyProjection(value: PRReviewJobProjection): PRReviewJobProjection {
  const spec = { ...value.spec };
  delete spec.executionAttempt;
  return { ...value, spec };
}

describe('KubernetesReviewJobProjector', () => {
  it.each(['Failed', 'Succeeded', 'Expired'])('does not acknowledge a terminal %s CR as an active projection', async (phase) => {
    const client = {
      getNamespacedCustomObject: vi.fn(async () => ({ ...projection, status: { phase } })),
      createNamespacedCustomObject: vi.fn(),
    };
    await expect(new KubernetesReviewJobProjector(client).ensure(projection)).rejects.toThrow('terminal');
    expect(client.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('creates the next attempt without deleting or reusing the prior terminal CR', async () => {
    const old = { ...attemptProjection(1), status: { phase: 'Failed' } };
    const created: unknown[] = [];
    const client = {
      getNamespacedCustomObject: vi.fn(async ({ name }: { name: string }) => {
        if (name === old.metadata.name) return old;
        throw notFound();
      }),
      createNamespacedCustomObject: vi.fn(async ({ body }: { body: unknown }) => { created.push(body); }),
    };
    await new KubernetesReviewJobProjector(client).ensure(attemptProjection(2));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ metadata: { name: 'ct-review-11111111111111111111111111111111-a2' },
      spec: { executionAttempt: 2, runSecretName: 'ct-review-run-11111111111111111111111111111111-a2' } });
    expect(old.status.phase).toBe('Failed');
  });
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

  it.each([1, 2_147_483_647])('accepts a GET-existing legacy CR at attempt %i without mutation', async (attempt) => {
    const expected = attemptProjection(attempt);
    const existing = legacyProjection(expected);
    const before = JSON.stringify(existing);
    const client = {
      getNamespacedCustomObject: vi.fn(async () => existing),
      createNamespacedCustomObject: vi.fn(),
    };
    const projector = new KubernetesReviewJobProjector(client);

    await expect(projector.ensure(expected)).resolves.toBeUndefined();
    expect(JSON.stringify(existing)).toBe(before);
    expect(existing.spec).not.toHaveProperty('executionAttempt');
    expect(client.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it.each([1, 2, 2_147_483_647])('accepts a 409 reread of a legacy CR at attempt %i without mutation', async (attempt) => {
    const expected = attemptProjection(attempt);
    const existing = legacyProjection(expected);
    const before = JSON.stringify(existing);
    const client = {
      getNamespacedCustomObject: vi.fn()
        .mockRejectedValueOnce(notFound())
        .mockResolvedValueOnce(existing),
      createNamespacedCustomObject: vi.fn(async () => { throw conflict(); }),
    };
    const projector = new KubernetesReviewJobProjector(client);

    await expect(projector.ensure(expected)).resolves.toBeUndefined();
    expect(JSON.stringify(existing)).toBe(before);
    expect(existing.spec).not.toHaveProperty('executionAttempt');
    expect(client.getNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it.each([
    { suffix: '-a0', attempt: 0 },
    { suffix: '-a-1', attempt: -1 },
    { suffix: '-anonsense', attempt: 1 },
    { suffix: '-a2147483648', attempt: 2_147_483_648 },
    { suffix: '-a+2', attempt: 2 },
    { suffix: '-a01', attempt: 1 },
    { suffix: '-a1', attempt: 1, foreignRun: true },
  ])('rejects invalid legacy identity $suffix (foreign run: $foreignRun)', async ({ suffix, attempt, foreignRun }) => {
    // Keep every other compared field identical so only validated derivation
    // can reject the suffix; a different Secret name alone would mask a bug.
    const expected = attemptProjection(attempt);
    expected.spec.runSecretName = `ct-review-run-${(foreignRun ? '2' : '1').repeat(32)}${suffix}`;
    const existing = legacyProjection(expected);
    for (const reread of [false, true]) {
      const get = vi.fn();
      if (reread) get.mockRejectedValueOnce(notFound());
      get.mockResolvedValueOnce(existing);
      const client = {
        getNamespacedCustomObject: get,
        createNamespacedCustomObject: vi.fn(async () => { throw conflict(); }),
      };
      await expect(new KubernetesReviewJobProjector(client).ensure(expected))
        .rejects.toThrow('existing PRReviewJob conflicts with the durable projection');
      expect(existing.spec).not.toHaveProperty('executionAttempt');
      expect(client.createNamespacedCustomObject).toHaveBeenCalledTimes(reread ? 1 : 0);
    }
  });

  it('keeps a legacy -a1 Secret readable without rewriting its name or unrelated spec fields', async () => {
    const expected = attemptProjection(1);
    expected.spec.runSecretName += '-a1';
    const existing = legacyProjection(expected);
    const before = JSON.stringify(existing);
    const client = { getNamespacedCustomObject: vi.fn(async () => existing), createNamespacedCustomObject: vi.fn() };
    await expect(new KubernetesReviewJobProjector(client).ensure(expected)).resolves.toBeUndefined();
    expect(JSON.stringify(existing)).toBe(before);
    await expect(new KubernetesReviewJobProjector(client).ensure({
      ...expected, spec: { ...expected.spec, runnerMode: 'prebaked' },
    })).rejects.toThrow('existing PRReviewJob conflicts with the durable projection');
    expect(client.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'explicit attempt mismatch',
      existing: () => ({ ...attemptProjection(2), spec: { ...attemptProjection(2).spec, executionAttempt: 3 } }),
    },
    {
      name: 'legacy malformed suffix',
      existing: () => {
        const value = legacyProjection(attemptProjection(2));
        value.spec.runSecretName = `ct-review-run-${'1'.repeat(32)}-a2147483648`;
        return value;
      },
    },
  ])('rejects $name instead of normalizing it', async ({ existing }) => {
    const client = {
      getNamespacedCustomObject: vi.fn(async () => existing()),
      createNamespacedCustomObject: vi.fn(),
    };
    const projector = new KubernetesReviewJobProjector(client);

    await expect(projector.ensure(attemptProjection(2)))
      .rejects.toThrow('existing PRReviewJob conflicts with the durable projection');
    expect(client.createNamespacedCustomObject).not.toHaveBeenCalled();
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
