import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import { createLiveRouter } from '../../src/api/liveApi';
import { CommentPublisher } from '../../src/github/commentPublisher';

describe('Live Agent Stream & Terminal View Suite (Release v1.3.0)', () => {
  let bus: LiveStreamBus;

  beforeEach(() => {
    bus = LiveStreamBus.getInstance();
    bus.clearHistory();
  });

  it('publishes live stream events and maintains event history per jobId', () => {
    const event = {
      jobId: 'job_test_123',
      timestamp: new Date().toISOString(),
      type: 'agent_start' as const,
      persona: 'security' as const,
      data: { message: 'Security persona analyzing authentication tokens' },
    };

    bus.publishEvent(event);

    const history = bus.getHistory('job_test_123');
    expect(history.length).toBe(1);
    expect(history[0].persona).toBe('security');
    expect(history[0].data.message).toContain('Security persona');
  });

  it('GET /api/live/history returns recorded events for a job', async () => {
    bus.publishEvent({
      jobId: 'job_api_456',
      timestamp: new Date().toISOString(),
      type: 'quorum_verdict' as const,
      persona: 'quorum' as const,
      data: { verdict: 'APPROVE', confidenceScore: 95 },
    });

    const app = express();
    app.use('/api/live', createLiveRouter());

    const res = await request(app).get('/api/live/history?jobId=job_api_456');

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe('job_api_456');
    expect(res.body.count).toBe(1);
    expect(res.body.events[0].data.verdict).toBe('APPROVE');
  });

  it('attaches Live Stream and Organization Dashboard URLs to published PR reviews', async () => {
    let capturedBody = '';

    const publisher = new CommentPublisher({
      githubToken: 'ghs_valid_test_token_1234567890',
      baseUrl: 'https://api.github.test',
    });

    // Mock fetchWithRetry
    (publisher as any).fetchWithRetry = async (_url: string, opts: any) => {
      const payload = JSON.parse(opts.body);
      capturedBody = payload.body;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ id: 9999 }),
      };
    };

    const res = await publisher.publishReview({
      owner: 'calltelemetry',
      repo: 'ct-meta',
      prNumber: 1448,
      commitSha: 'a1b2c3d4e5f6',
      event: 'COMMENT',
      body: '## PR Quorum Summary Review\nAll checks passed cleanly.',
    });

    expect(res.success).toBe(true);
    expect(capturedBody).toContain('Watch Live Agent Review Stream & Terminal View');
    expect(capturedBody).toContain('/dashboard/live?jobId=job_calltelemetry_ct-meta_pr1448_a1b2c3d');
    expect(capturedBody).toContain('/dashboard/organization');
  });
});
