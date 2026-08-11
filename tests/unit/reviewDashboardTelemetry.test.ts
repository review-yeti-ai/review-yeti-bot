import { describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import fs from 'node:fs';
import path from 'node:path';

const telemetry = require('../../src/telemetry/reviewDashboardTelemetry.js');
const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../schemas/review-event.v1.schema.json'), 'utf8'));
const validateSchema = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

const env = {
  GITHUB_REPOSITORY: 'Review-Yeti-AI/review-yeti-bot',
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '9876',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'pull_request',
  CT_REVIEW_VERSION: '1.1.0',
};

function completedEvent(overrides: Record<string, unknown> = {}) {
  return telemetry.buildReviewEvent({
    repository: 'review-yeti-ai/review-yeti-bot',
    prNumber: 42,
    title: 'Harden widget lookup',
    url: 'https://github.com/review-yeti-ai/review-yeti-bot/pull/42',
    headSha: 'A'.repeat(40),
    baseSha: 'B'.repeat(40),
    workflow: {
      runId: '9876',
      runAttempt: 2,
      url: 'https://github.com/review-yeti-ai/review-yeti-bot/actions/runs/9876',
      trigger: 'pull_request',
    },
    startedAt: '2026-08-10T20:00:00.000Z',
    completedAt: '2026-08-10T20:00:01.500Z',
    status: 'completed',
    verdict: 'FIX_FIRST',
    rationale: 'Fix owner@example.com access control; token sk_test_secret-value must not leak.',
    enforcementMode: 'advisory',
    severityCounts: { p0: 0, p1: 1, p2: 2 },
    coverage: { filesReviewed: 3, filesOmitted: 1, filesSkippedGenerated: 2, passes: 1 },
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUSD: 0.01 },
    arbitration: {
      algorithmVersion: 'arbitration-v1',
      expectedPersonas: ['security', 'testing'],
      completedPersonas: ['security', 'testing'],
      quorumSatisfied: true,
      coverageQuorumSatisfied: true,
      gateDecision: 'BLOCKED',
      mergeEligible: false,
      thresholds: { blockP1: 1, fixP2: 2 },
      publication: { publishedFindings: 1, rejectedFindings: 0 },
    },
    personas: [{
      persona: 'security',
      provider: 'openrouter',
      model: 'model-a',
      decision: 'FINDINGS',
      durationMs: 900,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUSD: 0.01 },
    }],
    findings: [{
      severity: 'P1',
      persona: 'security',
      path: 'src/widget.ts',
      side: 'RIGHT',
      line: 7,
      title: 'Missing tenant scope',
      body: 'The query can cross workspace boundaries. Bearer very-secret-token must not leak.',
      suggestion: 'Ask owner@example.com to include workspaceId in the predicate.',
    }],
    ...overrides,
  }, env);
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('review dashboard telemetry', () => {
  it('creates a deterministic id from normalized repository, PR, head, run, and attempt', () => {
    const input = { repository: 'Review-Yeti-AI/review-yeti-bot', prNumber: '42', headSha: 'ABC123', runId: ' 9876 ', runAttempt: '2' };
    const first = telemetry.createReviewEventId(input);
    const replay = telemetry.createReviewEventId({ ...input, repository: 'review-yeti-ai/review-yeti-bot', headSha: 'abc123' });

    expect(first).toBe(replay);
    expect(first).toMatch(/^ctre_[a-f0-9]{40}$/);
    expect(telemetry.createReviewEventId({ ...input, runAttempt: 3 })).not.toBe(first);
  });

  it('builds a payload accepted by the pinned review-event.v1 contract', () => {
    const event = completedEvent();
    const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'schemas/review-event.v1.schema.json'), 'utf8'));

    expect(schema.properties.schemaVersion.const).toBe('1.0');
    expect(schema.properties.eventId.pattern).toBe('^ctre_[a-f0-9]{40}$');
    expect(schema.$defs.arbitration.required).toEqual(expect.arrayContaining([
      'algorithmVersion', 'expectedPersonas', 'completedPersonas', 'quorumSatisfied',
      'coverageQuorumSatisfied', 'gateDecision', 'mergeEligible', 'thresholds',
    ]));
    expect(validateSchema(event)).toBe(true);
    expect(validateSchema.errors).toBeNull();
    expect(telemetry.validateReviewEvent(event)).toEqual([]);
    expect(event).toMatchObject({
      schemaVersion: '1.0',
      eventType: 'review.completed',
      producer: { name: 'ct-review-bot' },
      repository: { fullName: 'review-yeti-ai/review-yeti-bot' },
      pullRequest: { number: 42, headSha: 'A'.repeat(40), baseSha: 'B'.repeat(40) },
      workflow: { runId: '9876', runAttempt: 2, trigger: 'pull_request' },
      review: {
        status: 'completed',
        verdict: 'FIX_FIRST',
        durationMs: 1500,
        enforcement: { mode: 'advisory' },
        severityCounts: { p0: 0, p1: 1, p2: 2 },
        coverage: { filesReviewed: 3, filesOmitted: 1, filesSkippedGenerated: 2, passes: 1 },
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUSD: 0.01 },
      },
    });
    expect(event.review.personas[0]).toMatchObject({ persona: 'security', decision: 'FINDINGS' });
    expect(event.review.findings[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('redacts secrets and email addresses from review text and findings', () => {
    const serialized = JSON.stringify(completedEvent());

    expect(serialized).not.toContain('owner@example.com');
    expect(serialized).not.toContain('sk_test_secret-value');
    expect(serialized).not.toContain('very-secret-token');
    expect(serialized).toContain('[REDACTED_EMAIL]');
    expect(serialized).toContain('[REDACTED]');
  });

  it('preserves the advisory verdict when a review event is marked failed', () => {
    const failed = telemetry.markReviewEventFailed(completedEvent(), '2026-08-10T20:00:03.000Z');

    expect(failed.eventType).toBe('review.failed');
    expect(failed.review.status).toBe('failed');
    expect(failed.review.verdict).toBe('FIX_FIRST');
    expect(failed.review.durationMs).toBe(3000);
    expect(telemetry.validateReviewEvent(failed)).toEqual([]);
  });

  it('skips delivery and warns without credentials', async () => {
    const fetchImpl = vi.fn();
    const logs = logger();

    await expect(telemetry.deliverReviewEvent({ event: completedEvent(), url: 'https://dashboard.test', apiKey: '', fetchImpl, logger: logs }))
      .resolves.toEqual({ status: 'skipped', attempts: 0 });
    await expect(telemetry.deliverReviewEvent({ event: completedEvent(), url: '', apiKey: 'ctd_live_secret-key', fetchImpl, logger: logs }))
      .resolves.toEqual({ status: 'skipped', attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalled();
  });

  it('POSTs exactly once with the required headers and JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 202 });
    const event = completedEvent();

    await expect(telemetry.deliverReviewEvent({
      event,
      apiKey: 'ctd_live_secret-key',
      url: 'https://dashboard.test/events',
      fetchImpl,
      wait: async () => {},
    })).resolves.toEqual({ status: 'accepted', attempts: 1 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://dashboard.test/events');
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer ctd_live_secret-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': event.eventId,
      },
      body: JSON.stringify(event),
    });
  });

  it('treats 200 duplicate and 202 accepted responses as successful', async () => {
    await expect(telemetry.deliverReviewEvent({
      event: completedEvent(), apiKey: 'key', url: 'https://dashboard.test',
      fetchImpl: vi.fn().mockResolvedValue({ status: 200 }), wait: async () => {},
    })).resolves.toEqual({ status: 'duplicate', attempts: 1 });
    await expect(telemetry.deliverReviewEvent({
      event: completedEvent(), apiKey: 'key', url: 'https://dashboard.test',
      fetchImpl: vi.fn().mockResolvedValue({ status: 202 }), wait: async () => {},
    })).resolves.toEqual({ status: 'accepted', attempts: 1 });
  });

  it.each([401, 422])('does not retry non-transient HTTP %s', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue({ status });
    const result = await telemetry.deliverReviewEvent({
      event: completedEvent(), apiKey: 'key', url: 'https://dashboard.test', fetchImpl, wait: async () => {},
    });

    expect(result).toEqual({ status: 'failed', attempts: 1, reason: `HTTP ${status}` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 and 5xx only, then succeeds or fails fail-soft', async () => {
    const retryThenSuccess = vi.fn()
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 202 });
    await expect(telemetry.deliverReviewEvent({
      event: completedEvent(), apiKey: 'key', url: 'https://dashboard.test', fetchImpl: retryThenSuccess, wait: async () => {},
    })).resolves.toEqual({ status: 'accepted', attempts: 2 });

    const exhausted = vi.fn().mockResolvedValue({ status: 500 });
    await expect(telemetry.deliverReviewEvent({
      event: completedEvent(), apiKey: 'key', url: 'https://dashboard.test', fetchImpl: exhausted, wait: async () => {},
    })).resolves.toEqual({ status: 'failed', attempts: 3, reason: 'HTTP 500' });
    expect(exhausted).toHaveBeenCalledTimes(3);
  });

  it('keeps timeout and network failures out of the review result', async () => {
    const timeoutFetch = vi.fn((_url: string, request: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('AbortError')));
    }));
    await expect(telemetry.deliverReviewEvent({
      event: completedEvent(), apiKey: 'key', url: 'https://dashboard.test', fetchImpl: timeoutFetch, timeoutMs: 2, wait: async () => {},
    })).resolves.toEqual({ status: 'failed', attempts: 3, reason: 'timeout' });
    expect(timeoutFetch).toHaveBeenCalledTimes(3);

    const networkFetch = vi.fn().mockRejectedValue(new Error('socket reset with secret ctd_live_hidden'));
    await expect(telemetry.deliverReviewEvent({
      event: completedEvent(), apiKey: 'ctd_live_hidden', url: 'https://dashboard.test', fetchImpl: networkFetch, wait: async () => {},
    })).resolves.toEqual({ status: 'failed', attempts: 3, reason: 'network error' });
    expect(networkFetch).toHaveBeenCalledTimes(3);
  });

  it('never logs the dashboard key or response/error data', async () => {
    const logs = logger();
    const secret = 'ctd_live_do-not-log-this-key';
    await telemetry.deliverReviewEvent({
      event: completedEvent(), apiKey: secret, url: 'https://dashboard.test',
      fetchImpl: vi.fn().mockRejectedValue(new Error(`response body contains ${secret}`)),
      logger,
      wait: async () => {},
    });

    const output = JSON.stringify([...logs.info.mock.calls, ...logs.warn.mock.calls]);
    expect(output).not.toContain(secret);
    expect(output).not.toContain('response body contains');
  });
});
