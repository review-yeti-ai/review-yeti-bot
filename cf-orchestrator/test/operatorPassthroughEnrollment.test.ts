import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AUTHORITATIVE_REVIEW_APP_ID, PUBLIC_REVIEW_APP_ID, PUBLIC_REVIEW_REPOSITORY,
  PUBLIC_REVIEW_REPOSITORY_ID, reviewAppIdForRepository } from '../src/reviewAppAuthority.js';

describe('paused publication enrollment configuration', () => {
  it('keeps existing binding names without source manifests or Wrangler-required secrets', async () => {
    const wrangler = await readFile(resolve(process.cwd(), 'wrangler.toml'), { encoding: 'utf8' });
    const edgeTypes = await readFile(resolve(process.cwd(), 'src/types.ts'), { encoding: 'utf8' });
    const publisher = await readFile(resolve(process.cwd(), 'src/operatorPassthroughPublisher.ts'), { encoding: 'utf8' });

    assert.equal(/^keep_vars\s*=\s*true\s*$/mu.test(wrangler), true);
    assert.equal(/^\[secrets\]\s*$/mu.test(wrangler), false);
    assert.equal(/^OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES\s*=/mu.test(wrangler), false,
      'repository identity manifests must not be checked into Wrangler source');
    assert.equal(/^OPERATOR_PASSTHROUGH_POLICY_SOURCE\s*=/mu.test(wrangler), false,
      'policy source manifests must not be checked into Wrangler source');
    assert.equal(/OPERATOR_PASSTHROUGH_(?:REPOSITORY_IDENTITIES|POLICY_SOURCE)_CONFIG/u.test(edgeTypes), false);
    assert.equal(/OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES\?: string/u.test(edgeTypes), true);
    assert.equal(/OPERATOR_PASSTHROUGH_POLICY_SOURCE\?: string/u.test(edgeTypes), true);
    assert.equal(/OPERATOR_PASSTHROUGH_PRIVATE_REPOSITORY_IDENTITIES\?: string/u.test(edgeTypes), true);
    assert.equal(/env\.OPERATOR_PASSTHROUGH_REPOSITORY_IDENTITIES\b/u.test(publisher), true);
    assert.equal(/env\.OPERATOR_PASSTHROUGH_POLICY_SOURCE\b/u.test(publisher), true);
    assert.equal(/OPERATOR_PASSTHROUGH_(?:REPOSITORY_IDENTITIES|POLICY_SOURCE)_CONFIG/u.test(publisher), false);
  });

  it('uses synthetic enrollment identities while retaining the public self-review App authority', async () => {
    const wrangler = await readFile(resolve(process.cwd(), 'wrangler.toml'), { encoding: 'utf8' });
    const nodeConstants = await readFile(resolve(process.cwd(), '../src/config/repositoryReviewAuthorityConstants.ts'), { encoding: 'utf8' });
    const nodeService = await readFile(resolve(process.cwd(), '../src/auth/authoritativeServiceIdentity.ts'), { encoding: 'utf8' });
    const nodeActionDispatch = await readFile(resolve(process.cwd(), '../src/config/actionDispatchConfig.ts'), { encoding: 'utf8' });
    const nodeAppId = Number(nodeConstants.match(/PUBLIC_REVIEW_APP_ID\s*=\s*(\d+)/u)?.[1]);
    const nodeRepositoryId = Number(nodeConstants.match(/PUBLIC_REVIEW_REPOSITORY_ID\s*=\s*(\d+)/u)?.[1]);
    const nodeRepository = nodeConstants.match(/PUBLIC_REVIEW_REPOSITORY\s*=\s*'([^']+)'/u)?.[1];
    const nodeAuthoritativeAppId = Number(nodeService.match(/AUTHORITATIVE_REVIEW_APP_ID\s*=\s*(\d+)/u)?.[1]);
    const [owner, repo] = nodeRepository!.split('/');

    assert.equal(PUBLIC_REVIEW_APP_ID, nodeAppId);
    assert.equal(PUBLIC_REVIEW_REPOSITORY_ID, nodeRepositoryId);
    assert.equal(PUBLIC_REVIEW_REPOSITORY, nodeRepository);
    assert.equal(AUTHORITATIVE_REVIEW_APP_ID, nodeAuthoritativeAppId);
    assert.equal(reviewAppIdForRepository({ repositoryId: nodeRepositoryId, owner: owner!, repo: repo! }), nodeAppId);
    assert.equal(reviewAppIdForRepository({ repositoryId: 987654321, owner: 'synthetic-owner', repo: 'synthetic-repository' }),
      nodeAuthoritativeAppId);
    assert.match(wrangler, new RegExp('^REVIEW_YETI_PUBLIC_TARGET_APP_ID\\s*=\\s*"' + nodeAppId + '"', 'mu'));
    assert.match(nodeActionDispatch, /REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY/u);
    assert.match(await readFile(resolve(process.cwd(), 'src/types.ts'), { encoding: 'utf8' }), /REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY\?: string/u);
  });

  it('keeps optional private enrollment as a Worker secret outside checked-in vars', async () => {
    const wrangler = await readFile(resolve(process.cwd(), 'wrangler.toml'), { encoding: 'utf8' });
    const workflow = await readFile(resolve(process.cwd(), '../.github/workflows/cf-orchestrator-ci.yaml'), { encoding: 'utf8' });
    const edgeTypes = await readFile(resolve(process.cwd(), 'src/types.ts'), { encoding: 'utf8' });

    assert.match(edgeTypes, /OPERATOR_PASSTHROUGH_PRIVATE_REPOSITORY_IDENTITIES\?: string/u);
    assert.doesNotMatch(wrangler, /OPERATOR_PASSTHROUGH_PRIVATE_REPOSITORY_IDENTITIES/u);
    assert.match(workflow, /uses:\s*cloudflare\/wrangler-action@v3/u);
    assert.match(workflow, /command:\s*deploy/u);
    assert.doesNotMatch(workflow, /OPERATOR_PASSTHROUGH_PRIVATE_REPOSITORY_IDENTITIES/u);
  });
});
