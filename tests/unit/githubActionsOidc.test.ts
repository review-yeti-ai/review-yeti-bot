import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GitHubActionsOidcVerifier } from '../../src/auth/githubActionsOidc';

let privateKey: CryptoKey;
let keySet: ReturnType<typeof createLocalJWKSet>;

const claims = {
  repository: 'calltelemetry/cisco-cdr',
  repository_id: '123',
  repository_owner_id: '99',
  run_id: '98765',
  run_attempt: '2',
  event_name: 'workflow_dispatch',
  job_workflow_ref: 'calltelemetry/ct-review-actions/.github/workflows/review.yml@refs/heads/main',
  job_workflow_sha: 'd'.repeat(40),
};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
});

async function token(overrides: Record<string, unknown> = {}, audience = 'review-yeti-doks-dispatch') {
  return new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://token.actions.githubusercontent.com')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function verifier() {
  return new GitHubActionsOidcVerifier({
    keySet,
    policy: {
      repositoryIds: new Set(['123']),
      ownerIds: new Set(['99']),
      workflowRefs: new Set([claims.job_workflow_ref]),
      workflowShas: new Set([claims.job_workflow_sha]),
      allowedEvents: new Set(['workflow_dispatch', 'pull_request_target']),
      allowAppGate: false,
    },
  });
}

describe('GitHub Actions OIDC verification', () => {
  it('accepts the GitHub issuer, fixed audience, and immutable allowlisted claims', async () => {
    await expect(verifier().verify(await token())).resolves.toEqual(expect.objectContaining(claims));
  });

  it('rejects a wrong audience, owner, repository, workflow ref, workflow sha, or event', async () => {
    await expect(verifier().verify(await token({}, 'another-service'))).rejects.toThrow();
    await expect(verifier().verify(await token({ repository_owner_id: '100' }))).rejects.toThrow(/owner/i);
    await expect(verifier().verify(await token({ repository_id: '999' }))).rejects.toThrow(/repository/i);
    await expect(verifier().verify(await token({ job_workflow_ref: 'evil/repo/.github/workflows/x.yml@main' }))).rejects.toThrow(/workflow ref/i);
    await expect(verifier().verify(await token({ job_workflow_sha: 'e'.repeat(40) }))).rejects.toThrow(/workflow sha/i);
    await expect(verifier().verify(await token({ event_name: 'schedule' }))).rejects.toThrow(/event/i);
  });

  it('rejects expired tokens and tokens without immutable workflow provenance', async () => {
    const expired = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('https://token.actions.githubusercontent.com')
      .setAudience('review-yeti-doks-dispatch')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1_000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 500)
      .sign(privateKey);
    await expect(verifier().verify(expired)).rejects.toThrow();
    await expect(verifier().verify(await token({ job_workflow_ref: undefined, job_workflow_sha: undefined }))).rejects.toThrow(/workflow provenance/i);
  });
});
