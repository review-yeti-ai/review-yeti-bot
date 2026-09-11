import { describe, expect, it } from 'vitest';
import { actionDispatchConfigFromEnv } from '../../src/config/actionDispatchConfig';

describe('Action dispatch service configuration', () => {
  it.each([undefined, '', 'false'])(
    'defaults expected-generation enforcement off for %j',
    (value) => {
      expect(actionDispatchConfigFromEnv({
        ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: value,
      })).toEqual({ requireExpectedGeneration: false });
    },
  );

  it('enables expected-generation enforcement only with the exact true value', () => {
    expect(actionDispatchConfigFromEnv({
      ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: 'true',
    })).toEqual({ requireExpectedGeneration: true });
  });

  it.each(['1', 'yes', 'TRUE', ' true '])('rejects ambiguous enforcement value %j', (value) => {
    expect(() => actionDispatchConfigFromEnv({
      ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: value,
    })).toThrow('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false');
  });
});
