import { isDeepStrictEqual } from 'node:util';
import type { ReviewJobProjector } from './reviewJobDispatchEngine';
import type { PRReviewJobProjection } from './reviewJobProjection';

const GROUP = 'review-yeti.ai';
const VERSION = 'v1alpha2';
const PLURAL = 'prreviewjobs';

interface NamespacedCustomObjectIdentity {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
}

interface NamespacedCustomObjectCreate {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  body: unknown;
  fieldManager: string;
  fieldValidation: 'Strict';
}

export interface NamespacedCustomObjectClient {
  getNamespacedCustomObject(request: NamespacedCustomObjectIdentity): Promise<unknown>;
  createNamespacedCustomObject(request: NamespacedCustomObjectCreate): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function validHttpStatus(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 599
    ? Number(value)
    : undefined;
}

/** Extract only structured status fields. Never parse exception text. */
export function kubernetesStatusCode(error: unknown): number | undefined {
  const top = record(error);
  if (!top) return undefined;
  return validHttpStatus(top.code)
    ?? validHttpStatus(top.statusCode)
    ?? validHttpStatus(top.status)
    ?? validHttpStatus(record(top.response)?.statusCode)
    ?? validHttpStatus(record(top.response)?.status)
    ?? validHttpStatus(record(top.body)?.code);
}

function identity(projection: PRReviewJobProjection): NamespacedCustomObjectIdentity {
  return {
    group: GROUP,
    version: VERSION,
    namespace: projection.metadata.namespace,
    plural: PLURAL,
    name: projection.metadata.name,
  };
}

function projectedContract(value: unknown): unknown {
  const resource = record(value);
  const metadata = record(resource?.metadata);
  if (!resource || !metadata) return undefined;
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: metadata.name,
      namespace: metadata.namespace,
      labels: metadata.labels,
    },
    spec: resource.spec,
  };
}

function assertExact(existing: unknown, projection: PRReviewJobProjection): void {
  if (!isDeepStrictEqual(projectedContract(existing), projection)) {
    throw new Error('existing PRReviewJob conflicts with the durable projection');
  }
}

function apiFailure(operation: 'get' | 'create', error: unknown): Error {
  const status = kubernetesStatusCode(error);
  return new Error(`Kubernetes PRReviewJob ${operation} failed${status ? ` with status ${status}` : ''}`);
}

export class KubernetesReviewJobProjector implements ReviewJobProjector {
  constructor(private readonly client: NamespacedCustomObjectClient) {}

  async ensure(projection: PRReviewJobProjection): Promise<void> {
    const request = identity(projection);
    try {
      const existing = await this.client.getNamespacedCustomObject(request);
      assertExact(existing, projection);
      return;
    } catch (error) {
      if (kubernetesStatusCode(error) !== 404) {
        if (error instanceof Error && error.message === 'existing PRReviewJob conflicts with the durable projection') {
          throw error;
        }
        throw apiFailure('get', error);
      }
    }

    try {
      await this.client.createNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: projection.metadata.namespace,
        plural: PLURAL,
        body: projection,
        fieldManager: 'review-yeti-job-dispatcher',
        fieldValidation: 'Strict',
      });
    } catch (error) {
      if (kubernetesStatusCode(error) !== 409) throw apiFailure('create', error);
      try {
        const raced = await this.client.getNamespacedCustomObject(request);
        assertExact(raced, projection);
      } catch (rereadError) {
        if (rereadError instanceof Error && rereadError.message === 'existing PRReviewJob conflicts with the durable projection') {
          throw rereadError;
        }
        throw apiFailure('get', rereadError);
      }
    }
  }
}
