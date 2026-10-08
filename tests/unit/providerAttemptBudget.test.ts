import { describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, OpenRouterTimeoutError } from '../../src/gateway/openRouterClient';
import { ProviderAttemptBudget, ProviderAttemptBudgetExceededError } from '../../src/gateway/providerAttemptBudget';

const request = {
  model: 'test/model',
  messages: [{ role: 'user' as const, content: 'review the admitted diff' }],
  timeoutMs: 10_000,
  inactivityTimeoutMs: 10_000,
  stream: false,
};

function successfulResponse(content = '{"status":"ok"}'): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-budget-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'test/model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('physical provider-attempt budget', () => {
  it('counts OpenRouter same-client retries before fetch and denies over-budget retries', async () => {
    const budget = new ProviderAttemptBudget({ totalLimit: 1, investigationLimit: 1, verificationLimit: 0 });
    let attempts = 0;
    const fetchImplementation = vi.fn(async () => {
      attempts += 1;
      return new Response('{"error":{"message":"temporary"}}', { status: 503,
        headers: { 'content-type': 'application/json' } });
    });
    const client = new OpenRouterClient({ baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'test',
      fetchImplementation, maxRetries: 3, initialRetryDelayMs: 0, maxRetryDelayMs: 0, sleep: async () => {}, random: () => 0 });

    await expect(client.complete({ ...request, beforePhysicalAttempt: () => budget.beginAttempt('investigation') }))
      .rejects.toBeInstanceOf(ProviderAttemptBudgetExceededError);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(1);
    expect(budget.snapshot()).toMatchObject({ totalStarted: 1, investigationStarted: 1,
      verificationStarted: 0, deniedAttempts: 1, investigationDenied: 1, verificationDenied: 0 });
  });

  it('keeps the verifier reserve unavailable to concurrent investigation retries', async () => {
    const budget = new ProviderAttemptBudget({ totalLimit: 2, investigationLimit: 1, verificationLimit: 1 });
    const fetchImplementation = vi.fn(async () => successfulResponse());
    const client = new OpenRouterClient({ baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'test',
      fetchImplementation, maxRetries: 0 });
    const investigation = () => client.complete({ ...request,
      beforePhysicalAttempt: () => budget.beginAttempt('investigation') });

    const parallel = await Promise.allSettled([investigation(), investigation()]);
    expect(parallel.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(parallel.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejected = parallel.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ProviderAttemptBudgetExceededError);

    await client.complete({ ...request, beforePhysicalAttempt: () => budget.beginAttempt('verification') });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(budget.snapshot()).toMatchObject({ totalLimit: 2, investigationLimit: 1, verificationLimit: 1,
      totalStarted: 2, investigationStarted: 1, verificationStarted: 1,
      deniedAttempts: 1, investigationDenied: 1, verificationDenied: 0 });
  });

  it('counts a fetch that is later aborted, but not a request stopped before fetch', async () => {
    const budget = new ProviderAttemptBudget({ totalLimit: 1, investigationLimit: 1, verificationLimit: 0 });
    const controller = new AbortController();
    const fetchImplementation = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
      setTimeout(() => controller.abort(new Error('cancel review')), 0);
    }));
    const client = new OpenRouterClient({ baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'test',
      fetchImplementation, maxRetries: 3, initialRetryDelayMs: 0, maxRetryDelayMs: 0, sleep: async () => {}, random: () => 0 });

    await expect(client.complete({ ...request, signal: controller.signal,
      beforePhysicalAttempt: () => budget.beginAttempt('investigation') })).rejects.toBeInstanceOf(OpenRouterTimeoutError);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(budget.snapshot()).toMatchObject({ totalStarted: 1, investigationStarted: 1, deniedAttempts: 0 });
  });

  it('keeps redirect behavior unchanged outside the budgeted worker path', async () => {
    const budget = new ProviderAttemptBudget({ totalLimit: 2, investigationLimit: 2, verificationLimit: 0 });
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetchImplementation = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return successfulResponse();
    });
    const client = new OpenRouterClient({ baseUrl: 'https://gateway.example.invalid/v1', apiKey: 'test',
      fetchImplementation, maxRetries: 0 });

    await client.complete(request);
    await client.complete({ ...request, beforePhysicalAttempt: () => budget.beginAttempt('investigation') });

    expect(redirects).toEqual([undefined, 'error']);
    expect(budget.snapshot()).toMatchObject({ totalStarted: 1, investigationStarted: 1 });
  });
});
