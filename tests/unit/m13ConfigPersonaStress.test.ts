import { describe, it, expect, vi } from 'vitest';
import {
  parseAndValidateConfig,
  loadConfig,
  ConfigValidationError,
  translateCodeRabbitToV3,
  createDefaultV3Config,
} from '../../src/config/configLoader';
import { R4_ALLOWED_MODELS, V3_PROVIDER_MODELS } from '../../src/config/schema';

describe('M13 Stress Tests: Config Engine & Persona Model Edge Cases', () => {
  describe('1. Edge Case .coderabbit.yaml Configurations', () => {
    it('handles completely empty .coderabbit.yaml file', () => {
      const emptyYaml = ``;
      const config = parseAndValidateConfig(emptyYaml, true) as any;
      expect(config.version).toBe(3);
      expect(config.profile).toBe('balanced');
      expect(config.confidence_threshold).toBe(70);
      expect(config.mascot).toBe(true);
    });

    it('handles empty mapping {} in .coderabbit.yaml', () => {
      const emptyObjYaml = `{}`;
      const config = parseAndValidateConfig(emptyObjYaml, true) as any;
      expect(config.version).toBe(3);
      expect(config.profile).toBe('balanced');
    });

    it('rejects .coderabbit.yaml when reviews is an empty object as the sole key', () => {
      const singleEmptyReviewsYaml = `reviews: {}`;
      expect(() => parseAndValidateConfig(singleEmptyReviewsYaml, true)).toThrow(
        ConfigValidationError
      );
      expect(() => parseAndValidateConfig(singleEmptyReviewsYaml, true)).toThrow(
        'CodeRabbit configuration is not a ct-review policy'
      );
    });

    it('parses partial .coderabbit.yaml missing reviews, chat, kb, auto_review, dials', () => {
      const partialYaml = `
language: en-US
tone_instructions: "Be helpful"
`;
      const config = parseAndValidateConfig(partialYaml, true) as any;
      expect(config.version).toBe(3);
      expect(config.reviews.profile).toBe('balanced');
      expect(config.chat.auto_reply).toBe(true);
      expect(config.knowledge_base.learnings).toBe(true);
      expect(config.auto_review.enabled).toBe(true);
      expect(config.dials.confidence_threshold).toBe(70);
    });

    it('handles extreme confidence thresholds 0 and 100 in .coderabbit.yaml', () => {
      const yaml0 = `
reviews:
  confidence_threshold: 0
`;
      const config0 = parseAndValidateConfig(yaml0, true) as any;
      expect(config0.confidence_threshold).toBe(0);
      expect(config0.dials.confidence_threshold).toBe(0);

      const yaml100 = `
dials:
  confidence_threshold: 100
`;
      const config100 = parseAndValidateConfig(yaml100, true) as any;
      expect(config100.confidence_threshold).toBe(100);
      expect(config100.dials.confidence_threshold).toBe(100);
    });

    it('clamps out-of-bounds confidence thresholds (-50 and 150) in .coderabbit.yaml', () => {
      const yamlNegative = `
reviews:
  confidence_threshold: -50
`;
      const configNeg = parseAndValidateConfig(yamlNegative, true) as any;
      expect(configNeg.confidence_threshold).toBe(0);

      const yamlOver = `
dials:
  confidence_threshold: 150
`;
      const configOver = parseAndValidateConfig(yamlOver, true) as any;
      expect(configOver.confidence_threshold).toBe(100);
    });

    it('falls back to default 70 when confidence_threshold is non-numeric in .coderabbit.yaml', () => {
      const invalidTypeYaml = `
reviews:
  confidence_threshold: "very-high"
`;
      const config = parseAndValidateConfig(invalidTypeYaml, true) as any;
      expect(config.confidence_threshold).toBe(70);
    });

    it('accepts and passes custom persona model names in dials.persona_model', () => {
      const customModelYaml = `
dials:
  persona_model: "custom-fine-tuned-claude-v3"
`;
      const config = parseAndValidateConfig(customModelYaml, true) as any;
      expect(config.dials.persona_model).toBe('custom-fine-tuned-claude-v3');
    });

    it('falls back on invalid reviewer_effort and handles non-array path fields in .coderabbit.yaml', () => {
      const invalidTogglesYaml = `
reviews:
  reviewer_effort: "extreme_overdrive"
  path_instructions: "not an array"
path_filters: "not an array"
`;
      const config = parseAndValidateConfig(invalidTogglesYaml, true) as any;
      expect(config.reviewer_effort).toBe('low');
      expect(config.reviews.reviewer_effort).toBe('low');
      expect(config.path_instructions).toEqual([]);
      expect(config.path_filters).toEqual([]);
    });

    it('preserves unknown top-level keys without error in CodeRabbit format', () => {
      const extraKeysYaml = `
unknown_vendor_setting:
  enabled: true
reviews:
  profile: chill
`;
      const config = parseAndValidateConfig(extraKeysYaml, true) as any;
      expect(config.profile).toBe('chill');
    });
  });

  describe('2. Edge Case .ct-review.yaml (V3) Configurations & Schema Validation', () => {
    it('validates extreme confidence thresholds 0 and 100 in .ct-review.yaml V3', () => {
      const makeV3 = (threshold: number) => `
version: 3
profile: balanced
quorum: 1
confidence_threshold: ${threshold}
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      const config0 = parseAndValidateConfig(makeV3(0)) as any;
      expect(config0.confidence_threshold).toBe(0);

      const config100 = parseAndValidateConfig(makeV3(100)) as any;
      expect(config100.confidence_threshold).toBe(100);
    });

    it('rejects out-of-bounds confidence thresholds (-1 and 101) in V3 .ct-review.yaml', () => {
      const makeV3 = (threshold: number) => `
version: 3
profile: balanced
quorum: 1
confidence_threshold: ${threshold}
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(makeV3(-1))).toThrow(ConfigValidationError);
      expect(() => parseAndValidateConfig(makeV3(101))).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when missing required section personas', () => {
      const missingPersonas = `
version: 3
profile: balanced
quorum: 1
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(missingPersonas)).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when missing required section reviewers', () => {
      const missingReviewers = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
`;
      expect(() => parseAndValidateConfig(missingReviewers)).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when missing required section quorum', () => {
      const missingQuorum = `
version: 3
profile: balanced
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(missingQuorum)).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when no required enabled persona exists', () => {
      const noRequiredEnabledPersona = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: sec-lane
    enabled: false
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
  - id: opt-lane
    enabled: true
    required: false
    charter: builtin:correctness
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(noRequiredEnabledPersona)).toThrow(
        'at least one enabled required persona is required'
      );
    });

    it('enforces provider model allowlist in V3 .ct-review.yaml', () => {
      const makeV3WithModel = (model: string) => `
version: 3
profile: balanced
quorum: 1
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: "${model}"
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      // Allowed R4 and V3 models
      for (const allowed of ['claude-5-sonnet', 'gpt-5.6-sol', 'deepseek-v4-pro', 'glm-5.2']) {
        expect(() => parseAndValidateConfig(makeV3WithModel(allowed))).not.toThrow();
      }

      // Unallowed model name
      expect(() => parseAndValidateConfig(makeV3WithModel('unapproved-custom-model'))).toThrow(
        ConfigValidationError
      );
    });

    it('detects duplicate persona IDs and persona referencing disabled provider', () => {
      const dupPersona = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:correctness
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(dupPersona)).toThrow('persona ids must be unique');

      const refDisabledProvider = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [claude]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
    - id: claude
      enabled: false
      model: claude-5-sonnet
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(refDisabledProvider)).toThrow(
        'persona references disabled provider claude'
      );
    });

    it('detects quorum exceeding enabled distinct providers', () => {
      const quorumExceeded = `
version: 3
profile: balanced
quorum: 3
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:security
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(quorumExceeded)).toThrow(
        'quorum exceeds enabled distinct providers'
      );
    });

    it('validates charter formats: builtin vs custom charter minimum length', () => {
      const shortCustomCharter = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: "Too short"
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(shortCustomCharter)).toThrow(ConfigValidationError);

      const invalidBuiltinCharter = `
version: 3
profile: balanced
quorum: 1
personas:
  - id: sec-lane
    enabled: true
    required: true
    charter: builtin:nonexistent_charter
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
      expect(() => parseAndValidateConfig(invalidBuiltinCharter)).toThrow(
        'unknown built-in charter builtin:nonexistent_charter'
      );
    });
  });

  describe('3. Fallback Behavior and Error Handling in loadConfig', () => {
    it('exhaustively tries filename variants .ct-review.yaml -> .ct-review.yml -> ct-review.yaml -> .coderabbit.yaml', async () => {
      const requestedPaths: string[] = [];
      const mockClient = {
        getFileContent: vi.fn().mockImplementation(async (owner: string, repo: string, path: string) => {
          requestedPaths.push(`${owner}/${repo}:${path}`);
          if (path === '.coderabbit.yaml') {
            return `reviews: { profile: chill }`;
          }
          return null;
        }),
      };

      const config = await loadConfig('myorg', 'myrepo', 'main', mockClient);
      expect(config.profile).toBe('chill');
      expect(requestedPaths).toEqual([
        'myorg/myrepo:.ct-review.yaml',
        'myorg/myrepo:.ct-review.yml',
        'myorg/myrepo:ct-review.yaml',
        'myorg/myrepo:.coderabbit.yaml',
      ]);
    });

    it('falls back to .github org repo when target repo has no config files', async () => {
      const requestedPaths: string[] = [];
      const mockClient = {
        getFileContent: vi.fn().mockImplementation(async (owner: string, repo: string, path: string) => {
          requestedPaths.push(`${owner}/${repo}:${path}`);
          if (repo === '.github' && path === '.ct-review.yaml') {
            return `
version: 3
profile: assertive
quorum: 1
personas:
  - id: org-default
    enabled: true
    required: true
    charter: builtin:correctness
    paths: ["**"]
    providers: [codex]
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: codex
      enabled: true
      model: codex/gpt-5.6-sol-high
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
          }
          return null;
        }),
      };

      const config = await loadConfig('myorg', 'app-repo', 'main', mockClient);
      expect(config.profile).toBe('assertive');
      expect(requestedPaths).toContain('myorg/.github:.ct-review.yaml');
    });

    it('returns default V3 config when no config file exists anywhere', async () => {
      const mockClient = {
        getFileContent: vi.fn().mockResolvedValue(null),
      };

      const config = await loadConfig('myorg', 'app-repo', 'main', mockClient);
      const defaultConfig = createDefaultV3Config();
      expect(config.version).toBe(3);
      expect(config.profile).toBe(defaultConfig.profile);
      expect(config.personas).toHaveLength(defaultConfig.personas.length);
    });

    it('bubbles up ConfigValidationError when remote config contains YAML syntax errors', async () => {
      const mockClient = {
        getFileContent: vi.fn().mockResolvedValue(`
version: 3
profile: [invalid syntax tab
`),
      };

      await expect(loadConfig('myorg', 'myrepo', 'main', mockClient)).rejects.toThrow(
        ConfigValidationError
      );
    });

    it('translates legacy version 1 config to V3 format', async () => {
      const mockClient = {
        getFileContent: vi.fn().mockResolvedValue(`
version: 1
profile: chill
reviewer_effort: low
confidence_threshold: 80
mascot: false
`),
      };

      const config = await loadConfig('myorg', 'myrepo', 'main', mockClient);
      expect(config.version).toBe(3);
      expect(config.profile).toBe('chill');
      expect(config.reviewer_effort).toBe('low');
      expect(config.confidence_threshold).toBe(80);
      expect(config.mascot).toBe(false);
    });
  });
});
