/**
 * The dedicated rate-limit ladder in both review engines (`../../src/gateway/rateLimitBackoff`).
 *
 * Shape under test: a shared provider account with 15 concurrent slots answers the overflow with
 * HTTP 429 "Concurrent limit reached ... 15/15 slots in use". The five-retry transport ladder gave
 * up on that about a minute after the first rejection; the rate-limit ladder keeps waiting while
 * the run's budget lasts, honours Retry-After, and still classifies an exhausted budget as
 * `rate_limit`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, OpenRouterResponseError } from '../../src/gateway/openRouterClient';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { executePersonaPanel, extractMessageContentText, isProviderRateLimitError, isTransientLaneTransportError } from '../../src/panel/panelEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema } from '../../src/config/schema';
import { concurrentLimitMessage } from '../support/providerConcurrencyFixtures';

const epoch = Date.UTC(2026, 9, 2, 20);

function concurrencyRejection(model = 'pr-reviewer'): OpenRouterResponseError {
  return new OpenRouterResponseError(`gateway.test HTTP 429: ${concurrentLimitMessage(model, 15)}`, 429);
}

/** A real client's 429 so the sanitized Retry-After metadata is attached exactly as in production. */
async function throttledWithRetryAfter(header: string, observedAtMs = Date.now()): Promise<OpenRouterResponseError> {
  const client = new OpenRouterClient({ baseUrl: 'https://gateway.test/v1', apiKey: 'synthetic', now: () => observedAtMs,
    fetchImplementation: async () => new Response(JSON.stringify({ error: { message: concurrentLimitMessage('pr-reviewer', 15) } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': header } }) });
  return client.complete({ model: 'pr-reviewer', messages: [{ role: 'user', content: 'synthetic' }], timeoutMs: 10_000, stream: false })
    .catch((error) => error) as Promise<OpenRouterResponseError>;
}

const composedConfig = () => parseAndValidateConfig(`version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 5
      arbiter_timeout_s: 5
  arbiter:
    order: [codex]
`);

function composed(complete: (...args: any[]) => Promise<any>, durationMs: number) {
  return executeComposedReview({ config: composedConfig() as any, changedFiles: [{ path: 'src/test.ts', patch: '@@ -1 +1 @@\n-old\n+new' }],
    repository: 'example/test', headSha: 'a'.repeat(40), client: { complete },
    deadlineBudget: { deadlineAtMs: Date.now() + durationMs, timeoutMs: durationMs, terminalBound: true }, deadlineNow: () => Date.now() });
}

function singleAliasPanelConfig() {
  return ctReviewConfigV3Schema.parse({
    version: 3,
    profile: 'assertive',
    quorum: 1,
    personas: [
      { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['src/**'], providers: ['bifrost'] },
      { id: 'opt-lane', enabled: true, required: false, charter: 'builtin:correctness', paths: ['src/**'], providers: ['bifrost'] },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'none',
      overall_timeout_s: 120,
      providers: [{ id: 'bifrost', enabled: true, model: 'bifrost/pr-reviewer', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 }],
      arbiter: { order: ['bifrost'] },
    },
    path_instructions: [],
    rules: [],
  });
}

function roleResponse(opts: any) {
  const text = opts.messages.map((message: any) => extractMessageContentText(message.content)).join('\n');
  const nonce = [...text.matchAll(/CT_REVIEW_NONCE:([^\s]+)/g)].at(-1)?.[1] ?? 'test-nonce';
  const body = opts.persona === 'arbiter' ? { verdict: 'SHIP', rationale: 'All lanes completed.' }
    : opts.persona === 'moderator' ? { decision: 'RECONCILED', findings: [] }
      : { decision: 'APPROVE', findings: [] };
  return { model: opts.model, content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null, raw: {} };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('rate-limit predicate', () => {
  it('accepts only an observed 429 and leaves outages to the transport ladder', () => {
    expect(isProviderRateLimitError(concurrencyRejection())).toBe(true);
    expect(isProviderRateLimitError(new Error(`bifrost HTTP 429: ${concurrentLimitMessage('m', 15)}`))).toBe(true);
    expect(isProviderRateLimitError(new OpenRouterResponseError('HTTP 503', 503))).toBe(false);
    expect(isProviderRateLimitError(new Error('fetch failed'))).toBe(false);
    // Wording without an observed status keeps its existing fast-failover handling.
    expect(isProviderRateLimitError(new Error('provider capacity rejected: rate limited'))).toBe(false);
    expect(isProviderRateLimitError(new OpenRouterResponseError('HTTP 429: empty completion content', 429))).toBe(false);
    // The transport predicate still recognises outages.
    expect(isTransientLaneTransportError(new OpenRouterResponseError('HTTP 502', 502))).toBe(true);
  });
});

describe('composed engine rate-limit ladder', () => {
  it('rides out more consecutive 429s than the five-retry transport ladder allows', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls += 1;
      if (calls <= 10) throw concurrencyRejection();
      throw new Error('synthetic permanent failure after the throttle cleared');
    });
    await composed(complete, 20_000).catch(() => undefined);
    // Ten rejections, then the eleventh call reached the provider.
    expect(calls).toBe(11);
  });

  it('floors every wait at Retry-After and stops when the next wait no longer fits the deadline, still as a 429', async () => {
    const error = await throttledWithRetryAfter('4', epoch);
    vi.useFakeTimers(); vi.setSystemTime(epoch); vi.spyOn(Math, 'random').mockReturnValue(0);
    const times: number[] = [];
    const complete = vi.fn(async () => { times.push(Date.now() - epoch); throw error; });
    const outcome = composed(complete, 10_000).then(() => undefined, (failure) => failure);
    await vi.advanceTimersByTimeAsync(10_001);
    const failure = await outcome;
    // The cooldown is a fixed instant (epoch + 4s): the first wait honours it, later waits are
    // the jittered backoff once it has elapsed, and no wait ever ends past the deadline.
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(4_000);
    expect(Math.max(...times)).toBeLessThan(10_000);
    expect(failure).toBeInstanceOf(OpenRouterResponseError);
    expect((failure as OpenRouterResponseError).status).toBe(429);
  });

  it('refuses to wait when the declared cooldown is longer than the remaining budget', async () => {
    const error = await throttledWithRetryAfter('3600');
    const complete = vi.fn(async () => { throw error; });
    const failure = await composed(complete, 10_000).then(() => undefined, (thrown) => thrown);
    expect(complete).toHaveBeenCalledTimes(1);
    expect((failure as OpenRouterResponseError).status).toBe(429);
  });
});

describe('fan-out engine rate-limit ladder', () => {
  it('a single-alias lane survives more consecutive 429s than the transport ladder allows', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let rejected = 0;
    const complete = vi.fn(async (opts: any) => {
      if (opts.persona === 'sec-lane' && rejected < 10) { rejected += 1; throw concurrencyRejection(opts.model); }
      return roleResponse(opts);
    });
    const result = await executePersonaPanel({ config: singleAliasPanelConfig(), changedFiles: [{ path: 'src/a.ts', patch: '+ const a = 1;' }],
      repository: 'example/repo', headSha: 'head-rate-limit-survives', client: { complete } as never });
    expect(rejected).toBe(10);
    expect(result.personas.find((lane) => lane.id === 'sec-lane')?.decision).toBe('APPROVE');
  });

  it('classifies a lane whose budget cannot fit the declared cooldown as rate_limit, without retrying', async () => {
    const error = await throttledWithRetryAfter('3600');
    let optionalCalls = 0;
    const complete = vi.fn(async (opts: any) => {
      if (opts.persona === 'opt-lane') { optionalCalls += 1; throw error; }
      return roleResponse(opts);
    });
    const result = await executePersonaPanel({ config: singleAliasPanelConfig(), changedFiles: [{ path: 'src/a.ts', patch: '+ const a = 1;' }],
      repository: 'example/repo', headSha: 'head-rate-limit-budget', client: { complete } as never });
    expect(optionalCalls).toBe(1);
    expect(result.optionalFailures).toEqual([expect.objectContaining({ id: 'opt-lane', failureClass: 'rate_limit' })]);
  });
});
