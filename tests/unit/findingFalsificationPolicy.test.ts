import { describe, expect, it } from 'vitest';

import { callFalsificationModelTurn, resolveFindingFalsificationPolicy } from '../../.github/workflows/pipelines/review-pipeline';

function localConfig(value: unknown) {
  return { parsed: { review: { finding_falsification: value } } };
}

// review-pipeline.js destructures `{ localConfig, env = process.env } = {}` with no JSDoc
// annotation, so TS's cross-file declaration inference for the plain JS export only recovers
// the `env` binding (it has a literal default) and drops `localConfig` entirely from the
// synthesized parameter type. The function's real runtime contract does use localConfig (see
// the source), so this cast to the function's own inferred parameter type — not `any` — restores
// the field the checker failed to infer, without inventing behavior.
type FalsificationPolicyInput = Parameters<typeof resolveFindingFalsificationPolicy>[0];
function resolvePolicy(args: { localConfig: unknown; env: Record<string, string | undefined> }) {
  return resolveFindingFalsificationPolicy(args as unknown as FalsificationPolicyInput);
}

describe('resolveFindingFalsificationPolicy', () => {
  it('is off unless explicitly configured', () => {
    expect(resolvePolicy({ localConfig: { parsed: {} }, env: { NODE_ENV: 'test' } })).toMatchObject({ enabled: false, reason: 'not_configured' });
    expect(resolvePolicy({ localConfig: localConfig(false), env: { NODE_ENV: 'test' } })).toMatchObject({ enabled: false, reason: 'disabled_by_config' });
    expect(resolvePolicy({ localConfig: localConfig('yes'), env: { NODE_ENV: 'test' } })).toMatchObject({ enabled: false, reason: 'invalid_config' });
  });

  it('enables via true or an object, carrying limits through', () => {
    expect(resolvePolicy({ localConfig: localConfig(true), env: { NODE_ENV: 'test' } })).toMatchObject({ enabled: true });
    const policy = resolvePolicy({ localConfig: localConfig({ limits: { maxCalls: 3 } }), env: { NODE_ENV: 'test' } });
    expect(policy).toMatchObject({ enabled: true, limits: { maxCalls: 3 } });
  });

  it('honors the environment kill-switch', () => {
    const policy = resolvePolicy({ localConfig: localConfig(true), env: { NODE_ENV: 'test', REVIEW_YETI_FINDING_FALSIFICATION: 'false' } });
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
