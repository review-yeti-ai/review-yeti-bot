import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');

const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const policy = require(path.join(rootRepoDir, 'src/config/openrouter-review-policy.json'));

const {
  PERSONA_CHARTERS,
  RunTransportCircuitBreaker,
  reviewWithModel,
  readChatCompletionResponse,
} = pipeline;
const persona = PERSONA_CHARTERS.find((candidate: any) => candidate.id === 'security');
const diffFiles = [{
  path: 'src/api/user.ts',
  patch: 'diff --git a/src/api/user.ts b/src/api/user.ts\n@@ -1,2 +1,2 @@\n+const id = req.query.id;\n',
  addedLines: [{ text: 'const id = req.query.id;' }],
  deletedLines: [],
}];

function openRouterTransport() {
  return {
    name: 'openrouter',
    compat: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'qualification-test-key',
    model: 'openrouter/auto',
    stream: true,
    reasoning_effort: 'high',
  };
}

function streamResponse(frames: any[], { model = 'openai/gpt-5.6-luna', provider = 'openrouter', usage } = {}) {
  const payloads = [
    ...frames,
    {
      model,
      provider,
      usage,
      choices: [{ delta: {}, finish_reason: 'stop' }],
    },
  ];
  const wire = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': 'text/event-stream',
      'x-generation-id': 'qualification-generation-1',
    }),
    body: new ReadableStream({
      start(controller) {
        const splitAt = Math.max(1, Math.floor(wire.length / 2));
        controller.enqueue(new TextEncoder().encode(wire.slice(0, splitAt)));
        controller.enqueue(new TextEncoder().encode(wire.slice(splitAt)));
        controller.close();
      },
    }),
  };
}

describe('OpenRouter qualification contract', () => {
  it('enforces the distinct time-to-first-token deadline for a real SSE body', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({ start() {}, cancel() {} }),
    };

    await expect(readChatCompletionResponse(response, true, 100, 100, 5)).rejects.toMatchObject({
      timeoutKind: 'ttft',
    });
  });

  it('records reasoning_details text from the OpenRouter SSE wire shape', async () => {
    const fetchImplementation = async () => streamResponse([
      {
        choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'checked the diff' }] } }],
      },
      { choices: [{ delta: { content: '{"findings":[]}' } }] },
    ]);

    const result = await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 3 }, null, {
      openRouterPolicy: policy,
      transports: [openRouterTransport()],
      fetchImplementation,
      circuitBreaker: new RunTransportCircuitBreaker(),
    });

    expect(result).toMatchObject({ decision: 'APPROVE', reasoningPresent: true, ttftMs: expect.any(Number) });
    expect(result.responseAttempts[0]).toMatchObject({ reasoningPresent: true });
  });

  it('parses fragmented SSE, preserves OpenRouter routing, and records runtime attribution', async () => {
    const calls: any[] = [];
    const fetchImplementation = async (_url: string, init: any) => {
      calls.push({ body: JSON.parse(init.body), headers: init.headers });
      return streamResponse([
        { openrouter_metadata: { attempt: 2, strategy: 'default', region: 'us', endpoints: ['provider-a'] } },
        { choices: [{ delta: { reasoning: 'checking the diff' } }] },
        { choices: [{ delta: { content: '{"findings":[]}' } }] },
      ], {
        usage: { prompt_tokens: 101, completion_tokens: 23, total_tokens: 124, cost: 0.0042 },
      });
    };

    const result = await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 1 }, null, {
      openRouterPolicy: policy,
      transports: [openRouterTransport()],
      fetchImplementation,
      circuitBreaker: new RunTransportCircuitBreaker(),
    });

    expect(result).toMatchObject({
      decision: 'APPROVE',
      findings: [],
      model: 'openai/gpt-5.6-luna',
      provider: 'openrouter',
      inputTokens: 101,
      outputTokens: 23,
      cost: 0.0042,
      responseMode: 'stream',
      findingsSource: 'content',
      outputShape: 'direct_json_object',
      attemptCount: 1,
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      routerMetadata: expect.objectContaining({ attempt: 2, strategy: 'default', region: 'us' }),
    });
    expect(result.responseAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'parsed',
        transport: 'openrouter',
        provider: 'openrouter',
        responseStatus: 200,
        outputTokens: 23,
        responseMode: 'stream',
        outputShape: 'direct_json_object',
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        generationIdDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        routerMetadata: expect.objectContaining({ attempt: 2 }),
      }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['X-OpenRouter-Metadata']).toBe('enabled');
    expect(calls[0].headers.Accept).toBe('text/event-stream');
    expect(calls[0].body).toMatchObject({
      model: 'openrouter/auto',
      stream: true,
      reasoning: { effort: 'high' },
      response_format: { type: 'json_object' },
      provider: { data_collection: 'deny' },
      plugins: [{ id: 'auto-router', allowed_models: policy.allowed_models }],
    });
    expect(calls[0].body).not.toHaveProperty('reasoning_effort');
  });

  it('preserves a response-reported OpenInference upstream label separately from the gateway transport', async () => {
    const fetchImplementation = async () => streamResponse([
      { choices: [{ delta: { content: '{"findings":[]}' } }] },
    ], { provider: 'OpenInference', usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.0001 } });

    const result = await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 2 }, null, {
      openRouterPolicy: policy,
      transports: [openRouterTransport()],
      fetchImplementation,
      circuitBreaker: new RunTransportCircuitBreaker(),
    });

    expect(result.provider).toBe('OpenInference');
    expect(result.transport).toBe('openrouter');
    expect(result.responseAttempts).toEqual([
      expect.objectContaining({ provider: 'openinference', transport: 'openrouter' }),
    ]);
  });

  it('fails closed on OpenRouter authentication failure without retrying or crossing providers', async () => {
    let calls = 0;
    const fetchImplementation = async () => {
      calls += 1;
      return {
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { code: 'invalid_api_key', message: 'credential rejected' } }),
      };
    };

    const result = await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 1 }, null, {
      openRouterPolicy: policy,
      transports: [openRouterTransport()],
      fetchImplementation,
      circuitBreaker: new RunTransportCircuitBreaker(),
    });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      decision: 'ERROR',
      findings: [],
      attemptCount: 1,
      failureClass: 'http_4xx',
      retryReasons: ['http_4xx'],
      responseStatus: 401,
    });
    expect(result.transport).toBe('openrouter');
  });

  it('caps OpenRouter model recovery after an upstream 5xx and keeps the retry direct', async () => {
    const calls: any[] = [];
    const fetchImplementation = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (calls.length === 1) {
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => JSON.stringify({
            error: {
              code: 'upstream_unavailable',
              message: 'openai/gpt-5.6-luna is temporarily unavailable',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] }),
      };
    };

    const result = await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 1 }, null, {
      openRouterPolicy: policy,
      transports: [openRouterTransport()],
      fetchImplementation,
      circuitBreaker: new RunTransportCircuitBreaker(),
      sleepImplementation: async () => {},
    });

    expect(result).toMatchObject({
      decision: 'APPROVE',
      attemptCount: 2,
      retryReasons: ['http_5xx'],
      recoveryAction: 'model_fallback',
      failureClass: null,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      model: 'openai/gpt-5.6-luna',
      models: policy.allowed_models.slice(1, 4),
      provider: { data_collection: 'deny', require_parameters: true },
      response_format: { type: 'json_object' },
    });
    expect(calls[1].models).toHaveLength(3);
    expect(calls[1]).not.toHaveProperty('plugins');
    expect(calls[1]).not.toHaveProperty('reasoning');
  });

  it('does not invent usage or cost when OpenRouter omits them', async () => {
    const fetchImplementation = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        model: 'z-ai/glm-5.2',
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      }),
    });

    const result = await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 1 }, null, {
      openRouterPolicy: policy,
      transports: [{ ...openRouterTransport(), stream: false }],
      fetchImplementation,
      circuitBreaker: new RunTransportCircuitBreaker(),
    });

    expect(result).toMatchObject({
      decision: 'APPROVE',
      provider: 'openrouter',
      model: 'z-ai/glm-5.2',
      cost: null,
      inputTokens: null,
      outputTokens: null,
    });
  });
});
