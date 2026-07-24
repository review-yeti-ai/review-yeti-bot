import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { MockGithubServer } from '../e2e/harness/mockGithubServer';
import { MockOmniRouteServer } from '../e2e/harness/mockOmniRouteServer';
import { MockTicketServer } from '../e2e/harness/mockTicketServer';
import { FixtureGenerator } from '../e2e/harness/fixtureGenerator';
import { StateManager } from '../e2e/harness/stateManager';
import { E2EAssertions } from '../e2e/harness/assertions';
import { setupE2ETestHarness } from '../e2e/harness/e2eTestRunner';

describe('E2E Harness & Mock Infrastructure Smoke Verification', () => {
  describe('MockGithubServer', () => {
    let mockGithub: MockGithubServer;
    let serverUrl: string;

    beforeAll(async () => {
      mockGithub = new MockGithubServer({ port: 0, webhookSecret: 'test-secret-123' });
      serverUrl = await mockGithub.start();
    });

    afterAll(async () => {
      await mockGithub.stop();
    });

    test('generates valid HMAC SHA-256 signatures', () => {
      const payload = JSON.stringify({ event: 'test' });
      const sig = mockGithub.generateSignature(payload);
      expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    test('records PR reviews and inline comments', async () => {
      const prNumber = 201;

      // Post review via HTTP endpoint
      const reviewRes = await fetch(`${serverUrl}/repos/calltelemetry/ai-workspace/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: 'LGTM with minor nits',
          event: 'APPROVE',
          commit_id: 'sha-abc-123',
        }),
      });
      expect(reviewRes.status).toBe(200);

      const reviews = mockGithub.getRecordedReviews(prNumber);
      expect(reviews.length).toBe(1);
      expect(reviews[0].event).toBe('APPROVE');
      expect(reviews[0].body).toBe('LGTM with minor nits');

      // Post comment via HTTP endpoint
      const commentRes = await fetch(`${serverUrl}/repos/calltelemetry/ai-workspace/pulls/${prNumber}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: 'Avoid raw queries',
          commit_id: 'sha-abc-123',
          path: 'src/db.ts',
          line: 15,
          side: 'RIGHT',
        }),
      });
      expect(commentRes.status).toBe(201);

      const comments = mockGithub.getRecordedInlineComments(prNumber);
      expect(comments.length).toBe(1);
      expect(comments[0].line).toBe(15);
      expect(comments[0].path).toBe('src/db.ts');

      // Test assertion helper
      E2EAssertions.assertPrReviewSubmitted(mockGithub, prNumber, 'APPROVE');
      E2EAssertions.assertInlineCommentsCount(mockGithub, prNumber, 1);
    });

    test('returns PR files list', async () => {
      mockGithub.setMockFiles(301, [
        {
          filename: 'src/auth.ts',
          status: 'modified',
          additions: 5,
          deletions: 1,
          changes: 6,
          patch: '@@ -1,3 +1,4 @@\n+ export const secret = "test";',
        },
      ]);

      const res = await fetch(`${serverUrl}/repos/calltelemetry/ai-workspace/pulls/301/files`);
      const files = await res.json();
      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe('src/auth.ts');
    });

    test('builds PR and IssueComment webhook events', () => {
      const prEvent = mockGithub.buildPullRequestEvent('opened', { number: 404, title: 'Fix bug' });
      expect(prEvent.action).toBe('opened');
      expect(prEvent.number).toBe(404);
      expect(prEvent.pull_request.title).toBe('Fix bug');

      const commentEvent = mockGithub.buildIssueCommentEvent('@ct-review review', { prNumber: 404 });
      expect(commentEvent.action).toBe('created');
      expect(commentEvent.comment.body).toBe('@ct-review review');
      expect(commentEvent.issue.number).toBe(404);
    });
  });

  describe('MockOmniRouteServer', () => {
    let mockOmni: MockOmniRouteServer;
    let serverUrl: string;

    beforeAll(async () => {
      mockOmni = new MockOmniRouteServer(0);
      serverUrl = await mockOmni.start();
    });

    afterAll(async () => {
      await mockOmni.stop();
    });

    test('handles OAuth token refresh', async () => {
      const res = await fetch(`${serverUrl}/v1/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'valid-refresh-token',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.access_token).toBe('new-access-token-456');
    });

    test('handles chat completions with effort levels and personas', async () => {
      const res = await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-access-token-123',
        },
        body: JSON.stringify({
          persona: 'security',
          effortLevel: 'reasoning',
          provider: 'openai',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.providerUsed).toBe('openai');
      expect(data.reasoningTrace).toBeDefined();
      expect(data.tokensUsed.total).toBeGreaterThan(0);

      const content = JSON.parse(data.content);
      expect(content.findings[0].persona).toBe('security');
    });

    test('handles provider failure injection and failover state', async () => {
      mockOmni.configure({
        failProvider: { provider: 'openai', status: 503, failCount: 1 },
      });

      // First call fails
      const failRes = await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-access-token-123',
        },
        body: JSON.stringify({ provider: 'openai' }),
      });
      expect(failRes.status).toBe(503);

      // Second call succeeds (failCount reached 0)
      const okRes = await fetch(`${serverUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer valid-access-token-123',
        },
        body: JSON.stringify({ provider: 'openai' }),
      });
      expect(okRes.status).toBe(200);
    });
  });

  describe('MockTicketServer', () => {
    let mockTicket: MockTicketServer;
    let serverUrl: string;

    beforeAll(async () => {
      mockTicket = new MockTicketServer(0);
      serverUrl = await mockTicket.start();
    });

    afterAll(async () => {
      await mockTicket.stop();
    });

    test('queries Linear tickets via GraphQL', async () => {
      const res = await fetch(`${serverUrl}/linear/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query { issue(id: "PROJ-123") { id title state { name } } }',
          variables: { id: 'PROJ-123' },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.issue.id).toBe('PROJ-123');
      expect(data.data.issue.state.name).toBe('In Progress');
    });

    test('queries Jira tickets via REST v3', async () => {
      const res = await fetch(`${serverUrl}/jira/rest/api/3/issue/KEY-456`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.key).toBe('KEY-456');
      expect(data.fields.summary).toBe('Implement diff state persistence');
    });

    test('queries GitHub issues via REST v3', async () => {
      const res = await fetch(`${serverUrl}/github/repos/calltelemetry/ai-workspace/issues/789`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.number).toBe(789);
      expect(data.title).toBe('Update Kubernetes deployment manifests');
    });

    test('allows dynamic ticket registration and error injection', async () => {
      mockTicket.addTicket({
        key: 'TICK-999',
        provider: 'jira',
        title: 'New Dynamic Ticket',
        status: 'Open',
      });

      const tickRes = await fetch(`${serverUrl}/jira/rest/api/3/issue/TICK-999`);
      expect(tickRes.status).toBe(200);

      mockTicket.injectError('JIRA', 500);
      const errRes = await fetch(`${serverUrl}/jira/rest/api/3/issue/TICK-999`);
      expect(errRes.status).toBe(500);

      mockTicket.resetState();
    });
  });

  describe('FixtureGenerator', () => {
    test('builds unified diff strings', () => {
      const diff = FixtureGenerator.getScenarioDiff('security_vuln');
      expect(diff).toContain('diff --git a/src/auth/login.ts b/src/auth/login.ts');
      expect(diff).toContain('+  const apiKey = "AKIAIOSFODNN7EXAMPLE";');
    });

    test('generates valid YAML configuration', () => {
      const yamlStr = FixtureGenerator.buildConfigYaml({
        quorum: { minApprovals: 3, effortLevel: 'high' },
      });
      expect(yamlStr).toContain('minApprovals: 3');
      expect(yamlStr).toContain('effortLevel: high');
    });

    test('generates constitution markdown', () => {
      const md = FixtureGenerator.buildConstitutionMarkdown([
        {
          id: 'SEC-01',
          category: 'security',
          title: 'No Plaintext Secrets',
          directive: 'Do not commit unencrypted keys.',
          forbiddenPatterns: ['AKIA[0-9A-Z]{16}'],
        },
      ]);
      expect(md).toContain('# Operational Constitution');
      expect(md).toContain('## Rule SEC-01: No Plaintext Secrets');
    });
  });

  describe('StateManager', () => {
    test('creates isolated environment and manages database state', async () => {
      const stateMgr = new StateManager();
      const ctx = await stateMgr.createEnvironment('smoke-test-1');

      expect(ctx.dbPath).toMatch(/review_state\.(sqlite|json)/);
      expect(ctx.env.CT_REVIEW_DB_PATH).toBe(ctx.dbPath);

      // Insert dummy finding directly into isolated database
      if (ctx.isJsonFallback) {
        ctx.db
          .prepare(
            `INSERT INTO tracked_findings (id, pr_id, finding_hash, persona, severity, file_path, line_number, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run('f1', 101, 'hash123', 'security', 'critical', 'src/auth.ts', 20, 'IDENTIFIED');
      } else {
        ctx.db
          .prepare(
            `INSERT INTO pr_states (id, repo_owner, repo_name, pr_number, head_sha, base_sha, updated_at)
             VALUES (1, 'calltelemetry', 'ai-workspace', 101, 'sha1', 'sha0', '2026-01-01')`
          )
          .run();
        ctx.db
          .prepare(
            `INSERT INTO tracked_findings (pr_state_id, fingerprint_hash, file_path, start_line, end_line, persona, severity, comment, status, first_seen_commit, last_seen_commit, created_at, updated_at)
             VALUES (1, 'hash123', 'src/auth.ts', 20, 20, 'security', 'critical', 'comment', 'IDENTIFIED', 'sha1', 'sha1', '2026-01-01', '2026-01-01')`
          )
          .run();
      }

      const findings = stateMgr.getTrackedFindings(ctx, 101);
      expect(findings).toHaveLength(1);
      expect(findings[0].file_path).toBe('src/auth.ts');

      await stateMgr.teardownEnvironment('smoke-test-1');
    });
  });

  describe('Full E2E Test Harness Orchestration', () => {
    test('bootstraps full harness including app process and mock services', async () => {
      const harness = await setupE2ETestHarness({
        testRunId: 'full-harness-smoke',
        configYaml: FixtureGenerator.buildConfigYaml(),
      });

      expect(harness.appProcess.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      // Verify app health endpoint
      const healthRes = await fetch(`${harness.appProcess.url}/health`);
      expect(healthRes.status).toBe(200);
      const healthData = await healthRes.json();
      expect(healthData.service).toBe('ct-review-bot');

      await harness.teardown();
    });
  });
});
