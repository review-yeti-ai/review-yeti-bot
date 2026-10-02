import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterClient, OpenRouterResponseError } from '../../src/gateway/openRouterClient';
import { executeComposedReview } from '../../src/panel/composedEngine';
import { parseAndValidateConfig } from '../../src/config/configLoader';

const epoch = Date.UTC(2026, 9, 2, 20);
const request = { model: 'pr-reviewer', messages: [{ role: 'user' as const, content: 'synthetic test' }], timeoutMs: 10_000 };
const success = () => new Response(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: 'pr-reviewer', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }), { headers: { 'content-type': 'application/json' } });
const throttled = (header: string, status = 429, message = 'synthetic throttle') => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json', 'retry-after': header } });
async function responseError(header: string, stream = true, status = 429, message = 'synthetic throttle') {
  const client = new OpenRouterClient({ baseUrl: 'https://gateway.test/v1', apiKey: 'synthetic', now: () => epoch, fetchImplementation: async () => throttled(header, status, message) });
  return client.complete({ ...request, stream }).catch(error => error) as Promise<OpenRouterResponseError>;
}
const cfg = () => parseAndValidateConfig(`version: 3
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
function composed(complete: any, duration = 10_000) {
  return executeComposedReview({ config: cfg() as any, changedFiles: [{ path: 'src/test.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], repository: 'example/test', headSha: 'a'.repeat(40), client: { complete }, deadlineBudget: { deadlineAtMs: epoch + duration, timeoutMs: duration, terminalBound: true }, deadlineNow: () => Date.now() });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('429 Retry-After', () => {
  it.each([true, false])('preserves only bounded delta-seconds metadata on transport stream=%s', async stream => {
    const error = await responseError('3', stream);
    expect(error).toBeInstanceOf(OpenRouterResponseError);
    expect(error.retryAfter).toEqual({ notBeforeMs: epoch + 3000, format: 'delta_seconds' });
    expect(JSON.stringify(error.retryAfter)).not.toContain('synthetic');
  });
  it('converts an HTTP date into an absolute floor', async () => {
    const error = await responseError(new Date(epoch + 5000).toUTCString());
    expect(error.retryAfter).toEqual({ notBeforeMs: epoch + 5000, format: 'http_date' });
  });
  it.each(['Friday, 02-Oct-26 20:00:05 GMT', 'Fri Oct  2 20:00:05 2026'])('honors obsolete HTTP-date formats (%s)', async header => {
    expect((await responseError(header)).retryAfter).toEqual({ notBeforeMs: epoch + 5000, format: 'http_date' });
  });
  it('interprets a RFC850 year over 50 years ahead as the past century', async () => {
    expect((await responseError('Thursday, 02-Oct-97 20:00:05 GMT')).retryAfter).toEqual({ notBeforeMs: epoch, format: 'http_date' });
  });
  it('preserves the floor for an HTTP leap second', async () => {
    const header = 'Fri, 02 Oct 2026 20:00:60 GMT';
    expect((await responseError(header)).retryAfter).toEqual({ notBeforeMs: epoch + 60_000, format: 'http_date' });
  });
  it.each(['Friday, 99-Oct-26 20:00:05 GMT', 'Fri Oct 99 20:00:05 2026', '-1', '1.5', 'not-a-date', 'Fri, 99 Oct 2026 20:00:01 GMT'])('ignores malformed header %s', async header => {
    expect((await responseError(header)).retryAfter).toBeUndefined();
  });
  it.each(['86401', '9'.repeat(200), 'a'.repeat(200), new Date(epoch + 86_401_000).toUTCString()])('refuses an excessive declared cooldown without retaining its raw value', async header => {
    expect((await responseError(header)).retryAfter).toEqual({ exceedsBound: true });
  });
  it.each(['0', new Date(epoch - 1000).toUTCString()])('allows an already elapsed cooldown without a negative floor (%s)', async header => {
    expect((await responseError(header)).retryAfter).toMatchObject({ notBeforeMs: epoch });
  });
  it('does not attach Retry-After to a non-429 response', async () => {
    expect((await responseError('3', true, 503)).retryAfter).toBeUndefined();
  });
  it('client429 stays one attempt even when client retries are configured', async () => {
    const fetchImplementation = vi.fn(async () => throttled('3'));
    const sleep = vi.fn(async () => {});
    const client = new OpenRouterClient({ baseUrl: 'https://gateway.test/v1', apiKey: 'synthetic', now: () => epoch, fetchImplementation, maxRetries: 2, random: () => 0, sleep });
    const error = await client.complete({ ...request, stream: false }).catch(error => error);
    expect(error).toBeInstanceOf(OpenRouterResponseError);
    expect(error.retryAfter).toEqual({ notBeforeMs: epoch + 3000, format: 'delta_seconds' });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it.each(['10', '86401'])('streaming client preserves bounded cooldown metadata for %s without retrying 429', async header => {
    const fetchImplementation = vi.fn(async () => throttled(header));
    const sleep = vi.fn(async () => {});
    const client = new OpenRouterClient({ baseUrl: 'https://gateway.test/v1', apiKey: 'synthetic', now: () => epoch, fetchImplementation, maxRetries: 1, random: () => 0, sleep });
    const error = await client.complete({ ...request, stream: true }).catch(error => error);
    expect(error).toBeInstanceOf(OpenRouterResponseError);
    expect(error.retryAfter).toEqual(header === '10'
      ? { notBeforeMs: epoch + 10_000, format: 'delta_seconds' }
      : { exceedsBound: true });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it.each(['synthetic throttle', 'empty completion content'])('composed retries respect the floor including error-text overlap (%s)', async message => {
    const error = await responseError('3', true, 429, message);
    vi.useFakeTimers(); vi.setSystemTime(epoch); vi.spyOn(Math, 'random').mockReturnValue(0);
    const times: number[] = [];
    const complete = vi.fn(async () => { times.push(Date.now()); if (times.length === 1) throw error; throw new Error('synthetic permanent failure'); });
    const pending = composed(complete).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2999);
    expect(times).toEqual([epoch]);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(times).toEqual([epoch, epoch + 3000]);
  });
  it('composed cancellation during cooldown prevents another provider call', async () => {
    const error = await responseError('3');
    vi.useFakeTimers(); vi.setSystemTime(epoch); vi.spyOn(Math, 'random').mockReturnValue(0);
    const controller = new AbortController();
    const complete = vi.fn(async () => { throw error; });
    const pending = executeComposedReview({ config: cfg() as any, changedFiles: [{ path: 'src/test.ts', patch: '@@ -1 +1 @@\n-old\n+new' }], repository: 'example/test', headSha: 'a'.repeat(40), client: { complete }, signal: controller.signal, deadlineBudget: { deadlineAtMs: epoch + 10000, timeoutMs: 10000, terminalBound: true }, deadlineNow: () => Date.now() }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(complete).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(4000);
    await pending;
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it.each(['10', '86401'])('composed cannot bypass deadline refusal through its generic fallback (%s)', async header => {
    const error = await responseError(header);
    vi.useFakeTimers(); vi.setSystemTime(epoch); vi.spyOn(Math, 'random').mockReturnValue(0);
    const complete = vi.fn(async () => { throw error; });
    const pending = composed(complete).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
