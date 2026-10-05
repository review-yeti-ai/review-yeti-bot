import { createHmac } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createActionDispatchApp } from '../../src/dispatchServer';
import { createGitHubWebhookAdmissionHandler } from '../../src/review/githubWebhookAdmission';
import {
  createPassthroughShipPublisher, PASSTHROUGH_REVIEW_MODE_MARKER,
} from '../../src/review/passthroughShipPublisher';
import { buildReviewRunIdentity, deriveReviewRunId } from '../../src/review/reviewAdmission';
import { deriveReviewGateExternalId } from '../../src/review/reviewCheckIdentity';

const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const REPO_ID = 614653796;
const APP = { id: 4385771, slug: 'ct-review-bot' };

interface FakeOptions { draft?: boolean; head?: string; existing?: any[]; state?: string }

function fakeGitHub(options: FakeOptions = {}) {
  const runs: any[] = [...(options.existing ?? [])];
  const writes: Array<{ method: string; path: string; body: any }> = [];
  let nextId = 9000;
  const client = {
    async request(path: string, init?: RequestInit) {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/pulls\/42$/u.test(path)) {
        return {
          state: options.state ?? 'open', draft: options.draft ?? false,
          head: { sha: options.head ?? HEAD }, base: { sha: BASE, repo: { id: REPO_ID } },
        };
      }
      if (method === 'GET' && path.includes('/check-runs?')) {
        return { total_count: runs.length, check_runs: runs };
      }
      const body = JSON.parse(String(init?.body));
      writes.push({ method, path, body });
      if (method === 'POST') {
        const run = { id: nextId += 1, app: APP, head_sha: body.head_sha, ...body };
        runs.push(run);
        return run;
      }
      const id = Number(path.split('/').at(-1));
      Object.assign(runs.find((run) => run.id === id), body);
      return { id };
    },
  };
  return { client, writes, runs };
}

function publisher(fake: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) {
  const tokenFor = vi.fn(async () => 'ghs_token');
  return {
    tokenFor,
    publisher: createPassthroughShipPublisher({
      appId: APP.id, tokenFor, githubClientFor: () => fake.client, now: () => Date.parse('2026-10-05T00:00:00Z'), ...extra,
    }),
  };
}

const REQUEST = { owner: 'exampleorg', repo: 'dashboard', repositoryId: REPO_ID, prNumber: 42, headSha: HEAD, baseSha: BASE };

describe('passthrough service-owned SHIP check', () => {
  it('posts a completed/success Review Yeti check on the exact head labelled as passthrough', async () => {
    const fake = fakeGitHub();
    const { publisher: p } = publisher(fake);
    const result = await p.publish(REQUEST);

    expect(result).toMatchObject({ status: 'published', reviewMode: 'passthrough' });
    expect(fake.writes).toHaveLength(1);
    const body = fake.writes[0].body;
    expect(fake.writes[0].method).toBe('POST');
    expect(body).toMatchObject({ name: 'Review Yeti', head_sha: HEAD, status: 'completed', conclusion: 'success' });
    expect(body.output.title).toBe('Review Yeti: SHIP (passthrough: no review performed)');
    expect(body.output.summary).toContain('passthrough: no review performed');
    expect(body.output.summary).toContain(PASSTHROUGH_REVIEW_MODE_MARKER);
    expect(body.output.summary).toContain(`\`SHIP\` at \`${HEAD}\``);
    expect(body.external_id).toContain('review-yeti-passthrough');
  });

  it('is idempotent per head: a second request posts nothing', async () => {
    const fake = fakeGitHub();
    const { publisher: p } = publisher(fake);
    await p.publish(REQUEST);
    const second = await p.publish(REQUEST);
    expect(second).toMatchObject({ status: 'already_published' });
    expect(fake.writes).toHaveLength(1);
  });

  it('completes an in-progress passthrough check with a PATCH instead of creating a duplicate', async () => {
    const fake = fakeGitHub({ existing: [{
      id: 55, name: 'Review Yeti', app: APP, head_sha: HEAD, status: 'in_progress',
      external_id: `review-yeti-passthrough:v1:${REPO_ID}:${HEAD}`,
    }] });
    const { publisher: p } = publisher(fake);
    const result = await p.publish(REQUEST);
    expect(result).toMatchObject({ status: 'published', checkId: 55 });
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].method).toBe('PATCH');
    expect(fake.writes[0].path).toContain('/check-runs/55');
    expect(fake.writes[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(fake.runs.filter((run) => run.name === 'Review Yeti')).toHaveLength(1);
  });

  it('never posts for a draft, closed or stale pull request', async () => {
    for (const [options, reason] of [
      [{ draft: true }, 'pull_request_draft'],
      [{ state: 'closed' }, 'pull_request_not_open'],
      [{ head: 'd'.repeat(40) }, 'stale_head'],
    ] as const) {
      const fake = fakeGitHub(options);
      const { publisher: p } = publisher(fake);
      expect(await p.publish(REQUEST)).toEqual({ status: 'skipped', reason });
      expect(fake.writes).toHaveLength(0);
    }
  });

  it('does not supersede genuine review evidence already on the head', async () => {
    const fake = fakeGitHub({ existing: [{
      id: 1, name: 'Review Yeti', app: APP, head_sha: HEAD, status: 'completed', conclusion: 'failure',
      external_id: `run_${'1'.repeat(32)}:a1`,
    }] });
    const { publisher: p } = publisher(fake);
    expect(await p.publish(REQUEST)).toEqual({ status: 'skipped', reason: 'existing_review_evidence' });
    expect(fake.writes).toHaveLength(0);
  });

  it('skips when the pull request belongs to a different repository id', async () => {
    const fake = fakeGitHub();
    const { publisher: p } = publisher(fake);
    expect(await p.publish({ ...REQUEST, repositoryId: REPO_ID + 1 })).toEqual({ status: 'skipped', reason: 'repository_mismatch' });
    expect(fake.writes).toHaveLength(0);
  });

  it('does not post the Gate or the raw check over a genuine Gate already on the head', async () => {
    const fake = fakeGitHub({ existing: [{
      id: 2, name: 'Review Yeti Gate', app: APP, head_sha: HEAD, status: 'completed', conclusion: 'failure',
      external_id: `review-yeti-gate:v1:${'f'.repeat(64)}`,
    }] });
    const identity = buildReviewRunIdentity({ owner: 'exampleorg', repo: 'dashboard', prNumber: 42, headSha: HEAD, baseSha: BASE });
    const { publisher: p } = publisher(fake, { authoritativePublishing: {
      expectedAppId: APP.id, repositoryIds: [REPO_ID],
      resolver: { resolve: vi.fn(async () => ({ current: {}, identity, prepared: { policy: { effectivePolicyDigest: 'a'.repeat(64) } } })) },
    } });
    expect(await p.publish(REQUEST)).toEqual({ status: 'skipped', reason: 'existing_review_evidence' });
    expect(fake.writes).toHaveLength(0);
  });

  it('posts the paired service-owned Gate for an authoritative repository', async () => {
    const fake = fakeGitHub();
    const identity = buildReviewRunIdentity({ owner: 'exampleorg', repo: 'dashboard', prNumber: 42, headSha: HEAD, baseSha: BASE });
    const policyDigest = 'a'.repeat(64);
    const { publisher: p } = publisher(fake, { authoritativePublishing: {
      expectedAppId: APP.id, repositoryIds: [REPO_ID],
      resolver: { resolve: vi.fn(async () => ({ current: {}, identity, prepared: { policy: { effectivePolicyDigest: policyDigest } } })) },
    } });
    const result = await p.publish(REQUEST);

    expect(result).toMatchObject({ status: 'published' });
    expect(fake.writes.map((write) => write.body.name)).toEqual(['Review Yeti', 'Review Yeti Gate']);
    const gate = fake.writes[1].body;
    const runId = deriveReviewRunId(identity);
    expect(gate).toMatchObject({ head_sha: HEAD, status: 'completed', conclusion: 'success' });
    expect(gate.external_id).toBe(deriveReviewGateExternalId({
      owner: 'exampleorg', repo: 'dashboard', repositoryId: REPO_ID, prNumber: 42, headSha: HEAD, baseSha: BASE,
      policyDigest, runId, attemptId: `${runId}-passthrough`, executionAttempt: 1,
    }));
    expect(gate.output.summary).toContain(PASSTHROUGH_REVIEW_MODE_MARKER);
  });
});

const SECRET = 'webhook-secret-with-at-least-thirty-two-bytes';
function webhookApp(passthroughEnabled: boolean, ship: { publish: ReturnType<typeof vi.fn> }) {
  const admit = vi.fn(async () => ({ status: 'accepted', run: { runId: `run_${'1'.repeat(32)}` } }));
  const onEvent = createGitHubWebhookAdmissionHandler({
    config: { secret: SECRET, admissionEnabled: !passthroughEnabled, passthroughEnabled,
      repositoryIds: new Set([String(REPO_ID)]), ownerIds: new Set(['57884877']) },
    admission: { admit } as any,
    passthroughShip: ship as any,
    now: () => Date.parse('2026-10-05T00:00:00Z'),
  });
  const instance = createActionDispatchApp({
    verifier: { verify: vi.fn() } as any, admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(), databaseReady: vi.fn(async () => true),
    allowAppGate: true, githubWebhook: { secret: SECRET, onEvent },
  });
  return { instance, admit };
}
function pullRequestBody(draft: boolean) {
  return {
    action: 'opened', number: 42, installation: { id: 456 },
    repository: { id: REPO_ID, name: 'dashboard', full_name: 'exampleorg/dashboard', owner: { id: 57884877, login: 'exampleorg' } },
    pull_request: { number: 42, state: 'open', draft, head: { sha: HEAD }, base: { sha: BASE, repo: { full_name: 'exampleorg/dashboard' } } },
  };
}
async function deliver(instance: any, body: unknown, id: string) {
  const raw = JSON.stringify(body);
  return request(instance).post('/api/webhooks/github')
    .set('Content-Type', 'application/json').set('X-GitHub-Event', 'pull_request').set('X-GitHub-Delivery', id)
    .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`).send(raw);
}

describe('passthrough webhook wiring', () => {
  it('asks the service-owned publisher for the exact head and reports the check in the receipt', async () => {
    const ship = { publish: vi.fn(async () => ({ status: 'published', checkId: 9001, reviewMode: 'passthrough' })) };
    const { instance, admit } = webhookApp(true, ship);
    const response = await deliver(instance, pullRequestBody(false), 'delivery-ship');
    expect(response.status).toBe(200);
    expect(ship.publish).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'exampleorg', repo: 'dashboard', repositoryId: REPO_ID, prNumber: 42, headSha: HEAD, baseSha: BASE,
    }));
    expect(response.body).toMatchObject({ status: 'passthrough', reviewStarted: false,
      passthroughCheck: { status: 'published', checkId: 9001, reviewMode: 'passthrough' } });
    expect(admit).not.toHaveBeenCalled();
  });

  it('keeps draft pull requests out of the publisher', async () => {
    const ship = { publish: vi.fn() };
    const { instance } = webhookApp(true, ship);
    const response = await deliver(instance, pullRequestBody(true), 'delivery-draft');
    expect(response.body).toMatchObject({ status: 'ignored' });
    expect(ship.publish).not.toHaveBeenCalled();
  });

  it('surfaces a publisher failure instead of acknowledging the receipt', async () => {
    const ship = { publish: vi.fn(async () => { throw new Error('GitHub unavailable'); }) };
    const { instance } = webhookApp(true, ship);
    const response = await deliver(instance, pullRequestBody(false), 'delivery-fail');
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.body).not.toHaveProperty('status', 'passthrough');
  });

  it('does not touch the publisher when passthrough is off', async () => {
    const ship = { publish: vi.fn() };
    const { instance, admit } = webhookApp(false, ship);
    const response = await deliver(instance, pullRequestBody(false), 'delivery-normal');
    expect(response.status).toBe(200);
    expect(ship.publish).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledTimes(1);
  });
});

describe('passthrough merge-queue check', () => {
  const GROUP = { owner: 'exampleorg', repo: 'dashboard', repositoryId: REPO_ID, headSha: 'd'.repeat(40) };
  const canonical = `review-yeti-merge-group:${REPO_ID}:${GROUP.headSha}`;

  it('posts a completed/success Review Yeti check with the canonical queue identity', async () => {
    const fake = fakeGitHub();
    const { publisher: p } = publisher(fake);
    const result = await p.publishMergeGroup(GROUP);
    expect(result).toMatchObject({ status: 'published', reviewMode: 'passthrough' });
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].body).toMatchObject({
      name: 'Review Yeti', head_sha: GROUP.headSha, external_id: canonical, status: 'completed', conclusion: 'success',
    });
    expect(typeof fake.writes[0].body.completed_at).toBe('string');
    expect(fake.writes[0].body.output.summary).toContain(PASSTHROUGH_REVIEW_MODE_MARKER);
    expect((await p.publishMergeGroup(GROUP)).status).toBe('already_published');
    expect(fake.writes).toHaveLength(1);
  });

  it('never overrides a different official check on the queue commit', async () => {
    const fake = fakeGitHub({ existing: [{
      id: 3, name: 'Review Yeti', app: APP, head_sha: GROUP.headSha, status: 'completed', conclusion: 'failure',
      external_id: 'something-else',
    }] });
    const { publisher: p } = publisher(fake);
    expect(await p.publishMergeGroup(GROUP)).toEqual({ status: 'skipped', reason: 'existing_review_evidence' });
    expect(fake.writes).toHaveLength(0);
  });

  it('is requested by the webhook for an enrolled merge_group delivery during passthrough', async () => {
    const ship = { publish: vi.fn(), publishMergeGroup: vi.fn(async () => ({ status: 'published', checkId: 11, reviewMode: 'passthrough' })) };
    const config = { secret: SECRET, admissionEnabled: true, passthroughEnabled: true,
      repositoryIds: new Set([String(REPO_ID)]), ownerIds: new Set(['57884877']) };
    const onEvent = createGitHubWebhookAdmissionHandler({
      config, admission: { admit: vi.fn() } as any, passthroughShip: ship as any,
      mergeGroupGate: async () => ({ status: 'passthrough', repositoryId: REPO_ID, repository: 'exampleorg/dashboard',
        headSha: GROUP.headSha, baseSha: BASE }),
    });
    const instance = createActionDispatchApp({
      verifier: { verify: vi.fn() } as any, admission: { admit: vi.fn() } as any,
      resolveInstallationId: vi.fn(), databaseReady: vi.fn(async () => true),
      allowAppGate: true, githubWebhook: { secret: SECRET, onEvent },
    });
    const body = { action: 'checks_requested' };
    const raw = JSON.stringify(body);
    const response = await request(instance).post('/api/webhooks/github')
      .set('Content-Type', 'application/json').set('X-GitHub-Event', 'merge_group').set('X-GitHub-Delivery', 'delivery-mg')
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`).send(raw);
    expect(response.status).toBe(200);
    expect(ship.publishMergeGroup).toHaveBeenCalledWith({ ...GROUP });
    expect(ship.publish).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({ status: 'passthrough', passthroughCheck: { checkId: 11 } });
  });
});
