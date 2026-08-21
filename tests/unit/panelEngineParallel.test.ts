import { describe, it, expect, vi } from 'vitest';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { ReviewModelClient, OpenRouterResponse } from '../../src/gateway/openRouterClient';

describe('Panel Engine Parallel Execution', () => {
  const mockConfig: CtReviewConfigV3 = {
    version: '3.0',
    enabled: true,
    target_branch: 'main',
    quorum: 1,
    reviewer_effort: 'medium',
    reviewers: {
      overall_timeout_s: 60,
      fallback: 'continue',
      arbiter: {
        order: ['test-prov'],
      },
      providers: [
        {
          id: 'test-prov',
          type: 'openrouter',
          model: 'google/gemini-3.7-flash:medium',
          enabled: true,
          review_timeout_s: 30,
          arbiter_timeout_s: 30,
        },
      ],
    },
    personas: [
      {
        id: 'security',
        name: 'Security Guardian',
        enabled: true,
        paths: ['**/*'],
        providers: ['test-prov'],
        charter: 'Security checks',
      },
      {
        id: 'performance',
        name: 'Performance Specialist',
        enabled: true,
        paths: ['**/*'],
        providers: ['test-prov'],
        charter: 'Performance checks',
      },
      {
        id: 'architecture',
        name: 'Architecture Specialist',
        enabled: true,
        paths: ['**/*'],
        providers: ['test-prov'],
        charter: 'Architecture checks',
      },
    ],
  };

  it('executes multiple personas in parallel concurrently rather than sequentially', async () => {
    let activeConcurrentCalls = 0;
    let maxObservedConcurrency = 0;

    const mockClient: ReviewModelClient = {
      complete: vi.fn(async (request): Promise<OpenRouterResponse> => {
        activeConcurrentCalls++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, activeConcurrentCalls);

        // Simulate 50ms async network delay
        await new Promise((r) => setTimeout(r, 50));

        activeConcurrentCalls--;
        const match = request.messages[0].content.match(/CT_REVIEW_BEGIN:([^\s\n]+)/);
        const nonce = match ? match[1] : 'nonce123';
        const isArbiter = request.messages[0].content.includes('Role: ARBITER') || request.messages[1]?.content?.includes('Role: ARBITER');
        const jsonBody = isArbiter
          ? '{"verdict":"SHIP","rationale":"clean"}'
          : '{"decision":"APPROVE","findings":[],"rationale":"clean"}';

        return {
          model: request.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${jsonBody}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 50, total: 150 },
          costUSD: 0.0001,
        };
      }),
    };

    const startTime = Date.now();
    const result = await executePersonaPanel({
      config: mockConfig,
      changedFiles: [{ path: 'src/service.ts', patch: '+ const x = 1;' }],
      repository: 'calltelemetry/ct-meta',
      headSha: 'abc1234',
      client: mockClient,
    });
    const duration = Date.now() - startTime;

    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.personas).toHaveLength(3);
    // Verified concurrent execution: all 3 personas were active simultaneously
    expect(maxObservedConcurrency).toBe(3);
    // Verified parallel duration: ran in ~50-100ms, not 150ms+ serialized
    expect(duration).toBeLessThan(350);
  });
});
