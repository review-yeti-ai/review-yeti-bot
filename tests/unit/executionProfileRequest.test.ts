import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const {
  buildExecutionProfileRequest,
  credentialFreeRequestView,
  credentialFreeRequestFingerprint,
} = require(path.join(root, '.github/workflows/pipelines/execution-profile-request.js'));
const profiles = require(path.join(root, '.github/workflows/pipelines/execution-profile.js')).getExecutionProfiles();
const profile = (id: string) => profiles[id];

const persona = { id: 'testing', name: 'Testing Specialist', charter: 'Check tests.' };
const diffFiles = [{ path: 'src/example.ts', patch: '@@ -0,0 +1 @@\n+export const value = 1;' }];
const openRouterPolicy = {
  base_url: 'https://openrouter.ai/api/v1',
  model: 'openrouter/auto',
  allowed_models: [
    'openai/gpt-5.6-luna',
    'moonshotai/kimi-k2.6',
    'tencent/hy3',
    'z-ai/glm-5.1',
    'google/gemini-3.5-flash-lite',
  ],
  data_collection: 'deny',
  cost_quality_tradeoff: 7,
};

function successfulStream(model: string) {
  const payload = [
    `data: ${JSON.stringify({ model, choices: [{ delta: { content: '{"findings":[]}' } }] })}`,
    'data: [DONE]',
    '',
  ].join('\n');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function capture(transport: any) {
  pipeline.globalRunCircuitBreaker.reset();
  let captured: any;
  const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: '1' }, null, {
    apiKey: 'fixture-secret',
    baseUrl: transport.baseUrl,
    model: transport.model,
    transports: [transport],
    ...(transport.name === 'openrouter' ? { openRouterPolicy } : {}),
    fetchImplementation: async (url: string, init: any) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return successfulStream(transport.model);
    },
  });
  expect(result).toMatchObject({ decision: 'APPROVE', findings: [], transport: transport.name });
  return captured;
}

afterEach(() => {
  pipeline.globalRunCircuitBreaker.reset();
});

describe('Rank 4 execution-profile request parity', () => {
  it('projects only validated profile-owned wire fields and preserves runtime-owned model identity', () => {
    const current = {
      model: 'deepseek/deepseek-v4-flash-0731',
      messages: [{ role: 'user', content: 'secret diff' }],
      temperature: 0.1,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      stream: true,
      reasoning: { effort: 'high' },
      provider: { data_collection: 'deny' },
    };

    const unchanged = structuredClone(current);
    expect(buildExecutionProfileRequest(profile('openrouter-primary'), current)).toEqual(unchanged);
    expect(current).toEqual(unchanged);
    const missingModel = { ...current, model: undefined };
    expect(buildExecutionProfileRequest(profile('openrouter-primary'), missingModel).model).toBe('openrouter/auto');
    expect(missingModel.model).toBeUndefined();
    expect(() => buildExecutionProfileRequest({ ...current, id: 'openrouter-primary' })).toThrow(/canonical frozen profile/i);
  });

  it.each([
    ['openrouter-primary', {
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-flash-0731',
      stream: true,
      reasoningEffort: 'high',
      timeoutMs: 90000,
    }],
    ['fireworks-breakglass', {
      name: 'fireworks',
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
      stream: true,
      reasoningEffort: 'high',
      perfMetricsInResponse: true,
      timeoutMs: 120000,
    }],
    ['ollama-evaluation', {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      model: 'deepseek-v4-flash:cloud',
      stream: true,
      reasoningEffort: 'high',
      timeoutMs: 90000,
    }],
  ])('keeps the real request fingerprint identical for %s', async (profileId, transport) => {
    const baseline = await capture(transport);
    const rawBody = { ...baseline.body, stream: false };
    if (profileId === 'openrouter-primary') {
      rawBody.response_format = { type: 'text' };
      delete rawBody.reasoning;
      rawBody.reasoning_effort = 'high';
      rawBody.perf_metrics_in_response = true;
    } else if (profileId === 'fireworks-breakglass') {
      rawBody.response_format = { type: 'text' };
      delete rawBody.reasoning_effort;
      rawBody.reasoning = { effort: 'high' };
      rawBody.provider = { data_collection: 'deny' };
      rawBody.plugins = [{ id: 'auto-router' }];
      delete rawBody.perf_metrics_in_response;
    }
    const projectedBody = buildExecutionProfileRequest(profile(profileId), rawBody);
    expect(projectedBody).toEqual(baseline.body);

    const request = (captured: any) => ({
      url: captured.url,
      method: captured.init.method,
      headers: captured.init.headers,
      body: captured.body,
      timeoutMs: transport.timeoutMs,
    });
    expect(credentialFreeRequestFingerprint(request(baseline))).toBe(
      credentialFreeRequestFingerprint({ ...request(baseline), body: projectedBody }),
    );
    expect(JSON.stringify(credentialFreeRequestView({ ...request(baseline), body: projectedBody }))).not.toContain('fixture-secret');
    expect(JSON.stringify(credentialFreeRequestView({ ...request(baseline), body: projectedBody }))).not.toContain('secret diff');
  });

  it('independently asserts the profile-owned field translations', () => {
    const openRouter = buildExecutionProfileRequest(profile('openrouter-primary'), {
      model: 'current-model',
      stream: false,
      response_format: { type: 'text' },
      reasoning_effort: 'high',
      perf_metrics_in_response: true,
      provider: { data_collection: 'deny' },
      plugins: [{ id: 'auto-router' }],
    });
    expect(openRouter).toMatchObject({
      model: 'current-model',
      stream: true,
      response_format: { type: 'json_object' },
      reasoning: { effort: 'high' },
      provider: { data_collection: 'deny' },
      plugins: [{ id: 'auto-router' }],
    });
    expect(openRouter.reasoning_effort).toBeUndefined();
    expect(openRouter.perf_metrics_in_response).toBeUndefined();

    const fireworks = buildExecutionProfileRequest(profile('fireworks-breakglass'), {
      model: 'current-model',
      stream: false,
      response_format: { type: 'text' },
      reasoning: { effort: 'high' },
      provider: { data_collection: 'deny' },
      plugins: [{ id: 'auto-router' }],
    });
    expect(fireworks).toMatchObject({
      model: 'current-model',
      stream: true,
      response_format: { type: 'json_object' },
      reasoning_effort: 'high',
    });
    expect(fireworks.reasoning).toBeUndefined();
    expect(fireworks.provider).toBeUndefined();
    expect(fireworks.plugins).toBeUndefined();

    const ollama = buildExecutionProfileRequest(profile('ollama-evaluation'), {
      model: 'current-model',
      stream: false,
      response_format: { type: 'text' },
      reasoning_effort: 'high',
    });
    expect(ollama).toMatchObject({
      model: 'current-model',
      stream: true,
      response_format: { type: 'text' },
      reasoning_effort: 'high',
    });
  });

  it('redacts secrets in nested request fields and URL credentials before hashing', () => {
    const view = credentialFreeRequestView({
      url: 'https://user:password@example.test/v1/chat/completions?token=secret',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: {
        messages: [{ role: 'user', content: 'private prompt' }],
        metadata: { api_key: 'secret', label: 'safe' },
      },
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('https://user:password');
    expect(serialized).not.toContain('Bearer secret');
    expect(serialized).not.toContain('"api_key":"secret"');
    expect(serialized).not.toContain('private prompt');
    expect(view.endpoint).toBe('https://example.test/v1');
    expect(credentialFreeRequestFingerprint({
      url: 'https://example.test/v1/chat/completions',
      headers: { 'Content-Type': 'application/json' },
      body: { messages: [{ role: 'user', content: 'different prompt' }] },
    })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects prototype-sensitive request keys before sanitizing the fingerprint view', () => {
    expect(() => credentialFreeRequestView({
      body: JSON.parse('{"messages":[],"__proto__":{"polluted":true}}'),
    })).toThrow(/forbidden key.*__proto__/i);
    expect(() => credentialFreeRequestView({
      headers: JSON.parse('{"__proto__":{"polluted":true}}'),
      body: { messages: [] },
    })).toThrow(/forbidden key.*__proto__/i);
    const polluted = Object.create({ inherited: 'unsafe' });
    polluted.messages = [];
    expect(() => credentialFreeRequestView({ body: polluted })).toThrow(/plain objects/i);
    const accessor = {};
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => 'must not run' });
    expect(() => credentialFreeRequestView({ body: accessor })).toThrow(/accessor properties/i);
  });
});
