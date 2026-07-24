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
});
