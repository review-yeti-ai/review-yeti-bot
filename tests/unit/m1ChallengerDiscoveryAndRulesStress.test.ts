import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { authService } from '../../src/dashboard/authService';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { Express } from 'express';

describe('Milestone 1 Challenger: Adversarial Stress Test Suite (Discovery & Review Rules)', () => {
  let app: Express;
  let adminToken: string;

  beforeEach(() => {
    dashboardStore.reset();
    authService.reset();
    LiveStreamBus.getInstance().clearHistory();

    // Reset repositories in dashboard store
    (dashboardStore as any).data.repositories = [];

    // Seed baseline test repository (monitored)
    dashboardStore.updateRepository('exampleorg', 'example-api', {
      automationEnabled: true,
      customProfile: 'balanced',
      generateArchitecturalFlowchart: true,
    });

    // Seed a disabled test repository
    dashboardStore.updateRepository('exampleorg', 'paused-service', {
      automationEnabled: false,
      customProfile: 'chill',
    });

    // Create admin session token
    const session = authService.createGitHubSession({
      id: 'gh_admin',
      username: 'challenger-admin',
      role: 'admin',
      provider: 'github',
    });
    adminToken = session.token;

    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // VECTOR 1: Malformed Review Rule Schemas & Boundary Values
  // ==========================================================================
  describe('Vector 1: Malformed Review Rule Schemas & Boundary Values', () => {
    it('rejects invalid profile strings with 400 Bad Request', async () => {
      const invalidProfiles = ['ultra_aggressive', 'lenient', 'extreme', ''];

      for (const profile of invalidProfiles) {
        const res = await request(app)
          .put('/api/dashboard/repositories/exampleorg/example-api/rules')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            reviews: { profile },
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Invalid review rules payload');
      }
    });

    it('rejects non-string profile values (numbers, booleans, objects)', async () => {
      const invalidTypes = [123, true, {}, ['balanced']];

      for (const profile of invalidTypes) {
        const res = await request(app)
          .put('/api/dashboard/repositories/exampleorg/example-api/rules')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            reviews: { profile },
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
      }
    });

    it('enforces confidence_threshold boundaries [0, 100]', async () => {
      // Out of range: negative
      const resNeg = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { confidence_threshold: -1 } });
      expect(resNeg.status).toBe(400);

      // Out of range: over 100
      const resOver = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { confidence_threshold: 100.01 } });
      expect(resOver.status).toBe(400);

      // Invalid type: string
      const resStr = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { confidence_threshold: '75' } });
      expect(resStr.status).toBe(400);

      // Valid boundary: 0
      const res0 = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { confidence_threshold: 0 } });
      expect(res0.status).toBe(200);
      expect(res0.body.rules.reviews.confidence_threshold).toBe(0);

      // Valid boundary: 100
      const res100 = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { confidence_threshold: 100 } });
      expect(res100.status).toBe(200);
      expect(res100.body.rules.reviews.confidence_threshold).toBe(100);
    });

    it('enforces default_max_turns boundaries [1, 20] and integer constraint', async () => {
      // Less than 1
      const resZero = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { default_max_turns: 0 } });
      expect(resZero.status).toBe(400);

      const resNeg = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { default_max_turns: -5 } });
      expect(resNeg.status).toBe(400);

      // Greater than 20
      const res21 = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { default_max_turns: 21 } });
      expect(res21.status).toBe(400);

      // Non-integer float
      const resFloat = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { default_max_turns: 5.5 } });
      expect(resFloat.status).toBe(400);

      // Valid boundary: 1
      const res1 = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { default_max_turns: 1 } });
      expect(res1.status).toBe(200);
      expect(res1.body.rules.reviews.default_max_turns).toBe(1);

      // Valid boundary: 20
      const res20 = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { default_max_turns: 20 } });
      expect(res20.status).toBe(200);
      expect(res20.body.rules.reviews.default_max_turns).toBe(20);
    });

    it('rejects invalid reviewer_effort and enforcement_policy.failure_action', async () => {
      // Invalid reviewer_effort
      const resEffort = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { reviewer_effort: 'insane' } });
      expect(resEffort.status).toBe(400);

      // Valid reviewer_effort: max
      const resEffortValid = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reviews: { reviewer_effort: 'max' } });
      expect(resEffortValid.status).toBe(200);
      expect(resEffortValid.body.rules.reviews.reviewer_effort).toBe('max');

      // Invalid failure_action
      const resAction = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ enforcement_policy: { failure_action: 'destroy_repo' } });
      expect(resAction.status).toBe(400);

      // Valid failure_action: quarantine
      const resActionValid = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ enforcement_policy: { failure_action: 'quarantine' } });
      expect(resActionValid.status).toBe(200);
      expect(resActionValid.body.rules.enforcement_policy.failure_action).toBe('quarantine');
    });

    it('rejects malformed path_instructions items', async () => {
      // Invalid: instruction missing or not string
      const resBadItem = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reviews: {
            path_instructions: [{ path: 'src/**', instructions: 12345 }],
          },
        });
      expect(resBadItem.status).toBe(400);

      // Valid path instruction
      const resValid = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reviews: {
            path_instructions: [{ path: 'src/**', instructions: 'Verify error handling' }],
          },
        });
      expect(resValid.status).toBe(200);
      expect(resValid.body.rules.reviews.path_instructions).toHaveLength(1);
      expect(resValid.body.rules.reviews.path_instructions[0].instructions).toBe('Verify error handling');
    });

    it('handles non-object and array payloads safely without crashing', async () => {
      const resArray = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(['reviews', 'auto_review']));

      expect([400, 422]).toContain(resArray.status);

      const resString = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify('malformed string'));

      expect([400, 422]).toContain(resString.status);
    });

    it('supports camelCase aliases for autoReview and enforcementPolicy via schema preprocess', async () => {
      const res = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          autoReview: {
            enabled: false,
            triggers: ['pr_ready'],
          },
          enforcementPolicy: {
            require_ticket_link: true,
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.rules.auto_review.enabled).toBe(false);
      expect(res.body.rules.auto_review.triggers).toEqual(['pr_ready']);
      expect(res.body.rules.enforcement_policy.require_ticket_link).toBe(true);
    });
  });

  // ==========================================================================
  // VECTOR 2: Non-Existent Repos/Orgs & 404 Handling
  // ==========================================================================
  describe('Vector 2: Non-Existent Repos/Orgs & 404 Handling', () => {
    it('returns 404 for GET /rules on nonexistent repository and owner', async () => {
      const cases = [
        { owner: 'nonexistent-owner', repo: 'nonexistent-repo' },
        { owner: 'exampleorg', repo: 'phantom-repo' },
        { owner: 'ghost-org', repo: 'example-api' },
      ];

      for (const c of cases) {
        const res = await request(app)
          .get(`/api/dashboard/repositories/${c.owner}/${c.repo}/rules`)
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('not found');
      }
    });

    it('returns 404 for PUT /rules on nonexistent repository', async () => {
      const res = await request(app)
        .put('/api/dashboard/repositories/fake-owner/fake-repo/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reviews: { profile: 'chill' },
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('filters repositories by non-existent organization returning empty list (not 500)', async () => {
      const res = await request(app)
        .get('/api/github/repos?org=non-existent-org-9999')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.repositories).toEqual([]);
      expect(res.body.totalCount).toBe(0);
      expect(res.body.activeCount).toBe(0);
    });

    it('handles unexpected query parameters on /api/github/repos gracefully', async () => {
      const res = await request(app)
        .get('/api/github/repos?monitored=not_a_boolean&unknown_param=true')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 404 for GET /pulls on nonexistent repositories', async () => {
      const res = await request(app)
        .get('/api/github/repos/nonexistent_org/nonexistent_repo/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });
  });

  // ==========================================================================
  // VECTOR 3: On-Demand PR Review Dispatch Boundary Conditions
  // ==========================================================================
  describe('Vector 3: On-Demand PR Review Dispatch Boundary Conditions', () => {
    it('rejects non-numeric, zero, negative, or NaN prNumber with 400 Bad Request', async () => {
      const invalidPrs = [
        '0',
        '-1',
        '-9999',
        'abc',
        'undefined',
        'null',
        'NaN',
        'pr-42',
      ];

      for (const pr of invalidPrs) {
        const res = await request(app)
          .post(`/api/github/repos/exampleorg/example-api/pulls/${pr}/review`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            headSha: 'abcdef1234567890',
            title: 'Test PR',
          });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('Valid owner, repo, and prNumber');
      }
    });

    it('rejects decimal PR numbers like 3.14 with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/3.14/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('prNumber must be a positive integer');
    });

    it('rejects whitespace-only owner and repo with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/%20/%20/pulls/10/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Valid owner, repo, and prNumber');
    });

    it('returns 404 when dispatching reviews for untracked/non-existent repos', async () => {
      const res = await request(app)
        .post('/api/github/repos/ghost-org/ghost-repo/pulls/99/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Review for ghost repo',
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('rejects review dispatch when repo automation is explicitly disabled', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/paused-service/pulls/12/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('automation is disabled');
    });

    it('successfully queues on-demand review for valid high integer prNumber and returns 202', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/999999/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          headSha: 'feedface0987654321',
          title: 'Large PR number review',
        });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.jobId).toContain('pr999999');
    });

    it('generates random headSha and default title when body is empty', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/500/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.jobId).toContain('job_exampleorg_example-api_pr500');
    });

    it('records review run into dashboardStore after mock dispatch', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/88/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          headSha: '88888888888888888888',
          title: 'Review for PR 88',
        });

      expect(res.status).toBe(202);

      // Wait for mock timer (50ms)
      await new Promise((resolve) => setTimeout(resolve, 80));

      const logs = dashboardStore.getReviewLogs();
      const runLog = logs.find((l: any) => l.prNumber === 88);
      expect(runLog).toBeDefined();
      expect(runLog?.verdict).toBe('SHIP');
      expect(runLog?.title).toBe('Review for PR 88');
    });
  });

  // ==========================================================================
  // VECTOR 4: Concurrency Stress Tests
  // ==========================================================================
  describe('Vector 4: Concurrency Tests', () => {
    it('handles 30 simultaneous competing PUT updates to repository rules without corruption', async () => {
      const profiles: Array<'chill' | 'balanced' | 'assertive'> = ['chill', 'balanced', 'assertive'];
      const requests = [];

      for (let i = 0; i < 30; i++) {
        const profile = profiles[i % profiles.length];
        const threshold = 50 + (i % 50); // 50 to 99
        const turns = 1 + (i % 20); // 1 to 20
        const autoEnabled = i % 2 === 0;

        requests.push(
          request(app)
            .put('/api/dashboard/repositories/exampleorg/example-api/rules')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
              reviews: {
                profile,
                confidence_threshold: threshold,
                default_max_turns: turns,
              },
              auto_review: {
                enabled: autoEnabled,
              },
            })
        );
      }

      const responses = await Promise.all(requests);

      // Every response should succeed with 200
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.rules).toBeDefined();
      }

      // Check that final repository state in store is consistent and valid
      const finalRules = dashboardStore.getRepositoryRules('exampleorg', 'example-api');
      expect(profiles).toContain(finalRules.reviews.profile);
      expect(finalRules.reviews.confidence_threshold).toBeGreaterThanOrEqual(50);
      expect(finalRules.reviews.confidence_threshold).toBeLessThanOrEqual(99);
      expect(finalRules.reviews.default_max_turns).toBeGreaterThanOrEqual(1);
      expect(finalRules.reviews.default_max_turns).toBeLessThanOrEqual(20);
      expect(typeof finalRules.auto_review.enabled).toBe('boolean');

      // Top-level synced fields should match
      const repoSetting = dashboardStore.getRepository('exampleorg', 'example-api');
      expect(repoSetting?.customProfile).toBe(finalRules.reviews.profile);
      expect(repoSetting?.automationEnabled).toBe(finalRules.auto_review.enabled);
    });

    it('handles 25 simultaneous on-demand review dispatches without event emitter collision', async () => {
      const bus = LiveStreamBus.getInstance();
      const queuedJobs: string[] = [];

      const onEvent = (e: any) => {
        if (e.type === 'job:queued') {
          queuedJobs.push(e.jobId);
        }
      };
      bus.on('event', onEvent);

      const requests = [];
      for (let i = 1; i <= 25; i++) {
        requests.push(
          request(app)
            .post(`/api/github/repos/exampleorg/example-api/pulls/${i}/review`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
              headSha: `sha_${i}_${Date.now()}`,
              title: `Concurrent PR Review #${i}`,
            })
        );
      }

      const responses = await Promise.all(requests);
      bus.off('event', onEvent);

      for (let i = 0; i < responses.length; i++) {
        expect(responses[i].status).toBe(202);
        expect(responses[i].body.success).toBe(true);
        expect(responses[i].body.jobId).toBeDefined();
      }

      // Ensure 25 unique job IDs were generated
      const jobIds = responses.map((r) => r.body.jobId);
      const uniqueJobIds = new Set(jobIds);
      expect(uniqueJobIds.size).toBe(25);
    });

    it('handles simultaneous interleaved GET and PUT requests without stale or partial data', async () => {
      const interleaved = [];

      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          interleaved.push(
            request(app)
              .put('/api/dashboard/repositories/exampleorg/example-api/rules')
              .set('Authorization', `Bearer ${adminToken}`)
              .send({
                reviews: {
                  profile: i % 4 === 0 ? 'chill' : 'assertive',
                  confidence_threshold: 60 + i,
                },
              })
          );
        } else {
          interleaved.push(
            request(app)
              .get('/api/dashboard/repositories/exampleorg/example-api/rules')
              .set('Authorization', `Bearer ${adminToken}`)
          );
        }
      }

      const responses = await Promise.all(interleaved);

      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.rules).toBeDefined();
        expect(res.body.rules.reviews).toBeDefined();
        expect(['chill', 'assertive', 'balanced']).toContain(res.body.rules.reviews.profile);
      }
    });
  });
});
