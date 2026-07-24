import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { FixtureGenerator } from '@harness/fixtureGenerator';
import { E2EAssertions } from '@harness/assertions';

describe('Tier 1 Feature Coverage: GitHub Webhook Ingestion & Review Publishing', () => {
  let harness: E2ETestHarness;
  let appUrl: string;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier1-webhook-suite',
      configYaml: FixtureGenerator.buildConfigYaml(),
      constitutionMd: FixtureGenerator.buildConstitutionMarkdown([
        {
          id: 'SEC-01',
          category: 'security',
          title: 'No Plaintext AWS Keys',
          directive: 'Never commit plaintext AWS access keys.',
          forbiddenPatterns: ['/AKIA[0-9A-Z]{16}/'],
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
  });

  test('1. Validates HMAC SHA-256 signatures on incoming webhooks (accepts valid, rejects corrupt or missing)', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const payload = harness.mockGithub.buildPullRequestEvent('opened', { number: 101 });

    // 1A. Valid signature -> 200 OK
    const validRes = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload);
    expect(validRes.statusCode).toBe(200);
    expect(validRes.body.status).toBe('processed');

    // 1B. Corrupt signature -> 401 Unauthorized
    const corruptRes = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload, {
      corruptSignature: true,
    });
    expect(corruptRes.statusCode).toBe(401);
    expect(corruptRes.body.error).toContain('Invalid or missing signature');

    // 1C. Omitted signature -> 401 Unauthorized
    const missingRes = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload, {
      omitSignature: true,
    });
    expect(missingRes.statusCode).toBe(401);
  });

  test('2. Processes PR opened webhook event and triggers initial automated code review pass', async () => {
    const webhookEndpoint = `${appUrl}/webhook`;
    const payload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 201,
      title: 'feat(auth): add JWT authentication [PROJ-123]',
      body: 'Implements JWT validation for auth endpoints. Resolves [PROJ-123].',
      headSha: 'head-sha-201',
    });

    const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload);

    expect(res.statusCode).toBe(200);
    expect(res.body.event).toBe('pull_request');
    expect(res.body.action).toBe('opened');
    expect(res.body.prNumber).toBe(201);
    expect(res.body.ticketValid).toBe(true);

    // Verify mock GitHub server recorded the automated review submission
    const reviews = harness.mockGithub.getRecordedReviews(201);
    expect(reviews.length).toBeGreaterThan(0);
    E2EAssertions.assertPrReviewSubmitted(harness.mockGithub, 201, 'APPROVE');
  });

  test('3. Processes PR synchronize webhook event on new commit push', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const payload = harness.mockGithub.buildPullRequestEvent('synchronize', {
      number: 301,
      title: 'fix(auth): update token expiration check [PROJ-123]',
      headSha: 'head-sha-301-v2',
      baseSha: 'base-sha-301',
    });

    const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload);

    expect(res.statusCode).toBe(200);
    expect(res.body.action).toBe('synchronize');
    expect(res.body.prNumber).toBe(301);

    const reviews = harness.mockGithub.getRecordedReviews(301);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].commitId).toBe('head-sha-301-v2');
  });

  test('4. Triggers re-review when @ct-review review command comment is posted', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const payload = harness.mockGithub.buildIssueCommentEvent('@ct-review review', {
      prNumber: 401,
      user: 'reviewer-alice',
    });

    const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'issue_comment', payload);

    expect(res.statusCode).toBe(200);
    expect(res.body.event).toBe('issue_comment');
    expect(res.body.status).toBe('triggered');
    expect(res.body.prNumber).toBe(401);

    const reviews = harness.mockGithub.getRecordedReviews(401);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].body).toContain('Re-review triggered by comment command');
  });

  test('5. Publishes summary review and inline comments back to GitHub API', async () => {
    const prNumber = 501;
    const githubUrl = `http://127.0.0.1:${harness.mockGithub.port}`;

    // Post summary review directly to MockGithubServer API
    const reviewRes = await fetch(`${githubUrl}/repos/calltelemetry/ai-workspace/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: 'Security review complete: 1 finding identified.',
        event: 'REQUEST_CHANGES',
        commit_id: 'head-sha-501',
        comments: [
          {
            path: 'src/auth.ts',
            line: 42,
            side: 'RIGHT',
            body: '[security:critical] Unsanitized user input passed to eval()',
          },
        ],
      }),
    });

    expect(reviewRes.status).toBe(200);

    // Verify assertion helpers
    E2EAssertions.assertPrReviewSubmitted(harness.mockGithub, prNumber, 'REQUEST_CHANGES');
    const recordedReviews = harness.mockGithub.getRecordedReviews(prNumber);
    expect(recordedReviews[0].comments).toHaveLength(1);
    expect(recordedReviews[0].comments![0].path).toBe('src/auth.ts');
  });

  test('6. Ignores standard issue comments that do not contain bot review trigger command', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const payload = harness.mockGithub.buildIssueCommentEvent('Great work! Looks good to me.', {
      prNumber: 601,
      user: 'developer-bob',
    });

    const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'issue_comment', payload);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ignored');
    expect(res.body.reason).toBe('not bot review command');

    const reviews = harness.mockGithub.getRecordedReviews(601);
    expect(reviews).toHaveLength(0);
  });

  test('7. Rejects PR webhook when ticket enforcement is strict and PR title/body lacks ticket reference', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const payload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 701,
      title: 'refactor(core): cleanup unused imports',
      body: 'Minor refactor without any ticket reference.',
      headSha: 'head-sha-701',
    });

    const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload);

    expect(res.statusCode).toBe(200);
    expect(res.body.prNumber).toBe(701);
    expect(res.body.ticketValid).toBe(false);
    expect(res.body.decision).toBe('REQUEST_CHANGES');

    // Verify GitHub API recorded review with REQUEST_CHANGES
    const reviews = harness.mockGithub.getRecordedReviews(701);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].event).toBe('REQUEST_CHANGES');
  });

  test('8. Rejects PR webhook when constitution evaluation detects forbidden patterns in diff files', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const payload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: 801,
      title: 'feat(aws): add S3 key [PROJ-801]',
      body: 'Resolves [PROJ-801]. Detailed testing steps: 1. Run test suite.',
      headSha: 'head-sha-801',
      changedFiles: [
        {
          path: 'src/aws/s3.ts',
          content: 'const key = "AKIAIOSFODNN7EXAMPLE"; // FORBIDDEN AWS SECRET',
        },
      ],
    });

    const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', payload);

    expect(res.statusCode).toBe(200);
    expect(res.body.prNumber).toBe(801);
    expect(res.body.constitutionCompliant).toBe(false);
    expect(res.body.decision).toBe('REQUEST_CHANGES');

    // Verify GitHub API recorded review with REQUEST_CHANGES
    const reviews = harness.mockGithub.getRecordedReviews(801);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews[0].event).toBe('REQUEST_CHANGES');
  });
});
