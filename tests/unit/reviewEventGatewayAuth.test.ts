import { describe, expect, it } from 'vitest';
import {
  REVIEW_EVENT_GATEWAY_GRANT_SCHEMA,
  authorizeReviewEventAccess,
  authenticateReviewEventRequest,
  createReviewEventAuthConfig,
  createReviewEventGrant,
  parseReviewEventServiceCredentials,
  sha256TokenDigest,
  verifyReviewEventGrant,
  type ReviewEventIdentity,
  type ReviewEventPrincipal,
  type ReviewEventServiceCredential,
} from '../../src/events/reviewEventGatewayAuth';

const SERVICE_TOKEN = 'service-token-for-review-events';
const GRANT_SECRET = 'review-event-grant-secret-with-at-least-32-bytes';

const identity: ReviewEventIdentity = {
  repositoryId: 4242,
  runId: 'run-4242-attempt-1',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
};

const serviceCredential: ReviewEventServiceCredential = {
  id: 'gateway-reader',
  tokenDigest: sha256TokenDigest(SERVICE_TOKEN),
  repositoryIds: [identity.repositoryId],
  runIds: [identity.runId],
};

function authConfig(overrides: Partial<Parameters<typeof createReviewEventAuthConfig>[0]> = {}) {
  return createReviewEventAuthConfig({
    serviceCredentials: [serviceCredential],
    grantSecret: GRANT_SECRET,
    now: () => 1_700_000_000_000,
    ...overrides,
  });
}

describe('review event gateway auth contract', () => {
  it('hashes bearer material as a deterministic SHA-256 digest', () => {
    expect(sha256TokenDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('parses only hashed, explicitly scoped service credentials', () => {
    const parsed = parseReviewEventServiceCredentials(JSON.stringify([
      {
        id: 'reader',
        tokenDigest: serviceCredential.tokenDigest,
        repositoryIds: [4242],
        runIds: ['run-4242-attempt-1'],
      },
    ]));

    expect(parsed).toEqual([{
      ...serviceCredential,
      id: 'reader',
    }]);
    expect(() => parseReviewEventServiceCredentials(JSON.stringify([
      { id: 'raw-token', token: SERVICE_TOKEN, repositoryIds: [4242] },
    ]))).toThrow(/tokenDigest/i);
    expect(() => parseReviewEventServiceCredentials(JSON.stringify([
      { id: 'unscoped', tokenDigest: 'a'.repeat(64), repositoryIds: [] },
    ]))).toThrow(/repository/i);
  });

  it.each([undefined, '', ' \t\n '])('keeps absent or blank service configuration fail-closed (%j)', raw => {
    const credentials = parseReviewEventServiceCredentials(raw);
    expect(credentials).toEqual([]);
    const config = createReviewEventAuthConfig({ serviceCredentials: credentials });
    expect(authenticateReviewEventRequest({ authorization: `Bearer ${SERVICE_TOKEN}` }, config))
      .toMatchObject({ kind: 'unauthenticated', reason: 'invalid' });
    expect(() => parseReviewEventServiceCredentials('{malformed')).toThrow(/valid JSON/);
  });

  it('returns unauthenticated for missing, malformed, unknown, and legacy demo credentials', () => {
    const config = authConfig();

    expect(authenticateReviewEventRequest({}, config)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'missing',
    });
    expect(authenticateReviewEventRequest({ authorization: 'Basic abc' }, config)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'invalid',
    });
    expect(authenticateReviewEventRequest({ authorization: 'Bearer unknown' }, config)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'invalid',
    });
    expect(authenticateReviewEventRequest({ authorization: 'Bearer demo_token_public' }, config)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'invalid',
    });
    expect(authenticateReviewEventRequest({ authorization: 'Bearer public_viewer_token' }, config)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'invalid',
    });
    // A legacy session-looking value is not a gateway credential unless its
    // digest was explicitly provisioned with a repository scope.
    expect(authenticateReviewEventRequest({ authorization: 'Bearer sess_admin_default_password' }, config)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'invalid',
    });
  });

  it('rejects query-string credentials even when the value is a configured bearer token', () => {
    const config = authConfig();
    expect(authenticateReviewEventRequest({ queryToken: SERVICE_TOKEN }, config)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'query_token_rejected',
    });
    expect(authenticateReviewEventRequest({
      authorization: `Bearer ${SERVICE_TOKEN}`,
      queryToken: SERVICE_TOKEN,
    }, config)).toMatchObject({
      kind: 'unauthenticated',
      reason: 'query_token_rejected',
    });
  });

  it('authenticates a configured service bearer and preserves its exact scopes', () => {
    const result = authenticateReviewEventRequest({ authorization: `Bearer ${SERVICE_TOKEN}` }, authConfig());
    expect(result.kind).toBe('authenticated');
    if (result.kind !== 'authenticated') return;
    expect(result.principal).toMatchObject({
      kind: 'service',
      subject: 'gateway-reader',
      repositoryIds: [4242],
      runIds: ['run-4242-attempt-1'],
    });
  });

  it('rejects even empty query-token presence alongside an otherwise valid bearer', () => {
    expect(authenticateReviewEventRequest({ authorization: `Bearer ${SERVICE_TOKEN}`, queryToken: '' }, authConfig()))
      .toMatchObject({ kind: 'unauthenticated', reason: 'query_token_rejected' });
  });

  it('rejects ambiguous digest aliases instead of selecting whichever scope is configured last', () => {
    const aliases = [serviceCredential, { ...serviceCredential, id: 'other-repository', repositoryIds: [999] }];
    expect(() => createReviewEventAuthConfig({ serviceCredentials: aliases })).toThrow(/duplicate.*digest/i);
    expect(() => parseReviewEventServiceCredentials(JSON.stringify(aliases))).toThrow(/duplicate.*digest/i);
  });

  it('rejects non-canonical HMAC signature encodings', () => {
    const grant = createReviewEventGrant({ subject: 'reader', repositoryIds: [identity.repositoryId] },
      identity, GRANT_SECRET, { now: 1_700_000_000_000 });
    for (const suffix of ['!', '=']) {
      expect(verifyReviewEventGrant(grant.token + suffix, GRANT_SECRET, { now: 1_700_000_001_000 })).toBeNull();
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(grant.token.at(-1)!);
    const aliased = grant.token.slice(0, -1) + alphabet[last + 1];
    expect(Buffer.from(aliased.split('.')[2], 'base64url')).toEqual(Buffer.from(grant.token.split('.')[2], 'base64url'));
    expect(verifyReviewEventGrant(aliased, GRANT_SECRET, { now: 1_700_000_001_000 })).toBeNull();
  });

  it('creates a bounded single-run grant only for an already scoped principal', () => {
    const principal: ReviewEventPrincipal = {
      kind: 'service',
      subject: 'app-session-issuer',
      repositoryIds: [identity.repositoryId],
      runIds: [identity.runId],
    };
    const grant = createReviewEventGrant(principal, identity, GRANT_SECRET, {
      now: 1_700_000_000_000,
      ttlSeconds: 60,
    });

    expect(grant.expiresAt).toBe(1_700_000_060);
    expect(grant.token.split('.')).toHaveLength(3);
    expect(verifyReviewEventGrant(grant.token, GRANT_SECRET, { now: 1_700_000_030_000 })).toMatchObject({
      kind: 'grant',
      subject: 'app-session-issuer',
      identity,
      expiresAt: 1_700_000_060,
    });

    expect(() => createReviewEventGrant({ ...principal, repositoryIds: [99] }, identity, GRANT_SECRET))
      .toThrow(/repository scope/i);
    expect(() => createReviewEventGrant({ ...principal, runIds: ['other-run'] }, identity, GRANT_SECRET))
      .toThrow(/run scope/i);
  });

  it('authenticates a grant bearer through the gateway entry point, with no service credential match', () => {
    const grant = createReviewEventGrant({ subject: 'session-reader', repositoryIds: [identity.repositoryId] },
      identity, GRANT_SECRET, { now: 1_700_000_000_000 });
    const config = authConfig({ serviceCredentials: [] });
    expect(authenticateReviewEventRequest({ authorization: `Bearer ${grant.token}` }, config))
      .toMatchObject({ kind: 'authenticated', principal: { kind: 'grant', subject: 'session-reader',
        identity, repositoryIds: [identity.repositoryId], runIds: [identity.runId] } });
    expect(authenticateReviewEventRequest({ authorization: `Bearer ${grant.token}` },
      authConfig({ serviceCredentials: [], now: () => 1_700_000_060_000 })))
      .toMatchObject({ kind: 'unauthenticated', reason: 'invalid' });
    expect(authenticateReviewEventRequest({ authorization: `Bearer ${grant.token}` },
      authConfig({ serviceCredentials: [], grantSecret: 'different-secret-with-at-least-32-bytes' })))
      .toMatchObject({ kind: 'unauthenticated', reason: 'invalid' });
  });

  it('does not let an authenticated grant principal issue a new grant', () => {
    const grant = createReviewEventGrant({ subject: 'session-reader', repositoryIds: [identity.repositoryId] },
      identity, GRANT_SECRET, { now: 1_700_000_000_000 });
    const authenticated = authenticateReviewEventRequest({ authorization: `Bearer ${grant.token}` },
      authConfig({ serviceCredentials: [] }));
    expect(authenticated.kind).toBe('authenticated');
    if (authenticated.kind !== 'authenticated') throw new Error('Grant fixture failed');
    expect(() => createReviewEventGrant(authenticated.principal, identity, GRANT_SECRET,
      { now: 1_700_000_030_000 })).toThrow('a grant cannot issue another grant');
  });

  it('rejects grants with a missing, invalid, expired, or overlong lifetime', () => {
    const principal: ReviewEventPrincipal = {
      kind: 'service',
      subject: 'app-session-issuer',
      repositoryIds: [identity.repositoryId],
      runIds: [identity.runId],
    };
    expect(() => createReviewEventGrant(principal, identity, GRANT_SECRET, { ttlSeconds: 0 })).toThrow(/ttl/i);
    expect(() => createReviewEventGrant(principal, identity, GRANT_SECRET, { ttlSeconds: 301 })).toThrow(/ttl/i);

    const grant = createReviewEventGrant(principal, identity, GRANT_SECRET, {
      now: 1_700_000_000_000,
      ttlSeconds: 60,
    });
    expect(verifyReviewEventGrant(grant.token, GRANT_SECRET, { now: 1_700_000_060_000 })).toBeNull();
    expect(verifyReviewEventGrant(grant.token, GRANT_SECRET, { now: 1_700_000_061_000 })).toBeNull();
    expect(verifyReviewEventGrant('not-a-grant', GRANT_SECRET, { now: 1_700_000_000_000 })).toBeNull();
  });

  it('rejects tampering and a different HMAC secret without disclosing grant details', () => {
    const principal: ReviewEventPrincipal = {
      kind: 'service',
      subject: 'app-session-issuer',
      repositoryIds: [identity.repositoryId],
      runIds: [identity.runId],
    };
    const grant = createReviewEventGrant(principal, identity, GRANT_SECRET, {
      now: 1_700_000_000_000,
      ttlSeconds: 60,
    });
    const [header, encodedPayload, signature] = grant.token.split('.');
    const changedPayload = Buffer.from(JSON.stringify({
      schema: REVIEW_EVENT_GATEWAY_GRANT_SCHEMA,
      subject: 'attacker',
      repository_id: identity.repositoryId,
      run_id: identity.runId,
      base_sha: identity.baseSha,
      head_sha: identity.headSha,
      issued_at: 1_700_000_000,
      expires_at: 1_700_000_060,
    })).toString('base64url');

    expect(verifyReviewEventGrant(`${header}.${changedPayload}.${signature}`, GRANT_SECRET, {
      now: 1_700_000_001_000,
    })).toBeNull();
    expect(verifyReviewEventGrant(grant.token, `${GRANT_SECRET}-wrong`, {
      now: 1_700_000_001_000,
    })).toBeNull();
    expect(encodedPayload).not.toBe(changedPayload);
  });

  it('returns authenticated foreign-run access separately from unauthenticated access', () => {
    const serviceResult = authenticateReviewEventRequest({ authorization: `Bearer ${SERVICE_TOKEN}` }, authConfig());
    expect(serviceResult.kind).toBe('authenticated');
    if (serviceResult.kind !== 'authenticated') return;

    expect(authorizeReviewEventAccess(serviceResult.principal, identity)).toEqual({
      kind: 'authorized',
      principal: serviceResult.principal,
    });
    expect(authorizeReviewEventAccess(serviceResult.principal, { ...identity, runId: 'other-run' })).toMatchObject({
      kind: 'authenticated_foreign_run',
      reason: 'run_scope',
    });
    expect(authorizeReviewEventAccess(serviceResult.principal, { ...identity, repositoryId: 999 })).toMatchObject({
      kind: 'authenticated_foreign_run',
      reason: 'repository_scope',
    });

    const unauthenticated = authenticateReviewEventRequest({ authorization: 'Bearer invalid' }, authConfig());
    expect(unauthenticated.kind).toBe('unauthenticated');
  });

  it('supports repository-wide service scope while preserving an optional exact-run restriction', () => {
    const repositoryReader = authenticateReviewEventRequest({ authorization: `Bearer ${SERVICE_TOKEN}` }, authConfig({
      serviceCredentials: [{
        ...serviceCredential,
        runIds: undefined,
      }],
    }));
    expect(repositoryReader.kind).toBe('authenticated');
    if (repositoryReader.kind !== 'authenticated') return;

    expect(authorizeReviewEventAccess(repositoryReader.principal, {
      ...identity,
      runId: 'another-run-in-the-same-repository',
    }).kind).toBe('authorized');
    expect(authorizeReviewEventAccess(repositoryReader.principal, {
      ...identity,
      repositoryId: 999,
    })).toMatchObject({
      kind: 'authenticated_foreign_run',
      reason: 'repository_scope',
    });
  });

  it('requires a grant to match repository, run, base, and head exactly', () => {
    const principal: ReviewEventPrincipal = {
      kind: 'service',
      subject: 'app-session-issuer',
      repositoryIds: [identity.repositoryId],
      runIds: [identity.runId],
    };
    const grant = createReviewEventGrant(principal, identity, GRANT_SECRET, {
      now: 1_700_000_000_000,
      ttlSeconds: 60,
    });
    const authenticated = verifyReviewEventGrant(grant.token, GRANT_SECRET, { now: 1_700_000_001_000 });
    expect(authenticated?.kind).toBe('grant');
    if (!authenticated || authenticated.kind !== 'grant') return;

    for (const changed of [
      { repositoryId: 999 },
      { runId: 'other-run' },
      { baseSha: 'c'.repeat(40) },
      { headSha: 'd'.repeat(40) },
    ]) {
      expect(authorizeReviewEventAccess(authenticated, { ...identity, ...changed })).toMatchObject({
        kind: 'authenticated_foreign_run',
        reason: 'grant_identity_mismatch',
      });
    }
  });
});
