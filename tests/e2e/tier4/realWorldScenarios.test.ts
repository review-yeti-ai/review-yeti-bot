import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { FixtureGenerator } from '@harness/fixtureGenerator';
import { E2EAssertions } from '@harness/assertions';

describe('Tier 4 Real-World Application PR Workflow Scenarios', () => {
  let harness: E2ETestHarness;
  let appUrl: string;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier4-real-world-scenarios-suite',
      configYaml: FixtureGenerator.buildConfigYaml({
        quorum: {
          minApprovals: 2,
          personas: ['security', 'architecture', 'performance', 'quality'],
          effortLevel: 'medium',
        },
        ticketEnforcement: {
          required: true,
          providers: ['linear', 'jira', 'github'],
          patterns: ['\\[[A-Z]+-\\d+\\]', '#\\d+'],
        },
        constitution: {
          enabled: true,
          path: '.github/constitution.md',
        },
      }),
      constitutionMd: FixtureGenerator.buildConstitutionMarkdown([
        {
          id: 'SEC-01',
          category: 'security',
          title: 'No Hardcoded AWS Secrets',
          directive: 'Never commit hardcoded AWS access key ID patterns in source code.',
          forbiddenPatterns: ['/AKIA[0-9A-Z]{16}/'],
        },
        {
          id: 'ARCH-01',
          category: 'architecture',
          title: 'Modular Boundary Strictness',
          directive: 'Modules must maintain clear isolation and public API contracts.',
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

  test('Scenario 1: Enterprise Microservice Refactor PR Lifecycle', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const prNumber = 801;

    // Seed ticket PROJ-801 in mock ticket provider
    harness.mockTicket.addTicket({
      key: 'PROJ-801',
      provider: 'linear',
      title: 'Enterprise microservice refactor',
      status: 'In Progress',
    });

    // Step 1: Initial PR Opened with ticket [PROJ-801]
    const initialPRPayload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: prNumber,
      title: 'refactor(service): enterprise microservice refactor [PROJ-801]',
      body: 'Refactored auth microservice to improve scalability. Resolves [PROJ-801].',
      headSha: 'sha-proj801-v1',
      baseSha: 'sha-proj801-base',
      changedFiles: [
        {
          path: 'services/auth/src/service.ts',
          content: 'export function processAuthToken(token: string) { return !!token; }',
        },
      ],
    });

    // Deliver PR opened webhook -> src/app.ts runs ticket check, constitution check, 4-persona quorum via OmniRoute
    const res1 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', initialPRPayload);
    expect(res1.statusCode).toBe(200);
    expect(res1.body.status).toBe('processed');
    expect(res1.body.prNumber).toBe(prNumber);
    expect(res1.body.ticketValid).toBe(true);
    expect(res1.body.constitutionCompliant).toBe(true);
    expect(res1.body.decision).toBe('APPROVE');

    // Assert OmniRoute received persona completions natively driven by app.ts
    const omniRequests = harness.mockOmniRoute.getRecordedRequests();
    const chatReqs = omniRequests.filter((r) => r.path === '/v1/chat/completions');
    expect(chatReqs.length).toBeGreaterThanOrEqual(4);

    // Assert GitHub review & comments published natively
    E2EAssertions.assertPrReviewSubmitted(harness.mockGithub, prNumber, 'APPROVE');
    const initialComments = harness.mockGithub.getRecordedInlineComments(prNumber);
    expect(initialComments.length).toBeGreaterThan(0);
    expect(initialComments[0].path).toBe('services/auth/src/service.ts');

    // Step 2: Subsequent Commit Push (Synchronize event with new commit SHA)
    const updatedPRPayload = harness.mockGithub.buildPullRequestEvent('synchronize', {
      number: prNumber,
      title: 'refactor(service): enterprise microservice refactor [PROJ-801]',
      body: 'Refactored auth microservice to improve scalability. Resolves [PROJ-801].',
      headSha: 'sha-proj801-v2',
      baseSha: 'sha-proj801-base',
      changedFiles: [
        {
          path: 'services/auth/src/service.ts',
          content: 'export function processAuthToken(token: string) { return token.length > 10; }',
        },
        {
          path: 'services/auth/src/config.ts',
          content: 'export const AUTH_TIMEOUT = 5000;',
        },
      ],
    });

    const res2 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', updatedPRPayload);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.status).toBe('processed');
    expect(res2.body.decision).toBe('APPROVE');

    // Verify tracked findings state in DB/StateManager
    const trackedFindings = harness.stateManager.getTrackedFindings(harness.ctx, prNumber);
    expect(trackedFindings.length).toBeGreaterThan(0);

    // Verify latest GitHub review reflects the new commit
    const reviews = harness.mockGithub.getRecordedReviews(prNumber);
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    expect(reviews[reviews.length - 1].commitId).toBe('sha-proj801-v2');
    expect(reviews[reviews.length - 1].event).toBe('APPROVE');
  });

  test('Scenario 2: Emergency Hotfix PR Workflow', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const prNumber = 999;

    // Seed ticket HOTFIX-999
    harness.mockTicket.addTicket({
      key: 'HOTFIX-999',
      provider: 'jira',
      title: 'Emergency patch for auth vulnerability',
      status: 'In Progress',
    });

    // Fast-track hotfix PR payload with security vulnerability (eval)
    const hotfixPayload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: prNumber,
      title: 'fix(security): emergency hotfix for auth token leak [HOTFIX-999]',
      body: 'Emergency fast-track patch. Resolves [HOTFIX-999].',
      headSha: 'sha-hotfix-v1',
      baseSha: 'sha-hotfix-base',
      changedFiles: [
        {
          path: 'src/security/auth.ts',
          content: 'export function emergencyValidate(input: string) { return eval(input); }',
        },
      ],
    });

    const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', hotfixPayload);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.prNumber).toBe(prNumber);
    expect(res.body.ticketValid).toBe(true);
    expect(res.body.decision).toBe('REQUEST_CHANGES');

    // Assert GitHub recorded REQUEST_CHANGES review natively published
    E2EAssertions.assertPrReviewSubmitted(harness.mockGithub, prNumber, 'REQUEST_CHANGES');

    // Assert inline comments contain security critical finding
    const comments = harness.mockGithub.getRecordedInlineComments(prNumber);
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0].path).toBe('src/security/auth.ts');
    expect(comments[0].body).toContain('security');
  });

  test('Scenario 3: Monorepo Multi-Module PR with OmniRoute Provider Failover', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const prNumber = 303;

    // Seed ticket PROJ-303
    harness.mockTicket.addTicket({
      key: 'PROJ-303',
      provider: 'linear',
      title: 'Monorepo multi-module refactor',
      status: 'In Progress',
    });

    // Inject primary provider failover in MockOmniRouteServer (503 Service Unavailable)
    harness.mockOmniRoute.configure({
      failProvider: {
        provider: 'openai',
        status: 503,
        message: 'Primary LLM Service Unavailable',
        failCount: 4,
      },
    });

    // Monorepo multi-module PR payload modifying multiple packages
    const multiModulePRPayload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: prNumber,
      title: 'refactor(monorepo): update auth, billing, and api packages [PROJ-303]',
      body: 'Refactors shared dependencies across packages. Resolves [PROJ-303].',
      headSha: 'sha-monorepo-v1',
      baseSha: 'sha-monorepo-base',
      changedFiles: [
        {
          path: 'packages/auth/src/index.ts',
          content: 'export const authService = { validate: () => true };',
        },
        {
          path: 'packages/billing/src/index.ts',
          content: 'export const billingService = { process: () => true };',
        },
        {
          path: 'packages/api/src/index.ts',
          content: 'export const apiServer = { listen: () => {} };',
        },
      ],
    });

    const res = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', multiModulePRPayload);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('processed');
    expect(res.body.decision).toBe('APPROVE');

    // Verify OmniRoute request history shows failover: primary 'openai' failed, fallback 'anthropic' succeeded
    const omniRequests = harness.mockOmniRoute.getRecordedRequests();
    const chatReqs = omniRequests.filter((r) => r.path === '/v1/chat/completions');
    expect(chatReqs.length).toBeGreaterThan(0);

    const primaryReqs = chatReqs.filter((r) => r.body?.provider === 'openai');
    const fallbackReqs = chatReqs.filter((r) => r.body?.provider === 'anthropic');
    expect(primaryReqs.length).toBeGreaterThan(0);
    expect(fallbackReqs.length).toBeGreaterThan(0);

    // Assert GitHub review published natively
    E2EAssertions.assertPrReviewSubmitted(harness.mockGithub, prNumber, 'APPROVE');
  });

  test('Scenario 4: Contributor PR with Missing Ticket & Secret Exposure Remediation', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const prNumber = 404;

    // Seed ticket SEC-404
    harness.mockTicket.addTicket({
      key: 'SEC-404',
      provider: 'linear',
      title: 'Remediate secret exposure and add S3 helper',
      status: 'In Progress',
    });

    // Step 1: PR opened without ticket AND containing hardcoded AWS secret key
    const invalidPRPayload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: prNumber,
      title: 'feat(storage): add S3 file uploader helper',
      body: 'Adds S3 file helper.',
      headSha: 'sha-sec404-v1',
      baseSha: 'sha-sec404-base',
      changedFiles: [
        {
          path: 'src/storage/s3.ts',
          content: 'const accessKey = "AKIAIOSFODNN7EXAMPLE"; // HARDCODED SECRET',
        },
      ],
    });

    const res1 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', invalidPRPayload);
    expect(res1.statusCode).toBe(200);
    expect(res1.body.prNumber).toBe(prNumber);
    expect(res1.body.ticketValid).toBe(false);
    expect(res1.body.constitutionCompliant).toBe(false);
    expect(res1.body.decision).toBe('REQUEST_CHANGES');

    // Verify GitHub API recorded review with REQUEST_CHANGES
    E2EAssertions.assertPrReviewSubmitted(harness.mockGithub, prNumber, 'REQUEST_CHANGES');

    // Verify OmniRoute LLM calls were skipped due to ticket/constitution gate block
    const omniRequestsBeforeRemediation = harness.mockOmniRoute.getRecordedRequests();
    const pr404OmniBefore = omniRequestsBeforeRemediation.filter((r) => JSON.stringify(r.body || {}).includes('404'));
    expect(pr404OmniBefore).toHaveLength(0);

    // Step 2: Remediation — Author updates title with [SEC-404] and removes hardcoded secret
    const remediatedPRPayload = harness.mockGithub.buildPullRequestEvent('synchronize', {
      number: prNumber,
      title: 'feat(storage): add S3 file uploader helper [SEC-404]',
      body: 'Adds S3 file helper using environment configuration. Resolves [SEC-404].',
      headSha: 'sha-sec404-v2',
      baseSha: 'sha-sec404-base',
      changedFiles: [
        {
          path: 'src/storage/s3.ts',
          content: 'const accessKey = process.env.AWS_ACCESS_KEY_ID;',
        },
      ],
    });

    const res2 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', remediatedPRPayload);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.prNumber).toBe(prNumber);
    expect(res2.body.ticketValid).toBe(true);
    expect(res2.body.constitutionCompliant).toBe(true);
    expect(res2.body.decision).toBe('APPROVE');

    // Verify GitHub API recorded updated review with APPROVE
    const reviews = harness.mockGithub.getRecordedReviews(prNumber);
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    expect(reviews[reviews.length - 1].event).toBe('APPROVE');
  });

  test('Scenario 5: Multi-commit Nit Suppression & Diff State Preservation', async () => {
    const webhookEndpoint = `${appUrl}/api/webhook/github`;
    const prNumber = 505;

    // Seed ticket PROJ-505
    harness.mockTicket.addTicket({
      key: 'PROJ-505',
      provider: 'jira',
      title: 'Process incoming events',
      status: 'In Progress',
    });

    // Step 1: Commit 1 generates initial review and inline nit comments
    const commit1Payload = harness.mockGithub.buildPullRequestEvent('opened', {
      number: prNumber,
      title: 'feat(service): process incoming events [PROJ-505]',
      body: 'Adds event processing. Resolves [PROJ-505].',
      headSha: 'sha-commit-1',
      baseSha: 'sha-base',
      changedFiles: [
        {
          path: 'src/services/eventProcessor.ts',
          content: 'export function processEvent(e: any) { return e.id; }',
        },
      ],
    });

    const res1 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', commit1Payload);
    expect(res1.statusCode).toBe(200);
    expect(res1.body.status).toBe('processed');
    expect(res1.body.decision).toBe('APPROVE');

    const commentsCommit1 = harness.mockGithub.getRecordedInlineComments(prNumber);
    expect(commentsCommit1.length).toBeGreaterThan(0);

    // Step 2: Commit 2 updates an unrelated file
    const commit2Payload = harness.mockGithub.buildPullRequestEvent('synchronize', {
      number: prNumber,
      title: 'feat(service): process incoming events [PROJ-505]',
      body: 'Adds event processing. Resolves [PROJ-505].',
      headSha: 'sha-commit-2',
      baseSha: 'sha-base',
      changedFiles: [
        {
          path: 'src/services/eventProcessor.ts',
          content: 'export function processEvent(e: any) { return e.id; }',
        },
        {
          path: 'src/utils/logger.ts',
          content: 'export function logInfo(msg: string) { console.log(msg); }',
        },
      ],
    });

    const res2 = await harness.mockGithub.deliverWebhook(webhookEndpoint, 'pull_request', commit2Payload);
    expect(res2.statusCode).toBe(200);
    expect(res2.body.status).toBe('processed');
    expect(res2.body.decision).toBe('APPROVE');

    // Verify Diff State Manager preserved tracked findings state for prNumber 505
    const trackedFindings = harness.stateManager.getTrackedFindings(harness.ctx, prNumber);
    expect(trackedFindings.length).toBeGreaterThan(0);
  });
});
