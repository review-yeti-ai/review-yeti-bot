import { describe, expect, it, vi } from 'vitest';
import { KubernetesRunSecretProvisioner, PUBLISH_TOKEN_KEY, READ_TOKEN_KEY } from '../../src/k8s/kubernetesRunSecretProvisioner';

const request = {
  runId: `run_${'1'.repeat(32)}`,
  secretName: `ct-review-run-${'1'.repeat(32)}`,
  namespace: 'ct-review-system',
  owner: 'calltelemetry',
  repo: 'ct-meta',
};

function provisioner(over: Record<string, any> = {}) {
  const client = {
    createNamespacedSecret: vi.fn(async () => undefined),
    ...over.client,
  };
  const mintToken = over.mintToken || vi.fn(async () => ({
    token: 'ghs_minted',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { checks: 'write' },
  }));
  const mintReadToken = over.mintReadToken || vi.fn(async () => ({
    token: 'ghs_read',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { contents: 'read', pull_requests: 'read' },
  }));
  return {
    client,
    mintToken,
    mintReadToken,
    subject: new KubernetesRunSecretProvisioner({
      client, appId: '123', privateKey: 'key',
      mintToken: mintToken as never, mintReadToken: mintReadToken as never,
    }),
  };
}

describe('KubernetesRunSecretProvisioner', () => {
  it('mints for the run repository and writes only the publish token', async () => {
    const { subject, client, mintToken } = provisioner();
    await subject.provision(request);
    expect(mintToken).toHaveBeenCalledWith(expect.objectContaining({ owner: 'calltelemetry', repo: 'ct-meta' }));
    const body = (client.createNamespacedSecret.mock.calls[0][0] as any).body;
    // Both keys are required: the operator wires GH_TOKEN from GITHUB_READ_TOKEN
    // non-optionally, so a Secret carrying only the publish token leaves every
    // app-gate pod in CreateContainerConfigError -- it never starts and the pull
    // request never sees a check at all.
    expect(body.stringData).toEqual({
      [PUBLISH_TOKEN_KEY]: 'ghs_minted',
      [READ_TOKEN_KEY]: 'ghs_read',
    });
    expect(body.metadata.labels['review-yeti.ai/run-id']).toBe(request.runId);
  });

  it('treats a 409 as success without deleting anything', async () => {
    // A 409 means a sibling dispatcher provisioned this run moments ago with its own
    // fresh tokens. It cannot be a stale Secret: the run id is identity-derived and
    // re-admission does not reset terminal_deadline, so one name is only written
    // inside a single fifteen-minute window.
    //
    // This is what lets the dispatcher hold `create` and NOT `delete` on secrets --
    // a verb Kubernetes cannot scope to one name, which would otherwise reach the
    // App private key and the gateway credential in this namespace.
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const { subject, client } = provisioner({
      client: { createNamespacedSecret: vi.fn(async () => { throw conflict; }) },
    });
    await expect(subject.provision(request)).resolves.toBeUndefined();
    expect(client.createNamespacedSecret).toHaveBeenCalledOnce();
    expect((client as Record<string, unknown>).deleteNamespacedSecret).toBeUndefined();
  });

  it('propagates a non-conflict Kubernetes failure', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { code: 403 });
    const { subject, client } = provisioner({
      client: { createNamespacedSecret: vi.fn(async () => { throw forbidden; }) },
    });
    await expect(subject.provision(request)).rejects.toThrow(/forbidden/u);
  });

  it('never writes a secret when minting fails', async () => {
    const { subject, client } = provisioner({
      mintToken: vi.fn(async () => { throw new Error('unsafe contract'); }),
    });
    await expect(subject.provision(request)).rejects.toThrow(/unsafe contract/u);
    expect(client.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('refuses a secret name outside the run-scoped pattern', async () => {
    // Guards against writing over a Secret some other component owns.
    const { subject, client, mintToken } = provisioner();
    await expect(subject.provision({ ...request, secretName: 'ct-review-action-dispatch-runtime' }))
      .rejects.toThrow(/run-scoped pattern/u);
    expect(mintToken).not.toHaveBeenCalled();
    expect(client.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('requires App credentials at construction', () => {
    const client = { createNamespacedSecret: vi.fn(), deleteNamespacedSecret: vi.fn() };
    expect(() => new KubernetesRunSecretProvisioner({ client, appId: '', privateKey: 'k' }))
      .toThrow(/requires GitHub App credentials/u);
  });

  it('writes nothing when the read token cannot be minted', async () => {
    // Partial credentials are worse than none: the pod would start and then fail
    // mid-review, and this lane fails closed.
    const { subject, client } = provisioner({
      mintReadToken: vi.fn(async () => { throw new Error('unsafe contract'); }),
    });
    await expect(subject.provision(request)).rejects.toThrow(/unsafe contract/u);
    expect(client.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('mints both tokens for the same repository', async () => {
    const { subject, mintToken, mintReadToken } = provisioner();
    await subject.provision(request);
    const expected = expect.objectContaining({ owner: 'calltelemetry', repo: 'ct-meta' });
    expect(mintToken).toHaveBeenCalledWith(expected);
    expect(mintReadToken).toHaveBeenCalledWith(expected);
  });
});
