import { describe, expect, it } from 'vitest';
import { resolveWorkerAuthConfig } from '../../src/cli/runLiveReview';

describe('live review worker authentication', () => {
  it('requires explicit GitHub App credentials instead of falling back to gh user auth', () => {
    expect(() => resolveWorkerAuthConfig({
      GITHUB_TOKEN: 'ghp_user_token',
    } as NodeJS.ProcessEnv)).toThrow(/GITHUB_APP_ID/i);
  });

  it('returns only explicit GitHub App credential inputs', () => {
    expect(resolveWorkerAuthConfig({
      GITHUB_APP_ID: '4385771',
      GITHUB_APP_PRIVATE_KEY: 'pem-key',
      GITHUB_INSTALLATION_ID: '148780830',
      GITHUB_TOKEN: 'ghp_user_token',
    } as NodeJS.ProcessEnv)).toEqual({
      appId: '4385771',
      privateKey: 'pem-key',
      installationId: '148780830',
    });
  });
});
