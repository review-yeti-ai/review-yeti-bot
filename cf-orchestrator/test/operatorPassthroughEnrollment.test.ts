import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AUTHORITATIVE_REVIEW_APP_ID, PUBLIC_REVIEW_APP_ID, PUBLIC_REVIEW_REPOSITORY,
  PUBLIC_REVIEW_REPOSITORY_ID, reviewAppIdForRepository } from '../src/reviewAppAuthority.js';

describe('service-owned paused publication enrollment', () => {
  it('pins only the four current RHEL task repositories and the Review Yeti source repo by numeric identity', async () => {
    const wrangler = await readFile(resolve(process.cwd(), 'wrangler.toml'), { encoding: 'utf8' });
    const identitiesMatch = wrangler.match(/^OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES\s*=\s*'([^']+)'\s*$/mu);
    const policyMatch = wrangler.match(/^OPERATOR_PASSTHROUGH_POLICY_SOURCE\s*=\s*'([^']+)'\s*$/mu);
    assert.ok(identitiesMatch, 'missing explicit paused-publication repository identities');
    assert.ok(policyMatch, 'missing service-owned current policy source');

    const identities = JSON.parse(identitiesMatch[1]!) as Array<{ repositoryId: number; owner: string; repo: string }>;
    const normalized = identities.map(({ repositoryId, owner, repo }) => `${owner}/${repo}:${repositoryId}`).sort();
    assert.deepEqual(normalized, [
      'calltelemetry/ai-workspace:1131452104',
      'calltelemetry/ct-infrastructure:1355159090',
      'calltelemetry/ct-meta:1232078607',
      'review-yeti-ai/review-yeti-bot:1326169548',
    ]);

    const policy = JSON.parse(policyMatch[1]!) as Record<string, unknown>;
    assert.deepEqual(policy, {
      repositoryId: 1339040553,
      owner: 'calltelemetry',
      repo: 'ct-review-actions',
      ref: 'main',
      path: 'policy/review-yeti.json',
    });
  });

  it('matches the public self-review App identity and secret bindings used by Node authority', async () => {
    const wrangler = await readFile(resolve(process.cwd(), 'wrangler.toml'), { encoding: 'utf8' });
    const nodeConstants = await readFile(resolve(process.cwd(), '../src/config/repositoryReviewAuthorityConstants.ts'), { encoding: 'utf8' });
    const nodeService = await readFile(resolve(process.cwd(), '../src/auth/authoritativeServiceIdentity.ts'), { encoding: 'utf8' });
    const nodeActionDispatch = await readFile(resolve(process.cwd(), '../src/config/actionDispatchConfig.ts'), { encoding: 'utf8' });
    const nodeAppId = Number(nodeConstants.match(/PUBLIC_REVIEW_APP_ID\s*=\s*(\d+)/u)?.[1]);
    const nodeRepositoryId = Number(nodeConstants.match(/PUBLIC_REVIEW_REPOSITORY_ID\s*=\s*(\d+)/u)?.[1]);
    const nodeRepository = nodeConstants.match(/PUBLIC_REVIEW_REPOSITORY\s*=\s*'([^']+)'/u)?.[1];
    const nodeAuthoritativeAppId = Number(nodeService.match(/AUTHORITATIVE_REVIEW_APP_ID\s*=\s*(\d+)/u)?.[1]);

    assert.equal(PUBLIC_REVIEW_APP_ID, nodeAppId);
    assert.equal(PUBLIC_REVIEW_REPOSITORY_ID, nodeRepositoryId);
    assert.equal(PUBLIC_REVIEW_REPOSITORY, nodeRepository);
    assert.equal(AUTHORITATIVE_REVIEW_APP_ID, nodeAuthoritativeAppId);
    assert.equal(reviewAppIdForRepository({
      repositoryId: nodeRepositoryId,
      owner: nodeRepository!.split('/')[0]!,
      repo: nodeRepository!.split('/')[1]!,
    }), nodeAppId);
    assert.equal(reviewAppIdForRepository({ repositoryId: 1232078607, owner: 'calltelemetry', repo: 'ct-meta' }), nodeAuthoritativeAppId);
    assert.match(wrangler, new RegExp(`^REVIEW_YETI_PUBLIC_TARGET_APP_ID\\s*=\\s*"${nodeAppId}"`, 'mu'));
    assert.match(nodeActionDispatch, /REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY/u);
    const edgeTypes = await readFile(resolve(process.cwd(), 'src/types.ts'), { encoding: 'utf8' });
    assert.match(edgeTypes, /REVIEW_YETI_PUBLIC_TARGET_APP_ID\?: string/u);
    assert.match(edgeTypes, /REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY\?: string/u);
  });
});
