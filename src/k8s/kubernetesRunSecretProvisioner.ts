import { kubernetesStatusCode } from './kubernetesReviewJobProjector';
import type { RunSecretProvisioner } from './reviewJobDispatchEngine';
import { deriveRunSecretExecutionAttempt } from './reviewJobProjection';
import { getGitHubAppRepositoryPublishToken, getGitHubAppRepositoryReadToken } from '../github/appAuth';
import { sha256 } from '../review/reviewCore';
import { logger } from '../utils/logger';

export const PUBLISH_TOKEN_KEY = 'GITHUB_PUBLISH_TOKEN';
// The operator wires GH_TOKEN from this key, non-optionally, for the publishing
// lane. Omitting it leaves every app-gate pod in CreateContainerConfigError with
// backoffLimit 0 -- it never starts, never creates a check run, and the pull
// request sees nothing at all.
export const READ_TOKEN_KEY = 'GITHUB_READ_TOKEN';

export interface CoreSecretClient {
  createNamespacedSecret(request: {
    namespace: string;
    body: unknown;
    fieldManager: string;
    fieldValidation: 'Strict';
  }): Promise<unknown>;
  readNamespacedSecret(request: {
    namespace: string;
    name: string;
  }): Promise<unknown>;
  /**
   * REL-896: the only verb this adds beyond REL-586's original get/create pair.
   * Scoped to a JSON-merge-style metadata patch; the caller never sends `data`
   * or `stringData` through it, so a deployed Role granting only this verb still
   * cannot read or overwrite the token material.
   */
  patchNamespacedSecret(request: {
    namespace: string;
    name: string;
    body: unknown;
    fieldManager: string;
  }): Promise<unknown>;
}

export interface KubernetesRunSecretProvisionerOptions {
  client: CoreSecretClient;
  appId: string;
  privateKey: string;
  fieldManager?: string;
  mintToken?: typeof getGitHubAppRepositoryPublishToken;
  mintReadToken?: typeof getGitHubAppRepositoryReadToken;
}

/**
 * Creates the per-run Secret carrying a publish token minted from the installed
 * GitHub App (REL-586).
 *
 * The token is never persisted anywhere but this Secret, and the Secret is named
 * for the run, so its lifetime is the run's. The worker receives only this token --
 * one repository, `checks: write` -- and never the App private key, because that pod
 * parses untrusted pull-request diffs and executes model output.
 */
export class KubernetesRunSecretProvisioner implements RunSecretProvisioner {
  private readonly fieldManager: string;
  private readonly mintToken: typeof getGitHubAppRepositoryPublishToken;
  private readonly mintReadToken: typeof getGitHubAppRepositoryReadToken;

  constructor(private readonly options: KubernetesRunSecretProvisionerOptions) {
    if (!options.appId.trim() || !options.privateKey.trim()) {
      throw new Error('run secret provisioner requires GitHub App credentials');
    }
    this.fieldManager = options.fieldManager || 'ct-review-job-dispatcher';
    this.mintToken = options.mintToken || getGitHubAppRepositoryPublishToken;
    this.mintReadToken = options.mintReadToken || getGitHubAppRepositoryReadToken;
  }

  async provision(request: {
    runId: string;
    secretName: string;
    namespace: string;
    owner: string;
    repo: string;
  }): Promise<{ workerTokenDigest: string }> {
    // The name is derived from the run id upstream; refusing an unexpected shape
    // keeps this from writing a Secret that some other component owns.
    if (deriveRunSecretExecutionAttempt(request.runId, request.secretName) === undefined) {
      throw new Error('run secret name does not match the expected run-scoped pattern');
    }
    if (!request.owner || !request.repo) throw new Error('run secret provisioner requires owner and repo');

    // Recover a successful Secret create before minting anything. This is the
    // normal path after a dispatcher crash between the Kubernetes write and the
    // database digest bind, and it guarantees we never mint a replacement token
    // merely because the durable bind was interrupted.
    const existing = await readExistingRunSecret(this.options.client, request);
    if (existing) return existing;

    const credentials = {
      appId: this.options.appId,
      privateKey: this.options.privateKey,
      owner: request.owner,
      repo: request.repo,
    };
    // Two separately-scoped tokens rather than one broad grant: the panel reads the
    // pull request with contents+pull_requests read, and publishes the check with
    // checks: write. Neither can do the other's job.
    const [minted, readMinted] = await Promise.all([
      this.mintToken(credentials),
      this.mintReadToken(credentials),
    ]);

    const body = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: request.secretName,
        namespace: request.namespace,
        labels: {
          'review-yeti.ai/run-id': request.runId,
          'review-yeti.ai/component': 'run-credentials',
        },
        // Repository names can exceed the 63-character Kubernetes label limit.
        annotations: { 'review-yeti.ai/repository': `${request.owner}/${request.repo}` },
      },
      type: 'Opaque',
      stringData: {
        [PUBLISH_TOKEN_KEY]: minted.token,
        [READ_TOKEN_KEY]: readMinted.token,
      },
    };

    try {
      await this.options.client.createNamespacedSecret({
        namespace: request.namespace,
        body,
        fieldManager: this.fieldManager,
        fieldValidation: 'Strict',
      });
    } catch (error) {
      if (kubernetesStatusCode(error) === 409) {
        // Secret creation and the durable DB binding are separate writes. If the
        // process dies after the first succeeds, recover only the exact named
        // Secret after checking its identity labels and both token keys. Never
        // bind the freshly minted token from this attempt: it was not the token
        // delivered by the already-existing Secret.
        const recovered = await readExistingRunSecret(this.options.client, request);
        if (recovered) return recovered;
        throw new Error('run secret exists but trusted completion binding could not be recovered');
      }
      throw error;
    }
    return { workerTokenDigest: sha256(minted.token) };
  }

  /**
   * REL-896: attach an ownerReference from the run's PRReviewJob to this run's
   * Secret so Kubernetes cascade-deletes it once the CR is retired, instead of
   * relying solely on the shell reapers.
   *
   * Idempotent by inspection rather than by unconditional patch: an unrelated
   * concurrent call (a retried dispatch, a redispatched claim) must not send a
   * second patch once the Secret already carries the exact owner, and a Secret
   * that already has a DIFFERENT owner uid is left untouched rather than
   * adopted -- that would silently reassign cascade-deletion authority away
   * from whatever set it. Only ownerReferences metadata is read and written;
   * this never touches `data`/`stringData`, so a Role granting only this verb
   * still cannot see or overwrite token material.
   *
   * Throws on any read or patch failure; the caller (ReviewJobDispatchEngine)
   * treats that as fail-soft and must not fail the dispatch or block
   * markProjected on it, because the deployed Role may not yet grant `patch`
   * on secrets.
   */
  async attachOwnerReference(request: {
    runId: string;
    secretName: string;
    namespace: string;
    owner: { apiVersion: string; kind: string; name: string; uid: string };
  }): Promise<void> {
    if (deriveRunSecretExecutionAttempt(request.runId, request.secretName) === undefined) {
      throw new Error('run secret name does not match the expected run-scoped pattern');
    }

    const response = await this.options.client.readNamespacedSecret({
      namespace: request.namespace,
      name: request.secretName,
    });
    const secret = (response as { body?: unknown }).body ?? response;
    const metadata = asRecord(asRecord(secret)?.metadata);
    const existingOwners = Array.isArray(metadata?.ownerReferences) ? metadata!.ownerReferences : [];

    const desiredOwner = {
      apiVersion: request.owner.apiVersion,
      kind: request.owner.kind,
      name: request.owner.name,
      uid: request.owner.uid,
      controller: false,
      blockOwnerDeletion: false,
    };
    const matching = existingOwners.find((entry) => {
      const owner = asRecord(entry);
      return owner?.apiVersion === desiredOwner.apiVersion
        && owner?.kind === desiredOwner.kind
        && owner?.name === desiredOwner.name;
    });
    if (matching) {
      const matchingOwner = asRecord(matching);
      if (matchingOwner?.uid === desiredOwner.uid) return; // already correct: no call
      // A different uid means some other PRReviewJob (or reconciler) already
      // owns this Secret name. Never reassign cascade-deletion authority here.
      logger.warn('Run Secret already has a different PRReviewJob owner; leaving it alone (REL-896)', {
        runId: request.runId,
        secretName: request.secretName,
        namespace: request.namespace,
      });
      return;
    }

    await this.options.client.patchNamespacedSecret({
      namespace: request.namespace,
      name: request.secretName,
      body: { metadata: { ownerReferences: [...existingOwners, desiredOwner] } },
      fieldManager: this.fieldManager,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

async function readExistingRunSecret(
  client: CoreSecretClient,
  request: { runId: string; secretName: string; namespace: string; owner: string; repo: string },
): Promise<{ workerTokenDigest: string } | undefined> {
  let response: unknown;
  try {
    response = await client.readNamespacedSecret({ namespace: request.namespace, name: request.secretName });
  } catch (error) {
    if (kubernetesStatusCode(error) === 404) return undefined;
    throw new Error('run secret could not be read for trusted completion binding');
  }
  const secret = (response as { body?: unknown }).body ?? response;
  if (!isTrustedRunSecret(secret, request)) {
    throw new Error('run secret identity could not be verified');
  }
  const publishToken = decodeSecretToken(secret, PUBLISH_TOKEN_KEY);
  // The worker contract requires the sibling read token too. Requiring both
  // prevents an unrelated Secret with a copied publish key from being treated
  // as the run credential object.
  decodeSecretToken(secret, READ_TOKEN_KEY);
  return { workerTokenDigest: sha256(publishToken) };
}

function isTrustedRunSecret(
  value: unknown,
  request: { runId: string; secretName: string; namespace: string; owner: string; repo: string },
): boolean {
  if (!value || typeof value !== 'object') return false;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const record = metadata as {
    name?: unknown;
    namespace?: unknown;
    labels?: unknown;
    annotations?: Record<string, unknown>;
  };
  if (record.name !== request.secretName || record.namespace !== request.namespace) {
    return false;
  }
  if (!record.labels || typeof record.labels !== 'object') return false;
  const labels = record.labels as Record<string, unknown>;
  // Legacy run Secrets have only the run-id/component labels. Their exact
  // identity-derived name still binds them to this run; optional additional
  // identity metadata must match when present.
  const repository = record.annotations?.['review-yeti.ai/repository'];
  return labels['review-yeti.ai/run-id'] === request.runId
    && (repository === undefined || repository === `${request.owner}/${request.repo}`)
    && (labels['review-yeti.ai/owner'] === undefined || labels['review-yeti.ai/owner'] === request.owner)
    && (labels['review-yeti.ai/repo'] === undefined || labels['review-yeti.ai/repo'] === request.repo)
    && labels['review-yeti.ai/component'] === 'run-credentials';
}

function decodeSecretToken(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') throw new Error('secret data unavailable');
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== 'object') throw new Error('secret data unavailable');
  const encoded = (data as Record<string, unknown>)[key];
  if (typeof encoded !== 'string' || !encoded) throw new Error('secret token unavailable');
  const token = Buffer.from(encoded, 'base64').toString('utf8');
  if (!token.startsWith('ghs_')) throw new Error('secret token invalid');
  return token;
}
