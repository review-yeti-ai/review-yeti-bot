import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePersonaPanel, PanelConfigurationError } from '../../src/panel/panelEngine';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { createDefaultV3Config } from '../../src/config/configLoader';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

function buildMinimalConfig(): CtReviewConfigV3 {
  // Based on the real createDefaultV3Config() defaults (see src/config/configLoader.ts) so
  // every schema-required top-level section (reviews, chat, knowledge_base, ...) is present
  // without hand-duplicating the zod defaults here.
  return {
    ...createDefaultV3Config(),
    version: 3,
    profile: 'balanced',
    quorum: 1,
    personas: [
      {
        id: 'sec-lane',
        enabled: true,
        required: true,
        charter: 'builtin:security',
        paths: ['src/**'],
        providers: ['claude'],
      },
      {
        id: 'opt-lane',
        enabled: true,
        required: false,
        charter: 'builtin:consistency',
        paths: ['src/**'],
        providers: ['grok'],
      },
    ],
    reviewers: {
      execution: 'personas',
      fallback: 'ordered',
      overall_timeout_s: 60,
      providers: [
        { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'medium', review_timeout_s: 10, arbiter_timeout_s: 10 },
        { id: 'grok', enabled: true, model: 'deepseek-v4-pro', effort: 'medium', review_timeout_s: 10, arbiter_timeout_s: 10 },
      ],
      arbiter: { order: ['claude'] },
    },
    path_instructions: [],
    rules: [],
    reviewer_effort: 'medium',
    confidence_threshold: 70,
    mascot: true,
    display: { mascot: true },
  };
}

describe('panelEngine.ts — Comprehensive Unit Expansion Tests', () => {
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      complete: vi.fn(),
    };
  });

  it('PanelConfigurationError has name PanelConfigurationError', () => {
    const err = new PanelConfigurationError('test msg');
    expect(err.name).toBe('PanelConfigurationError');
    expect(err.message).toBe('test msg');
  });

  it('throws PanelConfigurationError when no enabled personas apply to changed paths', async () => {
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'docs/README.md' }]; // does not match src/**

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'owner/repo',
        headSha: 'sha-1',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('no enabled persona applies to the changed paths');
  });

  it('throws PanelConfigurationError when required persona fails closed', async () => {
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockRejectedValue(new Error('OmniRoute HTTP 503 Service Unavailable'));

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'owner/repo',
        headSha: 'sha-2',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('required persona failure');
  });

  it('records optionalLane failure into optionalFailures array without aborting panel', async () => {
    const config = buildMinimalConfig();
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : 'test-nonce';
      const allMsg = JSON.stringify(opts.messages);

      if (allMsg.includes('arbiter')) {
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'All good' })}\nCT_REVIEW_END:${nonce}`,
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
      } else if (opts.model === 'deepseek-v4-pro') {
        // Optional lane (grok) fails
        throw new Error('Grok provider timeout');
      } else {
        // Required lane (claude) succeeds
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      }
    });

    const result = await executePersonaPanel({
      config,
      changedFiles,
      repository: 'owner/repo',
      headSha: 'sha-3',
      client: mockClient as unknown as OmniRouteClient,
    });

    expect(result.personas).toHaveLength(1);
    expect(result.personas[0].id).toBe('sec-lane');
    expect(result.optionalFailures).toHaveLength(1);
    expect(result.optionalFailures[0].id).toBe('opt-lane');
    expect(result.optionalFailures[0].error).toContain('Grok provider timeout');
  });

  it('throws PanelConfigurationError when persona returns APPROVE with non-empty findings', async () => {
    const config = buildMinimalConfig();
    config.personas = [config.personas[0]]; // required sec-lane only
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({
          decision: 'APPROVE',
          findings: [{ severity: 'P0', path: 'src/main.ts', line: 1, title: 'Err', body: 'Err' }],
        })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'owner/repo',
        headSha: 'sha-4',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('APPROVE cannot contain findings');
  });

  it('throws PanelConfigurationError when persona returns FINDINGS with empty findings array', async () => {
    const config = buildMinimalConfig();
    config.personas = [config.personas[0]];
    const changedFiles = [{ path: 'src/main.ts' }];

    mockClient.complete.mockImplementation(async (opts: any) => {
      const prompt = opts.messages[1].content as string;
      const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
      const nonce = nonceMatch ? nonceMatch[1].trim() : '';

      return {
        model: opts.model,
        content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({
          decision: 'FINDINGS',
          findings: [],
        })}\nCT_REVIEW_END:${nonce}`,
        usage: null,
        costUSD: null,
      };
    });

    await expect(
      executePersonaPanel({
        config,
        changedFiles,
        repository: 'owner/repo',
        headSha: 'sha-5',
        client: mockClient as unknown as OmniRouteClient,
      })
    ).rejects.toThrow('FINDINGS requires at least one finding');
  });
});
