import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { authService, GitHubUserProfile } from '../../src/dashboard/authService';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { Express } from 'express';

describe('Milestone 1 Challenger 1: Adversarial Stress Suite (GitHub OAuth & Sessions)', () => {
  let app: Express;
  const originalEnv = { ...process.env };
  const SENSITIVE_TOKEN = 'gho_TOP_SECRET_GITHUB_OAUTH_TOKEN_DO_NOT_LEAK_xyz987';

  const setupMockGitHubFetch = (customProfile?: Partial<GitHubUserProfile>) => {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/login/oauth/access_token')) {
        return new Response(
          JSON.stringify({
            access_token: SENSITIVE_TOKEN,
            token_type: 'bearer',
            scope: 'read:user,user:email,read:org,repo',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.endsWith('/user')) {
        return new Response(
          JSON.stringify({
            id: 583231,
            login: 'octocat',
            name: 'The Octocat',
            avatar_url: 'https://avatars.githubusercontent.com/u/583231',
            email: null,
            ...(customProfile || {}),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (urlStr.endsWith('/user/emails')) {
        return new Response(
          JSON.stringify([
            { email: 'octocat@github.com', primary: true, verified: true },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not Found', { status: 404 });
    });
  };

  beforeEach(() => {
    authService.reset();
    dashboardStore.reset();
    process.env.GITHUB_CLIENT_ID = 'test_gh_client_id_stress';
    process.env.GITHUB_CLIENT_SECRET = 'test_gh_client_secret_stress';
    app = createApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Adversarial State & CSRF Replay Suite
  // =========================================================================
  describe('1. Adversarial State & CSRF Replay Suite', () => {
    it('rejects completely empty or missing state query parameter', async () => {
      const res1 = await request(app).get('/api/auth/github/callback?code=mock_code');
      expect(res1.status).toBe(400);
      expect(res1.body.success).toBe(false);
      expect(res1.body.error).toMatch(/Missing code or state/i);

      const res2 = await request(app).get('/api/auth/github/callback?code=mock_code&state=');
      expect(res2.status).toBe(400);
      expect(res2.body.success).toBe(false);
      expect(res2.body.error).toMatch(/Missing code or state/i);
    });

    it('rejects missing code query parameter even if state is valid', async () => {
      const state = authService.createOAuthState('/repos');
      const res = await request(app).get(`/api/auth/github/callback?state=${state}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Missing code or state/i);
    });

    it('rejects malicious injection payloads as state', async () => {
      const attackPayloads = [
        "' OR '1'='1",
        '<script>alert(1)</script>',
        '../../../../etc/passwd',
        '%00nullbyte',
        '{"state":"forged"}',
        'a'.repeat(2048),
      ];

      for (const payload of attackPayloads) {
        const res = await request(app).get(
          `/api/auth/github/callback?code=mock_code&state=${encodeURIComponent(payload)}`
        );
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Invalid or expired OAuth state/i);
      }
    });

    it('strictly enforces single-use consumption (anti-replay attack protection)', async () => {
      setupMockGitHubFetch();
      const state = authService.createOAuthState('/repos');

      // 1st consumption: legitimate user
      const firstRes = await request(app).get(
        `/api/auth/github/callback?code=legit_code_123&state=${state}&format=json`
      );
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.success).toBe(true);

      // 2nd consumption: replay attack with the exact same state
      const replayRes = await request(app).get(
        `/api/auth/github/callback?code=attacker_code_456&state=${state}&format=json`
      );
      expect(replayRes.status).toBe(400);
      expect(replayRes.body.success).toBe(false);
      expect(replayRes.body.error).toMatch(/Invalid or expired OAuth state/i);
    });

    it('rejects expired states past 10 minutes TTL', async () => {
      const state = authService.createOAuthState('/repos');

      // Fast-forward time past 10 minutes (600,000 ms) + 5 seconds
      const originalNow = Date.now;
      try {
        const tenMinutesLater = Date.now() + 10 * 60 * 1000 + 5000;
        Date.now = vi.fn(() => tenMinutesLater);

        const res = await request(app).get(
          `/api/auth/github/callback?code=mock_code&state=${state}&format=json`
        );
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Invalid or expired OAuth state/i);
      } finally {
        Date.now = originalNow;
      }
    });

    it('handles concurrent state consumption race condition: exactly 1 succeeds and 9 fail', async () => {
      setupMockGitHubFetch();
      const state = authService.createOAuthState('/repos');

      // Launch 10 simultaneous requests attempting to consume the single-use state
      const requests = Array.from({ length: 10 }, (_, i) =>
        request(app).get(
          `/api/auth/github/callback?code=race_code_${i}&state=${state}&format=json`
        )
      );

      const results = await Promise.all(requests);
      const successful = results.filter((r) => r.status === 200);
      const failed = results.filter((r) => r.status === 400);

      expect(successful.length).toBe(1);
      expect(failed.length).toBe(9);
      for (const f of failed) {
        expect(f.body.error).toMatch(/Invalid or expired OAuth state/i);
      }
    });

    it('prunes expired states when creating a new state to prevent unbounded memory growth', () => {
      const originalNow = Date.now;
      let currentTime = 1_000_000_000;
      Date.now = () => currentTime;

      try {
        // Create 5 old states
        for (let i = 0; i < 5; i++) {
          authService.createOAuthState(`/repos/${i}`);
        }

        // Advance time by 11 minutes
        currentTime += 11 * 60 * 1000;

        // Creating a new state should trigger the pruning of the 5 expired states
        const freshState = authService.createOAuthState('/fresh');
        expect(freshState).toBeDefined();

        // The fresh state should be valid
        const consumeFresh = authService.consumeOAuthState(freshState);
        expect(consumeFresh.valid).toBe(true);
        expect(consumeFresh.returnTo).toBe('/fresh');
      } finally {
        Date.now = originalNow;
      }
    });
  });

  // =========================================================================
  // 2. Adversarial Open Redirect & URL Sanitization Suite
  // =========================================================================
  describe('2. Adversarial Open Redirect & URL Sanitization Suite', () => {
    const maliciousReturnTos = [
      '//evil.com',
      '//evil.com/phishing',
      '///evil.com',
      '////evil.com',
      'https://evil.com',
      'http://evil.com',
      'javascript:alert(document.cookie)',
      'data:text/html,<script>window.location="http://evil.com"</script>',
      '/\\evil.com',
      '/\\\\evil.com',
      '/\\/evil.com',
      '@evil.com',
      '\\evil.com',
      'https://evil.com@legit.com',
      '//attacker.net\\@legit.com',
    ];

    it.each(maliciousReturnTos)(
      'sanitizes malicious return_to "%s" to safe default /repos',
      async (maliciousReturnTo) => {
        setupMockGitHubFetch();

        // 1. Initiate OAuth with malicious return_to
        const initRes = await request(app)
          .get(`/api/auth/github?return_to=${encodeURIComponent(maliciousReturnTo)}&format=json`);
        expect(initRes.status).toBe(200);
        const state = initRes.body.state;
        expect(state).toBeDefined();

        // 2. Perform OAuth callback redirect
        const callbackRes = await request(app).get(
          `/api/auth/github/callback?code=mock_code&state=${state}`
        );
        expect(callbackRes.status).toBe(302);
        const location = callbackRes.headers.location;
        expect(location).toBeDefined();

        // Must redirect to application's local /repos and NEVER to evil.com
        const parsedUrl = new URL(location);
        expect(parsedUrl.pathname).toBe('/repos');
        expect(parsedUrl.hostname).not.toContain('evil.com');
        expect(parsedUrl.hostname).not.toContain('attacker.net');
        expect(parsedUrl.searchParams.has('token')).toBe(true);
      }
    );

    it('safely preserves legitimate relative URLs with path, query, and hash', async () => {
      setupMockGitHubFetch();
      const validTarget = '/repos?filter=monitored&sort=updated#active-prs';

      const initRes = await request(app)
        .get(`/api/auth/github?return_to=${encodeURIComponent(validTarget)}&format=json`);
      expect(initRes.status).toBe(200);
      const state = initRes.body.state;

      const callbackRes = await request(app).get(
        `/api/auth/github/callback?code=mock_code&state=${state}`
      );
      expect(callbackRes.status).toBe(302);
      const location = callbackRes.headers.location;

      const parsedUrl = new URL(location);
      expect(parsedUrl.pathname).toBe('/repos');
      expect(parsedUrl.searchParams.get('filter')).toBe('monitored');
      expect(parsedUrl.searchParams.get('sort')).toBe('updated');
      expect(parsedUrl.searchParams.has('token')).toBe(true);
      expect(parsedUrl.hash).toBe('#active-prs');
    });
  });

  // =========================================================================
  // 3. Adversarial Token Leakage & Exposure Suite
  // =========================================================================
  describe('3. Adversarial Token Leakage & Exposure Suite', () => {
    it('NEVER leaks upstream GitHub accessToken in GET /api/auth/session', async () => {
      const userProfile: GitHubUserProfile = {
        id: 'gh_12345',
        username: 'secure_user',
        name: 'Secure User',
        email: 'secure@example.com',
        avatarUrl: 'https://avatars.githubusercontent.com/u/12345',
        role: 'reviewer',
        provider: 'github',
        accessToken: SENSITIVE_TOKEN,
      };

      const session = authService.createGitHubSession(userProfile);

      const res = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.user).toBeDefined();

      // Deep verification: sensitive token MUST NOT appear anywhere in the body
      const serializedBody = JSON.stringify(res.body);
      expect(serializedBody).not.toContain(SENSITIVE_TOKEN);
      expect(res.body.user.accessToken).toBeUndefined();
      expect(res.body.accessToken).toBeUndefined();
    });

    it('NEVER leaks upstream GitHub accessToken in GET /api/auth/github/callback (JSON format)', async () => {
      setupMockGitHubFetch();
      const state = authService.createOAuthState('/repos');

      const res = await request(app).get(
        `/api/auth/github/callback?code=code_sensitive&state=${state}&format=json`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user).toBeDefined();

      const serializedBody = JSON.stringify(res.body);
      expect(serializedBody).not.toContain(SENSITIVE_TOKEN);
      expect(res.body.user.accessToken).toBeUndefined();
      expect(res.body.accessToken).toBeUndefined();
    });

    it('NEVER leaks upstream GitHub accessToken in GET /api/auth/github/callback HTTP 302 Location URL', async () => {
      setupMockGitHubFetch();
      const state = authService.createOAuthState('/repos');

      const res = await request(app).get(
        `/api/auth/github/callback?code=code_sensitive&state=${state}`
      );

      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toBeDefined();
      expect(location).not.toContain(SENSITIVE_TOKEN);

      const parsedUrl = new URL(location);
      const tokenInQuery = parsedUrl.searchParams.get('token');
      expect(tokenInQuery).toMatch(/^sess_/);
      expect(tokenInQuery).not.toBe(SENSITIVE_TOKEN);
    });

    it('NEVER exposes accessToken in API key or protected endpoints', async () => {
      const userProfile: GitHubUserProfile = {
        id: 'gh_admin_1',
        username: 'admin_user',
        role: 'admin',
        provider: 'github',
        accessToken: SENSITIVE_TOKEN,
      };
      const session = authService.createGitHubSession(userProfile);

      const res = await request(app)
        .get('/api/auth/apikeys')
        .set('Authorization', `Bearer ${session.token}`);

      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(SENSITIVE_TOKEN);
    });
  });

  // =========================================================================
  // 4. Rapid Concurrent Logins & Multi-Session Isolation Suite
  // =========================================================================
  describe('4. Rapid Concurrent Logins & Multi-Session Isolation Suite', () => {
    it('handles 25 concurrent logins simultaneously with independent, non-conflicting sessions', async () => {
      setupMockGitHubFetch();
      const CONCURRENCY = 25;

      // 1. Generate 25 distinct states
      const states = Array.from({ length: CONCURRENCY }, (_, i) =>
        authService.createOAuthState(`/repos/project_${i}`)
      );

      // Verify all states are unique
      expect(new Set(states).size).toBe(CONCURRENCY);

      // 2. Perform 25 simultaneous callback exchanges
      const loginPromises = states.map((state, idx) =>
        request(app).get(
          `/api/auth/github/callback?code=mock_code_${idx}&state=${state}&format=json`
        )
      );

      const loginResults = await Promise.all(loginPromises);

      // 3. Assert all 25 logins succeeded
      for (const res of loginResults) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toMatch(/^sess_/);
      }

      // 4. Assert all session tokens are distinct
      const tokens = loginResults.map((r) => r.body.token);
      expect(new Set(tokens).size).toBe(CONCURRENCY);

      // 5. Stress test session validation: invoke GET /api/auth/session for all 25 concurrently
      const sessionCheckPromises = tokens.map((token) =>
        request(app)
          .get('/api/auth/session')
          .set('Authorization', `Bearer ${token}`)
      );

      const sessionChecks = await Promise.all(sessionCheckPromises);
      for (const res of sessionChecks) {
        expect(res.status).toBe(200);
        expect(res.body.authenticated).toBe(true);
        expect(res.body.user.username).toBe('octocat');
      }
    });

    it('isolates user sessions: invalidating Session A does not invalidate Session B', async () => {
      const sessionA = authService.createGitHubSession({
        id: 'gh_user_A',
        username: 'alice',
        role: 'reviewer',
        provider: 'github',
      });

      const sessionB = authService.createGitHubSession({
        id: 'gh_user_B',
        username: 'bob',
        role: 'admin',
        provider: 'github',
      });

      // Verify both are valid initially
      const checkA1 = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${sessionA.token}`);
      expect(checkA1.status).toBe(200);
      expect(checkA1.body.user.username).toBe('alice');

      const checkB1 = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${sessionB.token}`);
      expect(checkB1.status).toBe(200);
      expect(checkB1.body.user.username).toBe('bob');

      // Logout Session A
      const logoutA = await request(app)
        .delete('/api/auth/session')
        .set('Authorization', `Bearer ${sessionA.token}`);
      expect(logoutA.status).toBe(200);

      // Session A must now be 401
      const checkA2 = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${sessionA.token}`);
      expect(checkA2.status).toBe(401);

      // Session B MUST still be 200
      const checkB2 = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${sessionB.token}`);
      expect(checkB2.status).toBe(200);
      expect(checkB2.body.user.username).toBe('bob');

      // Logout Session B
      const logoutB = await request(app)
        .delete('/api/auth/session')
        .set('Authorization', `Bearer ${sessionB.token}`);
      expect(logoutB.status).toBe(200);

      // Session B must now also be 401
      const checkB3 = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${sessionB.token}`);
      expect(checkB3.status).toBe(401);
    });
  });

  // =========================================================================
  // 5. Session Revocation, Expiry & Boundary Stress Suite
  // =========================================================================
  describe('5. Session Revocation, Expiry & Boundary Stress Suite', () => {
    it('revokes session via Cookie and clears cookie headers', async () => {
      const session = authService.createGitHubSession({
        id: 'gh_cookie_user',
        username: 'cookie_tester',
        role: 'reviewer',
        provider: 'github',
      });

      // Revoke using cookie
      const res = await request(app)
        .delete('/api/auth/session')
        .set('Cookie', `ct_session_token=${session.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Check cookie clearing headers
      const rawCookies = res.headers['set-cookie'];
      expect(rawCookies).toBeDefined();
      const cookieStr = Array.isArray(rawCookies) ? rawCookies.join(';') : String(rawCookies);
      expect(cookieStr).toMatch(/ct_session_token=/);
      expect(cookieStr).toMatch(/Expires=Thu, 01 Jan 1970/);

      // Verify token is invalidated
      const checkRes = await request(app)
        .get('/api/auth/session')
        .set('Cookie', `ct_session_token=${session.token}`);
      expect(checkRes.status).toBe(401);
    });

    it('revokes session via query parameter ?token=...', async () => {
      const session = authService.createGitHubSession({
        id: 'gh_query_user',
        username: 'query_tester',
        role: 'reviewer',
        provider: 'github',
      });

      const res = await request(app)
        .delete(`/api/auth/session?token=${session.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify token is invalidated
      const checkRes = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);
      expect(checkRes.status).toBe(401);
    });

    it('handles DELETE /api/auth/session when unauthenticated without throwing errors', async () => {
      const res = await request(app).delete('/api/auth/session');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/Session invalidated successfully/i);
    });

    it('rejects expired sessions and cleans them up from storage', async () => {
      const session = authService.createGitHubSession({
        id: 'gh_expired_user',
        username: 'expired_tester',
        role: 'viewer',
        provider: 'github',
      });

      // Modify session to have expired in the past
      const stored = authService.validateSession(session.token);
      expect(stored).not.toBeNull();
      if (stored) {
        stored.expiresAt = new Date(Date.now() - 1000).toISOString();
      }

      // validateSession should detect expiration and return null
      const checkRes = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);

      expect(checkRes.status).toBe(401);
      expect(checkRes.body.authenticated).toBe(false);
      expect(checkRes.body.error).toMatch(/Session expired or invalid/i);

      // Subsequent direct validation should also be null (purged)
      expect(authService.validateSession(session.token)).toBeNull();
    });

    it('rejects malformed and boundary Authorization headers', async () => {
      const badHeaders = [
        'Bearer',
        'Bearer ',
        'Bearer    ',
        'Bearer invalid_token_123',
        'Basic dXNlcjpwYXNz',
        'Digest username="admin"',
        `Bearer ${'A'.repeat(8192)}`, // 8KB oversized token
      ];

      for (const h of badHeaders) {
        const res = await request(app)
          .get('/api/auth/session')
          .set('Authorization', h);

        expect(res.status).toBe(401);
        expect(res.body.authenticated).toBe(false);
      }
    });

    it('enforces authentication on protected routes when session is absent or revoked', async () => {
      // 1. Unauthenticated request to protected repository rules route
      const res1 = await request(app)
        .get('/api/dashboard/repositories/octocat/hello-world/rules');
      expect(res1.status).toBe(401);
      expect(res1.body.success).toBe(false);

      // 2. Unauthenticated request to protected github repos route
      const res2 = await request(app)
        .get('/api/github/repos');
      expect(res2.status).toBe(401);
      expect(res2.body.success).toBe(false);

      // 3. Create valid session and access protected route
      const session = authService.createGitHubSession({
        id: 'gh_admin',
        username: 'admin',
        role: 'admin',
        provider: 'github',
      });

      dashboardStore.updateRepository('octocat', 'hello-world', {
        automationEnabled: true,
      });

      const res3 = await request(app)
        .get('/api/dashboard/repositories/octocat/hello-world/rules')
        .set('Authorization', `Bearer ${session.token}`);
      expect(res3.status).toBe(200);

      // 4. Revoke session and verify access is immediately denied
      authService.invalidateSession(session.token);

      const res4 = await request(app)
        .get('/api/dashboard/repositories/octocat/hello-world/rules')
        .set('Authorization', `Bearer ${session.token}`);
      expect(res4.status).toBe(401);
    });
  });
});
