import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { authService } from '../../src/dashboard/authService';
import { Express } from 'express';

describe('R4: Repository Review Rules REST API Test Suite', () => {
  let app: Express;
  let adminToken: string;

  beforeEach(() => {
    dashboardStore.reset();
    authService.reset();

    // Clear any pre-existing default repositories and seed clean repo
    (dashboardStore as any).data.repositories = [];
    dashboardStore.updateRepository('exampleorg', 'example-api', {
      automationEnabled: true,
      customProfile: 'balanced',
      generateArchitecturalFlowchart: true,
    });

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

  describe('1. GET /api/dashboard/repositories/:owner/:repo/rules', () => {
    it('returns 200 with complete combined review rules structure', async () => {
      const res = await request(app)
        .get('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.owner).toBe('exampleorg');
      expect(res.body.repo).toBe('example-api');
      expect(res.body.rules).toBeDefined();

      const rules = res.body.rules;
      // Section 1: reviews
      expect(rules.reviews).toBeDefined();
      expect(rules.reviews.profile).toBe('balanced');
      expect(rules.reviews.sequence_diagrams).toBe(true);
      expect(rules.reviews.confidence_threshold).toBe(70);

      // Section 2: auto_review
      expect(rules.auto_review).toBeDefined();
      expect(rules.auto_review.enabled).toBe(true);
      expect(rules.auto_review.triggers).toContain('pr_opened');

      // Section 3: enforcement_policy
      expect(rules.enforcement_policy).toBeDefined();
      expect(rules.enforcement_policy.failure_action).toBe('fail_closed');
    });

    it('returns 404 for non-existent repository', async () => {
      const res = await request(app)
        .get('/api/dashboard/repositories/unknown-owner/unknown-repo/rules')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('2. PUT /api/dashboard/repositories/:owner/:repo/rules', () => {
    it('updates rules and synchronizes top-level repository fields', async () => {
      const payload = {
        reviews: {
          profile: 'assertive',
          sequence_diagrams: false,
          confidence_threshold: 85,
        },
        auto_review: {
          enabled: false,
          triggers: ['pr_opened', 'pr_ready', '@ct-review'],
        },
        enforcement_policy: {
          failure_action: 'quarantine',
          require_ticket_link: true,
        },
      };

      const res = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.rules.reviews.profile).toBe('assertive');
      expect(res.body.rules.reviews.sequence_diagrams).toBe(false);
      expect(res.body.rules.reviews.confidence_threshold).toBe(85);
      expect(res.body.rules.auto_review.enabled).toBe(false);
      expect(res.body.rules.auto_review.triggers).toContain('pr_ready');
      expect(res.body.rules.enforcement_policy.failure_action).toBe('quarantine');
      expect(res.body.rules.enforcement_policy.require_ticket_link).toBe(true);

      // Verify bidirectional synchronization to top-level repository fields
      const repoSetting = dashboardStore.getRepository('exampleorg', 'example-api');
      expect(repoSetting?.customProfile).toBe('assertive');
      expect(repoSetting?.strictnessProfile).toBe('assertive');
      expect(repoSetting?.generateArchitecturalFlowchart).toBe(false);
      expect(repoSetting?.automationEnabled).toBe(false);

      // Subsequent GET returns updated rules
      const getRes = await request(app)
        .get('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(getRes.status).toBe(200);
      expect(getRes.body.rules.reviews.profile).toBe('assertive');
      expect(getRes.body.rules.auto_review.enabled).toBe(false);
    });

    it('rejects invalid review rule fields with 400 Bad Request', async () => {
      const invalidPayload = {
        reviews: {
          profile: 'extreme_not_a_valid_profile',
          confidence_threshold: 150, // Max is 100
        },
      };

      const res = await request(app)
        .put('/api/dashboard/repositories/exampleorg/example-api/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(invalidPayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Invalid review rules payload');
      expect(res.body.details).toBeDefined();
    });

    it('returns 404 when updating non-existent repository', async () => {
      const res = await request(app)
        .put('/api/dashboard/repositories/non-existent/repo/rules')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          reviews: { profile: 'chill' },
        });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });
});
