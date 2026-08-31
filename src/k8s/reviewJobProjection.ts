import type { PublicationMode } from '../review/reviewRun';

const exactSha = /^[a-f0-9]{40}$/u;
const exactDigest = /^[a-f0-9]{64}$/u;
const runIdPattern = /^run_([a-f0-9]{32})$/u;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u;
const namespacePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const digestOnlyImagePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;

export const TRUSTED_WORKER_IMAGE_REPOSITORY = 'registry.digitalocean.com/calltelemetry/review-yeti-worker';

export interface ReviewJobProjectionInput {
  runId: string;
  deliveryId: string;
  repositoryId: number;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  receivedAt: number;
  terminalDeadline: number;
  policyDigest: string;
  configDigest: string;
  publicationMode: PublicationMode;
  workerImage: string;
  namespace: string;
}

export interface PRReviewJobProjection {
  apiVersion: 'review-yeti.ai/v1alpha2';
  kind: 'PRReviewJob';
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    runId: string;
    deliveryId: string;
    repositoryId: number;
    repo: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    receivedAt: string;
    terminalDeadline: string;
    policyDigest: string;
    configDigest: string;
    publicationMode: 'disabled';
    workerImage: string;
    runSecretName: string;
  };
}

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe integer`);
}

function exactHex(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) throw new Error(`${field} must be exact lowercase hexadecimal`);
}

export function buildReviewJobProjection(
  input: ReviewJobProjectionInput,
  now: number = Date.now(),
): PRReviewJobProjection {
  const runMatch = runIdPattern.exec(input.runId);
  if (!runMatch) throw new Error('run id must be run_ followed by 32 lowercase hexadecimal characters');
  if (!input.deliveryId || input.deliveryId.length > 512) throw new Error('delivery id must contain 1 to 512 characters');
  positiveSafeInteger(input.repositoryId, 'repository id');
  positiveSafeInteger(input.prNumber, 'pull request number');
  if (!repositoryPattern.test(input.repo)) throw new Error('repository must be an owner/name identity');
  exactHex(input.headSha, exactSha, 'head SHA');
  exactHex(input.baseSha, exactSha, 'base SHA');
  exactHex(input.policyDigest, exactDigest, 'policy digest');
  exactHex(input.configDigest, exactDigest, 'config digest');
  if (input.publicationMode !== 'disabled') {
    throw new Error('publication mode must remain disabled during DOKS qualification');
  }
  if (!namespacePattern.test(input.namespace)) throw new Error('namespace must be a Kubernetes DNS label');
  if (!digestOnlyImagePattern.test(input.workerImage)) {
    throw new Error('a strict digest-pinned worker image is required');
  }
  if (!input.workerImage.startsWith(`${TRUSTED_WORKER_IMAGE_REPOSITORY}@sha256:`)) {
    throw new Error(`worker image must use the trusted worker image repository ${TRUSTED_WORKER_IMAGE_REPOSITORY}`);
  }
  if (!Number.isFinite(input.receivedAt) || !Number.isFinite(input.terminalDeadline) || !Number.isFinite(now)) {
    throw new Error('review projection timestamps must be finite');
  }
  if (input.terminalDeadline !== input.receivedAt + 900_000) {
    throw new Error('terminal deadline must be exactly 15 minutes after receipt');
  }
  if (now < input.receivedAt) throw new Error('projection time cannot precede admission receipt');
  if (input.terminalDeadline - now < 120_000) {
    throw new Error('at least 120 seconds must remain before projection');
  }

  const identitySuffix = runMatch[1];
  return {
    apiVersion: 'review-yeti.ai/v1alpha2',
    kind: 'PRReviewJob',
    metadata: {
      name: `ct-review-${identitySuffix}`,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/name': 'review-yeti-worker',
        'review-yeti.ai/publication-mode': 'disabled',
        'review-yeti.ai/run-id': input.runId,
      },
    },
    spec: {
      runId: input.runId,
      deliveryId: input.deliveryId,
      repositoryId: input.repositoryId,
      repo: input.repo,
      prNumber: input.prNumber,
      headSha: input.headSha,
      baseSha: input.baseSha,
      receivedAt: new Date(input.receivedAt).toISOString(),
      terminalDeadline: new Date(input.terminalDeadline).toISOString(),
      policyDigest: input.policyDigest,
      configDigest: input.configDigest,
      publicationMode: 'disabled',
      workerImage: input.workerImage,
      runSecretName: `ct-review-run-${identitySuffix}`,
    },
  };
}
