import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { authService } from '../../src/dashboard/authService';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { Express } from 'express';

describe('R4: GitHub Org, Repo & Active PR Discovery API Test Suite', () => {
  let app: Express;
  let adminToken: string;

  beforeEach(() => {
    dashboardStore.reset();
    authService.reset();
    LiveStreamBus.getInstance().clearHistory();

    // Clear any pre-existing default repositories so tests assert on exact fixture counts
    (dashboardStore as any).data.repositories = [];

    // Seed test repositories
    dashboardStore.updateRepository('calltelemetry', 'cisco-cdr', {
      automationEnabled: true,
      customProfile: 'assertive',
    });
    dashboardStore.updateRepository('calltelemetry', 'ct-dialer', {
      automationEnabled: false,
      customProfile: 'chill',
    });
    dashboardStore.updateRepository('acme-corp', 'backend-service', {
      automationEnabled: true,
      customProfile: 'balanced',
    });

    // Create session token for protected routes
    const session = authService.createGitHubSession({
      id: 'gh_101',
      username: 'admin',
      role: 'admin',
      provider: 'github',
    });
    adminToken = session.token;

    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. GET /api/github/orgs (Organization Discovery)', () => {
    it('returns 200 with list of accessible organizations and repository counts', async () => {
      const res = await request(app)
        .get('/api/github/orgs')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.organizations)).toBe(true);
      expect(res.body.organizations.length).toBeGreaterThanOrEqual(2);

      const ctOrg = res.body.organizations.find((o: any) => o.login.toLowerCase() === 'calltelemetry');
      expect(ctOrg).toBeDefined();
      expect(ctOrg.monitoredCount).toBe(1);
      expect(ctOrg.totalReposCount).toBe(2);
      expect(ctOrg.avatarUrl).toContain('calltelemetry');

      const acmeOrg = res.body.organizations.find((o: any) => o.login.toLowerCase() === 'acme-corp');
      expect(acmeOrg).toBeDefined();
      expect(acmeOrg.monitoredCount).toBe(1);
      expect(acmeOrg.totalReposCount).toBe(1);
    });

    it('falls back to default organization when store has zero repositories', async () => {
      (dashboardStore as any).data.repositories = [];
      const res = await request(app)
        .get('/api/github/orgs')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.organizations.length).toBe(1);
      expect(res.body.organizations[0].login).toBe('calltelemetry');
    });
  });

  describe('2. GET /api/github/repos (Repository Discovery & Correlation)', () => {
    it('returns all accessible repositories with correlation fields', async () => {
      // Seed a review log for cisco-cdr
      dashboardStore.recordReviewRun({
        id: 'rev_1',
        prRun: 'calltelemetry/cisco-cdr#42',
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 42,
        title: 'fix(sip): handle drop call',
        headSha: 'abc1234567',
        status: 'completed',
        verdict: 'SHIP',
        timestamp: '2026-10-01T12:00:00.000Z',
        latencyMs: 1200,
        tokens: { prompt: 1000, completion: 200, total: 1200 },
        costUSD: 0.05,
        personas: ['security'],
        quorum: '1/1',
      } as any);

      const res = await request(app)
        .get('/api/github/repos')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.totalCount).toBe(3);
      expect(res.body.activeCount).toBe(2);

      const cdrRepo = res.body.repositories.find((r: any) => r.repo === 'cisco-cdr');
      expect(cdrRepo).toBeDefined();
      expect(cdrRepo.automationEnabled).toBe(true);
      expect(cdrRepo.lastVerdict).toBe('SHIP');
      expect(cdrRepo.lastReviewAt).toBe('2026-10-01T12:00:00.000Z');
    });

    it('filters repositories by organization (?org=...)', async () => {
      const res = await request(app)
        .get('/api/github/repos?org=calltelemetry')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(2);
      expect(res.body.repositories.every((r: any) => r.owner.toLowerCase() === 'calltelemetry')).toBe(true);
    });

    it('filters repositories by monitored status (?monitored=true)', async () => {
      const res = await request(app)
        .get('/api/github/repos?monitored=true')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(2);
      expect(res.body.repositories.every((r: any) => r.automationEnabled === true)).toBe(true);
    });
  });

  describe('3. GET /api/github/repos/:owner/:repo/pulls (Active PR Inspection & Review Join)', () => {
    it('returns open pull requests joined with historical completed review verdict', async () => {
      // Seed a review log for PR #42
      dashboardStore.recordReviewRun({
        id: 'rev_42',
        prRun: 'calltelemetry/cisco-cdr#42',
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 42,
        title: 'feat: add audio stream verification',
        headSha: 'headsha42',
        status: 'completed',
        verdict: 'SHIP',
        timestamp: '2026-10-01T12:30:00.000Z',
        latencyMs: 950,
        tokens: { prompt: 500, completion: 100, total: 600 },
        costUSD: 0.02,
        personas: ['security', 'architecture'],
        personaLogs: [{ persona: 'security', findingsCount: 0 }],
        quorum: '2/2',
      } as any);

      const res = await request(app)
        .get('/api/github/repos/calltelemetry/cisco-cdr/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pullRequests.length).toBeGreaterThanOrEqual(1);

      const pr42 = res.body.pullRequests.find((p: any) => p.number === 42);
      expect(pr42).toBeDefined();
      expect(pr42.title).toBe('feat: add audio stream verification');
      expect(pr42.reviewStatus).toBeDefined();
      expect(pr42.reviewStatus.status).toBe('completed');
      expect(pr42.reviewStatus.verdict).toBe('SHIP');
    });

    it('joins active running review job from LiveStreamBus', async () => {
      // Seed an active job in LiveStreamBus
      LiveStreamBus.getInstance().publishEvent({
        jobId: 'job_calltelemetry_cisco-cdr_pr99_abc',
        timestamp: new Date().toISOString(),
        type: 'job:dispatched',
        persona: 'all',
        data: {
          repo: 'calltelemetry/cisco-cdr',
          prNumber: 99,
          headSha: 'abc99',
          title: 'refactor(core): speed up pipeline',
          status: 'dispatched',
        },
      });

      // Also seed review log for #99 so it appears in PR listing fallback
      dashboardStore.recordReviewRun({
        id: 'rev_99_old',
        prRun: 'calltelemetry/cisco-cdr#99',
        repo: 'calltelemetry/cisco-cdr',
        prNumber: 99,
        title: 'refactor(core): speed up pipeline',
        headSha: 'abc99',
        status: 'completed',
        verdict: 'SHIP',
        timestamp: '2026-10-01T10:00:00.000Z',
        latencyMs: 1000,
        tokens: { prompt: 100, completion: 100, total: 200 },
        costUSD: 0.01,
        personas: ['quality'],
        quorum: '1/1',
      } as any);

      const res = await request(app)
        .get('/api/github/repos/calltelemetry/cisco-cdr/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const pr99 = res.body.pullRequests.find((p: any) => p.number === 99);
      expect(pr99).toBeDefined();
      // Active job in LiveStreamBus takes precedence over completed historical log
      expect(pr99.reviewStatus.status).toBe('running');
    });
  });

  describe('4. POST /api/github/repos/:owner/:repo/pulls/:prNumber/review (On-Demand Dispatch)', () => {
    it('queues an on-demand review and emits job:queued event to LiveStreamBus', async () => {
      let publishedQueuedEvent = false;
      const bus = LiveStreamBus.getInstance();
      const onEvent = (event: any) => {
        if (event.type === 'job:queued' && event.data?.prNumber === 77) {
          publishedQueuedEvent = true;
        }
      };
      bus.on('event', onEvent);

      const res = await request(app)
        .post('/api/github/repos/calltelemetry/cisco-cdr/pulls/77/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          headSha: 'deadbeef1234567890',
          title: 'perf(cucm): optimize query latency',
        });

      bus.off('event', onEvent);

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.jobId).toContain('job_calltelemetry_cisco-cdr_pr77');
      expect(publishedQueuedEvent).toBe(true);

      const history = bus.getHistory(res.body.jobId);
      expect(history.some((e: any) => e.type === 'job:queued')).toBe(true);
    });

    it('rejects invalid prNumber with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/calltelemetry/cisco-cdr/pulls/not-a-number/review')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Valid owner, repo, and prNumber');
    });
  });
});
