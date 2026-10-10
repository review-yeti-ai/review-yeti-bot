import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
});
