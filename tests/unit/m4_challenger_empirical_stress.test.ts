import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import { createApp } from '../../src/app';
import { setupE2ETestHarness, E2ETestHarness } from '../e2e/harness/e2eTestRunner';

function signPayload(body: any, secret = 'development-webhook-secret-key-12345'): string {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', secret);
  return 'sha256=' + hmac.update(raw).digest('hex');
}

describe('Challenger 2 Empirical Verification: GitHub EventHandler & Event Loop Integration', () => {

  describe('1. EventHandler - Event Triggers & Filtering', () => {
    let handler: GitHubEventHandler;

    beforeEach(() => {
      handler = new GitHubEventHandler();
    });

    it('1.1 Triggers on PR opened, synchronize, reopened events', () => {
      for (const action of ['opened', 'synchronize', 'reopened']) {
        const payload = {
          action,
          pull_request: { number: 1, state: 'open', head: { sha: 'sha1' }, base: { sha: 'sha0' } },
          repository: { owner: { login: 'octocat' }, name: 'hello-world' },
          sender: { login: 'dev-user' },
        };
        const result = handler.evaluateTrigger('pull_request', payload, 'del-1');
        expect(result.shouldTrigger).toBe(true);
        expect(result.parsedPayload?.triggerAction).toBe(action);
        expect(result.parsedPayload?.triggerSource).toBe('pr_event');
      }
    });

    it('1.2 Does NOT trigger on non-review PR actions (edited, closed, assigned, unlabeled)', () => {
      for (const action of ['edited', 'closed', 'assigned', 'unlabeled']) {
        const payload = {
          action,
          pull_request: { number: 1, state: 'open' },
          repository: { owner: { login: 'octocat' }, name: 'hello-world' },
          sender: { login: 'dev-user' },
        };
        const result = handler.evaluateTrigger('pull_request', payload, 'del-2');
        expect(result.shouldTrigger).toBe(false);
        expect(result.reason).toContain(`action '${action}' is not configured`);
      }
    });

    it('1.3 Filters PR events when PR state is closed', () => {
      const payload = {
        action: 'synchronize',
        pull_request: { number: 10, state: 'closed' },
        repository: { owner: { login: 'octocat' }, name: 'hello-world' },
        sender: { login: 'dev-user' },
      };
      const result = handler.evaluateTrigger('pull_request', payload, 'del-3');
      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toBe('PR is closed');
    });

    it('1.4 Label triggers — triggers on labeled action if PR has a trigger label', () => {
      // Trigger label present
      const payloadTrigger = {
        action: 'labeled',
        pull_request: { number: 2, state: 'open', labels: [{ name: 'ct-review' }] },
        repository: { owner: { login: 'octocat' }, name: 'hello-world' },
        sender: { login: 'dev-user' },
      };
      const resTrigger = handler.evaluateTrigger('pull_request', payloadTrigger, 'del-4');
      expect(resTrigger.shouldTrigger).toBe(true);
      expect(resTrigger.parsedPayload?.triggerSource).toBe('label_trigger');

      // Non-trigger label present
      const payloadNoTrigger = {
        action: 'labeled',
        pull_request: { number: 2, state: 'open', labels: [{ name: 'bug' }] },
        repository: { owner: { login: 'octocat' }, name: 'hello-world' },
        sender: { login: 'dev-user' },
      };
      const resNoTrigger = handler.evaluateTrigger('pull_request', payloadNoTrigger, 'del-5');
      expect(resNoTrigger.shouldTrigger).toBe(false);
    });

    it('1.5 Custom triggerLabels options support', () => {
      const customHandler = new GitHubEventHandler({ triggerLabels: ['custom-ai-review'] });
      
      const defaultLabelPayload = {
        action: 'labeled',
        pull_request: { number: 3, state: 'open', labels: [{ name: 'ct-review' }] },
        sender: { login: 'user1' },
      };
      expect(customHandler.evaluateTrigger('pull_request', defaultLabelPayload).shouldTrigger).toBe(false);

      const customLabelPayload = {
        action: 'labeled',
        pull_request: { number: 3, state: 'open', labels: [{ name: 'custom-ai-review' }] },
        sender: { login: 'user1' },
      };
      expect(customHandler.evaluateTrigger('pull_request', customLabelPayload).shouldTrigger).toBe(true);
    });

    it('1.6 Bot self-loop suppression for various bot senders', () => {
      const botSenders = [
        'github-actions[bot]',
        'dependabot[bot]',
        'ct-review-bot[bot]',
        'ct-review-bot',
        'some-custom-app[bot]',
      ];

      for (const bot of botSenders) {
        const payload = {
          action: 'opened',
          pull_request: { number: 5, state: 'open' },
          sender: { login: bot },
        };
        const result = handler.evaluateTrigger('pull_request', payload, 'del-bot');
        expect(result.shouldTrigger).toBe(false);
        expect(result.reason).toContain(`Ignored bot action from sender: ${bot}`);
      }

      // Human sender should trigger
      const humanPayload = {
        action: 'opened',
        pull_request: { number: 5, state: 'open' },
        sender: { login: 'jasonbarbee' },
      };
      expect(handler.evaluateTrigger('pull_request', humanPayload).shouldTrigger).toBe(true);
    });
  });

  describe('2. EventHandler - Comment Command Regex & Trigger Evaluation', () => {
    let handler: GitHubEventHandler;

    beforeEach(() => {
      handler = new GitHubEventHandler();
    });

    it('2.1 Matches valid comment commands (@ct-review review, @bot review, @ct-review-bot review)', () => {
      const validComments = [
        '@ct-review review',
        '@bot review',
        '@ct-review-bot review',
        '@CT-REVIEW REVIEW',
        '@Bot Review',
        '@ct-review-bot   review',
        '@ct-review\nreview',
        'Hey team, please @ct-review review this PR when ready!',
        'PR looks good @ct-review-bot review',
      ];

      for (const commentBody of validComments) {
        const payload = {
          action: 'created',
          issue: { number: 42, title: 'Fix bug' },
          comment: { id: 99, body: commentBody },
          sender: { login: 'developer1' },
        };
        const result = handler.evaluateTrigger('issue_comment', payload, 'del-comment');
        expect(result.shouldTrigger).toBe(true);
        expect(result.parsedPayload?.triggerSource).toBe('comment_command');
        expect(result.parsedPayload?.commandText).toBe(commentBody);
      }
    });

    it('2.2 Rejects non-command comments', () => {
      const invalidComments = [
        '@ct-review status',
        '@bot help',
        '@otherbot review',
        'just reviewing the code manually',
        '@ct-review-bot please look at lines 10-20',
      ];

      for (const commentBody of invalidComments) {
        const payload = {
          action: 'created',
          issue: { number: 42 },
          comment: { id: 99, body: commentBody },
          sender: { login: 'developer1' },
        };
        const result = handler.evaluateTrigger('issue_comment', payload, 'del-comment-invalid');
        expect(result.shouldTrigger).toBe(false);
        expect(result.reason).toBe('not bot review command');
      }
    });

    it('2.3 Suppresses bot senders on issue_comment', () => {
      const payload = {
        action: 'created',
        issue: { number: 42 },
        comment: { id: 100, body: '@ct-review review' },
        sender: { login: 'ct-review-bot' },
      };
      const result = handler.evaluateTrigger('issue_comment', payload, 'del-bot-comment');
      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toContain('Ignored bot action');
    });

    it('2.4 Handles pull_request_review_comment event type identically to issue_comment', () => {
      const payload = {
        action: 'created',
        pull_request: { number: 77, title: 'Refactor DB' },
        comment: { id: 101, body: '@bot review' },
        sender: { login: 'human' },
      };
      const result = handler.evaluateTrigger('pull_request_review_comment', payload, 'del-pr-comment');
      expect(result.shouldTrigger).toBe(true);
      expect(result.parsedPayload?.prNumber).toBe(77);
    });
  });

  describe('3. EventHandler - Async Job Queue & Concurrency', () => {
    it('3.1 Respects maxConcurrency setting and processes queued jobs asynchronously', async () => {
      let activeExecutions = 0;
      let maxSimultaneousExecutions = 0;
      const completedJobs: number[] = [];

      const handler = new GitHubEventHandler({
        maxConcurrency: 2,
        syncExecution: false,
        reviewRunner: async (payload) => {
          activeExecutions++;
          maxSimultaneousExecutions = Math.max(maxSimultaneousExecutions, activeExecutions);
          await new Promise((resolve) => setTimeout(resolve, 50));
          activeExecutions--;
          completedJobs.push(payload.prNumber);
          return { done: true };
        },
      });

      // Dispatch 5 webhook events
      for (let i = 1; i <= 5; i++) {
        const payload = {
          action: 'opened',
          pull_request: { number: i, state: 'open' },
          sender: { login: 'dev' },
        };
        const res = await handler.handleWebhook('pull_request', payload, `del-${i}`);
        expect(res.status).toBe('queued');
      }

      // Wait for queue to drain
      await handler.drainAndStop();

      expect(maxSimultaneousExecutions).toBeLessThanOrEqual(2);
      expect(completedJobs.length).toBe(5);
    });

    it('3.2 Retries failed jobs up to maxRetries before marking as failed', async () => {
      const attemptsMap = new Map<number, number>();

      const handler = new GitHubEventHandler({
        maxConcurrency: 1,
        syncExecution: false,
        reviewRunner: async (payload) => {
          const attempts = (attemptsMap.get(payload.prNumber) || 0) + 1;
          attemptsMap.set(payload.prNumber, attempts);

          if (payload.prNumber === 999) {
            throw new Error(`Flaky job error on attempt ${attempts}`);
          }
          return { status: 'ok' };
        },
      });

      const payload = {
        action: 'opened',
        pull_request: { number: 999, state: 'open' },
        sender: { login: 'dev' },
      };

      const handleRes = await handler.handleWebhook('pull_request', payload, 'del-999');
      const jobId = handleRes.jobId;

      await handler.drainAndStop();

      const finalJob = handler.getJob(jobId);
      expect(finalJob).toBeDefined();
      expect(finalJob?.status).toBe('failed');
      expect(finalJob?.attempt).toBe(2); // Max retries is 2
      expect(attemptsMap.get(999)).toBe(2);
    });
  });

  describe('4. App Event Loop Integration — Short-Circuit Gating & LLM Skipping', () => {
    let harness: E2ETestHarness;
    let app: any;
    let tempConstitutionPath: string;

    beforeEach(async () => {
      harness = await setupE2ETestHarness({
        testRunId: `challenger-m4-${Date.now()}`,
      });
      app = createApp();

      const tempDir = os.tmpdir();
      tempConstitutionPath = path.join(tempDir, `test-const-${Date.now()}.md`);
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

    afterEach(async () => {
      await harness.teardown();
      if (fs.existsSync(tempConstitutionPath)) {
        fs.unlinkSync(tempConstitutionPath);
      }
    });

    it('4.1 Short-circuit gating on Ticket Failure — executes 0 LLM calls', async () => {
      const invalidTicketPayload = {
        action: 'opened',
        number: 301,
        pull_request: {
          number: 301,
          title: 'feat: missing ticket identifier in title',
          body: 'Has testing steps included.',
          head: { sha: 'sha-301' },
          base: { sha: 'sha-base' },
          changed_files: [{ path: 'src/a.ts', content: 'const a = 1;' }],
        },
        repository: { name: 'ai-workspace', owner: { login: 'calltelemetry' } },
        sender: { login: 'user1' },
      };

      const sig = signPayload(invalidTicketPayload);

      const res = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sig)
        .set('Content-Type', 'application/json')
        .send(invalidTicketPayload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(res.body.ticketValid).toBe(false);
      expect(res.body.decision).toBe('REQUEST_CHANGES');

      // Verify ZERO OmniRoute LLM calls were executed
      expect(harness.mockOmniRoute.getRecordedRequests().length).toBe(0);

      // Verify MockGitHubServer recorded review REQUEST_CHANGES
      const reviews = harness.mockGithub.getRecordedReviews(301);
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      expect(reviews[reviews.length - 1].event).toBe('REQUEST_CHANGES');
    });

    it('4.2 Short-circuit gating on Constitution Failure — executes 0 LLM calls', async () => {
      const invalidConstitutionPayload = {
        action: 'opened',
        number: 302,
        pull_request: {
          number: 302,
          title: '[PROJ-302] feat: add dynamic eval execution',
          body: 'PR description with testing steps.',
          head: { sha: 'sha-302' },
          base: { sha: 'sha-base' },
          changed_files: [{ path: 'src/eval.ts', content: 'export const exec = eval(cmd);' }],
        },
        repository: { name: 'ai-workspace', owner: { login: 'calltelemetry' } },
        sender: { login: 'user2' },
      };

      const sig = signPayload(invalidConstitutionPayload);

      const res = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sig)
        .set('Content-Type', 'application/json')
        .send(invalidConstitutionPayload);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('processed');
      expect(res.body.constitutionCompliant).toBe(false);
      expect(res.body.decision).toBe('REQUEST_CHANGES');

      // Verify ZERO OmniRoute LLM calls were executed
      expect(harness.mockOmniRoute.getRecordedRequests().length).toBe(0);

      // Verify MockGitHubServer recorded review REQUEST_CHANGES
      const reviews = harness.mockGithub.getRecordedReviews(302);
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      expect(reviews[reviews.length - 1].event).toBe('REQUEST_CHANGES');
    });

    it('4.3 Skipping LLM calls on unchanged diffs', async () => {
      const initialPayload = {
        action: 'opened',
        number: 303,
        pull_request: {
          number: 303,
          title: '[PROJ-303] feat: initial clean commit',
          body: 'Includes testing steps.',
          head: { sha: 'sha-diff-1' },
          base: { sha: 'sha-base' },
          changed_files: [
            {
              path: 'src/stable.ts',
              content: 'export function hello() { return "world"; }',
              patch: '@@ -0,0 +1,1 @@\n+export function hello() { return "world"; }',
            },
          ],
        },
        repository: { name: 'ai-workspace', owner: { login: 'calltelemetry' } },
        sender: { login: 'user3' },
      };

      const sig1 = signPayload(initialPayload);

      const res1 = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sig1)
        .set('Content-Type', 'application/json')
        .send(initialPayload);

      expect(res1.status).toBe(200);
      expect(res1.body.decision).toBe('APPROVE');

      const initialLlmCalls = harness.mockOmniRoute.getRecordedRequests().length;
      expect(initialLlmCalls).toBeGreaterThan(0);

      // Subsequent synchronize event with IDENTICAL hunks / files
      const syncUnchangedPayload = {
        ...initialPayload,
        action: 'synchronize',
        pull_request: {
          ...initialPayload.pull_request,
          head: { sha: 'sha-diff-2' }, // New commit sha, but identical diff content
        },
      };

      const sig2 = signPayload(syncUnchangedPayload);

      const res2 = await request(app)
        .post('/webhook')
        .set('X-GitHub-Event', 'pull_request')
        .set('X-Hub-Signature-256', sig2)
        .set('Content-Type', 'application/json')
        .send(syncUnchangedPayload);

      expect(res2.status).toBe(200);
      expect(res2.body.decision).toBe('APPROVE');

      // Verify LLM calls count did NOT increase
      const finalLlmCalls = harness.mockOmniRoute.getRecordedRequests().length;
      expect(finalLlmCalls).toBe(initialLlmCalls);
    });
  });

  describe('5. Adversarial Stress & Edge Cases', () => {
    let handler: GitHubEventHandler;

    beforeEach(() => {
      handler = new GitHubEventHandler();
    });

    it('5.1 Comment regex over-matching test (@ct-review reviewing vs @ct-review review)', () => {
      const commentWithReviewing = {
        action: 'created',
        issue: { number: 99 },
        comment: { id: 501, body: '@ct-review reviewing the code' },
        sender: { login: 'dev' },
      };

      const evalRes = handler.evaluateTrigger('issue_comment', commentWithReviewing);
      // Documenting empirical behavior: regex /@(ct-review|bot|ct-review-bot)\s+review/i matches "reviewing"
      // because "review" matches as prefix of "reviewing".
      expect(evalRes.shouldTrigger).toBe(true);
    });

    it('5.2 Label trigger on labeled action when PR already has a trigger label', () => {
      // Adding non-trigger label 'documentation' to PR that already has 'ct-review' label
      const payload = {
        action: 'labeled',
        label: { name: 'documentation' }, // Label just added
        pull_request: {
          number: 88,
          state: 'open',
          labels: [{ name: 'ct-review' }, { name: 'documentation' }],
        },
        sender: { login: 'dev' },
      };

      const res = handler.evaluateTrigger('pull_request', payload);
      // Empirical observation: because handler checks pr.labels.some(), adding 'documentation' triggers review
      expect(res.shouldTrigger).toBe(true);
    });

    it('5.3 Store eviction when jobStore exceeds maxStoreSize (500)', async () => {
      const handlerWithSmallStore = new GitHubEventHandler({ syncExecution: false });

      for (let i = 0; i < 520; i++) {
        await handlerWithSmallStore.handleWebhook('pull_request', {
          action: 'opened',
          pull_request: { number: i, state: 'open' },
          sender: { login: 'user' },
        }, `delivery-${i}`);
      }

      const metrics = handlerWithSmallStore.getQueueMetrics();
      expect(metrics.totalTracked).toBeLessThanOrEqual(500);
      await handlerWithSmallStore.drainAndStop();
    });
  });
});
