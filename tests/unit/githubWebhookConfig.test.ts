import { describe, expect, it } from 'vitest';
import { githubWebhookConfigFromEnv } from '../../src/auth/githubWebhookConfig';

const policy = {
  allowAppGate: true,
  repositoryIds: new Set(['614653796', '999']),
  ownerIds: new Set(['57884877']),
};

describe('GitHub App webhook configuration', () => {
  it('is disabled by default', () => {
    expect(githubWebhookConfigFromEnv({}, policy)).toBeUndefined();
  });

  it('accepts only an explicit finite subset of the existing App gate allowlist', () => {
    const config = githubWebhookConfigFromEnv({
      GITHUB_APP_WEBHOOK_ENABLED: 'true',
      GITHUB_APP_WEBHOOK_ADMISSION_ENABLED: 'false',
      GITHUB_APP_WEBHOOK_REPOSITORY_IDS: '614653796',
      GITHUB_APP_WEBHOOK_OWNER_IDS: '57884877',
      GITHUB_WEBHOOK_SECRET: 'a'.repeat(64),
    }, policy);
    expect(config).toEqual({
      secret: 'a'.repeat(64), admissionEnabled: false,
      repositoryIds: new Set(['614653796']), ownerIds: new Set(['57884877']),
    });
  });

  it.each([
    { GITHUB_WEBHOOK_SECRET: 'short' },
    { GITHUB_WEBHOOK_SECRET: 'é'.repeat(513) },
    { GITHUB_APP_WEBHOOK_REPOSITORY_IDS: '1234' },
    { GITHUB_APP_WEBHOOK_OWNER_IDS: '77' },
    { GITHUB_APP_WEBHOOK_ADMISSION_ENABLED: 'yes' },
  ])('rejects unsafe configuration %#', (override) => {
    expect(() => githubWebhookConfigFromEnv({
      GITHUB_APP_WEBHOOK_ENABLED: 'true',
      GITHUB_APP_WEBHOOK_ADMISSION_ENABLED: 'false',
      GITHUB_APP_WEBHOOK_REPOSITORY_IDS: '614653796',
      GITHUB_APP_WEBHOOK_OWNER_IDS: '57884877',
      GITHUB_WEBHOOK_SECRET: 'a'.repeat(64),
      ...override,
    }, policy)).toThrow('GitHub App webhook configuration is invalid');
  });

  it('bounds the finite repository and owner enrollment lists', () => {
    const common = {
      GITHUB_APP_WEBHOOK_ENABLED: 'true', GITHUB_APP_WEBHOOK_ADMISSION_ENABLED: 'false',
      GITHUB_WEBHOOK_SECRET: 'a'.repeat(64),
    };
    expect(() => githubWebhookConfigFromEnv({ ...common,
      GITHUB_APP_WEBHOOK_REPOSITORY_IDS: Array.from({ length: 101 }, (_, index) => String(index + 1)).join(','),
      GITHUB_APP_WEBHOOK_OWNER_IDS: '57884877',
    }, policy)).toThrow('GITHUB_APP_WEBHOOK_REPOSITORY_IDS must contain unique positive integer ids');
    expect(() => githubWebhookConfigFromEnv({ ...common,
      GITHUB_APP_WEBHOOK_REPOSITORY_IDS: '614653796',
      GITHUB_APP_WEBHOOK_OWNER_IDS: Array.from({ length: 11 }, (_, index) => String(index + 1)).join(','),
    }, policy)).toThrow('GITHUB_APP_WEBHOOK_OWNER_IDS must contain unique positive integer ids');
  });

  it('refuses webhook admission when the existing app-gate policy is disabled', () => {
    expect(() => githubWebhookConfigFromEnv({
      GITHUB_APP_WEBHOOK_ENABLED: 'true', GITHUB_APP_WEBHOOK_ADMISSION_ENABLED: 'false',
      GITHUB_APP_WEBHOOK_REPOSITORY_IDS: '614653796', GITHUB_APP_WEBHOOK_OWNER_IDS: '57884877',
      GITHUB_WEBHOOK_SECRET: 'a'.repeat(64),
    }, { ...policy, allowAppGate: false })).toThrow('GitHub App webhook configuration is invalid');
  });

  it.each(['', '0', '0614653796', 'abc', '614653796,614653796'])
  ('refuses a malformed or duplicate repository id list %j', (repositoryIds) => {
    expect(() => githubWebhookConfigFromEnv({
      GITHUB_APP_WEBHOOK_ENABLED: 'true', GITHUB_APP_WEBHOOK_ADMISSION_ENABLED: 'false',
      GITHUB_APP_WEBHOOK_REPOSITORY_IDS: repositoryIds, GITHUB_APP_WEBHOOK_OWNER_IDS: '57884877',
      GITHUB_WEBHOOK_SECRET: 'a'.repeat(64),
    }, policy)).toThrow('GITHUB_APP_WEBHOOK_REPOSITORY_IDS must contain unique positive integer ids');
  });
});
