import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  formatSuggestionBody,
  buildGitHubReviewPayload,
  publishGitHubPullRequestReview,
  type InlineFindingSuggestion,
} from '../src/reviewPublisher.js';
import { createMockEnv } from './mockDurableObject.js';

async function signPayload(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

describe('Phase 2: PR Review Experience & ChatOps Ingress Suite', () => {
  describe('GitHub 1-Click Inline Suggestions (```suggestion blocks)', () => {
    it('formats inline finding with valid ```suggestion block', () => {
      const finding: InlineFindingSuggestion = {
        path: 'src/auth/tokenValidator.ts',
        line: 42,
        severity: 'P1',
        ruleId: 'security.crypto.timing_attack',
        title: 'Timing attack vulnerability in token validation',
        description: 'Direct string equality comparison leaks timing information. Use constant-time comparison.',
        suggestedFix: 'const isValid = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));',
      };

      const body = formatSuggestionBody(finding);

      assert.ok(body.includes('🚨 **[P1]** **Timing attack vulnerability in token validation**'));
      assert.ok(body.includes('*Rule: `security.crypto.timing_attack`*'));
      assert.ok(body.includes('```suggestion\nconst isValid = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));\n```'));
    });

    it('formats informational/P3 findings without suggestion when suggestedFix is omitted', () => {
      const finding: InlineFindingSuggestion = {
        path: 'src/docs/readme.md',
        line: 12,
        severity: 'P3',
        title: 'Grammar and formatting improvement',
        description: 'Consider updating section header for consistency.',
      };

      const body = formatSuggestionBody(finding);

      assert.ok(body.includes('💡 **[P3]** **Grammar and formatting improvement**'));
      assert.ok(!body.includes('```suggestion'));
    });

    it('builds full GitHub review payload with APPROVE when verdict is success', () => {
      const payload = buildGitHubReviewPayload({
        commitId: 'abcdef0123456789abcdef0123456789abcdef01',
        verdict: 'success',
        summaryMarkdown: '## Review Yeti: SHIP\n\nAll security invariants verified.',
        findings: [],
      });

      assert.equal(payload.commit_id, 'abcdef0123456789abcdef0123456789abcdef01');
      assert.equal(payload.event, 'APPROVE');
      assert.equal(payload.comments.length, 0);
      assert.ok(payload.body.includes('SHIP'));
    });

    it('builds full GitHub review payload with REQUEST_CHANGES when blocking P0/P1 findings exist', () => {
      const findings: InlineFindingSuggestion[] = [
        {
          path: 'src/fencing.ts',
          line: 88,
          startLine: 85,
          severity: 'P0',
          title: 'Split-brain fencing leak',
          description: 'Epoch must be checked before write.',
          suggestedFix: 'if (epoch !== this.currentEpoch) return false;\nawait this.write();',
        },
      ];

      const payload = buildGitHubReviewPayload({
        commitId: 'abcdef0123456789abcdef0123456789abcdef01',
        verdict: 'action_required',
        summaryMarkdown: '## Review Yeti: ACTION REQUIRED\n\n1 blocking issue found.',
        findings,
      });

      assert.equal(payload.event, 'REQUEST_CHANGES');
      assert.equal(payload.comments.length, 1);
      assert.equal(payload.comments[0].path, 'src/fencing.ts');
      assert.equal(payload.comments[0].line, 88);
      assert.equal(payload.comments[0].start_line, 85);
      assert.ok(payload.comments[0].body.includes('```suggestion'));
    });

    describe('review event follows the blocking severities only (P2 is advisory)', () => {
      const finding = (severity: 'P0' | 'P1' | 'P2'): InlineFindingSuggestion => ({
        path: 'src/a.ts', line: 3, severity, title: `${severity} finding`, description: 'Detail.',
      });
      const event = (verdict: 'success' | 'action_required' | 'neutral', severities: Array<'P0' | 'P1' | 'P2'>) =>
        buildGitHubReviewPayload({
          commitId: 'abcdef0123456789abcdef0123456789abcdef01', verdict, summaryMarkdown: '## Review Yeti',
          findings: severities.map(finding),
        }).event;

      it('approves a SHIP review that only has P2 findings', () => {
        assert.equal(event('success', ['P2']), 'APPROVE');
      });

      it('comments, without requesting changes, on action_required with only P2 findings', () => {
        assert.equal(event('action_required', ['P2']), 'COMMENT');
      });

      it('requests changes for P0/P1 findings on both verdicts, even when the verdict says success', () => {
        assert.equal(event('success', ['P1']), 'REQUEST_CHANGES');
        assert.equal(event('success', ['P2', 'P0']), 'REQUEST_CHANGES');
        assert.equal(event('action_required', ['P1']), 'REQUEST_CHANGES');
      });
    });

    it('includes runner cost and total runtime as an item in Review Yeti review payload when managed runners are used', () => {
      const payload = buildGitHubReviewPayload({
        commitId: 'abcdef0123456789abcdef0123456789abcdef01',
        verdict: 'success',
        summaryMarkdown: '## Review Yeti: SHIP\n\nAll security and quality invariants verified.',
        findings: [],
        runnerCost: {
          runnerType: 'digitalocean',
          runnerName: 'DigitalOcean Managed Agents (Firecracker microVM)',
          durationMs: 24800,
          vcpus: 2,
          memoryMb: 2048,
          costUsd: 0.000446,
          formattedCost: '$0.000446 USD',
          formattedRuntime: '24.8s (24,800 ms)',
          rateHourlyUsd: 0.0648,
        },
      });

      assert.equal(payload.event, 'APPROVE');
      assert.ok(payload.body.includes('### 💰 Managed Runner Execution & Cost'));
      assert.ok(payload.body.includes('**Runner:** DigitalOcean Managed Agents (Firecracker microVM) (2 vCPU / 2048 MB)'));
      assert.ok(payload.body.includes('**Total Runtime:** 24.8s (24,800 ms)'));
      assert.ok(payload.body.includes('**Runner Cost:** **$0.000446 USD**'));
    });

    it('publishes review to GitHub REST API via mock fetch', async () => {
      let calledUrl = '';
      let calledMethod = '';
      let calledAuth = '';
      let calledBody = '';

      const mockFetch = (async (url: string, init?: any) => {
        calledUrl = url;
        calledMethod = init?.method;
        calledAuth = init?.headers?.Authorization;
        calledBody = init?.body;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 987654, html_url: 'https://github.com/org/repo/pull/1#pullrequestreview-987654' }),
        };
      }) as any;

      const payload = buildGitHubReviewPayload({
        commitId: 'sha123',
        verdict: 'success',
        summaryMarkdown: 'Looks good!',
        findings: [],
      });

      const res = await publishGitHubPullRequestReview({
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        prNumber: 42,
        token: 'ghs_live_mock_token',
        payload,
        fetchFn: mockFetch,
      });

      assert.equal(res.success, true);
      assert.equal(res.reviewId, 987654);
      assert.equal(calledUrl, 'https://api.github.com/repos/review-yeti-ai/review-yeti-bot/pulls/42/reviews');
      assert.equal(calledMethod, 'POST');
      assert.equal(calledAuth, 'Bearer ghs_live_mock_token');
      assert.ok(calledBody.includes('APPROVE'));
    });
  });

  describe('ChatOps Ingress for PR issue_comment Webhooks', () => {
    it('ignores comments on standard issues (not PRs)', async () => {
      const env = createMockEnv();
      env.PILOT_REPOSITORIES = 'all';
      env.GITHUB_WEBHOOK_SECRET = 'chatops-test-secret';
      const payload = {
        action: 'created',
        issue: { number: 10 }, // No pull_request property
        comment: { body: '@review-yeti re-review' },
        repository: { full_name: 'review-yeti-ai/review-yeti-bot' },
      };

      const body = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET, body);
      const req = new Request('https://edge.reviewyeti.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issue_comment',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, env);
      const data = (await res.json()) as any;
      assert.equal(res.status, 200);
      assert.equal(data.status, 'ignored');
      assert.equal(data.reason, 'not_applicable_issue_comment');
    });

    it('ignores non-command comments on PRs', async () => {
      const env = createMockEnv();
      env.PILOT_REPOSITORIES = 'all';
      env.GITHUB_WEBHOOK_SECRET = 'chatops-test-secret';
      const payload = {
        action: 'created',
        issue: { number: 42, pull_request: { url: 'https://api.github.com/...' } },
        comment: { body: 'LGTM! Great work on this refactor.' },
        repository: { full_name: 'review-yeti-ai/review-yeti-bot' },
      };

      const body = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET, body);
      const req = new Request('https://edge.reviewyeti.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issue_comment',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, env);
      const data = (await res.json()) as any;
      assert.equal(res.status, 200);
      assert.equal(data.status, 'ignored');
      assert.equal(data.reason, 'not_review_command');
    });

    it('dispatches @review-yeti re-review on PR', async () => {
      const env = createMockEnv();
      env.PILOT_REPOSITORIES = 'all';
      env.GITHUB_WEBHOOK_SECRET = 'chatops-test-secret';
      let createdWorkflowParams: any = null;
      env.REVIEW_JOB_WORKFLOW = {
        create: async (params: any) => {
          createdWorkflowParams = params;
          return { id: params.id };
        },
      } as any;

      const payload = {
        action: 'created',
        issue: {
          number: 42,
          pull_request: {
            head: { sha: 'abcdef1234567890abcdef1234567890abcdef12' },
            base: { sha: '123456abcdef123456abcdef123456abcdef1234' },
          },
        },
        comment: { body: '@review-yeti re-review' },
        repository: { full_name: 'review-yeti-ai/review-yeti-bot' },
        installation: { id: 777 },
      };

      const body = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET, body);
      const req = new Request('https://edge.reviewyeti.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issue_comment',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, env);
      const data = (await res.json()) as any;

      assert.equal(res.status, 200);
      assert.equal(data.status, 'dispatched_chatops');
      assert.equal(data.command, 're-review');
      assert.equal(data.prNumber, 42);
      assert.equal(data.thinkingEffort, 'standard');

      assert.ok(createdWorkflowParams);
      assert.equal(createdWorkflowParams.params.owner, 'review-yeti-ai');
      assert.equal(createdWorkflowParams.params.repo, 'review-yeti-bot');
      assert.equal(createdWorkflowParams.params.headSha, 'abcdef1234567890abcdef1234567890abcdef12');
      assert.equal(createdWorkflowParams.params.installationId, 777);
    });

    it('dispatches @review-yeti deep-scan with thinkingEffort max', async () => {
      const env = createMockEnv();
      env.PILOT_REPOSITORIES = 'all';
      env.GITHUB_WEBHOOK_SECRET = 'chatops-test-secret';
      let createdWorkflowParams: any = null;
      env.REVIEW_JOB_WORKFLOW = {
        create: async (params: any) => {
          createdWorkflowParams = params;
          return { id: params.id };
        },
      } as any;

      const payload = {
        action: 'created',
        issue: {
          number: 108,
          pull_request: {
            head: { sha: 'deadbeef12345678' },
            base: { sha: 'basebeef12345678' },
          },
        },
        comment: { body: '/review-yeti deep-scan' },
        repository: { full_name: 'review-yeti-ai/review-yeti-bot' },
      };

      const body = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET, body);
      const req = new Request('https://edge.reviewyeti.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issue_comment',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, env);
      const data = (await res.json()) as any;

      assert.equal(res.status, 200);
      assert.equal(data.status, 'dispatched_chatops');
      assert.equal(data.command, 'deep-scan');
      assert.equal(data.thinkingEffort, 'max');

      assert.ok(createdWorkflowParams);
      assert.equal(createdWorkflowParams.params.thinkingEffort, 'max');
    });

    it('dispatches @review-yeti explain with targeted file/line', async () => {
      const env = createMockEnv();
      env.PILOT_REPOSITORIES = 'all';
      env.GITHUB_WEBHOOK_SECRET = 'chatops-test-secret';
      let createdWorkflowParams: any = null;
      env.REVIEW_JOB_WORKFLOW = {
        create: async (params: any) => {
          createdWorkflowParams = params;
          return { id: params.id };
        },
      } as any;

      const payload = {
        action: 'created',
        issue: {
          number: 200,
          pull_request: {
            head: { sha: 'targethead123' },
            base: { sha: 'targetbase123' },
          },
        },
        comment: { body: '@yeti explain src/crypto/cipher.ts:142' },
        repository: { full_name: 'review-yeti-ai/review-yeti-bot' },
      };

      const body = JSON.stringify(payload);
      const sig = await signPayload(env.GITHUB_WEBHOOK_SECRET, body);
      const req = new Request('https://edge.reviewyeti.internal/api/webhooks/github', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'issue_comment',
          'X-Hub-Signature-256': sig,
        },
        body,
      });

      const res = await worker.fetch(req, env);
      const data = (await res.json()) as any;

      assert.equal(res.status, 200);
      assert.equal(data.status, 'dispatched_chatops');
      assert.equal(data.command, 'explain');
      assert.equal(data.explainTarget, 'src/crypto/cipher.ts:142');

      assert.ok(createdWorkflowParams);
      assert.equal(createdWorkflowParams.params.explainTarget, 'src/crypto/cipher.ts:142');
    });
  });
});
