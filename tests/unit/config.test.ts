import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseAndValidateConfig } from '../../src/config/configLoader';

describe('canonical config compatibility', () => {
  it('reads legacy v1 without injecting a bot-owned persona roster', () => {
    const config = parseAndValidateConfig(`
version: 1
profile: balanced
lenses: [correctness, security]
quorum: 2
`);
    expect(config.version).toBe(1);
    expect((config as any).lenses).toEqual(['correctness', 'security']);
    expect((config as any).personas).toBeUndefined();
  });

  it('reads closed-world v2 as compatibility data', () => {
    const config = parseAndValidateConfig(`
version: 2
quorum: 2
reviewers:
  providers:
    - id: codex
      enabled: true
`);
    expect(config.version).toBe(2);
    expect((config as any).reviewers.providers[0].id).toBe('codex');
  });

  it('rejects malformed YAML and non-mapping documents', () => {
    expect(() => parseAndValidateConfig('quorum: [unterminated')).toThrow(ConfigValidationError);
    expect(() => parseAndValidateConfig('- one\n- two')).toThrow(/mapping/);
  });

  it('does not translate unrelated CodeRabbit configuration', () => {
    expect(() => parseAndValidateConfig('reviews: {}', true)).toThrow(/not a ct-review policy/);
  });

  describe('reviewLimitsSchema context window and diff boundary expansion (Milestone 1)', () => {
    it('defaults max_prompt_tokens to 128,000 and max_diff_bytes to 2,000,000', () => {
      const config = parseAndValidateConfig(`
version: 4
quorum: 1
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ["*"]
    providers: [synthetic]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 300
  providers:
    - id: synthetic
      enabled: true
      model: deepseek/deepseek-v4-flash-0731:low
      effort: low
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [synthetic]
`);
      expect(config.version).toBe(4);
      expect((config as any).limits.max_prompt_tokens).toBe(128_000);
      expect((config as any).limits.max_diff_bytes).toBe(2_000_000);
    });

    it('accepts expanded limits up to 4,000,000 prompt tokens and 10,000,000 diff bytes', () => {
      const config = parseAndValidateConfig(`
version: 4
quorum: 1
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ["*"]
    providers: [synthetic]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 300
  providers:
    - id: synthetic
      enabled: true
      model: google/gemini-3.7-flash:high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [synthetic]
limits:
  max_prompt_tokens: 4000000
  max_diff_bytes: 10000000
  max_completion_tokens: 128000
`);
      expect((config as any).limits.max_prompt_tokens).toBe(4_000_000);
      expect((config as any).limits.max_diff_bytes).toBe(10_000_000);
      expect((config as any).limits.max_completion_tokens).toBe(128_000);
    });

    it('rejects limits exceeding 4,000,000 prompt tokens or 10,000,000 diff bytes', () => {
      expect(() => parseAndValidateConfig(`
version: 4
quorum: 1
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ["*"]
    providers: [synthetic]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 300
  providers:
    - id: synthetic
      enabled: true
      model: google/gemini-3.7-flash:high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [synthetic]
limits:
  max_prompt_tokens: 4000001
`)).toThrow(ConfigValidationError);

      expect(() => parseAndValidateConfig(`
version: 4
quorum: 1
personas:
  - id: sec
    enabled: true
    required: true
    charter: builtin:security
    paths: ["*"]
    providers: [synthetic]
reviewers:
  execution: personas
  fallback: none
  overall_timeout_s: 300
  providers:
    - id: synthetic
      enabled: true
      model: google/gemini-3.7-flash:high
      effort: high
      review_timeout_s: 60
      arbiter_timeout_s: 60
  arbiter:
    order: [synthetic]
limits:
  max_diff_bytes: 10000001
`)).toThrow(ConfigValidationError);
    });
  });
});
