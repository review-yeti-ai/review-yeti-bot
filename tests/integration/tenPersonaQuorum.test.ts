import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

function build10PersonaConfig(): CtReviewConfigV3 {
  return {
    version: 3,
    profile: 'assertive',
    quorum: 4,
    personas: [
      { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['codex'] },
      { id: 'arch-lane', enabled: true, required: false, charter: 'builtin:constitutional-goals', paths: ['**'], providers: ['claude'] },
      { id: 'perf-lane', enabled: true, required: false, charter: 'builtin:performance', paths: ['**'], providers: ['grok'] },
      { id: 'qual-lane', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['agy-opus'] },
      { id: 'db-lane', enabled: true, required: false, charter: 'builtin:database', paths: ['**'], providers: ['codex'] },
      { id: 'api-lane', enabled: true, required: false, charter: 'builtin:contract', paths: ['**'], providers: ['claude'] },
      { id: 'sre-lane', enabled: true, required: false, charter: 'builtin:policy-compliance', paths: ['**'], providers: ['grok'] },
      { id: 'devops-lane', enabled: true, required: false, charter: 'builtin:devops', paths: ['**'], providers: ['agy-opus'] },
      { id: 'docs-lane', enabled: true, required: false, charter: 'builtin:consistency', paths: ['**'], providers: ['codex'] },
      { id: 'finops-lane', enabled: true, required: false, charter: 'builtin:finops', paths: ['**'], providers: ['claude'] },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 120,
      providers: [
        { id: 'codex', enabled: true, model: 'codex/gpt-5.6-sol-high', effort: 'max', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'grok', enabled: true, model: 'grok-cli/grok-4.5', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
        { id: 'agy-opus', enabled: true, model: 'agy/claude-opus-4-6-thinking', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
      ],
      arbiter: {
        order: ['codex', 'claude'],
      },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'high',
    confidence_threshold: 70,
    mascot: true,
  };
}

describe('10-Persona Fan-Out Quorum Integration Suite (Milestone 40)', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      complete: vi.fn(),
    };
  });

  it('executes 10-persona fan-out panel concurrently across 4 distinct providers', async () => {
    const config = build10PersonaConfig();
    const changedFiles = [{ path: 'src/core/engine.ts', patch: '+ export function runEngine() {}' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      if (prompt.includes('"role":"moderator"')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 200, completion: 50, total: 250 },
          costUSD: 0.002,
        };
      } else if (prompt.includes('"role":"arbiter"')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All 10 persona lanes passed verification.' })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 300, completion: 60, total: 360 },
          costUSD: 0.003,
        };
      } else {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 30, total: 130 },
          costUSD: 0.001,
        };
      }
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/ct-review-bot',
      headSha: '10persona-fanout-head-sha',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.headSha).toBe('10persona-fanout-head-sha');
    expect(result.personas).toHaveLength(10);
    expect(result.optionalFailures).toHaveLength(0);

    const personaIds = result.personas.map((p) => p.id);
    expect(personaIds).toContain('sec-lane');
    expect(personaIds).toContain('arch-lane');
    expect(personaIds).toContain('perf-lane');
    expect(personaIds).toContain('qual-lane');
    expect(personaIds).toContain('db-lane');
    expect(personaIds).toContain('api-lane');
    expect(personaIds).toContain('sre-lane');
    expect(personaIds).toContain('devops-lane');
    expect(personaIds).toContain('docs-lane');
    expect(personaIds).toContain('finops-lane');

    expect(result.quorum.required).toBe(4);
    expect(result.quorum.distinctProviders).toHaveLength(4);
    expect(result.quorum.satisfied).toBe(true);

    expect(result.arbiter.verdict).toBe('SHIP');
    expect(result.arbiter.rationale).toContain('All 10 persona lanes passed');
  });

  it('fails closed when a required persona (sec-lane) fails', async () => {
    const config = build10PersonaConfig();
    const changedFiles = [{ path: 'src/core/auth.ts', patch: '+ function bypassAuth() {}' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      if (prompt.includes('"sec-lane"')) {
        throw new Error('LLM provider API timeout on sec-lane');
      }

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
        usage: { prompt: 100, completion: 30, total: 130 },
        costUSD: 0.001,
      };
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'calltelemetry/ct-review-bot',
        headSha: 'required-fail-head-sha',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow(/required persona failure/);
  });

  it('resiliently handles optional persona failure (docs-lane) while completing panel review', async () => {
    const config = build10PersonaConfig();
    const changedFiles = [{ path: 'src/core/docs.ts', patch: '+ // doc update' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      if (prompt.includes('"docs-lane"')) {
        throw new Error('LLM provider API timeout on docs-lane');
      }

      if (prompt.includes('"role":"moderator"')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 200, completion: 50, total: 250 },
          costUSD: 0.002,
        };
      } else if (prompt.includes('"role":"arbiter"')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: '9 persona lanes approved.' })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 300, completion: 60, total: 360 },
          costUSD: 0.003,
        };
      } else {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: { prompt: 100, completion: 30, total: 130 },
          costUSD: 0.001,
        };
      }
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'calltelemetry/ct-review-bot',
      headSha: 'optional-fail-head-sha',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.personas).toHaveLength(9);
    expect(result.optionalFailures).toHaveLength(1);
    expect(result.optionalFailures[0].id).toBe('docs-lane');
    expect(result.optionalFailures[0].error).toContain('docs-lane');

    expect(result.quorum.satisfied).toBe(true);
    expect(result.arbiter.verdict).toBe('SHIP');
  });
});
