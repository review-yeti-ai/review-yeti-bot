import { describe, expect, it } from 'vitest';
import { jevTransport, invalidJevTransportContract } from '../../src/review/jevTransport';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

const ALL_PRESENT = {
  TYPESAFE_BASE_URL: 'https://api.typesafe.ai/v1/systemone',
  TYPESAFE_MODEL: 'jev-latest',
  TYPESAFE_API_KEY: 'ts-test-key',
  TYPESAFE_MODEL_PIN: 'jev-1.13.0',
};

describe('jevTransport — deliberately the OPPOSITE of openaiTransport', () => {
  it('returns null (disabled) when every Jev env var is absent -- the fallback IS the full existing pipeline', () => {
    expect(jevTransport(env())).toBeNull();
  });

  it('returns a config when every Jev env var is present', () => {
    const config = jevTransport(env(ALL_PRESENT));
    expect(config).toEqual({
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      apiKey: 'ts-test-key',
      modelPin: 'jev-1.13.0',
    });
  });

  it.each(['TYPESAFE_BASE_URL', 'TYPESAFE_MODEL', 'TYPESAFE_API_KEY', 'TYPESAFE_MODEL_PIN'])(
    'throws (fail loudly, not disabled) when only %s is missing -- partial config is a misconfiguration bug',
    (name) => {
      expect(() => jevTransport(env({ ...ALL_PRESENT, [name]: '' }))).toThrow(invalidJevTransportContract().message);
    },
  );

  it('throws for a non-https base URL', () => {
    expect(() =>
      jevTransport(env({ ...ALL_PRESENT, TYPESAFE_BASE_URL: 'http://api.typesafe.ai/v1/systemone' })),
    ).toThrow(invalidJevTransportContract().message);
  });

  it('throws for an unparseable base URL', () => {
    expect(() => jevTransport(env({ ...ALL_PRESENT, TYPESAFE_BASE_URL: 'not a url' }))).toThrow(
      invalidJevTransportContract().message,
    );
  });

  it('never logs or interpolates the API key into thrown errors', () => {
    let caught: Error | null = null;
    try {
      jevTransport(env({ ...ALL_PRESENT, TYPESAFE_BASE_URL: 'not a url' }));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).not.toContain('ts-test-key');
  });
});
