import { describe, it, expect, vi } from 'vitest';
import { createDefaultV3Config as makeDefaultV3, OPENCODE_LANE_TIMEOUT_S } from '../../src/config/configLoader';
import {
  ConfigValidationError,
  translateCodeRabbitToV3,
  parseAndValidateConfig,
  loadConfig,
} from '../../src/config/configLoader';

describe('configLoader.ts — Comprehensive Unit Expansion Tests', () => {
  it('ConfigValidationError carries message and optional details payload', () => {
    const err = new ConfigValidationError('Invalid YAML', { line: 5 });

    expect(err.name).toBe('ConfigValidationError');
    expect(err.message).toBe('Invalid YAML');
    expect(err.details).toEqual({ line: 5 });
  });

  it('translateCodeRabbitToV3 translates empty raw object to default V3 config', () => {
    const v3 = translateCodeRabbitToV3({});

    expect(v3.version).toBe(3);
    expect(v3.profile).toBe('balanced');
    expect(v3.quorum).toBe(1);
    expect(v3.personas.length).toBeGreaterThan(0);
    expect(v3.reviewers.providers[0].id).toBe('opencode');
    expect(v3.reviewers.providers.length).toBeGreaterThan(0);
    expect(v3.confidence_threshold).toBe(70);
  });

  it('translateCodeRabbitToV3 maps path_instructions, reviewer_effort, and confidence_threshold', () => {
    const raw = {
      reviews: {
        profile: 'assertive',
        reviewer_effort: 'high',
        confidence_threshold: 85,
        path_instructions: [
          { path: 'src/api/**', instructions: 'Enforce strict schema validation.' },
        ],
      },
    };

    const v3 = translateCodeRabbitToV3(raw);

    expect(v3.profile).toBe('assertive');
    expect(v3.reviewer_effort).toBe('high');
    expect(v3.confidence_threshold).toBe(85);
    expect(v3.path_instructions).toHaveLength(1);
    expect(v3.path_instructions[0].path).toBe('src/api/**');
  });

  it('parseAndValidateConfig parses valid version 3 YAML string', () => {
    const yamlStr = `
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
`;

    const config = parseAndValidateConfig(yamlStr);
    expect(config.version).toBe(3);
    expect((config as any).personas[0].id).toBe('sec-lane');
  });

  it('parseAndValidateConfig throws ConfigValidationError on YAML syntax error', () => {
    const invalidYaml = `
version: 3
  invalid: [tab character or broken indentation
  - item:
`;
    expect(() => parseAndValidateConfig(invalidYaml)).toThrow(ConfigValidationError);
  });

  it('parseAndValidateConfig throws ConfigValidationError when YAML parses as an array', () => {
    const arrayYaml = `
- item1
- item2
`;
    expect(() => parseAndValidateConfig(arrayYaml)).toThrow('Configuration YAML must be a mapping, not an array');
  });

  it('parseAndValidateConfig throws ConfigValidationError when mixing version 3 with legacy lenses', () => {
    const mixedYaml = `
version: 3
lenses: [security, performance]
`;
    expect(() => parseAndValidateConfig(mixedYaml)).toThrow('version 3 personas cannot be mixed with legacy lenses');
  });

  it('loadConfig hierarchy step 1: loads .ct-review.yaml at PR ref first', async () => {
    const mockClient = {
      getFileContent: vi.fn().mockImplementation(async (owner: string, repo: string, path: string) => {
        if (path === '.ct-review.yaml') {
          return `
version: 3
profile: assertive
quorum: 1
personas:
  - id: p1
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
`;
        }
        return null;
      }),
    };

    const config = await loadConfig('owner', 'repo', 'ref-1', mockClient);
    expect(config.version).toBe(3);
    expect(config.profile).toBe('assertive');
    expect(mockClient.getFileContent).toHaveBeenCalledWith('owner', 'repo', '.ct-review.yaml', 'ref-1');
  });

  it('loadConfig hierarchy step 5: falls back to default V3 config when no files found', async () => {
    const mockClient = {
      getFileContent: vi.fn().mockResolvedValue(null),
    };

    const config = await loadConfig('owner', 'repo', 'ref-2', mockClient);
    expect(config.version).toBe(3);
    expect(config.profile).toBe('balanced');
  });

  it('clamps review_timeout_s and arbiter_timeout_s to [1, 90]', () => {
    const yamlOver90 = `
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
  overall_timeout_s: 600
  providers:
    - id: claude
      enabled: true
      model: claude-5-sonnet
      effort: high
      review_timeout_s: 300
      arbiter_timeout_s: 180
  arbiter:
    order: [claude]
`;
    const config = parseAndValidateConfig(yamlOver90);
    const provider = (config as any).reviewers.providers[0];
    expect(provider.review_timeout_s).toBe(90);
    expect(provider.arbiter_timeout_s).toBe(90);

    const yamlUnder1 = `
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
  overall_timeout_s: 600
  providers:
    - id: claude
      enabled: true
      model: claude-5-sonnet
      effort: high
      review_timeout_s: 0
      arbiter_timeout_s: -10
  arbiter:
    order: [claude]
`;
    const configUnder = parseAndValidateConfig(yamlUnder1);
    const providerUnder = (configUnder as any).reviewers.providers[0];
    expect(providerUnder.review_timeout_s).toBe(1);
    expect(providerUnder.arbiter_timeout_s).toBe(1);
  });
});
describe('opencode lane budget', () => {
  const {
    resolveAutoTransportTimeoutMs,
  } = require('../../.github/workflows/pipelines/review-pipeline.js');

  // Measured, not guessed: at the shared 90s default every lane failed with "Streaming response
  // exceeded total deadline of 90000ms" on a ~2,500 line diff. Pinned so a future tidy-up that
  // folds it back into the shared default has to argue with a test.
  it('gives opencode its own raised budget, not the shared 90s default', () => {
    const cfg = makeDefaultV3();
    const opencode = cfg.reviewers.providers.find((p: any) => p.id === 'opencode');
    const claude = cfg.reviewers.providers.find((p: any) => p.id === 'claude');
    expect(opencode?.review_timeout_s).toBe(OPENCODE_LANE_TIMEOUT_S);
    expect(opencode?.arbiter_timeout_s).toBe(OPENCODE_LANE_TIMEOUT_S);
    expect(OPENCODE_LANE_TIMEOUT_S).toBeGreaterThan(90);
    // Raised for this provider ONLY. A timeout that never fires is not a timeout.
    expect(claude?.review_timeout_s).toBe(90);
  });

  // The outer deadline does NOT satisfy this by default, and the previous version of this test
  // hid that by supplying its own passing value -- it asserted arithmetic, not the deployed
  // relationship, so it could not fail on the invariant it named.
  //
  // With REVIEW_LANE_TIMEOUT_MS unset the outer default is 90s while the opencode budget is 300s,
  // so the opencode destination REQUIRES the variable. That requirement is enforced by
  // scripts/assert-review-transport-config.sh and covered in reviewTransportConfigGuard.test.ts;
  // what is pinned here is the fact that makes the requirement necessary.
  it('the default outer deadline is tighter than the opencode budget, so the variable is required', () => {
    expect(resolveAutoTransportTimeoutMs({})).toBeLessThan(OPENCODE_LANE_TIMEOUT_S * 1000);
  });
});

