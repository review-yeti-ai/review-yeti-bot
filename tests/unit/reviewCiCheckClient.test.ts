import { describe, expect, it, vi } from 'vitest';
import { createReviewCiCheckClient, reviewCiCheckCoordinates } from '../../src/github/reviewCiCheckClient';
import { deriveReviewCiCheckExternalId, GitHubReviewGateClient } from '../../src/github/reviewGateClient';
import { createReviewCiLanePlan, REVIEW_CI_CHECK_NAME, type ReviewCiValidationIdentity } from '../../src/review/reviewCi';

const identity: ReviewCiValidationIdentity = { requestId: '07b3c7a1-12a4-4e42-bc18-71df2e0cae1d', expectedAppId: 4385771,
  review: { repositoryId: 123, owner: 'calltelemetry', repo: 'ct-meta', prNumber: 42, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40),
    policyDigest: 'c'.repeat(64), runId: `run_${'a'.repeat(32)}`, attemptId: `run_${'a'.repeat(32)}-g0-e1`, reviewGeneration: 0, executionAttempt: 1 },
  binding: { candidateSha: 'd'.repeat(40), workflowId: 88, workflowPath: '.github/workflows/ci.yml', workflowRef: 'refs/heads/main',
    workflowSha: 'e'.repeat(40), lanePlan: createReviewCiLanePlan(['unit'], ['required tests']) } };
const options = { token: 'ghs_ci', expectedAppId: 4385771, baseUrl: 'https://api.example.invalid' };
const coordinates = reviewCiCheckCoordinates(identity, 1);
const externalId = deriveReviewCiCheckExternalId(coordinates);
function check(change: Record<string, unknown> = {}) { return { id: 77, name: REVIEW_CI_CHECK_NAME, app: { id: 4385771 },
  head_sha: identity.review.headSha, external_id: externalId, status: 'queued', conclusion: null, ...change }; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }

describe('shared CI check publication client', () => {
  it('binds request/epoch/C/workflow/lane plan and reports on PR H rather than workflow SHA or test C', () => {
    expect(coordinates.headSha).toBe(identity.review.headSha);
    expect(externalId).toMatch(/^review-yeti-ci:v1:/u);
    expect(externalId).not.toMatch(/^review-yeti-gate:/u);
    const variants: ReviewCiValidationIdentity[] = [
      { ...identity, requestId: '17b3c7a1-12a4-4e42-bc18-71df2e0cae1d' },
      { ...identity, binding: { ...identity.binding, candidateSha: 'f'.repeat(40) } },
      { ...identity, binding: { ...identity.binding, workflowSha: 'f'.repeat(40) } },
      { ...identity, binding: { ...identity.binding, lanePlan: createReviewCiLanePlan(['unit'], ['other required']) } },
    ];
    for (const variant of variants) expect(deriveReviewCiCheckExternalId(reviewCiCheckCoordinates(variant, 1))).not.toBe(externalId);
    expect(deriveReviewCiCheckExternalId(reviewCiCheckCoordinates(identity, 2))).toBe(externalId);
  });
  it('uses the shared one-create transport and exact App/name, then updates only the bound ID', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(check(), 201)).mockResolvedValueOnce(json(check()))
      .mockResolvedValueOnce(json(check({ status: 'completed', conclusion: 'success' })));
    const client = createReviewCiCheckClient({ ...options, fetchImplementation: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.createPending(coordinates)).resolves.toMatchObject({ id: 77, name: REVIEW_CI_CHECK_NAME, appId: 4385771 });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ name: REVIEW_CI_CHECK_NAME, head_sha: identity.review.headSha, external_id: externalId });
    await expect(client.updateExisting(coordinates, 77, { conclusion: 'success' })).resolves.toMatchObject({ id: 77, status: 'completed', conclusion: 'success' });
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', 'PATCH']);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('x-github-api-version')).toBe('2022-11-28');
  });
  it('does not reconcile a foreign App, eligibility gate, or unrelated attempt as CI', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ total_count: 4, check_runs: [
      check({ id: 1, app: { id: 1 } }), check({ id: 2, name: 'Review Yeti Gate' }), check({ id: 3, external_id: 'old-attempt' }), check(),
    ] }));
    await expect(createReviewCiCheckClient({ ...options, fetchImplementation: fetcher }).reconcile(coordinates)).resolves.toMatchObject({ id: 77 });
    expect(String(fetcher.mock.calls[0][0])).toContain('check_name=Review%20Yeti%20CI');
  });
  it.each(['Review Yeti', 'user-check', '', 'Review Yeti CI\n'])('rejects arbitrary check name %j', (checkName) => {
    expect(() => new GitHubReviewGateClient({ ...options, checkName: checkName as 'Review Yeti Gate' })).toThrow('Untrusted service check identity');
  });
  it('requires the exact governed App and never retries an uncertain create', async () => {
    expect(() => createReviewCiCheckClient({ ...options, expectedAppId: 1 })).toThrow('Untrusted CI check identity');
    expect(() => new GitHubReviewGateClient({ ...options, expectedAppId: 1, checkName: REVIEW_CI_CHECK_NAME })).toThrow('Untrusted service check identity');
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC'));
    await expect(createReviewCiCheckClient({ ...options, fetchImplementation: fetcher }).createPending(coordinates)).rejects.toThrow('GitHub Review Yeti gate request failed');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
