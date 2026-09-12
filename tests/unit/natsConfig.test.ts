import { describe, expect, it } from 'vitest';
import {
  NATS_CONFIG_ENV,
  natsConfigFromEnv,
  NatsConfigurationError,
} from '../../src/events/natsConfig';

describe('nats event publisher configuration', () => {
  it('is disabled by default without requiring any NATS settings', () => {
    const config = natsConfigFromEnv({});

    expect(config.enabled).toBe(false);
    expect(config.servers).toEqual([]);
    expect(config.token).toBeUndefined();
  });

  it('rejects an enabled publisher with a malformed server URL without echoing it', () => {
    const malformed = 'not-a-nats-url?token=do-not-echo';

    expect(() => natsConfigFromEnv({
      [NATS_CONFIG_ENV.enabled]: 'true',
      [NATS_CONFIG_ENV.serverUrl]: malformed,
      [NATS_CONFIG_ENV.token]: 'private-token',
    })).toThrow(NatsConfigurationError);

    try {
      natsConfigFromEnv({
        [NATS_CONFIG_ENV.enabled]: 'true',
        [NATS_CONFIG_ENV.serverUrl]: malformed,
        [NATS_CONFIG_ENV.token]: 'private-token',
      });
    } catch (error) {
      expect(String(error)).not.toContain(malformed);
      expect(String(error)).not.toContain('private-token');
    }
  });

  it('rejects credentials embedded in an enabled server URL', () => {
    const credentialUrl = 'nats://event-user:password@private-nats.internal:4222';

    expect(() => natsConfigFromEnv({
      [NATS_CONFIG_ENV.enabled]: 'true',
      [NATS_CONFIG_ENV.serverUrl]: credentialUrl,
      [NATS_CONFIG_ENV.token]: 'private-token',
    })).toThrow(/credential|server configuration|invalid/iu);
  });

  it('fails closed for an enabled publisher missing its separate credential', () => {
    expect(() => natsConfigFromEnv({
      [NATS_CONFIG_ENV.enabled]: 'true',
      [NATS_CONFIG_ENV.serverUrl]: 'tls://private-nats.internal:4222',
    })).toThrow(/credential|token|configuration/iu);
  });

  it('accepts a private URL and keeps all transport bounds finite', () => {
    const config = natsConfigFromEnv({
      [NATS_CONFIG_ENV.enabled]: 'true',
      [NATS_CONFIG_ENV.serverUrl]: 'tls://private-nats.internal:4222',
      [NATS_CONFIG_ENV.token]: 'private-token',
    });

    expect(config).toMatchObject({
      enabled: true,
      servers: ['tls://private-nats.internal:4222'],
      tls: { handshakeFirst: true, rejectUnauthorized: true },
    });
    expect(config.connectTimeoutMs).toBeGreaterThan(0);
    expect(config.publishAckTimeoutMs).toBeGreaterThan(0);
    expect(config.drainTimeoutMs).toBeGreaterThan(0);
    expect(config.maxReconnectAttempts).toBeGreaterThanOrEqual(0);
    expect(config.batchSize).toBeGreaterThan(0);
  });

  it('permits plaintext only for loopback fixtures', () => {
    const config = natsConfigFromEnv({
      [NATS_CONFIG_ENV.enabled]: 'true',
      [NATS_CONFIG_ENV.serverUrl]: 'nats://127.0.0.1:4222,nats://[::1]:4223',
      [NATS_CONFIG_ENV.token]: 'fixture-token',
    });

    expect(config.servers).toEqual(['nats://127.0.0.1:4222', 'nats://[::1]:4223']);
    expect(config.tls).toBeNull();
  });

  it('rejects non-loopback plaintext and mixed TLS modes without exposing the URL', () => {
    const nonLoopback = 'nats://private-nats.internal:4222';
    const mixed = 'tls://private-nats.internal:4222,nats://127.0.0.1:4222';

    for (const serverUrl of [nonLoopback, mixed]) {
      try {
        natsConfigFromEnv({
          [NATS_CONFIG_ENV.enabled]: 'true',
          [NATS_CONFIG_ENV.serverUrl]: serverUrl,
          [NATS_CONFIG_ENV.token]: 'private-token',
        });
        throw new Error('expected configuration rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(NatsConfigurationError);
        expect(String(error)).not.toContain(serverUrl);
        expect(String(error)).not.toContain('private-token');
      }
    }
  });

  it('rejects an unknown enabled flag instead of treating it as enabled', () => {
    expect(() => natsConfigFromEnv({
      [NATS_CONFIG_ENV.enabled]: 'yes',
    })).toThrow(/enabled|boolean|configuration/iu);
  });
});
