import { describe, it, expect } from 'vitest';
import {
  preChecksSchema,
  zoektPreCheckSchema,
  analyzersPreCheckSchema,
  resolvePreChecksConfig,
  ctReviewConfigV3Schema,
  ctReviewConfigV4Schema,
  PreChecksConfig,
  BANNED_MODELS,
  isBannedModel,
} from '../../src/config/schema';
import {
  createDefaultV3Config,
  createDefaultV4Config,
  parseAndValidateConfig,
  ConfigValidationError,
} from '../../src/config/configLoader';
import { ConfigResolver } from '../../src/config/configResolver';

function createValidV3Yaml(preChecksSnippet: string = ''): string {
  return `
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
    - id: claude
      enabled: true
      model: claude-5-sonnet
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [claude]
${preChecksSnippet}
`;
}

describe('schema.test.ts — Pre-Checks Configuration Schema & GitOps Tests', () => {

  // =========================================================================
  // SUITE 1: ZOD SCHEMA PARSING & DEFAULT-ON VALUES
  // =========================================================================
  describe('Suite 1: Zod Schema Default-On Values', () => {
    it('1.1: zoektPreCheckSchema applies default values (enabled: true, max_symbols: 200, timeoutMs: 10000)', () => {
      const parsed = zoektPreCheckSchema.parse({});
      expect(parsed.enabled).toBe(true);
      expect(parsed.max_symbols).toBe(200);
      expect(parsed.timeoutMs).toBe(10000);
      expect(parsed.indexDir).toBeUndefined();
    });

    it('1.2: analyzersPreCheckSchema applies default values (all enabled: true)', () => {
      const parsed = analyzersPreCheckSchema.parse({});
      expect(parsed.enabled).toBe(true);
      expect(parsed.linters).toBe(true);
      expect(parsed.security).toBe(true);
      expect(parsed.secrets).toBe(true);
    });

    it('1.3: preChecksSchema defaults to enabled with nested defaults on empty object', () => {
      const parsed = preChecksSchema.parse({});
      expect(parsed.enabled).toBe(true);
      expect(parsed.zoekt.enabled).toBe(true);
      expect(parsed.zoekt.max_symbols).toBe(200);
      expect(parsed.analyzers.enabled).toBe(true);
      expect(parsed.analyzers.linters).toBe(true);
      expect(parsed.analyzers.security).toBe(true);
      expect(parsed.analyzers.secrets).toBe(true);
    });

    it('1.4: resolvePreChecksConfig returns full default-on config when input is undefined or null', () => {
      const resNull = resolvePreChecksConfig(null);
      expect(resNull.enabled).toBe(true);
      expect(resNull.zoekt.enabled).toBe(true);
      expect(resNull.analyzers.enabled).toBe(true);

      const resUndef = resolvePreChecksConfig({});
      expect(resUndef.enabled).toBe(true);
      expect(resUndef.zoekt.max_symbols).toBe(200);
    });
  });

  // =========================================================================
  // SUITE 2: EXPLICIT OVERRIDES & SELECTIVE DISABLING
  // =========================================================================
  describe('Suite 2: Explicit Overrides & Cascading Disablement', () => {
    it('2.1: pre_checks: false disables top-level and cascades to zoekt and analyzers', () => {
      const parsed = preChecksSchema.parse(false);
      expect(parsed.enabled).toBe(false);
      expect(parsed.zoekt.enabled).toBe(false);
      expect(parsed.analyzers.enabled).toBe(false);
    });

    it('2.2: pre_checks: { enabled: false } disables all pre-checks', () => {
      const parsed = preChecksSchema.parse({ enabled: false });
      expect(parsed.enabled).toBe(false);
      expect(parsed.zoekt.enabled).toBe(false);
      expect(parsed.analyzers.enabled).toBe(false);
    });

    it('2.3: pre_checks: { zoekt: false } disables Zoekt while preserving analyzers default-on', () => {
      const parsed = preChecksSchema.parse({ zoekt: false });
      expect(parsed.enabled).toBe(true);
      expect(parsed.zoekt.enabled).toBe(false);
      expect(parsed.analyzers.enabled).toBe(true);
      expect(parsed.analyzers.security).toBe(true);
    });

    it('2.4: selective analyzer disabling preserves other analyzers and Zoekt', () => {
      const parsed = preChecksSchema.parse({
        analyzers: {
          security: false,
        },
      });
      expect(parsed.enabled).toBe(true);
      expect(parsed.zoekt.enabled).toBe(true);
      expect(parsed.analyzers.enabled).toBe(true);
      expect(parsed.analyzers.security).toBe(false);
      expect(parsed.analyzers.linters).toBe(true);
      expect(parsed.analyzers.secrets).toBe(true);
    });

    it('2.5: custom max_symbols and timeoutMs override defaults cleanly', () => {
      const parsed = preChecksSchema.parse({
        zoekt: {
          max_symbols: 50,
          timeoutMs: 15000,
          indexDir: '/custom/zoekt/index',
        },
      });
      expect(parsed.zoekt.max_symbols).toBe(50);
      expect(parsed.zoekt.timeoutMs).toBe(15000);
      expect(parsed.zoekt.indexDir).toBe('/custom/zoekt/index');
      expect(parsed.zoekt.enabled).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 3: CONFIG LOADER & DEFAULT CONFIG INTEGRATION
  // =========================================================================
  describe('Suite 3: Config Loader Default Generators & YAML Parsing', () => {
    it('3.1: createDefaultV3Config() includes default-on pre_checks', () => {
      const v3 = createDefaultV3Config();
      expect(v3.pre_checks).toBeDefined();
      expect(v3.pre_checks?.enabled).toBe(true);
      expect(v3.pre_checks?.zoekt.enabled).toBe(true);
      expect(v3.pre_checks?.zoekt.max_symbols).toBe(200);
      expect(v3.pre_checks?.analyzers.enabled).toBe(true);
    });

    it('3.2: createDefaultV4Config() includes default-on pre_checks', () => {
      const v4 = createDefaultV4Config();
      expect((v4 as any).pre_checks).toBeDefined();
      expect((v4 as any).pre_checks?.enabled).toBe(true);
    });

    it('3.3: parseAndValidateConfig defaults pre_checks to enabled when omitted in YAML', () => {
      const yaml = createValidV3Yaml();
      const config = parseAndValidateConfig(yaml);
      const preChecks = (config as any).pre_checks as PreChecksConfig;
      expect(preChecks).toBeDefined();
      expect(preChecks?.enabled).toBe(true);
      expect(preChecks?.zoekt.enabled).toBe(true);
      expect(preChecks?.zoekt.max_symbols).toBe(200);
    });

    it('3.4: parseAndValidateConfig respects YAML pre_checks override', () => {
      const yaml = createValidV3Yaml(`
pre_checks:
  enabled: true
  zoekt:
    enabled: true
    max_symbols: 10
  analyzers:
    security: false
`);
      const config = parseAndValidateConfig(yaml);
      const preChecks = (config as any).pre_checks as PreChecksConfig;
      expect(preChecks?.zoekt.max_symbols).toBe(10);
      expect(preChecks?.analyzers.security).toBe(false);
      expect(preChecks?.analyzers.linters).toBe(true);
    });
  });

  // =========================================================================
  // SUITE 4: 3-TIER CONFIG RESOLUTION & DEEP MERGING
  // =========================================================================
  describe('Suite 4: 3-Tier ConfigResolver Merging (System < Org < Repo)', () => {
    it('4.1: deep merges partial repo-level override over org-level defaults', async () => {
      const resolver = new ConfigResolver();

      const sys = {
        enabled: true,
        zoekt: { enabled: true, max_symbols: 25, timeoutMs: 5000 },
        analyzers: { enabled: true, linters: true, security: true, secrets: true },
      };
      const org = {
        zoekt: { max_symbols: 30 },
      };
      const repo = {
        zoekt: { timeoutMs: 10000 },
        analyzers: { secrets: false },
      };

      const merged = (resolver as any).mergePreChecks(sys, org, repo);

      expect(merged.enabled).toBe(true);
      expect(merged.zoekt.max_symbols).toBe(30); // Inherited from Org
      expect(merged.zoekt.timeoutMs).toBe(10000); // Overridden by Repo
      expect(merged.analyzers.secrets).toBe(false); // Overridden by Repo
      expect(merged.analyzers.linters).toBe(true); // Retained from System
    });

    it('4.2: repo-level pre_checks: false disables pre-checks regardless of org/system', async () => {
      const resolver = new ConfigResolver();

      const sys = { enabled: true, zoekt: { enabled: true, max_symbols: 25 }, analyzers: { enabled: true } };
      const org = { enabled: true };
      const repo = false;

      const merged = (resolver as any).mergePreChecks(sys, org, repo);

      expect(merged.enabled).toBe(false);
      expect(merged.zoekt.enabled).toBe(false);
      expect(merged.analyzers.enabled).toBe(false);
    });
  });

  // =========================================================================
  // SUITE 5: NEGATIVE VALUE & TYPE ERROR REJECTION
  // =========================================================================
  describe('Suite 5: Negative Value & Type Error Rejection', () => {
    it('5.1: rejects negative max_symbols', () => {
      expect(() => zoektPreCheckSchema.parse({ max_symbols: -5 })).toThrow();
    });

    it('5.2: rejects zero max_symbols', () => {
      expect(() => zoektPreCheckSchema.parse({ max_symbols: 0 })).toThrow();
    });

    it('5.3: rejects non-integer max_symbols', () => {
      expect(() => zoektPreCheckSchema.parse({ max_symbols: 12.5 })).toThrow();
    });

    it('5.4: rejects negative timeoutMs', () => {
      expect(() => zoektPreCheckSchema.parse({ timeoutMs: -1000 })).toThrow();
    });

    it('5.5: rejects non-boolean flags in analyzersPreCheckSchema', () => {
      expect(() => analyzersPreCheckSchema.parse({ linters: 'yes' as any })).toThrow();
      expect(() => analyzersPreCheckSchema.parse({ security: 1 as any })).toThrow();
    });

    it('5.6: parseAndValidateConfig throws ConfigValidationError on invalid pre_checks values', () => {
      const badYaml = createValidV3Yaml(`
pre_checks:
  zoekt:
    max_symbols: -10
`);
      expect(() => parseAndValidateConfig(badYaml)).toThrow(ConfigValidationError);
    });
  });

  // =========================================================================
  // SUITE 6: BANNED MODELS VALIDATION & ENFORCEMENT
  // =========================================================================
  describe('Suite 6: Banned Models Validation & Enforcement', () => {
    it('6.1: isBannedModel correctly flags all specified banned models', () => {
      // Claude 3.5 Sonnet variants
      expect(isBannedModel('claude-3.5-sonnet')).toBe(true);
      expect(isBannedModel('claude-3-5-sonnet')).toBe(true);
      expect(isBannedModel('anthropic/claude-3.5-sonnet')).toBe(true);
      expect(isBannedModel('openrouter/anthropic/claude-3.5-sonnet')).toBe(true);

      // Claude 3.7 Sonnet variants
      expect(isBannedModel('claude-3.7-sonnet')).toBe(true);
      expect(isBannedModel('claude-3-7-sonnet')).toBe(true);
      expect(isBannedModel('anthropic/claude-3.7-sonnet')).toBe(true);
      expect(isBannedModel('openrouter/anthropic/claude-3.7-sonnet')).toBe(true);

      // GPT-4o variants
      expect(isBannedModel('gpt-4o')).toBe(true);
      expect(isBannedModel('gpt-4o-mini')).toBe(true);
      expect(isBannedModel('openai/gpt-4o')).toBe(true);
      expect(isBannedModel('openai/gpt-4o-mini')).toBe(true);
      expect(isBannedModel('openrouter/openai/gpt-4o')).toBe(true);

      // GLM-4 variants
      expect(isBannedModel('glm-4')).toBe(true);
      expect(isBannedModel('glm-4.7')).toBe(true);
      expect(isBannedModel('GLM-4.7-Flash')).toBe(true);
      expect(isBannedModel('synthetic/hf:zai-org/GLM-4.7-Flash')).toBe(true);

      // Non-banned models pass
      expect(isBannedModel('glm-5.2')).toBe(false);
      expect(isBannedModel('claude-5-sonnet')).toBe(false);
      expect(isBannedModel('claude-opus-4-8')).toBe(false);
      expect(isBannedModel('gpt-5.6-sol')).toBe(false);
      expect(isBannedModel('deepseek-v4-pro')).toBe(false);
    });

    it('6.2: parseAndValidateConfig rejects persona with banned model', () => {
      const yaml = `
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
    model: gpt-4o
reviewers:
  execution: personas
  fallback: ordered
  overall_timeout_s: 60
  providers:
    - id: claude
      enabled: true
      model: claude-5-sonnet
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [claude]
`;
      expect(() => parseAndValidateConfig(yaml)).toThrow(ConfigValidationError);
    });

    it('6.3: parseAndValidateConfig rejects provider with banned model', () => {
      const yaml = `
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
    - id: claude
      enabled: true
      model: claude-3-5-sonnet
      effort: high
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [claude]
`;
      expect(() => parseAndValidateConfig(yaml)).toThrow(ConfigValidationError);
    });
  });
});
