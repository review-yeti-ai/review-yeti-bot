import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { authService } from '../../src/dashboard/authService';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { Express } from 'express';

describe('Milestone 1 Challenger: Empirical Verification of Closed Vulnerabilities', () => {
  let app: Express;
  let adminToken: string;

  beforeEach(() => {
    dashboardStore.reset();
    authService.reset();
    LiveStreamBus.getInstance().clearHistory();

    (dashboardStore as any).data.repositories = [];
    (dashboardStore as any).data.reviewLogs = [];

    // Seed tracked active repo
    dashboardStore.updateRepository('exampleorg', 'example-api', {
      automationEnabled: true,
      customProfile: 'balanced',
      generateArchitecturalFlowchart: true,
    });

    // Seed tracked repo with disabled automation
    dashboardStore.updateRepository('exampleorg', 'paused-service', {
      automationEnabled: false,
      customProfile: 'chill',
    });

    // Seed tracked repo with NO reviews and NO PRs
    dashboardStore.updateRepository('exampleorg', 'empty-repo', {
      automationEnabled: true,
      customProfile: 'balanced',
    });

    const session = authService.createGitHubSession({
      id: 'gh_admin',
      username: 'challenger-empirical-admin',
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
  // VULNERABILITY 1: Untracked repo in GET /pulls returns 404 (No PR #142)
  // ==========================================================================
  describe('Vulnerability 1: Untracked repo in GET /pulls returns 404', () => {
    it('returns 404 for untracked repository in GET /pulls', async () => {
      const res = await request(app)
        .get('/api/github/repos/untracked-owner/untracked-repo/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Repository untracked-owner/untracked-repo not found');
    });

    it('returns 404 for ghost-org/ghost-repo with query parameters', async () => {
      const res = await request(app)
        .get('/api/github/repos/ghost-org/ghost-repo/pulls?state=open&limit=10')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Repository ghost-org/ghost-repo not found');
    });

    it('returns 200 with empty array (NO synthetic PR #142) for tracked repo with zero reviews', async () => {
      const res = await request(app)
        .get('/api/github/repos/exampleorg/empty-repo/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pullRequests).toEqual([]);
      expect(res.body.totalCount).toBe(0);

      // Verify PR #142 does NOT exist in response
      const hasPr142 = res.body.pullRequests.some((pr: any) => pr.number === 142);
      expect(hasPr142).toBe(false);
    });

    it('correctly returns actual review logs for tracked repo without synthetic PR #142', async () => {
      // Add a real review log for example-api
      dashboardStore.recordReviewRun({
        id: 'rev_123',
        prRun: 'exampleorg/example-api#55',
        repo: 'exampleorg/example-api',
        prNumber: 55,
        title: 'Real PR 55',
        verdict: 'SHIP',
        confidenceScore: 90,
        latencyMs: 1200,
        timestamp: new Date().toISOString(),
        summary: 'All clear',
        headSha: 'abc1234567',
        status: 'completed',
        tokens: { prompt: 500, completion: 100, total: 600 },
        costUSD: 0.02,
        personas: ['security'],
        personaLogs: [{ persona: 'security', findingsCount: 0 }],
      });

      const res = await request(app)
        .get('/api/github/repos/exampleorg/example-api/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.pullRequests.length).toBe(1);
      expect(res.body.pullRequests[0].number).toBe(55);
      expect(res.body.pullRequests[0].title).toBe('Real PR 55');

      // Assert PR 142 is not injected
      const prNumbers = res.body.pullRequests.map((p: any) => p.number);
      expect(prNumbers).not.toContain(142);
    });
  });

  // ==========================================================================
  // VULNERABILITY 2: Untracked repo in POST /review returns 404
  // ==========================================================================
  describe('Vulnerability 2: Untracked repo in POST /review returns 404', () => {
    it('returns 404 when dispatching review for untracked repo', async () => {
      const res = await request(app)
        .post('/api/github/repos/untracked-owner/untracked-repo/pulls/1/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Review for untracked repo',
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Repository untracked-owner/untracked-repo not found');

      // Verify no job was queued in LiveStreamBus
      const activeJobs = LiveStreamBus.getInstance().getActiveJobs();
      expect(activeJobs.some((j: any) => (j.repo || '').includes('untracked-repo'))).toBe(false);

      // Verify no review logs added in dashboardStore
      const logs = dashboardStore.getReviewLogs() || [];
      expect(logs.some((l: any) => (l.repo || '').includes('untracked-repo'))).toBe(false);
    });

    it('returns 404 for ghost-org/ghost-repo with explicit headSha and baseSha', async () => {
      const res = await request(app)
        .post('/api/github/repos/ghost-org/ghost-repo/pulls/999/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          headSha: '1234567890abcdef',
          baseSha: 'main',
          title: 'Ghost Review',
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Repository ghost-org/ghost-repo not found');
    });
  });

  // ==========================================================================
  // VULNERABILITY 3: Whitespace-only owner/repo returns 400
  // ==========================================================================
  describe('Vulnerability 3: Whitespace-only owner/repo returns 400', () => {
    it('returns 400 for GET /pulls with whitespace-only owner and repo (%20/%20)', async () => {
      const res = await request(app)
        .get('/api/github/repos/%20/%20/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('owner and repo parameters are required');
    });

    it('returns 400 for GET /pulls when owner is whitespace only', async () => {
      const res = await request(app)
        .get('/api/github/repos/%20/example-api/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('owner and repo parameters are required');
    });

    it('returns 400 for GET /pulls when repo is whitespace only', async () => {
      const res = await request(app)
        .get('/api/github/repos/exampleorg/%20/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('owner and repo parameters are required');
    });

    it('returns 400 for GET /pulls with tab and newline whitespace (%09/%0A)', async () => {
      const res = await request(app)
        .get('/api/github/repos/%09/%0A/pulls')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('owner and repo parameters are required');
    });

    it('returns 400 for POST /review with whitespace-only owner and repo (%20/%20)', async () => {
      const res = await request(app)
        .post('/api/github/repos/%20/%20/pulls/10/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Valid owner, repo, and prNumber parameters are required');
    });

    it('returns 400 for POST /review when owner is whitespace only', async () => {
      const res = await request(app)
        .post('/api/github/repos/%20/example-api/pulls/10/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Valid owner, repo, and prNumber parameters are required');
    });

    it('returns 400 for POST /review when repo is whitespace only', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/%20/pulls/10/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Valid owner, repo, and prNumber parameters are required');
    });

    it('returns 400 for POST /review with multi-space whitespace (%20%20%20/%20%20%20)', async () => {
      const res = await request(app)
        .post('/api/github/repos/%20%20%20/%20%20%20/pulls/10/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // VULNERABILITY 4: Disabled automation returns 400
  // ==========================================================================
  describe('Vulnerability 4: Disabled automation returns 400', () => {
    it('returns 400 when dispatching review on repo with automationEnabled: false', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/paused-service/pulls/12/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Repository review automation is disabled');
    });

    it('returns 400 when dispatching with force: false on disabled repo', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/paused-service/pulls/12/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ force: false });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Repository review automation is disabled');
    });

    it('allows dispatch when explicit force: true is provided on disabled repo', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/paused-service/pulls/12/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ force: true, title: 'Forced review on disabled repo' });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.jobId).toBeDefined();
    });
  });

  // ==========================================================================
  // VULNERABILITY 5 / PARSING QUIRK: Decimal PR numbers (3.14) return 400
  // ==========================================================================
  describe('Vulnerability 5: Decimal and non-integer PR numbers return 400', () => {
    it('rejects 3.14 with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/3.14/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('prNumber must be a positive integer');
    });

    it('rejects 0.99 with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/0.99/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects scientific notation 1e5 with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/1e5/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects negative PR numbers like -1 with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/-1/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects PR number 0 with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/0/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects NaN with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/NaN/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects Infinity with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/Infinity/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects alphanumeric PR string like 42abc with 400 Bad Request', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/42abc/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('accepts valid positive integer PR number and returns 202', async () => {
      const res = await request(app)
        .post('/api/github/repos/exampleorg/example-api/pulls/42/review')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          headSha: 'c0ffee1234567890abcdef',
          title: 'Legitimate PR',
        });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.jobId).toContain('pr42');
    });
  });

  // ==========================================================================
  // REVIEWER 1 FINDING: Cookie Security in OAuth Callback
  // ==========================================================================
  describe('Reviewer 1 Finding: Cookie Security (httpOnly)', () => {
    it('sets ct_session_token cookie with HttpOnly flag during OAuth callback', async () => {
      process.env.GITHUB_CLIENT_ID = 'mock_client_id';
      process.env.GITHUB_CLIENT_SECRET = 'mock_client_secret';

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/login/oauth/access_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'gho_mock_access_token_123',
              token_type: 'bearer',
              scope: 'read:user,user:email,read:org,repo',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (urlStr.endsWith('/user')) {
          return new Response(
            JSON.stringify({
              id: 999999,
              login: 'challenger-tester',
              name: 'Challenger Tester',
              avatar_url: 'https://avatars.githubusercontent.com/u/999999',
              email: 'challenger@test.com',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not Found', { status: 404 });
      });

      // Initiate flow to get state
      const initRes = await request(app).get('/api/auth/github');
      expect(initRes.status).toBe(302);
      const location = initRes.header.location;
      const url = new URL(location);
      const state = url.searchParams.get('state');

      // Callback with state
      const callbackRes = await request(app)
        .get(`/api/auth/github/callback?code=valid_code&state=${state}`);

      expect(callbackRes.status).toBe(302);
      const cookies: string[] = (Array.isArray(callbackRes.header['set-cookie'])
        ? callbackRes.header['set-cookie']
        : [callbackRes.header['set-cookie']].filter(Boolean)) as string[];
      expect(cookies.length).toBeGreaterThan(0);

      const sessionCookie = cookies.find((c: string) => c.startsWith('ct_session_token='));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
    });
  });
});

