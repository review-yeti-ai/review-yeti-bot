import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setupE2ETestHarness, E2ETestHarness } from '../e2e/harness/e2eTestRunner';
import { createApp } from '../../src/app';

function signPayload(body: any, secret = 'development-webhook-secret-key-12345'): string {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', secret);
  return 'sha256=' + hmac.update(raw).digest('hex');
}

describe('Milestone 4: Webhook Event Loop Integration Test Suite', () => {
  let harness: E2ETestHarness;
  let app: any;
  let tempConstitutionPath: string;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'm4-webhook-integration-suite',
    });
    app = createApp();

    // Create temporary constitution file for testing
    const tempDir = os.tmpdir();
    tempConstitutionPath = path.join(tempDir, `test-constitution-${Date.now()}.md`);
    const constitutionContent = `
# Engineering Constitution

## Forbidden Patterns
- Prohibit direct eval execution \`/eval\\(.*?\\)/\`.

## Directives
- PR description MUST contain detailed testing steps.
`;
    fs.writeFileSync(tempConstitutionPath, constitutionContent, 'utf-8');
    process.env.CT_REVIEW_CONSTITUTION_PATH = tempConstitutionPath;
  });

  afterAll(async () => {
    await harness.teardown();
    if (fs.existsSync(tempConstitutionPath)) {
      fs.unlinkSync(tempConstitutionPath);
    }
  });

  beforeEach(() => {
    harness.mockGithub.reset();
    harness.mockOmniRoute.resetState();
  });

  test('1. Full Approval Flow — Valid ticket, compliant constitution, clean code returns APPROVE', async () => {
    const prPayload = {
      action: 'opened',
      number: 201,
      pull_request: {
        number: 201,
        title: '[PROJ-201] feat: add secure token parser',
        body: 'Implements JWT parsing. Testing steps: run unit tests.',
        head: { sha: 'sha-clean-1' },
        base: { sha: 'sha-base-0' },
        changed_files: [
          {
            path: 'src/parser.ts',
            content: 'export function parse(input: string) { return JSON.parse(input); }',
            patch: '@@ -0,0 +1,1 @@\n+export function parse(input: string) { return JSON.parse(input); }',
          },
        ],
      },
      repository: {
        name: 'ai-workspace',
        owner: { login: 'calltelemetry' },
      },
      sender: { login: 'developer1' },
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
    expect(res.body.prNumber).toBe(201);
    expect(res.body.ticketValid).toBe(true);
    expect(res.body.constitutionCompliant).toBe(true);
    expect(res.body.decision).toBe('APPROVE');

    // Verify mock GitHub server recorded the review
    const reviews = harness.mockGithub.getRecordedReviews(201);
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    const lastReview = reviews[reviews.length - 1];
    expect(lastReview.event).toBe('APPROVE');
  });

  test('2. Ticket Gating Short-Circuit — Missing ticket short-circuits to REQUEST_CHANGES without LLM calls', async () => {
    const prPayload = {
      action: 'opened',
      number: 202,
      pull_request: {
        number: 202,
        title: 'feat: add feature without ticket ID',
        body: 'Missing ticket ID in title and description but has testing steps.',
        head: { sha: 'sha-noticket-1' },
        base: { sha: 'sha-base-0' },
        changed_files: [
          {
            path: 'src/utils.ts',
            content: 'export const x = 1;',
          },
        ],
      },
      repository: {
        name: 'ai-workspace',
        owner: { login: 'calltelemetry' },
      },
      sender: { login: 'developer2' },
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
    expect(res.body.prNumber).toBe(202);
    expect(res.body.ticketValid).toBe(false);
    expect(res.body.decision).toBe('REQUEST_CHANGES');

    // Verify 0 OmniRoute LLM requests were recorded due to short-circuit
    expect(harness.mockOmniRoute.getRecordedRequests().length).toBe(0);

    // Verify review recorded on Mock GitHub Server with REQUEST_CHANGES
    const reviews = harness.mockGithub.getRecordedReviews(202);
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    const lastReview = reviews[reviews.length - 1];
    expect(lastReview.event).toBe('REQUEST_CHANGES');
  });

  test('3. Constitution Gating Short-Circuit — Violating constitution short-circuits to REQUEST_CHANGES', async () => {
    const prPayload = {
      action: 'opened',
      number: 203,
      pull_request: {
        number: 203,
        title: '[PROJ-203] feat: update core logic with unsafe eval',
        body: 'PR description with testing steps.',
        head: { sha: 'sha-badconst-1' },
        base: { sha: 'sha-base-0' },
        changed_files: [
          {
            path: 'src/core.ts',
            content: 'export const y = eval(input);', // Violates forbidden pattern eval()
          },
        ],
      },
      repository: {
        name: 'ai-workspace',
        owner: { login: 'calltelemetry' },
      },
      sender: { login: 'developer3' },
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
    expect(res.body.prNumber).toBe(203);
    expect(res.body.constitutionCompliant).toBe(false);
    expect(res.body.decision).toBe('REQUEST_CHANGES');
  });

  test('4. Re-Review Trigger (@ct-review review) — Comment command triggers review pass', async () => {
    const commentPayload = {
      action: 'created',
      issue: {
        number: 201,
        pull_request: {},
        title: '[PROJ-201] feat: add secure token parser',
        body: 'Testing steps included',
      },
      comment: {
        id: 555,
        body: '@ct-review review please re-check PR',
      },
      repository: {
        name: 'ai-workspace',
        owner: { login: 'calltelemetry' },
      },
      sender: { login: 'reviewer1' },
    };

    const signature = signPayload(commentPayload);

    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'issue_comment')
      .set('X-Hub-Signature-256', signature)
      .set('Content-Type', 'application/json')
      .send(commentPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('triggered');
    expect(res.body.event).toBe('issue_comment');
    expect(res.body.prNumber).toBe(201);
  });

  test('5. Incremental Diff Delta Filtering — Subsequent PR commit with unchanged hunks skips LLM re-analysis', async () => {
    const commit1Payload = {
      action: 'opened',
      number: 205,
      pull_request: {
        number: 205,
        title: '[PROJ-205] feat: initial commit',
        body: 'PR description with testing steps included.',
        head: { sha: 'sha-diff-v1' },
        base: { sha: 'sha-base-0' },
        changed_files: [
          {
            path: 'src/stable.ts',
            content: 'export function stable() { return true; }',
            patch: '@@ -0,0 +1,1 @@\n+export function stable() { return true; }',
          },
        ],
      },
      repository: {
        name: 'ai-workspace',
        owner: { login: 'calltelemetry' },
      },
      sender: { login: 'developer5' },
    };

    const sig1 = signPayload(commit1Payload);

    const res1 = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', sig1)
      .set('Content-Type', 'application/json')
      .send(commit1Payload);

    expect(res1.status).toBe(200);
    expect(res1.body.decision).toBe('APPROVE');

    const omniCallsAfterFirstCommit = harness.mockOmniRoute.getRecordedRequests().length;

    // Send second commit with identical hunks / files
    const commit2Payload = {
      ...commit1Payload,
      action: 'synchronize',
      pull_request: {
        ...commit1Payload.pull_request,
        head: { sha: 'sha-diff-v2' },
      },
    };

    const sig2 = signPayload(commit2Payload);

    const res2 = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', sig2)
      .set('Content-Type', 'application/json')
      .send(commit2Payload);

    expect(res2.status).toBe(200);
    expect(res2.body.decision).toBe('APPROVE');

    // OmniRoute LLM calls count should be unchanged on second commit because diff delta was unchanged
    expect(harness.mockOmniRoute.getRecordedRequests().length).toBe(omniCallsAfterFirstCommit);
  });

  test('6. Draft PR Guard — Webhook ignores and skips automated review execution when PR is marked as draft', async () => {
    const draftPayload = {
      action: 'opened',
      number: 206,
      pull_request: {
        number: 206,
        draft: true,
        title: '[PROJ-206] draft: work in progress',
        body: 'PR is still a work in progress',
        head: { sha: 'sha-draft-1' },
        base: { sha: 'sha-base-0' },
      },
      repository: {
        name: 'ai-workspace',
        owner: { login: 'calltelemetry' },
      },
      sender: { login: 'developer6' },
    };

    const signature = signPayload(draftPayload);

    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', signature)
      .set('Content-Type', 'application/json')
      .send(draftPayload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toBe('PR is a draft');
  });
});

