import { describe, it, expect } from 'vitest';
import {
  mcpItemSchema,
  mcpsSchema,
  onPRCloseSchema,
  ctReviewConfigV3Schema,
} from '../../src/config/schema';
import { codeRabbitRawSchema } from '../../src/config/codeRabbitSchema';
import {
  createDefaultV3Config,
  translateCodeRabbitToV3,
  parseAndValidateConfig,
} from '../../src/config/configLoader';

describe('Milestone 18: Schema Extensions & Config Loader', () => {
  describe('mcpItemSchema & mcpsSchema', () => {
    it('validates single mcp item with defaults', () => {
      const parsed = mcpItemSchema.parse({ name: 'context7' });
      expect(parsed).toEqual({ name: 'context7', enabled: true });
    });

    it('validates mcp item with custom options', () => {
      const parsed = mcpItemSchema.parse({ name: 'productlane', enabled: false, options: { verbose: true } });
      expect(parsed).toEqual({ name: 'productlane', enabled: false, options: { verbose: true } });
    });

    it('rejects empty name in mcpItemSchema', () => {
      expect(() => mcpItemSchema.parse({ name: '' })).toThrow();
    });

    it('validates mcpsSchema array', () => {
      const parsed = mcpsSchema.parse([
        { name: 'context7' },
        { name: 'productlane', enabled: true },
      ]);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('context7');
    });
  });

  describe('onPRCloseSchema', () => {
    it('provides defaults for empty input', () => {
      const parsed = onPRCloseSchema.parse({});
      expect(parsed).toEqual({
        create_followup_prs: [],
        sync_productlane: false,
      });
    });

    it('parses complete on_pr_close configuration', () => {
      const input = {
        create_followup_prs: ['docs', 'marketing'],
        sync_linear_status: 'Done',
        sync_productlane: true,
      };
      const parsed = onPRCloseSchema.parse(input);
      expect(parsed).toEqual({
        create_followup_prs: ['docs', 'marketing'],
        sync_linear_status: 'Done',
        sync_productlane: true,
      });
    });
  });

  describe('ctReviewConfigV3Schema Extensions', () => {
    it('includes mcps and on_pr_close in default V3 config validation', () => {
      const defaultConfig = createDefaultV3Config();
      const parsed = ctReviewConfigV3Schema.parse(defaultConfig);
      expect(parsed.mcps).toEqual([]);
      expect(parsed.on_pr_close).toEqual({
        create_followup_prs: [],
        sync_productlane: false,
      });
    });

    it('parses YAML config with mcps and on_pr_close via parseAndValidateConfig', () => {
      const yaml = `
version: 3
profile: "balanced"
quorum: 1
personas:
  - id: "sec-lane"
    enabled: true
    required: true
    charter: "builtin:correctness"
    paths: ["**"]
    providers: ["codex"]
reviewers:
  execution: "personas"
  fallback: "ordered"
  overall_timeout_s: 60
  providers:
    - id: "codex"
      enabled: true
      model: "codex/gpt-5.6-sol-high"
      effort: "max"
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: ["codex"]

mcps:
  - name: "context7"
    enabled: true
  - name: "productlane"
    enabled: true

on_pr_close:
  create_followup_prs: ["docs", "marketing"]
  sync_linear_status: "Done"
  sync_productlane: true
`;
      const config = parseAndValidateConfig(yaml) as any;
      expect(config.version).toBe(3);
      expect(config.mcps).toHaveLength(2);
      expect(config.mcps[0].name).toBe('context7');
      expect(config.on_pr_close.create_followup_prs).toEqual(['docs', 'marketing']);
      expect(config.on_pr_close.sync_linear_status).toBe('Done');
      expect(config.on_pr_close.sync_productlane).toBe(true);
    });
  });

  describe('codeRabbitSchema & Translation', () => {
    it('validates raw CodeRabbit schema containing mcps and onPrClose', () => {
      const raw = {
        reviews: { profile: 'assertive' },
        mcps: [{ name: 'context7', enabled: true }],
        onPrClose: {
          createFollowupPrs: ['docs'],
          syncLinearStatus: 'Done',
          syncProductlane: true,
        },
      };
      const parsed = codeRabbitRawSchema.parse(raw);
      expect(parsed.mcps).toHaveLength(1);
      expect(parsed.onPrClose).toBeDefined();
    });

    it('translates CodeRabbit config with camelCase onPrClose to V3 snake_case on_pr_close', () => {
      const raw = {
        reviews: { profile: 'assertive' },
        mcps: [{ name: 'context7', enabled: true }],
        onPrClose: {
          createFollowupPrs: ['docs', 'marketing'],
          syncLinearStatus: 'In Review',
          syncProductlane: true,
        },
      };
      const translated = translateCodeRabbitToV3(raw);
      expect(translated.mcps).toEqual([{ name: 'context7', enabled: true }]);
      expect(translated.on_pr_close).toEqual({
        create_followup_prs: ['docs', 'marketing'],
        sync_linear_status: 'In Review',
        sync_productlane: true,
      });
    });
  });
});
