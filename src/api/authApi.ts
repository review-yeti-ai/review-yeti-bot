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

  // GET /api/auth/session
  router.get('/session', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        error: 'No active session token provided',
      });
    }

    const token = authHeader.substring(7);
    const session = authService.validateSession(token);
    if (!session) {
      return res.status(401).json({
        success: false,
        authenticated: false,
        error: 'Session expired or invalid',
      });
    }

    return res.status(200).json({
      success: true,
      authenticated: true,
      user: session.user,
      expiresAt: session.expiresAt,
    });
  });

  // DELETE /api/auth/session
  router.delete('/session', (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      authService.invalidateSession(token);
    }
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
