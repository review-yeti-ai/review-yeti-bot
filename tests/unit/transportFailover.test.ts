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

  it('applies OpenRouter-only request fields only to the OpenRouter fallback', async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const mockFetch = async (url: string, init: any) => {
      requests.push({ url, body: JSON.parse(init.body) });

      if (url.includes('fireworks.ai')) {
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: 'temporarily unavailable' }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'openrouter/auto',
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      };
    };

    const result = await reviewWithModel(
      { id: 'testing', name: 'Testing', charter: 'Check test coverage' },
      [{ path: 'test/example.test.ts', patch: '+ expect(true).toBe(true)' }],
      { repo: 'calltelemetry/ct-review-actions', prNumber: 106 },
      null,
      {
        fetchImplementation: mockFetch,
        openRouterPolicy: {
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
        },
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
      },
    );

    expect(result.decision).toBe('APPROVE');
    expect(requests).toHaveLength(2);
    expect(requests[0].body).not.toHaveProperty('plugins');
    expect(requests[0].body).not.toHaveProperty('provider');
    expect(requests[1].body).toMatchObject({
      plugins: [{ id: 'auto-router' }],
      provider: { data_collection: 'deny' },
    });
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
