import type { PublicationMode } from '../review/reviewRun';
import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';

const exactSha = /^[a-f0-9]{40}$/u;
const exactDigest = /^[a-f0-9]{64}$/u;
const runIdPattern = /^run_([a-f0-9]{32})$/u;
const runSecretNamePattern = /^ct-review-run-([a-f0-9]{32})(?:-a([1-9][0-9]*))?$/u;
const maxExecutionAttempt = 2_147_483_647;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u;
const namespacePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const digestOnlyImagePattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;

export const TRUSTED_WORKER_IMAGE_REPOSITORIES = [
  'ghcr.io/review-yeti-ai/review-yeti-worker',
  'registry.digitalocean.com/calltelemetry/review-yeti-worker',
] as const;

export const TRUSTED_WORKER_IMAGE_REPOSITORY = TRUSTED_WORKER_IMAGE_REPOSITORIES[0];

export const DEFAULT_GENERIC_RUNNER_IMAGE = 'node:24-bookworm-slim';
export const GENERIC_RUNNER_IMAGE_PATTERN = /^(?:node:[a-zA-Z0-9_.-]+|ghcr\.io\/review-yeti-ai\/[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+)$/u;

export type RunnerMode = 'prebaked' | 'generic';

export function isTrustedWorkerImage(image: string): boolean {
  return TRUSTED_WORKER_IMAGE_REPOSITORIES.some((repo) => image.startsWith(`${repo}@sha256:`));
}

export interface ReviewJobProjectionInput {
  runId: string;
  deliveryId: string;
  /** Positive execution identity; projection retries reuse it, new workers advance it. */
  executionAttempt?: number;
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
  runnerMode?: RunnerMode;
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
    publicationMode: PublicationMode;
    workerImage: string;
    runSecretName: string;
    /** Optional for compatibility with projections created before attempt transport was added. */
    executionAttempt?: number;
    runnerMode?: RunnerMode;
  };
}

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe integer`);
}

function exactHex(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) throw new Error(`${field} must be exact lowercase hexadecimal`);
}

/** Canonical writer: first execution is unsuffixed; retries use a positive int32. */
export function buildRunSecretName(runId: string, executionAttempt: number = 1): string {
  const runMatch = runIdPattern.exec(runId);
  if (!runMatch) throw new Error('run id must be run_ followed by 32 lowercase hexadecimal characters');
  if (!Number.isSafeInteger(executionAttempt) || executionAttempt <= 0 || executionAttempt > maxExecutionAttempt) {
    throw new Error('execution attempt must be a positive int32');
  }
  return `ct-review-run-${runMatch[1]}${executionAttempt === 1 ? '' : `-a${executionAttempt}`}`;
}

/** Legacy reader: accepts -a1 as well as the canonical unsuffixed first attempt. */
export function deriveRunSecretExecutionAttempt(runId: unknown, secretName: unknown): number | undefined {
  if (typeof runId !== 'string' || typeof secretName !== 'string') return undefined;
  const runMatch = runIdPattern.exec(runId);
  const secretMatch = runSecretNamePattern.exec(secretName);
  if (!runMatch || !secretMatch || secretMatch[1] !== runMatch[1]) return undefined;
  const attempt = secretMatch[2] === undefined ? 1 : Number(secretMatch[2]);
  return Number.isSafeInteger(attempt) && attempt > 0 && attempt <= maxExecutionAttempt ? attempt : undefined;
}

export function buildReviewJobProjection(
  input: ReviewJobProjectionInput,
  now: number = Date.now(),
): PRReviewJobProjection {
  const executionAttempt = input.executionAttempt ?? 1;
  const runSecretName = buildRunSecretName(input.runId, executionAttempt);
  if (!input.deliveryId || input.deliveryId.length > 512) throw new Error('delivery id must contain 1 to 512 characters');
  positiveSafeInteger(input.repositoryId, 'repository id');
  positiveSafeInteger(input.prNumber, 'pull request number');
  if (!repositoryPattern.test(input.repo)) throw new Error('repository must be an owner/name identity');
  exactHex(input.headSha, exactSha, 'head SHA');
  exactHex(input.baseSha, exactSha, 'base SHA');
  exactHex(input.policyDigest, exactDigest, 'policy digest');
  exactHex(input.configDigest, exactDigest, 'config digest');
  if (input.publicationMode !== 'disabled' && input.publicationMode !== 'app-gate') {
    throw new Error('publication mode must be disabled or app-gate');
  }
  if (!namespacePattern.test(input.namespace)) throw new Error('namespace must be a Kubernetes DNS label');
  const runnerMode: RunnerMode = input.runnerMode || 'prebaked';
  if (runnerMode === 'generic') {
    if (!GENERIC_RUNNER_IMAGE_PATTERN.test(input.workerImage) && !isTrustedWorkerImage(input.workerImage)) {
      throw new Error(
        'generic runner image must be a supported node/runner image (e.g. node:24-bookworm-slim) or trusted worker image',
      );
    }
  } else {
    if (!digestOnlyImagePattern.test(input.workerImage)) {
      throw new Error('a strict digest-pinned worker image is required');
    }
    if (!isTrustedWorkerImage(input.workerImage)) {
      throw new Error(
        `worker image must use a trusted worker image repository (${TRUSTED_WORKER_IMAGE_REPOSITORIES.join(', ')})`,
      );
    }
  }
  if (!Number.isFinite(input.receivedAt) || !Number.isFinite(input.terminalDeadline) || !Number.isFinite(now)) {
    throw new Error('review projection timestamps must be finite');
  }
  if (input.terminalDeadline !== input.receivedAt + TERMINAL_DEADLINE_MS) {
    throw new Error(`terminal deadline must be exactly ${TERMINAL_DEADLINE_MS}ms (the configured terminal-deadline window) after receipt`);
  }
  if (now < input.receivedAt) throw new Error('projection time cannot precede admission receipt');
  if (input.terminalDeadline - now < 120_000) {
    throw new Error('at least 120 seconds must remain before projection');
  }

  // A retry of the same projection keeps this name. Once a worker has reached a
  // terminal state, the dispatcher advances executionAttempt and gets a fresh
  // CR/Secret identity while the immutable run id and review artifacts remain
  // stable. This prevents Kubernetes from accepting a stale terminal object.
  const projectionName = runSecretName.replace('ct-review-run-', 'ct-review-');
  return {
    apiVersion: 'review-yeti.ai/v1alpha2',
    kind: 'PRReviewJob',
    metadata: {
      name: projectionName,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/name': 'review-yeti-worker',
        'review-yeti.ai/publication-mode': input.publicationMode,
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
      publicationMode: input.publicationMode,
      workerImage: input.workerImage,
      runSecretName,
      ...(input.executionAttempt === undefined ? {} : { executionAttempt }),
      runnerMode,
    },
  };
}
