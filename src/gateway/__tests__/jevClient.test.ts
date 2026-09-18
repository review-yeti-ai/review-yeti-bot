import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JevClient,
  DisabledJevClient,
  calculateFullJitterDelay,
  isTransientJevStatus,
  validateJevQuestions,
  MAX_CHOICE_OPTIONS,
  MIN_SCORE_LEVELS,
  MAX_SCORE_LEVELS,
  MIN_USEFUL_CALL_MS,
  type JevQuestion,
  type JevOutcome,
} from '../jevClient';
import { initTelemetry, getMetrics, getPrometheusMetrics, getRecentSpans, clearSpans } from '../../telemetry';
import { logger } from '../../utils/logger';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const BASE_QUESTIONS = {
  is_ambiguous: { type: 'noul', instructions: 'Is this ambiguous?' } as JevQuestion,
};

function baseClient(overrides: ConstructorParameters<typeof JevClient>[0] = {}) {
  return new JevClient({
    baseUrl: 'https://api.typesafe.ai/v1/systemone',
    apiKey: 'test-key',
    model: 'jev-latest',
    fetchImplementation: vi.fn(),
    ...overrides,
  });
}

describe('JevClient — ok outcome', () => {
  it('POSTs {model, state, questions} and returns a typed ok outcome on success', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: {
          is_ambiguous: { type: 'noul', noul: 0.24 },
        },
        usage: { input_tokens: 561, output_tokens: 58 },
      }),
    );
    const client = baseClient({ fetchImplementation });

    const outcome = await client.ask({ state: 'some diff text', questions: BASE_QUESTIONS });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.model).toBe('jev-1.13.0');
    expect(outcome.answers.is_ambiguous).toEqual({ type: 'noul', noul: 0.24 });
    expect(outcome.usage).toEqual({ input_tokens: 561, output_tokens: 58 });
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImplementation.mock.calls[0];
    expect(String(url)).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ model: 'jev-latest', state: 'some diff text', questions: BASE_QUESTIONS });
  });

  it('never touches the network for DisabledJevClient and always reports disabled', async () => {
    const client = new DisabledJevClient();
    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'disabled', durationMs: 0 });
  });
});

describe('JevClient — documented HTTP failures never reject', () => {
  it.each([
    [401, 'http_401'],
    [422, 'http_422'],
    [529, 'http_529'],
  ] as const)('maps HTTP %d to unavailable/%s without throwing', async (status, reason) => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse(status, { error: 'nope' }));
    const client = baseClient({ fetchImplementation, maxRetries: 0 });

    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason, durationMs: expect.any(Number) });
  });

  it('retries 429s with full-jitter backoff before giving up', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse(429, { error: 'slow down' }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const random = vi.fn().mockReturnValue(0.5);
    const client = baseClient({
      fetchImplementation,
      maxRetries: 2,
      initialRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      sleep,
      random,
      stageBudgetMs: 60_000,
    });

    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });

    expect(outcome).toEqual({ status: 'unavailable', reason: 'http_429', durationMs: expect.any(Number) });
    expect(fetchImplementation).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBe(calculateFullJitterDelay(0, 100, 1000, random));
  });

  it('does not retry a non-transient 422', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse(422, { error: 'bad question' }));
    const client = baseClient({ fetchImplementation, maxRetries: 3 });

    await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

describe('JevClient — malformed responses', () => {
  it('reports malformed on invalid JSON', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      new Response('not json{{{', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = baseClient({ fetchImplementation });
    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  it('reports malformed when an answer key is missing', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 10, output_tokens: 1 } }),
    );
    const client = baseClient({ fetchImplementation });
    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  it('reports malformed when an answer type does not match the question type', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_ambiguous: { type: 'choice', choice: 'c1', probabilities: { c1: 1 }, confidence: 1 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    );
    const client = baseClient({ fetchImplementation });
    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  it('reports malformed on an undocumented HTTP status', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const client = baseClient({ fetchImplementation, maxRetries: 0 });
    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });
});

describe('JevClient — never rejects for transport conditions', () => {
  it('resolves unavailable/timeout instead of throwing on a rejected fetch (e.g. ECONNREFUSED)', async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const client = baseClient({ fetchImplementation, maxRetries: 0 });
    await expect(client.ask({ state: 's', questions: BASE_QUESTIONS })).resolves.toEqual({
      status: 'unavailable',
      reason: 'timeout',
      durationMs: expect.any(Number),
    });
  });

  it('resolves unavailable/timeout when the call exceeds its budget', async () => {
    // Use an injected clock rather than real wall-clock timers: a real setTimeout racing a
    // tight millisecond budget is inherently flaky under CI scheduling jitter.
    const now = () => 0; // remaining budget never erodes on its own -- only the abort fires
    const fetchImplementation = vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const client = baseClient({
      fetchImplementation,
      now,
      perCallCapMs: 20,
      stageBudgetMs: 100,
      maxRetries: 0,
    });
    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'timeout', durationMs: expect.any(Number) });
  });
});

describe('JevClient — caller cancellation (signal)', () => {
  it('resolves promptly as unavailable when the caller aborts mid-flight, even against a fetch double that ignores its own signal', async () => {
    const controller = new AbortController();
    // Deliberately ignores init.signal: never settles, never observes abort on its own.
    // Promptness must come from ask()'s own signal race, not from the double cooperating.
    const fetchImplementation = vi.fn().mockImplementation(() => new Promise(() => {}));
    const client = baseClient({
      fetchImplementation,
      // A long cap/budget: if this test passes only because a timeout/deadline fired, that
      // proves nothing about caller cancellation. Promptness relative to this size is the point.
      perCallCapMs: 5_000,
      stageBudgetMs: 5_000,
      maxRetries: 0,
    });

    const askPromise = client.ask({ state: 's', questions: BASE_QUESTIONS, signal: controller.signal });
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(1));
    const abortedAt = Date.now();
    controller.abort();

    const outcome = await askPromise;
    const elapsedMs = Date.now() - abortedAt;

    expect(outcome).toEqual({ status: 'unavailable', reason: 'timeout', durationMs: expect.any(Number) });
    expect(elapsedMs).toBeLessThan(500);
  });

  it('resolves promptly when the caller aborts during a 429 retry backoff, without waiting for the jitter sleep to complete', async () => {
    const controller = new AbortController();
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse(429, { error: 'slow down' }));
    // Never resolves on its own -- if ask() waited for this, the test would hang.
    const sleep = vi.fn().mockImplementation(() => new Promise(() => {}));
    const client = baseClient({
      fetchImplementation,
      sleep,
      maxRetries: 3,
      stageBudgetMs: 60_000,
    });

    const askPromise = client.ask({ state: 's', questions: BASE_QUESTIONS, signal: controller.signal });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    controller.abort();

    const outcome = await askPromise;
    expect(outcome).toEqual({ status: 'unavailable', reason: 'timeout', durationMs: expect.any(Number) });
    // The backoff sleep was entered but never awaited to completion, and no retry followed it.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});

describe('JevClient — per-run stage budget', () => {
  it('never starts a call once remaining budget is below the useful minimum', async () => {
    let now = 0;
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_ambiguous: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const client = baseClient({
      fetchImplementation,
      now: () => now,
      stageBudgetMs: MIN_USEFUL_CALL_MS - 1,
      perCallCapMs: 5000,
    });

    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'budget_exhausted', durationMs: 0 });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('caps a call at min(perCallCap, remaining) — a per-call cap alone would not bound the second call', async () => {
    let now = 0;
    const fetchImplementation = vi.fn().mockImplementation(async () => {
      now += 40; // consumes most of a tight stage budget on the first call
      return jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_ambiguous: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const client = baseClient({
      fetchImplementation,
      now: () => now,
      stageBudgetMs: 50,
      perCallCapMs: 5000, // a large per-call cap that would not, alone, bound the second call
    });

    const first = await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(first.status).toBe('ok');

    const second = await client.ask({ state: 's2', questions: BASE_QUESTIONS });
    expect(second).toEqual({ status: 'unavailable', reason: 'budget_exhausted', durationMs: expect.any(Number) });
  });
});

describe('JevClient — programmer errors throw (fail loudly in CI)', () => {
  it('throws for more than 255 choice options', async () => {
    const criteria: Record<string, string | null> = {};
    for (let i = 0; i < 256; i++) criteria[`c${i}`] = null;
    const client = baseClient();
    await expect(
      client.ask({
        state: 's',
        questions: { pick: { type: 'choice', instructions: 'pick one', criteria } },
      }),
    ).rejects.toThrow(/255/);
  });

  it('throws for fewer than 2 score levels', async () => {
    const client = baseClient();
    await expect(
      client.ask({
        state: 's',
        questions: { rate: { type: 'score', instructions: 'rate it', criteria: ['only-one'] } },
      }),
    ).rejects.toThrow(/2/);
  });

  it('throws for more than 10 score levels', async () => {
    const client = baseClient();
    const criteria = Array.from({ length: 11 }, (_, i) => `level-${i}`);
    await expect(
      client.ask({
        state: 's',
        questions: { rate: { type: 'score', instructions: 'rate it', criteria } },
      }),
    ).rejects.toThrow(/10/);
  });

  it('throws for oversized state', async () => {
    const client = baseClient();
    await expect(
      client.ask({
        state: 'x'.repeat(300_000),
        questions: BASE_QUESTIONS,
      }),
    ).rejects.toThrow(/budget|size|large/i);
  });

  it('validateJevQuestions is the reusable guard the constructor and ask() share', () => {
    expect(() => validateJevQuestions(BASE_QUESTIONS)).not.toThrow();
    expect(() => validateJevQuestions({ rate: { type: 'score', instructions: 'x', criteria: [] } } as any)).toThrow();
  });
});

describe('JevClient — helper functions', () => {
  it('calculateFullJitterDelay stays within [0, min(max, initial*2^attempt))', () => {
    const random = () => 0.999999;
    expect(calculateFullJitterDelay(0, 100, 1000, random)).toBeLessThan(100);
    expect(calculateFullJitterDelay(5, 100, 1000, random)).toBeLessThan(1000);
  });

  it('isTransientJevStatus is true only for 429 and 529', () => {
    expect(isTransientJevStatus(429)).toBe(true);
    expect(isTransientJevStatus(529)).toBe(true);
    expect(isTransientJevStatus(401)).toBe(false);
    expect(isTransientJevStatus(422)).toBe(false);
    expect(isTransientJevStatus(500)).toBe(false);
  });

  it('exports the documented limits', () => {
    expect(MAX_CHOICE_OPTIONS).toBe(255);
    expect(MIN_SCORE_LEVELS).toBe(2);
    expect(MAX_SCORE_LEVELS).toBe(10);
  });
});

describe('JevClient — telemetry', () => {
  beforeEach(() => {
    initTelemetry('review-yeti-bot');
    clearSpans();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a review_yeti_jev span with seam, versioned model, question count, tokens, duration, outcome', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_ambiguous: { type: 'noul', noul: 0.24 } },
        usage: { input_tokens: 561, output_tokens: 58 },
      }),
    );
    const client = baseClient({ fetchImplementation });
    await client.ask({ state: 's', questions: BASE_QUESTIONS, seam: 'triage' });

    const spans = getRecentSpans({ name: 'review_yeti_jev' });
    expect(spans.length).toBeGreaterThanOrEqual(1);
    const span = spans[spans.length - 1];
    expect(span.attributes['review_yeti.jev.seam']).toBe('triage');
    expect(span.attributes['review_yeti.jev.model']).toBe('jev-1.13.0');
    expect(span.attributes['review_yeti.jev.question_count']).toBe(1);
    expect(span.attributes['review_yeti.jev.input_tokens']).toBe(561);
    expect(span.attributes['review_yeti.jev.outcome']).toBe('ok');
    expect(typeof span.attributes['review_yeti.jev.duration_ms']).toBe('number');
  });

  it('increments review_yeti_jev counters', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_ambiguous: { type: 'noul', noul: 0.24 } },
        usage: { input_tokens: 1000, output_tokens: 58 },
      }),
    );
    const client = baseClient({ fetchImplementation });
    await client.ask({ state: 's', questions: BASE_QUESTIONS });

    const text = await getPrometheusMetrics();
    expect(text).toContain('review_yeti_jev_requests_total');
    expect(text).toContain('review_yeti_jev_input_tokens_total');
    expect(text).toContain('review_yeti_jev_cost_usd_total');
    expect(text).toContain('review_yeti_jev_duration_seconds');
  });

  it('warns and counts when the response model differs from the configured pin — a real condition, not an outage', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.14.0',
        answers: { is_ambiguous: { type: 'noul', noul: 0.24 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    );
    const client = baseClient({ fetchImplementation, modelPin: 'jev-1.13.0' });
    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });

    // Pin drift is informational, not a failure: calibrated thresholds are stale, not the service down.
    expect(outcome.status).toBe('ok');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/model pin/i),
      expect.objectContaining({ expected: 'jev-1.13.0', actual: 'jev-1.14.0' }),
    );
    const text = await getPrometheusMetrics();
    expect(text).toContain('review_yeti_jev_model_pin_mismatch_total');
  });

  it('does not warn when the response model matches the pin', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_ambiguous: { type: 'noul', noul: 0.24 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    );
    const client = baseClient({ fetchImplementation, modelPin: 'jev-1.13.0' });
    await client.ask({ state: 's', questions: BASE_QUESTIONS });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
