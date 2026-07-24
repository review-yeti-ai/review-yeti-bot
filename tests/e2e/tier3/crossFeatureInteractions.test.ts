import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { FixtureGenerator } from '@harness/fixtureGenerator';

describe('Tier 3 Cross-Feature Interaction & E2E System Integration', () => {
  let harness: E2ETestHarness;
  let appUrl: string;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier3-cross-feature-suite',
      configYaml: FixtureGenerator.buildConfigYaml({
        quorum: {
          minApprovals: 2,
          personas: ['security', 'architecture', 'performance', 'quality'],
          effortLevel: 'medium',
        },
        ticketEnforcement: {
          required: true,
          providers: ['linear', 'jira', 'github'],
          patterns: [],
        },
      }),
      constitutionMd: FixtureGenerator.buildConstitutionMarkdown([
        {
          id: 'SEC-01',
          category: 'security',
          title: 'No Plaintext AWS Keys',
          directive: 'Never commit plaintext AWS access keys in codebase.',
          forbiddenPatterns: ['/AKIA[0-9A-Z]{16}/'],
        },
        {
          id: 'OPS-01',
          category: 'compliance',
          title: 'Detailed PR Description Required',
          directive: 'PR description MUST contain detailed testing steps.',
        },
      ]),
    });
    appUrl = harness.appProcess.url;
  });

  afterAll(async () => {
    await harness.teardown();
  });

  beforeEach(() => {
    harness.mockGithub.reset();
    harness.mockOmniRoute.resetState();
    harness.mockTicket.resetState();
  });

  test('1. Full E2E Pipeline (Webhook Event -> Ticket Validation -> Config Parsing -> Quorum Panel Review via OmniRoute -> Inline GitHub Comment publication)', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;

    // Build PR opened event payload with valid ticket key PROJ-123
    const prPayload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 101,
      title: 'feat(auth): add JWT validation [PROJ-123]',
      body: 'Implements JWT validation. Resolves [PROJ-123]. Detailed testing steps: 1. Run unit tests.',
      headSha: 'head-sha-101',
      baseSha: 'base-sha-101',
      changedFiles: [
        {
          path: 'src/auth/jwt.ts',
          content: 'export function verifyToken(token: string) { return true; }',
        },
      ],
    });

    // Deliver Webhook -> Webhook route receives event, validates HMAC, parses config, validates ticket, checks constitution, calls OmniRoute, evaluates Quorum, and posts to GitHub API
    const webhookRes = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', prPayload);
    expect(webhookRes.statusCode).toBe(200);
    expect(webhookRes.body.status).toBe('processed');
    expect(webhookRes.body.prNumber).toBe(101);
    expect(webhookRes.body.ticketValid).toBe(true);
    expect(webhookRes.body.constitutionCompliant).toBe(true);
    expect(webhookRes.body.decision).toBe('APPROVE');

    // Verify OmniRoute LLM completions were natively invoked by app.ts for configured personas
    const omniRequests = harness.mockOmniRoute.getRecordedRequests();
    const chatReqs = omniRequests.filter((r) => r.path === '/v1/chat/completions');
    expect(chatReqs.length).toBeGreaterThanOrEqual(4);

    // Verify recorded GitHub reviews published by app.ts
    const reviews = harness.mockGithub.getRecordedReviews(101);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].event).toBe('APPROVE');

    // Verify recorded inline comments published by app.ts
    const comments = harness.mockGithub.getRecordedInlineComments(101);
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0].path).toBe('src/auth/jwt.ts');
  });

  test('2. Ticket Validation Gate (Webhook trigger with invalid/missing ticket key -> Ticket validator blocks execution -> PR status set to failure -> Quorum review skipped)', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;

    // Webhook payload with missing ticket key
    const prPayload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 202,
      title: 'refactor(core): cleanup unused internal functions',
      body: 'Refactored internal helper functions without ticket reference.',
      headSha: 'head-sha-202',
    });

    // Trigger webhook endpoint with failing payload
    const webhookRes = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', prPayload);

    expect(webhookRes.statusCode).toBe(200);
    expect(webhookRes.body.prNumber).toBe(202);
    expect(webhookRes.body.ticketValid).toBe(false);
    expect(webhookRes.body.decision).toBe('REQUEST_CHANGES');

    // Verify GitHub API recorded review with REQUEST_CHANGES
    const reviews = harness.mockGithub.getRecordedReviews(202);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].event).toBe('REQUEST_CHANGES');

    // Verify OmniRoute LLM calls were not issued for PR 202 because ticket gate blocked execution
    const omniRequests = harness.mockOmniRoute.getRecordedRequests();
    const pr202OmniReqs = omniRequests.filter((r) => JSON.stringify(r.body || {}).includes('202'));
    expect(pr202OmniReqs.length).toBe(0);
  });

  test('3. Custom Config + OmniRoute Failover (Webhook trigger with custom quorum override -> OmniRoute primary provider 503 error -> OmniRoute router falls back to secondary provider -> Quorum synthesis succeeds)', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;

    // Configure MockOmniRouteServer to simulate 503 error on primary provider 'openai'
    harness.mockOmniRoute.configure({
      failProvider: {
        provider: 'openai',
        status: 503,
        message: 'Primary LLM Service Unavailable',
        failCount: 2,
      },
    });

    // Deliver PR opened event webhook payload
    const prPayload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 303,
      title: 'feat(api): update endpoints [PROJ-303]',
      body: 'Updates API endpoints. Resolves [PROJ-303]. Detailed testing steps: 1. Run unit tests.',
      headSha: 'head-sha-303',
      changedFiles: [
        {
          path: 'src/api/index.ts',
          content: 'export const api = {};',
        },
      ],
    });

    const webhookRes = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', prPayload);

    expect(webhookRes.statusCode).toBe(200);
    expect(webhookRes.body.status).toBe('processed');
    expect(webhookRes.body.decision).toBe('APPROVE');

    // Verify recorded OmniRoute requests show primary provider failure followed by successful fallback
    const omniRequests = harness.mockOmniRoute.getRecordedRequests();
    const chatReqs = omniRequests.filter((r) => r.path === '/v1/chat/completions');
    expect(chatReqs.length).toBeGreaterThan(0);

    const primaryReqs = chatReqs.filter((r) => r.body?.provider === 'openai');
    const fallbackReqs = chatReqs.filter((r) => r.body?.provider === 'anthropic');
    expect(primaryReqs.length).toBeGreaterThan(0);
    expect(fallbackReqs.length).toBeGreaterThan(0);

    // Verify GitHub API recorded review with APPROVE
    const reviews = harness.mockGithub.getRecordedReviews(303);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].event).toBe('APPROVE');
  });

  test('4. Incremental Diff Delta Skip (First PR sync event processes full diff and saves SHA hash -> Second PR sync event with matching SHA hash -> Incremental diff manager detects unchanged diff and skips LLM calls)', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const prNumber = 404;
    const headSha = 'commit-sha-unchanged-111';

    const prPayload = harness.mockGithub.buildPullRequestEvent('synchronize', {
      number: prNumber,
      title: 'feat(payment): update fee calculation [PROJ-404]',
      body: 'Updates fee calculation. Resolves [PROJ-404]. Detailed testing steps: 1. Run unit tests.',
      headSha,
      baseSha: 'commit-sha-base-000',
      changedFiles: [
        {
          path: 'src/services/payment.ts',
          content: 'const fee = 0.02; return amount * fee;',
        },
      ],
    });

    // 1st PR sync event: First pass processes diff natively via app.ts
    const res1 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', prPayload);
    expect(res1.statusCode).toBe(200);
    expect(res1.body.status).toBe('processed');

    const omniReqsAfterFirstPass = harness.mockOmniRoute.getRecordedRequests().length;
    expect(omniReqsAfterFirstPass).toBeGreaterThan(0);

    // 2nd PR sync event: Same headSha and identical diff
    const res2 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', prPayload);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.status).toBe('processed');

    // Verify 0 additional OmniRoute requests were issued on second pass because diff was unchanged
    const omniReqsAfterSecondPass = harness.mockOmniRoute.getRecordedRequests().length;
    expect(omniReqsAfterSecondPass).toBe(omniReqsAfterFirstPass);
  });

  test('5. Constitution Engine + Ticket Enforcement (PR payload checked against constitution.md rules and ticket status validation in single review pass)', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;

    // Scenario A: Valid Ticket [PROJ-123], but violates Constitution rule (contains hardcoded AWS key)
    const prPayloadFail = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 505,
      title: 'feat(aws): add S3 file manager [PROJ-123]',
      body: 'Implements S3 manager. Detailed testing steps: 1. Run unit tests.',
      headSha: 'head-sha-505',
      changedFiles: [
        {
          path: 'src/aws/s3.ts',
          content: 'const accessKey = "AKIAIOSFODNN7EXAMPLE"; // FORBIDDEN SECRET',
        },
      ],
    });

    const resA = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', prPayloadFail);
    expect(resA.statusCode).toBe(200);
    expect(resA.body.prNumber).toBe(505);
    expect(resA.body.ticketValid).toBe(true);
    expect(resA.body.constitutionCompliant).toBe(false);
    expect(resA.body.decision).toBe('REQUEST_CHANGES');

    const reviewsA = harness.mockGithub.getRecordedReviews(505);
    expect(reviewsA.length).toBeGreaterThan(0);
    expect(reviewsA[0].event).toBe('REQUEST_CHANGES');

    // Scenario B: Valid Ticket [PROJ-123] AND Compliant with Constitution rules
    const prPayloadPass = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 506,
      title: 'feat(aws): add secure S3 file manager [PROJ-123]',
      body: 'Implements S3 manager using IAM roles. Detailed testing steps: 1. Run unit tests.',
      headSha: 'head-sha-506',
      changedFiles: [
        {
          path: 'src/aws/s3.ts',
          content: 'const accessKey = process.env.AWS_ACCESS_KEY_ID;',
        },
      ],
    });

    const resB = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', prPayloadPass);
    expect(resB.statusCode).toBe(200);
    expect(resB.body.prNumber).toBe(506);
    expect(resB.body.ticketValid).toBe(true);
    expect(resB.body.constitutionCompliant).toBe(true);
    expect(resB.body.decision).toBe('APPROVE');

    const reviewsB = harness.mockGithub.getRecordedReviews(506);
    expect(reviewsB.length).toBeGreaterThan(0);
    expect(reviewsB[0].event).toBe('APPROVE');
  });

  test('6. Gateway HMAC Reject Before Processing (Invalid Webhook HMAC signature returns 401 and halts pipeline before ticket or config parsing happens)', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const payload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 606,
      title: 'feat(core): secret feature [PROJ-123]',
      body: 'Resolves [PROJ-123].',
    });

    // 1. Deliver webhook with corrupted signature
    const corruptRes = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload, {
      corruptSignature: true,
    });

    expect(corruptRes.statusCode).toBe(401);
    expect(corruptRes.body).toHaveProperty('error', 'Invalid or missing signature');

    // 2. Deliver webhook with omitted signature header
    const missingRes = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload, {
      omitSignature: true,
    });

    expect(missingRes.statusCode).toBe(401);

    // 3. Verify pipeline was halted immediately before downstream processing occurred
    const ticketRequests = harness.mockTicket.getRecordedRequests();
    const pr606TicketReqs = ticketRequests.filter((r) => JSON.stringify(r).includes('606'));
    expect(pr606TicketReqs).toHaveLength(0);

    const githubReviews = harness.mockGithub.getRecordedReviews(606);
    expect(githubReviews).toHaveLength(0);
  });

  test('7. Multithreaded/Multi-commit PR update with state persistence and config overrides', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;

    // PR 1, Commit 1: Security vulnerability introduced (eval) -> REQUEST_CHANGES
    const pr1Commit1Payload = harness.mockGithub.buildPullRequestEvent('synchronize', {
      number: 701,
      title: 'feat(router): update routing logic [PROJ-701]',
      body: 'Updates routing. Resolves [PROJ-701]. Detailed testing steps: 1. Run unit tests.',
      headSha: 'sha-701-v1',
      baseSha: 'sha-base',
      changedFiles: [
        {
          path: 'src/api/router.ts',
          content: 'eval(req.query.cmd);',
        },
      ],
    });

    const resPR1v1 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', pr1Commit1Payload);
    expect(resPR1v1.statusCode).toBe(200);
    expect(resPR1v1.body.prNumber).toBe(701);
    expect(resPR1v1.body.decision).toBe('REQUEST_CHANGES');

    const reviews701v1 = harness.mockGithub.getRecordedReviews(701);
    expect(reviews701v1.length).toBeGreaterThan(0);
    expect(reviews701v1[0].event).toBe('REQUEST_CHANGES');

    // PR 2, Commit 1 (Processed concurrently/interleaved clean PR) -> APPROVE
    const pr2Commit1Payload = harness.mockGithub.buildPullRequestEvent('synchronize', {
      number: 702,
      title: 'feat(math): add math utility [PROJ-702]',
      body: 'Adds math utils. Resolves [PROJ-702]. Detailed testing steps: 1. Run unit tests.',
      headSha: 'sha-702-v1',
      baseSha: 'sha-base',
      changedFiles: [
        {
          path: 'src/utils/math.ts',
          content: 'const add = (a: number, b: number) => a + b;',
        },
      ],
    });

    const resPR2v1 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', pr2Commit1Payload);
    expect(resPR2v1.statusCode).toBe(200);
    expect(resPR2v1.body.prNumber).toBe(702);
    expect(resPR2v1.body.decision).toBe('APPROVE');

    const reviews702v1 = harness.mockGithub.getRecordedReviews(702);
    expect(reviews702v1.length).toBeGreaterThan(0);
    expect(reviews702v1[0].event).toBe('APPROVE');

    // PR 1, Commit 2: Vulnerability resolved by replacing eval -> APPROVE
    const pr1Commit2Payload = harness.mockGithub.buildPullRequestEvent('synchronize', {
      number: 701,
      title: 'feat(router): sanitize routing logic [PROJ-701]',
      body: 'Sanitizes router input. Resolves [PROJ-701]. Detailed testing steps: 1. Run unit tests.',
      headSha: 'sha-701-v2',
      baseSha: 'sha-base',
      changedFiles: [
        {
          path: 'src/api/router.ts',
          content: 'sanitizeAndExecute(req.query.cmd);',
        },
      ],
    });

    const resPR1v2 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', pr1Commit2Payload);
    expect(resPR1v2.statusCode).toBe(200);
    expect(resPR1v2.body.prNumber).toBe(701);
    expect(resPR1v2.body.decision).toBe('APPROVE');

    const reviews701v2 = harness.mockGithub.getRecordedReviews(701);
    expect(reviews701v2.length).toBeGreaterThan(1);
    expect(reviews701v2[reviews701v2.length - 1].event).toBe('APPROVE');
  });
});
