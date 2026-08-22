import { describe, expect, it } from 'vitest';

import { callFalsificationModelTurn, resolveFindingFalsificationPolicy } from '../../.github/workflows/pipelines/review-pipeline';

function localConfig(value: unknown) {
  return { parsed: { review: { finding_falsification: value } } };
}

describe('resolveFindingFalsificationPolicy', () => {
  it('is off unless explicitly configured', () => {
    expect(resolveFindingFalsificationPolicy({ localConfig: { parsed: {} }, env: {} })).toMatchObject({ enabled: false, reason: 'not_configured' });
    expect(resolveFindingFalsificationPolicy({ localConfig: localConfig(false), env: {} })).toMatchObject({ enabled: false, reason: 'disabled_by_config' });
    expect(resolveFindingFalsificationPolicy({ localConfig: localConfig('yes'), env: {} })).toMatchObject({ enabled: false, reason: 'invalid_config' });
  });

  it('enables via true or an object, carrying limits through', () => {
    expect(resolveFindingFalsificationPolicy({ localConfig: localConfig(true), env: {} })).toMatchObject({ enabled: true });
    const policy = resolveFindingFalsificationPolicy({ localConfig: localConfig({ limits: { maxCalls: 3 } }), env: {} });
    expect(policy).toMatchObject({ enabled: true, limits: { maxCalls: 3 } });
  });

  it('honors the environment kill-switch', () => {
    const policy = resolveFindingFalsificationPolicy({ localConfig: localConfig(true), env: { REVIEW_YETI_FINDING_FALSIFICATION: 'false' } });
    expect(policy).toMatchObject({ enabled: false, reason: 'disabled_by_env' });
  });
});

describe('callFalsificationModelTurn', () => {
  it('marks its own deadline firing as timedOut so the stage can classify it as verifier_timeout', async () => {
    const result = await callFalsificationModelTurn(
      { messages: [{ role: 'user', content: 'x' }], timeoutMs: 20 },
      {
        transports: [{ name: 'slow', baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' }],
        fetchImplementation: (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          }),
      },
    );
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(String((result as { error?: string }).error)).toContain('timed out after 20ms');
  });

  it('does not mark a plain transport failure as timedOut', async () => {
    const result = await callFalsificationModelTurn(
      { messages: [{ role: 'user', content: 'x' }], timeoutMs: 5_000 },
      {
        transports: [{ name: 'down', baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm' }],
        fetchImplementation: () => Promise.reject(new Error('connection refused')),
      },
    );
    expect(result.ok).toBe(false);
    expect((result as { timedOut?: boolean }).timedOut).toBeUndefined();
  });
});
