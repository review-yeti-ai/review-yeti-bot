import { describe, expect, it, vi } from 'vitest';
import { parseAndValidateConfig, loadConfig, translateCodeRabbitToV3, ConfigValidationError } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema, R4_ALLOWED_MODELS, V3_PROVIDER_MODELS } from '../../src/config/schema';
import { formatInlineCommentBody, ASCII_MASCOT } from '../../src/github/commentPublisher';

describe('Milestone 4 Empirical Stress Tests — Dual YAML, Precedence, Models & Dials', () => {

  describe('1. CodeRabbit YAML Config Translation & Dials', () => {
    it('translates various reviewer effort levels correctly', () => {
      const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
      for (const effort of efforts) {
        const raw = { reviews: { reviewer_effort: effort } };
        const translated = translateCodeRabbitToV3(raw);
        expect(translated.reviewer_effort).toBe(effort);
        expect(translated.reviewers.providers[0].effort).toBe(effort);
      }
    });

    it('handles default reviewer effort when invalid value provided', () => {
      const raw = { reviews: { reviewer_effort: 'ultra_fast' } };
      const translated = translateCodeRabbitToV3(raw);
      expect(translated.reviewer_effort).toBe('low');
    });

    it('translates valid confidence_threshold values', () => {
      const raw1 = { reviews: { confidence_threshold: 85 } };
      expect(translateCodeRabbitToV3(raw1).confidence_threshold).toBe(85);

      const raw2 = { reviews: { confidence_threshold: 0 } };
      expect(translateCodeRabbitToV3(raw2).confidence_threshold).toBe(0);

      const raw3 = { reviews: { confidence_threshold: 100 } };
      expect(translateCodeRabbitToV3(raw3).confidence_threshold).toBe(100);
    });

    it('clamps out-of-range confidence_threshold values', () => {
      const rawMin = { reviews: { confidence_threshold: -50 } };
      expect(translateCodeRabbitToV3(rawMin).confidence_threshold).toBe(0);

      const rawMax = { reviews: { confidence_threshold: 150 } };
      expect(translateCodeRabbitToV3(rawMax).confidence_threshold).toBe(100);
    });

    it('translates mascot toggle settings across display/root/reviews', () => {
      expect(translateCodeRabbitToV3({ mascot: false }).mascot).toBe(false);
      expect(translateCodeRabbitToV3({ reviews: { mascot: false } }).mascot).toBe(false);
      expect(translateCodeRabbitToV3({ display: { mascot: false } }).mascot).toBe(false);
      expect(translateCodeRabbitToV3({ mascot: true }).mascot).toBe(true);
      expect(translateCodeRabbitToV3({}).mascot).toBe(true);
    });

    it('translates path_instructions from array format', () => {
      const raw = {
        reviews: {
          path_instructions: [
            { path: 'src/**/*.ts', instructions: 'Verify async error handling' },
            { path: 'docs/**', instructions: 'Check spelling' },
          ],
        },
      };
      const translated = translateCodeRabbitToV3(raw);
      expect(translated.path_instructions).toHaveLength(2);
      expect(translated.path_instructions[0]).toEqual({ path: 'src/**/*.ts', instructions: 'Verify async error handling' });
      expect(translated.path_instructions[1]).toEqual({ path: 'docs/**', instructions: 'Check spelling' });
    });

    it('DEMONSTRATES ISSUE: string confidence_threshold in YAML falls back to default 70', () => {
      const raw = { reviews: { confidence_threshold: '85' as any } };
      const translated = translateCodeRabbitToV3(raw);
      expect(translated.confidence_threshold).toBe(70);
    });

    it('DEMONSTRATES ISSUE: dict path_instructions format is ignored', () => {
      const raw = {
        reviews: {
          path_instructions: { 'src/**/*.ts': 'Check types' } as any,
        },
      };
      const translated = translateCodeRabbitToV3(raw);
      expect(translated.path_instructions).toEqual([]);
    });
  });

  describe('2. 4-Tier Inheritance Loading Order (loadConfig)', () => {
    it('Tier 1: uses PR .ct-review.yaml when available', async () => {
      const client = {
        getFileContent: vi.fn().mockImplementation(async (owner, repo, path) => {
          if (path === '.ct-review.yaml' && repo !== '.github') {
            return `
version: 3
profile: assertive
quorum: 1
personas:
  - id: p1
    enabled: true
    required: true
    charter: builtin:correctness
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [codex]
`;
          }
          return null;
        }),
      };

      const config = await loadConfig('owner', 'repo', 'feature-branch', client);
      expect(config.profile).toBe('assertive');
      expect(client.getFileContent).toHaveBeenCalledWith('owner', 'repo', '.ct-review.yaml', 'feature-branch');
    });

    it('Tier 2: falls back to PR .coderabbit.yaml when PR .ct-review.yaml is absent', async () => {
      const client = {
        getFileContent: vi.fn().mockImplementation(async (owner, repo, path) => {
          if (path === '.coderabbit.yaml' && repo !== '.github') {
            return `reviews: { profile: chill, reviewer_effort: low }`;
          }
          return null;
        }),
      };

      const config = await loadConfig('owner', 'repo', 'feature-branch', client);
      expect(config.profile).toBe('chill');
      expect(config.reviewer_effort).toBe('low');
      expect(client.getFileContent).toHaveBeenCalledWith('owner', 'repo', '.coderabbit.yaml', 'feature-branch');
    });

    it('Tier 3: falls back to Org .github/.ct-review.yaml when PR configs are absent', async () => {
      const client = {
        getFileContent: vi.fn().mockImplementation(async (owner, repo, path) => {
          if (owner === 'owner' && repo === '.github' && path === '.ct-review.yaml') {
            return `
version: 3
profile: assertive
quorum: 1
personas:
  - id: p1
    enabled: true
    required: true
    charter: builtin:correctness
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [codex]
`;
          }
          return null;
        }),
      };

      const config = await loadConfig('owner', 'repo', 'feature-branch', client);
      expect(config.profile).toBe('assertive');
      expect(client.getFileContent).toHaveBeenCalledWith('owner', '.github', '.ct-review.yaml');
    });

    it('Tier 4: falls back to Org .github/.coderabbit.yaml when prior configs are absent', async () => {
      const client = {
        getFileContent: vi.fn().mockImplementation(async (owner, repo, path) => {
          if (owner === 'owner' && repo === '.github' && path === '.coderabbit.yaml') {
            return `reviews: { profile: chill }`;
          }
          return null;
        }),
      };

      const config = await loadConfig('owner', 'repo', 'feature-branch', client);
      expect(config.profile).toBe('chill');
      expect(client.getFileContent).toHaveBeenCalledWith('owner', '.github', '.coderabbit.yaml');
    });

    it('Tier 5: falls back to default config when all files are absent', async () => {
      const client = {
        getFileContent: vi.fn().mockResolvedValue(null),
      };

      const config = await loadConfig('owner', 'repo', 'feature-branch', client);
      expect(config.version).toBe(3);
      expect(config.profile).toBe('balanced');
      expect(config.quorum).toBe(1);
    });

    it('Strict Precedence: Tier 1 > Tier 2 > Tier 3 > Tier 4', async () => {
      const client = {
        getFileContent: vi.fn().mockImplementation(async (owner, repo, path) => {
          if (repo !== '.github') {
            if (path === '.ct-review.yaml') {
              return `
version: 3
profile: assertive
quorum: 1
personas:
  - id: p1
    enabled: true
    required: true
    charter: builtin:correctness
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [codex]
`;
            }
            if (path === '.coderabbit.yaml') {
              return `reviews: { profile: chill }`;
            }
          } else {
            if (path === '.ct-review.yaml') {
              return `version: 3\nprofile: balanced...`;
            }
          }
          return null;
        }),
      };

      const config = await loadConfig('owner', 'repo', 'feature-branch', client);
      expect(config.profile).toBe('assertive'); // Tier 1 wins over Tier 2, 3, 4
    });

    it('honors PR .ct-review.yaml with legacy version 1 by translating to V3 instead of falling through to Tier 2/3/4', async () => {
      const client = {
        getFileContent: vi.fn().mockImplementation(async (owner, repo, path) => {
          if (repo !== '.github' && path === '.ct-review.yaml') {
            return `
version: 1
profile: assertive
`;
          }
          if (repo !== '.github' && path === '.coderabbit.yaml') {
            return `reviews: { profile: chill }`;
          }
          return null;
        }),
      };

      const config = await loadConfig('owner', 'repo', 'feature-branch', client);
      expect(config.profile).toBe('assertive');
    });
  });

  describe('3. R4 Model Allowlisting', () => {
    const makeConfigWithModel = (providerId: string, modelName: string) => `
version: 3
profile: balanced
quorum: 1
personas:
  - id: test-persona
    enabled: true
    required: true
    charter: builtin:correctness
    paths: ["**"]
    providers: [${providerId}]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 300
  providers:
    - id: ${providerId}
      enabled: true
      model: "${modelName}"
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [${providerId}]
`;

    it('allows default model for each provider', () => {
      for (const [providerId, defaultModel] of Object.entries(V3_PROVIDER_MODELS)) {
        const config = parseAndValidateConfig(makeConfigWithModel(providerId, defaultModel));
        expect(config.version).toBe(3);
      }
    });

    it('allows each of the 4 R4 allowlisted models across providers', () => {
      const providers = ['codex', 'grok', 'agy-opus', 'claude'];
      for (const providerId of providers) {
        for (const model of R4_ALLOWED_MODELS) {
          const config = parseAndValidateConfig(makeConfigWithModel(providerId, model));
          expect(config.version).toBe(3);
        }
      }
    });

    it('rejects non-allowlisted models with ConfigValidationError', () => {
      const invalidModels = ['invalid-gpt-model', 'claude-invalid-v1', 'deepseek-invalid-v1', 'random-model-v1'];
      for (const invalidModel of invalidModels) {
        expect(() => parseAndValidateConfig(makeConfigWithModel('codex', invalidModel))).toThrow(ConfigValidationError);
      }
    });
  });

  describe('4. Fix for hasCodeRabbitFields Detection (configLoader.ts:101)', () => {
    it('does not intercept arbitrary non-CodeRabbit unversioned yaml as CodeRabbit format', () => {
      const yamlWithoutVersion = `
profile: assertive
`;
      const parsed = parseAndValidateConfig(yamlWithoutVersion);
      expect(parsed.version).toBe(1);
    });
  });

  describe('5. Mascot Display Dial Stress Test', () => {
    it('includes mascot ascii art when mascot dial is true', () => {
      const finding = {
        persona: 'correctness',
        severity: 'P0' as const,
        filePath: 'src/index.ts',
        lineNumber: 42,
        comment: 'Null pointer dereference',
      };
      const formatted = formatInlineCommentBody(finding, { mascot: true });
      expect(formatted).toContain(ASCII_MASCOT);
    });

    it('suppresses mascot ascii art when mascot dial is false', () => {
      const finding = {
        persona: 'correctness',
        severity: 'P0' as const,
        filePath: 'src/index.ts',
        lineNumber: 42,
        comment: 'Null pointer dereference',
      };
      const formatted = formatInlineCommentBody(finding, { mascot: false });
      expect(formatted).not.toContain(ASCII_MASCOT);
    });
  });

});
