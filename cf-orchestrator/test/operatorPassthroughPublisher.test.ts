import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import {
  publishOperatorPassthroughForTarget,
  readOperatorPassthroughByRunId,
} from '../src/operatorPassthroughPublisher.js';
import type { Env } from '../src/types.js';
import { queryActiveJobsTool } from '../src/mcp/tools/queryActiveJobs.js';
import { MockDurableObjectState } from './mockDurableObject.js';

const OWNER = 'review-yeti-ai';
const REPO = 'review-yeti-bot';
const REPOSITORY_ID = 1326169548;
const POLICY_REPOSITORY_ID = 1339040553;
const HEAD_A = '1'.repeat(40);
const HEAD_B = '3'.repeat(40);
const BASE_A = '2'.repeat(40);
const BASE_B = '4'.repeat(40);
const POLICY_SHA_A = 'a'.repeat(40);
const POLICY_SHA_B = 'b'.repeat(40);

interface MockCheck {
  id: number;
  name: string;
  head_sha: string;
  external_id: string;
  status: string;
  conclusion: string | null;
  app: { id: number; slug: string };
  output: { title: string; summary: string; annotations_count: number };
}

interface GithubMockOptions {
  target?: { owner: string; repo: string; repositoryId: number; prNumber?: number; headSha?: string; baseSha?: string };
  wrongAppOnCreate?: boolean;
  wrongRepositoryId?: boolean;
  failFirstGatePatch?: boolean;
  failSuccessReadback?: boolean;
  changeHeadOnSecondRead?: boolean;
  changePolicyOnSecondRead?: boolean;
  priorChangesRequested?: boolean;
  cancelOnFirstPatch?: boolean;
  hangOnFirstAuthorityRead?: boolean;
}

function policyDocument(): string {
  return JSON.stringify({
    schema: 'calltelemetry.review-policy.v1',
    review_yeti: {
      repository: `${OWNER}/${REPO}`,
      personas: 'architecture,security,documentation',
      budget: { max_investigation_turns: 20 },
    },
    repository_overrides: {
      'calltelemetry/ct-meta': { severity_policy: 'review-yeti-severity.v2' },
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function createTestEnv(options: GithubMockOptions = {}) {
  const target = options.target || { owner: OWNER, repo: REPO, repositoryId: REPOSITORY_ID, headSha: HEAD_A, baseSha: BASE_A };
  const targetHead = target.headSha || HEAD_A;
  const targetBase = target.baseSha || BASE_A;
  const targetPrNumber = target.prNumber || 42;
  const checks = new Map<number, MockCheck>();
  const publications = new Map<string, ReviewRunDO>();
  const requests: string[] = [];
  const counts = { creates: 0, patches: 0, policyReads: 0, candidateReads: 0 };
  let nextCheckId = 7000;
  let headRead = 0;
  let policyRead = 0;
  let gatePatchFailed = false;
  let cancelIssued = false;

  const env = {
    ENVIRONMENT: 'test',
    PARALLEL_MODE: 'false',
    PARALLEL_CHECK_NAME: 'Review Yeti',
    PILOT_REPOSITORIES: 'all',
    DEFAULT_WORKER_IMAGE: 'test',
    OPERATOR_GLOBAL_PASSTHROUGH: 'true',
    OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES: JSON.stringify([
      { repositoryId: target.repositoryId, owner: target.owner, repo: target.repo },
    ]),
    OPERATOR_PASSTHROUGH_POLICY_SOURCE: JSON.stringify({
      repositoryId: POLICY_REPOSITORY_ID,
      owner: 'calltelemetry',
      repo: 'ct-review-actions',
      ref: 'main',
      path: 'policy/review-yeti.json',
    }),
    GITHUB_APP_ID: '4385771',
    GITHUB_APP_PRIVATE_KEY: '',
    REVIEW_YETI_ATTESTATION_SECRET: 'test-attestation-secret-with-entropy',
    AUTH_CACHE: undefined,
  } as unknown as Env;

  const runNamespace = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let instance = publications.get(id);
      if (!instance) {
        instance = new ReviewRunDO(new MockDurableObjectState() as any, env);
        publications.set(id, instance);
      }
      return {
        fetch: async (url: string, init?: RequestInit) => {
          if (options.failSuccessReadback && new URL(url).pathname === '/operator-passthrough/read'
            && String(init?.method || 'GET').toUpperCase() === 'GET') {
            const state = await instance!.getOperatorPassthroughState();
            if (state?.receipt?.status === 'succeeded') {
              return jsonResponse({ state: { ...state, receipt: null }, link: null });
            }
          }
          return instance!.fetch(new Request(url, init));
        },
      };
    },
  };
  const repoGate = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => jsonResponse({ activeRunId: null, latestRunId: null }),
    }),
  };
  Object.assign(env, { REVIEW_RUN: runNamespace, REPO_GATE: repoGate });

  const cancelActivePublications = async () => {
    for (const [runId, instance] of publications) {
      await instance.fetch(new Request('http://do/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'test-cancelled' }),
      }));
      assert.ok(runId.startsWith('run_'));
    }
  };

  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = String(init.method || (typeof input === 'object' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase();
    const path = url.pathname;
    requests.push(`${method} ${path}`);
    if (options.hangOnFirstAuthorityRead && path.endsWith('/installation') && !headRead) {
      return await new Promise<Response>(() => {});
    }

    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/installation`) return jsonResponse({ id: 11 });
    if (method === 'GET' && path === '/repos/calltelemetry/ct-review-actions/installation') return jsonResponse({ id: 22 });
    if (method === 'POST' && path === '/app/installations/11/access_tokens') return jsonResponse({ token: 'ghs_target_scoped' });
    if (method === 'POST' && path === '/app/installations/22/access_tokens') return jsonResponse({ token: 'ghs_policy_scoped' });

    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}`) {
      counts.candidateReads += 1;
      return jsonResponse({
        id: options.wrongRepositoryId ? target.repositoryId + 1 : target.repositoryId,
        full_name: `${target.owner}/${target.repo}`,
        name: target.repo,
        private: false,
        default_branch: 'main',
        owner: { login: target.owner },
      });
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/pulls/${targetPrNumber}/reviews`) {
      return jsonResponse(options.priorChangesRequested ? [{ state: 'CHANGES_REQUESTED', commit_id: targetHead }] : []);
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/commits/${targetHead}/check-runs`) {
      return jsonResponse({ total_count: checks.size, check_runs: [...checks.values()] });
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/commits/${HEAD_B}/check-runs`) {
      return jsonResponse({ total_count: 0, check_runs: [] });
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/pulls/${targetPrNumber}`) {
      headRead += 1;
      return jsonResponse({
        number: targetPrNumber,
        state: 'open',
        draft: false,
        head: { sha: options.changeHeadOnSecondRead && headRead > 1 ? HEAD_B : targetHead },
        base: {
          sha: options.changeHeadOnSecondRead && headRead > 1 ? BASE_B : targetBase,
          ref: 'main',
          repo: { id: target.repositoryId },
        },
      });
    }
    if (method === 'GET' && path === '/repos/calltelemetry/ct-review-actions') {
      return jsonResponse({ id: POLICY_REPOSITORY_ID, full_name: 'calltelemetry/ct-review-actions', default_branch: 'main' });
    }
    if (method === 'GET' && path === '/repos/calltelemetry/ct-review-actions/commits/main') {
      counts.policyReads += 1;
      policyRead += 1;
      const sha = options.changePolicyOnSecondRead && policyRead > 1 ? POLICY_SHA_B : POLICY_SHA_A;
      return jsonResponse({ sha });
    }
    if (method === 'GET' && path === '/repos/calltelemetry/ct-review-actions/contents/policy/review-yeti.json') {
      const content = Buffer.from(policyDocument(), 'utf8').toString('base64');
      return jsonResponse({ path: 'policy/review-yeti.json', encoding: 'base64', content });
    }

    const checkCollection = new RegExp(`^/repos/${target.owner}/${target.repo}/commits/[a-f0-9]{40}/check-runs$`, 'u');
    if (method === 'GET' && checkCollection.test(path)) return jsonResponse({ total_count: checks.size, check_runs: [...checks.values()] });
    if (method === 'POST' && path === `/repos/${target.owner}/${target.repo}/check-runs`) {
      counts.creates += 1;
      const body = JSON.parse(String(init.body || '{}'));
      const check: MockCheck = {
        id: nextCheckId++,
        name: body.name,
        head_sha: body.head_sha,
        external_id: body.external_id,
        status: body.status,
        conclusion: null,
        app: { id: options.wrongAppOnCreate ? 999999 : 4385771, slug: 'ct-review-bot' },
        output: { ...body.output, annotations_count: 0 },
      };
      checks.set(check.id, check);
      return jsonResponse(check, 201);
    }

    const checkMatch = path.match(new RegExp(`^/repos/${target.owner}/${target.repo}/check-runs/(\\d+)$`, 'u'));
    if (checkMatch && method === 'GET') {
      const check = checks.get(Number(checkMatch[1]));
      return check ? jsonResponse(check) : jsonResponse({ message: 'Not Found' }, 404);
    }
    if (checkMatch && method === 'PATCH') {
      counts.patches += 1;
      const check = checks.get(Number(checkMatch[1]));
      if (!check) return jsonResponse({ message: 'Not Found' }, 404);
      const body = JSON.parse(String(init.body || '{}'));
      if (options.failFirstGatePatch && check.name === 'Review Yeti Gate' && !gatePatchFailed) {
        gatePatchFailed = true;
        return jsonResponse({ message: 'simulated partial publication' }, 500);
      }
      check.status = body.status;
      check.conclusion = body.conclusion;
      check.output = { ...body.output, annotations_count: 0 };
      if (options.cancelOnFirstPatch && !cancelIssued) {
        cancelIssued = true;
        await cancelActivePublications();
      }
      return jsonResponse(check);
    }
    return jsonResponse({ message: `unhandled ${method} ${path}` }, 404);
  };

  return { env, fetchFn, checks, publications, counts, requests };
}

async function createPrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const der = new Uint8Array(exported as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/gu)?.join('\n') || '';
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

describe('Edge operator passthrough publication', () => {
  it('resolves actual current GitHub identity and protected policy, then returns only a durable, exact App pair', async () => {
    const mock = createTestEnv();
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });

    assert.ok(receipt.status === 'succeeded', JSON.stringify({ receipt, requests: mock.requests }));
    assert.equal(receipt.repositoryId, REPOSITORY_ID);
    assert.equal(receipt.headSha, HEAD_A);
    assert.equal(receipt.baseSha, BASE_A);
    assert.equal(receipt.appId, 4385771);
    assert.equal(receipt.reviewStarted, false);
    assert.equal(receipt.expectedLanes, 0);
    assert.equal(receipt.completedLanes, 0);
    assert.equal(receipt.mergeEligible, true);
    assert.equal(mock.counts.creates, 2, JSON.stringify(receipt));
    assert.ok(receipt.policyDigest);

    const durable = (mock.env as any).REVIEW_RUN.get(receipt.runId!);
    const stored = await (await durable.fetch('http://do/operator-passthrough/read')).json() as any;
    assert.equal(stored.state.version, 'OperatorPassthroughState.v1');
    assert.equal(stored.state.receipt.auditDigest, receipt.auditDigest);
    assert.equal(stored.state.receipt.mergeEligible, true);
    const currentStatus = await readOperatorPassthroughByRunId(mock.env, receipt.runId!, { fetchFn: mock.fetchFn });
    assert.equal(currentStatus?.status, 'succeeded');
    assert.equal(currentStatus?.mergeEligible, true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fetchFn;
    try {
      const statusResult = await queryActiveJobsTool.execute({ runId: receipt.runId }, { env: mock.env } as any);
      const statusJson = statusResult.content?.find((item: any) => item.text?.startsWith('{'));
      assert.ok(statusJson);
      const parsedStatus = JSON.parse((statusJson as any).text);
      assert.equal(parsedStatus.operatorPassthrough.status, 'succeeded');
      assert.equal(parsedStatus.mergeEligible, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a same-external-ID check created by the wrong GitHub App', async () => {
    const mock = createTestEnv({ wrongAppOnCreate: true });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(receipt.appId, 4385771);
  });

  it('rejects a repository whose live GitHub ID differs from the service-owned enrollment', async () => {
    const mock = createTestEnv({ wrongRepositoryId: true });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'repository_not_enrolled');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('rejects caller-supplied head, base, policy, or App fields instead of using them as authority', async () => {
    const mock = createTestEnv();
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, {
      owner: OWNER,
      repo: REPO,
      prNumber: 42,
      headSha: HEAD_B,
      baseSha: BASE_B,
      policyDigest: 'f'.repeat(64),
      appId: 999999,
    } as any, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'authoritative_read_unavailable');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.requests.length, 0);
  });

  it('uses the protected per-repository effective override for ct-meta', async () => {
    const mock = createTestEnv({
      target: { owner: 'calltelemetry', repo: 'ct-meta', repositoryId: 1232078607, prNumber: 4168 },
    });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, {
      owner: 'calltelemetry', repo: 'ct-meta', prNumber: 4168,
    }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.repositoryId, 1232078607);
    assert.equal(receipt.policySource.owner, 'calltelemetry');
    assert.equal(receipt.policySource.repo, 'ct-review-actions');
    assert.equal(receipt.policySource.sha, POLICY_SHA_A);
    assert.ok(receipt.policyDigest);
  });

  it('preserves a prior same-head CHANGES_REQUESTED decision before creating checks', async () => {
    const mock = createTestEnv({ priorChangesRequested: true });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'prior_semantic_block');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('fails closed when the current head or protected policy changes during publication', async () => {
    for (const options of [{ changeHeadOnSecondRead: true }, { changePolicyOnSecondRead: true }]) {
      const mock = createTestEnv(options);
      (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
      const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
        fetchFn: mock.fetchFn,
      });
      assert.equal(receipt.status, 'unavailable');
      assert.equal(receipt.mergeEligible, false);
    }
  });

  it('keeps a partial PATCH retry on the same durable check IDs without duplicate check creation', async () => {
    const mock = createTestEnv({ failFirstGatePatch: true });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const target = { owner: OWNER, repo: REPO, prNumber: 42 };
    const first = await publishOperatorPassthroughForTarget(mock.env, target, { fetchFn: mock.fetchFn });
    assert.equal(first.status, 'unavailable', first.errorCode || JSON.stringify(first));
    assert.equal(first.mergeEligible, false);
    assert.equal(mock.counts.creates, 2, JSON.stringify(first));

    const second = await publishOperatorPassthroughForTarget(mock.env, target, { fetchFn: mock.fetchFn });
    assert.equal(second.status, 'succeeded');
    assert.equal(second.mergeEligible, true);
    assert.equal(second.runId, first.runId);
    assert.equal(mock.counts.creates, 2);
  });

  it('returns unavailable when the 15-second authority/publication budget expires', async () => {
    const mock = createTestEnv({ hangOnFirstAuthorityRead: true });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
      timeoutMs: 10,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.mergeEligible, false);
  });

  it('keeps a cancellation observed during publication merge-ineligible', async () => {
    const mock = createTestEnv({ cancelOnFirstPatch: true });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.mergeEligible, false);
  });

  it('keeps the paired publication merge-ineligible when its workflow run is cancelled', async () => {
    const mock = createTestEnv({ cancelOnFirstPatch: true });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const sourceRunId = 'run_workflow_source_123';
    const source = (mock.env as any).REVIEW_RUN.get(sourceRunId);
    await source.fetch('http://do/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: sourceRunId, owner: OWNER, repo: REPO, prNumber: 42,
        headSha: HEAD_A, baseSha: BASE_A, installationId: 0,
      }),
    });
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
      sourceRunId,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.mergeEligible, false);
    assert.ok(receipt.errorCode === 'cancel_requested' || receipt.errorCode === 'durable_state_unavailable');
  });

  it('fails closed when the durable success receipt cannot be read back', async () => {
    const mock = createTestEnv({ failSuccessReadback: true });
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'audit_unavailable');
    assert.equal(receipt.mergeEligible, false);
  });
});
