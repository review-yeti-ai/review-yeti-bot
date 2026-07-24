import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { setupE2ETestHarness, E2ETestHarness } from '@harness/e2eTestRunner';
import { parseAndValidateConfig, ConfigValidationError } from '@src/config/configLoader';
import { DEFAULT_ORG_CONFIG } from '@src/config/defaultOrgConfig';

describe('Tier 2 Boundary & Corner Case Tests: Configuration & Schema Validation', () => {
  let harness: E2ETestHarness;

  beforeAll(async () => {
    harness = await setupE2ETestHarness({
      testRunId: 'tier2-config-suite',
    });
  });

  afterAll(async () => {
    await harness.teardown();
  });

  test('1. Empty YAML input boundary - returns default org config without throwing', () => {
    const emptyInputs = ['', '   ', '\n\n# Only comments\n  \n'];

    for (const emptyInput of emptyInputs) {
      const config = parseAndValidateConfig(emptyInput);
      expect(config.version).toBe(DEFAULT_ORG_CONFIG.version);
      expect(config.quorum.minApprovals).toBe(DEFAULT_ORG_CONFIG.quorum.minApprovals);
      expect(config.quorum.personas).toEqual(DEFAULT_ORG_CONFIG.quorum.personas);
      expect(config.ticketEnforcement.required).toBe(DEFAULT_ORG_CONFIG.ticketEnforcement.required);
    }
  });

  test('2. Malformed YAML syntax boundary - throws ConfigValidationError on syntax errors', () => {
    const malformedYamls = [
      'quorum:\n  minApprovals: [unbalanced brackets',
      'version: "1.0"\nquorum: minApprovals: : invalid_colon',
      'ticketEnforcement: { required: true, providers: [linear, jira, }',
      '  invalid_indentation:\nquorum:\n minApprovals: 2',
    ];

    for (const badYaml of malformedYamls) {
      expect(() => parseAndValidateConfig(badYaml)).toThrow(ConfigValidationError);
    }
  });

  test('3. Invalid field types boundary - throws ConfigValidationError when field types mismatch schema', () => {
    const invalidTypeYamls = [
      'quorum:\n  minApprovals: "three"', // string instead of number
      'quorum:\n  personas: "security"', // string instead of array
      'ticketEnforcement:\n  required: "yes"', // string instead of boolean
      'constitution:\n  enabled: 1', // number instead of boolean
    ];

    for (const badYaml of invalidTypeYamls) {
      expect(() => parseAndValidateConfig(badYaml)).toThrow(ConfigValidationError);
    }
  });

  test('4. Out-of-range minApprovals boundary - throws ConfigValidationError for 0, negative, and non-integer values', () => {
    const outOfRangeYamls = [
      'quorum:\n  minApprovals: 0',
      'quorum:\n  minApprovals: -2',
      'quorum:\n  minApprovals: 2.5',
    ];

    for (const badYaml of outOfRangeYamls) {
      expect(() => parseAndValidateConfig(badYaml)).toThrow(ConfigValidationError);
    }
  });

  test('5. Unknown keys boundary - safely ignores unmapped top-level and nested configuration fields', () => {
    const yamlWithUnknownKeys = `
version: "1.0"
unknown_top_level_key: "some_value"
quorum:
  minApprovals: 3
  unknown_quorum_key: 12345
ticketEnforcement:
  required: true
  extra_field: true
`;

    const config = parseAndValidateConfig(yamlWithUnknownKeys);

    expect(config.version).toBe('1.0');
    expect(config.quorum.minApprovals).toBe(3);
    expect(config.ticketEnforcement.required).toBe(true);
    expect((config as any).unknown_top_level_key).toBeUndefined();
  });

  test('6. Unicode and whitespace boundary - correctly parses configs containing UTF-8 characters, emojis, and unusual spacing', () => {
    const unicodeYaml = `
version: "1.0"
quorum:
  minApprovals: 2
  personas:
    - security
    - architecture
  effortLevel: medium
ticketEnforcement:
  required: true
  patterns:
    - '\\[PROJ-\\d+\\] # 🚀 Unicode regex'
    - 'TICKET-🔑-\\d+'
constitution:
  enabled: true
  path: ".github/📜_constitution.md"
`;

    const config = parseAndValidateConfig(unicodeYaml);

    expect(config.quorum.minApprovals).toBe(2);
    expect(config.ticketEnforcement.patterns).toContain('\\[PROJ-\\d+\\] # 🚀 Unicode regex');
    expect(config.ticketEnforcement.patterns).toContain('TICKET-🔑-\\d+');
    expect(config.constitution.path).toBe('.github/📜_constitution.md');
  });
});
