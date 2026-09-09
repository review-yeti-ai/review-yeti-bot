import { describe, expect, it } from 'vitest';
import { authoritativeServiceConfigFromEnv, AUTHORITATIVE_REVIEW_APP_ID } from '../../src/auth/authoritativeServiceConfig';

const marker = 'SYNTHETIC_PRIVATE_CONFIG';
const source = { repositoryId: 987, owner: 'calltelemetry', repo: 'ct-review-actions', ref: 'refs/heads/main', path: 'policy/review.json' };
const policy = { allowAppGate: true, repositoryIds: new Set(['123', '456']) };
const error = 'Authoritative review service configuration is invalid';

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    AUTHORITATIVE_REVIEW_ENABLED: 'true', GITHUB_APP_ID: '4385771', AUTHORITATIVE_REVIEW_APP_ID: '4385771',
    AUTHORITATIVE_REVIEW_REPOSITORY_IDS: '123,456', AUTHORITATIVE_REVIEW_POLICY_SOURCE: JSON.stringify(source),
    BIFROST_BASE_URL: 'https://gateway.example.invalid/v1', REVIEW_MODEL: 'service-model', ...overrides,
  };
}

describe('authoritativeServiceConfigFromEnv', () => {
  it.each([undefined, 'false', 'true'])('separately gates new admission while controllers remain enabled (%s)', (admit) => {
    expect(authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_ADMISSION_ENABLED: admit }), policy)!.admissionEnabled)
      .toBe(admit === 'true');
  });
  it.each(['', 'TRUE', '1', ' true '])('rejects a malformed admission switch %s', (admit) => {
    expect(() => authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_ADMISSION_ENABLED: admit }), policy)).toThrow(error);
  });
  it.each([undefined, 'false'])('is inert when enabled=%s, without reading other configuration', (enabled) => {
    const input = { AUTHORITATIVE_REVIEW_ENABLED: enabled, get GITHUB_APP_ID(): string { throw new Error(marker); } };
    expect(authoritativeServiceConfigFromEnv(input, { allowAppGate: false, repositoryIds: new Set() })).toBeUndefined();
    expect(authoritativeServiceConfigFromEnv({}, policy)).toBeUndefined();
  });

  it.each(['', 'TRUE', 'False', '1', '0', ' true', 'true ', 'false\n', marker])('rejects nonexact enabled value %j', (value) => {
    expect(() => authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_ENABLED: value }), policy)).toThrow(error);
  });

  it('returns only explicit credential-free configuration and does not mutate its inputs', () => {
    const input = Object.freeze(env({ BIFROST_API_KEY: marker, GITHUB_APP_PRIVATE_KEY: marker, OPENROUTER_API_KEY: marker }));
    const before = JSON.stringify(input);
    const resolved = authoritativeServiceConfigFromEnv(input, policy);
    expect(resolved).toEqual({
      expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, admissionEnabled: false, repositoryIds: [123, 456],
      policyRepository: { repositoryId: 987, owner: 'calltelemetry', repo: 'ct-review-actions' },
      policyRef: source.ref, policyPath: source.path,
      transport: { baseUrl: input.BIFROST_BASE_URL, model: input.REVIEW_MODEL }, tickMs: 5_000,
    });
    expect(JSON.stringify(resolved)).not.toContain(marker);
    expect(JSON.stringify(input)).toBe(before);
    resolved!.repositoryIds.push(999);
    expect([...policy.repositoryIds]).toEqual(['123', '456']);
    expect(authoritativeServiceConfigFromEnv(input, policy)!.repositoryIds).toEqual([123, 456]);
  });

  it('requires OIDC app-gate permission independently of explicit opt-in', () => {
    expect(() => authoritativeServiceConfigFromEnv(env(), { ...policy, allowAppGate: false })).toThrow(error);
  });

  it.each(['GITHUB_APP_ID', 'AUTHORITATIVE_REVIEW_APP_ID'])('requires governed %s with no coercive fallback', (key) => {
    for (const value of [undefined, '', '0', '-1', '1.5', '4385772', '04385771', '4385771 ', '4.385771e6', 'Infinity']) {
      expect(() => authoritativeServiceConfigFromEnv(env({ [key]: value }), policy)).toThrow(error);
    }
    expect(() => authoritativeServiceConfigFromEnv(env({ GITHUB_APP_ID: '123', AUTHORITATIVE_REVIEW_APP_ID: '123' }), policy)).toThrow(error);
  });

  it.each([undefined, '', ' ', '*', '123,123', '123,', ',123', '123,,456', '0', '-1', '1.5', '0123', '1e3',
    '9007199254740992', 'NaN', '789'])('rejects invalid/nonallowlisted repository IDs %j', (value) => {
    expect(() => authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_REPOSITORY_IDS: value }), policy)).toThrow(error);
  });

  it('accepts a finite 1..100 subset, preserves explicit order and tolerates CSV whitespace', () => {
    expect(authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_REPOSITORY_IDS: ' 456, 123 ' }), policy)!.repositoryIds).toEqual([456, 123]);
    expect(authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_REPOSITORY_IDS: '123' }), policy)!.repositoryIds).toEqual([123]);
    const ids = Array.from({ length: 101 }, (_, index) => String(index + 1));
    const allowed = { ...policy, repositoryIds: new Set(ids) };
    expect(authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_REPOSITORY_IDS: ids.slice(0, 100).join(',') }), allowed)!.repositoryIds).toHaveLength(100);
    expect(() => authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_REPOSITORY_IDS: ids.join(',') }), allowed)).toThrow(error);
    expect(() => authoritativeServiceConfigFromEnv(env(), { ...policy, repositoryIds: new Set(['*']) })).toThrow(error);
  });

  it.each([undefined, '', '{}', 'null', '[]', '{', ' '.repeat(8_193)])('requires bounded policy-source JSON %j', (value) => {
    expect(() => authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_POLICY_SOURCE: value }), policy)).toThrow(error);
  });

  it.each([
    { repositoryId: 0 }, { repositoryId: '987' }, { repositoryId: Number.MAX_SAFE_INTEGER + 1 },
    { owner: '.' }, { owner: '../owner' }, { owner: 'x'.repeat(101) }, { repo: '..' }, { repo: 'x/y' },
    { ref: '' }, { ref: ' ' }, { ref: 'main\n' }, { ref: 'x'.repeat(257) },
    { path: '' }, { path: '/policy.json' }, { path: '../policy.json' }, { path: 'a/../policy.json' },
    { path: 'a//policy.json' }, { path: 'a\\policy.json' }, { path: 'a\0.json' }, { path: 'x'.repeat(513) },
    { apiKey: marker }, { url: 'https://caller.invalid' },
  ])('rejects malformed source identity/path or extra fields %j', (override) => {
    expect(() => authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_POLICY_SOURCE: JSON.stringify({ ...source, ...override }) }), policy)).toThrow(error);
  });

  it.each([undefined, '', 'http://gateway.invalid', `https://user:${marker}@gateway.invalid/v1`,
    `https://${marker}@gateway.invalid/v1`, 'https://gateway.invalid/v1?', 'https://gateway.invalid/v1?key=value',
    'https://gateway.invalid/v1#', ' https://gateway.invalid/v1', 'https://gateway.invalid/\nv1'])
  ('rejects missing or credential-bearing Bifrost transport %j', (value) => {
    expect(() => authoritativeServiceConfigFromEnv(env({ BIFROST_BASE_URL: value }), policy)).toThrow(error);
  });

  it.each([undefined, '', ' ', 'model\n', 'x'.repeat(257)])('requires an explicit bounded model %j', (value) => {
    expect(() => authoritativeServiceConfigFromEnv(env({ REVIEW_MODEL: value, OPENROUTER_MODEL: 'no-fallback' }), policy)).toThrow(error);
  });

  it.each(['1000', '60000'])('accepts tick bound %s', (value) => {
    expect(authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_TICK_MS: value }), policy)!.tickMs).toBe(Number(value));
  });

  it.each(['', '0', '999', '60001', '1000.5', '1e3', 'Infinity'])('rejects tick %j', (value) => {
    expect(() => authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_TICK_MS: value }), policy)).toThrow(error);
  });

  it('never retains source values or exception causes in startup errors', () => {
    let thrown: unknown;
    try { authoritativeServiceConfigFromEnv(env({ AUTHORITATIVE_REVIEW_POLICY_SOURCE: marker }), policy); } catch (failure) { thrown = failure; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(error);
    expect((thrown as Error).cause).toBeUndefined();
    expect(`${(thrown as Error).stack}\n${JSON.stringify(thrown)}`).not.toContain(marker);
  });
});
