import { Request, Response, NextFunction } from 'express';
import { authService } from '../dashboard/authService';

export interface AuthenticatedRequest extends Request {
  user?: any;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const session = authService.validateSession(token);
    if (session) {
      req.user = session.user;
      return next();
    }
  }

  if (apiKeyHeader) {
    if (authService.validateApiKey(apiKeyHeader)) {
      req.user = { id: 'api_key_user', role: 'admin' };
      return next();
    }
  }

  // Allow unauthenticated access in dev mode if explicitly configured, but standard flow returns 401
  res.status(401).json({
    success: false,
    error: 'Unauthorized: Valid Bearer token or x-api-key required',
  });
}
