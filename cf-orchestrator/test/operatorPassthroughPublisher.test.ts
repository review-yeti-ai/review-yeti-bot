import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewJobWorkflow } from '../src/reviewJobWorkflow.js';
import {
  publishOperatorPassthroughForTarget,
  publishOperatorPassthrough,
  readOperatorPassthroughByRunId,
  readOperatorPassthroughForTarget,
} from '../src/operatorPassthroughPublisher.js';
import { assertNoBlockingPriorOutcome } from '../src/operatorPriorOutcome.js';
import type { Env } from '../src/types.js';
import { queryActiveJobsTool } from '../src/mcp/tools/queryActiveJobs.js';
import { attestPrGateTool } from '../src/mcp/tools/attestPrGate.js';
import { handleMergeGroupAttestation, type MergeGroupPayload } from '../src/mergeGroupAttestation.js';
import { triggerReviewTool } from '../src/mcp/tools/triggerReview.js';
import { MockDurableObjectState } from './mockDurableObject.js';
import { MockContainerRunner } from '../src/runners/containerRunner.js';
import worker from '../src/worker.js';
import { PUBLIC_REVIEW_REPOSITORY, PUBLIC_REVIEW_REPOSITORY_ID, reviewAppIdForRepository } from '../src/reviewAppAuthority.js';

const [OWNER, REPO] = PUBLIC_REVIEW_REPOSITORY.split('/');
const REPOSITORY_ID = PUBLIC_REVIEW_REPOSITORY_ID;
const POLICY_OWNER = 'synthetic-policy-owner';
const POLICY_REPO = 'synthetic-policy-source';
const POLICY_REPOSITORY_ID = 987654322;
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
  started_at: string;
  app: { id: number; slug: string };
  output: { title: string; summary: string; annotations_count: number };
}

interface GithubMockOptions {
  target?: { owner: string; repo: string; repositoryId: number; prNumber?: number; headSha?: string; baseSha?: string };
  legacyRepositoryIdentities?: Array<{ repositoryId: number; owner: string; repo: string }>;
  privateRepositoryIdentities?: string;
  wrongAppOnCreate?: boolean;
  wrongRepositoryId?: boolean;
  failCheckCreateStatus?: number;
  failPolicyInstallationStatus?: number;
  checkReadFailureStatus?: number;
  failFirstGatePatch?: boolean;
  failSuccessReadback?: boolean;
  changeHeadOnSecondRead?: boolean;
  changePolicyOnSecondRead?: boolean;
  priorChangesRequested?: boolean;
  cancelOnFirstPatch?: boolean;
  hangOnFirstAuthorityRead?: boolean;
  reviewHistory?: any[];
  reviewAfterFirstGatePatch?: any;
  privateOnRepositoryRead?: number;
  cancelOnReviewRead?: number;
}

function policyDocument(): string {
  return JSON.stringify({
    schema: 'synthetic-owner.review-policy.v1',
    review_yeti: {
      repository: `${OWNER}/${REPO}`,
      personas: 'architecture,security,documentation',
      budget: { max_investigation_turns: 20 },
    },
    repository_overrides: {
      'synthetic-owner/synthetic-repository': { severity_policy: 'review-yeti-severity.v2' },
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
  const reviewHistory = [...(options.reviewHistory || (options.priorChangesRequested
    ? [{ id: 1, user: { id: 101 }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-10T00:00:00Z', commit_id: targetHead }]
    : []))];
  const checks = new Map<number, MockCheck>();
  const publications = new Map<string, ReviewRunDO>();
  const repoGates = new Map<string, RepoGateDO>();
  const requests: string[] = [];
  const counts = { creates: 0, patches: 0, policyReads: 0, candidateReads: 0, reviewReads: 0, appIssuers: [] as number[] };
  let nextCheckId = 7000;
  let headRead = 0;
  let repositoryRead = 0;
  let policyRead = 0;
  let currentPolicySha: string | undefined;
  let checkReadFailureStatus = options.checkReadFailureStatus;
  let gatePatchFailed = false;
  let cancelIssued = false;
  let cancelOnReviewRead = options.cancelOnReviewRead;
  let privateOnRead = options.privateOnRepositoryRead;

  const env = {
    ENVIRONMENT: 'test',
    PARALLEL_CHECK_NAME: 'Review Yeti',
    PILOT_REPOSITORIES: 'all',
    DEFAULT_WORKER_IMAGE: 'test',
    OPERATOR_GLOBAL_PASSTHROUGH: 'true',
    OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES: JSON.stringify(options.legacyRepositoryIdentities ?? [
      { repositoryId: target.repositoryId, owner: target.owner, repo: target.repo },
    ]),
    ...(options.privateRepositoryIdentities === undefined ? {} : {
      OPERATOR_PASSTHROUGH_PRIVATE_REPOSITORY_IDENTITIES: options.privateRepositoryIdentities,
    }),
    OPERATOR_PASSTHROUGH_POLICY_SOURCE: JSON.stringify({
      repositoryId: POLICY_REPOSITORY_ID,
      owner: POLICY_OWNER,
      repo: POLICY_REPO,
      ref: 'main',
      path: 'policy/review-yeti.json',
    }),
    GITHUB_APP_ID: '4385771',
    GITHUB_APP_PRIVATE_KEY: '',
    REVIEW_YETI_PUBLIC_TARGET_APP_ID: '4552718',
    REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY: '',
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
    get: (id: string) => {
      let instance = repoGates.get(id);
      if (!instance) {
        instance = new RepoGateDO(new MockDurableObjectState() as any, env);
        repoGates.set(id, instance);
      }
      return {
        fetch: async (url: string, init?: RequestInit) => instance!.fetch(new Request(url, init)),
      };
    },
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
    if (method === 'GET' && path === `/repos/${POLICY_OWNER}/${POLICY_REPO}/installation`) {
      return options.failPolicyInstallationStatus
        ? jsonResponse({ message: 'fixture policy installation unavailable' }, options.failPolicyInstallationStatus)
        : jsonResponse({ id: 22 });
    }
    if (method === 'POST' && (path === '/app/installations/11/access_tokens' || path === '/app/installations/22/access_tokens')) {
      const authorization = new Headers(init.headers).get('Authorization') || '';
      const jwtPayload = authorization.startsWith('Bearer ')
        ? JSON.parse(Buffer.from(authorization.slice(7).split('.')[1] || '', 'base64url').toString('utf8'))
        : {};
      counts.appIssuers.push(Number(jwtPayload.iss));
      return jsonResponse({ token: path.includes('/11/') ? 'ghs_target_scoped' : 'ghs_policy_scoped' });
    }

    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}`) {
      counts.candidateReads += 1;
      repositoryRead += 1;
      return jsonResponse({
        id: options.wrongRepositoryId ? target.repositoryId + 1 : target.repositoryId,
        full_name: `${target.owner}/${target.repo}`,
        name: target.repo,
        private: privateOnRead !== undefined && repositoryRead >= privateOnRead,
        default_branch: 'main',
        owner: { login: target.owner },
      });
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/pulls/${targetPrNumber}/reviews`) {
      counts.reviewReads += 1;
      if (cancelOnReviewRead === counts.reviewReads) {
        cancelOnReviewRead = undefined;
        await cancelActivePublications();
      }
      return jsonResponse(reviewHistory);
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/commits/${targetHead}/check-runs`) {
      const currentChecks = [...checks.values()].filter((check) => check.head_sha === targetHead);
      return jsonResponse({ total_count: currentChecks.length, check_runs: currentChecks });
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
    if (method === 'GET' && path === `/repos/${POLICY_OWNER}/${POLICY_REPO}`) {
      return jsonResponse({ id: POLICY_REPOSITORY_ID, full_name: `${POLICY_OWNER}/${POLICY_REPO}`, default_branch: 'main' });
    }
    if (method === 'GET' && path === `/repos/${POLICY_OWNER}/${POLICY_REPO}/commits/main`) {
      counts.policyReads += 1;
      policyRead += 1;
      const sha = currentPolicySha || (options.changePolicyOnSecondRead && policyRead > 1 ? POLICY_SHA_B : POLICY_SHA_A);
      return jsonResponse({ sha });
    }
    if (method === 'GET' && path === `/repos/${POLICY_OWNER}/${POLICY_REPO}/contents/policy/review-yeti.json`) {
      const content = Buffer.from(policyDocument(), 'utf8').toString('base64');
      return jsonResponse({ path: 'policy/review-yeti.json', encoding: 'base64', content });
    }

    const checkCollection = new RegExp(`^/repos/${target.owner}/${target.repo}/commits/[a-f0-9]{40}/check-runs$`, 'u');
    if (method === 'GET' && checkCollection.test(path)) {
      const commitSha = path.match(/\/commits\/([a-f0-9]{40})\/check-runs$/u)?.[1];
      const currentChecks = [...checks.values()].filter((check) => check.head_sha === commitSha);
      return jsonResponse({ total_count: currentChecks.length, check_runs: currentChecks });
    }
    if (method === 'POST' && path === `/repos/${target.owner}/${target.repo}/check-runs`) {
      counts.creates += 1;
      if (options.failCheckCreateStatus) {
        return jsonResponse({ message: 'private diagnostic' }, options.failCheckCreateStatus);
      }
      const body = JSON.parse(String(init.body || '{}'));
      const check: MockCheck = {
        id: nextCheckId++,
        name: body.name,
        head_sha: body.head_sha,
        external_id: body.external_id,
        status: body.status,
        conclusion: null,
        started_at: new Date().toISOString(),
        app: {
          id: options.wrongAppOnCreate ? 999999 : reviewAppIdForRepository(target),
          slug: 'ct-review-bot',
        },
        output: { ...body.output, annotations_count: 0 },
      };
      checks.set(check.id, check);
      return jsonResponse(check, 201);
    }

    const checkMatch = path.match(new RegExp(`^/repos/${target.owner}/${target.repo}/check-runs/(\\d+)$`, 'u'));
    if (checkMatch && method === 'GET') {
      if (checkReadFailureStatus) {
        return jsonResponse({ message: 'private diagnostic' }, checkReadFailureStatus);
      }
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
        if (options.reviewAfterFirstGatePatch) reviewHistory.push(options.reviewAfterFirstGatePatch);
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

  return {
    env, fetchFn, checks, publications, counts, requests, reviewHistory,
    setPrivateOnRepositoryRead: (read: number | undefined) => { privateOnRead = read; },
    setPolicySha: (sha: string | undefined) => { currentPolicySha = sha; },
    setCheckReadFailureStatus: (status: number | undefined) => { checkReadFailureStatus = status; },
    cancelOnNextReviewRead: () => { cancelOnReviewRead = counts.reviewReads + 1; },
  };
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

async function configureAppKeys(env: Env): Promise<void> {
  const key = await createPrivateKey();
  (env as any).GITHUB_APP_PRIVATE_KEY = key;
  (env as any).REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY = key;
}

async function seedUnstartedPriorRun(mock: ReturnType<typeof createTestEnv>, runId: string): Promise<void> {
  const prior = (mock.env as any).REVIEW_RUN.get(runId);
  await prior.fetch('http://do/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runId, owner: OWNER, repo: REPO, prNumber: 42,
      headSha: HEAD_B, baseSha: BASE_A, installationId: 11,
    }),
  });
  const status = await (await prior.fetch('http://do/status')).json() as any;
  assert.equal(status.runId, runId);
  assert.equal(status.phase, 'Pending');
  assert.equal(status.isCurrentHead, true);
  assert.equal(status.cancelRequested, false);
  assert.equal(status.headSha, HEAD_B);
  assert.match(status.specDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(status.terminalReceiptSummary, null);
  assert.equal(status.workerId, undefined);
  assert.equal(status.jobId, undefined);
  const gate = (mock.env as any).REPO_GATE.get((mock.env as any).REPO_GATE.idFromName(`${OWNER}/${REPO}`));
  await gate.fetch('http://do/register-run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prNumber: 42, runId }),
  });
}

async function signWebhookPayload(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `sha256=${Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('Edge operator passthrough publication', () => {
  it('resolves actual current GitHub identity and protected policy, then returns only a durable, exact App pair', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });

    assert.ok(receipt.status === 'succeeded', JSON.stringify({ receipt, requests: mock.requests }));
    assert.equal(receipt.repositoryId, REPOSITORY_ID);
    assert.equal(receipt.headSha, HEAD_A);
    assert.equal(receipt.baseSha, BASE_A);
    assert.equal(receipt.appId, 4552718);
    assert.ok(mock.counts.appIssuers.includes(4552718));
    assert.ok(mock.counts.appIssuers.includes(4385771));
    assert.equal(receipt.reviewStarted, false);
    assert.equal(receipt.expectedLanes, 0);
    assert.equal(receipt.completedLanes, 0);
    assert.equal(receipt.mergeEligible, true);
    assert.equal(mock.counts.creates, 2, JSON.stringify(receipt));
    assert.ok(receipt.policyDigest);

    const durable = (mock.env as any).REVIEW_RUN.get(receipt.runId!);
    const stored = await (await durable.fetch('http://do/operator-passthrough/read')).json() as any;
    assert.equal(stored.state.version, 'OperatorPassthroughState.v2');
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

  it('allows a stale unstarted latest pointer only after complete active and queued membership reads', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const priorRunId = 'run_stale_pending_latest';
    await seedUnstartedPriorRun(mock, priorRunId);

    const gate = (mock.env as any).REPO_GATE.get((mock.env as any).REPO_GATE.idFromName(`${OWNER}/${REPO}`));
    await gate.fetch('http://do/acquire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run_active_other_pr', headSha: HEAD_A, prNumber: 99 }),
    });
    const membership = await (await gate.fetch('http://do/active-run/42')).json() as any;
    assert.deepEqual(membership, {
      activeRunId: null,
      activeRunIds: [],
      activeRunIdsComplete: true,
      latestRunId: priorRunId,
      queuedRunIds: [],
    });

    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });

    assert.equal(receipt.status, 'succeeded', JSON.stringify(receipt));
    assert.equal(receipt.reason, 'operator_global_passthrough');
    assert.equal(receipt.reviewStarted, false);
    assert.equal(receipt.expectedLanes, 0);
    assert.equal(receipt.completedLanes, 0);
    assert.equal(receipt.publicationState, 'published');
    assert.equal(receipt.mergeEligible, true);
    assert.equal(mock.counts.creates, 2);
  });

  it('blocks a stale latest pointer when another same-PR active slot survives release of the newer run', async () => {
    const mock = createTestEnv();
    (mock.env as any).MAX_CONCURRENT_JOBS = '2';
    await configureAppKeys(mock.env);
    const olderRunId = 'run_older_same_pr_active';
    const newerRunId = 'run_newer_same_pr_released';
    await seedUnstartedPriorRun(mock, olderRunId);

    const gate = (mock.env as any).REPO_GATE.get((mock.env as any).REPO_GATE.idFromName(`${OWNER}/${REPO}`));
    await gate.fetch('http://do/acquire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: olderRunId, headSha: HEAD_B, prNumber: 42 }),
    });
    await seedUnstartedPriorRun(mock, newerRunId);
    await gate.fetch('http://do/acquire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: newerRunId, headSha: HEAD_B, prNumber: 42 }),
    });
    await gate.fetch('http://do/release', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: newerRunId }),
    });

    const membership = await (await gate.fetch('http://do/active-run/42')).json() as any;
    assert.equal(membership.activeRunId, null);
    assert.deepEqual(membership.activeRunIds, [olderRunId]);
    assert.equal(membership.activeRunIdsComplete, true);
    assert.equal(membership.latestRunId, newerRunId);

    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });

    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'prior_review_active');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('keeps a genuinely active pending latest run blocking passthrough publication', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const priorRunId = 'run_active_pending_latest';
    await seedUnstartedPriorRun(mock, priorRunId);
    const gate = (mock.env as any).REPO_GATE.get((mock.env as any).REPO_GATE.idFromName(`${OWNER}/${REPO}`));
    await gate.fetch('http://do/acquire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: priorRunId, headSha: HEAD_B, prNumber: 42 }),
    });

    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });

    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'prior_review_active');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('keeps a genuinely queued pending latest run blocking passthrough publication', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const priorRunId = 'run_queued_pending_latest';
    await seedUnstartedPriorRun(mock, priorRunId);
    const gate = (mock.env as any).REPO_GATE.get((mock.env as any).REPO_GATE.idFromName(`${OWNER}/${REPO}`));
    await gate.fetch('http://do/acquire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'run_other_pr_slot', headSha: HEAD_A, prNumber: 99 }),
    });
    await gate.fetch('http://do/acquire', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: priorRunId, headSha: HEAD_B, prNumber: 42 }),
    });

    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });

    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'prior_review_active');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('fails closed when active and queued membership is missing or unreadable', async () => {
    for (const fault of ['http_failure', 'missing_queue_membership', 'incomplete_active_membership'] as const) {
      const mock = createTestEnv();
      await configureAppKeys(mock.env);
      const priorRunId = `run_membership_${fault}`;
      await seedUnstartedPriorRun(mock, priorRunId);
      const original = (mock.env as any).REPO_GATE;
      (mock.env as any).REPO_GATE = {
        idFromName: original.idFromName,
        get(id: string) {
          const gate = original.get(id);
          return {
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              if (String(input) === 'http://do/active-run/42') {
                if (fault === 'http_failure') return jsonResponse({ message: 'private diagnostic' }, 503);
                if (fault === 'incomplete_active_membership') return jsonResponse({
                  activeRunId: null,
                  activeRunIds: ['run_unverified_active_membership'],
                  activeRunIdsComplete: false,
                  latestRunId: priorRunId,
                  queuedRunIds: [],
                });
                return jsonResponse({ activeRunId: null, latestRunId: priorRunId });
              }
              return gate.fetch(input, init);
            },
          };
        },
      };

      const receipt = await publishOperatorPassthroughForTarget(mock.env,
        { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });

      assert.equal(receipt.status, 'unavailable', fault);
      assert.equal(receipt.errorCode, 'prior_queue_state_unavailable', fault);
      assert.equal(receipt.mergeEligible, false, fault);
      assert.equal(mock.counts.creates, 0, fault);
    }
  });

  it('fails closed when a pending latest run status or identity readback fails', async () => {
    for (const failedPath of ['http://do/status', 'http://do/source-identity']) {
      const mock = createTestEnv();
      await configureAppKeys(mock.env);
      const priorRunId = `run_readback_${failedPath.endsWith('/status') ? 'status' : 'identity'}`;
      await seedUnstartedPriorRun(mock, priorRunId);
      const original = (mock.env as any).REVIEW_RUN;
      (mock.env as any).REVIEW_RUN = {
        idFromName: original.idFromName,
        get(id: string) {
          const run = original.get(id);
          return {
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              if (id === priorRunId && String(input) === failedPath) {
                return jsonResponse({ message: 'private diagnostic' }, 503);
              }
              return run.fetch(input, init);
            },
          };
        },
      };

      const receipt = await publishOperatorPassthroughForTarget(mock.env,
        { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });

      assert.equal(receipt.status, 'unavailable', failedPath);
      assert.equal(receipt.errorCode, 'prior_do_unavailable', failedPath);
      assert.equal(receipt.mergeEligible, false, failedPath);
      assert.equal(mock.counts.creates, 0, failedPath);
    }
  });

  it('blocks a stale-pending classification when the RepoGate membership changes during readback', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const priorRunId = 'run_pending_membership_race';
    await seedUnstartedPriorRun(mock, priorRunId);
    const original = (mock.env as any).REPO_GATE;
    let membershipReads = 0;
    (mock.env as any).REPO_GATE = {
      idFromName: original.idFromName,
      get(id: string) {
        const gate = original.get(id);
        return {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input) === 'http://do/active-run/42') {
              membershipReads += 1;
              const snapshot = await gate.fetch(input, init);
              if (membershipReads === 1) {
                await gate.fetch('http://do/acquire', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ runId: priorRunId, headSha: HEAD_B, prNumber: 42 }),
                });
              }
              return snapshot;
            }
            return gate.fetch(input, init);
          },
        };
      },
    };

    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });

    assert.equal(membershipReads, 2);
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'prior_review_active');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('rejects a same-external-ID check created by the wrong GitHub App', async () => {
    const mock = createTestEnv({ wrongAppOnCreate: true });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(receipt.appId, 4552718);
  });

  it('rejects a repository whose live GitHub ID differs from the service-owned enrollment', async () => {
    const mock = createTestEnv({ wrongRepositoryId: true });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'repository_not_enrolled');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('returns a generic policy-source failure category without echoing configured identities', async () => {
    const target = { owner: 'synthetic-target-owner', repo: 'synthetic-target', repositoryId: 987654321 };
    const mock = createTestEnv({ target, failPolicyInstallationStatus: 403 });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: target.owner, repo: target.repo, prNumber: 42 }, { fetchFn: mock.fetchFn });

    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'policy_source_unavailable');
    assert.doesNotMatch(JSON.stringify(receipt), /synthetic-policy-owner|synthetic-policy-source/u);
  });

  it('publishes for an exact repository identity supplied by the optional private secret binding', async () => {
    const target = { owner: 'fixture-owner', repo: 'enrolled-private-target', repositoryId: 987654321 };
    const mock = createTestEnv({
      target,
      legacyRepositoryIdentities: [{ repositoryId: 987654322, owner: 'fixture-legacy', repo: 'legacy-target' }],
      privateRepositoryIdentities: JSON.stringify([target]),
      privateOnRepositoryRead: 1,
    });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: target.owner, repo: target.repo, prNumber: 42 }, { fetchFn: mock.fetchFn });

    assert.equal(receipt.status, 'succeeded', JSON.stringify({ receipt, requests: mock.requests }));
    assert.equal(receipt.repositoryId, target.repositoryId);
    assert.equal(receipt.appId, 4385771);
    assert.equal(receipt.mergeEligible, true);
    assert.equal(mock.counts.creates, 2);
  });

  it('keeps a private target unenrolled when the optional binding is absent', async () => {
    const target = { owner: 'fixture-owner', repo: 'unenrolled-private-target', repositoryId: 987654323 };
    const mock = createTestEnv({
      target,
      legacyRepositoryIdentities: [{ repositoryId: 987654322, owner: 'fixture-legacy', repo: 'legacy-target' }],
    });
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: target.owner, repo: target.repo, prNumber: 42 }, { fetchFn: mock.fetchFn });

    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'repository_not_enrolled');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.requests.length, 0);
    assert.equal(mock.counts.creates, 0);
  });

  it('fails closed when either existing enrollment binding is absent', async () => {
    for (const binding of ['OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES', 'OPERATOR_PASSTHROUGH_POLICY_SOURCE']) {
      const mock = createTestEnv();
      delete (mock.env as any)[binding];
      const receipt = await publishOperatorPassthroughForTarget(mock.env,
        { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });

      assert.equal(receipt.status, 'unavailable');
      assert.equal(receipt.errorCode, 'service_configuration_unavailable');
      assert.equal(receipt.mergeEligible, false);
      assert.equal(mock.requests.length, 0);
      assert.equal(mock.counts.creates, 0);
    }
  });

  it('fails closed on malformed, wildcard, empty, or extra-field private identity manifests', async () => {
    const invalidManifests = [
      '{',
      JSON.stringify([{ repositoryId: 987654324, owner: 'fixture-owner', repo: '*' }]),
      JSON.stringify([]),
      JSON.stringify([{ repositoryId: 987654324, owner: 'fixture-owner', repo: 'private-target', extra: true }]),
    ];

    for (const privateRepositoryIdentities of invalidManifests) {
      const mock = createTestEnv({ privateRepositoryIdentities });
      const receipt = await publishOperatorPassthroughForTarget(mock.env,
        { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
      assert.equal(receipt.status, 'unavailable', privateRepositoryIdentities);
      assert.equal(receipt.errorCode, 'service_configuration_unavailable', privateRepositoryIdentities);
      assert.equal(receipt.mergeEligible, false, privateRepositoryIdentities);
      assert.equal(mock.requests.length, 0, privateRepositoryIdentities);
      assert.equal(mock.counts.creates, 0, privateRepositoryIdentities);
    }
  });

  it('rejects repository-name and repository-ID collisions between legacy and private manifests', async () => {
    const legacyIdentity = { repositoryId: 987654325, owner: 'fixture-owner', repo: 'legacy-target' };
    const collisions = [
      [{ repositoryId: 987654326, owner: 'FIXTURE-OWNER', repo: 'LEGACY-TARGET' }],
      [{ repositoryId: legacyIdentity.repositoryId, owner: 'another-fixture-owner', repo: 'private-target' }],
    ];

    for (const privateIdentities of collisions) {
      const mock = createTestEnv({
        legacyRepositoryIdentities: [legacyIdentity],
        privateRepositoryIdentities: JSON.stringify(privateIdentities),
      });
      const receipt = await publishOperatorPassthroughForTarget(mock.env,
        { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
      assert.equal(receipt.status, 'unavailable');
      assert.equal(receipt.errorCode, 'service_configuration_unavailable');
      assert.equal(receipt.mergeEligible, false);
      assert.equal(mock.requests.length, 0);
      assert.equal(mock.counts.creates, 0);
    }
  });

  it('fails closed when the dedicated public self-review App binding is missing', async () => {
    const mock = createTestEnv();
    (mock.env as any).GITHUB_APP_PRIVATE_KEY = await createPrivateKey();
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'app_identity_unavailable');
    assert.equal(receipt.appId, 0, 'an unresolved credential failure must not advertise the CT App as self authority');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('requires public self-repository visibility and rejects a visibility drift after publication', async () => {
    const privateAtAdmission = createTestEnv({ privateOnRepositoryRead: 1 });
    await configureAppKeys(privateAtAdmission.env);
    const privateReceipt = await publishOperatorPassthroughForTarget(privateAtAdmission.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: privateAtAdmission.fetchFn });
    assert.equal(privateReceipt.status, 'unavailable');
    assert.equal(privateReceipt.errorCode, 'current_candidate_changed');
    assert.equal(privateAtAdmission.counts.creates, 0);

    const toggled = createTestEnv();
    await configureAppKeys(toggled.env);
    const published = await publishOperatorPassthroughForTarget(toggled.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: toggled.fetchFn });
    assert.equal(published.status, 'succeeded');
    toggled.setPrivateOnRepositoryRead(4);
    const status = await readOperatorPassthroughByRunId(toggled.env, published.runId!, { fetchFn: toggled.fetchFn });
    assert.equal(status?.status, 'unavailable');
    assert.equal(status?.mergeEligible, false);
    assert.equal(status?.errorCode, 'current_candidate_changed');
  });

  it('rejects caller-supplied head, base, policy, or App fields instead of using them as authority', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
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

  it('uses the protected per-repository effective override for a synthetic target', async () => {
    const mock = createTestEnv({
      target: { owner: 'synthetic-owner', repo: 'synthetic-repository', repositoryId: 987654323, prNumber: 4168 },
    });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, {
      owner: 'synthetic-owner', repo: 'synthetic-repository', prNumber: 4168,
    }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.repositoryId, 987654323);
    assert.equal(receipt.appId, 4385771);
    assert.ok(mock.counts.appIssuers.every((appId) => appId === 4385771));
    assert.equal(receipt.policySource.owner, POLICY_OWNER);
    assert.equal(receipt.policySource.repo, POLICY_REPO);
    assert.equal(receipt.policySource.sha, POLICY_SHA_A);
    assert.ok(receipt.policyDigest);
  });

  it('preserves a prior same-head CHANGES_REQUESTED decision before creating checks', async () => {
    const mock = createTestEnv({ priorChangesRequested: true });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'prior_semantic_block');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('allows an explicit approval by the same reviewer to clear their earlier same-head veto', async () => {
    const mock = createTestEnv({ reviewHistory: [
      { id: 1, user: { id: 101 }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-10T00:00:00Z', commit_id: HEAD_A },
      { id: 2, user: { id: 101 }, state: 'APPROVED', submitted_at: '2026-10-10T00:01:00Z', commit_id: HEAD_A },
    ] });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.mergeEligible, true);
  });

  it('does not let a later approval on an older or unknown commit clear a current-head veto', async () => {
    for (const approvalCommit of [HEAD_B, 'malformed-commit', undefined]) {
      const approval = {
        id: 2, user: { id: 101 }, state: 'APPROVED',
        submitted_at: '2026-10-10T00:01:00Z',
        ...(approvalCommit === undefined ? {} : { commit_id: approvalCommit }),
      };
      const mock = createTestEnv({ reviewHistory: [
        { id: 1, user: { id: 101 }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-10T00:00:00Z', commit_id: HEAD_A },
        approval,
      ] });
      await configureAppKeys(mock.env);
      const receipt = await publishOperatorPassthroughForTarget(mock.env,
        { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
      assert.equal(receipt.status, 'unavailable');
      assert.equal(receipt.errorCode, 'prior_semantic_block');
      assert.equal(receipt.mergeEligible, false);
      assert.equal(mock.counts.creates, 0);
    }
  });

  it('allows an explicit dismissal to clear a reviewer veto but not an approval by a different reviewer', async () => {
    const dismissed = createTestEnv({ reviewHistory: [
      { id: 1, user: { id: 101 }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-10T00:00:00Z', commit_id: HEAD_A },
      { id: 2, user: { id: 101 }, state: 'DISMISSED', submitted_at: '2026-10-10T00:01:00Z', commit_id: HEAD_A },
    ] });
    await configureAppKeys(dismissed.env);
    const dismissedReceipt = await publishOperatorPassthroughForTarget(dismissed.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: dismissed.fetchFn });
    assert.equal(dismissedReceipt.status, 'succeeded');

    const otherReviewerApproval = createTestEnv({ reviewHistory: [
      { id: 1, user: { id: 101 }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-10T00:00:00Z', commit_id: HEAD_A },
      { id: 2, user: { id: 202 }, state: 'APPROVED', submitted_at: '2026-10-10T00:01:00Z', commit_id: HEAD_A },
    ] });
    await configureAppKeys(otherReviewerApproval.env);
    const blocked = await publishOperatorPassthroughForTarget(otherReviewerApproval.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: otherReviewerApproval.fetchFn });
    assert.equal(blocked.status, 'unavailable');
    assert.equal(blocked.errorCode, 'prior_semantic_block');
  });

  it('fails closed when the current head or protected policy changes during publication', async () => {
    for (const options of [{ changeHeadOnSecondRead: true }, { changePolicyOnSecondRead: true }]) {
      const mock = createTestEnv(options);
      await configureAppKeys(mock.env);
      const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
        fetchFn: mock.fetchFn,
      });
      assert.equal(receipt.status, 'unavailable');
      assert.equal(receipt.mergeEligible, false);
    }
  });

  it('keeps a partial PATCH retry on the same durable check IDs without duplicate check creation', async () => {
    const mock = createTestEnv({ failFirstGatePatch: true });
    await configureAppKeys(mock.env);
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

  it('admits the exact source run registered by the signed synchronize webhook through RepoGate and Workflow', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const webhookSecret = 'source-workflow-webhook-secret';
    Object.assign(mock.env, {
      GITHUB_WEBHOOK_SECRET: webhookSecret,
      PILOT_REPOSITORIES: `${OWNER}/${REPO}`,
      MAX_CONCURRENT_JOBS: '5',
      OPERATOR_GLOBAL_PASSTHROUGH: 'true',
    });
    let captured: { id: string; params: any } | undefined;
    (mock.env as any).REVIEW_JOB_WORKFLOW = {
      create: async (input: { id: string; params: any }) => { captured = input; return { id: input.id }; },
    };
    const payload = {
      action: 'synchronize',
      repository: {
        id: REPOSITORY_ID, name: REPO, full_name: `${OWNER}/${REPO}`, private: false,
        owner: { login: OWNER },
      },
      pull_request: {
        number: 42, draft: false,
        head: { sha: HEAD_A },
        base: { sha: BASE_A, ref: 'main', repo: { id: REPOSITORY_ID, full_name: `${OWNER}/${REPO}` } },
      },
      installation: { id: 11 },
    };
    const body = JSON.stringify(payload);
    const signature = await signWebhookPayload(webhookSecret, body);
    const response = await worker.fetch(new Request('https://edge.example/api/webhooks/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': signature },
      body,
    }), mock.env as any);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).status, 'dispatched_immediate');
    assert.ok(captured);
    assert.equal(captured!.params.headSha, HEAD_A);

    const gate = mock.env.REPO_GATE.get(mock.env.REPO_GATE.idFromName(`${OWNER}/${REPO}`));
    const registered = await (await gate.fetch(`http://do/active-run/42`)).json() as any;
    assert.equal(registered.latestRunId, captured!.id);
    assert.equal(registered.activeRunId, null);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fetchFn;
    try {
      const workflow = new ReviewJobWorkflow(mock.env as any, new MockContainerRunner());
      const step = { do: async (_name: string, arg2: any, arg3?: any) => (typeof arg2 === 'function' ? arg2 : arg3)(), sleep: async () => {} };
      const result = await workflow.run({ payload: captured!.params } as any, step as any);
      assert.equal(result.status, 'succeeded', JSON.stringify(result));
      assert.equal(result.repositoryId, REPOSITORY_ID);
      assert.equal(result.headSha, HEAD_A);
      assert.notEqual(result.runId, captured!.id, 'publication must retain its deterministic idempotency identity');
      assert.equal(result.appId, 4552718);
      assert.equal(mock.counts.creates, 2);
      const sourceIdentity = await (await (mock.env as any).REVIEW_RUN.get(captured!.id)
        .fetch('http://do/source-identity')).json() as any;
      assert.equal(sourceIdentity.owner, OWNER);
      assert.equal(sourceIdentity.repo, REPO);
      assert.equal(sourceIdentity.prNumber, 42);
      assert.equal(sourceIdentity.headSha, HEAD_A);
      assert.equal(sourceIdentity.baseSha, BASE_A);
      assert.equal(sourceIdentity.version, 'ReviewRunSourceIdentity.v1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not exempt a mismatched source run from an unrelated same-PR pending prior', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const sourceRunId = 'run_foreign_pending_source';
    const source = (mock.env as any).REVIEW_RUN.get(sourceRunId);
    await source.fetch('http://do/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: sourceRunId, owner: OWNER, repo: REPO, prNumber: 42,
        headSha: HEAD_B, baseSha: BASE_A, installationId: 11,
      }),
    });
    const gate = mock.env.REPO_GATE.get(mock.env.REPO_GATE.idFromName(`${OWNER}/${REPO}`));
    await gate.fetch('http://do/register-run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prNumber: 42, runId: sourceRunId }),
    });
    const result = await publishOperatorPassthrough(mock.env, {
      runId: sourceRunId, owner: OWNER, repo: REPO, prNumber: 42,
      headSha: HEAD_A, baseSha: BASE_A, installationId: 11,
    }, { fetchFn: mock.fetchFn });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('does not exempt a foreign-repository source run registered against the target PR', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const sourceRunId = 'run_foreign_repository_source';
    await (mock.env as any).REVIEW_RUN.get(sourceRunId).fetch('http://do/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: sourceRunId, owner: 'elsewhere', repo: 'foreign-repo', prNumber: 42,
        headSha: HEAD_A, baseSha: BASE_A, installationId: 11,
      }),
    });
    await mock.env.REPO_GATE.get(mock.env.REPO_GATE.idFromName(`${OWNER}/${REPO}`)).fetch('http://do/register-run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prNumber: 42, runId: sourceRunId }),
    });
    const result = await publishOperatorPassthrough(mock.env, {
      runId: sourceRunId, owner: OWNER, repo: REPO, prNumber: 42,
      headSha: HEAD_A, baseSha: BASE_A, installationId: 11,
    }, { fetchFn: mock.fetchFn });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.mergeEligible, false);
    assert.equal(mock.counts.creates, 0);
  });

  it('rechecks same-head review history before resuming an idempotent partial publication', async () => {
    const mock = createTestEnv({
      failFirstGatePatch: true,
      reviewAfterFirstGatePatch: {
        id: 99, user: { id: 505 }, state: 'CHANGES_REQUESTED',
        submitted_at: '2026-10-10T00:02:00Z', commit_id: HEAD_A,
      },
    });
    await configureAppKeys(mock.env);
    const target = { owner: OWNER, repo: REPO, prNumber: 42 };
    const first = await publishOperatorPassthroughForTarget(mock.env, target, { fetchFn: mock.fetchFn });
    assert.equal(first.status, 'unavailable');
    assert.equal(mock.counts.creates, 2);
    const reviewReadsBeforeRetry = mock.counts.reviewReads;

    const retry = await publishOperatorPassthroughForTarget(mock.env, target, { fetchFn: mock.fetchFn });
    assert.equal(retry.status, 'unavailable');
    assert.equal(retry.errorCode, 'prior_semantic_block');
    assert.equal(retry.mergeEligible, false);
    assert.equal(retry.runId, first.runId);
    assert.equal(mock.counts.creates, 2);
    assert.equal(mock.counts.patches, 2);
    assert.ok(mock.counts.reviewReads > reviewReadsBeforeRetry);
  });

  it('rechecks current review history before run status and gate attestation accept a receipt', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');
    mock.reviewHistory.push({
      id: 100, user: { id: 506 }, state: 'CHANGES_REQUESTED',
      submitted_at: '2026-10-10T00:03:00Z', commit_id: HEAD_A,
    });
    const reviewReadsBeforeStatus = mock.counts.reviewReads;
    const status = await readOperatorPassthroughByRunId(mock.env, receipt.runId!, { fetchFn: mock.fetchFn });
    assert.equal(status?.status, 'unavailable');
    assert.equal(status?.errorCode, 'prior_semantic_block');
    assert.equal(status?.mergeEligible, false);
    assert.ok(mock.counts.reviewReads > reviewReadsBeforeStatus);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fetchFn;
    try {
      const statusResult = await queryActiveJobsTool.execute({ runId: receipt.runId }, { env: mock.env } as any);
      const statusPayload = statusResult.content?.find((item: any) => item.text?.startsWith('{'));
      assert.ok(statusPayload);
      const statusOutput = JSON.parse((statusPayload as any).text);
      assert.equal(statusOutput.operatorPassthrough.status, 'unavailable');
      assert.equal(statusOutput.mergeEligible, false);

      const gate = await attestPrGateTool.execute({
        owner: OWNER, repo: REPO, pr_number: 42, head_sha: HEAD_A,
      }, { env: mock.env } as any);
      const body = gate.content?.find((item: any) => item.text?.startsWith('{'));
      assert.ok(body);
      const output = JSON.parse((body as any).text);
      assert.equal(output.gate_status, 'BLOCKED');
      assert.equal(output.attested, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports an exact missing check in read-only run diagnostics', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');
    assert.ok(receipt.runId);
    assert.ok(receipt.workerCheckId);
    mock.checks.delete(receipt.workerCheckId!);
    const createsBeforeRead = mock.counts.creates;
    const patchesBeforeRead = mock.counts.patches;

    const status = await readOperatorPassthroughByRunId(mock.env, receipt.runId!, { fetchFn: mock.fetchFn });
    const diagnostic = (status as any)?.diagnostic;
    assert.equal(diagnostic?.category, 'missing_check');
    assert.equal(diagnostic?.stage, 'review');
    assert.equal(diagnostic?.claimState, 'created');
    assert.equal(diagnostic?.checkId, receipt.workerCheckId);
    assert.equal(diagnostic?.externalCheckPresent, false);
    assert.match(diagnostic?.observedAt, /^\d{4}-\d{2}-\d{2}T/u);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fetchFn;
    try {
      const result = await queryActiveJobsTool.execute({ runId: receipt.runId }, { env: mock.env } as any);
      const body = result.content?.find((item: any) => item.text?.startsWith('{'));
      assert.ok(body);
      const report = JSON.parse((body as any).text);
      assert.equal(report.operatorPassthrough.diagnostic.category, 'missing_check');
      assert.equal(report.operatorPassthrough.diagnostic.stage, 'review');
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(mock.counts.creates, createsBeforeRead);
    assert.equal(mock.counts.patches, patchesBeforeRead);
  });

  it('classifies exact-check HTTP failures without exposing response bodies', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');
    const createsBeforeRead = mock.counts.creates;
    const patchesBeforeRead = mock.counts.patches;

    for (const [httpStatus, category] of [
      [403, 'auth_failure'], [429, 'rate_limited'], [504, 'timeout'], [404, 'missing_check'],
      [500, 'existing_check_read_failure'],
    ] as const) {
      mock.setCheckReadFailureStatus(httpStatus);
      const status = await readOperatorPassthroughByRunId(mock.env, receipt.runId!, { fetchFn: mock.fetchFn });
      const diagnostic = (status as any)?.diagnostic;
      assert.equal(diagnostic?.category, category);
      assert.equal(diagnostic?.httpStatus, httpStatus);
      assert.equal(diagnostic?.stage, 'review');
      assert.equal(diagnostic?.checkId, receipt.workerCheckId);
      if (httpStatus === 404) assert.equal(diagnostic?.externalCheckPresent, undefined);
      assert.equal(JSON.stringify(diagnostic).includes('private diagnostic'), false);
    }
    assert.equal(mock.counts.creates, createsBeforeRead);
    assert.equal(mock.counts.patches, patchesBeforeRead);
  });

  it('reports expected and observed App IDs for an exact-check identity mismatch', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');
    const check = mock.checks.get(receipt.workerCheckId!)!;
    check.app.id = 999999;

    const status = await readOperatorPassthroughByRunId(mock.env, receipt.runId!, { fetchFn: mock.fetchFn });
    const diagnostic = (status as any)?.diagnostic;
    assert.equal(diagnostic?.category, 'identity_mismatch');
    assert.equal(diagnostic?.stage, 'review');
    assert.equal(diagnostic?.checkId, receipt.workerCheckId);
    assert.equal(diagnostic?.expectedAppId, 4552718);
    assert.equal(diagnostic?.observedAppId, 999999);

    check.app.id = 4552718;
    const output = check.output as Partial<MockCheck['output']>;
    delete output.summary;
    const summaryStatus = await readOperatorPassthroughByRunId(mock.env, receipt.runId!, { fetchFn: mock.fetchFn });
    const summaryDiagnostic = (summaryStatus as any)?.diagnostic;
    assert.equal(summaryDiagnostic?.category, 'summary_mismatch');
    assert.equal(summaryDiagnostic?.stage, 'review');
    assert.equal(summaryDiagnostic?.checkId, receipt.workerCheckId);
  });

  it('reports a creating claim with no matching check as a read-only observation', async () => {
    const mock = createTestEnv({ failCheckCreateStatus: 503 });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'unavailable');
    assert.ok(receipt.runId);
    const createsBeforeRead = mock.counts.creates;
    const patchesBeforeRead = mock.counts.patches;

    const status = await readOperatorPassthroughByRunId(mock.env, receipt.runId!, { fetchFn: mock.fetchFn });
    const diagnostic = (status as any)?.diagnostic;
    assert.equal(diagnostic?.category, 'creating_check_absent');
    assert.equal(diagnostic?.stage, 'review');
    assert.equal(diagnostic?.claimState, 'creating');
    assert.equal(diagnostic?.checkId, null);
    assert.equal(diagnostic?.externalCheckPresent, false);
    assert.equal(mock.counts.creates, createsBeforeRead);
    assert.equal(mock.counts.patches, patchesBeforeRead);
  });

  it('rejects a completed publisher whose real Durable Object is cancelled during status revalidation', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');
    assert.ok(receipt.runId);

    // Cancellation happens inside the current-review API read, after the cached
    // publisher receipt and check pair have already been read from the Durable Object.
    mock.cancelOnNextReviewRead();
    const status = await readOperatorPassthroughByRunId(mock.env, receipt.runId!, { fetchFn: mock.fetchFn });
    assert.equal(status?.status, 'unavailable');
    assert.equal(status?.errorCode, 'cancel_requested');
    assert.equal(status?.mergeEligible, false);

    const publisherDO = mock.publications.get(receipt.runId!)!;
    const durableStatus = await publisherDO.getStatus();
    assert.equal(durableStatus.phase, 'Completed');
    assert.equal(durableStatus.cancelRequested, true);
    assert.equal(durableStatus.isCurrentHead, false);
    assert.equal(durableStatus.operatorPassthrough?.cancelRequested, true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fetchFn;
    try {
      const httpStatus = await worker.fetch(new Request(`https://operator.internal/api/dispatch/runs/${receipt.runId}/status`), mock.env);
      assert.equal(httpStatus.status, 200);
      const httpStatusBody = await httpStatus.json() as any;
      assert.equal(httpStatusBody.phase, 'Completed');
      assert.equal(httpStatusBody.cancelRequested, true);
      assert.equal(httpStatusBody.isCurrentHead, false);
      assert.equal(httpStatusBody.mergeEligible, false);
      assert.equal(httpStatusBody.operatorPassthrough.errorCode, 'cancel_requested');

      const gate = await attestPrGateTool.execute({
        owner: OWNER, repo: REPO, pr_number: 42, head_sha: HEAD_A,
      }, { env: mock.env } as any);
      const body = gate.content?.find((item: any) => item.text?.startsWith('{'));
      assert.ok(body);
      const output = JSON.parse((body as any).text);
      assert.equal(output.gate_status, 'BLOCKED');
      assert.equal(output.attested, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a publication cancelled during the final prior-review recheck before returning success', async () => {
    const mock = createTestEnv({ cancelOnReviewRead: 2 });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'cancel_requested');
    assert.equal(receipt.mergeEligible, false);
    assert.equal(mock.counts.creates, 2);
    assert.ok(receipt.runId);

    const publisherDO = mock.publications.get(receipt.runId!)!;
    const stored = await publisherDO.getOperatorPassthroughState();
    const durableStatus = await publisherDO.getStatus();
    assert.equal(stored?.cancelRequested, true);
    assert.equal(durableStatus.phase, 'Completed');
    assert.equal(durableStatus.cancelRequested, true);
    assert.equal(durableStatus.isCurrentHead, false);
  });

  it('does not treat a completed publisher with operator-level cancellation as an eligible prior run', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');
    assert.ok(receipt.runId);
    const publisherDO = mock.publications.get(receipt.runId!)!;
    await publisherDO.fetch(new Request('http://do/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'terminal_publisher_cancelled' }),
    }));

    const workerCheck = [...mock.checks.values()].find((check) => check.name === 'Review Yeti')!;
    const gateCheck = [...mock.checks.values()].find((check) => check.name === 'Review Yeti Gate')!;
    await assert.rejects(assertNoBlockingPriorOutcome(mock.env, {
      runId: receipt.runId!, owner: OWNER, repo: REPO, prNumber: 42,
      headSha: HEAD_A, baseSha: BASE_A, installationId: 11,
    }, 'ghs_target_scoped', 4552718, mock.fetchFn, {
      allowCurrentPublisherTerminal: true,
      currentPassthroughChecks: {
        appId: 4552718,
        workerExternalId: workerCheck.external_id,
        gateExternalId: gateCheck.external_id,
      },
    }), /prior_do_identity_mismatch|prior_outcome_unknown/);
  });

  it('keeps merge-group passthrough current across enabled, disabled, missing, and stale-policy states', async () => {
    const mock = createTestEnv();
    await configureAppKeys(mock.env);
    (mock.env as any).GITHUB_TOKEN = 'merge-group-token';
    const target = { owner: OWNER, repo: REPO, prNumber: 42 };
    const receipt = await publishOperatorPassthroughForTarget(mock.env, target, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'succeeded');

    const payload: MergeGroupPayload = {
      action: 'checks_requested',
      merge_group: {
        head_sha: HEAD_B,
        head_ref: 'refs/heads/gh-readonly-queue/main/pr-42-abcdef01',
        base_ref: 'refs/heads/main',
        base_sha: BASE_A,
      },
      repository: { id: REPOSITORY_ID, name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } },
    };
    const mergeFetch: typeof fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === '/graphql') {
        return jsonResponse({
          data: {
            repository: {
              mergeQueue: {
                entries: {
                  nodes: [{
                    position: 1, state: 'MERGEABLE', baseCommit: { oid: BASE_A },
                    pullRequest: { number: 42, headRefOid: HEAD_A, baseRefOid: BASE_A },
                  }],
                },
              },
            },
          },
        });
      }
      if (url.pathname.endsWith('/pulls/42/files')) return jsonResponse([]);
      if (url.pathname.includes('/compare/')) return jsonResponse({ files: [] });
      return mock.fetchFn(input, init);
    };

    const enabled = await handleMergeGroupAttestation(payload, mock.env, mergeFetch);
    assert.equal(enabled.status, 'attested', enabled.summary);
    assert.match(enabled.summary, /durable App 4552718/);

    mock.reviewHistory.push({
      id: 101, user: { id: 507 }, state: 'CHANGES_REQUESTED',
      submitted_at: '2026-10-10T00:04:00Z', commit_id: HEAD_A,
    });
    const vetoed = await handleMergeGroupAttestation(payload, mock.env, mergeFetch);
    assert.equal(vetoed.status, 'blocked');
    assert.equal(vetoed.conclusion, 'failure');
    mock.reviewHistory.push({
      id: 102, user: { id: 507 }, state: 'APPROVED',
      submitted_at: '2026-10-10T00:05:00Z', commit_id: HEAD_A,
    });
    const rereadAfterApproval = await readOperatorPassthroughForTarget(mock.env, target, { headSha: HEAD_A }, { fetchFn: mock.fetchFn });
    assert.equal(rereadAfterApproval.status, 'succeeded', JSON.stringify(rereadAfterApproval));
    const resolvedVeto = await handleMergeGroupAttestation(payload, mock.env, mergeFetch);
    assert.equal(resolvedVeto.status, 'attested', resolvedVeto.summary);

    mock.setPrivateOnRepositoryRead(mock.counts.candidateReads + 1);
    const privateVisibility = await handleMergeGroupAttestation(payload, mock.env, mergeFetch);
    assert.equal(privateVisibility.status, 'blocked');
    assert.match(privateVisibility.summary, /public self-repository visibility/i);
    mock.setPrivateOnRepositoryRead(undefined);

    const disabledEnv = { ...mock.env, OPERATOR_GLOBAL_PASSTHROUGH: 'false' } as Env;
    const disabled = await handleMergeGroupAttestation(payload, disabledEnv, mergeFetch);
    assert.equal(disabled.status, 'blocked');
    assert.equal(disabled.conclusion, 'failure');
    assert.match(disabled.summary, /no newest successful exact-head Review Yeti check from app 4552718/);

    const missingFlagEnv = { ...mock.env } as Env;
    delete (missingFlagEnv as any).OPERATOR_GLOBAL_PASSTHROUGH;
    const missing = await handleMergeGroupAttestation(payload, missingFlagEnv, mergeFetch);
    assert.equal(missing.status, 'blocked');
    assert.equal(missing.conclusion, 'failure');

    mock.setPolicySha(POLICY_SHA_B);
    const staleReceipt = await handleMergeGroupAttestation(payload, mock.env, mergeFetch);
    assert.equal(staleReceipt.status, 'blocked');
    assert.equal(staleReceipt.conclusion, 'failure');
    assert.match(staleReceipt.summary, /no current durable App 4552718 raw\/Gate passthrough publication receipt/);
  });

  it('blocks merge-group passthrough when the durable current receipt cannot be read back', async () => {
    const mock = createTestEnv({ failSuccessReadback: true });
    await configureAppKeys(mock.env);
    (mock.env as any).GITHUB_TOKEN = 'merge-group-token';
    const publication = await publishOperatorPassthroughForTarget(mock.env,
      { owner: OWNER, repo: REPO, prNumber: 42 }, { fetchFn: mock.fetchFn });
    assert.equal(publication.status, 'unavailable');
    assert.equal(publication.mergeEligible, false);

    const payload: MergeGroupPayload = {
      action: 'checks_requested',
      merge_group: {
        head_sha: HEAD_B,
        head_ref: 'refs/heads/gh-readonly-queue/main/pr-42-abcdef01',
        base_ref: 'refs/heads/main',
        base_sha: BASE_A,
      },
      repository: { id: REPOSITORY_ID, name: REPO, full_name: `${OWNER}/${REPO}`, owner: { login: OWNER } },
    };
    const mergeFetch: typeof fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname === '/graphql') {
        return jsonResponse({
          data: { repository: { mergeQueue: { entries: { nodes: [{
            position: 1, state: 'MERGEABLE', baseCommit: { oid: BASE_A },
            pullRequest: { number: 42, headRefOid: HEAD_A, baseRefOid: BASE_A },
          }] } } } },
        });
      }
      return mock.fetchFn(input, init);
    };
    const outcome = await handleMergeGroupAttestation(payload, mock.env, mergeFetch);
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.conclusion, 'failure');
    assert.match(outcome.summary, /no current durable App 4552718 raw\/Gate passthrough publication receipt/);
  });

  it('returns only a configured operator status URL for passthrough trigger results', async () => {
    const configured = createTestEnv();
    await configureAppKeys(configured.env);
    (configured.env as any).DISPATCH_STATUS_BASE_URL = 'https://operator.example.net/gateway/review-yeti/';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = configured.fetchFn;
    try {
      const result = await triggerReviewTool.execute({ owner: OWNER, repo: REPO, prNumber: 42 }, { env: configured.env } as any);
      const payload = result.content?.find((item: any) => item.text?.startsWith('{'));
      assert.ok(payload);
      const output = JSON.parse((payload as any).text);
      assert.equal(output.status, 'succeeded');
      assert.equal(output.trackingUrl,
        `https://operator.example.net/gateway/review-yeti/api/dispatch/runs/${output.runId}/status`);
      assert.equal(output.trackingUrl.includes('example.workers.dev'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const unconfigured = createTestEnv();
    await configureAppKeys(unconfigured.env);
    globalThis.fetch = unconfigured.fetchFn;
    try {
      const result = await triggerReviewTool.execute({ owner: OWNER, repo: REPO, prNumber: 42 }, { env: unconfigured.env } as any);
      const payload = result.content?.find((item: any) => item.text?.startsWith('{'));
      assert.ok(payload);
      const output = JSON.parse((payload as any).text);
      assert.equal(output.status, 'succeeded');
      assert.equal(output.trackingUrl, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns unavailable when the 15-second authority/publication budget expires', async () => {
    const mock = createTestEnv({ hangOnFirstAuthorityRead: true });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
      timeoutMs: 10,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.mergeEligible, false);
  });

  it('keeps a cancellation observed during publication merge-ineligible', async () => {
    const mock = createTestEnv({ cancelOnFirstPatch: true });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.mergeEligible, false);
  });

  it('keeps the paired publication merge-ineligible when its workflow run is cancelled', async () => {
    const mock = createTestEnv({ cancelOnFirstPatch: true });
    await configureAppKeys(mock.env);
    const sourceRunId = 'run_workflow_source_123';
    const source = (mock.env as any).REVIEW_RUN.get(sourceRunId);
    await source.fetch('http://do/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: sourceRunId, owner: OWNER, repo: REPO, prNumber: 42,
        headSha: HEAD_A, baseSha: BASE_A, installationId: 0,
      }),
    });
    const receipt = await publishOperatorPassthrough(mock.env, {
      runId: sourceRunId, owner: OWNER, repo: REPO, prNumber: 42,
      headSha: HEAD_A, baseSha: BASE_A, installationId: 0,
    }, { fetchFn: mock.fetchFn });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.mergeEligible, false);
    assert.ok(receipt.errorCode === 'cancel_requested' || receipt.errorCode === 'durable_state_unavailable');
  });

  it('fails closed when the durable success receipt cannot be read back', async () => {
    const mock = createTestEnv({ failSuccessReadback: true });
    await configureAppKeys(mock.env);
    const receipt = await publishOperatorPassthroughForTarget(mock.env, { owner: OWNER, repo: REPO, prNumber: 42 }, {
      fetchFn: mock.fetchFn,
    });
    assert.equal(receipt.status, 'unavailable');
    assert.equal(receipt.errorCode, 'audit_unavailable');
    assert.equal(receipt.mergeEligible, false);
  });
});
