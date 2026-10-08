import { PINNED_WORKER_IMAGE_PATTERN } from '../k8s/reviewJobProjection';

const digestSuffix = /@sha256:([a-f0-9]{64})$/u;
export const QUALIFICATION_RUNTIME_IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/** Returns the immutable digest only for a worker image accepted by the CR contract. */
export function qualificationRuntimeImageDigestFromReference(imageReference: unknown): string | undefined {
  if (typeof imageReference !== 'string' || !PINNED_WORKER_IMAGE_PATTERN.test(imageReference)) return undefined;
  const match = digestSuffix.exec(imageReference);
  return match ? `sha256:${match[1]}` : undefined;
}
