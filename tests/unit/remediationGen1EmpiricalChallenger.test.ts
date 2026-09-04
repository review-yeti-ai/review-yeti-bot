import { describe, it, expect, vi, afterEach } from 'vitest';
import { getProviderIdForModel, isModelEnabled, ALL_CANONICAL_PROVIDERS } from '../../src/lib/model-filtering';
import { executePersonaPanel } from '../../src/panel/panelEngine';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { parseAndValidateConfig } from '../../src/config/configLoader';
import { CtReviewConfigV3 } from '../../src/config/schema';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

describe('Remediation Gen1 Targeted Empirical Challenger Suite', () => {
  describe('1. OpenRouter Provider Resolution in model-filtering.ts', () => {
    it('correctly resolves openrouter prefix models to openrouter provider', () => {
      expect(getProviderIdForModel('openrouter/anthropic/claude-3.5-sonnet')).toBe('openrouter');
      expect(getProviderIdForModel('openrouter/meta-llama/llama-3.3-70b-instruct')).toBe('openrouter');
      expect(getProviderIdForModel('openrouter/deepseek/deepseek-r1')).toBe('openrouter');
      expect(getProviderIdForModel('openrouter')).toBe('openrouter');
      expect(getProviderIdForModel('OPENROUTER/openai/gpt-4o')).toBe('openrouter');
    });

    it('includes openrouter in ALL_CANONICAL_PROVIDERS list', () => {
      expect(ALL_CANONICAL_PROVIDERS).toContain('openrouter');
    });

    it('correctly evaluates model enablement for openrouter models based on provider config', () => {
      const enabledProviders = {
        openrouter: { id: 'openrouter', displayName: 'OpenRouter', enabled: true, activeModels: [], updatedAt: '' },
      };
      const disabledProviders = {
        openrouter: { id: 'openrouter', displayName: 'OpenRouter', enabled: false, activeModels: [], updatedAt: '' },
      };

      expect(isModelEnabled('openrouter/anthropic/claude-3.5-sonnet', enabledProviders)).toBe(true);
      expect(isModelEnabled('openrouter/anthropic/claude-3.5-sonnet', disabledProviders)).toBe(false);
    });
  });

  describe('2. Custom Prompt Precedence & Schema Empirical Analysis in panelEngine.ts', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      dashboardStore.reset();
    });

    it('demonstrates that customPrompt in raw persona object is honored by panelEngine logic', async () => {
      dashboardStore.updatePersonaSetting('security', {
        customPrompt: '',
      });

      // Construct a config object where persona has customPrompt directly without Zod stripping
      const rawConfig: any = {
        version: 3,
        profile: 'balanced',
        quorum: 1,
        personas: [
          {
            id: 'security',
            charter: 'builtin:security',
            customPrompt: 'YAML_CUSTOM_PROMPT_SECURITY',
            providers: ['codex'],
            paths: ['**/*'],
            required: true,
            enabled: true,
          },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'none',
          overall_timeout_s: 30,
          providers: [
            {
              id: 'codex',
              enabled: true,
              model: 'codex/gpt-5.6-sol-high',
              effort: 'high',
              review_timeout_s: 5,
            },
          ],
          arbiter: { order: ['codex'] },
        },
      };

      const capturedPrompts: string[] = [];
      const mockComplete = vi.fn().mockImplementation(async (req: any) => {
        const prompt = req.messages[req.messages.length - 1].content;
        capturedPrompts.push(prompt);
        const nonceMatch = prompt.match(/CT_REVIEW_NONCE:([a-f0-9-]+)/);
        const nonce = nonceMatch ? nonceMatch[1] : 'nonce';
        const allMsg = JSON.stringify(req.messages);

        if (allMsg.includes('arbiter')) {
          return { model: req.model, content: `CT_REVIEW_BEGIN:${nonce}\n{"verdict":"SHIP","rationale":"Clean"}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null, raw: {} };
        }
        if (allMsg.includes('moderator')) {
          return { model: req.model, content: `CT_REVIEW_BEGIN:${nonce}\n{"decision":"RECONCILED","findings":[]}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null, raw: {} };
        }
        return { model: req.model, content: `CT_REVIEW_BEGIN:${nonce}\n{"decision":"APPROVE","findings":[]}\nCT_REVIEW_END:${nonce}`, usage: null, costUSD: null, raw: {} };
      });

      const client = { complete: mockComplete } as unknown as OmniRouteClient;

      await executePersonaPanel({
        config: rawConfig,
        changedFiles: [{ path: 'src/main.ts', content: 'console.log("test");' }],
        repository: 'test/repo',
        headSha: 'abc1234',
        client,
      });

      const personaPrompt = capturedPrompts.find((p) => p.includes('Persona: security')) || capturedPrompts[0];
      expect(personaPrompt).toContain('YAML_CUSTOM_PROMPT_SECURITY');
    });

    it('verifies parseAndValidateConfig preserves customPrompt from persona objects via personaSchema', () => {
      const yamlWithCustomPrompt = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: security
    charter: builtin:security
    customPrompt: "YAML_CUSTOM_PROMPT_SECURITY"
    providers: [codex]
    paths: ["**/*"]
    required: true
    enabled: true
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 30
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 5
      arbiter_timeout_s: 5
  arbiter:
    order: [codex]
`;

      const parsedConfig = parseAndValidateConfig(yamlWithCustomPrompt) as any;
      const persona = parsedConfig.personas[0];

      expect(persona.customPrompt).toBe('YAML_CUSTOM_PROMPT_SECURITY');
    });
  });
});
