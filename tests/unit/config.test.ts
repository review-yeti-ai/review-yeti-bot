import { describe, it, expect } from 'vitest';
import { parseAndValidateConfig, ConfigValidationError, deepMergeConfig, convertCodeRabbitConfig } from '../../src/config/configLoader';
import { DEFAULT_ORG_CONFIG } from '../../src/config/defaultOrgConfig';

describe('Config Loader & Parser', () => {
  it('parses a valid complete .ct-review.yaml config', () => {
    const yamlStr = `
version: "1.0"
quorum:
  minApprovals: 3
  personas:
    - security
    - architecture
  effortLevel: high
ticketEnforcement:
  required: true
  providers:
    - linear
    - github
  patterns:
    - 'PROJECT-\\d+'
constitution:
  enabled: true
  path: ".github/custom_constitution.md"
`;

    const config = parseAndValidateConfig(yamlStr);
    expect(config.quorum.minApprovals).toBe(3);
    expect(config.quorum.personas).toEqual(['security', 'architecture']);
    expect(config.quorum.effortLevel).toBe('high');
    expect(config.ticketEnforcement.required).toBe(true);
    expect(config.ticketEnforcement.providers).toEqual(['linear', 'github']);
    expect(config.ticketEnforcement.patterns).toEqual(['PROJECT-\\d+']);
    expect(config.constitution.path).toBe('.github/custom_constitution.md');
  });

  it('deep merges minimal user overrides with DEFAULT_ORG_CONFIG defaults', () => {
    const yamlStr = `
quorum:
  minApprovals: 4
`;

    const config = parseAndValidateConfig(yamlStr);
    expect(config.quorum.minApprovals).toBe(4);
    // Inherited from org defaults
    expect(config.quorum.personas).toEqual(['security', 'architecture', 'performance', 'quality']);
    expect(config.quorum.effortLevel).toBe('medium');
    expect(config.ticketEnforcement.required).toBe(true);
    expect(config.constitution.enabled).toBe(true);
  });

  it('converts .coderabbit.yaml config to CtReviewConfig shape', () => {
    const codeRabbitYaml = `
language: "en-US"
reviews:
  profile: "assertive"
  high_level_summary: true
  auto_review:
    enabled: true
`;

    const config = parseAndValidateConfig(codeRabbitYaml, true);
    expect(config.quorum.effortLevel).toBe('high');
    expect(config.quorum.minApprovals).toBe(2);
    expect(config.ticketEnforcement.required).toBe(true);
  });

  it('throws ConfigValidationError on YAML syntax errors', () => {
    const invalidYaml = `
quorum:
  minApprovals: [unclosed list
`;

    expect(() => parseAndValidateConfig(invalidYaml)).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError on Zod schema validation failures', () => {
    const invalidSchemaYaml = `
quorum:
  minApprovals: 0
  personas:
    - invalid_persona_name
`;

    expect(() => parseAndValidateConfig(invalidSchemaYaml)).toThrow(ConfigValidationError);
  });

  it('deepMergeConfig correctly overrides nested properties', () => {
    const target = { quorum: { minApprovals: 5 } };
    const source = DEFAULT_ORG_CONFIG;
    const merged = deepMergeConfig(target, source);

    expect(merged.quorum.minApprovals).toBe(5);
    expect(merged.quorum.personas).toEqual(source.quorum.personas);
  });
});
