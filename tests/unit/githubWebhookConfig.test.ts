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
});
