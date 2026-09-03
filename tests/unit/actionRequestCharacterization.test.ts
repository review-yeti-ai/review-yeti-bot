import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const pipeline = require(path.join(root, '.github/workflows/pipelines/review-pipeline.js'));
const fixturePath = path.join(root, 'tests/fixtures/review-yeti/rank2a-execution-plan.fixture.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const FIXTURE_SOURCE = Object.freeze({
  repository: 'calltelemetry/ct-review-actions',
  commit: 'f28022666c4f32e22c8a4394ae12a3e72083c636',
  digest: '5ab2aab69d774c057c05e01c192a6d9a489622f6071742bbcec18321d2ffdbb2',
});

const BASE_URL_BY_CLASS: Record<string, string> = Object.freeze({
  'direct-fireworks-openai-compatible': 'https://api.fireworks.ai/inference/v1',
  'direct-ollama-cloud-openai-compatible': 'https://ollama.com/v1',
  'openrouter-gateway': 'https://openrouter.ai/api/v1',
});

const KEY_ENV_BY_NAME: Record<string, string> = Object.freeze({
  fireworks: 'FIXTURE_FIREWORKS_KEY',
  ollama: 'FIXTURE_OLLAMA_KEY',
  'openrouter-fallback': 'FIXTURE_OPENROUTER_KEY',
});

function canonicalJson(value: any): string | undefined {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hydrateTransportForAction(transport: any) {
  const baseUrl = BASE_URL_BY_CLASS[transport.base_url_class];
  const apiKeyEnv = KEY_ENV_BY_NAME[transport.name];
  if (!baseUrl || !apiKeyEnv) throw new Error(`unapproved fixture transport ${transport.name}`);

  return {
    name: transport.name,
    base_url: baseUrl,
    api_key_env: apiKeyEnv,
    model: transport.model,
    compat: transport.compatibility_mode,
    timeout_ms: transport.timeouts.request_ms,
    connect_timeout_ms: transport.timeouts.connect_ms,
    ttft_ms: transport.timeouts.ttft_ms,
    stall_ms: transport.timeouts.stall_ms,
    stream: transport.streaming,
    ...(transport.structured_output === 'runtime-default-uncharacterized'
      ? {}
      : { structured_output: transport.structured_output }),
    perf_metrics_in_response: transport.request_extensions.perf_metrics_in_response,
    reasoning_effort: transport.reasoning.effort,
    ...(transport.quarantine.on_timeout === 'runtime-default-uncharacterized'
      ? {}
      : { quarantine_on_timeout: transport.quarantine.on_timeout }),
    ignore_providers: transport.routing.ignore_providers,
    ...(transport.routing.provider ? { provider_routing: transport.routing.provider } : {}),
  };
}

function resolveFixtureRuntime() {
  const transportInputs = fixture.plan.transports.map(hydrateTransportForAction);
  return pipeline.resolveActionReviewRuntime({ parsed: {} }, {
    REVIEW_YETI_TRANSPORTS: JSON.stringify(transportInputs),
    FIXTURE_FIREWORKS_KEY: 'fixture-fireworks-key',
    FIXTURE_OLLAMA_KEY: 'fixture-ollama-key',
    FIXTURE_OPENROUTER_KEY: 'fixture-openrouter-key',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_MODEL: 'openrouter/auto',
    OPENROUTER_DATA_COLLECTION: 'deny',
  });
}

// Mirrors scripts/review-yeti-smoke.mjs::buildRequest at FIXTURE_SOURCE.commit. Keeping this
// adapter local avoids a cross-repository runtime dependency; the pinned digest and exhaustive
// disposition check make unclassified fixture changes fail closed.
function smokeBodyFromFixture(transport: any) {
  const body: Record<string, any> = {
    model: transport.model,
    messages: [
      { role: 'system', content: '<smoke-system-prompt>' },
      { role: 'user', content: '<smoke-user-prompt>' },
    ],
    temperature: 0,
    max_tokens: 128,
    stream: transport.streaming,
    response_format: { type: 'json_object' },
  };
  if (transport.routing.provider) body.provider = transport.routing.provider;
  if (transport.reasoning.effort !== 'runtime-default-uncharacterized') {
    if (transport.reasoning.wire_shape === 'reasoning.effort') {
      body.reasoning = { effort: transport.reasoning.effort };
    } else {
      body.reasoning_effort = transport.reasoning.effort;
    }
  }
  if (transport.request_extensions.perf_metrics_in_response) body.perf_metrics_in_response = true;
  return body;
}

function endpointClass(url: string) {
  const baseUrl = url.replace(/\/chat\/completions$/, '');
  return Object.entries(BASE_URL_BY_CLASS).find(([, candidate]) => candidate === baseUrl)?.[0] || 'unclassified';
}

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

async function capturePanelRequests() {
  const runtime = resolveFixtureRuntime();
  const captured: Record<string, any> = {};
  const contracts: Record<string, any> = {};

  for (const transport of runtime.modelConfig.transports) {
    pipeline.globalRunCircuitBreaker.reset();
    const result = await pipeline.reviewWithModel(
      { id: 'testing', name: 'Testing Specialist', charter: 'Check tests.' },
      [{ path: 'src/example.ts', patch: '@@ -0,0 +1 @@\n+export const value = 1;' }],
      { repo: 'fixture/repository', prNumber: '1' },
      null,
      {
        ...runtime.modelConfig,
        transports: [transport],
        fetchImplementation: async (url: string, init: any) => {
          const body = JSON.parse(init.body);
          captured[transport.name] = {
            endpoint_class: endpointClass(url),
            method: init.method,
            headers: {
              authorization: init.headers.Authorization ? '<redacted>' : '<missing>',
              'content-type': init.headers['Content-Type'],
            },
            timeout_ms: transport.timeoutMs,
            body: {
              ...body,
              messages: body.messages.map((message: any, index: number) => ({
                role: message.role,
                content: message.role === 'system'
                  ? '<panel-system-prompt>'
                  : index === 1
                    ? '<panel-evidence-prompt>'
                    : '<panel-assignment-prompt>',
              })),
            },
          };
          return successfulStream(transport.model);
        },
      },
    );
    expect(result).toMatchObject({ decision: 'APPROVE', findings: [], transport: transport.name });
    contracts[transport.name] = result.outputContract;
  }

  return { runtime, captured, contracts };
}

function leafPaths(value: any, prefix = ''): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [prefix];
    return value.flatMap((entry, index) => leafPaths(entry, `${prefix}[${index}]`));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return [prefix];
    return entries.flatMap(([key, entry]) => leafPaths(entry, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

function normalizePlanPath(pathValue: string) {
  return pathValue.replace(/\[\d+\]/g, '[*]');
}

function dispositionFor(pathValue: string): string | null {
  if (/^(schema|policy_schema|release_channel|transport_order\[\*\]|lane\.)/.test(pathValue)) return 'workflow-owned';
  if (/^transports\[\*\]\.(name|model|timeouts\.(connect_ms|request_ms|stall_ms|ttft_ms)|streaming|reasoning\.effort|request_extensions\.perf_metrics_in_response)$/.test(pathValue)) return 'consumed';
  if (pathValue === 'transports[*].base_url_class') return 'test-hydrated-and-consumed';
  if (/^transports\[\*\]\.(compatibility_mode|structured_output|reasoning\.wire_shape|routing\.mode)$/.test(pathValue)) return 'runtime-derived-or-hardcoded-parity';
  if (/^transports\[\*\]\.(privacy\.data_collection|routing\.provider\.data_collection)$/.test(pathValue)) return 'translated-via-action-policy';
  if (/^transports\[\*\]\.retry\.(max_attempts|classification)$/.test(pathValue)) return 'runtime-owned-uncharacterized';
  if (/^transports\[\*\]\.routing\.(ignore_providers(?:\[\*\])?|provider(?:\..*)?)/.test(pathValue)) return 'consumed';
  if (pathValue === 'transports[*].quarantine.on_timeout') return 'consumed';
  return null;
}

describe('CallTelemetry Rank 2A execution plan through the real Action request path', () => {
  it('pins the credential-free central fixture to its reviewed source and normalized digest', () => {
    expect(fixture.schema).toBe('calltelemetry.review-execution-plan-fixture.v1');
    expect(fixture.normalized_plan_sha256).toBe(FIXTURE_SOURCE.digest);
    expect(createHash('sha256').update(canonicalJson(fixture.plan)!).digest('hex')).toBe(FIXTURE_SOURCE.digest);
    expect(FIXTURE_SOURCE).toEqual({
      repository: 'calltelemetry/ct-review-actions',
      commit: 'f28022666c4f32e22c8a4394ae12a3e72083c636',
      digest: '5ab2aab69d774c057c05e01c192a6d9a489622f6071742bbcec18321d2ffdbb2',
    });
  });

  it('accounts for every fixture leaf without dropping timing policy', () => {
    const paths = [...new Set(leafPaths(fixture.plan).map(normalizePlanPath))].sort();
    expect(paths.filter((entry) => dispositionFor(entry) === null)).toEqual([]);
    expect(paths.filter((entry) => dispositionFor(entry) === 'dropped-by-runtime-mapper')).toEqual([]);
  });

  it('preserves timing and timeout quarantine decisions through the Action runtime mapper', () => {
    const runtime = resolveFixtureRuntime();

    expect(runtime.modelConfig.transports.find((transport: any) => transport.name === 'openrouter-fallback'))
      .toMatchObject({
        connectTimeoutMs: 30000,
        timeoutMs: 90000,
        ttftTimeoutMs: 30000,
        stallTimeoutMs: 20000,
        quarantineOnTimeout: false,
      });
  });

  it('snapshots the final credential-free request shape for every configured transport', async () => {
    const { captured, contracts } = await capturePanelRequests();
    const common = (model: string, temperature = 0.1) => ({
      model,
      messages: [
        { role: 'system', content: '<panel-system-prompt>' },
        { role: 'user', content: '<panel-evidence-prompt>' },
      ],
      temperature,
      response_format: { type: 'json_object' },
      stream: true,
    });

    expect(captured).toEqual({
      fireworks: {
        endpoint_class: 'direct-fireworks-openai-compatible',
        method: 'POST',
        headers: { authorization: '<redacted>', 'content-type': 'application/json' },
        timeout_ms: 120000,
        body: {
          ...common('accounts/fireworks/models/deepseek-v4-flash-0731'),
          reasoning_effort: 'none',
          perf_metrics_in_response: true,
        },
      },
      ollama: {
        endpoint_class: 'direct-ollama-cloud-openai-compatible',
        method: 'POST',
        headers: { authorization: '<redacted>', 'content-type': 'application/json' },
        timeout_ms: 90000,
        body: {
          ...common('deepseek-v4-flash:cloud', 0),
          seed: 144208749,
          reasoning_effort: 'none',
        },
      },
      'openrouter-fallback': {
        endpoint_class: 'openrouter-gateway',
        method: 'POST',
        headers: { authorization: '<redacted>', 'content-type': 'application/json' },
        timeout_ms: 90000,
        body: {
          ...common('deepseek/deepseek-v4-flash-0731'),
          messages: [
            { role: 'system', content: '<panel-system-prompt>' },
            { role: 'user', content: '<panel-evidence-prompt>' },
            { role: 'user', content: '<panel-assignment-prompt>' },
          ],
          reasoning: { effort: 'none' },
          session_id: 'review-yeti-v1-11a37010bca3ef6ace2fb892cd3d5969b2d4eff6fa878bce',
          prompt_cache_key: 'review-yeti-v1-11a37010bca3ef6ace2fb892cd3d5969b2d4eff6fa878bce',
          provider: {
            allow_fallbacks: true,
            require_parameters: true,
            ignore: ['morph', 'fireworks'],
            sort: 'throughput',
            preferred_min_throughput: { p90: 40 },
            preferred_max_latency: { p99: 3 },
            data_collection: 'deny',
          },
        },
      },
    });
    expect(contracts).toEqual({
      fireworks: {
        policyDeclared: 'json_object',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: true,
      },
      ollama: {
        policyDeclared: 'unknown',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: true,
      },
      'openrouter-fallback': {
        policyDeclared: 'json_object',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: true,
      },
    });
  });

  it('proves OpenRouter-only fields never reach Fireworks or Ollama', async () => {
    const { captured } = await capturePanelRequests();
    for (const name of ['fireworks', 'ollama']) {
      expect(captured[name].body).not.toHaveProperty('provider');
      expect(captured[name].body).not.toHaveProperty('plugins');
    }
    expect(captured.fireworks.body).not.toHaveProperty('seed');
    expect(captured['openrouter-fallback'].body).not.toHaveProperty('seed');
    expect(captured.ollama.body.seed).toBe(144208749);
    expect(captured['openrouter-fallback'].body).toHaveProperty('provider');
    expect(captured['openrouter-fallback'].body).not.toHaveProperty('plugins');
  });

  it('categorizes smoke/panel semantic parity and the remaining OpenRouter routing drift', async () => {
    const { captured } = await capturePanelRequests();
    const parity = Object.fromEntries(fixture.plan.transports.map((transport: any) => {
      const smoke = smokeBodyFromFixture(transport);
      const panel = captured[transport.name].body;
      return [transport.name, {
        model: smoke.model === panel.model ? 'equal' : 'different',
        response_format: canonicalJson(smoke.response_format) === canonicalJson(panel.response_format) ? 'equal' : 'different',
        stream: smoke.stream === panel.stream ? 'equal' : 'different',
        reasoning: canonicalJson(smoke.reasoning ?? smoke.reasoning_effort) === canonicalJson(panel.reasoning ?? panel.reasoning_effort) ? 'equal' : 'different',
        perf_metrics_in_response: canonicalJson(smoke.perf_metrics_in_response) === canonicalJson(panel.perf_metrics_in_response) ? 'equal' : 'different',
        provider: canonicalJson(smoke.provider) === canonicalJson(panel.provider) ? 'equal' : 'different',
        plugins: smoke.plugins === undefined && panel.plugins !== undefined ? 'panel-only' : 'equal',
        temperature: smoke.temperature === panel.temperature ? 'equal' : 'prompt-specific-difference',
        max_tokens: smoke.max_tokens === panel.max_tokens ? 'equal' : 'prompt-specific-difference',
      }];
    }));

    expect(parity).toEqual({
      fireworks: {
        model: 'equal', response_format: 'equal', stream: 'equal', reasoning: 'equal',
        perf_metrics_in_response: 'equal', provider: 'equal', plugins: 'equal',
        temperature: 'prompt-specific-difference', max_tokens: 'prompt-specific-difference',
      },
      ollama: {
        model: 'equal', response_format: 'equal', stream: 'equal', reasoning: 'equal',
        perf_metrics_in_response: 'equal', provider: 'equal', plugins: 'equal',
        temperature: 'equal', max_tokens: 'prompt-specific-difference',
      },
      'openrouter-fallback': {
        model: 'equal', response_format: 'equal', stream: 'equal', reasoning: 'equal',
        perf_metrics_in_response: 'equal', provider: 'equal', plugins: 'equal',
        temperature: 'prompt-specific-difference', max_tokens: 'prompt-specific-difference',
      },
    });
  });
});
