import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';

// Load review-pipeline
const pipelinePath = path.resolve(__dirname, '../../.github/workflows/pipelines/review-pipeline.js');
const { reviewWithModel, resolveModelConfig, globalRunCircuitBreaker } = require(pipelinePath);

describe('Multi-Transport Fast Failover', () => {
  beforeEach(() => {
    if (globalRunCircuitBreaker?.reset) globalRunCircuitBreaker.reset();
  });
  it('automatically falls over to secondary transport when primary transport returns 429 / queue cancelled', async () => {
    let attempt = 0;
    const mockFetch = async (url: string, init: any) => {
      attempt++;
      if (url.includes('api.fireworks.ai')) {
        // Fireworks returns 429 rate/concurrency limit
        return {
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ error: { message: 'Queue full: cancelled' } }),
        };
      }
      // OpenRouter fallback succeeds
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'openrouter/auto',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      };
    };

    const persona = { id: 'security', name: 'Security & Tenancy Guardian', charter: 'Check tenant scope' };
    const diffFiles = [{ path: 'lib/orders.ex', patch: '+ def list_orders do' }];
    const prContext = { repo: 'acme/test', prNumber: 1 };

    const result = await reviewWithModel(persona, diffFiles, prContext, null, {
      fetchImplementation: mockFetch,
      transports: [
        {
          name: 'fireworks',
          baseUrl: 'https://api.fireworks.ai/inference/v1',
          apiKey: 'fw-key',
          model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        },
        {
          name: 'openrouter-fallback',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'or-key',
          model: 'openrouter/auto',
        },
      ],
    });

    expect(result.decision).toBe('APPROVE');
    expect(result.findings).toEqual([]);
    expect(result.transport).toBe('openrouter-fallback');
    expect(attempt).toBe(2);
  });

  it('fails over across 3 configured transports (fireworks -> ollama -> openrouter) seamlessly', async () => {
    const visitedUrls: string[] = [];
    const mockFetch = async (url: string, init: any) => {
      visitedUrls.push(url);
      if (url.includes('api.fireworks.ai')) {
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: 'Server overloaded: cancelled' }),
        };
      }
      if (url.includes('ollama.ai')) {
        return {
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ error: 'Rate limit exceeded' }),
        };
      }
      // OpenRouter succeeds
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'deepseek/deepseek-v4-flash-0731',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  findings: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
        }),
      };
    };

    const persona = { id: 'architecture', name: 'System Architecture & Design', charter: 'Check layering' };
    const diffFiles = [{ path: 'lib/supervisor.ex', patch: '+ def start_link do' }];
    const prContext = { repo: 'calltelemetry/cisco-cdr', prNumber: 4452 };

    const result = await reviewWithModel(persona, diffFiles, prContext, null, {
      fetchImplementation: mockFetch,
      transports: [
        { name: 'fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: 'fw-key' },
        { name: 'ollama', baseUrl: 'https://ollama.ai/v1', apiKey: 'ollama-key' },
        { name: 'openrouter-fallback', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-key' },
      ],
    });

    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('openrouter-fallback');
    expect(visitedUrls.length).toBe(3);
    expect(visitedUrls[0]).toContain('api.fireworks.ai');
    expect(visitedUrls[1]).toContain('ollama.ai');
    expect(visitedUrls[2]).toContain('openrouter.ai');
  });

  it('applies OpenRouter policy fields only to the OpenRouter transport', async () => {
    const requestBodies: Array<{ url: string; body: any }> = [];
    const mockFetch = async (url: string, init: any) => {
      requestBodies.push({ url, body: JSON.parse(init.body) });
      if (url.includes('api.fireworks.ai')) {
        return {
          ok: false,
          status: 429,
          text: async () => 'queue full',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
        }),
      };
    };

    const policy = require(path.resolve(__dirname, '../../src/config/openrouter-review-policy.json'));
    const result = await reviewWithModel(
      { id: 'security', name: 'Security & Tenancy Guardian', charter: 'Check tenant scope' },
      [{ path: 'lib/orders.ex', patch: '+ def list_orders do' }],
      { repo: 'acme/test', prNumber: 1 },
      null,
      {
        fetchImplementation: mockFetch,
        openRouterPolicy: policy,
        transports: [
          {
            name: 'fireworks',
            baseUrl: 'https://api.fireworks.ai/inference/v1',
            apiKey: 'fw-key',
            model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
          },
          {
            name: 'openrouter-fallback',
            compat: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'or-key',
            model: 'openrouter/auto',
          },
        ],
      },
    );

    expect(result.decision).toBe('APPROVE');
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0].body).not.toHaveProperty('plugins');
    expect(requestBodies[0].body).not.toHaveProperty('provider');
    expect(requestBodies[1].body.plugins).toEqual([
      {
        id: 'auto-router',
        allowed_models: policy.allowed_models,
        cost_quality_tradeoff: policy.cost_quality_tradeoff,
      },
    ]);
    expect(requestBodies[1].body.provider).toEqual({ data_collection: policy.data_collection });
  });

  it('lowers reasoning effort and retries when a provider returns unusable output', async () => {
    const requestBodies: any[] = [];
    const mockFetch = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      requestBodies.push({ url, body });
      if (url.includes('api.fireworks.ai')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'not valid findings json' } }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] }),
      };
    };

    const result = await reviewWithModel(
      { id: 'security', name: 'Security & Tenancy Guardian', charter: 'Check tenant scope', reasoning_effort: 'high' },
      [{ path: 'lib/orders.ex', patch: '+ def list_orders do' }],
      { repo: 'acme/test', prNumber: 1 },
      null,
      {
        fetchImplementation: mockFetch,
        transports: [
          {
            name: 'fireworks',
            baseUrl: 'https://api.fireworks.ai/inference/v1',
            apiKey: 'fw-key',
            model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
          },
          {
            name: 'ollama',
            baseUrl: 'https://ollama.ai/v1',
            apiKey: 'ollama-key',
            model: 'deepseek-v4-flash:cloud',
            reasoning_effort: 'high',
          },
        ],
      },
    );

    expect(result.decision).toBe('APPROVE');
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0].body.max_tokens).toBe(8192);
    expect(requestBodies[1].body.max_tokens).toBe(8192);
    expect(requestBodies[0].body.reasoning_effort).toBe('high');
    expect(requestBodies[1].body.reasoning_effort).toBe('medium');
  });

  it('retries unparseable output once on the final transport with a bounded format-recovery request', async () => {
    const requestBodies: any[] = [];
    const mockFetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      requestBodies.push(body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: requestBodies.length === 1
                ? ''
                : JSON.stringify({ findings: [] }),
            },
          }],
        }),
      };
    };

    const result = await reviewWithModel(
      { id: 'security', name: 'Security & Tenancy Guardian', charter: 'Check tenant scope', reasoning_effort: 'high' },
      [{ path: 'lib/orders.ex', patch: '+ def list_orders do' }],
      { repo: 'acme/test', prNumber: 1 },
      null,
      {
        fetchImplementation: mockFetch,
        openRouterPolicy: {
          base_url: 'https://openrouter.ai/api/v1',
          model: 'openrouter/auto',
          allowed_models: [
            'moonshotai/kimi-k2.6',
            'google/gemini-3.5-flash-lite',
          ],
          data_collection: 'deny',
          cost_quality_tradeoff: 8,
        },
        transports: [{
          name: 'openrouter-fallback',
          compat: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'or-key',
          model: 'deepseek/deepseek-v4-flash-0731',
          reasoning_effort: 'high',
        }],
      },
    );

    expect(result.decision).toBe('APPROVE');
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0].model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(requestBodies[0].max_tokens).toBe(1024);
    expect(requestBodies[0].reasoning).toEqual({ effort: 'high' });
    expect(requestBodies[1].model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(requestBodies[1].max_tokens).toBe(4096);
    expect(requestBodies[1].reasoning).toEqual({ enabled: false });
    expect(requestBodies[1].provider).toEqual({ data_collection: 'deny' });
    expect(requestBodies[1].plugins).toBeUndefined();
    expect(requestBodies[1].messages[0].content).toContain('FORMAT RECOVERY');
  });

  it('keeps the bounded default for unknown direct-compatible transports', async () => {
    const requestBodies: any[] = [];
    const mockFetch = async (_url: string, init: any) => {
      requestBodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] }),
      };
    };

    await reviewWithModel(
      { id: 'security', name: 'Security & Tenancy Guardian', charter: 'Check tenant scope', reasoning_effort: 'high' },
      [{ path: 'lib/orders.ex', patch: '+ def list_orders do' }],
      { repo: 'acme/test', prNumber: 1 },
      null,
      {
        fetchImplementation: mockFetch,
        transports: [{
          name: 'custom-compatible',
          baseUrl: 'https://llm.example/v1',
          apiKey: 'custom-key',
          model: 'deepseek-v4-flash:cloud',
          reasoning_effort: 'high',
        }],
      },
    );

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0].max_tokens).toBe(1024);
  });

  it('correctly resolves and authenticates all configured candidate transports in resolveModelConfig', () => {
    const env = {
      FIREWORKS_PR_REVIEW_API_KEY: 'secret-fw',
      OLLAMA_PR_REVIEW_API_KEY: 'secret-ollama',
      OPENROUTER_PR_REVIEW_API_KEY: 'secret-openrouter',
      REVIEW_YETI_TRANSPORTS: JSON.stringify([
        { name: 'fireworks', base_url: 'https://api.fireworks.ai/inference/v1', api_key_env: 'FIREWORKS_PR_REVIEW_API_KEY' },
        { name: 'ollama', base_url: 'https://ollama.ai/v1', api_key_env: 'OLLAMA_PR_REVIEW_API_KEY' },
        { name: 'openrouter-fallback', base_url: 'https://openrouter.ai/api/v1', api_key_env: 'OPENROUTER_PR_REVIEW_API_KEY' },
      ]),
    };

    const config = resolveModelConfig(env);
    expect(config.enabled).toBe(true);
    expect(config.transports.length).toBe(3);
    expect(config.transports[0].name).toBe('fireworks');
    expect(config.transports[0].apiKey).toBe('secret-fw');
    expect(config.transports[1].name).toBe('ollama');
    expect(config.transports[1].apiKey).toBe('secret-ollama');
    expect(config.transports[2].name).toBe('openrouter-fallback');
    expect(config.transports[2].apiKey).toBe('secret-openrouter');
  });
});
