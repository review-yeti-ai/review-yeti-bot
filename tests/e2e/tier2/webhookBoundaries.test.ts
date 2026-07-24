import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { createApp } from '@src/app';

function signPayload(body: any, secret = 'development-webhook-secret-key-12345'): string {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', secret);
  return 'sha256=' + hmac.update(raw).digest('hex');
}

describe('Tier 2 Boundary & Corner Case Tests: Webhook Receiver & GitHub Event Processing', () => {
  let harness: E2ETestHarness;
  let app: any;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier2-webhook-suite',
    });
    app = createApp();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.mockGithub.reset();
    harness.mockOmniRoute.resetState();
  });

  test('1. Invalid HMAC signatures boundary - rejects request with 401 status when signature does not match', async () => {
    const payload = { action: 'opened', number: 1 };
    const invalidSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', invalidSignature)
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or missing signature');
  });

  test('2. Missing X-Hub-Signature-256 header boundary - rejects request with 401 status when header is missing', async () => {
    const payload = { action: 'opened', number: 1 };

    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or missing signature');
  });

  test('3. Zero-byte body payloads boundary - handles empty or zero-byte JSON payloads safely', async () => {
    const emptyPayload = {};
    const signature = signPayload(emptyPayload);

    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'ping')
      .set('X-Hub-Signature-256', signature)
      .set('Content-Type', 'application/json')
      .send(emptyPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pong');
  });

  test('4. Unsupported webhook events boundary - acknowledges non-PR events with status 200 without error', async () => {
    const payload = { action: 'created', ref: 'refs/heads/main' };
    const signature = signPayload(payload);

    const unsupportedEvents = ['push', 'release', 'workflow_run', 'star', 'fork'];

    for (const eventName of unsupportedEvents) {
      const res = await request(app)
        .post('/api/webhook/github')
        .set('X-GitHub-Event', eventName)
        .set('X-Hub-Signature-256', signature)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('received');
      expect(res.body.event).toBe(eventName);
    }
  });

  test('5. Rate limited GitHub REST responses boundary - handles API errors gracefully during PR file fetching', async () => {
    // Configure mock GitHub server to fail file fetches with 429 Rate Limit
    harness.mockGithub.configure({
      failFilesRequest: true,
      filesFailStatus: 429,
    });

    const prPayload = {
      action: 'opened',
      number: 101,
      pull_request: {
        number: 101,
        title: '[PROJ-101] feat: add new feature',
        body: 'PR description including testing steps and risk assessment',
        head: { sha: 'head-sha-123' },
        base: { sha: 'base-sha-123' },
      },
      repository: {
        name: 'ai-workspace',
        owner: { login: 'calltelemetry' },
      },
    };

    const signature = signPayload(prPayload);

    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', signature)
      .set('Content-Type', 'application/json')
      .send(prPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.prNumber).toBe(101);
  });
});
