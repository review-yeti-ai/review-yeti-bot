import { describe, expect, it, vi } from 'vitest';
import { parseAndValidateConfig, loadConfig, translateCodeRabbitToV3 } from '../../src/config/configLoader';
import { ctReviewConfigV3Schema, ASCII_MASCOT } from '../../src/config/schema';
import { formatInlineCommentBody, ASCII_MASCOT as PUBLISHER_MASCOT } from '../../src/github/commentPublisher';

describe('Milestone 4: Dual YAML Compatibility & Config Dials', () => {
  describe('Dual YAML Parsing & CodeRabbit Translation', () => {
    it('parses .ct-review.yaml V3 policy cleanly', () => {
      const yamlContent = `
version: 3
profile: assertive
quorum: 1
personas:
  - id: correctness
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
confidence_threshold: 85
mascot: true
`;
      const config = parseAndValidateConfig(yamlContent);
      expect(config.version).toBe(3);
      expect((config as any).profile).toBe('assertive');
      expect((config as any).confidence_threshold).toBe(85);
      expect((config as any).mascot).toBe(true);
    });

    it('parses and translates .coderabbit.yaml format without error rejection', () => {
      const codeRabbitYaml = `
language: en-US
tone_instructions: "Be helpful and concise."
reviews:
  profile: chill
  reviewer_effort: low
  confidence_threshold: 80
  mascot: false
  path_instructions:
    - path: "src/**/*.ts"
      instructions: "Check TypeScript types"
`;
      const config = parseAndValidateConfig(codeRabbitYaml, true);
      expect(config.version).toBe(3);
      expect((config as any).profile).toBe('chill');
      expect((config as any).reviewer_effort).toBe('low');
      expect((config as any).confidence_threshold).toBe(80);
      expect((config as any).mascot).toBe(false);
      expect((config as any).path_instructions).toHaveLength(1);
    });
  });

  describe('Org-Level Inheritance (loadConfig)', () => {
    it('falls back through precedence order in loadConfig', async () => {
      const mockClient = {
        getFileContent: vi.fn(),
      };

      // 1. Repo .ct-review.yaml exists
      mockClient.getFileContent.mockImplementation(async (_owner, _repo, path) => {
        if (path === '.ct-review.yaml') {
          return `
version: 3
profile: balanced
quorum: 1
personas:
  - id: test-p
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
      effort: medium
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [codex]
`;
        }
        return null;
      });

      const config1 = await loadConfig('myorg', 'myrepo', 'feature-branch', mockClient);
      expect(config1.version).toBe(3);
      expect(mockClient.getFileContent).toHaveBeenCalledWith('myorg', 'myrepo', '.ct-review.yaml', 'feature-branch');

      // 2. Repo .ct-review.yaml missing, .coderabbit.yaml exists
      mockClient.getFileContent.mockReset();
      mockClient.getFileContent.mockImplementation(async (_owner, _repo, path) => {
        if (path === '.coderabbit.yaml') {
          return `reviews: { profile: chill }`;
        }
        return null;
      });

      const config2 = await loadConfig('myorg', 'myrepo', 'feature-branch', mockClient);
      expect(config2.version).toBe(3);
      expect(config2.profile).toBe('chill');

      // 3. Both repo configs missing, org .github/.ct-review.yaml exists
      mockClient.getFileContent.mockReset();
      mockClient.getFileContent.mockImplementation(async (owner, repo, path) => {
        if (owner === 'myorg' && repo === '.github' && path === '.ct-review.yaml') {
          return `
version: 3
profile: assertive
quorum: 1
personas:
  - id: test-p
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
      });

      const config3 = await loadConfig('myorg', 'myrepo', 'feature-branch', mockClient);
      expect(config3.profile).toBe('assertive');

      // 4. All missing, falls back to default config
      mockClient.getFileContent.mockReset();
      mockClient.getFileContent.mockResolvedValue(null);

      const config4 = await loadConfig('myorg', 'myrepo', 'feature-branch', mockClient);
      expect(config4.version).toBe(3);
      expect(config4.personas).toBeDefined();
    });
  });

  describe('Config Schema Model Allowlist & Dials', () => {
    it('accepts R4 models (claude-5-sonnet, gpt-5.6-sol, deepseek-v4-pro, glm-5.2)', () => {
      const makeConfigWithModel = (modelName: string) => `
version: 3
profile: balanced
quorum: 1
personas:
  - id: test-persona
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
      model: "${modelName}"
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [codex]
`;

      for (const model of ['claude-5-sonnet', 'gpt-5.6-sol', 'deepseek-v4-pro', 'glm-5.2']) {
        const parsed = parseAndValidateConfig(makeConfigWithModel(model));
        expect(parsed.version).toBe(3);
      }
    });

    it('formats inline comment body with ASCII mascot when toggle enabled', () => {
      const finding = {
        persona: 'security',
        severity: 'P1' as const,
        filePath: 'src/app.ts',
        lineNumber: 10,
        comment: 'Check input sanitization',
      };

      const bodyWithMascot = formatInlineCommentBody(finding, { mascot: true });
      expect(bodyWithMascot).toContain(PUBLISHER_MASCOT);
      expect(bodyWithMascot).toContain('Check input sanitization');

      const bodyWithoutMascot = formatInlineCommentBody(finding, { mascot: false });
      expect(bodyWithoutMascot).not.toContain(PUBLISHER_MASCOT);
    });

    it('parses all 6 top-level CodeRabbit sections and resolves toggle fallbacks', () => {
      const fullYaml = `
reviews:
  profile: assertive
  reviewer_effort: high
  confidence_threshold: 85
  mascot: true
  ticket_enforcement: true
  request_changes_workflow: true
  poem: false
chat:
  auto_reply: true
  max_context_turns: 15
  art_mascot_response: true
knowledge_base:
  learnings: true
  issues: true
  pull_requests: false
  custom_instructions:
    - "Prefer functional components"
path_filters:
  - "!dist/**"
  - "!.apm/**"
auto_review:
  enabled: true
  ignore_drafts: true
  labels:
    - "review-me"
dials:
  memory_engine: false
  mascot: false
  confidence_threshold: 90
  ticket_enforcement: true
  persona_model: claude-5-sonnet
`;
      const config = parseAndValidateConfig(fullYaml, true) as any;
      expect(config.version).toBe(3);
      expect(config.reviews.profile).toBe('assertive');
      expect(config.reviews.reviewer_effort).toBe('high');
      expect(config.reviews.request_changes_workflow).toBe(true);
      expect(config.chat.max_context_turns).toBe(15);
      expect(config.knowledge_base.custom_instructions).toContain('Prefer functional components');
      expect(config.path_filters).toEqual(['!dist/**', '!.apm/**']);
      expect(config.auto_review.labels).toEqual(['review-me']);

      // Check dials toggle overriding section fallbacks
      expect(config.dials.memory_engine).toBe(false);
      expect(config.dials.mascot).toBe(false);
      expect(config.dials.confidence_threshold).toBe(90);
      expect(config.dials.ticket_enforcement).toBe(true);
      expect(config.dials.persona_model).toBe('claude-5-sonnet');
      expect(config.mascot).toBe(false);
      expect(config.confidence_threshold).toBe(90);
    });

    it('cascades toggle fallbacks from reviews and knowledge_base when dials are omitted', () => {
      const yamlWithoutDials = `
reviews:
  mascot: false
  confidence_threshold: 65
  ticket_enforcement: true
knowledge_base:
  learnings: false
`;
      const config = parseAndValidateConfig(yamlWithoutDials, true) as any;
      expect(config.dials.memory_engine).toBe(false);
      expect(config.dials.mascot).toBe(false);
      expect(config.dials.confidence_threshold).toBe(65);
      expect(config.dials.ticket_enforcement).toBe(true);
    });
  });
});
