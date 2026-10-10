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

      const externalTargets = new Map([['exampleorg/sample-repo', 123456]]);
      const kind = assertActionDispatchMatchesClaims(req, claims, externalTargets);
      assert.strictEqual(kind, 'central');
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
