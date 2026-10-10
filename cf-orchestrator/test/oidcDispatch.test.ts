import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, type KeyLike } from 'jose';
import worker from '../src/worker.js';
import {
  verifyGitHubActionsOidc,
  assertActionDispatchMatchesClaims,
  expectedActionDeliveryId,
  GITHUB_ACTIONS_OIDC_ISSUER,
  type GitHubActionsOidcClaims,
} from '../src/auth/oidcVerifier.js';
import { TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER } from '../src/auth/trustedCentralActionDispatch.js';
import {
  validateActionDispatchRequest,
  handleActionDispatch,
  type ActionDispatchRequest,
} from '../src/api/actionDispatchRoute.js';
import { createMockEnv } from './mockDurableObject.js';
import type { Env, ReviewRunSpec } from '../src/types.js';

// Import verification functions directly from the GitHub Actions dispatch script
// to prove 100% strict contract compatibility!
// @ts-ignore
import { validateReceipt } from '../../../scripts/dispatch-doks-action.mjs';

describe('GitHub Actions OIDC Action Dispatch', () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let attackerPrivateKey: KeyLike;
  let mockKeySet: () => KeyLike;

  before(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    mockKeySet = () => publicKey;

    const attackerPair = await generateKeyPair('RS256');
    attackerPrivateKey = attackerPair.privateKey;
  });

  async function createMockToken(
    claims: Partial<GitHubActionsOidcClaims> = {},
    signingKey: KeyLike = privateKey,
    opts: { issuer?: string; audience?: string | string[]; expiresIn?: string } = {}
  ): Promise<string> {
    const defaultClaims: Record<string, unknown> = {
      repository: 'exampleorg/sample-repo',
      repository_id: '123456',
      repository_owner_id: '78910',
      run_id: '987654321',
      run_attempt: '1',
      event_name: 'pull_request',
      ...claims,
    };

    const jwt = new SignJWT(defaultClaims)
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(opts.issuer ?? GITHUB_ACTIONS_OIDC_ISSUER)
      .setAudience(opts.audience ?? 'review-yeti-doks-dispatch')
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '5m');

    return await jwt.sign(signingKey);
  }

  function createValidDispatchRequest(
    overrides: Partial<ActionDispatchRequest> = {}
  ): ActionDispatchRequest {
    const runId = '987654321';
    const runAttempt = 1;
    const repositoryId = 123456;
    const prNumber = 42;
    const headSha = '1111111111111111111111111111111111111111';
    const baseSha = '0000000000000000000000000000000000000000';
    const actionSha = '2222222222222222222222222222222222222222';

    return {
      version: 'ActionDispatch.v1',
      deliveryId: `actions:${runId}:${runAttempt}:${repositoryId}:${prNumber}:${headSha}`,
      repositoryId,
      owner: 'exampleorg',
      repo: 'sample-repo',
      prNumber,
      headSha,
      baseSha,
      actionSha,
      publishMode: 'app-gate',
      requestedAt: new Date().toISOString(),
      caller: {
        runId,
        runAttempt,
        eventName: 'pull_request',
      },
      ...overrides,
    };
  }

  describe('Request Schema Validation (validateActionDispatchRequest)', () => {
    it('accepts a fully valid request and normalizes SHAs to lowercase', () => {
      const req = createValidDispatchRequest({
        headSha: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });
      const result = validateActionDispatchRequest(req);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(
        result.data?.headSha,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      );
    });

    it('rejects null, non-object, and array payloads', () => {
      assert.strictEqual(validateActionDispatchRequest(null).valid, false);
      assert.strictEqual(validateActionDispatchRequest([]).valid, false);
      assert.strictEqual(validateActionDispatchRequest('bad').valid, false);
    });

    it('rejects invalid or missing version', () => {
      const req = { ...createValidDispatchRequest(), version: 'Invalid.v1' };
      const result = validateActionDispatchRequest(req);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('version'));
    });

    it('rejects non-positive integers for repositoryId or prNumber', () => {
      const req = { ...createValidDispatchRequest(), repositoryId: 0, prNumber: -5 };
      const result = validateActionDispatchRequest(req);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('repositoryId'));
      assert.ok(result.errors.includes('prNumber'));
    });

    it('rejects malformed SHAs', () => {
      const req = { ...createValidDispatchRequest(), headSha: 'shortsha' };
      const result = validateActionDispatchRequest(req);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('headSha'));
    });

    it('rejects unsupported event names', () => {
      const req = createValidDispatchRequest({
        caller: {
          runId: '123',
          runAttempt: 1,
          eventName: 'push' as any,
        },
      });
      const result = validateActionDispatchRequest(req);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('caller.eventName'));
    });
  });

  describe('OIDC Verification (verifyGitHubActionsOidc)', () => {
    it('successfully verifies a valid RS256 token with expected claims', async () => {
      const token = await createMockToken();
      const claims = await verifyGitHubActionsOidc(token, { keySet: mockKeySet });
      assert.strictEqual(claims.repository, 'exampleorg/sample-repo');
      assert.strictEqual(claims.repository_id, '123456');
      assert.strictEqual(claims.run_id, '987654321');
    });

    it('accepts both review-yeti-doks-dispatch and review-yeti-edge-dispatch audiences', async () => {
      const doksToken = await createMockToken({}, privateKey, {
        audience: 'review-yeti-doks-dispatch',
      });
      const edgeToken = await createMockToken({}, privateKey, {
        audience: 'review-yeti-edge-dispatch',
      });

      const doksClaims = await verifyGitHubActionsOidc(doksToken, { keySet: mockKeySet });
      assert.strictEqual(doksClaims.repository, 'exampleorg/sample-repo');

      const edgeClaims = await verifyGitHubActionsOidc(edgeToken, { keySet: mockKeySet });
      assert.strictEqual(edgeClaims.repository, 'exampleorg/sample-repo');
    });

    it('rejects tokens signed by an unauthorized key', async () => {
      const forgedToken = await createMockToken({}, attackerPrivateKey);
      await assert.rejects(
        () => verifyGitHubActionsOidc(forgedToken, { keySet: mockKeySet }),
        /signature verification failed/i
      );
    });

    it('rejects tokens with an invalid issuer', async () => {
      const badIssuerToken = await createMockToken({}, privateKey, {
        issuer: 'https://attacker.example.com',
      });
      await assert.rejects(
        () => verifyGitHubActionsOidc(badIssuerToken, { keySet: mockKeySet }),
        /unexpected "iss" claim/i
      );
    });

    it('rejects tokens with an unexpected audience', async () => {
      const badAudToken = await createMockToken({}, privateKey, {
        audience: 'some-other-app',
      });
      await assert.rejects(
        () => verifyGitHubActionsOidc(badAudToken, { keySet: mockKeySet }),
        /unexpected "aud" claim/i
      );
    });

    it('rejects expired tokens', async () => {
      const expiredToken = await createMockToken({}, privateKey, {
        expiresIn: '-10s',
      });
      await assert.rejects(
        () => verifyGitHubActionsOidc(expiredToken, { keySet: mockKeySet }),
        /"exp" claim timestamp check failed/i
      );
    });

    it('rejects tokens missing required identity claims', async () => {
      const incompleteToken = await new SignJWT({
        repository: 'exampleorg/sample-repo',
        // missing repository_id, run_id, etc.
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(GITHUB_ACTIONS_OIDC_ISSUER)
        .setAudience('review-yeti-doks-dispatch')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

      await assert.rejects(
        () => verifyGitHubActionsOidc(incompleteToken, { keySet: mockKeySet }),
        /claim 'repository_id' is missing/i
      );
    });
  });

  describe('Claims Matching & Identity Assertion (assertActionDispatchMatchesClaims)', () => {
    it('authorizes direct caller when repository and run parameters match', async () => {
      const req = createValidDispatchRequest();
      const claims: GitHubActionsOidcClaims = {
        repository: 'exampleorg/sample-repo',
        repository_id: '123456',
        repository_owner_id: '78910',
        run_id: '987654321',
        run_attempt: '1',
        event_name: 'pull_request',
      };

      const kind = assertActionDispatchMatchesClaims(req, claims);
      assert.strictEqual(kind, 'direct');
    });

    it('authorizes central review repository when invoked via repository_dispatch', async () => {
      const req = createValidDispatchRequest({
        owner: 'exampleorg',
        repo: 'sample-repo',
        caller: {
          runId: '999999',
          runAttempt: 1,
          eventName: 'repository_dispatch',
        },
        deliveryId: expectedActionDeliveryId({
          caller: { runId: '999999', runAttempt: 1 },
          repositoryId: 123456,
          prNumber: 42,
          headSha: '1111111111111111111111111111111111111111',
        }),
      });

      const claims: GitHubActionsOidcClaims = {
        repository: 'review-yeti-ai/review-yeti-action',
        repository_id: '999999',
        repository_owner_id: '88888',
        run_id: '999999',
        run_attempt: '1',
        event_name: 'repository_dispatch',
      };

      const externalTargets = new Map([['exampleorg/sample-repo', {
        repositoryId: 123456,
        owner: 'exampleorg',
        repo: 'sample-repo',
        isPrivate: true,
        appId: 4385771,
      }]]);
      const kind = assertActionDispatchMatchesClaims(req, claims, externalTargets);
      assert.strictEqual(kind, 'central');
    });

    it('retains workflow_dispatch for legacy central Review Yeti callers', () => {
      const runId = '999998';
      const runAttempt = 1;
      const repositoryId = 1326169548;
      const prNumber = 42;
      const headSha = '1111111111111111111111111111111111111111';
      const req = createValidDispatchRequest({
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        repositoryId,
        caller: { runId, runAttempt, eventName: 'workflow_dispatch' },
        deliveryId: expectedActionDeliveryId({ caller: { runId, runAttempt }, repositoryId, prNumber, headSha }),
      });
      const claims: GitHubActionsOidcClaims = {
        repository: 'review-yeti-ai/review-yeti-bot',
        repository_id: '1326169548',
        repository_owner_id: '88888',
        run_id: runId,
        run_attempt: String(runAttempt),
        event_name: 'workflow_dispatch',
      };

      assert.equal(assertActionDispatchMatchesClaims(req, claims), 'central');
    });

    it('rejects legacy central PR events and fork callers targeting the public self repository', () => {
      const runId = '999997';
      const runAttempt = 1;
      const repositoryId = 1326169548;
      const prNumber = 42;
      const headSha = '1111111111111111111111111111111111111111';
      const target = {
        repositoryId,
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        isPrivate: false,
        appId: 4552718,
      };
      const externalTargets = new Map([[`${target.owner}/${target.repo}`, target]]);

      for (const eventName of ['pull_request', 'pull_request_target'] as const) {
        const request = createValidDispatchRequest({
          owner: target.owner,
          repo: target.repo,
          repositoryId,
          caller: { runId, runAttempt, eventName },
          deliveryId: expectedActionDeliveryId({ caller: { runId, runAttempt }, repositoryId, prNumber, headSha }),
        });
        const claims: GitHubActionsOidcClaims = {
          repository: 'review-yeti-ai/review-yeti-action',
          repository_id: '999999',
          repository_owner_id: '88888',
          run_id: runId,
          run_attempt: String(runAttempt),
          event_name: eventName,
          ref: 'refs/pull/42/merge',
          workflow_ref: 'review-yeti-ai/review-yeti-action/.github/workflows/untrusted.yml@refs/pull/42/merge',
          workflow_sha: 'a'.repeat(40),
        };
        assert.throws(() => assertActionDispatchMatchesClaims(request, claims, externalTargets), eventName);
      }

      const forkRequest = createValidDispatchRequest({
        owner: target.owner,
        repo: target.repo,
        repositoryId,
        caller: { runId, runAttempt, eventName: 'workflow_dispatch' },
        deliveryId: expectedActionDeliveryId({ caller: { runId, runAttempt }, repositoryId, prNumber, headSha }),
      });
      const forkClaims: GitHubActionsOidcClaims = {
        repository: 'attacker/review-yeti-action',
        repository_id: '999999',
        repository_owner_id: '77777',
        run_id: runId,
        run_attempt: String(runAttempt),
        event_name: 'workflow_dispatch',
      };
      assert.throws(() => assertActionDispatchMatchesClaims(forkRequest, forkClaims, externalTargets), /does not match OIDC token claims/);
    });

    function createTrustedCentralRequest(overrides: Partial<ActionDispatchRequest> = {}): ActionDispatchRequest {
      const runId = '38029691203';
      const runAttempt = 1;
      const repositoryId = 1131452104;
      const prNumber = 3546;
      const headSha = '4446d2b9f74af4cafbaf01814da80069e51d3cfa';
      return createValidDispatchRequest({
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        repositoryId,
        prNumber,
        headSha,
        baseSha: '59d7f03d8283148e41777f8cd85487fa85bfb675',
        caller: {
          runId,
          runAttempt,
          eventName: 'workflow_dispatch',
          workflowRef: TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER.jobWorkflowRef,
          workflowSha: TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER.jobWorkflowSha,
        },
        deliveryId: expectedActionDeliveryId({ caller: { runId, runAttempt }, repositoryId, prNumber, headSha }),
        ...overrides,
      });
    }

    function trustedCentralClaims(overrides: Partial<GitHubActionsOidcClaims> = {}): GitHubActionsOidcClaims {
      const caller = TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER;
      return {
        repository: caller.repository,
        repository_id: String(caller.repositoryId),
        repository_owner_id: String(caller.repositoryOwnerId),
        run_id: '38029691203',
        run_attempt: '1',
        event_name: 'workflow_dispatch',
        ref: caller.ref,
        workflow_ref: caller.workflowRef,
        workflow_sha: caller.workflowSha,
        job_workflow_ref: caller.jobWorkflowRef,
        job_workflow_sha: caller.jobWorkflowSha,
        ...overrides,
      };
    }

    const trustedAiWorkspace = new Map([['calltelemetry/ai-workspace', {
      repositoryId: 1131452104,
      owner: 'calltelemetry',
      repo: 'ai-workspace',
      isPrivate: true,
      appId: 4385771,
    }]]);

    it('admits the pinned CT central workflow only for the exact enrolled AI workspace identity', () => {
      assert.equal(
        assertActionDispatchMatchesClaims(createTrustedCentralRequest(), trustedCentralClaims(), trustedAiWorkspace),
        'central',
      );
    });

    it('rejects a CT central caller with the wrong repository name, numeric ID, or owner ID', () => {
      const request = createTrustedCentralRequest();
      for (const claims of [
        trustedCentralClaims({ repository: 'calltelemetry/ct-meta' }),
        trustedCentralClaims({ repository_id: '1339040554' }),
        trustedCentralClaims({ repository_owner_id: '314096169' }),
      ]) {
        assert.throws(() => assertActionDispatchMatchesClaims(request, claims, trustedAiWorkspace));
      }
    });

    it('rejects a fork and any unapproved dispatcher or reusable workflow ref/SHA', () => {
      const request = createTrustedCentralRequest();
      for (const claims of [
        trustedCentralClaims({ repository: 'jasonbarbee/ct-review-actions', repository_id: '1339040553' }),
        trustedCentralClaims({ event_name: 'pull_request_target' }),
        trustedCentralClaims({ ref: 'refs/heads/feature/untrusted' }),
        trustedCentralClaims({ workflow_ref: 'calltelemetry/ct-review-actions/.github/workflows/untrusted.yml@refs/heads/main' }),
        trustedCentralClaims({ workflow_sha: 'a'.repeat(40) }),
        trustedCentralClaims({ job_workflow_ref: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@refs/heads/feature/untrusted' }),
        trustedCentralClaims({ job_workflow_sha: 'b'.repeat(40) }),
      ]) {
        assert.throws(() => assertActionDispatchMatchesClaims(request, claims, trustedAiWorkspace));
      }
      assert.throws(() => assertActionDispatchMatchesClaims(createTrustedCentralRequest({
        caller: {
          runId: '38029691203', runAttempt: 1, eventName: 'workflow_dispatch',
          workflowRef: 'calltelemetry/ct-review-actions/.github/workflows/untrusted.yml@refs/heads/main',
          workflowSha: TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER.jobWorkflowSha,
        },
      }), trustedCentralClaims(), trustedAiWorkspace));
      assert.throws(() => assertActionDispatchMatchesClaims(createTrustedCentralRequest({
        caller: {
          runId: '38029691203', runAttempt: 1, eventName: 'workflow_dispatch',
          workflowRef: TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER.jobWorkflowRef,
          workflowSha: 'c'.repeat(40),
        },
      }), trustedCentralClaims(), trustedAiWorkspace));
    });

    it('rejects caller-supplied target ID, App, and unenrolled repository substitutions', () => {
      const request = createTrustedCentralRequest();
      const claims = trustedCentralClaims();
      const wrongId = createTrustedCentralRequest({
        repositoryId: 1355159090,
        deliveryId: expectedActionDeliveryId({
          caller: { runId: '38029691203', runAttempt: 1 },
          repositoryId: 1355159090,
          prNumber: 3546,
          headSha: '4446d2b9f74af4cafbaf01814da80069e51d3cfa',
        }),
      });
      assert.throws(() => assertActionDispatchMatchesClaims(wrongId, claims, trustedAiWorkspace));
      assert.throws(() => assertActionDispatchMatchesClaims(request, claims));
      assert.throws(() => assertActionDispatchMatchesClaims(request, claims, new Map([['calltelemetry/ai-workspace', {
        repositoryId: 1131452104, owner: 'calltelemetry', repo: 'ai-workspace', isPrivate: true, appId: 4552718,
      }]])));
      assert.throws(() => assertActionDispatchMatchesClaims(createTrustedCentralRequest({
        owner: 'calltelemetry', repo: 'unlisted-repo', repositoryId: 999999999,
      }), claims, trustedAiWorkspace));
    });

    it('rejects when repository does not match claims', async () => {
      const req = createValidDispatchRequest({ repo: 'another-repo' });
      const claims: GitHubActionsOidcClaims = {
        repository: 'exampleorg/sample-repo',
        repository_id: '123456',
        repository_owner_id: '78910',
        run_id: '987654321',
        run_attempt: '1',
        event_name: 'pull_request',
      };

      assert.throws(
        () => assertActionDispatchMatchesClaims(req, claims),
        /does not match OIDC token claims/i
      );
    });

    it('rejects when caller.runId does not match claims', async () => {
      const req = createValidDispatchRequest({
        caller: { runId: '111111', runAttempt: 1, eventName: 'pull_request' },
      });
      const claims: GitHubActionsOidcClaims = {
        repository: 'exampleorg/sample-repo',
        repository_id: '123456',
        repository_owner_id: '78910',
        run_id: '987654321',
        run_attempt: '1',
        event_name: 'pull_request',
      };

      assert.throws(
        () => assertActionDispatchMatchesClaims(req, claims),
        /caller\.runId does not match/i
      );
    });

    it('rejects when deliveryId format does not match expected delivery binding', async () => {
      const req = createValidDispatchRequest({
        deliveryId: 'actions:invalid-delivery-format',
      });
      const claims: GitHubActionsOidcClaims = {
        repository: 'exampleorg/sample-repo',
        repository_id: '123456',
        repository_owner_id: '78910',
        run_id: '987654321',
        run_attempt: '1',
        event_name: 'pull_request',
      };

      assert.throws(
        () => assertActionDispatchMatchesClaims(req, claims),
        /deliveryId does not match expected format/i
      );
    });
  });

  describe('HTTP Action Dispatch Endpoint (handleActionDispatch & worker.fetch)', () => {
    function createTestWorkerEnv(overrides: Partial<Env> = {}): {
      env: Env;
      dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }>;
    } {
      const baseEnv = createMockEnv();
      const dispatchedWorkflows: Array<{ id: string; params: ReviewRunSpec }> = [];

      baseEnv.PILOT_REPOSITORIES = 'exampleorg/sample-repo,review-yeti-ai/review-yeti-bot';
      baseEnv.ENVIRONMENT = 'test';
      baseEnv.PARALLEL_MODE = 'false';
      baseEnv.REVIEW_JOB_WORKFLOW = {
        create: async (item: { id: string; params: ReviewRunSpec }) => {
          dispatchedWorkflows.push(item);
        },
      };

      return {
        env: Object.assign(baseEnv, overrides),
        dispatchedWorkflows,
      };
    }

    it('returns HTTP 405 when called with GET or non-POST methods', async () => {
      const { env } = createTestWorkerEnv();
      const req = new Request('http://worker/api/dispatch/action', { method: 'GET' });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 405);
    });

    it('returns HTTP 401 when Authorization header is missing', async () => {
      const { env } = createTestWorkerEnv();
      const req = new Request('http://worker/api/dispatch/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidDispatchRequest()),
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 401);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'GitHub Actions OIDC bearer token is required');
    });

    it('returns HTTP 400 when JSON body is invalid or malformed', async () => {
      const { env } = createTestWorkerEnv();
      const token = await createMockToken();
      const req = new Request('http://worker/api/dispatch/action', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{ malformed json',
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 400);
    });

    it('returns HTTP 400 when required schema fields are missing', async () => {
      const { env } = createTestWorkerEnv();
      const token = await createMockToken();
      const invalidPayload = { version: 'ActionDispatch.v1', owner: 'exampleorg' };
      const req = new Request('http://worker/api/dispatch/action', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(invalidPayload),
      });
      const res = await worker.fetch(req, env);
      assert.strictEqual(res.status, 400);
      const data = (await res.json()) as any;
      assert.ok(Array.isArray(data.invalidFields));
      assert.ok(data.invalidFields.includes('repo'));
      assert.ok(data.invalidFields.includes('headSha'));
    });

    it('returns HTTP 403 when repository is not in PILOT_REPOSITORIES allowlist', async () => {
      const { env } = createTestWorkerEnv({
        PILOT_REPOSITORIES: 'exampleorg/other-repo',
      });
      const token = await createMockToken();
      const dispatchReq = createValidDispatchRequest();

      const req = new Request('http://worker/api/dispatch/action', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dispatchReq),
      });

      const res = await handleActionDispatch(req, env, undefined, { keySet: mockKeySet });
      assert.strictEqual(res.status, 403);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'Action dispatch is not authorized for repository');
    });

    it('returns HTTP 403 when OIDC token signature or claims do not match', async () => {
      const { env } = createTestWorkerEnv();
      const forgedToken = await createMockToken({}, attackerPrivateKey);
      const dispatchReq = createValidDispatchRequest();

      const req = new Request('http://worker/api/dispatch/action', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${forgedToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dispatchReq),
      });

      const res = await handleActionDispatch(req, env, undefined, { keySet: mockKeySet });
      assert.strictEqual(res.status, 403);
      const data = (await res.json()) as any;
      assert.strictEqual(data.error, 'Action dispatch is not authorized');
    });

    it('fails closed without a service-owned current repository enrollment', async () => {
      const { env } = createTestWorkerEnv({
        OPERATOR_GLOBAL_PASSTHROUGH: 'true',
      });
      const token = await createMockToken();
      const dispatchReq = createValidDispatchRequest();

      const req = new Request('http://worker/api/dispatch/action', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dispatchReq),
      });

      const res = await handleActionDispatch(req, env, undefined, { keySet: mockKeySet });
      assert.strictEqual(res.status, 503);

      const receipt = await res.json();
      assert.strictEqual((receipt as any).version, 'ActionDispatchPassthrough.v1');
      assert.strictEqual((receipt as any).publicationState, 'unavailable');
      assert.strictEqual((receipt as any).mergeEligible, false);
      assert.strictEqual((receipt as any).errorCode, 'service_configuration_unavailable');
    });

    it('returns HTTP 202 with ActionDispatchAccepted.v1 and dispatches workflow on normal admission', async () => {
      const { env, dispatchedWorkflows } = createTestWorkerEnv();
      const token = await createMockToken();
      const dispatchReq = createValidDispatchRequest();

      const req = new Request('http://worker/api/dispatch/action', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dispatchReq),
      });

      const res = await handleActionDispatch(req, env, undefined, { keySet: mockKeySet });
      assert.strictEqual(res.status, 202);

      const receipt = (await res.json()) as any;

      // Validate against dispatch-doks-action.mjs validator
      const validated = validateReceipt(receipt);
      assert.strictEqual(validated.version, 'ActionDispatchAccepted.v1');
      assert.strictEqual(validated.status, 'accepted');
      assert.ok(/^run_[a-f0-9]{16,64}$/.test(validated.runId));

      // Verify that workflow was created
      assert.strictEqual(dispatchedWorkflows.length, 1);
      assert.strictEqual(dispatchedWorkflows[0].id, validated.runId);
      assert.strictEqual(dispatchedWorkflows[0].params.owner, 'exampleorg');
      assert.strictEqual(dispatchedWorkflows[0].params.repo, 'sample-repo');
      assert.strictEqual(dispatchedWorkflows[0].params.prNumber, 42);
      assert.strictEqual(dispatchedWorkflows[0].params.headSha, dispatchReq.headSha);

      // Verify registration in RepoGateDO
      const repoGate = env.REPO_GATE.get(
        env.REPO_GATE.idFromName('exampleorg/sample-repo')
      );
      const gateRes = await repoGate.fetch('http://do/active-run/42');
      const gateData = (await gateRes.json()) as any;
      assert.strictEqual(gateData.latestRunId, validated.runId);
    });

    it('dispatches AI workspace only from the pinned CT central workflow and service enrollment', async () => {
      const caller = TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER;
      const runId = '38029691203';
      const runAttempt = 1;
      const repositoryId = 1131452104;
      const prNumber = 3546;
      const headSha = '4446d2b9f74af4cafbaf01814da80069e51d3cfa';
      const baseSha = '59d7f03d8283148e41777f8cd85487fa85bfb675';
      const { env, dispatchedWorkflows } = createTestWorkerEnv({
        PILOT_REPOSITORIES: 'calltelemetry/ai-workspace',
        OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES: JSON.stringify([
          { repositoryId, owner: 'calltelemetry', repo: 'ai-workspace', isPrivate: true, appId: 4385771 },
        ]),
      });
      const dispatchReq = createValidDispatchRequest({
        owner: 'calltelemetry',
        repo: 'ai-workspace',
        repositoryId,
        prNumber,
        headSha,
        baseSha,
        caller: {
          runId,
          runAttempt,
          eventName: 'workflow_dispatch',
          workflowRef: caller.jobWorkflowRef,
          workflowSha: caller.jobWorkflowSha,
        },
        deliveryId: expectedActionDeliveryId({ caller: { runId, runAttempt }, repositoryId, prNumber, headSha }),
      });
      const token = await createMockToken({
        repository: caller.repository,
        repository_id: String(caller.repositoryId),
        repository_owner_id: String(caller.repositoryOwnerId),
        run_id: runId,
        run_attempt: String(runAttempt),
        event_name: 'workflow_dispatch',
        ref: caller.ref,
        workflow_ref: caller.workflowRef,
        workflow_sha: caller.workflowSha,
        job_workflow_ref: caller.jobWorkflowRef,
        job_workflow_sha: caller.jobWorkflowSha,
      });
      const req = new Request('http://worker/api/dispatch/action', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(dispatchReq),
      });

      const res = await handleActionDispatch(req, env, undefined, { keySet: mockKeySet });
      assert.equal(res.status, 202);
      assert.equal(dispatchedWorkflows.length, 1);
      assert.equal(dispatchedWorkflows[0].params.owner, 'calltelemetry');
      assert.equal(dispatchedWorkflows[0].params.repo, 'ai-workspace');
      assert.equal(dispatchedWorkflows[0].params.headSha, headSha);
      assert.equal(dispatchedWorkflows[0].params.baseSha, baseSha);
    });

    it('rejects legacy PR and fork claims before the paused publisher can create or read checks', async () => {
      const originalFetch = globalThis.fetch;
      let githubCalls = 0;
      globalThis.fetch = (async () => {
        githubCalls += 1;
        return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;

      try {
        const repositoryId = 1326169548;
        const prNumber = 42;
        const headSha = '1111111111111111111111111111111111111111';
        const baseSha = '0000000000000000000000000000000000000000';
        const runId = '987650001';
        const runAttempt = 1;
        const targetIdentity = {
          repositoryId,
          owner: 'review-yeti-ai',
          repo: 'review-yeti-bot',
          isPrivate: false,
          appId: 4552718,
        };
        const cases = [
          {
            eventName: 'pull_request' as const,
            repository: 'review-yeti-ai/review-yeti-action',
            repositoryId: '999999',
            repositoryOwnerId: '88888',
            ref: 'refs/pull/42/merge',
            workflowRef: 'review-yeti-ai/review-yeti-action/.github/workflows/untrusted.yml@refs/pull/42/merge',
            workflowSha: 'a'.repeat(40),
          },
          {
            eventName: 'pull_request_target' as const,
            repository: 'review-yeti-ai/review-yeti-action',
            repositoryId: '999999',
            repositoryOwnerId: '88888',
            ref: 'refs/pull/42/merge',
            workflowRef: 'review-yeti-ai/review-yeti-action/.github/workflows/untrusted.yml@refs/pull/42/merge',
            workflowSha: 'a'.repeat(40),
          },
          {
            eventName: 'workflow_dispatch' as const,
            repository: 'attacker/review-yeti-action',
            repositoryId: '999999',
            repositoryOwnerId: '77777',
            ref: 'refs/heads/main',
            workflowRef: 'attacker/review-yeti-action/.github/workflows/review.yml@refs/heads/main',
            workflowSha: 'b'.repeat(40),
          },
        ];

        for (const [index, testCase] of cases.entries()) {
          const { env, dispatchedWorkflows } = createTestWorkerEnv({
            OPERATOR_GLOBAL_PASSTHROUGH: 'true',
            OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES: JSON.stringify([targetIdentity]),
            OPERATOR_PASSTHROUGH_POLICY_SOURCE: JSON.stringify({
              repositoryId: 1339040553,
              owner: 'calltelemetry',
              repo: 'ct-review-actions',
              ref: 'main',
              path: 'policy/review-yeti.json',
            }),
            REVIEW_YETI_PUBLIC_TARGET_APP_ID: '4552718',
          });
          const dispatchReq = createValidDispatchRequest({
            owner: targetIdentity.owner,
            repo: targetIdentity.repo,
            repositoryId,
            prNumber,
            headSha,
            baseSha,
            caller: { runId, runAttempt, eventName: testCase.eventName },
            deliveryId: expectedActionDeliveryId({ caller: { runId, runAttempt }, repositoryId, prNumber, headSha }),
          });
          const token = await createMockToken({
            repository: testCase.repository,
            repository_id: testCase.repositoryId,
            repository_owner_id: testCase.repositoryOwnerId,
            run_id: runId,
            run_attempt: String(runAttempt),
            event_name: testCase.eventName,
            ref: testCase.ref,
            workflow_ref: testCase.workflowRef,
            workflow_sha: testCase.workflowSha,
          });
          const request = new Request('http://worker/api/dispatch/action', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(dispatchReq),
          });

          githubCalls = 0;
          const response = await handleActionDispatch(request, env, undefined, { keySet: mockKeySet });
          assert.equal(response.status, 403, `case ${index}: ${testCase.repository} ${testCase.eventName}`);
          assert.equal(githubCalls, 0, `case ${index}: rejected before any GitHub check read/write`);
          assert.equal(dispatchedWorkflows.length, 0, `case ${index}: no workflow registered`);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('rejects central caller and target drift before registering or dispatching a workflow', async () => {
      const caller = TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER;
      const runId = '38029691203';
      const runAttempt = 1;
      const repositoryId = 1131452104;
      const prNumber = 3546;
      const headSha = '4446d2b9f74af4cafbaf01814da80069e51d3cfa';
      const baseSha = '59d7f03d8283148e41777f8cd85487fa85bfb675';
      const identities = [
        { repositoryId, owner: 'calltelemetry', repo: 'ai-workspace', isPrivate: true, appId: 4385771 },
      ];
      const cases: Array<{
        label: string;
        claims?: Partial<GitHubActionsOidcClaims>;
        request?: Partial<ActionDispatchRequest>;
        removeEnrollment?: boolean;
      }> = [
        { label: 'wrong numeric caller repository ID', claims: { repository_id: '1339040554' } },
        { label: 'wrong caller organization ID', claims: { repository_owner_id: '314096169' } },
        { label: 'fork caller repository', claims: { repository: 'jasonbarbee/ct-review-actions', repository_id: '1339040553' } },
        { label: 'unapproved dispatcher path', claims: { workflow_ref: 'calltelemetry/ct-review-actions/.github/workflows/untrusted.yml@refs/heads/main' } },
        { label: 'unapproved dispatcher SHA', claims: { workflow_sha: 'a'.repeat(40) } },
        { label: 'unapproved reusable workflow ref', claims: { job_workflow_ref: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@refs/heads/feature/untrusted' } },
        { label: 'unapproved reusable workflow SHA', claims: { job_workflow_sha: 'b'.repeat(40) } },
        { label: 'unprotected ref', claims: { ref: 'refs/heads/feature/untrusted' } },
        { label: 'caller-selected wrong target ID', request: { repositoryId: 1355159090 } },
        { label: 'caller-selected unenrolled target', request: { owner: 'calltelemetry', repo: 'unlisted-repo', repositoryId: 999999999 } },
        { label: 'missing service-owned enrollment', removeEnrollment: true },
      ];

      for (const testCase of cases) {
        const { env, dispatchedWorkflows } = createTestWorkerEnv({
          PILOT_REPOSITORIES: 'all',
          OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES: testCase.removeEnrollment ? undefined : JSON.stringify(identities),
        });
        const target = {
          owner: testCase.request?.owner ?? 'calltelemetry',
          repo: testCase.request?.repo ?? 'ai-workspace',
          repositoryId: testCase.request?.repositoryId ?? repositoryId,
        };
        const dispatchReq = createValidDispatchRequest({
          ...target,
          prNumber,
          headSha,
          baseSha,
          caller: {
            runId,
            runAttempt,
            eventName: 'workflow_dispatch',
            workflowRef: caller.jobWorkflowRef,
            workflowSha: caller.jobWorkflowSha,
          },
          deliveryId: expectedActionDeliveryId({ caller: { runId, runAttempt }, repositoryId: target.repositoryId, prNumber, headSha }),
        });
        const token = await createMockToken({
          repository: caller.repository,
          repository_id: String(caller.repositoryId),
          repository_owner_id: String(caller.repositoryOwnerId),
          run_id: runId,
          run_attempt: String(runAttempt),
          event_name: 'workflow_dispatch',
          ref: caller.ref,
          workflow_ref: caller.workflowRef,
          workflow_sha: caller.workflowSha,
          job_workflow_ref: caller.jobWorkflowRef,
          job_workflow_sha: caller.jobWorkflowSha,
          ...testCase.claims,
        });
        const req = new Request('http://worker/api/dispatch/action', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(dispatchReq),
        });
        const res = await handleActionDispatch(req, env, undefined, { keySet: mockKeySet });
        assert.equal(res.status, 403, testCase.label);
        assert.equal(dispatchedWorkflows.length, 0, testCase.label);
      }
    });

    it('routes requests on the /action alias path through worker.fetch', async () => {
      const { env } = createTestWorkerEnv();
      const token = await createMockToken();
      const dispatchReq = createValidDispatchRequest();

      const req = new Request('http://worker/action', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dispatchReq),
      });

      // Pass verifierOptions via custom mock in test or handleActionDispatch
      const res = await handleActionDispatch(req, env, undefined, { keySet: mockKeySet });
      assert.strictEqual(res.status, 202);
      const receipt = (await res.json()) as any;
      assert.strictEqual(receipt.version, 'ActionDispatchAccepted.v1');
    });
  });
});
