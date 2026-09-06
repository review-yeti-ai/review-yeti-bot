import { kubernetesStatusCode } from './kubernetesReviewJobProjector';
import type { RunSecretProvisioner } from './reviewJobDispatchEngine';
import { getGitHubAppRepositoryPublishToken } from '../github/appAuth';

export const PUBLISH_TOKEN_KEY = 'GITHUB_PUBLISH_TOKEN';
const SECRET_NAME_PATTERN = /^ct-review-run-[a-f0-9]{32}$/u;

export interface CoreSecretClient {
  createNamespacedSecret(request: {
    namespace: string;
    body: unknown;
    fieldManager: string;
    fieldValidation: 'Strict';
  }): Promise<unknown>;
  deleteNamespacedSecret(request: { namespace: string; name: string }): Promise<unknown>;
}

export interface KubernetesRunSecretProvisionerOptions {
  client: CoreSecretClient;
  appId: string;
  privateKey: string;
  fieldManager?: string;
  mintToken?: typeof getGitHubAppRepositoryPublishToken;
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

  constructor(private readonly options: KubernetesRunSecretProvisionerOptions) {
    if (!options.appId.trim() || !options.privateKey.trim()) {
      throw new Error('run secret provisioner requires GitHub App credentials');
    }
    this.fieldManager = options.fieldManager || 'ct-review-job-dispatcher';
    this.mintToken = options.mintToken || getGitHubAppRepositoryPublishToken;
  }

  async provision(request: {
    runId: string;
    secretName: string;
    namespace: string;
    owner: string;
    repo: string;
  }): Promise<void> {
    // The name is derived from the run id upstream; refusing an unexpected shape
    // keeps this from writing a Secret that some other component owns.
    if (!SECRET_NAME_PATTERN.test(request.secretName)) {
      throw new Error('run secret name does not match the expected run-scoped pattern');
    }
    if (!request.owner || !request.repo) throw new Error('run secret provisioner requires owner and repo');

    const minted = await this.mintToken({
      appId: this.options.appId,
      privateKey: this.options.privateKey,
      owner: request.owner,
      repo: request.repo,
    });

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
      },
      type: 'Opaque',
      stringData: { [PUBLISH_TOKEN_KEY]: minted.token },
    };

    try {
      await this.options.client.createNamespacedSecret({
        namespace: request.namespace,
        body,
        fieldManager: this.fieldManager,
        fieldValidation: 'Strict',
      });
      return;
    } catch (error) {
      if (kubernetesStatusCode(error) !== 409) throw error;
    }

    // A Secret already exists for this run. It may hold a token from an earlier
    // attempt that has since expired, so replace rather than reuse -- a stale token
    // would fail the review, and this lane fails closed. Delete-then-create instead
    // of patch so the replacement is whole and no stale key survives.
    await this.options.client.deleteNamespacedSecret({
      namespace: request.namespace,
      name: request.secretName,
    });
    await this.options.client.createNamespacedSecret({
      namespace: request.namespace,
      body,
      fieldManager: this.fieldManager,
      fieldValidation: 'Strict',
    });
  }
}
