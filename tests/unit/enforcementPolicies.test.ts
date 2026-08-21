import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { enforcementPolicySchema, ctReviewConfigV3Schema } from '../../src/config/schema';
import { createGitHubAppApiRouter } from '../../src/api/githubAppApi';

describe('Enterprise PR Enforcement Policies Suite (Milestone 44)', () => {
  it('validates default enforcement policy schema values', () => {
    const defaultPolicy = enforcementPolicySchema.parse({});
    expect(defaultPolicy.require_all_reviews).toBe(true);
    expect(defaultPolicy.failure_action).toBe('fail_closed');
    expect(defaultPolicy.require_ticket_link).toBe(false);
  });

  it('parses custom enforcement policy settings in ctReviewConfigV3Schema', () => {
    const rawConfig = {
      version: 3,
      quorum: 1,
      personas: [
        {
          id: 'sec',
          name: 'security',
          enabled: true,
          required: true,
          charter: 'builtin:security',
          paths: ['**/*'],
          providers: ['codex'],
        },
      ],
      reviewers: {
        execution: 'personas',
        fallback: 'ordered',
        overall_timeout_s: 180,
        providers: [
          {
            id: 'codex',
            enabled: true,
            model: 'codex/gpt-5.6-sol-high',
            effort: 'medium',
            review_timeout_s: 30,
            arbiter_timeout_s: 30,
          },
        ],
        arbiter: {
          order: ['codex'],
        },
      },
      enforcement_policy: {
        require_all_reviews: true,
        failure_action: 'quarantine',
        require_ticket_link: true,
      },
    };

    const parsed = ctReviewConfigV3Schema.parse(rawConfig);
    expect(parsed.enforcement_policy?.failure_action).toBe('quarantine');
    expect(parsed.enforcement_policy?.require_ticket_link).toBe(true);
  });

  it('rejects invalid failure_action values in enforcement policy schema', () => {
    const invalidConfig = {
      require_all_reviews: true,
      failure_action: 'invalid_action',
    };

    const result = enforcementPolicySchema.safeParse(invalidConfig);
    expect(result.success).toBe(false);
  });

  it('GET /api/github/enforcement-policy returns active policy settings', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/github', createGitHubAppApiRouter());

    const res = await request(app).get('/api/github/enforcement-policy');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.policy).toBeDefined();
  });

  it('PUT /api/github/enforcement-policy updates failureAction, requireAllReviews, and requireTicketLink', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/github', createGitHubAppApiRouter());

    const res = await request(app)
      .put('/api/github/enforcement-policy')
      .send({
        failureAction: 'quarantine',
        requireAllReviews: true,
        requireTicketLink: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.policy.failureAction).toBe('quarantine');
    expect(res.body.policy.requireTicketLink).toBe(true);
  });
});
