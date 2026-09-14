import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LiveStreamBus } from '../../src/live/liveStreamBus';
import {
  OpenRouterClient,
  OpenRouterResponseError,
  OpenRouterTimeoutError,
  calculateFullJitterDelay,
  isTransientGatewayError,
} from '../../src/gateway/openRouterClient';

const baseRequest = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user' as const, content: 'adversarial test diff' }],
  timeoutMs: 5000,
};

function sdkChatResult(content: string, usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }) {
  return {
    id: 'chatcmpl-adv-replay',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'openai/gpt-4o-mini',
    system_fingerprint: null,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage,
  };
}

function sdkChunk(delta: Record<string, unknown>, options: { model?: string; finish_reason?: string | null } = {}) {
  return JSON.stringify({
    id: 'chatcmpl-adv-chunk',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: options.model || 'openai/gpt-4o-mini',
    choices: [{ index: 0, finish_reason: options.finish_reason ?? null, delta }],
  });
}

describe('Challenger 1 Adversarial Stress & Empirical Verification Suite', () => {
  let unhandledRejections: any[] = [];
  let unhandledHandler: (reason: any) => void;

  beforeEach(() => {
    unhandledRejections = [];
    unhandledHandler = (reason: any) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', unhandledHandler);
  });

  afterEach(() => {
    process.removeListener('unhandledRejection', unhandledHandler);
    expect(unhandledRejections).toEqual([]);
  });

  describe('1. 504 Gateway Timeout Exhaustion & Error Invariants', () => {
    it('exhausts maxRetries (default 2, total 3 attempts) on continuous 504 and throws OpenRouterResponseError with status 504 (non-streaming)', async () => {
      let callCount = 0;
      const fetchImplementation = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout from upstream Ollama' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      let caughtError: any;
      try {
        await client.complete({ ...baseRequest, stream: false });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(OpenRouterResponseError);
      expect(caughtError.name).toBe('OpenRouterResponseError');
      expect(caughtError.status).toBe(504);
      expect(caughtError.message).toMatch(/504/);
      expect(fetchImplementation).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('exhausts maxRetries (default 2, total 3 attempts) on continuous 504 and throws OpenRouterResponseError with status 504 (streaming SSE)', async () => {
      let callCount = 0;
      const fetchImplementation = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout on SSE stream' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      let caughtError: any;
      try {
        await client.complete({ ...baseRequest, stream: true });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(OpenRouterResponseError);
      expect(caughtError.name).toBe('OpenRouterResponseError');
      expect(caughtError.status).toBe(504);
      expect(caughtError.message).toMatch(/504/);
      expect(fetchImplementation).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('fails immediately when maxRetries is 0 on 504 without sleeping', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() => {
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn();
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 0,
      });

      await expect(client.complete({ ...baseRequest, stream: false })).rejects.toMatchObject({
        name: 'OpenRouterResponseError',
        status: 504,
      });

      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('honors high maxRetries (4 retries = 5 attempts) before exhausting on 504', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() => {
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Persistent Gateway Timeout' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 4,
      });

      await expect(client.complete({ ...baseRequest, stream: false })).rejects.toMatchObject({
        name: 'OpenRouterResponseError',
        status: 504,
      });

      expect(fetchImplementation).toHaveBeenCalledTimes(5);
      expect(sleep).toHaveBeenCalledTimes(4);
    });

    it('per-request maxRetries override takes precedence over client options on 504', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() => {
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 5,
      });

      await expect(client.complete({
        ...baseRequest,
        stream: false,
        maxRetries: 1, // Override 5 -> 1 retry (2 total attempts)
      })).rejects.toMatchObject({
        name: 'OpenRouterResponseError',
        status: 504,
      });

      expect(fetchImplementation).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('records provider_5xx failure on LiveStreamBus ONLY upon final exhaustion', async () => {
      const busEvents: any[] = [];
      const spy = vi.spyOn(LiveStreamBus.getInstance(), 'publishEvent').mockImplementation((ev: any) => {
        busEvents.push(ev);
      });

      const fetchImplementation = vi.fn().mockImplementation(() => {
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      await expect(client.complete({
        ...baseRequest,
        jobId: 'job-adv-504-exhaust',
        stream: false,
      })).rejects.toMatchObject({
        name: 'OpenRouterResponseError',
        status: 504,
      });

      expect(busEvents.length).toBe(1);
      expect(busEvents[0]).toMatchObject({
        jobId: 'job-adv-504-exhaust',
        data: {
          outcome: 'failed',
          failureClass: 'provider_5xx',
          responseStatus: 504,
        },
      });

      spy.mockRestore();
    });
  });

  describe('2. Non-Retryable 4xx Status Codes (Zero Retries, Immediate Failure)', () => {
    const nonRetryableCodes = [
      { status: 400, name: 'Bad Request', failureClass: 'response' },
      { status: 401, name: 'Unauthorized', failureClass: 'response' },
      { status: 403, name: 'Forbidden', failureClass: 'response' },
      { status: 404, name: 'Not Found', failureClass: 'response' },
      { status: 422, name: 'Unprocessable Entity', failureClass: 'response' },
      { status: 429, name: 'Too Many Requests', failureClass: 'rate_limit' },
    ];

    for (const { status, name, failureClass } of nonRetryableCodes) {
      it(`does NOT retry non-streaming HTTP ${status} (${name}) and fails immediately`, async () => {
        const fetchImplementation = vi.fn().mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({
            error: { code: status, message: `Mock ${name} failure` },
          }), {
            status,
            headers: { 'content-type': 'application/json' },
          }))
        );
        const sleep = vi.fn();
        const client = new OpenRouterClient({
          apiKey: 'adv-test-key',
          fetchImplementation,
          sleep,
          maxRetries: 3,
        });

        let caughtError: any;
        try {
          await client.complete({ ...baseRequest, stream: false });
        } catch (err) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(OpenRouterResponseError);
        expect(caughtError.status).toBe(status);
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      });

      it(`does NOT retry streaming HTTP ${status} (${name}) and fails immediately`, async () => {
        const fetchImplementation = vi.fn().mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({
            error: { code: status, message: `Mock streaming ${name} failure` },
          }), {
            status,
            headers: { 'content-type': 'application/json' },
          }))
        );
        const sleep = vi.fn();
        const client = new OpenRouterClient({
          apiKey: 'adv-test-key',
          fetchImplementation,
          sleep,
          maxRetries: 3,
        });

        let caughtError: any;
        try {
          await client.complete({ ...baseRequest, stream: true });
        } catch (err) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(OpenRouterResponseError);
        expect(caughtError.status).toBe(status);
        expect(fetchImplementation).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      });

      it(`publishes correct failureClass (${failureClass}) for HTTP ${status} to LiveStreamBus`, async () => {
        const busEvents: any[] = [];
        const spy = vi.spyOn(LiveStreamBus.getInstance(), 'publishEvent').mockImplementation((ev: any) => {
          busEvents.push(ev);
        });

        const fetchImplementation = vi.fn().mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({
            error: { code: status, message: `Mock ${name}` },
          }), {
            status,
            headers: { 'content-type': 'application/json' },
          }))
        );
        const sleep = vi.fn();
        const client = new OpenRouterClient({
          apiKey: 'adv-test-key',
          fetchImplementation,
          sleep,
          maxRetries: 2,
        });

        await expect(client.complete({
          ...baseRequest,
          jobId: `job-4xx-${status}`,
          stream: false,
        })).rejects.toMatchObject({
          name: 'OpenRouterResponseError',
          status,
        });

        expect(busEvents.length).toBe(1);
        expect(busEvents[0]).toMatchObject({
          jobId: `job-4xx-${status}`,
          data: {
            outcome: 'failed',
            failureClass,
            responseStatus: status,
          },
        });

        spy.mockRestore();
      });
    }

    it('isTransientGatewayError returns false for all non-retryable 4xx and generic errors', () => {
      for (const { status, name } of nonRetryableCodes) {
        expect(isTransientGatewayError(new OpenRouterResponseError(name, status))).toBe(false);
      }
      expect(isTransientGatewayError(new OpenRouterResponseError('Internal Server Error', 500))).toBe(false);
      expect(isTransientGatewayError(new Error('Network offline'))).toBe(false);
      expect(isTransientGatewayError(null)).toBe(false);
      expect(isTransientGatewayError(undefined)).toBe(false);
    });
  });

  describe('3. Reasoning Content Parsing Matrix (Empty, Whitespace, Null, Nested Objects, Arrays, Streaming)', () => {
    it('resolves reasoning_content when primary content is empty string', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          id: 'chatcmpl-reasoning-1',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'deepseek/deepseek-r1',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'Reasoning step: analyze AST diff directly',
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const client = new OpenRouterClient({ apiKey: 'adv-test-key', fetchImplementation });
      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('Reasoning step: analyze AST diff directly');
    });

    it('resolves reasoning_content when primary content is whitespace-only string', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          id: 'chatcmpl-reasoning-2',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'deepseek/deepseek-r1',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '   \n\t  \r\n  ',
              reasoning_content: 'Reasoning step: ignore blank content and verify tokens',
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const client = new OpenRouterClient({ apiKey: 'adv-test-key', fetchImplementation });
      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('Reasoning step: ignore blank content and verify tokens');
    });

    it('resolves reasoning_content when primary content is null', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          id: 'chatcmpl-reasoning-3',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'deepseek/deepseek-r1',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'Reasoning step: null content fallback to thinking tokens',
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const client = new OpenRouterClient({ apiKey: 'adv-test-key', fetchImplementation });
      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('Reasoning step: null content fallback to thinking tokens');
    });

    it('resolves reasoning_content when primary content is an array of empty/whitespace text blocks', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          id: 'chatcmpl-reasoning-4',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'deepseek/deepseek-r1',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '' }, { type: 'text', text: '   ' }],
              reasoning_content: 'Reasoning step: empty array parts fallback to thinking',
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const client = new OpenRouterClient({ apiKey: 'adv-test-key', fetchImplementation });
      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('Reasoning step: empty array parts fallback to thinking');
    });

    it('resolves reasoningContent (camelCase) and reasoning_details array correctly', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          id: 'chatcmpl-reasoning-5',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'anthropic/claude-3.7-sonnet',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '',
              reasoning_details: [
                { type: 'thought', reasoning_content: 'Part 1: Analyze types. ' },
                { type: 'thought', text: 'Part 2: Verify invariants.' },
              ],
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const client = new OpenRouterClient({ apiKey: 'adv-test-key', fetchImplementation });
      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('Part 1: Analyze types. Part 2: Verify invariants.');
    });

    it('accumulates streaming reasoning_content when streaming content delta is empty or null', async () => {
      const sseBody = [
        `data: ${sdkChunk({ content: null, reasoning_content: 'Thinking: ' })}`,
        `data: ${sdkChunk({ content: '', reasoning_content: 'evaluating diff ' })}`,
        `data: ${sdkChunk({ content: null, reasoning_content: 'safety invariants.' })}`,
        `data: [DONE]`,
        '',
      ].join('\n\n');

      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }))
      );
      const client = new OpenRouterClient({ apiKey: 'adv-test-key', fetchImplementation });
      const res = await client.complete({ ...baseRequest, stream: true });
      expect(res.content).toBe('Thinking: evaluating diff safety invariants.');
    });

    it('retries when BOTH content AND reasoning_content are completely empty or whitespace', async () => {
      let callCount = 0;
      const fetchImplementation = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            id: 'chatcmpl-blank-1',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: 'openai/gpt-4o-mini',
            choices: [{
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '   ', reasoning_content: '  \n  ' },
            }],
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify(sdkChatResult('RECOVERED_VALID_CONTENT')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('RECOVERED_VALID_CONTENT');
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('fails closed when persistent empty completion exhausts maxRetries', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          id: 'chatcmpl-blank-all',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'openai/gpt-4o-mini',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '', reasoning_content: '' },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      await expect(client.complete({ ...baseRequest, stream: false })).rejects.toThrow(
        'OpenRouter returned empty completion content',
      );
      expect(fetchImplementation).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });
  });

  describe('4. Full Jitter Delay Mathematical & Boundary Verification', () => {
    it('strictly satisfies 0 <= delay <= min(maxDelayMs, initialDelayMs * 2^attempt) across 5,000 randomized iterations', () => {
      for (let i = 0; i < 5000; i++) {
        const attempt = Math.floor(Math.random() * 50); // 0 to 49
        const initialDelayMs = Math.floor(Math.random() * 10000) + 1; // 1 to 10000
        const maxDelayMs = Math.floor(Math.random() * 60000) + 1; // 1 to 60000
        const mockRandomVal = Math.random(); // 0 to <1

        const delay = calculateFullJitterDelay(attempt, initialDelayMs, maxDelayMs, () => mockRandomVal);

        const ceiling = Math.min(maxDelayMs, initialDelayMs * Math.pow(2, attempt));
        expect(Number.isInteger(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
        if (ceiling > 0) {
          expect(delay).toBeLessThan(ceiling);
        } else {
          expect(delay).toBe(0);
        }
      }
    });

    it('handles boundary extremes (random=0, random~1, attempt=0, attempt=large, zero delays)', () => {
      // random = 0 -> always 0
      expect(calculateFullJitterDelay(0, 500, 5000, () => 0)).toBe(0);
      expect(calculateFullJitterDelay(5, 500, 5000, () => 0)).toBe(0);
      expect(calculateFullJitterDelay(50, 500, 5000, () => 0)).toBe(0);

      // random = 0.999999999999 -> ceiling - 1
      const randAlmost1 = () => 0.999999999999;
      // attempt 0: ceiling = min(5000, 500 * 1) = 500 -> 499
      expect(calculateFullJitterDelay(0, 500, 5000, randAlmost1)).toBe(499);
      // attempt 1: ceiling = min(5000, 500 * 2) = 1000 -> 999
      expect(calculateFullJitterDelay(1, 500, 5000, randAlmost1)).toBe(999);
      // attempt 2: ceiling = min(5000, 500 * 4) = 2000 -> 1999
      expect(calculateFullJitterDelay(2, 500, 5000, randAlmost1)).toBe(1999);
      // attempt 3: ceiling = min(5000, 500 * 8) = 4000 -> 3999
      expect(calculateFullJitterDelay(3, 500, 5000, randAlmost1)).toBe(3999);
      // attempt 4: ceiling = min(5000, 500 * 16) = 5000 -> 4999 (capped at maxDelayMs)
      expect(calculateFullJitterDelay(4, 500, 5000, randAlmost1)).toBe(4999);
      // large attempt: stays capped at 5000 -> 4999
      expect(calculateFullJitterDelay(30, 500, 5000, randAlmost1)).toBe(4999);

      // zero initialDelayMs or maxDelayMs -> 0
      expect(calculateFullJitterDelay(0, 0, 5000, randAlmost1)).toBe(0);
      expect(calculateFullJitterDelay(5, 500, 0, randAlmost1)).toBe(0);
    });

    it('integrates jitter delay calculation into OpenRouterClient retry backoff sequence', async () => {
      let callCount = 0;
      const fetchImplementation = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(new Response(JSON.stringify({ error: { message: '503 Service Unavailable' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify(sdkChatResult('OK')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      });

      const randomSpy = vi.fn()
        .mockReturnValueOnce(0.25) // attempt 0: ceiling 400, delay 100
        .mockReturnValueOnce(0.75); // attempt 1: ceiling 800, delay 600
      const sleepSpy = vi.fn().mockResolvedValue(undefined);

      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep: sleepSpy,
        random: randomSpy,
        initialRetryDelayMs: 400,
        maxRetryDelayMs: 2000,
        maxRetries: 3,
      });

      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('OK');
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 100);
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 600);
    });
  });

  describe('5. AbortSignal Cancellation During Backoff Sleep & Zero Unhandled Rejections', () => {
    it('cancels cleanly when AbortSignal fires during backoff sleep without unhandled rejections', async () => {
      const controller = new AbortController();
      let callCount = 0;

      const fetchImplementation = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      });

      // Sleep simulates active sleep that gets aborted halfway
      const sleep = vi.fn().mockImplementation((_ms: number) => {
        // Abort while sleep is pending
        setTimeout(() => controller.abort(), 20);
        return new Promise<void>((resolve) => setTimeout(resolve, 200));
      });

      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      let caughtError: any;
      try {
        await client.complete({
          ...baseRequest,
          signal: controller.signal,
          stream: false,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(OpenRouterTimeoutError);
      expect(caughtError.name).toBe('OpenRouterTimeoutError');
      expect(caughtError.message).toMatch(/cancelled/);
      expect(fetchImplementation).toHaveBeenCalledTimes(1); // Never proceeds to attempt 2
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('cancels cleanly if underlying sleep rejects after abort without throwing unhandled promise rejection', async () => {
      const controller = new AbortController();

      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }))
      );

      // Sleep rejects after aborting controller
      const sleep = vi.fn().mockImplementation(() => {
        controller.abort();
        return new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Sleep timer cancelled by runtime')), 10);
        });
      });

      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      await expect(client.complete({
        ...baseRequest,
        signal: controller.signal,
        stream: false,
      })).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        message: expect.stringMatching(/cancelled/),
      });

      // Wait 30ms to ensure any delayed sleep rejection would trigger unhandledRejection
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandledRejections).toEqual([]);
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
    });

    it('cancels cleanly during the second retry attempt backoff sleep', async () => {
      const controller = new AbortController();
      let callCount = 0;

      const fetchImplementation = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Persistent Gateway Timeout' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      });

      let sleepCount = 0;
      const sleep = vi.fn().mockImplementation(() => {
        sleepCount++;
        if (sleepCount === 1) {
          // First retry sleep completes normally
          return Promise.resolve();
        }
        // Second retry sleep triggers abort
        controller.abort();
        return new Promise<void>((resolve) => setTimeout(resolve, 100));
      });

      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 3,
      });

      await expect(client.complete({
        ...baseRequest,
        signal: controller.signal,
        stream: false,
      })).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        message: expect.stringMatching(/cancelled/),
      });

      expect(fetchImplementation).toHaveBeenCalledTimes(2); // 1 initial + 1 retry, 3rd never executed
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('rejects immediately if signal is already aborted before complete() is called', async () => {
      const controller = new AbortController();
      controller.abort();

      const fetchImplementation = vi.fn();
      const sleep = vi.fn();
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
      });

      await expect(client.complete({
        ...baseRequest,
        signal: controller.signal,
        stream: false,
      })).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        message: expect.stringMatching(/cancelled/),
      });

      expect(fetchImplementation).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    it('handles multiple rapid abort calls without crashing or leaving hanging promises', async () => {
      const controller = new AbortController();

      const fetchImplementation = vi.fn().mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout' },
        }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }))
      );

      const sleep = vi.fn().mockImplementation(() => {
        controller.abort();
        controller.abort();
        controller.abort();
        return new Promise<void>((resolve) => setTimeout(resolve, 50));
      });

      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      await expect(client.complete({
        ...baseRequest,
        signal: controller.signal,
        stream: false,
      })).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        message: expect.stringMatching(/cancelled/),
      });

      await new Promise((r) => setTimeout(r, 60));
      expect(unhandledRejections).toEqual([]);
    });
  });
});

  describe('6. Deep Edge Cases & Upstream Failure Scenarios', () => {
    it('retries and recovers when 504 returns raw HTML error page from HAProxy/Nginx ingress', async () => {
      let callCount = 0;
      const html504 = '<!DOCTYPE html><html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>cloudflare / haproxy</center></body></html>';
      const fetchImplementation = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(new Response(html504, {
            status: 504,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify(sdkChatResult('RECOVERED_AFTER_HTML_504')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('RECOVERED_AFTER_HTML_504');
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('fails closed immediately on malformed response with empty choices array choices: [] without retrying', async () => {
      const fetchImplementation = vi.fn().mockImplementation(() => {
        return Promise.resolve(new Response(JSON.stringify({
          id: 'chatcmpl-no-choices',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'openai/gpt-4o-mini',
          choices: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      });
      const sleep = vi.fn();
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      await expect(client.complete({ ...baseRequest, stream: false })).rejects.toMatchObject({
        name: 'OpenRouterResponseError',
        message: expect.stringMatching(/malformed response/),
      });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('retries when response returns choice with empty message content and recovers on retry', async () => {
      let callCount = 0;
      const fetchImplementation = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            id: 'chatcmpl-empty-msg',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: 'openai/gpt-4o-mini',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify(sdkChatResult('RECOVERED_EMPTY_MSG')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
      });
      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        maxRetries: 2,
      });

      const res = await client.complete({ ...baseRequest, stream: false });
      expect(res.content).toBe('RECOVERED_EMPTY_MSG');
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('times out cleanly when remainingTimeoutMs expires during retry sequence', async () => {
      let nowTime = 1000;
      const now = () => nowTime;

      const fetchImplementation = vi.fn().mockImplementation(() => {
        // Advance time past the 500ms timeout
        nowTime += 600;
        return Promise.resolve(new Response(JSON.stringify({
          error: { code: 504, message: 'Gateway Timeout' },
        }), { status: 504, headers: { 'content-type': 'application/json' } }));
      });

      const sleep = vi.fn().mockResolvedValue(undefined);
      const client = new OpenRouterClient({
        apiKey: 'adv-test-key',
        fetchImplementation,
        sleep,
        now,
        maxRetries: 3,
      });

      await expect(client.complete({
        ...baseRequest,
        timeoutMs: 500,
        stream: false,
      })).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        message: expect.stringMatching(/exceeded 500ms/),
      });

      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledTimes(1);
    });
  });
