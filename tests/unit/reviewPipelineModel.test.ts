import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { reviewWithModel, resolveModelConfig, PERSONA_CHARTERS } = pipeline;
const securityPersona = PERSONA_CHARTERS.find((p: any) => p.id === 'security');

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
});

describe('reviewWithModel', () => {
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

  it('keeps the auto-router plugin payload when policy uses a canonical model override', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));

    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r', prNumber: '1' }, null, {
      apiKey: 'k',
      fetchImpl: impl,
      openRouterPolicy: {
        base_url: 'https://openrouter.ai/api/v1',
        model: 'z-ai/glm-5.1',
        allowed_models: ['moonshotai/kimi-k2.6', 'z-ai/glm-5.1'],
        data_collection: 'deny',
        cost_quality_tradeoff: 5,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      model: 'z-ai/glm-5.1',
      provider: { data_collection: 'deny' },
      plugins: [
        {
          id: 'auto-router',
          allowed_models: ['moonshotai/kimi-k2.6', 'z-ai/glm-5.1'],
          cost_quality_tradeoff: 5,
        },
      ],
    });
  });

  it('marks a provider lane failure as ERROR so it cannot become a successful verdict', async () => {
    const { impl } = stubFetch('{"error":{"message":"provider lane failed"}}');
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k',
      fetchImpl: impl,
    });

    expect(res.decision).toBe('ERROR');
    expect(res.findings).toEqual([]);
    expect(res.error).toContain('Provider returned an error payload');
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

  it('normalizes unknown severities to P2', async () => {
    const { impl } = stubFetch(JSON.stringify({
      findings: [{ severity: 'CRITICAL', path: 'src/api/user.ts', line: 1, title: 't', body: 'b' }],
    }));
    const res = await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, null, {
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings[0].severity).toBe('P2');
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
      apiKey: 'k', fetchImpl: impl,
    });
    expect(res.findings).toEqual([]);
    expect(res.error).toContain('429');
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

  it('includes prior-turn session context in the prompt when present', async () => {
    const { impl, calls } = stubFetch(JSON.stringify({ findings: [] }));
    await reviewWithModel(securityPersona, diffFiles, { repo: 'o/r' }, {
      augmentedHeader: 'PREVIOUS TURN: the author rejected the orgId nit.',
    }, { apiKey: 'k', fetchImpl: impl });
    const system = calls[0].body.messages.find((m: any) => m.role === 'system').content;
    expect(system).toContain('PREVIOUS TURN');
  });
});
