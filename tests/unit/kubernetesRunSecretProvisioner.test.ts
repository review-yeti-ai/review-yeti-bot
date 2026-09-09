import { describe, expect, it, vi } from 'vitest';
import { KubernetesRunSecretProvisioner, PUBLISH_TOKEN_KEY, READ_TOKEN_KEY } from '../../src/k8s/kubernetesRunSecretProvisioner';
import { sha256 } from '../../src/review/reviewCore';

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
    readNamespacedSecret: vi.fn(async () => { throw { code: 404 }; }),
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
    expect(body.metadata.labels).toMatchObject({
      'review-yeti.ai/run-id': request.runId,
      'review-yeti.ai/component': 'run-credentials',
    });
    expect(body.metadata.annotations).toEqual({ 'review-yeti.ai/repository': `${request.owner}/${request.repo}` });
  });

  it('recovers the exact existing Secret after a create 409 without binding a replacement', async () => {
    const existingToken = 'ghs_existing';
    const conflict = Object.assign(new Error('exists'), { code: 409 });
    const { subject, client, mintToken } = provisioner({
      client: {
        createNamespacedSecret: vi.fn(async () => { throw conflict; }),
        readNamespacedSecret: vi.fn()
          .mockRejectedValueOnce({ code: 404 })
          .mockResolvedValueOnce({ body: {
          metadata: { name: request.secretName, namespace: request.namespace, labels: {
            'review-yeti.ai/run-id': request.runId,
            'review-yeti.ai/owner': request.owner,
            'review-yeti.ai/repo': request.repo,
            'review-yeti.ai/component': 'run-credentials',
          } },
          data: {
            [PUBLISH_TOKEN_KEY]: Buffer.from(existingToken).toString('base64'),
            [READ_TOKEN_KEY]: Buffer.from('ghs_existing_read').toString('base64'),
          },
        } }),
      },
    });
    const result = await subject.provision(request);
    expect(result).toEqual({
      workerTokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    // The candidate mint happened before a concurrent creator won the race, but
    // it is never trusted or bound; the returned digest is the existing Secret's.
    expect(mintToken).toHaveBeenCalledOnce();
    expect(result.workerTokenDigest).toBe(sha256(existingToken));
    expect(client.createNamespacedSecret).toHaveBeenCalledOnce();
    expect(client.readNamespacedSecret).toHaveBeenCalledWith({ namespace: request.namespace, name: request.secretName });
    expect((client as Record<string, unknown>).deleteNamespacedSecret).toBeUndefined();
  });

  it('recovers before minting when the exact Secret already exists after a prior DB bind failure', async () => {
    const existingToken = 'ghs_existing';
    const { subject, client, mintToken } = provisioner({
      client: {
        readNamespacedSecret: vi.fn(async () => ({ metadata: {
          name: request.secretName, namespace: request.namespace, labels: {
            'review-yeti.ai/run-id': request.runId,
            'review-yeti.ai/owner': request.owner,
            'review-yeti.ai/repo': request.repo,
            'review-yeti.ai/component': 'run-credentials',
          },
        }, data: {
          [PUBLISH_TOKEN_KEY]: Buffer.from(existingToken).toString('base64'),
          [READ_TOKEN_KEY]: Buffer.from('ghs_existing_read').toString('base64'),
        } })),
      },
    });
    await expect(subject.provision(request)).resolves.toEqual({ workerTokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(mintToken).not.toHaveBeenCalled();
    expect(client.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('rejects an existing Secret whose identity labels do not match the run', async () => {
    const { subject, client, mintToken } = provisioner({
      client: {
        readNamespacedSecret: vi.fn(async () => ({ metadata: {
          name: request.secretName, namespace: request.namespace, labels: {
            'review-yeti.ai/run-id': request.runId,
            'review-yeti.ai/owner': 'another-owner',
            'review-yeti.ai/repo': request.repo,
            'review-yeti.ai/component': 'run-credentials',
          },
        }, data: {
          [PUBLISH_TOKEN_KEY]: Buffer.from('ghs_foreign').toString('base64'),
          [READ_TOKEN_KEY]: Buffer.from('ghs_foreign_read').toString('base64'),
        } })),
      },
    });
    await expect(subject.provision(request)).rejects.toThrow(/identity could not be verified/u);
    expect(mintToken).not.toHaveBeenCalled();
    expect(client.createNamespacedSecret).not.toHaveBeenCalled();
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

  it('accepts an execution-attempt-scoped Secret name', async () => {
    const { subject, client } = provisioner();
    await subject.provision({ ...request, secretName: `${request.secretName}-a2` });
    expect(client.createNamespacedSecret).toHaveBeenCalledOnce();
  });

  it('rejects a different valid-looking run name before any read or write', async () => {
    const { subject, client } = provisioner();
    await expect(subject.provision({ ...request, secretName: `ct-review-run-${'2'.repeat(32)}` })).rejects.toThrow(/run-scoped pattern/u);
    expect(client.readNamespacedSecret).not.toHaveBeenCalled();
    expect(client.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('keeps long repository names out of Kubernetes labels', async () => {
    const { subject, client } = provisioner();
    await subject.provision({ ...request, repo: 'a'.repeat(100) });
    const body = (client.createNamespacedSecret.mock.calls[0][0] as any).body;
    expect(body.metadata.annotations['review-yeti.ai/repository']).toBe(`calltelemetry/${'a'.repeat(100)}`);
    expect(Object.values(body.metadata.labels).every((entry) => String(entry).length <= 63)).toBe(true);
  });

  it('recovers a legacy identity-bound Secret without adding permission to mutate it', async () => {
    const { subject, client, mintToken } = provisioner({ client: {
      readNamespacedSecret: vi.fn(async () => ({ metadata: {
        name: request.secretName, namespace: request.namespace,
        labels: { 'review-yeti.ai/run-id': request.runId, 'review-yeti.ai/component': 'run-credentials' },
      }, data: {
        [PUBLISH_TOKEN_KEY]: Buffer.from('ghs_legacy').toString('base64'),
        [READ_TOKEN_KEY]: Buffer.from('ghs_legacy_read').toString('base64'),
      } })),
    } });
    await expect(subject.provision(request)).resolves.toEqual({ workerTokenDigest: sha256('ghs_legacy') });
    expect(mintToken).not.toHaveBeenCalled();
    expect(client.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('requires App credentials at construction', () => {
    const client = { createNamespacedSecret: vi.fn(), readNamespacedSecret: vi.fn(), deleteNamespacedSecret: vi.fn() };
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
