import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

function build4PersonaConfig(): CtReviewConfigV3 {
  return {
    version: 3,
    profile: 'assertive',
    quorum: 4,
    personas: [
      {
        id: 'security-tenancy',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['**'],
        providers: ['claude'],
      },
      {
        id: 'correctness-logic',
        enabled: true,
        required: true,
        charter: 'builtin:correctness',
        paths: ['**'],
        providers: ['codex'],
      },
      {
        id: 'contract-api',
        enabled: true,
        required: true,
        charter: 'builtin:contract',
        paths: ['**'],
        providers: ['grok'],
      },
      {
        id: 'constitutional-policy',
        enabled: true,
        required: true,
        charter: 'builtin:constitutional-goals',
        paths: ['**'],
        providers: ['agy-opus'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 120,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'grok', enabled: true, model: 'deepseek-v4-pro', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'agy-opus', enabled: true, model: 'glm-5.2', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: {
        order: ['claude', 'codex'],
      },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'high',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  };
}

describe('4-Persona Quorum Review Output Generation Integration', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      complete: vi.fn(),
    };
  });

  it('executes panel with 4 distinct persona providers using claude-5-sonnet, gpt-5.6-sol, deepseek-v4-pro, and glm-5.2', async () => {
    const config = build4PersonaConfig();
    const changedFiles = [{ path: 'src/gateway/providerPool.ts', patch: '+ export function addProvider() {}' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      if (prompt.includes('"role":"moderator"')) {
        const body = {
          decision: 'RECONCILED',
          findings: [
            {
              severity: 'P0',
              path: 'src/gateway/providerPool.ts',
              line: 1,
              title: 'Authentication Bypass',
              body: 'Reconciled: Missing auth check on provider addition endpoint.',
            },
          ],
        };
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 200, completion: 80, total: 280 },
          costUSD: 0.002,
        };
      } else if (prompt.includes('"role":"arbiter"')) {
        const body = {
          verdict: 'FIX_FIRST',
          rationale: 'P0 security finding (Auth Bypass) must be fixed before shipping.',
        };
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 250, completion: 60, total: 310 },
          costUSD: 0.0025,
        };
      } else {
        // Persona role
        if (opts.model === 'claude-5-sonnet') {
          const body = {
            decision: 'FINDINGS',
            findings: [
              {
                severity: 'P0',
                path: 'src/gateway/providerPool.ts',
                line: 1,
                title: 'Authentication Bypass',
                body: 'Missing auth check on provider addition endpoint.',
                confidence: 95,
                recommendation: 'Add Bearer token validation header check',
              },
            ],
          };
          return {
            model: 'claude-5-sonnet',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 100, completion: 50, total: 150 },
            costUSD: 0.0015,
          };
        } else if (opts.model === 'gpt-5.6-sol') {
          const body = {
            decision: 'FINDINGS',
            findings: [
              {
                severity: 'P1',
                path: 'src/gateway/providerPool.ts',
                line: 1,
                title: 'Unchecked Null Pointer',
                body: 'Possible null dereference on optional config fields.',
                confidence: 85,
              },
            ],
          };
          return {
            model: 'gpt-5.6-sol',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify(body)}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 110, completion: 45, total: 155 },
            costUSD: 0.0012,
          };
        } else if (opts.model === 'deepseek-v4-pro') {
          return {
            model: 'deepseek-v4-pro',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 90, completion: 20, total: 110 },
            costUSD: 0.0005,
          };
        } else {
          return {
            model: 'glm-5.2',
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 95, completion: 25, total: 120 },
            costUSD: 0.0006,
          };
        }
      }
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/ct-review-bot',
      headSha: 'abcd1234efgh5678',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.headSha).toBe('abcd1234efgh5678');
    expect(result.personas).toHaveLength(4);

    const modelsUsed = result.personas.map((p) => p.model);
    expect(modelsUsed).toContain('claude-5-sonnet');
    expect(modelsUsed).toContain('gpt-5.6-sol');
    expect(modelsUsed).toContain('deepseek-v4-pro');
    expect(modelsUsed).toContain('glm-5.2');

    expect(result.quorum.required).toBe(4);
    expect(result.quorum.distinctProviders).toHaveLength(4);
    expect(result.quorum.satisfied).toBe(true);

    expect(result.arbiter.verdict).toBe('FIX_FIRST');
    expect(result.arbiter.rationale).toContain('P0 security finding');
  });

  it('satisfies SHIP verdict when all 4 persona models approve zero findings', async () => {
    const config = build4PersonaConfig();
    const changedFiles = [{ path: 'src/utils/logger.ts', patch: '+ // logger comment' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      if (prompt.includes('"role":"moderator"')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 150, completion: 30, total: 180 },
          costUSD: 0.001,
        };
      } else if (prompt.includes('"role":"arbiter"')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All 4 persona checks passed with zero findings.' })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 160, completion: 40, total: 200 },
          costUSD: 0.0012,
        };
      } else {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 80, completion: 20, total: 100 },
          costUSD: 0.0005,
        };
      }
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/ct-review-bot',
      headSha: 'clean-commit-sha-999',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.quorum.satisfied).toBe(true);
    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.arbiter.rationale).toContain('zero findings');
  });

  it('fails closed when distinct-provider quorum count is less than required (e.g. < 4)', async () => {
    const config = build4PersonaConfig();
    config.quorum = 4;
    config.personas.forEach((p) => { p.providers = ['claude']; });

    const changedFiles = [{ path: 'src/app.ts', patch: '+ console.log(1);' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: { prompt: 50, completion: 20, total: 70 },
        costUSD: 0.0004,
      };
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/ct-review-bot',
        headSha: 'quorum-fail-sha',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow(/distinct-provider quorum failed: 1\/4/);
  });
});
