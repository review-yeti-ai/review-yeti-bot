import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JevClient,
  JEV_SYSTEM_ONE_PATH,
  isScoreIndexKey,
  resolveJevEndpoint,
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
import { JEV_INPUT_TOKEN_USD_PER_MILLION } from '../../types/jevContract';
import { JEV_LIVE_RESPONSES } from './jevLiveResponses.fixture';
import { initTelemetry, getMetrics, getPrometheusMetrics, getRecentSpans, clearSpans } from '../../telemetry';
import { logger } from '../../utils/logger';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Verbatim live responses (jev-1.13.0), captured for REL-1100. */
const LIVE = JEV_LIVE_RESPONSES;

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

  // Envelope-level fields. Previously only the ANSWERS were exercised, so deleting any of the
  // three envelope guards left every test green while a 200 carrying no usage (or no model) was
  // reported as `ok` -- and cost/telemetry then read undefined token counts off it. A response
  // this client cannot fully interpret is malformed, not a success.
  const VALID_ANSWERS = { is_ambiguous: { type: 'noul', noul: 0.2 } };

  it('reports malformed when the envelope has no usage', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', answers: VALID_ANSWERS }),
    );
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  it('reports malformed when usage token counts are not numbers', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', answers: VALID_ANSWERS, usage: { input_tokens: '10', output_tokens: 1 } }),
    );
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  it('reports malformed when the envelope has no model', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { answers: VALID_ANSWERS, usage: { input_tokens: 10, output_tokens: 1 } }),
    );
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: BASE_QUESTIONS });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  it('reports malformed when answers is absent entirely', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 1 } }),
    );
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: BASE_QUESTIONS });
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

  it('throws for an unknown question type', () => {
    expect(() =>
      validateJevQuestions({ mystery: { type: 'oracle', instructions: 'what happens' } } as any),
    ).toThrow(/unknown type "oracle"/);
  });

  it('throws for empty instructions', () => {
    expect(() => validateJevQuestions({ is_ambiguous: { type: 'noul', instructions: '' } } as any)).toThrow(
      /requires non-empty instructions/,
    );
  });

  it('throws for whitespace-only instructions', () => {
    expect(() => validateJevQuestions({ is_ambiguous: { type: 'noul', instructions: '   ' } } as any)).toThrow(
      /requires non-empty instructions/,
    );
  });

  it('throws for an empty choice criteria map', () => {
    expect(() =>
      validateJevQuestions({ pick: { type: 'choice', instructions: 'pick one', criteria: {} } } as any),
    ).toThrow(/requires a non-empty criteria map/);
  });
});

describe('JevClient — https enforced at the client, not only at jevTransport', () => {
  it('throws when constructed with an http:// baseUrl', () => {
    expect(() => new JevClient({ baseUrl: 'http://api.typesafe.ai/v1/systemone', apiKey: 'k' })).toThrow(
      /https/i,
    );
  });

  it('throws when constructed with an unparseable baseUrl', () => {
    expect(() => new JevClient({ baseUrl: 'not a url', apiKey: 'k' })).toThrow();
  });

  it('does not throw for a bare https host (the endpoint path is appended, not required)', () => {
    expect(() => new JevClient({ baseUrl: 'https://api.typesafe.ai', apiKey: 'k' })).not.toThrow();
  });

  it('does not throw for the default https baseUrl or an explicit https baseUrl', () => {
    expect(() => new JevClient({ apiKey: 'k' })).not.toThrow();
    expect(() => new JevClient({ baseUrl: 'https://api.typesafe.ai/v1/systemone', apiKey: 'k' })).not.toThrow();
  });
});

describe('JevClient — endpoint resolution (REL-1100)', () => {
  it.each([
    ['https://api.typesafe.ai', 'https://api.typesafe.ai/v1/systemone'],
    ['https://api.typesafe.ai/', 'https://api.typesafe.ai/v1/systemone'],
    ['  https://api.typesafe.ai//  ', 'https://api.typesafe.ai/v1/systemone'],
    ['https://api.typesafe.ai:8443', 'https://api.typesafe.ai:8443/v1/systemone'],
    ['https://api.typesafe.ai/v1/systemone', 'https://api.typesafe.ai/v1/systemone'],
    ['https://api.typesafe.ai/v1/systemone/', 'https://api.typesafe.ai/v1/systemone'],
    ['https://proxy.example/typesafe/v1/systemone', 'https://proxy.example/typesafe/v1/systemone'],
    ['https://api.typesafe.ai/?region=us', 'https://api.typesafe.ai/?region=us'],
    // An EMPTY query or fragment reads as '' from URL#search/#hash: it must be dropped, never
    // left in front of the appended path (which would put the path inside the query/fragment).
    ['https://api.typesafe.ai?', 'https://api.typesafe.ai/v1/systemone'],
    ['https://api.typesafe.ai/?', 'https://api.typesafe.ai/v1/systemone'],
    ['https://api.typesafe.ai#', 'https://api.typesafe.ai/v1/systemone'],
    ['https://api.typesafe.ai?#', 'https://api.typesafe.ai/v1/systemone'],
    ['not a url', 'not a url'],
  ])('resolveJevEndpoint(%j) -> %j', (input, expected) => {
    expect(resolveJevEndpoint(input)).toBe(expected);
  });

  it('POSTs to /v1/systemone when configured with the bare host (the Doppler value REL-1081 shipped with)', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse(200, LIVE.noul));
    const client = baseClient({ baseUrl: 'https://api.typesafe.ai', fetchImplementation });
    const outcome = await client.ask({ state: 's', questions: { lane__sec: { type: 'noul', instructions: 'Review?' } } });
    expect(outcome.status).toBe('ok');
    expect(String(fetchImplementation.mock.calls[0][0])).toBe(`https://api.typesafe.ai${JEV_SYSTEM_ONE_PATH}`);
  });

  it('negative proof: an explicit endpoint path is never rewritten', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse(200, LIVE.noul));
    const client = baseClient({ baseUrl: 'https://proxy.example/jev', fetchImplementation });
    await client.ask({ state: 's', questions: { lane__sec: { type: 'noul', instructions: 'Review?' } } });
    expect(String(fetchImplementation.mock.calls[0][0])).toBe('https://proxy.example/jev');
  });
});

describe('isScoreIndexKey — the one definition of the score level key format', () => {
  it('accepts 0-based decimal index strings and nothing else', () => {
    for (const key of ['0', '1', '4', '9', '10']) expect(isScoreIndexKey(key)).toBe(true);
    for (const key of ['', '-1', '00', '01', '1.0', ' 1', '1 ', '+1', 'one', 'Level 1, trivial']) expect(isScoreIndexKey(key)).toBe(false);
  });
});

describe('JevClient — live noul and choice responses (REL-1100)', () => {
  it('accepts the live noul and choice responses verbatim', async () => {
    const noul = await baseClient({ fetchImplementation: vi.fn().mockResolvedValue(jsonResponse(200, LIVE.noul)) })
      .ask({ state: 's', questions: { lane__sec: { type: 'noul', instructions: 'Review?' } } });
    expect(noul).toMatchObject({ status: 'ok', answers: LIVE.noul.answers, usage: LIVE.noul.usage });
    const choice = await baseClient({ fetchImplementation: vi.fn().mockResolvedValue(jsonResponse(200, LIVE.choice)) })
      .ask({ state: 's', questions: { category: { type: 'choice', instructions: 'Which?', criteria: { source: 'src', test: 'tests' } } } });
    expect(choice).toMatchObject({ status: 'ok', answers: LIVE.choice.answers, usage: LIVE.choice.usage });
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

  it('increments review_yeti_jev counters, computing cost from the single shared pricing constant', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { is_ambiguous: { type: 'noul', noul: 0.24 } },
        usage: { input_tokens: 1000, output_tokens: 58 },
      }),
    );
    const client = baseClient({ fetchImplementation });

    // Spy on the exact counter, not on cumulative Prometheus text, so this assertion is
    // independent of accumulated state from other tests sharing the process-wide metrics
    // singleton (getMetrics() is a singleton; getPrometheusMetrics() output is cumulative).
    const costSpy = vi.spyOn(getMetrics().jevCostUsd, 'add');

    await client.ask({ state: 's', questions: BASE_QUESTIONS });

    const text = await getPrometheusMetrics();
    expect(text).toContain('review_yeti_jev_requests_total');
    expect(text).toContain('review_yeti_jev_input_tokens_total');
    expect(text).toContain('review_yeti_jev_cost_usd_total');
    expect(text).toContain('review_yeti_jev_duration_seconds');

    // Both the counter's HELP text and the runtime cost calculation must derive from the
    // same JEV_INPUT_TOKEN_USD_PER_MILLION constant -- a repricing cannot leave one stale.
    expect(text).toContain(
      `# HELP review_yeti_jev_cost_usd_total Cumulative Jev cost in USD (input_tokens x $${JEV_INPUT_TOKEN_USD_PER_MILLION} / 1e6).`,
    );
    const expectedCostUsd = (1000 * JEV_INPUT_TOKEN_USD_PER_MILLION) / 1_000_000;
    expect(costSpy).toHaveBeenCalledTimes(1);
    expect(costSpy.mock.calls[0][0]).toBeCloseTo(expectedCostUsd, 12);
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

/**
 * `validAnswerShape`'s choice and score branches were introduced by this PR and had no direct
 * coverage: every ok-case fixture used a well-formed `noul`, and every malformed-case fixture
 * varied only envelope-level fields. Dropping the `probabilities` object check, or any other
 * loosening of these branches, passed the whole suite unchanged.
 *
 * These pin the branches as they actually behave TODAY, including the deliberate limit for
 * CHOICE answers: the client validates answer SHAPE, not the CONTENT of the probability map. The
 * values inside are not checked and `choice` is not required to be one of the question's
 * criteria keys. SCORE answers are the exception since REL-1100: their probability keys must name
 * a legend index and their values must be numbers, because the shadow triage derives the risk
 * level as the argmax over them and a key outside the legend would name a level nobody defined. That is a
 * real boundary -- the vendor guarantees a typed answer, so content validation here would be
 * duplicating a contract we do not own -- and it should change by decision, not by drift. If it
 * is ever tightened, the last test here is the one that must be updated deliberately.
 */
describe('JevClient — answer shape validation for choice and score', () => {
  const CHOICE_Q = {
    resolves_to: {
      type: 'choice', instructions: 'Which definition?',
      criteria: { c1: 'same module', c2: 'other module' },
    } as JevQuestion,
  };
  // Five levels, like the shadow triage's risk question: the live legend has indices 0..4.
  const SCORE_Q = {
    risk: {
      type: 'score', instructions: 'How risky?',
      criteria: ['Level 1, trivial: x', 'Level 2, low: x', 'Level 3, moderate: x', 'Level 4, high: x', 'Level 5, critical: x'],
    } as JevQuestion,
  };

  function okChoice(over: Record<string, unknown> = {}) {
    return { type: 'choice', choice: 'c1', confidence: 0.94, probabilities: { c1: 0.97, c2: 0.03 }, ...over };
  }
  /** The live score answer (REL-1100 capture), optionally overridden. */
  function okScore(over: Record<string, unknown> = {}) {
    return { ...LIVE.score.answers.risk, ...over };
  }

  it('accepts a well-formed choice answer', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', answers: { resolves_to: okChoice() }, usage: { input_tokens: 5, output_tokens: 1 } }),
    );
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: CHOICE_Q });
    expect(outcome.status).toBe('ok');
  });

  it('rejects a choice answer whose probabilities is not an object', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', answers: { resolves_to: okChoice({ probabilities: 'nope' }) }, usage: { input_tokens: 5, output_tokens: 1 } }),
    );
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: CHOICE_Q });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  it('rejects a choice answer whose probabilities is null', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', answers: { resolves_to: okChoice({ probabilities: null }) }, usage: { input_tokens: 5, output_tokens: 1 } }),
    );
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: CHOICE_Q });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  it('rejects a choice answer with a non-numeric confidence', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', answers: { resolves_to: okChoice({ confidence: 'high' }) }, usage: { input_tokens: 5, output_tokens: 1 } }),
    );
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: CHOICE_Q });
    expect(outcome).toEqual({ status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) });
  });

  async function askScore(answer: unknown) {
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, { model: 'jev-1.13.0', answers: { risk: answer }, usage: { input_tokens: 5, output_tokens: 1 } }),
    );
    return baseClient({ fetchImplementation }).ask({ state: 's', questions: SCORE_Q });
  }
  const MALFORMED = { status: 'unavailable', reason: 'malformed', durationMs: expect.any(Number) };

  it('accepts the live score response verbatim: index-keyed legend, continuous score (REL-1100)', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse(200, LIVE.score));
    const outcome = await baseClient({ fetchImplementation }).ask({ state: 's', questions: SCORE_Q });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.model).toBe('jev-1.13.0');
    expect(outcome.usage).toEqual({ input_tokens: 333, output_tokens: 17 });
    expect(outcome.answers.risk).toEqual(LIVE.score.answers.risk);
  });

  it('pins what the live score means: the expected 0-based level index, sum(index * probability)', () => {
    // Documents the vendor semantics the shadow's level derivation relies on NOT using: the score
    // is a mean in [0, n-1], not a level and not a [0,1] probability. If a future model changes
    // this, this test (not a silent log drift) is where it shows up.
    const risk = LIVE.score.answers.risk;
    const expected = Object.entries(risk.probabilities as Record<string, number>)
      .reduce((sum, [index, p]) => sum + Number(index) * p, 0);
    expect(risk.score).toBeCloseTo(expected, 2);
  });

  it('negative proof: the pre-REL-1100 array-only legend check rejects the live score response', () => {
    // A literal copy of the score branch this PR replaced. It is why every shadow call on
    // 2026-09-24 logged outcome=unavailable reason=malformed. If this ever passes, the live
    // fixture no longer represents the contract and the suite above proves nothing.
    const legacyScoreShape = (a: Record<string, unknown>) =>
      typeof a.score === 'number' && Array.isArray(a.legend) && typeof a.confidence === 'number' &&
      typeof a.probabilities === 'object' && a.probabilities !== null;
    expect(legacyScoreShape(LIVE.score.answers.risk)).toBe(false);
  });

  it('back-compat: accepts an array legend and normalizes it (and text-keyed probabilities) to index keys', async () => {
    const outcome = await askScore({
      type: 'score', score: 0.5, confidence: 0.6,
      legend: ['low', 'medium', 'high'],
      probabilities: { low: 0.1, high: 0.7, '1': 0.2 },
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.answers.risk).toEqual({
      type: 'score', score: 0.5, confidence: 0.6,
      legend: { '0': 'low', '1': 'medium', '2': 'high' },
      probabilities: { '0': 0.1, '2': 0.7, '1': 0.2 },
    });
  });

  it('back-compat: a duplicated array-legend text maps text-keyed probabilities to its FIRST index', async () => {
    const outcome = await askScore({ type: 'score', score: 0.5, confidence: 0.6, legend: ['a', 'a'], probabilities: { a: 1 } });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.answers.risk).toMatchObject({ legend: { '0': 'a', '1': 'a' }, probabilities: { '0': 1 } });
  });

  it.each([
    ['a string legend', { legend: 'low,medium' }],
    ['a null legend', { legend: null }],
    ['a missing legend', { legend: undefined }],
    ['an empty legend object', { legend: {} }],
    ['an empty legend array', { legend: [] }],
    ['a non-index legend key', { legend: { low: 'Level 1' } }],
    ['a negative legend index', { legend: { '-1': 'Level 0' } }],
    ['a zero-padded legend index', { legend: { '00': 'Level 1' } }],
    ['a legend index past the question\'s levels', { legend: { '0': 'a', '5': 'b' }, probabilities: { '0': 1 } }],
    ['a non-string legend value', { legend: { '0': 1 } }],
    ['a non-string element in an array legend', { legend: ['low', 42, 'high'], probabilities: { low: 0.1 } }],
    ['an array legend longer than the question\'s levels', { legend: ['a', 'b', 'c', 'd', 'e', 'f'], probabilities: {} }],
    ['a probability key not in the legend', { probabilities: { '0': 0.5, '7': 0.5 } }],
    ['a probability keyed by level text for an object legend', { probabilities: { 'Level 1, trivial': 1 } }],
    ['a non-numeric probability', { probabilities: { '0': 'high' } }],
    ['a probabilities array', { probabilities: [0.8, 0.2] }],
    ['null probabilities', { probabilities: null }],
    ['a non-numeric score', { score: '0.32' }],
    ['a non-finite confidence', { confidence: Number.NaN }],
  ])('rejects a score answer with %s as malformed', async (_label, over) => {
    expect(await askScore(okScore(over))).toEqual(MALFORMED);
  });

  it('does NOT validate probability-map contents, by design', async () => {
    // Shape only. Non-numeric values, and a `choice` outside the question's criteria keys, are
    // accepted. Documented deliberately: tightening this is a decision about owning the vendor's
    // answer contract, and this test is where that decision becomes visible.
    const fetchImplementation = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'jev-1.13.0',
        answers: { resolves_to: okChoice({ choice: 'not-a-criteria-key', probabilities: { c1: 'not-a-number' } }) },
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    );
    expect((await baseClient({ fetchImplementation }).ask({ state: 's', questions: CHOICE_Q })).status).toBe('ok');
  });
});

describe('JevClient — unavailable outcomes are measured too', () => {
  it('labels the request counter, duration, and span with the unavailable REASON', async () => {
    // Only the ok path asserted metrics, so the outcome label on the unavailable path could be
    // recorded as a literal, omitted, or mislabelled with every test still green -- and an
    // outage would then be indistinguishable from success in the dashboards this instruments.
    const fetchImplementation = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const client = baseClient({ fetchImplementation, maxRetries: 0 });

    const requestsSpy = vi.spyOn(getMetrics().jevRequests, 'add');
    const durationSpy = vi.spyOn(getMetrics().jevDuration, 'record');
    const tokensSpy = vi.spyOn(getMetrics().jevInputTokens, 'add');
    clearSpans();

    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS, seam: 'unit-seam' });
    expect(outcome.status).toBe('unavailable');

    expect(requestsSpy).toHaveBeenCalledWith(1, expect.objectContaining({ seam: 'unit-seam', outcome: 'http_429' }));
    expect(durationSpy).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ outcome: 'http_429' }));
    // Cost and token counters are ok-path only: an unavailable call consumed no billable input.
    expect(tokensSpy).not.toHaveBeenCalled();

    const span = getRecentSpans().find((sp) => sp.name === 'review_yeti_jev');
    expect(span?.attributes?.['review_yeti.jev.outcome']).toBe('http_429');

    requestsSpy.mockRestore(); durationSpy.mockRestore(); tokensSpy.mockRestore();
  });
});

describe('JevClient — retry budget exhaustion', () => {
  it('returns the last attempt outcome instead of sleeping when no budget remains', async () => {
    // `remaining <= 0` after a transient failure is a distinct branch from a null per-call
    // budget. Untested, a broken implementation could sleep anyway, loop, or relabel the result
    // as budget_exhausted -- losing the real reason the call failed.
    const fetchImplementation = vi.fn().mockResolvedValue(new Response('', { status: 529 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const client = baseClient({
      fetchImplementation,
      sleep,
      // This branch sits in a narrow window between two thresholds, and the window was found by
      // sweeping rather than by reasoning about the call sequence -- three attempts to derive it
      // analytically all landed on `budget_exhausted` instead, because the number of `now()`
      // reads before the first attempt is an implementation detail, not something to model from
      // the outside. At attempt start the remaining budget must be >= MIN_USEFUL_CALL_MS (20) or
      // `nextCallBudgetMs()` returns null and we take the OTHER branch; by the retry check it
      // must be <= 0. (d=20, B=60) sits in that window. The assertions below pin the branch by
      // its observable consequences -- original reason preserved, no sleep -- so a future change
      // to the call sequence fails loudly here rather than silently testing the wrong path.
      stageBudgetMs: 60,
      maxRetries: 2,
      now: () => { clock += 20; return clock; },
    });

    const outcome = await client.ask({ state: 's', questions: BASE_QUESTIONS });

    expect(outcome.status).toBe('unavailable');
    // The ORIGINAL failure reason survives -- not relabelled as budget_exhausted.
    expect((outcome as { reason: string }).reason).toBe('http_529');
    // And it did not sleep on a budget it did not have.
    expect(sleep).not.toHaveBeenCalled();
  });
});
