import { describe, expect, it } from 'vitest';
import type { AuthoritativeServiceConfig } from '../../src/auth/authoritativeServiceConfig';
import { findReviewCiEnrollment, reviewCiConfigFromEnv } from '../../src/auth/reviewCiConfig';
import { createReviewCiLanePlan, type StoredReviewCiRequest } from '../../src/review/reviewCi';

const review: AuthoritativeServiceConfig = {
  expectedAppId: 4385771, admissionEnabled: false, repositoryIds: [123],
  policyRepository: { repositoryId: 456, owner: 'example', repo: 'policy' },
  policyRef: 'refs/heads/main', policyPath: 'policy.json',
  transport: { baseUrl: 'https://example.invalid/v1', model: 'review' }, tickMs: 5000,
};
const repository = {
  repositoryId: 123, ownerId: 99, owner: 'example', repo: 'pilot',
  relay: { workflowId: 11, workflowPath: '.github/workflows/relay.yml',
    workflowRef: 'refs/heads/main', workflowSha: 'a'.repeat(40) },
  validation: { workflowId: 12, workflowPath: '.github/workflows/validation.yml',
    workflowRef: 'refs/tags/ci-v1', workflowSha: 'b'.repeat(40) },
  lanePlan: createReviewCiLanePlan(['ct-meta-hermetic-v1'],
    ['Review CI preflight', 'Review CI dependencies', 'Review CI unit']),
};
const env = () => ({ REVIEW_CI_ENABLED: 'true', REVIEW_CI_REPOSITORIES: JSON.stringify([repository]) });
const rejected = 'Review CI service configuration is invalid';
const request = (): StoredReviewCiRequest => ({
  requestId: '07b3c7a1-12a4-4e42-bc18-71df2e0cae1d', expectedAppId: 4385771, state: 'pending', binding: null,
  identityDigest: null, workflowEpoch: 0, execution: null, terminalReceipt: null,
  review: { repositoryId: 123, owner: 'example', repo: 'pilot', prNumber: 42,
    baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), policyDigest: 'c'.repeat(64),
    runId: `run_${'d'.repeat(32)}`, attemptId: `run_${'d'.repeat(32)}-g0-e1`, reviewGeneration: 0, executionAttempt: 1 },
});

describe('finite default-off CI deployment configuration', () => {
  it('owns one exact enrollment rule for service and runtime consumers', () => {
    const config = reviewCiConfigFromEnv(env(), review)!;
    expect(findReviewCiEnrollment(config, request())).toEqual(repository);
    expect(findReviewCiEnrollment(config, { ...request(), expectedAppId: 1 })).toBeUndefined();
    expect(findReviewCiEnrollment(config, { ...request(), review: { ...request().review, owner: 'outside' } })).toBeUndefined();
  });
  it('keeps existing admitted work drainable when both admission and delivery opt-ins are absent', () => {
    expect(reviewCiConfigFromEnv(env(), review)).toMatchObject({ admissionEnabled: false,
      repositoryDispatchEnabled: false, tickMs: 5000, repositories: [repository] });
  });
  it('requires the completion-event delivery opt-in before admitting new work', () => {
    expect(() => reviewCiConfigFromEnv({ ...env(), REVIEW_CI_ADMISSION_ENABLED: 'true' }, review)).toThrow(rejected);
    expect(reviewCiConfigFromEnv({ ...env(), REVIEW_CI_ADMISSION_ENABLED: 'true',
      REVIEW_CI_REPOSITORY_DISPATCH_ENABLED: 'true' }, review)).toMatchObject({ admissionEnabled: true });
  });
  for (const key of ['REVIEW_CI_ENABLED', 'REVIEW_CI_ADMISSION_ENABLED', 'REVIEW_CI_REPOSITORY_DISPATCH_ENABLED']) {
    for (const value of ['TRUE', ' true', 'true ', '1', '']) {
      it(`rejects noncanonical ${key}=${JSON.stringify(value)}`, () => {
        expect(() => reviewCiConfigFromEnv({ ...env(), [key]: value }, review)).toThrow(rejected);
      });
    }
  }
  for (const value of ['0', '999', '60001', '05000', '5e3', '-1', '9007199254740992']) {
    it(`rejects unbounded or noncanonical tick ${value}`, () => {
      expect(() => reviewCiConfigFromEnv({ ...env(), REVIEW_CI_TICK_MS: value }, review)).toThrow(rejected);
    });
  }
  for (const value of ['1000', '60000']) {
    it(`accepts documented inclusive tick bound ${value}`, () => {
      expect(reviewCiConfigFromEnv({ ...env(), REVIEW_CI_TICK_MS: value }, review)?.tickMs).toBe(Number(value));
    });
  }
  it('rejects the wrong App or unenrolled repository even with valid workflow coordinates', () => {
    expect(() => reviewCiConfigFromEnv(env(), { ...review, expectedAppId: 1 })).toThrow(rejected);
    expect(() => reviewCiConfigFromEnv(env(), { ...review, repositoryIds: [456] })).toThrow(rejected);
  });
  const malformed = [[], [repository, repository], [{ ...repository, owner: '..' }],
    [{ ...repository, relay: repository.validation }],
    [{ ...repository, validation: { ...repository.validation, workflowPath: repository.relay.workflowPath } }],
    [{ ...repository, validation: { ...repository.validation, workflowSha: '*' } }],
    [{ ...repository, lanePlan: { ...repository.lanePlan, digest: 'f'.repeat(64) } }],
    [{ ...repository, url: 'https://candidate.invalid' }],
    [repository, { ...repository, repositoryId: 124, owner: 'EXAMPLE', repo: 'PILOT' }],
    Array.from({ length: 101 }, (_, i) => ({ ...repository, repositoryId: i + 1, repo: `pilot-${i}` })),
  ];
  for (const [index, value] of malformed.entries()) {
    it(`rejects invalid or ambiguous enrollment ${index}`, () => {
      expect(() => reviewCiConfigFromEnv({ ...env(), REVIEW_CI_REPOSITORIES: JSON.stringify(value) },
        { ...review, repositoryIds: Array.from({ length: 200 }, (_, i) => i + 1) })).toThrow(rejected);
    });
  }
  it('bounds serialized enrollment before parsing and never echoes its contents', () => {
    for (const raw of ['synthetic-private-value', ' '.repeat(131073)]) {
      expect(() => reviewCiConfigFromEnv({ ...env(), REVIEW_CI_REPOSITORIES: raw }, review)).toThrow(new Error(rejected));
    }
  });
});
