import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isRedTeamPersona, getModelFamily, resolveDualModel, RED_TEAM_CHARTER_DEFAULT } from '../../src/personas/redTeamPersona';
import { ctReviewConfigV3Schema, CtReviewConfigV3 } from '../../src/config/schema';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

describe('redTeamPersona unit tests', () => {
  describe('isRedTeamPersona', () => {
    it('identifies red-team personas by ID', () => {
      expect(isRedTeamPersona('red_team')).toBe(true);
      expect(isRedTeamPersona('RED_TEAM')).toBe(true);
      expect(isRedTeamPersona('red-team')).toBe(true);
      expect(isRedTeamPersona('skeptic')).toBe(true);
    });

    it('identifies red-team personas by charter', () => {
      expect(isRedTeamPersona('custom_id', 'builtin:red-team')).toBe(true);
      expect(isRedTeamPersona('custom_id', 'builtin:skeptic')).toBe(true);
    });

    it('returns false for standard personas', () => {
      expect(isRedTeamPersona('correctness', 'builtin:correctness')).toBe(false);
      expect(isRedTeamPersona('security', 'builtin:security')).toBe(false);
    });
  });

  describe('getModelFamily', () => {
    it('classifies anthropic models correctly', () => {
      expect(getModelFamily('claude-5-sonnet')).toBe('anthropic');
      expect(getModelFamily('claude/claude-opus-4-8')).toBe('anthropic');
      expect(getModelFamily('claude-3-5-sonnet')).toBe('anthropic');
      expect(getModelFamily('claude-3.5-sonnet')).toBe('anthropic');
      expect(getModelFamily('agy/claude-opus-4-6-thinking')).toBe('anthropic');
    });

    it('classifies openai models correctly', () => {
      expect(getModelFamily('gpt-5.6-sol')).toBe('openai');
      expect(getModelFamily('gpt-4o')).toBe('openai');
      expect(getModelFamily('codex/gpt-5.6-sol-high')).toBe('openai');
    });

    it('classifies deepseek and grok models correctly', () => {
      expect(getModelFamily('deepseek-v4-pro')).toBe('deepseek-grok');
      expect(getModelFamily('deepseek-v3')).toBe('deepseek-grok');
      expect(getModelFamily('glm-5.2')).toBe('deepseek-grok');
      expect(getModelFamily('grok-cli/grok-4.5')).toBe('deepseek-grok');
      expect(getModelFamily('synthetic/v1')).toBe('deepseek-grok');
    });

    it('returns default for unknown model names', () => {
      expect(getModelFamily('custom-llm-v1')).toBe('default');
    });
  });

  describe('resolveDualModel', () => {
    it('resolves cross-examination model from a distinct model family', () => {
      const candidates = [
        { id: 'claude' as const, model: 'claude-5-sonnet' },
        { id: 'codex' as const, model: 'gpt-5.6-sol' },
      ];
      // Primary model is Anthropic; should pick Codex (OpenAI)
      const resolved = resolveDualModel('claude-5-sonnet', candidates);
      expect(resolved.providerId).toBe('codex');
      expect(resolved.model).toBe('gpt-5.6-sol');
    });

    it('uses preferred adversarial model when provided and matched', () => {
      const candidates = [
        { id: 'claude' as const, model: 'claude-5-sonnet' },
        { id: 'grok' as const, model: 'deepseek-v4-pro' },
      ];
      const resolved = resolveDualModel('claude-5-sonnet', candidates, 'deepseek-v4-pro');
      expect(resolved.providerId).toBe('grok');
      expect(resolved.model).toBe('deepseek-v4-pro');
    });
  });

  describe('Schema Validation', () => {
    it('parses red_team persona ID and built-in charters', () => {
      const rawConfig = {
        version: 3,
        profile: 'balanced',
        quorum: 2,
        personas: [
          {
            id: 'red_team',
            enabled: true,
            required: true,
            charter: 'builtin:red-team',
            paths: ['src/**'],
            providers: ['codex'],
            dual_model: true,
            adversarial_model: 'gpt-4o',
          },
          {
            id: 'skeptic',
            enabled: true,
            required: true,
            charter: 'builtin:skeptic',
            paths: ['src/**'],
            providers: ['claude'],
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 120,
          providers: [
            { id: 'claude', enabled: true, model: 'claude-3-5-sonnet', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'codex', enabled: true, model: 'gpt-4o', effort: 'medium', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['claude'] },
        },
      };

      const parsed = ctReviewConfigV3Schema.parse(rawConfig);
      expect(parsed.personas[0].id).toBe('red_team');
      expect(parsed.personas[0].charter).toBe('builtin:red-team');
      expect(parsed.personas[1].id).toBe('skeptic');
      expect(parsed.personas[1].charter).toBe('builtin:skeptic');
    });
  });

  describe('executePersonaPanel with Red-Team Persona', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = {
        complete: vi.fn(),
      };
    });

    it('executes Red-Team persona on a cross-examined model family distinct from author model', async () => {
      const config: CtReviewConfigV3 = {
        version: 3,
        profile: 'assertive',
        quorum: 2,
        personas: [
          {
            id: 'author_lane',
            enabled: true,
            required: true,
            charter: 'builtin:correctness',
            paths: ['src/**'],
            providers: ['claude'],
          },
          {
            id: 'red_team',
            enabled: true,
            required: true,
            charter: 'builtin:red-team',
            paths: ['src/**'],
            providers: ['claude', 'codex'],
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 120,
          providers: [
            { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['claude', 'codex'] },
        },
        path_instructions: [],
        rules: [],
        reviews: {
          profile: 'assertive',
          reviewer_effort: 'high',
          confidence_threshold: 70,
          mascot: true,
          ticket_enforcement: false,
          request_changes_workflow: true,
          high_level_summary: true,
          poem: false,
          review_status: true,
          collapse_walkthrough: false,
          sequence_diagrams: true,
          path_instructions: [],
        },
        chat: { auto_reply: true, max_context_turns: 10, art_mascot_response: true },
        knowledge_base: { learnings: true, issues: true, pull_requests: true, custom_instructions: [] },
        path_filters: [],
        auto_review: { enabled: true, ignore_drafts: true, review_drafts: false, triggers: [], labels: [], ignore_patterns: [], drafts: false },
        dials: { memory_engine: true, mascot: true, confidence_threshold: 70, ticket_enforcement: false },
        mcps: [],
        on_pr_close: { create_followup_prs: [], sync_productlane: false },
      };

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 10, completion: 10, total: 20 },
            costUSD: 0.0001,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes cross-examination' })}\nCT_REVIEW_END:${nonce}`,
            usage: { prompt: 15, completion: 15, total: 30 },
            costUSD: 0.0002,
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

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/index.ts', patch: '+ console.log("hello");' }],
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'abc1234',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.personas).toHaveLength(2);

      const redTeamLane = result.personas.find((p) => p.id === 'red_team');
      expect(redTeamLane).toBeDefined();
      expect(redTeamLane?.isRedTeam).toBe(true);
      expect(redTeamLane?.providerId).toBe('codex');
      expect(redTeamLane?.crossExaminedModel).toBe('gpt-5.6-sol');
    });

    it('handles config with ONLY Red-Team personas when nonRedTeamPersonas is empty', async () => {
      const config: CtReviewConfigV3 = {
        version: 3,
        profile: 'assertive',
        quorum: 1,
        personas: [
          {
            id: 'red_team',
            enabled: true,
            required: true,
            charter: 'builtin:red-team',
            paths: ['src/**'],
            providers: ['claude', 'codex'],
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 120,
          providers: [
            { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['claude'] },
        },
        path_instructions: [],
        rules: [],
      };

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: null,
            costUSD: null,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes' })}\nCT_REVIEW_END:${nonce}`,
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

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/index.ts', patch: '+ console.log("hello");' }],
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'abc1234',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].id).toBe('red_team');
      expect(result.personas[0].isRedTeam).toBe(true);
      // Primary authoring model defaulted to claude-5-sonnet (anthropic), so Red-Team picked codex (gpt-5.6-sol)
      expect(result.personas[0].providerId).toBe('codex');
    });

    it('supports non-Red-Team personas with dual_model: true', async () => {
      const config: CtReviewConfigV3 = {
        version: 3,
        profile: 'balanced',
        quorum: 1,
        personas: [
          {
            id: 'perf_lane',
            enabled: true,
            required: true,
            charter: 'builtin:performance',
            paths: ['src/**'],
            providers: ['claude', 'codex'],
            dual_model: true,
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 120,
          providers: [
            { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['claude'] },
        },
        path_instructions: [],
        rules: [],
      };

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';

        if (prompt.includes('"role":"moderator"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'RECONCILED', findings: [] })}\nCT_REVIEW_END:${nonce}`,
            usage: null,
            costUSD: null,
          };
        } else if (prompt.includes('"role":"arbiter"')) {
          return {
            model: opts.model,
            content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ verdict: 'SHIP', rationale: 'Passes' })}\nCT_REVIEW_END:${nonce}`,
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

      const result = await executePersonaPanel({
        config,
        changedFiles: [{ path: 'src/index.ts' }],
        repository: 'calltelemetry/cisco-cdr',
        headSha: 'abc1234',
        client: mockClient as unknown as OmniRouteClient,
      });

      expect(result.personas).toHaveLength(1);
      expect(result.personas[0].id).toBe('perf_lane');
      expect(result.personas[0].isRedTeam).toBeUndefined();
      expect(result.personas[0].crossExaminedModel).toBeDefined();
    });

    it('throws PanelConfigurationError when distinct provider quorum is unsatisfied', async () => {
      const config: CtReviewConfigV3 = {
        version: 3,
        profile: 'balanced',
        quorum: 2, // Quorum 2 required!
        personas: [
          {
            id: 'sec_lane',
            enabled: true,
            required: true,
            charter: 'builtin:security',
            paths: ['src/**'],
            providers: ['claude'],
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 120,
          providers: [
            { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
            { id: 'codex', enabled: true, model: 'gpt-5.6-sol', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['claude'] },
        },
        path_instructions: [],
        rules: [],
      };

      mockClient.complete.mockImplementation(async (opts: any) => {
        const prompt = opts.messages[1].content as string;
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:(.*?)(\n|$)/);
        const nonce = nonceMatch ? nonceMatch[1].trim() : '';
        return {
          model: opts.model,
          content: `CT_REVIEW_BEGIN:${nonce}\n${JSON.stringify({ decision: 'APPROVE', findings: [] })}\nCT_REVIEW_END:${nonce}`,
          usage: null,
          costUSD: null,
        };
      });

      await expect(
        executePersonaPanel({
          config,
          changedFiles: [{ path: 'src/index.ts' }],
          repository: 'calltelemetry/cisco-cdr',
          headSha: 'abc1234',
          client: mockClient as unknown as OmniRouteClient,
        })
      ).rejects.toThrow('distinct-provider quorum failed: 1/2');
    });
  });
});

