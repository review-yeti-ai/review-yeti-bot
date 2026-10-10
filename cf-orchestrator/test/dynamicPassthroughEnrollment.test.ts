import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../src/types.js';
import { inMemoryStore, updateRepositoryInDb } from '../src/storage/d1Client.js';
import {
  resolveRepositoryIdentities,
  publishOperatorPassthroughForTarget,
  readOperatorPassthroughForTarget,
} from '../src/operatorPassthroughPublisher.js';
import { RepoGateDO } from '../src/repoGateDO.js';
import { ReviewRunDO } from '../src/reviewRunDO.js';
import { MockDurableObjectState } from './mockDurableObject.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

async function createPassthroughTestEnv(target: { owner: string; repo: string; repositoryId: number; prNumber: number; headSha: string; baseSha: string }) {
  const testKey = await createPrivateKey();
  const checks = new Map<number, any>();
  const publications = new Map<string, ReviewRunDO>();
  const repoGates = new Map<string, RepoGateDO>();
  let nextCheckId = 8000;

  const env = {
    ENVIRONMENT: 'test',
    PARALLEL_MODE: 'false',
    PARALLEL_CHECK_NAME: 'Review Yeti',
    PILOT_REPOSITORIES: 'all',
    DEFAULT_WORKER_IMAGE: 'test',
    OPERATOR_GLOBAL_PASSTHROUGH: 'true',
    OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES: JSON.stringify([
      { repositoryId: 1131452104, owner: 'calltelemetry', repo: 'ai-workspace' },
      { repositoryId: 1326169548, owner: 'review-yeti-ai', repo: 'review-yeti-bot' },
    ]),
    OPERATOR_PASSTHROUGH_POLICY_SOURCE: JSON.stringify({
      repositoryId: 1339040553,
      owner: 'calltelemetry',
      repo: 'ct-review-actions',
      ref: 'main',
      path: 'policy/review-yeti.json',
    }),
    GITHUB_APP_ID: '4385771',
    GITHUB_APP_PRIVATE_KEY: testKey,
    REVIEW_YETI_PUBLIC_TARGET_APP_ID: '4552718',
    REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY: testKey,
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
        fetch: async (url: string, init?: RequestInit) => instance!.fetch(new Request(url, init)),
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

  const fetchFn: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = String(init.method || (typeof input === 'object' && !(input instanceof URL) ? input.method : 'GET')).toUpperCase();
    const path = url.pathname;

    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/installation`) {
      return jsonResponse({ id: 11 });
    }
    if (method === 'GET' && path === '/repos/calltelemetry/ct-review-actions/installation') {
      return jsonResponse({ id: 22 });
    }
    if (method === 'POST' && (path === '/app/installations/11/access_tokens' || path === '/app/installations/22/access_tokens')) {
      return jsonResponse({ token: path.includes('/11/') ? 'ghs_target_scoped' : 'ghs_policy_scoped' });
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}`) {
      return jsonResponse({
        id: target.repositoryId,
        full_name: `${target.owner}/${target.repo}`,
        name: target.repo,
        private: false,
        default_branch: 'main',
        owner: { login: target.owner },
      });
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}/reviews`) {
      return jsonResponse([]);
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/commits/${target.headSha}/check-runs`) {
      const currentChecks = [...checks.values()].filter((check) => check.head_sha === target.headSha);
      return jsonResponse({ total_count: currentChecks.length, check_runs: currentChecks });
    }
    if (method === 'GET' && path === `/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`) {
      return jsonResponse({
        number: target.prNumber,
        state: 'open',
        draft: false,
        base: { repo: { id: target.repositoryId }, sha: target.baseSha, ref: 'main' },
        head: { sha: target.headSha },
      });
    }
    if (method === 'GET' && path === '/repos/calltelemetry/ct-review-actions') {
      return jsonResponse({
        id: 1339040553,
        full_name: 'calltelemetry/ct-review-actions',
        default_branch: 'main',
      });
    }
    if (method === 'GET' && path === '/repos/calltelemetry/ct-review-actions/commits/main') {
      return jsonResponse({ sha: '1111111111111111111111111111111111111111' });
    }
    if (method === 'GET' && path === '/repos/calltelemetry/ct-review-actions/contents/policy/review-yeti.json') {
      const policyContent = JSON.stringify({
        schema: 'calltelemetry.review-policy.v1',
        review_yeti: {
          personas: 'architecture,security',
          profile: 'assertive',
          budget: { max_investigation_turns: 20 },
        },
      });
      return jsonResponse({
        path: 'policy/review-yeti.json',
        encoding: 'base64',
        content: Buffer.from(policyContent, 'utf8').toString('base64'),
      });
    }
    if (method === 'POST' && path === `/repos/${target.owner}/${target.repo}/check-runs`) {
      const payload = JSON.parse(String(init.body || '{}'));
      nextCheckId += 1;
      const checkRecord = {
        id: nextCheckId,
        app: { id: 4385771 },
        name: payload.name,
        head_sha: payload.head_sha,
        external_id: payload.external_id,
        status: payload.status,
        conclusion: null,
        output: {
          title: payload.output?.title,
          summary: payload.output?.summary,
          annotations_count: 0,
        },
      };
      checks.set(nextCheckId, checkRecord);
      return jsonResponse(checkRecord, 201);
    }
    const checkById = path.match(new RegExp(`^/repos/${target.owner}/${target.repo}/check-runs/(\\d+)$`));
    if (checkById) {
      const id = Number(checkById[1]);
      const current = checks.get(id);
      if (!current) return jsonResponse({ message: 'Not found' }, 404);
      if (method === 'PATCH') {
        const payload = JSON.parse(String(init.body || '{}'));
        Object.assign(current, {
          status: payload.status || current.status,
          conclusion: payload.conclusion || current.conclusion,
          output: {
            title: payload.output?.title ?? current.output?.title,
            summary: payload.output?.summary ?? current.output?.summary,
            annotations_count: 0,
          },
        });
        return jsonResponse(current);
      }
      return jsonResponse(current);
    }

    return jsonResponse({ message: `Unhandled test route: ${method} ${path}` }, 404);
  };

  return { env, fetchFn };
}

describe('Dynamic Passthrough Enrollment Engine', () => {
  it('resolves both static identities and dynamically enrolled repositories', async () => {
    const env = {
      OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES: JSON.stringify([
        { repositoryId: 1131452104, owner: 'calltelemetry', repo: 'ai-workspace' },
      ]),
    } as unknown as Env;

    // Enroll ct-infrastructure dynamically into inMemoryStore
    inMemoryStore.saveRepository({
      id: 'calltelemetry/ct-infrastructure',
      owner: 'calltelemetry',
      repo: 'ct-infrastructure',
      repositoryId: 1355159090,
      defaultBranch: 'main',
      automationEnabled: true,
      passthroughEnabled: true,
      generateFlowchart: true,
      customProfile: 'assertive',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const identities = await resolveRepositoryIdentities(env);
    const names = identities.map((i) => `${i.owner}/${i.repo}`).sort();
    assert.ok(names.includes('calltelemetry/ai-workspace'));
    assert.ok(names.includes('calltelemetry/ct-infrastructure'));
  });

  it('excludes repositories from passthrough when passthrough_enabled is false', async () => {
    const env = {
      OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES: JSON.stringify([
        { repositoryId: 1131452104, owner: 'calltelemetry', repo: 'ai-workspace' },
      ]),
    } as unknown as Env;

    inMemoryStore.saveRepository({
      id: 'calltelemetry/ct-disabled-passthrough',
      owner: 'calltelemetry',
      repo: 'ct-disabled-passthrough',
      repositoryId: 99999999,
      defaultBranch: 'main',
      automationEnabled: true,
      passthroughEnabled: false,
      generateFlowchart: true,
      customProfile: 'assertive',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const identities = await resolveRepositoryIdentities(env);
    const names = identities.map((i) => `${i.owner}/${i.repo}`);
    assert.ok(!names.includes('calltelemetry/ct-disabled-passthrough'));
  });

  it('rejects ct-uat before enrollment, and successfully publishes SHIP checks after dynamic onboarding', async () => {
    const ctUatTarget = {
      owner: 'calltelemetry',
      repo: 'ct-uat',
      repositoryId: 1399887766,
      prNumber: 1675,
      headSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      baseSha: '0000000000000000000000000000000000000000',
    };

    const { env, fetchFn } = await createPassthroughTestEnv(ctUatTarget);

    // 1. Before enrollment: ct-uat is rejected with repository_not_enrolled
    const beforeResult = await publishOperatorPassthroughForTarget(env, {
      owner: ctUatTarget.owner,
      repo: ctUatTarget.repo,
      prNumber: ctUatTarget.prNumber,
    }, { fetchFn });

    assert.equal(beforeResult.status, 'unavailable');
    assert.equal(beforeResult.errorCode, 'repository_not_enrolled');
    assert.equal(beforeResult.mergeEligible, false);

    // 2. Onboard ct-uat dynamically via storage layer (mimicking POST /api/settings/repos)
    await updateRepositoryInDb(env.DB, 'calltelemetry', 'ct-uat', {
      repositoryId: ctUatTarget.repositoryId,
      passthroughEnabled: true,
      automationEnabled: true,
    });

    // 3. After enrollment: publication succeeds completely!
    const afterResult = await publishOperatorPassthroughForTarget(env, {
      owner: ctUatTarget.owner,
      repo: ctUatTarget.repo,
      prNumber: ctUatTarget.prNumber,
    }, { fetchFn });

    assert.equal(afterResult.status, 'succeeded');
    assert.equal(afterResult.verdict, 'SHIP');
    assert.equal(afterResult.mergeEligible, true);
    assert.equal(afterResult.publicationState, 'published');
    assert.ok(afterResult.workerCheckId);
    assert.ok(afterResult.gateCheckId);
    assert.equal(afterResult.owner, 'calltelemetry');
    assert.equal(afterResult.repo, 'ct-uat');
    assert.equal(afterResult.prNumber, 1675);

    // 4. Verify readback also succeeds
    const readResult = await readOperatorPassthroughForTarget(env, {
      owner: ctUatTarget.owner,
      repo: ctUatTarget.repo,
      prNumber: ctUatTarget.prNumber,
    }, undefined, { fetchFn });

    assert.equal(readResult.status, 'succeeded');
    assert.equal(readResult.mergeEligible, true);
    assert.equal(readResult.workerCheckId, afterResult.workerCheckId);
    assert.equal(readResult.gateCheckId, afterResult.gateCheckId);
  });
});
