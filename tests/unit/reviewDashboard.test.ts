import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import fs from 'node:fs';
import path from 'node:path';

const dashboard = require('../../src/reviewDashboard.js');
const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../schemas/review-event.v1.schema.json'), 'utf8'));
const validateSchema = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

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

function startedEvent() {
  return dashboard.buildReviewStartedEvent({
    startedAtMs: 1_000,
    prContext: {
      repo: 'acme/widgets',
      prNumber: 42,
      headSha: 'abc123',
      baseSha: 'base123',
      title: 'Contains owner@example.com and should not be copied',
      eventData: { pull_request: { html_url: 'https://github.com/acme/widgets/pull/42' } },
    },
    arbitration: {
      verdict: 'BLOCK',
      rationale: 'Finding prose with sk_123456789-secret and owner@example.com',
      metrics: { p0Count: 4, p1Count: 3, p2Count: 2 },
    },
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUSD: 0.01 },
    personaResults: [{ personaId: 'security', provider: 'provider-a', model: 'secret-model', decision: 'FINDINGS' }],
    findings: [{ severity: 'P1', path: 'src/widget.ts', line: 7, title: 'Secret finding prose' }],
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
    expect(event.review.arbitration).toMatchObject({
      algorithmVersion: 'review-arbitration-v1',
      expectedPersonas: ['security'],
      completedPersonas: ['security'],
      gateDecision: 'BLOCKED',
      mergeEligible: false,
    });
    expect(validateSchema(event)).toBe(true);
    expect(validateSchema.errors).toBeNull();
    expect(JSON.stringify(event)).not.toContain('sk_123456789-secret');
    expect(JSON.stringify(event)).not.toContain('owner@example.com');
    expect(JSON.stringify(event)).toContain('[REDACTED]');
  });

  it('changes the event identity when the workflow attempt changes', () => {
    const input = {
      prContext: {
        repo: 'acme/widgets',
        prNumber: 42,
        headSha: 'abc123',
        baseSha: 'base123',
        title: 'Harden widget lookup',
      },
      arbitration: { verdict: 'FIX_FIRST', metrics: { p0Count: 0, p1Count: 1, p2Count: 0 } },
    };
    const first = dashboard.buildReviewEvent(input, env);
    const retry = dashboard.buildReviewEvent(input, { ...env, GITHUB_RUN_ATTEMPT: '3' });

    expect(retry.eventId).not.toBe(first.eventId);
  });

  it('builds a privacy-safe reviewing event with zeroed metrics and no reviewer output', () => {
    const event = startedEvent();
    const terminal = completedEvent();

    expect(event).toMatchObject({
      eventType: 'review.started',
      repository: terminal.repository,
      pullRequest: { number: terminal.pullRequest.number, headSha: terminal.pullRequest.headSha },
      workflow: terminal.workflow,
      review: {
        status: 'reviewing',
        durationMs: 0,
        severityCounts: { p0: 0, p1: 0, p2: 0 },
        coverage: { filesReviewed: 0, filesOmitted: 0, filesSkippedGenerated: 0, passes: 0 },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUSD: null },
        personas: [],
      },
    });
    expect(event.pullRequest.title).toBe('Review in progress');
    expect(event.review).not.toHaveProperty('verdict');
    expect(event.review).not.toHaveProperty('rationale');
    expect(event.review).not.toHaveProperty('findings');
    expect(validateSchema(event)).toBe(true);
    expect(validateSchema.errors).toBeNull();
    expect(JSON.stringify(event)).not.toMatch(/owner@example\.com|sk_123456789-secret|secret-model|Secret finding prose/u);
  });

  it('uses distinct deterministic event and delivery identities for started and terminal events', async () => {
    const started = startedEvent();
    const startedAgain = startedEvent();
    const terminal = completedEvent();
    const fetchImpl = vi.fn().mockResolvedValue({ status: 202 });

    expect(started.eventId).toMatch(/^ctre_[a-f0-9]{40}$/u);
    expect(started.eventId).toBe(startedAgain.eventId);
    expect(started.eventId).not.toBe(terminal.eventId);

    await dashboard.deliverReviewEvent({ event: started, apiKey: 'ctd_live_test_key', apiUrl: 'https://dashboard.test/api/v1/review-events', fetchImpl, wait: async () => {} });
    await dashboard.deliverReviewEvent({ event: terminal, apiKey: 'ctd_live_test_key', apiUrl: 'https://dashboard.test/api/v1/review-events', fetchImpl, wait: async () => {} });
    expect(fetchImpl.mock.calls[0][1].headers['Idempotency-Key']).toBe(started.eventId);
    expect(fetchImpl.mock.calls[1][1].headers['Idempotency-Key']).toBe(terminal.eventId);
    expect(fetchImpl.mock.calls[0][1].headers['Idempotency-Key']).not.toBe(fetchImpl.mock.calls[1][1].headers['Idempotency-Key']);
  });

  it('retries a started event with one stable idempotency key', async () => {
    const event = startedEvent();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 202 });

    await expect(dashboard.deliverReviewEvent({
      event,
      apiKey: 'ctd_live_test_key',
      apiUrl: 'https://dashboard.test/api/v1/review-events',
      fetchImpl,
      wait: async () => {},
    })).resolves.toMatchObject({ status: 'accepted', attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every((call) => call[1].headers['Idempotency-Key'] === event.eventId)).toBe(true);
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

  it('does not contact the cloud when either credential is missing', async () => {
    const fetchImpl = vi.fn();
    await expect(dashboard.deliverReviewEvent({ event: completedEvent(), apiKey: '', fetchImpl }))
      .resolves.toEqual({ status: 'disabled', attempts: 0 });
    await expect(dashboard.deliverReviewEvent({ event: completedEvent(), apiKey: 'ctd_live_test_key', apiUrl: '', fetchImpl }))
      .resolves.toEqual({ status: 'disabled', attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs exactly once and accepts every 2xx response', async () => {
    const event = completedEvent();
    const fetchImpl = vi.fn().mockResolvedValue({ status: 201 });

    await expect(dashboard.deliverReviewEvent({
      event,
      apiKey: 'ctd_live_test_key',
      apiUrl: 'https://dashboard.test/api/v1/review-events',
      fetchImpl,
      wait: async () => {},
    })).resolves.toMatchObject({ status: 'accepted', attempts: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://dashboard.test/api/v1/review-events');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer ctd_live_test_key',
        'Content-Type': 'application/json',
        'Idempotency-Key': event.eventId,
      },
      body: JSON.stringify(event),
    });
  });

  it.each([401, 422])('does not retry HTTP %s', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue({ status });
    await expect(dashboard.deliverReviewEvent({
      event: completedEvent(), apiKey: 'ctd_live_test_key', apiUrl: 'https://dashboard.test/api/v1/review-events', fetchImpl, wait: async () => {},
    })).resolves.toMatchObject({ status: 'failed', attempts: 1, reason: `HTTP ${status}` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries transient HTTP failures and remains fail-soft', async () => {
    const retryThenSuccess = vi.fn()
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 202 });
    await expect(dashboard.deliverReviewEvent({
      event: completedEvent(), apiKey: 'ctd_live_test_key', apiUrl: 'https://dashboard.test/api/v1/review-events', fetchImpl: retryThenSuccess, wait: async () => {},
    })).resolves.toMatchObject({ status: 'accepted', attempts: 2 });

    const exhausted = vi.fn().mockResolvedValue({ status: 500 });
    await expect(dashboard.deliverReviewEvent({
      event: completedEvent(), apiKey: 'ctd_live_test_key', apiUrl: 'https://dashboard.test/api/v1/review-events', fetchImpl: exhausted, wait: async () => {},
    })).resolves.toMatchObject({ status: 'failed', attempts: 3, reason: 'HTTP 500' });
    expect(exhausted).toHaveBeenCalledTimes(3);
  });

  it('keeps timeout and network errors fail-soft without exposing the key', async () => {
    const secret = 'ctd_live_do-not-log-this-key';
    const timeoutFetch = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })));
    }));
    await expect(dashboard.deliverReviewEvent({
      event: completedEvent(), apiKey: secret, apiUrl: 'https://dashboard.test/api/v1/review-events', fetchImpl: timeoutFetch, timeoutMs: 1, wait: async () => {},
    })).resolves.toMatchObject({ status: 'failed', attempts: 3, reason: 'timeout' });

    const networkFetch = vi.fn().mockRejectedValue(new Error(`response body contains ${secret}`));
    const networkResult = await dashboard.deliverReviewEvent({
      event: completedEvent(), apiKey: secret, apiUrl: 'https://dashboard.test/api/v1/review-events', fetchImpl: networkFetch, wait: async () => {},
    });
    expect(networkResult).toMatchObject({ status: 'failed', attempts: 3, reason: 'network error' });
    expect(networkFetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(networkResult)).not.toContain(secret);
  });
});
