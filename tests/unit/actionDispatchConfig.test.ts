import { describe, it, expect } from 'vitest';
import {
  actionDispatchConfigFromEnv,
  parsePositiveInteger,
  SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY,
  SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY_ID,
} from '../../src/config/actionDispatchConfig';

describe('actionDispatchConfig', () => {
  describe('parsePositiveInteger', () => {
    it('returns default value when input is undefined', () => {
      expect(parsePositiveInteger(undefined, 42, 'TEST_VAR')).toBe(42);
    });

    it('returns default value when input is empty string or whitespace', () => {
      expect(parsePositiveInteger('', 42, 'TEST_VAR')).toBe(42);
      expect(parsePositiveInteger('   ', 42, 'TEST_VAR')).toBe(42);
    });

    it('returns parsed integer when input is a valid positive integer string', () => {
      expect(parsePositiveInteger('1', 42, 'TEST_VAR')).toBe(1);
      expect(parsePositiveInteger('100', 42, 'TEST_VAR')).toBe(100);
      expect(parsePositiveInteger('1800000', 42, 'TEST_VAR')).toBe(1_800_000);
    });

    it('throws error when input is zero', () => {
      expect(() => parsePositiveInteger('0', 42, 'TEST_VAR')).toThrow(
        'TEST_VAR must be a positive integer'
      );
    });

    it('throws error when input is negative', () => {
      expect(() => parsePositiveInteger('-1', 42, 'TEST_VAR')).toThrow(
        'TEST_VAR must be a positive integer'
      );
      expect(() => parsePositiveInteger('-100', 42, 'TEST_VAR')).toThrow(
        'TEST_VAR must be a positive integer'
      );
    });

    it('throws error when input is a floating-point number', () => {
      expect(() => parsePositiveInteger('3.14', 42, 'TEST_VAR')).toThrow(
        'TEST_VAR must be a positive integer'
      );
    });

    it('throws error when input is non-numeric text or NaN', () => {
      expect(() => parsePositiveInteger('abc', 42, 'TEST_VAR')).toThrow(
        'TEST_VAR must be a positive integer'
      );
      expect(() => parsePositiveInteger('NaN', 42, 'TEST_VAR')).toThrow(
        'TEST_VAR must be a positive integer'
      );
      expect(() => parsePositiveInteger('Infinity', 42, 'TEST_VAR')).toThrow(
        'TEST_VAR must be a positive integer'
      );
    });
  });

  describe('actionDispatchConfigFromEnv', () => {
    it('provides safe defaults when environment is empty', () => {
      const config = actionDispatchConfigFromEnv({});
      expect(config.requireExpectedGeneration).toBe(false);
      expect(config.centralExternalRepositories.size).toBe(0);
      expect(config.mcp.enabled).toBe(false);
      expect(config.mcp.path).toBe('/api/mcp');
      expect(config.mcp.authToken).toBeUndefined();
      expect(config.mcp.maxSessions).toBe(100);
      expect(config.mcp.sessionTtlMs).toBe(1_800_000);
      expect(config.mcp.rateLimitWindowMs).toBe(60_000);
      expect(config.mcp.rateLimitMax).toBe(60);
      expect(config.mcp.rateLimit).toEqual({
        windowMs: 60_000,
        max: 60,
      });
    });

    describe('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION parsing', () => {
      it('parses "true" as boolean true', () => {
        const config = actionDispatchConfigFromEnv({
          ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: 'true',
        });
        expect(config.requireExpectedGeneration).toBe(true);
      });

      it('parses "false" and empty as boolean false', () => {
        expect(
          actionDispatchConfigFromEnv({ ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: 'false' })
            .requireExpectedGeneration
        ).toBe(false);
        expect(
          actionDispatchConfigFromEnv({ ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: '' })
            .requireExpectedGeneration
        ).toBe(false);
      });

      it('throws when not exactly true or false', () => {
        expect(() =>
          actionDispatchConfigFromEnv({ ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: 'yes' })
        ).toThrow('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false');
        expect(() =>
          actionDispatchConfigFromEnv({ ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION: '1' })
        ).toThrow('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false');
      });
    });

    describe('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES parsing', () => {
      it('accepts configured central dispatch repository and assigns fixed ID', () => {
        const config = actionDispatchConfigFromEnv({
          ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES: SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY,
          REVIEW_YETI_PUBLIC_TARGET_APP_ID: '7654321',
          REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY: 'synthetic-public-target-private-key',
        });
        expect(config.centralExternalRepositories.get(SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY)).toBe(
          SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY_ID
        );
        expect(config.centralExternalAppCredentials).toEqual({
          appId: '7654321', privateKey: 'synthetic-public-target-private-key',
        });
      });

      it('normalizes escaped newlines in the dedicated private key', () => {
        const config = actionDispatchConfigFromEnv({
          ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES: SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY,
          REVIEW_YETI_PUBLIC_TARGET_APP_ID: '7654321',
          REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY: 'first\\nsecond',
        });
        expect(config.centralExternalAppCredentials?.privateKey).toBe('first\nsecond');
      });

      it('trims the dedicated credential pair before use', () => {
        const config = actionDispatchConfigFromEnv({
          ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES: SELF_HOSTED_CENTRAL_DISPATCH_REPOSITORY,
          REVIEW_YETI_PUBLIC_TARGET_APP_ID: ' 7654321 ',
          REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY: ' synthetic-public-target-private-key ',
        });
        expect(config.centralExternalAppCredentials).toEqual({
          appId: '7654321', privateKey: 'synthetic-public-target-private-key',
        });
      });

      it('ignores dormant dedicated credentials when external dispatch is not enabled', () => {
        const config = actionDispatchConfigFromEnv({
          REVIEW_YETI_PUBLIC_TARGET_APP_ID: '7654321',
          REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY: 'synthetic-public-target-private-key',
        });
        expect(config.centralExternalRepositories.size).toBe(0);
        expect(config.centralExternalAppCredentials).toBeUndefined();
      });

      it('rejects unsupported external repositories', () => {
        expect(() =>
          actionDispatchConfigFromEnv({
            ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES: 'unauthorized/repo',
          })
        ).toThrow(
          'ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES must contain only explicit supported repositories'
        );
      });
    });

    describe('REVIEW_YETI_MCP_ENABLED and REVIEW_YETI_MCP_AUTH_TOKEN parsing', () => {
      it('parses "true" and accepts valid auth token', () => {
        const config = actionDispatchConfigFromEnv({
          REVIEW_YETI_MCP_ENABLED: 'true',
          REVIEW_YETI_MCP_AUTH_TOKEN: 'secret-token-12345',
        });
        expect(config.mcp.enabled).toBe(true);
        expect(config.mcp.authToken).toBe('secret-token-12345');
      });

      it('throws when REVIEW_YETI_MCP_ENABLED is not strictly true or false', () => {
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_ENABLED: 'yes' })
        ).toThrow('REVIEW_YETI_MCP_ENABLED must be exactly true or false');
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_ENABLED: '1' })
        ).toThrow('REVIEW_YETI_MCP_ENABLED must be exactly true or false');
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_ENABLED: 'truee' })
        ).toThrow('REVIEW_YETI_MCP_ENABLED must be exactly true or false');
      });

      it('requires REVIEW_YETI_MCP_AUTH_TOKEN when REVIEW_YETI_MCP_ENABLED is true', () => {
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_ENABLED: 'true' })
        ).toThrow('REVIEW_YETI_MCP_AUTH_TOKEN is required when REVIEW_YETI_MCP_ENABLED is true');

        expect(() =>
          actionDispatchConfigFromEnv({
            REVIEW_YETI_MCP_ENABLED: 'true',
            REVIEW_YETI_MCP_AUTH_TOKEN: '   ',
          })
        ).toThrow('REVIEW_YETI_MCP_AUTH_TOKEN is required when REVIEW_YETI_MCP_ENABLED is true');
      });

      it('allows omitting REVIEW_YETI_MCP_AUTH_TOKEN when REVIEW_YETI_MCP_ENABLED is false', () => {
        const config = actionDispatchConfigFromEnv({
          REVIEW_YETI_MCP_ENABLED: 'false',
        });
        expect(config.mcp.enabled).toBe(false);
        expect(config.mcp.authToken).toBeUndefined();
      });
    });

    describe('REVIEW_YETI_MCP_PATH parsing', () => {
      it('defaults to /api/mcp', () => {
        const config = actionDispatchConfigFromEnv({});
        expect(config.mcp.path).toBe('/api/mcp');
      });

      it('accepts valid custom path starting with /', () => {
        const config = actionDispatchConfigFromEnv({
          REVIEW_YETI_MCP_PATH: '/v1/agent/mcp',
        });
        expect(config.mcp.path).toBe('/v1/agent/mcp');
      });

      it('throws error when path does not start with /', () => {
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_PATH: 'api/mcp' })
        ).toThrow('REVIEW_YETI_MCP_PATH must start with "/"');
      });
    });

    describe('REVIEW_YETI_MCP_SESSION_TTL_MS and Floor Validation', () => {
      it('defaults session TTL to 1,800,000 ms', () => {
        const config = actionDispatchConfigFromEnv({});
        expect(config.mcp.sessionTtlMs).toBe(1_800_000);
      });

      it('accepts valid session TTL >= 5000 ms', () => {
        const config = actionDispatchConfigFromEnv({
          REVIEW_YETI_MCP_SESSION_TTL_MS: '5000',
        });
        expect(config.mcp.sessionTtlMs).toBe(5000);

        const config2 = actionDispatchConfigFromEnv({
          REVIEW_YETI_MCP_SESSION_TTL_MS: '60000',
        });
        expect(config2.mcp.sessionTtlMs).toBe(60000);
      });

      it('throws error when session TTL is below 5000 ms floor', () => {
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_SESSION_TTL_MS: '4999' })
        ).toThrow('REVIEW_YETI_MCP_SESSION_TTL_MS must be at least 5000ms');
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_SESSION_TTL_MS: '1000' })
        ).toThrow('REVIEW_YETI_MCP_SESSION_TTL_MS must be at least 5000ms');
      });
    });

    describe('Rate Limiting & Session Configuration', () => {
      it('parses custom maxSessions, rateLimitWindowMs, and rateLimitMax', () => {
        const config = actionDispatchConfigFromEnv({
          REVIEW_YETI_MCP_MAX_SESSIONS: '250',
          REVIEW_YETI_MCP_RATE_LIMIT_WINDOW_MS: '30000',
          REVIEW_YETI_MCP_RATE_LIMIT_MAX: '120',
        });
        expect(config.mcp.maxSessions).toBe(250);
        expect(config.mcp.rateLimitWindowMs).toBe(30000);
        expect(config.mcp.rateLimitMax).toBe(120);
        expect(config.mcp.rateLimit).toEqual({
          windowMs: 30000,
          max: 120,
        });
      });

      it('rejects invalid non-positive integers in rate limit settings', () => {
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_RATE_LIMIT_MAX: '0' })
        ).toThrow('REVIEW_YETI_MCP_RATE_LIMIT_MAX must be a positive integer');
        expect(() =>
          actionDispatchConfigFromEnv({ REVIEW_YETI_MCP_RATE_LIMIT_WINDOW_MS: '-500' })
        ).toThrow('REVIEW_YETI_MCP_RATE_LIMIT_WINDOW_MS must be a positive integer');
      });
    });
  });
});
