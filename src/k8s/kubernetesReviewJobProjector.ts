import { isDeepStrictEqual } from 'node:util';
import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import type { CancellationPatchResult, ReviewJobProjector } from './reviewJobProjector';
import { deriveRunSecretExecutionAttempt, type PRReviewJobProjection } from './reviewJobProjection';

const GROUP = 'review-yeti.ai';
const VERSION = 'v1alpha2';
const PLURAL = 'prreviewjobs';
/** Mirrors spec.cancelReason maxLength in the v1alpha2 CRD. */
export const CANCEL_REASON_MAX_LENGTH = 256;
const projectionConflictMessage = 'existing PRReviewJob conflicts with the durable projection';
const projectionTerminalMessage = 'existing PRReviewJob is terminal; fresh admission is required';

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

export interface NamespacedCustomObjectPatch {
  group: string;
  version: string;
  namespace: string;
  plural: string;
  name: string;
  body: unknown;
}

export interface NamespacedCustomObjectClient {
  getNamespacedCustomObject(request: NamespacedCustomObjectIdentity): Promise<unknown>;
  createNamespacedCustomObject(request: NamespacedCustomObjectCreate): Promise<unknown>;
  patchNamespacedCustomObject?(
    request: NamespacedCustomObjectPatch,
    options?: any,
  ): Promise<unknown>;
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

function legacyExecutionAttempt(spec: Record<string, unknown>): number {
  const attempt = deriveRunSecretExecutionAttempt(spec.runId, spec.runSecretName);
  if (attempt === undefined) throw new Error(projectionConflictMessage);
  return attempt;
}

function comparisonContract(existing: unknown, projection: PRReviewJobProjection): unknown {
  const contract = projectedContract(existing);
  if (projection.spec.executionAttempt === undefined) return contract;
  const projected = record(contract);
  const observedSpec = record(projected?.spec);
  if (!projected || !observedSpec || Object.prototype.hasOwnProperty.call(observedSpec, 'executionAttempt')) {
    return contract;
  }

  // Kubernetes may return a legacy CR after pruning the new optional field.
  // Clone only the comparison value; never write defaults back to the object
  // returned by the API or treat unrelated fields as part of this migration.
  return {
    ...projected,
    spec: {
      ...observedSpec,
      executionAttempt: legacyExecutionAttempt(observedSpec),
    },
  };
}

function assertExact(existing: unknown, projection: PRReviewJobProjection): void {
  if (!isDeepStrictEqual(comparisonContract(existing, projection), projection)) {
    throw new Error(projectionConflictMessage);
  }
  const phase = record(record(existing)?.status)?.phase;
  if (['Succeeded', 'Failed', 'Expired'].includes(String(phase))) {
    throw new Error(projectionTerminalMessage);
  }
}

function apiFailure(operation: 'get' | 'create' | 'patch', error: unknown): Error {
  const status = kubernetesStatusCode(error);
  const failure = new Error(`Kubernetes PRReviewJob ${operation} failed${status ? ` with status ${status}` : ''}`);
  // Only the structured status is carried forward, never the upstream error.
  return status !== undefined ? Object.assign(failure, { statusCode: status }) : failure;
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
        if (error instanceof Error && [projectionConflictMessage, projectionTerminalMessage].includes(error.message)) {
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
        if (rereadError instanceof Error && [projectionConflictMessage, projectionTerminalMessage].includes(rereadError.message)) {
          throw rereadError;
        }
        throw apiFailure('get', rereadError);
      }
    }
  }

  async patchCancellation(name: string, namespace: string, cancelReason?: string): Promise<CancellationPatchResult> {
    if (!this.client.patchNamespacedCustomObject) {
      throw new Error('Kubernetes client does not support patchNamespacedCustomObject');
    }
    const patchBody: Record<string, unknown> = {
      spec: {
        cancelRequested: true,
        // The CRD bounds cancelReason at 256 characters; an over-long reason
        // would turn every retry into a 422.
        ...(cancelReason ? { cancelReason: Array.from(cancelReason).slice(0, CANCEL_REASON_MAX_LENGTH).join('') } : {}),
      },
    };
    let patched: unknown;
    try {
      patched = await this.client.patchNamespacedCustomObject(
        {
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
          name,
          body: patchBody,
        },
        // REL-1073: the second argument is a client Configuration, not fetch
        // options. A plain `{ headers }` object is ignored and the generated
        // client falls back to application/json-patch+json, which the API server
        // rejects for this object body -- so no cancel was ever applied.
        setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
      );
    } catch (error) {
      const statusCode = kubernetesStatusCode(error);
      if (statusCode === 404) {
        return { status: 'not-found' };
      }
      // The CRD allows only one absent/false -> true flip and pins cancelReason
      // to that flip. A CR already cancelled (e.g. with a different reason)
      // rejects this patch with 422 forever; re-read it so an existing cancel
      // converges instead of retrying on every sweep.
      if (statusCode === 422 && await this.storedCancelRequested(name, namespace) === true) {
        return { status: 'already-cancelled' };
      }
      throw apiFailure('patch', error);
    }
    return { status: 'patched', cancelRequested: record(record(patched)?.spec)?.cancelRequested };
  }

  private async storedCancelRequested(name: string, namespace: string): Promise<unknown> {
    try {
      const stored = await this.client.getNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL, name });
      return record(record(stored)?.spec)?.cancelRequested;
    } catch {
      return undefined;
    }
  }
}
