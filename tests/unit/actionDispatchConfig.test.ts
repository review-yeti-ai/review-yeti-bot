import { describe, expect, it } from 'vitest';
import { actionDispatchConfigFromEnv } from '../../src/config/actionDispatchConfig';

const selfHostedRepository = 'review-yeti-ai/review-yeti-bot';

describe('Action dispatch service configuration', () => {
  it.each([undefined, '', 'false'])(
    'defaults expected-generation enforcement off for %j',
    (value) => {
      expect(actionDispatchConfigFromEnv({
        ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: value,
      })).toEqual({
        requireExpectedGeneration: false,
        centralExternalRepositories: new Map(),
      });
    },
  );

  it('enables expected-generation enforcement only with the exact true value', () => {
    expect(actionDispatchConfigFromEnv({
      ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: 'true',
    })).toEqual({
      requireExpectedGeneration: true,
      centralExternalRepositories: new Map(),
    });
  });

  it.each(['1', 'yes', 'TRUE', ' true '])('rejects ambiguous enforcement value %j', (value) => {
    expect(() => actionDispatchConfigFromEnv({
      ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: value,
    })).toThrow('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false');
  });

  it('opts the exact self-hosted repository into central dispatch', () => {
    expect(actionDispatchConfigFromEnv({
      ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES: selfHostedRepository,
    })).toEqual({
      requireExpectedGeneration: false,
      centralExternalRepositories: new Map([[selfHostedRepository, 1326169548]]),
    });
  });

  it.each([
    '',
    ' ',
    ',',
    'review-yeti-ai/other-repository',
    'other-owner/review-yeti-bot',
    `calltelemetry/cisco-cdr,${selfHostedRepository}`,
    ` ${selfHostedRepository}`,
    `${selfHostedRepository} `,
    `${selfHostedRepository},${selfHostedRepository}`,
  ])('rejects empty, malformed, duplicated, or unsupported external repository configuration %j', (value) => {
    expect(() => actionDispatchConfigFromEnv({
      ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES: value,
    })).toThrow('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES must contain only explicit supported repositories');
  });
});
