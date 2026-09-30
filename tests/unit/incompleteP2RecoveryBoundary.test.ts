import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchRouter } from '../../src/api/actionDispatchApi';
import { createIncompleteP2RecoveryHandler } from '../../src/api/incompleteP2RecoveryRoute';
import type { IncompleteP2RecoveryQueryable } from '../../src/api/incompleteP2RecoveryRoute';
import { createIncompleteP2RecoveryContext, parseIncompleteP2RecoveryContext } from '../../src/review/incompleteP2Recovery';
import { HttpIncompleteP2RecoverySource } from '../../src/review/incompleteP2RecoveryHttp';
import { deriveReviewGateExternalId } from '../../src/review/reviewCheckIdentity';
import { parseWorkerReviewCompletion, workerReviewCompletionDigest } from '../../src/review/workerReviewCompletion';
import { sha256 } from '../../src/review/reviewCore';

const TOKEN = 'ghs_incomplete_p2_worker_token';
const RUN = `run_${'1'.repeat(32)}`;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const POLICY = 'c'.repeat(64);
const CONFIG = 'd'.repeat(64);
const APP_ID = 4385771;
const COMPLETED_AT = '2026-09-29T12:00:00Z';
const GATE_AT = '2026-09-29T12:00:10Z';
const INCOMPLETE_SUMMARY = `Verdict \`BLOCK\` at \`${HEAD}\`.\nFindings: 1 (blocking P0/P1: 0; 1 raw persona finding(s) before clustering).\nCoverage: mode=panel; expected lanes=2; completed lanes=1; failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false.`;
const GATE_SUMMARY = 'Review Yeti Gate failed: the panel expected 2 review lane(s) but 1 completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.';

function minimalContext(workerResultDigest = 'e'.repeat(64)) {
  const source = {
    executionAttempt: 1,
    workerResultDigest,
    workerCheckId: 1001,
    gateCheckId: 2001,
    rawFindingCount: 1,
    canonicalFindingCount: 1,
  };
  return createIncompleteP2RecoveryContext({
    version: 'IncompleteP2RecoveryContext.v1',
    runId: RUN,
    repositoryId: 123,
    owner: 'example',
    repo: 'candidate',
    prNumber: 42,
    headSha: HEAD,
    baseSha: BASE,
    policyDigest: POLICY,
    configDigest: CONFIG,
    expectedAppId: APP_ID,
    executionAttempt: 2,
    sources: [source],
    findings: [{
      sourceExecutionAttempt: 1,
      sourceWorkerResultDigest: source.workerResultDigest,
      sourceWorkerCheckId: source.workerCheckId,
      sourceGateCheckId: source.gateCheckId,
      personaId: 'security',
      findingIndex: 0,
      finding: {
        severity: 'P2', path: 'src/example.ts', line: 7,
        title: 'Prior advisory', body: 'Verify the earlier observation against the current source.',
      },
    }],
  });
}

function incompleteArchiveFixture(options: {
  marker?: string;
  includeRecovery?: boolean;
  includeCompletion?: boolean;
  includePriorGate?: boolean;
  gateCheckOverrides?: Record<string, unknown>;
  sourceOverrides?: Record<string, unknown>;
} = {}) {
  const completion = parseWorkerReviewCompletion({
    version: 'WorkerReviewCompletion.v1', runId: RUN, repositoryId: 123,
    owner: 'example', repo: 'candidate', prNumber: 42, headSha: HEAD, baseSha: BASE,
    policyDigest: POLICY, configDigest: CONFIG, executionAttempt: 1,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: COMPLETED_AT,
      personas: [{ id: 'security', decision: 'FINDINGS', status: 'COMPLETE', findings: [{
        severity: 'P2', path: 'src/example.ts', line: 7,
        title: 'Prior advisory', body: 'Verify the earlier observation against the current source.',
      }] }],
      // The worker-observed quorum can still be true when a required lane is missing.
      // The bound Gate carries the trusted canonical false quorum decision.
      coverageComplete: true, quorumSatisfied: true,
    },
  });
  const completionDigest = workerReviewCompletionDigest(completion);
  const context = minimalContext(completionDigest);
  const gateCoordinates = {
    owner: 'example', repo: 'candidate', repositoryId: 123, prNumber: 42,
    headSha: HEAD, baseSha: BASE, policyDigest: POLICY,
    runId: RUN, attemptId: `${RUN}-g0-e1`, executionAttempt: 1,
  };
  const gateExternalId = deriveReviewGateExternalId(gateCoordinates);
  const gateCheck = {
    id: 2001, name: 'Review Yeti Gate', head_sha: HEAD,
    app: { id: APP_ID, slug: 'ct-review-bot' },
    external_id: gateExternalId, status: 'completed', conclusion: 'failure',
    started_at: '2026-09-29T12:00:01Z', completed_at: GATE_AT,
    output: { title: 'Review Yeti Gate: Failed (incomplete panel)', summary: GATE_SUMMARY },
    ...options.gateCheckOverrides,
  };
  const recovery = {
    generation: 1, checkId: 1001, externalId: `${RUN}:a1`, conclusion: 'failure', title: 'Review Yeti: BLOCK',
    legacyIncompleteRoster: { workerSummary: INCOMPLETE_SUMMARY, workerCompletedAt: COMPLETED_AT, gateChecks: [gateCheck] },
  };
  const runRow = {
    run_id: RUN, repository_id: 123, owner: 'example', repo: 'candidate', pr_number: 42,
    head_sha: HEAD, base_sha: BASE, effective_policy_digest: POLICY, effective_config_digest: CONFIG,
    authoritative_gate_app_id: APP_ID, publication_mode: 'app-gate',
  };
  const sourceRow = {
    ...runRow,
    source_execution_attempt: 1,
    content_digest: completionDigest,
    payload: completion,
    byte_length: Buffer.byteLength(JSON.stringify(completion), 'utf8'),
    payload_byte_length: Buffer.byteLength(JSON.stringify(completion), 'utf8'),
    gate_check_id: 2001,
    gate_execution_attempt: 1,
    gate_review_generation: 0,
    gate_repository_id: 123,
    gate_pr_number: 42,
    gate_expected_app_id: APP_ID,
    gate_external_id: gateExternalId,
    gate_creation_state: 'bound',
    gate_desired_state: 'failure',
    gate_coordinates: gateCoordinates,
    gate_evidence: {
      verdict: 'BLOCK', coverageComplete: true, quorumSatisfied: false,
      infrastructureFailure: false, exemption: null, expectedLanes: 2,
      completedLanes: 1, p0Count: 0, p1Count: 0,
    },
    gate_decision: { status: 'failure', reason: 'incomplete-review' },
    gate_worker_result_digest: completionDigest,
    ...options.sourceOverrides,
  };

  const calls: string[] = [];
  const query = vi.fn<IncompleteP2RecoveryQueryable['query']>(async (sql) => {
    calls.push(sql);
    if (sql.includes('FROM review_runs runs JOIN review_dispatch_outbox outbox')) {
      return { rows: [{ status: 'running', worker_token_digest: sha256(TOKEN) }] };
    }
    if (sql.includes('SELECT identity, repository_id, effective_policy_digest')) {
      return { rows: [{
        identity: { owner: 'example', repo: 'candidate', prNumber: 42, headSha: HEAD, baseSha: BASE, configDigest: CONFIG },
        repository_id: 123, effective_policy_digest: POLICY, authoritative_gate_app_id: APP_ID,
        artifacts: options.marker === undefined ? {} : {
          incomplete_p2_recovery_digest: options.marker === 'valid' ? context.contextDigest : options.marker,
        },
      }] };
    }
    if (sql.includes('SELECT repository_id, owner, repo, pr_number, head_sha, base_sha')) {
      return { rows: [runRow] };
    }
    if (sql.includes('SELECT run_id, repository_id, owner, repo, pr_number, head_sha')) {
      return { rows: [runRow] };
    }
    if (sql.includes('FROM review_generation_recoveries')) {
      return { rows: options.includeRecovery === false ? [] : [{
        recovered_generation: 1, worker_check_id: 1001, external_id: `${RUN}:a1`,
        conclusion: 'failure', title: 'Review Yeti: BLOCK', evidence: recovery,
      }] };
    }
    if (sql.includes('/* incomplete P2 recovery loss guard */')) {
      return { rows: options.includePriorGate === false ? [] : [{ ...sourceRow,
        ...(options.includeCompletion === false ? { payload: null, content_digest: null } : {}),
      }] };
    }
    if (sql.includes('JOIN review_worker_completions completions')) {
      return { rows: options.includeCompletion === false ? [] : [sourceRow] };
    }
    throw new Error(`Unexpected SQL in fixture: ${sql.trim().slice(0, 90)}`);
  });
  return { context, queryable: { query }, calls, completion, completionDigest };
}

function routeApp(queryable: IncompleteP2RecoveryQueryable) {
  const app = express();
  app.use(express.json());
  app.post('/api/dispatch/incomplete-p2-recovery', createIncompleteP2RecoveryHandler(queryable));
  return app;
}

const recoveryRequest = { version: 'IncompleteP2RecoveryRequest.v1', runId: RUN, executionAttempt: 2 };

describe('incomplete P2 recovery HTTP source', () => {
  it('posts exact execution identity and parses a valid service-owned context', async () => {
    const context = minimalContext();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      version: 'IncompleteP2RecoveryResponse.v1', runId: RUN, executionAttempt: 2, context,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const source = new HttpIncompleteP2RecoverySource({ token: TOKEN,
      completionEndpoint: 'https://service.example/api/dispatch/completion', runId: RUN,
      executionAttempt: 2, fetchImplementation: fetcher });

    await expect(source.read()).resolves.toEqual(context);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://service.example/api/dispatch/incomplete-p2-recovery');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
    expect(JSON.parse(String(init?.body))).toEqual(recoveryRequest);
  });

  it.each([
    ['HTTP failure', async () => new Response('{"error":"unavailable"}', { status: 503 })],
    ['redirect', async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } })],
    ['wrong execution identity', async () => new Response(JSON.stringify({
      version: 'IncompleteP2RecoveryResponse.v1', runId: `run_${'9'.repeat(32)}`, executionAttempt: 2, context: null,
    }), { status: 200 })],
  ])('fails closed on %s instead of treating it as an empty archive', async (_reason, response) => {
    const source = new HttpIncompleteP2RecoverySource({ token: TOKEN,
      completionEndpoint: 'https://service.example/api/dispatch/completion', runId: RUN,
      executionAttempt: 2, fetchImplementation: vi.fn<typeof fetch>(response) });
    await expect(source.read()).rejects.toThrow();
  });

  it('enforces the 80 KB HTTP read cap on a valid response carrying a valid context', async () => {
    const context = minimalContext();
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThan(64 * 1024);
    const responseBody = JSON.stringify({
      version: 'IncompleteP2RecoveryResponse.v1', runId: RUN, executionAttempt: 2, context,
    }).padEnd(80_001, ' ');
    const parsedBody = JSON.parse(responseBody);
    expect(Buffer.byteLength(responseBody, 'utf8')).toBeGreaterThan(80_000);
    expect(parsedBody).toMatchObject({
      version: 'IncompleteP2RecoveryResponse.v1', runId: RUN, executionAttempt: 2,
    });
    expect(() => parseIncompleteP2RecoveryContext(parsedBody.context)).not.toThrow();

    const source = new HttpIncompleteP2RecoverySource({ token: TOKEN,
      completionEndpoint: 'https://service.example/api/dispatch/completion', runId: RUN,
      executionAttempt: 2, fetchImplementation: vi.fn<typeof fetch>(async () => new Response(responseBody, {
        status: 200, headers: { 'content-type': 'application/json' },
      })) });
    await expect(source.read()).rejects.toThrow(/exceeds its bound/u);
  });

  it('fails closed when the archive transport rejects', async () => {
    const source = new HttpIncompleteP2RecoverySource({ token: TOKEN,
      completionEndpoint: 'https://service.example/api/dispatch/completion', runId: RUN,
      executionAttempt: 2, fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')) });
    await expect(source.read()).rejects.toThrow('offline');
  });
});

describe('authenticated incomplete P2 recovery route', () => {
  it('returns the retained context to the exact current worker bearer', async () => {
    const fixture = incompleteArchiveFixture({ marker: 'valid' });
    const response = await request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery')
      .set('Authorization', `Bearer ${TOKEN}`).send(recoveryRequest);
    expect(response.status).toBe(200);
    expect(response.body.context.contextDigest).toBe(fixture.context.contextDigest);
    expect(response.body.runId).toBe(RUN);
    expect(response.body.executionAttempt).toBe(2);
  });

  it.each([
    ['no bearer', undefined],
    ['malformed bearer', 'Bearer not-an-installation-token'],
  ])('returns 401 for %s before querying the database', async (_reason, authorization) => {
    const fixture = incompleteArchiveFixture({ marker: 'valid' });
    let pending = request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery');
    if (authorization) pending = pending.set('Authorization', authorization);
    const response = await pending.send(recoveryRequest);

    expect(response.status).toBe(401);
    expect(fixture.queryable.query).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
  });

  it.each([
    ['malformed run identity', { ...recoveryRequest, runId: 'not-a-run' }],
    ['unsupported attempt', { ...recoveryRequest, executionAttempt: 1 }],
    ['non-integer attempt', { ...recoveryRequest, executionAttempt: 2.5 }],
  ])('returns 400 for %s before querying the database', async (_reason, body) => {
    const fixture = incompleteArchiveFixture({ marker: 'valid' });
    const response = await request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery')
      .set('Authorization', `Bearer ${TOKEN}`).send(body);

    expect(response.status).toBe(400);
    expect(fixture.queryable.query).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
  });

  it('rejects a stale worker bearer before reading review identity or archive rows', async () => {
    const fixture = incompleteArchiveFixture();
    const query = fixture.queryable.query as ReturnType<typeof vi.fn>;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM review_runs runs JOIN review_dispatch_outbox outbox')) {
        return { rows: [{ status: 'running', worker_token_digest: sha256('ghs_previous_attempt') }] };
      }
      throw new Error('stale token must be refused before archive reads');
    });
    const response = await request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery')
      .set('Authorization', `Bearer ${TOKEN}`).send(recoveryRequest);
    expect(response.status).toBe(403);
    expect(query).toHaveBeenCalledOnce();
  });

  it('fails closed when a valid P2 archive has no admission marker', async () => {
    const fixture = incompleteArchiveFixture();
    const response = await request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery')
      .set('Authorization', `Bearer ${TOKEN}`).send(recoveryRequest);
    expect(response.status).toBe(503);
    expect(fixture.calls.some((sql) => sql.includes('JOIN review_worker_completions completions'))).toBe(true);
  });

  it('fails closed when the marker exists but the durable archive is missing', async () => {
    const fixture = incompleteArchiveFixture({ marker: 'f'.repeat(64), includeRecovery: false });
    const response = await request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery')
      .set('Authorization', `Bearer ${TOKEN}`).send(recoveryRequest);
    expect(response.status).toBe(503);
    expect(fixture.calls.some((sql) => sql.includes('JOIN review_worker_completions completions'))).toBe(false);
  });

  it('keeps an ordinary technical retry above the P2 recovery bound on the existing empty-context path', async () => {
    const fixture = incompleteArchiveFixture({ includeRecovery: false, includePriorGate: false });
    const response = await request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery')
      .set('Authorization', `Bearer ${TOKEN}`).send({ ...recoveryRequest, executionAttempt: 4 });
    expect(response.status).toBe(200);
    expect(response.body.context).toBeNull();
  });

  it('rejects a lost ledger and marker when the original incomplete findings still persist', async () => {
    const fixture = incompleteArchiveFixture({ includeRecovery: false });
    const response = await request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery')
      .set('Authorization', `Bearer ${TOKEN}`).send(recoveryRequest);
    expect(response.status).toBe(503);
    expect(fixture.calls.some((sql) => sql.includes('/* incomplete P2 recovery loss guard */'))).toBe(true);
  });

  it.each([
    ['Gate outside the worker interval', { gateCheckOverrides: { completed_at: '2026-09-29T11:59:59Z' } }],
    ['Gate from another App', { gateCheckOverrides: { app: { id: 7, slug: 'other-app' } } }],
    ['Gate from another head', { gateCheckOverrides: { head_sha: 'f'.repeat(40) } }],
    ['Gate bound to a different completion digest', { sourceOverrides: { gate_worker_result_digest: 'f'.repeat(64) } }],
  ])('rejects %s when loading archived P2 context', async (_reason, options) => {
    const fixture = incompleteArchiveFixture({ marker: 'valid', ...options });
    const response = await request(routeApp(fixture.queryable)).post('/api/dispatch/incomplete-p2-recovery')
      .set('Authorization', `Bearer ${TOKEN}`).send(recoveryRequest);
    expect(response.status).toBe(503);
    const archiveWasRead = fixture.calls.some((sql) => sql.includes('JOIN review_worker_completions completions'));
    expect(archiveWasRead).toBe('sourceOverrides' in options);
  });
});

describe('ActionDispatch incomplete P2 candidate boundary', () => {
  const common = {
    version: 'ActionDispatch.v1', deliveryId: '', repositoryId: 123, owner: 'example', repo: 'candidate',
    prNumber: 42, headSha: HEAD, baseSha: BASE, actionSha: 'f'.repeat(40), publishMode: 'app-gate',
    refreshRequested: true, refreshExecutionAttempt: 1, expectedGeneration: 2, incompleteP2Recovery: true,
    requestedAt: new Date().toISOString(),
    policy: {},
  } as const;

  function withDeliveryId(value: Record<string, unknown>) {
    const caller = value.caller as { runId: string; runAttempt: number };
    return { ...value, deliveryId: `actions:${caller.runId}:${caller.runAttempt}:${value.repositoryId}:${value.prNumber}:${value.headSha}` };
  }

  function api(claims: Record<string, unknown>) {
    const admission = { admit: vi.fn(async () => ({ status: 'accepted', run: { runId: RUN } })) };
    const app = express();
    app.use(express.json());
    app.use('/api/dispatch', createActionDispatchRouter({
      verifier: { verify: vi.fn(async () => claims), policy: { workflowRefs: new Set(['*']) } } as never,
      admission: admission as never,
      resolveInstallationId: vi.fn(async () => 321),
      allowAppGate: true,
      authoritativePublishing: {
        expectedAppId: APP_ID, repositoryIds: [123],
        resolver: { resolve: vi.fn(async () => ({ identity: { owner: 'example', repo: 'candidate', prNumber: 42,
          headSha: HEAD, baseSha: BASE }, prepared: { policy: { effectivePolicyDigest: POLICY } } })) },
      } as never,
      centralExternalRepositories: new Map([['example/candidate', 123]]),
      now: () => Date.parse(common.requestedAt),
    }));
    return { app, admission };
  }

  it('rejects a direct repository caller even when it supplies a valid-looking candidate flag', async () => {
    const claims = {
      repository: 'example/candidate', repository_id: '123', repository_owner_id: '456',
      run_id: '777', run_attempt: '1', event_name: 'pull_request',
      workflow_ref: 'example/candidate/.github/workflows/review.yml@refs/heads/main',
    };
    const body = withDeliveryId({ ...common, caller: { runId: '777', runAttempt: 1,
      eventName: 'pull_request', workflowRef: claims.workflow_ref } });
    const { app, admission } = api(claims);
    const response = await request(app).post('/api/dispatch/action').set('Authorization', 'Bearer oidc')
      .send(body);
    expect(response.status).toBe(403);
    expect(admission.admit).not.toHaveBeenCalled();
  });

  it('rejects the candidate flag when a central dispatch is not an explicit refresh', async () => {
    const claims = {
      repository: 'exampleorg/example-review-actions', repository_id: '900', repository_owner_id: '456',
      run_id: '888', run_attempt: '1', event_name: 'repository_dispatch',
      workflow_ref: 'exampleorg/example-review-actions/.github/workflows/repository-dispatch.yml@refs/heads/main',
      job_workflow_ref: 'exampleorg/example-review-actions/.github/workflows/review-yeti.yml@refs/heads/v1',
    };
    const body = withDeliveryId({ ...common, refreshRequested: false, caller: { runId: '888', runAttempt: 1,
      eventName: 'repository_dispatch', workflowRef: claims.workflow_ref } });
    const { app, admission } = api(claims);
    const response = await request(app).post('/api/dispatch/action').set('Authorization', 'Bearer oidc')
      .send(body);
    expect(response.status).toBe(400);
    expect(admission.admit).not.toHaveBeenCalled();
  });
});
