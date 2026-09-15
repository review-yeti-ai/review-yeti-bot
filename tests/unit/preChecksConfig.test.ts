import { describe, it, expect } from 'vitest';
import {
  zoektPreCheckSchema,
  analyzersPreCheckSchema,
  preChecksSchema,
  ctReviewConfigV3Schema,
  ctReviewConfigV4Schema,
  PreChecksConfig,
} from '../../src/config/schema';
import {
  createDefaultV3Config,
  createDefaultV4Config,
  parseAndValidateConfig,
  translateCodeRabbitToV3,
  translateLegacyConfigToV3,
  ConfigValidationError,
} from '../../src/config/configLoader';
import { ConfigResolver, RepositoryContentClient } from '../../src/config/configResolver';

// Helper to generate a minimal valid Version 3 YAML configuration
function createBaseV3Yaml(preChecksSection: string = ''): string {
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
${preChecksSection}
`;
}

// Helper to generate a minimal valid Version 4 YAML configuration
function createBaseV4Yaml(preChecksSection: string = ''): string {
  return `
version: 4
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
${preChecksSection}
`;
}

// Mock repository content client helper
const mockClient = (files: Record<string, string>): RepositoryContentClient => ({
  getFileContent: async (_owner: string, _repo: string, path: string) => {
    return files[path] || null;
  },
});

describe('preChecksConfig.test.ts — Milestone 2 Unit Test Suite', () => {

  // ===========================================================================
  // SUITE 1: DIRECT ZOD SCHEMA VALIDATION
  // ===========================================================================
  describe('Suite 1: Direct Zod Schema Validation', () => {
    describe('zoektPreCheckSchema', () => {
      it('1.1: applies default values (enabled: true, max_symbols: 200, timeoutMs: 10000) on empty input', () => {
        const parsed = zoektPreCheckSchema.parse({});
        expect(parsed.enabled).toBe(true);
        expect(parsed.max_symbols).toBe(200);
        expect(parsed.timeoutMs).toBe(10000);
        expect(parsed.indexDir).toBeUndefined();
      });

      it('1.2: accepts valid custom overrides', () => {
        const parsed = zoektPreCheckSchema.parse({
          enabled: false,
          max_symbols: 50,
          timeoutMs: 10000,
          indexDir: '/data/zoekt-index',
        });
        expect(parsed.enabled).toBe(false);
        expect(parsed.max_symbols).toBe(50);
        expect(parsed.timeoutMs).toBe(10000);
        expect(parsed.indexDir).toBe('/data/zoekt-index');
      });

      it('1.3: rejects negative max_symbols', () => {
        expect(() => zoektPreCheckSchema.parse({ max_symbols: -5 })).toThrow();
      });

      it('1.4: rejects zero max_symbols', () => {
        expect(() => zoektPreCheckSchema.parse({ max_symbols: 0 })).toThrow();
      });

      it('1.5: rejects floating-point max_symbols', () => {
        expect(() => zoektPreCheckSchema.parse({ max_symbols: 10.5 })).toThrow();
      });

      it('1.6: rejects non-numeric max_symbols (e.g. string "25")', () => {
        expect(() => zoektPreCheckSchema.parse({ max_symbols: '25' as any })).toThrow();
      });

      it('1.7: rejects non-boolean enabled flag', () => {
        expect(() => zoektPreCheckSchema.parse({ enabled: 'yes' as any })).toThrow();
        expect(() => zoektPreCheckSchema.parse({ enabled: 1 as any })).toThrow();
      });

      it('1.8: rejects negative or zero timeoutMs', () => {
        expect(() => zoektPreCheckSchema.parse({ timeoutMs: -100 })).toThrow();
        expect(() => zoektPreCheckSchema.parse({ timeoutMs: 0 })).toThrow();
      });
    });

    describe('analyzersPreCheckSchema', () => {
      it('1.9: applies default values (enabled, linters, security, secrets all true) on empty input', () => {
        const parsed = analyzersPreCheckSchema.parse({});
        expect(parsed.enabled).toBe(true);
        expect(parsed.linters).toBe(true);
        expect(parsed.security).toBe(true);
        expect(parsed.secrets).toBe(true);
      });

      it('1.10: accepts granular category overrides', () => {
        const parsed = analyzersPreCheckSchema.parse({
          enabled: true,
          linters: false,
          security: true,
          secrets: false,
        });
        expect(parsed.enabled).toBe(true);
        expect(parsed.linters).toBe(false);
        expect(parsed.security).toBe(true);
        expect(parsed.secrets).toBe(false);
      });

      it('1.11: rejects non-boolean flags for category switches', () => {
        expect(() => analyzersPreCheckSchema.parse({ linters: 'false' as any })).toThrow();
        expect(() => analyzersPreCheckSchema.parse({ security: 0 as any })).toThrow();
        expect(() => analyzersPreCheckSchema.parse({ secrets: null as any })).toThrow();
      });
    });

    describe('preChecksSchema', () => {
      it('1.12: applies full default configuration on empty object', () => {
        const parsed = preChecksSchema.parse({});
        expect(parsed.enabled).toBe(true);
        expect(parsed.zoekt.enabled).toBe(true);
        expect(parsed.zoekt.max_symbols).toBe(200);
        expect(parsed.analyzers.enabled).toBe(true);
        expect(parsed.analyzers.linters).toBe(true);
        expect(parsed.analyzers.security).toBe(true);
        expect(parsed.analyzers.secrets).toBe(true);
      });

      it('1.13: preserves nested defaults when partial subsystem override is provided', () => {
        const parsed = preChecksSchema.parse({
          zoekt: { max_symbols: 10 },
          analyzers: { secrets: false },
        });
        expect(parsed.enabled).toBe(true);
        expect(parsed.zoekt.enabled).toBe(true);
        expect(parsed.zoekt.max_symbols).toBe(10);
        expect(parsed.analyzers.enabled).toBe(true);
        expect(parsed.analyzers.linters).toBe(true);
        expect(parsed.analyzers.secrets).toBe(false);
      });

      it('1.14: rejects invalid root enabled flag', () => {
        expect(() => preChecksSchema.parse({ enabled: 'disabled' as any })).toThrow();
      });
    });
  });

  // ===========================================================================
  // SUITE 2: CONFIG LOADER & YAML PARSING
  // ===========================================================================
  describe('Suite 2: Config Loader & YAML Parsing', () => {
    it('2.1: createDefaultV3Config() includes complete default-on pre_checks configuration', () => {
      const config: any = createDefaultV3Config();
      expect(config.pre_checks).toBeDefined();
      expect(config.pre_checks.enabled).toBe(true);
      expect(config.pre_checks.zoekt.enabled).toBe(true);
      expect(config.pre_checks.zoekt.max_symbols).toBe(200);
      expect(config.pre_checks.zoekt.timeoutMs).toBe(10000);
      expect(config.pre_checks.analyzers.enabled).toBe(true);
      expect(config.pre_checks.analyzers.linters).toBe(true);
      expect(config.pre_checks.analyzers.security).toBe(true);
      expect(config.pre_checks.analyzers.secrets).toBe(true);
    });

    it('2.2: createDefaultV4Config() includes complete default-on pre_checks configuration', () => {
      const config: any = createDefaultV4Config();
      expect(config.pre_checks).toBeDefined();
      expect(config.pre_checks.enabled).toBe(true);
      expect(config.pre_checks.zoekt.enabled).toBe(true);
      expect(config.pre_checks.analyzers.secrets).toBe(true);
    });

    it('2.3: parseAndValidateConfig() resolves default-on pre_checks when omitted in Version 3 YAML', () => {
      const yamlStr = createBaseV3Yaml();
      const config: any = parseAndValidateConfig(yamlStr);
      expect(config.pre_checks).toBeDefined();
      expect(config.pre_checks.enabled).toBe(true);
      expect(config.pre_checks.zoekt.enabled).toBe(true);
      expect(config.pre_checks.zoekt.max_symbols).toBe(200);
      expect(config.pre_checks.analyzers.enabled).toBe(true);
      expect(config.pre_checks.analyzers.linters).toBe(true);
      expect(config.pre_checks.analyzers.security).toBe(true);
      expect(config.pre_checks.analyzers.secrets).toBe(true);
    });

    it('2.4: parseAndValidateConfig() resolves default-on pre_checks when omitted in Version 4 YAML', () => {
      const yamlStr = createBaseV4Yaml();
      const config: any = parseAndValidateConfig(yamlStr);
      expect(config.pre_checks).toBeDefined();
      expect(config.pre_checks.enabled).toBe(true);
      expect(config.pre_checks.zoekt.enabled).toBe(true);
      expect(config.pre_checks.analyzers.secrets).toBe(true);
    });

    it('2.5: parseAndValidateConfig() respects explicit master disable override (pre_checks.enabled: false)', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks:
  enabled: false
`);
      const config: any = parseAndValidateConfig(yamlStr);
      expect(config.pre_checks.enabled).toBe(false);
    });

    it('2.6: parseAndValidateConfig() respects granular zoekt.enabled: false while preserving analyzers', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks:
  enabled: true
  zoekt:
    enabled: false
  analyzers:
    enabled: true
`);
      const config: any = parseAndValidateConfig(yamlStr);
      expect(config.pre_checks.enabled).toBe(true);
      expect(config.pre_checks.zoekt.enabled).toBe(false);
      expect(config.pre_checks.analyzers.enabled).toBe(true);
      expect(config.pre_checks.analyzers.secrets).toBe(true);
    });

    it('2.7: parseAndValidateConfig() respects custom zoekt symbol budget (max_symbols: 10)', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks:
  zoekt:
    max_symbols: 10
`);
      const config: any = parseAndValidateConfig(yamlStr);
      expect(config.pre_checks.zoekt.max_symbols).toBe(10);
      expect(config.pre_checks.zoekt.enabled).toBe(true);
    });

    it('2.8: parseAndValidateConfig() respects granular analyzer category switches (linters, security, secrets)', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks:
  analyzers:
    linters: false
    security: true
    secrets: false
`);
      const config: any = parseAndValidateConfig(yamlStr);
      expect(config.pre_checks.analyzers.linters).toBe(false);
      expect(config.pre_checks.analyzers.security).toBe(true);
      expect(config.pre_checks.analyzers.secrets).toBe(false);
      expect(config.pre_checks.analyzers.enabled).toBe(true);
    });

    it('2.9: parseAndValidateConfig() respects analyzers.enabled: false while preserving zoekt', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks:
  zoekt:
    enabled: true
  analyzers:
    enabled: false
`);
      const config: any = parseAndValidateConfig(yamlStr);
      expect(config.pre_checks.zoekt.enabled).toBe(true);
      expect(config.pre_checks.analyzers.enabled).toBe(false);
    });

    it('2.10: parseAndValidateConfig() throws ConfigValidationError on negative max_symbols in YAML', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks:
  zoekt:
    max_symbols: -5
`);
      expect(() => parseAndValidateConfig(yamlStr)).toThrow(ConfigValidationError);
    });

    it('2.11: parseAndValidateConfig() throws ConfigValidationError on zero max_symbols in YAML', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks:
  zoekt:
    max_symbols: 0
`);
      expect(() => parseAndValidateConfig(yamlStr)).toThrow(ConfigValidationError);
    });

    it('2.12: parseAndValidateConfig() throws ConfigValidationError on non-boolean analyzer category in YAML', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks:
  analyzers:
    secrets: "not-a-bool"
`);
      expect(() => parseAndValidateConfig(yamlStr)).toThrow(ConfigValidationError);
    });

    it('2.13: parseAndValidateConfig() throws ConfigValidationError on invalid pre_checks type (string scalar)', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks: "invalid-string"
`);
      expect(() => parseAndValidateConfig(yamlStr)).toThrow(ConfigValidationError);
    });

    it('2.14: parseAndValidateConfig() cleanly parses YAML with empty pre_checks: {} mapping', () => {
      const yamlStr = createBaseV3Yaml(`
pre_checks: {}
`);
      const config: any = parseAndValidateConfig(yamlStr);
      expect(config.pre_checks.enabled).toBe(true);
      expect(config.pre_checks.zoekt.max_symbols).toBe(200);
      expect(config.pre_checks.analyzers.secrets).toBe(true);
    });

    it('2.15: ctReviewConfigV3Schema and ctReviewConfigV4Schema validate pre_checks objects directly', () => {
      const baseObj = {
        version: 3,
        profile: 'balanced',
        quorum: 1,
        personas: [
          { id: 'sec-lane', enabled: true, required: true, charter: 'builtin:security', paths: ['**'], providers: ['claude'] },
        ],
        reviewers: {
          execution: 'personas',
          fallback: 'ordered',
          overall_timeout_s: 60,
          providers: [
            { id: 'claude', enabled: true, model: 'claude-5-sonnet', effort: 'high', review_timeout_s: 30, arbiter_timeout_s: 30 },
          ],
          arbiter: { order: ['claude'] },
        },
      };

      const parsedV3 = ctReviewConfigV3Schema.parse({ ...baseObj, pre_checks: {} });
      expect(parsedV3.pre_checks?.enabled).toBe(true);
      expect(parsedV3.pre_checks?.zoekt.max_symbols).toBe(200);

      const parsedV4 = ctReviewConfigV4Schema.parse({ ...baseObj, version: 4, pre_checks: {} });
      expect(parsedV4.pre_checks?.enabled).toBe(true);
      expect(parsedV4.pre_checks?.analyzers.linters).toBe(true);
    });
  });

  // ===========================================================================
  // SUITE 3: CONFIG RESOLVER 3-TIER PRECEDENCE & DEEP MERGING
  // ===========================================================================
  describe('Suite 3: Config Resolver 3-Tier Precedence & Deep Merging', () => {
    it('3.1: preserves system default pre_checks when neither org nor repo specifies it', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const merged: any = resolver.deepMergeConfigs(sys, null, null);

      expect(merged.pre_checks).toBeDefined();
      expect(merged.pre_checks.enabled).toBe(true);
      expect(merged.pre_checks.zoekt.enabled).toBe(true);
      expect(merged.pre_checks.zoekt.max_symbols).toBe(200);
      expect(merged.pre_checks.analyzers.secrets).toBe(true);
    });

    it('3.2: applies organization-level pre_checks overrides when repo does not specify pre_checks', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const orgConfig = {
        pre_checks: {
          zoekt: { max_symbols: 50 },
          analyzers: { secrets: false },
        },
      };

      const merged: any = resolver.deepMergeConfigs(sys, orgConfig, null);
      expect(merged.pre_checks.zoekt.max_symbols).toBe(50);
      expect(merged.pre_checks.analyzers.secrets).toBe(false);
      // Unmentioned fields inherit system defaults
      expect(merged.pre_checks.zoekt.enabled).toBe(true);
      expect(merged.pre_checks.analyzers.linters).toBe(true);
      expect(merged.pre_checks.analyzers.security).toBe(true);
    });

    it('3.3: repository-level pre_checks strictly overrides organization and system configurations', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const orgConfig = {
        pre_checks: {
          zoekt: { max_symbols: 50 },
          analyzers: { linters: false },
        },
      };
      const repoConfig = {
        pre_checks: {
          zoekt: { max_symbols: 10 },
        },
      };

      const merged: any = resolver.deepMergeConfigs(sys, orgConfig, repoConfig);
      // Repo overrides Org max_symbols (10 vs 50)
      expect(merged.pre_checks.zoekt.max_symbols).toBe(10);
      // Inherits Org linters: false
      expect(merged.pre_checks.analyzers.linters).toBe(false);
      // Inherits System security: true
      expect(merged.pre_checks.analyzers.security).toBe(true);
    });

    it('3.4: performs 3-tier deep merging without clobbering unmentioned sub-keys', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const repoConfig = {
        pre_checks: {
          analyzers: {
            secrets: false,
          },
        },
      };

      const merged: any = resolver.deepMergeConfigs(sys, null, repoConfig);
      // Explicitly set in repo
      expect(merged.pre_checks.analyzers.secrets).toBe(false);
      // Must NOT be clobbered: unmentioned sub-keys retain defaults
      expect(merged.pre_checks.analyzers.enabled).toBe(true);
      expect(merged.pre_checks.analyzers.linters).toBe(true);
      expect(merged.pre_checks.analyzers.security).toBe(true);
      expect(merged.pre_checks.zoekt.enabled).toBe(true);
      expect(merged.pre_checks.zoekt.max_symbols).toBe(200);
    });

    it('3.5: master switch pre_checks.enabled: false at repo level overrides org and cascades disabled default', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const orgConfig = {
        pre_checks: {
          enabled: true,
          zoekt: { max_symbols: 40 },
        },
      };
      const repoConfig = {
        pre_checks: {
          enabled: false,
        },
      };

      const merged: any = resolver.deepMergeConfigs(sys, orgConfig, repoConfig);
      expect(merged.pre_checks.enabled).toBe(false);
      expect(merged.pre_checks.zoekt.enabled).toBe(false);
      expect(merged.pre_checks.analyzers.enabled).toBe(false);
    });

    it('3.6: supports boolean shorthand pre_checks: false at repository level', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const repoConfig = {
        pre_checks: false,
      };

      const merged: any = resolver.deepMergeConfigs(sys, null, repoConfig);
      expect(merged.pre_checks.enabled).toBe(false);
      expect(merged.pre_checks.zoekt.enabled).toBe(false);
      expect(merged.pre_checks.analyzers.enabled).toBe(false);
    });

    it('3.7: supports boolean shorthand zoekt: false and analyzers: false', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const repoConfig = {
        pre_checks: {
          zoekt: false,
        },
      };

      const merged: any = resolver.deepMergeConfigs(sys, null, repoConfig);
      expect(merged.pre_checks.enabled).toBe(true);
      expect(merged.pre_checks.zoekt.enabled).toBe(false);
      expect(merged.pre_checks.analyzers.enabled).toBe(true);
    });

    it('3.8: handles null or undefined pre_checks objects across all tiers gracefully', () => {
      const resolver = new ConfigResolver();
      const sys = createDefaultV3Config();
      const merged: any = resolver.deepMergeConfigs(sys, { pre_checks: null }, { pre_checks: undefined });

      expect(merged.pre_checks).toBeDefined();
      expect(merged.pre_checks.enabled).toBe(true);
      expect(merged.pre_checks.zoekt.max_symbols).toBe(200);
    });
  });

  // ===========================================================================
  // SUITE 4: FILE-BASED CONFIG RESOLVER INTEGRATION
  // ===========================================================================
  describe('Suite 4: File-Based Config Resolver Integration', () => {
    it('4.1: resolves custom pre_checks from .ct-review.yaml in repository', async () => {
      const resolver = new ConfigResolver();
      const repoYaml = createBaseV3Yaml(`
pre_checks:
  zoekt:
    max_symbols: 35
  analyzers:
    secrets: false
`);
      const client = mockClient({ '.ct-review.yaml': repoYaml });

      const config: any = await resolver.resolveConfig({
        owner: 'calltelemetry',
        repo: 'my-service',
        ref: 'main',
        client,
      });

      expect(config.pre_checks).toBeDefined();
      expect(config.pre_checks.zoekt.max_symbols).toBe(35);
      expect(config.pre_checks.analyzers.secrets).toBe(false);
      expect(config.pre_checks.zoekt.enabled).toBe(true);
      expect(config.pre_checks.analyzers.linters).toBe(true);
    });

    it('4.2: resolves custom pre_checks from .reviewyeti.yaml in repository', async () => {
      const resolver = new ConfigResolver();
      const repoYaml = createBaseV3Yaml(`
pre_checks:
  enabled: false
`);
      const client = mockClient({ '.reviewyeti.yaml': repoYaml });

      const config: any = await resolver.resolveConfig({
        owner: 'calltelemetry',
        repo: 'my-service',
        ref: 'main',
        client,
      });

      expect(config.pre_checks.enabled).toBe(false);
    });

    it('4.3: applies systemSettingsOverride for pre_checks when supplied', async () => {
      const resolver = new ConfigResolver();
      const client = mockClient({});

      const config: any = await resolver.resolveConfig({
        owner: 'calltelemetry',
        repo: 'my-service',
        ref: 'main',
        client,
        systemSettingsOverride: {
          pre_checks: {
            zoekt: { max_symbols: 10 },
          },
        },
      });

      expect(config.pre_checks.zoekt.max_symbols).toBe(10);
      expect(config.pre_checks.zoekt.enabled).toBe(true);
    });
  });

  // ===========================================================================
  // SUITE 5: BACKWARD COMPATIBILITY & TRANSLATORS
  // ===========================================================================
  describe('Suite 5: Backward Compatibility & Translators', () => {
    it('5.1: translateCodeRabbitToV3() retains default-on pre_checks when omitted in CodeRabbit YAML', () => {
      const raw = {
        reviews: {
          profile: 'assertive',
        },
      };
      const v3: any = translateCodeRabbitToV3(raw);

      expect(v3.pre_checks).toBeDefined();
      expect(v3.pre_checks.enabled).toBe(true);
      expect(v3.pre_checks.zoekt.enabled).toBe(true);
      expect(v3.pre_checks.analyzers.secrets).toBe(true);
    });

    it('5.2: translateLegacyConfigToV3() retains default-on pre_checks for legacy configs', () => {
      const legacyRaw = {
        version: 1,
        profile: 'balanced',
      };
      const v3: any = translateLegacyConfigToV3(legacyRaw);

      expect(v3.pre_checks).toBeDefined();
      expect(v3.pre_checks.enabled).toBe(true);
      expect(v3.pre_checks.zoekt.max_symbols).toBe(200);
    });
  });
});
