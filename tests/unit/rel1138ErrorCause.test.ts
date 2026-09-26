import { describe, it, expect } from 'vitest';
import {
  describeErrorChain,
  describeErrorCause,
  errorCauseLogFields,
  rootErrorCauseCode,
  MAX_ERROR_CAUSE_ENTRIES,
  MAX_ERROR_CAUSE_MESSAGE_CHARS,
} from '../../src/utils/errorCause';

// REL-1138: the sanitizer behind every transport-failure cause field. These drive the
// module directly; the client and panel wiring have their own tests.

function undiciConnectTimeout(): Error {
  const inner = Object.assign(
    new Error('Connect Timeout Error (attempted address: 10.245.1.7:443, timeout: 10000ms)'),
    { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
  );
  return new TypeError('fetch failed', { cause: inner });
}

describe('REL-1138 describeErrorChain', () => {
  it('walks .cause and keeps the undici code under a bare "fetch failed"', () => {
    const chain = describeErrorChain(undiciConnectTimeout());
    expect(chain).toEqual([
      { depth: 0, name: 'TypeError', message: 'fetch failed' },
      {
        depth: 1,
        name: 'ConnectTimeoutError',
        code: 'UND_ERR_CONNECT_TIMEOUT',
        message: 'Connect Timeout Error (attempted address: 10.245.1.7:443, timeout: 10000ms)',
      },
    ]);
    expect(rootErrorCauseCode(chain)).toBe('UND_ERR_CONNECT_TIMEOUT');
  });

  it('keeps errno, syscall, address and port from a system error', () => {
    const sys = Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:8080'), {
      code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '10.0.0.9', port: 8080,
    });
    const [entry] = describeErrorChain(sys);
    expect(entry).toMatchObject({ code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '10.0.0.9', port: 8080 });
  });

  it('reads AggregateError children (one per address tried)', () => {
    const a = Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' });
    const b = Object.assign(new Error('connect ENETUNREACH ::1:443'), { code: 'ENETUNREACH' });
    const agg = new AggregateError([a, b], '');
    const top = new TypeError('fetch failed', { cause: agg });
    const codes = describeErrorChain(top).map((entry) => entry.code).filter(Boolean);
    expect(codes).toEqual(['ETIMEDOUT', 'ENETUNREACH']);
  });

  it('never copies fields outside the allow-list (bodies, headers, request objects)', () => {
    const cause = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
      body: 'PRIVATE DIFF CONTENT',
      headers: { authorization: 'Bearer sk-shouldneverappear1234567890' },
      request: { body: 'prompt text' },
      rawResponse: 'response text',
    });
    const serialized = JSON.stringify(describeErrorChain(new TypeError('fetch failed', { cause })));
    expect(serialized).not.toContain('PRIVATE DIFF CONTENT');
    expect(serialized).not.toContain('sk-shouldneverappear');
    expect(serialized).not.toContain('prompt text');
    expect(serialized).not.toContain('response text');
    expect(serialized).toContain('ECONNRESET');
  });

  it('redacts secrets inside cause messages and caps their length', () => {
    const cause = Object.assign(
      new Error(`boom Authorization: Bearer sk-SECRETSECRETSECRET123 ${'x'.repeat(5_000)}`),
      { code: 'ECONNRESET' },
    );
    const chain = describeErrorChain(new TypeError('terminated', { cause }));
    const serialized = JSON.stringify(chain);
    expect(serialized).not.toContain('sk-SECRETSECRETSECRET123');
    expect(serialized).not.toContain('Bearer sk-');
    for (const entry of chain) expect((entry.message ?? '').length).toBeLessThanOrEqual(MAX_ERROR_CAUSE_MESSAGE_CHARS);
  });

  it('drops URL credentials, query strings and fragments from cause messages', () => {
    const error = new TypeError('fetch failed', {
      cause: new Error('connect to https://svc-user:hunter2pass@gateway.internal:8443/v1/chat?api_key=abc123secret&x=1#frag failed'),
    });
    const [entry] = describeErrorCause(error);
    expect(entry.message).toContain('https://gateway.internal:8443/v1/chat');
    expect(entry.message).not.toMatch(/hunter2pass|svc-user|abc123secret|api_key|#frag/u);
  });

  it('rejects a code or name that is not a plain token', () => {
    const cause = Object.assign(new Error('x'), { name: 'Evil name with spaces', code: 'CODE\nINJECT' });
    const [, entry] = describeErrorChain(new Error('top', { cause }));
    expect(entry.name).toBeUndefined();
    expect(entry.code).toBeUndefined();
  });

  it('is bounded and cycle-safe', () => {
    const a: any = new Error('a');
    const b: any = new Error('b', { cause: a });
    a.cause = b;
    expect(describeErrorChain(a)).toHaveLength(2);

    let deep: Error = new Error('leaf');
    for (let i = 0; i < 50; i += 1) deep = new Error(`level ${i}`, { cause: deep });
    expect(describeErrorChain(deep)).toHaveLength(MAX_ERROR_CAUSE_ENTRIES);
  });
});

describe('REL-1138 errorCauseLogFields', () => {
  it('returns nothing for an error without a cause, so a log line is unchanged', () => {
    expect(errorCauseLogFields(new Error('plain'))).toEqual({});
    expect(errorCauseLogFields('string failure')).toEqual({});
    expect(errorCauseLogFields(undefined)).toEqual({});
  });

  it('describes the chain beneath the error, not the error itself', () => {
    const fields = errorCauseLogFields(undiciConnectTimeout());
    expect(fields.errorCauseCode).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(fields.errorCause).toHaveLength(1);
    expect(fields.errorCause?.[0]).toMatchObject({ depth: 1, name: 'ConnectTimeoutError' });
    expect(describeErrorCause(undiciConnectTimeout())).toEqual(fields.errorCause);
  });

  it('prefers a precomputed causeChain carried on the error', () => {
    const carried = [{ depth: 0, name: 'TypeError', message: 'terminated' }, { depth: 1, code: 'UND_ERR_SOCKET' }];
    const error = Object.assign(new Error('wrapped'), { causeChain: carried });
    expect(errorCauseLogFields(error)).toEqual({ errorCause: carried, errorCauseCode: 'UND_ERR_SOCKET' });
  });
});
