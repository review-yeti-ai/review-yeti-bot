import { describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const root = fs.existsSync(path.join(path.resolve(__dirname, '../..'), 'src/telemetry/reviewTelemetry.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const telemetryModule = require(path.join(root, 'src/telemetry/reviewTelemetry.js'));
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));

const identity = {
  repository: 'review-yeti-ai/review-yeti-bot',
  prNumber: 42,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  policyDigest: 'c'.repeat(64),
};

describe('review telemetry', () => {
  it('uses deterministic event IDs while pseudonymizing persona IDs', async () => {
    const events: any[] = [];
    const telemetry = telemetryModule.createReviewTelemetry({
      identity,
      sink: { async emit(event: unknown) { events.push(event); } },
      clock: () => 1_700_000_000_000,
    });

    const first = telemetry.record({ phase: 'model', unitId: 'pass-1', personaId: 'security', outcome: 'completed' });
    const second = telemetry.record({ phase: 'model', unitId: 'pass-1', personaId: 'security', outcome: 'completed' });
    await telemetry.flush();

    expect(first.eventId).toBe(second.eventId);
    expect(first).toMatchObject({ schemaVersion: 'review-telemetry-v1', phase: 'model', outcome: 'completed' });
    expect(first.personaId).not.toBe('security');
    expect(first.personaId).toBe('p01');
    expect(JSON.stringify(events)).not.toContain('security');

    const failed = telemetry.record({ phase: 'model', unitId: 'pass-1', personaId: 'security', outcome: 'failed', failureClass: 'provider_timeout' });
    expect(failed.eventId).not.toBe(first.eventId);
  });

  it('keeps attributes bounded and excludes prose, secrets, URLs, and error objects', async () => {
    const events: any[] = [];
    const telemetry = telemetryModule.createReviewTelemetry({ identity, sink: { async emit(event: unknown) { events.push(event); } } });
    const event = telemetry.record({
      phase: 'publication',
      unitId: 'review-comment',
      providerId: 'OpenRouter',
      modelId: 'deepseek/deepseek-v4-flash-0731',
      outcome: 'failed',
      failureClass: 'provider_unavailable',
      latencyMs: 123.9,
      prompt: 'ignore previous instructions',
      comment: 'a PR comment',
      author: 'somebody',
      transcript: 'full model transcript',
      source: 'const token = secret',
      endpoint: 'https://alice:token@example.test/v1?api_key=secret',
      error: new Error('super-secret'),
      arbitrary: 'another secret',
    });
    await telemetry.flush();

    expect(event).toMatchObject({ providerId: 'openrouter', modelId: 'deepseek/deepseek-v4-flash-0731', failureClass: 'provider_unavailable', latencyMs: 123 });
    expect(event).not.toHaveProperty('prompt');
    expect(event).not.toHaveProperty('comment');
    expect(event).not.toHaveProperty('error');
    expect(JSON.stringify(events)).not.toMatch(/secret|instructions|somebody|transcript|example\.test/i);

    const unsafeRoute = telemetryModule.normalizeEvent(identity, {
      phase: 'model', unitId: 'pass-2', outcome: 'completed', providerId: 'provider-a', modelId: 'sk_live_abcDEF1234567890',
    });
    expect(unsafeRoute.providerId).toBe('other');
    expect(unsafeRoute).not.toHaveProperty('modelId');
    expect(JSON.stringify(unsafeRoute)).not.toContain('sk_live');
  });

  it('includes usage and cost only when a provider receipt is supplied', () => {
    const telemetry = telemetryModule.createReviewTelemetry({ identity });
    const unbacked = telemetry.record({
      phase: 'model', unitId: 'pass-1', outcome: 'completed',
      usage: { promptTokens: 10, completionTokens: 4, costUSD: 1.25 },
    });
    const backed = telemetry.record({
      phase: 'model', unitId: 'pass-2', outcome: 'completed',
      usage: { receiptId: 'gen_123', promptTokens: 10, completionTokens: 4, costUSD: 1.25 },
    });

    expect(unbacked).not.toHaveProperty('usage');
    expect(backed.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14, costUSD: 1.25 });
    expect(JSON.stringify(backed)).not.toContain('gen_123');

    const tokensOnly = telemetry.record({
      phase: 'model', unitId: 'pass-3', outcome: 'completed',
      usage: { receiptId: 'gen_456', promptTokens: 6, completionTokens: 2 },
    });
    expect(tokensOnly.usage).toEqual({ promptTokens: 6, completionTokens: 2, totalTokens: 8 });
  });

  it('omits telemetry usage when the provider did not supply a receipt-backed usage payload', async () => {
    const events: any[] = [];
    await pipeline.reviewWithModel(
      { id: 'security', name: 'Security', charter: 'Review safely.' },
      [{ path: 'src/app.js', patch: '+const safe = true;', addedLines: [{ text: 'const safe = true;' }] }],
      { repo: identity.repository, prNumber: '42', headSha: identity.headSha },
      {},
      {
        model: 'model-a', apiKey: 'test-key', baseUrl: 'https://api.example.test', maxAttempts: 1,
        reviewTelemetry: { record(event: unknown) { events.push(event); } },
        fetchImplementation: async () => ({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ model: 'model-a', provider: 'provider-a', id: 'gen_123', choices: [{ message: { content: '{"findings":[]}' } }] }),
        }),
      },
    );

    expect(events).toMatchObject([{ phase: 'model', outcome: 'completed' }]);
    expect(events[0]).not.toHaveProperty('usage');
  });

  it('keeps receipt-backed tokens but omits cost when the provider did not return a cost field', async () => {
    for (const cost of [null, '']) {
      const events: any[] = [];
      await pipeline.reviewWithModel(
        { id: 'security', name: 'Security', charter: 'Review safely.' },
        [{ path: 'src/app.js', patch: '+const safe = true;', addedLines: [{ text: 'const safe = true;' }] }],
        { repo: identity.repository, prNumber: '42', headSha: identity.headSha },
        {},
        {
          model: 'model-a', apiKey: 'test-key', baseUrl: 'https://api.example.test', maxAttempts: 1,
          reviewTelemetry: { record(event: unknown) { events.push(event); } },
          fetchImplementation: async () => ({
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ model: 'model-a', provider: 'provider-a', id: 'gen_123', usage: { prompt_tokens: 10, completion_tokens: 4, cost }, choices: [{ message: { content: '{"findings":[]}' } }] }),
          }),
        },
      );

      expect(events[0].usage).toEqual({ receiptId: 'gen_123', promptTokens: 10, completionTokens: 4 });
      expect(events[0].usage).not.toHaveProperty('costUSD');
    }

    const blankCost = telemetryModule.createReviewTelemetry({ identity }).record({
      phase: 'model', unitId: 'model-1-attempt-1', outcome: 'completed',
      usage: { receiptId: 'gen_456', promptTokens: 1, completionTokens: 2, costUSD: '' },
    });
    expect(blankCost.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });

    const explicitZero = telemetryModule.createReviewTelemetry({ identity }).record({
      phase: 'model', unitId: 'model-1-attempt-1', outcome: 'completed',
      usage: { receiptId: 'gen_789', promptTokens: 1, completionTokens: 2, costUSD: 0 },
    });
    expect(explicitZero.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3, costUSD: 0 });
  });

  it('rejects incomplete or malformed review identity coordinates', () => {
    expect(() => telemetryModule.createReviewTelemetry({ identity: { ...identity, headSha: 'head' } })).toThrow('headSha');
    expect(() => telemetryModule.createReviewTelemetry({ identity: { ...identity, prNumber: 0 } })).toThrow('prNumber');
  });

  it('maps arbitrary high-cardinality unit, provider, and model labels to bounded telemetry slots', () => {
    const event = telemetryModule.createReviewTelemetry({ identity }).record({
      phase: 'model', unitId: 'unbounded-model-call-824780', providerId: 'provider-824780', modelId: 'model-824780', outcome: 'completed',
    });

    expect(event.unitId).toBe('other');
    expect(event.providerId).toBe('other');
    expect(event.modelId).toBe('other');
  });

  it('maps unknown personas to a fixed custom slot without retaining their raw ID', () => {
    const event = telemetryModule.createReviewTelemetry({ identity }).record({
      phase: 'model', unitId: 'model-1-attempt-1', personaId: 'tenant-reviewer-824780', outcome: 'completed',
    });

    expect(event.personaId).toBe('p_custom');
    expect(JSON.stringify(event)).not.toContain('tenant-reviewer');
  });

  it('captures exporter outages as export_unavailable without rejecting review telemetry', async () => {
    const events: any[] = [];
    const telemetry = telemetryModule.createReviewTelemetry({
      identity,
      sink: { async emit(event: unknown) { events.push(event); } },
      exporter: {
        endpoint: 'https://otel.example.test/v1/traces',
        fetchImplementation: async () => { throw new Error('network token=do-not-leak'); },
      },
    });

    telemetry.record({ phase: 'review', unitId: 'pipeline', outcome: 'completed' });
    await expect(telemetry.flush()).resolves.toMatchObject({ status: 'unavailable' });

    expect(events.some((event) => event.failureClass === 'export_unavailable')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('do-not-leak');
  });

  it('does not let synchronous sink or exporter failures escape record()', async () => {
    const telemetry = telemetryModule.createReviewTelemetry({
      identity,
      sink: { emit() { throw new Error('sink-secret'); } },
      exporter: { endpoint: 'https://otel.example.test/v1/traces', fetchImplementation() { throw new Error('exporter-secret'); } },
    });

    expect(() => telemetry.record({ phase: 'review', unitId: 'pipeline', outcome: 'completed' })).not.toThrow();
    await expect(telemetry.flush()).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('flushes pending exports and treats cancellation as a receipt instead of a pipeline failure', async () => {
    let release: (() => void) | undefined;
    let aborted = false;
    const telemetry = telemetryModule.createReviewTelemetry({
      identity,
      exporter: {
        endpoint: 'https://otel.example.test/v1/traces',
        fetchImplementation: async (_url: string, options: any) => new Promise((resolve) => {
          options.signal.addEventListener('abort', () => { aborted = true; });
          release = () => resolve({ ok: true, status: 200 });
        }),
      },
    });
    telemetry.record({ phase: 'review', unitId: 'pipeline', outcome: 'completed' });
    const controller = new AbortController();
    controller.abort();

    await expect(telemetry.flush({ signal: controller.signal })).resolves.toMatchObject({ status: 'cancelled' });
    expect(aborted).toBe(true);
    release?.();
    await expect(telemetry.flush()).resolves.toMatchObject({ status: 'exported', pending: 0 });
  });

  it('cancels an already-started hanging exporter and bounds telemetry delivery', async () => {
    const telemetry = telemetryModule.createReviewTelemetry({
      identity,
      exporter: {
        endpoint: 'https://otel.example.test/v1/traces',
        timeoutMs: 5_000,
        fetchImplementation: async (_url: string, options: any) => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      },
    });
    telemetry.record({ phase: 'review', unitId: 'pipeline', outcome: 'completed' });
    const controller = new AbortController();
    const flushed = telemetry.flush({ signal: controller.signal });
    controller.abort();

    await expect(flushed).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('keeps cancellation local when the exporter signal is already aborted', async () => {
    const exporterController = new AbortController();
    const events: any[] = [];
    let requests = 0;
    const telemetry = telemetryModule.createReviewTelemetry({
      identity,
      sink: { emit(event: unknown) { events.push(event); } },
      exporter: {
        endpoint: 'https://otel.example.test/v1/traces',
        signal: exporterController.signal,
        fetchImplementation: async () => {
          requests += 1;
          return { ok: true, status: 200 };
        },
      },
    });
    exporterController.abort();

    telemetry.record({ phase: 'review', unitId: 'pipeline', outcome: 'cancelled', failureClass: 'cancelled' });
    await Promise.resolve();

    expect(requests).toBe(0);
    expect(events).toMatchObject([{ outcome: 'cancelled', failureClass: 'cancelled' }]);
    expect(events.some((event) => event.failureClass === 'export_unavailable')).toBe(false);
    await expect(telemetry.flush({ signal: exporterController.signal })).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('records receipt-backed provider usage for each model request without storing the receipt ID', async () => {
    const events: any[] = [];
    await pipeline.reviewWithModel(
      { id: 'security', name: 'Security', charter: 'Review safely.' },
      [{ path: 'src/app.js', patch: '+const safe = true;', addedLines: [{ text: 'const safe = true;' }] }],
      { repo: identity.repository, prNumber: '42', headSha: identity.headSha },
      {},
      {
        model: 'model-a', apiKey: 'test-key', baseUrl: 'https://api.example.test', maxAttempts: 1,
        reviewTelemetry: { record(event: unknown) { events.push(event); } },
        fetchImplementation: async () => ({
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ model: 'model-a', provider: 'provider-a', id: 'gen-secret', usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.01 }, choices: [{ message: { content: '{"findings":[]}' } }] }),
        }),
      },
    );

    expect(events).toMatchObject([{ phase: 'model', outcome: 'completed', providerId: 'provider-a', modelId: 'model-a', usage: { receiptId: 'gen-secret', promptTokens: 10, completionTokens: 4, costUSD: 0.01 } }]);
  });
});
