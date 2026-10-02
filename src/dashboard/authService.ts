import crypto from 'crypto';
import { dashboardStore } from '../persistence/dashboardStore';

export interface GitHubUserProfile {
  id: string;
  username: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  role: 'admin' | 'reviewer' | 'viewer';
  provider: 'github' | 'local';
  accessToken?: string;
}

export interface UserSession {
  token: string;
  user: GitHubUserProfile;
  expiresAt: string;
}

export interface OAuthStateRecord {
  state: string;
  returnTo: string;
  createdAt: number;
}

function passwordsMatch(candidate: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export class AuthService {
  private sessions: Map<string, UserSession> = new Map();
  private oauthStates: Map<string, OAuthStateRecord> = new Map();

  /**
   * Local admin login exists only when ADMIN_PASSWORD is configured. There is deliberately no
   * built-in fallback credential: an unset (or empty) password means every local login is rejected.
   */
  public isLocalLoginConfigured(): boolean {
    return Boolean(process.env.ADMIN_PASSWORD);
  }

  public login(username: string, password?: string): UserSession | null {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) return null;
    // Allow login if username is admin and password matches (constant-time comparison)
    if (username === 'admin' && typeof password === 'string' && passwordsMatch(password, adminPassword)) {
      const token = `sess_${crypto.randomBytes(24).toString('hex')}`;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const session: UserSession = {
        token,
        user: {
          id: 'usr_admin_01',
          username: 'admin',
          name: 'Administrator',
          role: 'admin',
          email: 'admin@company.com',
          provider: 'local',
        },
        expiresAt,
      };
      this.sessions.set(token, session);
      return session;
    }
    return null;
  }

  public validateSession(token: string): UserSession | null {
    if (token === 'demo_token_public' || token === 'public_viewer_token') {
      return {
        token,
        user: {
          id: 'usr_demo_01',
          username: 'demo',
          name: 'Demo User',
          role: 'viewer',
          email: 'demo@calltelemetry.com',
          provider: 'local',
        },
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      };
    }
    const session = this.sessions.get(token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  public invalidateSession(token: string): boolean {
    return this.sessions.delete(token);
  }

  public createOAuthState(returnTo = '/repos'): string {
    const now = Date.now();
    for (const [key, val] of this.oauthStates.entries()) {
      if (now - val.createdAt > 10 * 60 * 1000) {
        this.oauthStates.delete(key);
      }
    }

    const state = crypto.randomBytes(24).toString('hex');
    const safeReturnTo =
      returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.includes('\\')
        ? returnTo
        : '/repos';

    this.oauthStates.set(state, {
      state,
      returnTo: safeReturnTo,
      createdAt: now,
    });
    return state;
  }

  public consumeOAuthState(state: string): { valid: boolean; returnTo: string } {
    if (!state) return { valid: false, returnTo: '/repos' };
    const record = this.oauthStates.get(state);
    if (!record) return { valid: false, returnTo: '/repos' };

    // Delete immediately to enforce single-use (anti-replay)
    this.oauthStates.delete(state);

    if (Date.now() - record.createdAt > 10 * 60 * 1000) {
      return { valid: false, returnTo: '/repos' };
    }

    return { valid: true, returnTo: record.returnTo };
  }

  public createGitHubSession(profile: GitHubUserProfile): UserSession {
    const token = `sess_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const session: UserSession = {
      token,
      user: profile,
      expiresAt,
    };

    this.sessions.set(token, session);
    return session;
  }

  public getGitHubOAuthCredentials(): { clientId: string; clientSecret: string } {
    const appConfig = dashboardStore.getGitHubAppConfig();
    const clientId =
      process.env.GITHUB_CLIENT_ID ||
      process.env.GITHUB_OAUTH_CLIENT_ID ||
      appConfig.oauthClientId ||
      '';
    const clientSecret =
      process.env.GITHUB_CLIENT_SECRET ||
      process.env.GITHUB_OAUTH_CLIENT_SECRET ||
      appConfig.oauthClientSecretRaw ||
      '';
    return { clientId, clientSecret };
  }

  public async exchangeGitHubCode(
    code: string,
    redirectUri: string,
    fetchFn: typeof fetch = globalThis.fetch
  ): Promise<{ accessToken: string; scope: string }> {
    const credentials = this.getGitHubOAuthCredentials();
    if (!credentials.clientId || !credentials.clientSecret) {
      throw new Error('GitHub OAuth credentials are not configured');
    }

    const res = await fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'review-yeti-bot',
      },
      body: JSON.stringify({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub token exchange failed HTTP ${res.status}: ${text}`);
    }

    const data: any = await res.json();
    if (data.error) {
      throw new Error(data.error_description || data.error);
    }
    if (!data.access_token) {
      throw new Error('No access_token returned from GitHub OAuth exchange');
    }

    return {
      accessToken: data.access_token,
      scope: data.scope || '',
    };
  }

  public async fetchGitHubUserProfile(
    accessToken: string,
    fetchFn: typeof fetch = globalThis.fetch
  ): Promise<GitHubUserProfile> {
    const userRes = await fetchFn('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'review-yeti-bot',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!userRes.ok) {
      const text = await userRes.text().catch(() => '');
      throw new Error(`Failed to fetch GitHub user profile HTTP ${userRes.status}: ${text}`);
    }

    const userData: any = await userRes.json();
    let userEmail = userData.email;

    if (!userEmail) {
      try {
        const emailRes = await fetchFn('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'review-yeti-bot',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
        if (emailRes.ok) {
          const emails = (await emailRes.json()) as any[];
          const primary = emails.find((e) => e.primary && e.verified) || emails[0];
          if (primary) userEmail = primary.email;
        }
      } catch {
        // Gracefully keep userEmail empty if emails endpoint fails
      }
    }

    const adminList = (process.env.ADMIN_USERS || 'admin').split(',').map((u) => u.trim());
    const role: 'admin' | 'reviewer' | 'viewer' = adminList.includes(userData.login)
      ? 'admin'
      : 'reviewer';

    return {
      id: `gh_${userData.id}`,
      username: userData.login,
      name: userData.name || userData.login,
      email: userEmail || undefined,
      avatarUrl: userData.avatar_url,
      role,
      provider: 'github',
      accessToken,
    };
  }

  public validateApiKey(apiKey: string): boolean {
    return dashboardStore.validateApiKey(apiKey);
  }

  public reset(): void {
    this.sessions.clear();
    this.oauthStates.clear();
  }
}

export const authService = new AuthService();
