import { describe, expect, it, vi } from 'vitest';
import { AUTHORITATIVE_REVIEW_APP_ID } from '../../src/auth/authoritativeServiceConfig';
import { createMergeGroupGate, MergeGroupGateInProgressError } from '../../src/review/mergeGroupGate';
import type { MergeGroupGatePriorPublication } from '../../src/persistence/mergeGroupGateRepository';
import { canonicalJson, sha256 } from '../../src/review/reviewCore';
import {
  deriveOperatorPassthroughExternalId,
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
} from '../../src/review/reviewCheckIdentity';

const GROUP_HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PR_HEAD = 'c'.repeat(40);
const CURRENT_OPERATOR_PUBLICATION_ID = 'a'.repeat(64);
const CURRENT_OPERATOR_AUDIT_DIGEST = 'b'.repeat(64);
const OLD_OPERATOR_PUBLICATION_ID = 'e'.repeat(64);
const OLD_OPERATOR_AUDIT_DIGEST = 'f'.repeat(64);
const LEGACY_MAINTENANCE_DIGEST = 'd'.repeat(64);
const legacyMaintenanceReviewId = `review-yeti-maintenance:v1:${LEGACY_MAINTENANCE_DIGEST}:raw`;
const legacyMaintenanceGateId = `review-yeti-maintenance:v1:${LEGACY_MAINTENANCE_DIGEST}:gate`;
const currentOperatorReviewId = deriveOperatorPassthroughExternalId(
  CURRENT_OPERATOR_PUBLICATION_ID, CURRENT_OPERATOR_AUDIT_DIGEST, REVIEW_WORKER_CHECK_NAME);
const currentOperatorGateId = deriveOperatorPassthroughExternalId(
  CURRENT_OPERATOR_PUBLICATION_ID, CURRENT_OPERATOR_AUDIT_DIGEST, REVIEW_GATE_CHECK_NAME);
const currentOperatorReceipt = { publicationId: CURRENT_OPERATOR_PUBLICATION_ID,
  auditDigest: CURRENT_OPERATOR_AUDIT_DIGEST, mergeEligible: true };
const oldOperatorReviewId = deriveOperatorPassthroughExternalId(
  OLD_OPERATOR_PUBLICATION_ID, OLD_OPERATOR_AUDIT_DIGEST, REVIEW_WORKER_CHECK_NAME);
const oldOperatorGateId = deriveOperatorPassthroughExternalId(
  OLD_OPERATOR_PUBLICATION_ID, OLD_OPERATOR_AUDIT_DIGEST, REVIEW_GATE_CHECK_NAME);
const config = {
  secret: 'x'.repeat(64), admissionEnabled: true,
  repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']),
};
const officialApp = { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' };

function payload() {
  return {
    action: 'checks_requested', installation: { id: 123 },
    repository: {
      id: 614653796, name: 'dashboard', full_name: 'exampleorg/dashboard',
      owner: { id: 57884877, login: 'exampleorg' },
    },
    merge_group: {
      head_sha: GROUP_HEAD, base_sha: BASE,
      head_ref: 'refs/heads/gh-readonly-queue/main/pr-42-abcdef0',
      base_ref: 'refs/heads/main',
    },
  };
}

function queue(head = PR_HEAD, trailingEntries: any[] = []) {
  const nodes = [{
    position: 1, state: 'AWAITING_CHECKS', baseCommit: { oid: BASE }, headCommit: { oid: GROUP_HEAD },
    pullRequest: {
      number: 42, state: 'OPEN', baseRefName: 'main', headRefOid: head,
      repository: { nameWithOwner: 'exampleorg/dashboard' },
    },
  }, ...trailingEntries];
  return { data: { repository: { mergeQueue: {
    id: 'MQ_1', entries: { totalCount: nodes.length, nodes, pageInfo: { hasNextPage: false } },
  } } } };
}

function queueSnapshotDigest(passthrough = false, value: any = queue()): string {
  const identity = payload();
  const mergeGroup = identity.merge_group;
  const queueData = value.data.repository.mergeQueue;
  const allEntries = [...queueData.entries.nodes].sort((left, right) => left.position - right.position);
  return sha256(canonicalJson({
    version: 'ReviewYetiMergeQueueSnapshot.v1',
    repositoryId: identity.repository.id,
    repository: identity.repository.full_name,
    owner: identity.repository.owner.login,
    repo: identity.repository.name,
    queueId: queueData.id,
    branch: 'main',
    headRef: mergeGroup.head_ref,
    baseRef: mergeGroup.base_ref,
    groupHeadSha: mergeGroup.head_sha,
    groupBaseSha: mergeGroup.base_sha,
    currentPullRequest: 42,
    entries: allEntries.map((entry: any) => ({
      position: entry.position,
      state: entry.state,
      baseCommitSha: entry.baseCommit.oid,
      headCommitSha: entry.headCommit.oid,
      pullRequest: {
        number: entry.pullRequest.number,
        state: entry.pullRequest.state,
        baseRefName: entry.pullRequest.baseRefName,
        headRefOid: entry.pullRequest.headRefOid,
        repository: entry.pullRequest.repository.nameWithOwner,
      },
    })),
    operatorPassthroughEnabled: passthrough,
  }));
}

function stableGroupId(passthrough = false, value: any = queue()): string {
  return `review-yeti-merge-group:v2:614653796:${GROUP_HEAD}:${queueSnapshotDigest(passthrough, value)}`;
}

function groupCheckResponse(id: number, init: RequestInit | undefined, passthrough = false, value: any = queue()) {
  const requestBody = init?.body ? JSON.parse(String(init.body)) : {};
  return response({ id, name: 'Review Yeti', head_sha: GROUP_HEAD, external_id: stableGroupId(passthrough, value), conclusion: null,
    app: officialApp, ...requestBody });
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function repository() {
  return {
    claim: vi.fn(async () => ({ status: 'acquired' as const })),
    reserveCheckCreation: vi.fn(async () => true),
    bindCheck: vi.fn(async () => undefined),
    listPriorPublications: vi.fn(async (): Promise<MergeGroupGatePriorPublication[]> => []),
    settlePriorPublication: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

describe('native merge-group Review Yeti gate', () => {
  it('publishes exactly one successful official App check after two stable exact-head queue reads', async () => {
    let graphqlReads = 0;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/commits/${GROUP_HEAD}/check-runs?filter=all&per_page=100`)) {
        return response({ total_count: 0, check_runs: [] });
      }
      if (url.endsWith('/check-runs') && init?.method === 'POST') {
        return groupCheckResponse(9001, init);
      }
      if (url === 'https://api.github.com/graphql') {
        graphqlReads += 1;
        return response(queue());
      }
      if (url.endsWith(`/commits/${PR_HEAD}/check-runs?filter=all&per_page=100`)) {
        return response({ total_count: 1, check_runs: [{
          id: 8001, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
        }] });
      }
      if (url.endsWith('/check-runs/9001') && init?.method === 'PATCH') return groupCheckResponse(9001, init);
      return response({ error: 'unexpected request' }, 500);
    }) as typeof fetch;
    const store = repository();
    const gate = createMergeGroupGate({
      config, repository: store as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).resolves.toEqual({ checkId: 9001, conclusion: 'success',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    expect(graphqlReads).toBe(2);
    const creates = (fetchImplementation as any).mock.calls.filter(([, init]: [unknown, RequestInit]) => init?.method === 'POST'
      && String((init as RequestInit).body).includes(stableGroupId()));
    expect(creates).toHaveLength(1);
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9001') && init?.method === 'PATCH');
    expect(JSON.parse(String(completion[1].body))).toEqual(expect.objectContaining({ status: 'completed', conclusion: 'success' }));
  });

  it('qualifies only constituents at or ahead of the current queue entry', async () => {
    const behindHead = 'd'.repeat(40);
    const trailing = [{
      position: 2, state: 'AWAITING_CHECKS', baseCommit: { oid: BASE }, headCommit: { oid: 'e'.repeat(40) },
      pullRequest: { number: 43, state: 'OPEN', baseRefName: 'main', headRefOid: behindHead,
        repository: { nameWithOwner: 'exampleorg/dashboard' } },
    }];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9013, init, false, queue(PR_HEAD, trailing));
      if (url === 'https://api.github.com/graphql') return response(queue(PR_HEAD, trailing));
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8013, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success', app: officialApp,
      }] });
      if (url.endsWith('/check-runs/9013') && init?.method === 'PATCH') return groupCheckResponse(9013, init, false, queue(PR_HEAD, trailing));
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9013, conclusion: 'success',
      snapshotDigest: queueSnapshotDigest(false, queue(PR_HEAD, trailing)), constituents: 1 });
    expect((fetchImplementation as any).mock.calls.some(([url]: [unknown]) => String(url).includes(behindHead))).toBe(false);
  });

  it('rejects unavailable queue evidence before publishing a synthetic check', async () => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9002, init);
      if (url === 'https://api.github.com/graphql') return response({ error: 'unavailable' }, 503);
      if (url.endsWith('/check-runs/9002') && init?.method === 'PATCH') return groupCheckResponse(9002, init);
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).rejects.toThrow('GitHub JSON request failed with HTTP 503');
    expect((fetchImplementation as any).mock.calls.filter(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs') && init?.method === 'POST')).toHaveLength(0);
  });

  it.each([
    ['pending', PR_HEAD, 'in_progress', null, 'latest exact-head Review Yeti check is not successful', officialApp],
    ['failed', PR_HEAD, 'completed', 'failure', 'latest exact-head Review Yeti check is not successful', officialApp],
    ['stale', 'd'.repeat(40), 'completed', 'success', 'contains malformed or stale Review Yeti evidence', officialApp],
    ['foreign App', PR_HEAD, 'completed', 'success', 'has no Review Yeti check from the official App',
      { id: AUTHORITATIVE_REVIEW_APP_ID + 1, slug: 'ct-review-bot' }],
  ])('fails the synthetic check for %s constituent evidence',
    async (_label, observedHead, status, conclusion, reason, app) => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9004, init);
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8002, name: 'Review Yeti', head_sha: observedHead, status, conclusion,
        app,
      }] });
      if (url.endsWith('/check-runs/9004') && init?.method === 'PATCH') return groupCheckResponse(9004, init);
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).resolves.toEqual({ checkId: 9004, conclusion: 'failure',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9004') && init?.method === 'PATCH');
    expect(JSON.parse(String(completion[1].body)).output.summary).toContain(`PR #42: ${reason}`);
    });

  it.each([
    {
      label: 'previous operator-passthrough pair', reviewExternalId: oldOperatorReviewId,
      gateExternalId: oldOperatorGateId, title: 'Review Yeti: SHIP (passthrough: no review performed)',
      summary: 'review-mode=passthrough Zero review lanes ran.',
      reason: 'latest exact-head Review Yeti check is not the current operator-passthrough SHIP',
    },
    {
      label: 'deployed legacy maintenance pair', reviewExternalId: legacyMaintenanceReviewId,
      gateExternalId: legacyMaintenanceGateId, title: 'SHIP: operator passthrough; review bypassed',
      summary: 'review-mode=passthrough\nreview-completed=false\ndecision=SHIP',
      reason: 'legacy operator maintenance SHIP is not current merge-group evidence',
    },
  ])('does not accept a $label as normal review evidence when passthrough is disabled', async ({
    reviewExternalId, gateExternalId, title, summary, reason,
  }) => {
    const normalConfig = { ...config, passthroughEnabled: false };
    const runs = [
      { id: 8150, name: 'Review Yeti', head_sha: PR_HEAD, external_id: reviewExternalId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title, summary } },
      { id: 8151, name: 'Review Yeti Gate', head_sha: PR_HEAD, external_id: gateExternalId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title, summary } },
    ];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9050, init);
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: runs.length, check_runs: runs });
      if (url.endsWith('/check-runs/9050') && init?.method === 'PATCH') return groupCheckResponse(9050, init);
      return response({}, 500);
    }) as typeof fetch;
    const ensureOperatorPassthrough = vi.fn(async () => currentOperatorReceipt);
    const gate = createMergeGroupGate({ config: normalConfig, repository: repository() as any,
      tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation, ensureOperatorPassthrough });

    await expect(gate(payload())).resolves.toEqual({ checkId: 9050, conclusion: 'failure',
      snapshotDigest: queueSnapshotDigest(false), constituents: 1 });
    expect(ensureOperatorPassthrough).not.toHaveBeenCalled();
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9050') && init?.method === 'PATCH');
    expect(JSON.parse(String(completion[1].body)).output.summary)
      .toContain(reason);
  });

  it('does not treat successful deployed maintenance checks as a paused durable receipt', async () => {
    const pausedConfig = { ...config, passthroughEnabled: true };
    const legacyRuns = [
      { id: 8150, name: 'Review Yeti', head_sha: PR_HEAD, external_id: legacyMaintenanceReviewId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'SHIP: operator passthrough; review bypassed',
          summary: 'review-mode=passthrough\nreview-completed=false\ndecision=SHIP' } },
      { id: 8151, name: 'Review Yeti Gate', head_sha: PR_HEAD, external_id: legacyMaintenanceGateId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'SHIP: operator passthrough; review bypassed',
          summary: 'review-mode=passthrough\nreview-completed=false\ndecision=SHIP' } },
    ];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9051, init, true);
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({
        total_count: legacyRuns.length, check_runs: legacyRuns,
      });
      if (url.endsWith('/check-runs/9051') && init?.method === 'PATCH') return groupCheckResponse(9051, init, true);
      return response({}, 500);
    }) as typeof fetch;
    const ensureOperatorPassthrough = vi.fn(async () => null);
    const gate = createMergeGroupGate({ config: pausedConfig, repository: repository() as any,
      tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation, ensureOperatorPassthrough });

    await expect(gate(payload(), { deliveryId: 'legacy-without-current-receipt', deliveryDigest: 'd'.repeat(64) }))
      .resolves.toEqual({ checkId: 9051, conclusion: 'failure',
        snapshotDigest: queueSnapshotDigest(true), constituents: 1 });
    expect(ensureOperatorPassthrough).toHaveBeenCalledOnce();
    expect((fetchImplementation as any).mock.calls.some(([url]: [unknown]) =>
      String(url).includes(`/commits/${PR_HEAD}/check-runs`))).toBe(false);
  });

  it.each([
    ['paired latest operator SHIP', [
      { id: 8100, name: 'Review Yeti', head_sha: PR_HEAD, external_id: currentOperatorReviewId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'Review Yeti: SHIP (passthrough: no review performed)',
          summary: 'review-mode=passthrough Zero review lanes ran.' } },
      { id: 8101, name: 'Review Yeti Gate', head_sha: PR_HEAD, external_id: currentOperatorGateId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'Review Yeti Gate: SHIP (operator passthrough SHIP)',
          summary: 'review-mode=passthrough Zero review lanes ran.' } },
    ], 'success', undefined],
    ['higher-ID ordinary SHIP', [
      { id: 8100, name: 'Review Yeti', head_sha: PR_HEAD, external_id: currentOperatorReviewId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'Review Yeti: SHIP (passthrough: no review performed)',
          summary: 'review-mode=passthrough Zero review lanes ran.' } },
      { id: 8101, name: 'Review Yeti Gate', head_sha: PR_HEAD, external_id: currentOperatorGateId,
        status: 'completed', conclusion: 'success', app: officialApp,
          output: { title: 'Review Yeti Gate: SHIP (operator passthrough SHIP)',
          summary: 'review-mode=passthrough Zero review lanes ran.' } },
      { id: 8102, name: 'Review Yeti', head_sha: PR_HEAD, external_id: 'run_ordinary:a1',
        status: 'completed', conclusion: 'success', app: officialApp, output: { title: 'Review Yeti: SHIP', summary: 'Normal review.' } },
    ], 'failure', 'does not match the current durable operator SHIP publication'],
    ['same-head old publication after base or policy changes', [
      { id: 8150, name: 'Review Yeti', head_sha: PR_HEAD, external_id: oldOperatorReviewId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'Review Yeti: SHIP (passthrough: no review performed)',
          summary: 'review-mode=passthrough Zero review lanes ran.' } },
      { id: 8151, name: 'Review Yeti Gate', head_sha: PR_HEAD, external_id: oldOperatorGateId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'Review Yeti Gate: SHIP (operator passthrough SHIP)',
          summary: 'review-mode=passthrough Zero review lanes ran.' } },
    ], 'failure', 'does not match the current durable operator SHIP publication'],
    ['higher-ID ordinary Gate failure', [
      { id: 8200, name: 'Review Yeti', head_sha: PR_HEAD, external_id: currentOperatorReviewId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'Review Yeti: SHIP (passthrough: no review performed)',
          summary: 'review-mode=passthrough Zero review lanes ran.' } },
      { id: 8201, name: 'Review Yeti Gate', head_sha: PR_HEAD, external_id: currentOperatorGateId,
        status: 'completed', conclusion: 'success', app: officialApp,
        output: { title: 'Review Yeti Gate: SHIP (operator passthrough SHIP)',
          summary: 'review-mode=passthrough Zero review lanes ran.' } },
      { id: 8202, name: 'Review Yeti Gate', head_sha: PR_HEAD, external_id: 'run_ordinary:a1',
        status: 'completed', conclusion: 'failure', app: officialApp, output: { title: 'Review Yeti Gate: Failed', summary: 'Normal review.' } },
    ], 'failure', 'paired exact-head Review Yeti Gate passthrough check is not successful'],
  ])('requires an exact current operator paired verdict when paused: %s', async (_label, runs, expected, reason) => {
    const pausedConfig = { ...config, passthroughEnabled: true };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9030, init, true);
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: runs.length, check_runs: runs });
      if (url.endsWith('/check-runs/9030') && init?.method === 'PATCH') return groupCheckResponse(9030, init, true);
      return response({}, 500);
    }) as typeof fetch;
    const ensureOperatorPassthrough = vi.fn(async () => currentOperatorReceipt);
    const gate = createMergeGroupGate({ config: pausedConfig, repository: repository() as any,
      tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation, ensureOperatorPassthrough });
    await expect(gate(payload(), { deliveryId: 'delivery-1', deliveryDigest: 'a'.repeat(64) }))
      .resolves.toEqual({ checkId: 9030, conclusion: expected,
        snapshotDigest: queueSnapshotDigest(true), constituents: 1 });
    expect(ensureOperatorPassthrough).toHaveBeenCalledOnce();
    if (reason) {
      const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
        String(url).endsWith('/check-runs/9030') && init?.method === 'PATCH');
      expect(JSON.parse(String(completion[1].body)).output.summary).toContain(reason);
    }
  });

  it.each([
    ['missing durable receipt', null],
    ['pending durable receipt', { ...currentOperatorReceipt, mergeEligible: false }],
  ])('fails paused merge-group admission when the %s is unavailable', async (_label, operatorReceipt) => {
    const pausedConfig = { ...config, passthroughEnabled: true };
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9040, init, true);
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.endsWith('/check-runs/9040') && init?.method === 'PATCH') return groupCheckResponse(9040, init, true);
      return response({}, 500);
    }) as typeof fetch;
    const ensureOperatorPassthrough = vi.fn(async () => operatorReceipt);
    const gate = createMergeGroupGate({ config: pausedConfig, repository: repository() as any,
      tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation, ensureOperatorPassthrough });

    await expect(gate(payload(), { deliveryId: 'delivery-unready', deliveryDigest: 'c'.repeat(64) }))
      .resolves.toEqual({ checkId: 9040, conclusion: 'failure', snapshotDigest: queueSnapshotDigest(true), constituents: 1 });
    expect(ensureOperatorPassthrough).toHaveBeenCalledOnce();
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9040') && init?.method === 'PATCH');
    expect(JSON.parse(String(completion[1].body)).output.summary)
      .toContain('exact operator SHIP checks are not durably published');
  });

  it.each([
    ['later success', [
      { id: 10, status: 'completed', conclusion: 'failure' },
      { id: 11, status: 'completed', conclusion: 'success' },
    ], 'success'],
    ['later failure', [
      { id: 20, status: 'completed', conclusion: 'success' },
      { id: 21, status: 'completed', conclusion: 'failure' },
    ], 'failure'],
  ])('uses the %s official check when multiple exact-head runs exist', async (_label, runs, expected) => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9014, init);
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({
        total_count: runs.length,
        check_runs: runs.map((run) => ({ ...run, name: 'Review Yeti', head_sha: PR_HEAD, app: officialApp })),
      });
      if (url.endsWith('/check-runs/9014') && init?.method === 'PATCH') return groupCheckResponse(9014, init);
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9014, conclusion: expected,
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
  });

  it('fails when the merge queue changes between qualification reads', async () => {
    let graphqlReads = 0;
    const changedHead = 'e'.repeat(40);
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9005, init);
      if (url === 'https://api.github.com/graphql') {
        graphqlReads += 1;
        return response(queue(graphqlReads === 1 ? PR_HEAD : changedHead));
      }
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8003, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
        app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
      }] });
      if (url.endsWith('/check-runs/9005') && init?.method === 'PATCH') return groupCheckResponse(9005, init);
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9005, conclusion: 'failure',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    const completion = (fetchImplementation as any).mock.calls.find(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs/9005') && init?.method === 'PATCH');
    expect(JSON.parse(String(completion[1].body)).output.summary)
      .toContain('merge queue changed during exact-head qualification');
  });

  it.each([
    ['mismatched current head', () => {
      const value: any = queue(); value.data.repository.mergeQueue.entries.nodes[0].headCommit.oid = 'd'.repeat(40); return value;
    }, undefined],
    ['mismatched current base', () => {
      const value: any = queue(); value.data.repository.mergeQueue.entries.nodes[0].baseCommit.oid = 'd'.repeat(40); return value;
    }, undefined],
    ['ineligible constituent', () => {
      const value: any = queue(); value.data.repository.mergeQueue.entries.nodes[0].pullRequest.state = 'CLOSED'; return value;
    }, undefined],
    ['paginated queue evidence', () => {
      const value: any = queue(); value.data.repository.mergeQueue.entries.pageInfo.hasNextPage = true; return value;
    }, undefined],
    ['incomplete check-run evidence', () => queue(), { total_count: 2, check_runs: [{
      id: 8015, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success', app: officialApp,
    }] }],
  ])('fails closed for %s', async (_label, queueResponse, checkResponse) => {
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/graphql') return response(queueResponse());
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') return groupCheckResponse(9015, init);
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response(checkResponse || { total_count: 1, check_runs: [{
        id: 8015, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success', app: officialApp,
      }] });
      if (url.endsWith('/check-runs/9015') && init?.method === 'PATCH') return groupCheckResponse(9015, init);
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    if (_label === 'incomplete check-run evidence') {
      await expect(gate(payload())).resolves.toEqual({ checkId: 9015, conclusion: 'failure',
        snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    } else {
      await expect(gate(payload())).rejects.toThrow();
    }
  });

  it('requalifies a previously stored result against fresh queue and constituent evidence', async () => {
    const tokenFor = vi.fn(async () => 'ghs_test');
    let graphqlReads = 0;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/graphql') { graphqlReads += 1; return response(queue()); }
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 9003, name: 'Review Yeti', head_sha: GROUP_HEAD, external_id: stableGroupId(),
        status: 'completed', conclusion: 'success', app: officialApp,
      }] });
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8003, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success', app: officialApp,
      }] });
      if (url.endsWith('/check-runs/9003') && init?.method === 'PATCH') return groupCheckResponse(9003, init);
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any,
      tokenFor, fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9003, conclusion: 'success',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    expect(tokenFor).toHaveBeenCalledOnce();
    expect(graphqlReads).toBe(2);
  });

  it('rejects a duplicate delivery without holding a connection or touching GitHub', async () => {
    const tokenFor = vi.fn(async () => 'ghs_test');
    const fetchImplementation = vi.fn(async () => response(queue())) as unknown as typeof fetch;
    const store = {
      claim: vi.fn(async () => ({ status: 'busy' as const })), complete: vi.fn(), release: vi.fn(),
      reserveCheckCreation: vi.fn(), bindCheck: vi.fn(),
      listPriorPublications: vi.fn(), settlePriorPublication: vi.fn(),
    };
    const gate = createMergeGroupGate({ config, repository: store, tokenFor, fetchImplementation });
    await expect(gate(payload())).rejects.toBeInstanceOf(MergeGroupGateInProgressError);
    expect(tokenFor).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });

  it('invalidates a terminal GitHub check before requalifying the same queue snapshot', async () => {
    const stableId = stableGroupId();
    let graphqlReads = 0;
    const calls: Array<{ url: string; method?: string; body?: any }> = [];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({
        total_count: 1, check_runs: [{ id: 9010, name: 'Review Yeti', head_sha: GROUP_HEAD,
          external_id: stableId, status: 'completed', conclusion: 'success',
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' } }],
      });
      if (url === 'https://api.github.com/graphql') { graphqlReads += 1; return response(queue()); }
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8010, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success', app: officialApp,
      }] });
      if (url.endsWith('/check-runs/9010') && init?.method === 'PATCH') return groupCheckResponse(9010, init);
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9010, conclusion: 'success',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    expect(graphqlReads).toBe(2);
    expect(calls.filter((call) => call.url.endsWith('/check-runs') && call.method === 'POST')).toHaveLength(0);
    const revalidation = calls.findIndex((call) => call.url.endsWith('/check-runs/9010')
      && call.method === 'PATCH' && call.body?.status === 'in_progress');
    const constituentRead = calls.findIndex((call) => call.url.includes(`/commits/${PR_HEAD}/check-runs`));
    expect(revalidation).toBeGreaterThanOrEqual(0);
    expect(revalidation).toBeLessThan(constituentRead);
  });

  it('resumes a matching in-progress GitHub check without creating a duplicate', async () => {
    const stableId = stableGroupId();
    let graphqlReads = 0;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response({
        total_count: 1, check_runs: [{ id: 9011, name: 'Review Yeti', head_sha: GROUP_HEAD,
          external_id: stableId, status: 'in_progress', conclusion: null,
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' } }],
      });
      if (url === 'https://api.github.com/graphql') { graphqlReads += 1; return response(queue()); }
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8011, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
        app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
      }] });
      if (url.endsWith('/check-runs/9011') && init?.method === 'PATCH') return groupCheckResponse(9011, init);
      return response({}, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({
      config, repository: repository() as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });
    await expect(gate(payload())).resolves.toEqual({ checkId: 9011, conclusion: 'success',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    expect(graphqlReads).toBe(2);
    expect((fetchImplementation as any).mock.calls.some(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs') && init?.method === 'POST')).toBe(false);
  });

  it('holds a new snapshot until an older unknown-ACK check is found and retired', async () => {
    const priorDigest = 'f'.repeat(64);
    const priorExternalId = `review-yeti-merge-group:v2:614653796:${GROUP_HEAD}:${priorDigest}`;
    let priorSettled = false;
    let groupListReads = 0;
    const store = repository();
    store.listPriorPublications.mockImplementation(async () => priorSettled ? [] : [{
      snapshotDigest: priorDigest, checkId: null, checkCreationStarted: true, conclusion: null,
    }]);
    store.settlePriorPublication.mockImplementation(async () => { priorSettled = true; });
    const calls: Array<{ url: string; method?: string; body?: any }> = [];
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;
      const requestBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body: requestBody });
      if (url.endsWith(`/commits/${GROUP_HEAD}/check-runs?filter=all&per_page=100`)) {
        groupListReads += 1;
        return groupListReads === 1 ? response({ total_count: 0, check_runs: [] }) : response({
          total_count: 1, check_runs: [{ id: 8999, name: 'Review Yeti', head_sha: GROUP_HEAD,
            external_id: priorExternalId, status: 'in_progress', conclusion: null, app: officialApp }],
        });
      }
      if (url.endsWith('/check-runs/8999') && method === 'PATCH') {
        return response({ id: 8999, name: 'Review Yeti', head_sha: GROUP_HEAD,
          external_id: priorExternalId, status: 'completed', conclusion: 'failure', app: officialApp });
      }
      if (url.endsWith('/check-runs') && method === 'POST') return groupCheckResponse(9020, init);
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8020, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success', app: officialApp,
      }] });
      if (url.endsWith('/check-runs/9020') && method === 'PATCH') return groupCheckResponse(9020, init);
      return response({ error: 'unexpected request' }, 500);
    }) as typeof fetch;
    const gate = createMergeGroupGate({ config, repository: store as any,
      tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation });

    await expect(gate(payload())).rejects.toThrow(/earlier merge-group check is unresolved/u);
    expect(calls.filter((call) => call.url.endsWith('/check-runs') && call.method === 'POST')).toHaveLength(0);
    expect(store.release).toHaveBeenCalledOnce();

    await expect(gate(payload())).resolves.toEqual({ checkId: 9020, conclusion: 'success',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    const priorRetirement = calls.findIndex((call) => call.url.endsWith('/check-runs/8999')
      && call.method === 'PATCH' && call.body?.conclusion === 'failure');
    const newCreate = calls.findIndex((call) => call.url.endsWith('/check-runs') && call.method === 'POST');
    expect(priorRetirement).toBeGreaterThanOrEqual(0);
    expect(priorRetirement).toBeLessThan(newCreate);
    expect(store.settlePriorPublication).toHaveBeenCalledWith(614653796, GROUP_HEAD,
      queueSnapshotDigest(), expect.any(String), priorDigest, 8999);
    expect(store.reserveCheckCreation).toHaveBeenCalledOnce();
  });

  it('propagates a terminal PATCH failure and resumes the same in-progress check on retry', async () => {
    const stableId = stableGroupId();
    let completionAttempts = 0;
    let created = false;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response(created ? {
        total_count: 1, check_runs: [{ id: 9012, name: 'Review Yeti', head_sha: GROUP_HEAD,
          external_id: stableId, status: 'in_progress', conclusion: null,
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' } }],
      } : { total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') {
        created = true;
        return groupCheckResponse(9012, init);
      }
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8012, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
        app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
      }] });
      if (url.endsWith('/check-runs/9012') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        if (body.status !== 'completed') return groupCheckResponse(9012, init);
        completionAttempts += 1;
        // REL-1103: 500 is not a transient status, so it stays terminal for this call.
        return completionAttempts === 1 ? response({ error: 'internal' }, 500) : groupCheckResponse(9012, init);
      }
      return response({}, 500);
    }) as typeof fetch;
    const store = repository();
    const gate = createMergeGroupGate({
      config, repository: store as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).rejects.toThrow('GitHub JSON request failed with HTTP 500');
    await expect(gate(payload())).resolves.toEqual({ checkId: 9012, conclusion: 'success',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(completionAttempts).toBe(2);
    expect((fetchImplementation as any).mock.calls.filter(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs') && init?.method === 'POST')).toHaveLength(1);
  });

  it('REL-1103: retries a transient 503 PATCH within the same call instead of failing the gate', async () => {
    const stableId = stableGroupId();
    let completionAttempts = 0;
    let created = false;
    const fetchImplementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`/commits/${GROUP_HEAD}/check-runs`)) return response(created ? {
        total_count: 1, check_runs: [{ id: 9012, name: 'Review Yeti', head_sha: GROUP_HEAD,
          external_id: stableId, status: 'in_progress', conclusion: null,
          app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' } }],
      } : { total_count: 0, check_runs: [] });
      if (url.endsWith('/check-runs') && init?.method === 'POST') {
        created = true;
        return groupCheckResponse(9012, init);
      }
      if (url === 'https://api.github.com/graphql') return response(queue());
      if (url.includes(`/commits/${PR_HEAD}/check-runs`)) return response({ total_count: 1, check_runs: [{
        id: 8012, name: 'Review Yeti', head_sha: PR_HEAD, status: 'completed', conclusion: 'success',
        app: { id: AUTHORITATIVE_REVIEW_APP_ID, slug: 'ct-review-bot' },
      }] });
      if (url.endsWith('/check-runs/9012') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        if (body.status !== 'completed') return groupCheckResponse(9012, init);
        completionAttempts += 1;
        return completionAttempts === 1 ? response({ error: 'unavailable' }, 503) : groupCheckResponse(9012, init);
      }
      return response({}, 500);
    }) as typeof fetch;
    const store = repository();
    const gate = createMergeGroupGate({
      config, repository: store as any, tokenFor: vi.fn(async () => 'ghs_test'), fetchImplementation,
    });

    await expect(gate(payload())).resolves.toEqual({ checkId: 9012, conclusion: 'success',
      snapshotDigest: queueSnapshotDigest(), constituents: 1 });
    expect(store.claim).toHaveBeenCalledTimes(1);
    expect(completionAttempts).toBe(2);
    expect((fetchImplementation as any).mock.calls.filter(([url, init]: [unknown, RequestInit]) =>
      String(url).endsWith('/check-runs') && init?.method === 'POST')).toHaveLength(1);
  });

  it('rejects an unenrolled or malformed merge-group identity before any side effect', async () => {
    const store = repository();
    const tokenFor = vi.fn(async () => 'ghs_test');
    const gate = createMergeGroupGate({ config, repository: store as any, tokenFor });
    await expect(gate({ ...payload(), merge_group: { ...payload().merge_group, head_ref: 'refs/heads/main' } }))
      .rejects.toThrow('GitHub webhook repository identity is not enrolled');
    expect(store.claim).not.toHaveBeenCalled();
    expect(tokenFor).not.toHaveBeenCalled();
  });
});
