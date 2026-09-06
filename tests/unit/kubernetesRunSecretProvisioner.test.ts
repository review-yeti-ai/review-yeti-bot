import { describe, expect, it, vi } from 'vitest';
import { KubernetesRunSecretProvisioner, PUBLISH_TOKEN_KEY } from '../../src/k8s/kubernetesRunSecretProvisioner';

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
    deleteNamespacedSecret: vi.fn(async () => undefined),
    ...over.client,
  };
  const mintToken = over.mintToken || vi.fn(async () => ({
    token: 'ghs_minted',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { checks: 'write' },
  }));
  return {
    client,
    mintToken,
    subject: new KubernetesRunSecretProvisioner({
      client, appId: '123', privateKey: 'key', mintToken: mintToken as never,
    }),
  };
}

describe('KubernetesRunSecretProvisioner', () => {
  it('mints for the run repository and writes only the publish token', async () => {
    const { subject, client, mintToken } = provisioner();
    await subject.provision(request);
    expect(mintToken).toHaveBeenCalledWith(expect.objectContaining({ owner: 'calltelemetry', repo: 'ct-meta' }));
    const body = (client.createNamespacedSecret.mock.calls[0][0] as any).body;
    expect(body.stringData).toEqual({ [PUBLISH_TOKEN_KEY]: 'ghs_minted' });
    expect(body.metadata.labels['review-yeti.ai/run-id']).toBe(request.runId);
  });

  it('replaces an existing run secret rather than reusing it', async () => {
    // A Secret from an earlier attempt may hold an expired token. Reusing it would
    // fail the review, and this lane fails closed.
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    let created = 0;
    const { subject, client } = provisioner({
      client: {
        createNamespacedSecret: vi.fn(async () => {
          created += 1;
          if (created === 1) throw conflict;
          return undefined;
        }),
      },
    });
    await subject.provision(request);
    expect(client.deleteNamespacedSecret).toHaveBeenCalledWith(
      expect.objectContaining({ name: request.secretName }),
    );
    expect(created).toBe(2);
  });

  it('propagates a non-conflict Kubernetes failure', async () => {
    const forbidden = Object.assign(new Error('forbidden'), { code: 403 });
    const { subject, client } = provisioner({
      client: { createNamespacedSecret: vi.fn(async () => { throw forbidden; }) },
    });
    await expect(subject.provision(request)).rejects.toThrow(/forbidden/u);
    expect(client.deleteNamespacedSecret).not.toHaveBeenCalled();
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
});
