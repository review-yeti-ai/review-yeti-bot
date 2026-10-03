import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authService } from '../dashboard/authService';
import { dashboardStore } from '../persistence/dashboardStore';
import { requireAuth } from './authMiddleware';

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export const createApiKeySchema = z.object({
  name: z.string().min(1, 'API Key name is required'),
});

export function createAuthRouter(): Router {
  const router = Router();

  // POST /api/auth/login
  router.post('/login', (req: Request, res: Response) => {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid login request',
        details: parseResult.error.format(),
      });
    }

    // Fail closed: without a configured ADMIN_PASSWORD no local login can succeed.
    if (!authService.isLocalLoginConfigured()) {
      return res.status(503).json({
        success: false,
        error: 'Local login is disabled: ADMIN_PASSWORD is not configured',
      });
    }

    const { username, password } = parseResult.data;
    const session = authService.login(username, password);
    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password',
      });
    }

    return res.status(200).json({
      success: true,
      user: session.user,
      token: session.token,
      expiresAt: session.expiresAt,
    });
  });

  // GET /api/auth/github - Initiate GitHub OAuth Flow
  router.get('/github', (req: Request, res: Response) => {
    try {
      const credentials = authService.getGitHubOAuthCredentials();
      if (!credentials.clientId) {
        return res.status(400).json({
          success: false,
          error: 'GitHub OAuth Client ID is not configured',
        });
      }

      const returnToParam = (req.query.return_to as string) || (req.query.redirect as string);
      if (returnToParam && (returnToParam.startsWith('http://') || returnToParam.startsWith('https://'))) {
        if (!returnToParam.startsWith('http://localhost') && !returnToParam.startsWith('http://127.0.0.1')) {
          if (req.query.format !== 'json') {
            return res.status(400).json({ success: false, error: 'Invalid return_to: external open redirects not allowed' });
          }
        }
      }

      const scopeParam = req.query.scope as string | undefined;
      if (scopeParam !== undefined && scopeParam.trim() === '') {
        return res.status(400).json({ success: false, error: 'Scope parameter cannot be empty' });
      }
      if (scopeParam && scopeParam.length > 500) {
        return res.status(400).json({ success: false, error: 'Requested scope exceeds maximum allowed length' });
      }

      const returnTo = returnToParam || '/repos';
      const state = authService.createOAuthState(returnTo);

      const host = req.get('host');
      const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
      const redirectUri =
        process.env.GITHUB_OAUTH_CALLBACK_URL || `${protocol}://${host}/api/auth/github/callback`;
      const scope = (req.query.scope as string) || 'read:user user:email read:org repo';

      const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
        credentials.clientId
      )}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(
        scope
      )}&state=${encodeURIComponent(state)}`;

      const wantsJson =
        req.headers.accept?.includes('application/json') || req.query.format === 'json';
      if (wantsJson) {
        return res.status(200).json({
          success: true,
          url: authUrl,
          state,
          redirectUri,
          scopes: scope,
          returnTo: returnToParam || '/repos',
        });
      }

      return res.redirect(302, authUrl);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to initiate GitHub OAuth flow',
      });
    }
  });

  // GET /api/auth/github/callback - Handle GitHub OAuth Code Exchange
  router.get('/github/callback', async (req: Request, res: Response) => {
    try {
      const { code, state, error, error_description } = req.query;

      if (error) {
        const errorMsg = String(error_description || error);
        const wantsJson =
          req.headers.accept?.includes('application/json') || req.query.format === 'json';
        if (wantsJson) {
          return res.status(400).json({ success: false, error: errorMsg });
        }
        return res.redirect(302, `/repos?error=${encodeURIComponent(errorMsg)}`);
      }

      if (!code || !state) {
        return res.status(400).json({
          success: false,
          error: 'Missing code or state parameter',
        });
      }

      const { valid, returnTo } = authService.consumeOAuthState(String(state));
      if (!valid) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or expired OAuth state',
        });
      }

      const host = req.get('host');
      const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
      const redirectUri =
        process.env.GITHUB_OAUTH_CALLBACK_URL || `${protocol}://${host}/api/auth/github/callback`;

      const { accessToken } = await authService.exchangeGitHubCode(String(code), redirectUri);
      const userProfile = await authService.fetchGitHubUserProfile(accessToken);
      const session = authService.createGitHubSession(userProfile);

      const isLocalhost = Boolean(
        host?.startsWith('localhost') || host?.startsWith('127.0.0.1')
      );

      // Set cookie for browser sessions
      res.cookie('ct_session_token', session.token, {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' && !isLocalhost,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      const wantsJson =
        req.headers.accept?.includes('application/json') || req.query.format === 'json';
      if (wantsJson) {
        const { accessToken: _token, ...safeUser } = session.user as any;
        return res.status(200).json({
          success: true,
          token: session.token,
          user: safeUser,
          expiresAt: session.expiresAt,
        });
      }

      const targetUrl = new URL(returnTo, `${protocol}://${host}`);
      targetUrl.searchParams.set('token', session.token);
      return res.redirect(302, targetUrl.toString());
    } catch (err: any) {
      return res.status(400).json({
        success: false,
        error: err?.message || 'Failed to complete GitHub OAuth authentication',
      });
    }
  });

  // GET /api/auth/session
  router.get('/session', (req: Request, res: Response) => {
    let token: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.query?.token) {
      token = String(req.query.token);
    } else if (req.headers.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)ct_session_token=([^;]+)/);
      if (match) token = decodeURIComponent(match[1]);
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        error: 'No active session token provided',
      });
    }

    const session = authService.validateSession(token);
    if (!session) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        error: 'Session expired or invalid',
      });
    }

    // Never leak upstream accessToken over the wire
    const { accessToken: _upstreamToken, ...safeUser } = session.user as any;

    return res.status(200).json({
      success: true,
      authenticated: true,
      user: safeUser,
      expiresAt: session.expiresAt,
    });
  });

  // DELETE /api/auth/session
  router.delete('/session', (req: Request, res: Response) => {
    let token: string | undefined;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.query?.token) {
      token = String(req.query.token);
    } else if (req.headers.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)ct_session_token=([^;]+)/);
      if (match) token = decodeURIComponent(match[1]);
    }

    if (token) {
      authService.invalidateSession(token);
    }

    res.clearCookie('ct_session_token', { path: '/' });
    res.setHeader('Set-Cookie', 'ct_session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');

    return res.status(200).json({
      success: true,
      message: 'Session invalidated successfully',
    });
  });

  // Require auth for API key management
  router.use('/apikeys', requireAuth);

  // GET /api/auth/apikeys
  router.get('/apikeys', (_req: Request, res: Response) => {
    const apiKeys = dashboardStore.getApiKeys().map((k) => ({
      id: k.id,
      name: k.name,
      maskedKey: k.maskedKey,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    }));

    return res.status(200).json({
      success: true,
      apiKeys,
    });
  });

  // POST /api/auth/apikeys
  router.post('/apikeys', (req: Request, res: Response) => {
    const parseResult = createApiKeySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid API key request',
        details: parseResult.error.format(),
      });
    }

    const created = dashboardStore.createApiKey(parseResult.data.name);
    return res.status(201).json({
      success: true,
      apiKey: created,
    });
  });

  // DELETE /api/auth/apikeys/:id
  router.delete('/apikeys/:id', (req: Request, res: Response) => {
    const id = req.params.id;
    const removed = dashboardStore.deleteApiKey(id);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: 'API key not found',
      });
    }

    return res.status(200).json({
      success: true,
      removedId: id,
    });
  });

  return router;
}
