import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';

describe('Next-Gen Analytics & Live Status REST API Suite', () => {
  let app: any;
  let authToken: string;

  beforeEach(async () => {
    process.env.WEBHOOK_SECRET = 'test_webhook_secret';
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = 'test_key';
    process.env.OMNIROUTE_BASE_URL = 'http://localhost:8080';
    app = createApp();

    // Authenticate admin user
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    authToken = loginRes.body.token;
  });

  describe('Authentication on Next-Gen Analytics Endpoints', () => {
    it('rejects unauthenticated requests to /api/analytics/checkpoints with 401', async () => {
      const res = await request(app).get('/api/analytics/checkpoints');
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated requests to /api/analytics/compaction with 401', async () => {
      const res = await request(app).get('/api/analytics/compaction');
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated requests to /api/analytics/incremental with 401', async () => {
      const res = await request(app).get('/api/analytics/incremental');
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated requests to /api/analytics/fast-path with 401', async () => {
      const res = await request(app).get('/api/analytics/fast-path');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/analytics/checkpoints', () => {
    it('returns content-addressed checkpoint metrics with hit rates and zero-token savings', async () => {
      const res = await request(app)
        .get('/api/analytics/checkpoints?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('totalSubtasks');
      expect(res.body).toHaveProperty('cacheHits');
      expect(res.body).toHaveProperty('cacheMisses');
      expect(res.body).toHaveProperty('hitRatePercent');
      expect(res.body).toHaveProperty('zeroTokenReplaysCount');
      expect(res.body).toHaveProperty('tokensSavedTotal');
      expect(res.body).toHaveProperty('byLane');
      expect(res.body.byLane).toHaveProperty('security');
    });
  });

  describe('GET /api/analytics/compaction', () => {
    it('returns unbounded AST compaction and diff eviction receipt metrics', async () => {
      const res = await request(app)
        .get('/api/analytics/compaction?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('compactionRatio');
      expect(res.body).toHaveProperty('rawDiffTokensAvg');
      expect(res.body).toHaveProperty('compactedTokensAvg');
      expect(res.body).toHaveProperty('diffEvictionReceiptsCount');
      expect(res.body).toHaveProperty('flatContextSlopeConfirmed', true);
      expect(res.body).toHaveProperty('maxPrTokensHandled');
      expect(res.body.maxPrTokensHandled).toBeGreaterThan(25000); // Unbounded beyond 25k limit
    });
  });

  describe('GET /api/analytics/incremental', () => {
    it('returns finding state machine metrics and Catch-22 preventions', async () => {
      const res = await request(app)
        .get('/api/analytics/incremental?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('recheckLaneRuns');
      expect(res.body).toHaveProperty('catch22Preventions');
      expect(res.body).toHaveProperty('findingsAutoResolvedCount');
      expect(res.body).toHaveProperty('resolutionRatePercent');
      expect(res.body).toHaveProperty('avgCommitsToResolution');
    });
  });

  describe('GET /api/analytics/fast-path', () => {
    it('returns blocker fast-path quorum early-exit metrics and aborted streams', async () => {
      const res = await request(app)
        .get('/api/analytics/fast-path?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('totalFastPathExits');
      expect(res.body).toHaveProperty('abortedStreamsCount');
      expect(res.body).toHaveProperty('avgTimeToBlockerMs');
      expect(res.body).toHaveProperty('latencyReductionPercent');
      expect(res.body).toHaveProperty('reasonsBreakdown');
    });
  });

  describe('Summary Next-Gen Extensions', () => {
    it('GET /api/analytics/summary includes next-gen KPIs', async () => {
      const res = await request(app)
        .get('/api/analytics/summary?range=7d')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const summary = res.body.summary;
      expect(summary).toHaveProperty('checkpointHitRatePercent');
      expect(summary).toHaveProperty('zeroTokenReplaySavingsTokens');
      expect(summary).toHaveProperty('compactionRatio');
      expect(summary).toHaveProperty('recheckLaneRuns');
      expect(summary).toHaveProperty('blockerFastPathCount');
    });
  });

  describe('GET /api/live/status & Enriched Active Jobs', () => {
    it('returns deep job status for live review jobs', async () => {
      const res = await request(app).get('/api/live/status?jobId=default-job');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('jobId', 'default-job');
      expect(res.body).toHaveProperty('eventsCount');
    });

    it('GET /api/live/jobs returns enriched next-gen properties', async () => {
      const res = await request(app).get('/api/live/jobs');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.jobs)).toBe(true);
      if (res.body.jobs.length > 0) {
        const first = res.body.jobs[0];
        expect(first).toHaveProperty('isIncremental');
        expect(first).toHaveProperty('recheckLane');
        expect(first).toHaveProperty('fileCoveragePercent');
        expect(first).toHaveProperty('checkpointHits');
        expect(first).toHaveProperty('compactionRatio');
        expect(first).toHaveProperty('blockerFastPathTriggered');
      }
    });
  });
});
