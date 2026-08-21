import { describe, it, expect } from 'vitest';
import path from 'path';

// Load review-pipeline reviewWithModel
const pipelinePath = path.resolve(__dirname, '../../.github/workflows/pipelines/review-pipeline.js');
const { reviewWithModel } = require(pipelinePath);

describe('Multi-Transport Fast Failover', () => {
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

    expect(attempt).toBe(2);
    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('openrouter-fallback');
  });
});
