import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { FixtureGenerator } from '@harness/fixtureGenerator';
import { parseAndValidateConfig, deepMergeConfig, convertCodeRabbitConfig, ConfigValidationError } from '@src/config/configLoader';
import { DEFAULT_ORG_CONFIG } from '@src/config/defaultOrgConfig';
import { ctReviewConfigSchema } from '@src/config/schema';

describe('Tier 1 Feature Coverage: Configuration Engine & Schema Validation', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier1-config-suite',
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test('1. Loads and parses primary .ct-review.yaml config file', () => {
    const yamlContent = `
version: "1.0"
quorum:
  minApprovals: 3
  personas:
    - security
    - architecture
  effortLevel: reasoning
ticketEnforcement:
  required: true
  providers:
    - linear
    - jira
  patterns:
    - '\\[PROJ-\\d+\\]'
constitution:
  enabled: true
  path: ".github/custom-constitution.md"
`;

    const config = parseAndValidateConfig(yamlContent);

    expect(config.version).toBe('1.0');
    expect(config.quorum.minApprovals).toBe(3);
    expect(config.quorum.personas).toEqual(['security', 'architecture']);
    expect(config.quorum.effortLevel).toBe('reasoning');
    expect(config.ticketEnforcement.required).toBe(true);
    expect(config.ticketEnforcement.providers).toEqual(['linear', 'jira']);
    expect(config.ticketEnforcement.patterns).toEqual(['\\[PROJ-\\d+\\]']);
    expect(config.constitution.enabled).toBe(true);
    expect(config.constitution.path).toBe('.github/custom-constitution.md');
  });

  test('2. Converts and falls back to .coderabbit.yaml format when primary config is absent', () => {
    const codeRabbitYaml = `
reviews:
  profile: "chill"
  high_level_summary: true
chat:
  auto_reply: true
`;

    const configChill = parseAndValidateConfig(codeRabbitYaml, true);
    expect(configChill.quorum.effortLevel).toBe('low');
    expect(configChill.quorum.minApprovals).toBe(2);

    const codeRabbitAssertive = `
reviews:
  profile: "assertive"
`;
    const configAssertive = parseAndValidateConfig(codeRabbitAssertive, true);
    expect(configAssertive.quorum.effortLevel).toBe('high');
  });

  test('3. Merges user overrides with organization defaults (DEFAULT_ORG_CONFIG)', () => {
    const partialYaml = `
quorum:
  minApprovals: 4
`;

    const config = parseAndValidateConfig(partialYaml);

    // Explicit override
    expect(config.quorum.minApprovals).toBe(4);

    // Merged from org defaults
    expect(config.version).toBe(DEFAULT_ORG_CONFIG.version);
    expect(config.quorum.personas).toEqual(DEFAULT_ORG_CONFIG.quorum.personas);
    expect(config.quorum.effortLevel).toBe(DEFAULT_ORG_CONFIG.quorum.effortLevel);
    expect(config.ticketEnforcement.required).toBe(DEFAULT_ORG_CONFIG.ticketEnforcement.required);
    expect(config.constitution.enabled).toBe(DEFAULT_ORG_CONFIG.constitution.enabled);
  });

  test('4. Enforces Zod schema parsing and throws ConfigValidationError on invalid options', () => {
    // minApprovals < 1 violation
    const invalidMinApprovals = `
quorum:
  minApprovals: 0
`;
    expect(() => parseAndValidateConfig(invalidMinApprovals)).toThrow(ConfigValidationError);

    // Invalid persona enum value
    const invalidPersona = `
quorum:
  personas:
    - invalid_persona_name
`;
    expect(() => parseAndValidateConfig(invalidPersona)).toThrow(ConfigValidationError);

    // Invalid effort level
    const invalidEffort = `
quorum:
  effortLevel: super_fast
`;
    expect(() => parseAndValidateConfig(invalidEffort)).toThrow(ConfigValidationError);
  });

  test('5. Supports custom persona list overrides and schema validation', () => {
    const customPersonasYaml = `
quorum:
  personas:
    - security
    - performance
`;

    const config = parseAndValidateConfig(customPersonasYaml);
    expect(config.quorum.personas).toEqual(['security', 'performance']);

    const validRaw = {
      version: '1.0',
      quorum: {
        minApprovals: 1,
        personas: ['quality'],
        effortLevel: 'low',
      },
    };

    const parsed = ctReviewConfigSchema.parse(validRaw);
    expect(parsed.quorum.personas).toEqual(['quality']);
  });

  test('6. FixtureGenerator integration and empty YAML fallback to default org config', () => {
    const fixtureYaml = FixtureGenerator.buildConfigYaml({
      quorum: { minApprovals: 3, effortLevel: 'high' },
    });

    const parsedFixture = parseAndValidateConfig(fixtureYaml);
    expect(parsedFixture.quorum.minApprovals).toBe(3);
    expect(parsedFixture.quorum.effortLevel).toBe('high');

    // Empty YAML string handles gracefully
    const emptyConfig = parseAndValidateConfig('');
    expect(emptyConfig.quorum.minApprovals).toBe(DEFAULT_ORG_CONFIG.quorum.minApprovals);
    expect(emptyConfig.quorum.personas).toEqual(DEFAULT_ORG_CONFIG.quorum.personas);
  });
});
