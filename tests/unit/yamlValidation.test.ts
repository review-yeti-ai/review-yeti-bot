import { describe, it, expect } from 'vitest';
import { parseAndValidateConfig, ConfigValidationError } from '../../src/config/configLoader';

describe('YAML Validation & Syntax Hardening Suite (Milestone 40)', () => {
  it('rejects malformed YAML syntax', () => {
    const invalidYaml = `
version: 3
profile: [unclosed array
  key: value
`;
    expect(() => parseAndValidateConfig(invalidYaml)).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig(invalidYaml)).toThrow(/YAML syntax error/);
  });

  it('rejects non-mapping YAML top-level structure (raw array)', () => {
    const arrayYaml = `
- item1
- item2
- item3
`;
    expect(() => parseAndValidateConfig(arrayYaml)).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig(arrayYaml)).toThrow(/Configuration YAML must be a mapping, not an array/);
  });

  it('rejects non-mapping YAML top-level structure (scalar string)', () => {
    const scalarYaml = `"just a string"`;
    expect(() => parseAndValidateConfig(scalarYaml)).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig(scalarYaml)).toThrow(/Configuration YAML must be a mapping/);
  });

  it('rejects duplicate persona IDs in personas array', () => {
    const duplicatePersonasYaml = `
version: 3
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
    required: false
    charter: builtin:performance
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
      effort: max
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
    expect(() => parseAndValidateConfig(duplicatePersonasYaml)).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig(duplicatePersonasYaml)).toThrow(/persona ids must be unique/);
  });

  it('rejects unknown built-in charter formats', () => {
    const unknownCharterYaml = `
version: 3
quorum: 1
personas:
  - id: custom-lane
    enabled: true
    required: true
    charter: builtin:invalid-charter-name
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
      effort: max
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
    expect(() => parseAndValidateConfig(unknownCharterYaml)).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig(unknownCharterYaml)).toThrow(/unknown built-in charter/);
  });

  it('rejects custom charters that are too short (< 12 characters)', () => {
    const shortCharterYaml = `
version: 3
quorum: 1
personas:
  - id: custom-lane
    enabled: true
    required: true
    charter: short
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
      effort: max
      review_timeout_s: 30
      arbiter_timeout_s: 30
  arbiter:
    order: [codex]
`;
    expect(() => parseAndValidateConfig(shortCharterYaml)).toThrow(ConfigValidationError);
  });

  it('rejects persona referencing disabled provider', () => {
    const disabledProviderYaml = `
version: 3
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
      effort: max
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
    expect(() => parseAndValidateConfig(disabledProviderYaml)).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig(disabledProviderYaml)).toThrow(/references disabled provider/);
  });

  it('rejects invalid CodeRabbit configuration', () => {
    const invalidCodeRabbit = `
reviews: {}
`;
    expect(() => parseAndValidateConfig(invalidCodeRabbit, true)).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig(invalidCodeRabbit, true)).toThrow(/CodeRabbit configuration is not a ct-review policy/);
  });
});
