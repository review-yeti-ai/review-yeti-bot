import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { ReviewCiOidcVerifier } from '../../src/auth/reviewCiOidc';
import { reviewCiConfigFromEnv, type ReviewCiRepositoryConfig } from '../../src/auth/reviewCiConfig';
import { createReviewCiLanePlan } from '../../src/review/reviewCi';
import type { AuthoritativeServiceConfig } from '../../src/auth/authoritativeServiceConfig';

let privateKey: KeyLike;
let keySet: ReturnType<typeof createLocalJWKSet>;
const repository: ReviewCiRepositoryConfig = {
  repositoryId: 123, ownerId: 99, owner: 'example', repo: 'pilot',
  relay: { workflowId: 11, workflowPath: '.github/workflows/review-relay.yml', workflowRef: 'refs/heads/main', workflowSha: 'a'.repeat(40) },
  validation: { workflowId: 12, workflowPath: '.github/workflows/review-validation.yml', workflowRef: 'refs/heads/main', workflowSha: 'b'.repeat(40) },
  lanePlan: createReviewCiLanePlan(['unit'], ['Trusted preflight', 'Unit tests']),
};
const review = { expectedAppId: 4385771, repositoryIds: [123] } as AuthoritativeServiceConfig;
const enabled = { REVIEW_CI_ENABLED: 'true', REVIEW_CI_REPOSITORIES: JSON.stringify([repository]) };
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  keySet = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'ci-test', alg: 'RS256', use: 'sig' }] });
});
async function token(overrides: Record<string, unknown> = {}, role: 'relay' | 'validation' = 'relay', audience = 'review-yeti-ci-control') {
  const workflow = repository[role];
  return new SignJWT({ repository: 'example/pilot', repository_id: '123', repository_owner_id: '99',
    run_id: '987', run_attempt: '1', event_name: role === 'relay' ? 'repository_dispatch' : 'workflow_dispatch',
    workflow_ref: `example/pilot/${workflow.workflowPath}@${workflow.workflowRef}`, workflow_sha: workflow.workflowSha,
    ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'ci-test' })
    .setIssuer('https://token.actions.githubusercontent.com').setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(privateKey);
}
const verifier = () => new ReviewCiOidcVerifier({ repositories: [repository], keySet });

describe('strict CI provenance and opt-in configuration', () => {
  it('stays disabled by default and pauses new admission while the controller is enabled', () => {
    expect(reviewCiConfigFromEnv({}, undefined)).toBeUndefined();
    expect(reviewCiConfigFromEnv({ REVIEW_CI_ENABLED: 'false' }, undefined)).toBeUndefined();
    expect(reviewCiConfigFromEnv(enabled, review)).toEqual({ expectedAppId: 4385771,
      admissionEnabled: false, repositoryDispatchEnabled: false, repositories: [repository], tickMs: 5000 });
    expect(reviewCiConfigFromEnv({ ...enabled, REVIEW_CI_ADMISSION_ENABLED: 'true', REVIEW_CI_REPOSITORY_DISPATCH_ENABLED: 'true' }, review))
      .toMatchObject({ admissionEnabled: true, repositoryDispatchEnabled: true });
  });
  it('rejects malformed opt-ins, missing enrollment, wildcard workflow identity and duplicate repos', () => {
    for (const environment of [{ ...enabled, REVIEW_CI_ENABLED: 'yes' }, { ...enabled, REVIEW_CI_ADMISSION_ENABLED: '1' },
      { ...enabled, REVIEW_CI_TICK_MS: '0' }, { ...enabled, REVIEW_CI_TICK_MS: '60001' },
      { ...enabled, REVIEW_CI_REPOSITORIES: JSON.stringify([repository, repository]) },
      { ...enabled, REVIEW_CI_REPOSITORIES: JSON.stringify([{ ...repository, validation: { ...repository.validation, workflowSha: '*' } }]) },
      { ...enabled, REVIEW_CI_REPOSITORIES: JSON.stringify([{ ...repository, extra: 'no' }]) }]) {
      expect(() => reviewCiConfigFromEnv(environment, review)).toThrow('Review CI service configuration is invalid');
    }
    expect(() => reviewCiConfigFromEnv(enabled, undefined)).toThrow();
    expect(() => reviewCiConfigFromEnv(enabled, { ...review, repositoryIds: [] })).toThrow();
  });
  it('accepts only the configured direct relay or validation workflow tuple', async () => {
    await expect(verifier().verify(await token(), 'relay')).resolves.toMatchObject({ role: 'relay', runId: 987, runAttempt: 1 });
    await expect(verifier().verify(await token({}, 'validation'), 'validation')).resolves.toMatchObject({ role: 'validation' });
  });
  it('rejects legacy audience, role swaps, ref/SHA cross-product, callee substitution, and candidate event', async () => {
    await expect(verifier().verify(await token({}, 'relay', 'review-yeti-doks-dispatch'), 'relay')).rejects.toThrow('not authorized');
    await expect(verifier().verify(await token(), 'validation')).rejects.toThrow('not authorized');
    for (const override of [{ workflow_sha: repository.validation.workflowSha },
      { job_workflow_ref: `example/pilot/${repository.relay.workflowPath}@refs/heads/main`, job_workflow_sha: repository.relay.workflowSha },
      { event_name: 'pull_request' }, { event_name: 'workflow_run' }, { repository: 'example/imposter' }, { repository_owner_id: '100' },
      { run_id: '9007199254740992' }, { run_attempt: '0' }, { run_attempt: '1e2' }]) {
      await expect(verifier().verify(await token(override), 'relay')).rejects.toThrow('not authorized');
    }
    await expect(verifier().verify(await token({ event_name: 'repository_dispatch' }, 'validation'), 'validation')).rejects.toThrow('not authorized');
  });
});
