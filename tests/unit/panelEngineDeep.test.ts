import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel, PanelConfigurationError } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

function buildDeepConfig(): CtReviewConfigV3 {
  return {
    version: 3,
    profile: 'assertive',
    quorum: 2,
    personas: [
      {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/security/**'],
        providers: ['claude', 'grok'],
      },
      {
        id: 'correct-lane',
        enabled: true,
        required: true,
        charter: 'builtin:correctness',
        paths: ['src/security/**'],
        providers: ['codex'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 120,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'grok', enabled: true, model: 'deepseek-v4-pro', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: { order: ['claude', 'codex'] },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'high',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  };
}

describe('panelEngine.ts — Deep Edge Case & Nonce-Fence Unit Tests', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      complete: vi.fn(),
    };
  });

  it('matches glob paths correctly (src/security/**)', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts', patch: '+ const token = 123;' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const allMsg = JSON.stringify(opts.messages);

      if (allMsg.includes('arbiter')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes cleanly' })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 15, completion: 15, total: 30 },
          costUSD: 0.0002,
        };
      } else if (allMsg.includes('moderator')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 10, completion: 10, total: 20 },
          costUSD: 0.0001,
        };
      } else {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 5, completion: 5, total: 10 },
          costUSD: 0.00005,
        };
      }
    });

    const panelResult = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-123',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(panelResult.personas).toHaveLength(2);
    expect(panelResult.arbiter.verdict).toBe('SHIP');
  });

  it('uses fallback provider when primary provider fails in persona lane', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const allMsg = JSON.stringify(opts.messages);

      if (allMsg.includes('arbiter')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else if (allMsg.includes('moderator')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else {
        // Persona lane
        if (opts.model === 'claude-5-sonnet') {
          // Primary provider fails!
          throw new Error('Claude API Timeout');
        } else {
          // Fallback provider (grok/deepseek-v4-pro or codex/gpt-5.6-sol) succeeds
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: null,
            costUSD: null,
          };
        }
      }
    });

    const panelResult = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-fallback',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(panelResult.personas).toHaveLength(2);
    const secLane = panelResult.personas.find((p) => p.id === 'sec-lane');
    expect(secLane?.providerId).toBe('grok');
    expect(secLane?.model).toBe('deepseek-v4-pro');
  });

  it('throws PanelConfigurationError when missing nonce fence in model output', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];

    mockClient.complete.mockResolvedValue({
      model: 'claude-5-sonnet',
      content: 'Here is my review without any CT_REVIEW_BEGIN nonce fences: {"decision":"APPROVE","findings":[]}',
      usage: null,
      costUSD: null,
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-bad-fence',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('required persona failure');
  });

  it('throws PanelConfigurationError when JSON inside nonce fence is invalid syntax', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n{ invalid json syntax ... }\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/repo',
        headSha: 'head-sha-bad-json',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('required persona failure');
  });

  it('supports BLOCK arbiter verdict with rationale', async () => {
    const config = buildDeepConfig();
    const changedFiles = [{ path: 'src/security/auth.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const allMsg = JSON.stringify(opts.messages);

      if (allMsg.includes('arbiter')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'BLOCK', rationale: 'Critical security violation blocks merge.' })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else if (allMsg.includes('moderator')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      } else {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
    });

    const panelResult = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/repo',
      headSha: 'head-sha-block',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(panelResult.arbiter.verdict).toBe('BLOCK');
    expect(panelResult.arbiter.rationale).toContain('Critical security violation');
  });
});
