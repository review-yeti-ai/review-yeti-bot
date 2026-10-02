import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { authService } from '../../src/dashboard/authService';
import { dashboardStore } from '../../src/persistence/dashboardStore';
import { Express } from 'express';

describe('R4: GitHub OAuth & Session Lifecycle Test Suite', () => {
  let app: Express;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    authService.reset();
    dashboardStore.reset();
    process.env.GITHUB_CLIENT_ID = 'test_gh_client_id_12345';
    process.env.GITHUB_CLIENT_SECRET = 'test_gh_client_secret_67890';
    app = createApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('1. GET /api/auth/github (Initiate Flow)', () => {
    it('redirects to GitHub authorize URL with valid client_id, scopes, and CSRF state', async () => {
      const res = await request(app).get('/api/auth/github');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('https://github.com/login/oauth/authorize');
      expect(res.headers.location).toContain('client_id=test_gh_client_id_12345');
      expect(res.headers.location).toContain('state=');
      expect(res.headers.location).toContain('scope=read%3Auser%20user%3Aemail%20read%3Aorg%20repo');
    });

    it('returns JSON when format=json query parameter is present', async () => {
      const res = await request(app).get('/api/auth/github?format=json');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toContain('https://github.com/login/oauth/authorize');
      expect(res.body.state).toBeDefined();
    });

    it('returns JSON when Accept: application/json header is provided', async () => {
      const res = await request(app)
        .get('/api/auth/github')
        .set('Accept', 'application/json');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toContain('https://github.com/login/oauth/authorize');
      expect(res.body.state).toBeDefined();
    });

    it('fails with 400 when GitHub client ID is not configured', async () => {
      delete process.env.GITHUB_CLIENT_ID;
      delete process.env.GITHUB_OAUTH_CLIENT_ID;
      dashboardStore.updateGitHubAppConfig({ oauthClientId: '' });

      const res = await request(app).get('/api/auth/github');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Client ID');
    });
  });

  describe('2. GET /api/auth/github/callback (Code Exchange & Session Minting)', () => {
    it('successfully exchanges code, fetches profile + emails, and mints UserSession', async () => {
      // 1. Generate valid state
      const state = authService.createOAuthState('/repos');

      // 2. Mock external GitHub API calls
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/login/oauth/access_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'gho_mock_access_token_abc123',
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

      // 3. Invoke callback with format=json
      const res = await request(app).get(
        `/api/auth/github/callback?code=mock_github_auth_code_999&state=${state}&format=json`
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toMatch(/^sess_/);
      expect(res.body.user.username).toBe('octocat');
      expect(res.body.user.email).toBe('octocat@github.com');
      expect(res.body.user.provider).toBe('github');

      // Verify cookie was set
      const rawCookies = res.headers['set-cookie'];
      expect(rawCookies).toBeDefined();
      const cookies = Array.isArray(rawCookies) ? rawCookies : [String(rawCookies)];
      expect(cookies.some((c: string) => c.includes('ct_session_token='))).toBe(true);

      // Verify state was consumed (single-use anti-replay)
      const reuseRes = await request(app).get(
        `/api/auth/github/callback?code=mock_github_auth_code_999&state=${state}&format=json`
      );
      expect(reuseRes.status).toBe(400);
      expect(reuseRes.body.error).toContain('state');
    });

    it('redirects to returnTo URL with token param on standard browser callback', async () => {
      const state = authService.createOAuthState('/repos?tab=active');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/login/oauth/access_token')) {
          return new Response(
            JSON.stringify({
              access_token: 'gho_mock_access_token_abc123',
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
              email: 'octocat@github.com',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('Not Found', { status: 404 });
      });

      const res = await request(app).get(
        `/api/auth/github/callback?code=mock_github_auth_code_999&state=${state}`
      );

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/repos?tab=active');
      expect(res.headers.location).toContain('token=sess_');
    });

    it('rejects callback with invalid or expired state', async () => {
      const res = await request(app).get(
        '/api/auth/github/callback?code=some_code&state=non_existent_state'
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('state');
    });

    it('handles GitHub oauth error callback parameter', async () => {
      const res = await request(app).get(
        '/api/auth/github/callback?error=access_denied&error_description=The+user+denied+access&format=json'
      );
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('denied');
    });
  });

  describe('3. Session Retrieval & Logout', () => {
    it('GET /api/auth/session returns user without leaking accessToken', async () => {
      const profile = {
        id: 'gh_583231',
        username: 'octocat',
        name: 'The Octocat',
        email: 'octocat@github.com',
        role: 'admin' as const,
        provider: 'github' as const,
        accessToken: 'gho_secret_access_token_never_leak',
      };
      const session = authService.createGitHubSession(profile);

      const res = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.username).toBe('octocat');
      expect(res.body.user.accessToken).toBeUndefined(); // MUST NOT leak accessToken
    });

    it('GET /api/auth/session authenticates via ct_session_token cookie', async () => {
      const profile = {
        id: 'gh_583231',
        username: 'octocat',
        name: 'The Octocat',
        email: 'octocat@github.com',
        role: 'reviewer' as const,
        provider: 'github' as const,
      };
      const session = authService.createGitHubSession(profile);

      const res = await request(app)
        .get('/api/auth/session')
        .set('Cookie', `ct_session_token=${session.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.user.username).toBe('octocat');
    });

    it('DELETE /api/auth/session revokes token and clears cookie', async () => {
      const session = authService.createGitHubSession({
        id: 'gh_1',
        username: 'dev',
        role: 'reviewer',
        provider: 'github',
      });

      const delRes = await request(app)
        .delete('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);

      expect(delRes.status).toBe(200);
      expect(delRes.body.success).toBe(true);

      const rawCookies = delRes.headers['set-cookie'];
      expect(rawCookies).toBeDefined();
      const cookies = Array.isArray(rawCookies) ? rawCookies : [String(rawCookies)];
      expect(cookies.some((c: string) => c.includes('ct_session_token=;'))).toBe(true);

      // Verify session is now invalid
      const checkRes = await request(app)
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);
      expect(checkRes.status).toBe(401);
    });
  });
});
