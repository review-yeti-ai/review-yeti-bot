import { describe, expect, it, vi } from 'vitest';

const CENTRAL_REPOSITORY = 'calltelemetry/ct-review-actions';
const TARGET_REPOSITORY = 'review-yeti-ai/review-yeti-qualification';
const TARGET_ID = 1_409_547_157;
const TARGET_INSTALLATION_ID = 152_783_031;
const RUN_ID = '98765';
const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const POLICY_DIGEST = 'c'.repeat(64);
const CONFIG_DIGEST = 'd'.repeat(64);
const CENTRAL_WORKFLOW_REF = `${CENTRAL_REPOSITORY}/.github/workflows/repository-dispatch.yml@refs/heads/main`;
const REUSABLE_WORKFLOW_REF = `${CENTRAL_REPOSITORY}/.github/workflows/review-yeti.yml@refs/heads/v1`;
const APP_ID = 4_385_771;
const QUALIFICATION_RUNTIME_IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;

describe('isolated qualification DOKS admission', () => {
  async function harness(callerKind: 'central' | 'direct', qualificationInstance = true,
    preparedRuntimeDigest: string | null = QUALIFICATION_RUNTIME_IMAGE_DIGEST) {
    vi.stubEnv('REVIEW_YETI_CENTRAL_REPOSITORY', CENTRAL_REPOSITORY);
    vi.resetModules();
    const { createActionDispatchRouter } = await import('../../src/api/actionDispatchApi');
    const admit = vi.fn(async () => ({ status: 'accepted' as const,
      run: { runId: `run_${'e'.repeat(32)}` } }));
    const resolve = vi.fn(async (target: Record<string, unknown>) => ({
      identity: target, prepared: { policy: { effectivePolicyDigest: POLICY_DIGEST },
        ...(preparedRuntimeDigest === null ? {} : { qualificationRuntimeImageDigest: preparedRuntimeDigest }) },
    }));
    const claims = callerKind === 'central' ? {
      repository: CENTRAL_REPOSITORY,
      repository_id: '1339040553',
      repository_owner_id: '57884877',
      run_id: RUN_ID,
      run_attempt: '1',
      event_name: 'repository_dispatch',
      workflow_ref: CENTRAL_WORKFLOW_REF,
      job_workflow_ref: REUSABLE_WORKFLOW_REF,
      workflow_sha: 'f'.repeat(40),
    } : {
      repository: TARGET_REPOSITORY,
      repository_id: String(TARGET_ID),
      repository_owner_id: '314096169',
      run_id: RUN_ID,
      run_attempt: '1',
      event_name: 'workflow_dispatch',
    };
    const verify = vi.fn(async () => claims);
    const router = createActionDispatchRouter({
      verifier: { verify, policy: {} } as never,
      admission: { admit } as never,
      allowAppGate: true,
      passthroughEnabled: false,
      ...(qualificationInstance ? { qualificationInstance: true,
        qualificationRuntimeImageDigest: QUALIFICATION_RUNTIME_IMAGE_DIGEST } : {}),
      centralExternalRepositories: new Map([[TARGET_REPOSITORY, TARGET_ID]]),
      resolveInstallationId: vi.fn(async () => TARGET_INSTALLATION_ID),
      authoritativePublishing: {
        expectedAppId: APP_ID,
        repositoryIds: [TARGET_ID],
        repositoryIdentities: [{ repositoryId: TARGET_ID, owner: 'review-yeti-ai', repo: 'review-yeti-qualification' }],
        acceptNewRequests: true,
        resolver: { resolve },
      } as never,
      now: () => Date.parse('2026-10-07T12:00:00.000Z'),
    });
    const actionHandler = (router as any).stack
      .find((layer: any) => layer.route?.path === '/action')?.route?.stack?.[0]?.handle;
    if (typeof actionHandler !== 'function') throw new Error('Action dispatch route was not registered');
    const dispatch = {
      version: 'ActionDispatch.v1',
      deliveryId: `actions:${RUN_ID}:1:${TARGET_ID}:7:${HEAD_SHA}`,
      repositoryId: TARGET_ID, owner: 'review-yeti-ai', repo: 'review-yeti-qualification',
      qualificationRuntimeImageDigest: QUALIFICATION_RUNTIME_IMAGE_DIGEST,
      prNumber: 7, headSha: HEAD_SHA, baseSha: BASE_SHA, actionSha: '9'.repeat(40),
      publishMode: 'app-gate', requestedAt: '2026-10-07T12:00:00.000Z',
      caller: { runId: RUN_ID, runAttempt: 1,
        eventName: callerKind === 'central' ? 'repository_dispatch' : 'workflow_dispatch',
        ...(callerKind === 'central' ? { workflowRef: CENTRAL_WORKFLOW_REF, workflowSha: 'f'.repeat(40) } : {}) },
    };
    const execute = async (body: unknown) => {
      const response = {
        statusCode: 0,
        body: undefined as unknown,
        status(code: number) { this.statusCode = code; return this; },
        json(value: unknown) { this.body = value; return this; },
      };
      await actionHandler({ header: (name: string) => name.toLowerCase() === 'authorization'
        ? 'Bearer opaque-oidc-token' : undefined, body } as never, response as never);
      return response;
    };
    return { execute, admit, resolve, verify, dispatch };
  }

  it('admits a normal exact-target review only from the trusted central OIDC workflow', async () => {
    const f = await harness('central');

    const response = await f.execute(f.dispatch);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({ version: 'ActionDispatchAccepted.v1', status: 'accepted',
      runId: `run_${'e'.repeat(32)}` });
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      repositoryId: TARGET_ID, owner: 'review-yeti-ai', repo: 'review-yeti-qualification',
      prNumber: 7, headSha: HEAD_SHA, baseSha: BASE_SHA,
    }));
    expect(f.admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      repositoryId: TARGET_ID, installationId: TARGET_INSTALLATION_ID,
      centralActionDispatch: true, publicationMode: 'app-gate',
      effectivePolicyDigest: POLICY_DIGEST,
      authoritativeGate: { expectedAppId: APP_ID,
        prepared: { policy: { effectivePolicyDigest: POLICY_DIGEST },
          qualificationRuntimeImageDigest: QUALIFICATION_RUNTIME_IMAGE_DIGEST } },
    }));
  });

  it('rejects a direct target workflow even when it presents the exact repository identity', async () => {
    const f = await harness('direct');

    const response = await f.execute(f.dispatch);

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'External target requires the authorized central workflow' });
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['different', `sha256:${'b'.repeat(64)}`],
  ])('rejects a %s runtime image digest before resolving or admitting', async (_label, digest) => {
    const f = await harness('central');
    const request = { ...f.dispatch, ...(digest === undefined ? { qualificationRuntimeImageDigest: undefined }
      : { qualificationRuntimeImageDigest: digest }) };

    const response = await f.execute(request);

    expect(response.statusCode).toBe(403);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('rejects a prepared receipt whose service-owned runtime capability is missing', async () => {
    const f = await harness('central', true, null);

    const response = await f.execute(f.dispatch);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Qualification runtime image preparation is unavailable' });
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('rejects the qualification runtime capability on a non-qualification service', async () => {
    const f = await harness('central', false);

    const response = await f.execute(f.dispatch);

    expect(response.statusCode).toBe(403);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
  });

  it('does not accept a request-body passthrough override', async () => {
    const f = await harness('central');

    const response = await f.execute({ ...f.dispatch, serviceOwnedPassthrough: false });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid Action dispatch request' });
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.admit).not.toHaveBeenCalled();
  });
});
