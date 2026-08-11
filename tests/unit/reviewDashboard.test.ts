import { describe, expect, it, vi } from 'vitest';

const dashboard = require('../../src/reviewDashboard.js');

const env = {
  GITHUB_REPOSITORY: 'acme/widgets',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '9876',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_ACTION_REF: 'v1',
};

function completedEvent(detail = 'full') {
  return dashboard.buildReviewEvent({
    detail,
    startedAtMs: 1_000,
    completedAtMs: 2_500,
    prContext: {
      repo: 'acme/widgets',
      prNumber: 42,
      headSha: 'abc123',
      baseSha: 'base123',
      title: 'Harden widget lookup',
      eventData: { pull_request: { html_url: 'https://github.com/acme/widgets/pull/42' } },
    },
    arbitration: {
      verdict: 'FIX_FIRST',
      rationale: 'One fix is required.',
      metrics: { p0Count: 0, p1Count: 1, p2Count: 0 },
    },
    coverage: { reviewed: ['src/widget.ts'], omitted: [], skipped: [], passes: 1 },
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUSD: 0.01 },
    personaResults: [{
      personaId: 'security',
      provider: 'provider-a',
      model: 'model-a',
      decision: 'FINDINGS',
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUSD: 0.01 },
      findings: [{
        severity: 'P1', path: 'src/widget.ts', line: 7, side: 'RIGHT', title: 'Missing tenant scope',
        body: 'The query can cross workspace boundaries. Token sk_123456789-secret must not leak.',
        suggestion: 'Ask owner@example.com to include workspaceId in the predicate.',
      }],
    }],
  }, env);
}

describe('review dashboard delivery', () => {
  it('builds a deterministic sanitized event compatible with the cloud contract', () => {
    const event = completedEvent();

    expect(event.eventId).toMatch(/^ctre_[a-f0-9]{40}$/u);
    expect(event.eventId).toBe(completedEvent().eventId);
    expect(event.eventType).toBe('review.completed');
    expect(event.repository.fullName).toBe('acme/widgets');
    expect(event.workflow.url).toBe('https://github.com/acme/widgets/actions/runs/9876');
    expect(event.review.durationMs).toBe(1_500);
    expect(event.review.findings).toHaveLength(1);
    expect(event.review.findings[0].fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(event)).not.toContain('sk_123456789-secret');
    expect(JSON.stringify(event)).not.toContain('owner@example.com');
    expect(JSON.stringify(event)).toContain('[REDACTED]');
  });

  it('omits structured findings in metrics mode', () => {
    expect(completedEvent('metrics').review.findings).toBeUndefined();
  });

  it('returns a cloud detail URL for accepted and duplicate deliveries', async () => {
    const accepted = await dashboard.deliverReviewEvent({
      event: completedEvent(),
      apiKey: 'ctd_live_test_key',
      apiUrl: 'https://api.reviewyeti.ai/api/v1/review-events',
      siteUrl: 'https://reviewyeti.ai',
      fetchImpl: vi.fn().mockResolvedValue({
        status: 202,
        json: async () => ({ status: 'accepted', reviewRunId: 'j57abc123' }),
      }),
      wait: async () => {},
    });
    expect(accepted).toMatchObject({
      status: 'accepted',
      reviewRunId: 'j57abc123',
      reviewUrl: 'https://reviewyeti.ai/dashboard/reviews/j57abc123',
    });

    const duplicate = await dashboard.deliverReviewEvent({
      event: completedEvent(),
      apiKey: 'ctd_live_test_key',
      apiUrl: 'https://api.reviewyeti.ai',
      siteUrl: 'https://reviewyeti.ai',
      fetchImpl: vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ status: 'duplicate', reviewRunId: 'j57abc123' }),
      }),
      wait: async () => {},
    });
    expect(duplicate).toMatchObject({ status: 'duplicate', reviewUrl: 'https://reviewyeti.ai/dashboard/reviews/j57abc123' });
  });

  it('does not contact the cloud when no key is configured', async () => {
    const fetchImpl = vi.fn();
    await expect(dashboard.deliverReviewEvent({ event: completedEvent(), apiKey: '', fetchImpl }))
      .resolves.toEqual({ status: 'disabled', attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
