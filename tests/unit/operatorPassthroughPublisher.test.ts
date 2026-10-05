import { describe, expect, it, vi } from 'vitest';
import { GitHubReviewGateClient, type GitHubReviewGateClient as ReviewGateClient } from '../../src/github/reviewGateClient';
import {
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
  deriveReviewCheckExternalId,
  type ReviewGateCheck,
} from '../../src/review/reviewCheckIdentity';
import {
  operatorPassthroughIdentityForCandidate,
  type OperatorPassthroughPublicationClaim,
  type OperatorPassthroughPublicationRepository,
} from '../../src/review/operatorPassthrough';
import { OperatorPassthroughPublisher } from '../../src/review/operatorPassthroughPublisher';
import { evaluateReviewGate } from '../../src/review/reviewGatePolicy';

const APP_ID = 4_385_771;
const TOKEN = 'ghs_operator_passthrough_test_token';
const candidate = {
  owner: 'exampleorg',
  repo: 'review-yeti-bot',
  repositoryId: 3210,
  prNumber: 42,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  policyDigest: 'c'.repeat(64),
};

function claim(overrides: Partial<OperatorPassthroughPublicationClaim> = {}): OperatorPassthroughPublicationClaim {
  const identity = operatorPassthroughIdentityForCandidate(candidate, APP_ID, 7);
  return {
    ...identity,
    publicationSequence: 7,
    expectedAppId: APP_ID,
    reviewCheckId: null,
    reviewCreationState: 'creating',
    gateCheckId: null,
    gateCreationState: 'creating',
    retirementRequestedAt: null,
    retirementReason: null,
    retiredAt: null,
    leaseOwner: 'operator-publisher-test',
    leaseToken: 'lease-token',
    stage: 'review',
    mayCreate: true,
    retiring: false,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function checkNameFor(stage: OperatorPassthroughPublicationClaim['stage']) {
  return stage === 'review' ? REVIEW_WORKER_CHECK_NAME : REVIEW_GATE_CHECK_NAME;
}

function apiForPublication(
  publication: OperatorPassthroughPublicationClaim,
  options: { failPost?: boolean; failPatch?: boolean; responseAppId?: number;
    existingChecks?: Record<string, unknown>[] } = {},
) {
  const name = checkNameFor(publication.stage);
  const id = publication.stage === 'review'
    ? publication.reviewCheckId ?? 7_901
    : publication.gateCheckId ?? 7_902;
  let currentCheck: Record<string, unknown> = {
    id,
    name,
    app: { id: options.responseAppId ?? publication.expectedAppId },
    head_sha: publication.coordinates.headSha,
    external_id: deriveReviewCheckExternalId(publication.coordinates, name),
    status: 'in_progress',
    conclusion: null,
  };
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname.endsWith(`/commits/${publication.coordinates.headSha}/check-runs`)) {
      const existingChecks = options.existingChecks ?? [];
      return response({ total_count: existingChecks.length, check_runs: existingChecks });
    }
    if (method === 'POST' && url.pathname.endsWith('/check-runs')) {
      if (options.failPost) throw new Error(`connection ended after POST: ${TOKEN}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      currentCheck = {
        ...currentCheck,
        name: body.name,
        head_sha: body.head_sha,
        external_id: body.external_id,
        status: body.status,
      };
      return response(currentCheck, 201);
    }
    if (url.pathname.endsWith(`/check-runs/${id}`) && method === 'GET') return response(currentCheck);
    if (url.pathname.endsWith(`/check-runs/${id}`) && method === 'PATCH') {
      if (options.failPatch) throw new Error(`connection ended after PATCH: ${TOKEN}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      currentCheck = { ...currentCheck, status: body.status, conclusion: body.conclusion };
      return response(currentCheck);
    }
    throw new Error(`unexpected GitHub request ${method} ${url.pathname}`);
  });
  const client = new GitHubReviewGateClient({
    token: TOKEN,
    expectedAppId: publication.expectedAppId,
    checkName: name,
    baseUrl: 'https://github.test/api/v3',
    fetchImplementation,
    timeoutMs: 1_000,
    reconcileTimeoutMs: 1_000,
  });
  return { client, fetchImplementation };
}

type Publish = Parameters<OperatorPassthroughPublicationRepository['publishLocked']>[1];
type PublishResult = Awaited<ReturnType<Publish>>;

function repositoryFor(claims: OperatorPassthroughPublicationClaim[]) {
  const queue = [...claims];
  const callbackResults: PublishResult[] = [];
  const claimPublication = vi.fn(async () => queue.shift() ?? null);
  const publishLocked = vi.fn(async (current: OperatorPassthroughPublicationClaim, publish: Publish) => {
    const result = await publish(current);
    callbackResults.push(result);
    return 'kind' in result ? 'retry' as const : 'published' as const;
  });
  const retryPublication = vi.fn(async () => true);
  const repository = { claimPublication, publishLocked, retryPublication } as unknown as OperatorPassthroughPublicationRepository;
  return { repository, claimPublication, publishLocked, retryPublication, callbackResults };
}

function publisherFor(
  repository: OperatorPassthroughPublicationRepository,
  clientFor: (claim: OperatorPassthroughPublicationClaim) => Promise<Pick<ReviewGateClient,
    'createOperatorPending' | 'reconcileOperator' | 'updateOperatorExisting'>>,
  options: {
    candidateIsCurrent?: (claim: OperatorPassthroughPublicationClaim) => Promise<boolean>;
  } = {},
) {
  return new OperatorPassthroughPublisher({
    repository,
    clientFor,
    workerId: 'unit-operator-publisher',
    now: () => 1_800_000_000_000,
    retryDelayMs: 5_000,
    ...options,
  });
}

describe('OperatorPassthroughPublisher', () => {
  it('keeps normal failure evidence intact while the separate durable pause publisher emits SHIP', async () => {
    const failedReview = {
      verdict: 'BLOCK' as const,
      completedAt: '2026-10-05T00:00:00.000Z',
      coverageComplete: false,
      quorumSatisfied: false,
      infrastructureFailure: true,
      p0Count: 1,
      p1Count: 2,
      p2Count: 3,
      expectedLanes: 6,
      completedLanes: 0,
    };

    expect(evaluateReviewGate({
      candidate: { repositoryId: candidate.repositoryId, prNumber: candidate.prNumber,
        headSha: candidate.headSha, baseSha: candidate.baseSha, policyDigest: candidate.policyDigest },
      current: { repositoryId: candidate.repositoryId, prNumber: candidate.prNumber,
        headSha: candidate.headSha, baseSha: candidate.baseSha, policyDigest: candidate.policyDigest,
        open: true, draft: false },
      evidence: failedReview,
      passthrough: true,
    } as any)).toMatchObject({ status: 'failure', eligible: false, reason: 'infrastructure-failure' });

    const publication = claim();
    const repository = repositoryFor([publication]);
    const api = apiForPublication(publication);
    const operatorPublisher = publisherFor(repository.repository, async () => api.client, {
      candidateIsCurrent: async () => true,
    });
    await expect(operatorPublisher.runOnce()).resolves.toMatchObject({ status: 'published' });
    const terminalPatch = api.fetchImplementation.mock.calls.find(([, init]) => {
      if (init?.method !== 'PATCH') return false;
      return (JSON.parse(String(init.body)) as Record<string, unknown>).conclusion === 'success';
    });
    expect(terminalPatch).toBeDefined();
    expect(String(terminalPatch?.[1]?.body)).toContain('passthrough: no review performed');
  });

  it.each([
    ['review', REVIEW_WORKER_CHECK_NAME, 'Review Yeti: SHIP (passthrough: no review performed)'],
    ['gate', REVIEW_GATE_CHECK_NAME, 'Review Yeti Gate: SHIP (operator passthrough SHIP)'],
  ] as const)('publishes the exact %s required check identity and terminal SHIP output', async (stage, expectedName, expectedTitle) => {
    const publication = claim({ stage });
    const f = repositoryFor([publication]);
    const api = apiForPublication(publication);
    const clientFor = vi.fn(async (current: OperatorPassthroughPublicationClaim) => {
      expect(current).toEqual(publication);
      return api.client;
    });
    const publisher = publisherFor(f.repository, clientFor);

    const result = await publisher.runOnce(publication.publicationId);
    expect(result).toEqual({
      status: 'published', publicationId: publication.publicationId,
    });

    const requests = api.fetchImplementation.mock.calls.map(([input, init]) => ({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
    }));
    const lookup = requests.find((request) => request.method === 'GET');
    expect(lookup?.url.pathname).toBe(`/api/v3/repos/${candidate.owner}/${candidate.repo}/commits/${candidate.headSha}/check-runs`);
    expect(lookup?.url.searchParams.get('check_name')).toBe(expectedName);

    const create = requests.find((request) => request.method === 'POST');
    expect(create?.url.pathname).toBe(`/api/v3/repos/${candidate.owner}/${candidate.repo}/check-runs`);
    expect(create?.body).toMatchObject({
      name: expectedName,
      head_sha: candidate.headSha,
      external_id: stage === 'review' ? publication.reviewExternalId : publication.gateExternalId,
      status: 'in_progress',
    });

    const update = requests.find((request) => request.method === 'PATCH');
    expect(update?.body).toMatchObject({
      status: 'completed',
      conclusion: 'success',
      output: {
        title: expectedTitle,
        summary: expect.stringContaining('review-mode=passthrough'),
      },
    });
    const summary = String((update?.body?.output as { summary?: unknown } | undefined)?.summary);
    expect(summary).toContain('Zero review lanes ran.');
    expect(summary).toContain(`${candidate.owner}/${candidate.repo}#${candidate.prNumber} at ${candidate.headSha}`);
    expect(summary).toContain(`base ${candidate.baseSha}; policy ${candidate.policyDigest}`);
    expect(clientFor).toHaveBeenCalledOnce();
    expect(api.fetchImplementation).toHaveBeenCalledTimes(4);
    expect(f.callbackResults.at(-1)).toMatchObject({
      id: stage === 'review' ? 7_901 : 7_902,
      name: expectedName,
      appId: APP_ID,
      headSha: candidate.headSha,
      externalId: stage === 'review' ? publication.reviewExternalId : publication.gateExternalId,
      status: 'completed',
      conclusion: 'success',
    });
  });

  it('publishes a distinct operator pair without adopting or overwriting existing ordinary Review Yeti evidence', async () => {
    const publication = claim({ stage: 'review' });
    const ordinaryCheck = {
      id: 7_800,
      name: REVIEW_WORKER_CHECK_NAME,
      app: { id: APP_ID },
      head_sha: candidate.headSha,
      external_id: `run_${'d'.repeat(32)}:a1`,
      status: 'completed',
      conclusion: 'failure',
    };
    const f = repositoryFor([publication]);
    const api = apiForPublication(publication, { existingChecks: [ordinaryCheck] });
    const publisher = publisherFor(f.repository, async () => api.client);

    await expect(publisher.runOnce(publication.publicationId)).resolves.toMatchObject({ status: 'published' });
    const requests = api.fetchImplementation.mock.calls.map(([input, init]) => ({
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
    }));
    const create = requests.find((request) => request.method === 'POST');
    expect(create?.body).toMatchObject({
      name: REVIEW_WORKER_CHECK_NAME,
      head_sha: candidate.headSha,
      external_id: publication.reviewExternalId,
      status: 'in_progress',
    });
    expect(publication.reviewExternalId).not.toBe(ordinaryCheck.external_id);
    expect(requests.some((request) => request.url.pathname.endsWith(`/check-runs/${ordinaryCheck.id}`)
      && request.method === 'PATCH')).toBe(false);
    expect(f.callbackResults.at(-1)).toMatchObject({
      id: 7_901,
      appId: APP_ID,
      headSha: candidate.headSha,
      externalId: publication.reviewExternalId,
      status: 'completed',
      conclusion: 'success',
    });
  });

  it('keeps an uncertain create reconcile-only on retry instead of issuing a second POST', async () => {
    const first = claim({ stage: 'review', mayCreate: true });
    const retry = { ...first, mayCreate: false };
    const f = repositoryFor([first, retry]);
    const api = apiForPublication(first, { failPost: true });
    const clientFor = vi.fn(async () => api.client);
    const publisher = publisherFor(f.repository, clientFor);

    const firstResult = await publisher.runOnce(first.publicationId);
    const secondResult = await publisher.runOnce(first.publicationId);
    expect(firstResult).toMatchObject({ status: 'retry' });
    expect(secondResult).toMatchObject({ status: 'retry' });

    const methods = api.fetchImplementation.mock.calls.map(([, init]) => init?.method ?? 'GET');
    expect(methods.filter((method) => method === 'POST')).toHaveLength(1);
    expect(methods.filter((method) => method === 'GET')).toHaveLength(2);
    expect(methods.filter((method) => method === 'PATCH')).toHaveLength(0);
    expect(clientFor).toHaveBeenCalledTimes(2);
    expect(f.retryPublication).toHaveBeenCalledOnce();
    expect(JSON.stringify([firstResult, secondResult])).not.toContain(TOKEN);
  });

  it('stops before client preparation or GitHub calls when the candidate has changed', async () => {
    const publication = claim();
    const f = repositoryFor([publication]);
    const clientFor = vi.fn(async () => { throw new Error('must not prepare a client'); });
    const candidateIsCurrent = vi.fn(async () => false);
    const publisher = publisherFor(f.repository, clientFor, { candidateIsCurrent });

    await expect(publisher.runOnce(publication.publicationId)).resolves.toMatchObject({ status: 'retry' });

    expect(candidateIsCurrent).toHaveBeenCalledWith(publication);
    expect(clientFor).not.toHaveBeenCalled();
    expect(f.callbackResults).toEqual([{ kind: 'retire-required', reason: 'candidate-changed', retryDelayMs: 5_000 }]);
  });

  it('retires an existing check when pause is disabled without evaluating it as a current paused candidate', async () => {
    const publication = claim({
      stage: 'review',
      reviewCheckId: 8_001,
      reviewCreationState: 'bound',
      retirementRequestedAt: 1_700_000_000_000,
      retirementReason: 'pause-disabled',
      retiring: true,
      mayCreate: false,
    });
    const f = repositoryFor([publication]);
    const candidateIsCurrent = vi.fn(async () => false);
    const check = {
      id: 8_001,
      name: REVIEW_WORKER_CHECK_NAME,
      appId: APP_ID,
      headSha: publication.coordinates.headSha,
      externalId: publication.reviewExternalId,
      status: 'completed',
      conclusion: 'failure',
    } satisfies ReviewGateCheck;
    const client = {
      reconcileOperator: vi.fn(async () => null),
      createOperatorPending: vi.fn(async () => check),
      updateOperatorExisting: vi.fn(async () => check),
    };
    const clientFor = vi.fn(async () => client);
    const publisher = publisherFor(f.repository, clientFor, { candidateIsCurrent });

    await expect(publisher.runOnce(publication.publicationId)).resolves.toMatchObject({ status: 'published' });

    expect(candidateIsCurrent).not.toHaveBeenCalled();
    expect(client.reconcileOperator).not.toHaveBeenCalled();
    expect(client.createOperatorPending).not.toHaveBeenCalled();
    expect(client.updateOperatorExisting).toHaveBeenCalledWith(expect.objectContaining({
      coordinates: publication.coordinates,
      checkId: 8_001,
      update: {
        conclusion: 'failure',
        title: 'Review Yeti: NO VERDICT (operator passthrough retired)',
        summary: expect.stringContaining('A normal review is required.'),
      },
    }));
  });

  it('records a known client-preparation failure as not-started and exposes no credential detail', async () => {
    const publication = claim({ mayCreate: true });
    const f = repositoryFor([publication]);
    const clientFor = vi.fn(async () => { throw new Error(`token preparation failed: ${TOKEN}`); });
    const publisher = publisherFor(f.repository, clientFor);

    const result = await publisher.runOnce(publication.publicationId);

    expect(result).toMatchObject({ status: 'retry' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(f.callbackResults).toEqual([{ kind: 'not-started', retryDelayMs: 5_000 }]);
    expect(f.retryPublication).not.toHaveBeenCalled();
  });

  it('retries a failed terminal update without exposing transport diagnostics', async () => {
    const publication = claim({
      stage: 'gate',
      gateCheckId: 8_002,
      gateCreationState: 'bound',
      mayCreate: false,
    });
    const f = repositoryFor([publication]);
    const api = apiForPublication(publication, { failPatch: true });
    const clientFor = vi.fn(async () => api.client);
    const publisher = publisherFor(f.repository, clientFor);

    const result = await publisher.runOnce(publication.publicationId);

    expect(result).toEqual({ status: 'retry', publicationId: publication.publicationId });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(api.fetchImplementation.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PATCH']);
    expect(f.retryPublication).toHaveBeenCalledWith(publication, 1_800_000_000_000, 5_000);
  });
});
