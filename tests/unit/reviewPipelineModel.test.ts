import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const {
  analyzeFindingsPayload,
  buildOutputContractTelemetry,
  normalizeOutputContractTelemetry,
  normalizeModelFinishReason,
  responseSizeBucket,
  reviewWithModel,
  resolveModelConfig,
  resolveStructuredOutputMode,
  buildFindingsResponseFormat,
  isStructuredOutputCompatibilityError,
  FINDINGS_RESPONSE_SCHEMA,
  PERSONA_CHARTERS,
} = pipeline;
const securityPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');
const testingPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'testing');

const diffFiles = [
  {
    path: 'src/api/user.ts',
    patch: 'diff --git a/src/api/user.ts b/src/api/user.ts\n+const id = req.query.id;\n',
    addedLines: [{ text: 'const id = req.query.id;' }],
    deletedLines: [],
  },
];

/** Builds a fetch stub returning an OpenAI-compatible chat completion. */
function stubFetch(content: string, opts: { ok?: boolean; status?: number; payload?: any } = {}) {
  const calls: any[] = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: opts.ok !== false,
      status: opts.status || 200,
      text: async () => 'error body',
      json: async () => opts.payload || ({ choices: [{ message: { content } }] }),
    };
  };
  return { impl, calls };
}

const validFindings = JSON.stringify({
  findings: [
    {
      severity: 'P1',
      path: 'src/api/user.ts',
      line: 2,
      title: 'Unvalidated query parameter',
      body: 'req.query.id flows into a query without tenant scoping.',
      suggestion: 'Scope the lookup by orgId.',
    },
  ],
});

describe('bounded model output-shape telemetry', () => {
  it('separates policy declaration, wire observation, provider capability, and terminal parsing', () => {
    expect(buildOutputContractTelemetry(
      { structured_output: 'strict' },
      { response_format: { type: 'json_object' } },
      true,
    )).toEqual({
      policyDeclared: 'json_object',
      requestObserved: 'json_object',
      providerSupported: 'unreported',
      terminalParsed: true,
    });
    expect(buildOutputContractTelemetry({}, {}, false)).toEqual({
      policyDeclared: 'unknown',
      requestObserved: 'prompt_validated_json',
      providerSupported: 'unreported',
      terminalParsed: false,
    });
    expect(normalizeOutputContractTelemetry({ policyDeclared: 'secret', terminalParsed: 1 })).toEqual({
      policyDeclared: 'unknown',
      requestObserved: 'unknown',
      providerSupported: 'unreported',
      terminalParsed: false,
    });
  });

  it.each([
    ['{"findings":[]}', 'direct_json_object'],
    ['[]', 'direct_json_array'],
    ['```json\n{"findings":[]}\n```', 'fenced_json_object'],
    ['```json\n[]\n```', 'fenced_json_array'],
    ['Result: {"findings":[]} done.', 'embedded_json_object'],
    ['{"answer":[]}', 'valid_json_wrong_shape'],
    ['{"findings":[', 'truncated_json'],
    ['review completed without a JSON result', 'no_json'],
    ['', 'empty_content'],
  ])('classifies %j without retaining response text', (content, outputShape) => {
    const analysis = analyzeFindingsPayload(content);
    expect(analysis.outputShape).toBe(outputShape);
    expect(Object.keys(analysis).sort()).toEqual(['findings', 'outputShape']);
  });

  it('normalizes finish reasons and response sizes to closed buckets', () => {
    expect(normalizeModelFinishReason('stop')).toBe('stop');
    expect(normalizeModelFinishReason('provider_secret_detail')).toBe('other');
    expect(normalizeModelFinishReason()).toBe('missing');
    expect(responseSizeBucket('')).toBe('empty');
    expect(responseSizeBucket('x'.repeat(257))).toBe('small');
    expect(responseSizeBucket('x'.repeat(16_385))).toBe('oversize');
  });

  it('keeps json_schema opt-in while preserving the compatible json_object default', () => {
    expect(resolveStructuredOutputMode({ structured_output: 'strict' })).toBe('json_object');
    expect(resolveStructuredOutputMode({})).toBe('json_object');
    expect(resolveStructuredOutputMode({ structured_output_mode: 'json_schema' })).toBe('json_schema');
    expect(buildFindingsResponseFormat('json_object')).toEqual({ type: 'json_object' });
    expect(buildFindingsResponseFormat('json_schema')).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'review_findings',
        strict: true,
        schema: FINDINGS_RESPONSE_SCHEMA,
      },
    });
  });

  it('recognizes only explicit structured-output compatibility errors', () => {
    expect(isStructuredOutputCompatibilityError(400, 'response_format json_schema is not supported')).toBe(true);
    expect(isStructuredOutputCompatibilityError(422, 'structured output schema is invalid')).toBe(true);
    expect(isStructuredOutputCompatibilityError(401, 'response_format json_schema is not supported')).toBe(false);
    expect(isStructuredOutputCompatibilityError(400, 'invalid API key')).toBe(false);
  });
});

describe('resolveModelConfig', () => {
  it('reports disabled when no API key is present', () => {
    const cfg = resolveModelConfig({});
    expect(cfg.enabled).toBe(false);
  });

  it('enables when OPENROUTER_API_KEY is present and defaults to the OpenRouter endpoint', () => {
    const cfg = resolveModelConfig({ OPENROUTER_API_KEY: 'sk-test' });
    expect(cfg.enabled).toBe(true);
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.baseUrl).toContain('openrouter.ai');
    expect(cfg.model).toBe('openrouter/auto');
  });

  it('allows an explicitly configured OpenRouter-compatible endpoint', () => {
    const cfg = resolveModelConfig({
      OPENROUTER_API_KEY: 'k',
      OPENROUTER_BASE_URL: 'https://openrouter.example/v1/',
      OPENROUTER_MODEL: 'some/model',
    });
    expect(cfg.baseUrl).toBe('https://openrouter.example/v1');
    expect(cfg.model).toBe('some/model');
  });

  it('auto-synthesizes multi-transport chain when multiple provider API keys are supplied', () => {
    const cfg = resolveModelConfig({
      FIREWORKS_API_KEY: 'fw-key-123',
      ANTHROPIC_API_KEY: 'sk-ant-456',
      OPENROUTER_API_KEY: 'sk-or-789',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.transports).toHaveLength(3);
    expect(cfg.transports[0].name).toBe('fireworks');
    expect(cfg.transports[0].apiKey).toBe('fw-key-123');
    expect(cfg.transports[0].model).toBe('accounts/fireworks/models/deepseek-v4-flash-0731');
    expect(cfg.transports[1].name).toBe('anthropic');
    expect(cfg.transports[1].apiKey).toBe('sk-ant-456');
    expect(cfg.transports[1].model).toBe('claude-5-haiku:high');
    expect(cfg.transports[2].name).toBe('openrouter');
    expect(cfg.transports[2].apiKey).toBe('sk-or-789');
  });

  it('supports direct Gemini, OpenAI, and Ollama provider keys with modern defaults', () => {
    const cfg = resolveModelConfig({
      GEMINI_API_KEY: 'gem-key-abc',
      OPENAI_API_KEY: 'oa-key-123',
      OLLAMA_API_KEY: 'ollama-key-xyz',
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.transports).toHaveLength(3);
    expect(cfg.transports[0].name).toBe('ollama');
    expect(cfg.transports[1].name).toBe('gemini');
    expect(cfg.transports[1].model).toBe('google/gemini-3.7-flash:high');
    expect(cfg.transports[2].name).toBe('openai');
    expect(cfg.transports[2].model).toBe('openai/gpt-5.6-luna:high');
  });

  it('retains central stream and reasoning fields in an explicit transport plan', () => {
    const cfg = resolveModelConfig({
      FIREWORKS_PR_REVIEW_API_KEY: 'fw-key',
      REVIEW_YETI_TRANSPORTS: JSON.stringify([{
        name: 'fireworks',
        base_url: 'https://api.fireworks.ai/inference/v1',
        api_key_env: 'FIREWORKS_PR_REVIEW_API_KEY',
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        stream: true,
        reasoning_effort: 'high',
        perf_metrics_in_response: true,
        structured_output_mode: 'json_schema',
      }]),
    });

    expect(cfg.transports[0]).toMatchObject({
      stream: true,
      reasoningEffort: 'high',
      perfMetricsInResponse: true,
      structuredOutputMode: 'json_schema',
    });
  });
});

describe('reviewWithModel', () => {
  it('reserves a three-times direct generation budget for the structured output target', () => {
    expect(pipeline.DIRECT_GENERATION_BUDGET_MULTIPLIER).toBe(3);
    expect(pipeline.DEFAULT_DIRECT_MAX_OUTPUT_TOKENS).toBe(
      pipeline.DEFAULT_DIRECT_OUTPUT_BUDGET_TOKENS * 3,
    );
  });

  it('posts the persona charter as the system prompt to the chat completions endpoint', async () => {
    const { impl, calls } = stubFetch(validFindings);
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0].init.headers.Authorization).toBe('Bearer k');
    expect(calls[0].body.model).toBe('m');
    const system = calls[0].body.messages.find((m: any) => m.role === 'system').content;
    expect(system).toContain(securityPersona.charter);
  });

  it('matches the prompt to the tool-free request contract', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(testingPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
    });

    const body = calls[0].body;
    const system = body.messages.find((message: any) => message.role === 'system').content;
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(system).toContain('No tools are attached to this request');
    expect(system).not.toContain('Tool Guidance');
    for (const advertisedTool of ['read_file', 'code_search', 'symbol_lookup', 'context7_search', 'fetch_docs']) {
      expect(system).not.toContain(advertisedTool);
    }
  });

  it('includes generic testing evidence checks in the runtime charter', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(testingPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
    });

    const system = calls[0].body.messages.find((message: any) => message.role === 'system').content;
    expect(system).toContain('Concrete counterfactual evidence:');
    expect(system).toContain('Sibling coverage:');
    expect(system).toContain('Semantic equivalence:');
    expect(system).toContain('equivalent formatting, reordering, or representation');
    expect(system).not.toMatch(/vacuous|format.?evadable|absence.?guard|default.?value/i);
  });

  it('keeps evaluation answers and grading vocabulary out of the runtime testing prompt', async () => {
    const matrix = JSON.parse(fs.readFileSync(
      path.join(rootRepoDir, 'eval-baselines/verified-publication-fixtures/evaluation-matrix.json'),
      'utf8',
    ));
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(testingPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', fetchImpl: impl,
    });

    const system = calls[0].body.messages.find((message: any) => message.role === 'system').content;
    for (const fixture of matrix.fixtures) {
      expect(system).not.toContain(fixture.id);
      expect(system).not.toContain(fixture.title);
      expect(system).not.toContain(fixture.summary);
      for (const expectedPath of fixture.expectedPaths) expect(system).not.toContain(expectedPath);
      for (const rubricGroup of fixture.mustMatch) {
        expect(system).not.toContain(JSON.stringify(rubricGroup));
        expect(system).not.toContain(rubricGroup.join('|'));
      }
    }
  });

  it('uses the canonical fetchImplementation boundary and fails closed on malformed provider JSON', async () => {
    const fetchImplementation = async () => new Response('{not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      model: 'synthetic-reviewer',
      fetchImplementation,
    });

    expect(res.decision).toBe('ERROR');
    expect(res.findings).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it('validates the OpenRouter policy before the first provider request', async () => {
    let fetched = false;
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      model: 'openrouter/auto',
      openRouterPolicy: {
        base_url: 'https://openrouter.ai/api/v1',
        model: 'openrouter/auto',
        allowed_models: ['openai/not-approved'],
        data_collection: 'deny',
        cost_quality_tradeoff: 7,
      },
      fetchImpl: async () => {
        fetched = true;
        throw new Error('provider must not be reached');
      },
    });

    expect(fetched).toBe(false);
    expect(res.decision).toBe('ERROR');
    expect(res.error).toContain('canonical five-model fleet');
  });

  it('sends the resolved OpenRouter auto-router policy as exact request JSON', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    const manifest = require(path.join(rootRepoDir, 'src/config/openrouter-review-policy.json'));

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      fetchImpl: impl,
      openRouterPolicy: manifest,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].body).toMatchObject({
      model: 'openrouter/auto',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      provider: { data_collection: 'deny' },
      plugins: [
        {
          id: 'auto-router',
          allowed_models: manifest.allowed_models,
          cost_quality_tradeoff: manifest.cost_quality_tradeoff,
        },
      ],
    });
    expect(calls[0].body.provider).not.toHaveProperty('allow_fallbacks');
    expect(calls[0].body.plugins[0].allowed_models).toHaveLength(5);
  });

  it('falls back once from an unsupported JSON Schema contract to json_object', async () => {
    const calls: any[] = [];
    let requestCount = 0;
    const fetchImplementation = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: { message: 'response_format json_schema is not supported by this model' } }),
          headers: new Headers(),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] }),
      };
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      fetchImplementation,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{
        name: 'openrouter-fallback',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'k',
        model: 'provider/schema-model',
        provider: 'openrouter',
        structured_output_mode: 'json_schema',
      }],
    });

    expect(result.decision).toBe('APPROVE');
    expect(calls).toHaveLength(2);
    expect(calls[0].response_format.type).toBe('json_schema');
    expect(calls[1].response_format).toEqual({ type: 'json_object' });
    expect(result.recoveryAction).toBe('structured_output_fallback');
    expect(result.outputContract).toMatchObject({
      requestObserved: 'json_object',
      terminalParsed: true,
    });
    expect(result.responseAttempts).toEqual([
      expect.objectContaining({
        outcome: 'http_error',
        responseStatus: 400,
        outputContract: expect.objectContaining({ requestObserved: 'json_schema' }),
      }),
      expect.objectContaining({
        outcome: 'parsed',
        outputContract: expect.objectContaining({ requestObserved: 'json_object' }),
      }),
    ]);
  });

  it('uses deterministic sampling for Ollama while preserving the existing gateway temperature', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      transports: [{
        name: 'ollama',
        baseUrl: 'https://ollama.com/v1',
        apiKey: 'k',
        model: 'deepseek-v4-flash:cloud',
        stream: false,
        reasoning_effort: 'high',
      }],
      fetchImpl: impl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[0].body.seed).toBeTypeOf('number');
  });

  it('keeps the Ollama seed stable for identical evidence and changes it with the reviewed source', async () => {
    const ollama = { name: 'ollama', model: 'deepseek-v4-flash:cloud' };
    const baseContext = { repo: 'o/r', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), prNumber: 'candidate-arm' };
    const seed = pipeline.deriveOllamaRequestSeed(ollama, 'https://ollama.com/v1', securityPersona, diffFiles, baseContext);
    const pairedArmSeed = pipeline.deriveOllamaRequestSeed(
      ollama,
      'https://ollama.com/v1',
      securityPersona,
      diffFiles,
      { ...baseContext, prNumber: 'baseline-arm', title: 'ignored arm label' },
    );

    expect(seed).toBe(pairedArmSeed);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0x7fffffff);
    expect(pipeline.deriveOllamaRequestSeed(
      ollama,
      'https://ollama.com/v1',
      securityPersona,
      [{ ...diffFiles[0], patch: `${diffFiles[0].patch}\n+changed();` }],
      baseContext,
    )).not.toBe(seed);
    expect(pipeline.deriveOllamaRequestSeed(
      { name: 'fireworks', model: 'm' },
      'https://api.fireworks.ai/inference/v1',
      securityPersona,
      diffFiles,
      baseContext,
    )).toBeNull();
  });

  it('never sends the Ollama seed to Fireworks or OpenRouter', async () => {
    for (const transport of [
      { name: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'k', model: 'm' },
      { name: 'openrouter-fallback', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'm', provider: { data_collection: 'deny' } },
    ]) {
      const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
      await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }, null, {
        transports: [transport],
        fetchImpl: impl,
      });
      expect(calls[0].body).not.toHaveProperty('seed');
    }
  });

  it('keeps the auto-router plugin payload when policy uses a canonical model override', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      fetchImpl: impl,
      openRouterPolicy: {
        base_url: 'https://openrouter.ai/api/v1',
        model: 'z-ai/glm-5.2',
        allowed_models: ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2'],
        data_collection: 'deny',
        cost_quality_tradeoff: 5,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      model: 'z-ai/glm-5.2',
      provider: { data_collection: 'deny' },
      plugins: [
        {
          id: 'auto-router',
          allowed_models: ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2'],
          cost_quality_tradeoff: 5,
        },
      ],
    });
  });

  it('does not send OpenRouter routing fields to a direct provider transport', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      fetchImpl: impl,
      transports: [
        {
          name: 'fireworks',
          baseUrl: 'https://api.fireworks.ai/inference/v1',
          apiKey: 'fw-key',
          model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        },
      ],
      openRouterPolicy: {
        base_url: 'https://openrouter.ai/api/v1',
        model: 'openrouter/auto',
        allowed_models: ['openai/gpt-5.6-luna', 'z-ai/glm-5.2'],
        data_collection: 'deny',
        cost_quality_tradeoff: 5,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    expect(calls[0].body).not.toHaveProperty('plugins');
    expect(calls[0].body).not.toHaveProperty('provider');
  });

  it('preserves the central streaming handoff and parses SSE findings', async () => {
    const calls: any[] = [];
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'checking the diff' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: [{ type: 'text', text: '[]}' }] } }] })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    // Exercise the real ReadableStream path and split the first JSON frame in
    // the middle of a line. A parser that treats each read as a complete SSE
    // event silently drops this frame and returns malformed findings.
    const splitAt = sse.indexOf('findings') + 4;
    const streamFetch = async (_url: string, init: any) => {
      calls.push({ init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse.slice(0, splitAt)));
            controller.enqueue(new TextEncoder().encode(sse.slice(splitAt)));
            controller.close();
          },
        }),
      };
    };

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: streamFetch,
      transports: [{
        name: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        stream: true,
        reasoning_effort: 'high',
        perf_metrics_in_response: true,
      }],
    });

    expect(res.decision).toBe('APPROVE');
    expect(res.findings).toEqual([]);
    expect(calls[0].body).toMatchObject({
      stream: true,
      max_tokens: 24576,
      reasoning_effort: 'high',
      perf_metrics_in_response: true,
    });
  });

  it('reserves a three-times direct-provider generation budget for high-reasoning JSON on a full-size diff', async () => {
    const calls: any[] = [];
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'reviewing the complete diff' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ findings: [] }) } }] })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    const streamFetch = async (_url: string, init: any) => {
      calls.push({ init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        }),
      };
    };
    const huge = [{ path: 'src/api/user.ts', patch: 'x'.repeat(410_400), addedLines: [], deletedLines: [] }];

    const res = await reviewWithModel(securityPersona, huge, { repo: 'o/r' }, null, {
      maxDiffChars: 410_400,
      fetchImplementation: streamFetch,
      transports: [{
        name: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        stream: true,
        reasoning_effort: 'high',
      }],
    });

    expect(res.decision).toBe('APPROVE');
    expect(calls[0].body.messages.find((m: any) => m.role === 'user').content.length).toBeLessThanOrEqual(412_000);
    expect(calls[0].body).toMatchObject({
      stream: true,
      max_tokens: 24576,
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
    });
  });

  it('preserves an explicit direct-provider max_tokens override', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: impl,
      transports: [{
        name: 'ollama',
        baseUrl: 'https://ollama.com/v1',
        apiKey: 'ollama-key',
        model: 'deepseek-v4-flash:cloud',
        max_tokens: 4096,
      }],
    });
    expect(calls[0].body.max_tokens).toBe(4096);
  });

  it('accepts structured content arrays but never treats reasoning-only output as findings', async () => {
    const arrayResponse = stubFetch('', {
      payload: { choices: [{ message: { content: [{ type: 'text', text: '{"findings":[]}' }] } }] },
    });
    const arrayResult = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: arrayResponse.impl,
      transports: [{ name: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'k', model: 'm' }],
    });
    expect(arrayResult.decision).toBe('APPROVE');
    expect(arrayResult.findings).toEqual([]);
    expect(arrayResult).toMatchObject({
      outputShape: 'direct_json_object',
      finishReason: 'missing',
      responseMode: 'buffered',
      findingsSource: 'content',
      contentPresent: true,
      reasoningPresent: false,
      contentSizeBucket: 'tiny',
      reasoningSizeBucket: 'empty',
      outputContract: {
        policyDeclared: 'unknown',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: true,
      },
    });

    const reasoningOnly = stubFetch('', {
      payload: { choices: [{ message: { content: [], reasoning: 'I checked the diff.' } }] },
    });
    const reasoningResult = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: reasoningOnly.impl,
      transports: [{ name: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'k', model: 'm' }],
    });
    expect(reasoningResult.decision).toBe('ERROR');
    expect(reasoningResult.findings).toEqual([]);
    expect(reasoningResult).toMatchObject({
      outputShape: 'no_json',
      findingsSource: 'none',
      contentPresent: false,
      reasoningPresent: true,
      outputContract: {
        policyDeclared: 'unknown',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: false,
      },
    });
  });

  it('parses a complete findings object carried in a streamed reasoning delta', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '{"findings":[]}' } }] })}`,
      'data: [DONE]',
      '',
    ].join('\n');
    const streamFetch = async (_url: string, init: any) => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
      body: new ReadableStream({
        start(controller) {
          // Split the SSE frame to exercise the same carry-buffer path used by
          // provider streams; the reasoning JSON must survive chunk boundaries.
          const splitAt = sse.indexOf('findings') + 5;
          controller.enqueue(new TextEncoder().encode(sse.slice(0, splitAt)));
          controller.enqueue(new TextEncoder().encode(sse.slice(splitAt)));
          controller.close();
        },
      }),
    });

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: streamFetch,
      transports: [{
        name: 'ollama',
        baseUrl: 'https://ollama.com/v1',
        apiKey: 'k',
        model: 'deepseek-v4-flash:cloud',
        stream: true,
      }],
    });

    expect(result.decision).toBe('APPROVE');
    expect(result).toMatchObject({
      outputShape: 'direct_json_object',
      responseMode: 'stream',
      findingsSource: 'reasoning',
      contentPresent: false,
      reasoningPresent: true,
      outputContract: {
        policyDeclared: 'unknown',
        requestObserved: 'json_object',
        providerSupported: 'unreported',
        terminalParsed: true,
      },
    });
    expect(result.findings).toEqual([]);
  });

  it('uses the official OpenRouter SDK for a native SSE response and preserves gateway telemetry', async () => {
    const frames = [
      JSON.stringify({
        id: 'chatcmpl-sdk-pipeline',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model: 'openai/gpt-5.6-luna',
        choices: [{ index: 0, finish_reason: null, delta: { content: '{"findings":[]}' } }],
      }),
      '[DONE]',
    ].map((frame) => `data: ${frame}\n\n`).join('');
    let observed: { headers: Headers; body: any } | null = null;
    const fetchImplementation = async (_url: string, init: any) => {
      observed = { headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return new Response(frames, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-generation-id': 'gen-sdk-pipeline',
        },
      });
    };

    const result = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation,
      transports: [{
        name: 'openrouter-fallback',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'or-key',
        model: 'openrouter/auto',
        provider: 'openrouter',
        reasoning_effort: 'high',
        stream: true,
      }],
    });

    expect(result).toMatchObject({ decision: 'APPROVE', findings: [], responseMode: 'stream' });
    expect(result.generationIdDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(observed?.headers.get('x-openrouter-metadata')).toBe('enabled');
    expect(observed?.headers.get('user-agent')).toContain('@openrouter/sdk');
    expect(observed?.body).toMatchObject({
      model: 'openrouter/auto',
      stream: true,
      reasoning: { effort: 'high' },
    });
  });

  it('treats the streaming timeout as inactivity instead of total generation time', async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '[]}' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const streamFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
      body: new ReadableStream({
        async start(controller) {
          for (const frame of frames) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            controller.enqueue(new TextEncoder().encode(frame));
          }
          controller.close();
        },
      }),
    });

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: streamFetch,
      timeoutMs: 100,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{
        name: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        stream: true,
      }],
    });

    expect(res.decision).toBe('APPROVE');
    expect(res.findings).toEqual([]);
  });

  it('caps an active streaming generation by total wall clock even when deltas keep arriving', async () => {
    const activeStreamFetch = async () => {
      let cancelled = false;
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
        body: new ReadableStream({
          async start(controller) {
            try {
              while (!cancelled) {
                controller.enqueue(new TextEncoder().encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'still thinking ' } }] })}\n\n`,
                ));
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
            } catch {
              try { controller.close(); } catch { /* cancelled by watchdog */ }
            }
          },
          cancel() {
            cancelled = true;
          },
        }),
      };
    };

    const started = Date.now();
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: activeStreamFetch,
      timeoutMs: 25,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{
        name: 'openrouter-fallback',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'or-key',
        model: 'deepseek/deepseek-v4-flash-0731',
        provider: 'openrouter',
        reasoning_effort: 'high',
        stream: true,
      }],
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(res.decision).toBe('ERROR');
    expect(res.error).toContain('total deadline');
    expect(res.responseAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'transport_error', failureClass: 'timeout', timeoutKind: 'total' }),
    ]));
  });

  it('retries an OpenRouter stream timeout once with reasoning disabled before failing closed', async () => {
    const calls: any[] = [];
    const stalledResponse = () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
      body: new ReadableStream({ start() {} }),
    });
    const recoveredResponse = () => {
      const wire = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(wire));
            controller.close();
          },
        }),
      };
    };
    const fetchImplementation = async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return calls.length === 1 ? stalledResponse() : recoveredResponse();
    };

    const started = Date.now();
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation,
      timeoutMs: 25,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{
        name: 'openrouter-fallback',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'or-key',
        model: 'deepseek/deepseek-v4-flash-0731',
        provider: 'openrouter',
        reasoning_effort: 'high',
        stream: true,
      }],
    });

    expect(Date.now() - started).toBeLessThan(500);
    expect(res).toMatchObject({ decision: 'APPROVE', findings: [], attemptCount: 2, recoveryAction: 'bounded_retry' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveProperty('reasoning', { effort: 'high' });
    expect(calls[1]).toHaveProperty('reasoning', { effort: 'high' });
    expect(calls[1]).not.toHaveProperty('plugins');
    expect(calls[1].messages[0].content).toContain('Re-evaluate the complete diff');
    expect(calls[1].messages[0].content).not.toContain('return only {"findings":[]}');
    expect(res.responseAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempt: 1, outcome: 'transport_error', failureClass: 'timeout', timeoutKind: 'total' }),
      expect.objectContaining({ attempt: 2, outcome: 'parsed', failureClass: null }),
    ]));
  });

  it('fails closed when a streaming response becomes idle', async () => {
    const stalledFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
      body: new ReadableStream({ start() {} }),
    });

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: stalledFetch,
      timeoutMs: 25,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{
        name: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        stream: true,
      }],
    });

    expect(res.decision).toBe('ERROR');
    expect(res.error).toMatch(/Streaming response stalled|total deadline/);
    expect(res.responseAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'transport_error', failureClass: 'timeout', timeoutKind: 'total' }),
    ]));
  });

  it('caps format-recovery streams by wall clock so reasoning tokens cannot hang the lane', async () => {
    let calls = 0;
    const sse = (chunks, { hang = false } = {}) => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
      body: new ReadableStream({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: chunk }] })}\n\n`,
            ));
          }
          if (!hang) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          try {
            while (true) {
              await new Promise((resolve) => setTimeout(resolve, 15));
              controller.enqueue(new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'still thinking ' } }] })}\n\n`,
              ));
            }
          } catch {
            try { controller.close(); } catch { /* already cancelled */ }
          }
        },
      }),
    });

    const streamFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return sse([{ reasoning: 'prose that is not findings JSON' }]);
      }
      return sse([], { hang: true });
    };

    const started = Date.now();
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: streamFetch,
      timeoutMs: 80,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{
        name: 'fireworks',
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        apiKey: 'fw-key',
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        stream: true,
      }],
    });

    expect(Date.now() - started).toBeLessThan(1500);
    expect(calls).toBe(2);
    expect(res.decision).toBe('ERROR');
    expect(res.error).toMatch(/total deadline|stalled/i);
    expect(res.responseAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'transport_error', failureClass: 'timeout', timeoutKind: 'total' }),
    ]));
  });

  it('marks a provider lane failure as ERROR so it cannot become a successful verdict', async () => {
    const { impl } = stubFetch('{"error":{"message":"provider lane failed"}}');
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      baseUrl: 'https://llm.test/v1',
      fetchImpl: impl,
    });

    expect(res.decision).toBe('ERROR');
    expect(res.findings).toEqual([]);
    expect(res.error).toContain('Provider returned an error payload');
  });

  it('uses the policy-approved model fallback when OpenRouter returns an upstream rate-limit payload', async () => {
    const calls: any[] = [];
    const manifest = require(path.join(rootRepoDir, 'src/config/openrouter-review-policy.json'));
    const fetchImplementation = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body, headers: init.headers });
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'x-generation-id': 'gen-rate-limited' }),
          json: async () => ({
            error: {
              code: 'rate_limit_exceeded',
              message: 'openai/gpt-5.6-luna is temporarily rate-limited upstream',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-generation-id': 'gen-recovered' }),
        json: async () => ({
          model: 'z-ai/glm-5.2',
          openrouter_metadata: { attempt: 2 },
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
        }),
      };
    };

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      model: 'openrouter/auto',
      openRouterPolicy: manifest,
      fetchImplementation,
      sleepImplementation: async () => {},
    });

    expect(res).toMatchObject({
      decision: 'APPROVE',
      findings: [],
      attemptCount: 2,
      retryReasons: ['provider_rate_limit'],
      failureClass: null,
      errorCode: 'rate_limit_exceeded',
      recoveryAction: 'model_fallback',
      routerAttempt: 2,
    });
    expect(res.generationIdDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(res.responseAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'provider_error',
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        generationIdDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: 'parsed',
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        generationIdDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(res.responseAttempts[0].requestFingerprint).not.toBe(res.responseAttempts[1].requestFingerprint);
    expect(res.responseAttempts[0].generationIdDigest).not.toBe(res.responseAttempts[1].generationIdDigest);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers['X-OpenRouter-Metadata']).toBe('enabled');
    expect(calls[1].body).toMatchObject({
      model: 'openai/gpt-5.6-luna',
      models: ['moonshotai/kimi-k2.6', 'tencent/hy3', 'z-ai/glm-5.2'],
      provider: { data_collection: 'deny', require_parameters: true },
      response_format: { type: 'json_object' },
    });
    expect(calls[1].body).not.toHaveProperty('plugins');
    expect(calls[1].body).not.toHaveProperty('reasoning');
  });

  it.each([
    {
      name: 'keeps canonical order when the failed model is in the middle',
      failedModel: 'tencent/hy3',
      model: 'openrouter/auto',
      allowedModels: [
        'openai/gpt-5.6-luna',
        'moonshotai/kimi-k2.6',
        'tencent/hy3',
        'z-ai/glm-5.2',
        'google/gemini-3.5-flash-lite',
      ],
      expectedModels: [
        'openai/gpt-5.6-luna',
        'moonshotai/kimi-k2.6',
        'z-ai/glm-5.2',
      ],
    },
    {
      name: 'retains every remaining model when the policy is below the limit',
      failedModel: 'z-ai/glm-5.2',
      model: 'z-ai/glm-5.2',
      allowedModels: ['moonshotai/kimi-k2.6', 'z-ai/glm-5.2'],
      expectedModels: ['moonshotai/kimi-k2.6'],
    },
  ])('$name', async ({ failedModel, model, allowedModels, expectedModels }) => {
    const calls: any[] = [];
    const fetchImplementation = async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            error: {
              code: 'rate_limit_exceeded',
              message: `${failedModel} is temporarily rate-limited upstream`,
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

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      model,
      openRouterPolicy: {
        base_url: 'https://openrouter.ai/api/v1',
        model,
        allowed_models: allowedModels,
        data_collection: 'deny',
        cost_quality_tradeoff: 7,
      },
      fetchImplementation,
      sleepImplementation: async () => {},
    });

    expect(res.decision).toBe('APPROVE');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      model: failedModel,
      models: expectedModels,
      provider: { data_collection: 'deny', require_parameters: true },
      response_format: { type: 'json_object' },
    });
    expect(calls[1].models).toHaveLength(expectedModels.length);
    expect(calls[1]).not.toHaveProperty('plugins');
    expect(calls[1]).not.toHaveProperty('reasoning');
  });

  it('does not retry a non-capacity provider error payload', async () => {
    const manifest = require(path.join(rootRepoDir, 'src/config/openrouter-review-policy.json'));
    let calls = 0;
    const fetchImplementation = async () => {
      calls += 1;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ error: { code: 'invalid_request', message: 'openai/gpt-5.6-luna rejected this unsupported request shape' } }),
        };
    };

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      model: 'openrouter/auto',
      openRouterPolicy: manifest,
      fetchImplementation,
    });

    expect(calls).toBe(1);
    expect(res.decision).toBe('ERROR');
    expect(res.failureClass).toBe('provider_error');
    expect(res.errorCode).toBe('invalid_request');
    expect(res.recoveryAction).toBeNull();
  });

  it('honors a bounded Retry-After on a transient OpenRouter HTTP 429', async () => {
    const calls: any[] = [];
    const sleeps: number[] = [];
    const fetchImplementation = async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '30' }),
          text: async () => 'rate limited',
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] }),
      };
    };

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      model: 'openrouter/auto',
      fetchImplementation,
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
    });

    expect(res.decision).toBe('APPROVE');
    expect(res.attemptCount).toBe(2);
    expect(res.retryReasons).toEqual(['http_429']);
    expect(res.recoveryAction).toBe('bounded_retry');
    expect(sleeps).toEqual([5_000]);
  });

  it('returns structured findings parsed from the model response', async () => {
    const { impl } = stubFetch(validFindings);
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].severity).toBe('P1');
    expect(res.findings[0].path).toBe('src/api/user.ts');
    expect(res.decision).toBe('FINDINGS');
    expect(res.attemptCount).toBe(1);
    expect(Number.isInteger(res.latencyMs)).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.retryReasons).toEqual([]);
    expect(res.failureClass).toBeNull();
  });

  it('records bounded retry telemetry without changing the successful lane outcome', async () => {
    let calls = 0;
    const fetchImplementation = async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] }),
      };
    };

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{ name: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'k', model: 'm' }],
    });

    expect(calls).toBe(2);
    expect(res.decision).toBe('APPROVE');
    expect(res.attemptCount).toBe(2);
    expect(res.retryReasons).toEqual(['transient_socket']);
    expect(res.failureClass).toBeNull();
  });

  it('records a sanitized failover reason while leaving a recovered lane successful', async () => {
    let calls = 0;
    const fetchImplementation = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          text: async () => 'provider secret and request details',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] }),
      };
    };

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [
        { name: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'k1', model: 'm1' },
        { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k2', model: 'm2' },
      ],
    });

    expect(res.decision).toBe('APPROVE');
    expect(res.attemptCount).toBe(2);
    expect(res.retryReasons).toEqual(['http_429']);
    expect(res.failureClass).toBeNull();
    expect(JSON.stringify(res.retryReasons)).not.toContain('provider secret');
  });

  it('classifies a final malformed response without persisting provider text', async () => {
    const { impl } = stubFetch('not findings JSON');
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation: impl,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{ name: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'k', model: 'm' }],
    });

    expect(res.decision).toBe('ERROR');
    expect(res.attemptCount).toBe(2);
    expect(res.retryReasons).toEqual(['malformed_output']);
    expect(res.failureClass).toBe('malformed_output');
    expect(res.error).toBe('Model response contained no parseable findings JSON.');
  });

  it('retains bounded first-attempt evidence across direct format recovery', async () => {
    const requestBodies: any[] = [];
    let calls = 0;
    const fetchImplementation = async (_url: string, init: any) => {
      requestBodies.push(JSON.parse(init.body));
      calls += 1;
      const payload = calls === 1
        ? {
            provider: 'unclassified-upstream-provider',
            usage: { completion_tokens: 24_576 },
            choices: [{
              finish_reason: 'length',
              message: { content: '', reasoning_content: 'analysis without findings JSON' },
            }],
          }
        : {
            usage: { completion_tokens: 12 },
            choices: [{
              finish_reason: 'stop',
              message: { content: JSON.stringify({ findings: [] }), reasoning_content: '' },
            }],
          };
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => payload,
      };
    };

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      fetchImplementation,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      transports: [{
        name: 'ollama',
        baseUrl: 'https://ollama.com/v1',
        apiKey: 'k',
        model: 'deepseek-v4-flash:cloud',
        reasoning_effort: 'high',
      }],
    });

    expect(res.decision).toBe('APPROVE');
    expect(requestBodies.map((body) => body.reasoning_effort)).toEqual(['high', 'none']);
    expect(res.responseAttempts).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'malformed_output',
        transport: 'ollama',
        provider: 'ollama',
        responseStatus: 200,
        failureClass: 'malformed_output',
        reasoningEffort: 'high',
        maxOutputTokens: 24_576,
        outputTokens: 24_576,
        outputShape: 'no_json',
        finishReason: 'length',
        findingsSource: 'none',
        contentPresent: false,
        reasoningPresent: true,
      }),
      expect.objectContaining({
        attempt: 2,
        outcome: 'parsed',
        transport: 'ollama',
        provider: 'ollama',
        responseStatus: 200,
        failureClass: null,
        reasoningEffort: 'none',
        maxOutputTokens: 24_576,
        outputTokens: 12,
        outputShape: 'direct_json_object',
        finishReason: 'stop',
        findingsSource: 'content',
        contentPresent: true,
        reasoningPresent: false,
      }),
    ]);
    expect(JSON.stringify(res.responseAttempts)).not.toContain('analysis without findings JSON');
  });

  it('returns response model, provider, and reported usage cost metadata', async () => {
    const { impl } = stubFetch(JSON.stringify({ findings: [] }), {
      payload: {
        model: 'openai/gpt-5.6-luna',
        provider: 'OpenAI',
        usage: { cost: 0.0074, prompt_tokens: 100, completion_tokens: 20 },
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      },
    });

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      model: 'openrouter/auto',
      fetchImpl: impl,
    });

    expect(res.model).toBe('openai/gpt-5.6-luna');
    expect(res.provider).toBe('OpenAI');
    expect(res.cost).toBe(0.0074);
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(20);
  });

  it('characterizes alternate provider-reported token and cost fields before receipt promotion', async () => {
    const { impl } = stubFetch(JSON.stringify({ findings: [] }), {
      payload: {
        usage: {
          total_cost: '0.0081',
          input_tokens: '101',
          outputTokens: '22',
        },
        choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
      },
    });

    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      model: 'openrouter/auto',
      fetchImpl: impl,
    });

    // The lane result captures these provider fields today. Rank 3D will
    // decide separately how, and when, to persist them in the run report.
    expect(res.cost).toBe(0.0081);
    expect(res.inputTokens).toBe(101);
    expect(res.outputTokens).toBe(22);
  });

  it('parses findings wrapped in a markdown code fence', async () => {
    const { impl } = stubFetch('Sure!\n```json\n' + validFindings + '\n```\n');
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toHaveLength(1);
  });

  it('discards findings for files absent from the diff', async () => {
    const hallucinated = JSON.stringify({
      findings: [
        { severity: 'P0', path: 'src/does-not-exist.ts', line: 1, title: 'Ghost', body: 'b' },
        { severity: 'P1', path: 'src/api/user.ts', line: 1, title: 'Real', body: 'b' },
      ],
    });
    const { impl } = stubFetch(hallucinated);
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].title).toBe('Real');
  });

  it('fails closed on unknown severities instead of normalizing them to P2', async () => {
    const { impl } = stubFetch(JSON.stringify({
      findings: [{ severity: 'CRITICAL', path: 'src/api/user.ts', line: 1, title: 't', body: 'b' }],
    }));
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toEqual([]);
    expect(res.error).toContain('canonical findings contract');
  });

  it('returns no findings rather than throwing on unparseable output', async () => {
    const { impl } = stubFetch('I could not analyze this diff, sorry.');
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toEqual([]);
    expect(res.error).toBeTruthy();
  });

  it('surfaces an error instead of throwing when the endpoint rejects the request', async () => {
    const { impl } = stubFetch('', { ok: false, status: 429 });
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', baseUrl: 'https://llm.test/v1', fetchImpl: impl,
    });
    expect(res.findings).toEqual([]);
    expect(res.error).toContain('429');
    expect(res.attemptCount).toBe(1);
    expect(res.retryReasons).toEqual(['http_429']);
    expect(res.failureClass).toBe('http_429');
  });

  it('truncates oversized diffs to the configured character budget', async () => {
    const huge = [{
      path: 'src/api/user.ts',
      patch: 'x'.repeat(50_000),
      addedLines: [],
      deletedLines: [],
    }];
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(securityPersona, huge, { repo: 'o/r' }, null, {
      apiKey: 'k', maxDiffChars: 1_000, fetchImpl: impl,
    });
    const user = calls[0].body.messages.find((m: any) => m.role === 'user').content;
    expect(user.length).toBeLessThan(3_000);
    expect(user).toContain('truncated');
  });

  it('keeps the policy-sized 410,400-character prompt within a bounded completion budget', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    const huge = [{
      path: 'src/api/user.ts',
      patch: 'x'.repeat(410_400),
      addedLines: [],
      deletedLines: [],
    }];

    await reviewWithModel(securityPersona, huge, { repo: 'o/r' }, null, {
      maxDiffChars: 410_400,
      fetchImplementation: impl,
    });

    const user = calls[0].body.messages.find((m: any) => m.role === 'user').content;
    expect(user.length).toBeLessThanOrEqual(412_000);
    expect(calls[0].body.max_tokens).toBe(24576);
  });

  it('includes prior-turn session context in the prompt when present', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, {
      augmentedHeader: 'PREVIOUS TURN: the author rejected the orgId nit.',
    }, { apiKey: 'k', fetchImpl: impl });
    const system = calls[0].body.messages.find((m: any) => m.role === 'system').content;
    expect(system).toContain('PREVIOUS TURN');
  });
});
