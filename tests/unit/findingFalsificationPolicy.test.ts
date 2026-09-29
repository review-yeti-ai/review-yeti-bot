import { describe, expect, it } from 'vitest';

import {
  callFalsificationModelTurn,
  resolveActionReviewRuntime,
  resolveFindingFalsificationPolicy,
} from '../../.github/workflows/pipelines/review-pipeline';

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

// Plain-JS declaration inference loses the real localConfig parameter because
// the implementation defaults it to null. Preserve the runtime contract here
// without weakening the test's result type.
function resolveRuntime(localConfig: unknown, env: Record<string, string | undefined>) {
  const resolver = resolveActionReviewRuntime as unknown as (
    config: unknown,
    runtimeEnv: Record<string, string | undefined>,
  ) => ReturnType<typeof resolveActionReviewRuntime>;
  return resolver(localConfig, env);
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
  it('keeps an explicit direct transport model when the guarded action destination is the gateway', async () => {
    const directModel = 'deepseek/deepseek-v4-flash-0731';
    const runtime = resolveRuntime({ parsed: {} }, {
      OPENROUTER_API_KEY: 'direct-key',
      REVIEW_TRANSPORT_DESTINATION: 'gateway',
      REVIEW_YETI_TRANSPORTS: JSON.stringify([{
        name: 'openrouter-direct',
        base_url: 'https://openrouter.ai/api/v1',
        model: directModel,
        api_key_env: 'OPENROUTER_API_KEY',
      }]),
    });
    let requestBody: Record<string, unknown> | undefined;

    const result = await callFalsificationModelTurn(
      { messages: [{ role: 'user', content: 'verify' }], timeoutMs: 5_000 },
      {
        ...runtime.modelConfig,
        fetchImplementation: async (_url: string, init: { body: string }) => {
          requestBody = JSON.parse(init.body);
          return new Response(JSON.stringify({
            choices: [{ message: { content: '{"verdict":"upheld"}' } }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(runtime.modelConfig.model).not.toBe('pr-reviewer');
    expect(requestBody?.model).toBe(directModel);
  });

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
