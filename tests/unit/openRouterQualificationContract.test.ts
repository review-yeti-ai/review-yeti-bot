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
const testingPersona = PERSONA_CHARTERS.find((candidate: any) => candidate.id === 'testing');
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
    model: policy.allowed_models[0],
    models: [policy.allowed_models[1]],
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
  it('shares the complete review context prefix across personas and varies only the final assignment', async () => {
    const requestBodies: any[] = [];
    const fetchImplementation = async (_url: string, init: any) => {
      requestBodies.push(JSON.parse(init.body));
      return streamResponse([{ choices: [{ delta: { content: '{"findings":[]}' } }] }]);
    };
    const prContext = {
      repo: 'calltelemetry/example',
      prNumber: 17,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      title: 'Cache-friendly review',
    };

    for (const reviewer of [persona, testingPersona]) {
      const result = await reviewWithModel(reviewer, diffFiles, prContext, null, {
        openRouterPolicy: policy,
        transports: [openRouterTransport()],
        fetchImplementation,
        circuitBreaker: new RunTransportCircuitBreaker(),
      });
      expect(result.decision).toBe('APPROVE');
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0].messages).toHaveLength(3);
    expect(requestBodies[1].messages).toHaveLength(3);
    expect(requestBodies[0].messages.slice(0, 2)).toEqual(requestBodies[1].messages.slice(0, 2));
    expect(requestBodies[0].messages[0]).toMatchObject({ role: 'system' });
    expect(requestBodies[0].messages[1]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Unified diff under review:'),
    });
    expect(requestBodies[0].messages[2]).toMatchObject({
      role: 'user',
      content: expect.stringContaining(persona.charter),
    });
    expect(requestBodies[1].messages[2]).toMatchObject({
      role: 'user',
      content: expect.stringContaining(testingPersona.charter),
    });
    expect(requestBodies[0].messages[2]).not.toEqual(requestBodies[1].messages[2]);
    expect(requestBodies[0].session_id).toMatch(/^review-yeti-v1-[a-f0-9]{48}$/);
    expect(requestBodies[0].session_id).toBe(requestBodies[1].session_id);
    expect(requestBodies[0].prompt_cache_key).toBe(requestBodies[0].session_id);
    expect(requestBodies[1].prompt_cache_key).toBe(requestBodies[1].session_id);
  });

  it('invalidates the OpenRouter prompt cache identity when the exact review content changes', async () => {
    const sessionIds: string[] = [];
    const fetchImplementation = async (_url: string, init: any) => {
      sessionIds.push(JSON.parse(init.body).session_id);
      return streamResponse([{ choices: [{ delta: { content: '{"findings":[]}' } }] }]);
    };
    const commonOptions = {
      openRouterPolicy: policy,
      transports: [openRouterTransport()],
      fetchImplementation,
      circuitBreaker: new RunTransportCircuitBreaker(),
    };

    await reviewWithModel(persona, diffFiles, {
      repo: 'calltelemetry/example',
      prNumber: 17,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    }, null, commonOptions);
    await reviewWithModel(persona, [{
      ...diffFiles[0],
      patch: `${diffFiles[0].patch}+const changed = true;\n`,
    }], {
      repo: 'calltelemetry/example',
      prNumber: 17,
      baseSha: 'a'.repeat(40),
      headSha: 'c'.repeat(40),
    }, null, commonOptions);

    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).toMatch(/^review-yeti-v1-[a-f0-9]{48}$/);
    expect(sessionIds[1]).toMatch(/^review-yeti-v1-[a-f0-9]{48}$/);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
  });

  it('does not send OpenRouter cache-routing fields to direct providers', async () => {
    let requestBody: any;
    const fetchImplementation = async (_url: string, init: any) => {
      requestBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
      };
    };

    const result = await reviewWithModel(persona, diffFiles, { repo: 'o/r', prNumber: 1 }, null, {
      transports: [{
        name: 'ollama',
        baseUrl: 'https://ollama.com/v1',
        apiKey: 'direct-test-key',
        model: 'deepseek-v4-flash:cloud',
      }],
      fetchImplementation,
      circuitBreaker: new RunTransportCircuitBreaker(),
    });

    expect(result.decision).toBe('APPROVE');
    expect(requestBody.messages).toHaveLength(2);
    expect(requestBody.messages[0].content).toContain(persona.charter);
    expect(requestBody).not.toHaveProperty('session_id');
    expect(requestBody).not.toHaveProperty('prompt_cache_key');
  });

  it('enforces the distinct time-to-first-token deadline for a real SSE body', async () => {
    const response = {
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({ start() {}, cancel() {} }),
    };

    await expect(readChatCompletionResponse(response, true, 100, 100, 5)).rejects.toMatchObject({
      timeoutKind: 'ttft',
    });
  });

  it('does not treat a role-only SSE envelope as the first usable token', async () => {
    const wire = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`;
    const response = {
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(wire));
        },
        cancel() {},
      }),
    };

    await expect(readChatCompletionResponse(response, true, 100, 100, 5)).rejects.toMatchObject({
      timeoutKind: 'ttft',
    });
  });

  it('does not treat empty-string deltas as the first usable token', async () => {
    const wire = `data: ${JSON.stringify({ choices: [{ delta: { content: '', reasoning: '' } }] })}\n\n`;
    const response = {
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(wire));
        },
        cancel() {},
      }),
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
        usage: {
          prompt_tokens: 101,
          completion_tokens: 23,
          total_tokens: 124,
          cost: 0.0042,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 21 },
        },
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
      cachedInputTokens: 80,
      cacheWriteTokens: 21,
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
        cachedInputTokens: 80,
        cacheWriteTokens: 21,
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
      model: policy.allowed_models[0],
      models: [policy.allowed_models[1]],
      stream: true,
      reasoning: { effort: 'high' },
      response_format: { type: 'json_object' },
      provider: { data_collection: 'deny' },
    });
    expect(calls[0].body).not.toHaveProperty('plugins');
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
              message: `${policy.allowed_models[0]} is temporarily unavailable`,
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
      model: policy.allowed_models[0],
      models: [policy.allowed_models[1]],
      provider: { data_collection: 'deny', require_parameters: true },
      response_format: { type: 'json_object' },
    });
    expect(calls[1].models).toHaveLength(1);
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
